//! A preset's amount (`xmp::apply_preset`, Issue #17121 F2a): 0% is the
//! photo's settings byte for byte, 100% exactly `preset_settings`, numbers
//! in between linear (extrapolated to 150% and stopped at their ranges),
//! curves on the union of their nodes, color grading hues on the short arc
//! and an absolute white in mireds without extrapolation.

use niho_develop::settings::{
    ColorGradeBand, CurveChannel, CurvePoint, HslAdjustment, HslBand, ToneCurve, VignetteStyle,
    WhiteBalance, WhiteBalanceMode, LOOK_NIHO_STANDARD_1,
};
use niho_develop::tone_ops::DngSpline;
use niho_develop::xmp::{self, XmpError, BUILTIN_PRESETS};
use niho_develop::{DevelopSettings, LightroomWhite};
use serde_json::Value;

const MONO_XMP: &str = include_str!("fixtures/effects/lr-monochrome.xmp");
const FILM_XMP: &str = include_str!("fixtures/effects/lr-film.xmp");

/// An XMP preset with these `crs` attributes (and curve elements).
fn preset(attributes: &str, elements: &str) -> String {
    format!(
        r#"<x:xmpmeta xmlns:x="adobe:ns:meta/"><rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#">
<rdf:Description rdf:about="" xmlns:crs="http://ns.adobe.com/camera-raw-settings/1.0/" {attributes}>{elements}</rdf:Description></rdf:RDF></x:xmpmeta>"#
    )
}

fn curve_element(name: &str, points: &[(u8, u8)]) -> String {
    let items: String = points
        .iter()
        .map(|(x, y)| format!("<rdf:li>{x}, {y}</rdf:li>"))
        .collect();
    format!("<crs:{name}><rdf:Seq>{items}</rdf:Seq></crs:{name}>")
}

fn apply(xmp: &str, base: &DevelopSettings, amount: f64) -> DevelopSettings {
    xmp::apply_preset(xmp, base, amount, None).unwrap().settings
}

fn close(a: f64, b: f64) -> bool {
    (a - b).abs() <= 1e-9 * b.abs().max(1.0)
}

/// A photo's own edit: every kind of control away from its default, the
/// NIHO look, a working copy's base version and an unknown key.
fn edited_base() -> DevelopSettings {
    let mut s = DevelopSettings::new_edit();
    s.base = Some("apple-raw-linear/1/test".into());
    s.extra.insert("futureKey".into(), Value::from(7));
    s.exposure = 0.3;
    s.contrast = 10.0;
    s.vibrance = -20.0;
    s.parametric_darks = 12.0;
    s.hsl.set(
        HslBand::Blue,
        HslAdjustment {
            hue: 10.0,
            saturation: -10.0,
            luminance: 4.0,
        },
    );
    s.calibration.red_hue = 8.0;
    s.color_grading.shadow = ColorGradeBand {
        hue: 350.0,
        saturation: 20.0,
        luminance: -10.0,
    };
    s.color_grading.blending = 60.0;
    s.gray_mixer.set(HslBand::Red, 30.0);
    s.vignette.amount = -20.0;
    s.grain.amount = 10.0;
    s.grain.seed = Some(7.0);
    s.tone_curves = vec![ToneCurve {
        channel: CurveChannel::Red,
        points: vec![
            CurvePoint { x: 0.0, y: 0.0 },
            CurvePoint {
                x: 128.0 / 255.0,
                y: 110.0 / 255.0,
            },
            CurvePoint { x: 1.0, y: 1.0 },
        ],
    }];
    // Effects use the v3 shape contract; this fixture is assembled by
    // mutating the typed settings rather than parsing JSON, so keep its
    // version in sync explicitly.
    s.v = s.required_version();
    assert!(s.validate().is_empty());
    s
}

fn numbers_preset() -> String {
    preset(
        r#"crs:Exposure2012="+1.3" crs:Contrast2012="+25" crs:Vibrance="+40" crs:ParametricDarks="-20"
        crs:HueAdjustmentBlue="-30" crs:SaturationAdjustmentBlue="+50" crs:LuminanceAdjustmentBlue="0"
        crs:RedHue="-12" crs:SplitToningShadowHue="10" crs:SplitToningShadowSaturation="40"
        crs:ColorGradeShadowLum="+30" crs:ColorGradeBlending="100" crs:SplitToningBalance="-40"
        crs:GrayMixerRed="-50" crs:PostCropVignetteAmount="-60" crs:GrainAmount="50""#,
        "",
    )
}

