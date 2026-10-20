//! V3 experiment: keep camera RGB in the working copy and defer WB/profile to render time.
//! No production stage-1 or stage-2 entry point calls this crate.

use std::path::Path;
#[cfg(not(target_arch = "wasm32"))]
use std::time::Instant;

use anyhow::{bail, ensure, Context, Result};
use niho_base_raw::decode::{CameraRaw, RawData};
use niho_base_raw::{color, dcp, demosaic, encode, matrix, orient, pipeline, resize};
use niho_develop::color as develop_color;
use serde::{Deserialize, Serialize};
#[cfg(feature = "wasm")]
use wasm_bindgen::prelude::*;

pub const SCHEMA: &str = "niho-camera-linear-probe/1";
pub const BASE_VERSION: &str = "probe-camera-linear-bilinear-png16-v1";

struct ProbeClock {
    #[cfg(not(target_arch = "wasm32"))]
    at: Instant,
}

impl ProbeClock {
    fn now() -> Self {
        Self {
            #[cfg(not(target_arch = "wasm32"))]
            at: Instant::now(),
        }
    }

    fn elapsed_ms(&self) -> f64 {
        #[cfg(not(target_arch = "wasm32"))]
        {
            self.at.elapsed().as_secs_f64() * 1000.0
        }
        #[cfg(target_arch = "wasm32")]
        {
            // JavaScript caller times wasm. std::time::Instant panics on this target.
            0.0
        }
    }
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkMeta {
    pub schema: String,
    pub base_version: String,
    pub camera_make: String,
    pub camera_model: String,
    pub as_shot_neutral: [f64; 3],
    pub dcp_sha256: String,
    pub raw_baseline_ev: f64,
    pub baseline_ev: f64,
    pub width: usize,
    pub height: usize,
    pub encoding: String,
}

pub struct WorkCopy {
    pub rgb: Vec<f32>,
    pub meta: WorkMeta,
}

/// Normalize CFA without white balance. The crop's Bayer phase remains unchanged.
fn normalized_cfa(raw: &CameraRaw) -> Vec<f32> {
    let mut out = vec![0.0; raw.crop.width * raw.crop.height];
    for y in 0..raw.crop.height {
        let row = (raw.crop.y + y) * raw.full_width + raw.crop.x;
        for x in 0..raw.crop.width {
            let site = (y & 1) * 2 + (x & 1);
            let sample = match &raw.data {
                RawData::U16(data) => data[row + x] as f32,
                RawData::F32(data) => data[row + x],
            };
            out[y * raw.crop.width + x] =
                ((sample - raw.black[site]) / (raw.white[site] - raw.black[site])).clamp(0.0, 1.0);
        }
    }
    out
}

/// Stage 1 stops at camera-linear RGB, before white balance and DCP color.
pub fn make(raw_path: &Path, profile: &dcp::LoadedDcp, long_edge: usize) -> Result<WorkCopy> {
    ensure!(long_edge > 0, "long edge must be positive");
    let mut raw = niho_base_raw::decode::decode_file(raw_path)?;
    let as_shot_neutral = raw.as_shot_neutral();
    let (w, h) = (raw.crop.width, raw.crop.height);
    let cfa = normalized_cfa(&raw);
    raw.data = RawData::U16(Vec::new());
    let camera = demosaic::bilinear(&cfa, w, h, raw.pattern);
    drop(cfa);
    let (rw, rh) = resize::target_size(w, h, long_edge);
    let resized = if (rw, rh) == (w, h) {
        camera
    } else {
        resize::lanczos3_rgb(&camera, w, h, rw, rh)
    };
    let (rgb, width, height) = orient::apply(resized, rw, rh, raw.orientation);
    Ok(WorkCopy {
        rgb,
        meta: WorkMeta {
            schema: SCHEMA.into(),
            base_version: BASE_VERSION.into(),
            camera_make: raw.clean_make,
            camera_model: raw.clean_model,
            as_shot_neutral,
            dcp_sha256: profile.sha256.clone(),
            raw_baseline_ev: raw.baseline_exposure.unwrap_or(0.0),
            baseline_ev: raw.baseline_exposure.unwrap_or(0.0)
                + profile.spec.baseline_exposure_offset,
            width,
            height,
            encoding: "png16-power-1/1.8-max2".into(),
        },
    })
}

fn target_neutral(spec: &dcp::DcpSpec, kelvin: f64, tint: f64) -> Result<[f64; 3]> {
    ensure!(
        kelvin.is_finite() && (2000.0..=100_000.0).contains(&kelvin),
        "invalid Kelvin"
    );
    ensure!(tint.is_finite() && tint.abs() <= 150.0, "invalid tint");
    let xy = develop_color::xy_from_temperature(kelvin, tint);
    let xyz = color::xy_to_xyz(&[xy.x, xy.y]);
    let cm1 = matrix::from_row_major(&spec.color_matrix1).context("invalid ColorMatrix1")?;
    let cm = if let (Some(il2), Some(cm2)) = (spec.illuminant2, &spec.color_matrix2) {
        let cm2 = matrix::from_row_major(cm2).context("invalid ColorMatrix2")?;
        match (
            color::illuminant_cct(spec.illuminant1),
            color::illuminant_cct(il2),
        ) {
            (Some(t1), Some(t2)) => {
                matrix::blend(&cm1, &cm2, color::interpolation_weight(kelvin, t1, t2))
            }
            _ => cm1,
        }
    } else {
        cm1
    };
    let n = matrix::mul_vec(&cm, &xyz);
    ensure!(
        n.iter().all(|v| v.is_finite() && *v > 0.0),
        "target neutral outside profile gamut"
    );
    let max = n.iter().copied().fold(0.0_f64, f64::max);
    Ok([n[0] / max, n[1] / max, n[2] / max])
}

pub struct Rendered {
    pub rgb: Vec<f32>,
    pub width: usize,
    pub height: usize,
    pub transform_ms: f64,
    pub setup_ms: f64,
    pub decode_ms: f64,
    pub white_balance_ms: f64,
    pub color_ms: f64,
    pub neutral: [f64; 3],
    pub white_xy: [f64; 2],
    pub profile_sha256: String,
    pub profile_changed: bool,
    pub baseline_ev: f64,
}

/// Experimental stage-2 prefix. A different explicit profile is allowed because
/// the camera-linear pixels do not contain the earlier profile. The returned
/// linear ProPhoto image can enter the existing stage-2 renderer; only this
/// prefix is timed here.
pub fn render(
    codes: &[u16],
    meta: &WorkMeta,
    profile: &dcp::LoadedDcp,
    white: Option<(f64, f64)>,
) -> Result<Rendered> {
    ensure!(
        meta.schema == SCHEMA && meta.base_version == BASE_VERSION,
        "unknown camera-linear version"
    );
    ensure!(
        meta.encoding == "png16-power-1/1.8-max2",
        "unknown working-copy encoding"
    );
    ensure!(
        codes.len() == meta.width * meta.height * 3,
        "working-copy dimensions mismatch"
    );
    let camera = format!("{} {}", meta.camera_make, meta.camera_model);
    ensure!(
        camera.eq_ignore_ascii_case(&profile.spec.unique_camera_model),
        "profile camera mismatch"
    );
    let setup = ProbeClock::now();
    let neutral = match white {
        Some((kelvin, tint)) => target_neutral(&profile.spec, kelvin, tint)?,
        None => meta.as_shot_neutral,
    };
    let pc = color::resolve_profile_color(&profile.spec, &neutral)?;
    let gains = [1.0 / neutral[0], 1.0 / neutral[1], 1.0 / neutral[2]];
    let setup_ms = setup.elapsed_ms();
    let start = ProbeClock::now();
    let mut rgb: Vec<f32> = codes.iter().map(|&v| encode::decode_value(v)).collect();
    let decode_ms = start.elapsed_ms();
    let step = ProbeClock::now();
    for px in rgb.as_chunks_mut::<3>().0 {
        for c in 0..3 {
            px[c] = (px[c] * gains[c] as f32).min(1.0);
        }
    }
    let white_balance_ms = step.elapsed_ms();
    let step = ProbeClock::now();
    pipeline::apply_color(&mut rgb, meta.width, &pc);
    let color_ms = step.elapsed_ms();
    let transform_ms = start.elapsed_ms();
    Ok(Rendered {
        rgb,
        width: meta.width,
        height: meta.height,
        transform_ms,
        setup_ms,
        decode_ms,
        white_balance_ms,
        color_ms,
        neutral,
        white_xy: pc.white_xy,
        profile_sha256: profile.sha256.clone(),
        profile_changed: meta.dcp_sha256 != profile.sha256,
        baseline_ev: meta.raw_baseline_ev + profile.spec.baseline_exposure_offset,
    })
}

/// Sidecar for the temporary ProPhoto image handed to the existing stage-2
/// renderer. The settings' white has already been resolved from camera RGB.
pub fn stage2_handoff_meta(rendered: &Rendered) -> serde_json::Value {
    serde_json::json!({
        "kind": "raw",
        "baseVersion": format!("{}-rendered-dcp-{}", BASE_VERSION, rendered.profile_sha256),
        "baselineEV": rendered.baseline_ev,
        "asShotWhite": {"x": rendered.white_xy[0], "y": rendered.white_xy[1]},
        "dcpSha256": rendered.profile_sha256,
        "lookTableIncluded": false
    })
}

pub fn load_work_copy(png_path: &Path, meta_path: &Path) -> Result<(Vec<u16>, WorkMeta)> {
    let meta: WorkMeta = serde_json::from_slice(&std::fs::read(meta_path)?)?;
    let (codes, width, height) = encode::read_png16(&std::fs::read(png_path)?)?;
    if width != meta.width || height != meta.height {
        bail!("PNG and sidecar dimensions disagree");
    }
    Ok((codes, meta))
}

pub fn write_work_copy(path: &Path, work: &WorkCopy) -> Result<()> {
    encode::write_png16(path, &work.rgb, work.meta.width, work.meta.height)?;
    let sidecar = path.with_extension("json");
    let data = serde_json::to_vec_pretty(&work.meta).context("serialize camera-linear metadata")?;
    encode::write_atomic(&sidecar, &data)
}

/// The exact experimental stage-2 prefix used by the native CLI, exposed for
/// a byte-level native/wasm comparison. Input DCP bytes are supplied by the caller.
#[cfg(feature = "wasm")]
#[wasm_bindgen]
pub fn render_codes_wasm(
    codes: &[u16],
    meta_json: &str,
    dcp_bytes: &[u8],
    kelvin: f64,
    tint: f64,
) -> std::result::Result<Vec<u16>, JsValue> {
    let run = || -> Result<Vec<u16>> {
        let meta: WorkMeta = serde_json::from_str(meta_json)?;
        let spec = dcp::DcpSpec::from_dcp_bytes(dcp_bytes)?;
        let profile = dcp::LoadedDcp {
            spec,
            sha256: dcp::sha256_hex(dcp_bytes),
        };
        let white = if kelvin > 0.0 {
            Some((kelvin, tint))
        } else {
            None
        };
        let rendered = render(codes, &meta, &profile, white)?;
        Ok(rendered.rgb.into_iter().map(encode::encode_value).collect())
    };
    run().map_err(|error| JsValue::from_str(&format!("{error:#}")))
}

#[cfg(test)]
mod tests {
    use super::*;

