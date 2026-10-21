//! Local adjustments (`masks`): the saved shape, its strict validation and the
//! compatibility rules of `docs/local-adjustments.md` (Epic #31, M1 = #65).
//! The shared fixture `fixtures/masks/settings-cases.json` is also read by
//! `develop-masks.test.ts`, so Rust and TypeScript accept, reject and write
//! the same masks. This file is also run by the wasm-bindgen test command.
//!
//! Every render path draws the active masks (M2, #66; the layered render
//! itself is `masks_render.rs`).

use niho_develop::local_mask::{MaskKind, MaskShape};
use niho_develop::settings::{
    DevelopSettings, HslAdjustment, HslBand, MASKS_SETTINGS_VERSION, MAX_LOCAL_MASKS,
    MAX_SETTINGS_VERSION,
};
use niho_develop::xmp::{apply_preset, settings_to_xmp, XmpWriteOptions};
use niho_develop::{
    before_settings, encode, export_jpeg, export_png, parse_settings, render, Error, Filter,
    Quality, RenderOptions, Session,
};
use serde_json::{json, Value};

const CASES: &str = include_str!("fixtures/masks/settings-cases.json");

fn cases() -> Value {
    serde_json::from_str(CASES).expect("fixture is JSON")
}

/// The first problem `from_value` / `validate` find, like `parse_settings`.
fn first_code(settings: &Value) -> Option<String> {
    match DevelopSettings::from_value(settings) {
        Err(e) => Some(e.code),
        Ok(s) => s.validate().into_iter().next().map(|e| e.code),
    }
}

fn linear(id: &str) -> Value {
    json!({
        "id": id,
        "kind": "linear",
        "zero": {"x": 0.5, "y": 0.2},
        "full": {"x": 0.5, "y": 0.5},
        "adjust": {"exposure": -0.7}
    })
}

fn with_masks(v: u32, masks: Value) -> DevelopSettings {
    DevelopSettings::from_value(&json!({
        "v": v,
        "engine": "niho-10",
        "look": "niho-standard-1",
        "base": null,
        "masks": masks
    }))
    .unwrap()
}

fn options() -> RenderOptions {
    RenderOptions {
        max_dimension: 32,
        quality: Quality::Final,
        filter: Filter::Lanczos3,
        decode_cap: 0,
    }
}

fn photo_png() -> Vec<u8> {
    let (width, height) = (24usize, 16usize);
    let mut rgba = vec![255u8; width * height * 4];
    for (index, pixel) in rgba.chunks_exact_mut(4).enumerate() {
        let (x, y) = (index % width, index / width);
        pixel[..3].copy_from_slice(&[(x * 10) as u8, (y * 15) as u8, ((x + y) * 5) as u8]);
    }
    encode::encode_png(&rgba, width, height).unwrap()
}

#[cfg_attr(target_arch = "wasm32", wasm_bindgen_test::wasm_bindgen_test)]
#[cfg_attr(not(target_arch = "wasm32"), test)]
fn shared_valid_cases_read_and_write_the_canonical_masks() {
    let doc = cases();
    let valid = doc["valid"].as_array().unwrap();
    assert!(valid.len() >= 15, "the fixture covers the shapes");
    for case in valid {
        let name = case["name"].as_str().unwrap();
        let settings = DevelopSettings::from_value(&case["settings"])
            .unwrap_or_else(|e| panic!("{name}: from_value failed: {e}"));
        assert_eq!(settings.validate(), vec![], "{name}: valid");
        let canonical = &case["canonical"];
        let written = settings.to_value();
        if canonical.as_array().unwrap().is_empty() {
            assert!(
                written.get("masks").is_none(),
                "{name}: empty masks are not written"
            );
            assert_ne!(
                settings.required_version(),
                MASKS_SETTINGS_VERSION,
                "{name}"
            );
            continue;
        }
        assert_eq!(&written["masks"], canonical, "{name}: canonical masks");
        assert_eq!(
            settings.required_version(),
            MASKS_SETTINGS_VERSION,
            "{name}"
        );
        // The canonical form reads back to the same settings, and `masks`
        // never lands in the opaque `extra` capture.
        assert!(!settings.extra.contains_key("masks"), "{name}");
        let again = DevelopSettings::from_value(&written).unwrap();
        assert_eq!(again, settings, "{name}: round trip");
        assert_eq!(again.to_value(), written, "{name}: canonical is stable");
    }
}