#[test]
fn zero_is_the_base_and_one_is_the_whole_preset() {
    let base = edited_base();
    for (id, text) in BUILTIN_PRESETS
        .iter()
        .map(|p| (p.id, p.xmp.to_string()))
        .chain([("numbers", numbers_preset()), ("film", FILM_XMP.into())])
    {
        let zero = xmp::apply_preset(&text, &base, 0.0, None).unwrap();
        assert_eq!(zero.settings.to_json(), base.to_json(), "{id} 0%");
        assert_eq!(zero.amount, Some(0.0));
        let whole = xmp::preset_settings(&text, Some(&base)).unwrap();
        let one = xmp::apply_preset(&text, &base, 1.0, None).unwrap();
        assert_eq!(
            one.settings.to_json(),
            whole.settings.to_json(),
            "{id} 100%"
        );
        // The report is the whole preset's at every amount.
        assert_eq!(zero.items, whole.items, "{id}");
        assert_eq!(zero.unsupported, whole.unsupported, "{id}");
        assert_eq!(zero.converted, whole.converted, "{id}");
        assert_eq!(one.to_value()["amount"], 1);
        assert!(whole.to_value().get("amount").is_none());
    }
}

#[test]
fn numbers_move_linearly_and_basic_sliders_stay_integers() {
    let base = edited_base();
    let half = apply(&numbers_preset(), &base, 0.5);
    assert!(close(half.exposure, 0.8), "{}", half.exposure);
    // (10 + 25) / 2 = 17.5: the basic sliders are integers (the converter
    // requires them, so another preset can be applied on this result).
    assert_eq!(half.contrast, 18.0);
    assert_eq!(half.vibrance, 10.0);
    assert!(close(half.parametric_darks, -4.0));
    let blue = half.hsl.get(HslBand::Blue).unwrap();
    assert_eq!(
        (blue.hue, blue.saturation, blue.luminance),
        (-10.0, 20.0, 2.0)
    );
    assert_eq!(half.calibration.red_hue, -2.0);
    let shadow = half.color_grading.shadow;
    assert_eq!(
        (shadow.hue, shadow.saturation, shadow.luminance),
        (0.0, 30.0, 10.0)
    );
    assert_eq!(half.color_grading.blending, 80.0);
    assert_eq!(half.color_grading.balance, -20.0);
    assert_eq!(half.gray_mixer.get(HslBand::Red), -10.0);
    assert_eq!(half.vignette.amount, -40.0);
    assert_eq!(half.grain.amount, 30.0);
    // Controls the preset does not carry do not move.
    assert_eq!(half.parametric_shadows, base.parametric_shadows);
    assert_eq!(half.tone_curves, base.tone_curves);
    assert!(half.validate().is_empty(), "{:?}", half.validate());
    // Applying another preset on a partial amount converts cleanly.
    let again = xmp::preset_settings(BUILTIN_PRESETS[0].xmp, Some(&half)).unwrap();
    assert!(again.converted, "{:?}", again.convert_issues);
}

#[test]
fn amounts_above_one_extrapolate_and_stop_at_the_ranges() {
    let base = DevelopSettings::neutral();
    let strong = preset(
        r#"crs:Exposure2012="+4" crs:Contrast2012="+80" crs:Saturation="-30" crs:ParametricShadowSplit="10"
        crs:HueAdjustmentRed="+90" crs:ColorGradeMidtoneHue="120" crs:ColorGradeMidtoneSat="80"
        crs:ColorGradeBlending="20" crs:PostCropVignetteAmount="-80" crs:GrainAmount="90""#,
        "",
    );
    let s = apply(&strong, &base, 1.5);
    assert_eq!(s.exposure, 5.0);
    assert_eq!(s.contrast, 100.0);
    assert_eq!(s.saturation, -45.0);
    assert_eq!(s.parametric_shadow_split, 2.5);
    assert_eq!(s.hsl.get(HslBand::Red).unwrap().hue, 100.0);
    assert_eq!(s.color_grading.midtone.saturation, 100.0);
    // The base midtone has no saturation: the preset's hue.
    assert_eq!(s.color_grading.midtone.hue, 120.0);
    assert_eq!(s.color_grading.blending, 0.0);
    assert_eq!(s.vignette.amount, -100.0);
    assert_eq!(s.grain.amount, 100.0);
    assert!(s.validate().is_empty(), "{:?}", s.validate());
}

