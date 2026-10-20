//! NIHO standard look (`developSettings.look`, spec "段 2", S8 #16947): one
//! step after exposure / local tone and before the ACR3 default curve, on
//! linear ProPhoto clamped to `[0, 1]` (the input of the cube that holds
//! "look -> ACR3").
//!
//! - `niho-interim-1`: identity (S5 photos keep it; never changes).
//! - `niho-standard-1`: an HSV adjustment per hue (hue shift, saturation and
//!   value scales at two saturation nodes) before ACR3, and a hue-preserving
//!   tone curve at the end of cube P (after the user's point curve and RGB
//!   channel curves, on sRGB-encoded values like the point curve). Measured
//!   on the three bundled presets, this order is the closest to Lightroom's
//!   Adobe Color, which adds its tone at the point-curve stage (before ACR3
//!   put bluesky2's Blacks +90 on top of the look's darker shadows: 3.50 vs
//!   3.17 mean ΔE00). The coefficients are NIHO's own,
//!   fitted to Lightroom exports rendered with Adobe Color
//!   (`tools/calibrate/fit_look.py`); no Adobe table or profile values are
//!   read or copied.
//!
//! The formula is the one of `tools/calibrate/look.py` (its docstring is the
//! source of truth): hexcone HSV, periodic Catmull-Rom across hue nodes,
//! linear across the saturation nodes `[S1, 1]` from zero at `s = 0`,
//! `h' = h + dh/60`, `s' = min(s e^ls, 1)`, `v' = v e^lv`; the tone is a
//! monotone cubic Hermite (Fritsch-Carlson) through `tone.x -> tone.y` in
//! `tone.space`, applied with `RGBTone` at `tone.stage` (`point-curve` on
//! sRGB-encoded values, or `pre-acr3` in the `x^(1/2.2)` domain right after
//! the HSV step).

use crate::tone_ops::{encoded_curve, rgb_tone};
use serde_json::Value;
use std::sync::OnceLock;

type Rgb = [f64; 3];

/// Interim look: identity before the ACR3 default curve (S5 photos).
pub const LOOK_NIHO_INTERIM_1: &str = "niho-interim-1";
/// NIHO standard look, version 1 (S8).
pub const LOOK_NIHO_STANDARD_1: &str = "niho-standard-1";
/// NIHO 3 R236 look: interim-1 RAW base tone plus the R218 profile residual
/// before Vibrance / Saturation / HSL.
pub const LOOK_NIHO_STANDARD_2: &str = "niho-standard-2";
/// NIHO 4 R372 camera-scoped response with the unchanged NIHO 3 tail.
pub const LOOK_NIHO_STANDARD_3: &str = "niho-standard-3";
/// NIHO 5 RAW highlight recovery; the R395 tail stays unchanged.
pub const LOOK_NIHO_STANDARD_4: &str = "niho-standard-4";
/// NIHO 7 signed-RAW highlight response; the NIHO 5 palette/tone is unchanged.
pub const LOOK_NIHO_STANDARD_5: &str = "niho-standard-5";
/// Every look version this crate renders (old versions never change).
pub const LOOKS: [&str; 6] = [
    LOOK_NIHO_INTERIM_1,
    LOOK_NIHO_STANDARD_1,
    LOOK_NIHO_STANDARD_2,
    LOOK_NIHO_STANDARD_3,
    LOOK_NIHO_STANDARD_4,
    LOOK_NIHO_STANDARD_5,
];

const TONE_GAMMA: f64 = 2.2;

/// Fitted coefficients of `niho-standard-1` (`niho-develop-look/v1`).
const STANDARD_1_JSON: &str = include_str!("../looks/niho-standard-1.json");

/// Whether `look` names a version this crate renders.
pub fn is_known(look: &str) -> bool {
    LOOKS.contains(&look)
}

/// Where the look's tone curve is applied.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ToneStage {
    /// Right after the HSV step, before ACR3 (`x^(1/2.2)` domain).
    PreAcr3,
    /// Last in cube P, after the user's point curve and RGB channel curves
    /// (sRGB-encoded values, like the point curve).
    PointCurve,
}

#[derive(Debug, Clone)]
pub struct LookParams {
    /// `[hue node][saturation node] = [dh (degrees), ln sat scale, ln value scale]`.
    hsv: Vec<[[f64; 3]; 2]>,
    sat_node: f64,
    tone_stage: ToneStage,
    tone_x: Vec<f64>,
    tone_y: Vec<f64>,
    tone_m: Vec<f64>,
}

