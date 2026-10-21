//! Writing `developSettings` as a Lightroom XMP preset
//! (`xmp::settings_to_xmp`, Issue #17121 F2a): what is written reads back
//! unchanged through `preset_settings`, groups decide what is written, and
//! the packet is a Lightroom preset (metadata, escaped name).

use niho_develop::effects::GRAIN_DEFAULT_SEED;
use niho_develop::settings::{
    ColorGradeBand, CurveChannel, CurvePoint, DetailSettings, HslAdjustment, HslBand,
    SharpeningSettings, ToneCurve, VignetteStyle, WhiteBalance, WhiteBalanceMode,
};
use niho_develop::tone_ops::curves_are_identity;
use niho_develop::xmp::{
    self, XmpGroup, XmpWriteOptions, BUILTIN_PRESETS, EFFECT_KEYS, SCALAR_KEYS,
};
use niho_develop::DevelopSettings;
use serde_json::{json, Value};
use std::collections::BTreeSet;

const MONO_XMP: &str = include_str!("fixtures/effects/lr-monochrome.xmp");
const FILM_XMP: &str = include_str!("fixtures/effects/lr-film.xmp");

fn all_groups() -> XmpWriteOptions {
    XmpWriteOptions {
        name: "round trip".into(),
        uuid: None,
        groups: XmpGroup::ALL.to_vec(),
    }
}

fn grid(v: u8) -> f64 {
    v as f64 / 255.0
}

fn curve(channel: CurveChannel, points: &[(u8, u8)]) -> ToneCurve {
    ToneCurve {
        channel,
        points: points
            .iter()
            .map(|(x, y)| CurvePoint {
                x: grid(*x),
                y: grid(*y),
            })
            .collect(),
    }
}

/// Every written control away from its default (fixed, distinct values;
/// integers where the converter requires them).
fn everything() -> DevelopSettings {
    let mut s = DevelopSettings::neutral();
    s.exposure = 1.37;
    for (i, key) in SCALAR_KEYS.iter().enumerate() {
        let (lo, hi) = key.range;
        if key.xmp == "Exposure2012" || key.xmp == "CurveRefineSaturation" {
            continue; // 1.37 above; 100 is the only rendered refinement
        }
        let v = lo + (hi - lo) * ((i * 37 % 89) as f64 + 5.0) / 100.0;
        *key.field.value_mut(&mut s) = if key.field.is_integer_slider() || key.range.1 == 359.0 {
            v.round()
        } else {
            v
        };
    }
    for (i, band) in HslBand::ALL.into_iter().enumerate() {
        let i = i as f64;
        s.hsl.set(
            band,
            HslAdjustment {
                hue: -40.0 + 7.0 * i,
                saturation: 35.0 - 9.0 * i,
                luminance: 2.5 * i - 11.0,
            },
        );
        s.gray_mixer.set(band, 60.0 - 13.0 * i);
    }
    s.white_balance = WhiteBalance {
        mode: WhiteBalanceMode::Absolute,
        temperature: Some(4321.0),
        tint: Some(17.0),
    };
    // Sorted by channel name, as `preset_settings` returns them.
    s.tone_curves = vec![
        curve(CurveChannel::Blue, &[(0, 0), (63, 56), (255, 255)]),
        curve(CurveChannel::Green, &[(0, 10), (128, 120), (255, 250)]),
        curve(
            CurveChannel::Red,
            &[(0, 0), (70, 80), (190, 200), (255, 255)],
        ),
        curve(
            CurveChannel::Rgb,
            &[(0, 20), (42, 30), (120, 131), (198, 209), (255, 255)],
        ),
    ];
    s.grayscale = true;
    s.vignette.amount = -35.0;
    s.vignette.midpoint = 45.0;
    s.vignette.roundness = 10.0;
    s.vignette.feather = 60.0;
    s.vignette.highlights = 30.0;
    s.vignette.style = VignetteStyle::ColorPriority;
    s.grain.amount = 30.0;
    s.grain.size = 35.0;
    s.grain.roughness = 55.0;
    s.grain.seed = Some(20_260_930.0);
    // v6 detail (Issue #32): Camera Raw stores these as integers except the
    // radius, which has one decimal.
    s.detail = Some(DetailSettings {
        sharpening: SharpeningSettings {
            amount: 65.0,
            radius: 1.3,
            detail: 40.0,
            masking: 20.0,
        },
        luminance_noise_reduction: 30.0,
        color_noise_reduction: Some(45.0),
    });
    s.v = s.required_version();
    assert!(s.validate().is_empty(), "{:?}", s.validate());
    s
}

