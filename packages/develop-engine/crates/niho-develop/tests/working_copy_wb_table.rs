//! A RAW working copy that carries its camera's white-balance table
//! (`whiteBalanceTable`, S11 #17108) takes Apple's own matrix for the
//! absolute white balance: the frame is the one of the working copy whose
//! pixels were re-rendered at the target white (up to the 16-bit
//! quantization), and it is no longer an approximation. Without a usable
//! table (failed self-check, no as-shot K / tint on the table's scale) the
//! chromatic adaptation stays.

use niho_develop::color::{mat_vec_f32, to_f32, Mat3};
use niho_develop::decode::{self, LinearImage};
use niho_develop::settings::{WhiteBalance, WhiteBalanceMode};
use niho_develop::wb_table::WhiteBalanceTable;
use niho_develop::{DevelopSettings, Filter, Quality, Rendered, Session, WorkingCopyMeta};
use serde_json::{json, Value};

const FIXTURE: &str = include_str!("fixtures/wb/wb-table-parity.json");

/// The DC-S5 table, in the shape stage 1 writes after a passed self-check.
fn table() -> Value {
    let fixture: Value = serde_json::from_str(FIXTURE).unwrap();
    fixture["whiteBalanceTable"].clone()
}

fn transfer(as_shot: (f64, f64), target: (f64, f64)) -> Mat3 {
    WhiteBalanceTable::from_meta(&table())
        .unwrap()
        .unwrap()
        .working_copy_transfer(as_shot, target)
        .unwrap()
}

/// A low-saturation linear ProPhoto gradient: every channel stays inside
/// the working-copy range (0..2) after the white-balance matrices here.
fn working_copy() -> Vec<u8> {
    let (w, h) = (96usize, 64usize);
    let mut data = Vec::with_capacity(w * h * 3);
    for y in 0..h {
        for x in 0..w {
            let t = x as f32 / (w - 1) as f32;
            let u = y as f32 / (h - 1) as f32;
            data.extend_from_slice(&[0.05 + 0.35 * t, 0.06 + 0.3 * u, 0.07 + 0.25 * (1.0 - t)]);
        }
    }
    decode::encode_working_copy(&LinearImage {
        width: w,
        height: h,
        data,
    })
}

/// The working copy re-rendered at another white: its decoded pixels times
/// `m` (as the renderer applies it), encoded again.
fn premultiplied(png: &[u8], m: &Mat3) -> Vec<u8> {
    let decoded = decode::decode_working_copy(png, 0, Filter::Lanczos3).unwrap();
    let m = to_f32(m);
    let mut data = Vec::with_capacity(decoded.data.len());
    for px in decoded.data.chunks_exact(3) {
        let v = mat_vec_f32(&m, [px[0], px[1], px[2]]);
        assert!(v.iter().all(|c| *c > 0.0 && *c < 2.0), "{v:?} leaves 0..2");
        data.extend_from_slice(&v);
    }
    decode::encode_working_copy(&LinearImage {
        width: decoded.width,
        height: decoded.height,
        data,
    })
}

/// Stage 1's own as-shot white (Lightroom-scale K / tint without a map).
fn apple() -> Value {
    json!({"x": 0.3324, "y": 0.3474, "temperature": 5400, "tint": 4})
}

/// Adobe's reading of it (a per-model `whiteBalanceMap`).
fn adobe() -> Value {
    json!({"x": 0.3301, "y": 0.3431, "temperature": 5550, "tint": 6.1,
           "source": "uv-offset", "du": -0.0068, "dv": 0})
}

fn meta(as_shot: Value, adobe: Option<Value>, table: Option<Value>) -> String {
    let mut meta = json!({"kind": "raw", "baselineEV": 0.2, "asShotWhite": as_shot,
                          "dcpSha256": "t", "lookTableIncluded": true});
    if let Some(adobe) = adobe {
        meta["asShotWhiteAdobe"] = adobe;
    }
    if let Some(table) = table {
        meta["whiteBalanceTable"] = table;
    }
    meta.to_string()
}

fn absolute(temperature: f64, tint: f64) -> DevelopSettings {
    let mut s = DevelopSettings::neutral();
    s.white_balance = WhiteBalance {
        mode: WhiteBalanceMode::Absolute,
        temperature: Some(temperature),
        tint: Some(tint),
    };
    s
}

/// Edits outside the white balance, the same on both sides of a comparison.
fn edited(mut s: DevelopSettings) -> DevelopSettings {
    s.exposure = 0.4;
    s.contrast = 25.0;
    s.vibrance = 15.0;
    s
}

fn render(png: &[u8], meta: &str, settings: &DevelopSettings) -> Rendered {
    let mut session = Session::open_working_copy(png, meta, Filter::Lanczos3).unwrap();
    session.render(settings, 0, Quality::Final).unwrap()
}

fn approximates(frame: &Rendered) -> bool {
    frame.approximations.contains(&"absoluteWhiteBalance")
}

fn max_difference(a: &Rendered, b: &Rendered) -> u8 {
    assert_eq!((a.width, a.height), (b.width, b.height));
    a.rgba
        .iter()
        .zip(&b.rgba)
        .map(|(x, y)| x.abs_diff(*y))
        .max()
        .unwrap()
}

