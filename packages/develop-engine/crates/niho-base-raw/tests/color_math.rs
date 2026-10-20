//! Color math: matrices, Bradford, CCT, HSV, HueSatMap, DNG camera → XYZ(D50).

mod common;

use niho_base_raw::color::{
    self, bradford, cct_duv, hsv_to_rgb, resolve_profile_color, rgb_to_hsv, xyz_to_xy, HueSatMap,
    D50_XYZ, D65_XYZ, PROPHOTO_TO_XYZ_D50, XYZ_D50_TO_PROPHOTO,
};
use niho_base_raw::dcp::HueSatMapSpec;
use niho_base_raw::matrix::{self, Mat3};

fn close(a: f64, b: f64, tol: f64) -> bool {
    (a - b).abs() <= tol
}

#[test]
fn prophoto_white_roundtrip() {
    // ProPhoto white (1,1,1) → XYZ D50 → ProPhoto (1,1,1).
    let xyz = matrix::mul_vec(&PROPHOTO_TO_XYZ_D50, &[1.0, 1.0, 1.0]);
    for c in 0..3 {
        assert!(close(xyz[c], D50_XYZ[c], 2e-5), "ProPhoto white → {xyz:?}");
    }
    let back = matrix::mul_vec(&XYZ_D50_TO_PROPHOTO, &xyz);
    for v in back {
        assert!(close(v, 1.0, 1e-6), "{back:?}");
    }
    // The two contract matrices are inverses of each other.
    let id = matrix::mul(&XYZ_D50_TO_PROPHOTO, &PROPHOTO_TO_XYZ_D50);
    assert!(matrix::max_abs_diff(&id, &matrix::IDENTITY) < 1e-6);
}

#[test]
fn bradford_d65_to_d50_known_values() {
    // Bruce Lindbloom, "Chromatic Adaptation", Bradford D65 → D50.
    let expected: Mat3 = [
        [1.0478112, 0.0228866, -0.0501270],
        [0.0295424, 0.9904844, -0.0170491],
        [-0.0092345, 0.0150436, 0.7521316],
    ];
    let m = bradford(&D65_XYZ, &D50_XYZ);
    assert!(matrix::max_abs_diff(&m, &expected) < 2e-6, "{m:?}");
    let w = matrix::mul_vec(&m, &D65_XYZ);
    for c in 0..3 {
        assert!(close(w[c], D50_XYZ[c], 1e-9));
    }
}

#[test]
fn cct_of_d65_white() {
    let (t, duv) = cct_duv(&xyz_to_xy(&D65_XYZ));
    assert!(close(t, 6504.0, 5.0), "D65 → {t} K");
    assert!(close(duv, 0.0032, 3e-4), "D65 Duv {duv}");
    assert_eq!(color::CCT_METHOD, "robertson1968");
}

#[test]
fn hsv_roundtrip() {
    let samples = [
        [0.0, 0.0, 0.0],
        [0.5, 0.5, 0.5],
        [1.0, 0.0, 0.0],
        [0.2, 0.9, 0.1],
        [0.05, 0.1, 1.7],
        [1.3, 0.2, 0.7],
        [0.3, 0.3, 0.9],
        [0.9, 0.9, 0.1],
    ];
    for rgb in samples {
        let (h, s, v) = rgb_to_hsv(rgb[0], rgb[1], rgb[2]);
        assert!((0.0..6.0).contains(&h) && (0.0..=1.0).contains(&s));
        let back = hsv_to_rgb(h, s, v);
        for c in 0..3 {
            assert!((back[c] - rgb[c]).abs() < 1e-6, "{rgb:?} → {back:?}");
        }
    }
}

#[test]
fn identity_hue_sat_map_is_identity() {
    for (h, s, v) in [(12, 6, 1), (36, 8, 16), (1, 2, 1)] {
        let t = HueSatMap::identity(h, s, v);
        for rgb in [
            [0.2_f32, 0.4, 0.9],
            [1.2, 0.1, 0.05],
            [0.33, 0.33, 0.33],
            [0.0, 0.0, 0.0],
            [0.7, 0.69, 0.1],
        ] {
            let out = t.apply(rgb);
            for c in 0..3 {
                assert!(
                    (out[c] - rgb[c]).abs() < 1e-6,
                    "{h}x{s}x{v} {rgb:?} → {out:?}"
                );
            }
        }
    }
}

