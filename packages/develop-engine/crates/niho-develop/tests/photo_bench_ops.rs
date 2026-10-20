//! Cross-checks the ported point and spatial operations against Photo
//! Bench's own fixtures (`Tests/Fixtures/phase2/*.json`, generated from the
//! `.photobench/phase2` Python reference models that Photo Bench's Swift
//! port matches at 1e-4 relative).

use niho_develop::color_ops;
use niho_develop::settings::{
    CalibrationSettings, ColorGradeBand, ColorGradingSettings, CurveChannel, CurvePoint,
    DevelopSettings, HslAdjustment, HslBand, ToneCurve,
};
use niho_develop::spatial::{self, GainScale, Quality, Shift, SpatialParams};
use niho_develop::tone_ops::{self, Parametric, PreparedPointCurve, PreparedPostOps};

/// The sampled Stage P used by cube bakes stays within 5e-5 (linear) of the
/// direct model; the largest gaps sit at the curves' clamp kinks. For
/// scale: 8-bit cube entries step by 1/255 in the gamma-1.8 domain.
#[test]
fn sampled_post_ops_match_direct_model() {
    let presets = [
        ("niho-bluesky2", 0.42),
        ("niho-pastel", 0.37),
        ("niho-colorful", -0.8),
    ];
    for (id, ev) in presets {
        let s = niho_develop::xmp::preset_settings(
            niho_develop::xmp::builtin_preset(id).unwrap().xmp,
            None,
        )
        .unwrap()
        .settings;
        let prepared = PreparedPostOps::with_exposure(&s, ev);
        let mut worst: f64 = 0.0;
        let n = 24;
        for r in 0..=n {
            for g in 0..=n {
                for b in 0..=n {
                    let v = [
                        (r as f64 / n as f64).powf(1.8),
                        (g as f64 / n as f64).powf(1.8),
                        (b as f64 / n as f64).powf(1.8),
                    ];
                    let direct = tone_ops::apply_post_ops(tone_ops::exposure_non_raw(v, ev), &s);
                    let sampled = prepared.apply(v);
                    for c in 0..3 {
                        worst = worst.max((direct[c] - sampled[c]).abs());
                    }
                }
            }
        }
        assert!(worst < 5e-5, "{id}: worst {worst}");
    }
}
use serde_json::Value;

fn load(name: &str) -> Value {
    let path = format!(
        "{}/tests/fixtures/photo-bench/{name}",
        env!("CARGO_MANIFEST_DIR")
    );
    serde_json::from_str(&std::fs::read_to_string(path).unwrap()).unwrap()
}

fn rgb_list(v: &Value) -> Vec<[f64; 3]> {
    v.as_array()
        .unwrap()
        .iter()
        .map(|p| {
            let a = p.as_array().unwrap();
            [
                a[0].as_f64().unwrap(),
                a[1].as_f64().unwrap(),
                a[2].as_f64().unwrap(),
            ]
        })
        .collect()
}

fn f(v: &Value, key: &str) -> f64 {
    v[key].as_f64().unwrap_or_else(|| panic!("missing {key}"))
}

fn assert_close(label: &str, got: [f64; 3], want: [f64; 3], rel: f64, floor: f64) -> f64 {
    let mut worst: f64 = 0.0;
    for c in 0..3 {
        let tol = (rel * want[c].abs()).max(floor);
        let diff = (got[c] - want[c]).abs();
        worst = worst.max(diff / want[c].abs().max(floor));
        assert!(
            diff <= tol,
            "{label} channel {c}: got {} want {} (diff {diff})",
            got[c],
            want[c]
        );
    }
    worst
}

fn curve_from_255(points: &Value) -> Vec<ToneCurve> {
    let pts = points
        .as_array()
        .unwrap()
        .iter()
        .map(|p| {
            let a = p.as_array().unwrap();
            CurvePoint {
                x: a[0].as_f64().unwrap() / 255.0,
                y: a[1].as_f64().unwrap() / 255.0,
            }
        })
        .collect();
    vec![ToneCurve {
        channel: CurveChannel::Rgb,
        points: pts,
    }]
}

