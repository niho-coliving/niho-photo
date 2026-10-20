//! A RAW working copy's absolute white balance adapts from Adobe's reading of
//! the as-shot white (`asShotWhiteAdobe`, S9 #16999) when the metadata carries
//! it, and from stage 1's own `asShotWhite` otherwise.

use niho_develop::decode::{self, LinearImage};
use niho_develop::settings::{WhiteBalance, WhiteBalanceMode};
use niho_develop::{DevelopSettings, Filter, Quality, Session, WorkingCopyMeta};

fn working_copy() -> Vec<u8> {
    let (w, h) = (96usize, 64usize);
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

fn meta(as_shot: &str, adobe: &str) -> String {
    format!(
        r#"{{"kind":"raw","baselineEV":0.2,"asShotWhite":{as_shot},{adobe}"dcpSha256":"t","lookTableIncluded":true}}"#
    )
}

const APPLE: &str = r#"{"x":0.3324,"y":0.3474,"temperature":5400,"tint":4}"#;
const ADOBE_XY: &str = r#"{"x":0.3301,"y":0.3431}"#;

fn render(png: &[u8], meta: &str, settings: &DevelopSettings) -> Vec<u8> {
    let mut session = Session::open_working_copy(png, meta, Filter::Lanczos3).unwrap();
    session.render(settings, 0, Quality::Final).unwrap().rgba
}

#[test]
fn absolute_white_balance_adapts_from_adobes_as_shot_white() {
    let png = working_copy();
    let mut warm = DevelopSettings::neutral();
    warm.white_balance = WhiteBalance {
        mode: WhiteBalanceMode::Absolute,
        temperature: Some(4200.0),
        tint: Some(8.0),
    };
    let adobe_field = r#""asShotWhiteAdobe":{"x":0.3301,"y":0.3431,"temperature":5550,"tint":6.1,"source":"uv-offset","du":-0.0068,"dv":0},"#;
    let from_apple = render(&png, &meta(APPLE, ""), &warm);
    let from_adobe = render(&png, &meta(APPLE, adobe_field), &warm);
    // Adobe's white is the adaptation source: the same frame as a working
    // copy whose own as-shot white were Adobe's.
    assert_eq!(from_adobe, render(&png, &meta(ADOBE_XY, ""), &warm));
    assert_ne!(from_adobe, from_apple);
    // `null` (no per-model map) is the same as absent.
    let null_field = r#""asShotWhiteAdobe":null,"#;
    assert_eq!(render(&png, &meta(APPLE, null_field), &warm), from_apple);
    // Without an absolute white balance neither white is used.
    let neutral = DevelopSettings::neutral();
    assert_eq!(
        render(&png, &meta(APPLE, adobe_field), &neutral),
        render(&png, &meta(APPLE, ""), &neutral)
    );
}

#[test]
fn a_malformed_adobe_white_is_rejected() {
    let missing_y = r#""asShotWhiteAdobe":{"x":0.33},"#;
    let err = WorkingCopyMeta::from_json(&meta(APPLE, missing_y)).unwrap_err();
    assert!(err.to_string().contains("asShotWhiteAdobe.y"), "{err}");
    assert!(WorkingCopyMeta::from_json(&meta(APPLE, r#""asShotWhiteAdobe":null,"#)).is_ok());
}

#[test]
fn lightrooms_as_shot_white_is_the_adaptation_source() {
    use niho_develop::LightroomWhite;
    let adobe = r#""asShotWhiteAdobe":{"x":0.3301,"y":0.3431,"temperature":5550,"tint":6.1},"#;
    let adobe_xy_only = r#""asShotWhiteAdobe":{"x":0.3301,"y":0.3431},"#;
    let white = |m: &str| {
        WorkingCopyMeta::from_json(m)
            .unwrap()
            .lightroom_as_shot_white()
    };
    // Adobe's reading when present (the white the absolute WB adapts from).
    assert_eq!(
        white(&meta(APPLE, adobe)),
        Some(LightroomWhite {
            temperature: 5550.0,
            tint: 6.1
        })
    );
    let m = WorkingCopyMeta::from_json(&meta(APPLE, adobe)).unwrap();
    assert_eq!(m.adobe_as_shot_white().unwrap().x, 0.3301);
    // Otherwise stage 1's own.
    assert_eq!(
        white(&meta(APPLE, "")),
        Some(LightroomWhite {
            temperature: 5400.0,
            tint: 4.0
        })
    );
    // Adobe's white without K / tint: none (not mixed with the other).
    assert_eq!(white(&meta(APPLE, adobe_xy_only)), None);
    assert_eq!(white(&meta(ADOBE_XY, "")), None);
    assert_eq!(white(r#"{"kind":"raster","iccSha256":"sRGB"}"#), None);
}