    use niho_camera_color::color::ProfileInput;
    use niho_develop::camera_linear::to_linear_prophoto;
    use niho_develop::LinearImage;

    #[test]
    // `as_chunks_mut` is newer than the workspace MSRV; keep this test compatible with Rust 1.85.
    #[allow(clippy::chunks_exact_to_as_chunks)]
    fn pure_stage2_prefix_matches_unclipped_probe_pixels() {
        let spec = dcp::DcpSpec::from_dcp_bytes(include_bytes!(
            "../../niho-base-raw/profiles/panasonic-dc-s5/niho-dc-s5-independent-v1.dcp"
        ))
        .unwrap();
        let neutral = [0.5, 1.0, 0.25];
        let camera = LinearImage {
            width: 1,
            height: 1,
            data: vec![0.02, 0.03, 0.04],
        };
        let mut old_probe = camera.data.clone();
        let gains = [1.0 / neutral[0], 1.0 / neutral[1], 1.0 / neutral[2]];
        for px in old_probe.chunks_exact_mut(3) {
            for channel in 0..3 {
                px[channel] = (px[channel] * gains[channel] as f32).min(1.0);
            }
        }
        let resolved = color::resolve_profile_color(&spec, &neutral).unwrap();
        pipeline::apply_color(&mut old_probe, 1, &resolved);

        let input = ProfileInput {
            illuminant1: spec.illuminant1,
            color_matrix1: &spec.color_matrix1,
            illuminant2: spec.illuminant2,
            color_matrix2: spec.color_matrix2.as_deref(),
            forward_matrix1: spec.forward_matrix1.as_deref(),
            forward_matrix2: spec.forward_matrix2.as_deref(),
            hue_sat_map: None,
        };
        let pure = to_linear_prophoto(&camera, &input, neutral).unwrap();
        assert_eq!(pure.data, old_probe);
    }

