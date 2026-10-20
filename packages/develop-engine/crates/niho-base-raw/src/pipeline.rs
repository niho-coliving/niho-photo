//! `render` (working copy) and `dump-camera` (white-balanced camera RGB) pipelines.
//!
//! Order: decode → normalize + WB + clip on the CFA → bilinear demosaic → color (render only:
//! camera → linear ProPhoto, negatives → 0, HueSatMap) → Lanczos3 to the long edge → orientation
//! → PNG16. Resizing before orienting is exact (flips/transposes commute with the separable filter).

use std::collections::BTreeMap;
use std::path::{Path, PathBuf};
use std::time::Instant;

use anyhow::{bail, Context, Result};
use serde::Serialize;

use crate::color::{self, ProfileColor};
use crate::dcp::{self, LoadedDcp};
use crate::decode::{self, CameraRaw, RawData};
use crate::sidecar::{
    self, json_number, round_to, CameraInfo, DcpInfo, DecoderInfo, EncodingInfo, OutputInfo,
    Sidecar, SourceInfo, Timings, WhiteBalanceInfo,
};
use crate::{demosaic, encode, matrix, orient, par, resize};

pub const DEFAULT_RENDER_LONG_EDGE: usize = 2560;
pub const DEFAULT_DUMP_LONG_EDGE: usize = 1500;

pub enum Mode<'a> {
    /// Working copy in linear ProPhoto through the given DCP.
    Render(&'a LoadedDcp),
    /// White-balanced camera RGB, no color matrix (input to the ForwardMatrix / HueSatMap fit).
    DumpCamera,
}

/// A developed image before encoding.
pub struct Developed {
    /// Interleaved RGB, display orientation.
    pub rgb: Vec<f32>,
    pub width: usize,
    pub height: usize,
    pub sidecar: Sidecar,
    /// Non-fatal notes for stderr (e.g. DCP camera mismatch).
    pub warnings: Vec<String>,
}

fn ms(t: Instant) -> f64 {
    round_to(t.elapsed().as_secs_f64() * 1000.0, 1)
}

/// Apply the resolved profile to white-balanced camera RGB in place (contract §2.5 steps 5–7).
pub fn apply_color(rgb: &mut [f32], width: usize, pc: &ProfileColor) {
    let m = matrix::to_f32(&pc.camera_to_prophoto);
    let hsm = pc.hue_sat_map.as_ref();
    par::for_each_row_mut(rgb, width * 3, |_, row| {
        for px in row.as_chunks_mut::<3>().0.iter_mut() {
            let (r, g, b) = (px[0], px[1], px[2]);
            let mut o = [
                (m[0][0] * r + m[0][1] * g + m[0][2] * b).max(0.0),
                (m[1][0] * r + m[1][1] * g + m[1][2] * b).max(0.0),
                (m[2][0] * r + m[2][1] * g + m[2][2] * b).max(0.0),
            ];
            if let Some(t) = hsm {
                o = t.apply(o);
            }
            px.copy_from_slice(&o);
        }
    });
}

/// A camera dump has no measured color profile. Do not infer its white from a vendor table.
fn white_without_dcp(_raw: &CameraRaw, _neutral: &[f64; 3]) -> ([f64; 2], f64, f64) {
    ([0.0, 0.0], 0.0, 0.0)
}

fn dcp_info(d: &LoadedDcp) -> DcpInfo {
    let s = &d.spec;
    DcpInfo {
        sha256: d.sha256.clone(),
        profile_name: s.profile_name.clone(),
        unique_camera_model: s.unique_camera_model.clone(),
        copyright: s.copyright.clone(),
        embed_policy: s.embed_policy,
        illuminants: s.illuminants(),
        has_forward_matrix: s.forward_matrix1.is_some(),
        hue_sat_map_dims: s.hue_sat_map.as_ref().map(|h| h.dims()),
        has_look_table: s.look_table.is_some(),
        has_tone_curve: s.tone_curve.is_some(),
        baseline_exposure_offset: s.baseline_exposure_offset,
    }
}

