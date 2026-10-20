//! Private, local-only Stage 1 quality probe. This crate is not part of a production route.

mod guided;
mod highlight;
mod lens;

use std::path::{Path, PathBuf};
use std::process::ExitCode;
use std::time::Instant;

use anyhow::{ensure, Context, Result};
use clap::{Parser, ValueEnum};
use niho_base_raw::decode::RawData;
use niho_base_raw::{color, dcp, decode, demosaic, encode, orient, pipeline, resize};
use rawler::cfa::PlaneColor;
use rawler::imgop::sensor::bayer::ppg::PPGDemosaic;
use rawler::imgop::sensor::Demosaic;
use rawler::pixarray::PixF32;
use rawler::CFA;
use serde::Serialize;

const DEFAULT_LONG_EDGE: usize = 2560;
const LUMA_RANGE: f32 = 0.03;
const CHROMA_RANGE: f32 = 0.08;

#[derive(Clone, Copy, Debug, Serialize, ValueEnum)]
#[serde(rename_all = "lowercase")]
enum DemosaicMethod {
    Bilinear,
    Ppg,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, ValueEnum)]
#[serde(rename_all = "lowercase")]
enum LensMode {
    Off,
    Embedded,
}

#[derive(Clone, Copy, Debug, Serialize, ValueEnum)]
#[serde(rename_all = "kebab-case")]
enum HighlightMode {
    Clip,
    PreserveWb,
}