impl LookParams {
    /// Parses `niho-develop-look/v1`.
    pub fn from_json(text: &str) -> Result<Self, String> {
        let v: Value = serde_json::from_str(text).map_err(|e| e.to_string())?;
        if v["schema"] != "niho-develop-look/v1" {
            return Err("schema must be niho-develop-look/v1".into());
        }
        let num = |x: &Value| x.as_f64().ok_or_else(|| "number expected".to_string());
        let hsv = v["hsv"]
            .as_array()
            .ok_or("hsv")?
            .iter()
            .map(|hue| -> Result<[[f64; 3]; 2], String> {
                let nodes = hue.as_array().ok_or("hsv node")?;
                if nodes.len() != 2 {
                    return Err("two saturation nodes expected".into());
                }
                let mut out = [[0.0; 3]; 2];
                for (i, n) in nodes.iter().enumerate() {
                    let a = n.as_array().ok_or("hsv values")?;
                    if a.len() != 3 {
                        return Err("[dh, ls, lv] expected".into());
                    }
                    for k in 0..3 {
                        out[i][k] = num(&a[k])?;
                    }
                }
                Ok(out)
            })
            .collect::<Result<Vec<_>, _>>()?;
        let sat = v["satNodes"].as_array().ok_or("satNodes")?;
        let sat_node = num(&sat[0])?;
        if hsv.len() < 3 || !(sat_node > 0.0 && sat_node < 1.0) || num(&sat[1])? != 1.0 {
            return Err("hueNodes >= 3 and satNodes = [S1 in (0, 1), 1] expected".into());
        }
        let list = |key: &str| -> Result<Vec<f64>, String> {
            v["tone"][key]
                .as_array()
                .ok_or(format!("tone.{key}"))?
                .iter()
                .map(num)
                .collect()
        };
        let (tone_x, tone_y) = (list("x")?, list("y")?);
        if tone_x.len() < 2
            || tone_x.len() != tone_y.len()
            || tone_x.windows(2).any(|w| w[1] <= w[0])
            || tone_y.windows(2).any(|w| w[1] < w[0])
        {
            return Err("tone.x must increase and tone.y must not decrease".into());
        }
        let tone_stage =
            match (
                v["tone"]["stage"].as_str().unwrap_or("pre-acr3"),
                v["tone"]["space"].as_str(),
            ) {
                ("pre-acr3", None | Some("gamma2.2")) => ToneStage::PreAcr3,
                ("point-curve", Some("srgb-encoded")) => ToneStage::PointCurve,
                _ => return Err(
                    "tone.stage / tone.space: pre-acr3 + gamma2.2 or point-curve + srgb-encoded"
                        .into(),
                ),
            };
        let tone_m = monotone_tangents(&tone_x, &tone_y);
        Ok(Self {
            hsv,
            sat_node,
            tone_stage,
            tone_x,
            tone_y,
            tone_m,
        })
    }

    pub fn tone_stage(&self) -> ToneStage {
        self.tone_stage
    }

    /// The tone curve itself, in `tone.space` (clamped to `[0, 1]`).
    pub fn curve(&self, u: f64) -> f64 {
        hermite(&self.tone_x, &self.tone_y, &self.tone_m, u.clamp(0.0, 1.0)).clamp(0.0, 1.0)
    }

    /// `pre-acr3` tone curve on a linear value (clamped to `[0, 1]`).
    fn tone(&self, x: f64) -> f64 {
        self.curve(x.clamp(0.0, 1.0).powf(1.0 / TONE_GAMMA))
            .powf(TONE_GAMMA)
    }

