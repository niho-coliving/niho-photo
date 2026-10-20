use niho_develop::decode::{encode_signed_working_copy, encode_working_copy};
use niho_develop::settings::{
    ENGINE_NIHO_5, ENGINE_NIHO_7, LOOK_NIHO_STANDARD_4, LOOK_NIHO_STANDARD_5,
};
use niho_develop::{
    encode, parse_settings, render, render_camera_linear, xmp, AsShotWhite, CameraLinearWorkMeta,
    DevelopSettings, Error, Filter, LinearImage, Quality, RenderOptions, Session,
};

const PANASONIC: &str = "apple-ciraw8/linear-prophoto-d50/cal-panasonic-dc-s5-apple-v4";
const SONY_ZV: &str = "apple-ciraw8/linear-prophoto-d50/cal-sony-zv-e10m2-apple-v3";
const SONY_FX30: &str = "apple-ciraw8/linear-prophoto-d50/cal-sony-ilme-fx30-apple-v2";

fn image(width: usize, height: usize) -> LinearImage {
    let mut data = Vec::with_capacity(width * height * 3);
    for y in 0..height {
        for x in 0..width {
            if (width / 4..width * 3 / 4).contains(&x) && (height / 4..height * 3 / 4).contains(&y)
            {
                data.extend_from_slice(&[2.06, 2.06, 2.06]);
            } else {
                let u = x as f32 / width.max(1) as f32;
                let v = y as f32 / height.max(1) as f32;
                data.extend_from_slice(&[-0.08 + 0.9 * u, 0.12 + 0.7 * v, 0.2 + 0.5 * u]);
            }
        }
    }
    LinearImage {
        width,
        height,
        data,
    }
}

