//! Reproducible public measurement for `niho-12` (#29), the float-cube engine
//! for new raster and legacy (unsigned) RAW edits.
//!
//! Prints one JSON document with
//! - public golden inputs × `scripts/golden/cases.json` cases: `niho-12`
//!   against the `niho-10` raster formula it extends (same input, same
//!   settings; a difference measurement, not an external reference);
//! - synthetic 1024-step linear f32 sky / skin ramps (no input 8-bit
//!   quantization) on the raster path (`niho-10` vs `niho-12`) and the legacy
//!   RAW path (`niho-2` vs `niho-12`): adjacent output steps `>= 2`;
//! - native cold renders of the 1024×64 ramp (not the wasm frame gate).
//!
//! ```sh
//! cargo +1.98.1 run --release --locked \
//!   --manifest-path packages/develop-engine/Cargo.toml \
//!   -p niho-develop --example niho12_measure > niho12-measure.json
//! ```

use niho_develop::convert::convert_edit_settings;
use niho_develop::decode::{LinearImage, WorkingCopyMeta};
use niho_develop::pipeline::{render_working_copy, WorkingCopy};
use niho_develop::settings::{ENGINE_NIHO_10, ENGINE_NIHO_12, ENGINE_NIHO_2, LOOK_NIHO_STANDARD_1};
use niho_develop::{xmp, DevelopSettings, Filter, Quality, Session};
use serde_json::{json, Value};
use std::path::PathBuf;
use std::time::Instant;

fn root() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../..")
}

fn with_engine(settings: &DevelopSettings, engine: &str) -> DevelopSettings {
    let mut settings = settings.clone();
    settings.engine = engine.into();
    settings.look = LOOK_NIHO_STANDARD_1.into();
    settings
}

/// The `niho8_measure` setting (moderate tone and color).
fn moderate() -> DevelopSettings {
    let mut settings = DevelopSettings::neutral();
    settings.exposure = 0.37;
    settings.contrast = 24.0;
    settings.highlights = -45.0;
    settings.shadows = 32.0;
    settings.whites = -18.0;
    settings.blacks = 21.0;
    settings.vibrance = 28.0;
    settings.saturation = 7.0;
    settings
}

fn preset(id: &str) -> DevelopSettings {
    let preset = xmp::builtin_preset(id).expect("bundled preset");
    let result = xmp::preset_settings(preset.xmp, None).expect("preset");
    assert!(result.converted, "{id}");
    result.settings
}

fn golden_cases() -> Vec<(String, DevelopSettings)> {
    let cases: Value = serde_json::from_str(
        &std::fs::read_to_string(root().join("scripts/golden/cases.json")).unwrap(),
    )
    .unwrap();
    cases["cases"]
        .as_array()
        .unwrap()
        .iter()
        .map(|case| {
            let name = case["name"].as_str().unwrap().to_owned();
            let settings = match case["preset"].as_str() {
                Some(id) => preset(id),
                None => {
                    let outcome = convert_edit_settings(&case["settings"], None);
                    assert!(outcome.ok, "{name}: {:?}", outcome.issues);
                    outcome.settings
                }
            };
            (name, settings)
        })
        .collect()
}

fn delta(a: &[u8], b: &[u8]) -> Value {
    assert_eq!(a.len(), b.len());
    let mut sum = 0u64;
    let mut max = 0u8;
    let mut changed = 0usize;
    for (pa, pb) in a.chunks_exact(4).zip(b.chunks_exact(4)) {
        let mut pixel_changed = false;
        for channel in 0..3 {
            let d = pa[channel].abs_diff(pb[channel]);
            sum += u64::from(d);
            max = max.max(d);
            pixel_changed |= d != 0;
        }
        changed += usize::from(pixel_changed);
    }
    json!({
        "meanAbsoluteCodeDelta": sum as f64 / (a.len() / 4 * 3) as f64,
        "maxAbsoluteCodeDelta": max,
        "changedPixels": changed,
        "pixels": a.len() / 4
    })
}

fn render_raster(bytes: &[u8], settings: &DevelopSettings, quality: Quality) -> Vec<u8> {
    let mut session = Session::open_raster(bytes, 0, Filter::Lanczos3).unwrap();
    session.render(settings, 0, quality).unwrap().rgba
}