    /// `(dh degrees, ls, lv)` at hue `h` in `[0, 6)` and saturation `s`.
    fn adjustments(&self, h: f64, s: f64) -> Rgb {
        let n = self.hsv.len();
        let t = h * (n as f64 / 6.0);
        let i = t.floor();
        let u = t - i;
        let i = i as isize;
        let at = |k: isize, sat: usize| self.hsv[k.rem_euclid(n as isize) as usize][sat];
        let cr = |sat: usize| -> Rgb {
            let (p0, p1, p2, p3) = (at(i - 1, sat), at(i, sat), at(i + 1, sat), at(i + 2, sat));
            let mut out = [0.0; 3];
            for k in 0..3 {
                out[k] = 0.5
                    * (2.0 * p1[k]
                        + (p2[k] - p0[k]) * u
                        + (2.0 * p0[k] - 5.0 * p1[k] + 4.0 * p2[k] - p3[k]) * u * u
                        + (3.0 * p1[k] - p0[k] - 3.0 * p2[k] + p3[k]) * u * u * u);
            }
            out
        };
        let (low, high) = (cr(0), cr(1));
        let s1 = self.sat_node;
        if s <= s1 {
            let a = (s / s1).clamp(0.0, 1.0);
            [a * low[0], a * low[1], a * low[2]]
        } else {
            let b = ((s - s1) / (1.0 - s1)).clamp(0.0, 1.0);
            [
                low[0] + b * (high[0] - low[0]),
                low[1] + b * (high[1] - low[1]),
                low[2] + b * (high[2] - low[2]),
            ]
        }
    }

    /// The part before ACR3, on linear ProPhoto (each channel clamped to
    /// `[0, 1]` first): the HSV step, plus the tone when it is `pre-acr3`.
    pub fn pre_acr3(&self, rgb: Rgb) -> Rgb {
        let x = [
            rgb[0].clamp(0.0, 1.0),
            rgb[1].clamp(0.0, 1.0),
            rgb[2].clamp(0.0, 1.0),
        ];
        let (h, s, v) = rgb_to_hsv(x);
        let adj = self.adjustments(h, s);
        let h2 = h + adj[0] / 60.0;
        let s2 = (s * libm::exp(adj[1])).min(1.0);
        let v2 = v * libm::exp(adj[2]);
        let y = hsv_to_rgb(h2, s2, v2);
        match self.tone_stage {
            ToneStage::PreAcr3 => rgb_tone(y, &|t| self.tone(t)),
            ToneStage::PointCurve => y,
        }
    }

    /// The `point-curve` tone on linear ProPhoto (identity for `pre-acr3`),
    /// exactly as the point curve applies a curve (`encoded_curve`). Cube P
    /// samples [`LookParams::curve`] instead (see `tone_ops`).
    pub fn point_curve(&self, rgb: Rgb) -> Rgb {
        match self.tone_stage {
            ToneStage::PointCurve => encoded_curve(rgb, &|u| self.curve(u)),
            ToneStage::PreAcr3 => rgb,
        }
    }
}

/// The fitted `niho-standard-1` (parsed once).
pub fn standard_1() -> &'static LookParams {
    static P: OnceLock<LookParams> = OnceLock::new();
    P.get_or_init(|| LookParams::from_json(STANDARD_1_JSON).expect("looks/niho-standard-1.json"))
}

/// The look for a version (`None` = identity). Unknown versions are rejected
/// when the settings are parsed, so they never reach here.
pub fn params(look: &str) -> Option<&'static LookParams> {
    (look == LOOK_NIHO_STANDARD_1).then(standard_1)
}

/// Hexcone HSV (`h` in `[0, 6)`, 0 = red).
fn rgb_to_hsv(rgb: Rgb) -> (f64, f64, f64) {
    let [r, g, b] = rgb;
    let v = r.max(g).max(b);
    let c = v - r.min(g).min(b);
    let s = if v > 0.0 { c / v } else { 0.0 };
    if c <= 0.0 {
        return (0.0, s, v);
    }
    let h = if v == r {
        (g - b) / c
    } else if v == g {
        2.0 + (b - r) / c
    } else {
        4.0 + (r - g) / c
    };
    (h.rem_euclid(6.0), s, v)
}

fn hsv_to_rgb(h: f64, s: f64, v: f64) -> Rgb {
    let h = h.rem_euclid(6.0);
    let i = h.floor();
    let f = h - i;
    let p = v * (1.0 - s);
    let q = v * (1.0 - s * f);
    let t = v * (1.0 - s * (1.0 - f));
    match (i as i64).rem_euclid(6) {
        0 => [v, t, p],
        1 => [q, v, p],
        2 => [p, v, t],
        3 => [p, q, v],
        4 => [t, p, v],
        _ => [v, p, q],
    }
}

