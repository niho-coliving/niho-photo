//! "自動" (F4a #17123, `src/auto.rs`): deterministic, only the six Light
//! sliders and Vibrance change, the clipping stays within `max(before,
//! 0.1%)`, a second press barely moves, a crop is what is measured, and
//! the session's frames are kept.

use niho_develop::auto::{self, Measure, Step};
use niho_develop::color::{mat_vec_f32, SRGB_TO_PROPHOTO_F32};
use niho_develop::decode::{self, LinearImage};
use niho_develop::{encode, xmp, DevelopSettings, Filter, Quality, Session};

fn fixture(name: &str) -> Vec<u8> {
    std::fs::read(format!(
        "{}/../../fixtures/golden/input/{name}",
        env!("CARGO_MANIFEST_DIR")
    ))
    .unwrap()
}

fn bluesky2() -> DevelopSettings {
    xmp::preset_settings(xmp::builtin_preset("niho-bluesky2").unwrap().xmp, None)
        .unwrap()
        .settings
}

/// `base` with a geometry (JSON) and `v: 2`.
fn with_geometry(base: &DevelopSettings, geometry: &str) -> DevelopSettings {
    let mut v = base.to_value();
    v["v"] = 2.into();
    v["geometry"] = serde_json::from_str(geometry).unwrap();
    DevelopSettings::from_json(&v.to_string()).unwrap()
}

const RAW_META: &str = r#"{"kind":"raw","baselineEV":0.35,"asShotWhite":{"x":0.3324,"y":0.3474},"dcpSha256":"test","lookTableIncluded":true}"#;

/// A RAW-like working copy (linear ProPhoto x `gain`) made from a photo.
fn raw_working_copy(bytes: &[u8], gain: f32) -> Vec<u8> {
    let raster = decode::decode_raster(bytes, 0, Filter::Lanczos3).unwrap();
    let mut data = Vec::with_capacity(raster.image.data.len());
    for px in raster.image.data.chunks_exact(3) {
        let v = mat_vec_f32(&SRGB_TO_PROPHOTO_F32, [px[0], px[1], px[2]]);
        data.extend_from_slice(&[
            v[0].max(0.0) * gain,
            v[1].max(0.0) * gain,
            v[2].max(0.0) * gain,
        ]);
    }
    decode::encode_working_copy(&LinearImage {
        width: raster.image.width,
        height: raster.image.height,
        data,
    })
}

/// A 360 x 240 8-bit PNG of a textured scene whose encoded level at
/// `(x, y)` (0..1) is `level(t)` of a base pattern `t` in 0..1, lightly
/// tinted.
fn synthetic(level: impl Fn(f64) -> f64) -> Vec<u8> {
    let (w, h) = (360usize, 240usize);
    let mut rgba = Vec::with_capacity(w * h * 4);
    for j in 0..h {
        for i in 0..w {
            let (x, y) = (i as f64 / w as f64, j as f64 / h as f64);
            let t = (0.5
                + 0.3
                    * (std::f64::consts::TAU * 3.0 * x).sin()
                    * (std::f64::consts::TAU * 2.0 * y).cos()
                + 0.2 * (x - 0.5)
                + 0.05 * (std::f64::consts::TAU * 23.0 * (x + y)).sin())
            .clamp(0.0, 1.0);
            let l = level(t);
            let tint = 0.08 * (std::f64::consts::TAU * 2.0 * y).sin();
            for c in [l * (1.0 + tint), l, l * (1.0 - tint)] {
                rgba.push((c.clamp(0.0, 1.0) * 255.0 + 0.5) as u8);
            }
            rgba.push(255);
        }
    }
    encode::encode_png(&rgba, w, h).unwrap()
}

type Open = Box<dyn Fn() -> Session>;

/// The photos: the golden JPEGs, a RAW-like working copy, and synthetic
/// scenes too dark, too bright, flat ("sleepy") and too contrasty.
fn photos() -> Vec<(&'static str, Open)> {
    let raster = |bytes: Vec<u8>| -> Open {
        Box::new(move || Session::open_raster(&bytes, 0, Filter::Lanczos3).unwrap())
    };
    let raw = |bytes: Vec<u8>| -> Open {
        Box::new(move || Session::open_working_copy(&bytes, RAW_META, Filter::Lanczos3).unwrap())
    };
    vec![
        ("dsc02072", raster(fixture("dsc02072.jpg"))),
        ("dsc02078", raster(fixture("dsc02078.jpg"))),
        ("dsc02150", raster(fixture("dsc02150.jpg"))),
        (
            "raw dsc02150",
            raw(raw_working_copy(&fixture("dsc02150.jpg"), 0.25)),
        ),
        ("dark", raster(synthetic(|t| 0.02 + 0.22 * t))),
        ("bright", raster(synthetic(|t| 0.8 + 0.3 * t))),
        ("sleepy", raster(synthetic(|t| 0.42 + 0.14 * t))),
        (
            "contrasty",
            raster(synthetic(|t| {
                if t < 0.5 {
                    0.02 + 0.1 * t
                } else {
                    0.9 + 0.2 * t
                }
            })),
        ),
        (
            "raw dark",
            raw(raw_working_copy(&synthetic(|t| 0.05 + 0.4 * t), 0.2)),
        ),
    ]
}

