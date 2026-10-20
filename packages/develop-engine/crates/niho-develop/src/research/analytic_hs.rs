//! Isolated analytic image-adaptive Highlights/Shadows candidate B (#26).
//!
//! This is deliberately outside the production pipeline. It uses scene
//! mean log luminance for highlights and p90 log luminance for shadows,
//! with an optional frozen residual whose contribution is hard bounded.
//! The module contains no fitting/training routine and must not be tuned on
//! an independent holdout.

use crate::color::{mat_vec_f32, PP_LUMA_F32, SRGB_TO_PROPHOTO_F32};
use crate::decode::{LinearImage, Raster};
use crate::niho6::SourceSpace;
use crate::pipeline::{self, RenderOptions, Rendered};
use crate::settings::{DevelopSettings, ENGINE_NIHO_2};
use crate::Error;

pub const ANALYSIS_LONG_EDGE: usize = 750;
pub const MAX_RESIDUAL_EV: f64 = 0.5;
pub const MAX_HIGHLIGHT_GAIN_EV: f64 = 4.0;
pub const MAX_SHADOW_GAIN_EV: f64 = 3.0;

#[derive(Debug, Clone, Copy, PartialEq)]
pub struct ResidualModel {
    pub highlight: [f64; 3],
    pub shadow: [f64; 3],
    pub max_residual_ev: f64,
}

impl Default for ResidualModel {
    fn default() -> Self {
        Self {
            highlight: [0.0; 3],
            shadow: [0.0; 3],
            max_residual_ev: 0.0,
        }
    }
}

impl ResidualModel {
    pub fn validate(self) -> Result<Self, String> {
        if !self
            .highlight
            .iter()
            .chain(&self.shadow)
            .all(|value| value.is_finite() && value.abs() <= 8.0)
        {
            return Err("residual coefficients must be finite and within -8..8".into());
        }
        if !self.max_residual_ev.is_finite()
            || !(0.0..=MAX_RESIDUAL_EV).contains(&self.max_residual_ev)
        {
            return Err(format!(
                "maxResidualEV must be finite and within 0..{MAX_RESIDUAL_EV}"
            ));
        }
        Ok(self)
    }

    fn values(self, mean_ln: f64, p90_ln: f64) -> (f64, f64) {
        let features = [
            1.0,
            (mean_ln / 8.0).clamp(-1.0, 1.0),
            (p90_ln / 8.0).clamp(-1.0, 1.0),
        ];
        let eval = |coefficients: [f64; 3]| {
            let raw = coefficients
                .iter()
                .zip(features)
                .map(|(coefficient, feature)| coefficient * feature)
                .sum::<f64>();
            libm::tanh(raw) * self.max_residual_ev
        };
        (eval(self.highlight), eval(self.shadow))
    }
}

#[derive(Debug, Clone, Copy, PartialEq)]
pub struct Analysis {
    pub mean_log_luminance: f64,
    pub p90_log_luminance: f64,
    pub exposure_ev: f64,
    pub highlight_residual_ev: f64,
    pub shadow_residual_ev: f64,
}

#[derive(Debug, Clone, Copy, PartialEq)]
pub struct ApplySummary {
    pub analysis: Analysis,
    pub min_gain_ev: f64,
    pub max_gain_ev: f64,
    pub non_finite_pixels: usize,
}

fn analyze(
    image: &LinearImage,
    space: SourceSpace,
    exposure_ev: f64,
    residual: ResidualModel,
) -> Analysis {
    let small = crate::niho6::analysis_image(image, space);
    let stats = crate::spatial::compute_stats(&small.data, small.width, small.height, PP_LUMA_F32);
    let exposure_ev = if exposure_ev.is_finite() {
        exposure_ev.clamp(-5.0, 5.0)
    } else {
        0.0
    };
    let mean = stats.mean_ln + exposure_ev;
    let p90 = stats.full_p90 + exposure_ev;
    let (highlight_residual_ev, shadow_residual_ev) = residual.values(mean, p90);
    Analysis {
        mean_log_luminance: mean,
        p90_log_luminance: p90,
        exposure_ev,
        highlight_residual_ev,
        shadow_residual_ev,
    }
}

