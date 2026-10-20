//! `niho-8` is an explicit, unpromoted evaluation candidate. It reuses the
//! niho-6 raster formula and niho-2 legacy RAW formula, changing only the
//! precision of the look/ACR3, P and Q cube entries.

use niho_develop::decode::{encode_signed_working_copy, encode_working_copy, LinearImage};
use niho_develop::pipeline::{settings_cubes, INTERACTIVE_TONE_CUBE_DIMENSION};
use niho_develop::settings::{ENGINE_NIHO_2, ENGINE_NIHO_6, ENGINE_NIHO_8, LOOK_NIHO_STANDARD_1};
use niho_develop::{parse_settings, xmp, DevelopSettings, Error, Filter, Quality, Session};

fn image() -> LinearImage {
    LinearImage {
        width: 32,
        height: 24,
        data: (0..32 * 24)
            .flat_map(|i| {
                let t = i as f32 / (32 * 24 - 1) as f32;
                [0.01 + 0.75 * t, 0.02 + 0.55 * t * t, 0.03 + 0.4 * t]
            })
            .collect(),
    }
}

fn settings(engine: &str) -> DevelopSettings {
    let mut settings = DevelopSettings::neutral();
    settings.engine = engine.into();
    settings.look = LOOK_NIHO_STANDARD_1.into();
    settings.exposure = 0.37;
    settings.contrast = 23.0;
    settings.highlights = -40.0;
    settings.shadows = 30.0;
    settings.vibrance = 27.0;
    settings
}

#[test]
fn parses_as_opt_in_without_changing_constructor_defaults() {
    assert_eq!(
        parse_settings(r#"{"engine":"niho-8","look":"niho-standard-1"}"#)
            .unwrap()
            .engine,
        ENGINE_NIHO_8
    );
    assert_eq!(DevelopSettings::neutral().engine, "niho-1");
    assert_eq!(DevelopSettings::new_edit().engine, "niho-1");
}

#[test]
fn float_cubes_follow_interactive_and_final_dimensions() {
    let settings = settings(ENGINE_NIHO_8);
    for (quality, dimension) in [
        (Quality::Interactive, INTERACTIVE_TONE_CUBE_DIMENSION),
        (Quality::Final, 64),
    ] {
        let raster = settings_cubes(
            &settings,
            settings.exposure,
            quality,
            None,
            true,
            None,
            false,
        );
        assert!(raster.acr3.is_none());
        assert_eq!(raster.post.unwrap().dimension(), dimension);
        assert_eq!(raster.color.unwrap().dimension(), dimension);

        let raw = settings_cubes(
            &settings,
            0.0,
            quality,
            None,
            true,
            niho_develop::pipeline::raw_look_tone(&settings),
            true,
        );
        assert_eq!(raw.acr3.unwrap().dimension(), dimension);
        assert_eq!(raw.post.unwrap().dimension(), dimension);
        assert_eq!(raw.color.unwrap().dimension(), dimension);
    }
}

#[test]
fn raster_reuses_niho6_formula_but_changes_cube_precision() {
    let png = niho_develop::encode::encode_png(
        &image()
            .data
            .chunks_exact(3)
            .flat_map(|p| {
                [
                    (p[0] * 255.0).round() as u8,
                    (p[1] * 255.0).round() as u8,
                    (p[2] * 255.0).round() as u8,
                    255,
                ]
            })
            .collect::<Vec<_>>(),
        32,
        24,
    )
    .unwrap();
    let mut niho6 = Session::open_raster(&png, 0, Filter::Lanczos3).unwrap();
    let mut niho8 = Session::open_raster(&png, 0, Filter::Lanczos3).unwrap();
    let six = settings(ENGINE_NIHO_6);
    let eight = settings(ENGINE_NIHO_8);
    let a = niho6.render(&six, 0, Quality::Final).unwrap().rgba;
    let b = niho8.render(&eight, 0, Quality::Final).unwrap().rgba;
    assert_ne!(a, b, "unquantized entries must be observable on this ramp");

    // With no P/Q operation, both candidates take exactly the same niho-6
    // H/S preparation and legacy local share.
    let mut six_hs = DevelopSettings::neutral();
    six_hs.engine = ENGINE_NIHO_6.into();
    six_hs.highlights = -40.0;
    six_hs.shadows = 30.0;
    let mut eight_hs = six_hs.clone();
    eight_hs.engine = ENGINE_NIHO_8.into();
    assert_eq!(
        niho6.render(&six_hs, 0, Quality::Final).unwrap().rgba,
        niho8.render(&eight_hs, 0, Quality::Final).unwrap().rgba
    );
}

#[test]
fn legacy_raw_is_supported_but_signed_raw_is_rejected() {
    let image = image();
    let png = encode_working_copy(&image);
    let meta = r#"{"kind":"raw","baselineEV":0,"asShotWhite":{"x":0.3457,"y":0.3585},"dcpSha256":"fixture","lookTableIncluded":true}"#;
    let mut session = Session::open_working_copy(&png, meta, Filter::Lanczos3).unwrap();
    let niho2 = session
        .render(&settings(ENGINE_NIHO_2), 0, Quality::Final)
        .unwrap()
        .rgba;
    let niho8 = session
        .render(&settings(ENGINE_NIHO_8), 0, Quality::Final)
        .unwrap()
        .rgba;
    assert_ne!(niho2, niho8);

    let (signed, encoding) = encode_signed_working_copy(&image).unwrap();
    let signed_meta = format!(
        r#"{{"kind":"raw","baselineEV":0,"asShotWhite":{{"x":0.3457,"y":0.3585}},"dcpSha256":"fixture","lookTableIncluded":false,"encoding":{{"kind":"signed-gamma18-v1","ceiling":{}}}}}"#,
        encoding.ceiling()
    );
    let error = Session::open_working_copy(&signed, &signed_meta, Filter::Lanczos3)
        .unwrap()
        .render(&settings(ENGINE_NIHO_8), 0, Quality::Final)
        .unwrap_err();
    assert!(matches!(error, Error::IncompatibleWorkingCopy(_)));
}

#[test]
fn presets_and_xmp_keep_the_explicit_candidate() {
    let base = settings(ENGINE_NIHO_8);
    let applied = xmp::apply_preset(
        xmp::builtin_preset("niho-colorful").unwrap().xmp,
        &base,
        1.0,
        None,
    )
    .unwrap();
    assert_eq!(applied.engine, ENGINE_NIHO_8);
    let written = xmp::settings_to_xmp(&applied, &xmp::XmpWriteOptions::default());
    assert!(written
        .not_written
        .iter()
        .all(|item| item != "relativeTemperature"));
}
