//! Lightroom's local adjustments in an XMP preset -> NIHO `masks` (Epic #31
//! M6, #69; `docs/local-adjustments.md` "Lightroom の XMP の読み").
//!
//! Every XMP here is synthetic: the structure follows Lightroom's
//! `crs:MaskGroupBasedCorrections`, the numbers, names and sync ids are
//! invented for the tests (no real file, value or digest).

use niho_develop::local_mask::{LocalMask, MaskKind, MaskShape};
use niho_develop::settings::{DevelopSettings, MAX_LOCAL_MASKS};
use niho_develop::xmp::{
    self, apply_preset, preset_settings, Level, PresetResult, BUILTIN_PRESETS,
};
use serde_json::{json, Value};

fn document(root_attributes: &str, body: &str) -> String {
    format!(
        r#"<x:xmpmeta xmlns:x="adobe:ns:meta/"><rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#">
<rdf:Description rdf:about="" xmlns:crs="http://ns.adobe.com/camera-raw-settings/1.0/" crs:Version="17.0" crs:ProcessVersion="11.0" {root_attributes}>
{body}
</rdf:Description></rdf:RDF></x:xmpmeta>"#
    )
}

/// A preset whose root carries an exposure and the given corrections.
fn preset(corrections: &[String]) -> String {
    document(
        r#"crs:Exposure2012="+0.10""#,
        &format!(
            "<crs:MaskGroupBasedCorrections><rdf:Seq>{}</rdf:Seq></crs:MaskGroupBasedCorrections>",
            corrections.concat()
        ),
    )
}

/// The `Local*` keys Lightroom writes at 0 (and the toning hue it keeps
/// without a toning saturation), for `correction`'s defaults.
const ZERO_LOCALS: &[(&str, &str)] = &[
    ("LocalExposure", "0"),
    ("LocalHue", "0"),
    ("LocalSaturation", "0"),
    ("LocalContrast", "0"),
    ("LocalClarity", "0"),
    ("LocalSharpness", "0"),
    ("LocalBrightness", "0"),
    ("LocalToningHue", "210"),
    ("LocalToningSaturation", "0"),
    ("LocalExposure2012", "0"),
    ("LocalContrast2012", "0"),
    ("LocalHighlights2012", "0"),
    ("LocalShadows2012", "0"),
    ("LocalWhites2012", "0"),
    ("LocalBlacks2012", "0"),
    ("LocalClarity2012", "0"),
    ("LocalDehaze", "0"),
    ("LocalLuminanceNoise", "0"),
    ("LocalMoire", "0"),
    ("LocalDefringe", "0"),
    ("LocalTemperature", "0"),
    ("LocalTint", "0"),
    ("LocalTexture", "0"),
    ("LocalCurveRefineSaturation", "100"),
];