#[test]
fn the_table_renders_the_white_as_apples_decoder_does() {
    let png = working_copy();
    let with_table = meta(apple(), None, Some(table()));
    let as_shot = meta(apple(), None, None);
    let m = transfer((5400.0, 4.0), (4200.0, 8.0));
    let rerendered = premultiplied(&png, &m);
    for (target, developed_as_shot) in [
        (absolute(4200.0, 8.0), DevelopSettings::neutral()),
        (
            edited(absolute(4200.0, 8.0)),
            edited(DevelopSettings::neutral()),
        ),
    ] {
        let frame = render(&png, &with_table, &target);
        assert!(!approximates(&frame), "{:?}", frame.approximations);
        assert!(frame.approximations.contains(&"dcpLookTableNotApplied"));
        let expected = render(&rerendered, &as_shot, &developed_as_shot);
        let difference = max_difference(&frame, &expected);
        assert!(
            difference <= 1,
            "{difference} levels off the re-rendered copy"
        );
        // The approximation (no table) lands elsewhere.
        let approximated = render(&png, &as_shot, &target);
        assert!(approximates(&approximated));
        assert!(max_difference(&frame, &approximated) > 1);
    }
}

#[test]
fn the_table_starts_from_adobes_as_shot_white_when_the_working_copy_has_it() {
    let png = working_copy();
    let warm = absolute(4200.0, 8.0);
    let frame = render(&png, &meta(apple(), Some(adobe()), Some(table())), &warm);
    assert!(!approximates(&frame), "{:?}", frame.approximations);
    let m = transfer((5550.0, 6.1), (4200.0, 8.0));
    let expected = render(
        &premultiplied(&png, &m),
        &meta(apple(), None, None),
        &DevelopSettings::neutral(),
    );
    assert!(max_difference(&frame, &expected) <= 1);
    let from_apple = render(&png, &meta(apple(), None, Some(table())), &warm);
    assert!(max_difference(&frame, &from_apple) > 1);
}

#[test]
fn without_the_as_shot_white_on_the_tables_scale_the_approximation_stays() {
    let png = working_copy();
    let warm = absolute(4200.0, 8.0);
    // Adobe's reading without K / tint: Apple's own K / tint are on another
    // scale, so they are not used instead.
    let adobe_xy = json!({"x": 0.3301, "y": 0.3431});
    let frame = render(
        &png,
        &meta(apple(), Some(adobe_xy.clone()), Some(table())),
        &warm,
    );
    assert!(approximates(&frame));
    let without_table = render(&png, &meta(apple(), Some(adobe_xy), None), &warm);
    assert_eq!(frame.rgba, without_table.rgba);
    // No K / tint at all.
    let apple_xy = json!({"x": 0.3324, "y": 0.3474});
    let frame = render(&png, &meta(apple_xy.clone(), None, Some(table())), &warm);
    assert!(approximates(&frame));
    assert_eq!(
        frame.rgba,
        render(&png, &meta(apple_xy, None, None), &warm).rgba
    );
}

#[test]
fn a_failed_self_check_keeps_the_approximation() {
    let png = working_copy();
    let warm = absolute(4200.0, 8.0);
    let approximated = render(&png, &meta(apple(), None, None), &warm);
    // The shape apple-raw-linear writes when the self-check fails.
    let mismatch = json!({
        "schema": "niho-develop-wb-table/v1",
        "status": "mismatch",
        "check": {"status": "mismatch", "white": {"temperature": 3400, "tint": 24},
                  "asShot": {"temperature": 5400, "tint": 4}, "residual": 0.04,
                  "pixels": 5000, "ms": 230, "reason": "the residual is above 0.01"}
    });
    // `null`: gamut mapping on, or no table for the model.
    for table in [mismatch, Value::Null] {
        let frame = render(&png, &meta(apple(), None, Some(table)), &warm);
        assert!(approximates(&frame));
        assert_eq!(frame.rgba, approximated.rgba);
    }
}

#[test]
fn only_the_absolute_white_balance_reads_the_table() {
    let png = working_copy();
    let with_table = meta(apple(), Some(adobe()), Some(table()));
    let without = meta(apple(), Some(adobe()), None);
    let mut relative = DevelopSettings::neutral();
    relative.white_balance.mode = WhiteBalanceMode::Relative;
    relative.relative_temperature = 20.0;
    relative.relative_tint = -10.0;
    for s in [
        DevelopSettings::neutral(),
        edited(DevelopSettings::neutral()),
        relative,
    ] {
        let frame = render(&png, &with_table, &s);
        assert!(!approximates(&frame));
        assert_eq!(frame.rgba, render(&png, &without, &s).rgba);
    }
}

#[test]
fn a_malformed_table_is_rejected() {
    let png = working_copy();
    let mut broken = table();
    broken["inverseMatrices"][7] = json!([1.0, 0.0, 0.0]);
    let err = WorkingCopyMeta::from_json(&meta(apple(), None, Some(broken))).unwrap_err();
    assert!(
        err.to_string()
            .contains("whiteBalanceTable.inverseMatrices[7]"),
        "{err}"
    );
    let mut other_space = table();
    other_space["space"] = json!("camera-native");
    let err = Session::open_working_copy(
        &png,
        &meta(apple(), None, Some(other_space)),
        Filter::Lanczos3,
    )
    .err()
    .expect("rejected");
    assert!(err.to_string().contains("whiteBalanceTable.space"), "{err}");
    // A later schema is not read: the working copy opens and approximates.
    let mut later = table();
    later["schema"] = json!("niho-develop-wb-table/v2");
    let frame = render(
        &png,
        &meta(apple(), None, Some(later)),
        &absolute(4200.0, 8.0),
    );
    assert!(approximates(&frame));
}
