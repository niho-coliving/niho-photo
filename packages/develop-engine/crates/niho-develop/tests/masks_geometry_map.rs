//! The mask plane's output-to-working-image map ([`SourceMap`]) is
//! TypeScript's `geometryOutputToSource` (`docs/local-adjustments.md` "座標"):
//! `fixtures/masks/geometry-map-cases.json` holds that function's values
//! (written and checked by `develop-masks-geometry-map.test.ts`), and the
//! Rust map must give them to [`TOLERANCE`] for every quarter turn, flip,
//! crop, turned crop (the inscribed shrink included) and perspective (with
//! and without "余白を埋める"). Past the perspective's vanishing line, where
//! TypeScript returns `null`, [`SourceMap::checked_source_of`] is `None` and
//! the total [`SourceMap::source_of`] stays finite. On a perspective the
//! planes ([`local_render::mask_weights`], `Session::mask_plane`) and the
//! masked render follow the fixture's points at output pixel centres. Also
//! run by the wasm-bindgen test command.

use niho_develop::local_render::{self, SourceMap, FULL_WEIGHT};
use niho_develop::{encode, DevelopSettings, Filter, Geometry, Quality, Session};
use serde_json::{json, Value};

const CASES: &str = include_str!("fixtures/masks/geometry-map-cases.json");

/// The largest difference allowed from TypeScript's value (`0..1` of the
/// working image).
const TOLERANCE: f64 = 1e-9;

fn fixture() -> Value {
    serde_json::from_str(CASES).unwrap()
}

/// One fixture point: the output position (and its pixel for `pixels`)
/// and TypeScript's working-image position (`None`: `null`).
struct Point {
    pixel: Option<(usize, usize)>,
    px: f64,
    py: f64,
    source: Option<[f64; 2]>,
}

fn points(case: &Value) -> Vec<Point> {
    case["points"]
        .as_array()
        .unwrap()
        .iter()
        .map(|p| {
            let source = match (p["sx"].as_f64(), p["sy"].as_f64()) {
                (Some(sx), Some(sy)) => Some([sx, sy]),
                _ => {
                    assert!(p["sx"].is_null() && p["sy"].is_null(), "{p}");
                    None
                }
            };
            Point {
                pixel: p["i"]
                    .as_u64()
                    .map(|i| (i as usize, p["j"].as_u64().unwrap() as usize)),
                px: p["px"].as_f64().unwrap(),
                py: p["py"].as_f64().unwrap(),
                source,
            }
        })
        .collect()
}

fn size(value: &Value) -> (usize, usize) {
    (
        value["width"].as_u64().unwrap() as usize,
        value["height"].as_u64().unwrap() as usize,
    )
}

fn map_of(case: &Value) -> SourceMap {
    let geometry = Geometry::from_value(&case["geometry"]).unwrap();
    let (width, height) = size(&case["source"]);
    SourceMap::new(Some(&geometry), width, height)
        .unwrap_or_else(|_| panic!("{}: a rectangle", case["name"]))
}

#[cfg_attr(target_arch = "wasm32", wasm_bindgen_test::wasm_bindgen_test)]
#[cfg_attr(not(target_arch = "wasm32"), test)]
fn the_map_is_typescripts_geometry_output_to_source() {
    let doc = fixture();
    let cases = doc["cases"].as_array().unwrap();
    let pixels = doc["pixels"].as_array().unwrap();
    assert!(cases.len() >= 120, "{} cases", cases.len());
    assert!(pixels.len() >= 3, "{} pixel cases", pixels.len());
    let (mut mapped, mut beyond, mut perspective) = (0, 0, 0);
    let mut worst = 0.0f64;
    for case in cases.iter().chain(pixels) {
        let name = case["name"].as_str().unwrap();
        perspective += usize::from(case["geometry"].get("perspective").is_some());
        let map = map_of(case);
        for p in points(case) {
            let total = map.source_of(p.px, p.py);
            let checked = map.checked_source_of(p.px, p.py);
            match p.source {
                Some([sx, sy]) => {
                    // Where TypeScript has a value, both are it.
                    assert_eq!(checked, Some(total), "{name} at ({}, {})", p.px, p.py);
                    let d = (total[0] - sx).abs().max((total[1] - sy).abs());
                    assert!(
                        d < TOLERANCE,
                        "{name} at ({}, {}): {total:?} vs ({sx}, {sy})",
                        p.px,
                        p.py
                    );
                    worst = worst.max(d);
                    mapped += 1;
                }
                None => {
                    // Past the vanishing line: no position, the total map
                    // stays finite.
                    assert_eq!(checked, None, "{name} at ({}, {})", p.px, p.py);
                    assert!(total.iter().all(|c| c.is_finite()), "{name}: {total:?}");
                    beyond += 1;
                }
            }
        }
    }
    assert!(mapped >= 1500, "{mapped} points");
    assert!(beyond >= 1, "a point past the vanishing line");
    assert!(perspective >= 60, "{perspective} cases with a perspective");
    // The measured difference is rounding only.
    assert!(worst < 1e-12, "{worst}");
}

