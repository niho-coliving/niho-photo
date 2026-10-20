//! `niho-6` (#18397): the JPEG / PNG formula with the JPEG-trained
//! Highlights / Shadows response, and the RAW Vibrance / HSL luminance
//! responses. Saved `niho-1` / `niho-2` settings keep their pixels; `niho-6`
//! differs from `niho-2` only where those apply, and every entry point
//! renders the same frame.

use niho_develop::decode::{self, LinearImage};
use niho_develop::settings::{
    HslAdjustment, HslBand, ENGINE_NIHO_2, ENGINE_NIHO_6, LOOK_NIHO_STANDARD_1,
};
use niho_develop::{
    encode, parse_settings, render, xmp, DevelopSettings, Error, Filter, Quality, RenderOptions,
    Session,
};

fn fixture(name: &str) -> Vec<u8> {
    std::fs::read(format!(
        "{}/../../fixtures/golden/input/{name}",
        env!("CARGO_MANIFEST_DIR")
    ))
    .unwrap()
}

fn with_engine(mut settings: DevelopSettings, engine: &str) -> DevelopSettings {
    settings.engine = engine.into();
    settings.look = LOOK_NIHO_STANDARD_1.into();
    settings
}

fn tone(highlights: f64, shadows: f64) -> DevelopSettings {
    let mut s = DevelopSettings::neutral();
    s.exposure = 0.3;
    s.highlights = highlights;
    s.shadows = shadows;
    s.vibrance = 15.0;
    with_engine(s, ENGINE_NIHO_6)
}

fn one_shot(input: &[u8], settings: &DevelopSettings, max: usize) -> Vec<u8> {
    render(
        input,
        &settings.to_json(),
        &RenderOptions {
            max_dimension: max,
            ..Default::default()
        },
    )
    .unwrap()
    .rgba
}

