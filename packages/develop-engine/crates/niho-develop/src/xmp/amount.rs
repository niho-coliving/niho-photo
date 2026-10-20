//! A preset's amount (Lightroom's "Amount" slider, 0..150%, Issue #17121
//! F2a): settings between the photo's own (`base`, 0%) and the whole preset
//! applied on them ([`preset_settings`], 100%), extrapolated above 100%.
//!
//! - Numbers move linearly from `base` to the preset and stop at their
//!   `validate` ranges; the ten basic sliders are rounded to integers (the
//!   converter requires them, so a preset can be applied again on the
//!   result, and Lightroom's sliders are integers too).
//! - Point curves are interpolated per channel on the union of both curves'
//!   nodes, each curve evaluated like the renderer (DNG spline; a channel
//!   without a curve is the identity).
//! - Color grading hues take the short way around the wheel.
//! - Switches (`grayscale`, `vignette.style`, `grain.seed`) are the
//!   preset's above 0%.
//! - An absolute white balance moves in mireds (1e6 / K) from the photo's
//!   white (its own absolute white, else the as-shot white on Lightroom's
//!   scale) and stops at the preset's (no extrapolation).
//! - `look`, `base` and unknown keys stay the photo's. `engine` also stays,
//!   except a non-zero incremental-WB preset promotes it to `niho-2`.

use super::{preset_settings, EffectField, PresetResult, XmpError, EFFECT_KEYS, SCALAR_KEYS};
use crate::decode::LightroomWhite;
use crate::settings::{
    ColorGradeBand, ColorPoint, CurveChannel, CurvePoint, DevelopSettings, HslAdjustment,
    HslAdjustments, HslBand, OklchDelta, OklchRange, OklchTarget, ToneCurve, WhiteBalance,
    WhiteBalanceMode, ABSOLUTE_TEMPERATURE_RANGE, ABSOLUTE_TINT_RANGE, ENGINE_NIHO_2,
};
use crate::tone_ops::{normalized_points, DngSpline};

/// The largest preset amount (150%).
pub const PRESET_AMOUNT_MAX: f64 = 1.5;

/// Applies `xmp` on `base` at `amount` (0..=1.5; 0 returns `base`
/// unchanged, 1 exactly [`preset_settings`]). `as_shot` is the photo's
/// as-shot white on Lightroom's scale
/// ([`crate::WorkingCopyMeta::lightroom_as_shot_white`]); without it (a
/// JPEG / PNG, which renders no absolute white balance) an absolute white is
/// the preset's at any amount above 0. The report (`items`, `unsupported`,
/// `converted`, ...) is the whole preset's; [`PresetResult::amount`] is set.
pub fn apply_preset(
    xmp: &str,
    base: &DevelopSettings,
    amount: f64,
    as_shot: Option<LightroomWhite>,
) -> Result<PresetResult, XmpError> {
    if !amount.is_finite() || !(0.0..=PRESET_AMOUNT_MAX).contains(&amount) {
        return Err(XmpError::InvalidAmount(amount));
    }
    let mut result = preset_settings(xmp, Some(base))?;
    result.amount = Some(amount);
    if amount == 0.0 {
        result.settings = base.clone();
    } else if amount != 1.0 {
        result.settings = blend(base, &result.settings, amount, as_shot);
    }
    Ok(result)
}

/// `b` -> `f` at `t` (exactly `b` at 0 or when equal, exactly `f` at 1).
fn mix(b: f64, f: f64, t: f64) -> f64 {
    if b == f || t == 0.0 {
        b
    } else if t == 1.0 {
        f
    } else {
        (1.0 - t) * b + t * f
    }
}

/// [`mix`] stopped at `range` (a value that does not move is kept as is).
fn mix_in(b: f64, f: f64, t: f64, range: (f64, f64)) -> f64 {
    if b == f {
        b
    } else {
        mix(b, f, t).clamp(range.0, range.1)
    }
}

