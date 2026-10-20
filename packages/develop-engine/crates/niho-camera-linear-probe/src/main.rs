use std::io::{Read, Write};
use std::path::PathBuf;
use std::time::Instant;

use anyhow::{ensure, Result};
use clap::{Parser, Subcommand};
use flate2::{read::ZlibDecoder, write::ZlibEncoder, Compression};
use niho_base_raw::{dcp, encode};
use niho_camera_linear_probe::{
    load_work_copy, make, render, stage2_handoff_meta, write_work_copy,
};

#[derive(Parser)]
#[command(about = "Local V3 camera-linear working-copy experiment")]
struct Cli {
    #[command(subcommand)]
    command: Command,
}

#[derive(Subcommand)]
enum Command {
    /// Measure unencoded camera-linear samples without writing pixels or private RAW metadata.
    Inspect {
        #[arg(long)]
        raw: PathBuf,
        #[arg(long)]
        dcp: PathBuf,
        #[arg(long, default_value_t = 2560)]
        long_edge: usize,
    },
    /// Compare bit-exact f32/zlib with the existing clipping PNG16, without writing pixels.
    CodecBench {
        #[arg(long)]
        raw: PathBuf,
        #[arg(long)]
        dcp: PathBuf,
        #[arg(long, default_value_t = 2560)]
        long_edge: usize,
    },
    Make {
        #[arg(long)]
        raw: PathBuf,
        #[arg(long)]
        dcp: PathBuf,
        #[arg(long)]
        out: PathBuf,
        #[arg(long, default_value_t = 2560)]
        long_edge: usize,
    },
    Render {
        #[arg(long)]
        input: PathBuf,
        #[arg(long)]
        meta: PathBuf,
        #[arg(long)]
        dcp: PathBuf,
        #[arg(long)]
        out: PathBuf,
        #[arg(long)]
        kelvin: Option<f64>,
        #[arg(long, default_value_t = 0.0)]
        tint: f64,
    },
    /// Repeat the stage-2 prefix in one warm process, without PNG output I/O.
    Bench {
        #[arg(long)]
        input: PathBuf,
        #[arg(long)]
        meta: PathBuf,
        #[arg(long)]
        dcp: PathBuf,
        #[arg(long, default_value_t = 50)]
        runs: usize,
        #[arg(long)]
        kelvin: Option<f64>,
        #[arg(long, default_value_t = 0.0)]
        tint: f64,
    },
}

fn percentile(sorted: &[f64], fraction: f64) -> f64 {
    sorted[((sorted.len() as f64 * fraction).ceil() as usize).saturating_sub(1)]
}

