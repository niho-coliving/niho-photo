//! Heal marks (niho-photo#44, `src/heal.rs`): a wire over a sky and a
//! stain on a regular wall are filled from their surroundings, a flat
//! background is filled with its color, the edge stays seamless, "写す"
//! copies its source (pushed back onto the photo, or picked
//! deterministically), marks follow the photo through the geometry, a
//! Session plans each mark once, settings need `v: 8`, presets never carry
//! the marks, and native and wasm heal the same bytes. Synthetic images
//! only. The whole file is also run by the wasm-bindgen test command
//! (`scripts/ci/run-scope.mjs`).

use niho_develop::decode::{self, encode_signed_working_copy, LinearImage};
use niho_develop::heal::HealStats;
use niho_develop::settings::{
    HEAL_SETTINGS_VERSION, MAX_SETTINGS_VERSION, READABLE_SETTINGS_VERSIONS,
};
use niho_develop::xmp::{self, XmpWriteOptions};
use niho_develop::{DevelopSettings, Filter, Quality, RenderOptions, Session};

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

fn to8(v: f64) -> u8 {
    (v.clamp(0.0, 1.0) * 255.0).round() as u8
}

/// A deterministic hash in `0..1` (synthetic texture).
fn hash01(x: u32, y: u32) -> f64 {
    let mut v = u64::from(x).wrapping_mul(0x9e37_79b9_7f4a_7c15)
        ^ u64::from(y).wrapping_mul(0xc2b2_ae3d_27d4_eb4f);
    v ^= v >> 31;
    v = v.wrapping_mul(0xbf58_476d_1ce4_e5b9);
    v ^= v >> 29;
    (v % 10_000) as f64 / 10_000.0
}

/// `base` with `heal` (JSON) at the version it needs.
fn with_heal(base: &DevelopSettings, heal: &str) -> DevelopSettings {
    let mut v = base.to_value();
    v["heal"] = serde_json::from_str(heal).unwrap();
    let mut s = DevelopSettings::from_json(&v.to_string()).unwrap();
    s.v = s.required_version().max(s.v);
    assert!(s.validate().is_empty(), "{:?}", s.validate());
    s
}

/// `base` with `geometry` (JSON) at the version it needs.
fn with_geometry(base: &DevelopSettings, geometry: &str) -> DevelopSettings {
    let mut v = base.to_value();
    v["geometry"] = serde_json::from_str(geometry).unwrap();
    let mut s = DevelopSettings::from_json(&v.to_string()).unwrap();
    s.v = s.required_version().max(s.v);
    assert!(s.validate().is_empty(), "{:?}", s.validate());
    s
}