#[test]
fn hue_sat_map_shifts_and_scales() {
    // Uniform +120° hue shift and ×0.5 saturation: pure red → half-saturated green.
    let t = HueSatMap::new(6, 2, 1, 0, vec![[120.0, 0.5, 1.0]; 12]).unwrap();
    let out = t.apply([1.0, 0.0, 0.0]);
    let (h, s, v) = rgb_to_hsv(out[0], out[1], out[2]);
    assert!(
        (h - 2.0).abs() < 1e-5 && (s - 0.5).abs() < 1e-6 && (v - 1.0).abs() < 1e-6,
        "{out:?}"
    );
    // Grays are untouched (s = 0) whatever the table says; valScale still applies.
    let t = HueSatMap::new(6, 2, 1, 0, vec![[45.0, 3.0, 2.0]; 12]).unwrap();
    assert_eq!(t.apply([0.25, 0.25, 0.25]), [0.5, 0.5, 0.5]);
    // Saturation is clipped at 1.
    let t = HueSatMap::new(6, 2, 1, 0, vec![[0.0, 10.0, 1.0]; 12]).unwrap();
    let (_, s, _) = {
        let o = t.apply([0.5, 0.4, 0.4]);
        rgb_to_hsv(o[0], o[1], o[2])
    };
    assert!((s - 1.0).abs() < 1e-6);
}

#[test]
fn hue_sat_map_interpolates_in_saturation_and_wraps_in_hue() {
    // hue 12 × sat 2: hueShift = 0 at s = 0 and 30° at s = 1 (all hues).
    let mut data = Vec::new();
    for _h in 0..12 {
        data.push([0.0, 1.0, 1.0]);
        data.push([30.0, 1.0, 1.0]);
    }
    let t = HueSatMap::new(12, 2, 1, 0, data).unwrap();
    let e = t.lookup(5.99, 0.5, 1.0);
    assert!((e[0] - 15.0).abs() < 1e-5, "{e:?}");
    // Hue wrap: entry 11 (330°) blends with entry 0 (0°) near h = 6.
    let mut data = vec![[0.0, 1.0, 1.0]; 24];
    data[0] = [0.0, 1.0, 1.0];
    data[1] = [10.0, 1.0, 1.0]; // hue 0, sat 1
    data[22] = [0.0, 1.0, 1.0];
    data[23] = [20.0, 1.0, 1.0]; // hue 11, sat 1
    let t = HueSatMap::new(12, 2, 1, 0, data).unwrap();
    let e = t.lookup(5.75, 1.0, 1.0); // 345°: halfway between 330° and 360° = 0°
    assert!((e[0] - 15.0).abs() < 1e-4, "{e:?}");
}

#[test]
fn forward_matrix_maps_neutral_to_d50() {
    let mut spec = common::minimal_spec();
    // FM equivalent of the D65 ColorMatrix: Bradford(D65→D50) · inv(CM) · diag(CM · XYZ_D65).
    let cm = matrix::from_row_major(&spec.color_matrix1).unwrap();
    let n65 = matrix::mul_vec(&cm, &D65_XYZ);
    let fm = matrix::mul(
        &bradford(&D65_XYZ, &D50_XYZ),
        &matrix::mul(&matrix::inverse(&cm).unwrap(), &matrix::diag(&n65)),
    );
    spec.forward_matrix1 = Some(matrix::to_row_major(&fm).to_vec());
    let neutral = [0.649746, 1.0, 0.417618];
    let pc = resolve_profile_color(&spec, &neutral).unwrap();
    assert!(pc.uses_forward_matrix);
    let white = matrix::mul_vec(&pc.camera_to_xyz_d50, &[1.0, 1.0, 1.0]);
    for c in 0..3 {
        assert!(close(white[c], D50_XYZ[c], 1e-9), "{white:?}");
    }
    let pp = matrix::mul_vec(&pc.camera_to_prophoto, &[1.0, 1.0, 1.0]);
    for v in pp {
        assert!(close(v, 1.0, 2e-5), "{pp:?}");
    }
}

