//! `niho-12` (#29) is the float-cube engine for new raster and legacy
//! (unsigned) RAW edits: the `niho-10` raster formula and the `niho-2` legacy
//! RAW formula, with unquantized f32 entries in the look/ACR3, P and Q cubes.
//! Its pixels are frozen once saved; signed RAW and camera-linear input are
//! refused.

use niho_develop::decode::{encode_signed_working_copy, encode_working_copy, LinearImage};
use niho_develop::pipeline::{settings_cubes, INTERACTIVE_TONE_CUBE_DIMENSION};
use niho_develop::settings::{
    ENGINE_NIHO_10, ENGINE_NIHO_12, ENGINE_NIHO_2, ENGINE_NIHO_8, LOOK_NIHO_STANDARD_1,
};
use niho_develop::{
    parse_settings, render_camera_linear, xmp, AsShotWhite, CameraLinearWorkMeta, DevelopSettings,
    Error, Filter, Quality, RenderOptions, Session,
};

const LEGACY_RAW_META: &str = r#"{"kind":"raw","baselineEV":0,"asShotWhite":{"x":0.3457,"y":0.3585},"dcpSha256":"fixture","lookTableIncluded":true}"#;

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

fn png() -> Vec<u8> {
    let source = image();
    let rgba: Vec<u8> = source
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
        .collect();
    niho_develop::encode::encode_png(&rgba, source.width, source.height).unwrap()
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
    settings.saturation = -35.0;
    settings
}

fn with_engine(settings: &DevelopSettings, engine: &str) -> DevelopSettings {
    let mut settings = settings.clone();
    settings.engine = engine.into();
    settings
}