fn read(xmp_text: &str) -> xmp::PresetResult {
    xmp::preset_settings(xmp_text, Some(&DevelopSettings::neutral())).unwrap()
}

#[test]
fn every_written_control_reads_back_unchanged() {
    let s = everything();
    let out = xmp::settings_to_xmp(&s, &all_groups());
    assert!(out.not_written.is_empty(), "{:?}", out.not_written);
    let back = read(&out.xmp);
    assert!(back.converted, "{:?}", back.convert_issues);
    assert!(back.unsupported.is_empty(), "{:?}", back.unsupported);
    assert_eq!(back.settings.to_value(), s.to_value());
    assert_eq!(back.name, "round trip");
}

#[test]
fn the_packet_is_a_lightroom_preset() {
    let s = everything();
    let out = xmp::settings_to_xmp(&s, &all_groups());
    let doc = xmp::parse(&out.xmp).unwrap();
    let p = &doc.properties;
    assert_eq!(p["PresetType"], "Normal");
    assert_eq!(p["Version"], xmp::XMP_CAMERA_RAW_VERSION);
    assert_eq!(p["ProcessVersion"], "15.4");
    assert_eq!(p["HasSettings"], "True");
    assert_eq!(p["SupportsAmount"], "True");
    assert_eq!(p["SupportsColor"], "False");
    assert_eq!(p["SupportsMonochrome"], "True");
    assert_eq!(p["WhiteBalance"], "Custom");
    assert_eq!(p["Temperature"], "4321");
    assert_eq!(p["Tint"], "+17");
    assert_eq!(p["Exposure2012"], "+1.37");
    assert_eq!(p["ConvertToGrayscale"], "True");
    assert_eq!(p["PostCropVignetteStyle"], "2");
    assert_eq!(p["GrainSeed"], "20260930");
    assert_eq!(p["ToneCurveName2012"], "Custom");
    let uuid = &p["UUID"];
    assert_eq!(uuid.len(), 32);
    assert!(uuid
        .chars()
        .all(|c| c.is_ascii_digit() || ('A'..='F').contains(&c)));
    assert_eq!(doc.sequences.len(), 4);
    assert!(out.xmp.contains("<rdf:li>42, 30</rdf:li>"));
    // Deterministic: the same content gives the same UUID, another name
    // another one; a given UUID is used as is.
    assert_eq!(xmp::settings_to_xmp(&s, &all_groups()).xmp, out.xmp);
    let renamed = XmpWriteOptions {
        name: "other".into(),
        ..all_groups()
    };
    let other = xmp::parse(&xmp::settings_to_xmp(&s, &renamed).xmp).unwrap();
    assert_ne!(&other.properties["UUID"], uuid);
    let given = XmpWriteOptions {
        uuid: Some("0123456789ABCDEF0123456789ABCDEF".into()),
        ..all_groups()
    };
    let given = xmp::parse(&xmp::settings_to_xmp(&s, &given).xmp).unwrap();
    assert_eq!(given.properties["UUID"], "0123456789ABCDEF0123456789ABCDEF");
    // A color preset supports both source kinds; grayscale is expressed by
    // SupportsColor=false while SupportsMonochrome remains true.
    let color = xmp::settings_to_xmp(&DevelopSettings::neutral(), &all_groups());
    let color = xmp::parse(&color.xmp).unwrap();
    assert_eq!(color.properties["SupportsColor"], "True");
    assert_eq!(color.properties["SupportsMonochrome"], "True");
    assert!(!color.properties.contains_key("ToneCurveName2012"));

    let mut monochrome_settings = DevelopSettings::neutral();
    monochrome_settings.grayscale = true;
    let monochrome =
        xmp::parse(&xmp::settings_to_xmp(&monochrome_settings, &all_groups()).xmp).unwrap();
    assert_eq!(monochrome.properties["SupportsColor"], "False");
    assert_eq!(monochrome.properties["SupportsMonochrome"], "True");
}