#[derive(Debug, Parser)]
#[command(
    name = "niho-quality-probe",
    version,
    about = "Local Stage 1 probe: compare bilinear/PPG demosaic and optional chroma denoise"
)]
struct Cli {
    #[arg(long)]
    raw: PathBuf,
    #[arg(long)]
    dcp: PathBuf,
    #[arg(long)]
    out: PathBuf,
    #[arg(long, default_value_t = DEFAULT_LONG_EDGE)]
    long_edge: usize,
    #[arg(long, value_enum, default_value_t = DemosaicMethod::Bilinear)]
    demosaic: DemosaicMethod,
    #[arg(long, default_value_t = 0.0, value_parser = parse_chroma_strength)]
    chroma_strength: f32,
    /// Apply the wider guided color-noise experiment after resizing.
    #[arg(long, default_value_t = false)]
    guided_chroma: bool,
    /// Override the ISO-adaptive radius (4 below ISO 2500, otherwise 8).
    #[arg(long)]
    guided_radius: Option<usize>,
    #[arg(long, default_value_t = 0.0001)]
    guided_eps: f32,
    /// Apply supported lens parameters embedded in Sony ARW or Panasonic RW2.
    #[arg(long, value_enum, default_value_t = LensMode::Off)]
    lens_correction: LensMode,
    /// Keep white-balanced CFA samples above 1 until the final encoding.
    #[arg(long, value_enum, default_value_t = HighlightMode::Clip)]
    highlight: HighlightMode,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct Metadata {
    schema: &'static str,
    camera: CameraMetadata,
    settings: SettingsMetadata,
    source: Dimensions,
    output: OutputMetadata,
    lens: Option<lens::Report>,
    timings_ms: Timings,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct CameraMetadata {
    make: String,
    model: String,
    clean_make: String,
    clean_model: String,
    iso: Option<f64>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct SettingsMetadata {
    demosaic: DemosaicMethod,
    chroma_strength: f32,
    guided_chroma: bool,
    guided_radius: usize,
    guided_eps: f32,
    guided_high_iso: bool,
    lens_correction: LensMode,
    highlight: HighlightMode,
    long_edge: usize,
    cfa: String,
    dcp_profile: String,
    dcp_sha256: String,
}

#[derive(Serialize)]
struct Dimensions {
    width: usize,
    height: usize,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct OutputMetadata {
    width: usize,
    height: usize,
    color_space: &'static str,
    encoding: &'static str,
    orientation: &'static str,
}

#[derive(Default, Serialize)]
#[serde(rename_all = "camelCase")]
struct Timings {
    decode: f64,
    prepare_cfa: f64,
    demosaic: f64,
    chroma_denoise: f64,
    color: f64,
    resize_and_orient: f64,
    guided_chroma: f64,
    lens_correction: f64,
    encode: f64,
    total: f64,
}

fn parse_chroma_strength(value: &str) -> std::result::Result<f32, String> {
    let parsed = value
        .parse::<f32>()
        .map_err(|_| "must be a number from 0 to 1".to_string())?;
    if parsed.is_finite() && (0.0..=1.0).contains(&parsed) {
        Ok(parsed)
    } else {
        Err("must be a finite number from 0 to 1".to_string())
    }
}

fn elapsed_ms(started: Instant) -> f64 {
    (started.elapsed().as_secs_f64() * 10_000.0).round() / 10.0
}

fn cfa_for_ppg(name: &str, pattern: [[u8; 2]; 2]) -> Result<CFA> {
    let cfa = CFA::new(name);
    for (row, colors) in pattern.iter().enumerate() {
        for (col, expected) in colors.iter().enumerate() {
            ensure!(
                cfa.color_at(row, col) == usize::from(*expected),
                "CFA phase mismatch at ({col},{row}): {name} says {}, decoded crop says {expected}",
                cfa.color_at(row, col)
            );
        }
    }
    ensure!(cfa.is_rgb(), "PPG requires an RGB Bayer CFA, got {name}");
    Ok(cfa)
}

fn ppg_demosaic(
    samples: Vec<f32>,
    width: usize,
    height: usize,
    cfa_name: &str,
    pattern: [[u8; 2]; 2],
) -> Result<Vec<f32>> {
    ensure!(
        width >= 6 && height >= 6,
        "PPG requires an image of at least 6x6 pixels (got {width}x{height})"
    );
    let cfa = cfa_for_ppg(cfa_name, pattern)?;
    let pixels = PixF32::new_with(samples, width, height);
    let rgb = PPGDemosaic::new().demosaic(&pixels, &cfa, &PlaneColor::new("RGB"), pixels.rect());
    drop(pixels);
    Ok(rgb.into_flatten())
}

#[inline]
fn luma_chroma(px: &[f32]) -> (f32, f32, f32) {
    let luma = (px[0] + 2.0 * px[1] + px[2]) * 0.25;
    (luma, px[0] - px[1], px[2] - px[1])
}

/// Denoise the two opponent-color components with a 3x3 bilateral filter.
///
/// The guide uses both luma and chroma distance, so a hard luminance or color edge receives very
/// little cross-edge weight. The filtered chroma is a positive weighted mean and is blended with
/// the original by `strength`, keeping it inside the local chroma range. Reconstruction preserves
/// `Y = (R + 2G + B) / 4` apart from floating-point roundoff.
fn denoise_chroma(rgb: &mut [f32], width: usize, height: usize, strength: f32) {
    if strength == 0.0 || width == 0 || height == 0 {
        return;
    }
    assert_eq!(rgb.len(), width * height * 3);

    // Only two scanlines are allocated. `previous_source_row` preserves the one source row that
    // has already been overwritten; the current and next rows are still untouched in `rgb`.
    let row_len = width * 3;
    let mut previous_source_row = vec![0.0_f32; row_len];
    let mut filtered_row = vec![0.0_f32; row_len];
    for y in 0..height {
        for x in 0..width {
            let center_index = (y * width + x) * 3;
            let center = &rgb[center_index..center_index + 3];
            let (center_y, center_rg, center_bg) = luma_chroma(center);
            if !center_y.is_finite() || !center_rg.is_finite() || !center_bg.is_finite() {
                filtered_row[x * 3..x * 3 + 3].copy_from_slice(center);
                continue;
            }

            let mut weight_sum = 0.0_f32;
            let mut rg_sum = 0.0_f32;
            let mut bg_sum = 0.0_f32;
            let y_start = y.saturating_sub(1);
            let y_end = (y + 1).min(height - 1);
            let x_start = x.saturating_sub(1);
            let x_end = (x + 1).min(width - 1);
            for neighbor_y in y_start..=y_end {
                for neighbor_x in x_start..=x_end {
                    let neighbor = if neighbor_y < y {
                        &previous_source_row[neighbor_x * 3..neighbor_x * 3 + 3]
                    } else {
                        let index = (neighbor_y * width + neighbor_x) * 3;
                        &rgb[index..index + 3]
                    };
                    let (neighbor_luma, neighbor_rg, neighbor_bg) = luma_chroma(neighbor);
                    if !neighbor_luma.is_finite()
                        || !neighbor_rg.is_finite()
                        || !neighbor_bg.is_finite()
                    {
                        continue;
                    }
                    let delta_y = (neighbor_luma - center_y) / LUMA_RANGE;
                    let delta_rg = (neighbor_rg - center_rg) / CHROMA_RANGE;
                    let delta_bg = (neighbor_bg - center_bg) / CHROMA_RANGE;
                    let diagonal = neighbor_x != x && neighbor_y != y;
                    let spatial = if diagonal { 0.5 } else { 1.0 };
                    let weight = spatial
                        / (1.0 + delta_y * delta_y + delta_rg * delta_rg + delta_bg * delta_bg);
                    weight_sum += weight;
                    rg_sum += weight * neighbor_rg;
                    bg_sum += weight * neighbor_bg;
                }
            }

            let filtered_rg = rg_sum / weight_sum;
            let filtered_bg = bg_sum / weight_sum;
            let rg = center_rg + strength * (filtered_rg - center_rg);
            let bg = center_bg + strength * (filtered_bg - center_bg);
            let green = center_y - (rg + bg) * 0.25;
            filtered_row[x * 3] = green + rg;
            filtered_row[x * 3 + 1] = green;
            filtered_row[x * 3 + 2] = green + bg;
        }
        let row_start = y * row_len;
        let row_end = row_start + row_len;
        previous_source_row.copy_from_slice(&rgb[row_start..row_end]);
        rgb[row_start..row_end].copy_from_slice(&filtered_row);
    }
}

fn paths_alias(a: &Path, b: &Path) -> bool {
    if a == b {
        return true;
    }
    match (std::fs::canonicalize(a), std::fs::canonicalize(b)) {
        (Ok(a), Ok(b)) => a == b,
        _ => false,
    }
}

fn validate_paths(cli: &Cli, metadata_path: &Path) -> Result<()> {
    ensure!(cli.long_edge > 0, "--long-edge must be at least 1");
    ensure!(
        !cli.guided_chroma || cli.chroma_strength == 0.0,
        "--guided-chroma and --chroma-strength cannot be combined"
    );
    ensure!(
        cli.guided_radius
            .is_none_or(|radius| (1..32).contains(&radius))
            && cli.guided_eps.is_finite()
            && cli.guided_eps > 0.0,
        "--guided-radius must be 1..31 and --guided-eps finite and positive"
    );
    ensure!(
        !paths_alias(&cli.out, metadata_path),
        "output PNG and metadata sidecar must be different paths"
    );
    for input in [&cli.raw, &cli.dcp] {
        ensure!(
            !paths_alias(&cli.out, input) && !paths_alias(metadata_path, input),
            "output path aliases input file {}",
            input.display()
        );
    }
    Ok(())
}

fn run(cli: Cli) -> Result<()> {
    let started = Instant::now();
    let metadata_path = cli.out.with_extension("json");
    validate_paths(&cli, &metadata_path)?;

    let mut timings = Timings::default();
    let step = Instant::now();
    let mut raw = decode::decode_file(&cli.raw)?;
    timings.decode = elapsed_ms(step);

    let loaded_dcp = dcp::load_dcp(&cli.dcp)?;
    let camera_name = format!("{} {}", raw.clean_make, raw.clean_model);
    if !loaded_dcp
        .spec
        .unique_camera_model
        .eq_ignore_ascii_case(&camera_name)
    {
        eprintln!(
            "warning: DCP camera \"{}\" does not match RAW camera \"{camera_name}\"",
            loaded_dcp.spec.unique_camera_model
        );
    }

    let camera = CameraMetadata {
        make: raw.make.clone(),
        model: raw.model.clone(),
        clean_make: raw.clean_make.clone(),
        clean_model: raw.clean_model.clone(),
        iso: raw.iso,
    };
    let guided_high_iso = raw.iso.is_some_and(|iso| iso >= 2500.0);
    let guided_radius = cli
        .guided_radius
        .unwrap_or(if guided_high_iso { 8 } else { 4 });
    let (width, height) = (raw.crop.width, raw.crop.height);
    let cfa_name = raw.cfa_name();
    let orientation = raw.orientation;
    let pattern = raw.pattern;
    let neutral = raw.as_shot_neutral();
    let multipliers = raw.as_shot_multipliers();

    let step = Instant::now();
    let gains = [
        multipliers[0] as f32,
        multipliers[1] as f32,
        multipliers[2] as f32,
    ];
    let cfa_samples = match cli.highlight {
        HighlightMode::Clip => demosaic::prepare_cfa(&raw, gains),
        HighlightMode::PreserveWb => highlight::prepare_cfa_preserve_wb(&raw, gains),
    };
    raw.data = RawData::U16(Vec::new());
    timings.prepare_cfa = elapsed_ms(step);

    let step = Instant::now();
    let mut rgb = match cli.demosaic {
        DemosaicMethod::Bilinear => {
            let rgb = demosaic::bilinear(&cfa_samples, width, height, pattern);
            drop(cfa_samples);
            rgb
        }
        DemosaicMethod::Ppg => ppg_demosaic(cfa_samples, width, height, &cfa_name, pattern)?,
    };
    timings.demosaic = elapsed_ms(step);

    let step = Instant::now();
    denoise_chroma(&mut rgb, width, height, cli.chroma_strength);
    timings.chroma_denoise = elapsed_ms(step);

    let step = Instant::now();
    let profile_color =
        color::resolve_profile_color(&loaded_dcp.spec, &neutral).context("cannot apply the DCP")?;
    pipeline::apply_color(&mut rgb, width, &profile_color);
    timings.color = elapsed_ms(step);

    let step = Instant::now();
    let (resized_width, resized_height) = resize::target_size(width, height, cli.long_edge);
    let resized = if (resized_width, resized_height) == (width, height) {
        std::mem::take(&mut rgb)
    } else {
        resize::lanczos3_rgb(&rgb, width, height, resized_width, resized_height)
    };
    drop(rgb);
    let (mut output, output_width, output_height) =
        orient::apply(resized, resized_width, resized_height, orientation);
    timings.resize_and_orient = elapsed_ms(step);

    if cli.guided_chroma {
        let step = Instant::now();
        guided::apply(
            &mut output,
            output_width,
            output_height,
            guided_radius,
            cli.guided_eps,
            guided_high_iso,
        );
        timings.guided_chroma = elapsed_ms(step);
    }

    let lens_report = if cli.lens_correction == LensMode::Embedded {
        let step = Instant::now();
        let params = lens::load(&cli.raw)?;
        let report = lens::apply(&mut output, output_width, output_height, &params);
        timings.lens_correction = elapsed_ms(step);
        Some(report)
    } else {
        None
    };

    match std::fs::remove_file(&metadata_path) {
        Ok(()) => {}
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
        Err(error) => {
            return Err(error).with_context(|| {
                format!(
                    "cannot clear stale metadata sidecar {}",
                    metadata_path.display()
                )
            });
        }
    }
    let step = Instant::now();
    encode::write_png16(&cli.out, &output, output_width, output_height)?;
    timings.encode = elapsed_ms(step);
    timings.total = elapsed_ms(started);

    let total_ms = timings.total;
    let metadata = Metadata {
        schema: "niho-quality-probe/1",
        camera,
        settings: SettingsMetadata {
            demosaic: cli.demosaic,
            chroma_strength: cli.chroma_strength,
            guided_chroma: cli.guided_chroma,
            guided_radius,
            guided_eps: cli.guided_eps,
            guided_high_iso,
            lens_correction: cli.lens_correction,
            highlight: cli.highlight,
            long_edge: cli.long_edge,
            cfa: cfa_name,
            dcp_profile: loaded_dcp.spec.profile_name,
            dcp_sha256: loaded_dcp.sha256,
        },
        source: Dimensions { width, height },
        output: OutputMetadata {
            width: output_width,
            height: output_height,
            color_space: "linear ProPhoto RGB D50",
            encoding: "PNG16 power 1/1.8 max 2.0",
            orientation: orientation.name(),
        },
        lens: lens_report,
        timings_ms: timings,
    };
    let mut json = serde_json::to_vec_pretty(&metadata)?;
    json.push(b'\n');
    encode::write_atomic(&metadata_path, &json)?;

    println!(
        "{} {}x{} demosaic={} chroma-strength={} guided-chroma={} total={total_ms:.1}ms metadata={}",
        cli.out.display(),
        output_width,
        output_height,
        match cli.demosaic {
            DemosaicMethod::Bilinear => "bilinear",
            DemosaicMethod::Ppg => "ppg",
        },
        cli.chroma_strength,
        cli.guided_chroma,
        metadata_path.display()
    );
    Ok(())
}

fn main() -> ExitCode {
    match run(Cli::parse()) {
        Ok(()) => ExitCode::SUCCESS,
        Err(error) => {
            eprintln!("error: {error:#}");
            ExitCode::FAILURE
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn luma(rgb: &[f32]) -> f32 {
        (rgb[0] + 2.0 * rgb[1] + rgb[2]) * 0.25
    }

    #[test]
    fn chroma_strength_is_bounded_and_finite() {
        for valid in ["0", "0.25", "1"] {
            assert!(parse_chroma_strength(valid).is_ok());
        }
        for invalid in ["-0.1", "1.1", "NaN", "inf"] {
            assert!(parse_chroma_strength(invalid).is_err());
        }
    }

    #[test]
    fn cfa_phase_matches_all_bayer_variants() {
        for (name, pattern) in [
            ("RGGB", [[0, 1], [1, 2]]),
            ("BGGR", [[2, 1], [1, 0]]),
            ("GRBG", [[1, 0], [2, 1]]),
            ("GBRG", [[1, 2], [0, 1]]),
        ] {
            assert!(cfa_for_ppg(name, pattern).is_ok());
        }
        assert!(cfa_for_ppg("RGGB", [[2, 1], [1, 0]]).is_err());
    }

    #[test]
    fn zero_strength_is_bit_identical() {
        let mut image = vec![0.1, 0.2, 0.3, 0.8, 0.4, 0.2];
        let original = image.clone();
        denoise_chroma(&mut image, 2, 1, 0.0);
        assert_eq!(image, original);
    }

    #[test]
    fn denoise_preserves_luma_and_reduces_isolated_chroma() {
        let mut image = vec![0.5_f32; 5 * 5 * 3];
        let center = (2 * 5 + 2) * 3;
        image[center..center + 3].copy_from_slice(&[0.65, 0.45, 0.45]);
        let before = image.clone();
        denoise_chroma(&mut image, 5, 5, 1.0);

        assert!(
            (luma(&image[center..center + 3]) - luma(&before[center..center + 3])).abs() < 1e-6
        );
        assert!((image[center] - image[center + 1]).abs() < 0.2);
    }

    #[test]
    fn denoise_does_not_bleed_across_hard_color_edge() {
        let mut image = Vec::new();
        for _y in 0..3 {
            for x in 0..6 {
                image.extend_from_slice(if x < 3 {
                    &[1.0, 0.0, 0.0]
                } else {
                    &[0.0, 0.0, 1.0]
                });
            }
        }
        denoise_chroma(&mut image, 6, 3, 1.0);
        let left_edge = (6 + 2) * 3;
        let right_edge = (6 + 3) * 3;
        assert!(image[left_edge] > 0.99);
        assert!(image[right_edge + 2] > 0.99);
        assert!((luma(&image[left_edge..left_edge + 3]) - 0.25).abs() < 1e-6);
        assert!((luma(&image[right_edge..right_edge + 3]) - 0.25).abs() < 1e-6);
    }
}