fn smoothstep(value: f64) -> f64 {
    let t = value.clamp(0.0, 1.0);
    t * t * (3.0 - 2.0 * t)
}

// Analytic anchors are provisional research parameters, not a Lightroom
// calibration. Unlike a pointwise gain, the actual operator below is the
// existing multi-resolution local Laplacian from spatial.rs.
fn local_params(
    settings: &DevelopSettings,
    analysis: Analysis,
    long_edge: usize,
) -> crate::spatial::SpatialParams {
    use crate::spatial::{GainScale, Quality, Shift, SpatialParams};
    SpatialParams {
        highlights: settings.highlights.min(0.0),
        shadows: settings.shadows.max(0.0),
        texture: 0.0,
        clarity: 0.0,
        scale_px: crate::spatial::scale_px(long_edge as f64),
        long_edge,
        gain_scale: GainScale {
            highlights_neg: (0.72 - 0.11 * analysis.mean_log_luminance).clamp(0.35, 1.35),
            highlights_pos: 0.0,
            shadows_neg: 0.0,
            shadows_pos: (0.82 + 0.10 * analysis.p90_log_luminance).clamp(0.45, 1.30),
        },
        shift: Shift {
            highlights: (analysis.mean_log_luminance + 4.0).clamp(-8.0, 2.0),
            shadows: (analysis.p90_log_luminance + 1.0).clamp(-8.0, 2.0),
        },
        quality: Quality::Final,
    }
}

/// Applies candidate B to a copy of `image`. The source can be decoded
/// linear sRGB or linear ProPhoto; the operation itself is linear ProPhoto.
pub fn prepare(
    image: &LinearImage,
    space: SourceSpace,
    settings: &DevelopSettings,
    residual: ResidualModel,
) -> Result<(LinearImage, ApplySummary), String> {
    let residual = residual.validate()?;
    if image
        .width
        .checked_mul(image.height)
        .and_then(|n| n.checked_mul(3))
        != Some(image.data.len())
        || image.width == 0
        || image.height == 0
        || !image.data.iter().all(|v| v.is_finite())
    {
        return Err("invalid or non-finite linear image".into());
    }
    let analysis = analyze(image, space, settings.exposure, residual);
    let mut output = image.clone();
    if settings.highlights >= 0.0 && settings.shadows <= 0.0 {
        return Ok((
            output,
            ApplySummary {
                analysis,
                min_gain_ev: 0.0,
                max_gain_ev: 0.0,
                non_finite_pixels: 0,
            },
        ));
    }
    let prophoto: Vec<f32> = image
        .data
        .chunks_exact(3)
        .flat_map(|pixel| {
            let rgb = [pixel[0], pixel[1], pixel[2]];
            if space == SourceSpace::LinearSrgb {
                mat_vec_f32(&SRGB_TO_PROPHOTO_F32, rgb)
            } else {
                rgb
            }
        })
        .collect();
    let mut exposed = crate::spatial::luminance_plane(&prophoto, image.width, image.height);
    for value in &mut exposed.data {
        *value += analysis.exposure_ev as f32;
    }
    let params = local_params(settings, analysis, image.width.max(image.height));
    let mapped =
        crate::spatial::spatial_luminance(&exposed, &params).ok_or("no local H/S response")?;
    let mut min_gain_ev = f64::INFINITY;
    let mut max_gain_ev = f64::NEG_INFINITY;
    let non_finite_pixels = 0;
    for (index, pixel) in output.data.chunks_exact_mut(3).enumerate() {
        let value = f64::from(exposed.data[index]);
        let h_weight = smoothstep((value - analysis.mean_log_luminance + 1.0) / 5.0);
        let s_weight = smoothstep((analysis.p90_log_luminance - value + 0.5) / 7.0);
        let residual_ev = (-settings.highlights / 100.0).clamp(0.0, 1.0)
            * h_weight
            * analysis.highlight_residual_ev
            + (settings.shadows / 100.0).clamp(0.0, 1.0) * s_weight * analysis.shadow_residual_ev;
        let gain_ev = (f64::from(mapped.data[index] - exposed.data[index]) + residual_ev)
            .clamp(-MAX_HIGHLIGHT_GAIN_EV, MAX_SHADOW_GAIN_EV);
        min_gain_ev = min_gain_ev.min(gain_ev);
        max_gain_ev = max_gain_ev.max(gain_ev);
        // A scalar gain commutes with the source-space matrix. Applying it
        // directly avoids an unnecessary round trip and makes zero edits exact.
        let gain = libm::exp2(gain_ev) as f32;
        for value in pixel {
            *value *= gain;
        }
    }
    Ok((
        output,
        ApplySummary {
            analysis,
            min_gain_ev,
            max_gain_ev,
            non_finite_pixels,
        },
    ))
}

