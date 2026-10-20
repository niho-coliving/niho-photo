//! `niho-6` raster preparation (#18397, `NIHO6.md`): the JPEG / PNG
//! original (or raster working copy) with Highlights (<= 0) and Shadows
//! (>= 0) from the JPEG-trained response ([`crate::niho6_response`]). The
//! rest of the frame is the `niho-2` raster formula on the prepared image
//! (`pipeline::render_linear` leaves those two directions to this module).
//!
//! - Analysis: the whole photo (not a crop, preview or thumbnail) reduced
//!   to a 750px long edge by area averaging in linear sRGB, then linear
//!   ProPhoto. Its coefficient maps do not depend on the amounts.
//! - Gain: `gH`, `gS` (EV) at the analysis size, resized bilinearly to the
//!   prepared image. Per pixel, with `Y` the ProPhoto luminance,
//!   `out = rgb·G + (rgb − Y)·(C − G)`, `G = 2^(gH + gS)`,
//!   `C = 2^(αH·gH + αS·gS)` (the chroma follows its own exponents of the
//!   luminance gain, as in Lightroom's JPEG exports).

use crate::color::{PP_LUMA, SRGB_TO_PROPHOTO, SRGB_TO_PROPHOTO_F32};
use crate::decode::LinearImage;
use crate::niho6_response::{self, CoefficientMaps, ResponseError};
use crate::resize::{self, Filter};
use crate::settings::DevelopSettings;
use std::fmt;
use std::sync::OnceLock;

pub const ANALYSIS_LONG_EDGE: usize = 750;

/// Share of Highlights (<= 0) / Shadows (>= 0) the `niho-2` local pass keeps
/// (R24 in `NIHO6.md`): the learned gain applies `1 - LEGACY_SHARE` of its
/// response and the legacy local pass `LEGACY_SHARE` of the amounts. The two
/// err on different photos, so the mix halves the regressions against
/// `niho-2` on unseen capture dates.
pub const LEGACY_SHARE: f64 = 0.5;

/// What a source's pixels are: decoded JPEG / PNG originals are extended
/// linear sRGB, raster working copies linear ProPhoto.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum SourceSpace {
    LinearSrgb,
    LinearProPhoto,
}

#[derive(Debug)]
pub enum PrepareError {
    Response(ResponseError),
    NonFinite(&'static str),
}

impl fmt::Display for PrepareError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Response(e) => write!(f, "H/S response: {e}"),
            Self::NonFinite(stage) => write!(f, "non-finite value during {stage}"),
        }
    }
}

impl std::error::Error for PrepareError {}

/// The response's coefficient maps of one photo, and the size of the
/// source they were made from (a session made from the same source reuses
/// them, whatever its own working size).
#[derive(Debug)]
pub struct Analysis {
    pub maps: CoefficientMaps,
    /// The exposure the analysis was made at ([`analysis_exposure`]).
    pub exposure_ev: f64,
    pub source_width: usize,
    pub source_height: usize,
}

/// Whether these settings use the response (otherwise `niho-6` renders
/// exactly as `niho-2`).
pub fn uses_response(settings: &DevelopSettings) -> bool {
    settings.highlights < 0.0 || settings.shadows > 0.0
}

/// The analysis size of a `width x height` source (as NIHO 3's).
pub fn analysis_size(width: usize, height: usize) -> (usize, usize) {
    if width >= height {
        (
            ANALYSIS_LONG_EDGE.min(width),
            ((height as f64 * ANALYSIS_LONG_EDGE as f64 / width as f64).round() as usize)
                .max(1)
                .min(height),
        )
    } else {
        (
            ((width as f64 * ANALYSIS_LONG_EDGE as f64 / height as f64).round() as usize)
                .max(1)
                .min(width),
            ANALYSIS_LONG_EDGE.min(height),
        )
    }
}

/// The analysis image of a whole source: area average to
/// [`analysis_size`] in the source's space, then linear ProPhoto.
pub fn analysis_image(source: &LinearImage, space: SourceSpace) -> LinearImage {
    let (w, h) = (source.width, source.height);
    let (aw, ah) = analysis_size(w, h);
    let mut data = resize::resample(&source.data, w, h, aw, ah, Filter::Area);
    if space == SourceSpace::LinearSrgb {
        for px in data.chunks_exact_mut(3) {
            let v = crate::color::mat_vec_f32(&SRGB_TO_PROPHOTO_F32, [px[0], px[1], px[2]]);
            px.copy_from_slice(&v);
        }
    }
    LinearImage {
        width: aw,
        height: ah,
        data,
    }
}