#[test]
fn integer_sliders_are_rounded_before_xmp_write() {
    let mut s = DevelopSettings::neutral();
    s.contrast = 12.5;
    s.texture = -12.5;
    let options = XmpWriteOptions {
        groups: vec![XmpGroup::Tone, XmpGroup::Presence],
        ..all_groups()
    };
    let written = xmp::settings_to_xmp(&s, &options);
    let out = xmp::parse(&written.xmp).unwrap();
    assert_eq!(out.properties["Contrast2012"], "+13");
    assert_eq!(out.properties["Texture"], "-13");
    let back = read(&written.xmp).settings;
    assert_eq!(back.contrast, 13.0);
    assert_eq!(back.texture, -13.0);
}

#[test]
fn absent_grain_seed_is_written_as_the_renderer_default() {
    let mut s = DevelopSettings::neutral();
    s.grain.amount = 30.0;
    let out = xmp::parse(&xmp::settings_to_xmp(&s, &all_groups()).xmp).unwrap();
    assert_eq!(out.properties["GrainSeed"], GRAIN_DEFAULT_SEED.to_string());
}

#[test]
fn the_name_is_escaped() {
    let name = r#"A & B <"x"> 'y'"#;
    let options = XmpWriteOptions {
        name: name.into(),
        ..XmpWriteOptions::default()
    };
    let out = xmp::settings_to_xmp(&DevelopSettings::neutral(), &options);
    assert!(out
        .xmp
        .contains("A &amp; B &lt;&quot;x&quot;&gt; &apos;y&apos;"));
    assert_eq!(xmp::parse(&out.xmp).unwrap().name.as_deref(), Some(name));
    assert_eq!(read(&out.xmp).name, name);
}

/// The Camera Raw settings properties of a written packet (without the
/// preset metadata).
fn written_keys(s: &DevelopSettings, groups: &[XmpGroup]) -> BTreeSet<String> {
    let options = XmpWriteOptions {
        groups: groups.to_vec(),
        ..all_groups()
    };
    let doc = xmp::parse(&xmp::settings_to_xmp(s, &options).xmp).unwrap();
    let metadata = [
        "PresetType",
        "UUID",
        "SupportsAmount",
        "SupportsColor",
        "SupportsMonochrome",
        "Version",
        "ProcessVersion",
        "HasSettings",
    ];
    doc.properties
        .keys()
        .filter(|k| !metadata.contains(&k.as_str()))
        .cloned()
        .chain(doc.sequences.keys().cloned())
        .collect()
}