fn metadata(camera: &str, ceiling: Option<f64>) -> String {
    let encoding = ceiling.map_or_else(String::new, |ceiling| {
        format!(r#","encoding":{{"kind":"signed-gamma18-v1","ceiling":{ceiling}}}"#)
    });
    format!(
        r#"{{"kind":"raw","baselineEV":-0.25,"asShotWhite":{{"x":0.3127,"y":0.329,"temperature":5500,"tint":0}},"asShotWhiteAdobe":null,"whiteBalanceTable":null,"dcpSha256":"{camera}","lookTableIncluded":false{encoding}}}"#
    )
}

fn settings(engine: &str, look: &str, highlights: f64) -> DevelopSettings {
    let mut value = DevelopSettings::neutral();
    value.engine = engine.into();
    value.look = look.into();
    value.highlights = highlights;
    value.exposure = -1.0;
    value
}

fn niho7(highlights: f64) -> DevelopSettings {
    settings(ENGINE_NIHO_7, LOOK_NIHO_STANDARD_5, highlights)
}

#[test]
fn formula_and_look_are_a_new_locked_pair() {
    let value = niho7(-60.0);
    assert_eq!(parse_settings(&value.to_json()).unwrap(), value);
    for (engine, look) in [
        (ENGINE_NIHO_7, LOOK_NIHO_STANDARD_4),
        (ENGINE_NIHO_5, LOOK_NIHO_STANDARD_5),
    ] {
        assert!(parse_settings(&settings(engine, look, -60.0).to_json()).is_err());
    }

    let preset = xmp::builtin_preset("niho-colorful").unwrap().xmp;
    let applied = xmp::apply_preset(preset, &value, 1.0, None)
        .unwrap()
        .settings;
    assert_eq!(applied.engine, ENGINE_NIHO_7);
    assert_eq!(applied.look, LOOK_NIHO_STANDARD_5);
}

#[test]
fn h0_is_identical_to_published_niho5_for_all_known_cameras() {
    let source = image(80, 60);
    let (png, encoding) = encode_signed_working_copy(&source).unwrap();
    let niho5_h0 = settings(ENGINE_NIHO_5, LOOK_NIHO_STANDARD_4, 0.0);
    let niho7_h0 = niho7(0.0);
    for camera in [PANASONIC, SONY_ZV, SONY_FX30] {
        let meta = metadata(camera, Some(encoding.ceiling()));
        let mut session = Session::open_working_copy(&png, &meta, Filter::Lanczos3).unwrap();
        assert_eq!(
            session.render(&niho5_h0, 0, Quality::Final).unwrap().rgba,
            session.render(&niho7_h0, 0, Quality::Final).unwrap().rgba,
            "{camera}"
        );
    }
}

#[test]
fn negative_highlights_are_versioned() {
    let source = image(80, 60);
    let (png, encoding) = encode_signed_working_copy(&source).unwrap();
    let meta = metadata(PANASONIC, Some(encoding.ceiling()));
    let mut session = Session::open_working_copy(&png, &meta, Filter::Lanczos3).unwrap();
    let niho5_h100 = settings(ENGINE_NIHO_5, LOOK_NIHO_STANDARD_4, -100.0);
    let niho7_h100 = niho7(-100.0);
    assert_ne!(
        session.render(&niho5_h100, 0, Quality::Final).unwrap().rgba,
        session.render(&niho7_h100, 0, Quality::Final).unwrap().rgba
    );
}

#[test]
fn only_supported_signed_raw_working_copies_are_accepted() {
    let source = image(24, 18);
    let unsigned = encode_working_copy(&source);
    let mut unsigned_raw =
        Session::open_working_copy(&unsigned, &metadata(PANASONIC, None), Filter::Lanczos3)
            .unwrap();
    assert!(matches!(
        unsigned_raw.render(&niho7(-60.0), 0, Quality::Final),
        Err(Error::IncompatibleWorkingCopy(message))
            if message == "niho-7 RAW requires encoding signed-gamma18-v1"
    ));

    let (signed, encoding) = encode_signed_working_copy(&source).unwrap();
    let mut unknown = Session::open_working_copy(
        &signed,
        &metadata("unknown-calibration", Some(encoding.ceiling())),
        Filter::Lanczos3,
    )
    .unwrap();
    assert!(matches!(
        unknown.render(&niho7(-60.0), 0, Quality::Final),
        Err(Error::IncompatibleWorkingCopy(message))
            if message == "niho-7 does not support this camera calibration"
    ));

    let raster_png = encode::encode_png(&vec![127_u8; 24 * 18 * 4], 24, 18).unwrap();
    let mut raster = Session::open_raster(&raster_png, 0, Filter::Lanczos3).unwrap();
    assert!(matches!(
        raster.render(&niho7(-60.0), 0, Quality::Final),
        Err(Error::IncompatibleWorkingCopy(message))
            if message == "niho-7 supports signed RAW working copies only"
    ));
    assert!(matches!(
        render(
            &raster_png,
            &niho7(-60.0).to_json(),
            &RenderOptions::default()
        ),
        Err(Error::IncompatibleWorkingCopy(message))
            if message == "niho-7 supports signed RAW working copies only"
    ));

    let camera_meta = CameraLinearWorkMeta {
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
            &source,
            &[],
            &camera_meta,
            &niho7(-60.0),
            &RenderOptions::default()
        ),
        Err(Error::IncompatibleWorkingCopy(message))
            if message == "niho-7 supports signed RAW working copies only"
    ));
}

#[test]
fn preview_and_derived_sessions_use_full_source_analysis() {
    let source = image(64, 48);
    let (png, encoding) = encode_signed_working_copy(&source).unwrap();
    let meta = metadata(PANASONIC, Some(encoding.ceiling()));
    let open = || Session::open_working_copy(&png, &meta, Filter::Lanczos3).unwrap();
    let mut value = niho7(-70.0);
    value.color_noise_reduction = 25.0;

    let mut parent = open();
    parent.render(&value, 24, Quality::Final).unwrap();
    let mut shared = parent.thumbnail(24);
    let mut fresh = open().thumbnail(24);
    for quality in [Quality::Final, Quality::Interactive] {
        assert_eq!(
            shared.render(&value, 0, quality).unwrap().rgba,
            fresh.render(&value, 0, quality).unwrap().rgba,
            "{quality:?}"
        );
    }
    assert_eq!(
        parent.auto_settings(&value).unwrap(),
        open().auto_settings(&value).unwrap()
    );
}
