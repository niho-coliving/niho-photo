//! Rendering the geometry (F3 #17122, `src/frame.rs`): a cropped frame is
//! the whole render cut there (bit for bit for per-pixel adjustments, close
//! for the local ones), turns and flips move pixels, straightened crops are
//! deterministic, the session keeps and drops the window's working image,
//! and a one-shot render decodes large enough for the crop.

use niho_develop::color::{mat_vec_f32, SRGB_TO_PROPHOTO_F32};
use niho_develop::decode::{self, LinearImage};
use niho_develop::frame::{self, Rect};
use niho_develop::{xmp, DevelopSettings, Filter, Quality, RenderOptions, Rendered, Session};

mod common;

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

/// Per-pixel adjustments only (no Highlights / Shadows / Texture / Clarity).
fn pointwise() -> DevelopSettings {
    let mut s = bluesky2();
    s.highlights = 0.0;
    s.shadows = 0.0;
    s.texture = 0.0;
    s.clarity = 0.0;
    s.exposure = 0.35;
    s.contrast = 20.0;
    s.saturation = 12.0;
    s
}

fn local() -> DevelopSettings {
    let mut s = DevelopSettings::neutral();
    s.highlights = -60.0;
    s.shadows = 50.0;
    s.texture = 30.0;
    s.clarity = 25.0;
    s
}

fn mixed() -> DevelopSettings {
    let mut s = pointwise();
    s.highlights = -40.0;
    s.shadows = 35.0;
    s.texture = -20.0;
    s.clarity = 30.0;
    s
}

/// `base` with `geometry` (JSON) and `v: 2`.
fn with_geometry(base: &DevelopSettings, geometry: &str) -> DevelopSettings {
    let mut v = base.to_value();
    v["v"] = 2.into();
    v["geometry"] = serde_json::from_str(geometry).unwrap();
    let s = DevelopSettings::from_json(&v.to_string()).unwrap();
    assert!(s.validate().is_empty(), "{:?}", s.validate());
    s
}

/// Opens a fresh session on the same photo.
type Open<'a> = Box<dyn Fn() -> Session + 'a>;

fn photo_session() -> Session {
    Session::open_raster(&fixture("dsc02150.jpg"), 0, Filter::Lanczos3).unwrap()
}

const RAW_META: &str = r#"{"kind":"raw","baselineEV":0.35,"asShotWhite":{"x":0.3324,"y":0.3474},"dcpSha256":"test","lookTableIncluded":true}"#;

/// A RAW-like working copy (linear ProPhoto) made from a photo.
fn raw_working_copy() -> Vec<u8> {
    let raster = decode::decode_raster(&fixture("dsc02072.jpg"), 0, Filter::Lanczos3).unwrap();
    let mut data = Vec::with_capacity(raster.image.data.len());
    for px in raster.image.data.chunks_exact(3) {
        let v = mat_vec_f32(&SRGB_TO_PROPHOTO_F32, [px[0], px[1], px[2]]);
        data.extend_from_slice(&[
            v[0].max(0.0) * 0.8,
            v[1].max(0.0) * 0.8,
            v[2].max(0.0) * 0.8,
        ]);
    }
    decode::encode_working_copy(&LinearImage {
        width: raster.image.width,
        height: raster.image.height,
        data,
    })
}

fn rect_of(frame: &Rendered, r: Rect) -> Vec<u8> {
    assert!(r.x + r.width <= frame.width && r.y + r.height <= frame.height);
    (r.y..r.y + r.height)
        .flat_map(|y| {
            frame.rgba[(y * frame.width + r.x) * 4..(y * frame.width + r.x + r.width) * 4].to_vec()
        })
        .collect()
}

#[derive(Debug)]
struct DeltaE {
    mean: f64,
    p99: f64,
    max: f64,
}

/// ΔE00 between two `width x height` RGBA frames, `border` pixels of each
/// edge left out.
fn delta_e(a: &[u8], b: &[u8], width: usize, height: usize, border: usize) -> DeltaE {
    assert_eq!(a.len(), b.len());
    let mut d = Vec::new();
    for y in border..height - border {
        for x in border..width - border {
            let i = (y * width + x) * 4;
            d.push(common::delta_e00(
                common::srgb_to_lab([a[i], a[i + 1], a[i + 2]]),
                common::srgb_to_lab([b[i], b[i + 1], b[i + 2]]),
            ));
        }
    }
    let mean = d.iter().sum::<f64>() / d.len() as f64;
    d.sort_by(|x, y| x.total_cmp(y));
    DeltaE {
        mean,
        p99: d[((d.len() as f64 * 0.99) as usize).min(d.len() - 1)],
        max: d[d.len() - 1],
    }
}

