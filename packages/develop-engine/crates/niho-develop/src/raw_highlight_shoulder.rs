//! NIHO 7: fixed FX30 rational highlight shoulder.
//!
//! The model reads the same four immutable signed-source features as the
//! non-FX residual, but predicts two nonnegative response maps. The maps are
//! evaluated at the frozen canonical dimensions and resized only afterwards.

use crate::niho4_response::{CoefficientMaps, RawResponseError};

const FEATURE_COUNT: usize = 4;
#[cfg(test)]
const MODEL_JSON: &str = include_str!("niho7/raw-highlight-shoulder-v1.json");
const MEAN: [f32; FEATURE_COUNT] = [
    f32::from_bits(0x3f9d3234),
    f32::from_bits(0xc0770de6),
    f32::from_bits(0x40045b76),
    f32::from_bits(0xc027531f),
];
const SCALE: [f32; FEATURE_COUNT] = [
    f32::from_bits(0x3e59b845),
    f32::from_bits(0x3e8da86d),
    f32::from_bits(0x3f7f2c30),
    f32::from_bits(0x3fb26440),
];
// Restrict the affine to the calibration support; actual source Y in
// the rational response and mask remains unchanged.
const DOMAIN_LOW: [f32; FEATURE_COUNT] = [
    f32::from_bits(0x3f2176b3),
    f32::from_bits(0xc084e9ff),
    f32::from_bits(0x3d207464),
    f32::from_bits(0xc0b22994),
];
const DOMAIN_HIGH: [f32; FEATURE_COUNT] = [
    f32::from_bits(0x3fc789f4),
    f32::from_bits(0xc05b5682),
    f32::from_bits(0x40ad15f8),
    f32::from_bits(0xbf468394),
];
const COEFFICIENTS_A: [f32; FEATURE_COUNT + 1] = [
    f32::from_bits(0x3efa0ef7),
    f32::from_bits(0xbe45ba64),
    f32::from_bits(0xbf90e7dc),
    f32::from_bits(0xbe927439),
    f32::from_bits(0x3e2e75c3),
];
const COEFFICIENTS_B: [f32; FEATURE_COUNT + 1] = [
    f32::from_bits(0xc04e5002),
    f32::from_bits(0x3ff157a7),
    f32::from_bits(0xbf8987bd),
    f32::from_bits(0x3f94cc2e),
    f32::from_bits(0xbf9e194c),
];

#[inline]
fn softplus(value: f32) -> f32 {
    if value > 20.0 {
        value
    } else {
        libm::log1pf(libm::expf(value))
    }
}

fn predict(feature: [f32; FEATURE_COUNT], coefficients: [f32; FEATURE_COUNT + 1]) -> f32 {
    softplus(
        feature
            .into_iter()
            .enumerate()
            .fold(coefficients[0], |sum, (index, value)| {
                sum + ((value.clamp(DOMAIN_LOW[index], DOMAIN_HIGH[index]) - MEAN[index])
                    / SCALE[index])
                    * coefficients[index + 1]
            }),
    )
}

pub(crate) fn maps(
    source: &[f32],
    width: usize,
    height: usize,
    baseline_ev: f64,
    coefficients: &CoefficientMaps,
) -> Result<(Vec<f32>, Vec<f32>), RawResponseError> {
    let rows = crate::raw_highlight_residual::feature_rows(
        source,
        width,
        height,
        baseline_ev,
        coefficients,
    )?;
    Ok((
        rows.iter()
            .map(|row| predict(*row, COEFFICIENTS_A))
            .collect(),
        rows.into_iter()
            .map(|row| predict(row, COEFFICIENTS_B))
            .collect(),
    ))
}

/// Physical display-luminance headroom, measured on the full immutable
/// baseline-exposed source. The storage ceiling is intentionally not an
/// input: it is an adaptive range rather than a physical clipping point.
pub(crate) fn mask_weights(
    source: &[f32],
    width: usize,
    height: usize,
    baseline_ev: f64,
) -> Vec<f32> {
    let exposure = libm::exp2(baseline_ev) as f32;
    source
        .chunks_exact(3)
        .take(width * height)
        .map(|pixel| {
            if pixel.iter().any(|value| *value < 0.0 || !value.is_finite()) {
                return 0.0;
            }
            let y = (pixel[0] * 0.2880402 + pixel[1] * 0.7118741 + pixel[2] * 0.0000857) * exposure;
            let t = ((y - 0.8) / 0.2).clamp(0.0, 1.0);
            t * t * (3.0 - 2.0 * t)
        })
        .collect()
}