/// niho-photo#39: the midtone / global luminance (rendered since then) move
/// with the amount like the other numbers, and stop at -100..100.
#[test]
fn midtone_and_global_luminance_follow_the_amount() {
    let mut base = edited_base();
    base.color_grading.midtone.luminance = 10.0;
    let text = preset(
        r#"crs:ColorGradeMidtoneLum="+50" crs:ColorGradeGlobalLum="-80""#,
        "",
    );
    for (amount, midtone, global) in [
        (0.0, 10.0, 0.0),
        (0.5, 30.0, -40.0),
        (1.0, 50.0, -80.0),
        (1.5, 70.0, -100.0),
    ] {
        let r = xmp::apply_preset(&text, &base, amount, None).unwrap();
        let g = &r.settings.color_grading;
        assert!(close(g.midtone.luminance, midtone), "{amount}: {g:?}");
        assert!(close(g.global.luminance, global), "{amount}: {g:?}");
        assert!(r.converted, "{amount}: {:?}", r.convert_issues);
        assert!(r.unsupported.is_empty(), "{amount}: {:?}", r.unsupported);
        assert!(r.settings.validate().is_empty(), "{amount}");
    }
}

#[test]
fn invalid_amounts_are_rejected() {
    let base = DevelopSettings::neutral();
    for amount in [-0.01, 1.51, f64::NAN, f64::INFINITY] {
        let err = xmp::apply_preset(&numbers_preset(), &base, amount, None).unwrap_err();
        assert!(matches!(err, XmpError::InvalidAmount(_)), "{amount}");
    }
    assert!(matches!(
        xmp::apply_preset("<a>", &base, 0.5, None),
        Err(XmpError::InvalidXml(_))
    ));
}

fn curve(s: &DevelopSettings, channel: CurveChannel) -> Option<&ToneCurve> {
    s.tone_curves.iter().find(|c| c.channel == channel)
}

fn eval(points: &[(f64, f64)], x: f64) -> f64 {
    DngSpline::new(points).unwrap().evaluate(x).clamp(0.0, 1.0)
}

#[test]
fn curves_blend_on_the_union_of_their_nodes() {
    let g = |v: u8| v as f64 / 255.0;
    // Base: a red curve (0 / 128 / 255) and no rgb curve. Preset: an rgb
    // curve, a red curve with other nodes, a linear green curve.
    let mut base = DevelopSettings::neutral();
    base.tone_curves = vec![ToneCurve {
        channel: CurveChannel::Red,
        points: vec![
            CurvePoint { x: 0.0, y: 0.0 },
            CurvePoint { x: g(64), y: g(50) },
            CurvePoint { x: 1.0, y: 1.0 },
        ],
    }];
    let text = preset(
        "",
        &[
            curve_element("ToneCurvePV2012", &[(0, 20), (128, 140), (255, 255)]),
            curve_element("ToneCurvePV2012Red", &[(0, 0), (192, 210), (255, 255)]),
            curve_element("ToneCurvePV2012Green", &[(0, 0), (255, 255)]),
        ]
        .concat(),
    );
    let half = apply(&text, &base, 0.5);
    // rgb: only the preset has a curve; the identity's nodes are 0 and 1.
    let rgb = curve(&half, CurveChannel::Rgb).unwrap();
    let preset_rgb = [(0.0, g(20)), (g(128), g(140)), (1.0, 1.0)];
    let xs: Vec<f64> = rgb.points.iter().map(|p| p.x).collect();
    assert_eq!(xs, vec![0.0, g(128), 1.0]);
    for p in &rgb.points {
        assert!(
            close(p.y, 0.5 * p.x + 0.5 * eval(&preset_rgb, p.x)),
            "{p:?}"
        );
    }
    assert!(close(rgb.points[0].y, g(10)));
    // red: both curves, evaluated at 0, 64, 192, 255.
    let red = curve(&half, CurveChannel::Red).unwrap();
    let base_red = [(0.0, 0.0), (g(64), g(50)), (1.0, 1.0)];
    let preset_red = [(0.0, 0.0), (g(192), g(210)), (1.0, 1.0)];
    let xs: Vec<f64> = red.points.iter().map(|p| p.x).collect();
    assert_eq!(xs, vec![0.0, g(64), g(192), 1.0]);
    for p in &red.points {
        let want = 0.5 * eval(&base_red, p.x) + 0.5 * eval(&preset_red, p.x);
        assert!(close(p.y, want), "{p:?} vs {want}");
    }
    // green: identity on both sides (no curve / a linear curve): none.
    assert!(curve(&half, CurveChannel::Green).is_none());
    assert!(curve(&half, CurveChannel::Blue).is_none());
    // 150%: the values stop at [0, 1].
    let strong = apply(&text, &base, 1.5);
    for c in &strong.tone_curves {
        assert!(c.points.iter().all(|p| (0.0..=1.0).contains(&p.y)));
    }
    assert!(strong.validate().is_empty());
    // A linear preset curve takes the base curve halfway to the identity.
    let linear = preset(
        "",
        &curve_element("ToneCurvePV2012Red", &[(0, 0), (255, 255)]),
    );
    let red = apply(&linear, &base, 0.5);
    let red = curve(&red, CurveChannel::Red).unwrap();
    assert!(close(red.points[1].y, 0.5 * g(64) + 0.5 * g(50)));
}

