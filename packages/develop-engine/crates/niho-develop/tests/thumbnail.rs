//! Preset previews (`Session::thumbnail`, Issue #17121 F2a): a separate
//! small session from the decoded input, which leaves the photo's session
//! (and its next drag frame) as it was.

use niho_develop::decode::{self, LinearImage};
use niho_develop::settings::{WhiteBalance, WhiteBalanceMode};
use niho_develop::{
    xmp, DevelopSettings, Filter, LightroomWhite, Quality, Session, THUMBNAIL_MAX_DIMENSION,
};

fn fixture(name: &str) -> Vec<u8> {
    std::fs::read(format!(
        "{}/../../fixtures/golden/input/{name}",
        env!("CARGO_MANIFEST_DIR")
    ))
    .unwrap()
}

fn preset(id: &str) -> DevelopSettings {
    xmp::preset_settings(xmp::builtin_preset(id).unwrap().xmp, None)
        .unwrap()
        .settings
}

fn long_side(s: &Session) -> usize {
    let (w, h) = s.source_size();
    w.max(h)
}

#[test]
fn thumbnails_have_the_asked_long_side_up_to_the_limit() {
    let photo = Session::open_raster(&fixture("dsc02072.jpg"), 1200, Filter::Lanczos3).unwrap();
    assert_eq!(long_side(&photo), 1200);
    assert_eq!(long_side(&photo.thumbnail(384)), 384);
    assert_eq!(long_side(&photo.thumbnail(256)), 256);
    assert_eq!(long_side(&photo.thumbnail(2000)), THUMBNAIL_MAX_DIMENSION);
    assert_eq!(long_side(&photo.thumbnail(0)), THUMBNAIL_MAX_DIMENSION);
    let (w, h) = photo.source_size();
    let (tw, th) = photo.thumbnail(384).source_size();
    assert!((tw as f64 / th as f64 - w as f64 / h as f64).abs() < 0.01);
    // Never enlarged.
    let small = Session::open_raster(&fixture("dsc02072.jpg"), 200, Filter::Lanczos3).unwrap();
    assert_eq!(small.thumbnail(384).source_size(), small.source_size());
    assert!(photo.working_copy_meta().is_none());
    assert!(photo.as_shot_white().is_none());
}

#[test]
fn a_thumbnail_renders_like_the_photo_at_that_size() {
    let photo = Session::open_raster(&fixture("dsc02078.jpg"), 1200, Filter::Lanczos3).unwrap();
    let settings = preset("niho-pastel");
    let mut fresh = Session::open_raster(&fixture("dsc02078.jpg"), 1200, Filter::Lanczos3).unwrap();
    let want = fresh.render(&settings, 384, Quality::Final).unwrap();
    let got = photo
        .thumbnail(384)
        .render(&settings, 0, Quality::Final)
        .unwrap();
    assert_eq!((got.width, got.height), (want.width, want.height));
    assert_eq!(got.rgba, want.rgba);
}

#[test]
fn previews_leave_the_next_drag_frame_as_it_was() {
    let input = fixture("dsc02150.jpg");
    let released = preset("niho-bluesky2");
    let mut dragged = released.clone();
    dragged.vibrance += 10.0;
    dragged.shadows += 5.0;
    let frames = |previews: bool| {
        let mut photo = Session::open_raster(&input, 1200, Filter::Lanczos3).unwrap();
        photo.render(&released, 800, Quality::Final).unwrap();
        if previews {
            let mut small = photo.thumbnail(320);
            for id in ["niho-bluesky2", "niho-pastel", "niho-colorful"] {
                small.render(&preset(id), 0, Quality::Final).unwrap();
            }
        }
        let drag = photo.render(&dragged, 800, Quality::Interactive).unwrap();
        let exact = photo.render(&dragged, 800, Quality::Final).unwrap();
        (drag.rgba, exact.rgba)
    };
    assert_eq!(frames(true), frames(false));
}

fn working_copy() -> Vec<u8> {
    let (w, h) = (600usize, 400usize);
    let mut data = Vec::with_capacity(w * h * 3);
    for y in 0..h {
        for x in 0..w {
            let t = x as f32 / (w - 1) as f32;
            let u = y as f32 / (h - 1) as f32;
            data.extend_from_slice(&[0.03 + 0.6 * t, 0.05 + 0.4 * u, 0.08 + 0.3 * (1.0 - t)]);
        }
    }
    decode::encode_working_copy(&LinearImage {
        width: w,
        height: h,
        data,
    })
}

#[test]
fn a_working_copy_thumbnail_keeps_its_metadata() {
    let meta = r#"{"kind":"raw","baselineEV":0.35,"asShotWhite":{"x":0.3324,"y":0.3474,"temperature":5400,"tint":4},"asShotWhiteAdobe":{"x":0.3301,"y":0.3431,"temperature":5550,"tint":6.1},"dcpSha256":"t","lookTableIncluded":true}"#;
    let png = working_copy();
    let photo = Session::open_working_copy(&png, meta, Filter::Lanczos3).unwrap();
    let small = photo.thumbnail(300);
    assert_eq!(small.source_size(), (300, 200));
    assert_eq!(small.working_copy_meta(), photo.working_copy_meta());
    assert_eq!(
        small.as_shot_white(),
        Some(LightroomWhite {
            temperature: 5550.0,
            tint: 6.1
        })
    );
    // The absolute white adapts from the same white as the photo's.
    let mut warm = DevelopSettings::neutral();
    warm.white_balance = WhiteBalance {
        mode: WhiteBalanceMode::Absolute,
        temperature: Some(4200.0),
        tint: Some(8.0),
    };
    let mut fresh = Session::open_working_copy(&png, meta, Filter::Lanczos3).unwrap();
    let want = fresh.render(&warm, 300, Quality::Final).unwrap();
    let mut small = small;
    assert_eq!(
        small.render(&warm, 0, Quality::Final).unwrap().rgba,
        want.rgba
    );
}