fn run() -> Result<()> {
    match Cli::parse().command {
        Command::Inspect {
            raw,
            dcp: path,
            long_edge,
        } => {
            let profile = dcp::load_dcp(&path)?;
            let work = make(&raw, &profile, long_edge)?;
            ensure!(!work.rgb.is_empty(), "camera-linear image has no samples");
            let mut min: Option<f32> = None;
            let mut max: Option<f32> = None;
            let mut negative = 0usize;
            let mut below_minus_quarter = 0usize;
            let mut above_one = 0usize;
            let mut above_two = 0usize;
            let mut non_finite = 0usize;
            for &value in &work.rgb {
                if !value.is_finite() {
                    non_finite += 1;
                    continue;
                }
                min = Some(min.map_or(value, |current| current.min(value)));
                max = Some(max.map_or(value, |current| current.max(value)));
                negative += usize::from(value < 0.0);
                below_minus_quarter += usize::from(value < -0.25);
                above_one += usize::from(value > 1.0);
                above_two += usize::from(value > 2.0);
            }
            println!(
                "{}",
                serde_json::json!({
                    "schema": "niho-camera-linear-range/1",
                    "width": work.meta.width,
                    "height": work.meta.height,
                    "samples": work.rgb.len(),
                    "min": min,
                    "max": max,
                    "negative": negative,
                    "belowMinusQuarter": below_minus_quarter,
                    "aboveOne": above_one,
                    "aboveTwo": above_two,
                    "nonFinite": non_finite,
                    "currentPng16WouldClip": negative + above_two,
                })
            );
        }
        Command::CodecBench {
            raw,
            dcp: path,
            long_edge,
        } => {
            let profile = dcp::load_dcp(&path)?;
            let work = make(&raw, &profile, long_edge)?;
            ensure!(!work.rgb.is_empty(), "camera-linear image has no samples");

            let started = Instant::now();
            let mut encoder = ZlibEncoder::new(Vec::new(), Compression::fast());
            let mut scratch = Vec::with_capacity(16_384 * 4);
            for samples in work.rgb.chunks(16_384) {
                scratch.clear();
                for sample in samples {
                    scratch.extend_from_slice(&sample.to_bits().to_le_bytes());
                }
                encoder.write_all(&scratch)?;
            }
            let compressed = encoder.finish()?;
            let encode_ms = started.elapsed().as_millis();

            let started = Instant::now();
            let mut decoder = ZlibDecoder::new(compressed.as_slice());
            let mut mismatched = 0usize;
            for samples in work.rgb.chunks(16_384) {
                scratch.resize(samples.len() * 4, 0);
                decoder.read_exact(&mut scratch)?;
                let (decoded_samples, remainder) = scratch.as_chunks::<4>();
                ensure!(
                    remainder.is_empty(),
                    "decoded sample ended with partial bytes"
                );
                mismatched += samples
                    .iter()
                    .zip(decoded_samples)
                    .filter(|(sample, bytes)| u32::from_le_bytes(**bytes) != sample.to_bits())
                    .count();
            }
            let mut extra = [0u8; 1];
            ensure!(
                decoder.read(&mut extra)? == 0,
                "decoded stream has extra samples"
            );
            let decode_ms = started.elapsed().as_millis();
            ensure!(
                mismatched == 0,
                "lossless round trip changed {mismatched} samples"
            );

            let started = Instant::now();
            let png = encode::png16_bytes(&work.rgb, work.meta.width, work.meta.height)?;
            let png_encode_ms = started.elapsed().as_millis();

            // Experimental signed range only. Reject any out-of-range sample instead of
            // silently clipping it through the existing PNG16 encoder.
            const SIGNED_LOWER: f32 = -0.25;
            const SIGNED_UPPER: f32 = 2.0;
            ensure!(
                work.rgb
                    .iter()
                    .all(|v| v.is_finite() && (SIGNED_LOWER..=SIGNED_UPPER).contains(v)),
                "signed PNG16 trial range is too narrow for this image"
            );
            let signed_png_transform_started = Instant::now();
            let range = SIGNED_UPPER - SIGNED_LOWER;
            let mapped: Vec<f32> = work
                .rgb
                .iter()
                .map(|v| (v - SIGNED_LOWER) * (2.0 / range))
                .collect();
            let signed_png = encode::png16_bytes(&mapped, work.meta.width, work.meta.height)?;
            let signed_png_transform_and_encode_ms =
                signed_png_transform_started.elapsed().as_millis();
            let (signed_codes, width, height) = encode::read_png16(&signed_png)?;
            ensure!(
                width == work.meta.width
                    && height == work.meta.height
                    && signed_codes.len() == work.rgb.len(),
                "signed PNG16 dimensions or sample count changed"
            );
            let mut errors = Vec::with_capacity(work.rgb.len());
            let mut error_sum = 0.0f64;
            let mut error_max = 0.0f32;
            for (&original, code) in work.rgb.iter().zip(signed_codes) {
                let decoded = encode::decode_value(code) * (range / 2.0) + SIGNED_LOWER;
                let error = (original - decoded).abs();
                error_sum += f64::from(error);
                error_max = error_max.max(error);
                errors.push(error);
            }
            let p99_index = ((errors.len() as f64 * 0.99).ceil() as usize).saturating_sub(1);
            let p99_error = *errors.select_nth_unstable_by(p99_index, f32::total_cmp).1;
            println!(
                "{}",
                serde_json::json!({
                    "schema": "niho-camera-linear-codec-bench/1",
                    "width": work.meta.width,
                    "height": work.meta.height,
                    "samples": work.rgb.len(),
                    "floatBytes": work.rgb.len() * 4,
                    "zlibFastBytes": compressed.len(),
                    "zlibFastEncodeMs": encode_ms,
                    "zlibFastDecodeMs": decode_ms,
                    "roundTripBitMismatches": mismatched,
                    "existingClippingPng16Bytes": png.len(),
                    "existingClippingPng16EncodeMs": png_encode_ms,
                    "signedPng16Range": [SIGNED_LOWER, SIGNED_UPPER],
                    "signedPng16Bytes": signed_png.len(),
                    "signedPng16TransformAndEncodeMs": signed_png_transform_and_encode_ms,
                    "signedPng16MeanAbsError": error_sum / work.rgb.len() as f64,
                    "signedPng16P99AbsError": p99_error,
                    "signedPng16MaxAbsError": error_max,
                })
            );
        }
        Command::Make {
            raw,
            dcp: path,
            out,
            long_edge,
        } => {
            ensure!(raw != out, "RAW input and output paths must differ");
            let profile = dcp::load_dcp(&path)?;
            let work = make(&raw, &profile, long_edge)?;
            write_work_copy(&out, &work)?;
            println!(
                "{} {}x{} baseVersion={} dcpSha256={}",
                out.display(),
                work.meta.width,
                work.meta.height,
                work.meta.base_version,
                work.meta.dcp_sha256
            );
        }
        Command::Render {
            input,
            meta,
            dcp: path,
            out,
            kelvin,
            tint,
        } => {
            ensure!(
                input != out && meta != out,
                "input and output paths must differ"
            );
            ensure!(kelvin.is_some() || tint == 0.0, "tint requires kelvin");
            let profile = dcp::load_dcp(&path)?;
            let (codes, work_meta) = load_work_copy(&input, &meta)?;
            let rendered = render(&codes, &work_meta, &profile, kelvin.map(|k| (k, tint)))?;
            encode::write_png16(&out, &rendered.rgb, rendered.width, rendered.height)?;
            let handoff = serde_json::to_vec_pretty(&stage2_handoff_meta(&rendered))?;
            encode::write_atomic(&out.with_extension("json"), &handoff)?;
            println!(
                "{} {}x{} stage2Prefix={:.3}ms setup={:.3}ms decode={:.3}ms wb={:.3}ms color={:.3}ms profileChanged={} neutral={:?}",
                out.display(),
                rendered.width,
                rendered.height,
                rendered.transform_ms + rendered.setup_ms,
                rendered.setup_ms,
                rendered.decode_ms,
                rendered.white_balance_ms,
                rendered.color_ms,
                rendered.profile_changed,
                rendered.neutral
            );
        }
        Command::Bench {
            input,
            meta,
            dcp: path,
            runs,
            kelvin,
            tint,
        } => {
            ensure!((2..=1000).contains(&runs), "runs must be 2..1000");
            ensure!(kelvin.is_some() || tint == 0.0, "tint requires kelvin");
            let profile = dcp::load_dcp(&path)?;
            let (codes, work_meta) = load_work_copy(&input, &meta)?;
            let mut increments = Vec::with_capacity(runs);
            let mut decodes = Vec::with_capacity(runs);
            for _ in 0..runs {
                let rendered = render(&codes, &work_meta, &profile, kelvin.map(|k| (k, tint)))?;
                increments.push(rendered.setup_ms + rendered.white_balance_ms + rendered.color_ms);
                decodes.push(rendered.decode_ms);
                std::hint::black_box(rendered.rgb);
            }
            increments.sort_by(f64::total_cmp);
            decodes.sort_by(f64::total_cmp);
            println!(
                "runs={} incrementMedian={:.3}ms incrementP95={:.3}ms decodeMedian={:.3}ms",
                runs,
                percentile(&increments, 0.5),
                percentile(&increments, 0.95),
                percentile(&decodes, 0.5)
            );
        }
    }
    Ok(())
}

fn main() {
    if let Err(error) = run() {
        eprintln!("{error:#}");
        std::process::exit(1);
    }
}