fn blend(
    base: &DevelopSettings,
    full: &DevelopSettings,
    t: f64,
    as_shot: Option<LightroomWhite>,
) -> DevelopSettings {
    // The preset's switches and `legacySettings`; the photo's identity.
    let mut r = full.clone();
    r.v = base.v;
    r.engine =
        if full.engine == ENGINE_NIHO_2 && full.white_balance.mode == WhiteBalanceMode::Relative {
            full.engine.clone()
        } else {
            base.engine.clone()
        };
    r.look = base.look.clone();
    r.base = base.base.clone();
    r.extra = base.extra.clone();
    for key in &SCALAR_KEYS {
        if key.field.is_grade_hue() {
            continue;
        }
        let (b, f) = (key.field.value(base), key.field.value(full));
        let mut v = mix_in(b, f, t, key.range);
        if b != f && key.field.is_integer_slider() {
            v = libm::round(v);
        }
        *key.field.value_mut(&mut r) = v;
    }
    let (bg, fg) = (&base.color_grading, &full.color_grading);
    let g = &mut r.color_grading;
    g.shadow.hue = mix_hue(&bg.shadow, &fg.shadow, t);
    g.midtone.hue = mix_hue(&bg.midtone, &fg.midtone, t);
    g.highlight.hue = mix_hue(&bg.highlight, &fg.highlight, t);
    g.global.hue = mix_hue(&bg.global, &fg.global, t);
    r.hsl = mix_hsl(&base.hsl, &full.hsl, t);
    r.color_points = mix_color_points(&base.color_points, &full.color_points, t);
    r.color_noise_reduction = mix_in(
        base.color_noise_reduction,
        full.color_noise_reduction,
        t,
        (0.0, 100.0),
    );
    r.color_noise_reduction_detail = mix_in(
        base.color_noise_reduction_detail,
        full.color_noise_reduction_detail,
        t,
        (0.0, 100.0),
    );
    r.color_noise_reduction_smoothness = mix_in(
        base.color_noise_reduction_smoothness,
        full.color_noise_reduction_smoothness,
        t,
        (0.0, 100.0),
    );
    for key in EFFECT_KEYS {
        let field = key.field;
        // Grayscale and the style have no range; the seed is a switch.
        let Some(range) = field.range() else {
            continue;
        };
        if field == EffectField::GrainSeed {
            continue;
        }
        if let (Some(b), Some(f)) = (field.value(base), field.value(full)) {
            field.set(&mut r, mix_in(b, f, t, range));
        }
    }
    r.tone_curves = mix_curves(&base.tone_curves, &full.tone_curves, t);
    mix_white_balance(base, full, t, as_shot, &mut r);
    // The blended result may turn on an effect even when the photo's base
    // used the legacy shape version. Keep the version contract in sync with
    // the actual settings rather than carrying the base version through.
    r.v = r.required_version();
    r
}

/// A color grading wheel angle: the short arc from the photo's hue to the
/// preset's (extrapolated along it), in 0..=359. A band without saturation
/// on one side takes the other side's hue.
fn mix_hue(b: &ColorGradeBand, f: &ColorGradeBand, t: f64) -> f64 {
    if b.hue == f.hue {
        return b.hue;
    }
    if b.saturation == 0.0 {
        return f.hue;
    }
    if f.saturation == 0.0 {
        return b.hue;
    }
    let mut d = (f.hue - b.hue).rem_euclid(360.0);
    if d > 180.0 {
        d -= 360.0;
    }
    let h = (b.hue + t * d).rem_euclid(360.0);
    // 359 < h < 360 is closer to 359 or to 0 on the wheel.
    if h >= 359.5 {
        0.0
    } else {
        h.min(359.0)
    }
}