#[test]
fn color_grading_hues_take_the_short_arc() {
    let mut base = DevelopSettings::neutral();
    base.color_grading.shadow = ColorGradeBand {
        hue: 350.0,
        saturation: 20.0,
        luminance: 0.0,
    };
    base.color_grading.highlight = ColorGradeBand {
        hue: 200.0,
        saturation: 30.0,
        luminance: 0.0,
    };
    let text = preset(
        r#"crs:SplitToningShadowHue="10" crs:SplitToningShadowSaturation="40"
        crs:SplitToningHighlightHue="60" crs:SplitToningHighlightSaturation="0""#,
        "",
    );
    let at = |a: f64| apply(&text, &base, a).color_grading;
    assert_eq!(at(0.5).shadow.hue, 0.0);
    assert_eq!(at(0.25).shadow.hue, 355.0);
    assert_eq!(at(0.75).shadow.hue, 5.0);
    assert_eq!(at(1.5).shadow.hue, 20.0);
    // The preset's highlight has no saturation: the base's hue stays while
    // the saturation fades.
    assert_eq!(at(0.5).highlight.hue, 200.0);
    assert_eq!(at(0.5).highlight.saturation, 15.0);
    // 359 < h < 360 lands on the nearer of 359 and 0.
    let mut near = DevelopSettings::neutral();
    near.color_grading.global = ColorGradeBand {
        hue: 358.0,
        saturation: 10.0,
        luminance: 0.0,
    };
    let wrap = preset(
        r#"crs:ColorGradeGlobalHue="1" crs:ColorGradeGlobalSat="10""#,
        "",
    );
    // 358 + 0.5 * 3 = 359.5 -> 0; 358 + 0.4 * 3 = 359.2 -> 359.
    assert_eq!(apply(&wrap, &near, 0.5).color_grading.global.hue, 0.0);
    assert_eq!(apply(&wrap, &near, 0.4).color_grading.global.hue, 359.0);
}

fn absolute(temperature: f64, tint: f64) -> WhiteBalance {
    WhiteBalance {
        mode: WhiteBalanceMode::Absolute,
        temperature: Some(temperature),
        tint: Some(tint),
    }
}

fn white(s: &DevelopSettings) -> (WhiteBalanceMode, f64, f64) {
    let wb = s.white_balance;
    (
        wb.mode,
        wb.temperature.unwrap_or(f64::NAN),
        wb.tint.unwrap_or(f64::NAN),
    )
}