    #[test]
    fn neutral_at_d50_is_finite() {
        let spec = dcp::DcpSpec {
            schema: dcp::SPEC_SCHEMA.into(),
            profile_name: String::new(),
            unique_camera_model: "Synthetic Camera".into(),
            copyright: String::new(),
            embed_policy: 0,
            calibration_signature: String::new(),
            illuminant1: 21,
            color_matrix1: vec![1.0, 0.0, 0.0, 0.0, 1.0, 0.0, 0.0, 0.0, 1.0],
            illuminant2: None,
            color_matrix2: None,
            forward_matrix1: None,
            forward_matrix2: None,
            hue_sat_map: None,
            baseline_exposure_offset: 0.0,
            default_black_render: 0,
            tone_curve: None,
            look_table: None,
        };
        let neutral = target_neutral(&spec, 5000.0, 0.0).unwrap();
        assert!(neutral.iter().all(|v| *v > 0.0 && *v <= 1.0));
    }

    #[test]
    fn two_illuminant_white_round_trips_through_profile() {
        let profile = dcp::load_dcp(
            &Path::new(env!("CARGO_MANIFEST_DIR"))
                .join("../niho-base-raw/profiles/panasonic-dc-s5/niho-dc-s5-independent-v1.dcp"),
        )
        .unwrap();
        let mut spec = profile.spec;
        spec.illuminant2 = Some(17);
        let mut cm2 = spec.color_matrix1.clone();
        cm2[0] *= 1.08;
        cm2[8] *= 0.92;
        spec.color_matrix2 = Some(cm2);
        spec.forward_matrix2 = spec.forward_matrix1.clone();
        for kelvin in [4000.0, 5500.0, 7500.0] {
            let neutral = target_neutral(&spec, kelvin, 10.0).unwrap();
            let resolved = color::resolve_profile_color(&spec, &neutral).unwrap();
            let target = develop_color::xy_from_temperature(kelvin, 10.0);
            assert!((resolved.white_xy[0] - target.x).abs() < 2e-4);
            assert!((resolved.white_xy[1] - target.y).abs() < 2e-4);
        }
    }

