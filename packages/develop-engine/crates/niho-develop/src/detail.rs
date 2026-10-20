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
        let filtered = crate::raw_chroma::apply_detail(&prophoto, width, height, amount)
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

/// Source preparation uses the old frozen path unless v5 explicitly owns
/// the color amount. This keeps every legacy RAW pixel unchanged.
pub(crate) fn reduce_raw_chroma(
    source: &[f32],
    width: usize,
    height: usize,
    settings: &crate::settings::DevelopSettings,
) -> Result<Vec<f32>, crate::raw_chroma::RawChromaError> {
    match settings
        .detail
        .and_then(|detail| detail.color_noise_reduction)
    {
        Some(amount) => crate::raw_chroma::apply_detail(source, width, height, amount),
        None => crate::raw_chroma::apply(
            source,
            width,
            height,
            settings.color_noise_reduction.min(50.0),
        ),
    }
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
    // Keep the authored radius continuous. Rounding it to an integer box
    // made adjacent values such as 1.1 and 1.2 exactly the same operation.
    // A truncated Gaussian has a bounded footprint while preserving smooth
    // changes in sigma; each normalized 1-D kernel is built once and reused
    // for the horizontal and vertical passes.
    let sigma = sharpening_sigma(whole_long_edge, settings);
    let broad = gaussian_mean(&luma, width, height, sigma);
    let fine = gaussian_mean(&luma, width, height, (sigma * 0.45).max(1.0 / 1024.0));
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

fn sharpening_sigma(whole_long_edge: usize, settings: SharpeningSettings) -> f64 {
    let scale = whole_long_edge.max(1) as f64 / 1500.0;
    (settings.radius * scale).clamp(1.0 / 1024.0, 24.0)
}

/// Maximum pixel reach read by [`sharpen_linear_srgb`]. Geometry plans use
/// this to size an internal crop halo. A halo clipped by the actual photo
/// boundary may be smaller; the filter clamps at that photo boundary.
pub fn sharpening_reach(whole_long_edge: usize, settings: SharpeningSettings) -> usize {
    libm::ceil(3.0 * sharpening_sigma(whole_long_edge, settings)) as usize
}

fn box_mean(source: &[f32], width: usize, height: usize, radius: usize) -> Vec<f32> {
    let mut horizontal = vec![0.0; source.len()];
    let diameter = radius * 2 + 1;
    for y in 0..height {
        let row = &source[y * width..(y + 1) * width];
        let mut sum = row[0] * radius as f32;
        for value in row.iter().take(radius.min(width - 1) + 1) {
            sum += *value;
        }
        sum += row[width - 1] * radius.saturating_sub(width - 1) as f32;
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
        sum += horizontal[(height - 1) * width + x] * radius.saturating_sub(height - 1) as f32;
        for y in 0..height {
            output[y * width + x] = sum / diameter as f32;
            let remove = horizontal[y.saturating_sub(radius) * width + x];
            let add = horizontal[(y + radius + 1).min(height - 1) * width + x];
            sum += add - remove;
        }
    }
    output
}

fn gaussian_mean(source: &[f32], width: usize, height: usize, sigma: f64) -> Vec<f32> {
    let radius = libm::ceil(3.0 * sigma) as usize;
    let mut kernel = Vec::with_capacity(radius + 1);
    let mut total = 1.0f64;
    kernel.push(1.0f32);
    for offset in 1..=radius {
        let x = offset as f64;
        let weight = libm::exp(-(x * x) / (2.0 * sigma * sigma));
        kernel.push(weight as f32);
        total += 2.0 * weight;
    }
    let inverse = (1.0 / total) as f32;
    for weight in &mut kernel {
        *weight *= inverse;
    }

    let mut horizontal = vec![0.0f32; source.len()];
    for y in 0..height {
        let row = &source[y * width..(y + 1) * width];
        for x in 0..width {
            let mut sum = row[x] * kernel[0];
            for (offset, weight) in kernel.iter().copied().enumerate().skip(1) {
                sum += weight * (row[x.saturating_sub(offset)] + row[(x + offset).min(width - 1)]);
            }
            horizontal[y * width + x] = sum;
        }
    }
    let mut output = vec![0.0f32; source.len()];
    for y in 0..height {
        for x in 0..width {
            let mut sum = horizontal[y * width + x] * kernel[0];
            for (offset, weight) in kernel.iter().copied().enumerate().skip(1) {
                sum += weight
                    * (horizontal[y.saturating_sub(offset) * width + x]
                        + horizontal[(y + offset).min(height - 1) * width + x]);
            }
            output[y * width + x] = sum;
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

    fn reference_box_mean(source: &[f32], width: usize, height: usize, radius: usize) -> Vec<f32> {
        let diameter = radius * 2 + 1;
        let area = (diameter * diameter) as f32;
        (0..height)
            .flat_map(|y| {
                (0..width).map(move |x| {
                    let mut sum = 0.0f32;
                    for dy in 0..diameter {
                        let sy = (y + dy).saturating_sub(radius).min(height - 1);
                        for dx in 0..diameter {
                            let sx = (x + dx).saturating_sub(radius).min(width - 1);
                            sum += source[sy * width + sx];
                        }
                    }
                    sum / area
                })
            })
            .collect()
    }

    #[test]
    fn box_mean_matches_independent_clamped_convolution_on_tiny_images() {
        for (width, height) in [(1, 1), (1, 5), (5, 1), (2, 2)] {
            let source: Vec<f32> = (0..width * height)
                .map(|index| 0.125 + index as f32 * 0.25)
                .collect();
            for radius in 0..=9 {
                let actual = box_mean(&source, width, height, radius);
                let expected = reference_box_mean(&source, width, height, radius);
                for (actual, expected) in actual.iter().zip(expected) {
                    assert!(
                        (actual - expected).abs() <= 2e-6,
                        "{width}x{height} radius {radius}: {actual} vs {expected}"
                    );
                }
                let constant = vec![0.375; width * height];
                assert!(box_mean(&constant, width, height, radius)
                    .iter()
                    .all(|value| (*value - 0.375).abs() <= 2e-6));
            }
        }
    }

    #[test]
    fn active_detail_keeps_tiny_constant_colors_constant() {
        for (width, height) in [(1, 1), (1, 7), (7, 1), (2, 2)] {
            let source = [0.18, 0.42, 0.77].repeat(width * height);
            let reduced = reduce_noise(
                &source,
                width,
                height,
                9_000,
                SourceSpace::LinearSrgb,
                DetailSettings {
                    luminance_noise_reduction: 100.0,
                    ..DetailSettings::default()
                },
                None,
            )
            .unwrap();
            for (actual, expected) in reduced.iter().zip(&source) {
                assert!((actual - expected).abs() <= 2e-6);
            }
            let mut sharpened = source.clone();
            sharpen_linear_srgb(
                &mut sharpened,
                width,
                height,
                9_000,
                SharpeningSettings {
                    amount: 150.0,
                    radius: 3.0,
                    detail: 100.0,
                    masking: 0.0,
                },
            )
            .unwrap();
            for (actual, expected) in sharpened.iter().zip(&source) {
                assert!((actual - expected).abs() <= 1e-5);
            }
        }
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
    fn sharpening_amount_zero_is_exact_and_continuous_radius_acts() {
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
        let edge = (height / 2 * width + width / 2 - 1) * 3;
        assert!((low[edge] - source[edge]).abs() > 0.01);

        let at_radius = |radius| {
            let mut value = source.clone();
            sharpen_linear_srgb(
                &mut value,
                width,
                height,
                1500,
                SharpeningSettings {
                    amount: 100.0,
                    radius,
                    detail: 35.0,
                    masking: 0.0,
                },
            )
            .unwrap();
            value
        };
        let mut previous = at_radius(0.5);
        for step in 6..=30 {
            let current = at_radius(step as f64 / 10.0);
            assert_ne!(previous, current, "radius {} must act", step as f64 / 10.0);
            previous = current;
        }
    }

    #[test]
    fn masking_suppresses_seeded_flat_noise_but_preserves_the_real_edge() {
        let (width, height) = (96, 48);
        let mut state = 0x32d3_91abu32;
        let mut source = Vec::with_capacity(width * height * 3);
        for _y in 0..height {
            for x in 0..width {
                state ^= state << 13;
                state ^= state >> 17;
                state ^= state << 5;
                let noise = (state as f32 / u32::MAX as f32 - 0.5) * 0.035;
                let value = if x < width / 2 { 0.3 } else { 0.7 };
                source.extend_from_slice(&[value + noise; 3]);
            }
        }
        let apply = |masking, detail| {
            let mut output = source.clone();
            sharpen_linear_srgb(
                &mut output,
                width,
                height,
                1500,
                SharpeningSettings {
                    amount: 120.0,
                    radius: 1.35,
                    detail,
                    masking,
                },
            )
            .unwrap();
            output
        };
        let unmasked = apply(0.0, 25.0);
        let masked = apply(100.0, 25.0);
        let flat_delta_variance = |rendered: &[f32]| {
            let mut deltas = Vec::new();
            for y in 4..height - 4 {
                for x in 4..width / 2 - 8 {
                    let index = (y * width + x) * 3 + 1;
                    deltas.push(rendered[index] - source[index]);
                }
            }
            variance(&deltas)
        };
        assert!(flat_delta_variance(&masked) < flat_delta_variance(&unmasked) * 0.35);
        let edge_response = |rendered: &[f32]| {
            let y = height / 2;
            let left = (y * width + width / 2 - 1) * 3 + 1;
            let right = (y * width + width / 2) * 3 + 1;
            (rendered[right] - rendered[left]) - (source[right] - source[left])
        };
        assert!(edge_response(&masked) > 0.01);
        let low_detail = apply(0.0, 0.0);
        let high_detail = apply(0.0, 100.0);
        let high_frequency_response = |rendered: &[f32]| {
            let mut total = 0.0f32;
            for y in 4..height - 4 {
                for x in 4..width / 2 - 8 {
                    let i = (y * width + x) * 3 + 1;
                    total += (rendered[i] - source[i]).abs();
                }
            }
            total
        };
        assert!(
            (high_frequency_response(&high_detail) - high_frequency_response(&low_detail)).abs()
                > 0.01
        );
    }

    #[test]
    fn sharpening_is_luma_only_and_keeps_signed_headroom_finite() {
        let mut rgb = vec![-0.12, 0.08, 1.25, 0.15, 0.35, 1.52, 0.7, 0.9, 2.1];
        let original = rgb.clone();
        sharpen_linear_srgb(
            &mut rgb,
            3,
            1,
            1500,
            SharpeningSettings {
                amount: 150.0,
                radius: 1.2,
                detail: 65.0,
                masking: 0.0,
            },
        )
        .unwrap();
        for (before, after) in original.chunks_exact(3).zip(rgb.chunks_exact(3)) {
            let delta = [
                after[0] - before[0],
                after[1] - before[1],
                after[2] - before[2],
            ];
            assert!((delta[0] - delta[1]).abs() <= 1e-6);
            assert!((delta[1] - delta[2]).abs() <= 1e-6);
            assert!(after.iter().all(|value| value.is_finite()));
        }
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