/// A/B render entry point for private-reference owners. A is the unchanged
/// `niho-2` renderer. B replaces only negative Highlights / positive
/// Shadows with this candidate, then runs the same remaining `niho-2`
/// stages. Geometry is intentionally excluded from this reproducible probe.
pub fn render_pair(
    input: &[u8],
    settings: &DevelopSettings,
    options: &RenderOptions,
    residual: ResidualModel,
) -> Result<(Rendered, Rendered, ApplySummary), Error> {
    if settings
        .geometry
        .as_ref()
        .is_some_and(|geometry| !geometry.is_identity())
    {
        return Err(Error::IncompatibleWorkingCopy(
            "analytic H/S probe requires uncropped input; evaluate geometry separately".into(),
        ));
    }
    let mut baseline_settings = settings.clone();
    baseline_settings.engine = ENGINE_NIHO_2.into();
    let raster = crate::decode::decode_raster(input, options.max_dimension, options.filter)?;
    let baseline =
        pipeline::render_raster(&raster, &baseline_settings, options.quality, None, None).0;
    let (prepared, summary) = prepare(
        &raster.image,
        SourceSpace::LinearSrgb,
        &baseline_settings,
        residual,
    )
    .map_err(Error::Niho6Prepare)?;
    let candidate_raster = Raster {
        image: prepared,
        info: raster.info,
    };
    let mut downstream = baseline_settings;
    downstream.highlights = downstream.highlights.max(0.0);
    downstream.shadows = downstream.shadows.min(0.0);
    let candidate =
        pipeline::render_raster(&candidate_raster, &downstream, options.quality, None, None).0;
    Ok((baseline, candidate, summary))
}

pub fn gate_contract_json() -> serde_json::Value {
    serde_json::json!({
        "longEdge": 1500,
        "blurRadius": 2,
        "pixels": "flat",
        "neutralMeanDeltaE00Max": 2.0,
        "presetMeanDeltaE00Max": 3.0,
        "p99DeltaE00Max": 8.0,
        "freezeBeforeIndependentEvaluation": true
    })
}