/// Attributes from defaults with `overrides` replacing (or adding) keys.
fn attributes(defaults: &[(&str, &str)], overrides: &[(&str, &str)]) -> String {
    let mut out: Vec<(String, String)> = defaults
        .iter()
        .map(|(k, v)| (k.to_string(), v.to_string()))
        .collect();
    for (key, value) in overrides {
        match out.iter_mut().find(|(k, _)| k == key) {
            Some(slot) => slot.1 = value.to_string(),
            None => out.push((key.to_string(), value.to_string())),
        }
    }
    out.iter()
        .map(|(k, v)| format!(r#" crs:{k}="{v}""#))
        .collect()
}

/// One correction (`rdf:li` / `rdf:Description`) with its masks.
fn correction(overrides: &[(&str, &str)], masks: &[String]) -> String {
    let mut defaults: Vec<(&str, &str)> = vec![
        ("What", "Correction"),
        ("CorrectionAmount", "1"),
        ("CorrectionActive", "true"),
        ("CorrectionName", "Synthetic mask"),
        ("CorrectionSyncID", "00000000000000000000000000000001"),
    ];
    defaults.extend_from_slice(ZERO_LOCALS);
    format!(
        "<rdf:li><rdf:Description{}><crs:CorrectionMasks><rdf:Seq>{}</rdf:Seq></crs:CorrectionMasks></rdf:Description></rdf:li>",
        attributes(&defaults, overrides),
        masks.concat()
    )
}

const MASK_COMMON: &[(&str, &str)] = &[
    ("MaskActive", "true"),
    ("MaskName", "Synthetic shape"),
    ("MaskBlendMode", "0"),
    ("MaskInverted", "false"),
    ("MaskSyncID", "00000000000000000000000000000002"),
    ("MaskValue", "1"),
];

/// A mask with its attributes on the `rdf:li` (as Lightroom writes simple
/// masks).
fn mask(what: &str, shape: &[(&str, &str)], overrides: &[(&str, &str)]) -> String {
    let mut defaults: Vec<(&str, &str)> = vec![("What", what)];
    defaults.extend_from_slice(MASK_COMMON);
    defaults.extend_from_slice(shape);
    format!("<rdf:li{}/>", attributes(&defaults, overrides))
}

fn gradient(overrides: &[(&str, &str)]) -> String {
    mask(
        "Mask/Gradient",
        &[
            ("ZeroX", "0.31"),
            ("ZeroY", "0.82"),
            ("FullX", "0.36"),
            ("FullY", "0.47"),
        ],
        overrides,
    )
}

fn radial(overrides: &[(&str, &str)]) -> String {
    mask(
        "Mask/CircularGradient",
        &[
            ("Top", "0.2"),
            ("Left", "0.1"),
            ("Bottom", "0.7"),
            ("Right", "0.8"),
            ("Angle", "0"),
            ("Midpoint", "50"),
            ("Roundness", "0"),
            ("Feather", "80"),
            ("Flipped", "true"),
            ("Version", "2"),
        ],
        overrides,
    )
}

fn read(xmp: &str) -> PresetResult {
    preset_settings(xmp, None).expect("preset reads")
}

fn close(a: f64, b: f64) -> bool {
    (a - b).abs() < 1e-9
}

fn unsupported_masks(result: &PresetResult) -> Vec<&str> {
    result
        .unsupported
        .iter()
        .map(String::as_str)
        .filter(|key| key.contains("Corrections"))
        .collect()
}

fn item<'a>(result: &'a PresetResult, property: &str) -> &'a xmp::CompatibilityItem {
    result
        .items
        .iter()
        .find(|item| item.property == property)
        .unwrap_or_else(|| panic!("no item {property}: {:?}", result.items))
}

/// The masks as `developSettings.masks` must accept them.
fn assert_valid_masks(result: &PresetResult) {
    let value = result.to_value();
    let settings = DevelopSettings::from_value(&json!({
        "v": 5,
        "engine": "niho-10",
        "look": "niho-standard-1",
        "base": null,
        "masks": value["masks"],
    }))
    .expect("masks are valid developSettings masks");
    assert!(settings.validate().is_empty());
    assert_eq!(settings.masks, result.masks);
}

#[test]
fn linear_gradients_become_linear_masks_with_their_local_sliders() {
    let sliders = [
        ("LocalExposure2012", "-0.25"),
        ("LocalContrast2012", "0.2"),
        ("LocalHighlights2012", "-0.6"),
        ("LocalShadows2012", "0.45"),
        ("LocalWhites2012", "0.1"),
        ("LocalBlacks2012", "-1"),
        ("LocalClarity2012", "0.15"),
        ("LocalDehaze", "0.05"),
        ("LocalTexture", "-0.1"),
        ("LocalSaturation", "0.12"),
    ];
    let xmp = preset(&[
        correction(&sliders, &[gradient(&[])]),
        correction(
            &[("LocalExposure2012", "0.5")],
            &[gradient(&[("MaskInverted", "true")])],
        ),
    ]);
    let result = read(&xmp);
    assert!(
        close(result.settings.exposure, 0.1),
        "the global part is applied"
    );
    assert!(
        result.settings.masks.is_empty(),
        "settings.masks stay the base's"
    );
    assert_eq!(result.masks.len(), 2);
    let first = &result.masks[0];
    assert_eq!(first.id, "xmp-1");
    assert_eq!(first.kind, MaskKind::Linear);
    assert!(first.enabled && !first.invert);
    let MaskShape::Linear { zero, full } = first.shape else {
        panic!("linear shape");
    };
    assert_eq!((zero.x, zero.y, full.x, full.y), (0.31, 0.82, 0.36, 0.47));
    let a = &first.adjust;
    for (got, want) in [
        (a.exposure, -0.25),
        (a.contrast, 20.0),
        (a.highlights, -60.0),
        (a.shadows, 45.0),
        (a.whites, 10.0),
        (a.blacks, -100.0),
        (a.clarity, 15.0),
        (a.dehaze, 5.0),
        (a.texture, -10.0),
        (a.saturation, 12.0),
        (a.vibrance, 0.0),
        (a.relative_temperature, 0.0),
    ] {
        assert!(close(got, want), "{got} != {want}");
    }
    let second = &result.masks[1];
    assert_eq!(second.id, "xmp-2");
    assert!(second.invert);
    assert!(close(second.adjust.exposure, 0.5));
    // Zero `Local*` keys and the toning hue without saturation say nothing.
    assert!(
        unsupported_masks(&result).is_empty(),
        "{:?}",
        result.unsupported
    );
    let read_item = item(&result, "MaskGroupBasedCorrections.1.linear");
    assert_eq!(read_item.level, Level::Approximate);
    assert!(read_item.note.contains("xmp-1"));
    assert_valid_masks(&result);
}

