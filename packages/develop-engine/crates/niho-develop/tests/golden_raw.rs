//! RAW working-copy golden against Photo Bench's RAW production path
//! (`AdobeBaseRenderer.Handle.image(settings:)`, `.final`, 16-bit sRGB).
//! The references come from `scripts/golden/make_raw_references.py` (macOS,
//! Photo Bench's sources and engine; the RAWs are the owner's, so nothing is
//! committed). Run with:
//!
//!   NIHO_RAW_GOLDEN_DIR=<dir> python3 scripts/golden/make_raw_references.py
//!   NIHO_RAW_GOLDEN_DIR=<dir> cargo test --release -p niho-develop --test golden_raw -- --ignored --nocapture
//!
//! Without `NIHO_RAW_GOLDEN_DIR` the test only prints that it is skipped.
//!
//! `<dir>/<scene>/wc/`: the macOS working copy (`renderWorkingCopy`, what
//! stage 1 makes today). Photo Bench renders it through its RAW path with an
//! identity stage 1 (Stage M, no DCP tables, an identity look, no Adobe
//! Color curve). Gated like the JPEG golden (`tests/golden.rs`): mean ΔE00
//! <= 1.0 over every pixel, and the 99.9th percentile of 2x2 blocks in
//! linear light <= 3.0 without the blocks whose color leaves sRGB before
//! the output stage (NIHO clips there first, Photo Bench does not: README
//! "忠実度" / 出力変換).
//!
//! `<dir>/<scene>/dcp/`: Photo Bench's own LibRaw + Adobe DCP working copy
//! (Stage H output) and its renders, including the absolute white balance,
//! which Photo Bench re-derives from the DCP at the new white and the crate
//! approximates with a CAT from the as-shot white (spec). Reported, not
//! gated.
//!
//! Both sets also print the PNG quantization's share: the crate's render of
//! the working copy's float pixels (`wc.f32`, before the 16-bit encode)
//! against its render of the PNG.

use niho_develop::convert::convert_edit_settings;
use niho_develop::decode::{self, LinearImage, WorkingCopyMeta};
use niho_develop::pipeline::{render_working_copy_marking_out_of_srgb, WorkingCopy};
use niho_develop::Filter;
use serde_json::Value;
use std::path::{Path, PathBuf};

mod common;
use common::*;

fn read_f32(path: &Path) -> LinearImage {
    let bytes = std::fs::read(path).unwrap();
    assert_eq!(&bytes[..8], b"NIHOWCF1", "{}", path.display());
    let word = |i: usize| u32::from_le_bytes(bytes[i..i + 4].try_into().unwrap()) as usize;
    let (width, height) = (word(8), word(12));
    let data: Vec<f32> = bytes[16..]
        .chunks_exact(4)
        .map(|b| f32::from_le_bytes(b.try_into().unwrap()))
        .collect();
    assert_eq!(data.len(), width * height * 3);
    LinearImage {
        width,
        height,
        data,
    }
}

struct Row {
    set: &'static str,
    case: String,
    mean: f64,
    mean_in: f64,
    p999: f64,
    box_p999: f64,
    box_p999_in: f64,
    left_out: f64,
    quant_mean: f64,
    quant_p999: f64,
}

fn is_absolute_wb(settings: &Value) -> bool {
    settings["whiteBalance"]["mode"] == "custom" && settings["whiteBalance"]["temperature"].is_f64()
}