fn parametric_from(p: &Value) -> Parametric {
    Parametric {
        shadows: f(p, "shadows"),
        darks: f(p, "darks"),
        lights: f(p, "lights"),
        highlights: f(p, "highlights"),
        shadow_split: f(p, "shadowSplit"),
        midtone_split: f(p, "midtoneSplit"),
        highlight_split: f(p, "highlightSplit"),
    }
}

#[test]
fn tone_ops_match_reference_model() {
    let fixture = load("tone-ops.json");
    let inputs = rgb_list(&fixture["inputs"]);
    let mut cases = 0;
    for case in fixture["cases"].as_array().unwrap() {
        let name = case["name"].as_str().unwrap();
        let p = &case["params"];
        let outputs = rgb_list(&case["outputs"]);
        let op: Box<dyn Fn([f64; 3]) -> [f64; 3]> = match case["op"].as_str().unwrap() {
            "exposureNonRaw" => {
                let ev = f(p, "ev");
                Box::new(move |v| tone_ops::exposure_non_raw(v, ev))
            }
            "contrast" => {
                let a = f(p, "amount");
                Box::new(move |v| tone_ops::contrast(v, a))
            }
            "whites" => {
                let a = f(p, "amount");
                Box::new(move |v| tone_ops::whites(v, a))
            }
            "blacks" => {
                let a = f(p, "amount");
                Box::new(move |v| tone_ops::blacks(v, a))
            }
            "parametric" => {
                let par = parametric_from(p);
                Box::new(move |v| tone_ops::parametric(v, &par))
            }
            "pointCurve" => {
                let curve = PreparedPointCurve::new(&curve_from_255(&p["points"]));
                Box::new(move |v| curve.apply(v))
            }
            "applyPostOps" => {
                let mut s = DevelopSettings::neutral();
                s.contrast = f(p, "contrast");
                s.whites = f(p, "whites");
                s.blacks = f(p, "blacks");
                s.parametric_shadows = f(p, "parametricShadows");
                s.parametric_darks = f(p, "parametricDarks");
                s.parametric_lights = f(p, "parametricLights");
                s.parametric_highlights = f(p, "parametricHighlights");
                s.parametric_shadow_split = f(p, "parametricShadowSplit");
                s.parametric_midtone_split = f(p, "parametricMidtoneSplit");
                s.parametric_highlight_split = f(p, "parametricHighlightSplit");
                s.tone_curves = curve_from_255(&p["points"]);
                Box::new(move |v| tone_ops::apply_post_ops(v, &s))
            }
            other => panic!("unknown op {other}"),
        };
        for (i, (input, want)) in inputs.iter().zip(outputs.iter()).enumerate() {
            assert_close(&format!("{name}[{i}]"), op(*input), *want, 1e-4, 1e-7);
        }
        cases += 1;
    }
    assert!(cases >= 27);
}

fn band(name: &str) -> HslBand {
    HslBand::parse(&name.to_lowercase()).unwrap()
}

fn grading_from(p: &Value) -> ColorGradingSettings {
    let b = |prefix: &str| ColorGradeBand {
        hue: f(p, &format!("{prefix}Hue")),
        saturation: f(p, &format!("{prefix}Sat")),
        luminance: f(p, &format!("{prefix}Lum")),
    };
    ColorGradingSettings {
        shadow: b("shadow"),
        midtone: b("midtone"),
        highlight: b("highlight"),
        global: b("global"),
        blending: f(p, "blending"),
        balance: f(p, "balance"),
    }
}