/// Fritsch-Carlson tangents (keep monotone segments monotone).
fn monotone_tangents(x: &[f64], y: &[f64]) -> Vec<f64> {
    let n = x.len();
    let d: Vec<f64> = (0..n - 1)
        .map(|k| (y[k + 1] - y[k]) / (x[k + 1] - x[k]))
        .collect();
    let mut m = vec![0.0; n];
    m[0] = d[0];
    m[n - 1] = d[n - 2];
    for k in 1..n - 1 {
        m[k] = if d[k - 1] * d[k] > 0.0 {
            (d[k - 1] + d[k]) / 2.0
        } else {
            0.0
        };
    }
    for k in 0..n - 1 {
        if d[k] == 0.0 {
            m[k] = 0.0;
            m[k + 1] = 0.0;
            continue;
        }
        let (a, b) = (m[k] / d[k], m[k + 1] / d[k]);
        let r = a * a + b * b;
        if r > 9.0 {
            let tau = 3.0 / r.sqrt();
            m[k] = tau * a * d[k];
            m[k + 1] = tau * b * d[k];
        }
    }
    m
}

fn hermite(x: &[f64], y: &[f64], m: &[f64], q: f64) -> f64 {
    let n = x.len();
    let q = q.clamp(x[0], x[n - 1]);
    // the segment k with x[k] <= q < x[k + 1] (the last one at q = x[n - 1])
    let k = x[1..n - 1].iter().take_while(|&&xi| xi <= q).count();
    let h = x[k + 1] - x[k];
    let t = (q - x[k]) / h;
    let (t2, t3) = (t * t, t * t * t);
    (2.0 * t3 - 3.0 * t2 + 1.0) * y[k]
        + (t3 - 2.0 * t2 + t) * h * m[k]
        + (-2.0 * t3 + 3.0 * t2) * y[k + 1]
        + (t3 - t2) * h * m[k + 1]
}

#[cfg(test)]
mod tests {
    use super::*;

    fn identity_json() -> String {
        let hsv: Vec<String> = (0..12).map(|_| "[[0,0,0],[0,0,0]]".to_string()).collect();
        format!(
            r#"{{"schema":"niho-develop-look/v1","look":"t","hueNodes":12,"satNodes":[0.3,1.0],"hsv":[{}],"tone":{{"space":"gamma2.2","x":[0,0.5,1],"y":[0,0.5,1]}}}}"#,
            hsv.join(",")
        )
    }

    #[test]
    fn identity_coefficients_are_the_identity() {
        let p = LookParams::from_json(&identity_json()).unwrap();
        for rgb in [
            [0.0, 0.0, 0.0],
            [0.18, 0.18, 0.18],
            [0.9, 0.2, 0.05],
            [0.1, 0.4, 0.8],
            [1.0, 1.0, 1.0],
        ] {
            let out = p.point_curve(p.pre_acr3(rgb));
            for k in 0..3 {
                assert!((out[k] - rgb[k]).abs() < 1e-12, "{rgb:?} -> {out:?}");
            }
        }
    }

    #[test]
    fn standard_1_keeps_grays_and_ends_and_is_monotone_on_grays() {
        let p = standard_1();
        let mut last = -1.0;
        for i in 0..=256 {
            let g = i as f64 / 256.0;
            let out = p.point_curve(p.pre_acr3([g, g, g]));
            // hue / saturation adjustments vanish at s = 0: grays stay gray
            assert!((out[0] - out[1]).abs() < 1e-12 && (out[1] - out[2]).abs() < 1e-12);
            assert!(out[0] >= last, "tone must not decrease at {g}");
            last = out[0];
        }
        assert!(p.point_curve(p.pre_acr3([0.0; 3]))[0].abs() < 1e-12);
        assert!((p.point_curve(p.pre_acr3([1.0; 3]))[0] - 1.0).abs() < 1e-12);
    }

    #[test]
    fn hsv_round_trips() {
        for rgb in [
            [0.9, 0.2, 0.05],
            [0.1, 0.4, 0.8],
            [0.3, 0.7, 0.2],
            [0.6, 0.1, 0.5],
            [0.2, 0.2, 0.9],
        ] {
            let (h, s, v) = rgb_to_hsv(rgb);
            let back = hsv_to_rgb(h, s, v);
            for k in 0..3 {
                assert!((back[k] - rgb[k]).abs() < 1e-12);
            }
        }
    }

    #[test]
    fn known_versions() {
        assert!(
            is_known("niho-interim-1")
                && is_known("niho-standard-1")
                && is_known("niho-standard-2")
                && !is_known("niho-standard-999")
        );
        assert!(params(LOOK_NIHO_INTERIM_1).is_none() && params(LOOK_NIHO_STANDARD_1).is_some());
    }
}