#[test]
fn color_matrix_only_maps_neutral_to_d50_with_unit_luminance() {
    let spec = common::minimal_spec();
    for neutral in [
        [0.649746, 1.0, 0.417618],
        [0.42, 1.0, 0.68],
        [0.9, 1.0, 0.3],
    ] {
        let pc = resolve_profile_color(&spec, &neutral).unwrap();
        assert!(!pc.uses_forward_matrix);
        let white = matrix::mul_vec(&pc.camera_to_xyz_d50, &[1.0, 1.0, 1.0]);
        for c in 0..3 {
            assert!(close(white[c], D50_XYZ[c], 1e-9), "{neutral:?} → {white:?}");
        }
    }
    // The D65 neutral of the D65 matrix is found at ~6504 K.
    let cm = matrix::from_row_major(&spec.color_matrix1).unwrap();
    let n = matrix::mul_vec(&cm, &D65_XYZ);
    let m = n[0].max(n[1]).max(n[2]);
    let pc = resolve_profile_color(&spec, &[n[0] / m, n[1] / m, n[2] / m]).unwrap();
    assert!(close(pc.cct, 6504.0, 5.0), "{}", pc.cct);
}

#[test]
fn two_illuminants_interpolate_by_white() {
    // Set 1 = Standard A with a distinct matrix, set 2 = D65 with an independent synthetic matrix.
    let mut spec = common::minimal_spec();
    let cm65 = spec.color_matrix1.clone();
    let cm_a = vec![0.9, 0.1, 0.0, 0.0, 0.9, 0.1, 0.1, 0.0, 0.9];
    spec.illuminant1 = 17;
    spec.color_matrix1 = cm_a.clone();
    spec.illuminant2 = Some(21);
    spec.color_matrix2 = Some(cm65.clone());
    // Neutral of D65 under the D65 matrix → weight toward set 2 ≈ 1.
    let cm = matrix::from_row_major(&cm65).unwrap();
    let n = matrix::mul_vec(&cm, &D65_XYZ);
    let pc = resolve_profile_color(&spec, &[n[0] / n[1], 1.0, n[2] / n[1]]).unwrap();
    assert!(pc.weight1 < 0.01, "weight1 {}", pc.weight1);
    assert!(close(pc.cct, 6504.0, 10.0), "{}", pc.cct);
    // Neutral of Standard A under the A matrix → weight toward set 1 ≈ 1.
    let a_xyz = color::xy_to_xyz(&[0.44757, 0.40745]);
    let cma = matrix::from_row_major(&cm_a).unwrap();
    let n = matrix::mul_vec(&cma, &a_xyz);
    let pc = resolve_profile_color(&spec, &[n[0] / n[1], 1.0, n[2] / n[1]]).unwrap();
    assert!(pc.weight1 > 0.95, "weight1 {}", pc.weight1);
    // HueSatMap tables are blended with the same weight.
    spec.hue_sat_map = Some(HueSatMapSpec {
        hue_divisions: 2,
        sat_divisions: 2,
        val_divisions: 1,
        encoding: 0,
        data1: vec![[10.0, 1.0, 1.0]; 4],
        data2: Some(vec![[0.0, 1.0, 1.0]; 4]),
    });
    let pc = resolve_profile_color(&spec, &[n[0] / n[1], 1.0, n[2] / n[1]]).unwrap();
    let t = pc.hue_sat_map.unwrap();
    assert!((t.data[0][0] as f64 - 10.0 * pc.weight1).abs() < 1e-4);
}

#[test]
fn base_version_format() {
    let sha = "12ac8236ed7a937f13ba774127ee7af246b976a7722af433d085ee66aee81392";
    let v = niho_base_raw::base_version(sha);
    assert_eq!(v, format!("b1.p1.e1.dcp-{sha}"));
    assert!(niho_base_raw::is_valid_base_version(&v));
    assert!(!niho_base_raw::is_valid_base_version("b1.p1.e1.dcp-12AC"));
    assert!(!niho_base_raw::is_valid_base_version("dump"));
    assert!(!niho_base_raw::is_valid_base_version(&format!(
        "b2.p1.e1.dcp-{sha}"
    )));
}
