//! v5 detail against Lightroom's statistics (Issue #32 round 32,
//! `docs/detail-processing.md`).
//!
//! The 1500 x 1000 chart of `tools/calibrate/make_lr_round32.py` is drawn
//! here from the fixture's regions with a seeded generator (the same edges,
//! gratings and noise sigmas; another noise realization). Every variant's
//! Camera Raw values go through the product's XMP preset converter onto a
//! niho-10 new edit and render at full size, Final. The statistics are those
//! of `tools/calibrate/round32_stats.py`; Lightroom's come from
//! `fixtures/color/review-2026-10-21/detail-round32-lightroom.json`.
#![cfg(not(target_arch = "wasm32"))]

use niho_develop::{encode, xmp, DevelopSettings, Filter, Quality, Session};
use serde_json::Value;
use std::collections::BTreeMap;

const LIGHTROOM: &str =
    include_str!("../../../fixtures/color/review-2026-10-21/detail-round32-lightroom.json");

struct Rng(u64);

impl Rng {
    fn next(&mut self) -> f64 {
        self.0 ^= self.0 << 13;
        self.0 ^= self.0 >> 7;
        self.0 ^= self.0 << 17;
        ((self.0 >> 11) as f64 + 0.5) / (1u64 << 53) as f64
    }

    fn normal(&mut self) -> f64 {
        let (u, v) = (self.next(), self.next());
        libm::sqrt(-2.0 * libm::log(u)) * libm::cos(std::f64::consts::TAU * v)
    }
}

fn region_box(region: &Value) -> [usize; 4] {
    let b = region["box"].as_array().unwrap();
    [0, 1, 2, 3].map(|i| b[i].as_u64().unwrap() as usize)
}

fn chart(spec: &Value) -> (Vec<u8>, usize, usize) {
    let width = spec["width"].as_u64().unwrap() as usize;
    let height = spec["height"].as_u64().unwrap() as usize;
    let mut rgb = vec![[0.0f64; 3]; width * height];
    let mut rng = Rng(0x0032_d3a1_5eed_0032);
    for region in spec["regions"].as_array().unwrap() {
        let [x0, y0, x1, y1] = region_box(region);
        for y in y0..y1 {
            for x in x0..x1 {
                let value = match region["kind"].as_str().unwrap() {
                    "edge" => {
                        let level = if x < (x0 + x1) / 2 { "lo" } else { "hi" };
                        [region[level].as_f64().unwrap(); 3]
                    }
                    "grating" => {
                        let period = region["period"].as_f64().unwrap();
                        let phase = std::f64::consts::TAU * (x - x0) as f64 / period;
                        [128.0 + 48.0 * libm::sin(phase); 3]
                    }
                    _ => {
                        let base = region["rgb"].as_array().unwrap();
                        let luma = region["lumaSigma"].as_f64().unwrap() * rng.normal();
                        let sigma = region["chromaSigma"].as_f64().unwrap();
                        let (cb, cr) = (sigma * rng.normal(), sigma * rng.normal());
                        // Rec.601 chroma offsets with zero luma change.
                        let offset = [1.402 * cr, -0.344136 * cb - 0.714136 * cr, 1.772 * cb];
                        [0, 1, 2].map(|c| base[c].as_f64().unwrap() + luma + offset[c])
                    }
                };
                rgb[y * width + x] = value;
            }
        }
    }
    let rgba: Vec<u8> = rgb
        .iter()
        .flat_map(|pixel| {
            let [r, g, b] = pixel.map(|v| v.round().clamp(0.0, 255.0) as u8);
            [r, g, b, 255]
        })
        .collect();
    (
        encode::encode_png(&rgba, width, height).unwrap(),
        width,
        height,
    )
}