/// The exposure (EV) the response sees for `settings`: Lightroom decides
/// Highlights / Shadows on the exposed photo (R20 in `NIHO6.md`), so the
/// features are those of the analysis image scaled by `2^exposure`.
pub fn analysis_exposure(settings: &DevelopSettings) -> f64 {
    if settings.exposure.is_finite() {
        settings.exposure
    } else {
        0.0
    }
}

/// The features of a whole source's analysis image (once per photo; the
/// exposure only moves two of them, [`analysis_at`]).
pub fn source_features(
    source: &LinearImage,
    space: SourceSpace,
) -> Result<SourceFeatures, PrepareError> {
    let small = analysis_image(source, space);
    let features = niho6_response::features(&small.data, small.width, small.height)
        .map_err(PrepareError::Response)?;
    Ok(SourceFeatures {
        features,
        source_width: source.width,
        source_height: source.height,
    })
}

/// [`source_features`] and the size of the source they were made from.
#[derive(Debug)]
pub struct SourceFeatures {
    pub features: niho6_response::Features,
    pub source_width: usize,
    pub source_height: usize,
}

/// The analysis of a source's features as seen at `exposure_ev`.
pub fn analysis_at(features: &SourceFeatures, exposure_ev: f64) -> Result<Analysis, PrepareError> {
    let maps = niho6_response::coefficient_maps_at(&features.features, exposure_ev)
        .map_err(PrepareError::Response)?;
    Ok(Analysis {
        maps,
        exposure_ev,
        source_width: features.source_width,
        source_height: features.source_height,
    })
}

/// The analysis of a whole source as seen at `exposure_ev`.
pub fn analysis(
    source: &LinearImage,
    space: SourceSpace,
    exposure_ev: f64,
) -> Result<Analysis, PrepareError> {
    analysis_at(&source_features(source, space)?, exposure_ev)
}

/// ProPhoto luminance of a value in `space` (`PP_LUMA`, and for linear sRGB
/// `PP_LUMA · SRGB_TO_PROPHOTO`; both spaces keep the same white, so
/// `rgb − Y` is the same color difference).
fn luminance_weights(space: SourceSpace) -> [f32; 3] {
    static SRGB: OnceLock<[f32; 3]> = OnceLock::new();
    match space {
        SourceSpace::LinearProPhoto => PP_LUMA.map(|v| v as f32),
        SourceSpace::LinearSrgb => *SRGB.get_or_init(|| {
            let mut w = [0.0f64; 3];
            for (j, slot) in w.iter_mut().enumerate() {
                *slot = (0..3).map(|i| PP_LUMA[i] * SRGB_TO_PROPHOTO[i][j]).sum();
            }
            w.map(|v| v as f32)
        }),
    }
}

/// The cache key of an image prepared from a `width x height` source for
/// `settings` with an analysis made at `analysis_exposure_ev` (only the
/// amounts the response uses, its preprocessed source, and that exposure
/// change it).
pub fn preparation_key(
    width: usize,
    height: usize,
    settings: &DevelopSettings,
    analysis_exposure_ev: f64,
) -> String {
    let detail = settings.detail.map_or_else(
        || "none".to_string(),
        |detail| {
            format!(
                "{}|{:?}",
                detail.luminance_noise_reduction, detail.color_noise_reduction
            )
        },
    );
    format!(
        "niho6|{width}x{height}|{detail}|{}|{}|{analysis_exposure_ev}",
        settings.highlights.min(0.0),
        settings.shadows.max(0.0),
    )
}