/// Crops (angle 0) and the sizes they render at: one reduced from the
/// working size, one not, and a slight one whose window is the whole
/// source (no copy, `Plan::window_is_source`).
const CROPS: [(&str, usize); 3] = [
    (
        r#"{"crop":{"left":0.2,"top":0.15,"right":0.8,"bottom":0.85}}"#,
        600,
    ),
    (
        r#"{"crop":{"left":0.13,"top":0.27,"right":0.71,"bottom":0.9}}"#,
        0,
    ),
    (
        r#"{"crop":{"left":0.02,"top":0.03,"right":0.97,"bottom":0.98}}"#,
        0,
    ),
];

/// The whole render at the plan's virtual size, cut at the crop, and the
/// cropped frame.
fn whole_and_cropped(
    open: &dyn Fn() -> Session,
    base: &DevelopSettings,
    geometry: &str,
    m: usize,
    quality: Quality,
) -> (Vec<u8>, Rendered) {
    let settings = with_geometry(base, geometry);
    let (sw, sh) = open().source_size();
    let plan = frame::plan(settings.geometry.as_ref().unwrap(), sw, sh, m).unwrap();
    let ((vw, vh), crop) = plan.virtual_crop().unwrap();
    assert_eq!(
        plan.window_is_source(),
        geometry.contains("0.02") && m == 0,
        "{geometry}"
    );
    let whole = open().render(base, vw.max(vh), quality).unwrap();
    assert_eq!((whole.width, whole.height), (vw, vh));
    let cropped = open().render(&settings, m, quality).unwrap();
    assert_eq!((cropped.width, cropped.height), (crop.width, crop.height));
    (rect_of(&whole, crop), cropped)
}

fn check_crop_is_the_whole_render_cut(label: &str, open: &dyn Fn() -> Session) {
    for (geometry, m) in CROPS {
        for quality in [Quality::Final, Quality::Interactive] {
            let (expected, cropped) = whole_and_cropped(open, &pointwise(), geometry, m, quality);
            assert!(
                expected == cropped.rgba,
                "{label} {geometry} M {m} {quality:?}: per-pixel adjustments differ"
            );
        }
        for (name, base) in [("local", local()), ("mixed", mixed())] {
            let (expected, cropped) = whole_and_cropped(open, &base, geometry, m, Quality::Final);
            let d = delta_e(&expected, &cropped.rgba, cropped.width, cropped.height, 8);
            eprintln!(
                "{label} {name} {geometry} M {m} ({}x{}): crop vs whole cut ΔE00 mean {:.3}, p99 {:.2}, max {:.2}",
                cropped.width, cropped.height, d.mean, d.p99, d.max
            );
            assert!(d.mean <= 0.5, "{label} {name} {geometry}: {d:?}");
        }
    }
}

#[test]
fn a_crop_of_a_photo_is_the_whole_render_cut_there() {
    check_crop_is_the_whole_render_cut("jpeg", &photo_session);
}

#[test]
fn a_crop_of_a_raw_working_copy_is_the_whole_render_cut_there() {
    let png = raw_working_copy();
    check_crop_is_the_whole_render_cut("raw", &|| {
        Session::open_working_copy(&png, RAW_META, Filter::Lanczos3).unwrap()
    });
}

#[test]
fn moving_the_crop_by_a_pixel_keeps_the_local_result_inside() {
    // No reduction (M = 0): the crop moves one frame pixel right and down.
    let crop = |dx: f64| {
        format!(
            r#"{{"crop":{{"left":{},"top":{},"right":{},"bottom":{}}}}}"#,
            (240.0 + dx) / 1200.0,
            (160.0 + dx) / 800.0,
            (960.0 + dx) / 1200.0,
            (640.0 + dx) / 800.0
        )
    };
    for base in [local(), mixed()] {
        let a = photo_session()
            .render(&with_geometry(&base, &crop(0.0)), 0, Quality::Final)
            .unwrap();
        let b = photo_session()
            .render(&with_geometry(&base, &crop(1.0)), 0, Quality::Final)
            .unwrap();
        assert_eq!((a.width, a.height), (720, 480));
        assert_eq!((b.width, b.height), (720, 480));
        // The frame pixels both show: a's (1, 1).. and b's (0, 0)..
        let common = |f: &Rendered, at: usize| {
            rect_of(
                f,
                Rect {
                    x: at,
                    y: at,
                    width: 719,
                    height: 479,
                },
            )
        };
        let d = delta_e(&common(&a, 1), &common(&b, 0), 719, 479, 8);
        eprintln!(
            "crop moved by 1px: ΔE00 inside mean {:.4}, p99 {:.3}, max {:.3}",
            d.mean, d.p99, d.max
        );
        assert!(d.mean <= 0.05 && d.p99 <= 0.5, "{d:?}");
    }
}

