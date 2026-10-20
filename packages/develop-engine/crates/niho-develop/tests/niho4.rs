use niho_develop::decode::{encode_signed_working_copy, encode_working_copy};
use niho_develop::settings::{ENGINE_NIHO_4, LOOK_NIHO_STANDARD_3};
use niho_develop::{
    encode, parse_settings, render, xmp, DevelopSettings, Error, Filter, LinearImage, Quality,
    RenderOptions, Session,
};

const PANASONIC: &str = "apple-ciraw8/linear-prophoto-d50/cal-panasonic-dc-s5-apple-v4";
const SONY_ZV: &str = "apple-ciraw8/linear-prophoto-d50/cal-sony-zv-e10m2-apple-v3";
const SONY_FX30: &str = "apple-ciraw8/linear-prophoto-d50/cal-sony-ilme-fx30-apple-v2";

fn image(width: usize, height: usize) -> LinearImage {
    let mut data = Vec::with_capacity(width * height * 3);
    for y in 0..height {
        for x in 0..width {
            let u = x as f32 / width.max(1) as f32;
            let v = y as f32 / height.max(1) as f32;
            data.extend_from_slice(&[-0.08 + 2.2 * u, 0.03 + 1.4 * v, 0.06 + 0.9 * (u - v).abs()]);
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
        r#"{{"kind":"raw","baselineEV":-0.25,"asShotWhite":{{"x":0.3127,"y":0.329,"temperature":5500,"tint":4}},"asShotWhiteAdobe":null,"whiteBalanceTable":null,"dcpSha256":"{camera}","lookTableIncluded":false{encoding}}}"#
    )
}

fn niho4() -> DevelopSettings {
    let mut settings = DevelopSettings::neutral();
    settings.engine = ENGINE_NIHO_4.into();
    settings.look = LOOK_NIHO_STANDARD_3.into();
    settings.highlights = -55.0;
    settings.shadows = 42.0;
    settings
}

#[test]
fn engine_look_pair_round_trips_and_cross_pairs_fail_closed() {
    let settings = niho4();
    let json = settings.to_json();
    assert_eq!(DevelopSettings::from_json(&json).unwrap(), settings);
    assert_eq!(
        parse_settings(r#"{"engine":"niho-4","look":"niho-standard-2"}"#)
            .unwrap_err()
            .to_string(),
        "invalid_settings: look (engineLookMismatch): niho-4 requires niho-standard-3, and niho-standard-3 requires niho-4"
    );
    assert!(parse_settings(r#"{"engine":"niho-3","look":"niho-standard-3"}"#).is_err());

    let preset = xmp::builtin_preset("niho-colorful").unwrap().xmp;
    let applied = xmp::apply_preset(preset, &settings, 1.0, None)
        .unwrap()
        .settings;
    assert_eq!(applied.engine, ENGINE_NIHO_4);
    assert_eq!(applied.look, LOOK_NIHO_STANDARD_3);
    assert_eq!(applied.color_noise_reduction, 25.0);
}

#[test]
fn camera_dispatch_is_fixed_and_unsupported_calibrations_fail_closed() {
    let source = image(24, 18);
    let (png, encoding) = encode_signed_working_copy(&source).unwrap();
    let settings = niho4();
    let render = |camera| {
        Session::open_working_copy(
            &png,
            &metadata(camera, Some(encoding.ceiling())),
            Filter::Lanczos3,
        )
        .unwrap()
        .render(&settings, 0, Quality::Final)
    };

    let panasonic = render(PANASONIC).unwrap();
    let sony_zv = render(SONY_ZV).unwrap();
    let sony_fx30 = render(SONY_FX30).unwrap();
    assert_ne!(panasonic.rgba, sony_zv.rgba);
    assert_eq!(sony_zv.rgba, sony_fx30.rgba);

    for unsupported in [
        "fixture",
        "apple-ciraw8/linear-prophoto-d50/cal-panasonic-dc-s5-apple",
        "apple-ciraw8/linear-prophoto-d50/cal-panasonic-dc-s5-apple-vx",
        "apple-ciraw8/linear-prophoto-d50/cal-sony-a7iv-apple-v1",
    ] {
        assert!(matches!(
            render(unsupported),
            Err(Error::IncompatibleWorkingCopy(message))
                if message == "niho-4 does not support this camera calibration"
        ));
    }
}

#[test]
fn only_signed_raw_working_copies_are_accepted() {
    let source = image(12, 8);
    let unsigned = encode_working_copy(&source);
    let mut raw =
        Session::open_working_copy(&unsigned, &metadata(PANASONIC, None), Filter::Lanczos3)
            .unwrap();
    assert!(matches!(
        raw.render(&niho4(), 0, Quality::Final),
        Err(Error::IncompatibleWorkingCopy(message))
            if message == "niho-3/niho-4 RAW requires encoding signed-gamma18-v1"
    ));

    let rgba = vec![127_u8; 12 * 8 * 4];
    let raster_png = encode::encode_png(&rgba, 12, 8).unwrap();
    let mut raster = Session::open_raster(&raster_png, 0, Filter::Lanczos3).unwrap();
    assert!(matches!(
        raster.render(&niho4(), 0, Quality::Final),
        Err(Error::IncompatibleWorkingCopy(message))
            if message == "niho-4 supports signed RAW working copies only"
    ));
    assert!(matches!(
        render(&raster_png, &niho4().to_json(), &RenderOptions::default()),
        Err(Error::IncompatibleWorkingCopy(message))
            if message == "niho-4 supports signed RAW working copies only"
    ));
}

#[test]
fn shared_analysis_and_preview_cache_match_fresh_sessions() {
    for camera in [PANASONIC, SONY_ZV] {
        let source = image(48, 36);
        let (png, encoding) = encode_signed_working_copy(&source).unwrap();
        let meta = metadata(camera, Some(encoding.ceiling()));
        let open = || Session::open_working_copy(&png, &meta, Filter::Lanczos3).unwrap();
        let mut settings = niho4();
        settings.color_noise_reduction = 25.0;

        let mut parent = open();
        parent.render(&settings, 20, Quality::Final).unwrap();
        parent.render(&settings, 20, Quality::Interactive).unwrap();
        let mut shared = parent.thumbnail(24);
        let mut fresh = open().thumbnail(24);

        for quality in [Quality::Final, Quality::Interactive] {
            let cached = shared.render(&settings, 0, quality).unwrap();
            let uncached = fresh.render(&settings, 0, quality).unwrap();
            assert_eq!(cached.rgba, uncached.rgba, "{camera} {quality:?}");
        }

        let before_auto = parent.render(&settings, 20, Quality::Final).unwrap();
        assert_eq!(
            parent.auto_settings(&settings).unwrap(),
            open().auto_settings(&settings).unwrap()
        );
        assert_eq!(
            parent.render(&settings, 20, Quality::Final).unwrap().rgba,
            before_auto.rgba
        );
    }
}