#[test]
fn unrotated_radials_become_radial_masks() {
    let result = read(&preset(&[correction(
        &[
            ("LocalShadows2012", "0.3"),
            ("LocalTemperature", "-0.22"),
            ("LocalTint", "0.08"),
        ],
        &[radial(&[])],
    )]));
    assert_eq!(result.masks.len(), 1);
    let mask = &result.masks[0];
    assert_eq!(mask.kind, MaskKind::Radial);
    let MaskShape::Radial {
        center,
        radius_x,
        radius_y,
        angle,
        feather,
    } = mask.shape
    else {
        panic!("radial shape");
    };
    assert!(close(center.x, 0.45) && close(center.y, 0.45));
    assert!(close(radius_x, 0.35) && close(radius_y, 0.25));
    assert_eq!((angle, feather), (0.0, 80.0));
    assert!(close(mask.adjust.shadows, 30.0));
    assert!(close(mask.adjust.relative_temperature, -22.0));
    assert!(close(mask.adjust.relative_tint, 8.0));
    // The local white balance is an approximation.
    for key in ["LocalTemperature", "LocalTint"] {
        let item = item(&result, &format!("MaskGroupBasedCorrections.1.{key}"));
        assert_eq!(item.level, Level::Approximate);
    }
    assert_eq!(
        item(&result, "MaskGroupBasedCorrections.1.radial").level,
        Level::Approximate
    );
    assert!(unsupported_masks(&result).is_empty());
    assert_valid_masks(&result);
}

#[test]
fn correction_amount_scales_and_inactive_corrections_are_disabled() {
    let result = read(&preset(&[
        correction(
            &[
                ("CorrectionAmount", "0.5"),
                ("LocalExposure2012", "0.8"),
                ("LocalContrast2012", "-0.4"),
            ],
            &[gradient(&[])],
        ),
        correction(
            &[("CorrectionActive", "false"), ("LocalExposure2012", "0.3")],
            &[gradient(&[])],
        ),
        correction(
            &[("LocalExposure2012", "0.3")],
            &[radial(&[("MaskActive", "false")])],
        ),
    ]));
    assert_eq!(result.masks.len(), 3);
    assert!(close(result.masks[0].adjust.exposure, 0.4));
    assert!(close(result.masks[0].adjust.contrast, -20.0));
    assert!(result.masks[0].enabled);
    // Present but disabled: the edit is kept, nothing is drawn.
    assert!(!result.masks[1].enabled);
    assert!(close(result.masks[1].adjust.exposure, 0.3));
    assert!(!result.masks[2].enabled);
    assert!(unsupported_masks(&result).is_empty());
    assert_valid_masks(&result);
}

/// One correction that must be left out, with the unsupported key it gives.
fn assert_left_out(correction: String, key: &str) {
    let result = read(&preset(&[correction]));
    assert!(result.masks.is_empty(), "{key}: {:?}", result.masks);
    let keys = unsupported_masks(&result);
    assert!(keys.contains(&key), "{key} not in {keys:?}");
    assert_eq!(item(&result, key).level, Level::Unsupported);
}