#[test]
fn groups_decide_what_is_written() {
    let s = everything();
    let mut union = BTreeSet::new();
    for group in XmpGroup::ALL {
        let keys = written_keys(&s, &[group]);
        if group == XmpGroup::NoiseReduction {
            // A raster engine renders NR only through v6 detail.
            assert_eq!(
                keys,
                BTreeSet::from(
                    [
                        "LuminanceSmoothing",
                        "ColorNoiseReduction",
                        "ColorNoiseReductionDetail",
                        "ColorNoiseReductionSmoothness",
                    ]
                    .map(String::from)
                )
            );
            let mut without_detail = s.clone();
            without_detail.detail = None;
            assert!(
                written_keys(&without_detail, &[group]).is_empty(),
                "legacy engine without detail must not export CNR"
            );
        }
        if group == XmpGroup::Sharpening {
            assert_eq!(
                keys,
                BTreeSet::from(
                    [
                        "Sharpness",
                        "SharpenRadius",
                        "SharpenDetail",
                        "SharpenEdgeMasking"
                    ]
                    .map(String::from)
                )
            );
            let mut without_detail = s.clone();
            without_detail.detail = None;
            assert!(written_keys(&without_detail, &[group]).is_empty());
        }
        assert!(!keys.is_empty(), "{group:?}");
        assert!(union.is_disjoint(&keys), "{group:?} overlaps");
        union.extend(keys);
        assert_eq!(XmpGroup::parse(group.as_str()), Some(group));
    }
    assert_eq!(union, written_keys(&s, &XmpGroup::ALL));
    let effects: BTreeSet<String> = EFFECT_KEYS.iter().map(|k| k.xmp.to_string()).collect();
    assert!(effects.is_subset(&union));
    assert_eq!(
        written_keys(&s, &[XmpGroup::Exposure]),
        BTreeSet::from(["Exposure2012".to_string()])
    );
    assert_eq!(
        written_keys(&s, &[XmpGroup::WhiteBalance]),
        BTreeSet::from(["WhiteBalance", "Temperature", "Tint"].map(String::from))
    );
    assert_eq!(written_keys(&s, &[XmpGroup::Hsl]).len(), 24);
    // The default leaves the photo's exposure and white alone.
    let default = written_keys(&s, &XmpGroup::DEFAULT);
    assert!(!default.contains("Exposure2012") && !default.contains("WhiteBalance"));
    let out = xmp::settings_to_xmp(&s, &XmpWriteOptions::default());
    let mut photo = DevelopSettings::neutral();
    photo.exposure = -0.7;
    photo.white_balance = WhiteBalance {
        mode: WhiteBalanceMode::Absolute,
        temperature: Some(6100.0),
        tint: Some(-3.0),
    };
    let applied = xmp::preset_settings(&out.xmp, Some(&photo))
        .unwrap()
        .settings;
    assert_eq!(applied.exposure, -0.7);
    assert_eq!(applied.white_balance, photo.white_balance);
    assert_eq!(applied.contrast, s.contrast);
    assert_eq!(applied.tone_curves, s.tone_curves);
    // Every key of a written group is written (defaults included), so the
    // preset resets what the photo had there.
    let mut curved = photo.clone();
    curved.tone_curves = vec![curve(CurveChannel::Rgb, &[(0, 30), (255, 255)])];
    curved.vignette.amount = -50.0;
    let neutral_preset =
        xmp::settings_to_xmp(&DevelopSettings::neutral(), &XmpWriteOptions::default());
    let reset = xmp::preset_settings(&neutral_preset.xmp, Some(&curved))
        .unwrap()
        .settings;
    assert!(curves_are_identity(&reset.tone_curves, 1e-9));
    assert_eq!(reset.vignette.amount, 0.0);
    assert_eq!(reset.exposure, -0.7);
}