fn packet(settings: &Value) -> String {
    let attributes: String = settings
        .as_object()
        .unwrap()
        .iter()
        .map(|(key, value)| format!(" crs:{key}=\"{}\"", value.as_str().unwrap()))
        .collect();
    format!(
        "<x:xmpmeta xmlns:x=\"adobe:ns:meta/\"><rdf:RDF \
         xmlns:rdf=\"http://www.w3.org/1999/02/22-rdf-syntax-ns#\"><rdf:Description \
         rdf:about=\"\" xmlns:crs=\"http://ns.adobe.com/camera-raw-settings/1.0/\" \
         crs:Version=\"18.3\" crs:ProcessVersion=\"15.4\"{attributes} \
         crs:LensProfileEnable=\"0\" crs:AutoLateralCA=\"0\" crs:HasSettings=\"True\" \
         crs:AlreadyApplied=\"False\"/></rdf:RDF></x:xmpmeta>"
    )
}

/// Rec.601 luma of 8-bit codes.
fn luma(pixel: &[u8]) -> f64 {
    0.299 * f64::from(pixel[0]) + 0.587 * f64::from(pixel[1]) + 0.114 * f64::from(pixel[2])
}

fn mean(values: &[f64]) -> f64 {
    values.iter().sum::<f64>() / values.len() as f64
}

fn std(values: &[f64]) -> f64 {
    let m = mean(values);
    (values.iter().map(|v| (v - m) * (v - m)).sum::<f64>() / values.len() as f64).sqrt()
}

/// numpy's default (linear) percentile.
fn percentile(values: &[f64], q: f64) -> f64 {
    let mut sorted = values.to_vec();
    sorted.sort_by(f64::total_cmp);
    let position = q / 100.0 * (sorted.len() - 1) as f64;
    let (lo, hi) = (position.floor() as usize, position.ceil() as usize);
    sorted[lo] + (sorted[hi] - sorted[lo]) * (position - lo as f64)
}

/// `name -> value` in the naming of `round32_stats.py compare`.
fn statistics(rgba: &[u8], width: usize, spec: &Value) -> BTreeMap<String, f64> {
    let y = |x: usize, row: usize| luma(&rgba[(row * width + x) * 4..]);
    let column_profile = |x0: usize, x1: usize, y0: usize, y1: usize| -> Vec<f64> {
        (x0..x1)
            .map(|x| mean(&(y0..y1).map(|row| y(x, row)).collect::<Vec<_>>()))
            .collect()
    };
    let mut out = BTreeMap::new();
    for region in spec["regions"].as_array().unwrap() {
        let [x0, y0, x1, y1] = region_box(region);
        match region["kind"].as_str().unwrap() {
            "edge" => {
                let profile = column_profile(x0, x1, y0 + 40, y1 - 40);
                let mid = (x1 - x0) / 2;
                let window = &profile[mid - 30..mid + 30];
                let left = mean(&window[..10]);
                let right = mean(&window[window.len() - 10..]);
                let crossing = |level: f64| -> f64 {
                    let i = window.iter().position(|v| *v >= level).unwrap();
                    if i == 0 {
                        0.0
                    } else {
                        (i - 1) as f64 + (level - window[i - 1]) / (window[i] - window[i - 1])
                    }
                };
                let span = right - left;
                let name = format!(
                    "edge {}-{}",
                    region["lo"].as_u64().unwrap(),
                    region["hi"].as_u64().unwrap()
                );
                let max = window.iter().copied().fold(f64::MIN, f64::max);
                let min = window.iter().copied().fold(f64::MAX, f64::min);
                out.insert(
                    format!("{name} rise10to90"),
                    crossing(left + 0.9 * span) - crossing(left + 0.1 * span),
                );
                out.insert(format!("{name} overshoot"), max - right);
                out.insert(format!("{name} undershoot"), left - min);
            }
            "grating" => {
                let profile = column_profile(x0 + 20, x1 - 20, y0 + 40, y1 - 40);
                out.insert(
                    format!("grating p{} gain", region["period"].as_u64().unwrap()),
                    (percentile(&profile, 99.0) - percentile(&profile, 1.0)) / 96.0,
                );
            }
            _ => {
                let (w, h) = (x1 - x0, y1 - y0);
                let mut lumas = Vec::new();
                let mut cbs = Vec::new();
                let mut crs = Vec::new();
                for row in y0 + h / 5..y1 - h / 5 {
                    for x in x0 + w / 5..x1 - w / 5 {
                        let pixel = &rgba[(row * width + x) * 4..];
                        let l = luma(pixel);
                        lumas.push(l);
                        cbs.push((f64::from(pixel[2]) - l) / 1.772);
                        crs.push((f64::from(pixel[0]) - l) / 1.402);
                    }
                }
                let rgb: Vec<String> = region["rgb"]
                    .as_array()
                    .unwrap()
                    .iter()
                    .map(|v| v.to_string())
                    .collect();
                let (luma_in, chroma_in) = (
                    region["lumaSigma"].as_u64().unwrap(),
                    region["chromaSigma"].as_u64().unwrap(),
                );
                let name = format!("patch {} luma{luma_in} chroma{chroma_in}", rgb.join("/"));
                if luma_in > 0 || chroma_in > 0 {
                    out.insert(format!("{name} lumaStd"), std(&lumas));
                }
                if chroma_in > 0 {
                    out.insert(format!("{name} chromaStd"), (std(&cbs) + std(&crs)) / 2.0);
                }
            }
        }
    }
    out
}