#[cfg_attr(target_arch = "wasm32", wasm_bindgen_test::wasm_bindgen_test)]
#[cfg_attr(not(target_arch = "wasm32"), test)]
fn shared_invalid_cases_are_rejected_with_their_code() {
    let doc = cases();
    let invalid = doc["invalid"].as_array().unwrap();
    assert!(invalid.len() >= 100, "the fixture covers every field");
    for case in invalid {
        let name = case["name"].as_str().unwrap();
        let want = case["code"].as_str().unwrap();
        assert_eq!(
            first_code(&case["settings"]).as_deref(),
            Some(want),
            "{name}"
        );
        // `parse_settings` (the render and wasm entry) refuses all of them.
        assert!(
            parse_settings(&case["settings"].to_string()).is_err(),
            "{name}"
        );
    }
}

#[cfg_attr(target_arch = "wasm32", wasm_bindgen_test::wasm_bindgen_test)]
#[cfg_attr(not(target_arch = "wasm32"), test)]
fn the_five_kinds_have_their_shape_and_masks_stay_out_of_extra() {
    let hash = "0".repeat(64);
    let settings = with_masks(
        5,
        json!([
            linear("a"),
            {
                "id": "b", "kind": "radial", "center": {"x": 0.5, "y": 0.5},
                "radius": {"x": 0.3, "y": 0.2}, "angle": 15, "feather": 50,
                "adjust": {"saturation": 10}
            },
            {"id": "c", "kind": "brush", "surface": {"id": hash, "width": 8, "height": 4}, "adjust": {}},
            {"id": "d", "kind": "subject", "surface": {"id": hash, "width": 8, "height": 4}, "adjust": {}},
            {"id": "e", "kind": "sky", "surface": {"id": hash, "width": 8, "height": 4}, "adjust": {}}
        ]),
    );
    let kinds: Vec<MaskKind> = settings.masks.iter().map(|m| m.kind).collect();
    assert_eq!(kinds, MaskKind::ALL.to_vec());
    assert!(matches!(settings.masks[0].shape, MaskShape::Linear { .. }));
    assert!(matches!(settings.masks[1].shape, MaskShape::Radial { .. }));
    for mask in &settings.masks[2..] {
        assert!(matches!(mask.shape, MaskShape::Surface(_)));
    }
    assert!(settings.extra.is_empty());
    assert_eq!(MAX_LOCAL_MASKS, 8);
}

