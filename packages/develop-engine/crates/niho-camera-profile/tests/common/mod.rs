//! Shared test helpers.

use niho_camera_profile::dcp::{DcpSpec, HueSatMapSpec, LookTableSpec, SPEC_SCHEMA};

/// A spec that exercises every tag the writer knows. Matrix values are on the 1/10000 grid and
/// table values are exactly representable in f32, so the round trip is exact.
pub fn full_spec() -> DcpSpec {
    let mut data1 = Vec::new();
    let mut data2 = Vec::new();
    for h in 0..12 {
        for s in 0..6 {
            if s == 0 {
                data1.push([0.0, 1.0, 1.0]);
                data2.push([0.0, 1.0, 1.0]);
            } else {
                data1.push([(h as f64 - 6.0) * 0.5, 1.0 + s as f64 * 0.0625, 1.0]);
                data2.push([(h as f64 - 6.0) * -0.25, 1.0 - s as f64 * 0.03125, 1.0]);
            }
        }
    }
    DcpSpec {
        schema: SPEC_SCHEMA.to_string(),
        profile_name: "NIHO Test Camera v9".to_string(),
        unique_camera_model: "Panasonic DC-S5".to_string(),
        copyright: "Copyright 2026 NIHO Inc. Test profile.".to_string(),
        embed_policy: 3,
        calibration_signature: "com.niho.develop-engine".to_string(),
        illuminant1: 17,
        color_matrix1: vec![1.0, 0.0, 0.0, 0.0, 1.0, 0.0, 0.0, 0.0, 1.0],
        illuminant2: Some(21),
        color_matrix2: Some(vec![0.9, 0.1, 0.0, 0.0, 0.9, 0.1, 0.1, 0.0, 0.9]),
        forward_matrix1: Some(vec![0.6, 0.2, 0.1643, 0.2, 0.7, 0.1, 0.05, 0.05, 0.7251]),
        forward_matrix2: Some(vec![0.5, 0.3, 0.1643, 0.1, 0.8, 0.1, 0.1, 0.0, 0.7251]),
        hue_sat_map: Some(HueSatMapSpec {
            hue_divisions: 12,
            sat_divisions: 6,
            val_divisions: 1,
            encoding: 0,
            data1,
            data2: Some(data2),
        }),
        baseline_exposure_offset: -0.35,
        default_black_render: 1,
        tone_curve: Some(vec![[0.0, 0.0], [0.25, 0.1875], [1.0, 1.0]]),
        look_table: Some(LookTableSpec {
            hue_divisions: 2,
            sat_divisions: 2,
            val_divisions: 2,
            encoding: 1,
            data: [
                [0.0, 1.0, 1.0],
                [1.5, 0.75, 1.0],
                [0.0, 1.0, 1.0],
                [-2.0, 1.25, 1.0],
            ]
            .repeat(2),
        }),
    }
}