fn lightroom_statistics(stats: &Value) -> BTreeMap<String, f64> {
    let mut out = BTreeMap::new();
    for edge in stats["edges"].as_array().unwrap() {
        let name = format!("edge {}-{}", edge["lo"], edge["hi"]);
        for key in ["rise10to90", "overshoot", "undershoot"] {
            out.insert(format!("{name} {key}"), edge[key].as_f64().unwrap());
        }
    }
    for grating in stats["gratings"].as_array().unwrap() {
        out.insert(
            format!("grating p{} gain", grating["period"]),
            grating["gain"].as_f64().unwrap(),
        );
    }
    for patch in stats["noise"].as_array().unwrap() {
        let rgb: Vec<String> = patch["rgb"]
            .as_array()
            .unwrap()
            .iter()
            .map(|v| v.to_string())
            .collect();
        let (luma_in, chroma_in) = (
            patch["lumaSigmaIn"].as_u64().unwrap(),
            patch["chromaSigmaIn"].as_u64().unwrap(),
        );
        let name = format!("patch {} luma{luma_in} chroma{chroma_in}", rgb.join("/"));
        if luma_in > 0 || chroma_in > 0 {
            out.insert(
                format!("{name} lumaStd"),
                patch["lumaStd"].as_f64().unwrap(),
            );
        }
        if chroma_in > 0 {
            let chroma =
                (patch["cbStd"].as_f64().unwrap() + patch["crStd"].as_f64().unwrap()) / 2.0;
            out.insert(format!("{name} chromaStd"), chroma);
        }
    }
    out
}

fn kind(stat: &str) -> &str {
    stat.rsplit(' ').next().unwrap()
}

/// Allowed |NIHO - Lightroom| per statistic (the calibrated residual with
/// margin; `docs/detail-processing.md` lists the residuals).
fn tolerance(stat: &str, lightroom: f64) -> f64 {
    match kind(stat) {
        "rise10to90" => 2.5,
        "overshoot" | "undershoot" => 8.0,
        "gain" => 0.15,
        "lumaStd" => 1.5 + 0.2 * lightroom,
        "chromaStd" => 1.0,
        other => panic!("unknown statistic {other}"),
    }
}

/// A step smaller than this is "no change" (as `round32_stats.py`).
fn step(stat: &str) -> f64 {
    match kind(stat) {
        "rise10to90" => 0.15,
        "overshoot" | "undershoot" => 1.0,
        "gain" => 0.011,
        _ => 0.15,
    }
}

fn direction(delta: f64, tolerance: f64) -> i32 {
    if delta.abs() <= tolerance {
        0
    } else if delta > 0.0 {
        1
    } else {
        -1
    }
}