#[test]
fn color_ops_match_reference_model() {
    let fixture = load("color-ops.json");
    let inputs = rgb_list(&fixture["inputs"]);
    let mut cases = 0;
    for case in fixture["cases"].as_array().unwrap() {
        let name = case["name"].as_str().unwrap();
        let p = &case["params"];
        let outputs = rgb_list(&case["outputs"]);
        let op: Box<dyn Fn([f64; 3]) -> [f64; 3]> = match case["op"].as_str().unwrap() {
            "saturation" => {
                let a = f(p, "amount");
                Box::new(move |v| color_ops::saturation(v, a))
            }
            "vibrance" => {
                let a = f(p, "amount");
                Box::new(move |v| color_ops::vibrance(v, a))
            }
            "hsl" => {
                let adj = vec![(
                    band(p["hslBand"].as_str().unwrap()),
                    HslAdjustment {
                        hue: f(p, "hslHue"),
                        saturation: f(p, "hslSaturation"),
                        luminance: f(p, "hslLuminance"),
                    },
                )];
                Box::new(move |v| color_ops::hsl(v, &adj))
            }
            "calibration" => {
                let c = CalibrationSettings {
                    shadow_tint: 0.0,
                    red_hue: f(p, "redHue"),
                    red_saturation: f(p, "redSaturation"),
                    green_hue: f(p, "greenHue"),
                    green_saturation: f(p, "greenSaturation"),
                    blue_hue: f(p, "blueHue"),
                    blue_saturation: f(p, "blueSaturation"),
                };
                Box::new(move |v| color_ops::calibration(v, &c))
            }
            "colorGrading" => {
                let g = grading_from(p);
                Box::new(move |v| color_ops::color_grading(v, &g))
            }
            "applyColorOps" => {
                let mut s = DevelopSettings::neutral();
                s.vibrance = f(p, "vibrance");
                s.saturation = f(p, "saturation");
                for a in p["hslAdjustments"].as_array().unwrap() {
                    s.hsl.set(
                        band(a["band"].as_str().unwrap()),
                        HslAdjustment {
                            hue: f(a, "hue"),
                            saturation: f(a, "saturation"),
                            luminance: f(a, "luminance"),
                        },
                    );
                }
                s.color_grading = grading_from(p);
                let prepared = color_ops::PreparedColorOps::new(&s);
                Box::new(move |v| prepared.apply(v))
            }
            other => panic!("unknown op {other}"),
        };
        for (i, (input, want)) in inputs.iter().zip(outputs.iter()).enumerate() {
            assert_close(&format!("{name}[{i}]"), op(*input), *want, 1e-4, 1e-6);
        }
        cases += 1;
    }
    assert!(cases >= 22);
}

fn flat(v: &Value) -> Vec<f32> {
    rgb_list(v)
        .into_iter()
        .flat_map(|p| [p[0] as f32, p[1] as f32, p[2] as f32])
        .collect()
}

/// `f32` pyramids against the `float64` reference: 1e-3 relative (the
/// reference's own Swift port gate is 1e-4 in `Double`).
const SPATIAL_REL: f64 = 1e-3;

fn check_image(label: &str, got: &[f32], want: &[f32]) -> f64 {
    let mut worst: f64 = 0.0;
    for (i, (g, w)) in got.iter().zip(want.iter()).enumerate() {
        let (g, w) = (*g as f64, *w as f64);
        let diff = (g - w).abs();
        if diff <= 1e-6 {
            continue;
        }
        let rel = diff / w.abs().max(1e-6);
        worst = worst.max(rel);
        assert!(
            rel <= SPATIAL_REL,
            "{label}[{i}]: got {g} want {w} (rel {rel})"
        );
    }
    worst
}

fn spatial_params(h: f64, s: f64, t: f64, c: f64, scale_px: f64) -> SpatialParams {
    SpatialParams {
        highlights: h,
        shadows: s,
        texture: t,
        clarity: c,
        scale_px,
        long_edge: (scale_px * 1500.0 / 32.0).round() as usize,
        gain_scale: GainScale::IDENTITY,
        shift: Shift::default(),
        quality: Quality::Final,
    }
}

