//! Camera-linear RGB to the linear ProPhoto input used by stage 2.
//!
//! This is a pure prefix for a future camera-linear working copy. Existing RAW and raster
//! Session entry points do not call it.

use std::fmt;

use niho_camera_color::color::{self, ProfileInput};
use niho_camera_color::matrix;
use niho_camera_profile::dcp::{sha256_hex, DcpSpec};

use crate::color as develop_color;
use crate::decode::AsShotWhite;
use crate::settings::{ABSOLUTE_TEMPERATURE_RANGE, ABSOLUTE_TINT_RANGE};
use crate::LinearImage;

/// Identity and RAW metadata needed to render an already-decoded camera-linear image.
#[derive(Debug, Clone, PartialEq)]
pub struct CameraLinearWorkMeta {
    /// Expected 64-character lowercase SHA-256 of the exact DCP bytes.
    pub expected_dcp_sha256: String,
    /// Expected DCP `uniqueCameraModel`, matched exactly.
    pub expected_unique_camera_model: String,
    /// Drawing-base version required by every non-neutral settings value.
    pub base_version: String,
    /// The as-shot camera neutral applied before the DCP color transform.
    pub as_shot_camera_neutral: [f64; 3],
    /// RAW-only baseline exposure, without the DCP BaselineExposureOffset.
    pub raw_baseline_ev: f64,
    /// As-shot white retained for working-copy metadata and preset behavior.
    pub as_shot_white: AsShotWhite,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum CameraLinearError {
    InvalidDimensions,
    InvalidNeutral,
    InvalidWhiteBalance,
    NonFinitePixel,
    InvalidExpectedSha256,
    InvalidExpectedCameraModel,
    Sha256Mismatch,
    CameraModelMismatch,
    InvalidBaseVersion,
    BaseVersionMismatch,
    NonFiniteBaselineExposure,
    InvalidBaselineExposureGain,
    InvalidAsShotWhite,
    InvalidProfile(String),
    NonFiniteOutput,
}

impl fmt::Display for CameraLinearError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::InvalidDimensions => write!(f, "camera-linear dimensions do not match pixels"),
            Self::InvalidNeutral => write!(
                f,
                "camera neutral must be finite, positive, and normalized to max 1"
            ),
            Self::InvalidWhiteBalance => write!(f, "absolute white balance is out of range"),
            Self::NonFinitePixel => write!(f, "camera-linear image contains a non-finite pixel"),
            Self::InvalidExpectedSha256 => write!(f, "expected DCP SHA-256 must be lowercase hex"),
            Self::InvalidExpectedCameraModel => write!(f, "expected camera model is empty"),
            Self::Sha256Mismatch => write!(f, "DCP SHA-256 does not match expected identity"),
            Self::CameraModelMismatch => {
                write!(f, "DCP camera model does not match expected model")
            }
            Self::InvalidBaseVersion => write!(f, "camera-linear base version is empty"),
            Self::BaseVersionMismatch => {
                write!(
                    f,
                    "develop settings base does not match camera-linear base version"
                )
            }
            Self::NonFiniteBaselineExposure => {
                write!(f, "camera-linear baseline exposure must be finite")
            }
            Self::InvalidBaselineExposureGain => {
                write!(
                    f,
                    "camera-linear baseline exposure does not produce a finite f32 gain"
                )
            }
            Self::InvalidAsShotWhite => write!(f, "camera-linear as-shot white is invalid"),
            Self::InvalidProfile(message) => write!(f, "invalid camera profile: {message}"),
            Self::NonFiniteOutput => write!(f, "camera profile produced a non-finite pixel"),
        }
    }
}

impl std::error::Error for CameraLinearError {}

/// Convert a stage-2 absolute Kelvin/tint setting to the camera neutral used by the DCP prefix.
///
/// Unlike the older ProPhoto adaptation of a baked-white working copy, this computes the white
/// in camera RGB before applying the DCP. The bounds are the same as `DevelopSettings`.
pub fn neutral_for_absolute_white(
    profile: &ProfileInput<'_>,
    temperature: f64,
    tint: f64,
) -> Result<[f64; 3], CameraLinearError> {
    if !temperature.is_finite()
        || !(ABSOLUTE_TEMPERATURE_RANGE.0..=ABSOLUTE_TEMPERATURE_RANGE.1).contains(&temperature)
        || !tint.is_finite()
        || !(ABSOLUTE_TINT_RANGE.0..=ABSOLUTE_TINT_RANGE.1).contains(&tint)
    {
        return Err(CameraLinearError::InvalidWhiteBalance);
    }
    let xy = develop_color::xy_from_temperature(temperature, tint);
    if !xy.x.is_finite() || !xy.y.is_finite() || xy.x <= 0.0 || xy.y <= 0.0 || xy.x + xy.y >= 1.0 {
        return Err(CameraLinearError::InvalidWhiteBalance);
    }
    color::camera_neutral_for_xy(profile, [xy.x, xy.y])
        .map_err(|e| CameraLinearError::InvalidProfile(e.to_string()))
}

/// Resolve a caller-supplied DCP only when its exact bytes and camera identity match.
///
/// The expected SHA-256 is the 64-character lowercase hex digest of the original DCP bytes.
/// The expected model must match `uniqueCameraModel` exactly. This validates the full DCP spec
/// before running the same pure color path as [`to_linear_prophoto`]. No file I/O is performed.
pub fn to_linear_prophoto_from_dcp_bytes(
    camera: &LinearImage,
    dcp_bytes: &[u8],
    expected_sha256: &str,
    expected_unique_camera_model: &str,
    neutral: [f64; 3],
) -> Result<LinearImage, CameraLinearError> {
    let spec = validated_dcp(dcp_bytes, expected_sha256, expected_unique_camera_model)?;
    to_linear_prophoto(camera, &spec.color_input(), neutral)
}