/// Decode and develop one raw file (no encoding).
pub fn develop(raw_path: &Path, mode: Mode, long_edge: usize) -> Result<Developed> {
    if long_edge == 0 {
        bail!("--long-edge must be at least 1");
    }
    let mut warnings = Vec::new();
    let t0 = Instant::now();
    let mut raw = decode::decode_file(raw_path)?;
    let t_decode = ms(t0);

    let camera_name = format!("{} {}", raw.clean_make, raw.clean_model);
    if let Mode::Render(d) = &mode {
        if !d
            .spec
            .unique_camera_model
            .eq_ignore_ascii_case(&camera_name)
        {
            warnings.push(format!(
                "DCP UniqueCameraModel \"{}\" does not match the camera \"{camera_name}\"",
                d.spec.unique_camera_model
            ));
        }
    }

    // Normalize + WB + clip on the CFA, then demosaic.
    let t = Instant::now();
    let mul = raw.as_shot_multipliers();
    let cfa = demosaic::prepare_cfa(&raw, [mul[0] as f32, mul[1] as f32, mul[2] as f32]);
    raw.data = RawData::U16(Vec::new()); // free the mosaic before the RGB buffer
    let (w, h) = (raw.crop.width, raw.crop.height);
    let mut rgb = demosaic::bilinear(&cfa, w, h, raw.pattern);
    drop(cfa);
    let t_demosaic = ms(t);

    // Color.
    let t = Instant::now();
    let neutral = raw.as_shot_neutral();
    let (white_xy, cct, duv) = match &mode {
        Mode::Render(d) => {
            let pc =
                color::resolve_profile_color(&d.spec, &neutral).context("cannot apply the DCP")?;
            apply_color(&mut rgb, w, &pc);
            (pc.white_xy, pc.cct, pc.duv)
        }
        Mode::DumpCamera => white_without_dcp(&raw, &neutral),
    };
    let t_color = if matches!(mode, Mode::Render(_)) {
        ms(t)
    } else {
        0.0
    };

    // Resize, then orientation.
    let t = Instant::now();
    let (rw, rh) = resize::target_size(w, h, long_edge);
    let resized = if (rw, rh) != (w, h) {
        resize::lanczos3_rgb(&rgb, w, h, rw, rh)
    } else {
        std::mem::take(&mut rgb)
    };
    drop(rgb);
    let (out, ow, oh) = orient::apply(resized, rw, rh, raw.orientation);
    let t_resize = ms(t);

    let (base_version, color_space, dcp_meta, baseline_ev) = match &mode {
        Mode::Render(d) => (
            crate::base_version(&d.sha256),
            sidecar::COLOR_SPACE_PROPHOTO,
            Some(dcp_info(d)),
            raw.baseline_exposure.unwrap_or(0.0) + d.spec.baseline_exposure_offset,
        ),
        Mode::DumpCamera => (
            crate::DUMP_BASE_VERSION.to_string(),
            sidecar::COLOR_SPACE_CAMERA,
            None,
            raw.baseline_exposure.unwrap_or(0.0),
        ),
    };

    let sidecar = Sidecar {
        schema: sidecar::SCHEMA.to_string(),
        base_version,
        processing_version: crate::PROCESSING_VERSION.to_string(),
        encoding_version: crate::ENCODING_VERSION.to_string(),
        decoder: DecoderInfo {
            name: crate::DECODER_NAME.to_string(),
            version: crate::DECODER_VERSION.to_string(),
        },
        camera: CameraInfo {
            make: raw.make.clone(),
            model: raw.model.clone(),
            clean_make: raw.clean_make.clone(),
            clean_model: raw.clean_model.clone(),
        },
        source: SourceInfo {
            width: w,
            height: h,
            cfa: raw.cfa_name(),
            bits_per_sample: raw.bits_per_sample,
            black_level: raw.black.iter().map(|&x| json_number(x as f64)).collect(),
            white_level: raw.white_reported.iter().map(|&x| json_number(x)).collect(),
            iso: raw.iso,
            baseline_exposure: raw.baseline_exposure,
            baseline_exposure_source: raw.baseline_exposure_source.map(str::to_string),
        },
        dcp: dcp_meta,
        white_balance: WhiteBalanceInfo {
            as_shot_multipliers: mul,
            as_shot_neutral: neutral,
            xy: [round_to(white_xy[0], 6), round_to(white_xy[1], 6)],
            cct: round_to(cct, 1),
            duv: round_to(duv, 6),
            cct_method: color::CCT_METHOD.to_string(),
        },
        baseline_ev,
        highlight_mode: "clip".to_string(),
        demosaic: "bilinear".to_string(),
        orientation: raw.orientation.name().to_string(),
        orientation_applied: true,
        lens_correction_applied: false,
        look_table_included: false,
        output: OutputInfo {
            width: ow,
            height: oh,
            color_space: color_space.to_string(),
            encoding: EncodingInfo {
                transfer: "power".to_string(),
                gamma: encode::GAMMA_F64,
                linear_max: encode::LINEAR_MAX_F64,
                bits_per_sample: encode::BITS_PER_SAMPLE,
            },
            resample: if (rw, rh) != (w, h) {
                "lanczos3"
            } else {
                "none"
            }
            .to_string(),
        },
        timings_ms: Timings {
            decode: t_decode,
            demosaic: t_demosaic,
            color: t_color,
            resize: t_resize,
            encode: 0.0,
            total: 0.0,
        },
    };
    Ok(Developed {
        rgb: out,
        width: ow,
        height: oh,
        sidecar,
        warnings,
    })
}

