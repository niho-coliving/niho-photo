//! Drag (interactive) frames approximate the released (final) frame:
//! Highlights / Shadows at half resolution (unless the session kept a local
//! pass of the same input) and the per-pixel tail as one 33^3 cube over a
//! shaped input (`pipeline::DragTail`). They are never saved; these bounds
//! catch a broken or loosened approximation (a wrong grid, shaper or
//! upsampling shows up as ΔE00 >> 1).
//!
//! Two situations: "fresh", the first drag frame of a session (nothing
//! kept: the whole approximation), and "after release", a drag frame right
//! after the released frame of the same settings (the released local pass
//! is kept: only the tail differs), e.g. dragging a color slider on a
//! preset.

use niho_develop::color::{mat_vec_f32, SRGB_TO_PROPHOTO_F32};
use niho_develop::decode::{self, LinearImage};
use niho_develop::{xmp, DevelopSettings, Filter, Quality, Rendered, Session};

mod common;

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

fn cases() -> Vec<(&'static str, DevelopSettings)> {
    let mut local = DevelopSettings::neutral();
    local.highlights = -60.0;
    local.shadows = 50.0;
    local.texture = 30.0;
    local.clarity = 25.0;
    // NIHO effects (#17120 E1) on a preset: black & white in the tail cube,
    // the vignette's gain before it and the grain after it, at the same
    // places in drag and released frames.
    let mut effects = preset("niho-bluesky2");
    effects.v = 3;
    effects.grayscale = true;
    effects
        .gray_mixer
        .set(niho_develop::settings::HslBand::Blue, -40.0);
    effects.color_grading.shadow.hue = 210.0;
    effects.color_grading.shadow.saturation = 20.0;
    effects.vignette.amount = -45.0;
    effects.grain.amount = 35.0;
    vec![
        ("bluesky2", preset("niho-bluesky2")),
        ("pastel", preset("niho-pastel")),
        ("local", local),
        ("effects", effects),
    ]
}

/// Mean and 99.9th percentile ΔE00 between two frames.
fn delta_e(a: &Rendered, b: &Rendered) -> (f64, f64) {
    assert_eq!((a.width, a.height), (b.width, b.height));
    let mut d: Vec<f64> = a
        .rgba
        .chunks_exact(4)
        .zip(b.rgba.chunks_exact(4))
        .map(|(p, q)| {
            common::delta_e00(
                common::srgb_to_lab([p[0], p[1], p[2]]),
                common::srgb_to_lab([q[0], q[1], q[2]]),
            )
        })
        .collect();
    let mean = d.iter().sum::<f64>() / d.len() as f64;
    d.sort_by(|x, y| x.total_cmp(y));
    (mean, d[(d.len() as f64 * 0.999) as usize])
}

/// Bounds per case: (fresh mean, fresh p99.9, after-release p99.9).
/// Measured (2026-09, PR3): JPEG bluesky2 0.58-0.63 / 2.61-2.78 / 2.51-2.66,
/// pastel 0.50-0.55 / 2.48-3.12 / 2.11-2.25, local 0.17-0.20 / 1.89-2.61 /
/// 0; the RAW-like working copy bluesky2 0.38 / 3.46 / 2.32, pastel 0.61 /
/// 4.22 / 2.47, local 0.32 / 2.88 / 1.26.
fn bounds(label: &str, name: &str) -> (f64, f64, f64) {
    let raw = label.starts_with("raw");
    match name {
        "local" => (0.4, 3.0, if raw { 1.6 } else { 0.01 }),
        _ if raw => (0.75, 4.6, 2.8),
        _ => (0.75, 3.3, 3.0),
    }
}

fn check(label: &str, open: impl Fn() -> Session) {
    for (name, settings) in cases() {
        let released = open().render(&settings, 0, Quality::Final).unwrap();
        let fresh = open().render(&settings, 0, Quality::Interactive).unwrap();
        let mut session = open();
        session.render(&settings, 0, Quality::Final).unwrap();
        let after_release = session.render(&settings, 0, Quality::Interactive).unwrap();
        let (mean, p999) = delta_e(&fresh, &released);
        let (kept_mean, kept_p999) = delta_e(&after_release, &released);
        eprintln!(
            "{label} {name}: drag vs released mean ΔE00 {mean:.3}, p99.9 {p999:.2} (after release: {kept_mean:.3}, {kept_p999:.2})"
        );
        let (max_mean, max_p999, max_kept_p999) = bounds(label, name);
        assert!(mean <= max_mean, "{label} {name}: mean ΔE00 {mean}");
        assert!(p999 <= max_p999, "{label} {name}: p99.9 ΔE00 {p999}");
        assert!(
            kept_p999 <= max_kept_p999,
            "{label} {name}: p99.9 ΔE00 after release {kept_p999}"
        );
    }
}

#[test]
fn drag_frames_of_a_photo_stay_close_to_the_released_frame() {
    for input in ["dsc02072.jpg", "dsc02150.jpg"] {
        let bytes = fixture(input);
        check(input, || {
            Session::open_raster(&bytes, 1200, Filter::Lanczos3).unwrap()
        });
    }
}

#[test]
fn drag_frames_of_a_raw_working_copy_stay_close_to_the_released_frame() {
    // A RAW-like working copy (linear ProPhoto) made from a photo.
    let raster = decode::decode_raster(&fixture("dsc02150.jpg"), 0, Filter::Lanczos3).unwrap();
    let mut data = Vec::with_capacity(raster.image.data.len());
    for px in raster.image.data.chunks_exact(3) {
        let v = mat_vec_f32(&SRGB_TO_PROPHOTO_F32, [px[0], px[1], px[2]]);
        data.extend_from_slice(&[
            v[0].max(0.0) * 0.8,
            v[1].max(0.0) * 0.8,
            v[2].max(0.0) * 0.8,
        ]);
    }
    let png = decode::encode_working_copy(&LinearImage {
        width: raster.image.width,
        height: raster.image.height,
        data,
    });
    let meta = r#"{"kind":"raw","baselineEV":0.35,"asShotWhite":{"x":0.3324,"y":0.3474},"dcpSha256":"test","lookTableIncluded":true}"#;
    check("raw working copy", || {
        Session::open_working_copy(&png, meta, Filter::Lanczos3).unwrap()
    });
}