#[test]
fn shapes_niho_cannot_read_are_reported_and_left_out() {
    let exposure = [("LocalExposure2012", "0.4")];
    let one = "MaskGroupBasedCorrections.1";
    assert_left_out(
        correction(&exposure, &[radial(&[("Angle", "30")])]),
        &format!("{one}.rotatedRadial"),
    );
    assert_left_out(
        correction(&exposure, &[radial(&[("Roundness", "20")])]),
        &format!("{one}.radialRoundness"),
    );
    assert_left_out(
        correction(&exposure, &[radial(&[("Flipped", "false")])]),
        &format!("{one}.radialFlipped"),
    );
    assert_left_out(
        correction(&exposure, &[radial(&[("Midpoint", "70")])]),
        &format!("{one}.radialMidpoint"),
    );
    assert_left_out(
        correction(&exposure, &[radial(&[("Version", "3")])]),
        &format!("{one}.radialVersion"),
    );
    // The centre must lie in the frame, the half axes in 0.005..1.5.
    assert_left_out(
        correction(&exposure, &[radial(&[("Left", "0.9"), ("Right", "1.8")])]),
        &format!("{one}.outOfRange"),
    );
    assert_left_out(
        correction(&exposure, &[radial(&[("Left", "0.8"), ("Right", "0.1")])]),
        &format!("{one}.outOfRange"),
    );
    assert_left_out(
        correction(&exposure, &[gradient(&[("ZeroX", "-1.5")])]),
        &format!("{one}.outOfRange"),
    );
    assert_left_out(
        correction(&exposure, &[gradient(&[("ZeroX", "x")])]),
        &format!("{one}.invalid"),
    );
    assert_left_out(
        correction(
            &exposure,
            &[mask("Mask/Image", &[("MaskSubType", "2")], &[])],
        ),
        &format!("{one}.aiMask"),
    );
    assert_left_out(
        correction(&exposure, &[mask("Mask/RangeMask", &[], &[])]),
        &format!("{one}.rangeMask"),
    );
    assert_left_out(
        correction(&exposure, &[mask("Mask/Future", &[], &[])]),
        &format!("{one}.unknownMask"),
    );
    assert_left_out(
        correction(
            &exposure,
            &[gradient(&[]), gradient(&[("MaskBlendMode", "1")])],
        ),
        &format!("{one}.multipleMasks"),
    );
    assert_left_out(
        correction(&exposure, &[gradient(&[("MaskBlendMode", "1")])]),
        &format!("{one}.maskBlend"),
    );
    assert_left_out(
        correction(&exposure, &[gradient(&[("MaskValue", "0.5")])]),
        &format!("{one}.maskValue"),
    );
    assert_left_out(
        correction(&exposure, &[gradient(&[("MaskActive", "maybe")])]),
        &format!("{one}.invalid"),
    );
    assert_left_out(
        correction(&[("CorrectionAmount", "1.5")], &[gradient(&[])]),
        &format!("{one}.invalid"),
    );
    // A correction without a mask.
    assert_left_out(correction(&exposure, &[]), &format!("{one}.invalid"));
}

/// A brush as Lightroom writes it: an aggregate of painted dabs.
fn brush() -> String {
    let dabs = ["d 0.412 0.903", "r 0.21", "d 0.433 0.887"]
        .map(|dab| format!("<rdf:li>{dab}</rdf:li>"))
        .concat();
    format!(
        r#"<rdf:li><rdf:Description crs:What="Mask/Aggregate" crs:MaskActive="true" crs:MaskName="Brush 1" crs:MaskBlendMode="0" crs:MaskInverted="false" crs:MaskSyncID="00000000000000000000000000000003" crs:MaskValue="1"><crs:Masks><rdf:Seq><rdf:li><rdf:Description crs:What="Mask/Paint" crs:MaskValue="1" crs:Radius="0.05" crs:Flow="1" crs:CenterWeight="0"><crs:Dabs><rdf:Seq>{dabs}</rdf:Seq></crs:Dabs></rdf:Description></rdf:li></rdf:Seq></crs:Masks></rdf:Description></rdf:li>"#
    )
}

