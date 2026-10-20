//! Mandatory owner-shot RW2 acceptance. No environment switch or silent skip.
use std::path::PathBuf;

use niho_base_raw::{decode, encode, pipeline};
use niho_camera_profile::dcp;
use serde_json::Value;

fn root() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../..")
}

#[test]
fn public_rw2_preserves_sensor_interpretation_and_original_camera_pixels() {
    let directory = root().join("fixtures/public-raw");
    let raw = directory.join("dc-s5-owner.rw2");
    let audit: Value =
        serde_json::from_slice(&std::fs::read(directory.join("dc-s5-owner.audit.json")).unwrap())
            .unwrap();
    let bytes = std::fs::read(&raw).unwrap();
    assert_eq!(
        dcp::sha256_hex(&bytes),
        audit["outputSha256"].as_str().unwrap()
    );
    let actual = serde_json::to_value(pipeline::camera_info(&raw).unwrap()).unwrap();
    for key in [
        "make",
        "model",
        "cleanMake",
        "cleanModel",
        "fullWidth",
        "fullHeight",
        "crop",
        "cfa",
        "bitsPerSample",
        "blackLevel",
        "whiteLevel",
        "wbCoeffs",
        "asShotMultipliers",
        "asShotNeutral",
        "orientation",
        "orientationExif",
    ] {
        assert_eq!(
            actual[key], audit["cameraInfo"][key],
            "decoder interpretation changed: {key}"
        );
    }
    let decoded = decode::decode_file(&raw).unwrap();
    assert_eq!(decoded.clean_model, "DC-S5");
    match decoded.data {
        decode::RawData::U16(values) => {
            assert_eq!(values.len(), decoded.full_width * decoded.full_height)
        }
        decode::RawData::F32(_) => panic!("RW2 unexpectedly decoded to float"),
    }
    let output = pipeline::develop(&raw, pipeline::Mode::DumpCamera, 512).unwrap();
    let golden = std::fs::read(directory.join("dc-s5-camera512.png")).unwrap();
    assert_eq!(
        dcp::sha256_hex(&golden),
        audit["cameraPng512Sha256"].as_str().unwrap()
    );
    let (codes, width, height) = encode::read_png16(&golden).unwrap();
    assert_eq!((output.width, output.height), (width, height));
    assert_eq!(output.rgb.len(), codes.len());
    for (actual, expected) in output.rgb.iter().zip(codes) {
        assert!(
            encode::encode_value(*actual).abs_diff(expected) <= 1,
            "public RW2 camera golden changed"
        );
    }
}

#[test]
fn public_rw2_renders_with_the_independently_measured_profile() {
    let raw = root().join("fixtures/public-raw/dc-s5-owner.rw2");
    let profile = dcp::load_dcp(
        &root().join("crates/niho-base-raw/profiles/panasonic-dc-s5/niho-dc-s5-independent-v1.dcp"),
    )
    .unwrap();
    let output = pipeline::develop(&raw, pipeline::Mode::Render(&profile), 256).unwrap();
    assert_eq!(output.width.max(output.height), 256);
    // Lanczos may overshoot below zero at edges. The PNG encoder bounds the output.
    assert!(output.rgb.iter().all(|v| v.is_finite()));
    let encoded = encode::png16_bytes(&output.rgb, output.width, output.height).unwrap();
    let (codes, width, height) = encode::read_png16(&encoded).unwrap();
    assert_eq!((width, height), (output.width, output.height));
    assert_eq!(codes.len(), output.width * output.height * 3);
    assert!(output.rgb.iter().any(|v| *v > 0.1));
    assert_eq!(output.sidecar.dcp.unwrap().sha256, profile.sha256);
}