/// Frame pixel `(x, y)` of a `w x h` image turned / mirrored (the geometry
/// module docs), from the unturned pixels.
fn turned(f: &Rendered, rotate: u32, flip_h: bool, flip_v: bool) -> (usize, usize, Vec<u8>) {
    let (w, h) = (f.width, f.height);
    let (fw, fh) = if rotate % 180 == 90 { (h, w) } else { (w, h) };
    let mut out = Vec::with_capacity(w * h * 4);
    for y in 0..fh {
        for x in 0..fw {
            // Undo the flips, then the clockwise turn.
            let x = if flip_h { fw - 1 - x } else { x };
            let y = if flip_v { fh - 1 - y } else { y };
            let (sx, sy) = match rotate {
                90 => (y, h - 1 - x),
                180 => (w - 1 - x, h - 1 - y),
                270 => (w - 1 - y, x),
                _ => (x, y),
            };
            out.extend_from_slice(&f.rgba[(sy * w + sx) * 4..(sy * w + sx) * 4 + 4]);
        }
    }
    (fw, fh, out)
}

#[test]
fn turns_and_flips_move_the_whole_renders_pixels() {
    let png = raw_working_copy();
    let opens: [(&str, Open<'_>); 2] = [
        (
            "jpeg",
            Box::new(|| {
                Session::open_raster(&fixture("dsc02150.jpg"), 600, Filter::Lanczos3).unwrap()
            }),
        ),
        (
            "raw",
            Box::new(|| Session::open_working_copy(&png, RAW_META, Filter::Lanczos3).unwrap()),
        ),
    ];
    for (label, open) in &opens {
        let whole = open().render(&pointwise(), 0, Quality::Final).unwrap();
        for (rotate, flip_h, flip_v) in [
            (90, false, false),
            (180, false, false),
            (270, false, false),
            (0, true, false),
            (0, false, true),
            (90, true, false),
        ] {
            let geometry = format!(r#"{{"rotate":{rotate},"flipH":{flip_h},"flipV":{flip_v}}}"#);
            let framed = open()
                .render(&with_geometry(&pointwise(), &geometry), 0, Quality::Final)
                .unwrap();
            let (w, h, expected) = turned(&whole, rotate, flip_h, flip_v);
            assert_eq!((framed.width, framed.height), (w, h), "{label} {geometry}");
            assert!(framed.rgba == expected, "{label} {geometry}");
        }
    }
}

#[test]
fn straightened_crops_are_deterministic_and_sized_by_the_plan() {
    let geometry =
        r#"{"rotate":90,"angle":3,"crop":{"left":0.1,"top":0.15,"right":0.85,"bottom":0.9}}"#;
    let png = raw_working_copy();
    for (label, open) in [
        ("jpeg", Box::new(photo_session) as Open<'_>),
        (
            "raw",
            Box::new(|| Session::open_working_copy(&png, RAW_META, Filter::Lanczos3).unwrap()),
        ),
    ] {
        for base in [bluesky2(), local()] {
            let settings = with_geometry(&base, geometry);
            for m in [0usize, 500] {
                let (sw, sh) = open().source_size();
                let plan = frame::plan(settings.geometry.as_ref().unwrap(), sw, sh, m).unwrap();
                let a = open().render(&settings, m, Quality::Final).unwrap();
                let b = open().render(&settings, m, Quality::Final).unwrap();
                assert_eq!((a.width, a.height), (plan.width, plan.height), "{label}");
                assert!(a.rgba == b.rgba, "{label} M {m}");
                assert_eq!(
                    niho_develop::output_size(&settings, sw, sh, m).unwrap(),
                    (a.width, a.height)
                );
                if m > 0 {
                    assert_eq!(a.width.max(a.height), m);
                }
            }
        }
    }
}

#[test]
fn a_tiny_angle_samples_the_same_pixels() {
    // At a millionth of a degree every output pixel's center lands on a
    // frame pixel's center: the straightened path (frame read through the
    // turns, Catmull-Rom) gives the pixels of the angle-0 path.
    for geometry in [
        r#""crop":{"left":0.3,"top":0.3,"right":0.7,"bottom":0.7}"#,
        r#""rotate":90,"flipH":true,"crop":{"left":0.1,"top":0.2,"right":0.6,"bottom":0.9}"#,
    ] {
        let straight = photo_session()
            .render(
                &with_geometry(&pointwise(), &format!("{{{geometry}}}")),
                0,
                Quality::Final,
            )
            .unwrap();
        let turned = photo_session()
            .render(
                &with_geometry(&pointwise(), &format!(r#"{{"angle":1e-6,{geometry}}}"#)),
                0,
                Quality::Final,
            )
            .unwrap();
        assert_eq!(
            (turned.width, turned.height),
            (straight.width, straight.height)
        );
        let d = delta_e(
            &turned.rgba,
            &straight.rgba,
            straight.width,
            straight.height,
            0,
        );
        // At most a rounding step of the 8-bit output here and there.
        assert!(d.max < 1.0 && d.mean < 0.01, "{geometry}: {d:?}");
    }
}

#[test]
fn the_session_keeps_the_window_and_drops_stale_local_passes() {
    let a = with_geometry(
        &local(),
        r#"{"crop":{"left":0.2,"top":0.15,"right":0.8,"bottom":0.85}}"#,
    );
    let b = with_geometry(
        &local(),
        r#"{"crop":{"left":0.25,"top":0.15,"right":0.85,"bottom":0.85}}"#,
    );
    let fresh = |s: &DevelopSettings, q: Quality| photo_session().render(s, 600, q).unwrap();
    let mut session = photo_session();
    // The same geometry again: the kept window gives the same frame.
    let first = session.render(&a, 600, Quality::Final).unwrap();
    let again = session.render(&a, 600, Quality::Final).unwrap();
    assert!(first.rgba == again.rgba);
    assert!(first.rgba == fresh(&a, Quality::Final).rgba);
    // Another crop is another frame, and the drag frame after it does not
    // take the old crop's local pass (nor does its release).
    let drag = session.render(&b, 600, Quality::Interactive).unwrap();
    assert!(drag.rgba != first.rgba);
    assert!(drag.rgba == fresh(&b, Quality::Interactive).rgba);
    let released = session.render(&b, 600, Quality::Final).unwrap();
    assert!(released.rgba == fresh(&b, Quality::Final).rgba);
    let back = session.render(&a, 600, Quality::Interactive).unwrap();
    assert!(back.rgba == fresh(&a, Quality::Interactive).rgba);
    // Without the geometry again: the whole photo, as a fresh session.
    let whole = session.render(&local(), 600, Quality::Final).unwrap();
    assert!(whole.rgba == fresh(&local(), Quality::Final).rgba);
    assert_eq!((whole.width, whole.height), (600, 400));
}

#[test]
fn a_one_shot_render_decodes_enough_for_the_crop() {
    let input = fixture("dsc02150.jpg");
    let settings = with_geometry(
        &bluesky2(),
        r#"{"crop":{"left":0.25,"top":0.25,"right":0.75,"bottom":0.75}}"#,
    );
    let options = RenderOptions {
        max_dimension: 600,
        ..Default::default()
    };
    assert_eq!(frame::image_size(&input).unwrap(), (1200, 800));
    assert_eq!(
        niho_develop::raster_decode_size(&settings, 1200, 800, 600, options.decode_cap).unwrap(),
        1200
    );
    let frame = niho_develop::render(&input, &settings.to_json(), &options).unwrap();
    // The 600 x 400 crop of the 1200px original, not of a 600px decode.
    assert_eq!((frame.width, frame.height), (600, 400));
    let expected = Session::open_raster(&input, 1200, Filter::Lanczos3)
        .unwrap()
        .render(&settings, 600, Quality::Final)
        .unwrap();
    assert!(frame.rgba == expected.rgba);
    // A cap below the crop's need: a smaller decode, a smaller frame.
    let capped = niho_develop::render(
        &input,
        &settings.to_json(),
        &RenderOptions {
            decode_cap: 800,
            ..options
        },
    )
    .unwrap();
    assert_eq!((capped.width, capped.height), (400, 267));
    // The EXIF orientation counts in the original's size.
    let turned = std::fs::read(format!(
        "{}/../../fixtures/golden/orientation-6.jpg",
        env!("CARGO_MANIFEST_DIR")
    ))
    .unwrap();
    assert_eq!(frame::image_size(&turned).unwrap(), (48, 64));
}
