//! Isolated analytic image-adaptive Highlights/Shadows candidate B (#26).
//!
//! This is deliberately outside the production pipeline. It drives the
//! existing multi-resolution local Laplacian of `spatial.rs` with gain scales
//! and shifts that are linear in the scene statistics (mean log2 luminance for
//! Highlights, p90 log2 luminance for Shadows), adds an optional hard-bounded
//! residual, and lets the colour difference follow its own exponent of the
//! luminance gain. The module contains no fitting routine: coefficients come
//! from a frozen manifest (`niho.analytic-hs-candidate.v1`, or `.v2` for
//! candidate C) produced outside the crate on development teachers only, and
//! must not be tuned on an independent holdout.
//!
//! Candidate C keeps the same operator but predicts each photo's gain
//! scales, shifts and chroma exponents from photo-level summaries of the
//! `niho-6` response's 26 features ([`photo_features`]) with a linear model
//! whose inputs are standardized and clipped and whose outputs are clamped
//! to fixed physical ranges, so photos outside the teachers saturate instead
//! of extrapolating.

use crate::color::{mat_vec_f32, PP_LUMA, PP_LUMA_F32, SRGB_TO_PROPHOTO, SRGB_TO_PROPHOTO_F32};
use crate::decode::{LinearImage, Raster};
use crate::niho6::SourceSpace;
use crate::pipeline::{self, RenderOptions, Rendered};
use crate::settings::{DevelopSettings, ENGINE_NIHO_6};
use crate::spatial::Plane;
use crate::Error;

pub const ANALYSIS_LONG_EDGE: usize = 750;
pub const MAX_RESIDUAL_EV: f64 = 0.5;
/// Hard bounds of the total per-pixel gain (EV).
pub const MAX_HIGHLIGHT_GAIN_EV: f64 = 4.0;
pub const MAX_SHADOW_GAIN_EV: f64 = 3.0;
/// Hard bounds of the resolved local-Laplacian gain scales and shifts. They
/// are part of the formula, not fitted: a scene outside the teachers'
/// statistics saturates here instead of extrapolating a line.
pub const HIGHLIGHT_SCALE_RANGE: (f64, f64) = (0.0, 3.5);
pub const SHADOW_SCALE_RANGE: (f64, f64) = (0.0, 2.5);
pub const SHIFT_RANGE: (f64, f64) = (-12.0, 8.0);
/// Accepted range of the colour-difference exponents.
pub const CHROMA_ALPHA_RANGE: (f64, f64) = (0.0, 1.5);
/// Accepted magnitude of each linear coefficient.
pub const MAX_LINEAR_COEFFICIENT: f64 = 16.0;

pub const CANDIDATE_SCHEMA: &str = "niho.analytic-hs-candidate.v1";
/// Candidate C: the v1 coefficients plus a per-photo model.
pub const CANDIDATE_MODEL_SCHEMA: &str = "niho.analytic-hs-candidate.v2";
/// Photo-level summaries of the 26 `raw_response` features
/// ([`photo_features`]).
pub const PHOTO_FEATURE_SET: &str = "niho6-features26-mean-std-v1";
pub const PHOTO_FEATURE_COUNT: usize = 39;
/// Model outputs: ln kH, sH − m, alphaH, ln kS, sS − q, alphaS.
pub const PHOTO_OUTPUT_COUNT: usize = 6;
/// Standardized inputs are clipped to ±this.
pub const PHOTO_FEATURE_Z_CLIP: f64 = 3.0;
/// Fixed ranges of the model outputs (natural log for the gain scales).
pub const PHOTO_OUTPUT_RANGES: [(f64, f64); PHOTO_OUTPUT_COUNT] = [
    (-2.995_732_273_553_991, 1.252_762_968_495_368), // kH 0.05..3.5
    (0.0, 12.0),
    (0.0, 1.5),
    (-2.995_732_273_553_991, 0.916_290_731_874_155), // kS 0.05..2.5
    (-4.0, 8.0),
    (0.5, 1.5),
];
/// Accepted magnitude of each model weight / bias.
pub const MAX_MODEL_COEFFICIENT: f64 = 64.0;
/// Per-pixel `raw_response` features summarized by mean and standard
/// deviation (the others are global or redundant: 0 = 1 + 2, 1 and 16..22
/// are photo constants, 25 is a rank).
const PHOTO_PIXEL_FEATURES: [usize; 15] = [3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 23, 24];

/// [`PHOTO_FEATURE_COUNT`] summaries of one photo at exposure 0.
pub type PhotoFeatures = [f64; PHOTO_FEATURE_COUNT];

/// Candidate C's linear model: `out = clamp(bias + W · clip((x − mean) / scale))`.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct PhotoModel {
    pub mean: [f64; PHOTO_FEATURE_COUNT],
    pub scale: [f64; PHOTO_FEATURE_COUNT],
    pub weights: [[f64; PHOTO_FEATURE_COUNT]; PHOTO_OUTPUT_COUNT],
    pub bias: [f64; PHOTO_OUTPUT_COUNT],
}

impl PhotoModel {
    pub fn validate(self) -> Result<Self, String> {
        let finite = |v: &f64| v.is_finite();
        if !self.mean.iter().all(finite) || !self.scale.iter().all(|v| v.is_finite() && *v > 1e-12)
        {
            return Err("model mean/scale must be finite and scale positive".into());
        }
        if !self
            .weights
            .iter()
            .flatten()
            .chain(&self.bias)
            .all(|v| v.is_finite() && v.abs() <= MAX_MODEL_COEFFICIENT)
        {
            return Err(format!(
                "model weights must be finite and within ±{MAX_MODEL_COEFFICIENT}"
            ));
        }
        Ok(self)
    }

    /// The clamped outputs for `features` seen at `exposure_ev` (only the
    /// photo's mean log luminance moves with the exposure).
    pub fn outputs(&self, features: &PhotoFeatures, exposure_ev: f64) -> [f64; PHOTO_OUTPUT_COUNT] {
        let mut z = [0.0; PHOTO_FEATURE_COUNT];
        for (i, slot) in z.iter_mut().enumerate() {
            let x = features[i] + if i == 0 { exposure_ev } else { 0.0 };
            let value = (x - self.mean[i]) / self.scale[i];
            *slot = if value.is_finite() {
                value.clamp(-PHOTO_FEATURE_Z_CLIP, PHOTO_FEATURE_Z_CLIP)
            } else {
                0.0
            };
        }
        let mut out = [0.0; PHOTO_OUTPUT_COUNT];
        for (j, slot) in out.iter_mut().enumerate() {
            let raw = self.bias[j]
                + self.weights[j]
                    .iter()
                    .zip(&z)
                    .map(|(w, x)| w * x)
                    .sum::<f64>();
            *slot = raw.clamp(PHOTO_OUTPUT_RANGES[j].0, PHOTO_OUTPUT_RANGES[j].1);
        }
        out
    }