#[test]
fn brushes_are_reported_as_brushes_even_with_several_strokes() {
    let exposure = [("LocalExposure2012", "0.4")];
    assert_left_out(
        correction(&exposure, &[brush()]),
        "MaskGroupBasedCorrections.1.brush",
    );
    let result = read(&preset(&[correction(&exposure, &[brush(), brush()])]));
    assert_eq!(
        unsupported_masks(&result),
        ["MaskGroupBasedCorrections.1.brush"]
    );
    // The legacy brush list is a brush as well (every correction).
    let legacy = document(
        "",
        &format!(
            "<crs:PaintBasedCorrections><rdf:Seq>{}{}</rdf:Seq></crs:PaintBasedCorrections>",
            correction(&exposure, &[mask("Mask/Paint", &[], &[])]),
            correction(&exposure, &[mask("Mask/Paint", &[], &[])])
        ),
    );
    let result = read(&legacy);
    assert!(result.masks.is_empty());
    assert_eq!(
        unsupported_masks(&result),
        [
            "PaintBasedCorrections.1.brush",
            "PaintBasedCorrections.2.brush"
        ]
    );
    assert_eq!(
        item(&result, "PaintBasedCorrections.1.brush").level,
        Level::Unsupported
    );
}

#[test]
fn local_sliders_without_a_niho_twin_are_reported_per_key() {
    let result = read(&preset(&[correction(
        &[
            ("LocalExposure2012", "0.4"),
            ("LocalSharpness", "0.3"),
            ("LocalHue", "0.2"),
            ("LocalLuminanceNoise", "0.1"),
            ("LocalMoire", "0.1"),
            ("LocalDefringe", "0.1"),
            ("LocalBrightness", "0.1"),
            ("LocalExposure", "0.2"),
            ("LocalContrast", "0.2"),
            ("LocalClarity", "0.2"),
            ("LocalToningSaturation", "0.4"),
            ("LocalCurveRefineSaturation", "80"),
            ("LocalFutureSlider", "0.5"),
        ],
        &[gradient(&[])],
    )]));
    // The mask keeps what NIHO has.
    assert_eq!(result.masks.len(), 1);
    assert!(close(result.masks[0].adjust.exposure, 0.4));
    let prefix = "MaskGroupBasedCorrections.1";
    let mut want: Vec<String> = [
        "LocalSharpness",
        "LocalHue",
        "LocalLuminanceNoise",
        "LocalMoire",
        "LocalDefringe",
        "LocalBrightness",
        "LocalExposure",
        "LocalContrast",
        "LocalClarity",
        "LocalToningSaturation",
        "LocalCurveRefineSaturation",
        "LocalFutureSlider",
    ]
    .map(|key| format!("{prefix}.{key}"))
    .to_vec();
    want.sort();
    let mut got: Vec<String> = unsupported_masks(&result)
        .into_iter()
        .map(String::from)
        .collect();
    got.sort();
    assert_eq!(got, want);
    assert!(item(&result, &format!("{prefix}.LocalToningSaturation"))
        .value
        .contains("LocalToningHue=210"));
    assert_valid_masks(&result);
}

#[test]
fn at_most_eight_masks_are_read() {
    let corrections: Vec<String> = (0..MAX_LOCAL_MASKS + 1)
        .map(|_| correction(&[("LocalExposure2012", "0.1")], &[gradient(&[])]))
        .collect();
    let result = read(&preset(&corrections));
    assert_eq!(result.masks.len(), MAX_LOCAL_MASKS);
    let ids: Vec<&str> = result.masks.iter().map(|m| m.id.as_str()).collect();
    assert_eq!(ids.first(), Some(&"xmp-1"));
    assert_eq!(ids.last(), Some(&"xmp-8"));
    assert_eq!(
        unsupported_masks(&result),
        ["MaskGroupBasedCorrections.9.tooMany"]
    );
    assert_valid_masks(&result);
}

fn mask_exposures(masks: &[LocalMask]) -> Vec<f64> {
    masks.iter().map(|m| m.adjust.exposure).collect()
}