/// Default sidecar path: same basename as the PNG, `.json`.
pub fn default_meta_path(out: &Path) -> PathBuf {
    out.with_extension("json")
}

fn canonical_target(path: &Path) -> Result<PathBuf> {
    if path.exists() {
        return std::fs::canonicalize(path)
            .with_context(|| format!("cannot resolve output/input path {}", path.display()));
    }
    let name = path
        .file_name()
        .with_context(|| format!("path has no file name: {}", path.display()))?;
    let parent = path
        .parent()
        .filter(|p| !p.as_os_str().is_empty())
        .unwrap_or(Path::new("."));
    Ok(std::fs::canonicalize(parent)
        .with_context(|| format!("cannot resolve parent directory {}", parent.display()))?
        .join(name))
}

fn paths_alias(a: &Path, b: &Path) -> Result<bool> {
    if a == b || canonical_target(a)? == canonical_target(b)? {
        return Ok(true);
    }
    #[cfg(unix)]
    if a.exists() && b.exists() {
        use std::os::unix::fs::MetadataExt;
        let ma = std::fs::metadata(a)?;
        let mb = std::fs::metadata(b)?;
        if ma.dev() == mb.dev() && ma.ino() == mb.ino() {
            return Ok(true);
        }
    }
    #[cfg(windows)]
    if a.is_file() && b.is_file() && windows_file_identity(a)? == windows_file_identity(b)? {
        return Ok(true);
    }
    Ok(false)
}

#[cfg(windows)]
fn windows_file_identity(path: &Path) -> Result<(u64, [u8; 16])> {
    use std::os::windows::io::AsRawHandle;
    use windows_sys::Win32::Storage::FileSystem::{
        FileIdInfo, GetFileInformationByHandleEx, FILE_ID_INFO,
    };

    let file = std::fs::File::open(path)
        .with_context(|| format!("cannot open file identity handle for {}", path.display()))?;
    let mut info = FILE_ID_INFO::default();
    // SAFETY: `file` owns a valid handle for the duration of the call and `info` is a writable,
    // correctly sized FILE_ID_INFO buffer. The API does not retain either pointer.
    let succeeded = unsafe {
        GetFileInformationByHandleEx(
            file.as_raw_handle(),
            FileIdInfo,
            (&mut info as *mut FILE_ID_INFO).cast(),
            std::mem::size_of::<FILE_ID_INFO>() as u32,
        )
    };
    if succeeded == 0 {
        return Err(std::io::Error::last_os_error())
            .with_context(|| format!("cannot read Windows file identity for {}", path.display()));
    }
    if info.FileId.Identifier == [0; 16] {
        bail!(
            "Windows did not provide a stable file identity for {}",
            path.display()
        );
    }
    Ok((info.VolumeSerialNumber, info.FileId.Identifier))
}

fn validate_output_paths(inputs: &[&Path], out: &Path, meta: Option<&Path>) -> Result<PathBuf> {
    let meta = meta
        .map(Path::to_path_buf)
        .unwrap_or_else(|| default_meta_path(out));
    if paths_alias(out, &meta)? {
        bail!("--meta must differ from --out (the paths resolve to the same file)");
    }
    for input in inputs {
        if paths_alias(out, input)? || paths_alias(&meta, input)? {
            bail!(
                "output path aliases input file {} (refusing to overwrite an input)",
                input.display()
            );
        }
    }
    Ok(meta)
}

/// Encode `dev` to `out` and write the sidecar. `started` is the start of the whole command.
pub fn write_outputs(
    dev: &mut Developed,
    out: &Path,
    meta: Option<&Path>,
    started: Instant,
) -> Result<PathBuf> {
    let meta = validate_output_paths(&[], out, meta)?;
    match std::fs::remove_file(&meta) {
        Ok(()) => {}
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
        Err(error) => {
            return Err(error)
                .with_context(|| format!("cannot clear stale sidecar {}", meta.display()))
        }
    }
    let t = Instant::now();
    encode::write_png16(out, &dev.rgb, dev.width, dev.height)?;
    dev.sidecar.timings_ms.encode = ms(t);
    dev.sidecar.timings_ms.total = ms(started);
    let mut json = serde_json::to_vec_pretty(&dev.sidecar)?;
    json.push(b'\n');
    encode::write_atomic(&meta, &json)?;
    Ok(meta)
}

/// `render`: raw + DCP → working copy PNG + sidecar.
pub fn render_files(
    raw: &Path,
    dcp_path: &Path,
    out: &Path,
    meta: Option<&Path>,
    long_edge: usize,
) -> Result<Developed> {
    validate_output_paths(&[raw, dcp_path], out, meta)?;
    let started = Instant::now();
    let d = dcp::load_dcp(dcp_path)?;
    let mut dev = develop(raw, Mode::Render(&d), long_edge)?;
    write_outputs(&mut dev, out, meta, started)?;
    Ok(dev)
}