fn mix_hsl(base: &HslAdjustments, full: &HslAdjustments, t: f64) -> HslAdjustments {
    let range = (-100.0, 100.0);
    let mut out = HslAdjustments::default();
    for band in HslBand::ALL {
        let (b, f) = (base.get(band), full.get(band));
        if b.is_none() && f.is_none() {
            continue;
        }
        let (bv, fv) = (b.unwrap_or_default(), f.unwrap_or_default());
        let a = HslAdjustment {
            hue: mix_in(bv.hue, fv.hue, t, range),
            saturation: mix_in(bv.saturation, fv.saturation, t, range),
            luminance: mix_in(bv.luminance, fv.luminance, t, range),
        };
        if !a.is_zero() || (b.is_some() && f.is_some()) {
            out.set(band, a);
        }
    }
    out
}

fn mix_angle(b: f64, f: f64, t: f64) -> f64 {
    let mut delta = (f - b).rem_euclid(360.0);
    if delta > 180.0 {
        delta -= 360.0;
    }
    (b + t * delta).rem_euclid(360.0)
}

/// NIHO points are not Adobe PointColors. XMP application currently keeps
/// them, while this interpolation also defines the amount contract for a
/// future NIHO-native preset carrier: match by id, move every numeric field
/// linearly, and take the shortest arc for target hue.
fn mix_color_points(base: &[ColorPoint], full: &[ColorPoint], t: f64) -> Vec<ColorPoint> {
    let mut out = Vec::with_capacity(base.len().max(full.len()));
    for point in full {
        if let Some(before) = base.iter().find(|candidate| candidate.id == point.id) {
            out.push(ColorPoint {
                id: point.id.clone(),
                target: OklchTarget {
                    lightness: mix_in(
                        before.target.lightness,
                        point.target.lightness,
                        t,
                        (0.0, 1.0),
                    ),
                    chroma: mix_in(before.target.chroma, point.target.chroma, t, (0.0, 5.0)),
                    hue: mix_angle(before.target.hue, point.target.hue, t),
                },
                range: OklchRange {
                    hue: mix_in(before.range.hue, point.range.hue, t, (1.0, 180.0)),
                    chroma: mix_in(before.range.chroma, point.range.chroma, t, (0.001, 5.0)),
                    lightness: mix_in(
                        before.range.lightness,
                        point.range.lightness,
                        t,
                        (0.001, 1.0),
                    ),
                },
                delta: OklchDelta {
                    hue: mix_in(before.delta.hue, point.delta.hue, t, (-180.0, 180.0)),
                    chroma_scale: mix_in(
                        before.delta.chroma_scale,
                        point.delta.chroma_scale,
                        t,
                        (0.0, 3.0),
                    ),
                    lightness: mix_in(
                        before.delta.lightness,
                        point.delta.lightness,
                        t,
                        (-1.0, 1.0),
                    ),
                },
            });
        } else if t > 0.0 {
            let mut added = point.clone();
            added.delta.hue = (t * point.delta.hue).clamp(-180.0, 180.0);
            added.delta.chroma_scale = mix(1.0, point.delta.chroma_scale, t).clamp(0.0, 3.0);
            added.delta.lightness = (t * point.delta.lightness).clamp(-1.0, 1.0);
            out.push(added);
        }
    }
    for point in base {
        if !full.iter().any(|candidate| candidate.id == point.id) && t < 1.0 {
            let mut removed = point.clone();
            removed.delta.hue = mix(point.delta.hue, 0.0, t);
            removed.delta.chroma_scale = mix(point.delta.chroma_scale, 1.0, t);
            removed.delta.lightness = mix(point.delta.lightness, 0.0, t);
            out.push(removed);
        }
    }
    out
}

const CURVE_CHANNELS: [CurveChannel; 4] = [
    CurveChannel::Rgb,
    CurveChannel::Red,
    CurveChannel::Green,
    CurveChannel::Blue,
];

/// Curves a channel renders with: its normalized points (at least two), or
/// `None` for the identity.
fn rendered_points(curves: &[ToneCurve], channel: CurveChannel) -> Option<Vec<CurvePoint>> {
    let curve = curves.iter().find(|c| c.channel == channel)?;
    let points = normalized_points(curve);
    (points.len() >= 2).then_some(points)
}