    fn json(&self) -> serde_json::Value {
        serde_json::json!({
            "features": PHOTO_FEATURE_SET,
            "mean": self.mean.to_vec(),
            "scale": self.scale.to_vec(),
            "weights": self.weights.iter().map(|w| w.to_vec()).collect::<Vec<_>>(),
            "bias": self.bias.to_vec()
        })
    }

    fn from_json(value: &serde_json::Value) -> Result<Self, String> {
        if value["features"] != PHOTO_FEATURE_SET {
            return Err(format!("model features must be {PHOTO_FEATURE_SET}"));
        }
        let vector = |v: &serde_json::Value, key: &str, n: usize| -> Result<Vec<f64>, String> {
            let values = v
                .as_array()
                .ok_or_else(|| format!("{key} must be an array"))?;
            if values.len() != n {
                return Err(format!("{key} must contain {n} values"));
            }
            values
                .iter()
                .map(|x| x.as_f64().ok_or_else(|| format!("{key} must be numbers")))
                .collect()
        };
        let mut model = PhotoModel {
            mean: [0.0; PHOTO_FEATURE_COUNT],
            scale: [0.0; PHOTO_FEATURE_COUNT],
            weights: [[0.0; PHOTO_FEATURE_COUNT]; PHOTO_OUTPUT_COUNT],
            bias: [0.0; PHOTO_OUTPUT_COUNT],
        };
        model
            .mean
            .copy_from_slice(&vector(&value["mean"], "mean", PHOTO_FEATURE_COUNT)?);
        model
            .scale
            .copy_from_slice(&vector(&value["scale"], "scale", PHOTO_FEATURE_COUNT)?);
        model
            .bias
            .copy_from_slice(&vector(&value["bias"], "bias", PHOTO_OUTPUT_COUNT)?);
        let rows = value["weights"]
            .as_array()
            .ok_or("weights must be an array")?;
        if rows.len() != PHOTO_OUTPUT_COUNT {
            return Err(format!("weights must contain {PHOTO_OUTPUT_COUNT} rows"));
        }
        for (row, slot) in rows.iter().zip(model.weights.iter_mut()) {
            slot.copy_from_slice(&vector(row, "weights", PHOTO_FEATURE_COUNT)?);
        }
        model.validate()
    }
}

/// The photo-level summaries of the 26 `raw_response` features of the whole
/// source's 750px analysis image (as `niho-6` computes them): the mean log
/// luminance, the 7 global quantiles relative to it, the spread of the
/// relative log luminance, and the mean and standard deviation of the other
/// per-pixel features.
pub fn photo_features(image: &LinearImage, space: SourceSpace) -> Result<PhotoFeatures, String> {
    let small = crate::niho6::analysis_image(image, space);
    let vectors = crate::raw_response::feature_vectors(&small.data, small.width, small.height)
        .map_err(|error| format!("features: {error:?}"))?;
    let n = vectors.len().max(1) as f64;
    let moments = |index: usize| {
        let mean = vectors.iter().map(|v| f64::from(v[index])).sum::<f64>() / n;
        let variance = vectors
            .iter()
            .map(|v| (f64::from(v[index]) - mean).powi(2))
            .sum::<f64>()
            / n;
        (mean, variance.sqrt())
    };
    let mut out = [0.0; PHOTO_FEATURE_COUNT];
    out[0] = moments(1).0;
    for (offset, index) in (16..=22).enumerate() {
        out[1 + offset] = moments(index).0;
    }
    out[8] = moments(2).1;
    for (k, index) in PHOTO_PIXEL_FEATURES.iter().enumerate() {
        let (mean, deviation) = moments(*index);
        out[9 + 2 * k] = mean;
        out[10 + 2 * k] = deviation;
    }
    if !out.iter().all(|v| v.is_finite()) {
        return Err("non-finite photo features".into());
    }
    Ok(out)
}
pub const RESIDUAL_SCHEMA: &str = "niho.analytic-hs-residual.v1";

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

/// The analytic part of candidate B. Every value is a linear function of one
/// scene statistic, then clamped to the fixed ranges above:
///
/// - Highlights (< 0): gain scale `kH = c0 + c1 * mean`, shift
///   `sH = c0 + c1 * mean` of the existing Highlights table.
/// - Shadows (> 0): gain scale `kS = c0 + c1 * p90`, shift
///   `sS = c0 + c1 * p90` of the existing Shadows table.
/// - Colour: `out = rgb * G + (rgb - Y) * (C - G)`, `G = 2^(gH + gS)`,
///   `C = 2^(alphaH * gH + alphaS * gS)` (1 and 1 is a scalar gain).
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct Formula {
    pub highlight_scale: [f64; 2],
    pub highlight_shift: [f64; 2],
    pub shadow_scale: [f64; 2],
    pub shadow_shift: [f64; 2],
    pub highlight_chroma_alpha: f64,
    pub shadow_chroma_alpha: f64,
}

impl Formula {
    /// The provisional anchors of the first (uncalibrated) candidate B.
    pub const UNCALIBRATED: Formula = Formula {
        highlight_scale: [0.72, -0.11],
        highlight_shift: [4.0, 1.0],
        shadow_scale: [0.82, 0.10],
        shadow_shift: [1.0, 1.0],
        highlight_chroma_alpha: 1.0,
        shadow_chroma_alpha: 1.0,
    };

    pub fn validate(self) -> Result<Self, String> {
        let linear = self
            .highlight_scale
            .iter()
            .chain(&self.highlight_shift)
            .chain(&self.shadow_scale)
            .chain(&self.shadow_shift);
        if !linear
            .clone()
            .all(|value| value.is_finite() && value.abs() <= MAX_LINEAR_COEFFICIENT)
        {
            return Err(format!(
                "formula coefficients must be finite and within ±{MAX_LINEAR_COEFFICIENT}"
            ));
        }
        for alpha in [self.highlight_chroma_alpha, self.shadow_chroma_alpha] {
            if !alpha.is_finite() || !(CHROMA_ALPHA_RANGE.0..=CHROMA_ALPHA_RANGE.1).contains(&alpha)
            {
                return Err(format!(
                    "chroma alphas must be finite and within {}..{}",
                    CHROMA_ALPHA_RANGE.0, CHROMA_ALPHA_RANGE.1
                ));
            }
        }
        Ok(self)
    }

