//! Lightroom's Detail panel <-> v6 `developSettings.detail` (Issue #32):
//! which XMP keys are read, how Camera Raw's defaults are treated, the
//! reported levels, the writer, and the preset amount.

use niho_develop::settings::{
    DetailSettings, DevelopSettings, SharpeningSettings, ENGINE_NIHO_10, ENGINE_NIHO_11,
    LOOK_NIHO_STANDARD_1, LOOK_NIHO_STANDARD_5,
};
use niho_develop::xmp::{self, Level, XmpGroup, XmpWriteOptions};

fn packet(attributes: &str) -> String {
    format!(
        r#"<x:xmpmeta xmlns:x="adobe:ns:meta/"><rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#"><rdf:Description rdf:about="" xmlns:crs="http://ns.adobe.com/camera-raw-settings/1.0/" {attributes}/></rdf:RDF></x:xmpmeta>"#
    )
}

fn raster() -> DevelopSettings {
    let mut s = DevelopSettings::neutral();
    s.engine = ENGINE_NIHO_10.into();
    s.look = LOOK_NIHO_STANDARD_1.into();
    s
}

fn signed_raw() -> DevelopSettings {
    let mut s = DevelopSettings::neutral();
    s.engine = ENGINE_NIHO_11.into();
    s.look = LOOK_NIHO_STANDARD_5.into();
    s
}

fn level(result: &xmp::PresetResult, property: &str) -> (Level, String) {
    let item = result
        .items
        .iter()
        .find(|item| item.property == property)
        .unwrap_or_else(|| panic!("{property}"));
    assert_eq!(item.photo_bench_level, Level::Unsupported, "{property}");
    (item.level, item.note.clone())
}

/// Camera Raw's defaults for a rendered (JPEG / TIFF) file: every amount 0.
const JPEG_DEFAULTS: &str = r#"crs:Sharpness="0" crs:SharpenRadius="+1.0" crs:SharpenDetail="25" crs:SharpenEdgeMasking="0" crs:LuminanceSmoothing="0" crs:LuminanceNoiseReductionDetail="50" crs:LuminanceNoiseReductionContrast="0" crs:ColorNoiseReduction="0" crs:ColorNoiseReductionDetail="50" crs:ColorNoiseReductionSmoothness="50""#;
/// Camera Raw's defaults for a RAW file: Sharpness 40, color NR 25.
const RAW_DEFAULTS: &str = r#"crs:Sharpness="40" crs:SharpenRadius="+1.0" crs:SharpenDetail="25" crs:SharpenEdgeMasking="0" crs:LuminanceSmoothing="0" crs:LuminanceNoiseReductionDetail="50" crs:LuminanceNoiseReductionContrast="0" crs:ColorNoiseReduction="25" crs:ColorNoiseReductionDetail="50" crs:ColorNoiseReductionSmoothness="50""#;

#[test]
fn all_zero_camera_raw_defaults_keep_the_shape_and_report_nothing_unsupported() {
    for base in [raster(), signed_raw()] {
        let result = xmp::preset_settings(&packet(JPEG_DEFAULTS), Some(&base)).unwrap();
        assert_eq!(result.settings.detail, None, "{}", base.engine);
        assert_eq!(result.settings.v, base.v, "{}", base.engine);
        assert!(result.unsupported.is_empty(), "{:?}", result.unsupported);
        for key in xmp::DETAIL_KEYS {
            assert_eq!(level(&result, key).0, Level::Exact, "{} {key}", base.engine);
        }
    }
}

#[test]
fn raw_defaults_are_applied_as_written_on_every_engine() {
    // A key the XMP writes acts on any photo, like Lightroom applying the
    // preset; Camera Raw's RAW defaults are not special.
    let on_raster = xmp::preset_settings(&packet(RAW_DEFAULTS), Some(&raster())).unwrap();
    assert_eq!(
        on_raster.settings.detail,
        Some(DetailSettings {
            sharpening: SharpeningSettings {
                amount: 40.0,
                radius: 1.0,
                detail: 25.0,
                masking: 0.0,
            },
            luminance_noise_reduction: 0.0,
            color_noise_reduction: Some(25.0),
        })
    );
    assert_eq!(on_raster.settings.v, 6);
    assert!(
        on_raster.unsupported.is_empty(),
        "{:?}",
        on_raster.unsupported
    );
    for key in [
        "Sharpness",
        "SharpenRadius",
        "SharpenDetail",
        "SharpenEdgeMasking",
        "ColorNoiseReduction",
        "ColorNoiseReductionDetail",
        "ColorNoiseReductionSmoothness",
    ] {
        assert_eq!(level(&on_raster, key).0, Level::Approximate, "{key}");
        assert!(on_raster.approximate.contains(&key.to_string()), "{key}");
    }
    assert_eq!(level(&on_raster, "LuminanceSmoothing").0, Level::Exact);

    let on_raw = xmp::preset_settings(&packet(RAW_DEFAULTS), Some(&signed_raw())).unwrap();
    assert_eq!(on_raw.settings.color_noise_reduction, 25.0);
    assert_eq!(
        on_raw.settings.detail.unwrap().color_noise_reduction,
        Some(25.0)
    );
    assert!(level(&on_raw, "ColorNoiseReduction")
        .1
        .contains("signed RAW"));
}