pub(crate) fn validated_dcp(
    dcp_bytes: &[u8],
    expected_sha256: &str,
    expected_unique_camera_model: &str,
) -> Result<DcpSpec, CameraLinearError> {
    if expected_sha256.len() != 64
        || !expected_sha256
            .bytes()
            .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
    {
        return Err(CameraLinearError::InvalidExpectedSha256);
    }
    if expected_unique_camera_model.trim().is_empty() {
        return Err(CameraLinearError::InvalidExpectedCameraModel);
    }
    if sha256_hex(dcp_bytes) != expected_sha256 {
        return Err(CameraLinearError::Sha256Mismatch);
    }

    let spec = DcpSpec::from_dcp_bytes(dcp_bytes)
        .map_err(|e| CameraLinearError::InvalidProfile(e.to_string()))?;
    spec.validate()
        .map_err(|e| CameraLinearError::InvalidProfile(e.to_string()))?;
    if spec.unique_camera_model != expected_unique_camera_model {
        return Err(CameraLinearError::CameraModelMismatch);
    }
    Ok(spec)
}

pub(crate) fn validate_work_meta(meta: &CameraLinearWorkMeta) -> Result<(), CameraLinearError> {
    if meta.base_version.trim().is_empty() {
        return Err(CameraLinearError::InvalidBaseVersion);
    }
    validate_neutral(meta.as_shot_camera_neutral)?;
    if !meta.raw_baseline_ev.is_finite() {
        return Err(CameraLinearError::NonFiniteBaselineExposure);
    }
    let white = meta.as_shot_white;
    if !white.x.is_finite()
        || !white.y.is_finite()
        || white.x <= 0.0
        || white.y <= 0.0
        || white.x + white.y >= 1.0
        || white
            .temperature
            .is_some_and(|temperature| !temperature.is_finite() || temperature <= 0.0)
        || white.tint.is_some_and(|tint| !tint.is_finite())
    {
        return Err(CameraLinearError::InvalidAsShotWhite);
    }
    Ok(())
}

fn validate_neutral(neutral: [f64; 3]) -> Result<(), CameraLinearError> {
    if neutral.iter().any(|n| !n.is_finite() || *n <= 0.0) {
        return Err(CameraLinearError::InvalidNeutral);
    }
    let max_neutral = neutral.into_iter().fold(0.0_f64, f64::max);
    if (max_neutral - 1.0).abs() > 1e-6 {
        return Err(CameraLinearError::InvalidNeutral);
    }
    let gains = neutral.map(|n| (1.0 / n) as f32);
    if gains.iter().any(|gain| !gain.is_finite() || *gain <= 0.0) {
        return Err(CameraLinearError::InvalidNeutral);
    }
    Ok(())
}

/// Apply the selected camera neutral and DCP profile to a camera-linear image.
///
/// Pass the as-shot neutral for the original white, or a requested neutral for a new white. The
/// order matches the base-raw color prefix: reciprocal WB gains in f32 with an upper clip at 1.0,
/// f32 camera-to-ProPhoto matrix, negative clamp, then HueSatMap. Values above 1.0 produced by the
/// matrix are retained in linear light.
pub fn to_linear_prophoto(
    camera: &LinearImage,
    profile: &ProfileInput<'_>,
    neutral: [f64; 3],
) -> Result<LinearImage, CameraLinearError> {
    let expected = camera
        .width
        .checked_mul(camera.height)
        .and_then(|n| n.checked_mul(3))
        .filter(|_| camera.width > 0 && camera.height > 0)
        .ok_or(CameraLinearError::InvalidDimensions)?;
    if camera.data.len() != expected {
        return Err(CameraLinearError::InvalidDimensions);
    }
    validate_neutral(neutral)?;
    let gains = neutral.map(|n| (1.0 / n) as f32);
    if camera.data.iter().any(|v| !v.is_finite()) {
        return Err(CameraLinearError::NonFinitePixel);
    }

    let resolved = color::resolve_profile_color(profile, &neutral)
        .map_err(|e| CameraLinearError::InvalidProfile(e.to_string()))?;
    let m = matrix::to_f32(&resolved.camera_to_prophoto);
    if m.iter().flatten().any(|v| !v.is_finite()) {
        return Err(CameraLinearError::InvalidProfile(
            "camera-to-ProPhoto matrix is not finite in f32".into(),
        ));
    }

    let mut data = Vec::with_capacity(expected);
    for px in camera.data.chunks_exact(3) {
        let (r, g, b) = (
            (px[0] * gains[0]).min(1.0),
            (px[1] * gains[1]).min(1.0),
            (px[2] * gains[2]).min(1.0),
        );
        let mut out = [
            (m[0][0] * r + m[0][1] * g + m[0][2] * b).max(0.0),
            (m[1][0] * r + m[1][1] * g + m[1][2] * b).max(0.0),
            (m[2][0] * r + m[2][1] * g + m[2][2] * b).max(0.0),
        ];
        if let Some(table) = &resolved.hue_sat_map {
            out = table.apply(out);
        }
        if out.iter().any(|v| !v.is_finite()) {
            return Err(CameraLinearError::NonFiniteOutput);
        }
        data.extend_from_slice(&out);
    }

    Ok(LinearImage {
        width: camera.width,
        height: camera.height,
        data,
    })
}
