//! What the DCP writer produces reads back with the same values in exiftool (`exiftool -j -n -b`).
//! Skipped when exiftool is not installed (e.g. on the CI runner).

mod common;

use std::process::Command;

use common::full_spec;

fn exiftool_available() -> bool {
    Command::new("exiftool")
        .arg("-ver")
        .output()
        .map(|o| o.status.success())
        .unwrap_or(false)
}

fn numbers(v: &serde_json::Value) -> Vec<f64> {
    match v {
        serde_json::Value::Number(n) => vec![n.as_f64().unwrap()],
        serde_json::Value::String(s) => s
            .split_whitespace()
            .map(|x| x.parse::<f64>().unwrap())
            .collect(),
        other => panic!("unexpected exiftool value {other}"),
    }
}

fn assert_close(tag: &str, got: &[f64], want: &[f64], tol: f64) {
    assert_eq!(
        got.len(),
        want.len(),
        "{tag}: {} values, expected {}",
        got.len(),
        want.len()
    );
    for (i, (g, w)) in got.iter().zip(want).enumerate() {
        assert!(
            (g - w).abs() <= tol,
            "{tag}[{i}]: exiftool {g}, written {w}"
        );
    }
}

#[test]
fn exiftool_reads_the_written_values() {
    if !exiftool_available() {
        eprintln!("skip: exiftool not found");
        return;
    }
    let spec = full_spec();
    let dir = std::env::temp_dir().join(format!("niho-base-raw-exiftool-{}", std::process::id()));
    std::fs::create_dir_all(&dir).unwrap();
    let path = dir.join("full.dcp");
    std::fs::write(&path, spec.to_dcp_bytes().unwrap()).unwrap();
    // exiftool leaves out large binary tags unless they are named, even with -b.
    let out = Command::new("exiftool")
        .args([
            "-j",
            "-n",
            "-b",
            "-all",
            "-ProfileHueSatMapData1",
            "-ProfileHueSatMapData2",
            "-ProfileLookTableData",
        ])
        .arg(&path)
        .output()
        .unwrap();
    std::fs::remove_dir_all(&dir).ok();
    assert!(
        out.status.success(),
        "exiftool failed: {}",
        String::from_utf8_lossy(&out.stderr)
    );
    let json: serde_json::Value = serde_json::from_slice(&out.stdout).unwrap();
    let t = &json[0];

    assert_eq!(t["FileType"], "DCP");
    assert_eq!(t["UniqueCameraModel"], spec.unique_camera_model.as_str());
    assert_eq!(t["ProfileName"], spec.profile_name.as_str());
    assert_eq!(t["ProfileCopyright"], spec.copyright.as_str());
    assert_eq!(
        t["ProfileCalibrationSig"],
        spec.calibration_signature.as_str()
    );
    assert_eq!(t["ProfileEmbedPolicy"], spec.embed_policy);
    assert_eq!(t["CalibrationIlluminant1"], spec.illuminant1);
    assert_eq!(t["CalibrationIlluminant2"], spec.illuminant2.unwrap());
    assert_eq!(t["DefaultBlackRender"], spec.default_black_render);
    assert_close(
        "ColorMatrix1",
        &numbers(&t["ColorMatrix1"]),
        &spec.color_matrix1,
        1e-9,
    );
    assert_close(
        "ColorMatrix2",
        &numbers(&t["ColorMatrix2"]),
        spec.color_matrix2.as_ref().unwrap(),
        1e-9,
    );
    assert_close(
        "ForwardMatrix1",
        &numbers(&t["ForwardMatrix1"]),
        spec.forward_matrix1.as_ref().unwrap(),
        1e-9,
    );
    assert_close(
        "ForwardMatrix2",
        &numbers(&t["ForwardMatrix2"]),
        spec.forward_matrix2.as_ref().unwrap(),
        1e-9,
    );
    assert_close(
        "BaselineExposureOffset",
        &numbers(&t["BaselineExposureOffset"]),
        &[spec.baseline_exposure_offset],
        1e-9,
    );

    let hsm = spec.hue_sat_map.as_ref().unwrap();
    assert_close(
        "ProfileHueSatMapDims",
        &numbers(&t["ProfileHueSatMapDims"]),
        &[
            hsm.hue_divisions as f64,
            hsm.sat_divisions as f64,
            hsm.val_divisions as f64,
        ],
        0.0,
    );
    assert_eq!(t["ProfileHueSatMapEncoding"], hsm.encoding);
    let flat = |d: &[[f64; 3]]| d.iter().flatten().copied().collect::<Vec<f64>>();
    assert_close(
        "ProfileHueSatMapData1",
        &numbers(&t["ProfileHueSatMapData1"]),
        &flat(&hsm.data1),
        1e-6,
    );
    assert_close(
        "ProfileHueSatMapData2",
        &numbers(&t["ProfileHueSatMapData2"]),
        &flat(hsm.data2.as_ref().unwrap()),
        1e-6,
    );

    let tc: Vec<f64> = spec
        .tone_curve
        .as_ref()
        .unwrap()
        .iter()
        .flatten()
        .copied()
        .collect();
    assert_close(
        "ProfileToneCurve",
        &numbers(&t["ProfileToneCurve"]),
        &tc,
        1e-6,
    );

    let lut = spec.look_table.as_ref().unwrap();
    assert_close(
        "ProfileLookTableDims",
        &numbers(&t["ProfileLookTableDims"]),
        &[
            lut.hue_divisions as f64,
            lut.sat_divisions as f64,
            lut.val_divisions as f64,
        ],
        0.0,
    );
    assert_eq!(t["ProfileLookTableEncoding"], lut.encoding);
    assert_close(
        "ProfileLookTableData",
        &numbers(&t["ProfileLookTableData"]),
        &flat(&lut.data),
        1e-6,
    );
}