/// Start settings: neutral, and a preset with a key the crate does not
/// know (kept verbatim).
fn starts() -> Vec<(&'static str, DevelopSettings)> {
    let mut preset = bluesky2().to_value();
    preset["someFutureKey"] = serde_json::json!({"kept": [1, 2]});
    vec![
        ("neutral", DevelopSettings::neutral()),
        (
            "bluesky2",
            DevelopSettings::from_json(&preset.to_string()).unwrap(),
        ),
    ]
}

const LIGHT: [&str; 7] = [
    "exposure",
    "contrast",
    "highlights",
    "shadows",
    "whites",
    "blacks",
    "vibrance",
];

fn light(s: &DevelopSettings) -> [f64; 7] {
    [
        s.exposure,
        s.contrast,
        s.highlights,
        s.shadows,
        s.whites,
        s.blacks,
        s.vibrance,
    ]
}

/// Everything but the six Light sliders and Vibrance.
fn the_rest(s: &DevelopSettings) -> serde_json::Value {
    let mut v = s.to_value();
    for k in LIGHT {
        v.as_object_mut().unwrap().remove(k);
    }
    v
}

#[test]
fn auto_is_deterministic_and_sets_only_the_light_sliders_and_vibrance() {
    for (name, open) in photos() {
        for (start, s) in starts() {
            let label = format!("{name} from {start}");
            let mut session = open();
            let a = session.auto_settings(&s).unwrap();
            let b = session.auto_settings(&s).unwrap();
            let c = open().auto_settings(&s).unwrap();
            assert_eq!(a.to_json(), b.to_json(), "{label}");
            assert_eq!(a.to_json(), c.to_json(), "{label}");
            assert!(a.validate().is_empty(), "{label}: {:?}", a.validate());
            assert_eq!(the_rest(&a), the_rest(&s), "{label}");
            // Exposure in 0.05 EV steps from the current value, the rest
            // whole numbers (the starts are whole numbers).
            let steps = (a.exposure - s.exposure) / 0.05;
            assert!(
                (steps - steps.round()).abs() < 1e-6,
                "{label}: {}",
                a.exposure
            );
            for v in &light(&a)[1..] {
                assert_eq!(*v, v.round(), "{label}");
            }
            // Never against the current value's direction.
            for (now, after) in light(&s).iter().zip(light(&a)) {
                assert!(now * (after - now) >= 0.0, "{label}: {now} -> {after}");
            }
        }
    }
}

#[test]
fn auto_does_not_clip_more_than_before_or_0_1_percent() {
    for (name, open) in photos() {
        for (start, s) in starts() {
            let label = format!("{name} from {start}");
            let mut session = open();
            let outcome = session.auto_outcome(&s).unwrap();
            // The proxy of the result, rendered on its own.
            let frame = open()
                .render(
                    &outcome.settings,
                    auto::PROXY_LONG_EDGE,
                    auto::PROXY_QUALITY,
                )
                .unwrap();
            let after = Measure::of(&frame).summary();
            let before = outcome.before;
            assert!(
                after.clipped_white <= before.clipped_white.max(auto::CLIP_FLOOR)
                    && after.clipped_black <= before.clipped_black.max(auto::CLIP_FLOOR),
                "{label}: {before:?} -> {after:?}"
            );
            if outcome.step == Step::Kept {
                assert_eq!(outcome.settings.to_json(), s.to_json(), "{label}");
            }
        }
    }
}

