//! Upright (niho-photo#46, `src/upright.rs`): the automatic level / vertical
//! / full correction found from the photo's lines. Synthetic images only:
//! an upright "building" (window grid, pilasters, floor beams under a sky)
//! drawn through a known perspective, so the correction that stands it up
//! again is known exactly, and images without straight lines (noise,
//! circles, a gradient, soft blobs, leaning trunks). The whole file is also
//! run by the wasm-bindgen test command (`scripts/ci/run-scope.mjs`): the
//! estimates recorded on native must come out bit for bit the same.

use niho_develop::geometry::Perspective;
use niho_develop::perspective::Warp;
use niho_develop::upright::{
    line_segments, LumaFrame, Segment, UprightEstimate, UprightMode, REASON_NO_LINES,
};
use niho_develop::{DevelopSettings, Filter, Quality, Session};

const MODES: [UprightMode; 4] = [
    UprightMode::Auto,
    UprightMode::Level,
    UprightMode::Vertical,
    UprightMode::Full,
];
/// The photos' size (portrait, like most building photos).
const W: u32 = 540;
const H: u32 = 720;

fn png(width: u32, height: u32, pixel: impl Fn(u32, u32) -> [u8; 3]) -> Vec<u8> {
    let mut rgb = Vec::with_capacity((width * height * 3) as usize);
    for y in 0..height {
        for x in 0..width {
            rgb.extend_from_slice(&pixel(x, y));
        }
    }
    let img = image::RgbImage::from_raw(width, height, rgb).unwrap();
    let mut out = Vec::new();
    img.write_to(&mut std::io::Cursor::new(&mut out), image::ImageFormat::Png)
        .unwrap();
    out
}

fn gray(v: f64) -> [u8; 3] {
    let g = (v.clamp(0.0, 1.0) * 255.0).round() as u8;
    [g, g, g]
}

fn fract(x: f64) -> f64 {
    x - x.floor()
}

/// A deterministic pseudo-random number in 0..1 for pixel `(x, y)`.
fn hash01(x: u32, y: u32, salt: u32) -> f64 {
    let mut h =
        x.wrapping_mul(0x9E37_79B1) ^ y.wrapping_mul(0x85EB_CA77) ^ salt.wrapping_mul(0xC2B2_AE3D);
    h ^= h >> 15;
    h = h.wrapping_mul(0x2C1B_3C6D);
    h ^= h >> 12;
    h = h.wrapping_mul(0x297A_2D39);
    h ^= h >> 15;
    h as f64 / u32::MAX as f64
}

/// The upright building at canvas point `(x, y)` of the `W x H` canvas
/// (gray 0..1): bays every 0.09 and floors every 0.11 of the long side
/// under a sky. `slanted` adds roof-like bands at 14, -63 and 31 degrees
/// (lines that are neither vertical nor horizontal).
fn building(x: f64, y: f64, slanted: bool) -> f64 {
    let l = W.max(H) as f64;
    let (u, v) = (x / l, y / l);
    if slanted {
        for (degrees, offset, shade) in
            [(14.0f64, 0.31, 0.2), (-63.0, 0.52, 0.18), (31.0, 0.77, 0.9)]
        {
            let (s, c) = (
                libm::sin(degrees.to_radians()),
                libm::cos(degrees.to_radians()),
            );
            let d = (u - 0.5) * s - (v - 0.5) * c - (offset - 0.5);
            if fract(d / 0.37) < 0.025 {
                return shade;
            }
        }
    }
    if v < 0.12 {
        return 0.85 - 0.3 * v;
    }
    let (fx, fy) = (fract(u / 0.09), fract((v - 0.12) / 0.11));
    if fx < 0.14 {
        0.8
    } else if fy > 0.84 {
        0.32
    } else if (0.3..0.84).contains(&fx) && (0.2..0.7).contains(&fy) {
        0.14
    } else {
        0.56
    }
}