/// `image` (in `space`; the whole photo or its reduction) with the
/// response's Highlights and Shadows of `settings` applied.
pub fn apply(
    image: &LinearImage,
    space: SourceSpace,
    analysis: &Analysis,
    settings: &DevelopSettings,
) -> Result<LinearImage, PrepareError> {
    let maps = &analysis.maps;
    let (highlight, shadow) = niho6_response::gains(
        maps,
        settings.highlights.min(0.0),
        settings.shadows.max(0.0),
    )
    .map_err(PrepareError::Response)?;
    let models = niho6_response::models().map_err(PrepareError::Response)?;
    let (alpha_h, alpha_s) = (models.highlight_chroma_alpha, models.shadow_chroma_alpha);
    let (w, h) = (image.width, image.height);
    let share = (1.0 - LEGACY_SHARE) as f32;
    let highlight: Vec<f32> = highlight.iter().map(|g| g * share).collect();
    let shadow: Vec<f32> = shadow.iter().map(|g| g * share).collect();
    let highlight = resize_plane_bilinear(&highlight, maps.width, maps.height, w, h);
    let shadow = resize_plane_bilinear(&shadow, maps.width, maps.height, w, h);
    let luma = luminance_weights(space);
    let mut data = image.data.clone();
    for ((px, gh), gs) in data.chunks_exact_mut(3).zip(highlight).zip(shadow) {
        let y = px[0] * luma[0] + px[1] * luma[1] + px[2] * luma[2];
        let g = libm::exp2f(gh + gs);
        let c = libm::exp2f(alpha_h * gh + alpha_s * gs);
        for v in px.iter_mut() {
            *v = *v * g + (*v - y) * (c - g);
        }
    }
    if data.iter().any(|v| !v.is_finite()) {
        return Err(PrepareError::NonFinite("niho-6 preparation"));
    }
    Ok(LinearImage {
        width: w,
        height: h,
        data,
    })
}

/// Bilinear resize of a plane with pixel centers aligned (NIHO 3's).
pub(crate) fn resize_plane_bilinear(
    source: &[f32],
    in_width: usize,
    in_height: usize,
    out_width: usize,
    out_height: usize,
) -> Vec<f32> {
    let mut output = vec![0.0; out_width * out_height];
    let scale_x = in_width as f64 / out_width as f64;
    let scale_y = in_height as f64 / out_height as f64;
    for y in 0..out_height {
        let sy = ((y as f64 + 0.5) * scale_y - 0.5).clamp(0.0, (in_height - 1) as f64);
        let y0 = libm::floor(sy) as usize;
        let y1 = (y0 + 1).min(in_height - 1);
        let ty = (sy - y0 as f64) as f32;
        for x in 0..out_width {
            let sx = ((x as f64 + 0.5) * scale_x - 0.5).clamp(0.0, (in_width - 1) as f64);
            let x0 = libm::floor(sx) as usize;
            let x1 = (x0 + 1).min(in_width - 1);
            let tx = (sx - x0 as f64) as f32;
            let top = source[y0 * in_width + x0]
                + tx * (source[y0 * in_width + x1] - source[y0 * in_width + x0]);
            let bottom = source[y1 * in_width + x0]
                + tx * (source[y1 * in_width + x1] - source[y1 * in_width + x0]);
            output[y * out_width + x] = top + ty * (bottom - top);
        }
    }
    output
}

#[cfg(test)]
mod tests {
    use super::*;

    fn gradient(w: usize, h: usize) -> LinearImage {
        let mut data = Vec::with_capacity(w * h * 3);
        for y in 0..h {
            for x in 0..w {
                let t = (x + y * w) as f32 / (w * h) as f32;
                data.extend_from_slice(&[0.01 + 0.8 * t * t, 0.01 + 0.7 * t, 0.02 + 0.5 * t]);
            }
        }
        LinearImage {
            width: w,
            height: h,
            data,
        }
    }

    #[test]
    fn zero_amounts_keep_every_bit() {
        let image = gradient(64, 48);
        let analysis = analysis(&image, SourceSpace::LinearSrgb, 0.0).unwrap();
        let prepared = apply(
            &image,
            SourceSpace::LinearSrgb,
            &analysis,
            &DevelopSettings::neutral(),
        )
        .unwrap();
        assert_eq!(prepared.data, image.data);
    }

    #[test]
    fn analysis_is_of_the_whole_photo_at_750() {
        assert_eq!(analysis_size(2560, 1707), (750, 500));
        assert_eq!(analysis_size(1707, 2560), (500, 750));
        assert_eq!(analysis_size(600, 400), (600, 400));
    }

    #[test]
    fn neutral_pixels_stay_neutral() {
        let mut image = gradient(32, 24);
        for px in image.data.chunks_exact_mut(3) {
            let v = px[1];
            px.copy_from_slice(&[v, v, v]);
        }
        let analysis = analysis(&image, SourceSpace::LinearSrgb, 0.0).unwrap();
        let settings = DevelopSettings {
            highlights: -80.0,
            shadows: 60.0,
            ..DevelopSettings::neutral()
        };
        let prepared = apply(&image, SourceSpace::LinearSrgb, &analysis, &settings).unwrap();
        for px in prepared.data.chunks_exact(3) {
            assert!((px[0] - px[1]).abs() <= 1e-5 * px[1].abs().max(1.0));
            assert!((px[2] - px[1]).abs() <= 1e-5 * px[1].abs().max(1.0));
        }
    }
}