/// The masks the plane tests draw: a ramp and a hard-edged turned ellipse,
/// in working-image coordinates.
fn masks() -> Value {
    json!([
        {"id": "ramp", "kind": "linear", "zero": {"x": 0.5, "y": 0.3}, "full": {"x": 0.58, "y": 0.75},
         "adjust": {"exposure": -1}},
        {"id": "spot", "kind": "radial", "center": {"x": 0.38, "y": 0.55}, "radius": {"x": 0.22, "y": 0.3},
         "angle": 20, "feather": 0, "adjust": {"exposure": -1}}
    ])
}

/// `m` of `mask` at working-image position `(u, v)` on a working image of
/// aspect `a`, by `docs/local-adjustments.md` "面の式" (`f32`, the shape's
/// constants from `f64`).
fn plane_value(mask: &Value, [u, v]: [f64; 2], a: f64) -> f32 {
    let at = |path: &[&str]| path.iter().fold(mask, |m, k| &m[*k]).as_f64().unwrap();
    let (x, y) = ((u * a) as f32, v as f32);
    let m = match mask["kind"].as_str().unwrap() {
        "linear" => {
            let (zx, zy) = ((at(&["zero", "x"]) * a) as f32, at(&["zero", "y"]) as f32);
            let (fx, fy) = ((at(&["full", "x"]) * a) as f32, at(&["full", "y"]) as f32);
            let (dx, dy) = (fx - zx, fy - zy);
            (((x - zx) * dx + (y - zy) * dy) / (dx * dx + dy * dy)).clamp(0.0, 1.0)
        }
        "radial" => {
            let theta = at(&["angle"]) * core::f64::consts::PI / 180.0;
            let (cos, sin) = (libm::cos(theta) as f32, libm::sin(theta) as f32);
            let (ox, oy) = (
                x - (at(&["center", "x"]) * a) as f32,
                y - at(&["center", "y"]) as f32,
            );
            let px = ox * cos + oy * sin;
            let py = -ox * sin + oy * cos;
            let (qx, qy) = (
                px / (at(&["radius", "x"]) * a) as f32,
                py / at(&["radius", "y"]) as f32,
            );
            let r = (qx * qx + qy * qy).sqrt();
            let f = ((at(&["feather"]) / 100.0) as f32).max(0.002);
            let s = ((1.0 - r) / f).clamp(0.0, 1.0);
            s * s * (3.0 - 2.0 * s)
        }
        kind => panic!("{kind}"),
    };
    if mask["invert"].as_bool() == Some(true) {
        1.0 - m
    } else {
        m
    }
}

fn settings(geometry: &Value, masks: Value) -> DevelopSettings {
    DevelopSettings::from_value(&json!({
        "v": 7, "engine": "niho-10", "look": "niho-standard-1", "base": null,
        "geometry": geometry, "masks": masks
    }))
    .unwrap()
}

/// An output pixel `(i, j)` and TypeScript's working-image position of its
/// centre.
type PixelPoint = ((usize, usize), [f64; 2]);

/// The fixture's pixel cases with TypeScript's position at each point.
fn pixel_cases() -> Vec<(Value, Vec<PixelPoint>)> {
    fixture()["pixels"]
        .as_array()
        .unwrap()
        .iter()
        .map(|case| {
            let pixels = points(case)
                .into_iter()
                .map(|p| (p.pixel.unwrap(), p.source.expect("a position")))
                .collect();
            (case.clone(), pixels)
        })
        .collect()
}

#[cfg_attr(target_arch = "wasm32", wasm_bindgen_test::wasm_bindgen_test)]
#[cfg_attr(not(target_arch = "wasm32"), test)]
fn planes_on_a_perspective_are_the_planes_at_typescripts_points() {
    let masks = masks();
    let mut inverted = masks[1].clone();
    inverted["invert"] = json!(true);
    for (case, pixels) in pixel_cases() {
        let name = case["name"].as_str().unwrap();
        let (sw, sh) = size(&case["source"]);
        let (w, h) = size(&case["output"]);
        let map = map_of(&case);
        // The same geometry without its perspective (the map before the
        // perspective was mapped) draws another plane.
        let mut flat = case["geometry"].clone();
        flat.as_object_mut().unwrap().remove("perspective");
        let flat = SourceMap::new(Some(&Geometry::from_value(&flat).unwrap()), sw, sh).unwrap();
        for mask in [&masks[0], &masks[1], &inverted] {
            let local = settings(&case["geometry"], json!([mask])).masks[0].clone();
            let plane = local_render::mask_weights(&local, &map, w, h, None).unwrap();
            for &((i, j), source) in &pixels {
                let want =
                    local_render::weight_of(plane_value(mask, source, sw as f64 / sh as f64));
                let got = plane[j * w + i];
                assert!(
                    got.abs_diff(want) <= 1,
                    "{name} {} ({i}, {j}): {got} vs {want}",
                    mask["id"]
                );
            }
            assert_ne!(
                local_render::mask_weights(&local, &flat, w, h, None).unwrap(),
                plane,
                "{name}: the perspective moves the plane"
            );
        }
    }
}