/// Evaluates a channel's curve like `tone_ops::PreparedPointCurve`.
struct ChannelCurve(Option<DngSpline>);

impl ChannelCurve {
    fn new(points: Option<&[CurvePoint]>) -> Self {
        Self(points.and_then(|p| {
            let pairs: Vec<(f64, f64)> = p.iter().map(|p| (p.x, p.y)).collect();
            DngSpline::new(&pairs)
        }))
    }

    fn eval(&self, x: f64) -> f64 {
        match &self.0 {
            Some(spline) => spline.evaluate(x).clamp(0.0, 1.0),
            None => x,
        }
    }
}

/// Per channel: the photo's curve when the preset renders the same one;
/// otherwise both curves evaluated on the union of their nodes (the
/// identity's are 0 and 1) and the values interpolated, stopped at [0, 1].
/// A result that is the identity has no curve.
fn mix_curves(base: &[ToneCurve], full: &[ToneCurve], t: f64) -> Vec<ToneCurve> {
    const SAME_X: f64 = 0.000_001;
    let identity = [CurvePoint { x: 0.0, y: 0.0 }, CurvePoint { x: 1.0, y: 1.0 }];
    let mut out = Vec::new();
    for channel in CURVE_CHANNELS {
        let (b, f) = (
            rendered_points(base, channel),
            rendered_points(full, channel),
        );
        if b == f {
            if let Some(curve) = base.iter().find(|c| c.channel == channel) {
                out.push(curve.clone());
            }
            continue;
        }
        let (bp, fp) = (
            b.as_deref().unwrap_or(&identity),
            f.as_deref().unwrap_or(&identity),
        );
        let mut xs: Vec<f64> = bp.iter().chain(fp).map(|p| p.x).collect();
        xs.sort_by(f64::total_cmp);
        xs.dedup_by(|later, kept| (*later - *kept).abs() < SAME_X);
        let (cb, cf) = (
            ChannelCurve::new(b.as_deref()),
            ChannelCurve::new(f.as_deref()),
        );
        let points: Vec<CurvePoint> = xs
            .into_iter()
            .map(|x| CurvePoint {
                x,
                y: mix(cb.eval(x), cf.eval(x), t).clamp(0.0, 1.0),
            })
            .collect();
        if points.iter().any(|p| (p.y - p.x).abs() > 1e-9) {
            out.push(ToneCurve { channel, points });
        }
    }
    out.sort_by(|a, b| a.channel.as_str().cmp(b.channel.as_str()));
    out
}

/// Kelvin between two whites, linear in mireds (1e6 / K).
fn mix_kelvin(k0: f64, k1: f64, t: f64) -> f64 {
    if k0 == k1 || t == 0.0 {
        return k0;
    }
    if t == 1.0 {
        return k1;
    }
    let mired = (1.0 - t) * (1e6 / k0) + t * (1e6 / k1);
    (1e6 / mired).clamp(ABSOLUTE_TEMPERATURE_RANGE.0, ABSOLUTE_TEMPERATURE_RANGE.1)
}

fn absolute_between(from: LightroomWhite, to: LightroomWhite, t: f64) -> WhiteBalance {
    WhiteBalance {
        mode: WhiteBalanceMode::Absolute,
        temperature: Some(mix_kelvin(from.temperature, to.temperature, t)),
        tint: Some(mix(from.tint, to.tint, t).clamp(ABSOLUTE_TINT_RANGE.0, ABSOLUTE_TINT_RANGE.1)),
    }
}

fn absolute_white(wb: &WhiteBalance) -> Option<LightroomWhite> {
    match (wb.mode, wb.temperature, wb.tint) {
        (WhiteBalanceMode::Absolute, Some(temperature), Some(tint)) => {
            Some(LightroomWhite { temperature, tint })
        }
        _ => None,
    }
}