/// The gray of photo pixel `(i, j)` that `correction` stands upright: the
/// building where the correction puts the pixel (2 x 2 supersampled).
fn photo_gray(warp: Option<&Warp>, i: u32, j: u32, slanted: bool) -> f64 {
    let mut sum = 0.0;
    for (dx, dy) in [(0.25, 0.25), (0.75, 0.25), (0.25, 0.75), (0.75, 0.75)] {
        let p = [i as f64 + dx, j as f64 + dy];
        let q = match warp {
            Some(warp) => warp.to_canvas(p),
            None => Some(p),
        };
        sum += q.map_or(0.5, |q| building(q[0], q[1], slanted));
    }
    sum / 4.0
}

/// A `W x H` photo of the building that `correction` stands upright.
fn photo(correction: &Perspective, slanted: bool) -> Vec<u8> {
    let warp = Warp::new(correction, W as usize, H as usize);
    png(W, H, |i, j| gray(photo_gray(warp.as_ref(), i, j, slanted)))
}

fn perspective(rotate: f64, vertical: f64, horizontal: f64) -> Perspective {
    Perspective {
        rotate,
        vertical,
        horizontal,
        ..Perspective::default()
    }
}

/// Neutral settings with `geometry` (JSON) at the version it needs.
fn settings(geometry: &str) -> DevelopSettings {
    let mut v = DevelopSettings::neutral().to_value();
    v["geometry"] = serde_json::from_str(geometry).unwrap();
    let mut s = DevelopSettings::from_json(&v.to_string()).unwrap();
    s.v = s.required_version().max(s.v);
    assert!(s.validate().is_empty(), "{:?}", s.validate());
    s
}

fn estimate(input: &[u8], geometry: &str, mode: UprightMode) -> UprightEstimate {
    let session = Session::open_raster(input, 0, Filter::Lanczos3).unwrap();
    session.estimate_upright(&settings(geometry), mode)
}

/// `e` was found and corrects `expected` within 0.3 degrees and 3 slider
/// steps; the sliders it does not set are neutral.
fn assert_close(e: &UprightEstimate, expected: &Perspective) {
    assert_eq!(e.reason, None, "{e:?}");
    let p = &e.perspective;
    assert!(
        (p.rotate - expected.rotate).abs() <= 0.3
            && (p.vertical - expected.vertical).abs() <= 3.0
            && (p.horizontal - expected.horizontal).abs() <= 3.0,
        "{e:?} vs {expected:?}"
    );
    assert_eq!((p.aspect, p.scale, p.x, p.y), (0.0, 100.0, 0.0, 0.0));
    assert!(e.confidence > 0.5 && e.confidence <= 1.0, "{e:?}");
}

#[cfg_attr(target_arch = "wasm32", wasm_bindgen_test::wasm_bindgen_test)]
#[cfg_attr(not(target_arch = "wasm32"), test)]
fn full_finds_the_inverse_of_a_known_perspective() {
    let truth = perspective(2.5, -30.0, 20.0);
    let input = photo(&truth, false);
    let full = estimate(&input, "{}", UprightMode::Full);
    assert_close(&full, &truth);
    assert_eq!(full.mode, UprightMode::Full);
    assert!(
        full.vertical_lines >= 20 && full.horizontal_lines >= 20,
        "{full:?}"
    );
    // Auto sees that only all three stand both families up.
    let auto = estimate(&input, "{}", UprightMode::Auto);
    assert_eq!(auto.mode, UprightMode::Full, "{auto:?}");
    assert_close(&auto, &truth);
    // Vertical stands the verticals up and leaves the horizontal at 0.
    let vertical = estimate(&input, "{}", UprightMode::Vertical);
    assert_close(&vertical, &perspective(2.5, -30.0, 0.0));
    assert_eq!(vertical.perspective.horizontal, 0.0);
}