#[test]
fn what_xmp_cannot_carry_is_reported() {
    let mut relative = DevelopSettings::neutral();
    relative.white_balance.mode = WhiteBalanceMode::Relative;
    relative.relative_temperature = 12.0;
    let with_white = xmp::settings_to_xmp(&relative, &all_groups());
    assert_eq!(
        with_white.not_written,
        vec!["relativeTemperature", "relativeTint"]
    );
    assert!(!xmp::parse(&with_white.xmp)
        .unwrap()
        .properties
        .contains_key("WhiteBalance"));
    // Outside the written groups nothing is missing.
    assert!(xmp::settings_to_xmp(&relative, &XmpWriteOptions::default())
        .not_written
        .is_empty());
    let mut legacy = DevelopSettings::neutral();
    let mut kept = serde_json::Map::new();
    kept.insert("futureControl".into(), Value::from(3));
    legacy.legacy_settings = Some(kept);
    legacy.look = "niho-standard-1".into();
    legacy.extra.insert("unknown".into(), Value::from(1));
    let out = xmp::settings_to_xmp(&legacy, &XmpWriteOptions::default());
    assert_eq!(out.not_written, vec!["legacySettings"]);
    assert!(!out.xmp.contains("futureControl") && !out.xmp.contains("unknown"));
    assert!(!out.xmp.contains("niho-standard-1"));
    let value = out.to_value();
    assert_eq!(value["notWritten"], json!(["legacySettings"]));
    assert_eq!(value["xmp"], out.xmp);
}

#[test]
fn niho_2_relative_white_writes_incremental_xmp_and_round_trips() {
    let mut relative = DevelopSettings::neutral();
    relative.engine = "niho-2".into();
    relative.white_balance.mode = WhiteBalanceMode::Relative;
    relative.relative_temperature = -30.0;
    relative.relative_tint = 20.0;
    let written = xmp::settings_to_xmp(&relative, &all_groups());
    assert!(written.not_written.is_empty(), "{:?}", written.not_written);
    let document = xmp::parse(&written.xmp).unwrap();
    assert_eq!(document.properties["WhiteBalance"], "Custom");
    assert_eq!(document.properties["IncrementalTemperature"], "-30");
    assert_eq!(document.properties["IncrementalTint"], "+20");

    let back = xmp::preset_settings(&written.xmp, None).unwrap();
    assert!(back.converted, "{:?}", back.convert_issues);
    assert_eq!(back.settings.engine, "niho-2");
    assert_eq!(back.settings.white_balance.mode, WhiteBalanceMode::Relative);
    assert_eq!(back.settings.relative_temperature, -30.0);
    assert_eq!(back.settings.relative_tint, 20.0);

    relative.relative_temperature = 0.0;
    relative.relative_tint = 0.0;
    let zero = xmp::parse(&xmp::settings_to_xmp(&relative, &all_groups()).xmp).unwrap();
    assert_eq!(zero.properties["WhiteBalance"], "As Shot");
    assert!(!zero.properties.contains_key("IncrementalTemperature"));
    assert!(!zero.properties.contains_key("IncrementalTint"));
}

#[test]
fn niho_3_relative_white_survives_xmp_export() {
    let mut base = DevelopSettings::neutral();
    base.engine = "niho-3".into();
    base.look = "niho-standard-2".into();
    base.white_balance.mode = WhiteBalanceMode::Relative;
    base.relative_temperature = -30.0;
    base.relative_tint = 20.0;
    let written = xmp::settings_to_xmp(&base, &all_groups());
    assert!(written.not_written.is_empty(), "{:?}", written.not_written);
    let back = xmp::preset_settings(&written.xmp, Some(&base)).unwrap();
    assert_eq!(back.settings.engine, "niho-3");
    assert_eq!(back.settings.white_balance.mode, WhiteBalanceMode::Relative);
    assert_eq!(back.settings.relative_temperature, -30.0);
    assert_eq!(back.settings.relative_tint, 20.0);
}