#[test]
fn the_amount_scales_the_preset_masks_and_stops_at_the_ranges() {
    let xmp = preset(&[correction(
        &[("LocalExposure2012", "0.8"), ("LocalContrast2012", "0.8")],
        &[gradient(&[])],
    )]);
    let base = DevelopSettings::neutral();
    let whole = preset_settings(&xmp, Some(&base)).unwrap();
    let at = |amount: f64| apply_preset(&xmp, &base, amount, None).unwrap();
    assert!(at(0.0).masks.is_empty(), "0% carries no mask");
    assert_eq!(at(0.0).settings, base);
    assert_eq!(at(1.0).masks, whole.masks);
    let half = at(0.5);
    assert!(close(mask_exposures(&half.masks)[0], 0.4));
    assert!(close(half.masks[0].adjust.contrast, 40.0));
    let more = at(1.5);
    assert!(close(mask_exposures(&more.masks)[0], 1.2));
    // 80 x 1.5 = 120 stops at 100.
    assert_eq!(more.masks[0].adjust.contrast, 100.0);
    assert_eq!(more.masks[0].shape, whole.masks[0].shape);
    assert_eq!(more.masks[0].id, "xmp-1");
    for amount in [0.5, 1.0, 1.5] {
        assert_valid_masks(&at(amount));
        assert_eq!(at(amount).to_value()["masks"].as_array().unwrap().len(), 1);
    }
}