    fn line(coefficients: [f64; 2], statistic: f64, range: (f64, f64)) -> f64 {
        (coefficients[0] + coefficients[1] * statistic).clamp(range.0, range.1)
    }
}

/// The analytic formula and the bounded residual of candidate B, and for
/// candidate C the per-photo model that replaces the formula's lines and
/// chroma exponents.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct Candidate {
    pub formula: Formula,
    pub residual: ResidualModel,
    pub model: Option<PhotoModel>,
}

impl Default for Candidate {
    fn default() -> Self {
        Self {
            formula: Formula::UNCALIBRATED,
            residual: ResidualModel::default(),
            model: None,
        }
    }
}

impl Candidate {
    pub fn validate(self) -> Result<Self, String> {
        Ok(Self {
            formula: self.formula.validate()?,
            residual: self.residual.validate()?,
            model: self.model.map(PhotoModel::validate).transpose()?,
        })
    }

    fn schema(&self) -> &'static str {
        if self.model.is_some() {
            CANDIDATE_MODEL_SCHEMA
        } else {
            CANDIDATE_SCHEMA
        }
    }

    /// The canonical coefficient object whose SHA-256 a frozen manifest
    /// records (`model` only for candidate C, so v1 digests are unchanged).
    pub fn coefficients_json(&self) -> serde_json::Value {
        let f = &self.formula;
        let mut value = serde_json::json!({
            "formula": {
                "highlightScale": f.highlight_scale,
                "highlightShift": f.highlight_shift,
                "shadowScale": f.shadow_scale,
                "shadowShift": f.shadow_shift,
                "highlightChromaAlpha": f.highlight_chroma_alpha,
                "shadowChromaAlpha": f.shadow_chroma_alpha
            },
            "residual": {
                "highlight": self.residual.highlight,
                "shadow": self.residual.shadow,
                "maxResidualEV": self.residual.max_residual_ev
            }
        });
        if let Some(model) = &self.model {
            value["model"] = model.json();
        }
        value
    }

    pub fn coefficients_sha256(&self) -> String {
        let canonical =
            serde_json::to_vec(&self.coefficients_json()).expect("coefficients serialize");
        niho_camera_profile::dcp::sha256_hex(&canonical)
    }

    /// Reads the (unfrozen) coefficient object of [`Self::coefficients_json`].
    pub fn from_coefficients_json(value: &serde_json::Value) -> Result<Self, String> {
        let number = |v: &serde_json::Value, key: &str| -> Result<f64, String> {
            v[key]
                .as_f64()
                .ok_or_else(|| format!("{key} must be a number"))
        };
        let array = |v: &serde_json::Value, key: &str, n: usize| -> Result<Vec<f64>, String> {
            let values = v[key]
                .as_array()
                .ok_or_else(|| format!("{key} must be an array"))?;
            if values.len() != n {
                return Err(format!("{key} must contain {n} coefficients"));
            }
            values
                .iter()
                .enumerate()
                .map(|(i, x)| x.as_f64().ok_or_else(|| format!("{key}[{i}]")))
                .collect()
        };
        let pair = |v: &serde_json::Value, key: &str| -> Result<[f64; 2], String> {
            let values = array(v, key, 2)?;
            Ok([values[0], values[1]])
        };
        let triple = |v: &serde_json::Value, key: &str| -> Result<[f64; 3], String> {
            let values = array(v, key, 3)?;
            Ok([values[0], values[1], values[2]])
        };
        let f = &value["formula"];
        let r = &value["residual"];
        if !f.is_object() || !r.is_object() {
            return Err("formula and residual objects are required".into());
        }
        Self {
            formula: Formula {
                highlight_scale: pair(f, "highlightScale")?,
                highlight_shift: pair(f, "highlightShift")?,
                shadow_scale: pair(f, "shadowScale")?,
                shadow_shift: pair(f, "shadowShift")?,
                highlight_chroma_alpha: number(f, "highlightChromaAlpha")?,
                shadow_chroma_alpha: number(f, "shadowChromaAlpha")?,
            },
            residual: ResidualModel {
                highlight: triple(r, "highlight")?,
                shadow: triple(r, "shadow")?,
                max_residual_ev: number(r, "maxResidualEV")?,
            },
            model: if value["model"].is_null() {
                None
            } else {
                Some(PhotoModel::from_json(&value["model"])?)
            },
        }
        .validate()
    }

    /// Every coefficient rounded to 12 significant digits (magnitudes below
    /// 1e-10 become 0). serde_json's default float parser is exact for such
    /// decimals, so a frozen manifest re-serializes to the same bytes and its
    /// digest is stable.
    pub fn canonical(&self) -> Self {
        fn round(v: f64) -> f64 {
            if v.abs() < 1e-10 {
                0.0
            } else {
                format!("{v:.11e}").parse().unwrap_or(v)
            }
        }
        fn each<const N: usize>(values: [f64; N]) -> [f64; N] {
            values.map(round)
        }
        let f = &self.formula;
        Self {
            formula: Formula {
                highlight_scale: each(f.highlight_scale),
                highlight_shift: each(f.highlight_shift),
                shadow_scale: each(f.shadow_scale),
                shadow_shift: each(f.shadow_shift),
                highlight_chroma_alpha: round(f.highlight_chroma_alpha),
                shadow_chroma_alpha: round(f.shadow_chroma_alpha),
            },
            residual: ResidualModel {
                highlight: each(self.residual.highlight),
                shadow: each(self.residual.shadow),
                max_residual_ev: round(self.residual.max_residual_ev),
            },
            model: self.model.map(|m| PhotoModel {
                mean: each(m.mean),
                scale: each(m.scale),
                weights: m.weights.map(each),
                bias: each(m.bias),
            }),
        }
    }

    /// A frozen `niho.analytic-hs-candidate.v1` (B) or `.v2` (C) manifest of
    /// the [`Self::canonical`] coefficients (provenance fields are added by
    /// the freeze record).
    pub fn frozen_manifest(&self) -> serde_json::Value {
        let canonical = self.canonical();
        let mut value = canonical.coefficients_json();
        value["schema"] = canonical.schema().into();
        value["frozen"] = true.into();
        value["coefficientsSha256"] = canonical.coefficients_sha256().into();
        value
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

/// Mean and p90 log2 luminance of the whole source (750px area reduction,
/// linear ProPhoto), before exposure.
pub fn scene_statistics(image: &LinearImage, space: SourceSpace) -> (f64, f64) {
    let small = crate::niho6::analysis_image(image, space);
    let stats = crate::spatial::compute_stats(&small.data, small.width, small.height, PP_LUMA_F32);
    (stats.mean_ln, stats.full_p90)
}

fn bounded_exposure(exposure_ev: f64) -> f64 {
    if exposure_ev.is_finite() {
        exposure_ev.clamp(-5.0, 5.0)
    } else {
        0.0
    }
}

/// The analysis at `exposure_ev` from [`scene_statistics`].
pub fn analysis_from_statistics(
    statistics: (f64, f64),
    exposure_ev: f64,
    residual: ResidualModel,
) -> Analysis {
    let exposure_ev = bounded_exposure(exposure_ev);
    let mean = statistics.0 + exposure_ev;
    let p90 = statistics.1 + exposure_ev;
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

/// Gain scales, shifts and chroma exponents of one photo for one analysis:
/// the formula's lines (B) or the per-photo model (C), clamped to the fixed
/// ranges.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct Resolved {
    pub highlight_scale: f64,
    pub highlight_shift: f64,
    pub shadow_scale: f64,
    pub shadow_shift: f64,
    pub highlight_alpha: f64,
    pub shadow_alpha: f64,
}

/// The parameters of `candidate` for one photo. Candidate C needs the
/// photo's [`photo_features`] (at exposure 0).
pub fn resolve(
    candidate: &Candidate,
    analysis: Analysis,
    features: Option<&PhotoFeatures>,
) -> Result<Resolved, String> {
    let mean = analysis.mean_log_luminance;
    let p90 = analysis.p90_log_luminance;
    if let Some(model) = &candidate.model {
        let features = features.ok_or("candidate C needs the photo features")?;
        let out = model.outputs(features, analysis.exposure_ev);
        return Ok(Resolved {
            highlight_scale: out[0]
                .exp()
                .clamp(HIGHLIGHT_SCALE_RANGE.0, HIGHLIGHT_SCALE_RANGE.1),
            highlight_shift: (mean + out[1]).clamp(SHIFT_RANGE.0, SHIFT_RANGE.1),
            highlight_alpha: out[2],
            shadow_scale: out[3]
                .exp()
                .clamp(SHADOW_SCALE_RANGE.0, SHADOW_SCALE_RANGE.1),
            shadow_shift: (p90 + out[4]).clamp(SHIFT_RANGE.0, SHIFT_RANGE.1),
            shadow_alpha: out[5],
        });
    }
    let formula = &candidate.formula;
    Ok(Resolved {
        highlight_scale: Formula::line(formula.highlight_scale, mean, HIGHLIGHT_SCALE_RANGE),
        highlight_shift: Formula::line(formula.highlight_shift, mean, SHIFT_RANGE),
        shadow_scale: Formula::line(formula.shadow_scale, p90, SHADOW_SCALE_RANGE),
        shadow_shift: Formula::line(formula.shadow_shift, p90, SHIFT_RANGE),
        highlight_alpha: formula.highlight_chroma_alpha,
        shadow_alpha: formula.shadow_chroma_alpha,
    })
}

/// The local-Laplacian parameters of one direction. Unlike a pointwise gain,
/// the operator is the existing multi-resolution local Laplacian.
fn local_params(
    highlights: f64,
    shadows: f64,
    resolved: &Resolved,
    long_edge: usize,
) -> crate::spatial::SpatialParams {
    use crate::spatial::{GainScale, Quality, Shift, SpatialParams};
    SpatialParams {
        highlights,
        shadows,
        texture: 0.0,
        clarity: 0.0,
        scale_px: crate::spatial::scale_px(long_edge as f64),
        long_edge,
        gain_scale: GainScale {
            highlights_neg: resolved.highlight_scale,
            highlights_pos: 0.0,
            shadows_neg: 0.0,
            shadows_pos: resolved.shadow_scale,
        },
        shift: Shift {
            highlights: resolved.highlight_shift,
            shadows: resolved.shadow_shift,
        },
        quality: Quality::Final,
    }
}

/// Optional Highlights and Shadows EV planes (`None`: direction unused).
pub type GainPlanes = (Option<Vec<f32>>, Option<Vec<f32>>);

/// The Highlights and Shadows EV planes (before the residual and bounds) of
/// the exposed log2 luminance `exposed`. A direction that is not used is
/// `None`. Shadows act on the Highlights result, as in `spatial.rs`.
pub fn local_gains(
    exposed: &Plane,
    settings: &DevelopSettings,
    resolved: &Resolved,
) -> Result<GainPlanes, String> {
    let long_edge = exposed.width.max(exposed.height);
    let highlights = settings.highlights.min(0.0);
    let shadows = settings.shadows.max(0.0);
    let after_highlights = if highlights < 0.0 {
        let params = local_params(highlights, 0.0, resolved, long_edge);
        Some(
            crate::spatial::spatial_luminance(exposed, &params)
                .ok_or("no local Highlights response")?,
        )
    } else {
        None
    };
    let highlight_gain = after_highlights.as_ref().map(|plane| {
        plane
            .data
            .iter()
            .zip(&exposed.data)
            .map(|(after, before)| after - before)
            .collect::<Vec<f32>>()
    });
    let shadow_gain = if shadows > 0.0 {
        let input = after_highlights.as_ref().unwrap_or(exposed);
        let params = local_params(0.0, shadows, resolved, long_edge);
        let after =
            crate::spatial::spatial_luminance(input, &params).ok_or("no local Shadows response")?;
        Some(
            after
                .data
                .iter()
                .zip(&input.data)
                .map(|(after, before)| after - before)
                .collect::<Vec<f32>>(),
        )
    } else {
        None
    };
    Ok((highlight_gain, shadow_gain))
}

/// ProPhoto luminance weights of a value in `space` (as `niho6.rs`).
fn luminance_weights(space: SourceSpace) -> [f32; 3] {
    match space {
        SourceSpace::LinearProPhoto => PP_LUMA_F32,
        SourceSpace::LinearSrgb => {
            let mut w = [0.0f64; 3];
            for (j, slot) in w.iter_mut().enumerate() {
                *slot = (0..3).map(|i| PP_LUMA[i] * SRGB_TO_PROPHOTO[i][j]).sum();
            }
            w.map(|v| v as f32)
        }
    }
}

fn validate_image(image: &LinearImage) -> Result<(), String> {
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
    Ok(())
}

/// Applies candidate B to a copy of `image`. The source can be decoded
/// linear sRGB or linear ProPhoto; the luminance operation is linear
/// ProPhoto.
pub fn prepare(
    image: &LinearImage,
    space: SourceSpace,
    settings: &DevelopSettings,
    candidate: &Candidate,
) -> Result<(LinearImage, ApplySummary), String> {
    validate_image(image)?;
    let features = if candidate.model.is_some() {
        Some(photo_features(image, space)?)
    } else {
        None
    };
    prepare_with_statistics(
        image,
        space,
        settings,
        candidate,
        scene_statistics(image, space),
        features.as_ref(),
    )
}

/// [`prepare`] with the whole source's [`scene_statistics`] (and, for
/// candidate C, [`photo_features`]) already known (`image` may then be a
/// reduction of that source).
pub fn prepare_with_statistics(
    image: &LinearImage,
    space: SourceSpace,
    settings: &DevelopSettings,
    candidate: &Candidate,
    statistics: (f64, f64),
    features: Option<&PhotoFeatures>,
) -> Result<(LinearImage, ApplySummary), String> {
    let candidate = candidate.validate()?;
    validate_image(image)?;
    let analysis = analysis_from_statistics(statistics, settings.exposure, candidate.residual);
    if settings.highlights >= 0.0 && settings.shadows <= 0.0 {
        return Ok((
            image.clone(),
            ApplySummary {
                analysis,
                min_gain_ev: 0.0,
                max_gain_ev: 0.0,
                non_finite_pixels: 0,
            },
        ));
    }
    let resolved = resolve(&candidate, analysis, features)?;
    let exposed = exposed_luminance(image, space, analysis.exposure_ev);
    let (highlight_gain, shadow_gain) = local_gains(&exposed, settings, &resolved)?;
    apply_gains(
        image,
        space,
        settings,
        &resolved,
        analysis,
        &exposed,
        highlight_gain.as_deref(),
        shadow_gain.as_deref(),
    )
}

/// The linear ProPhoto log2 luminance of `image` plus `exposure_ev`.
pub fn exposed_luminance(image: &LinearImage, space: SourceSpace, exposure_ev: f64) -> Plane {
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
        *value += exposure_ev as f32;
    }
    exposed
}

