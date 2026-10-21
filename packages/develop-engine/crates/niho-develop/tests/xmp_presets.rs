//! The bundled presets (and Photo Bench's fourth, night, kept only as a
//! parser fixture) must produce exactly what Photo Bench's engine returns
//! for `presetSettings` (fixture captured from photobench-engine
//! 0.1.0+f2f5c87a94de) except where NIHO follows Lightroom on purpose
//! ([`with_niho_differences`]), and convert cleanly into `developSettings`.

use niho_develop::settings::WhiteBalanceMode;
use niho_develop::xmp::{self, BUILTIN_PRESETS};
use niho_develop::DevelopSettings;

const NIGHT_XMP: &str = include_str!("fixtures/photo-bench/niho-night.xmp");

/// Every preset Photo Bench's engine bundles: NIHO's three plus night.
fn photo_bench_presets() -> Vec<(&'static str, &'static str)> {
    let mut all: Vec<(&str, &str)> = BUILTIN_PRESETS.iter().map(|p| (p.id, p.xmp)).collect();
    all.push(("niho-night", NIGHT_XMP));
    all
}
use serde_json::Value;

/// NIHO's deliberate differences from Photo Bench's `presetSettings`:
/// `WhiteBalance="Custom"` without values is Lightroom's fixed white
/// (`xmp::LIGHTROOM_CUSTOM_WHITE`, S9 #16999); Photo Bench keeps it as shot.
fn with_niho_differences(id: &str, mut want: Value) -> Value {
    if id == "niho-bluesky2" {
        let wb = want["whiteBalance"].as_object_mut().unwrap();
        assert_eq!(wb["mode"], "custom");
        assert!(!wb.contains_key("temperature") && !wb.contains_key("tint"));
        wb.insert(
            "temperature".into(),
            Value::from(xmp::LIGHTROOM_CUSTOM_WHITE.0),
        );
        wb.insert("tint".into(), Value::from(xmp::LIGHTROOM_CUSTOM_WHITE.1));
    }
    want
}

fn expected() -> Value {
    let path = format!(
        "{}/tests/fixtures/photo-bench/builtin-preset-settings.json",
        env!("CARGO_MANIFEST_DIR")
    );
    serde_json::from_str(&std::fs::read_to_string(path).unwrap()).unwrap()
}

/// Order-insensitive comparison for `hsl` (a Swift dictionary). Numbers are
/// compared by [`same`] with a 1e-12 relative tolerance: Foundation's
/// JSONSerialization prints some doubles 1 ULP off (0.24705882352941175 for
/// 63/255).
fn normalize(v: &Value) -> Value {
    match v {
        Value::Object(o) => {
            let mut out = serde_json::Map::new();
            for (k, val) in o {
                if k == "hsl" {
                    let mut pairs: Vec<(String, Value)> = val
                        .as_array()
                        .unwrap()
                        .chunks(2)
                        .map(|c| (c[0].as_str().unwrap().to_string(), normalize(&c[1])))
                        .collect();
                    pairs.sort_by(|a, b| a.0.cmp(&b.0));
                    out.insert(
                        k.clone(),
                        Value::from(
                            pairs
                                .into_iter()
                                .map(|(b, a)| Value::from(vec![Value::from(b), a]))
                                .collect::<Vec<_>>(),
                        ),
                    );
                } else {
                    out.insert(k.clone(), normalize(val));
                }
            }
            Value::Object(out)
        }
        Value::Array(a) => Value::Array(a.iter().map(normalize).collect()),
        Value::Number(n) => Value::from(n.as_f64().unwrap()),
        other => other.clone(),
    }
}

fn same(a: &Value, b: &Value, path: &str) {
    match (a, b) {
        (Value::Object(x), Value::Object(y)) => {
            let mut kx: Vec<_> = x.keys().collect();
            let mut ky: Vec<_> = y.keys().collect();
            kx.sort();
            ky.sort();
            assert_eq!(kx, ky, "{path}: keys");
            for k in kx {
                same(&x[k], &y[k], &format!("{path}.{k}"));
            }
        }
        (Value::Array(x), Value::Array(y)) => {
            assert_eq!(x.len(), y.len(), "{path}: length");
            for (i, (p, q)) in x.iter().zip(y.iter()).enumerate() {
                same(p, q, &format!("{path}[{i}]"));
            }
        }
        (Value::Number(x), Value::Number(y)) => {
            let (x, y) = (x.as_f64().unwrap(), y.as_f64().unwrap());
            assert!(
                (x - y).abs() <= 1e-12 * x.abs().max(1.0),
                "{path}: {x} vs {y}"
            );
        }
        _ => assert_eq!(a, b, "{path}"),
    }
}

