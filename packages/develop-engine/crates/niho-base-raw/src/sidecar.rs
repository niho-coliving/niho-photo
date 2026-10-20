//! Sidecar JSON (contract §2.2, schema `niho-base-raw.working-copy/1`). Field order follows the contract.

use serde::Serialize;

pub const SCHEMA: &str = "niho-base-raw.working-copy/1";
pub const COLOR_SPACE_PROPHOTO: &str = "linear-prophoto-rgb-d50";
pub const COLOR_SPACE_CAMERA: &str = "camera-rgb-wb";

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Sidecar {
    pub schema: String,
    pub base_version: String,
    pub processing_version: String,
    pub encoding_version: String,
    pub decoder: DecoderInfo,
    pub camera: CameraInfo,
    pub source: SourceInfo,
    /// `null` for `dump-camera`.
    pub dcp: Option<DcpInfo>,
    pub white_balance: WhiteBalanceInfo,
    #[serde(rename = "baselineEV")]
    pub baseline_ev: f64,
    pub highlight_mode: String,
    pub demosaic: String,
    pub orientation: String,
    pub orientation_applied: bool,
    pub lens_correction_applied: bool,
    pub look_table_included: bool,
    pub output: OutputInfo,
    pub timings_ms: Timings,
}

#[derive(Clone, Debug, Serialize)]
pub struct DecoderInfo {
    pub name: String,
    pub version: String,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CameraInfo {
    pub make: String,
    pub model: String,
    pub clean_make: String,
    pub clean_model: String,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SourceInfo {
    /// Size after the decoder's crop (the image area), before orientation.
    pub width: usize,
    pub height: usize,
    /// CFA pattern relative to the crop origin.
    pub cfa: String,
    pub bits_per_sample: u32,
    pub black_level: Vec<serde_json::Value>,
    pub white_level: Vec<serde_json::Value>,
    /// EXIF ISO (`null` when absent).
    pub iso: Option<f64>,
    /// The raw's own part of `baselineEV` (EV): the DNG BaselineExposure tag, or the extended-low-ISO pull.
    pub baseline_exposure: Option<f64>,
    /// `"dng"`, `"extended-low-iso"` or `null`.
    pub baseline_exposure_source: Option<String>,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DcpInfo {
    pub sha256: String,
    pub profile_name: String,
    pub unique_camera_model: String,
    pub copyright: String,
    pub embed_policy: u32,
    pub illuminants: Vec<u16>,
    pub has_forward_matrix: bool,
    pub hue_sat_map_dims: Option<[u32; 3]>,
    pub has_look_table: bool,
    pub has_tone_curve: bool,
    pub baseline_exposure_offset: f64,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WhiteBalanceInfo {
    /// `mul_c = wb_c / min(wb)`.
    pub as_shot_multipliers: [f64; 3],
    /// `n_c = 1 / mul_c`.
    pub as_shot_neutral: [f64; 3],
    /// Chromaticity of the camera neutral (through the ColorMatrix).
    pub xy: [f64; 2],
    pub cct: f64,
    pub duv: f64,
    /// Addition to contract §2.2 (§2.5 step 8 asks the method to be recorded).
    pub cct_method: String,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct OutputInfo {
    pub width: usize,
    pub height: usize,
    pub color_space: String,
    pub encoding: EncodingInfo,
    pub resample: String,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct EncodingInfo {
    pub transfer: String,
    pub gamma: f64,
    pub linear_max: f64,
    pub bits_per_sample: u32,
}

#[derive(Clone, Debug, Default, Serialize)]
pub struct Timings {
    pub decode: f64,
    pub demosaic: f64,
    pub color: f64,
    pub resize: f64,
    pub encode: f64,
    pub total: f64,
}

/// A number as JSON: integral values without a fractional part (`510`, not `510.0`).
pub fn json_number(x: f64) -> serde_json::Value {
    if x.is_finite() && x.fract() == 0.0 && x.abs() < 9.0e15 {
        serde_json::Value::from(x as i64)
    } else {
        serde_json::Value::from(x)
    }
}

/// Round to `digits` decimals for readable JSON.
pub fn round_to(x: f64, digits: i32) -> f64 {
    let k = 10f64.powi(digits);
    (x * k).round() / k
}
