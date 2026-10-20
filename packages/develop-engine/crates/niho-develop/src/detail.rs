//! v5 detail processing on float linear-light pixels.
//!
//! Noise reduction runs on the source before adaptive/local processing.
//! Sharpening runs on the output-sized linear-sRGB plane immediately before
//! output transform and output effects. Radii are expressed at a 1500 px
//! whole-photo long edge; a geometry window therefore keeps the same source
//! scale as the uncropped frame.

use crate::color::{
    mat_vec_f32, PP_LUMA_F32, PROPHOTO_TO_SRGB_F32, REC709_LUMA_F32, SRGB_TO_PROPHOTO_F32,
};
use crate::settings::{DetailSettings, SharpeningSettings};
use std::fmt;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum SourceSpace {
    LinearSrgb,
    LinearProPhoto,
}

/// Settings for a pipeline whose source already includes v5 NR. Sharpening
/// stays active; only the source operations are neutralized.
pub(crate) fn source_noise_disabled(
    settings: &crate::settings::DevelopSettings,
) -> crate::settings::DevelopSettings {
    let mut downstream = settings.clone();
    if let Some(detail) = downstream.detail.as_mut() {
        detail.luminance_noise_reduction = 0.0;
        if detail.color_noise_reduction.is_some() {
            detail.color_noise_reduction = Some(0.0);
        }
    }
    downstream
}

#[derive(Clone, Debug, PartialEq)]
pub enum DetailError {
    InvalidDimensions,
    InvalidLength { expected: usize, actual: usize },
    NonFiniteInput(usize),
    NonFiniteOutput(usize),
    Chroma(crate::raw_chroma::RawChromaError),
}

impl fmt::Display for DetailError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::InvalidDimensions => write!(f, "invalid detail image dimensions"),
            Self::InvalidLength { expected, actual } => {
                write!(
                    f,
                    "invalid detail RGB length: expected {expected}, got {actual}"
                )
            }
            Self::NonFiniteInput(index) => write!(f, "non-finite detail input at {index}"),
            Self::NonFiniteOutput(index) => write!(f, "non-finite detail output at {index}"),
            Self::Chroma(error) => write!(f, "detail color noise reduction: {error}"),
        }
    }
}

impl std::error::Error for DetailError {}

fn validate(source: &[f32], width: usize, height: usize) -> Result<(), DetailError> {
    let expected = width
        .checked_mul(height)
        .and_then(|pixels| pixels.checked_mul(3))
        .filter(|_| width > 0 && height > 0)
        .ok_or(DetailError::InvalidDimensions)?;
    if source.len() != expected {
        return Err(DetailError::InvalidLength {
            expected,
            actual: source.len(),
        });
    }
    if let Some(index) = source.iter().position(|value| !value.is_finite()) {
        return Err(DetailError::NonFiniteInput(index));
    }
    Ok(())
}

/// Applies v5 source noise reduction. `raster_color_amount` is used only for
/// raster sources; signed RAW applies the effective R209 amount in its
/// canonical preparation cache and passes `None` here, avoiding a second
/// chroma pass.
pub fn reduce_noise(
    source: &[f32],
    width: usize,
    height: usize,
    whole_long_edge: usize,
    space: SourceSpace,
    detail: DetailSettings,
    raster_color_amount: Option<f64>,
) -> Result<Vec<f32>, DetailError> {
    validate(source, width, height)?;
    let mut output = source.to_vec();
    if let Some(amount) = raster_color_amount.filter(|amount| *amount > 0.0) {
        let prophoto = match space {
            SourceSpace::LinearProPhoto => output,
            SourceSpace::LinearSrgb => output
                .chunks_exact(3)
                .flat_map(|pixel| {
                    mat_vec_f32(&SRGB_TO_PROPHOTO_F32, [pixel[0], pixel[1], pixel[2]])
                })
                .collect(),
        };
        let filtered = crate::raw_chroma::apply(&prophoto, width, height, amount)
            .map_err(DetailError::Chroma)?;
        output = match space {
            SourceSpace::LinearProPhoto => filtered,
            SourceSpace::LinearSrgb => filtered
                .chunks_exact(3)
                .flat_map(|pixel| {
                    mat_vec_f32(&PROPHOTO_TO_SRGB_F32, [pixel[0], pixel[1], pixel[2]])
                })
                .collect(),
        };
    }
    if detail.luminance_noise_reduction > 0.0 {
        guided_luminance(
            &mut output,
            width,
            height,
            whole_long_edge,
            space,
            detail.luminance_noise_reduction,
        );
    }
    if let Some(index) = output.iter().position(|value| !value.is_finite()) {
        return Err(DetailError::NonFiniteOutput(index));
    }
    Ok(output)
}