    #[test]
    fn profile_update_reuses_camera_pixels_and_updates_handoff_identity() {
        let mut profile = dcp::load_dcp(
            &Path::new(env!("CARGO_MANIFEST_DIR"))
                .join("../niho-base-raw/profiles/panasonic-dc-s5/niho-dc-s5-independent-v1.dcp"),
        )
        .unwrap();
        let meta = WorkMeta {
            schema: SCHEMA.into(),
            base_version: BASE_VERSION.into(),
            camera_make: "Panasonic".into(),
            camera_model: "DC-S5".into(),
            as_shot_neutral: [0.55, 1.0, 0.48],
            dcp_sha256: profile.sha256.clone(),
            raw_baseline_ev: 0.2,
            baseline_ev: 0.2 + profile.spec.baseline_exposure_offset,
            width: 1,
            height: 1,
            encoding: "png16-power-1/1.8-max2".into(),
        };
        let first = render(&[10000, 12000, 14000], &meta, &profile, None).unwrap();
        assert!(!first.profile_changed);
        profile.sha256 = "e".repeat(64);
        profile.spec.baseline_exposure_offset = 0.1;
        let changed = render(&[10000, 12000, 14000], &meta, &profile, None).unwrap();
        assert!(changed.profile_changed);
        assert!((changed.baseline_ev - 0.3).abs() < 1e-12);
        let handoff = stage2_handoff_meta(&changed);
        assert_eq!(handoff["dcpSha256"], profile.sha256);
        assert!((handoff["baselineEV"].as_f64().unwrap() - 0.3).abs() < 1e-12);
        assert_ne!(
            stage2_handoff_meta(&first)["baseVersion"],
            handoff["baseVersion"]
        );
    }
}
