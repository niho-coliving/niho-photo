//! The perspective of the geometry (niho-photo#46, `src/perspective.rs`):
//! the window samples the frame through the inverse warp, the identity's
//! values render bit for bit as before, a Session redraws when only the
//! perspective changes, "余白を埋める" sizes the output, native and wasm
//! render the same bytes (this file is in the wasm cross-target run), and
//! XMP presets read, write and blend the Transform sliders. Synthetic
//! images only. The whole file is also run by the wasm-bindgen test
//! command (`scripts/ci/run-scope.mjs`).

use niho_develop::decode::LinearImage;
use niho_develop::frame;
use niho_develop::geometry::Geometry;
use niho_develop::settings::PERSPECTIVE_SETTINGS_VERSION;
use niho_develop::xmp::{self, Level, XmpGroup, XmpWriteOptions};
use niho_develop::{DevelopSettings, Filter, Quality, Session};

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

/// A grid of lines over a soft gradient (an architecture-like test card).
fn grid_png(width: u32, height: u32) -> Vec<u8> {
    png(width, height, |x, y| {
        if x % 16 == 0 || y % 16 == 0 {
            [235, 235, 235]
        } else {
            [
                (40 + x * 120 / width) as u8,
                (60 + y * 100 / height) as u8,
                (90 + (x + y) * 60 / (width + height)) as u8,
            ]
        }
    })
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

fn geometry(json: &str) -> Geometry {
    Geometry::from_value(&serde_json::from_str(json).unwrap()).unwrap()
}

fn edited() -> DevelopSettings {
    let mut s = DevelopSettings::neutral();
    s.exposure = 0.2;
    s.contrast = 15.0;
    s.shadows = 30.0;
    s.clarity = 20.0;
    s
}

fn fnv1a64(bytes: &[u8]) -> u64 {
    bytes.iter().fold(0xcbf2_9ce4_8422_2325u64, |hash, byte| {
        (hash ^ u64::from(*byte)).wrapping_mul(0x0100_0000_01b3)
    })
}

#[cfg_attr(target_arch = "wasm32", wasm_bindgen_test::wasm_bindgen_test)]
#[cfg_attr(not(target_arch = "wasm32"), test)]
fn the_window_samples_a_ramp_through_the_inverse_warp() {
    // A linear ramp: Catmull-Rom reproduces it, so each output pixel holds
    // the ramp at the frame point the plan maps it to.
    let (w, h) = (300usize, 200usize);
    let ramp = |x: f64, y: f64| 0.1 + 0.002 * x + 0.003 * y;
    let source = LinearImage {
        width: w,
        height: h,
        data: (0..w * h)
            .flat_map(|i| {
                let v = ramp((i % w) as f64, (i / w) as f64) as f32;
                [v, v * 0.5, v * 0.25]
            })
            .collect(),
    };
    for json in [
        r#"{"perspective":{"vertical":-40}}"#,
        r#"{"perspective":{"horizontal":30,"rotate":-4,"aspect":20,"scale":110,"x":5,"y":-8},"angle":2.5,"crop":{"left":0.1,"top":0.1,"right":0.9,"bottom":0.9}}"#,
        r#"{"rotate":90,"flipH":true,"perspective":{"vertical":25},"constrain":true}"#,
    ] {
        let g = geometry(json);
        let plan = frame::plan(&g, w, h, 0).unwrap();
        let window = frame::working_image(&source, &plan, Filter::Lanczos3);
        let (fw, fh) = plan.frame_size();
        let mut checked = 0;
        for j in (0..plan.height).step_by(7) {
            for i in (0..plan.width).step_by(5) {
                let [x, y] = plan.turned_point(i, j).unwrap();
                // Away from the edges (the taps clamp there).
                if !(x > 3.0 && x < fw as f64 - 3.0 && y > 3.0 && y < fh as f64 - 3.0) {
                    continue;
                }
                // Frame pixel (x, y) is source pixel ... through the turns:
                // compare on the frame's own ramp instead.
                let (sx, sy) = frame_to_source(&g, x - 0.5, y - 0.5, w as f64, h as f64);
                let expected = ramp(sx, sy);
                let k = ((plan.output.y + j) * plan.window_width + plan.output.x + i) * 3;
                let got = window.data[k] as f64;
                assert!(
                    (got - expected).abs() < 2e-4,
                    "{json} ({i}, {j}) at ({x}, {y}): {got} vs {expected}"
                );
                assert!((window.data[k + 1] as f64 - expected * 0.5).abs() < 2e-4);
                checked += 1;
            }
        }
        assert!(checked > 100, "{json}: {checked}");
    }
}

/// A frame point (pixel units, centers at integers) as a source point,
/// undoing the flips and the quarter turn (`geometry.rs` module docs).
fn frame_to_source(g: &Geometry, x: f64, y: f64, w: f64, h: f64) -> (f64, f64) {
    let (fw, fh) = if g.rotate % 180 == 90 { (h, w) } else { (w, h) };
    let x = if g.flip_h { fw - 1.0 - x } else { x };
    let y = if g.flip_v { fh - 1.0 - y } else { y };
    match g.rotate % 360 {
        90 => (y, h - 1.0 - x),
        180 => (w - 1.0 - x, h - 1.0 - y),
        270 => (w - 1.0 - y, x),
        _ => (x, y),
    }
}

#[cfg_attr(target_arch = "wasm32", wasm_bindgen_test::wasm_bindgen_test)]
#[cfg_attr(not(target_arch = "wasm32"), test)]
fn the_identitys_values_render_bit_for_bit_as_without_them() {
    let input = grid_png(320, 240);
    let base = edited();
    for (plain, with) in [
        (
            "null",
            r#"{"perspective":{"scale":100},"constrain":true,"upright":1}"#,
        ),
        (
            r#"{"rotate":90,"crop":{"left":0.1,"top":0,"right":0.9,"bottom":1}}"#,
            r#"{"rotate":90,"crop":{"left":0.1,"top":0,"right":0.9,"bottom":1},"constrain":true,"perspective":{"vertical":0}}"#,
        ),
        (
            r#"{"angle":3}"#,
            r#"{"angle":3,"constrain":true,"upright":4}"#,
        ),
    ] {
        let a = if plain == "null" {
            base.clone()
        } else {
            with_geometry(&base, plain)
        };
        let b = with_geometry(&base, with);
        assert!(b.v < PERSPECTIVE_SETTINGS_VERSION);
        for m in [0usize, 200] {
            let mut session = Session::open_raster(&input, 0, Filter::Lanczos3).unwrap();
            let fa = session.render(&a, m, Quality::Final).unwrap();
            let fb = Session::open_raster(&input, 0, Filter::Lanczos3)
                .unwrap()
                .render(&b, m, Quality::Final)
                .unwrap();
            assert_eq!((fa.width, fa.height), (fb.width, fb.height), "{with}");
            assert!(fa.rgba == fb.rgba, "{with} M {m}");
        }
    }
}

#[cfg_attr(target_arch = "wasm32", wasm_bindgen_test::wasm_bindgen_test)]
#[cfg_attr(not(target_arch = "wasm32"), test)]
fn a_session_redraws_when_only_the_perspective_changes() {
    let input = grid_png(400, 300);
    let base = edited();
    let a = with_geometry(&base, r#"{"perspective":{"vertical":-35}}"#);
    let b = with_geometry(&base, r#"{"perspective":{"vertical":-36}}"#);
    let c = with_geometry(
        &base,
        r#"{"perspective":{"vertical":-35},"constrain":true}"#,
    );
    assert_eq!(a.v, PERSPECTIVE_SETTINGS_VERSION);
    let mut session = Session::open_raster(&input, 0, Filter::Lanczos3).unwrap();
    for m in [0usize, 256] {
        let fa = session.render(&a, m, Quality::Final).unwrap();
        let fb = session.render(&b, m, Quality::Final).unwrap();
        let fc = session.render(&c, m, Quality::Final).unwrap();
        let again = session.render(&a, m, Quality::Final).unwrap();
        assert!(fa.rgba != fb.rgba, "M {m}");
        assert!(fa.rgba == again.rgba, "M {m}");
        // A fresh Session draws the same frame.
        let fresh = Session::open_raster(&input, 0, Filter::Lanczos3)
            .unwrap()
            .render(&a, m, Quality::Final)
            .unwrap();
        assert!(fa.rgba == fresh.rgba, "M {m}");
        // Sizes are the plan's (`geometryOutputSize`); constrain cuts the
        // uncovered corners away.
        let size = |s: &DevelopSettings| niho_develop::output_size(s, 400, 300, m).unwrap();
        assert_eq!((fa.width, fa.height), size(&a));
        assert_eq!((fc.width, fc.height), size(&c));
        if m == 0 {
            assert!(fc.width < fa.width && fc.height < fa.height);
        }
    }
}

#[cfg_attr(target_arch = "wasm32", wasm_bindgen_test::wasm_bindgen_test)]
#[cfg_attr(not(target_arch = "wasm32"), test)]
fn large_reductions_and_tiny_angles_keep_the_window_on_the_output() {
    for (w, h) in [(4000usize, 3000usize), (997, 1503)] {
        for json in [
            r#"{"perspective":{"vertical":-50},"constrain":true}"#,
            r#"{"perspective":{"scale":50,"x":100,"y":-100}}"#,
            r#"{"perspective":{"vertical":100,"horizontal":-100,"rotate":10,"aspect":-100,"scale":150}}"#,
            r#"{"perspective":{"vertical":-20},"angle":0.0001,"crop":{"left":0.2,"top":0.2,"right":0.8,"bottom":0.8}}"#,
        ] {
            let g = geometry(json);
            for m in [0usize, 33, 97, 1280] {
                let p = frame::plan(&g, w, h, m).unwrap();
                assert!(p.width >= 1 && p.height >= 1);
                if m > 0 {
                    assert!(p.width.max(p.height) <= m, "{json} {m}: {p:?}");
                }
                assert!(p.output.x + p.output.width <= p.window_width);
                assert!(p.output.y + p.output.height <= p.window_height);
                assert!(p.scale_long_edge <= w.max(h));
            }
        }
    }
    // Small enough to render: every combination draws the plan's size.
    let input = grid_png(240, 160);
    for json in [
        r#"{"perspective":{"scale":50,"x":100,"y":-100}}"#,
        r#"{"perspective":{"vertical":100,"horizontal":-100,"rotate":10,"aspect":-100,"scale":150},"constrain":true}"#,
    ] {
        let s = with_geometry(&DevelopSettings::neutral(), json);
        for m in [0usize, 64] {
            let f = Session::open_raster(&input, 0, Filter::Lanczos3)
                .unwrap()
                .render(&s, m, Quality::Final)
                .unwrap();
            assert_eq!(
                (f.width, f.height),
                niho_develop::output_size(&s, 240, 160, m).unwrap()
            );
        }
    }
}

#[cfg_attr(target_arch = "wasm32", wasm_bindgen_test::wasm_bindgen_test)]
#[cfg_attr(not(target_arch = "wasm32"), test)]
fn an_older_reader_refuses_a_perspective() {
    // v 7 is required; a v 2 geometry with a perspective is too low and
    // v 8 is unknown.
    let low = DevelopSettings::from_json(r#"{"v":2,"geometry":{"perspective":{"vertical":-10}}}"#)
        .unwrap();
    assert!(low
        .validate()
        .iter()
        .any(|issue| issue.code == "versionTooLow"));
    assert_eq!(
        DevelopSettings::from_json(r#"{"v":8}"#).unwrap_err().code,
        "unsupportedVersion"
    );
    let input = grid_png(64, 48);
    let mut session = Session::open_raster(&input, 0, Filter::Lanczos3).unwrap();
    assert!(session.render(&low, 0, Quality::Final).is_err());
}

#[cfg_attr(target_arch = "wasm32", wasm_bindgen_test::wasm_bindgen_test)]
#[cfg_attr(not(target_arch = "wasm32"), test)]
fn native_and_wasm_render_the_same_perspective() {
    let input = grid_png(96, 64);
    let mut base = DevelopSettings::neutral();
    base.exposure = 0.15;
    base.shadows = 20.0;
    let mut hashes = Vec::new();
    for json in [
        r#"{"perspective":{"vertical":-45}}"#,
        r#"{"perspective":{"vertical":-45},"constrain":true}"#,
        r#"{"perspective":{"horizontal":35,"rotate":-3.5,"aspect":25,"scale":85,"x":-12,"y":7},"angle":2,"crop":{"left":0.05,"top":0.1,"right":0.95,"bottom":0.9}}"#,
        r#"{"rotate":270,"flipV":true,"perspective":{"vertical":60,"scale":120},"constrain":true}"#,
    ] {
        let s = with_geometry(&base, json);
        let mut session = Session::open_raster(&input, 0, Filter::Lanczos3).unwrap();
        for m in [0usize, 40] {
            let f = session.render(&s, m, Quality::Final).unwrap();
            hashes.push((f.width, f.height, fnv1a64(&f.rgba)));
        }
    }
    assert_eq!(hashes, EXPECTED_HASHES);
}

/// [`native_and_wasm_render_the_same_perspective`]'s frames (recorded on
/// native; the wasm build must match them).
const EXPECTED_HASHES: [(usize, usize, u64); 8] = [
    (96, 64, 1_663_441_479_485_963_494),
    (40, 27, 3_842_574_722_525_988_025),
    (89, 59, 2_127_715_713_894_993_151),
    (40, 27, 11_455_663_761_391_101_228),
    (88, 48, 1_040_287_821_288_540_949),
    (40, 22, 10_612_983_047_973_484_118),
    (64, 96, 7_509_452_036_289_151_768),
    (27, 40, 5_517_717_909_382_128_830),
];

// MARK: - XMP

fn preset(attributes: &str) -> String {
    format!(
        r#"<x:xmpmeta xmlns:x="adobe:ns:meta/"><rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#">
<rdf:Description rdf:about="" xmlns:crs="http://ns.adobe.com/camera-raw-settings/1.0/" {attributes}/></rdf:RDF></x:xmpmeta>"#
    )
}

fn item<'a>(result: &'a xmp::PresetResult, property: &str) -> &'a xmp::CompatibilityItem {
    result
        .items
        .iter()
        .find(|i| i.property == property)
        .unwrap_or_else(|| panic!("{property}"))
}

#[cfg_attr(target_arch = "wasm32", wasm_bindgen_test::wasm_bindgen_test)]
#[cfg_attr(not(target_arch = "wasm32"), test)]
fn a_preset_applies_the_transform_and_keeps_the_photos_geometry() {
    let xmp = preset(
        r#"crs:PerspectiveVertical="-25" crs:PerspectiveHorizontal="0" crs:PerspectiveRotate="+12.5" crs:PerspectiveScale="120" crs:PerspectiveAspect="0" crs:PerspectiveX="+3.5" crs:PerspectiveY="0" crs:PerspectiveUpright="1" crs:CropConstrainToWarp="1" crs:UprightVersion="151388160" crs:UprightTransform_0="1.0 0 0 0 1.0 0 0 0 1.0" crs:Exposure2012="+0.30""#,
    );
    let base = with_geometry(
        &DevelopSettings::neutral(),
        r#"{"rotate":90,"crop":{"left":0.1,"top":0.2,"right":0.9,"bottom":0.8},"aspect":"4:5"}"#,
    );
    let result = xmp::preset_settings(&xmp, Some(&base)).unwrap();
    let g = result.settings.geometry.as_ref().unwrap();
    assert_eq!(g.perspective.vertical, -25.0);
    assert_eq!(g.perspective.rotate, 10.0, "clamped to its range");
    assert_eq!(g.perspective.scale, 120.0);
    assert_eq!(g.perspective.x, 3.5);
    assert_eq!(g.upright, 1.0);
    assert!(g.constrain);
    // The photo's own geometry stays.
    assert_eq!(g.rotate, 90);
    assert_eq!(g.crop, base.geometry.as_ref().unwrap().crop);
    assert_eq!(g.aspect.as_deref(), Some("4:5"));
    assert_eq!(result.settings.v, PERSPECTIVE_SETTINGS_VERSION);
    assert!(result.settings.validate().is_empty());
    assert_eq!(result.settings.exposure, 0.3);
    // The report: sliders approximate (identity ones exact), the clamped one
    // says so, Upright and its computation are not applied.
    assert_eq!(
        item(&result, "PerspectiveVertical").level,
        Level::Approximate
    );
    assert_eq!(item(&result, "PerspectiveHorizontal").level, Level::Exact);
    let rotate = item(&result, "PerspectiveRotate");
    assert_eq!(rotate.level, Level::Approximate);
    assert!(rotate.note.contains("-10..10"), "{}", rotate.note);
    assert_eq!(
        item(&result, "PerspectiveUpright").level,
        Level::Unsupported
    );
    assert_eq!(
        item(&result, "UprightTransform_0").level,
        Level::Unsupported
    );
    assert_eq!(item(&result, "UprightVersion").level, Level::Metadata);
    assert_eq!(
        item(&result, "CropConstrainToWarp").level,
        Level::Approximate
    );
    assert!(result
        .unsupported
        .contains(&"PerspectiveUpright".to_string()));
    assert!(!result
        .unsupported
        .iter()
        .any(|p| p.starts_with("Perspective") && p != "PerspectiveUpright"));
    assert!(result
        .approximate
        .contains(&"PerspectiveVertical".to_string()));
}

#[cfg_attr(target_arch = "wasm32", wasm_bindgen_test::wasm_bindgen_test)]
#[cfg_attr(not(target_arch = "wasm32"), test)]
fn an_identity_transform_resets_the_photos_and_upright_off_is_not_reported() {
    let xmp = preset(
        r#"crs:PerspectiveVertical="0" crs:PerspectiveHorizontal="0" crs:PerspectiveRotate="0.0" crs:PerspectiveScale="100" crs:PerspectiveAspect="0" crs:PerspectiveX="0.00" crs:PerspectiveY="0.00" crs:PerspectiveUpright="0" crs:CropConstrainToWarp="0" crs:UprightVersion="151388160" crs:UprightCenterMode="0" crs:UprightTransform_0="1 0 0 0 1 0 0 0 1""#,
    );
    // A photo with a perspective gets the identity (the preset sets it).
    let tilted = with_geometry(
        &DevelopSettings::neutral(),
        r#"{"perspective":{"vertical":-30},"crop":{"right":0.9}}"#,
    );
    let result = xmp::preset_settings(&xmp, Some(&tilted)).unwrap();
    let g = result.settings.geometry.as_ref().unwrap();
    assert!(g.perspective.is_identity());
    assert_eq!(g.crop.right, 0.9);
    assert_eq!(result.settings.v, 2);
    assert!(result.unsupported.is_empty(), "{:?}", result.unsupported);
    // A photo without a geometry does not gain one.
    let result = xmp::preset_settings(&xmp, Some(&DevelopSettings::neutral())).unwrap();
    assert!(result.settings.geometry.is_none());
    assert_eq!(result.settings.v, 1);
    // Without a base either.
    assert!(xmp::preset_settings(&xmp, None)
        .unwrap()
        .settings
        .geometry
        .is_none());
}

#[cfg_attr(target_arch = "wasm32", wasm_bindgen_test::wasm_bindgen_test)]
#[cfg_attr(not(target_arch = "wasm32"), test)]
fn the_transform_group_writes_and_reads_back() {
    let s = with_geometry(
        &DevelopSettings::neutral(),
        r#"{"perspective":{"vertical":-22,"horizontal":8,"rotate":-1.5,"aspect":12,"scale":104,"x":-2.5,"y":4},"upright":3,"constrain":true}"#,
    );
    let options = XmpWriteOptions {
        name: "transform".into(),
        uuid: None,
        groups: vec![XmpGroup::Transform],
    };
    let written = xmp::settings_to_xmp(&s, &options);
    assert!(written.xmp.contains(r#"crs:PerspectiveVertical="-22""#));
    assert!(written.xmp.contains(r#"crs:PerspectiveHorizontal="+8""#));
    assert!(written.xmp.contains(r#"crs:PerspectiveScale="104""#));
    assert!(written.xmp.contains(r#"crs:PerspectiveUpright="3""#));
    assert!(written.xmp.contains(r#"crs:CropConstrainToWarp="1""#));
    let back = xmp::preset_settings(&written.xmp, Some(&DevelopSettings::neutral())).unwrap();
    let g = back.settings.geometry.as_ref().unwrap();
    assert_eq!(g.perspective, s.geometry.as_ref().unwrap().perspective);
    assert_eq!(g.upright, 3.0);
    assert!(g.constrain);
    // The default groups leave the geometry out (it is each photo's).
    let default = xmp::settings_to_xmp(&s, &XmpWriteOptions::default());
    assert!(!default.xmp.contains("Perspective"));
    assert_eq!(XmpGroup::parse("transform"), Some(XmpGroup::Transform));
}

#[cfg_attr(target_arch = "wasm32", wasm_bindgen_test::wasm_bindgen_test)]
#[cfg_attr(not(target_arch = "wasm32"), test)]
fn the_amount_moves_the_transform_linearly() {
    let xmp = preset(r#"crs:PerspectiveVertical="-40" crs:PerspectiveScale="120""#);
    let base = with_geometry(
        &DevelopSettings::neutral(),
        r#"{"perspective":{"vertical":-10},"crop":{"left":0.1}}"#,
    );
    let at = |amount: f64| {
        xmp::apply_preset(&xmp, &base, amount, None)
            .unwrap()
            .settings
    };
    assert_eq!(at(0.0), base);
    let half = at(0.5);
    let g = half.geometry.as_ref().unwrap();
    assert!((g.perspective.vertical + 25.0).abs() < 1e-9);
    assert!((g.perspective.scale - 110.0).abs() < 1e-9);
    assert_eq!(g.crop.left, 0.1);
    assert_eq!(half.v, PERSPECTIVE_SETTINGS_VERSION);
    let over = at(1.5);
    let g = over.geometry.as_ref().unwrap();
    assert!((g.perspective.vertical + 55.0).abs() < 1e-9);
    assert!((g.perspective.scale - 130.0).abs() < 1e-9);
    // Stopped at the ranges.
    let far = preset(r#"crs:PerspectiveVertical="-90""#);
    let g = xmp::apply_preset(&far, &base, 1.5, None)
        .unwrap()
        .settings
        .geometry
        .unwrap();
    assert_eq!(g.perspective.vertical, -100.0);
    // A photo without a geometry and an identity preset keeps none.
    let neutral = preset(r#"crs:PerspectiveVertical="0" crs:PerspectiveScale="100""#);
    let s = xmp::apply_preset(&neutral, &DevelopSettings::neutral(), 0.5, None)
        .unwrap()
        .settings;
    assert!(s.geometry.is_none());
    assert_eq!(s.v, 1);
}