fn guided_luminance(
    rgb: &mut [f32],
    width: usize,
    height: usize,
    whole_long_edge: usize,
    space: SourceSpace,
    amount: f64,
) {
    let weights = match space {
        SourceSpace::LinearSrgb => REC709_LUMA_F32,
        SourceSpace::LinearProPhoto => PP_LUMA_F32,
    };
    let scale = whole_long_edge.max(1) as f64 / 1500.0;
    let radius = libm::round((1.5 + amount * 0.055) * scale).clamp(1.0, 32.0) as usize;
    let strength = (amount / 100.0) as f32;
    let epsilon = (0.006 + 0.075 * strength).powi(2);
    let guide: Vec<f32> = rgb
        .chunks_exact(3)
        .map(|pixel| {
            (pixel[0] * weights[0] + pixel[1] * weights[1] + pixel[2] * weights[2])
                .max(3e-5)
                .ln()
        })
        .collect();
    let mean = box_mean(&guide, width, height, radius);
    let square: Vec<f32> = guide.iter().map(|value| value * value).collect();
    let mean_square = box_mean(&square, width, height, radius);
    let mut a = Vec::with_capacity(guide.len());
    let mut b = Vec::with_capacity(guide.len());
    for ((mean, mean_square), value) in mean.iter().zip(&mean_square).zip(&guide) {
        let variance = (*mean_square - *mean * *mean).max(0.0);
        let slope = variance / (variance + epsilon);
        a.push(slope);
        b.push(*mean - slope * *mean);
        debug_assert!(value.is_finite());
    }
    let mean_a = box_mean(&a, width, height, radius);
    let mean_b = box_mean(&b, width, height, radius);
    for (((pixel, original), a), b) in rgb
        .chunks_exact_mut(3)
        .zip(&guide)
        .zip(&mean_a)
        .zip(&mean_b)
    {
        let filtered = a * original + b;
        let delta = (filtered - original) * strength;
        let scale = libm::expf(delta);
        pixel[0] *= scale;
        pixel[1] *= scale;
        pixel[2] *= scale;
    }
}

/// Applies linear-light luma USM in place. The plane is output-sized linear
/// sRGB, never decoded back from `Rendered.rgba`. Interactive renders may
/// omit it; a following Final render always recomputes this exact operation.
pub fn sharpen_linear_srgb(
    rgb: &mut [f32],
    width: usize,
    height: usize,
    whole_long_edge: usize,
    settings: SharpeningSettings,
) -> Result<(), DetailError> {
    validate(rgb, width, height)?;
    if settings.amount == 0.0 {
        return Ok(());
    }
    let luma: Vec<f32> = rgb
        .chunks_exact(3)
        .map(|pixel| {
            pixel[0] * REC709_LUMA_F32[0]
                + pixel[1] * REC709_LUMA_F32[1]
                + pixel[2] * REC709_LUMA_F32[2]
        })
        .collect();
    let scale = whole_long_edge.max(1) as f64 / 1500.0;
    let radius = libm::round(settings.radius * scale).clamp(1.0, 24.0) as usize;
    let fine_radius = libm::round(settings.radius * 0.45 * scale).clamp(1.0, 12.0) as usize;
    let broad = box_mean(&luma, width, height, radius);
    let fine = box_mean(&luma, width, height, fine_radius);
    let detail_weight = (settings.detail / 100.0) as f32;
    let gain = (settings.amount / 100.0) as f32;
    let threshold = (settings.masking / 100.0) as f32 * 0.075;
    for y in 0..height {
        for x in 0..width {
            let index = y * width + x;
            let left = luma[y * width + x.saturating_sub(1)];
            let right = luma[y * width + (x + 1).min(width - 1)];
            let top = luma[y.saturating_sub(1) * width + x];
            let bottom = luma[(y + 1).min(height - 1) * width + x];
            let gradient = ((right - left).abs() + (bottom - top).abs()) * 0.5;
            let mask = if threshold == 0.0 {
                1.0
            } else {
                gradient / (gradient + threshold)
            };
            let broad_high = luma[index] - broad[index];
            let fine_high = luma[index] - fine[index];
            let high = broad_high * (1.0 - detail_weight) + fine_high * detail_weight * 1.5;
            let delta = high * gain * mask;
            let pixel = &mut rgb[index * 3..index * 3 + 3];
            pixel[0] += delta;
            pixel[1] += delta;
            pixel[2] += delta;
        }
    }
    if let Some(index) = rgb.iter().position(|value| !value.is_finite()) {
        return Err(DetailError::NonFiniteOutput(index));
    }
    Ok(())
}

