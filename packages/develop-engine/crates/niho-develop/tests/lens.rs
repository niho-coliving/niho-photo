//! The lens corrections (niho-photo#45, `src/lens.rs`): the manual
//! distortion straightens a known barrel / pincushion, the manual
//! vignetting flattens known dark corners, the chromatic aberration found
//! in a photo is removed (and nothing is found without edges or without an
//! aberration), the fringe removal neutralizes purple / green edges but not
//! large purple / green areas, the lens follows the perspective, the angle
//! and the crop, a Session estimates the aberration once per photo, the
//! settings need `v: 9`, XMP presets read, write and blend the Lens
//! Corrections panel, and native and wasm render the same bytes. Synthetic
//! images only. The whole file is also run by the wasm-bindgen test command
//! (`scripts/ci/run-scope.mjs`).

use niho_develop::decode::LinearImage;
use niho_develop::frame;
use niho_develop::geometry::Geometry;
use niho_develop::lens::{
    estimate_chromatic_aberration, Lens, LensRender, LensSpace, LENS_SETTINGS_VERSION,
    MAX_DISTORTION, MAX_VIGNETTING_EV, VIGNETTING_START_SPAN,
};
use niho_develop::settings::{MAX_SETTINGS_VERSION, READABLE_SETTINGS_VERSIONS};
use niho_develop::xmp::{self, Level, XmpGroup, XmpWriteOptions};
use niho_develop::{DevelopSettings, Filter, Quality, RenderOptions, Session};

fn encode(v: f64) -> u8 {
    let v = v.clamp(0.0, 1.0);
    let e = if v <= 0.003_130_8 {
        12.92 * v
    } else {
        1.055 * v.powf(1.0 / 2.4) - 0.055
    };
    (e * 255.0).round() as u8
}

fn decode(v: u8) -> f64 {
    let c = v as f64 / 255.0;
    if c <= 0.04045 {
        c / 12.92
    } else {
        ((c + 0.055) / 1.055).powf(2.4)
    }
}

/// A PNG of linear sRGB values at each pixel's center.
fn png(width: u32, height: u32, pixel: impl Fn(f64, f64) -> [f64; 3]) -> Vec<u8> {
    let mut rgb = Vec::with_capacity((width * height * 3) as usize);
    for y in 0..height {
        for x in 0..width {
            let p = pixel(x as f64 + 0.5, y as f64 + 0.5);
            rgb.extend(p.map(encode));
        }
    }
    let img = image::RgbImage::from_raw(width, height, rgb).unwrap();
    let mut out = Vec::new();
    img.write_to(&mut std::io::Cursor::new(&mut out), image::ImageFormat::Png)
        .unwrap();
    out
}

fn linear(width: usize, height: usize, pixel: impl Fn(f64, f64) -> [f64; 3]) -> LinearImage {
    let mut data = Vec::with_capacity(width * height * 3);
    for y in 0..height {
        for x in 0..width {
            let p = pixel(x as f64 + 0.5, y as f64 + 0.5);
            data.extend(p.map(|v| v as f32));
        }
    }
    LinearImage {
        width,
        height,
        data,
    }
}

/// `base` with `lens` (JSON) at the version it needs.
fn with_lens(base: &DevelopSettings, lens: &str) -> DevelopSettings {
    let mut v = base.to_value();
    v["lens"] = serde_json::from_str(lens).unwrap();
    let mut s = DevelopSettings::from_json(&v.to_string()).unwrap();
    s.v = s.required_version().max(s.v);
    assert!(s.validate().is_empty(), "{:?}", s.validate());
    s
}

fn with_geometry(base: &DevelopSettings, geometry: &str) -> DevelopSettings {
    let mut v = base.to_value();
    v["geometry"] = serde_json::from_str(geometry).unwrap();
    let mut s = DevelopSettings::from_json(&v.to_string()).unwrap();
    s.v = s.required_version().max(s.v);
    assert!(s.validate().is_empty(), "{:?}", s.validate());
    s
}

fn render_lens(lens: &Lens) -> LensRender {
    LensRender::new(lens, None, LensSpace::LinearSrgb).unwrap()
}

fn fnv1a64(bytes: &[u8]) -> u64 {
    bytes.iter().fold(0xcbf2_9ce4_8422_2325u64, |hash, byte| {
        (hash ^ u64::from(*byte)).wrapping_mul(0x0100_0000_01b3)
    })
}

/// The documented radial map of the distortion (`src/lens.rs`, `LensMap`):
/// output radius `r` -> the photo's radius.
fn distortion_radius(r: f64, a: f64, radius: f64) -> f64 {
    let z = if a < 0.0 { 1.0 / (1.0 - a) } else { 1.0 };
    let rho = r / radius;
    if rho <= 1.0 {
        z * r * (1.0 - a * rho * rho)
    } else {
        z * radius * ((1.0 - a) + (rho - 1.0) * (1.0 - 3.0 * a))
    }
}

/// The output radius whose photo radius is `r` (Newton on the monotonic
/// map).
fn undistorted_radius(r: f64, a: f64, radius: f64) -> f64 {
    let mut x = r;
    for _ in 0..60 {
        let f = distortion_radius(x, a, radius) - r;
        let h = 1e-4 * radius;
        let d =
            (distortion_radius(x + h, a, radius) - distortion_radius(x - h, a, radius)) / (2.0 * h);
        x -= f / d;
    }
    x
}

// MARK: - Distortion