/// Reads an optional frozen residual manifest. The coefficient digest is of
/// the canonical JSON object `{highlight,shadow,maxResidualEV}`.
pub fn residual_from_manifest(bytes: &[u8]) -> Result<(ResidualModel, String), String> {
    let value: serde_json::Value =
        serde_json::from_slice(bytes).map_err(|error| error.to_string())?;
    if value["schema"] != "niho.analytic-hs-residual.v1" || value["frozen"] != true {
        return Err("residual manifest must be frozen niho.analytic-hs-residual.v1".into());
    }
    let vector = |key: &str| -> Result<[f64; 3], String> {
        let values = value[key]
            .as_array()
            .ok_or_else(|| format!("{key} must be an array"))?;
        if values.len() != 3 {
            return Err(format!("{key} must contain three coefficients"));
        }
        Ok([
            values[0].as_f64().ok_or_else(|| format!("{key}[0]"))?,
            values[1].as_f64().ok_or_else(|| format!("{key}[1]"))?,
            values[2].as_f64().ok_or_else(|| format!("{key}[2]"))?,
        ])
    };
    let model = ResidualModel {
        highlight: vector("highlight")?,
        shadow: vector("shadow")?,
        max_residual_ev: value["maxResidualEV"]
            .as_f64()
            .ok_or_else(|| "maxResidualEV".to_string())?,
    }
    .validate()?;
    let canonical = serde_json::to_vec(&serde_json::json!({
        "highlight": model.highlight,
        "shadow": model.shadow,
        "maxResidualEV": model.max_residual_ev
    }))
    .map_err(|error| error.to_string())?;
    let digest = niho_camera_profile::dcp::sha256_hex(&canonical);
    if value["coefficientsSha256"].as_str() != Some(digest.as_str()) {
        return Err("coefficientsSha256 does not match canonical coefficients".into());
    }
    Ok((model, digest))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn scene(kind: &str) -> LinearImage {
        let (width, height) = (96, 64);
        let mut data = Vec::with_capacity(width * height * 3);
        for y in 0..height {
            for x in 0..width {
                let t = x as f32 / (width - 1) as f32;
                let v = match kind {
                    "night" => 0.002 + 0.035 * t,
                    "window" if x > width * 2 / 3 => 0.85 + 0.1 * t,
                    "window" => 0.015 + 0.12 * t,
                    _ => 0.15 + 0.65 * t,
                };
                let row = 0.95 + 0.05 * y as f32 / height as f32;
                data.extend_from_slice(&[v * row, v * row, v * row]);
            }
        }
        LinearImage {
            width,
            height,
            data,
        }
    }

    #[test]
    fn dark_night_and_bright_window_are_finite_and_bounded() {
        let mut settings = DevelopSettings::neutral();
        settings.highlights = -100.0;
        settings.shadows = 100.0;
        for kind in ["dark", "night", "window"] {
            let (output, summary) = prepare(
                &scene(kind),
                SourceSpace::LinearProPhoto,
                &settings,
                ResidualModel::default(),
            )
            .unwrap();
            assert!(output.data.iter().all(|value| value.is_finite()), "{kind}");
            assert_eq!(summary.non_finite_pixels, 0);
            assert!(summary.min_gain_ev >= -MAX_HIGHLIGHT_GAIN_EV);
            assert!(summary.max_gain_ev <= MAX_SHADOW_GAIN_EV);
            for pixel in output.data.chunks_exact(3) {
                assert!((pixel[0] - pixel[1]).abs() < 1e-6);
                assert!((pixel[1] - pixel[2]).abs() < 1e-6);
            }
        }
    }

    #[test]
    fn zero_amounts_are_bit_identical_and_exposure_changes_analysis() {
        let image = scene("window");
        let neutral = DevelopSettings::neutral();
        let (same, _) = prepare(
            &image,
            SourceSpace::LinearProPhoto,
            &neutral,
            ResidualModel::default(),
        )
        .unwrap();
        assert_eq!(same.data, image.data);

        let mut brighter = neutral;
        brighter.exposure = 1.0;
        brighter.highlights = -80.0;
        let (_, at_one) = prepare(
            &image,
            SourceSpace::LinearProPhoto,
            &brighter,
            ResidualModel::default(),
        )
        .unwrap();
        brighter.exposure = 0.0;
        let (_, at_zero) = prepare(
            &image,
            SourceSpace::LinearProPhoto,
            &brighter,
            ResidualModel::default(),
        )
        .unwrap();
        assert_eq!(
            at_one.analysis.mean_log_luminance,
            at_zero.analysis.mean_log_luminance + 1.0
        );
        assert_ne!(at_one.min_gain_ev, at_zero.min_gain_ev);
    }
}