pub(crate) fn apply_pixel(
    pre: [f32; 3],
    old: [f32; 3],
    a: f32,
    b: f32,
    mask: f32,
    h: f32,
    baseline_exposure: f32,
) -> [f32; 3] {
    if mask <= 0.0
        || h <= 0.0
        || !mask.is_finite()
        || !h.is_finite()
        || !a.is_finite()
        || !b.is_finite()
        || !baseline_exposure.is_finite()
        || pre.iter().any(|value| *value < 0.0 || !value.is_finite())
    {
        return old;
    }
    let y_pre = (pre[0] * 0.2880402 + pre[1] * 0.7118741 + pre[2] * 0.0000857) * baseline_exposure;
    let k = h * a + h * h * b;
    let scale = (1.0 / (1.0 + k * y_pre)).max(1.0 / 256.0);
    let weight = mask.clamp(0.0, 1.0);
    std::array::from_fn(|index| old[index] + weight * (pre[index] * scale - old[index]))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn model_json_and_runtime_f32_constants_are_bit_exact() {
        let model: serde_json::Value = serde_json::from_str(MODEL_JSON).unwrap();
        for (key, actual) in [
            ("mean", &MEAN[..]),
            ("scale", &SCALE[..]),
            ("domainLow", &DOMAIN_LOW[..]),
            ("domainHigh", &DOMAIN_HIGH[..]),
            ("coefficientsA", &COEFFICIENTS_A[..]),
            ("coefficientsB", &COEFFICIENTS_B[..]),
        ] {
            let expected = model[key]
                .as_array()
                .unwrap()
                .iter()
                .map(|value| (value.as_f64().unwrap() as f32).to_bits())
                .collect::<Vec<_>>();
            assert_eq!(
                actual
                    .iter()
                    .map(|value| value.to_bits())
                    .collect::<Vec<_>>(),
                expected,
                "{key}"
            );
        }
        for coefficients in [COEFFICIENTS_A, COEFFICIENTS_B] {
            let value = predict(MEAN, coefficients);
            assert!(value.is_finite() && value >= 0.0);
        }
    }

    #[test]
    fn response_saturates_at_the_calibrated_feature_domain() {
        for coefficients in [COEFFICIENTS_A, COEFFICIENTS_B] {
            let inside = predict(MEAN, coefficients);
            assert!(inside.is_finite() && inside >= 0.0);
            for index in 0..FEATURE_COUNT {
                for (bound, direction) in [(DOMAIN_LOW[index], -1.0), (DOMAIN_HIGH[index], 1.0)] {
                    let mut boundary = MEAN;
                    boundary[index] = bound;
                    let mut outside = boundary;
                    outside[index] += direction * 100.0;
                    assert_eq!(
                        predict(boundary, coefficients),
                        predict(outside, coefficients)
                    );
                }
            }
        }
    }

    #[test]
    fn physical_mask_is_independent_of_encoding_ceiling_chroma_and_flatness() {
        // No encoding ceiling enters the API, and a single pixel has no
        // neighborhood/flatness term. Equal luminance therefore has equal
        // weight even when chroma differs.
        let colored_green = (0.9 - 1.2 * 0.2880402 - 0.2 * 0.0000857) / 0.7118741;
        let neutral = mask_weights(&[0.9, 0.9, 0.9], 1, 1, 0.0)[0];
        let colored = mask_weights(&[1.2, colored_green, 0.2], 1, 1, 0.0)[0];
        assert!((neutral - colored).abs() < 1e-6);
        assert_eq!(mask_weights(&[0.6, 0.6, 0.6], 1, 1, 0.0), vec![0.0]);
        assert_eq!(mask_weights(&[2.2, 2.2, 2.2], 1, 1, 0.0), vec![1.0]);
        assert_eq!(mask_weights(&[2.1, 1.7, 1.0], 1, 1, 0.0), vec![1.0]);
        assert_eq!(mask_weights(&[2.1, 1.7, 1.0], 1, 1, -2.0), vec![0.0]);
        assert_eq!(mask_weights(&[-1.0, 2.0, 2.0], 1, 1, 0.0), vec![0.0]);
        assert_eq!(mask_weights(&[f32::NAN, 2.0, 2.0], 1, 1, 0.0), vec![0.0]);
    }

    #[test]
    fn h0_w0_and_invalid_pre_are_exact_old_response() {
        let old = [0.1, 0.2, 0.3];
        assert_eq!(apply_pixel([2.0; 3], old, 1.0, 1.0, 0.0, 1.0, 1.0), old);
        assert_eq!(apply_pixel([2.0; 3], old, 1.0, 1.0, 1.0, 0.0, 1.0), old);
        assert_eq!(
            apply_pixel([-1.0, 2.0, 2.0], old, 1.0, 1.0, 1.0, 1.0, 1.0),
            old
        );
        assert_eq!(
            apply_pixel([f32::NAN, 2.0, 2.0], old, 1.0, 1.0, 1.0, 1.0, 1.0),
            old
        );
    }

    #[test]
    fn response_is_finite_bounded_monotonic_and_color_relative_at_full_weight() {
        let pre = [2.0, 1.5, 0.75];
        let old = [0.2, 0.2, 0.2];
        let mut previous = pre;
        for h in [0.01, 0.6, 1.0] {
            let output = apply_pixel(pre, old, 2.0, 2.0, 1.0, h, 1.0);
            assert!(output.iter().all(|value| value.is_finite()));
            for index in 0..3 {
                assert!((pre[index] / 256.0..=pre[index]).contains(&output[index]));
                assert!(output[index] <= previous[index]);
            }
            let relative = output[0] / pre[0];
            assert!((output[1] / pre[1] - relative).abs() < 1e-6);
            assert!((output[2] / pre[2] - relative).abs() < 1e-6);
            previous = output;
        }
    }
}