fn mix_white_balance(
    base: &DevelopSettings,
    full: &DevelopSettings,
    t: f64,
    as_shot: Option<LightroomWhite>,
    r: &mut DevelopSettings,
) {
    let (bw, fw) = (&base.white_balance, &full.white_balance);
    if bw == fw
        && base.relative_temperature == full.relative_temperature
        && base.relative_tint == full.relative_tint
    {
        r.white_balance = *bw;
        r.relative_temperature = base.relative_temperature;
        r.relative_tint = base.relative_tint;
        return;
    }
    if bw.mode == WhiteBalanceMode::Relative || fw.mode == WhiteBalanceMode::Relative {
        // Non-RAW relative values: linear (0 on a side without them). The
        // mode is the preset's unless relative values remain, which need
        // `relative` (the absolute values stay as kept values).
        let range = (-100.0, 100.0);
        r.relative_temperature = mix_in(
            base.relative_temperature,
            full.relative_temperature,
            t,
            range,
        );
        r.relative_tint = mix_in(base.relative_tint, full.relative_tint, t, range);
        r.white_balance = *fw;
        if r.relative_temperature != 0.0 || r.relative_tint != 0.0 {
            r.white_balance.mode = WhiteBalanceMode::Relative;
        }
        return;
    }
    // An absolute white stops at the preset's (no extrapolation).
    let t = t.min(1.0);
    r.white_balance = match (absolute_white(bw), absolute_white(fw), fw.mode) {
        (Some(from), Some(to), _) => absolute_between(from, to, t),
        (None, Some(to), _) if bw.mode == WhiteBalanceMode::AsShot => match as_shot {
            Some(from) => absolute_between(from, to, t),
            None => *fw,
        },
        (Some(from), None, WhiteBalanceMode::AsShot) if t < 1.0 => match as_shot {
            Some(to) => absolute_between(from, to, t),
            None => *fw,
        },
        _ => *fw,
    };
}

#[cfg(test)]
mod color_point_tests {
    use super::*;

    fn point(id: &str, hue: f64, delta_hue: f64) -> ColorPoint {
        ColorPoint {
            id: id.into(),
            target: OklchTarget {
                lightness: 0.7,
                chroma: 0.1,
                hue,
            },
            range: OklchRange {
                hue: 20.0,
                chroma: 0.05,
                lightness: 0.1,
            },
            delta: OklchDelta {
                hue: delta_hue,
                chroma_scale: 1.5,
                lightness: 0.1,
            },
        }
    }

    #[test]
    fn color_points_amount_is_linear_and_target_hue_takes_short_arc() {
        let mut base = vec![point("skin", 350.0, 0.0)];
        base[0].delta.chroma_scale = 1.0;
        base[0].delta.lightness = 0.0;
        let full = vec![point("skin", 10.0, 20.0)];
        assert_eq!(mix_color_points(&base, &full, 0.0), base);
        assert_eq!(mix_color_points(&base, &full, 1.0), full);
        let half = mix_color_points(&base, &full, 0.5);
        assert_eq!(half[0].target.hue, 0.0);
        assert_eq!(half[0].delta.hue, 10.0);
        assert_eq!(half[0].delta.chroma_scale, 1.25);
        assert_eq!(half[0].delta.lightness, 0.05);

        let added = mix_color_points(&[], &[point("sky", 250.0, -10.0)], 0.5);
        assert_eq!(added[0].delta.hue, -5.0);
        assert_eq!(added[0].delta.chroma_scale, 1.25);
        assert_eq!(added[0].delta.lightness, 0.05);

        let removed = mix_color_points(&[point("skin", 50.0, 20.0)], &[], 0.5);
        assert_eq!(removed[0].delta.hue, 10.0);
        assert_eq!(removed[0].delta.chroma_scale, 1.25);
        assert_eq!(removed[0].delta.lightness, 0.05);
        assert!(mix_color_points(&[point("skin", 50.0, 20.0)], &[], 1.0).is_empty());
    }
}