#[test]
fn builtin_presets_match_photo_bench_engine() {
    let expected = expected();
    for (id, text) in photo_bench_presets() {
        let want = expected["presets"]
            .as_array()
            .unwrap()
            .iter()
            .find(|p| p["id"] == id)
            .unwrap_or_else(|| panic!("fixture for {id}"));
        let result = xmp::preset_settings(text, None).unwrap();
        assert_eq!(result.name, want["name"].as_str().unwrap(), "{id} name");
        same(
            &normalize(&result.edit_settings),
            &normalize(&with_niho_differences(id, want["settings"].clone())),
            id,
        );
        let want_unsupported: Vec<String> = want["unsupported"]
            .as_array()
            .unwrap()
            .iter()
            .map(|v| v.as_str().unwrap().to_string())
            .collect();
        // Photo Bench's own levels are its engine's; NIHO renders the effects
        // (#17120 E1), which these presets carry at their defaults.
        let photo_bench_unsupported: Vec<String> = result
            .items
            .iter()
            .filter(|i| i.photo_bench_level == xmp::Level::Unsupported)
            .map(|i| i.property.clone())
            .collect();
        assert_eq!(
            photo_bench_unsupported, want_unsupported,
            "{id} unsupported"
        );
        // NIHO also renders the Detail panel (v6, Issue #32).
        let niho_unsupported: Vec<String> = want_unsupported
            .iter()
            .filter(|p| xmp::effect_field(p).is_none() && !xmp::DETAIL_KEYS.contains(&p.as_str()))
            .cloned()
            .collect();
        assert_eq!(
            result.unsupported, niho_unsupported,
            "{id} NIHO unsupported"
        );
        for p in want_unsupported
            .iter()
            .filter(|p| xmp::effect_field(p).is_some())
        {
            let item = result.items.iter().find(|i| &i.property == p).unwrap();
            assert_eq!(item.level, xmp::Level::Exact, "{id} {p}");
        }
        // The bundled presets carry Camera Raw's default sub-controls, so
        // every Detail-panel key is rendered (exact at 0, else approximate).
        for p in want_unsupported
            .iter()
            .filter(|p| xmp::DETAIL_KEYS.contains(&p.as_str()))
        {
            let item = result.items.iter().find(|i| &i.property == p).unwrap();
            assert_ne!(item.level, xmp::Level::Unsupported, "{id} {p}");
        }
        assert!(result.converted, "{id}: {:?}", result.convert_issues);
        assert!(
            result.settings.validate().is_empty(),
            "{id}: {:?}",
            result.settings.validate()
        );
    }
}