#[test]
#[ignore = "needs NIHO_RAW_GOLDEN_DIR from scripts/golden/make_raw_references.py (macOS + Photo Bench)"]
fn raw_working_copy_against_photo_bench() {
    let Some(dir) = std::env::var_os("NIHO_RAW_GOLDEN_DIR").map(PathBuf::from) else {
        println!("skipped: NIHO_RAW_GOLDEN_DIR is not set");
        return;
    };
    let mut scenes: Vec<PathBuf> = std::fs::read_dir(&dir)
        .unwrap()
        .filter_map(|e| e.ok().map(|e| e.path()))
        .filter(|p| p.join("wc/cases.json").exists())
        .collect();
    scenes.sort();
    if let Ok(only) = std::env::var("NIHO_RAW_GOLDEN_SCENES") {
        let only: Vec<&str> = only.split(',').collect();
        scenes.retain(|p| only.iter().any(|s| p.ends_with(s)));
    }
    assert!(!scenes.is_empty(), "no scenes in {}", dir.display());
    let mut rows = Vec::new();
    let mut failures = Vec::new();
    for scene_dir in &scenes {
        let scene = scene_dir.file_name().unwrap().to_string_lossy().to_string();
        for set in ["wc", "dcp"] {
            let d = scene_dir.join(set);
            if !d.join("cases.json").exists() {
                continue;
            }
            let meta =
                WorkingCopyMeta::from_json(&std::fs::read_to_string(d.join("wc.json")).unwrap())
                    .unwrap();
            let png = decode::decode_working_copy(
                &std::fs::read(d.join("wc.png")).unwrap(),
                0,
                Filter::Lanczos3,
            )
            .unwrap();
            let float = read_f32(&d.join("wc.f32"));
            assert_eq!((png.width, png.height), (float.width, float.height));
            let cases: Value =
                serde_json::from_str(&std::fs::read_to_string(d.join("cases.json")).unwrap())
                    .unwrap();
            let out = d.join("crate");
            std::fs::create_dir_all(&out).unwrap();
            for case in cases["cases"].as_array().unwrap() {
                let name = case["name"].as_str().unwrap();
                let outcome = convert_edit_settings(&case["settings"], None);
                assert!(outcome.ok, "{scene}/{set}/{name}: {:?}", outcome.issues);
                let settings = outcome.settings;
                let reference =
                    image::load_from_memory(&std::fs::read(d.join(format!("{name}.png"))).unwrap())
                        .unwrap()
                        .to_rgb16();
                let frame = render_working_copy_marking_out_of_srgb(
                    &WorkingCopy {
                        image: &png,
                        meta: &meta,
                    },
                    &settings,
                );
                assert_eq!(
                    (frame.width, frame.height),
                    (reference.width() as usize, reference.height() as usize)
                );
                let opaque: Vec<u8> = frame
                    .rgba
                    .chunks_exact(4)
                    .flat_map(|p| [p[0], p[1], p[2], 255])
                    .collect();
                std::fs::write(
                    out.join(format!("{name}.png")),
                    niho_develop::encode::encode_png(&opaque, frame.width, frame.height).unwrap(),
                )
                .unwrap();
                let c = compare_to_linear(
                    &frame.rgba,
                    &linear_of_rgb16(reference.as_raw()),
                    frame.width,
                    frame.height,
                );
                // The PNG quantization: the same settings on the float pixels.
                let from_float = render_working_copy_marking_out_of_srgb(
                    &WorkingCopy {
                        image: &float,
                        meta: &meta,
                    },
                    &settings,
                );
                let q = compare_to_linear(
                    &opaque,
                    &linear_of_rgba8(&from_float.rgba),
                    frame.width,
                    frame.height,
                );
                let gated = set == "wc" && !is_absolute_wb(&case["settings"]);
                if gated && (c.full_in_srgb.mean > 1.0 || c.box2_in_srgb.p999 > 3.0) {
                    failures.push(format!(
                        "{scene}/{name}: mean (in sRGB) {:.3} p99.9(2x2, in sRGB) {:.3}",
                        c.full_in_srgb.mean, c.box2_in_srgb.p999
                    ));
                }
                println!(
                    "{set} {scene} {name}: mean {:.3} in sRGB {:.3} p99.9 {:.3} | 2x2 p99.9 {:.3} in sRGB {:.3} (left out {:.2}%) | PNG quantization mean {:.4} p99.9 {:.3}",
                    c.full.mean,
                    c.full_in_srgb.mean,
                    c.full.p999,
                    c.box2.p999,
                    c.box2_in_srgb.p999,
                    c.left_out * 100.0,
                    q.full.mean,
                    q.full.p999
                );
                rows.push(Row {
                    set,
                    case: name.to_string(),
                    mean: c.full.mean,
                    mean_in: c.full_in_srgb.mean,
                    p999: c.full.p999,
                    box_p999: c.box2.p999,
                    box_p999_in: c.box2_in_srgb.p999,
                    left_out: c.left_out,
                    quant_mean: q.full.mean,
                    quant_p999: q.full.p999,
                });
            }
        }
    }
    // One line per (set, case): the range over the scenes.
    println!("\n| set | case | mean ΔE00 in sRGB (gate) | mean ΔE00 | p99.9 | 2x2 p99.9 in sRGB (gate) | 2x2 p99.9 | left out | PNG quantization mean / p99.9 |");
    println!("|---|---|---|---|---|---|---|---|---|");
    let mut keys: Vec<(&str, String)> = Vec::new();
    for r in &rows {
        if !keys.iter().any(|(s, c)| *s == r.set && *c == r.case) {
            keys.push((r.set, r.case.clone()));
        }
    }
    let range = |v: Vec<f64>, digits: usize| {
        let lo = v.iter().cloned().fold(f64::INFINITY, f64::min);
        let hi = v.iter().cloned().fold(f64::NEG_INFINITY, f64::max);
        format!("{lo:.digits$}–{hi:.digits$}")
    };
    for (set, case) in keys {
        let rs: Vec<&Row> = rows
            .iter()
            .filter(|r| r.set == set && r.case == case)
            .collect();
        println!(
            "| {set} | {case} | {} | {} | {} | {} | {} | {}% | {} / {} |",
            range(rs.iter().map(|r| r.mean_in).collect(), 2),
            range(rs.iter().map(|r| r.mean).collect(), 2),
            range(rs.iter().map(|r| r.p999).collect(), 2),
            range(rs.iter().map(|r| r.box_p999_in).collect(), 2),
            range(rs.iter().map(|r| r.box_p999).collect(), 2),
            range(rs.iter().map(|r| r.left_out * 100.0).collect(), 2),
            range(rs.iter().map(|r| r.quant_mean).collect(), 3),
            range(rs.iter().map(|r| r.quant_p999).collect(), 2),
        );
    }
    assert!(failures.is_empty(), "gate failures: {failures:#?}");
}