#[test]
fn missing_companions_take_the_photos_value_or_camera_raws_default() {
    let only_amount = packet(r#"crs:Sharpness="60""#);
    let fresh = xmp::preset_settings(&only_amount, Some(&raster()))
        .unwrap()
        .settings;
    assert_eq!(
        fresh.detail.unwrap().sharpening,
        SharpeningSettings {
            amount: 60.0,
            radius: 1.0,
            detail: 25.0,
            masking: 0.0,
        }
    );
    assert_eq!(fresh.detail.unwrap().color_noise_reduction, None);

    let mut edited = raster();
    edited.detail = Some(DetailSettings {
        sharpening: SharpeningSettings {
            amount: 20.0,
            radius: 2.2,
            detail: 70.0,
            masking: 35.0,
        },
        luminance_noise_reduction: 15.0,
        color_noise_reduction: Some(10.0),
    });
    edited.v = edited.required_version();
    let patched = xmp::preset_settings(&only_amount, Some(&edited))
        .unwrap()
        .settings
        .detail
        .unwrap();
    assert_eq!(patched.sharpening.amount, 60.0);
    assert_eq!(patched.sharpening.radius, 2.2);
    assert_eq!(patched.luminance_noise_reduction, 15.0);
    assert_eq!(patched.color_noise_reduction, Some(10.0));

    // A preset without Detail-panel keys leaves the photo's detail alone.
    let tone_only = packet(r#"crs:Contrast2012="+12""#);
    let kept = xmp::preset_settings(&tone_only, Some(&edited))
        .unwrap()
        .settings;
    assert_eq!(kept.detail, edited.detail);
    assert_eq!(kept.v, 6);
}

#[test]
fn out_of_range_malformed_and_luminance_sub_controls_are_reported() {
    let result = xmp::preset_settings(
        &packet(
            r#"crs:Sharpness="200" crs:SharpenRadius="0.2" crs:LuminanceSmoothing="30" crs:LuminanceNoiseReductionDetail="50" crs:LuminanceNoiseReductionContrast="12""#,
        ),
        Some(&raster()),
    )
    .unwrap();
    let detail = result.settings.detail.unwrap();
    assert_eq!(detail.sharpening.amount, 150.0);
    assert_eq!(detail.sharpening.radius, 0.5);
    assert_eq!(detail.luminance_noise_reduction, 30.0);
    let (sharpness, note) = level(&result, "Sharpness");
    assert_eq!(sharpness, Level::Approximate);
    assert!(note.contains("0..150"), "{note}");
    assert!(level(&result, "SharpenRadius").1.contains("0.5..3"));
    assert_eq!(level(&result, "LuminanceSmoothing").0, Level::Approximate);
    assert_eq!(
        level(&result, "LuminanceNoiseReductionDetail").0,
        Level::Approximate
    );
    // Not Camera Raw's default contrast: kept, rendered with the default.
    assert_eq!(
        level(&result, "LuminanceNoiseReductionContrast").0,
        Level::Unsupported
    );
    assert_eq!(result.unsupported, ["LuminanceNoiseReductionContrast"]);

    let malformed =
        xmp::preset_settings(&packet(r#"crs:Sharpness="sharp""#), Some(&raster())).unwrap();
    assert_eq!(malformed.settings.detail, None);
    assert!(!malformed.converted);
    assert_eq!(level(&malformed, "Sharpness").0, Level::Unsupported);
    assert!(malformed
        .settings
        .legacy_settings
        .as_ref()
        .unwrap()
        .contains_key("xmp:Sharpness"));
}

#[test]
fn the_writer_round_trips_detail_and_leaves_presets_without_it_unchanged() {
    let mut s = raster();
    s.detail = Some(DetailSettings {
        sharpening: SharpeningSettings {
            amount: 72.0,
            radius: 1.7,
            detail: 33.0,
            masking: 48.0,
        },
        luminance_noise_reduction: 41.0,
        color_noise_reduction: Some(64.0),
    });
    s.v = s.required_version();
    let written = xmp::settings_to_xmp(&s, &XmpWriteOptions::default());
    for attribute in [
        r#"crs:Sharpness="72""#,
        r#"crs:SharpenRadius="+1.7""#,
        r#"crs:SharpenDetail="33""#,
        r#"crs:SharpenEdgeMasking="48""#,
        r#"crs:LuminanceSmoothing="41""#,
        r#"crs:ColorNoiseReduction="64""#,
    ] {
        assert!(
            written.xmp.contains(attribute),
            "{attribute}\n{}",
            written.xmp
        );
    }
    let back = xmp::preset_settings(&written.xmp, Some(&raster())).unwrap();
    assert_eq!(back.settings.detail, s.detail);
    assert!(back.unsupported.is_empty(), "{:?}", back.unsupported);

    // Edits without detail write exactly the bytes they wrote before #32.
    for base in [raster(), DevelopSettings::neutral()] {
        let without = XmpWriteOptions {
            groups: XmpGroup::DEFAULT
                .into_iter()
                .filter(|g| !matches!(g, XmpGroup::Sharpening | XmpGroup::NoiseReduction))
                .collect(),
            ..XmpWriteOptions::default()
        };
        assert_eq!(
            xmp::settings_to_xmp(&base, &XmpWriteOptions::default()).xmp,
            xmp::settings_to_xmp(&base, &without).xmp
        );
    }

    // A signed RAW edit carries the color NR it renders: the legacy amount
    // when detail has none of its own.
    let mut raw = signed_raw();
    raw.color_noise_reduction = 31.0;
    raw.detail = Some(DetailSettings {
        sharpening: SharpeningSettings {
            amount: 25.0,
            ..SharpeningSettings::default()
        },
        ..DetailSettings::default()
    });
    raw.v = raw.required_version();
    let raw_xmp = xmp::settings_to_xmp(&raw, &XmpWriteOptions::default()).xmp;
    assert!(
        raw_xmp.contains(r#"crs:ColorNoiseReduction="31""#),
        "{raw_xmp}"
    );
    assert!(raw_xmp.contains(r#"crs:Sharpness="25""#), "{raw_xmp}");
}

#[test]
fn the_preset_amount_moves_every_detail_value_from_what_the_photo_renders() {
    let preset = packet(
        r#"crs:Sharpness="80" crs:SharpenRadius="+2.0" crs:LuminanceSmoothing="40" crs:ColorNoiseReduction="60""#,
    );
    let half = xmp::apply_preset(&preset, &raster(), 0.5, None)
        .unwrap()
        .settings;
    let detail = half.detail.unwrap();
    assert_eq!(detail.sharpening.amount, 40.0);
    assert_eq!(detail.sharpening.radius, 1.5);
    assert_eq!(detail.luminance_noise_reduction, 20.0);
    assert_eq!(detail.color_noise_reduction, Some(30.0));
    assert_eq!(half.v, 6);

    let over = xmp::apply_preset(&preset, &raster(), 1.5, None)
        .unwrap()
        .settings
        .detail
        .unwrap();
    assert_eq!(over.sharpening.amount, 120.0);
    assert_eq!(over.color_noise_reduction, Some(90.0));
    assert_eq!(over.sharpening.radius, 2.5);

    // A signed RAW photo already renders its legacy amount: the blend
    // starts there instead of at 0.
    let mut raw = signed_raw();
    raw.color_noise_reduction = 20.0;
    let raw_half = xmp::apply_preset(&preset, &raw, 0.5, None)
        .unwrap()
        .settings;
    assert_eq!(raw_half.detail.unwrap().color_noise_reduction, Some(40.0));
    assert!(raw_half.validate().is_empty(), "{:?}", raw_half.validate());

    let zero = xmp::apply_preset(&preset, &raster(), 0.0, None)
        .unwrap()
        .settings;
    assert_eq!(zero, raster());
}

#[test]
fn compatibility_without_a_photo_reports_detail_levels() {
    let doc = xmp::parse(&packet(RAW_DEFAULTS)).unwrap();
    let items = doc.compatibility();
    let find = |key: &str| items.iter().find(|item| item.property == key).unwrap();
    assert_eq!(find("Sharpness").level, Level::Approximate);
    assert_eq!(find("ColorNoiseReduction").level, Level::Approximate);
    assert_eq!(find("LuminanceSmoothing").level, Level::Exact);
}
