//! `packages/develop-engine/fixtures/convert/edit-settings-cases.json`:
//! Photo Bench `EditSettings` -> `developSettings` v1.

use niho_develop::convert::convert_edit_settings;
use serde_json::Value;

#[test]
fn edit_settings_conversion_cases() {
    let path = format!(
        "{}/../../fixtures/convert/edit-settings-cases.json",
        env!("CARGO_MANIFEST_DIR")
    );
    let fixture: Value = serde_json::from_str(&std::fs::read_to_string(path).unwrap()).unwrap();
    for case in fixture["cases"].as_array().unwrap() {
        let name = case["name"].as_str().unwrap();
        let input = &case["input"];
        let snapshot = input.clone();
        let outcome = convert_edit_settings(input, Some("base-test"));
        assert_eq!(input, &snapshot, "{name}: input must not change");
        let expect = &case["expect"];
        assert_eq!(
            outcome.ok,
            expect["ok"].as_bool().unwrap(),
            "{name}: ok ({:?})",
            outcome.issues
        );
        let settings = outcome.settings.to_value();
        assert_eq!(settings["base"], "base-test", "{name}");
        assert_eq!(settings["v"], 1);
        if let Some(engine) = expect["engine"].as_str() {
            assert_eq!(settings["engine"], engine, "{name}: engine");
        }
        let mut legacy: Vec<String> = settings["legacySettings"]
            .as_object()
            .map(|o| o.keys().cloned().collect())
            .unwrap_or_default();
        legacy.sort();
        let want_legacy: Vec<String> = expect["legacyKeys"]
            .as_array()
            .map(|a| a.iter().map(|v| v.as_str().unwrap().to_string()).collect())
            .unwrap_or_default();
        assert_eq!(legacy, want_legacy, "{name}: legacy keys");
        for key in legacy {
            assert_eq!(
                settings["legacySettings"][&key], input[&key],
                "{name}: legacy value kept verbatim"
            );
        }
        if let Some(codes) = expect["issueCodes"].as_array() {
            let mut got: Vec<String> = outcome.issues.iter().map(|i| i.code.clone()).collect();
            got.sort();
            let mut want: Vec<String> = codes
                .iter()
                .map(|v| v.as_str().unwrap().to_string())
                .collect();
            want.sort();
            assert_eq!(got, want, "{name}: issue codes");
        }
        if let Some(codes) = expect["noteCodes"].as_array() {
            let got: Vec<String> = outcome.notes.iter().map(|i| i.code.clone()).collect();
            let want: Vec<String> = codes
                .iter()
                .map(|v| v.as_str().unwrap().to_string())
                .collect();
            assert_eq!(got, want, "{name}: note codes");
        }
        if let Some(wb) = expect["whiteBalance"].as_object() {
            for (k, v) in wb {
                assert_eq!(
                    settings["whiteBalance"][k].as_f64().or(None),
                    v.as_f64(),
                    "{name}: whiteBalance.{k}"
                );
                if v.is_string() {
                    assert_eq!(&settings["whiteBalance"][k], v, "{name}: whiteBalance.{k}");
                }
            }
        }
        for key in [
            "exposure",
            "contrast",
            "shadows",
            "highlights",
            "texture",
            "clarity",
            "dehaze",
            "relativeTemperature",
            "relativeTint",
        ] {
            if let Some(v) = expect[key].as_f64() {
                assert_eq!(settings[key].as_f64(), Some(v), "{name}: {key}");
            }
        }
        if let Some(channels) = expect["toneCurveChannels"].as_array() {
            let got: Vec<&str> = settings["toneCurves"]
                .as_array()
                .unwrap()
                .iter()
                .map(|c| c["channel"].as_str().unwrap())
                .collect();
            let want: Vec<&str> = channels.iter().map(|v| v.as_str().unwrap()).collect();
            assert_eq!(got, want, "{name}: curves");
        }
        if let Some(bands) = expect["hslBands"].as_array() {
            let got: Vec<&str> = settings["hsl"]
                .as_array()
                .unwrap()
                .iter()
                .step_by(2)
                .map(|b| b.as_str().unwrap())
                .collect();
            let want: Vec<&str> = bands.iter().map(|v| v.as_str().unwrap()).collect();
            assert_eq!(got, want, "{name}: hsl bands in canonical order");
        }
        if let Some(b) = expect["colorGradingBlending"].as_f64() {
            assert_eq!(
                settings["colorGrading"]["blending"].as_f64(),
                Some(b),
                "{name}"
            );
        }
        if outcome.ok {
            assert!(
                outcome.settings.validate().is_empty(),
                "{name}: {:?}",
                outcome.settings.validate()
            );
        }
    }
}
