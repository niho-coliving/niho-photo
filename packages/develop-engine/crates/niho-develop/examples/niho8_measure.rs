//! Reproducible public measurement for the unpromoted `niho-8` candidate.
//!
//! Prints one JSON document with public-fixture deltas against `niho-6`,
//! synthetic 1024-step sky/skin ramp banding counts, and cold-session
//! Interactive/Final timings. It does not assert a production-quality gate.

use niho_develop::decode::{LinearImage, WorkingCopyMeta};
use niho_develop::pipeline::{render_working_copy, WorkingCopy};
use niho_develop::settings::{ENGINE_NIHO_6, ENGINE_NIHO_8, LOOK_NIHO_STANDARD_1};
use niho_develop::{DevelopSettings, Filter, Quality, Session};
use serde_json::{json, Value};
use std::path::PathBuf;
use std::time::Instant;

fn settings(engine: &str) -> DevelopSettings {
    let mut settings = DevelopSettings::neutral();
    settings.engine = engine.into();
    settings.look = LOOK_NIHO_STANDARD_1.into();
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

fn render_linear_ramp(
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

fn adjacent_counts(rgba: &[u8], row: usize) -> Value {
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
    json!({"adjacentGe2": ge2, "adjacentEqual": equal, "maxAdjacent": max})
}

fn render(bytes: &[u8], settings: &DevelopSettings, quality: Quality) -> (Vec<u8>, f64) {
    let opened = Instant::now();
    let mut session = Session::open_raster(bytes, 0, Filter::Lanczos3).unwrap();
    let started = Instant::now();
    let frame = session.render(settings, 0, quality).unwrap();
    let render_ms = started.elapsed().as_secs_f64() * 1000.0;
    std::hint::black_box(&frame.rgba);
    let _open_and_render_ms = opened.elapsed().as_secs_f64() * 1000.0;
    (frame.rgba, render_ms)
}

fn main() {
    let root = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../..");
    let fixture_dir = root.join("fixtures/golden/input");
    let six = settings(ENGINE_NIHO_6);
    let eight = settings(ENGINE_NIHO_8);
    let mut fixtures = Vec::new();
    for name in [
        "dsc02072.jpg",
        "dsc02078.jpg",
        "dsc02150.jpg",
        "saturated-blue.png",
    ] {
        let bytes = std::fs::read(fixture_dir.join(name)).unwrap();
        let (a, _) = render(&bytes, &six, Quality::Final);
        let (b, _) = render(&bytes, &eight, Quality::Final);
        fixtures.push(json!({
            "fixture": name,
            "reference": "niho-6 raster formula on the same public input",
            "niho8MinusReference": delta(&b, &a)
        }));
    }

    let ramp = linear_ramp();
    let (six_ramp, _) = render_linear_ramp(&ramp, &six, Quality::Final, false);
    let (eight_interactive, interactive_ms) =
        render_linear_ramp(&ramp, &eight, Quality::Interactive, false);
    let (eight_final, final_ms) = render_linear_ramp(&ramp, &eight, Quality::Final, false);
    let mut two = eight.clone();
    two.engine = niho_develop::settings::ENGINE_NIHO_2.into();
    let (raw_two, _) = render_linear_ramp(&ramp, &two, Quality::Final, true);
    let (raw_eight, _) = render_linear_ramp(&ramp, &eight, Quality::Final, true);
    let output = json!({
        "schema": "niho.niho8-public-measurement.v1",
        "candidate": "niho-8",
        "status": "unpromoted-evaluation-candidate",
        "qualityClaim": false,
        "cubeContract": {
            "entries": "f32-unquantized",
            "interactiveDimension": 33,
            "finalDimension": 64,
            "gamma": 1.8,
            "interpolation": "trilinear"
        },
        "publicFixtures": fixtures,
        "syntheticRamps": {
            "width": 1024,
            "input": "1024 distinct linear f32 steps; no input 8-bit quantization",
            "legacyRaw": {
                "skyNiho2": adjacent_counts(&raw_two, 0), "skyNiho8": adjacent_counts(&raw_eight, 0),
                "skinNiho2": adjacent_counts(&raw_two, 32), "skinNiho8": adjacent_counts(&raw_eight, 32)
            },
            "sky": {
                "niho6Final": adjacent_counts(&six_ramp, 0),
                "niho8Interactive": adjacent_counts(&eight_interactive, 0),
                "niho8Final": adjacent_counts(&eight_final, 0)
            },
            "skin": {
                "niho6Final": adjacent_counts(&six_ramp, 32),
                "niho8Interactive": adjacent_counts(&eight_interactive, 32),
                "niho8Final": adjacent_counts(&eight_final, 32)
            }
        },
        "timingsMs": {
            "scope": "native cold pipeline render of 1024x64 ramp; not a wasm frame performance gate",
            "interactive": interactive_ms,
            "final": final_ms
        },
        "remainingGates": [
            "external Lightroom preset plus white-balance references",
            "independent teacher/holdout evaluation",
            "product promotion decision"
        ]
    });
    println!("{}", serde_json::to_string_pretty(&output).unwrap());
}