/// The per-pixel part of candidate B: the bounded residual, the EV bounds
/// and the colour rule applied with the Highlights / Shadows EV planes of
/// [`local_gains`] (or of an equivalent computation). `exposed` is
/// [`exposed_luminance`] of `image`.
#[allow(clippy::too_many_arguments)]
pub fn apply_gains(
    image: &LinearImage,
    space: SourceSpace,
    settings: &DevelopSettings,
    resolved: &Resolved,
    analysis: Analysis,
    exposed: &Plane,
    highlight_gain: Option<&[f32]>,
    shadow_gain: Option<&[f32]>,
) -> Result<(LinearImage, ApplySummary), String> {
    let pixels = image.width * image.height;
    if exposed.data.len() != pixels
        || highlight_gain.is_some_and(|gain| gain.len() != pixels)
        || shadow_gain.is_some_and(|gain| gain.len() != pixels)
    {
        return Err("gain planes do not match the image".into());
    }
    let mut output = image.clone();
    let highlight_amount = (-settings.highlights / 100.0).clamp(0.0, 1.0);
    let shadow_amount = (settings.shadows / 100.0).clamp(0.0, 1.0);
    let alpha_h = resolved.highlight_alpha;
    let alpha_s = resolved.shadow_alpha;
    let luma = luminance_weights(space);
    let mut min_gain_ev = f64::INFINITY;
    let mut max_gain_ev = f64::NEG_INFINITY;
    for (index, pixel) in output.data.chunks_exact_mut(3).enumerate() {
        let value = f64::from(exposed.data[index]);
        let h_weight = smoothstep((value - analysis.mean_log_luminance + 1.0) / 5.0);
        let s_weight = smoothstep((analysis.p90_log_luminance - value + 0.5) / 7.0);
        let mut gh = highlight_gain.map_or(0.0, |gain| f64::from(gain[index]))
            + highlight_amount * h_weight * analysis.highlight_residual_ev;
        let mut gs = shadow_gain.map_or(0.0, |gain| f64::from(gain[index]))
            + shadow_amount * s_weight * analysis.shadow_residual_ev;
        let total = gh + gs;
        let bounded = total.clamp(-MAX_HIGHLIGHT_GAIN_EV, MAX_SHADOW_GAIN_EV);
        if bounded != total {
            // Both directions keep their share of the bounded gain.
            let scale = bounded / total;
            gh *= scale;
            gs *= scale;
        }
        min_gain_ev = min_gain_ev.min(bounded);
        max_gain_ev = max_gain_ev.max(bounded);
        let g = libm::exp2(bounded) as f32;
        let c = libm::exp2(alpha_h * gh + alpha_s * gs) as f32;
        if c == g {
            // A scalar gain commutes with the source-space matrix; applying
            // it directly keeps neutral and alpha = 1 exact.
            for v in pixel.iter_mut() {
                *v *= g;
            }
        } else {
            let y = pixel[0] * luma[0] + pixel[1] * luma[1] + pixel[2] * luma[2];
            for v in pixel.iter_mut() {
                *v = *v * g + (*v - y) * (c - g);
            }
        }
    }
    if !output.data.iter().all(|value| value.is_finite()) {
        return Err("non-finite output from analytic H/S candidate".into());
    }
    Ok((
        output,
        ApplySummary {
            analysis,
            min_gain_ev,
            max_gain_ev,
            non_finite_pixels: 0,
        },
    ))
}