#[test]
fn builtin_preset_details() {
    let ids: Vec<&str> = BUILTIN_PRESETS.iter().map(|p| p.id).collect();
    assert_eq!(ids, ["niho-bluesky2", "niho-pastel", "niho-colorful"]);
    let night = xmp::preset_settings(NIGHT_XMP, None).unwrap();
    assert_eq!(
        night.settings.white_balance.mode,
        WhiteBalanceMode::Absolute
    );
    assert_eq!(night.settings.white_balance.temperature, Some(6214.0));
    assert_eq!(night.settings.white_balance.tint, Some(13.0));
    assert!(night.approximate.contains(&"WhiteBalance".to_string()));
    assert_eq!(night.settings.highlights, -87.0);
    assert_eq!(night.settings.color_grading.shadow.saturation, 13.0);

    // bluesky2: Custom without Temperature / Tint (incremental values 0) is
    // Lightroom's fixed 5001 K / +10 (Photo Bench: as shot).
    let bluesky2 =
        xmp::preset_settings(xmp::builtin_preset("niho-bluesky2").unwrap().xmp, None).unwrap();
    assert_eq!(
        bluesky2.settings.white_balance.mode,
        WhiteBalanceMode::Absolute
    );
    assert_eq!(bluesky2.settings.white_balance.temperature, Some(5001.0));
    assert_eq!(bluesky2.settings.white_balance.tint, Some(10.0));
    assert!(bluesky2.approximate.contains(&"WhiteBalance".to_string()));
    assert!(bluesky2.converted, "{:?}", bluesky2.convert_issues);
    assert_eq!(bluesky2.settings.texture, 12.0);

    // The base's look stays (a preset never switches the NIHO look).
    let mut base = DevelopSettings::neutral();
    base.look = "niho-standard-1".into();
    let on_standard =
        xmp::preset_settings(xmp::builtin_preset("niho-pastel").unwrap().xmp, Some(&base)).unwrap();
    assert_eq!(on_standard.settings.look, "niho-standard-1");
    let no_base =
        xmp::preset_settings(xmp::builtin_preset("niho-pastel").unwrap().xmp, None).unwrap();
    assert_eq!(no_base.settings.look, "niho-interim-1");

    // colorful's nested Look curve must not replace the root curve.
    let colorful =
        xmp::preset_settings(xmp::builtin_preset("niho-colorful").unwrap().xmp, None).unwrap();
    assert!(colorful.unsupported.iter().any(|p| p.starts_with("Look.")));
    assert_eq!(colorful.settings.tone_curves.len(), 4);
}

#[test]
fn preset_patches_base_without_resetting_other_edits() {
    let mut base = niho_develop::settings::DevelopSettings::neutral();
    base.base = Some("base-v1".into());
    base.relative_temperature = 0.0;
    base.clarity = 33.0;
    let xmp = r#"<x:xmpmeta xmlns:x="adobe:ns:meta/"><rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#">
<rdf:Description rdf:about="" xmlns:crs="http://ns.adobe.com/camera-raw-settings/1.0/" crs:Exposure2012="+0.30"/></rdf:RDF></x:xmpmeta>"#;
    let r = xmp::preset_settings(xmp, Some(&base)).unwrap();
    assert_eq!(r.settings.exposure, 0.3);
    assert_eq!(r.settings.clarity, 33.0);
    assert_eq!(r.settings.base.as_deref(), Some("base-v1"));
}

fn custom_white(extra: &str) -> String {
    format!(
        r#"<x:xmpmeta xmlns:x="adobe:ns:meta/"><rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#">
<rdf:Description rdf:about="" xmlns:crs="http://ns.adobe.com/camera-raw-settings/1.0/" crs:WhiteBalance="Custom" {extra}/></rdf:RDF></x:xmpmeta>"#
    )
}

