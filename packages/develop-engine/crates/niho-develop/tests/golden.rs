//! Golden comparison against Photo Bench (`scripts/golden/make_references.py`
//! renders the references with photobench-engine on a Mac; they are not
//! committed). Run with:
//!
//!   python3 scripts/golden/make_references.py
//!   cargo test --release -p niho-develop --test golden -- --ignored --nocapture
//!
//! Gate (spec "段 2"): mean ΔE00 <= 1.0 and 99.9th percentile <= 3.0 on the
//! photos. The 99.9th percentile leaves out the 2x2 blocks with a pixel whose
//! color leaves sRGB before the output stage (`render_raster_marking_out_of_srgb`):
//! there NIHO clips before the output knee and Photo Bench compresses the
//! unclipped color, which dulls saturated blue to violet (PR2, output.rs,
//! README "忠実度"); the share left out is printed. `saturated-blue.png`
//! (synthetic colors outside sRGB) is reported, not gated.
//!
//! The only reference Photo Bench can produce today is its engine's JPEG
//! export (quality 1.0, 4:4:4; the `photobench-render --format tif16`
//! binary on disk predates ToneOps v3). That encode alone costs mean 0.19 /
//! p99.9 2.4 ΔE00 (the `neutral` rows: identical pipelines). So the mean is
//! gated at full resolution and the 99.9th percentile after a 2x2 box
//! average in linear light, which removes most of the JPEG's block noise
//! (neutral: p99.9 2.4 -> 1.2) but keeps systematic differences. Both are
//! printed.

use niho_develop::convert::convert_edit_settings;
use niho_develop::pipeline::{render_raster, render_raster_marking_out_of_srgb};
use niho_develop::{decode, xmp, DevelopSettings, Filter, Quality};
use serde_json::Value;
use std::path::PathBuf;

mod common;
use common::*;

fn root() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../..")
}

fn settings_for(case: &Value) -> DevelopSettings {
    if let Some(id) = case["preset"].as_str() {
        let preset = xmp::builtin_preset(id).expect("bundled preset");
        let result = xmp::preset_settings(preset.xmp, None).unwrap();
        assert!(result.converted);
        // Photo Bench never rendered the Detail panel; the bundled presets'
        // Sharpness / color NR (v6 detail, Issue #32) are outside this color
        // gate, which compares Photo Bench's own frames.
        let mut settings = result.settings;
        settings.detail = None;
        settings.v = settings.required_version();
        return settings;
    }
    let outcome = convert_edit_settings(&case["settings"], None);
    assert!(outcome.ok, "{:?}", outcome.issues);
    outcome.settings
}

#[test]
#[ignore = "needs references from scripts/golden/make_references.py (macOS + photobench-engine)"]
fn golden_against_photo_bench() {
    let cases: Value = serde_json::from_str(
        &std::fs::read_to_string(root().join("scripts/golden/cases.json")).unwrap(),
    )
    .unwrap();
    let ref_dir = root().join("fixtures/golden/reference");
    let out_dir = root().join("fixtures/golden/out");
    std::fs::create_dir_all(&out_dir).unwrap();
    let mut failures = Vec::new();
    println!("| case | input | mean ΔE00 | p99.9 | max | 2x2 mean | 2x2 p99.9 | 2x2 p99.9 in sRGB | left out |");
    println!("|---|---|---|---|---|---|---|---|---|");
    let mut rows = Vec::new();
    for case in cases["cases"].as_array().unwrap() {
        let name = case["name"].as_str().unwrap();
        let settings = settings_for(case);
        for input in cases["inputs"].as_array().unwrap() {
            let input = input.as_str().unwrap();
            let stem = input.trim_end_matches(".jpg").trim_end_matches(".png");
            let reference = ref_dir.join(format!("{stem}__{name}.jpg"));
            let Ok(ref_bytes) = std::fs::read(&reference) else {
                panic!(
                    "missing {} (run scripts/golden/make_references.py)",
                    reference.display()
                );
            };
            let ref_img = image::load_from_memory(&ref_bytes).unwrap().to_rgb8();
            // Same decoded pixels as the reference (lossless PNG of the JPEG).
            let bytes = std::fs::read(ref_dir.join(format!("{stem}.png"))).unwrap();
            let raster = decode::decode_raster(&bytes, 0, Filter::Lanczos3).unwrap();
            // The same pixels as render_raster, alpha 0 where the color leaves sRGB.
            let frame = render_raster_marking_out_of_srgb(&raster, &settings);
            assert_eq!(
                (frame.width, frame.height),
                (ref_img.width() as usize, ref_img.height() as usize)
            );
            let opaque: Vec<u8> = frame
                .rgba
                .chunks_exact(4)
                .flat_map(|p| [p[0], p[1], p[2], 255])
                .collect();
            let png = niho_develop::encode::encode_png(&opaque, frame.width, frame.height).unwrap();
            std::fs::write(out_dir.join(format!("{stem}__{name}.png")), png).unwrap();
            let s = compare(&frame.rgba, ref_img.as_raw());
            let b = compare_box2(&frame.rgba, ref_img.as_raw(), frame.width, frame.height);
            let (inside, left_out) =
                compare_box2_unmarked(&frame.rgba, ref_img.as_raw(), frame.width, frame.height);
            println!(
                "| {name} | {stem} | {:.3} | {:.3} | {:.2} | {:.3} | {:.3} | {:.3} | {:.2}% |",
                s.mean,
                s.p999,
                s.max,
                b.mean,
                b.p999,
                inside.p999,
                left_out * 100.0
            );
            let gated = input.ends_with(".jpg");
            if gated {
                rows.push((name.to_string(), s.mean, s.p999));
            }
            if gated && (s.mean > 1.0 || inside.p999 > 3.0) {
                failures.push(format!(
                    "{name}/{stem}: mean {:.3} p99.9(2x2, in sRGB) {:.3}",
                    s.mean, inside.p999
                ));
            }
        }
    }
    // Decoder baseline: the JPEG itself (zune-jpeg vs Apple's decoder),
    // neutral settings. Reported, not gated (not stage 2).
    for input in cases["inputs"].as_array().unwrap() {
        let input = input.as_str().unwrap();
        let Some(stem) = input.strip_suffix(".jpg") else {
            continue; // PNG inputs are lossless: no decoder baseline.
        };
        let ref_img = image::load_from_memory(
            &std::fs::read(ref_dir.join(format!("{stem}__jpeg-decode.jpg"))).unwrap(),
        )
        .unwrap()
        .to_rgb8();
        let bytes = std::fs::read(root().join("fixtures/golden/input").join(input)).unwrap();
        let raster = decode::decode_raster(&bytes, 0, Filter::Lanczos3).unwrap();
        let (frame, _, _) = render_raster(
            &raster,
            &DevelopSettings::neutral(),
            Quality::Final,
            None,
            None,
        );
        let s = compare(&frame.rgba, ref_img.as_raw());
        let b = compare_box2(&frame.rgba, ref_img.as_raw(), frame.width, frame.height);
        println!(
            "| jpeg-decode (baseline) | {stem} | {:.3} | {:.3} | {:.2} | {:.3} | {:.3} | - | - |",
            s.mean, s.p999, s.max, b.mean, b.p999
        );
    }
    let overall = rows.iter().map(|r| r.1).sum::<f64>() / rows.len() as f64;
    println!(
        "overall mean ΔE00 {overall:.3} over {} renders of the photos",
        rows.len()
    );
    assert!(failures.is_empty(), "gate failures: {failures:#?}");
}