/// Thin dark lines every 32 px (centered at 16 + 32k) on a bright card.
fn line_card(x: f64, y: f64) -> f64 {
    let line = |v: f64| {
        let d = (v - 16.0).rem_euclid(32.0);
        let d = d.min(32.0 - d);
        (-(d * d) / 2.0).exp()
    };
    0.7 - 0.62 * line(x).max(line(y))
}

/// The worst distance (px) of the horizontal lines' centers from straight,
/// sampled every 8 columns away from the vertical lines and the borders.
fn line_bow(image: &[f32], stride: usize, size: (usize, usize), at: (usize, usize)) -> f64 {
    let (width, height) = size;
    let (ox, oy) = at;
    let value = |x: usize, y: usize| image[((oy + y) * stride + ox + x) * 3 + 1] as f64;
    let mut worst: f64 = 0.0;
    let mut n = 0;
    let lines: Vec<f64> = (0..)
        .map(|k| 16.0 + 32.0 * k as f64)
        .take_while(|y| *y < height as f64 - 10.0)
        .collect();
    for &y0 in lines.iter().filter(|y| **y > 10.0) {
        for x in (12..width - 12).step_by(8) {
            let dx = (x as f64 + 0.5 - 16.0).rem_euclid(32.0);
            if dx.min(32.0 - dx) < 7.0 {
                continue;
            }
            let (mut sum, mut moment) = (0.0, 0.0);
            let lo = (y0 - 8.0).max(0.0) as usize;
            let hi = ((y0 + 8.0) as usize).min(height - 1);
            for y in lo..=hi {
                let w = (0.7 - value(x, y)).max(0.0);
                sum += w;
                moment += w * (y as f64 + 0.5);
            }
            if sum < 0.3 {
                continue;
            }
            worst = worst.max((moment / sum - y0).abs());
            n += 1;
        }
    }
    assert!(n > 100, "{n}");
    worst
}

#[cfg_attr(target_arch = "wasm32", wasm_bindgen_test::wasm_bindgen_test)]
#[cfg_attr(not(target_arch = "wasm32"), test)]
fn the_manual_distortion_straightens_a_known_barrel_and_pincushion() {
    let (w, h) = (480usize, 320usize);
    let (cx, cy) = (w as f64 / 2.0, h as f64 / 2.0);
    let radius = (w as f64).hypot(h as f64) / 2.0;
    for slider in [30.0, -30.0] {
        let a = slider / 100.0 * MAX_DISTORTION;
        // The photo: the card seen through a lens whose correction is the
        // map (a barrel for a positive slider, a pincushion for a negative).
        let photo = linear(w, h, |x, y| {
            let (dx, dy) = (x - cx, y - cy);
            let r = dx.hypot(dy);
            let s = if r == 0.0 {
                1.0
            } else {
                undistorted_radius(r, a, radius) / r
            };
            let v = line_card(cx + dx * s, cy + dy * s);
            [v, v, v]
        });
        let before = line_bow(&photo.data, w, (w, h), (0, 0));
        let lens = render_lens(&Lens {
            distortion: slider,
            ..Lens::default()
        });
        let plan = frame::plan_with_lens(&Geometry::default(), Some(&lens), w, h, 0).unwrap();
        assert_eq!((plan.width, plan.height), (w, h));
        let window = frame::working_image(&photo, &plan, Filter::Lanczos3);
        let after = line_bow(
            &window.data,
            plan.window_width,
            (plan.width, plan.height),
            (plan.output.x, plan.output.y),
        );
        assert!(before > 4.0, "{slider}: {before}");
        assert!(after < 0.25, "{slider}: {after} (before {before})");
    }
}

// MARK: - Vignetting