#[test]
fn presets_without_masks_are_unchanged() {
    for preset in BUILTIN_PRESETS {
        let result = read(preset.xmp);
        assert!(result.masks.is_empty(), "{}", preset.id);
        assert!(unsupported_masks(&result).is_empty(), "{}", preset.id);
        assert_eq!(result.to_value()["masks"], json!([]), "{}", preset.id);
    }
    let plain = document(r#"crs:Exposure2012="+0.30""#, "");
    let result = read(&plain);
    assert!(result.masks.is_empty());
    assert!(result
        .items
        .iter()
        .all(|item| !item.property.contains("Corrections")));
}

/// A preset with an embedded Look and corrections in element form
/// (`rdf:parseType="Resource"`, simple elements, `rdf:Description` masks).
fn look_and_element_form() -> String {
    document(
        r#"crs:Exposure2012="+0.10""#,
        r#"<crs:Look><rdf:Description crs:Name="Synthetic Look" crs:Amount="1"><crs:Parameters><rdf:Description crs:Version="17.0" crs:ProcessVersion="11.0"/></crs:Parameters></rdf:Description></crs:Look>
<crs:MaskGroupBasedCorrections><rdf:Seq>
 <rdf:li rdf:parseType="Resource"><crs:What>Correction</crs:What><crs:CorrectionAmount>1</crs:CorrectionAmount><crs:LocalExposure2012>0.35</crs:LocalExposure2012><crs:LocalToningHue>45</crs:LocalToningHue>
  <crs:CorrectionMasks><rdf:Seq><rdf:li><rdf:Description crs:What="Mask/CircularGradient" crs:MaskValue="1" crs:Top="0.3" crs:Left="0.3" crs:Bottom="0.5" crs:Right="0.6" crs:Angle="0" crs:Midpoint="50" crs:Roundness="0" crs:Feather="40" crs:Flipped="true" crs:Version="2"/></rdf:li></rdf:Seq></crs:CorrectionMasks>
 </rdf:li>
</rdf:Seq></crs:MaskGroupBasedCorrections>"#,
    )
}

#[test]
fn mask_descriptions_do_not_leak_into_look_or_root_properties() {
    let xmp = look_and_element_form();
    let doc = xmp::parse(&xmp).unwrap();
    // Keys inside the corrections neither reach the nested Look nor
    // overwrite the root (`Version` 2 of the radial vs. the root's 17.0).
    assert_eq!(
        doc.properties.get("Version").map(String::as_str),
        Some("17.0")
    );
    assert!(!doc.properties.contains_key("MaskGroupBasedCorrections"));
    for key in [
        "What",
        "LocalExposure2012",
        "Top",
        "Feather",
        "Flipped",
        "CorrectionAmount",
    ] {
        assert!(!doc.nested.contains_key(key), "{key} leaked into nested");
        assert!(
            !doc.properties.contains_key(key),
            "{key} leaked into properties"
        );
    }
    assert!(doc.nested.contains_key("Name"), "the Look is still read");
    assert_eq!(doc.local_corrections.len(), 1);
    let result = read(&xmp);
    let looks: Vec<&str> = result
        .items
        .iter()
        .map(|item| item.property.as_str())
        .filter(|property| property.starts_with("Look."))
        .collect();
    assert!(
        looks
            .iter()
            .all(|p| !p.contains("What") && !p.contains("Local")),
        "{looks:?}"
    );
    assert_eq!(result.masks.len(), 1);
    assert!(close(result.masks[0].adjust.exposure, 0.35));
    assert_eq!(result.masks[0].kind, MaskKind::Radial);
    assert!(
        unsupported_masks(&result).is_empty(),
        "{:?}",
        result.unsupported
    );
}

#[test]
fn a_preset_with_only_masks_has_settings() {
    let xmp = format!(
        r#"<x:xmpmeta xmlns:x="adobe:ns:meta/"><rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#"><rdf:Description xmlns:crs="http://ns.adobe.com/camera-raw-settings/1.0/"><crs:MaskGroupBasedCorrections><rdf:Seq>{}</rdf:Seq></crs:MaskGroupBasedCorrections></rdf:Description></rdf:RDF></x:xmpmeta>"#,
        correction(&[("LocalExposure2012", "0.2")], &[gradient(&[])])
    );
    let result = read(&xmp);
    assert_eq!(result.masks.len(), 1);
    assert!(result.settings.is_neutral());
}

#[test]
fn legacy_gradient_lists_are_reported_not_read() {
    let legacy_body = format!(
        "<crs:GradientBasedCorrections><rdf:Seq>{}{}</rdf:Seq></crs:GradientBasedCorrections><crs:CircularGradientBasedCorrections><rdf:Seq>{}</rdf:Seq></crs:CircularGradientBasedCorrections>",
        correction(&[("LocalExposure2012", "0.2")], &[gradient(&[])]),
        correction(&[("LocalExposure2012", "0.1")], &[gradient(&[])]),
        correction(&[("LocalExposure2012", "-0.2")], &[radial(&[])]),
    );
    // No real export has confirmed their units and shapes: every
    // correction is reported, none becomes a mask.
    let legacy = read(&document("", &legacy_body));
    assert!(legacy.masks.is_empty());
    assert_eq!(
        unsupported_masks(&legacy),
        [
            "GradientBasedCorrections.1.legacyList",
            "GradientBasedCorrections.2.legacyList",
            "CircularGradientBasedCorrections.1.legacyList",
        ]
    );
    let circular = item(&legacy, "CircularGradientBasedCorrections.1.legacyList");
    assert_eq!(circular.value, "Mask/CircularGradient");
    assert!(circular.note.contains("旧形式"));
    // With MaskGroupBasedCorrections (the same masks), the legacy lists
    // are only metadata.
    let both = document(
        "",
        &format!(
            "<crs:MaskGroupBasedCorrections><rdf:Seq>{}</rdf:Seq></crs:MaskGroupBasedCorrections>{legacy_body}",
            correction(&[("LocalExposure2012", "0.2")], &[gradient(&[])])
        ),
    );
    let result = read(&both);
    assert_eq!(result.masks.len(), 1);
    assert_eq!(
        item(&result, "GradientBasedCorrections").level,
        Level::Metadata
    );
    assert!(unsupported_masks(&result).is_empty());
}

#[test]
fn an_absolute_white_takes_no_local_white_balance() {
    let xmp = document(
        r#"crs:WhiteBalance="Custom" crs:Temperature="5600" crs:Tint="+4""#,
        &format!(
            "<crs:MaskGroupBasedCorrections><rdf:Seq>{}</rdf:Seq></crs:MaskGroupBasedCorrections>",
            correction(
                &[("LocalTemperature", "0.3"), ("LocalExposure2012", "0.2")],
                &[gradient(&[])]
            )
        ),
    );
    let result = read(&xmp);
    assert_eq!(result.masks.len(), 1);
    assert_eq!(result.masks[0].adjust.relative_temperature, 0.0);
    assert!(close(result.masks[0].adjust.exposure, 0.2));
    assert_eq!(
        unsupported_masks(&result),
        ["MaskGroupBasedCorrections.1.LocalTemperature"]
    );
    let settings: Value = result.settings.to_value();
    assert_eq!(settings["whiteBalance"]["mode"], "absolute");
}