fn mark(
    mode: &str,
    radius: f64,
    feather: f64,
    points: &[[f64; 2]],
    source: Option<[f64; 2]>,
) -> String {
    let points: Vec<String> = points
        .iter()
        .map(|p| format!("[{},{}]", p[0], p[1]))
        .collect();
    let source = source.map_or(String::new(), |s| {
        format!(r#","source":[{},{}]"#, s[0], s[1])
    });
    format!(
        r#"{{"id":"m{}","mode":"{mode}","radius":{radius},"feather":{feather},"points":[{}]{source}}}"#,
        points.len() * 1000 + (radius * 1e6) as usize + (feather * 10.0) as usize,
        points.join(",")
    )
}

fn render(input: &[u8], settings: &DevelopSettings) -> (Vec<u8>, usize, usize) {
    let mut session = Session::open_raster(input, 0, Filter::Lanczos3).unwrap();
    let f = session.render(settings, 0, Quality::Final).unwrap();
    (f.rgba, f.width, f.height)
}

/// RMSE (8-bit levels) and largest difference of the pixels where
/// `inside(x, y)`.
fn compare(a: &[u8], b: &[u8], w: usize, inside: impl Fn(usize, usize) -> bool) -> (f64, u8) {
    let (mut sum, mut max, mut n) = (0.0, 0u8, 0usize);
    for (i, (pa, pb)) in a.chunks(4).zip(b.chunks(4)).enumerate() {
        if !inside(i % w, i / w) {
            continue;
        }
        for c in 0..3 {
            let d = pa[c].abs_diff(pb[c]);
            sum += f64::from(d) * f64::from(d);
            max = max.max(d);
        }
        n += 1;
    }
    assert!(n > 0);
    ((sum / (3 * n) as f64).sqrt(), max)
}

/// Correlation of the green channel of `a` and `b` where `inside`.
fn correlation(a: &[u8], b: &[u8], w: usize, inside: impl Fn(usize, usize) -> bool) -> f64 {
    let (mut sa, mut sb, mut saa, mut sbb, mut sab, mut n) = (0.0, 0.0, 0.0, 0.0, 0.0, 0.0);
    for (i, (pa, pb)) in a.chunks(4).zip(b.chunks(4)).enumerate() {
        if !inside(i % w, i / w) {
            continue;
        }
        let (va, vb) = (f64::from(pa[1]), f64::from(pb[1]));
        sa += va;
        sb += vb;
        saa += va * va;
        sbb += vb * vb;
        sab += va * vb;
        n += 1.0;
    }
    let cov = sab / n - sa / n * sb / n;
    let (da, db) = (saa / n - (sa / n).powi(2), sbb / n - (sb / n).powi(2));
    if da <= 0.0 || db <= 0.0 {
        return if (da - db).abs() < 1e-9 { 1.0 } else { 0.0 };
    }
    cov / (da.sqrt() * db.sqrt())
}

fn segment_distance(x: f64, y: f64, pts: &[[f64; 2]]) -> f64 {
    if pts.len() == 1 {
        return ((x - pts[0][0]).powi(2) + (y - pts[0][1]).powi(2)).sqrt();
    }
    let mut best = f64::MAX;
    for s in pts.windows(2) {
        let (a, b) = (s[0], s[1]);
        let (dx, dy) = (b[0] - a[0], b[1] - a[1]);
        let l2 = dx * dx + dy * dy;
        let t = if l2 > 0.0 {
            (((x - a[0]) * dx + (y - a[1]) * dy) / l2).clamp(0.0, 1.0)
        } else {
            0.0
        };
        best = best.min(((x - a[0] - t * dx).powi(2) + (y - a[1] - t * dy).powi(2)).sqrt());
    }
    best
}

fn fnv1a64(bytes: &[u8]) -> u64 {
    bytes.iter().fold(0xcbf2_9ce4_8422_2325u64, |hash, byte| {
        (hash ^ u64::from(*byte)).wrapping_mul(0x0100_0000_01b3)
    })
}

// MARK: - Synthetic photos

/// A sky from blue (top) to white (bottom).
fn sky(y: f64, h: f64) -> [f64; 3] {
    let t = y / h;
    [0.35 + 0.6 * t, 0.55 + 0.42 * t, 0.92 + 0.07 * t]
}

/// A sagging power line across the frame.
fn wire_y(x: f64, w: f64, h: f64) -> f64 {
    let u = (x - w / 2.0) / (w / 2.0);
    0.35 * h + 0.12 * h * u * u + 0.05 * h * u
}

/// The sky with (or without) the wire.
fn sky_png(w: u32, h: u32, wire: bool) -> Vec<u8> {
    let (wf, hf) = (f64::from(w), f64::from(h));
    let thick = (wf / 400.0).max(1.2);
    png(w, h, |x, y| {
        let (xf, yf) = (f64::from(x) + 0.5, f64::from(y) + 0.5);
        let c = sky(yf, hf);
        let k = if wire {
            (thick - (yf - wire_y(xf, wf, hf)).abs()).clamp(0.0, 1.0)
        } else {
            0.0
        };
        [
            to8(c[0] * (1.0 - k) + 0.05 * k),
            to8(c[1] * (1.0 - k) + 0.05 * k),
            to8(c[2] * (1.0 - k) + 0.06 * k),
        ]
    })
}

/// The wire's stroke (pixels) and its mark (normalized).
fn wire_stroke(w: u32, h: u32) -> (Vec<[f64; 2]>, Vec<[f64; 2]>) {
    let (wf, hf) = (f64::from(w), f64::from(h));
    let px: Vec<[f64; 2]> = (0..=32)
        .map(|i| {
            let x = wf * f64::from(i) / 32.0;
            [x, wire_y(x, wf, hf)]
        })
        .collect();
    let norm = px.iter().map(|p| [p[0] / wf, p[1] / hf]).collect();
    (px, norm)
}

/// An irregular stain's coverage at `(x, y)` (center `(cx, cy)`, size `r`).
fn stain(x: f64, y: f64, (cx, cy): (f64, f64), r: f64) -> f64 {
    let (dx, dy) = (x - cx, y - cy);
    let a = dy.atan2(dx);
    let edge = r * (1.0 + 0.2 * (3.0 * a).sin() + 0.1 * (7.0 * a + 1.0).cos());
    (edge - (dx * dx + dy * dy).sqrt()).clamp(0.0, 1.0)
}

/// A pattern with (or without) a dark green stain at its center.
fn stained_png(
    w: u32,
    h: u32,
    r: f64,
    wall: &dyn Fn(f64, f64) -> [f64; 3],
    stained: bool,
) -> Vec<u8> {
    let center = (f64::from(w) / 2.0, f64::from(h) / 2.0);
    png(w, h, |x, y| {
        let (xf, yf) = (f64::from(x) + 0.5, f64::from(y) + 0.5);
        let c = wall(xf, yf);
        let k = if stained {
            stain(xf, yf, center, r)
        } else {
            0.0
        };
        [
            to8(c[0] * (1.0 - k) + 0.12 * k),
            to8(c[1] * (1.0 - k) + 0.2 * k),
            to8(c[2] * (1.0 - k) + 0.1 * k),
        ]
    })
}

/// Grass: green noise, brighter to the right.
fn grass(x: u32, y: u32, w: u32) -> [f64; 3] {
    let n = hash01(x / 2, y / 2) * 0.12 + hash01(x, y) * 0.05;
    let b = 0.25 + 0.35 * f64::from(x) / f64::from(w);
    [b * 0.6 + n, b + n, b * 0.4 + n * 0.5]
}

/// Grass with a red sign at `(cx, cy)` (`hw x hh` half size).
fn sign_png(w: u32, h: u32, (cx, cy): (f64, f64), (hw, hh): (f64, f64)) -> Vec<u8> {
    png(w, h, |x, y| {
        let (dx, dy) = (f64::from(x) - cx, f64::from(y) - cy);
        let c = if dx.abs() < hw && dy.abs() < hh {
            [0.8, 0.05, 0.05]
        } else {
            grass(x, y, w)
        };
        [to8(c[0]), to8(c[1]), to8(c[2])]
    })
}

fn reds(rgba: &[u8]) -> usize {
    rgba.chunks(4).filter(|p| p[0] > 120 && p[1] < 60).count()
}

// MARK: - The fill

#[cfg_attr(target_arch = "wasm32", wasm_bindgen_test::wasm_bindgen_test)]
#[cfg_attr(not(target_arch = "wasm32"), test)]
fn no_marks_render_as_before() {
    let input = sky_png(96, 64, true);
    let mut base = DevelopSettings::neutral();
    base.exposure = 0.3;
    base.clarity = 25.0;
    let mut empty = base.clone();
    empty.v = HEAL_SETTINGS_VERSION;
    let parsed = DevelopSettings::from_json(&{
        let mut v = empty.to_value();
        v["heal"] = serde_json::json!([]);
        v.to_string()
    })
    .unwrap();
    assert!(parsed.heal.is_empty());
    assert!(
        parsed.to_value().get("heal").is_none(),
        "no marks write no key"
    );
    assert_eq!(render(&input, &base).0, render(&input, &parsed).0);
}

#[cfg_attr(target_arch = "wasm32", wasm_bindgen_test::wasm_bindgen_test)]
#[cfg_attr(not(target_arch = "wasm32"), test)]
fn a_wire_across_a_sky_disappears() {
    let (w, h) = (384u32, 256u32);
    let (px, norm) = wire_stroke(w, h);
    let clean = render(&sky_png(w, h, false), &DevelopSettings::neutral()).0;
    let wired = sky_png(w, h, true);
    let radius_px = 4.0;
    let inside =
        |x: usize, y: usize| segment_distance(x as f64 + 0.5, y as f64 + 0.5, &px) < radius_px;
    let (before, _) = compare(
        &clean,
        &render(&wired, &DevelopSettings::neutral()).0,
        w as usize,
        inside,
    );
    assert!(before > 20.0, "the wire is there: {before}");
    for feather in [0.0, 0.5] {
        let heal = format!(
            "[{}]",
            mark("remove", radius_px / f64::from(w), feather, &norm, None)
        );
        let (healed, rw, _) = render(&wired, &with_heal(&DevelopSettings::neutral(), &heal));
        let (rmse, max) = compare(&clean, &healed, rw, inside);
        // Measured 0.3 / 1 level: the gradient continues through the stroke.
        assert!(
            rmse < 1.0 && max <= 4,
            "feather {feather}: rmse {rmse} max {max}"
        );
        let (outside, _) = compare(&clean, &healed, rw, |x, y| !inside(x, y));
        assert!(outside < 0.5, "the rest of the sky is untouched: {outside}");
    }
}

#[cfg_attr(target_arch = "wasm32", wasm_bindgen_test::wasm_bindgen_test)]
#[cfg_attr(not(target_arch = "wasm32"), test)]
fn regular_walls_continue_in_phase() {
    let (w, h) = (640u32, 480u32);
    let center = (320.0, 240.0);
    type Wall = Box<dyn Fn(f64, f64) -> [f64; 3]>;
    let walls: Vec<(&str, Wall, f64)> = vec![
        (
            "stripes",
            Box::new(|x: f64, _y: f64| {
                let t = 0.5 + 0.35 * (2.0 * std::f64::consts::PI * x / 14.0).sin();
                [t, t * 0.8, t * 0.6]
            }),
            0.99,
        ),
        (
            "diagonal",
            Box::new(|x: f64, y: f64| {
                let t = if ((x + y) / 10.0).floor() as i64 % 2 == 0 {
                    0.8
                } else {
                    0.25
                };
                [t, t, t * 0.9]
            }),
            0.99,
        ),
        (
            "grid",
            Box::new(|x: f64, y: f64| {
                if x % 20.0 < 2.0 || y % 20.0 < 2.0 {
                    [0.9, 0.9, 0.85]
                } else {
                    [0.3, 0.45, 0.6]
                }
            }),
            0.99,
        ),
        (
            "bricks",
            Box::new(|x: f64, y: f64| {
                let row = (y / 24.0).floor() as i64;
                let bx = (x + if row % 2 == 0 { 0.0 } else { 24.0 }) % 48.0;
                let n = 0.04 * (hash01(x as u32, y as u32) - 0.5);
                if bx < 3.0 || y % 24.0 < 3.0 {
                    [0.78, 0.76, 0.72]
                } else {
                    [0.62 + n, 0.33 + n, 0.25 + n]
                }
            }),
            0.9,
        ),
    ];
    for (name, wall, least) in &walls {
        let r = 40.0;
        let radius_px = r * 1.35 + 2.0;
        let clean = render(
            &stained_png(w, h, r, wall.as_ref(), false),
            &DevelopSettings::neutral(),
        )
        .0;
        let stained = stained_png(w, h, r, wall.as_ref(), true);
        let heal = format!(
            "[{}]",
            mark("remove", radius_px / f64::from(w), 0.0, &[[0.5, 0.5]], None)
        );
        let (healed, rw, _) = render(&stained, &with_heal(&DevelopSettings::neutral(), &heal));
        let inside = |x: usize, y: usize| {
            ((x as f64 + 0.5 - center.0).powi(2) + (y as f64 + 0.5 - center.1).powi(2)).sqrt()
                < radius_px
        };
        let corr = correlation(&clean, &healed, rw, inside);
        let (rmse, _) = compare(&clean, &healed, rw, inside);
        assert!(corr >= *least, "{name}: correlation {corr} rmse {rmse}");
    }
}

#[cfg_attr(target_arch = "wasm32", wasm_bindgen_test::wasm_bindgen_test)]
#[cfg_attr(not(target_arch = "wasm32"), test)]
fn a_flat_background_fills_with_its_color() {
    let input = png(128, 96, |x, y| {
        let (dx, dy) = (f64::from(x) - 64.0, f64::from(y) - 48.0);
        if dx * dx + dy * dy < 100.0 {
            [200, 30, 30]
        } else {
            [90, 140, 200]
        }
    });
    let flat = render(
        &png(128, 96, |_, _| [90, 140, 200]),
        &DevelopSettings::neutral(),
    )
    .0;
    // A soft brush fades its outer half: it is drawn wider.
    for (radius, feather) in [(14.0, 0.0), (22.0, 1.0)] {
        let heal = format!(
            "[{}]",
            mark("remove", radius / 128.0, feather, &[[0.5, 0.5]], None)
        );
        let (healed, rw, _) = render(&input, &with_heal(&DevelopSettings::neutral(), &heal));
        let (_, max) = compare(&flat, &healed, rw, |_, _| true);
        assert!(max <= 1, "feather {feather}: {max}");
    }
}

/// How much the image changes across the brush's edge (mean of the 4-neighbour
/// differences straddling it) over how much it changes elsewhere in the
/// texture.
fn seam(rgba: &[u8], w: usize, h: usize, center: (f64, f64), radius: f64) -> f64 {
    let d = |x: usize, y: usize| {
        ((x as f64 + 0.5 - center.0).powi(2) + (y as f64 + 0.5 - center.1).powi(2)).sqrt()
    };
    let diff = |a: usize, b: usize| -> f64 {
        (0..3)
            .map(|c| f64::from(rgba[a * 4 + c].abs_diff(rgba[b * 4 + c])))
            .sum::<f64>()
            / 3.0
    };
    let (mut edge, mut ne, mut away, mut na) = (0.0, 0.0, 0.0, 0.0);
    for y in 0..h - 1 {
        for x in 0..w - 1 {
            let k = y * w + x;
            for (nx, ny, j) in [(x + 1, y, k + 1), (x, y + 1, k + w)] {
                let (da, db) = (d(x, y), d(nx, ny));
                if (da < radius) != (db < radius) {
                    edge += diff(k, j);
                    ne += 1.0;
                } else if da > radius + 12.0 && db > radius + 12.0 {
                    away += diff(k, j);
                    na += 1.0;
                }
            }
        }
    }
    (edge / ne) / (away / na)
}

#[cfg_attr(target_arch = "wasm32", wasm_bindgen_test::wasm_bindgen_test)]
#[cfg_attr(not(target_arch = "wasm32"), test)]
fn the_edge_is_seamless_and_feather_softens_it() {
    // "写す" from a brighter place: the colors are matched at the edge.
    let (w, h) = (240u32, 160u32);
    let center = (80.0, 80.0);
    let input = png(w, h, |x, y| {
        let c = grass(x, y, w);
        [to8(c[0]), to8(c[1]), to8(c[2])]
    });
    let radius = 24.0;
    let mut seams = Vec::new();
    for feather in [0.0, 1.0] {
        let heal = format!(
            "[{}]",
            mark(
                "clone",
                radius / 240.0,
                feather,
                &[[center.0 / 240.0, center.1 / 160.0]],
                Some([0.45, 0.0])
            )
        );
        let (healed, rw, rh) = render(&input, &with_heal(&DevelopSettings::neutral(), &heal));
        seams.push(seam(&healed, rw, rh, center, radius + 0.5));
    }
    let photo = seam(
        &render(&input, &DevelopSettings::neutral()).0,
        w as usize,
        h as usize,
        center,
        radius + 0.5,
    );
    // The photo's own texture changes ~1x across any circle; the healed
    // edges stay close to it, and a soft edge less than a hard one.
    assert!(
        seams[0] < photo + 0.35,
        "hard edge {} vs photo {photo}",
        seams[0]
    );
    assert!(seams[1] <= seams[0], "soft {} hard {}", seams[1], seams[0]);
}

// MARK: - "写す"

#[cfg_attr(target_arch = "wasm32", wasm_bindgen_test::wasm_bindgen_test)]
#[cfg_attr(not(target_arch = "wasm32"), test)]
fn clone_copies_its_source() {
    let (w, h) = (200u32, 160u32);
    // Brightness changes with x only: a vertical copy needs no correction.
    let input = png(w, h, |x, y| {
        let c = grass(x, y, w);
        [to8(c[0]), to8(c[1]), to8(c[2])]
    });
    let (cx, cy, r) = (100.0, 50.0, 16.0);
    let heal = format!(
        "[{}]",
        mark(
            "clone",
            r / 200.0,
            0.0,
            &[[cx / 200.0, cy / 160.0]],
            Some([0.0, 0.4])
        )
    );
    let (healed, rw, _) = render(&input, &with_heal(&DevelopSettings::neutral(), &heal));
    let (photo, _, _) = render(&input, &DevelopSettings::neutral());
    let dy = (0.4f64 * 160.0).round() as usize;
    let (mut sum, mut n) = (0.0, 0.0);
    let (mut sa, mut sb, mut sab, mut saa, mut sbb) = (0.0, 0.0, 0.0, 0.0, 0.0);
    for y in 0..160usize {
        for x in 0..200usize {
            if ((x as f64 + 0.5 - cx).powi(2) + (y as f64 + 0.5 - cy).powi(2)).sqrt() > r - 3.0 {
                continue;
            }
            let (a, b) = (
                healed[(y * rw + x) * 4 + 1] as f64,
                photo[((y + dy) * rw + x) * 4 + 1] as f64,
            );
            sum += (a - b).abs();
            n += 1.0;
            sa += a;
            sb += b;
            sab += a * b;
            saa += a * a;
            sbb += b * b;
        }
    }
    let corr = (sab / n - sa / n * sb / n)
        / ((saa / n - (sa / n).powi(2)).sqrt() * (sbb / n - (sb / n).powi(2)).sqrt());
    // The copy is the source's grass (the color match moves it by its
    // noise: measured 2.8 levels on average).
    assert!(
        sum / n < 4.0 && corr > 0.99,
        "mean diff {} corr {corr}",
        sum / n
    );
}

#[cfg_attr(target_arch = "wasm32", wasm_bindgen_test::wasm_bindgen_test)]
#[cfg_attr(not(target_arch = "wasm32"), test)]
fn a_source_off_the_photo_is_pushed_back() {
    let input = sign_png(160, 120, (20.0, 60.0), (8.0, 6.0));
    let at = |sx: f64| {
        let heal = format!(
            "[{}]",
            mark("clone", 0.08, 0.2, &[[140.0 / 160.0, 0.5]], Some([sx, 0.0]))
        );
        render(&input, &with_heal(&DevelopSettings::neutral(), &heal)).0
    };
    // The mark's right edge is 6 px from the photo's: any farther right
    // source copies from the photo's edge.
    let far = at(0.9);
    assert_eq!(far, at(0.5));
    assert_ne!(far, at(-0.4));
}

#[cfg_attr(target_arch = "wasm32", wasm_bindgen_test::wasm_bindgen_test)]
#[cfg_attr(not(target_arch = "wasm32"), test)]
fn an_automatic_source_is_deterministic_and_skips_the_object() {
    let input = sign_png(240, 160, (80.0, 80.0), (14.0, 9.0));
    assert!(reds(&render(&input, &DevelopSettings::neutral()).0) > 300);
    let heal = format!(
        "[{}]",
        mark("clone", 24.0 / 240.0, 0.3, &[[80.0 / 240.0, 0.5]], None)
    );
    let s = with_heal(&DevelopSettings::neutral(), &heal);
    let first = render(&input, &s).0;
    assert_eq!(reds(&first), 0);
    assert_eq!(first, render(&input, &s).0);
}

// MARK: - Edges and extremes

#[cfg_attr(target_arch = "wasm32", wasm_bindgen_test::wasm_bindgen_test)]
#[cfg_attr(not(target_arch = "wasm32"), test)]
fn edges_corners_and_extremes_render() {
    let input = sign_png(160, 120, (6.0, 6.0), (6.0, 6.0));
    let base = DevelopSettings::neutral();
    let many: Vec<String> = (0..64)
        .map(|i| {
            let (x, y) = (
                0.05 + 0.9 * f64::from(i % 8) / 7.0,
                0.05 + 0.9 * f64::from(i / 8) / 7.0,
            );
            mark(
                if i % 3 == 0 { "clone" } else { "remove" },
                0.01,
                0.5,
                &[[x, y]],
                None,
            )
            .replacen(r#""id":"m"#, &format!(r#""id":"k{i}_"#), 1)
        })
        .collect();
    let cases = [
        // A corner, the top edge, a mark over most of the photo.
        format!("[{}]", mark("remove", 0.12, 0.0, &[[0.0, 0.0]], None)),
        format!(
            "[{}]",
            mark("remove", 0.03, 0.5, &[[0.0, 0.0], [1.0, 0.0]], None)
        ),
        format!(
            "[{}]",
            mark(
                "remove",
                0.25,
                0.5,
                &[[0.0, 0.0], [1.0, 1.0], [0.0, 1.0], [1.0, 0.0], [0.5, 0.5]],
                None
            )
        ),
        // One point, the same point again and again, the smallest and the
        // largest radius.
        format!("[{}]", mark("remove", 0.05, 0.0, &[[0.5, 0.5]], None)),
        format!("[{}]", mark("remove", 0.05, 0.0, &[[0.5, 0.5]; 40], None)),
        format!("[{}]", mark("remove", 0.002, 0.0, &[[0.3, 0.3]], None)),
        format!("[{}]", mark("clone", 0.25, 1.0, &[[0.5, 0.5]], None)),
        format!("[{}]", many.join(",")),
    ];
    for heal in &cases {
        let s = with_heal(&base, heal);
        let first = render(&input, &s).0;
        assert_eq!(first, render(&input, &s).0, "{heal}");
    }
    // The corner sign is removed.
    let corner = with_heal(&base, &cases[0]);
    assert_eq!(reds(&render(&input, &corner).0), 0);
}

#[cfg_attr(target_arch = "wasm32", wasm_bindgen_test::wasm_bindgen_test)]
#[cfg_attr(not(target_arch = "wasm32"), test)]
fn marks_apply_in_the_order_drawn() {
    let input = sign_png(160, 120, (80.0, 60.0), (10.0, 8.0));
    let base = DevelopSettings::neutral();
    let copy = mark("clone", 0.1, 0.0, &[[0.5, 0.5]], Some([-0.3, 0.0]));
    let fill =
        mark("remove", 0.06, 0.3, &[[0.55, 0.5]], None).replacen(r#""id":"m"#, r#""id":"r"#, 1);
    let a = render(&input, &with_heal(&base, &format!("[{copy},{fill}]"))).0;
    let b = render(&input, &with_heal(&base, &format!("[{fill},{copy}]"))).0;
    assert_ne!(a, b);
    assert_eq!(reds(&a), 0);
    assert_eq!(reds(&b), 0);
}

// MARK: - Geometry

#[cfg_attr(target_arch = "wasm32", wasm_bindgen_test::wasm_bindgen_test)]
#[cfg_attr(not(target_arch = "wasm32"), test)]
fn marks_stay_on_the_photo_through_the_geometry() {
    // Two dark dots on a flat photo; the mark covers the first. Whatever the
    // geometry, the result is the photo with the second dot only.
    let dot = |x: u32, y: u32, (cx, cy): (f64, f64)| {
        (f64::from(x) + 0.5 - cx).powi(2) + (f64::from(y) + 0.5 - cy).powi(2) < 36.0
    };
    let (d1, d2) = ((60.0, 50.0), (170.0, 110.0));
    let both = png(240, 160, |x, y| {
        if dot(x, y, d1) || dot(x, y, d2) {
            [20, 20, 20]
        } else {
            [150, 160, 170]
        }
    });
    let second = png(240, 160, |x, y| {
        if dot(x, y, d2) {
            [20, 20, 20]
        } else {
            [150, 160, 170]
        }
    });
    let heal = format!(
        "[{}]",
        mark("remove", 0.05, 0.0, &[[60.0 / 240.0, 50.0 / 160.0]], None)
    );
    let base = DevelopSettings::neutral();
    for geometry in [
        r#"{}"#,
        r#"{"rotate":90}"#,
        r#"{"flipH":true}"#,
        r#"{"rotate":270,"flipV":true}"#,
        r#"{"angle":7,"crop":{"left":0.05,"top":0.05,"right":0.95,"bottom":0.95}}"#,
        r#"{"perspective":{"vertical":-30,"rotate":2}}"#,
        r#"{"crop":{"left":0.0,"top":0.0,"right":0.5,"bottom":1.0}}"#,
    ] {
        let healed = with_heal(&with_geometry(&base, geometry), &heal);
        let expected = with_geometry(&base, geometry);
        let (a, w, _) = render(&both, &healed);
        let (b, _, _) = render(&second, &expected);
        let (rmse, max) = compare(&a, &b, w, |_, _| true);
        assert!(rmse < 0.5 && max <= 3, "{geometry}: rmse {rmse} max {max}");
    }
}

// MARK: - Session

#[cfg_attr(target_arch = "wasm32", wasm_bindgen_test::wasm_bindgen_test)]
#[cfg_attr(not(target_arch = "wasm32"), test)]
fn a_session_plans_each_mark_once() {
    let input = sign_png(240, 160, (60.0, 60.0), (8.0, 6.0));
    let mut session = Session::open_raster(&input, 0, Filter::Lanczos3).unwrap();
    let base = DevelopSettings::neutral();
    let near = mark("remove", 0.05, 0.3, &[[0.25, 0.375]], None);
    let far =
        mark("remove", 0.04, 0.3, &[[0.85, 0.8]], None).replacen(r#""id":"m"#, r#""id":"f"#, 1);
    let moved =
        mark("remove", 0.04, 0.3, &[[0.8, 0.8]], None).replacen(r#""id":"m"#, r#""id":"f"#, 1);
    let render = |s: &mut Session, settings: &DevelopSettings| {
        s.render(settings, 120, Quality::Final).unwrap().rgba
    };
    let one = with_heal(&base, &format!("[{near}]"));
    let first = render(&mut session, &one);
    assert_eq!(
        session.heal_stats(),
        HealStats {
            planned: 1,
            healed: 1
        }
    );
    // Colors and tones: neither searched nor applied again.
    let mut brighter = one.clone();
    brighter.exposure = 0.6;
    brighter.contrast = 30.0;
    let lit = render(&mut session, &brighter);
    assert_ne!(lit, first);
    assert_eq!(
        session.heal_stats(),
        HealStats {
            planned: 1,
            healed: 1
        }
    );
    assert_eq!(render(&mut session, &one), first);
    // A new mark plans that mark only; moving it, that mark again; deleting
    // it, nothing.
    render(&mut session, &with_heal(&base, &format!("[{near},{far}]")));
    assert_eq!(
        session.heal_stats(),
        HealStats {
            planned: 2,
            healed: 2
        }
    );
    render(
        &mut session,
        &with_heal(&base, &format!("[{near},{moved}]")),
    );
    assert_eq!(
        session.heal_stats(),
        HealStats {
            planned: 3,
            healed: 3
        }
    );
    assert_eq!(render(&mut session, &one), first);
    assert_eq!(
        session.heal_stats(),
        HealStats {
            planned: 3,
            healed: 4
        }
    );
    // No marks: the photo as it was.
    let plain = render(&mut session, &base);
    let fresh = Session::open_raster(&input, 0, Filter::Lanczos3)
        .unwrap()
        .render(&base, 120, Quality::Final)
        .unwrap()
        .rgba;
    assert_eq!(plain, fresh);
    // A session's frames are a fresh session's.
    let mut other = Session::open_raster(&input, 0, Filter::Lanczos3).unwrap();
    assert_eq!(
        other.render(&brighter, 120, Quality::Final).unwrap().rgba,
        lit
    );
}

#[cfg_attr(target_arch = "wasm32", wasm_bindgen_test::wasm_bindgen_test)]
#[cfg_attr(not(target_arch = "wasm32"), test)]
fn a_one_shot_render_heals_as_a_session_does() {
    let input = sign_png(200, 140, (70.0, 70.0), (10.0, 7.0));
    let heal = format!("[{}]", mark("remove", 0.08, 0.3, &[[0.35, 0.5]], None));
    for geometry in [
        None,
        Some(r#"{"angle":3,"crop":{"left":0.1,"top":0.0,"right":0.9,"bottom":1.0}}"#),
    ] {
        let mut s = with_heal(&DevelopSettings::neutral(), &heal);
        if let Some(g) = geometry {
            s = with_geometry(&s, g);
        }
        let options = RenderOptions {
            max_dimension: 0,
            quality: Quality::Final,
            filter: Filter::Lanczos3,
            decode_cap: 0,
        };
        let once = niho_develop::render(&input, &s.to_json(), &options).unwrap();
        assert_eq!(once.rgba, render(&input, &s).0, "{geometry:?}");
        assert_eq!(reds(&once.rgba), 0);
    }
}

#[cfg_attr(target_arch = "wasm32", wasm_bindgen_test::wasm_bindgen_test)]
#[cfg_attr(not(target_arch = "wasm32"), test)]
fn a_reduced_preview_looks_like_the_full_size_render() {
    // The preview heals the photo opened at half size; the export heals it
    // at full size (then reduced here to compare).
    let (w, h) = (480u32, 320u32);
    let input = sign_png(w, h, (150.0, 160.0), (18.0, 12.0));
    let heal = format!(
        "[{}]",
        mark("remove", 30.0 / 480.0, 0.3, &[[150.0 / 480.0, 0.5]], None)
    );
    let s = with_heal(&DevelopSettings::neutral(), &heal);
    let preview = Session::open_raster(&input, 240, Filter::Lanczos3)
        .unwrap()
        .render(&s, 0, Quality::Final)
        .unwrap();
    let export = Session::open_raster(&input, 0, Filter::Lanczos3)
        .unwrap()
        .render(&s, 240, Quality::Final)
        .unwrap();
    assert_eq!(
        (preview.width, preview.height),
        (export.width, export.height)
    );
    let inside = |x: usize, y: usize| {
        ((x as f64 + 0.5 - 75.0).powi(2) + (y as f64 + 0.5 - 80.0).powi(2)).sqrt() < 15.0
    };
    let (rmse, _) = compare(&preview.rgba, &export.rgba, preview.width, inside);
    let (outside, _) = compare(&preview.rgba, &export.rgba, preview.width, |x, y| {
        !inside(x, y)
    });
    assert_eq!(reds(&preview.rgba), 0);
    assert_eq!(reds(&export.rgba), 0);
    // The fills differ in their grass (different pixels to copy) but not in
    // their tone.
    assert!(
        rmse < 12.0 && outside < 3.0,
        "inside {rmse} outside {outside}"
    );
}

// MARK: - Working copies

#[cfg_attr(target_arch = "wasm32", wasm_bindgen_test::wasm_bindgen_test)]
#[cfg_attr(not(target_arch = "wasm32"), test)]
fn working_copies_heal_their_master() {
    let (w, h) = (128usize, 96usize);
    let wired = |wire: bool| {
        let mut data = Vec::with_capacity(w * h * 3);
        for y in 0..h {
            for x in 0..w {
                let t = y as f32 / h as f32;
                let on = wire && ((y as f32 + 0.5) - (30.0 + 0.1 * x as f32)).abs() < 1.2;
                let v = if on {
                    [0.01, 0.01, 0.012]
                } else {
                    [0.08 + 0.5 * t, 0.15 + 0.45 * t, 0.5 + 0.2 * t]
                };
                data.extend_from_slice(&v);
            }
        }
        LinearImage {
            width: w,
            height: h,
            data,
        }
    };
    let stroke: Vec<[f64; 2]> = vec![[0.0, 30.0 / 96.0], [1.0, (30.0 + 12.8) / 96.0]];
    let heal = format!("[{}]", mark("remove", 4.0 / 128.0, 0.0, &stroke, None));
    let px: Vec<[f64; 2]> = stroke.iter().map(|p| [p[0] * 128.0, p[1] * 96.0]).collect();
    let inside = |x: usize, y: usize| segment_distance(x as f64 + 0.5, y as f64 + 0.5, &px) < 4.0;

    // A raster working copy (linear ProPhoto).
    let meta = r#"{"kind":"raster","iccSha256":"sRGB"}"#;
    let open = |wire: bool| {
        Session::open_working_copy(
            &decode::encode_working_copy(&wired(wire)),
            meta,
            Filter::Lanczos3,
        )
        .unwrap()
    };
    let base = DevelopSettings::neutral();
    let clean = open(false).render(&base, 0, Quality::Final).unwrap().rgba;
    let healed = open(true)
        .render(&with_heal(&base, &heal), 0, Quality::Final)
        .unwrap()
        .rgba;
    let (rmse, _) = compare(&clean, &healed, w, inside);
    assert!(rmse < 1.5, "raster working copy: {rmse}");

    // A signed RAW working copy: the prepared master is healed, and moving
    // a master slider applies the kept plan again without searching.
    let metadata = |ceiling: f64| {
        format!(
            r#"{{"kind":"raw","baselineEV":0.25,"asShotWhite":{{"x":0.3127,"y":0.329,"temperature":5500,"tint":4}},"asShotWhiteAdobe":null,"whiteBalanceTable":null,"dcpSha256":"fixture","lookTableIncluded":false,"encoding":{{"kind":"signed-gamma18-v1","ceiling":{ceiling}}}}}"#
        )
    };
    let mut niho3 = DevelopSettings::neutral();
    niho3.engine = "niho-3".into();
    niho3.look = "niho-standard-2".into();
    let signed = |wire: bool| {
        let (png, encoding) = encode_signed_working_copy(&wired(wire)).unwrap();
        Session::open_working_copy(&png, &metadata(encoding.ceiling()), Filter::Lanczos3).unwrap()
    };
    let clean = signed(false)
        .render(&niho3, 0, Quality::Final)
        .unwrap()
        .rgba;
    let mut session = signed(true);
    let s = with_heal(&niho3, &heal);
    let healed = session.render(&s, 0, Quality::Final).unwrap().rgba;
    let (rmse, _) = compare(&clean, &healed, w, inside);
    assert!(rmse < 1.5, "signed RAW: {rmse}");
    let mut exposed = s.clone();
    exposed.exposure = 0.5;
    let lit = session.render(&exposed, 0, Quality::Final).unwrap().rgba;
    assert_eq!(
        session.heal_stats(),
        HealStats {
            planned: 1,
            healed: 2
        }
    );
    assert_eq!(
        signed(true)
            .render(&exposed, 0, Quality::Final)
            .unwrap()
            .rgba,
        lit
    );
}

// MARK: - Settings and presets

#[cfg_attr(target_arch = "wasm32", wasm_bindgen_test::wasm_bindgen_test)]
#[cfg_attr(not(target_arch = "wasm32"), test)]
fn marks_need_v8_and_round_trip() {
    assert_eq!(HEAL_SETTINGS_VERSION, 8);
    assert_eq!(MAX_SETTINGS_VERSION, 8);
    assert!((1..=8).all(|version| READABLE_SETTINGS_VERSIONS.contains(&version)));
    let heal = format!(
        "[{}]",
        mark(
            "clone",
            0.02,
            0.4,
            &[[0.1, 0.2], [0.3, 0.4]],
            Some([0.1, -0.2])
        )
    );
    let mut perspective = DevelopSettings::neutral();
    perspective.v = 7;
    let s = with_heal(
        &with_geometry(&perspective, r#"{"perspective":{"vertical":-20}}"#),
        &heal,
    );
    assert_eq!(s.required_version(), 8);
    assert_eq!(s.v, 8);
    let mut value = s.to_value();
    value["futureKey"] = serde_json::json!({"a": 1});
    let parsed = DevelopSettings::from_value(&value).unwrap();
    assert_eq!(parsed.heal, s.heal);
    assert_eq!(parsed.extra["futureKey"]["a"], 1);
    assert_eq!(
        DevelopSettings::from_value(&parsed.to_value()).unwrap(),
        parsed
    );
    assert!(s.is_neutral(), "the marks are not a color edit");
    for v in [1, 4, 7] {
        let mut low = s.clone();
        low.v = v;
        assert!(low
            .validate()
            .iter()
            .any(|e| e.path == "v" && e.code == "versionTooLow"));
    }
    // A reader that does not know v8 refuses it.
    let mut text = s.to_value();
    text["v"] = 9.into();
    assert_eq!(
        DevelopSettings::from_value(&text).unwrap_err().code,
        "unsupportedVersion"
    );
    // "補正前" shows the photo without the marks (and keeps its geometry).
    let before =
        DevelopSettings::from_json(&niho_develop::before_settings(&s.to_json()).unwrap()).unwrap();
    assert!(before.heal.is_empty() && before.geometry.is_some());
}

#[cfg_attr(target_arch = "wasm32", wasm_bindgen_test::wasm_bindgen_test)]
#[cfg_attr(not(target_arch = "wasm32"), test)]
fn presets_neither_write_nor_drop_the_marks() {
    let heal = format!(
        "[{}]",
        mark("remove", 0.02, 0.4, &[[0.1, 0.2], [0.3, 0.4]], None)
    );
    let mut base = DevelopSettings::neutral();
    base.exposure = 0.4;
    base.contrast = 20.0;
    let s = with_heal(&base, &heal);
    let written = xmp::settings_to_xmp(&s, &XmpWriteOptions::default());
    assert!(written.not_written.is_empty(), "{:?}", written.not_written);
    let text = written.to_value()["xmp"].as_str().unwrap().to_string();
    assert!(!text.contains("heal") && !text.contains("Retouch"));
    let preset = r#"<x:xmpmeta xmlns:x="adobe:ns:meta/"><rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#">
<rdf:Description rdf:about="" xmlns:crs="http://ns.adobe.com/camera-raw-settings/1.0/" crs:Contrast2012="+45" crs:Saturation="-20"/></rdf:RDF></x:xmpmeta>"#;
    let applied = xmp::preset_settings(preset, Some(&s)).unwrap().settings;
    assert_eq!(applied.heal, s.heal);
    assert_eq!(applied.v, 8);
    let half = xmp::apply_preset(preset, &s, 0.5, None).unwrap().settings;
    assert_eq!(half.heal, s.heal);
    assert!(half.validate().is_empty());
}

// MARK: - Native and wasm

#[cfg_attr(target_arch = "wasm32", wasm_bindgen_test::wasm_bindgen_test)]
#[cfg_attr(not(target_arch = "wasm32"), test)]
fn native_and_wasm_heal_the_same() {
    let sign = sign_png(120, 80, (40.0, 40.0), (8.0, 6.0));
    let (_, norm) = wire_stroke(120, 80);
    let sky = sky_png(120, 80, true);
    let wall = stained_png(
        120,
        80,
        14.0,
        &|x: f64, y: f64| {
            if x % 12.0 < 2.0 || y % 12.0 < 2.0 {
                [0.9, 0.9, 0.85]
            } else {
                [0.3, 0.45, 0.6]
            }
        },
        true,
    );
    let mut base = DevelopSettings::neutral();
    base.exposure = 0.2;
    base.shadows = 20.0;
    let mut hashes = Vec::new();
    for (input, heal) in [
        (
            &sign,
            format!(
                "[{}]",
                mark("remove", 0.12, 0.3, &[[40.0 / 120.0, 0.5]], None)
            ),
        ),
        (
            &sign,
            format!(
                "[{}]",
                mark("clone", 0.12, 0.6, &[[40.0 / 120.0, 0.5]], Some([0.4, 0.1]))
            ),
        ),
        (
            &sign,
            format!(
                "[{}]",
                mark("clone", 0.12, 0.0, &[[40.0 / 120.0, 0.5]], None)
            ),
        ),
        (
            &sky,
            format!("[{}]", mark("remove", 0.02, 0.5, &norm, None)),
        ),
        (
            &wall,
            format!("[{}]", mark("remove", 0.17, 0.0, &[[0.5, 0.5]], None)),
        ),
    ] {
        let s = with_heal(&base, &heal);
        let mut session = Session::open_raster(input, 0, Filter::Lanczos3).unwrap();
        for m in [0usize, 60] {
            let f = session.render(&s, m, Quality::Final).unwrap();
            hashes.push((f.width, f.height, fnv1a64(&f.rgba)));
        }
    }
    assert_eq!(hashes, EXPECTED_HASHES);
}

/// [`native_and_wasm_heal_the_same`]'s frames (recorded on native; the
/// wasm build must match them).
const EXPECTED_HASHES: [(usize, usize, u64); 10] = [
    (120, 80, 8_084_928_091_424_890_712),
    (60, 40, 3_608_808_321_209_035_464),
    (120, 80, 18_386_439_498_534_960_265),
    (60, 40, 3_481_787_538_192_080_150),
    (120, 80, 7_714_011_338_224_522_187),
    (60, 40, 8_118_400_537_332_392_498),
    (120, 80, 5_200_283_417_591_265_288),
    (60, 40, 1_681_475_836_753_405_830),
    (120, 80, 7_924_311_437_323_005_391),
    (60, 40, 808_804_773_136_659_307),
];