fn linear_ramp() -> LinearImage {
    let mut data = Vec::with_capacity(1024 * 64 * 3);
    for row in 0..64 {
        for x in 0..1024 {
            let t = x as f64 / 1023.0;
            let rgb = if row < 32 {
                [0.035 + 0.35 * t, 0.08 + 0.62 * t, 0.16 + 0.75 * t]
            } else {
                [0.07 + 0.78 * t, 0.035 + 0.55 * t, 0.025 + 0.42 * t]
            };
            data.extend(
                niho_develop::color::mat_vec(&niho_develop::color::SRGB_TO_PROPHOTO, rgb)
                    .map(|v| v as f32),
            );
        }
    }
    LinearImage {
        width: 1024,
        height: 64,
        data,
    }
}

fn render_ramp(
    image: &LinearImage,
    settings: &DevelopSettings,
    quality: Quality,
    raw: bool,
) -> (Vec<u8>, f64) {
    let meta = if raw {
        WorkingCopyMeta::from_json(r#"{"kind":"raw","baselineEV":0,"asShotWhite":{"x":0.3457,"y":0.3585},"dcpSha256":"synthetic","lookTableIncluded":true}"#).unwrap()
    } else {
        WorkingCopyMeta::Raster {
            icc_sha256: "sRGB".into(),
        }
    };
    let started = Instant::now();
    let frame = render_working_copy(&WorkingCopy { image, meta: &meta }, settings, quality, None).0;
    (frame.rgba, started.elapsed().as_secs_f64() * 1000.0)
}

/// Adjacent-pixel output steps along one ramp row: `>= 2` code values
/// (banding), equal neighbors, and the largest step, per RGB channel.
fn adjacent(rgba: &[u8], row: usize) -> Value {
    let row = &rgba[row * 1024 * 4..(row + 1) * 1024 * 4];
    let mut ge2 = [0usize; 3];
    let mut equal = [0usize; 3];
    let mut max = [0u8; 3];
    for pair in row.chunks_exact(4).collect::<Vec<_>>().windows(2) {
        for channel in 0..3 {
            let d = pair[0][channel].abs_diff(pair[1][channel]);
            ge2[channel] += usize::from(d >= 2);
            equal[channel] += usize::from(d == 0);
            max[channel] = max[channel].max(d);
        }
    }
    json!({
        "adjacentGe2": ge2,
        "adjacentGe2Total": ge2.iter().sum::<usize>(),
        "adjacentEqual": equal,
        "maxAdjacent": max
    })
}

fn ge2_total(rgba: &[u8], row: usize) -> usize {
    adjacent(rgba, row)["adjacentGe2Total"].as_u64().unwrap() as usize
}

fn main() {
    let fixture_dir = root().join("fixtures/golden/input");
    let cases = golden_cases();
    let mut fixtures = Vec::new();
    let mut fixture_summary = (0usize, 0u8, 0.0f64);
    for name in [
        "dsc02072.jpg",
        "dsc02078.jpg",
        "dsc02150.jpg",
        "saturated-blue.png",
    ] {
        let bytes = std::fs::read(fixture_dir.join(name)).unwrap();
        let mut rows = Vec::new();
        for (case, settings) in &cases {
            let ten = render_raster(
                &bytes,
                &with_engine(settings, ENGINE_NIHO_10),
                Quality::Final,
            );
            let twelve = render_raster(
                &bytes,
                &with_engine(settings, ENGINE_NIHO_12),
                Quality::Final,
            );
            let d = delta(&twelve, &ten);
            fixture_summary.0 += usize::from(d["changedPixels"].as_u64().unwrap() > 0);
            fixture_summary.1 = fixture_summary
                .1
                .max(d["maxAbsoluteCodeDelta"].as_u64().unwrap() as u8);
            fixture_summary.2 = fixture_summary
                .2
                .max(d["meanAbsoluteCodeDelta"].as_f64().unwrap());
            rows.push(json!({"case": case, "niho12MinusNiho10Final": d}));
        }
        fixtures.push(json!({"fixture": name, "cases": rows}));
    }

    let ramp = linear_ramp();
    let variants: Vec<(&str, DevelopSettings)> = vec![
        ("moderate", moderate()),
        ("preset-bluesky2", preset("niho-bluesky2")),
        ("preset-pastel", preset("niho-pastel")),
        ("preset-colorful", preset("niho-colorful")),
    ];
    let mut ramps = Vec::new();
    let mut totals = json!({
        "rasterNiho10Final": 0, "rasterNiho12Final": 0,
        "rasterNiho10Interactive": 0, "rasterNiho12Interactive": 0,
        "legacyRawNiho2Final": 0, "legacyRawNiho12Final": 0,
        "legacyRawNiho2Interactive": 0, "legacyRawNiho12Interactive": 0
    });
    let mut timings = Vec::new();
    for (variant, settings) in &variants {
        let mut entry = json!({"variant": variant});
        for (path, raw, baseline) in [
            ("raster", false, ENGINE_NIHO_10),
            ("legacyRaw", true, ENGINE_NIHO_2),
        ] {
            let mut rows = json!({});
            for (label, engine) in [("baseline", baseline), ("niho12", ENGINE_NIHO_12)] {
                let s = with_engine(settings, engine);
                let (interactive, interactive_ms) =
                    render_ramp(&ramp, &s, Quality::Interactive, raw);
                let (final_frame, final_ms) = render_ramp(&ramp, &s, Quality::Final, raw);
                let key = |quality: &str| {
                    let prefix = if raw { "legacyRaw" } else { "raster" };
                    let engine = if label == "niho12" {
                        "Niho12".to_owned()
                    } else if raw {
                        "Niho2".to_owned()
                    } else {
                        "Niho10".to_owned()
                    };
                    format!("{prefix}{engine}{quality}")
                };
                for (quality, frame) in [("Final", &final_frame), ("Interactive", &interactive)] {
                    let total = ge2_total(frame, 0) + ge2_total(frame, 32);
                    let k = key(quality);
                    totals[&k] = (totals[&k].as_u64().unwrap() + total as u64).into();
                }
                rows[engine] = json!({
                    "skyFinal": adjacent(&final_frame, 0),
                    "skinFinal": adjacent(&final_frame, 32),
                    "skyInteractive": adjacent(&interactive, 0),
                    "skinInteractive": adjacent(&interactive, 32)
                });
                if *variant == "moderate" {
                    timings.push(json!({
                        "path": path, "engine": engine,
                        "interactiveMs": interactive_ms, "finalMs": final_ms
                    }));
                }
            }
            entry[path] = rows;
        }
        ramps.push(entry);
    }

    let output = json!({
        "schema": "niho.niho12-public-measurement.v1",
        "engine": "niho-12",
        "status": "new-edit default for raster and legacy unsigned RAW working copies",
        "formulas": {
            "raster": "niho-10 (niho-6 response + hue-stable saturation)",
            "legacyRaw": "niho-2",
            "signedRaw": "refused",
            "cameraLinear": "refused"
        },
        "cubeContract": {
            "entries": "f32-unquantized (RAW look+ACR3, P, Q)",
            "interactiveDimension": 33,
            "finalDimension": 64,
            "gamma": 1.8,
            "interpolation": "trilinear",
            "inputClamp": "unchanged"
        },
        "publicFixtures": {
            "reference": "niho-10 raster formula on the same public input and settings (not Photo Bench / Lightroom)",
            "cases": cases.iter().map(|(name, _)| name.clone()).collect::<Vec<_>>(),
            "summary": {
                "pairs": fixtures.len() * cases.len(),
                "pairsWithChangedPixels": fixture_summary.0,
                "maxAbsoluteCodeDelta": fixture_summary.1,
                "maxMeanAbsoluteCodeDelta": fixture_summary.2
            },
            "inputs": fixtures
        },
        "syntheticRamps": {
            "width": 1024,
            "rows": {"sky": 0, "skin": 32},
            "input": "1024 distinct linear f32 steps per 2-color interpolation; no input 8-bit quantization",
            "adjacentGe2Totals": totals,
            "variants": ramps
        },
        "timingsMs": {
            "scope": "native cold pipeline render of the 1024x64 ramp (moderate); not a wasm frame gate",
            "rows": timings
        }
    });
    println!("{}", serde_json::to_string_pretty(&output).unwrap());
}