#[test]
fn curves_are_written_on_lightrooms_grid() {
    let mut s = DevelopSettings::neutral();
    // 0.5 * 255 = 127.5 -> 128, 0.3 * 255 = 76.5 -> 77.
    s.tone_curves = vec![ToneCurve {
        channel: CurveChannel::Rgb,
        points: vec![
            CurvePoint { x: 0.0, y: 0.0 },
            CurvePoint { x: 0.5, y: 0.3 },
            CurvePoint { x: 1.0, y: 1.0 },
        ],
    }];
    let options = XmpWriteOptions {
        groups: vec![XmpGroup::ToneCurve],
        ..all_groups()
    };
    let out = xmp::settings_to_xmp(&s, &options);
    assert!(out.xmp.contains("<rdf:li>128, 77</rdf:li>"), "{}", out.xmp);
    // Channels without a curve are linear, as Lightroom writes them.
    let doc = xmp::parse(&out.xmp).unwrap();
    let red = &doc.sequences["crs:ToneCurvePV2012Red"];
    assert_eq!(
        red,
        &vec![CurvePoint { x: 0.0, y: 0.0 }, CurvePoint { x: 1.0, y: 1.0 }]
    );
    let back = read(&out.xmp).settings;
    let rgb = back
        .tone_curves
        .iter()
        .find(|c| c.channel == CurveChannel::Rgb)
        .unwrap();
    assert_eq!(
        rgb.points[1],
        CurvePoint {
            x: grid(128),
            y: grid(77)
        }
    );
}

#[test]
fn presets_read_write_read_to_the_same_settings() {
    // The bundled presets carry all four curves, like Lightroom writes them:
    // byte for byte the same settings.
    for p in BUILTIN_PRESETS {
        let first = xmp::preset_settings(p.xmp, None).unwrap();
        let written = xmp::settings_to_xmp(&first.settings, &all_groups());
        assert!(
            written.not_written.is_empty(),
            "{}: {:?}",
            p.id,
            written.not_written
        );
        let second = xmp::preset_settings(&written.xmp, None).unwrap();
        let mut expected = first.settings.clone();
        // The writer canonicalizes an absent seed to the renderer's fixed
        // default so applying a preset cannot preserve another photo's seed.
        if expected.grain.seed.is_none() {
            expected.grain.seed = Some(GRAIN_DEFAULT_SEED as f64);
        }
        assert_eq!(second.settings.to_json(), expected.to_json(), "{}", p.id);
        assert!(second.converted, "{}: {:?}", p.id, second.convert_issues);
        // Only what NIHO renders is written: nothing reads as unsupported.
        assert!(
            second.unsupported.is_empty(),
            "{}: {:?}",
            p.id,
            second.unsupported
        );
    }
    // Hand-made packets without point curves: a channel without a curve is
    // written linear (0, 0 / 255, 255) so the preset resets it, which reads
    // back as identity curves; everything else is the same.
    let without_identity = |s: &DevelopSettings| {
        let mut s = s.clone();
        s.tone_curves
            .retain(|c| !curves_are_identity(std::slice::from_ref(c), 1e-9));
        s.to_json()
    };
    for (id, text) in [("lr-monochrome", MONO_XMP), ("lr-film", FILM_XMP)] {
        let first = xmp::preset_settings(text, None).unwrap();
        let written = xmp::settings_to_xmp(&first.settings, &all_groups());
        assert!(
            written.not_written.is_empty(),
            "{id}: {:?}",
            written.not_written
        );
        let second = xmp::preset_settings(&written.xmp, None).unwrap();
        let mut expected = first.settings.clone();
        if expected.grain.seed.is_none() {
            expected.grain.seed = Some(GRAIN_DEFAULT_SEED as f64);
        }
        assert_eq!(
            without_identity(&second.settings),
            without_identity(&expected),
            "{id}"
        );
        assert!(second.converted, "{id}: {:?}", second.convert_issues);
    }
}