#[cfg_attr(target_arch = "wasm32", wasm_bindgen_test::wasm_bindgen_test)]
#[cfg_attr(not(target_arch = "wasm32"), test)]
fn version_five_is_read_and_six_is_not() {
    assert_eq!(MASKS_SETTINGS_VERSION, 5);
    assert_eq!(MAX_SETTINGS_VERSION, 5);
    assert_eq!(
        DevelopSettings::from_json(r#"{"v":5}"#).unwrap().v,
        5,
        "v 5 without masks is readable"
    );
    let error = DevelopSettings::from_json(r#"{"v":6}"#).unwrap_err();
    assert_eq!(error.code, "unsupportedVersion");
    assert!(error.message.contains("v = 5"), "{}", error.message);
}

#[cfg_attr(target_arch = "wasm32", wasm_bindgen_test::wasm_bindgen_test)]
#[cfg_attr(not(target_arch = "wasm32"), test)]
fn masks_need_version_five_before_any_other_feature() {
    let mut settings = with_masks(5, json!([linear("a")]));
    assert_eq!(settings.required_version(), 5);
    // Masks win over color points, effects and geometry.
    settings.grayscale = true;
    assert_eq!(settings.required_version(), 5);
    settings.v = 4;
    let issues = settings.validate();
    assert_eq!(issues.len(), 1, "{issues:?}");
    assert_eq!(issues[0].code, "versionTooLow");
    assert!(issues[0].message.contains("v = 5"));
    settings.masks.clear();
    assert_eq!(settings.required_version(), 3);
    assert!(settings.validate().is_empty());
}

#[cfg_attr(target_arch = "wasm32", wasm_bindgen_test::wasm_bindgen_test)]
#[cfg_attr(not(target_arch = "wasm32"), test)]
fn only_enabled_masks_with_an_adjustment_are_active() {
    let mut settings = with_masks(5, json!([linear("a")]));
    assert!(settings.has_active_masks());
    assert!(!settings.is_neutral());

    settings.masks[0].enabled = false;
    assert!(!settings.has_active_masks());
    assert!(settings.is_neutral(), "a disabled mask draws nothing");
    assert_eq!(settings.required_version(), 5, "but it still needs v 5");

    settings.masks[0].enabled = true;
    settings.masks[0].adjust = Default::default();
    assert!(
        !settings.has_active_masks(),
        "an empty adjust draws nothing"
    );

    settings.masks[0].adjust.hsl.set(
        HslBand::Red,
        HslAdjustment {
            hue: 0.0,
            saturation: 0.0,
            luminance: 0.0,
        },
    );
    assert!(
        !settings.has_active_masks(),
        "a zero hsl delta is no change"
    );
    settings.masks[0].adjust.hsl.set(
        HslBand::Red,
        HslAdjustment {
            hue: 5.0,
            saturation: 0.0,
            luminance: 0.0,
        },
    );
    assert!(settings.has_active_masks());
}

#[cfg_attr(target_arch = "wasm32", wasm_bindgen_test::wasm_bindgen_test)]
#[cfg_attr(not(target_arch = "wasm32"), test)]
fn validate_checks_masks_built_without_parsing() {
    let mut settings = with_masks(5, json!([linear("a"), linear("b")]));
    assert!(settings.validate().is_empty());
    settings.masks[1].id = "a".into();
    settings.masks[0].adjust.exposure = 9.0;
    settings.masks[0].kind = MaskKind::Radial;
    let codes: Vec<String> = settings.validate().into_iter().map(|e| e.code).collect();
    assert!(codes.contains(&"duplicateMaskId".to_string()), "{codes:?}");
    assert!(codes.contains(&"maskOutOfRange".to_string()), "{codes:?}");
    assert!(codes.contains(&"invalidMask".to_string()), "{codes:?}");

    let mut many = with_masks(5, json!([linear("a")]));
    for index in 0..MAX_LOCAL_MASKS {
        let mut mask = many.masks[0].clone();
        mask.id = format!("m{index}");
        many.masks.push(mask);
    }
    assert!(many.validate().iter().any(|e| e.code == "tooManyMasks"));
}

#[cfg_attr(target_arch = "wasm32", wasm_bindgen_test::wasm_bindgen_test)]
#[cfg_attr(not(target_arch = "wasm32"), test)]
fn a_relative_white_balance_delta_needs_a_mode_other_than_absolute() {
    let mut mask = linear("wb");
    mask["adjust"] = json!({"relativeTemperature": 12});
    let absolute = json!({
        "v": 5, "engine": "niho-10", "look": "niho-standard-1", "base": null,
        "whiteBalance": {"mode": "absolute", "temperature": 5600, "tint": 0},
        "masks": [mask.clone()]
    });
    let error = DevelopSettings::from_value(&absolute).unwrap_err();
    assert_eq!(error.code, "localWhiteBalance");
    assert_eq!(error.path, "masks[0].adjust.relativeTemperature");
    // The key order of the JSON does not matter: `masks` before `whiteBalance`.
    let text = r#"{"masks":[{"id":"a","kind":"linear","zero":{"x":0.5,"y":0.2},"full":{"x":0.5,"y":0.5},"adjust":{"relativeTint":3}}],"whiteBalance":{"mode":"absolute","temperature":5600,"tint":0},"v":5}"#;
    assert_eq!(
        DevelopSettings::from_json(text).unwrap_err().code,
        "localWhiteBalance"
    );
    let mut relative = absolute.clone();
    relative["whiteBalance"] = json!({"mode": "relative"});
    assert!(DevelopSettings::from_value(&relative).is_ok());
}

#[cfg_attr(target_arch = "wasm32", wasm_bindgen_test::wasm_bindgen_test)]
#[cfg_attr(not(target_arch = "wasm32"), test)]
fn unknown_top_level_keys_are_still_kept_verbatim() {
    let settings =
        DevelopSettings::from_json(r#"{"v":5,"engine":"niho-1","futureKey":{"a":1},"masks":[]}"#)
            .unwrap();
    assert_eq!(settings.extra["futureKey"]["a"], 1);
    assert!(!settings.extra.contains_key("masks"));
    assert_eq!(settings.to_value()["futureKey"]["a"], 1);
}

#[cfg_attr(target_arch = "wasm32", wasm_bindgen_test::wasm_bindgen_test)]
#[cfg_attr(not(target_arch = "wasm32"), test)]
fn before_settings_drop_the_masks_and_stay_valid() {
    let mut settings = with_masks(5, json!([linear("a")]));
    settings.exposure = 0.4;
    let before = before_settings(&settings.to_json()).unwrap();
    let parsed = parse_settings(&before).unwrap();
    assert!(parsed.masks.is_empty());
    assert!(parsed.is_neutral());
    assert_eq!(parsed.engine, settings.engine);
    assert_eq!(parsed.look, settings.look);
    assert!(parsed.to_value().get("masks").is_none());
}

#[cfg_attr(target_arch = "wasm32", wasm_bindgen_test::wasm_bindgen_test)]
#[cfg_attr(not(target_arch = "wasm32"), test)]
fn presets_and_amounts_keep_the_photos_masks() {
    let preset = r#"<x:xmpmeta xmlns:x="adobe:ns:meta/"><rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#"><rdf:Description xmlns:crs="http://ns.adobe.com/camera-raw-settings/1.0/" crs:Exposure2012="+1"/></rdf:RDF></x:xmpmeta>"#;
    let base = with_masks(5, json!([linear("a")]));
    for amount in [0.0, 0.5, 1.0, 1.5] {
        let applied = apply_preset(preset, &base, amount, None).unwrap();
        assert_eq!(applied.settings.masks, base.masks, "amount {amount}");
        assert_eq!(applied.settings.v, 5, "amount {amount}");
        assert!(applied.settings.validate().is_empty());
        if amount == 0.0 {
            assert_eq!(applied.settings, base);
        }
    }
    let written = settings_to_xmp(&base, &XmpWriteOptions::default());
    assert!(written.not_written.iter().any(|field| field == "masks"));
    assert!(!written.xmp.to_ascii_lowercase().contains("mask"));
    let none = settings_to_xmp(&DevelopSettings::neutral(), &XmpWriteOptions::default());
    assert!(!none.not_written.iter().any(|field| field == "masks"));
}

#[cfg_attr(target_arch = "wasm32", wasm_bindgen_test::wasm_bindgen_test)]
#[cfg_attr(not(target_arch = "wasm32"), test)]
fn every_render_path_draws_an_active_mask() {
    let png = photo_png();
    // Exposure -0.7 from y = 0.2 (none) to y = 0.5 (all) of the 24 x 16 photo.
    let active = with_masks(5, json!([linear("a")]));
    let json = active.to_json();
    let plain = {
        let mut s = active.clone();
        s.masks.clear();
        s.v = 1;
        s
    };
    let darker = {
        let mut s = plain.clone();
        s.exposure = -0.7;
        s
    };
    let rows = |frame: &niho_develop::Rendered, range: std::ops::Range<usize>| {
        frame.rgba[range.start * frame.width * 4..range.end * frame.width * 4].to_vec()
    };
    // The one-shot paths: above the ramp the photo as without the mask, below
    // it the photo with the mask's exposure everywhere.
    let masked = render(&png, &json, &options()).unwrap();
    let unmasked = render(&png, &plain.to_json(), &options()).unwrap();
    let all = render(&png, &darker.to_json(), &options()).unwrap();
    assert_eq!((masked.width, masked.height), (24, 16));
    assert_eq!(rows(&masked, 0..3), rows(&unmasked, 0..3));
    assert_eq!(rows(&masked, 8..16), rows(&all, 8..16));
    assert_ne!(rows(&masked, 4..7), rows(&unmasked, 4..7));
    assert_ne!(rows(&masked, 4..7), rows(&all, 4..7));
    assert_eq!(
        export_png(&png, &json, &options()).unwrap(),
        encode::encode_png(&masked.rgba, 24, 16).unwrap()
    );
    assert!(!export_jpeg(&png, &json, &options(), 90).unwrap().is_empty());
    // With a geometry the one-shot path goes through a Session.
    let mut framed = active.clone();
    framed.geometry = Some(niho_develop::Geometry::from_value(&json!({"rotate": 90})).unwrap());
    let turned = render(&png, &framed.to_json(), &options()).unwrap();
    assert_eq!((turned.width, turned.height), (16, 24));
    // A Session, at every quality and size; the frame at the working size is
    // the one-shot one.
    let mut session = Session::open_raster(&png, 0, Filter::Lanczos3).unwrap();
    for quality in [Quality::Interactive, Quality::Final] {
        for size in [0usize, 16] {
            let frame = session.render(&active, size, quality).unwrap();
            let base = session.render(&plain, size, quality).unwrap();
            assert_ne!(frame.rgba, base.rgba, "{quality:?} {size}");
        }
    }
    assert_eq!(
        session.render(&active, 0, Quality::Final).unwrap().rgba,
        masked.rgba
    );
    // Auto reads the global settings and keeps the masks.
    let auto = session.auto_settings(&active).unwrap();
    assert_eq!(auto.masks, active.masks);
    assert_eq!(auto.v, 5);

    // Masks that draw nothing do not stop a render, and the frame is the
    // same as without them.
    let expected = session.render(&plain, 0, Quality::Final).unwrap().rgba;
    let mut disabled = active.clone();
    disabled.masks[0].enabled = false;
    assert_eq!(
        session.render(&disabled, 0, Quality::Final).unwrap().rgba,
        expected
    );
    let mut empty = active.clone();
    empty.masks[0].adjust = Default::default();
    assert_eq!(
        session.render(&empty, 0, Quality::Final).unwrap().rgba,
        expected
    );
    assert_eq!(
        render(&png, &disabled.to_json(), &options()).unwrap().rgba,
        render(&png, &plain.to_json(), &options()).unwrap().rgba
    );
}

#[cfg_attr(target_arch = "wasm32", wasm_bindgen_test::wasm_bindgen_test)]
#[cfg_attr(not(target_arch = "wasm32"), test)]
fn a_surface_mask_fails_until_its_surface_can_be_loaded() {
    let png = photo_png();
    let surface = json!({
        "id": "brush1", "kind": "brush",
        "surface": {"id": "0".repeat(64), "width": 8, "height": 4},
        "adjust": {"shadows": 25}
    });
    let active = with_masks(5, json!([linear("a"), surface]));
    let missing = |error: Error| {
        assert!(
            matches!(&error, Error::MaskSurfaceMissing(id) if id == "brush1"),
            "{error}"
        );
        assert!(
            error.to_string().starts_with("maskSurfaceMissing"),
            "{error}"
        );
    };
    missing(render(&png, &active.to_json(), &options()).unwrap_err());
    missing(export_png(&png, &active.to_json(), &options()).unwrap_err());
    let mut session = Session::open_raster(&png, 0, Filter::Lanczos3).unwrap();
    for quality in [Quality::Interactive, Quality::Final] {
        missing(session.render(&active, 0, quality).unwrap_err());
    }
    missing(session.mask_plane(&active, "brush1", 0).unwrap_err());
    // A disabled one is not drawn, so it does not need its surface.
    let mut disabled = active.clone();
    disabled.masks[1].enabled = false;
    assert!(session.render(&disabled, 0, Quality::Final).is_ok());
}