/// A synthetic photo: a gradient with a bright block.
fn photo_png(w: usize, h: usize) -> Vec<u8> {
    let mut rgba = Vec::with_capacity(w * h * 4);
    for y in 0..h {
        for x in 0..w {
            let block = x > w * 2 / 3 && y < h / 3;
            let (r, g, b) = if block {
                (235, 240, 250)
            } else {
                (
                    (40 + x * 160 / w) as u8,
                    (50 + y * 140 / h) as u8,
                    ((x + y) * 90 / (w + h) + 60) as u8,
                )
            };
            rgba.extend_from_slice(&[r, g, b, 255]);
        }
    }
    encode::encode_png(&rgba, w, h).unwrap()
}

#[cfg_attr(target_arch = "wasm32", wasm_bindgen_test::wasm_bindgen_test)]
#[cfg_attr(not(target_arch = "wasm32"), test)]
fn session_planes_on_a_perspective_follow_typescripts_map() {
    let masks = masks();
    for (case, pixels) in pixel_cases() {
        let name = case["name"].as_str().unwrap();
        let (sw, sh) = size(&case["source"]);
        let session = Session::open_raster(&photo_png(sw, sh), 0, Filter::Lanczos3).unwrap();
        let s = settings(&case["geometry"], masks.clone());
        let max_dimension = case["maxDimension"].as_u64().unwrap() as usize;
        for mask in masks.as_array().unwrap() {
            let id = mask["id"].as_str().unwrap();
            let (w, h, plane) = session.mask_plane(&s, id, max_dimension).unwrap();
            assert_eq!((w, h), size(&case["output"]), "{name}: the render's size");
            for &((i, j), source) in &pixels {
                let m = plane_value(mask, source, sw as f64 / sh as f64);
                let want = local_render::weight_to_u8(local_render::weight_of(m));
                let got = plane[j * w + i];
                assert!(
                    got.abs_diff(want) <= 1,
                    "{name} {id} ({i}, {j}): {got} vs {want}"
                );
            }
        }
    }
}

#[cfg_attr(target_arch = "wasm32", wasm_bindgen_test::wasm_bindgen_test)]
#[cfg_attr(not(target_arch = "wasm32"), test)]
fn a_masked_render_on_a_perspective_changes_the_content_under_the_mask() {
    // The spot only (exposure -1): where TypeScript's position is outside
    // it the frame is the plain one, inside it darker.
    let spot = masks()[1].clone();
    for (case, pixels) in pixel_cases() {
        let name = case["name"].as_str().unwrap();
        let (sw, sh) = size(&case["source"]);
        let (w, h) = size(&case["output"]);
        let max_dimension = case["maxDimension"].as_u64().unwrap() as usize;
        let masked = settings(&case["geometry"], json!([spot]));
        let plain = settings(&case["geometry"], json!([]));
        let mut session = Session::open_raster(&photo_png(sw, sh), 0, Filter::Lanczos3).unwrap();
        for quality in [Quality::Interactive, Quality::Final] {
            let frame = session.render(&masked, max_dimension, quality).unwrap();
            let before = session.render(&plain, max_dimension, quality).unwrap();
            assert_eq!((frame.width, frame.height), (w, h), "{name}");
            let rgb = |rgba: &[u8], i: usize, j: usize| {
                let p = (j * w + i) * 4;
                [rgba[p], rgba[p + 1], rgba[p + 2]]
            };
            let luma = |c: [u8; 3]| c.iter().map(|v| u32::from(*v)).sum::<u32>();
            let (mut outside, mut inside) = (0, 0);
            for &((i, j), source) in &pixels {
                let weight =
                    local_render::weight_of(plane_value(&spot, source, sw as f64 / sh as f64));
                let (a, b) = (rgb(&frame.rgba, i, j), rgb(&before.rgba, i, j));
                if weight == 0 {
                    assert_eq!(a, b, "{name} {quality:?} ({i}, {j}) outside the spot");
                    outside += 1;
                } else if weight == FULL_WEIGHT {
                    assert!(
                        luma(a) < luma(b),
                        "{name} {quality:?} ({i}, {j}) inside the spot: {a:?} {b:?}"
                    );
                    inside += 1;
                }
            }
            assert!(
                outside >= 20 && inside >= 20,
                "{name}: {outside} / {inside}"
            );
        }
    }
}