#[test]
fn options_are_read_from_json() {
    let options = XmpWriteOptions::from_value(&json!({
        "name": "朝の光",
        "uuid": "0123456789abcdef0123456789abcdef",
        "groups": ["tone", "hsl", "tone"],
    }))
    .unwrap();
    assert_eq!(options.name, "朝の光");
    assert_eq!(
        options.uuid.as_deref(),
        Some("0123456789ABCDEF0123456789ABCDEF")
    );
    assert_eq!(options.groups, vec![XmpGroup::Tone, XmpGroup::Hsl]);
    assert_eq!(
        XmpWriteOptions::from_value(&json!({})).unwrap(),
        XmpWriteOptions::default()
    );
    for bad in [
        json!({"groups": ["exposures"]}),
        json!({"uuid": "123"}),
        json!({"name": 3}),
        json!({"nmae": "x"}),
        json!([]),
    ] {
        assert!(XmpWriteOptions::from_value(&bad).is_err(), "{bad}");
    }
    let names: Vec<&str> = XmpGroup::ALL.iter().map(|g| g.as_str()).collect();
    assert_eq!(
        names,
        [
            "exposure",
            "whiteBalance",
            "tone",
            "presence",
            "toneCurve",
            "hsl",
            "colorGrading",
            "calibration",
            "blackAndWhite",
            "vignette",
            "grain",
            "noiseReduction",
            "sharpening",
            "transform"
        ]
    );
}

#[test]
fn color_grading_wheels_use_lightrooms_split_toning_keys() {
    let mut s = DevelopSettings::neutral();
    s.color_grading.shadow = ColorGradeBand {
        hue: 215.0,
        saturation: 12.0,
        luminance: -5.0,
    };
    let options = XmpWriteOptions {
        groups: vec![XmpGroup::ColorGrading],
        ..all_groups()
    };
    let doc = xmp::parse(&xmp::settings_to_xmp(&s, &options).xmp).unwrap();
    assert_eq!(doc.properties["SplitToningShadowHue"], "215");
    assert_eq!(doc.properties["SplitToningShadowSaturation"], "12");
    assert_eq!(doc.properties["ColorGradeShadowLum"], "-5");
    assert!(!doc.properties.contains_key("ColorGradeShadowHue"));
}

/// niho-photo#39: the midtone / global luminance render, so a preset writes
/// them like every other key of its group (0 included, the way Lightroom
/// saves a preset) and they read back without an "unsupported" report.
#[test]
fn midtone_and_global_luminance_are_written_and_read_back() {
    let options = XmpWriteOptions {
        groups: vec![XmpGroup::ColorGrading],
        ..all_groups()
    };
    let mut s = DevelopSettings::neutral();
    s.color_grading.midtone = ColorGradeBand {
        hue: 40.0,
        saturation: 20.0,
        luminance: 35.0,
    };
    s.color_grading.global.luminance = -12.0;
    let out = xmp::settings_to_xmp(&s, &options);
    let doc = xmp::parse(&out.xmp).unwrap();
    assert_eq!(doc.properties["ColorGradeMidtoneLum"], "+35");
    assert_eq!(doc.properties["ColorGradeGlobalLum"], "-12");
    let back = read(&out.xmp);
    assert!(back.converted, "{:?}", back.convert_issues);
    assert!(back.unsupported.is_empty(), "{:?}", back.unsupported);
    assert_eq!(back.settings.color_grading, s.color_grading);
    // 0 is written too: applying the preset resets a photo's luminance.
    let zero = xmp::settings_to_xmp(&DevelopSettings::neutral(), &options);
    let zero_doc = xmp::parse(&zero.xmp).unwrap();
    assert_eq!(zero_doc.properties["ColorGradeMidtoneLum"], "0");
    assert_eq!(zero_doc.properties["ColorGradeGlobalLum"], "0");
    let reset = xmp::preset_settings(&zero.xmp, Some(&s)).unwrap();
    assert!(reset.converted, "{:?}", reset.convert_issues);
    assert_eq!(reset.settings.color_grading.midtone.luminance, 0.0);
    assert_eq!(reset.settings.color_grading.global.luminance, 0.0);
    assert!(reset.unsupported.is_empty(), "{:?}", reset.unsupported);
}

