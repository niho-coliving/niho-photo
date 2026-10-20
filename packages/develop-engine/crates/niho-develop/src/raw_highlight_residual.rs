//! NIHO 7: the fixed bounded residual on the frozen R395 highlight gain.
//!
//! The four features are measured from the immutable full-resolution signed
//! CNR source at the response map's canonical dimensions. Only this residual
//! uses signed headroom; the underlying R395 coefficient maps retain their
//! frozen unsigned quantization and clamp.

use crate::niho4_response::{self, CoefficientMaps, RawResponseError};
use crate::resize::{self, Filter};

pub const FEATURE_COUNT: usize = 4;

#[cfg(test)]
const MODEL_JSON: &str = include_str!("niho7/raw-highlight-residual-v1.json");
const MEAN: [f32; FEATURE_COUNT] = [
    f32::from_bits(0x3f5970b6),
    f32::from_bits(0xc080a2f4),
    f32::from_bits(0x3fff0fb6),
    f32::from_bits(0xbfdb1a98),
];
const SCALE: [f32; FEATURE_COUNT] = [
    f32::from_bits(0x3f300bac),
    f32::from_bits(0x3f702565),
    f32::from_bits(0x3fa4b2a3),
    f32::from_bits(0x3f9d811a),
];
const INTERCEPT: f32 = f32::from_bits(0x3f117908);
const COEFFICIENTS: [f32; FEATURE_COUNT] = [
    f32::from_bits(0x3e33ed06),
    f32::from_bits(0x3f375551),
    f32::from_bits(0xbdf1043a),
    f32::from_bits(0xbec2dd8d),
];

fn signed_analysis(
    source: &[f32],
    width: usize,
    height: usize,
    baseline_ev: f64,
    out_width: usize,
    out_height: usize,
) -> Vec<f32> {
    let exposure = libm::exp2(baseline_ev) as f32;
    resize::resample_rows(
        width,
        height,
        out_width,
        out_height,
        Filter::Area,
        |y, output| {
            let source = &source[y * width * 3..(y + 1) * width * 3];
            for (output, source) in output.iter_mut().zip(source) {
                *output = *source * exposure;
            }
        },
    )
}

pub(crate) fn feature_rows(
    source: &[f32],
    width: usize,
    height: usize,
    baseline_ev: f64,
    coefficients: &CoefficientMaps,
) -> Result<Vec<[f32; FEATURE_COUNT]>, RawResponseError> {
    let signed = signed_analysis(
        source,
        width,
        height,
        baseline_ev,
        coefficients.width,
        coefficients.height,
    );
    let exact = niho4_response::feature_vectors(&signed, coefficients.width, coefficients.height)?;
    let (h100_gain, _) = niho4_response::gain_ev_components(coefficients, -100.0, 0.0)?;
    Ok(exact
        .into_iter()
        .zip(h100_gain)
        .map(|(row, gain)| [row[0], row[1], row[7], gain])
        .collect())
}

fn predict_base(feature: [f32; FEATURE_COUNT]) -> f32 {
    let value = feature
        .into_iter()
        .enumerate()
        .fold(INTERCEPT, |sum, (index, value)| {
            sum + ((value - MEAN[index]) / SCALE[index]) * COEFFICIENTS[index]
        });
    if value.is_finite() {
        value.clamp(-1.0, 1.0)
    } else {
        0.0
    }
}

pub(crate) fn base_map(
    source: &[f32],
    width: usize,
    height: usize,
    baseline_ev: f64,
    coefficients: &CoefficientMaps,
) -> Result<Vec<f32>, RawResponseError> {
    Ok(
        feature_rows(source, width, height, baseline_ev, coefficients)?
            .into_iter()
            .map(predict_base)
            .collect(),
    )
}

pub(crate) fn apply_to_gains(
    gains: &mut [f32],
    residual_base: &[f32],
    source_mask: &[f32],
    highlights: f32,
) {
    if !highlights.is_finite() || !(-100.0..0.0).contains(&highlights) {
        return;
    }
    debug_assert_eq!(gains.len(), residual_base.len());
    debug_assert_eq!(gains.len(), source_mask.len());
    let h = -highlights / 100.0;
    let ramp = h.powi(4);
    for ((gain, base), mask) in gains.iter_mut().zip(residual_base).zip(source_mask) {
        let base = if base.is_finite() {
            base.clamp(-1.0, 1.0)
        } else {
            0.0
        };
        let mask = if mask.is_finite() {
            mask.clamp(0.0, 1.0)
        } else {
            0.0
        };
        *gain = (*gain + ramp * mask * base).clamp(-8.0, 0.0);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn h0_invalid_noncandidate_and_nonfinite_inputs_are_bounded_no_ops() {
        for highlights in [0.0, 1.0, -101.0, f32::NAN] {
            let mut gains = vec![-0.5, -7.9];
            let original = gains.clone();
            apply_to_gains(&mut gains, &[1.0, -1.0], &[1.0, 1.0], highlights);
            assert_eq!(gains, original);
        }

        let mut gains = vec![-0.5, -0.5, -7.9, -0.1];
        apply_to_gains(
            &mut gains,
            &[1.0, f32::NAN, -1.0, 1.0],
            &[0.0, 1.0, 1.0, f32::NAN],
            -100.0,
        );
        assert_eq!(gains[0], -0.5);
        assert_eq!(gains[1], -0.5);
        assert_eq!(gains[2], -8.0);
        assert_eq!(gains[3], -0.1);
        assert!(gains
            .iter()
            .all(|value| value.is_finite() && (-8.0..=0.0).contains(value)));
    }

    #[test]
    fn runtime_f32_constants_are_bit_exact_with_the_versioned_model() {
        let model: serde_json::Value = serde_json::from_str(MODEL_JSON).unwrap();
        let values = |key: &str| {
            model[key]
                .as_array()
                .unwrap()
                .iter()
                .map(|value| value.as_f64().unwrap() as f32)
                .collect::<Vec<_>>()
        };
        let mean = values("normalizationMean");
        let scale = values("normalizationScale");
        let beta = values("interceptAndCoefficients");
        assert_eq!(
            mean.iter().map(|v| v.to_bits()).collect::<Vec<_>>(),
            MEAN.iter().map(|v| v.to_bits()).collect::<Vec<_>>()
        );
        assert_eq!(
            scale.iter().map(|v| v.to_bits()).collect::<Vec<_>>(),
            SCALE.iter().map(|v| v.to_bits()).collect::<Vec<_>>()
        );
        assert_eq!(beta[0].to_bits(), INTERCEPT.to_bits());
        assert_eq!(
            beta[1..].iter().map(|v| v.to_bits()).collect::<Vec<_>>(),
            COEFFICIENTS.iter().map(|v| v.to_bits()).collect::<Vec<_>>()
        );
    }

    #[test]
    fn prediction_is_finite_and_clamped_for_extreme_features() {
        for feature in [
            [0.0; FEATURE_COUNT],
            [f32::MAX; FEATURE_COUNT],
            [f32::MIN; FEATURE_COUNT],
            [f32::INFINITY, f32::NEG_INFINITY, f32::NAN, 0.0],
        ] {
            let value = predict_base(feature);
            assert!(value.is_finite());
            assert!((-1.0..=1.0).contains(&value));
        }
    }
}