/// Lightroom's sharpening kernel rings on the second pixel, which moves the
/// 10% crossing of a strongly sharpened edge outward (its rise grows with
/// the strength); NIHO's Gaussian USM does not ring. NIHO's dark halo on
/// the 64 side of the 64-192 edge is held at about 10 codes, where
/// Lightroom wanders between 8 and 12.
fn documented_residual(variant_sharpness: f64, stat: &str) -> bool {
    (variant_sharpness > 0.0 && kind(stat) == "rise10to90") || stat == "edge 64-192 undershoot"
}

#[test]
fn every_round32_statistic_is_near_lightroom_and_moves_its_way() {
    let fixture: Value = serde_json::from_str(LIGHTROOM).unwrap();
    let spec = &fixture["chart"];
    let (png, width, height) = chart(spec);
    let mut base = DevelopSettings::new_edit();
    base.engine = "niho-10".into();
    let mut session = Session::open_raster(&png, 0, Filter::Lanczos3).unwrap();
    let variants = fixture["variants"].as_object().unwrap();
    let mut niho = BTreeMap::new();
    let mut failures = Vec::new();
    for (name, entry) in variants {
        let settings = xmp::preset_settings(&packet(&entry["settings"]), Some(&base))
            .unwrap()
            .settings;
        let frame = session.render(&settings, 0, Quality::Final).unwrap();
        assert_eq!((frame.width, frame.height), (width, height));
        let ours = statistics(&frame.rgba, width, spec);
        let sharpness: f64 = entry["settings"]["Sharpness"]
            .as_str()
            .unwrap()
            .parse()
            .unwrap();
        for (stat, reference) in lightroom_statistics(&entry["lightroom"]) {
            if documented_residual(sharpness, &stat) {
                continue;
            }
            let value = ours[&stat];
            if (value - reference).abs() > tolerance(&stat, reference) {
                failures.push(format!(
                    "{name} {stat}: NIHO {value:.3} vs Lightroom {reference:.3}"
                ));
            }
        }
        niho.insert(name.clone(), (sharpness, ours));
    }
    let families: [&[&str]; 6] = [
        &["neutral", "sharp_a40", "sharp_a80", "sharp_a150"],
        &[
            "sharp_a80_r05",
            "sharp_a80",
            "sharp_a80_r20",
            "sharp_a80_r30",
        ],
        &[
            "sharp_a80_d0",
            "sharp_a80",
            "sharp_a80_d75",
            "sharp_a80_d100",
        ],
        &["sharp_a80", "sharp_a80_m50", "sharp_a80_m90"],
        &["neutral", "lnr_25", "lnr_50", "lnr_75", "lnr_100"],
        &["neutral", "cnr_25", "cnr_50", "cnr_100"],
    ];
    for family in families {
        let lightroom: Vec<_> = family
            .iter()
            .map(|n| lightroom_statistics(&variants[*n]["lightroom"]))
            .collect();
        let ours: Vec<_> = family.iter().map(|n| &niho[*n]).collect();
        for stat in lightroom[0].keys() {
            if ours
                .iter()
                .any(|(sharpness, _)| documented_residual(*sharpness, stat))
            {
                continue;
            }
            let tolerance = step(stat);
            let lr: Vec<f64> = lightroom.iter().map(|s| s[stat]).collect();
            let ni: Vec<f64> = ours.iter().map(|(_, s)| s[stat]).collect();
            let (lr_total, ni_total) = (lr[lr.len() - 1] - lr[0], ni[ni.len() - 1] - ni[0]);
            let overall = if lr_total.abs() > tolerance {
                ni_total * lr_total > 0.0
            } else {
                ni_total.abs() <= 3.0 * tolerance
            };
            let opposite = lr.windows(2).zip(ni.windows(2)).any(|(l, n)| {
                let (l, n) = (
                    direction(l[1] - l[0], tolerance),
                    direction(n[1] - n[0], tolerance),
                );
                l != 0 && n == -l
            });
            if !overall || opposite {
                failures.push(format!(
                    "{}: {stat} Lightroom {lr:.3?} NIHO {ni:.3?}",
                    family.join(" -> ")
                ));
            }
        }
    }
    assert!(failures.is_empty(), "{}", failures.join("\n"));
}
