//! Lightroom comparison (informational, not a gate): Photo Bench's
//! `exports/lr-measure/round3` pairs (JPEG inputs with an embedded Camera Raw
//! XMP, and Lightroom's full-size sRGB exports). The photos are the owner's
//! and never enter the repository:
//!
//!   NIHO_LR_MEASURE_DIR=OWNER_DATA_ROOT \
//!     cargo test --release -p niho-develop --test lightroom -- --ignored --nocapture
//!
//! Both sides are reduced to 1500px (linear light, Lanczos-3) and compared
//! with ΔE00 (mean, 99.9th percentile).

use image::ImageDecoder;
use niho_develop::pipeline::render_raster;
use niho_develop::{decode, xmp, Filter, Quality};
use std::collections::BTreeMap;
use std::hash::{Hash, Hasher};
use std::path::PathBuf;

mod common;

/// Keeps private comparison images outside the repository and prints only
/// per-variant aggregates. This is a diagnostic, not a synthetic reference.
#[test]
#[ignore = "requires owner's round10 Lightroom exports through NIHO_LR_MEASURE_DIR"]
fn hue_stable_raster_against_lightroom() {
    use niho_develop::settings::{ENGINE_NIHO_10, ENGINE_NIHO_6};
    let root = std::path::PathBuf::from(
        std::env::var_os("NIHO_LR_MEASURE_DIR").expect("NIHO_LR_MEASURE_DIR is required"),
    )
    .join("round10");
    let mut rows: BTreeMap<String, Vec<(f64, f64)>> = BTreeMap::new();
    let mut inputs: Vec<_> = std::fs::read_dir(root.join("round10-jpeg"))
        .expect("round10 inputs are required")
        .map(|entry| entry.unwrap().path())
        .filter(|path| {
            path.file_name()
                .and_then(|name| name.to_str())
                .is_some_and(|name| {
                    name.ends_with("_hsl_blue.jpg") || name.ends_with("_hsl_orange.jpg")
                })
        })
        .collect();
    inputs.sort();
    assert_eq!(
        inputs.len(),
        16,
        "requires eight scenes and both HSL variants"
    );
    for path in inputs {
        let name = path.file_name().unwrap();
        let variant = if name.to_str().unwrap().ends_with("_hsl_blue.jpg") {
            "blue"
        } else {
            "orange"
        };
        let input = std::fs::read(&path).expect("comparison input");
        let reference =
            std::fs::read(root.join("lr-export-jpeg").join(name)).expect("comparison reference");
        let xmp_text = embedded_xmp(&input).expect("input settings");
        let mut settings = xmp::preset_settings(&xmp_text, None).unwrap().settings;
        let raster = decode::decode_raster(&input, 1500, Filter::Lanczos3).unwrap();
        let lr = decode::decode_raster(&reference, 1500, Filter::Lanczos3).unwrap();
        assert_eq!(
            (raster.image.width, raster.image.height),
            (lr.image.width, lr.image.height)
        );
        let reference_rgb: Vec<_> = lr
            .image
            .data
            .iter()
            .map(|value| niho_develop::output::encode_srgb8(*value))
            .collect();
        let mut means = [0.0; 2];
        for (index, engine) in [ENGINE_NIHO_6, ENGINE_NIHO_10].into_iter().enumerate() {
            settings.engine = engine.into();
            let (frame, _, _) = render_raster(&raster, &settings, Quality::Final, None, None);
            means[index] = common::compare(&frame.rgba, &reference_rgb).mean;
            assert!(means[index].is_finite());
        }
        rows.entry(variant.into())
            .or_default()
            .push((means[0], means[1]));
    }
    for (variant, values) in rows {
        let count = values.len() as f64;
        let old = values.iter().map(|value| value.0).sum::<f64>() / count;
        let new = values.iter().map(|value| value.1).sum::<f64>() / count;
        println!(
            "HSL {variant}: scenes={} mean DeltaE00 niho6={old:.6} niho10={new:.6} change={:+.6}",
            values.len(),
            new - old
        );
    }
}