#[cfg_attr(target_arch = "wasm32", wasm_bindgen_test::wasm_bindgen_test)]
#[cfg_attr(not(target_arch = "wasm32"), test)]
fn vertical_finds_converging_verticals() {
    // A building shot from below: only the verticals converge.
    let truth = perspective(0.0, -35.0, 0.0);
    let input = photo(&truth, false);
    let vertical = estimate(&input, "{}", UprightMode::Vertical);
    assert_close(&vertical, &truth);
    assert_eq!(vertical.mode, UprightMode::Vertical);
    assert_eq!(vertical.perspective.horizontal, 0.0);
    let auto = estimate(&input, "{}", UprightMode::Auto);
    assert_eq!(auto.mode, UprightMode::Vertical, "{auto:?}");
    assert_close(&auto, &truth);
    // Full finds no horizontal perspective to correct.
    assert_close(&estimate(&input, "{}", UprightMode::Full), &truth);
}

#[cfg_attr(target_arch = "wasm32", wasm_bindgen_test::wasm_bindgen_test)]
#[cfg_attr(not(target_arch = "wasm32"), test)]
fn level_finds_a_tilt() {
    let truth = perspective(-3.2, 0.0, 0.0);
    let input = photo(&truth, false);
    let level = estimate(&input, "{}", UprightMode::Level);
    assert_close(&level, &truth);
    assert_eq!(level.mode, UprightMode::Level);
    assert_eq!(
        (level.perspective.vertical, level.perspective.horizontal),
        (0.0, 0.0)
    );
    let auto = estimate(&input, "{}", UprightMode::Auto);
    assert_eq!(auto.mode, UprightMode::Level, "{auto:?}");
    assert_close(&auto, &truth);
}

#[cfg_attr(target_arch = "wasm32", wasm_bindgen_test::wasm_bindgen_test)]
#[cfg_attr(not(target_arch = "wasm32"), test)]
fn an_upright_photo_is_left_about_as_it_is() {
    let input = photo(&Perspective::default(), false);
    for mode in MODES {
        let e = estimate(&input, "{}", mode);
        assert_eq!(e.reason, None, "{mode:?}");
        let p = &e.perspective;
        assert!(
            p.rotate.abs() < 0.2 && p.vertical.abs() < 1.0 && p.horizontal.abs() < 1.0,
            "{mode:?}: {e:?}"
        );
        if mode == UprightMode::Auto {
            assert_eq!(e.mode, UprightMode::Level);
        }
    }
}

#[cfg_attr(target_arch = "wasm32", wasm_bindgen_test::wasm_bindgen_test)]
#[cfg_attr(not(target_arch = "wasm32"), test)]
fn photos_without_straight_lines_are_not_corrected() {
    let cases: [(&str, Vec<u8>); 5] = [
        ("noise", png(W, H, |x, y| gray(hash01(x, y, 1)))),
        (
            "circles",
            png(W, H, |x, y| {
                let mut v = 0.5;
                for (cx, cy, r) in [
                    (270.0, 230.0, 190.0),
                    (150.0, 520.0, 110.0),
                    (410.0, 560.0, 90.0),
                    (270.0, 230.0, 90.0),
                ] {
                    let (dx, dy) = (x as f64 - cx, y as f64 - cy);
                    if dx * dx + dy * dy < r * r {
                        v = if r > 150.0 { 0.2 } else { 0.85 };
                    }
                }
                gray(v)
            }),
        ),
        (
            "gradient",
            png(W, H, |x, y| {
                gray(0.1 + 0.4 * x as f64 / W as f64 + 0.4 * y as f64 / H as f64)
            }),
        ),
        (
            "blobs",
            png(W, H, |x, y| {
                let (u, v) = (x as f64 / 60.0, y as f64 / 60.0);
                gray(
                    0.5 + 0.25 * libm::sin(u * 1.3 + 0.4) * libm::cos(v * 0.9)
                        + 0.15 * libm::sin(u * 2.7 - v * 1.9)
                        + 0.2 * (hash01(x, y, 7) - 0.5),
                )
            }),
        ),
        (
            "trunks",
            // Wobbly trunks of random lean (no two agree).
            png(W, H, |x, y| {
                let mut v = 0.7 - 0.3 * (y as f64 / H as f64);
                for k in 0..7u32 {
                    let x0 = 30.0 + k as f64 * 75.0 + 25.0 * hash01(k, 0, 3);
                    let lean = (hash01(k, 1, 3) - 0.5) * 0.5;
                    let cx = x0 + lean * y as f64 + 9.0 * libm::sin(y as f64 / 55.0 + k as f64);
                    if (x as f64 - cx).abs() < 6.0 + 3.0 * hash01(k, 2, 3) {
                        v = 0.15;
                    }
                }
                gray(v + 0.08 * (hash01(x, y, 9) - 0.5))
            }),
        ),
    ];
    for (name, input) in &cases {
        for mode in MODES {
            let e = estimate(input, "{}", mode);
            assert_eq!(e.reason, Some(REASON_NO_LINES), "{name} {mode:?}: {e:?}");
            assert_eq!(e.perspective, Perspective::default(), "{name} {mode:?}");
            assert_eq!(e.confidence, 0.0);
            assert_eq!(e.mode, mode);
        }
    }
}