fn box_mean(source: &[f32], width: usize, height: usize, radius: usize) -> Vec<f32> {
    let mut horizontal = vec![0.0; source.len()];
    let diameter = radius * 2 + 1;
    for y in 0..height {
        let row = &source[y * width..(y + 1) * width];
        let mut sum = row[0] * radius as f32;
        for x in 0..=radius.min(width - 1) {
            sum += row[x];
        }
        for x in 0..width {
            horizontal[y * width + x] = sum / diameter as f32;
            let remove = row[x.saturating_sub(radius)];
            let add = row[(x + radius + 1).min(width - 1)];
            sum += add - remove;
        }
    }
    let mut output = vec![0.0; source.len()];
    for x in 0..width {
        let mut sum = horizontal[x] * radius as f32;
        for y in 0..=radius.min(height - 1) {
            sum += horizontal[y * width + x];
        }
        for y in 0..height {
            output[y * width + x] = sum / diameter as f32;
            let remove = horizontal[y.saturating_sub(radius) * width + x];
            let add = horizontal[(y + radius + 1).min(height - 1) * width + x];
            sum += add - remove;
        }
    }
    output
}

#[cfg(test)]
mod tests {
    use super::*;

    fn variance(values: &[f32]) -> f32 {
        let mean = values.iter().sum::<f32>() / values.len() as f32;
        values
            .iter()
            .map(|value| (value - mean).powi(2))
            .sum::<f32>()
            / values.len() as f32
    }

    #[test]
    fn seeded_flat_noise_falls_and_step_edge_is_retained() {
        let (width, height) = (48, 24);
        let mut seed = 7u32;
        let mut source = Vec::with_capacity(width * height * 3);
        for _y in 0..height {
            for x in 0..width {
                seed = seed.wrapping_mul(1_664_525).wrapping_add(1_013_904_223);
                let noise = ((seed >> 8) as f32 / 16_777_215.0 - 0.5) * 0.08;
                let value = if x < width / 2 { 0.25 } else { 0.75 };
                source.extend_from_slice(&[value + noise; 3]);
            }
        }
        let settings = DetailSettings {
            luminance_noise_reduction: 80.0,
            ..DetailSettings::default()
        };
        let filtered = reduce_noise(
            &source,
            width,
            height,
            1500,
            SourceSpace::LinearSrgb,
            settings,
            None,
        )
        .unwrap();
        let before: Vec<_> = source
            .chunks_exact(3)
            .take(width / 3)
            .map(|p| p[1])
            .collect();
        let after: Vec<_> = filtered
            .chunks_exact(3)
            .take(width / 3)
            .map(|p| p[1])
            .collect();
        assert!(variance(&after) < variance(&before));
        let row = height / 2;
        let left = filtered[(row * width + width / 2 - 3) * 3 + 1];
        let right = filtered[(row * width + width / 2 + 3) * 3 + 1];
        assert!(right - left > 0.35);
    }

    #[test]
    fn sharpening_amount_zero_is_exact_and_detail_and_masking_act() {
        let (width, height) = (31, 9);
        let mut source = vec![0.3; width * height * 3];
        for y in 0..height {
            for x in width / 2..width {
                source[(y * width + x) * 3..(y * width + x) * 3 + 3].fill(0.7);
            }
        }
        let mut zero = source.clone();
        sharpen_linear_srgb(
            &mut zero,
            width,
            height,
            1500,
            SharpeningSettings::default(),
        )
        .unwrap();
        assert_eq!(zero, source);
        let apply = |detail, masking| {
            let mut value = source.clone();
            sharpen_linear_srgb(
                &mut value,
                width,
                height,
                1500,
                SharpeningSettings {
                    amount: 100.0,
                    radius: 1.5,
                    detail,
                    masking,
                },
            )
            .unwrap();
            value
        };
        let low = apply(0.0, 0.0);
        let high = apply(100.0, 0.0);
        assert_ne!(low, high, "detail must change the high-frequency weight");
        let masked = apply(25.0, 100.0);
        assert!((masked[3] - source[3]).abs() < (low[3] - source[3]).abs() + 1e-6);
        let edge = (height / 2 * width + width / 2 - 1) * 3;
        assert!((low[edge] - source[edge]).abs() > 0.01);
    }

    #[test]
    fn rejects_nonfinite_and_handles_tiny_signed_headroom() {
        assert!(reduce_noise(
            &[f32::NAN, 0.0, 0.0],
            1,
            1,
            1,
            SourceSpace::LinearProPhoto,
            DetailSettings::default(),
            None,
        )
        .is_err());
        let mut tiny = [-0.2, 0.1, 1.4];
        sharpen_linear_srgb(
            &mut tiny,
            1,
            1,
            1,
            SharpeningSettings {
                amount: 100.0,
                ..SharpeningSettings::default()
            },
        )
        .unwrap();
        assert!(tiny.iter().all(|value| value.is_finite()));
    }
}