/// The external PNGs preserve the original TIFF's 16-bit channel codes and
/// embedded ICC profile. They are diagnostic data, never repository assets.
#[test]
#[ignore = "requires external ICC-preserved round1 saturation charts through NIHO_COLOR_REFERENCE_DIR"]
fn hue_stable_global_saturation_against_lightroom() {
    use niho_develop::settings::{DevelopSettings, ENGINE_NIHO_10, ENGINE_NIHO_6};
    let root = PathBuf::from(
        std::env::var_os("NIHO_COLOR_REFERENCE_DIR").expect("NIHO_COLOR_REFERENCE_DIR is required"),
    );
    for saturation in [50, 100] {
        let name = format!("c1_hald-srgb_Saturation_+{saturation}.png");
        let input = std::fs::read(root.join("source").join(&name)).expect("chart input");
        let reference =
            std::fs::read(root.join("lightroom").join(&name)).expect("Lightroom chart reference");
        let raster = decode::decode_raster(&input, 0, Filter::Lanczos3).unwrap();
        let reference = decode::decode_raster(&reference, 0, Filter::Lanczos3).unwrap();
        assert_eq!(
            (raster.image.width, raster.image.height),
            (reference.image.width, reference.image.height)
        );
        let reference_rgb: Vec<_> = reference
            .image
            .data
            .iter()
            .map(|value| niho_develop::output::encode_srgb8(*value))
            .collect();
        let mut means = [0.0; 2];
        for (index, engine) in [ENGINE_NIHO_6, ENGINE_NIHO_10].into_iter().enumerate() {
            let mut settings = DevelopSettings::neutral();
            settings.engine = engine.into();
            settings.look = "niho-standard-1".into();
            settings.saturation = f64::from(saturation);
            let (frame, _, _) = render_raster(&raster, &settings, Quality::Final, None, None);
            means[index] = common::compare(&frame.rgba, &reference_rgb).mean;
            assert!(means[index].is_finite());
        }
        println!(
            "Saturation +{saturation}: mean DeltaE00 niho6={:.6} niho10={:.6} change={:+.6}",
            means[0],
            means[1],
            means[1] - means[0]
        );
    }
}

fn embedded_xmp(bytes: &[u8]) -> Option<String> {
    let mut decoder = image::codecs::jpeg::JpegDecoder::new(std::io::Cursor::new(bytes)).ok()?;
    let xmp = decoder.xmp_metadata().ok()??;
    String::from_utf8(xmp).ok()
}

#[test]
#[ignore = "needs NIHO_LR_MEASURE_DIR (owner's photos, not in the repository)"]
fn round3_jpeg_highlights_shadows_against_lightroom() {
    let Some(dir) = std::env::var_os("NIHO_LR_MEASURE_DIR") else {
        eprintln!("NIHO_LR_MEASURE_DIR is not set; skipping");
        return;
    };
    let round3 = PathBuf::from(dir).join("round3");
    let mut names: Vec<String> = std::fs::read_dir(round3.join("round3-jpeg"))
        .unwrap()
        .filter_map(|e| e.ok())
        .map(|e| e.file_name().to_string_lossy().into_owned())
        .filter(|n| n.ends_with(".jpg"))
        .collect();
    names.sort();
    let mut by_variant: BTreeMap<String, Vec<(f64, f64)>> = BTreeMap::new();
    for name in &names {
        let input = std::fs::read(round3.join("round3-jpeg").join(name)).unwrap();
        let Ok(reference) = std::fs::read(round3.join("lr-export-jpeg").join(name)) else {
            continue;
        };
        let xmp_text = embedded_xmp(&input).expect("embedded XMP");
        let preset = xmp::preset_settings(&xmp_text, None).expect("preset");
        let raster = decode::decode_raster(&input, 1500, Filter::Lanczos3).unwrap();
        let (frame, _, _) = render_raster(&raster, &preset.settings, Quality::Final, None, None);
        let lr = decode::decode_raster(&reference, 1500, Filter::Lanczos3).unwrap();
        assert_eq!(
            (frame.width, frame.height),
            (lr.image.width, lr.image.height)
        );
        let enc = |v: f32| niho_develop::output::encode_srgb8(v);
        let lr_rgb: Vec<u8> = lr.image.data.iter().map(|v| enc(*v)).collect();
        let s = common::compare(&frame.rgba, &lr_rgb);
        // r3_<scene>_<variant>.jpg
        let variant = name
            .trim_end_matches(".jpg")
            .splitn(3, '_')
            .nth(2)
            .unwrap_or("?")
            .to_string();
        println!("{name}: mean {:.2} p99.9 {:.2}", s.mean, s.p999);
        by_variant
            .entry(variant)
            .or_default()
            .push((s.mean, s.p999));
    }
    println!("| variant | scenes | mean ΔE00 | p99.9 |");
    println!("|---|---|---|---|");
    for (variant, rows) in &by_variant {
        let n = rows.len() as f64;
        println!(
            "| {variant} | {} | {:.2} | {:.2} |",
            rows.len(),
            rows.iter().map(|r| r.0).sum::<f64>() / n,
            rows.iter().map(|r| r.1).sum::<f64>() / n
        );
    }
}