#[cfg_attr(target_arch = "wasm32", wasm_bindgen_test::wasm_bindgen_test)]
#[cfg_attr(not(target_arch = "wasm32"), test)]
fn slanted_lines_do_not_pull_the_fit() {
    // Roof-like bands (about 15% of the lines' length; one within the
    // horizontal window) on the photo of the first test.
    let truth = perspective(2.5, -30.0, 20.0);
    let input = photo(&truth, true);
    assert_close(&estimate(&input, "{}", UprightMode::Full), &truth);
    assert_close(&estimate(&input, "{}", UprightMode::Auto), &truth);
}

/// The length-weighted mean deviation (degrees) of `segments` at least
/// `min_length` long from vertical (those within 25 degrees of it) and
/// from horizontal.
fn mean_deviation(segments: &[Segment], min_length: f64) -> (f64, f64) {
    let (mut v, mut vw, mut h, mut hw) = (0.0, 0.0, 0.0, 0.0);
    for s in segments.iter().filter(|s| s.length() >= min_length) {
        let (from_vertical, from_horizontal) =
            (s.from_vertical_degrees(), s.from_horizontal_degrees());
        if from_vertical.abs() <= 25.0 {
            v += s.length() * from_vertical.abs();
            vw += s.length();
        } else if from_horizontal.abs() <= 25.0 {
            h += s.length() * from_horizontal.abs();
            hw += s.length();
        }
    }
    assert!(vw > 0.0 && hw > 0.0);
    (v / vw, h / hw)
}

#[cfg_attr(target_arch = "wasm32", wasm_bindgen_test::wasm_bindgen_test)]
#[cfg_attr(not(target_arch = "wasm32"), test)]
fn the_correction_stands_the_rendered_lines_upright() {
    let truth = perspective(2.5, -30.0, 20.0);
    let input = photo(&truth, false);
    let mut session = Session::open_raster(&input, 0, Filter::Lanczos3).unwrap();
    let measure = |frame: &niho_develop::Rendered| {
        let luma: Vec<f32> = frame
            .rgba
            .chunks_exact(4)
            .map(|px| (px[0] as f32 + px[1] as f32 + px[2] as f32) / 3.0)
            .collect();
        let plane = LumaFrame::from_plane(frame.width, frame.height, luma);
        let segments = line_segments(plane.width, plane.height, &plane.data);
        mean_deviation(&segments, 0.05 * frame.width.max(frame.height) as f64)
    };
    let before = measure(&session.render(&settings("{}"), 0, Quality::Final).unwrap());
    assert!(before.0 > 2.0 && before.1 > 2.0, "{before:?}");
    let e = session.estimate_upright(&settings("{}"), UprightMode::Full);
    let p = e.perspective;
    let corrected = settings(&format!(
        r#"{{"perspective":{{"rotate":{},"vertical":{},"horizontal":{}}},"constrain":true,"upright":4}}"#,
        p.rotate, p.vertical, p.horizontal
    ));
    let frame = session.render(&corrected, 0, Quality::Final).unwrap();
    // "余白を埋める" cut the uncovered corners away (the output is smaller).
    assert!(frame.width < W as usize && frame.height < H as usize);
    let after = measure(&frame);
    assert!(after.0 < 0.3 && after.1 < 0.3, "{after:?}");
}

