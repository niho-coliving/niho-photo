//! DCP writer / reader round trips and spec validation.

mod common;

use common::full_spec;
use niho_base_raw::dcp::{DcpSpec, HueSatMapSpec};

#[test]
fn write_read_roundtrip_with_hue_sat_map() {
    let spec = full_spec();
    let bytes = spec.to_dcp_bytes().unwrap();
    assert_eq!(
        &bytes[0..4],
        b"IIRC",
        "little-endian TIFF with the DCP magic 0x4352"
    );
    let back = DcpSpec::from_dcp_bytes(&bytes).unwrap();
    assert_eq!(back, spec);
    // Writing again gives the same bytes (stable SHA-256 / baseVersion).
    assert_eq!(back.to_dcp_bytes().unwrap(), bytes);
}

#[test]
fn json_roundtrip_and_summary() {
    let spec = full_spec();
    let text = serde_json::to_string_pretty(&spec).unwrap();
    let back: DcpSpec = serde_json::from_str(&text).unwrap();
    assert_eq!(back, spec);
    // Contract key order, in the full and the summary form.
    let keys = [
        "schema",
        "profileName",
        "uniqueCameraModel",
        "copyright",
        "embedPolicy",
        "calibrationSignature",
        "illuminant1",
        "colorMatrix1",
        "illuminant2",
        "colorMatrix2",
        "forwardMatrix1",
        "forwardMatrix2",
        "hueSatMap",
        "baselineExposureOffset",
        "defaultBlackRender",
        "toneCurve",
        "lookTable",
    ];
    for summary in [false, true] {
        let text = spec.to_json_string(summary).unwrap();
        let positions: Vec<usize> = keys
            .iter()
            .map(|k| {
                text.find(&format!("\n  \"{k}\":"))
                    .unwrap_or_else(|| panic!("{k} missing"))
            })
            .collect();
        assert!(
            positions.windows(2).all(|w| w[0] < w[1]),
            "key order (summary={summary})"
        );
    }
    let summary: serde_json::Value =
        serde_json::from_str(&spec.to_json_string(true).unwrap()).unwrap();
    let hsm = summary["hueSatMap"].as_object().unwrap();
    assert!(!hsm.contains_key("data1") && !hsm.contains_key("data2"));
    assert_eq!(hsm["hueDivisions"], 12);
    assert!(!summary["lookTable"]
        .as_object()
        .unwrap()
        .contains_key("data"));
    // The full form parses back to the same spec.
    let back: DcpSpec = serde_json::from_str(&spec.to_json_string(false).unwrap()).unwrap();
    assert_eq!(back, spec);
}

#[test]
fn minimal_contract_spec_parses() {
    // The example of contract §2.4 verbatim.
    let text = r#"{
      "schema": "niho-base-raw.dcp-spec/1",
      "profileName": "NIHO Panasonic DC-S5 v1",
      "uniqueCameraModel": "Panasonic DC-S5",
      "copyright": "Copyright 2026 NIHO Inc.",
      "embedPolicy": 3,
      "calibrationSignature": "com.niho.develop-engine",
      "illuminant1": 21, "colorMatrix1": [1.0, 0.0, 0.0, 0.0, 1.0, 0.0, 0.0, 0.0, 1.0],
      "illuminant2": null, "colorMatrix2": null,
      "forwardMatrix1": null, "forwardMatrix2": null,
      "hueSatMap": null,
      "baselineExposureOffset": 0.0,
      "defaultBlackRender": 0,
      "toneCurve": null
    }"#;
    let spec: DcpSpec = serde_json::from_str(text).unwrap();
    let bytes = spec.to_dcp_bytes().unwrap();
    let back = DcpSpec::from_dcp_bytes(&bytes).unwrap();
    assert_eq!(back, spec);
}

#[test]
fn validation_rejects_bad_specs() {
    let good = common::minimal_spec();
    assert!(good.validate().is_ok());

    let mut s = good.clone();
    s.schema = "something/2".into();
    assert!(s.to_dcp_bytes().is_err());

    let mut s = good.clone();
    s.color_matrix1.pop();
    assert!(s.to_dcp_bytes().is_err());

    let mut s = good.clone();
    s.illuminant2 = Some(17);
    assert!(
        s.to_dcp_bytes().is_err(),
        "illuminant2 without colorMatrix2"
    );

    let mut s = good.clone();
    s.hue_sat_map = Some(HueSatMapSpec {
        hue_divisions: 12,
        sat_divisions: 6,
        val_divisions: 1,
        encoding: 0,
        data1: vec![[0.0, 1.0, 1.0]; 71],
        data2: None,
    });
    assert!(s.to_dcp_bytes().is_err(), "wrong HueSatMap length");

    let mut s = good;
    s.embed_policy = 7;
    assert!(s.to_dcp_bytes().is_err());
}

#[test]
fn reader_rejects_non_profiles() {
    assert!(DcpSpec::from_dcp_bytes(b"not a tiff at all").is_err());
    // A TIFF container without ColorMatrix1.
    let bytes = niho_base_raw::tiff::write_single_ifd_le(
        niho_base_raw::tiff::MAGIC_DCP,
        &[(0xC614, niho_base_raw::tiff::Value::Ascii("X".into()))],
    )
    .unwrap();
    assert!(DcpSpec::from_dcp_bytes(&bytes).is_err());
}