#[test]
fn engine_is_raster_only_and_keeps_the_raster_looks() {
    let settings = tone(-40.0, 30.0);
    let json = settings.to_json();
    assert_eq!(DevelopSettings::from_json(&json).unwrap(), settings);
    assert!(parse_settings(r#"{"engine":"niho-6","look":"niho-interim-1"}"#).is_ok());
    assert!(parse_settings(r#"{"engine":"niho-6","look":"niho-standard-2"}"#).is_err());
    assert!(parse_settings(r#"{"engine":"niho-6","look":"niho-standard-3"}"#).is_err());

    let raw_meta = r#"{"kind":"raw","baselineEV":0,"asShotWhite":{"x":0.33,"y":0.34},"dcpSha256":"test","lookTableIncluded":true}"#;
    let png = decode::encode_working_copy(&LinearImage {
        width: 4,
        height: 3,
        data: (0..36).map(|i| 0.02 + i as f32 / 40.0).collect(),
    });
    let error = Session::open_working_copy(&png, raw_meta, Filter::Lanczos3)
        .unwrap()
        .render(&settings, 0, Quality::Final)
        .unwrap_err();
    assert!(
        matches!(error, Error::IncompatibleWorkingCopy(_)),
        "{error}"
    );
}

#[test]
fn without_the_response_niho_6_is_niho_2_byte_for_byte() {
    let input = fixture("dsc02072.jpg");
    // No Highlights / Shadows, and the directions the response does not take;
    // no Vibrance and no HSL luminance (the RAW responses), but Saturation
    // and HSL hue / saturation (the `niho-2` formula).
    for (h, s) in [(0.0, 0.0), (35.0, 0.0), (0.0, -25.0), (20.0, -40.0)] {
        let mut settings = tone(h, s);
        settings.vibrance = 0.0;
        settings.saturation = 18.0;
        settings.hsl.set(
            HslBand::Green,
            HslAdjustment {
                hue: 12.0,
                saturation: -25.0,
                luminance: 0.0,
            },
        );
        settings.texture = 12.0;
        settings.relative_temperature = 20.0;
        settings.white_balance.mode = niho_develop::settings::WhiteBalanceMode::Relative;
        let niho2 = with_engine(settings.clone(), ENGINE_NIHO_2);
        assert_eq!(
            one_shot(&input, &settings, 640),
            one_shot(&input, &niho2, 640)
        );
        let mut a = Session::open_raster(&input, 1024, Filter::Lanczos3).unwrap();
        let mut b = Session::open_raster(&input, 1024, Filter::Lanczos3).unwrap();
        for quality in [Quality::Interactive, Quality::Final] {
            assert_eq!(
                a.render(&settings, 512, quality).unwrap().rgba,
                b.render(&niho2, 512, quality).unwrap().rgba,
                "{h} {s} {quality:?}"
            );
        }
    }
}

#[test]
fn vibrance_hsl_luminance_and_blacks_are_the_raw_responses_on_niho_6_only() {
    // R14 / R18 (`NIHO6.md`): on a JPEG Lightroom's Vibrance, HSL luminance
    // and positive Blacks follow the RAW responses (NIHO 3 Vibrance, NIHO 4
    // HSL luminance, NIHO 3 Blacks), not the Photo Bench port that `niho-2`
    // keeps.
    let input = fixture("dsc02072.jpg");
    let mut vibrance = DevelopSettings::neutral();
    vibrance.vibrance = 40.0;
    let mut luminance = DevelopSettings::neutral();
    luminance.hsl.set(
        HslBand::Yellow,
        HslAdjustment {
            hue: 0.0,
            saturation: -18.0,
            luminance: 25.0,
        },
    );
    // R18: positive Blacks is the RAW (NIHO 3) curve on `niho-6` too.
    let mut blacks = DevelopSettings::neutral();
    blacks.blacks = 60.0;
    for settings in [vibrance, luminance, blacks] {
        let niho6 = with_engine(settings.clone(), ENGINE_NIHO_6);
        let niho2 = with_engine(settings, ENGINE_NIHO_2);
        let (a, b) = (one_shot(&input, &niho6, 640), one_shot(&input, &niho2, 640));
        assert_ne!(a, b);
        // The Session (preview / Final frames) takes the same responses.
        for quality in [Quality::Interactive, Quality::Final] {
            let mut a = Session::open_raster(&input, 1024, Filter::Lanczos3).unwrap();
            let mut b = Session::open_raster(&input, 1024, Filter::Lanczos3).unwrap();
            assert_ne!(
                a.render(&niho6, 512, quality).unwrap().rgba,
                b.render(&niho2, 512, quality).unwrap().rgba,
                "{quality:?}"
            );
        }
    }
}

#[test]
fn the_response_sees_the_exposed_photo_and_returns_to_the_same_frame() {
    // R20 (`NIHO6.md`): Lightroom decides Highlights / Shadows on the exposed
    // photo, so the coefficient maps follow the exposure. The features are
    // made once per photo; a Session that goes to another exposure and back
    // renders the same bytes.
    let input = fixture("dsc02072.jpg");
    let raster = decode::decode_raster(&input, 512, Filter::Lanczos3).unwrap();
    let space = niho_develop::niho6::SourceSpace::LinearSrgb;
    let features = niho_develop::niho6::source_features(&raster.image, space).unwrap();
    let at = |ev| {
        niho_develop::niho6::analysis_at(&features, ev)
            .unwrap()
            .maps
    };
    assert_ne!(at(0.0).highlight_a, at(0.6).highlight_a);
    assert_eq!(
        niho_develop::niho6::analysis(&raster.image, space, 0.6)
            .unwrap()
            .maps
            .highlight_a,
        at(0.6).highlight_a
    );

    let mut exposed = tone(-60.0, 30.0);
    exposed.exposure = 0.6;
    let mut flat = exposed.clone();
    flat.exposure = 0.0;
    let mut session = Session::open_raster(&input, 1024, Filter::Lanczos3).unwrap();
    let first = session.render(&exposed, 512, Quality::Final).unwrap().rgba;
    let other = session.render(&flat, 512, Quality::Final).unwrap().rgba;
    let again = session.render(&exposed, 512, Quality::Final).unwrap().rgba;
    assert_ne!(first, other);
    assert_eq!(first, again);

    // Dragging the exposure (Interactive) reuses the analysis already made;
    // the released frame (Final) is the exact one, as in a fresh session.
    for ev in [0.5, 0.3, 0.1] {
        let mut dragged = exposed.clone();
        dragged.exposure = ev;
        session.render(&dragged, 512, Quality::Interactive).unwrap();
    }
    let released = session.render(&flat, 512, Quality::Final).unwrap().rgba;
    let mut fresh = Session::open_raster(&input, 1024, Filter::Lanczos3).unwrap();
    assert_eq!(
        released,
        fresh.render(&flat, 512, Quality::Final).unwrap().rgba
    );
}

#[test]
fn the_response_changes_only_niho_6() {
    let input = fixture("dsc02072.jpg");
    let settings = tone(-70.0, 45.0);
    let niho2 = with_engine(settings.clone(), ENGINE_NIHO_2);
    assert_ne!(
        one_shot(&input, &settings, 640),
        one_shot(&input, &niho2, 640)
    );
}

#[test]
fn one_shot_session_and_released_drags_agree() {
    let input = fixture("dsc02072.jpg");
    let settings = tone(-60.0, 35.0);
    let expected = one_shot(&input, &settings, 800);
    let mut session = Session::open_raster(&input, 800, Filter::Lanczos3).unwrap();
    assert_eq!(
        session.render(&settings, 0, Quality::Final).unwrap().rgba,
        expected
    );
    // A drag at a display size, a release, and back to the zero response.
    let mut drag = settings.clone();
    drag.highlights = -30.0;
    session.render(&drag, 400, Quality::Interactive).unwrap();
    assert_eq!(
        session.render(&settings, 0, Quality::Final).unwrap().rgba,
        expected
    );
    let mut off = settings.clone();
    off.highlights = 0.0;
    off.shadows = 0.0;
    let mut fresh = Session::open_raster(&input, 800, Filter::Lanczos3).unwrap();
    assert_eq!(
        session.render(&off, 0, Quality::Final).unwrap().rgba,
        fresh.render(&off, 0, Quality::Final).unwrap().rgba
    );
    assert_eq!(
        session.render(&settings, 0, Quality::Final).unwrap().rgba,
        expected
    );
}

#[test]
fn a_crop_reads_the_whole_photo() {
    // The response is per pixel given the analysis of the whole photo, so a
    // crop renders the same pixels as the whole frame cut. The `niho-2` local
    // pass that keeps `LEGACY_SHARE` of Highlights / Shadows (R24) differs by
    // at most one code within a few columns of the crop edge, as `niho-2`
    // itself does.
    let input = fixture("dsc02072.jpg");
    let settings = tone(-80.0, 50.0);
    let mut session = Session::open_raster(&input, 600, Filter::Lanczos3).unwrap();
    let whole = session.render(&settings, 0, Quality::Final).unwrap();
    let mut cropped = settings.to_value();
    cropped["v"] = 2.into();
    cropped["geometry"] =
        serde_json::json!({"crop": {"left": 0.25, "top": 0.0, "right": 1.0, "bottom": 1.0}});
    let cropped = DevelopSettings::from_json(&cropped.to_string()).unwrap();
    let framed = session.render(&cropped, 0, Quality::Final).unwrap();
    let x0 = whole.width - framed.width;
    for y in 0..framed.height {
        for x in 0..framed.width {
            for channel in 0..3 {
                let a = i32::from(whole.rgba[(y * whole.width + x0 + x) * 4 + channel]);
                let b = i32::from(framed.rgba[(y * framed.width + x) * 4 + channel]);
                if x < 8 {
                    assert!((a - b).abs() <= 1, "row {y} column {x}: {a} vs {b}");
                } else {
                    assert_eq!(a, b, "row {y} column {x}");
                }
            }
        }
    }
}

#[test]
fn previews_and_auto_use_the_photos_analysis() {
    let input = fixture("dsc02072.jpg");
    let settings = tone(-50.0, 40.0);
    let photo = Session::open_raster(&input, 1200, Filter::Lanczos3).unwrap();
    // A preview made before the photo rendered and one made after read the
    // same analysis (the whole source's), not their own reductions.
    let mut early = photo.thumbnail(256);
    let mut parent = Session::open_raster(&input, 1200, Filter::Lanczos3).unwrap();
    parent.render(&settings, 0, Quality::Final).unwrap();
    let mut late = parent.thumbnail(256);
    assert_eq!(
        early.render(&settings, 0, Quality::Final).unwrap().rgba,
        late.render(&settings, 0, Quality::Final).unwrap().rgba
    );
    // "自動" proposes and checks niho-6 candidates on prepared frames.
    let auto = parent.auto_settings(&with_engine(DevelopSettings::neutral(), ENGINE_NIHO_6));
    assert_eq!(auto.unwrap().engine, ENGINE_NIHO_6);
}

#[test]
fn presets_and_xmp_keep_niho_6() {
    let base = with_engine(DevelopSettings::neutral(), ENGINE_NIHO_6);
    for id in ["niho-bluesky2", "niho-pastel", "niho-colorful"] {
        let preset = xmp::builtin_preset(id).unwrap().xmp;
        for amount in [0.5, 1.0] {
            let applied = xmp::apply_preset(preset, &base, amount, None)
                .unwrap()
                .settings;
            assert_eq!(applied.engine, ENGINE_NIHO_6, "{id} {amount}");
        }
    }
    let mut warm = base.clone();
    warm.white_balance.mode = niho_develop::settings::WhiteBalanceMode::Relative;
    warm.relative_temperature = 25.0;
    let written = xmp::settings_to_xmp(
        &warm,
        &xmp::XmpWriteOptions {
            groups: xmp::XmpGroup::ALL.to_vec(),
            ..Default::default()
        },
    );
    assert!(written.xmp.contains(r#"crs:WhiteBalance="Custom""#));
    assert!(written.xmp.contains(r#"crs:IncrementalTemperature="+25""#));
}

#[test]
fn raster_working_copies_take_the_response_in_prophoto() {
    // A linear ProPhoto raster working copy and the same pixels as an
    // 8-bit sRGB original get the same Highlights / Shadows response.
    let (w, h) = (96, 64);
    let mut srgb = Vec::with_capacity(w * h * 4);
    for y in 0..h {
        for x in 0..w {
            let r = (x * 255 / w) as u8;
            let g = (y * 255 / h) as u8;
            let b = ((x + y) * 255 / (w + h)) as u8;
            srgb.extend_from_slice(&[r, g, b, 255]);
        }
    }
    let png = encode::encode_png(&srgb, w, h).unwrap();
    let raster = decode::decode_raster(&png, 0, Filter::Lanczos3).unwrap();
    let prophoto: Vec<f32> = raster
        .image
        .data
        .chunks_exact(3)
        .flat_map(|px| {
            niho_develop::color::mat_vec_f32(
                &niho_develop::color::SRGB_TO_PROPHOTO_F32,
                [px[0], px[1], px[2]],
            )
        })
        .collect();
    let working = decode::encode_working_copy(&LinearImage {
        width: w,
        height: h,
        data: prophoto,
    });
    let settings = tone(-70.0, 50.0);
    let original = one_shot(&png, &settings, 0);
    let copy = Session::open_working_copy(
        &working,
        r#"{"kind":"raster","iccSha256":"sRGB"}"#,
        Filter::Lanczos3,
    )
    .unwrap()
    .render(&settings, 0, Quality::Final)
    .unwrap()
    .rgba;
    let worst = original
        .iter()
        .zip(&copy)
        .map(|(a, b)| a.abs_diff(*b))
        .max()
        .unwrap();
    assert!(worst <= 3, "16-bit working copy vs 8-bit original: {worst}");
}
