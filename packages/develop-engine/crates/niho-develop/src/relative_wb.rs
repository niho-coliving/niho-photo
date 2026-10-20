//! Relative color temperature / tint (`relativeTemperature` /
//! `relativeTint`, -100..100): Photo Bench `RelativeColorAdjustment`, which
//! runs Core Image's `CITemperatureAndTint` with
//! `inputNeutral = (6500 + 30 * temperature, 0.5 * tint)` and
//! `inputTargetNeutral = (6500, 0)` on extended linear sRGB.
//!
//! Core Image does not document the filter's math. Measured on float
//! buffers (`scripts/golden/temperature_tint_probe.swift`), it is a linear
//! 3x3 matrix: a Bradford adaptation from the DNG-SDK chromaticity of the
//! neutral (`xy_from_temperature(T, tint)`) to that of the target, conjugated
//! with Apple's legacy "Generic RGB" primaries (D65 white) instead of the
//! working space's sRGB primaries. This model reproduces the filter within
//! 3e-6 per matrix element (float precision) over temperatures 2000–25000K
//! and tints ±50 of both neutrals, so the stage is `exact`.

use crate::color::{
    bradford_xyz, mat_inverse, mat_mul, mat_vec, to_f32, xy_from_temperature, xy_to_xyz, Mat3, Xy,
};

/// Apple "Generic RGB" (the pre-10.6 Core Image working space) primaries
/// and white, which `CITemperatureAndTint` uses to reach XYZ.
const GENERIC_RGB_PRIMARIES: [Xy; 3] = [
    Xy { x: 0.630, y: 0.340 },
    Xy { x: 0.295, y: 0.605 },
    Xy { x: 0.155, y: 0.077 },
];
const GENERIC_RGB_WHITE: Xy = Xy {
    x: 0.3127,
    y: 0.3290,
};

/// Linear Generic RGB -> XYZ (white maps to the D65 white with Y = 1).
fn generic_rgb_to_xyz() -> Mat3 {
    let [r, g, b] = GENERIC_RGB_PRIMARIES.map(xy_to_xyz);
    let primaries: Mat3 = [[r[0], g[0], b[0]], [r[1], g[1], b[1]], [r[2], g[2], b[2]]];
    let s = mat_vec(&mat_inverse(&primaries), xy_to_xyz(GENERIC_RGB_WHITE));
    let mut m = primaries;
    for row in m.iter_mut() {
        for (value, scale) in row.iter_mut().zip(s) {
            *value *= scale;
        }
    }
    m
}

pub fn sanitized(value: f64) -> f64 {
    if value.is_finite() {
        value.clamp(-100.0, 100.0)
    } else {
        0.0
    }
}

/// Matrix on extended linear sRGB; `None` when both values are 0.
pub fn relative_matrix(temperature: f64, tint: f64) -> Option<[[f32; 3]; 3]> {
    let t = sanitized(temperature);
    let n = sanitized(tint);
    if t == 0.0 && n == 0.0 {
        return None;
    }
    let source = xy_from_temperature(6500.0 + 30.0 * t, 0.5 * n);
    let target = xy_from_temperature(6500.0, 0.0);
    let cat = bradford_xyz(source, target);
    let to_xyz = generic_rgb_to_xyz();
    let m = mat_mul(&mat_inverse(&to_xyz), &mat_mul(&cat, &to_xyz));
    Some(to_f32(&m))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn warmer_neutral_reduces_blue() {
        // inputNeutral 9500K -> 6500K: a bluish light is neutralized.
        let m = relative_matrix(100.0, 0.0).unwrap();
        assert!(m[2][2] < 0.8 && m[0][0] > 1.03, "{m:?}");
        assert!(relative_matrix(0.0, 0.0).is_none());
    }

    #[test]
    fn matches_core_image_measurements() {
        // CITemperatureAndTint on RGBAf buffers in extended linear sRGB
        // (macOS 28, scripts/golden/temperature_tint_probe.swift): the
        // images of the unit vectors, i.e. the matrix columns.
        #[rustfmt::skip]
        type Case = ((f64, f64), [[f32; 3]; 3]);
        let cases: [Case; 4] = [
            (
                (-100.0, 100.0),
                [
                    [0.868222, 0.008903, 0.06778],
                    [-0.167343, 1.023408, 0.244885],
                    [-0.136904, -0.165805, 3.974278],
                ],
            ),
            (
                (-30.0, 60.0),
                [
                    [1.005899, -0.003105, 0.006955],
                    [0.032335, 0.969278, 0.027125],
                    [-0.010629, -0.019312, 1.309838],
                ],
            ),
            (
                (40.0, -20.0),
                [
                    [1.014936, -0.000419, -0.003577],
                    [0.008201, 1.007415, -0.012948],
                    [0.007182, 0.008778, 0.851216],
                ],
            ),
            (
                (100.0, -100.0),
                [
                    [0.973557, 0.007978, -0.006839],
                    [-0.09248, 1.073976, -0.029118],
                    [0.006263, 0.021804, 0.69283],
                ],
            ),
        ];
        for ((t, n), columns) in cases {
            let m = relative_matrix(t, n).unwrap();
            for (k, column) in columns.iter().enumerate() {
                for (i, want) in column.iter().enumerate() {
                    assert!(
                        (m[i][k] - want).abs() < 1e-5,
                        "({t}, {n}) m[{i}][{k}] = {} vs Core Image {want}",
                        m[i][k]
                    );
                }
            }
        }
    }
}