#[test]
fn parses_as_a_reader_capability_without_changing_constructor_defaults() {
    assert_eq!(
        parse_settings(r#"{"engine":"niho-12","look":"niho-standard-1"}"#)
            .unwrap()
            .engine,
        ENGINE_NIHO_12
    );
    assert_eq!(niho_develop::ENGINE_VERSION, ENGINE_NIHO_12);
    // Crate constructors keep their compatibility default; the product
    // default for new edits is chosen by the clients (`develop-settings.ts`).
    assert_eq!(DevelopSettings::neutral().engine, "niho-1");
    assert_eq!(DevelopSettings::new_edit().engine, "niho-1");
    // The legacy RAW formula has no signed-RAW look.
    assert!(parse_settings(r#"{"v":1,"engine":"niho-12","look":"niho-standard-5"}"#).is_err());
}

#[test]
fn float_cubes_follow_interactive_and_final_dimensions() {
    let settings = settings(ENGINE_NIHO_12);
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
fn raster_is_the_niho10_formula_with_float_cube_p() {
    let png = png();
    let mut niho10 = Session::open_raster(&png, 0, Filter::Lanczos3).unwrap();
    let mut niho12 = Session::open_raster(&png, 0, Filter::Lanczos3).unwrap();
    let ten = settings(ENGINE_NIHO_10);
    let twelve = settings(ENGINE_NIHO_12);
    assert_ne!(
        niho10.render(&ten, 0, Quality::Final).unwrap().rgba,
        niho12.render(&twelve, 0, Quality::Final).unwrap().rgba,
        "unquantized cube P entries must be observable on this ramp"
    );

    // Without a cube P operation the only remaining cube is Q, which
    // `niho-10` already keeps in f32: hue-stable saturation, Vibrance, HSL
    // and the niho-6 H/S response are byte-identical.
    let mut q_only = DevelopSettings::neutral();
    q_only.engine = ENGINE_NIHO_10.into();
    q_only.look = LOOK_NIHO_STANDARD_1.into();
    q_only.highlights = -40.0;
    q_only.shadows = 30.0;
    q_only.vibrance = 27.0;
    q_only.saturation = -50.0;
    let value = q_only.to_value();
    let mut hsl = value.clone();
    hsl["hsl"] = serde_json::json!({"orange":{"hue":12,"saturation":-30,"luminance":15}});
    let q_only = DevelopSettings::from_json(&hsl.to_string()).unwrap();
    for quality in [Quality::Final, Quality::Interactive] {
        assert_eq!(
            niho10.render(&q_only, 0, quality).unwrap().rgba,
            niho12
                .render(&with_engine(&q_only, ENGINE_NIHO_12), 0, quality)
                .unwrap()
                .rgba
        );
    }

    // A neutral raster edit goes through no cube: `niho-2` (what a native
    // export of an untouched photo is handed) draws the same bytes.
    let mut neutral = DevelopSettings::new_edit();
    neutral.engine = ENGINE_NIHO_12.into();
    assert_eq!(
        niho12.render(&neutral, 0, Quality::Final).unwrap().rgba,
        niho10
            .render(&with_engine(&neutral, ENGINE_NIHO_2), 0, Quality::Final)
            .unwrap()
            .rgba
    );
}

#[test]
fn legacy_raw_is_the_niho8_raw_path_and_signed_raw_is_rejected() {
    let image = image();
    let png = encode_working_copy(&image);
    let mut session = Session::open_working_copy(&png, LEGACY_RAW_META, Filter::Lanczos3).unwrap();
    for quality in [Quality::Final, Quality::Interactive] {
        let niho2 = session
            .render(&settings(ENGINE_NIHO_2), 0, quality)
            .unwrap()
            .rgba;
        let niho8 = session
            .render(&settings(ENGINE_NIHO_8), 0, quality)
            .unwrap()
            .rgba;
        let niho12 = session
            .render(&settings(ENGINE_NIHO_12), 0, quality)
            .unwrap()
            .rgba;
        assert_ne!(niho2, niho12);
        // The raster-only hue restoration never reaches the legacy RAW
        // formula: niho-12 RAW is exactly the niho-8 RAW path.
        assert_eq!(niho8, niho12);
    }
    let sample = |engine: &str| {
        Session::open_working_copy(&png, LEGACY_RAW_META, Filter::Lanczos3)
            .unwrap()
            .sample_color(&settings(engine), 0, 0.7, 0.4)
            .unwrap()
    };
    assert_eq!(sample(ENGINE_NIHO_12), sample(ENGINE_NIHO_8));

    let (signed, encoding) = encode_signed_working_copy(&image).unwrap();
    let signed_meta = format!(
        r#"{{"kind":"raw","baselineEV":0,"asShotWhite":{{"x":0.3457,"y":0.3585}},"dcpSha256":"fixture","lookTableIncluded":false,"encoding":{{"kind":"signed-gamma18-v1","ceiling":{}}}}}"#,
        encoding.ceiling()
    );
    let error = Session::open_working_copy(&signed, &signed_meta, Filter::Lanczos3)
        .unwrap()
        .render(&settings(ENGINE_NIHO_12), 0, Quality::Final)
        .unwrap_err();
    assert!(matches!(
        error,
        Error::IncompatibleWorkingCopy(message)
            if message == "niho-12 does not define signed-gamma18-v1 semantics; use niho-3/4/5/7/11"
    ));
}

#[test]
fn camera_linear_input_is_rejected() {
    let meta = CameraLinearWorkMeta {
        expected_dcp_sha256: "0".repeat(64),
        expected_unique_camera_model: "fixture".into(),
        base_version: "fixture".into(),
        as_shot_camera_neutral: [0.5, 1.0, 0.75],
        raw_baseline_ev: 0.0,
        as_shot_white: AsShotWhite {
            x: 0.3127,
            y: 0.329,
            temperature: Some(5500.0),
            tint: Some(0.0),
        },
    };
    assert!(matches!(
        render_camera_linear(
            &image(),
            &[],
            &meta,
            &settings(ENGINE_NIHO_12),
            &RenderOptions::default()
        ),
        Err(Error::IncompatibleWorkingCopy(message))
            if message == "niho-12 camera-linear input is unsupported; use a raster or legacy unsigned RAW working copy"
    ));
}

#[test]
fn presets_and_xmp_keep_niho12() {
    let base = settings(ENGINE_NIHO_12);
    for preset in ["niho-colorful", "niho-bluesky2", "niho-pastel"] {
        let applied =
            xmp::apply_preset(xmp::builtin_preset(preset).unwrap().xmp, &base, 1.0, None).unwrap();
        assert_eq!(applied.settings.engine, ENGINE_NIHO_12, "{preset}");
        assert_eq!(applied.settings.look, LOOK_NIHO_STANDARD_1);
        let partial =
            xmp::apply_preset(xmp::builtin_preset(preset).unwrap().xmp, &base, 0.4, None).unwrap();
        assert_eq!(partial.settings.engine, ENGINE_NIHO_12, "{preset} 40%");
    }
    // A preset whose incremental white balance promotes niho-1 to niho-2
    // never demotes a niho-12 photo.
    let incremental = r#"<x:xmpmeta xmlns:x="adobe:ns:meta/"><rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#"><rdf:Description xmlns:crs="http://ns.adobe.com/camera-raw-settings/1.0/" crs:WhiteBalance="Custom" crs:IncrementalTemperature="12" crs:IncrementalTint="-4"/></rdf:RDF></x:xmpmeta>"#;
    let promoted = xmp::apply_preset(incremental, &DevelopSettings::neutral(), 1.0, None).unwrap();
    assert_eq!(promoted.settings.engine, ENGINE_NIHO_2);
    let kept = xmp::apply_preset(incremental, &base, 1.0, None).unwrap();
    assert_eq!(kept.settings.engine, ENGINE_NIHO_12);
    let written = xmp::settings_to_xmp(&kept.settings, &xmp::XmpWriteOptions::default());
    assert!(written
        .not_written
        .iter()
        .all(|item| item != "relativeTemperature"));
}

#[test]
fn sessions_crops_released_drags_and_precision_cache_are_consistent() {
    let png = png();
    let mut session = Session::open_raster(&png, 0, Filter::Lanczos3).unwrap();
    let legacy = settings(ENGINE_NIHO_10);
    let original = session.render(&legacy, 0, Quality::Final).unwrap().rgba;
    let candidate = settings(ENGINE_NIHO_12);
    for crop in [false, true] {
        let mut value = candidate.to_value();
        if crop {
            value["v"] = 2.into();
            value["geometry"] = serde_json::json!({"rotate":90,"angle":3.0,"crop":{"left":0.1,"top":0.15,"right":0.85,"bottom":0.9}});
        }
        let settings = DevelopSettings::from_json(&value.to_string()).unwrap();
        let expected = niho_develop::render(
            &png,
            &settings.to_json(),
            &RenderOptions {
                max_dimension: 0,
                ..Default::default()
            },
        )
        .unwrap();
        session.render(&settings, 0, Quality::Interactive).unwrap();
        let released = session.render(&settings, 0, Quality::Final).unwrap();
        assert_eq!(
            (released.width, released.height),
            (expected.width, expected.height)
        );
        assert_eq!(released.rgba, expected.rgba);
    }
    assert_eq!(
        session.render(&legacy, 0, Quality::Final).unwrap().rgba,
        original,
        "the float cube cache must never alter a previously rendered niho-10 frame"
    );
}