#[cfg_attr(target_arch = "wasm32", wasm_bindgen_test::wasm_bindgen_test)]
#[cfg_attr(not(target_arch = "wasm32"), test)]
fn the_frame_is_the_turned_and_flipped_photo() {
    // The same photo stored turned a quarter counter-clockwise (or
    // mirrored) and turned back by the geometry: the same frame, so the
    // same estimate bit for bit (no reduction at this size).
    let truth = perspective(2.5, -30.0, 20.0);
    let warp = Warp::new(&truth, W as usize, H as usize);
    let upright = estimate(&photo(&truth, false), "{}", UprightMode::Full);
    // Frame pixel (x, y) of a quarter turn is source pixel (y, h - 1 - x)
    // (`frame.rs`), the source being H x W.
    let stored = png(H, W, |sx, sy| {
        gray(photo_gray(warp.as_ref(), W - 1 - sy, sx, false))
    });
    assert_eq!(
        estimate(&stored, r#"{"rotate":90}"#, UprightMode::Full),
        upright
    );
    let mirrored = png(W, H, |x, y| {
        gray(photo_gray(warp.as_ref(), W - 1 - x, y, false))
    });
    assert_eq!(
        estimate(&mirrored, r#"{"flipH":true}"#, UprightMode::Full),
        upright
    );
}

#[cfg_attr(target_arch = "wasm32", wasm_bindgen_test::wasm_bindgen_test)]
#[cfg_attr(not(target_arch = "wasm32"), test)]
fn the_straighten_angle_is_taken_off() {
    // The crop already turns the result 1.2 degrees the same way: the
    // perspective's rotation adds the rest, so the result turns 3.2 in all.
    let input = photo(&perspective(3.2, 0.0, 0.0), false);
    let e = estimate(&input, r#"{"angle":1.2}"#, UprightMode::Level);
    assert_close(&e, &perspective(2.0, 0.0, 0.0));
}

#[cfg_attr(target_arch = "wasm32", wasm_bindgen_test::wasm_bindgen_test)]
#[cfg_attr(not(target_arch = "wasm32"), test)]
fn a_correction_past_the_range_stops_there_with_less_confidence() {
    let within = estimate(
        &photo(&perspective(0.0, -90.0, 0.0), false),
        "{}",
        UprightMode::Vertical,
    );
    assert_close(&within, &perspective(0.0, -90.0, 0.0));
    let past = estimate(
        &photo(&perspective(0.0, -130.0, 0.0), false),
        "{}",
        UprightMode::Vertical,
    );
    assert_eq!(past.reason, None);
    assert_eq!(past.perspective.vertical, -100.0);
    assert!(past.confidence <= 0.5 && past.confidence > 0.0, "{past:?}");
}

#[cfg_attr(target_arch = "wasm32", wasm_bindgen_test::wasm_bindgen_test)]
#[cfg_attr(not(target_arch = "wasm32"), test)]
fn the_estimate_is_deterministic_and_leaves_the_session_as_it_was() {
    let input = photo(&perspective(-1.5, 25.0, -15.0), false);
    let mut session = Session::open_raster(&input, 0, Filter::Lanczos3).unwrap();
    let s = settings(r#"{"crop":{"left":0.1,"top":0.1,"right":0.9,"bottom":0.95}}"#);
    let before = session.render(&s, 200, Quality::Final).unwrap();
    let first = session.estimate_upright(&s, UprightMode::Auto);
    for _ in 0..2 {
        assert_eq!(session.estimate_upright(&s, UprightMode::Auto), first);
    }
    let again = Session::open_raster(&input, 0, Filter::Lanczos3).unwrap();
    assert_eq!(again.estimate_upright(&s, UprightMode::Auto), first);
    // The crop does not change what is estimated (the whole frame is read).
    assert_eq!(
        session.estimate_upright(&settings("{}"), UprightMode::Auto),
        first
    );
    assert_eq!(
        session.render(&s, 200, Quality::Final).unwrap().rgba,
        before.rgba
    );
}

#[cfg_attr(target_arch = "wasm32", wasm_bindgen_test::wasm_bindgen_test)]
#[cfg_attr(not(target_arch = "wasm32"), test)]
fn the_estimate_reads_as_json() {
    let found = estimate(
        &photo(&perspective(0.0, -35.0, 0.0), false),
        "{}",
        UprightMode::Vertical,
    );
    let v = found.to_value();
    assert_eq!(v["mode"], 3);
    assert_eq!(v["perspective"]["vertical"], found.perspective.vertical);
    assert_eq!(v["perspective"]["scale"], 100.0);
    assert_eq!(v["lines"]["vertical"], found.vertical_lines);
    assert!(v.get("reason").is_none());
    let none = estimate(
        &png(W, H, |x, y| gray(hash01(x, y, 2))),
        "{}",
        UprightMode::Auto,
    );
    let v = none.to_value();
    assert_eq!(v["reason"], "noLines");
    assert_eq!(v["mode"], 1);
    assert_eq!(v["confidence"], 0.0);
    assert_eq!(v["perspective"]["vertical"], 0.0);
}

#[cfg_attr(target_arch = "wasm32", wasm_bindgen_test::wasm_bindgen_test)]
#[cfg_attr(not(target_arch = "wasm32"), test)]
fn native_and_wasm_estimate_the_same() {
    let input = photo(&perspective(2.5, -30.0, 20.0), true);
    let session = Session::open_raster(&input, 0, Filter::Lanczos3).unwrap();
    let mut got = Vec::new();
    for (geometry, mode) in [
        ("{}", UprightMode::Auto),
        ("{}", UprightMode::Level),
        (r#"{"rotate":270,"angle":-2}"#, UprightMode::Full),
    ] {
        let e = session.estimate_upright(&settings(geometry), mode);
        let p = e.perspective;
        got.push((
            e.mode.number(),
            p.rotate.to_bits(),
            p.vertical.to_bits(),
            p.horizontal.to_bits(),
            e.confidence.to_bits(),
            e.vertical_lines,
            e.horizontal_lines,
        ));
    }
    assert_eq!(got, EXPECTED_ESTIMATES);
}

/// [`native_and_wasm_estimate_the_same`]'s estimates (recorded on native;
/// the wasm build must match them).
/// (rotate 2.5, vertical -29.81, horizontal 20.4 / rotate 2.28 / rotate
/// 4.5, vertical -19.36, horizontal -30.52 with confidences 0.87, 0.25 and
/// 0.87.)
const EXPECTED_ESTIMATES: [(u32, u64, u64, u64, u64, usize, usize); 3] = [
    (
        4,
        4_612_811_918_334_230_528,
        13_852_456_023_592_649_359,
        4_626_435_307_207_026_278,
        4_606_016_579_885_763_779,
        209,
        272,
    ),
    (
        2,
        4_612_316_522_375_219_773,
        0,
        0,
        4_598_258_868_974_505_212,
        212,
        272,
    ),
    (
        4,
        4_616_752_568_008_179_712,
        13_849_514_610_086_023_004,
        13_852_655_870_826_113_925,
        4_606_012_665_770_541_935,
        272,
        209,
    ),
];