#[test]
fn an_absolute_white_moves_in_mireds_and_stops_at_the_preset() {
    let as_shot = Some(LightroomWhite {
        temperature: 6000.0,
        tint: 4.0,
    });
    let custom = preset(
        r#"crs:WhiteBalance="Custom" crs:Temperature="3000" crs:Tint="+20""#,
        "",
    );
    let shot = DevelopSettings::neutral();
    let with = |base: &DevelopSettings, text: &str, a: f64, w: Option<LightroomWhite>| {
        white(&xmp::apply_preset(text, base, a, w).unwrap().settings)
    };
    // As shot -> 3000 K: (1e6/6000 + 1e6/3000) / 2 = 250 mired = 4000 K.
    let (mode, k, tint) = with(&shot, &custom, 0.5, as_shot);
    assert_eq!(mode, WhiteBalanceMode::Absolute);
    assert!(close(k, 4000.0), "{k}");
    assert!(close(tint, 12.0));
    // No extrapolation past the preset's white.
    assert_eq!(
        with(&shot, &custom, 1.5, as_shot),
        (WhiteBalanceMode::Absolute, 3000.0, 20.0)
    );
    // Without the as-shot white (a JPEG / PNG): the preset's white.
    assert_eq!(
        with(&shot, &custom, 0.5, None),
        (WhiteBalanceMode::Absolute, 3000.0, 20.0)
    );
    // Absolute -> absolute: 5000 K -> 2500 K is 200 -> 400 mired.
    let mut warm = DevelopSettings::neutral();
    warm.white_balance = absolute(5000.0, 0.0);
    let cooler = preset(
        r#"crs:WhiteBalance="Custom" crs:Temperature="2500" crs:Tint="+10""#,
        "",
    );
    let (_, k, tint) = with(&warm, &cooler, 0.5, None);
    assert!(close(k, 1e6 / 300.0), "{k}");
    assert!(close(tint, 5.0));
    // Absolute -> "As Shot": toward the as-shot white, as shot at 100%.
    let mut custom_base = DevelopSettings::neutral();
    custom_base.white_balance = absolute(4000.0, 10.0);
    let as_shot_preset = preset(r#"crs:WhiteBalance="As Shot""#, "");
    let (mode, k, tint) = with(&custom_base, &as_shot_preset, 0.5, as_shot);
    assert_eq!(mode, WhiteBalanceMode::Absolute);
    assert!(close(k, 1e6 / ((250.0 + 1e6 / 6000.0) / 2.0)), "{k}");
    assert!(close(tint, 7.0));
    for a in [1.0, 1.5] {
        assert_eq!(
            with(&custom_base, &as_shot_preset, a, as_shot).0,
            WhiteBalanceMode::AsShot
        );
    }
    assert_eq!(
        with(&custom_base, &as_shot_preset, 0.5, None).0,
        WhiteBalanceMode::AsShot
    );
    // bluesky2's Custom without values is Lightroom's 5001 K / +10.
    let bluesky2 = BUILTIN_PRESETS[0].xmp;
    let (_, k, tint) = with(&shot, bluesky2, 0.5, as_shot);
    assert!(close(k, 1e6 / ((1e6 / 6000.0 + 1e6 / 5001.0) / 2.0)), "{k}");
    assert!(close(tint, 7.0));
}

#[test]
fn relative_values_move_linearly_and_keep_the_relative_mode() {
    let mut base = DevelopSettings::neutral();
    base.white_balance.mode = WhiteBalanceMode::Relative;
    base.relative_temperature = 20.0;
    base.relative_tint = -10.0;
    let custom = preset(
        r#"crs:WhiteBalance="Custom" crs:Temperature="3000" crs:Tint="+20""#,
        "",
    );
    // The whole preset keeps the relative values (they win over the
    // absolute white, which is kept), so they do not move.
    let half = apply(&custom, &base, 0.5);
    assert_eq!(half.white_balance.mode, WhiteBalanceMode::Relative);
    assert_eq!(
        (half.relative_temperature, half.relative_tint),
        (20.0, -10.0)
    );
    assert!(half.validate().is_empty(), "{:?}", half.validate());
}

#[test]
fn incremental_white_promotes_partial_preset_amounts_to_niho_2() {
    let base = DevelopSettings::neutral();
    let incremental = preset(
        r#"crs:WhiteBalance="Custom" crs:IncrementalTemperature="+30" crs:IncrementalTint="+20""#,
        "",
    );
    assert_eq!(apply(&incremental, &base, 0.0).engine, "niho-1");
    let half = apply(&incremental, &base, 0.5);
    assert_eq!(half.engine, "niho-2");
    assert_eq!(half.white_balance.mode, WhiteBalanceMode::Relative);
    assert_eq!(
        (half.relative_temperature, half.relative_tint),
        (15.0, 10.0)
    );
    assert!(half.validate().is_empty(), "{:?}", half.validate());
}

#[test]
fn effects_and_switches_follow_the_preset() {
    let mut base = DevelopSettings::neutral();
    base.grain.seed = Some(99.0);
    base.vignette.style = VignetteStyle::PaintOverlay;
    let whole = xmp::preset_settings(MONO_XMP, Some(&base))
        .unwrap()
        .settings;
    let half = apply(MONO_XMP, &base, 0.5);
    assert!(half.grayscale && whole.grayscale);
    for band in HslBand::ALL {
        assert!(close(
            half.gray_mixer.get(band),
            whole.gray_mixer.get(band) / 2.0
        ));
    }
    assert_eq!(half.vignette.amount, whole.vignette.amount / 2.0);
    assert_eq!(half.vignette.style, whole.vignette.style);
    assert_eq!(half.grain.amount, whole.grain.amount / 2.0);
    assert_eq!(half.grain.size, whole.grain.size);
    assert_eq!(half.grain.seed, whole.grain.seed);
    // A tiny amount already switches black & white on.
    assert!(apply(MONO_XMP, &base, 0.01).grayscale);
    let film = apply(FILM_XMP, &base, 0.5);
    assert!(!film.grayscale);
    assert!(film.validate().is_empty());
}

#[test]
fn the_look_base_and_unknown_keys_stay_the_photos() {
    let base = edited_base();
    for p in BUILTIN_PRESETS {
        let half = apply(p.xmp, &base, 0.5);
        assert_eq!(half.look, LOOK_NIHO_STANDARD_1, "{}", p.id);
        assert_eq!(half.base, base.base, "{}", p.id);
        assert_eq!(half.extra, base.extra, "{}", p.id);
        assert_eq!(half.engine, base.engine, "{}", p.id);
    }
}

#[test]
fn builtin_presets_at_every_amount_are_valid_and_reapplicable() {
    let as_shot = Some(LightroomWhite {
        temperature: 5600.0,
        tint: 2.0,
    });
    for base in [DevelopSettings::new_edit(), edited_base()] {
        for p in BUILTIN_PRESETS {
            let mut previous: Option<DevelopSettings> = None;
            for amount in [0.0, 0.5, 1.0, 1.5] {
                let r = xmp::apply_preset(p.xmp, &base, amount, as_shot).unwrap();
                let s = r.settings;
                assert!(r.converted, "{} {amount}", p.id);
                assert!(
                    s.validate().is_empty(),
                    "{} {amount}: {:?}",
                    p.id,
                    s.validate()
                );
                let again = xmp::preset_settings(BUILTIN_PRESETS[1].xmp, Some(&s)).unwrap();
                assert!(
                    again.converted,
                    "{} {amount}: {:?}",
                    p.id, again.convert_issues
                );
                // Every amount changes the photo further (the exposure moves
                // monotonically toward the preset's).
                if let Some(prev) = previous {
                    let whole = xmp::preset_settings(p.xmp, Some(&base)).unwrap().settings;
                    let toward = (whole.exposure - base.exposure).signum();
                    assert!(
                        (s.exposure - prev.exposure) * toward >= 0.0,
                        "{} {amount}",
                        p.id
                    );
                }
                previous = Some(s);
            }
        }
    }
}

#[test]
fn a_preset_never_carries_or_drops_the_crop() {
    // F3 geometry (v 2): a preset patches color settings only, at any amount,
    // and saving settings as a preset leaves the crop out.
    let base = DevelopSettings::from_json(
        r#"{"v":2,"geometry":{"rotate":90,"crop":{"left":0.1,"top":0,"right":0.9,"bottom":1}},"exposure":0.3}"#,
    )
    .unwrap();
    for amount in [0.0, 0.5, 1.0, 1.5] {
        for p in BUILTIN_PRESETS {
            let s = apply(p.xmp, &base, amount);
            assert_eq!(s.geometry, base.geometry, "{} at {amount}", p.id);
            assert_eq!(s.v, base.v, "{} at {amount}", p.id);
            assert!(
                s.validate().is_empty(),
                "{} at {amount}: {:?}",
                p.id,
                s.validate()
            );
        }
    }
    let written = xmp::settings_to_xmp(&base, &xmp::XmpWriteOptions::default());
    assert!(
        !written.xmp.contains("crs:Crop") && !written.xmp.contains("crs:HasCrop"),
        "{}",
        written.xmp
    );
}