#[test]
fn spatial_highlights_shadows_match_reference_model() {
    let fixture = load("spatial-ops.json");
    let width = fixture["width"].as_u64().unwrap() as usize;
    let height = fixture["height"].as_u64().unwrap() as usize;
    let input = flat(&fixture["input"]);
    let mut worst: f64 = 0.0;
    for case in fixture["cases"].as_array().unwrap() {
        let mut rgb = input.clone();
        let p = spatial_params(
            f(case, "highlights"),
            f(case, "shadows"),
            0.0,
            0.0,
            f(case, "scalePx"),
        );
        spatial::apply_in_place(&mut rgb, width, height, &p);
        worst = worst.max(check_image(
            case["name"].as_str().unwrap(),
            &rgb,
            &flat(&case["output"]),
        ));
    }
    eprintln!("spatial worst relative error {worst:e}");
}

#[test]
fn pyramid_primitives_match_reference_model() {
    let fixture = load("spatial-ops.json");
    for key in ["pyrDown", "pyrUp"] {
        let d = &fixture[key];
        let in_w = d["inputWidth"].as_u64().unwrap() as usize;
        let in_h = d["inputHeight"].as_u64().unwrap() as usize;
        let out_w = d["outputWidth"].as_u64().unwrap() as usize;
        let out_h = d["outputHeight"].as_u64().unwrap() as usize;
        let data: Vec<f32> = d["input"]
            .as_array()
            .unwrap()
            .iter()
            .map(|v| v.as_f64().unwrap() as f32)
            .collect();
        let want: Vec<f32> = d["output"]
            .as_array()
            .unwrap()
            .iter()
            .map(|v| v.as_f64().unwrap() as f32)
            .collect();
        let plane = spatial::Plane {
            width: in_w,
            height: in_h,
            data,
        };
        let out = if key == "pyrDown" {
            spatial::pyr_down(&plane)
        } else {
            spatial::pyr_up(&plane, out_w, out_h)
        };
        assert_eq!((out.width, out.height), (out_w, out_h));
        for (i, (g, w)) in out.data.iter().zip(want.iter()).enumerate() {
            assert!(
                (g - w).abs() <= 1e-5 * w.abs().max(1.0),
                "{key}[{i}]: {g} vs {w}"
            );
        }
    }
}

#[test]
fn texture_clarity_dehaze_match_reference_model() {
    let fixture = load("detail-ops.json");
    let width = fixture["width"].as_u64().unwrap() as usize;
    let height = fixture["height"].as_u64().unwrap() as usize;
    let input = flat(&fixture["input"]);
    for case in fixture["textureCases"].as_array().unwrap() {
        let mut rgb = input.clone();
        spatial::apply_in_place(
            &mut rgb,
            width,
            height,
            &spatial_params(0.0, 0.0, f(case, "amount"), 0.0, f(case, "scalePx")),
        );
        check_image(case["name"].as_str().unwrap(), &rgb, &flat(&case["output"]));
    }
    for case in fixture["clarityCases"].as_array().unwrap() {
        let mut rgb = input.clone();
        spatial::apply_in_place(
            &mut rgb,
            width,
            height,
            &spatial_params(0.0, 0.0, 0.0, f(case, "amount"), f(case, "scalePx")),
        );
        check_image(case["name"].as_str().unwrap(), &rgb, &flat(&case["output"]));
    }
    let c = &fixture["chainedCase"];
    let mut rgb = input.clone();
    spatial::apply_in_place(
        &mut rgb,
        width,
        height,
        &spatial_params(
            f(c, "highlights"),
            f(c, "shadows"),
            f(c, "texture"),
            f(c, "clarity"),
            f(c, "scalePx"),
        ),
    );
    check_image("chained", &rgb, &flat(&c["output"]));
    let inputs = rgb_list(&fixture["input"]);
    for case in fixture["dehazeCases"].as_array().unwrap() {
        let amount = f(case, "amount");
        for (i, (v, want)) in inputs
            .iter()
            .zip(rgb_list(&case["output"]).iter())
            .enumerate()
        {
            let got = tone_ops::dehaze(*v, amount);
            for ch in 0..3 {
                let diff = (got[ch] - want[ch]).abs();
                if diff > 1e-6 {
                    assert!(
                        diff / want[ch].abs().max(1e-6) <= 1e-4,
                        "dehaze {amount} [{i}]: {got:?} vs {want:?}"
                    );
                }
            }
        }
    }
}