#[cfg_attr(target_arch = "wasm32", wasm_bindgen_test::wasm_bindgen_test)]
#[cfg_attr(not(target_arch = "wasm32"), test)]
fn the_manual_vignetting_flattens_known_dark_corners() {
    let (w, h) = (360usize, 240usize);
    let (cx, cy) = (w as f64 / 2.0, h as f64 / 2.0);
    let radius = (w as f64).hypot(h as f64) / 2.0;
    let (amount, midpoint) = (60.0, 30.0);
    let ev = amount / 100.0 * MAX_VIGNETTING_EV;
    let start = VIGNETTING_START_SPAN * midpoint / 100.0;
    let falloff = |x: f64, y: f64| {
        let rho = (x - cx).hypot(y - cy) / radius;
        let t = ((rho - start) / (1.0 - start)).clamp(0.0, 1.0);
        (-ev * t * t).exp2()
    };
    let photo = linear(w, h, |x, y| {
        let v = 0.25 * falloff(x, y);
        [v, v * 0.9, v * 0.8]
    });
    let lens = render_lens(&Lens {
        vignetting: amount,
        vignetting_midpoint: midpoint,
        ..Lens::default()
    });
    // Unreduced and reduced (the aligned window's gain follows the frame).
    for m in [0usize, 180] {
        let plan = frame::plan_with_lens(&Geometry::default(), Some(&lens), w, h, m).unwrap();
        let window = frame::working_image(&photo, &plan, Filter::Lanczos3);
        let mut worst: f32 = 0.0;
        for j in 0..plan.height {
            for i in 0..plan.width {
                let k = ((plan.output.y + j) * plan.window_width + plan.output.x + i) * 3;
                worst = worst.max((window.data[k] - 0.25).abs());
            }
        }
        // The reduction averages the falloff over a pixel and a half.
        let tolerance = if m == 0 { 2e-6 } else { 2e-3 };
        assert!(worst < tolerance, "M {m}: {worst}");
    }
    // Through a Session (8-bit in and out): the corners are as bright as
    // the center.
    let input = png(w as u32, h as u32, |x, y| {
        let v = 0.25 * falloff(x, y);
        [v, v, v]
    });
    let s = with_lens(
        &DevelopSettings::neutral(),
        &format!(r#"{{"vignetting":{amount},"vignettingMidpoint":{midpoint}}}"#),
    );
    let mut session = Session::open_raster(&input, 0, Filter::Lanczos3).unwrap();
    let plain = session
        .render(&DevelopSettings::neutral(), 0, Quality::Final)
        .unwrap();
    let fixed = session.render(&s, 0, Quality::Final).unwrap();
    let spread = |rgba: &[u8]| {
        let g: Vec<u8> = rgba.chunks_exact(4).map(|p| p[1]).collect();
        g.iter().max().unwrap() - g.iter().min().unwrap()
    };
    assert!(spread(&plain.rgba) > 25, "{}", spread(&plain.rgba));
    assert!(spread(&fixed.rgba) <= 3, "{}", spread(&fixed.rgba));
}

// MARK: - Chromatic aberration

/// A card of dark branches (thin bars at several angles) over a bright sky,
/// red and blue magnified by `scale` about the center (a lens's lateral
/// chromatic aberration).
fn branches(width: f64, height: f64, scale: [f64; 2]) -> impl Fn(f64, f64) -> [f64; 3] {
    let (cx, cy) = (width / 2.0, height / 2.0);
    let card = move |x: f64, y: f64| {
        let mut dark: f64 = 0.0;
        for k in 0..14 {
            let angle = 0.37 * k as f64;
            let (s, c) = angle.sin_cos();
            let offset = (k as f64 * 53.0) % (width * 0.8) - width * 0.4;
            let d = ((x - cx) * c + (y - cy) * s - offset).abs();
            dark = dark.max(1.0 / (1.0 + ((d - 2.5) * 1.6).exp()));
        }
        0.75 - 0.7 * dark
    };
    move |x, y| {
        let at = |s: f64| card(cx + (x - cx) / s, cy + (y - cy) / s);
        [at(scale[0]), card(x, y), at(scale[1])]
    }
}

#[cfg_attr(target_arch = "wasm32", wasm_bindgen_test::wasm_bindgen_test)]
#[cfg_attr(not(target_arch = "wasm32"), test)]
fn the_chromatic_aberration_of_a_photo_is_found_and_removed() {
    let (w, h) = (640u32, 427u32);
    let truth = [1.003, 0.9975];
    let photo = linear(w as usize, h as usize, branches(w as f64, h as f64, truth));
    let found = estimate_chromatic_aberration(&photo);
    assert!(found.edges > 200, "{found:?}");
    assert!((found.red - (truth[0] - 1.0)).abs() < 3e-4, "{found:?}");
    assert!((found.blue - (truth[1] - 1.0)).abs() < 3e-4, "{found:?}");

    let input = png(w, h, branches(w as f64, h as f64, truth));
    let s = with_lens(
        &DevelopSettings::neutral(),
        r#"{"removeChromaticAberration":true}"#,
    );
    assert_eq!(s.v, LENS_SETTINGS_VERSION);
    let mut session = Session::open_raster(&input, 0, Filter::Lanczos3).unwrap();
    let plain = session
        .render(&DevelopSettings::neutral(), 0, Quality::Final)
        .unwrap();
    let fixed = session.render(&s, 0, Quality::Final).unwrap();
    // The card is neutral: red and blue against green measure the fringes
    // (the outer quarter of the photo, where the aberration shows).
    let fringe = |rgba: &[u8]| {
        let (mut sum, mut n) = (0.0, 0.0);
        for (i, p) in rgba.chunks_exact(4).enumerate() {
            let (x, y) = ((i % w as usize) as f64, (i / w as usize) as f64);
            let rho =
                (x - w as f64 / 2.0).hypot(y - h as f64 / 2.0) / (w as f64).hypot(h as f64) * 2.0;
            if !(0.6..0.97).contains(&rho) {
                continue;
            }
            let g = decode(p[1]);
            sum += (decode(p[0]) - g).abs() + (decode(p[2]) - g).abs();
            n += 1.0;
        }
        sum / n
    };
    let (before, after) = (fringe(&plain.rgba), fringe(&fixed.rgba));
    assert!(after < before * 0.25, "{before} -> {after}");
    let stats = session.lens_stats();
    assert_eq!(stats.chromatic_estimates, 1);
    // The 8-bit photo's estimate is close to the linear one.
    let red = stats.chromatic.unwrap().red;
    assert!((red - (truth[0] - 1.0)).abs() < 4e-4, "{red}");
}

#[cfg_attr(target_arch = "wasm32", wasm_bindgen_test::wasm_bindgen_test)]
#[cfg_attr(not(target_arch = "wasm32"), test)]
fn nothing_is_found_without_edges_or_without_an_aberration() {
    let (w, h) = (480usize, 320usize);
    let hash01 = |x: f64, y: f64| {
        let mut v = (x as u64).wrapping_mul(0x9e37_79b9_7f4a_7c15)
            ^ (y as u64).wrapping_mul(0xc2b2_ae3d_27d4_eb4f);
        v ^= v >> 31;
        v = v.wrapping_mul(0xbf58_476d_1ce4_e5b9);
        v ^= v >> 29;
        (v % 10_000) as f64 / 10_000.0
    };
    type Card = Box<dyn Fn(f64, f64) -> [f64; 3]>;
    let cases: Vec<(&str, Card)> = vec![
        ("flat", Box::new(|_, _| [0.3, 0.3, 0.3])),
        ("one color", Box::new(|_, _| [0.6, 0.2, 0.1])),
        (
            "gradient",
            Box::new(move |x, y| [x / w as f64, y / h as f64, 0.4]),
        ),
        (
            "noise",
            Box::new(move |x, y| {
                [
                    0.1 + 0.8 * hash01(x, y),
                    0.1 + 0.8 * hash01(x + 1000.0, y),
                    0.1 + 0.8 * hash01(x, y + 1000.0),
                ]
            }),
        ),
        (
            "gray noise",
            Box::new(move |x, y| {
                let v = 0.1 + 0.8 * hash01(x, y);
                [v, v, v]
            }),
        ),
        (
            "edges without aberration",
            Box::new(branches(w as f64, h as f64, [1.0, 1.0])),
        ),
    ];
    for (name, pixel) in cases {
        let photo = linear(w, h, &pixel);
        let found = estimate_chromatic_aberration(&photo);
        assert_eq!((found.red, found.blue), (0.0, 0.0), "{name}: {found:?}");
        // The switch then renders exactly as without it.
        let input = png(w as u32, h as u32, &pixel);
        let mut base = DevelopSettings::neutral();
        base.exposure = 0.3;
        base.clarity = 20.0;
        let s = with_lens(&base, r#"{"removeChromaticAberration":true}"#);
        let mut session = Session::open_raster(&input, 0, Filter::Lanczos3).unwrap();
        for m in [0usize, 200] {
            let a = session.render(&base, m, Quality::Final).unwrap();
            let b = session.render(&s, m, Quality::Final).unwrap();
            assert!(a.rgba == b.rgba, "{name} M {m}");
        }
    }
}

// MARK: - Fringes

/// Dark branches with purple (left) and green (right) fringes over a sky,
/// a large purple square and a large green square away from them.
fn fringed(x: f64, y: f64) -> [f64; 3] {
    let sky = [0.8, 0.8, 0.8];
    let in_square = |x0: f64, y0: f64| (x0..x0 + 70.0).contains(&x) && (y0..y0 + 70.0).contains(&y);
    if in_square(20.0, 20.0) {
        return [0.35, 0.1, 0.55];
    }
    if in_square(20.0, 180.0) {
        return [0.12, 0.45, 0.1];
    }
    for bar in [150.0, 230.0, 310.0] {
        let d = x - bar;
        if d.abs() < 3.0 {
            return [0.03, 0.03, 0.03];
        }
        if (-5.0..-3.0).contains(&d) {
            return [0.35, 0.1, 0.55];
        }
        if (3.0..5.0).contains(&d) {
            return [0.12, 0.45, 0.1];
        }
    }
    sky
}

fn saturation(p: &[u8]) -> f64 {
    let v: Vec<f64> = p[..3].iter().map(|c| *c as f64).collect();
    let max = v.iter().cloned().fold(0.0, f64::max);
    let min = v.iter().cloned().fold(255.0, f64::min);
    max - min
}

#[cfg_attr(target_arch = "wasm32", wasm_bindgen_test::wasm_bindgen_test)]
#[cfg_attr(not(target_arch = "wasm32"), test)]
fn fringes_near_edges_go_and_large_areas_stay() {
    let (w, h) = (400u32, 280u32);
    let input = png(w, h, fringed);
    let base = DevelopSettings::neutral();
    let s = with_lens(
        &base,
        r#"{"defringe":{"purple":{"amount":100},"green":{"amount":100}}}"#,
    );
    let mut session = Session::open_raster(&input, 0, Filter::Lanczos3).unwrap();
    let plain = session.render(&base, 0, Quality::Final).unwrap();
    let fixed = session.render(&s, 0, Quality::Final).unwrap();
    let at = |f: &niho_develop::Rendered, x: u32, y: u32| {
        let k = ((y * w + x) * 4) as usize;
        f.rgba[k..k + 4].to_vec()
    };
    for bar in [150u32, 230, 310] {
        for y in [40u32, 140, 240] {
            for x in [bar - 5, bar - 4, bar + 3, bar + 4] {
                let (a, b) = (saturation(&at(&plain, x, y)), saturation(&at(&fixed, x, y)));
                assert!(a > 60.0 && b < a * 0.2, "({x}, {y}): {a} -> {b}");
            }
        }
    }
    // The squares' insides (more than the radius and a pixel from their
    // borders) and the sky do not change.
    for (x0, y0) in [(20u32, 20u32), (20, 180)] {
        for y in y0 + 8..y0 + 62 {
            for x in x0 + 8..x0 + 62 {
                assert_eq!(at(&plain, x, y), at(&fixed, x, y), "({x}, {y})");
            }
        }
    }
    assert_eq!(at(&plain, 120, 140), at(&fixed, 120, 140));
    // Only purple: the green fringes stay.
    let purple = with_lens(&base, r#"{"defringe":{"purple":{"amount":100}}}"#);
    let only = session.render(&purple, 0, Quality::Final).unwrap();
    assert!(saturation(&at(&only, 154, 140)) > 60.0);
    assert!(saturation(&at(&only, 146, 140)) < 20.0);
}

// MARK: - Order with the geometry

#[cfg_attr(target_arch = "wasm32", wasm_bindgen_test::wasm_bindgen_test)]
#[cfg_attr(not(target_arch = "wasm32"), test)]
fn the_lens_is_the_end_of_the_inverse_map() {
    // A linear ramp: Catmull-Rom reproduces it, so each output pixel holds
    // the ramp where the plan maps it.
    let (w, h) = (300usize, 200usize);
    let ramp = |x: f64, y: f64| 0.1 + 0.002 * x + 0.003 * y;
    let source = linear(w, h, |x, y| {
        let v = ramp(x - 0.5, y - 0.5);
        [v, v * 0.5, v * 0.25]
    });
    let (cx, cy) = (w as f64 / 2.0, h as f64 / 2.0);
    let radius = (w as f64).hypot(h as f64) / 2.0;
    for (json, slider) in [
        (r#"{}"#, 40.0),
        (r#"{"perspective":{"vertical":-30}}"#, 25.0),
        (
            r#"{"perspective":{"horizontal":20,"rotate":-3},"angle":2.5,"crop":{"left":0.1,"top":0.1,"right":0.9,"bottom":0.85}}"#,
            -35.0,
        ),
        (
            r#"{"angle":-4,"crop":{"left":0.05,"top":0.0,"right":0.8,"bottom":0.9}}"#,
            60.0,
        ),
    ] {
        let g = Geometry::from_value(&serde_json::from_str(json).unwrap()).unwrap();
        let lens = render_lens(&Lens {
            distortion: slider,
            ..Lens::default()
        });
        let a = slider / 100.0 * MAX_DISTORTION;
        let without = frame::plan(&g, w, h, 0).unwrap();
        let plan = frame::plan_with_lens(&g, Some(&lens), w, h, 0).unwrap();
        // The output is the geometry's.
        assert_eq!((plan.width, plan.height), (without.width, without.height));
        let window = frame::working_image(&source, &plan, Filter::Lanczos3);
        let mut checked = 0;
        for j in (0..plan.height).step_by(7) {
            for i in (0..plan.width).step_by(5) {
                // The geometry's frame point, then the lens (documented).
                let p = without.turned_point(i, j).unwrap_or([
                    (i as f64 + 0.5) * w as f64 / without.width as f64,
                    (j as f64 + 0.5) * h as f64 / without.height as f64,
                ]);
                let (dx, dy) = (p[0] - cx, p[1] - cy);
                let r = dx.hypot(dy);
                let f = if r == 0.0 {
                    1.0
                } else {
                    distortion_radius(r, a, radius) / r
                };
                let q = [cx + dx * f, cy + dy * f];
                let got_point = plan.turned_point(i, j).unwrap();
                assert!(
                    (got_point[0] - q[0]).abs() < 1e-9 && (got_point[1] - q[1]).abs() < 1e-9,
                    "{json}: {got_point:?} vs {q:?}"
                );
                if !(q[0] > 3.0 && q[0] < w as f64 - 3.0 && q[1] > 3.0 && q[1] < h as f64 - 3.0) {
                    continue;
                }
                let k = ((plan.output.y + j) * plan.window_width + plan.output.x + i) * 3;
                let expected = ramp(q[0] - 0.5, q[1] - 0.5);
                assert!(
                    (window.data[k] as f64 - expected).abs() < 2e-4,
                    "{json} ({i}, {j}): {} vs {expected}",
                    window.data[k]
                );
                checked += 1;
            }
        }
        assert!(checked > 100, "{json}: {checked}");
    }
}

#[cfg_attr(target_arch = "wasm32", wasm_bindgen_test::wasm_bindgen_test)]
#[cfg_attr(not(target_arch = "wasm32"), test)]
fn inactive_values_render_bit_for_bit_as_before() {
    let input = png(200, 140, |x, y| {
        let v = line_card(x, y);
        [v, v * 0.9, v * 0.7]
    });
    let mut base = DevelopSettings::neutral();
    base.exposure = 0.3;
    base.shadows = 25.0;
    base.clarity = 15.0;
    for (geometry, lens) in [
        (None, r#"{"vignettingMidpoint":20}"#),
        (
            Some(r#"{"angle":3}"#),
            r#"{"defringe":{"purple":{"hueLo":10,"hueHi":90}}}"#,
        ),
        (Some(r#"{"crop":{"right":0.7}}"#), r#"{}"#),
    ] {
        let a = geometry.map_or(base.clone(), |g| with_geometry(&base, g));
        let b = with_lens(&a, lens);
        assert_eq!(a.v, b.v, "{lens}");
        for m in [0usize, 90] {
            let fa = Session::open_raster(&input, 0, Filter::Lanczos3)
                .unwrap()
                .render(&a, m, Quality::Final)
                .unwrap();
            let fb = Session::open_raster(&input, 0, Filter::Lanczos3)
                .unwrap()
                .render(&b, m, Quality::Final)
                .unwrap();
            assert!(fa.rgba == fb.rgba, "{lens} M {m}");
        }
    }
}

#[cfg_attr(target_arch = "wasm32", wasm_bindgen_test::wasm_bindgen_test)]
#[cfg_attr(not(target_arch = "wasm32"), test)]
fn a_session_estimates_the_aberration_once_and_redraws_by_the_lens() {
    let (w, h) = (320u32, 214u32);
    let input = png(w, h, branches(w as f64, h as f64, [1.004, 0.996]));
    let mut base = DevelopSettings::neutral();
    base.exposure = 0.1;
    let a = with_lens(
        &base,
        r#"{"removeChromaticAberration":true,"distortion":10}"#,
    );
    let mut session = Session::open_raster(&input, 0, Filter::Lanczos3).unwrap();
    assert_eq!(session.lens_stats().chromatic_estimates, 0);
    let first = session.render(&a, 0, Quality::Final).unwrap();
    let mut brighter = a.clone();
    brighter.exposure = 0.6;
    session.render(&brighter, 0, Quality::Interactive).unwrap();
    let turned = with_geometry(&a, r#"{"angle":2,"rotate":90}"#);
    session.render(&turned, 160, Quality::Final).unwrap();
    let other = with_lens(
        &base,
        r#"{"removeChromaticAberration":true,"distortion":11}"#,
    );
    let second = session.render(&other, 0, Quality::Final).unwrap();
    assert!(first.rgba != second.rgba);
    let again = session.render(&a, 0, Quality::Final).unwrap();
    assert!(first.rgba == again.rgba);
    // Previews share the estimate of the whole photo.
    let mut thumbnail = session.thumbnail(128);
    thumbnail.render(&a, 0, Quality::Final).unwrap();
    assert_eq!(thumbnail.lens_stats().chromatic_estimates, 1);
    let stats = session.lens_stats();
    assert_eq!(stats.chromatic_estimates, 1);
    assert!(stats.chromatic.unwrap().red > 0.002, "{stats:?}");
    // Auto and the picker read the lens too, and estimate nothing again.
    session.auto_settings(&a).unwrap();
    session.sample_color(&a, 0, 0.5, 0.5).unwrap();
    assert_eq!(session.lens_stats().chromatic_estimates, 1);
    // A fresh Session draws the same frame.
    let fresh = Session::open_raster(&input, 0, Filter::Lanczos3)
        .unwrap()
        .render(&a, 0, Quality::Final)
        .unwrap();
    assert!(first.rgba == fresh.rgba);
    // The one-shot render draws through a Session too.
    let options = RenderOptions {
        max_dimension: 0,
        ..RenderOptions::default()
    };
    let one_shot = niho_develop::render(&input, &a.to_json(), &options).unwrap();
    assert!(one_shot.rgba == first.rgba);
    assert_eq!(
        niho_develop::output_size(&a, w as usize, h as usize, 100).unwrap(),
        (100, 67)
    );
}

#[cfg_attr(target_arch = "wasm32", wasm_bindgen_test::wasm_bindgen_test)]
#[cfg_attr(not(target_arch = "wasm32"), test)]
fn a_one_shot_heal_estimates_chromatic_aberration_from_the_original() {
    let (w, h) = (320u32, 214u32);
    let input = png(w, h, branches(w as f64, h as f64, [1.006, 0.994]));
    let base = with_lens(
        &DevelopSettings::neutral(),
        r#"{"removeChromaticAberration":true}"#,
    );
    let mut value = base.to_value();
    value["heal"] = serde_json::json!([{
        "id": "erase-branch",
        "mode": "remove",
        "radius": 0.25,
        "feather": 0.0,
        "points": [[0.5, 0.5]]
    }]);
    let settings = DevelopSettings::from_json(&value.to_string()).unwrap();
    assert!(settings.validate().is_empty(), "{:?}", settings.validate());

    let mut session = Session::open_raster(&input, 0, Filter::Lanczos3).unwrap();
    let interactive = session.render(&settings, 0, Quality::Final).unwrap();
    assert_eq!(session.lens_stats().chromatic_estimates, 1);

    let options = RenderOptions {
        max_dimension: 0,
        ..RenderOptions::default()
    };
    let one_shot = niho_develop::render(&input, &settings.to_json(), &options).unwrap();
    assert_eq!(one_shot.rgba, interactive.rgba);
}

// MARK: - Settings

#[cfg_attr(target_arch = "wasm32", wasm_bindgen_test::wasm_bindgen_test)]
#[cfg_attr(not(target_arch = "wasm32"), test)]
fn the_settings_need_v9_and_round_trip() {
    assert_eq!(LENS_SETTINGS_VERSION, 9);
    assert_eq!(MAX_SETTINGS_VERSION, 9);
    assert!(READABLE_SETTINGS_VERSIONS.contains(&9));
    let mut base = DevelopSettings::neutral();
    base.contrast = 10.0;
    let s = with_lens(
        &base,
        r#"{"distortion":-12,"vignetting":40,"vignettingMidpoint":35,"removeChromaticAberration":true,"defringe":{"purple":{"amount":30,"hueLo":25,"hueHi":75},"green":{"amount":10,"hueLo":35,"hueHi":65}}}"#,
    );
    assert_eq!(s.required_version(), 9);
    assert_eq!(s.v, 9);
    assert!(!s.is_neutral(), "an active lens is reset by 初期化");
    let mut value = s.to_value();
    assert_eq!(value["lens"]["defringe"]["green"]["hueHi"], 65);
    value["futureKey"] = serde_json::json!({"a": 1});
    let parsed = DevelopSettings::from_value(&value).unwrap();
    assert_eq!(parsed.lens, s.lens);
    assert_eq!(parsed.extra["futureKey"]["a"], 1);
    assert_eq!(
        DevelopSettings::from_value(&parsed.to_value()).unwrap(),
        parsed
    );
    for v in [1, 7, 8] {
        let mut low = s.clone();
        low.v = v;
        assert!(low
            .validate()
            .iter()
            .any(|e| e.path == "v" && e.code == "versionTooLow"));
    }
    // A reader that does not know v9 refuses it.
    let mut text = s.to_value();
    text["v"] = 10.into();
    assert_eq!(
        DevelopSettings::from_value(&text).unwrap_err().code,
        "unsupportedVersion"
    );
    // Values that render nothing keep the version and the key.
    let quiet = with_lens(&base, r#"{"vignettingMidpoint":20}"#);
    assert_eq!(quiet.required_version(), 1);
    assert_eq!(quiet.to_value()["lens"]["vignettingMidpoint"], 20);
    // The defaults write no key.
    let none = with_lens(&base, r#"{"distortion":0}"#);
    assert!(none.to_value().get("lens").is_none());
    // Out of range and unknown keys.
    let mut bad = s.clone();
    bad.lens.distortion = 120.0;
    bad.lens.defringe.purple.hue_lo = 90.0;
    let issues = bad.validate();
    assert!(issues
        .iter()
        .any(|e| e.path == "lens.distortion" && e.code == "outOfRange"));
    assert!(issues
        .iter()
        .any(|e| e.path == "lens.defringe.purple" && e.code == "invalidRange"));
    let mut unknown = s.to_value();
    unknown["lens"]["profile"] = true.into();
    assert_eq!(
        DevelopSettings::from_value(&unknown).unwrap_err().code,
        "unknownKey"
    );
    // "補正前" shows the photo without the lens corrections.
    let before =
        DevelopSettings::from_json(&niho_develop::before_settings(&s.to_json()).unwrap()).unwrap();
    assert!(before.lens.is_default());
}

// MARK: - XMP

const LENS_XMP: &str = r#"<x:xmpmeta xmlns:x="adobe:ns:meta/"><rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#">
<rdf:Description rdf:about="" xmlns:crs="http://ns.adobe.com/camera-raw-settings/1.0/"
 crs:Contrast2012="+20" crs:LensManualDistortionAmount="+15" crs:VignetteAmount="+40" crs:VignetteMidpoint="30"
 crs:AutoLateralCA="1" crs:DefringePurpleAmount="6" crs:DefringePurpleHueLo="25" crs:DefringePurpleHueHi="75"
 crs:DefringeGreenAmount="2" crs:DefringeGreenHueLo="45" crs:DefringeGreenHueHi="55"
 crs:LensProfileEnable="1" crs:LensProfileSetup="LensDefaults" crs:LensProfileName="Some Lens"
 crs:PostCropVignetteAmount="-20"/></rdf:RDF></x:xmpmeta>"#;

#[cfg_attr(target_arch = "wasm32", wasm_bindgen_test::wasm_bindgen_test)]
#[cfg_attr(not(target_arch = "wasm32"), test)]
fn xmp_presets_read_write_and_blend_the_lens_corrections() {
    let mut photo = DevelopSettings::neutral();
    photo.exposure = -0.4;
    let photo = with_lens(
        &photo,
        r#"{"distortion":-5,"defringe":{"green":{"amount":40}}}"#,
    );
    let result = xmp::preset_settings(LENS_XMP, Some(&photo)).unwrap();
    let l = &result.settings.lens;
    assert_eq!(l.distortion, 15.0);
    assert_eq!((l.vignetting, l.vignetting_midpoint), (40.0, 30.0));
    assert!(l.remove_chromatic_aberration);
    assert_eq!(
        (
            l.defringe.purple.amount,
            l.defringe.purple.hue_lo,
            l.defringe.purple.hue_hi
        ),
        (30.0, 25.0, 75.0)
    );
    assert_eq!(l.defringe.green.amount, 10.0);
    // The post-crop vignette is the effect, not the lens.
    assert_eq!(result.settings.vignette.amount, -20.0);
    assert_eq!(result.settings.v, 9);
    assert!(result.unsupported.is_empty(), "{:?}", result.unsupported);
    let level = |key: &str| {
        result
            .items
            .iter()
            .find(|i| i.property == key)
            .map(|i| i.level)
            .unwrap()
    };
    assert_eq!(level("LensManualDistortionAmount"), Level::Approximate);
    assert_eq!(level("AutoLateralCA"), Level::Approximate);
    assert_eq!(level("LensProfileEnable"), Level::Metadata);
    assert_eq!(level("LensProfileName"), Level::Metadata);
    // A preset that does not carry the lens keeps the photo's.
    let plain = r#"<x:xmpmeta xmlns:x="adobe:ns:meta/"><rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#">
<rdf:Description rdf:about="" xmlns:crs="http://ns.adobe.com/camera-raw-settings/1.0/" crs:Contrast2012="+45"/></rdf:RDF></x:xmpmeta>"#;
    assert_eq!(
        xmp::preset_settings(plain, Some(&photo))
            .unwrap()
            .settings
            .lens,
        photo.lens
    );
    // Turning the profile off, or other profile amounts, cannot be applied.
    let off = r#"<x:xmpmeta xmlns:x="adobe:ns:meta/"><rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#">
<rdf:Description rdf:about="" xmlns:crs="http://ns.adobe.com/camera-raw-settings/1.0/" crs:LensProfileEnable="0" crs:AutoLateralCA="0" crs:Defringe="1"/></rdf:RDF></x:xmpmeta>"#;
    let off = xmp::preset_settings(off, None).unwrap();
    assert_eq!(off.unsupported, vec!["Defringe", "LensProfileEnable"]);
    assert!(off.settings.lens.is_default());
    let scaled = r#"<x:xmpmeta xmlns:x="adobe:ns:meta/"><rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#">
<rdf:Description rdf:about="" xmlns:crs="http://ns.adobe.com/camera-raw-settings/1.0/" crs:LensProfileEnable="1" crs:LensProfileDistortionScale="60" crs:LensProfileVignettingScale="100"/></rdf:RDF></x:xmpmeta>"#;
    assert_eq!(
        xmp::preset_settings(scaled, None).unwrap().unsupported,
        vec!["LensProfileDistortionScale"]
    );
    // Out of range values are clamped and reported.
    let wide = r#"<x:xmpmeta xmlns:x="adobe:ns:meta/"><rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#">
<rdf:Description rdf:about="" xmlns:crs="http://ns.adobe.com/camera-raw-settings/1.0/" crs:LensManualDistortionAmount="+140" crs:DefringeGreenAmount="30" crs:DefringeGreenHueLo="80" crs:DefringeGreenHueHi="20"/></rdf:RDF></x:xmpmeta>"#;
    let wide = xmp::preset_settings(wide, None).unwrap();
    assert_eq!(wide.settings.lens.distortion, 100.0);
    assert_eq!(wide.settings.lens.defringe.green.amount, 100.0);
    assert_eq!(
        (
            wide.settings.lens.defringe.green.hue_lo,
            wide.settings.lens.defringe.green.hue_hi
        ),
        (20.0, 80.0)
    );
    assert!(wide
        .items
        .iter()
        .any(|i| i.property == "LensManualDistortionAmount" && i.note.contains("範囲外")));

    // Written (the default groups carry the lens) and read back.
    let s = result.settings.clone();
    let written = xmp::settings_to_xmp(&s, &XmpWriteOptions::default());
    assert!(XmpGroup::DEFAULT.contains(&XmpGroup::Lens));
    let doc = xmp::parse(&written.xmp).unwrap();
    assert_eq!(doc.properties["LensManualDistortionAmount"], "+15");
    assert_eq!(doc.properties["DefringePurpleAmount"], "6");
    assert_eq!(doc.properties["AutoLateralCA"], "1");
    assert!(!doc.properties.contains_key("LensProfileEnable"));
    let back = xmp::preset_settings(&written.xmp, Some(&DevelopSettings::neutral())).unwrap();
    assert_eq!(back.settings.lens, s.lens);
    assert!(back.unsupported.is_empty(), "{:?}", back.unsupported);
    // A neutral preset resets the photo's lens.
    let neutral = xmp::settings_to_xmp(&DevelopSettings::neutral(), &XmpWriteOptions::default());
    let reset = xmp::preset_settings(&neutral.xmp, Some(&photo))
        .unwrap()
        .settings;
    assert!(reset.lens.is_default());
    // Without the group nothing is written.
    let only_tone = XmpWriteOptions {
        groups: vec![XmpGroup::Tone],
        ..XmpWriteOptions::default()
    };
    assert!(!xmp::settings_to_xmp(&s, &only_tone)
        .xmp
        .contains("Defringe"));

    // The amount: numbers move from the photo's, the switch and the hues
    // are the preset's above 0%.
    let half = xmp::apply_preset(LENS_XMP, &photo, 0.5, None)
        .unwrap()
        .settings;
    assert_eq!(half.lens.distortion, 5.0);
    assert_eq!(half.lens.vignetting, 20.0);
    assert_eq!(half.lens.vignetting_midpoint, 40.0);
    assert_eq!(half.lens.defringe.green.amount, 25.0);
    assert!(half.lens.remove_chromatic_aberration);
    assert_eq!(half.lens.defringe.purple.hue_lo, 25.0);
    assert!(half.validate().is_empty(), "{:?}", half.validate());
    let zero = xmp::apply_preset(LENS_XMP, &photo, 0.0, None)
        .unwrap()
        .settings;
    assert_eq!(zero.lens, photo.lens);
    let more = xmp::apply_preset(LENS_XMP, &photo, 1.5, None)
        .unwrap()
        .settings;
    assert_eq!(more.lens.distortion, 25.0);
    assert!(more.validate().is_empty());
}

// MARK: - Native and wasm

#[cfg_attr(target_arch = "wasm32", wasm_bindgen_test::wasm_bindgen_test)]
#[cfg_attr(not(target_arch = "wasm32"), test)]
fn native_and_wasm_render_the_lens_the_same() {
    let card = png(160, 108, branches(160.0, 108.0, [1.006, 0.994]));
    let fringes = png(200, 140, |x, y| fringed(x * 2.0, y * 2.0));
    let mut base = DevelopSettings::neutral();
    base.exposure = 0.2;
    base.shadows = 20.0;
    let mut hashes = Vec::new();
    for (input, lens, geometry) in [
        (&card, r#"{"distortion":35,"vignetting":-40}"#, None),
        (
            &card,
            r#"{"distortion":-50,"removeChromaticAberration":true}"#,
            Some(r#"{"perspective":{"vertical":-20},"angle":2}"#),
        ),
        (
            &fringes,
            r#"{"vignetting":30,"vignettingMidpoint":10,"defringe":{"purple":{"amount":70},"green":{"amount":40}}}"#,
            Some(r#"{"crop":{"left":0.1,"right":0.9}}"#),
        ),
    ] {
        let g = geometry.map_or(base.clone(), |g| with_geometry(&base, g));
        let s = with_lens(&g, lens);
        let mut session = Session::open_raster(input, 0, Filter::Lanczos3).unwrap();
        for m in [0usize, 60] {
            let f = session.render(&s, m, Quality::Final).unwrap();
            hashes.push((f.width, f.height, fnv1a64(&f.rgba)));
        }
        let found = session.lens_stats().chromatic;
        if let Some(found) = found {
            hashes.push((found.edges, 0, found.red.to_bits() ^ found.blue.to_bits()));
        }
    }
    assert_eq!(hashes, EXPECTED_HASHES);
}

/// [`native_and_wasm_render_the_lens_the_same`]'s frames (recorded on
/// native; the wasm build must match them).
const EXPECTED_HASHES: [(usize, usize, u64); 7] = [
    (160, 108, 3_110_306_787_521_690_766),
    (60, 41, 15_447_521_158_220_714_102),
    (157, 98, 4_560_125_204_715_549_921),
    (60, 38, 18_100_986_324_651_958_290),
    (179, 0, 9_227_828_994_556_200_754),
    (160, 140, 10_119_925_133_143_370_957),
    (60, 53, 15_594_123_094_554_593_778),
];