/// The settings the remaining stages see after candidate B: the same
/// settings with negative Highlights and positive Shadows removed.
pub fn downstream_settings(settings: &DevelopSettings) -> DevelopSettings {
    let mut downstream = settings.clone();
    downstream.highlights = downstream.highlights.max(0.0);
    downstream.shadows = downstream.shadows.min(0.0);
    downstream
}

/// The raster engine the probe renders with: the settings' own engine when
/// it uses the frozen `niho-6` H/S (`niho-6`, `niho-8`, `niho-10`), else
/// `niho-6`.
pub fn baseline_settings(settings: &DevelopSettings) -> DevelopSettings {
    let mut baseline = settings.clone();
    if !crate::niho6::uses_raster_formula(&baseline) {
        baseline.engine = ENGINE_NIHO_6.into();
    }
    baseline
}

/// A/B render entry point for private-reference owners. A is the unchanged
/// raster renderer of [`baseline_settings`] (`niho-6` H/S). B replaces only
/// negative Highlights / positive Shadows with this candidate, then runs the
/// same remaining stages of that engine. Geometry is intentionally excluded
/// from this reproducible probe.
pub fn render_pair(
    input: &[u8],
    settings: &DevelopSettings,
    options: &RenderOptions,
    candidate: &Candidate,
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
    let baseline_settings = baseline_settings(settings);
    let raster = crate::decode::decode_raster(input, options.max_dimension, options.filter)?;
    let baseline =
        pipeline::render_raster(&raster, &baseline_settings, options.quality, None, None).0;
    let (prepared, summary) = prepare(
        &raster.image,
        SourceSpace::LinearSrgb,
        &baseline_settings,
        candidate,
    )
    .map_err(Error::Niho6Prepare)?;
    let candidate_raster = Raster {
        image: prepared,
        info: raster.info,
    };
    let downstream = downstream_settings(&baseline_settings);
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
    if value["schema"] != RESIDUAL_SCHEMA || value["frozen"] != true {
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

/// Reads a frozen candidate manifest: `niho.analytic-hs-candidate.v1`
/// (formula + residual), `.v2` (candidate C: plus the per-photo model) or
/// the older residual-only
/// `niho.analytic-hs-residual.v1` (with the uncalibrated formula). Returns
/// the candidate and the digest its manifest records.
pub fn candidate_from_manifest(bytes: &[u8]) -> Result<(Candidate, String), String> {
    let value: serde_json::Value =
        serde_json::from_slice(bytes).map_err(|error| error.to_string())?;
    if value["schema"] == RESIDUAL_SCHEMA {
        let (residual, digest) = residual_from_manifest(bytes)?;
        return Ok((
            Candidate {
                formula: Formula::UNCALIBRATED,
                residual,
                model: None,
            },
            digest,
        ));
    }
    if (value["schema"] != CANDIDATE_SCHEMA && value["schema"] != CANDIDATE_MODEL_SCHEMA)
        || value["frozen"] != true
    {
        return Err(format!(
            "candidate manifest must be frozen {CANDIDATE_SCHEMA} or {CANDIDATE_MODEL_SCHEMA}"
        ));
    }
    let candidate = Candidate::from_coefficients_json(&value)?;
    if value["schema"] != candidate.schema() {
        return Err("the schema must be v2 exactly when a per-photo model is present".into());
    }
    let digest = candidate.coefficients_sha256();
    if value["coefficientsSha256"].as_str() != Some(digest.as_str()) {
        return Err("coefficientsSha256 does not match canonical coefficients".into());
    }
    Ok((candidate, digest))
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

    fn colourful(kind: &str) -> LinearImage {
        let mut image = scene(kind);
        for (index, pixel) in image.data.chunks_exact_mut(3).enumerate() {
            let tint = (index % 7) as f32 / 7.0;
            pixel[0] *= 0.6 + 0.8 * tint;
            pixel[2] *= 1.3 - 0.6 * tint;
        }
        image
    }

    /// A calibrated-like candidate that exercises every term (strong scales,
    /// chroma alphas below/above 1 and a saturated residual).
    fn strong() -> Candidate {
        Candidate {
            formula: Formula {
                highlight_scale: [0.2, -0.45],
                highlight_shift: [6.5, 1.0],
                shadow_scale: [1.4, 0.05],
                shadow_shift: [0.5, 0.9],
                highlight_chroma_alpha: 0.4,
                shadow_chroma_alpha: 1.1,
            },
            residual: ResidualModel {
                highlight: [8.0, -8.0, 8.0],
                shadow: [-8.0, 8.0, -8.0],
                max_residual_ev: MAX_RESIDUAL_EV,
            },
            model: None,
        }
    }

    /// Candidate C with a deterministic model (mean 0, unit scale, small
    /// weights) on top of `strong()`'s residual.
    fn with_model() -> Candidate {
        let mut weights = [[0.0; PHOTO_FEATURE_COUNT]; PHOTO_OUTPUT_COUNT];
        for (j, row) in weights.iter_mut().enumerate() {
            for (i, w) in row.iter_mut().enumerate() {
                *w = 0.05 * ((i + 3 * j) as f64).sin();
            }
        }
        Candidate {
            model: Some(PhotoModel {
                mean: [0.0; PHOTO_FEATURE_COUNT],
                scale: [1.0; PHOTO_FEATURE_COUNT],
                weights,
                bias: [1.5f64.ln(), 6.0, 0.5, 0.0, 1.0, 1.0],
            }),
            ..strong()
        }
    }

    #[test]
    fn dark_night_and_bright_window_are_finite_and_bounded() {
        let mut settings = DevelopSettings::neutral();
        settings.highlights = -100.0;
        settings.shadows = 100.0;
        for candidate in [Candidate::default(), strong(), with_model()] {
            for kind in ["dark", "night", "window"] {
                let (output, summary) = prepare(
                    &scene(kind),
                    SourceSpace::LinearProPhoto,
                    &settings,
                    &candidate,
                )
                .unwrap();
                assert!(output.data.iter().all(|value| value.is_finite()), "{kind}");
                assert_eq!(summary.non_finite_pixels, 0);
                assert!(summary.min_gain_ev >= -MAX_HIGHLIGHT_GAIN_EV);
                assert!(summary.max_gain_ev <= MAX_SHADOW_GAIN_EV);
                // Neutral input stays neutral whatever the chroma alphas.
                for pixel in output.data.chunks_exact(3) {
                    assert!((pixel[0] - pixel[1]).abs() <= 1e-6 * pixel[1].abs().max(1.0));
                    assert!((pixel[1] - pixel[2]).abs() <= 1e-6 * pixel[1].abs().max(1.0));
                }
            }
        }
    }

    #[test]
    fn colour_input_is_finite_and_gain_bounded_in_both_spaces() {
        let mut settings = DevelopSettings::neutral();
        settings.highlights = -100.0;
        settings.shadows = 100.0;
        for (space, candidate) in [
            (SourceSpace::LinearSrgb, strong()),
            (SourceSpace::LinearProPhoto, strong()),
            (SourceSpace::LinearSrgb, with_model()),
        ] {
            for kind in ["dark", "night", "window"] {
                let image = colourful(kind);
                let (output, summary) = prepare(&image, space, &settings, &candidate).unwrap();
                assert!(output.data.iter().all(|value| value.is_finite()));
                assert!(summary.min_gain_ev >= -MAX_HIGHLIGHT_GAIN_EV - 1e-9);
                assert!(summary.max_gain_ev <= MAX_SHADOW_GAIN_EV + 1e-9);
                // The luminance gain itself stays within the EV bounds.
                let luma = luminance_weights(space);
                for (before, after) in image.data.chunks_exact(3).zip(output.data.chunks_exact(3)) {
                    let y0 = before[0] * luma[0] + before[1] * luma[1] + before[2] * luma[2];
                    let y1 = after[0] * luma[0] + after[1] * luma[1] + after[2] * luma[2];
                    if y0 > 1e-4 {
                        let ev = f64::from((y1 / y0).log2());
                        assert!(ev >= -MAX_HIGHLIGHT_GAIN_EV - 1e-3, "{ev}");
                        assert!(ev <= MAX_SHADOW_GAIN_EV + 1e-3, "{ev}");
                    }
                }
            }
        }
    }

    #[test]
    fn zero_amounts_are_bit_identical_and_exposure_changes_analysis() {
        let image = scene("window");
        let neutral = DevelopSettings::neutral();
        for candidate in [Candidate::default(), strong(), with_model()] {
            let (same, summary) =
                prepare(&image, SourceSpace::LinearProPhoto, &neutral, &candidate).unwrap();
            assert_eq!(same.data, image.data);
            assert_eq!(summary.min_gain_ev, 0.0);
            // Opposite directions are left to the downstream renderer.
            let mut opposite = neutral.clone();
            opposite.highlights = 40.0;
            opposite.shadows = -40.0;
            let (same, _) =
                prepare(&image, SourceSpace::LinearSrgb, &opposite, &candidate).unwrap();
            assert_eq!(same.data, image.data);
        }

        let mut brighter = neutral;
        brighter.exposure = 1.0;
        brighter.highlights = -80.0;
        for candidate in [Candidate::default(), strong(), with_model()] {
            let (_, at_one) =
                prepare(&image, SourceSpace::LinearProPhoto, &brighter, &candidate).unwrap();
            let mut at_zero_settings = brighter.clone();
            at_zero_settings.exposure = 0.0;
            let (_, at_zero) = prepare(
                &image,
                SourceSpace::LinearProPhoto,
                &at_zero_settings,
                &candidate,
            )
            .unwrap();
            assert_eq!(
                at_one.analysis.mean_log_luminance,
                at_zero.analysis.mean_log_luminance + 1.0
            );
            assert_eq!(
                at_one.analysis.p90_log_luminance,
                at_zero.analysis.p90_log_luminance + 1.0
            );
            assert_ne!(at_one.min_gain_ev, at_zero.min_gain_ev);
        }
    }

    #[test]
    fn exposure_follows_like_a_brighter_photo() {
        // Exposure +1 on a photo is analysed like the same photo twice as
        // bright: Lightroom decides Highlights / Shadows after exposure.
        let image = scene("window");
        let mut doubled = image.clone();
        for value in &mut doubled.data {
            *value *= 2.0;
        }
        let mut settings = DevelopSettings::neutral();
        settings.highlights = -70.0;
        settings.shadows = 50.0;
        let mut exposed = settings.clone();
        exposed.exposure = 1.0;
        for candidate in [strong(), with_model()] {
            let (a, sa) =
                prepare(&image, SourceSpace::LinearProPhoto, &exposed, &candidate).unwrap();
            let (b, sb) =
                prepare(&doubled, SourceSpace::LinearProPhoto, &settings, &candidate).unwrap();
            assert!((sa.analysis.mean_log_luminance - sb.analysis.mean_log_luminance).abs() < 1e-5);
            assert!((sa.analysis.p90_log_luminance - sb.analysis.p90_log_luminance).abs() < 1e-5);
            for (x, y) in a.data.iter().zip(&b.data) {
                // a is before the exposure stage, b already twice as bright.
                assert!((2.0 * x - y).abs() <= 2e-3 * y.abs().max(1e-3), "{x} {y}");
            }
        }
        // The photo features move like the analysis: only the mean log
        // luminance follows the exposure.
        let fa = photo_features(&image, SourceSpace::LinearProPhoto).unwrap();
        let fb = photo_features(&doubled, SourceSpace::LinearProPhoto).unwrap();
        assert!((fb[0] - fa[0] - 1.0).abs() < 1e-4);
        for i in 1..PHOTO_FEATURE_COUNT {
            assert!(
                (fb[i] - fa[i]).abs() < 1e-3,
                "feature {i}: {} {}",
                fa[i],
                fb[i]
            );
        }
    }

    #[test]
    fn alpha_one_is_a_scalar_gain_and_alphas_change_only_colour() {
        let image = colourful("window");
        let mut settings = DevelopSettings::neutral();
        settings.highlights = -100.0;
        let mut scalar = strong();
        scalar.formula.highlight_chroma_alpha = 1.0;
        scalar.formula.shadow_chroma_alpha = 1.0;
        let (gain_only, _) = prepare(&image, SourceSpace::LinearSrgb, &settings, &scalar).unwrap();
        for (before, after) in image
            .data
            .chunks_exact(3)
            .zip(gain_only.data.chunks_exact(3))
        {
            let k = after[1] / before[1];
            assert!((after[0] - before[0] * k).abs() <= 1e-5 * after[0].abs().max(1e-3));
            assert!((after[2] - before[2] * k).abs() <= 1e-5 * after[2].abs().max(1e-3));
        }
        let (coloured, _) = prepare(&image, SourceSpace::LinearSrgb, &settings, &strong()).unwrap();
        let luma = luminance_weights(SourceSpace::LinearSrgb);
        for (a, b) in gain_only
            .data
            .chunks_exact(3)
            .zip(coloured.data.chunks_exact(3))
        {
            let ya = a[0] * luma[0] + a[1] * luma[1] + a[2] * luma[2];
            let yb = b[0] * luma[0] + b[1] * luma[1] + b[2] * luma[2];
            assert!((ya - yb).abs() <= 1e-5 * ya.abs().max(1e-3));
        }
    }

    #[test]
    fn manifests_round_trip_and_reject_tampering_or_out_of_range_values() {
        let candidate = strong();
        let manifest = candidate.frozen_manifest();
        let bytes = serde_json::to_vec(&manifest).unwrap();
        let (read, digest) = candidate_from_manifest(&bytes).unwrap();
        assert_eq!(read, candidate);
        assert_eq!(digest, candidate.coefficients_sha256());

        let mut tampered = manifest.clone();
        tampered["formula"]["highlightScale"][0] = 0.3.into();
        assert!(candidate_from_manifest(&serde_json::to_vec(&tampered).unwrap()).is_err());
        let mut unfrozen = manifest.clone();
        unfrozen["frozen"] = false.into();
        assert!(candidate_from_manifest(&serde_json::to_vec(&unfrozen).unwrap()).is_err());

        let mut too_large = candidate;
        too_large.residual.max_residual_ev = 0.6;
        assert!(too_large.validate().is_err());
        let mut bad_alpha = candidate;
        bad_alpha.formula.highlight_chroma_alpha = 2.0;
        assert!(bad_alpha.validate().is_err());
        let mut bad_line = candidate;
        bad_line.formula.shadow_shift[1] = f64::NAN;
        assert!(bad_line.validate().is_err());

        // The residual-only manifest keeps the uncalibrated formula.
        let residual = ResidualModel {
            highlight: [0.1, 0.2, 0.3],
            shadow: [0.0, -0.1, 0.0],
            max_residual_ev: 0.25,
        };
        let canonical = serde_json::to_vec(&serde_json::json!({
            "highlight": residual.highlight,
            "shadow": residual.shadow,
            "maxResidualEV": residual.max_residual_ev
        }))
        .unwrap();
        let legacy = serde_json::json!({
            "schema": RESIDUAL_SCHEMA,
            "frozen": true,
            "highlight": residual.highlight,
            "shadow": residual.shadow,
            "maxResidualEV": residual.max_residual_ev,
            "coefficientsSha256": niho_camera_profile::dcp::sha256_hex(&canonical)
        });
        let (read, _) = candidate_from_manifest(&serde_json::to_vec(&legacy).unwrap()).unwrap();
        assert_eq!(read.formula, Formula::UNCALIBRATED);
        assert_eq!(read.residual, residual);
    }

    #[test]
    fn probe_keeps_the_raster_engine_and_zero_amounts_render_identically() {
        use crate::settings::{ENGINE_NIHO_10, ENGINE_NIHO_2};
        let (width, height) = (48usize, 32usize);
        let mut rgba = Vec::with_capacity(width * height * 4);
        for y in 0..height {
            for x in 0..width {
                let v = (x * 255 / (width - 1)) as u8;
                rgba.extend_from_slice(&[v, (y * 7) as u8, 255 - v, 255]);
            }
        }
        let png = crate::encode::encode_png(&rgba, width, height).unwrap();
        let options = RenderOptions {
            max_dimension: 64,
            ..Default::default()
        };
        let mut settings = DevelopSettings::neutral();
        settings.engine = ENGINE_NIHO_10.into();
        assert_eq!(baseline_settings(&settings).engine, ENGINE_NIHO_10);
        let (a, b, _) = render_pair(&png, &settings, &options, &strong()).unwrap();
        assert_eq!(a.rgba, b.rgba);
        settings.highlights = -100.0;
        settings.shadows = 100.0;
        let (a, b, summary) = render_pair(&png, &settings, &options, &strong()).unwrap();
        assert_eq!((a.width, a.height), (b.width, b.height));
        assert_ne!(a.rgba, b.rgba);
        assert!(summary.min_gain_ev.is_finite() && summary.max_gain_ev.is_finite());
        let mut legacy = DevelopSettings::neutral();
        legacy.engine = ENGINE_NIHO_2.into();
        assert_eq!(baseline_settings(&legacy).engine, ENGINE_NIHO_6);
        assert_eq!(downstream_settings(&settings).highlights, 0.0);
        assert_eq!(downstream_settings(&settings).shadows, 0.0);
    }

    #[test]
    fn photo_model_outputs_saturate_outside_the_teachers() {
        let model = with_model().model.unwrap();
        for value in [1e9, -1e9, f64::NAN, f64::INFINITY] {
            let features = [value; PHOTO_FEATURE_COUNT];
            for exposure in [-5.0, 0.0, 5.0] {
                let out = model.outputs(&features, exposure);
                for (j, v) in out.iter().enumerate() {
                    let (lo, hi) = PHOTO_OUTPUT_RANGES[j];
                    assert!(v.is_finite() && *v >= lo && *v <= hi, "{j} {v}");
                }
            }
        }
        // Resolved parameters stay inside the fixed ranges too.
        let analysis = analysis_from_statistics((-30.0, 20.0), 0.0, ResidualModel::default());
        let features = [1e9; PHOTO_FEATURE_COUNT];
        let resolved = resolve(&with_model(), analysis, Some(&features)).unwrap();
        assert!(
            (HIGHLIGHT_SCALE_RANGE.0..=HIGHLIGHT_SCALE_RANGE.1).contains(&resolved.highlight_scale)
        );
        assert!((SHADOW_SCALE_RANGE.0..=SHADOW_SCALE_RANGE.1).contains(&resolved.shadow_scale));
        assert!((SHIFT_RANGE.0..=SHIFT_RANGE.1).contains(&resolved.highlight_shift));
        assert!((SHIFT_RANGE.0..=SHIFT_RANGE.1).contains(&resolved.shadow_shift));
        assert!(resolve(&with_model(), analysis, None).is_err());
    }

    #[test]
    fn model_manifests_round_trip_and_v1_digests_are_unchanged() {
        let c = with_model();
        let manifest = c.frozen_manifest();
        assert_eq!(manifest["schema"], CANDIDATE_MODEL_SCHEMA);
        let (read, digest) =
            candidate_from_manifest(&serde_json::to_vec(&manifest).unwrap()).unwrap();
        assert_eq!(read, c.canonical());
        assert_eq!(digest, c.canonical().coefficients_sha256());
        // The canonical values change by far less than they could matter.
        let model = c.model.unwrap();
        let canonical = read.model.unwrap();
        for (a, b) in model
            .weights
            .iter()
            .flatten()
            .zip(canonical.weights.iter().flatten())
        {
            assert!((a - b).abs() <= 1e-11 * a.abs().max(1e-10));
        }
        let mut tampered = manifest.clone();
        tampered["model"]["weights"][2][5] = 0.5.into();
        assert!(candidate_from_manifest(&serde_json::to_vec(&tampered).unwrap()).is_err());
        let mut wrong_schema = manifest.clone();
        wrong_schema["schema"] = CANDIDATE_SCHEMA.into();
        assert!(candidate_from_manifest(&serde_json::to_vec(&wrong_schema).unwrap()).is_err());
        let mut bad_scale = c;
        bad_scale.model.as_mut().unwrap().scale[3] = 0.0;
        assert!(bad_scale.validate().is_err());
        // A candidate without a model keeps the v1 canonical object.
        let b = strong();
        assert!(b.coefficients_json().get("model").is_none());
        assert_eq!(b.frozen_manifest()["schema"], CANDIDATE_SCHEMA);
    }

    #[test]
    fn statistics_are_of_the_whole_source() {
        let image = scene("night");
        let (mean, p90) = scene_statistics(&image, SourceSpace::LinearProPhoto);
        assert!(mean < p90);
        let analysis = analysis_from_statistics((mean, p90), 0.5, ResidualModel::default());
        assert_eq!(analysis.mean_log_luminance, mean + 0.5);
        assert_eq!(analysis.highlight_residual_ev, 0.0);
        let bounded = analysis_from_statistics((mean, p90), f64::NAN, ResidualModel::default());
        assert_eq!(bounded.exposure_ev, 0.0);
    }
}