#[test]
fn custom_white_balance_without_values_is_lightrooms_fixed_white() {
    let fixed = xmp::preset_settings(&custom_white(""), None).unwrap();
    let wb = &fixed.settings.white_balance;
    assert_eq!(wb.mode, WhiteBalanceMode::Absolute);
    assert_eq!((wb.temperature, wb.tint), (Some(5001.0), Some(10.0)));

    // Explicit values win.
    let explicit = xmp::preset_settings(
        &custom_white(r#"crs:Temperature="4300" crs:Tint="-7""#),
        None,
    )
    .unwrap();
    let wb = &explicit.settings.white_balance;
    assert_eq!((wb.temperature, wb.tint), (Some(4300.0), Some(-7.0)));

    // A base that already has an absolute white keeps it (patch semantics).
    let mut base = niho_develop::settings::DevelopSettings::neutral();
    base.white_balance.mode = WhiteBalanceMode::Absolute;
    base.white_balance.temperature = Some(4000.0);
    base.white_balance.tint = Some(3.0);
    let patched = xmp::preset_settings(&custom_white(""), Some(&base)).unwrap();
    let wb = &patched.settings.white_balance;
    assert_eq!((wb.temperature, wb.tint), (Some(4000.0), Some(3.0)));

    // Non-zero incremental values are the calibrated niho-2 relative white.
    let incremental =
        xmp::preset_settings(&custom_white(r#"crs:IncrementalTemperature="12""#), None).unwrap();
    assert!(incremental.converted, "{:?}", incremental.convert_issues);
    assert_eq!(
        incremental.settings.white_balance.mode,
        WhiteBalanceMode::Relative
    );
    assert_eq!(incremental.settings.engine, "niho-2");
    assert_eq!(incremental.settings.relative_temperature, 12.0);
    assert_eq!(incremental.settings.relative_tint, 0.0);
    assert!(!incremental
        .unsupported
        .contains(&"IncrementalTemperature".to_string()));

    let mut relative_base = DevelopSettings::neutral();
    relative_base.white_balance.mode = WhiteBalanceMode::Relative;
    relative_base.relative_temperature = -5.0;
    let conflict = xmp::preset_settings(
        &custom_white(r#"crs:IncrementalTint="12""#),
        Some(&relative_base),
    )
    .unwrap();
    assert!(!conflict.converted);
    assert!(conflict
        .convert_issues
        .iter()
        .any(|issue| issue.code == "conflictingValue"));
}

// MARK: - NIHO effects (#17120 E1)

const MONO_XMP: &str = include_str!("fixtures/effects/lr-monochrome.xmp");
const FILM_XMP: &str = include_str!("fixtures/effects/lr-film.xmp");

fn item<'a>(r: &'a xmp::PresetResult, property: &str) -> &'a xmp::CompatibilityItem {
    r.items
        .iter()
        .find(|i| i.property == property)
        .unwrap_or_else(|| panic!("{property}"))
}

fn effects_xmp(attributes: &str) -> String {
    format!(
        r#"<x:xmpmeta xmlns:x="adobe:ns:meta/"><rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#">
<rdf:Description rdf:about="" xmlns:crs="http://ns.adobe.com/camera-raw-settings/1.0/" {attributes}/></rdf:RDF></x:xmpmeta>"#
    )
}

#[test]
fn lightroom_monochrome_and_film_presets_carry_their_effects() {
    use niho_develop::settings::{HslBand, VignetteStyle};
    for (name, text) in [("mono", MONO_XMP), ("film", FILM_XMP)] {
        let r = xmp::preset_settings(text, None).unwrap();
        assert!(r.converted, "{name}: {:?}", r.convert_issues);
        assert!(r.settings.validate().is_empty(), "{name}");
        for key in xmp::EFFECT_KEYS {
            assert!(
                !r.unsupported.iter().any(|p| p == key.xmp),
                "{name}: {} unsupported",
                key.xmp
            );
            // Photo Bench has none of them.
            if let Some(i) = r.items.iter().find(|i| i.property == key.xmp) {
                assert_eq!(i.photo_bench_level, xmp::Level::Unsupported);
            }
        }
    }

    let mono = xmp::preset_settings(MONO_XMP, None).unwrap();
    assert_eq!(item(&mono, "AutoGrayscaleMix").level, xmp::Level::Metadata);
    assert_eq!(mono.name, "NIHO test mono");
    let s = &mono.settings;
    assert!(s.grayscale);
    assert_eq!(s.gray_mixer.get(HslBand::Red), 12.0);
    assert_eq!(s.gray_mixer.get(HslBand::Blue), -30.0);
    assert_eq!(s.vignette.amount, -25.0);
    assert_eq!(s.vignette.style, VignetteStyle::HighlightPriority);
    assert_eq!(
        (s.grain.amount, s.grain.size, s.grain.roughness),
        (30.0, 25.0, 50.0)
    );
    assert_eq!(s.grain.seed, None);
    assert_eq!(s.contrast, 18.0);
    // Fitted to round8 (#17120): black & white and the vignette are exact,
    // grain (statistics only) approximate.
    for key in [
        "ConvertToGrayscale",
        "GrayMixerRed",
        "GrayMixerYellow",
        "PostCropVignetteAmount",
        "PostCropVignetteMidpoint",
    ] {
        assert_eq!(item(&mono, key).level, xmp::Level::Exact, "{key}");
    }
    for key in ["GrainAmount", "GrainFrequency"] {
        assert_eq!(item(&mono, key).level, xmp::Level::Approximate, "{key}");
    }
    // The saved JSON names the effects.
    let json = s.to_value();
    assert_eq!(json["grayscale"], true);
    assert_eq!(json["vignette"]["amount"], -25);
    assert_eq!(json["grain"]["amount"], 30);

    let film = xmp::preset_settings(FILM_XMP, None).unwrap();
    let s = &film.settings;
    assert!(!s.grayscale);
    assert!(s.gray_mixer.is_zero());
    assert_eq!(
        (
            s.vignette.amount,
            s.vignette.midpoint,
            s.vignette.feather,
            s.vignette.roundness
        ),
        (-15.0, 40.0, 70.0, 10.0)
    );
    assert_eq!(
        (s.grain.amount, s.grain.size, s.grain.roughness),
        (40.0, 30.0, 60.0)
    );
    // Color presets write the B&W mix at 0 with ConvertToGrayscale="False".
    assert_eq!(item(&film, "ConvertToGrayscale").level, xmp::Level::Exact);
    assert_eq!(item(&film, "GrayMixerGreen").level, xmp::Level::Exact);
    assert_eq!(
        item(&film, "PostCropVignetteAmount").level,
        xmp::Level::Exact
    );
    assert_eq!(item(&film, "GrainAmount").level, xmp::Level::Approximate);
}

#[test]
fn effect_keys_patch_the_base_like_lightroom() {
    use niho_develop::settings::{HslBand, VignetteStyle};
    let mut base = DevelopSettings::neutral();
    base.grayscale = true;
    base.gray_mixer.set(HslBand::Green, 30.0);
    base.vignette.amount = -50.0;
    base.vignette.midpoint = 30.0;
    base.vignette.style = VignetteStyle::PaintOverlay;
    base.grain.amount = 20.0;
    base.grain.seed = Some(7.0);
    base.clarity = 12.0;

    // Only the vignette amount: everything else stays the base's.
    let r = xmp::preset_settings(
        &effects_xmp(r#"crs:PostCropVignetteAmount="-10""#),
        Some(&base),
    )
    .unwrap();
    let mut want = base.clone();
    want.vignette.amount = -10.0;
    want.v = want.required_version();
    assert_eq!(r.settings, want);
    assert!(r.converted);

    // A color preset turns black & white off and replaces the grain it
    // carries (the seed it does not carry stays).
    let r = xmp::preset_settings(FILM_XMP, Some(&base)).unwrap();
    assert!(!r.settings.grayscale);
    assert!(r.settings.gray_mixer.is_zero());
    assert_eq!(r.settings.vignette.style, VignetteStyle::HighlightPriority);
    assert_eq!(r.settings.grain.amount, 40.0);
    assert_eq!(r.settings.grain.seed, Some(7.0));

    // Without a base the defaults are patched.
    let r = xmp::preset_settings(&effects_xmp(r#"crs:GrainAmount="12""#), None).unwrap();
    assert_eq!(r.settings.grain.amount, 12.0);
    assert_eq!(r.settings.grain.size, 25.0);
    assert!(!r.settings.grayscale);
}

#[test]
fn partial_effect_preset_compatibility_uses_the_effective_base() {
    use niho_develop::settings::HslBand;

    let mut base = DevelopSettings::neutral();
    base.grayscale = true;
    base.vignette.amount = -20.0;
    base.grain.amount = 15.0;

    let r = xmp::preset_settings(
        &effects_xmp(
            r#"crs:GrayMixerGreen="25" crs:PostCropVignetteMidpoint="35" crs:GrainSize="40""#,
        ),
        Some(&base),
    )
    .unwrap();

    assert!(r.settings.grayscale);
    assert_eq!(r.settings.gray_mixer.get(HslBand::Green), 25.0);
    assert_eq!(r.settings.vignette.amount, -20.0);
    assert_eq!(r.settings.vignette.midpoint, 35.0);
    assert_eq!(r.settings.grain.amount, 15.0);
    assert_eq!(r.settings.grain.size, 40.0);
    for key in ["GrayMixerGreen", "PostCropVignetteMidpoint"] {
        assert_eq!(item(&r, key).level, xmp::Level::Exact, "{key}");
    }
    assert_eq!(item(&r, "GrainSize").level, xmp::Level::Approximate);
}

#[test]
fn effect_values_are_levelled_clamped_and_rejected() {
    // Defaults (Lightroom writes every key): exact, not unsupported.
    let r = xmp::preset_settings(
        &effects_xmp(
            r#"crs:Exposure2012="0" crs:ConvertToGrayscale="False" crs:GrayMixerRed="+20" crs:PostCropVignetteAmount="0" crs:PostCropVignetteMidpoint="50" crs:PostCropVignetteStyle="1" crs:GrainAmount="0" crs:GrainSize="25" crs:GrainSeed="123""#,
        ),
        None,
    )
    .unwrap();
    for key in [
        "ConvertToGrayscale",
        "GrayMixerRed",
        "PostCropVignetteAmount",
        "PostCropVignetteMidpoint",
        "PostCropVignetteStyle",
        "GrainAmount",
        "GrainSize",
        "GrainSeed",
    ] {
        assert_eq!(item(&r, key).level, xmp::Level::Exact, "{key}");
    }
    assert!(r.settings.is_neutral());
    assert_eq!(r.settings.grain.seed, Some(123.0));

    // Highlight contrast is rendered for a darkening highlight-priority
    // vignette (round9), and has nothing to do on a brightening one.
    for (amount, note) in [("-20", "当てはめ"), ("20", "効かない")] {
        let r = xmp::preset_settings(
            &effects_xmp(&format!(
                r#"crs:PostCropVignetteAmount="{amount}" crs:PostCropVignetteHighlightContrast="30" crs:PostCropVignetteStyle="1""#
            )),
            None,
        )
        .unwrap();
        let hc = item(&r, "PostCropVignetteHighlightContrast");
        assert_eq!(hc.level, xmp::Level::Exact, "{amount}");
        assert!(hc.note.contains(note), "{amount}: {}", hc.note);
        assert_eq!(r.settings.vignette.highlights, 30.0);
    }

    // Color priority keeps it but does not render it.
    let r = xmp::preset_settings(
        &effects_xmp(
            r#"crs:PostCropVignetteAmount="-20" crs:PostCropVignetteHighlightContrast="30" crs:PostCropVignetteStyle="2""#,
        ),
        None,
    )
    .unwrap();
    let hc = item(&r, "PostCropVignetteHighlightContrast");
    assert_eq!(hc.level, xmp::Level::Approximate);
    assert!(hc.note.contains("保持のみ"), "{}", hc.note);
    assert_eq!(r.settings.vignette.highlights, 30.0);
    assert_eq!(
        r.settings.vignette.style,
        niho_develop::settings::VignetteStyle::ColorPriority
    );

    // Out of range: clamped and reported.
    let r = xmp::preset_settings(
        &effects_xmp(
            r#"crs:GrainAmount="150" crs:GrayMixerRed="-140" crs:ConvertToGrayscale="True""#,
        ),
        None,
    )
    .unwrap();
    assert_eq!(r.settings.grain.amount, 100.0);
    assert_eq!(
        r.settings
            .gray_mixer
            .get(niho_develop::settings::HslBand::Red),
        -100.0
    );
    assert!(item(&r, "GrainAmount").note.contains("丸めて"));
    assert!(r.converted);

    // Unreadable values: unsupported, kept in legacySettings, not converted.
    for (attributes, key) in [
        (r#"crs:GrainAmount="lots""#, "GrainAmount"),
        (
            r#"crs:PostCropVignetteAmount="NaN""#,
            "PostCropVignetteAmount",
        ),
        (r#"crs:ConvertToGrayscale="Yes""#, "ConvertToGrayscale"),
        (r#"crs:PostCropVignetteStyle="4""#, "PostCropVignetteStyle"),
    ] {
        let r = xmp::preset_settings(&effects_xmp(attributes), None).unwrap();
        assert_eq!(item(&r, key).level, xmp::Level::Unsupported, "{key}");
        assert!(r.unsupported.contains(&key.to_string()), "{key}");
        assert!(!r.converted, "{key}");
        let legacy = r.settings.legacy_settings.clone().unwrap();
        assert!(legacy.contains_key(&format!("xmp:{key}")), "{key}");
        assert!(r.settings.is_neutral(), "{key}");
    }
}