#[test]
fn niho3_noise_reduction_group_round_trips_without_changing_legacy_presets() {
    let mut settings = DevelopSettings::neutral();
    settings.engine = niho_develop::settings::ENGINE_NIHO_3.into();
    settings.look = niho_develop::settings::LOOK_NIHO_STANDARD_2.into();
    settings.color_noise_reduction = 31.0;
    settings.color_noise_reduction_detail = 60.0;
    settings.color_noise_reduction_smoothness = 55.0;
    let options = XmpWriteOptions::default();
    let written = xmp::settings_to_xmp(&settings, &options);
    let mut base = settings.clone();
    base.color_noise_reduction = 0.0;
    base.color_noise_reduction_detail = 50.0;
    base.color_noise_reduction_smoothness = 50.0;
    let imported = xmp::preset_settings(&written.xmp, Some(&base)).unwrap();
    assert_eq!(imported.settings.color_noise_reduction, 31.0);
    assert_eq!(imported.settings.color_noise_reduction_detail, 60.0);
    assert_eq!(imported.settings.color_noise_reduction_smoothness, 55.0);
    for property in ["ColorNoiseReductionDetail", "ColorNoiseReductionSmoothness"] {
        assert_eq!(
            imported
                .items
                .iter()
                .find(|i| i.property == property)
                .unwrap()
                .level,
            xmp::Level::Unsupported
        );
    }
    settings.color_noise_reduction = 31.5;
    let fractional = xmp::settings_to_xmp(&settings, &options);
    // Camera Raw defines this property as Integer; preset amount can be
    // fractional internally, so quantize only at the XMP boundary.
    assert_eq!(
        xmp::preset_settings(&fractional.xmp, Some(&base))
            .unwrap()
            .settings
            .color_noise_reduction,
        32.0
    );
    let without_noise = XmpWriteOptions {
        groups: options
            .groups
            .iter()
            .copied()
            .filter(|g| *g != XmpGroup::NoiseReduction)
            .collect(),
        ..options.clone()
    };
    assert!(!xmp::settings_to_xmp(&settings, &without_noise)
        .xmp
        .contains("crs:ColorNoiseReduction"));
    let legacy = DevelopSettings::neutral();
    assert_eq!(
        xmp::settings_to_xmp(&legacy, &options).xmp,
        xmp::settings_to_xmp(&legacy, &without_noise).xmp
    );
}

#[test]
fn legacy_raw_color_noise_reduction_is_capped_at_the_r209_limit_in_xmp() {
    let mut settings = DevelopSettings::neutral();
    settings.engine = niho_develop::settings::ENGINE_NIHO_3.into();
    settings.color_noise_reduction = 75.0;
    assert!(settings.detail.is_none());

    let written = xmp::settings_to_xmp(&settings, &all_groups());
    let document = xmp::parse(&written.xmp).unwrap();
    assert_eq!(document.properties["ColorNoiseReduction"], "50");
}

#[test]
fn niho4_noise_reduction_group_round_trips_without_changing_the_formula_pair() {
    let mut settings = DevelopSettings::neutral();
    settings.engine = niho_develop::settings::ENGINE_NIHO_4.into();
    settings.look = niho_develop::settings::LOOK_NIHO_STANDARD_3.into();
    settings.color_noise_reduction = 31.0;
    settings.color_noise_reduction_detail = 60.0;
    settings.color_noise_reduction_smoothness = 55.0;
    let written = xmp::settings_to_xmp(&settings, &XmpWriteOptions::default());
    let mut base = settings.clone();
    base.color_noise_reduction = 0.0;
    base.color_noise_reduction_detail = 50.0;
    base.color_noise_reduction_smoothness = 50.0;
    let imported = xmp::preset_settings(&written.xmp, Some(&base)).unwrap();
    assert_eq!(imported.settings.engine, settings.engine);
    assert_eq!(imported.settings.look, settings.look);
    assert_eq!(imported.settings.color_noise_reduction, 31.0);
    assert_eq!(imported.settings.color_noise_reduction_detail, 60.0);
    assert_eq!(imported.settings.color_noise_reduction_smoothness, 55.0);
}
