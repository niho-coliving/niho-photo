//! Saturated blue to violet outside sRGB (a night scene's colored lights,
//! S9 #16999) must keep the chroma and hue of a plain sRGB clip, as
//! Lightroom's sRGB conversion does: `fixtures/golden/input/saturated-blue.png`
//! (examples/saturated_patches.rs), neutral settings, raster and RAW paths.
//! Before the output transform clipped first, these patches kept 0.54 of the
//! chroma with 38° of hue shift (Photo Bench still does).

use niho_develop::acr3;
use niho_develop::color::{mat_vec, srgb_encode, PROPHOTO_TO_SRGB, SRGB_TO_PROPHOTO};
use niho_develop::decode::{self, LinearImage};
use niho_develop::tone_ops::rgb_tone;
use niho_develop::{DevelopSettings, Filter, Quality, RenderOptions, Session};

const PATCH: usize = 32;

fn fixture() -> Vec<u8> {
    common::with_synthetic_prophoto_profile(
        &std::fs::read(format!(
            "{}/../../fixtures/golden/input/saturated-blue.png",
            env!("CARGO_MANIFEST_DIR")
        ))
        .unwrap(),
    )
}

mod common;

/// CIELab chroma and hue (degrees) of an sRGB 8-bit color.
fn lch(p: [u8; 3]) -> (f64, f64) {
    let lab = common::srgb_to_lab(p);
    (
        lab[1].hypot(lab[2]),
        lab[2].atan2(lab[1]).to_degrees().rem_euclid(360.0),
    )
}

fn clip8(v: [f64; 3]) -> [u8; 3] {
    v.map(|x| (srgb_encode(x.clamp(0.0, 1.0)) * 255.0).round() as u8)
}

/// Patch centers whose color is outside sRGB, with the clipped reference.
fn check(label: &str, width: usize, rgba: &[u8], patches: &[(usize, [f64; 3])]) {
    let (mut n, mut sum_ratio, mut min_ratio, mut sum_dh, mut max_dh) =
        (0.0, 0.0, f64::INFINITY, 0.0, 0.0f64);
    for (i, reference) in patches {
        if reference.iter().all(|v| (0.0..=1.0).contains(v)) {
            continue;
        }
        let (c_ref, h_ref) = lch(clip8(*reference));
        if c_ref < 5.0 {
            continue;
        }
        let (x, y) = ((i % 8) * PATCH + PATCH / 2, (i / 8) * PATCH + PATCH / 2);
        let o = (y * width + x) * 4;
        let (c, h) = lch([rgba[o], rgba[o + 1], rgba[o + 2]]);
        let ratio = c / c_ref;
        let dh = ((h - h_ref + 540.0).rem_euclid(360.0) - 180.0).abs();
        n += 1.0;
        sum_ratio += ratio;
        min_ratio = min_ratio.min(ratio);
        sum_dh += dh;
        max_dh = max_dh.max(dh);
    }
    let (mean_ratio, mean_dh) = (sum_ratio / n, sum_dh / n);
    eprintln!(
        "{label}: {n} patches outside sRGB, chroma vs clip mean {mean_ratio:.3} min {min_ratio:.3}, |Δh| mean {mean_dh:.1}° max {max_dh:.1}°"
    );
    assert!(n >= 20.0, "{label}: {n} patches");
    assert!(
        mean_ratio >= 0.92 && min_ratio >= 0.8,
        "{label}: chroma {mean_ratio} / {min_ratio}"
    );
    assert!(
        mean_dh <= 3.0 && max_dh <= 8.0,
        "{label}: hue {mean_dh} / {max_dh}"
    );
}

fn patch_centers(image: &LinearImage) -> Vec<(usize, [f32; 3])> {
    let columns = image.width / PATCH;
    let rows = image.height / PATCH;
    (0..columns * rows)
        .map(|i| {
            let (x, y) = (
                (i % columns) * PATCH + PATCH / 2,
                (i / columns) * PATCH + PATCH / 2,
            );
            let o = (y * image.width + x) * 3;
            (i, [image.data[o], image.data[o + 1], image.data[o + 2]])
        })
        .filter(|(_, v)| v.iter().any(|c| *c != 0.0))
        .collect()
}

#[test]
fn saturated_blue_keeps_the_clipped_chroma_and_hue_on_the_raster_path() {
    let bytes = fixture();
    let raster = decode::decode_raster(&bytes, 0, Filter::Lanczos3).unwrap();
    let frame = niho_develop::render(
        &bytes,
        &DevelopSettings::neutral().to_json(),
        &RenderOptions {
            max_dimension: 0,
            ..Default::default()
        },
    )
    .unwrap();
    let patches: Vec<(usize, [f64; 3])> = patch_centers(&raster.image)
        .into_iter()
        .map(|(i, v)| (i, v.map(|c| c as f64)))
        .collect();
    check("raster", raster.image.width, &frame.rgba, &patches);
}

#[test]
fn saturated_blue_keeps_the_clipped_chroma_and_hue_on_the_raw_path() {
    // The same colors as a RAW working copy (linear ProPhoto): the reference
    // is the ACR3 tone (exact) and a plain sRGB clip.
    let raster = decode::decode_raster(&fixture(), 0, Filter::Lanczos3).unwrap();
    let mut data = Vec::with_capacity(raster.image.data.len());
    for px in raster.image.data.chunks_exact(3) {
        let v = mat_vec(
            &SRGB_TO_PROPHOTO,
            [px[0] as f64, px[1] as f64, px[2] as f64],
        );
        data.extend(v.map(|c| c.max(0.0) as f32));
    }
    let image = LinearImage {
        width: raster.image.width,
        height: raster.image.height,
        data,
    };
    let png = decode::encode_working_copy(&image);
    let stored = decode::decode_working_copy(&png, 0, Filter::Lanczos3).unwrap();
    let meta = r#"{"kind":"raw","baselineEV":0,"asShotWhite":{"x":0.3457,"y":0.3585},"dcpSha256":"test","lookTableIncluded":true}"#;
    let mut session = Session::open_working_copy(&png, meta, Filter::Lanczos3).unwrap();
    let frame = session
        .render(&DevelopSettings::neutral(), 0, Quality::Final)
        .unwrap();
    let patches: Vec<(usize, [f64; 3])> = patch_centers(&stored)
        .into_iter()
        .map(|(i, v)| {
            let toned = rgb_tone(v.map(|c| c as f64), &acr3::evaluate);
            (i, mat_vec(&PROPHOTO_TO_SRGB, toned))
        })
        .collect();
    check("raw", stored.width, &frame.rgba, &patches);
}