#[test]
#[ignore = "needs owner's Lightroom round10 JPEG exports outside the repository"]
fn round10_jpeg_exposure_white_balance_hsl_against_lightroom() {
    let Some(dir) = std::env::var_os("NIHO_LR_MEASURE_DIR") else {
        eprintln!("NIHO_LR_MEASURE_DIR is not set; skipping");
        return;
    };
    let round10 = PathBuf::from(dir).join("round10");
    let input_dir = round10.join("round10-jpeg");
    let reference_dir = round10.join("lr-export-jpeg");
    let mut names: Vec<String> = std::fs::read_dir(&input_dir)
        .expect("make_lr_round10.py must prepare the JPEG inputs")
        .filter_map(|entry| entry.ok())
        .map(|entry| entry.file_name().to_string_lossy().into_owned())
        .filter(|name| name.ends_with(".jpg"))
        .collect();
    names.sort();
    assert_eq!(
        names.len(),
        56,
        "round10 must contain 8 scenes × 7 variants"
    );
    let mut by_variant: BTreeMap<String, Vec<(f64, f64)>> = BTreeMap::new();
    let mut reference_pixels: BTreeMap<String, BTreeMap<String, u64>> = BTreeMap::new();
    for name in &names {
        let input = std::fs::read(input_dir.join(name)).unwrap();
        let reference = std::fs::read(reference_dir.join(name))
            .unwrap_or_else(|_| panic!("Lightroom の書き出しがない: {name}"));
        let xmp_text = embedded_xmp(&input).expect("embedded XMP");
        let preset = xmp::preset_settings(&xmp_text, None).expect("preset");
        let raster = decode::decode_raster(&input, 1500, Filter::Lanczos3).unwrap();
        let (frame, _, _) = render_raster(&raster, &preset.settings, Quality::Final, None, None);
        let lr = decode::decode_raster(&reference, 1500, Filter::Lanczos3).unwrap();
        assert_eq!(
            (frame.width, frame.height),
            (lr.image.width, lr.image.height)
        );
        let lr_rgb: Vec<u8> = lr
            .image
            .data
            .iter()
            .map(|v| niho_develop::output::encode_srgb8(*v))
            .collect();
        let stats = common::compare(&frame.rgba, &lr_rgb);
        let variant = name
            .trim_end_matches(".jpg")
            .splitn(3, '_')
            .nth(2)
            .unwrap_or("?")
            .to_string();
        let scene = name.split('_').nth(1).expect("round10 scene").to_string();
        let mut hasher = std::collections::hash_map::DefaultHasher::new();
        lr_rgb.hash(&mut hasher);
        reference_pixels
            .entry(scene)
            .or_default()
            .insert(variant.clone(), hasher.finish());
        println!("{name}: mean {:.2} p99.9 {:.2}", stats.mean, stats.p999);
        by_variant
            .entry(variant)
            .or_default()
            .push((stats.mean, stats.p999));
    }
    for variant in [
        "exposure_plus1",
        "exposure_minus1",
        "wb_warm",
        "wb_cool",
        "hsl_blue",
        "hsl_orange",
    ] {
        assert!(
            reference_pixels.values().any(|scene| {
                scene.get(variant).is_some_and(|value| scene.get("neutral") != Some(value))
            }),
            "Lightroom export {variant} has the same pixels as neutral in all scenes; choose JPG, not Original + Settings"
        );
    }
    println!("| variant | scenes | mean ΔE00 | p99.9 avg | p99.9 max |");
    println!("|---|---|---|---|---|");
    for (variant, rows) in &by_variant {
        let n = rows.len() as f64;
        println!(
            "| {variant} | {} | {:.2} | {:.2} | {:.2} |",
            rows.len(),
            rows.iter().map(|row| row.0).sum::<f64>() / n,
            rows.iter().map(|row| row.1).sum::<f64>() / n,
            rows.iter()
                .map(|row| row.1)
                .fold(0.0f64, |max, value| max.max(value))
        );
    }
}