/// `dump-camera`: raw → white-balanced camera RGB PNG + sidecar.
pub fn dump_camera_files(
    raw: &Path,
    out: &Path,
    meta: Option<&Path>,
    long_edge: usize,
) -> Result<Developed> {
    validate_output_paths(&[raw], out, meta)?;
    let started = Instant::now();
    let mut dev = develop(raw, Mode::DumpCamera, long_edge)?;
    write_outputs(&mut dev, out, meta, started)?;
    Ok(dev)
}

#[cfg(test)]
mod output_path_tests {
    use super::*;

    fn test_dir() -> PathBuf {
        let nonce = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let dir = std::env::temp_dir().join(format!(
            "niho-base-raw-output-paths-{}-{}",
            std::process::id(),
            nonce
        ));
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    #[test]
    fn rejects_output_that_is_the_raw_input_before_reading_dcp() {
        let dir = test_dir();
        let raw = dir.join("input.raw");
        std::fs::write(&raw, b"not a raw file").unwrap();
        let result = render_files(&raw, &dir.join("missing.dcp"), &raw, None, 16);
        let error = match result {
            Err(error) => error,
            Ok(_) => panic!("render unexpectedly overwrote its raw input"),
        };
        assert!(format!("{error:#}").contains("aliases input"));
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn rejects_sidecar_aliases_to_input_and_hardlinked_output() {
        let dir = test_dir();
        let raw = dir.join("input.raw");
        let out = dir.join("output.png");
        let hardlink = dir.join("same-input.raw");
        std::fs::write(&raw, b"raw").unwrap();
        std::fs::write(&out, b"png").unwrap();
        std::fs::hard_link(&raw, &hardlink).unwrap();
        assert!(!paths_alias(&raw, &out).unwrap());
        assert!(validate_output_paths(&[&raw], &out, Some(&hardlink)).is_err());
        assert!(validate_output_paths(&[], &out, Some(&out)).is_err());
        let _ = std::fs::remove_dir_all(dir);
    }
}

/// `camera-info` report.
#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CameraInfoReport {
    pub make: String,
    pub model: String,
    pub clean_make: String,
    pub clean_model: String,
    pub full_width: usize,
    pub full_height: usize,
    pub crop: CropReport,
    pub cfa: String,
    pub bits_per_sample: u32,
    pub black_level: Vec<serde_json::Value>,
    pub white_level: Vec<serde_json::Value>,
    pub wb_coeffs: [f64; 3],
    pub as_shot_multipliers: [f64; 3],
    pub as_shot_neutral: [f64; 3],
    pub orientation: String,
    pub orientation_exif: u16,
    pub orientation_source: String,
    pub iso: Option<f64>,
    pub baseline_exposure: Option<f64>,
    pub baseline_exposure_source: Option<String>,
    pub rawler_color_matrices: BTreeMap<String, Vec<f64>>,
    pub decode_ms: f64,
}

#[derive(Clone, Debug, Serialize)]
pub struct CropReport {
    pub x: usize,
    pub y: usize,
    pub width: usize,
    pub height: usize,
}

pub fn camera_info(raw_path: &Path) -> Result<CameraInfoReport> {
    let t = Instant::now();
    let raw = decode::decode_file(raw_path)?;
    let decode_ms = ms(t);
    Ok(CameraInfoReport {
        make: raw.make.clone(),
        model: raw.model.clone(),
        clean_make: raw.clean_make.clone(),
        clean_model: raw.clean_model.clone(),
        full_width: raw.full_width,
        full_height: raw.full_height,
        crop: CropReport {
            x: raw.crop.x,
            y: raw.crop.y,
            width: raw.crop.width,
            height: raw.crop.height,
        },
        cfa: raw.cfa_name(),
        bits_per_sample: raw.bits_per_sample,
        black_level: raw.black_reported.iter().map(|&x| json_number(x)).collect(),
        white_level: raw.white_reported.iter().map(|&x| json_number(x)).collect(),
        wb_coeffs: [
            raw.wb_coeffs[0] as f64,
            raw.wb_coeffs[1] as f64,
            raw.wb_coeffs[2] as f64,
        ],
        as_shot_multipliers: raw.as_shot_multipliers(),
        as_shot_neutral: raw.as_shot_neutral(),
        orientation: raw.orientation.name().to_string(),
        orientation_exif: raw.orientation.exif_value(),
        orientation_source: raw.orientation_source.to_string(),
        iso: raw.iso,
        baseline_exposure: raw.baseline_exposure,
        baseline_exposure_source: raw.baseline_exposure_source.map(str::to_string),
        rawler_color_matrices: raw.rawler_color_matrices.iter().cloned().collect(),
        decode_ms,
    })
}