#[test]
fn the_rules_correct_what_the_scene_needs() {
    let press = |name: &str| {
        let (_, open) = photos().into_iter().find(|(n, _)| *n == name).unwrap();
        open().auto_outcome(&DevelopSettings::neutral()).unwrap()
    };
    // Too dark: brighter, the median toward the band.
    for name in ["dark", "raw dark"] {
        let o = press(name);
        assert!(o.deltas.exposure > 0.0, "{name}: {:?}", o.deltas);
        assert!(o.after.median > o.before.median + 0.05, "{name}: {o:?}");
    }
    // Flat: more contrast and a wider range.
    let o = press("sleepy");
    assert!(o.deltas.contrast > 0.0, "{:?}", o.deltas);
    assert!(
        o.deltas.whites > 0.0 && o.deltas.blacks < 0.0,
        "{:?}",
        o.deltas
    );
    // Very bright: darker, and highlights brought down.
    let o = press("bright");
    assert!(
        o.deltas.exposure < 0.0 && o.deltas.highlights < 0.0,
        "{:?}",
        o.deltas
    );
    // Too contrasty: shadows lifted and highlights brought down.
    let o = press("contrasty");
    assert!(
        o.deltas.shadows > 0.0 && o.deltas.highlights < 0.0,
        "{:?}",
        o.deltas
    );
}

#[test]
fn a_second_press_barely_moves() {
    for (name, open) in photos() {
        for (start, s) in starts() {
            let label = format!("{name} from {start}");
            let mut session = open();
            let first = session.auto_outcome(&s).unwrap();
            let again = session.auto_settings(&first.settings).unwrap();
            let (a, b) = (light(&first.settings), light(&again));
            // A photo whose largest exposure change of one press did not
            // bring the median into the band (too dark / too bright) goes
            // on the next time.
            let median = first.after.median;
            let at_limit = first.deltas.exposure >= 0.95 || first.deltas.exposure <= -0.45;
            if at_limit && !(auto::MEDIAN_LOW..=auto::MEDIAN_HIGH).contains(&median) {
                continue;
            }
            assert!((b[0] - a[0]).abs() <= 0.1 + 1e-9, "{label}: {a:?} -> {b:?}");
            for i in 1..7 {
                assert!((b[i] - a[i]).abs() <= 5.0, "{label}: {a:?} -> {b:?}");
            }
        }
    }
}

#[test]
fn a_crop_is_measured_within_the_crop() {
    // A dark left part (45%) and a normal right part.
    let (w, h) = (400usize, 240usize);
    let mut rgba = Vec::with_capacity(w * h * 4);
    for j in 0..h {
        for i in 0..w {
            let t = 0.5 + 0.4 * ((i * 7 + j * 3) % 37) as f64 / 37.0 - 0.2;
            let l = if i < w * 45 / 100 {
                0.05 + 0.15 * t
            } else {
                0.45 + 0.4 * t
            };
            let v = (l * 255.0 + 0.5) as u8;
            rgba.extend_from_slice(&[v, v, v, 255]);
        }
    }
    let png = encode::encode_png(&rgba, w, h).unwrap();
    let open = move || Session::open_raster(&png, 0, Filter::Lanczos3).unwrap();
    let whole = DevelopSettings::neutral();
    let crop = with_geometry(
        &whole,
        r#"{"crop":{"left":0.0,"top":0.0,"right":0.45,"bottom":1.0}}"#,
    );
    let a = open().auto_settings(&whole).unwrap();
    let b = open().auto_settings(&crop).unwrap();
    assert_ne!(light(&a), light(&b));
    assert!(b.exposure > a.exposure, "{:?} {:?}", light(&a), light(&b));
    assert_eq!(b.geometry, crop.geometry);
    assert_eq!(open().auto_settings(&crop).unwrap().to_json(), b.to_json());
}

#[test]
fn the_session_keeps_its_frames() {
    let mut s = bluesky2();
    s.highlights = -40.0;
    s.shadows = 30.0;
    let mut dragged = s.clone();
    dragged.vibrance += 7.0;
    let cropped = with_geometry(
        &s,
        r#"{"crop":{"left":0.1,"top":0.1,"right":0.9,"bottom":0.9}}"#,
    );
    let mut dragged_cropped = cropped.clone();
    dragged_cropped.vibrance += 7.0;
    let open = || Session::open_raster(&fixture("dsc02150.jpg"), 0, Filter::Lanczos3).unwrap();
    for (settings, drag) in [(&s, &dragged), (&cropped, &dragged_cropped)] {
        // A released frame, then a drag frame (it takes the released
        // frame's local pass): with and without a press in between.
        let mut plain = open();
        plain.render(settings, 600, Quality::Final).unwrap();
        let expected = plain.render(drag, 600, Quality::Interactive).unwrap();
        let mut pressed = open();
        pressed.render(settings, 600, Quality::Final).unwrap();
        pressed.auto_settings(settings).unwrap();
        let frame = pressed.render(drag, 600, Quality::Interactive).unwrap();
        assert!(frame.rgba == expected.rgba);
        // (A fresh session's drag frame differs: the kept pass was used.)
        assert!(open().render(drag, 600, Quality::Interactive).unwrap().rgba != frame.rgba);
    }
}
