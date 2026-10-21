//! `developSettings.lens` (niho-photo#45, "レンズ"): the manual lens
//! corrections of stage 2 (distortion, vignetting) and the automatic
//! removal of lateral chromatic aberration and of purple / green fringes.
//! See `docs/lens-adjustments.md`.
//!
//! - **No profile.** Profile corrections are not made here: the Mac's
//!   RAW sidecar bakes the camera's distortion (and, for embedded
//!   profiles, its vignetting) into the working copy, which cannot be
//!   turned off afterwards (owner decision 2026-09-29), so a second
//!   profile here would correct twice. The manual values are on top of
//!   what the working copy already carries.
//! - **Shape.** `{ distortion, vignetting, vignettingMidpoint,
//!   removeChromaticAberration, defringe: { purple: { amount, hueLo, hueHi },
//!   green: {...} } }`. Missing keys take the defaults, unknown keys are
//!   errors (`unknownKey`), ranges are [`validate_lens`]'s. The defaults
//!   write no key; settings whose lens renders something
//!   ([`Lens::is_active`]) need `v: 9`.
//! - **Where.** Distortion and chromatic aberration are geometry: they are
//!   the end of the inverse map that resamples the working image
//!   (`frame.rs`: output pixel -> crop and angle -> perspective -> lens ->
//!   the photo), one Catmull-Rom pass, red and blue at their own scaled
//!   points. Vignetting is a linear-light gain on the resampled pixel by
//!   its radius on the photo; fringes are removed on the resampled window
//!   right after. Both come before the local pass and every color
//!   adjustment.
//! - **Identity.** Settings whose lens renders nothing take every path as
//!   before, bit for bit.

mod chromatic;
mod fringe;

pub use chromatic::{estimate_chromatic_aberration, ChromaticEstimate};
pub(crate) use fringe::{defringe_radius, defringe_window};

use crate::settings::{num, SettingsError};
use serde_json::{Map, Value};

/// `v` of settings whose lens renders something (niho-photo#45; 5 and 6
/// belong to other features).
pub const LENS_SETTINGS_VERSION: u32 = 9;
/// The radial coefficient `a` at `distortion` 100 ([`LensMap`]).
pub const MAX_DISTORTION: f64 = 0.2;
/// The corner's exposure change at `vignetting` 100 (EV).
pub const MAX_VIGNETTING_EV: f64 = 1.5;
/// Where the vignetting starts at `vignettingMidpoint` 100 (fraction of
/// the half diagonal; 0 starts at the center).
pub const VIGNETTING_START_SPAN: f64 = 0.9;
/// Largest estimated red / blue scale against green (both ways).
pub const MAX_CHROMATIC_SCALE: f64 = 0.01;
/// Lightroom's purple hue slider (`DefringePurpleHueLo / Hi`, `0..100`) on
/// the hue circle: `PURPLE_HUE.0 + PURPLE_HUE.1 * u` degrees (225..360,
/// blue to magenta-red; the default 30..70 is 265.5..319.5).
pub const PURPLE_HUE: (f64, f64) = (225.0, 1.35);
/// Lightroom's green hue slider (`DefringeGreenHueLo / Hi`, `0..100`):
/// `GREEN_HUE.0 + GREEN_HUE.1 * u` degrees (60..180, yellow to cyan; the
/// default 40..60 is 108..132).
pub const GREEN_HUE: (f64, f64) = (60.0, 1.2);

/// One fringe color of `defringe` ("紫" / "緑").
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct FringeBand {
    /// How strongly matching pixels near edges are neutralized, `0..100`
    /// (0: off).
    pub amount: f64,
    /// The hue range on Lightroom's slider for this color, `0..100`
    /// (`hue_lo <= hue_hi`), [`PURPLE_HUE`] / [`GREEN_HUE`].
    pub hue_lo: f64,
    pub hue_hi: f64,
}

/// `lens.defringe`.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct Defringe {
    pub purple: FringeBand,
    pub green: FringeBand,
}

impl Default for Defringe {
    fn default() -> Self {
        Self {
            purple: FringeBand {
                amount: 0.0,
                hue_lo: 30.0,
                hue_hi: 70.0,
            },
            green: FringeBand {
                amount: 0.0,
                hue_lo: 40.0,
                hue_hi: 60.0,
            },
        }
    }
}

impl Defringe {
    pub fn is_active(&self) -> bool {
        self.purple.amount > 0.0 || self.green.amount > 0.0
    }
}

/// `developSettings.lens`.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct Lens {
    /// `-100..100`; positive straightens a barrel (lines bowed outwards),
    /// negative a pincushion.
    pub distortion: f64,
    /// `-100..100`; positive brightens the corners.
    pub vignetting: f64,
    /// `0..100`; how far from the corners the vignetting starts (lower
    /// reaches further toward the center).
    pub vignetting_midpoint: f64,
    /// Lateral chromatic aberration estimated from the photo and removed.
    pub remove_chromatic_aberration: bool,
    pub defringe: Defringe,
}

impl Default for Lens {
    fn default() -> Self {
        Self {
            distortion: 0.0,
            vignetting: 0.0,
            vignetting_midpoint: 50.0,
            remove_chromatic_aberration: false,
            defringe: Defringe::default(),
        }
    }
}

impl Lens {
    /// Whether these values change pixels (the midpoint and the hue ranges
    /// alone do not). Active settings need [`LENS_SETTINGS_VERSION`].
    pub fn is_active(&self) -> bool {
        self.distortion != 0.0
            || self.vignetting != 0.0
            || self.remove_chromatic_aberration
            || self.defringe.is_active()
    }

    pub fn is_default(&self) -> bool {
        *self == Self::default()
    }
}

const LENS_KEYS: [&str; 5] = [
    "distortion",
    "vignetting",
    "vignettingMidpoint",
    "removeChromaticAberration",
    "defringe",
];
const BAND_KEYS: [&str; 3] = ["amount", "hueLo", "hueHi"];

fn number(v: &Value, path: &str) -> Result<f64, SettingsError> {
    let n = v
        .as_f64()
        .ok_or_else(|| SettingsError::new(path, "invalidType", "must be a number"))?;
    if !n.is_finite() {
        return Err(SettingsError::new(path, "notFinite", "must be finite"));
    }
    Ok(n)
}

fn object<'a>(
    v: &'a Value,
    path: &str,
    keys: &[&str],
) -> Result<&'a Map<String, Value>, SettingsError> {
    let o = v
        .as_object()
        .ok_or_else(|| SettingsError::new(path, "invalidType", "must be an object"))?;
    if let Some(key) = o.keys().find(|k| !keys.contains(&k.as_str())) {
        return Err(SettingsError::new(
            &format!("{path}.{key}"),
            "unknownKey",
            "unknown lens field",
        ));
    }
    Ok(o)
}

fn parse_band(v: &Value, path: &str, mut band: FringeBand) -> Result<FringeBand, SettingsError> {
    let o = object(v, path, &BAND_KEYS)?;
    for (key, value) in o {
        let p = format!("{path}.{key}");
        match key.as_str() {
            "amount" => band.amount = number(value, &p)?,
            "hueLo" => band.hue_lo = number(value, &p)?,
            _ => band.hue_hi = number(value, &p)?,
        }
    }
    Ok(band)
}

/// Reads `lens` (`null` is the defaults). Wrong types, unknown keys and
/// non-finite numbers are errors; ranges are [`validate_lens`]'s.
pub fn parse_lens(v: &Value) -> Result<Lens, SettingsError> {
    let mut lens = Lens::default();
    if v.is_null() {
        return Ok(lens);
    }
    let o = object(v, "lens", &LENS_KEYS)?;
    for (key, value) in o {
        let path = format!("lens.{key}");
        match key.as_str() {
            "distortion" => lens.distortion = number(value, &path)?,
            "vignetting" => lens.vignetting = number(value, &path)?,
            "vignettingMidpoint" => lens.vignetting_midpoint = number(value, &path)?,
            "removeChromaticAberration" => {
                lens.remove_chromatic_aberration = value
                    .as_bool()
                    .ok_or_else(|| SettingsError::new(&path, "invalidType", "must be a boolean"))?
            }
            _ => {
                if value.is_null() {
                    continue;
                }
                let d = object(value, &path, &["purple", "green"])?;
                if let Some(p) = d.get("purple") {
                    lens.defringe.purple =
                        parse_band(p, "lens.defringe.purple", lens.defringe.purple)?;
                }
                if let Some(g) = d.get("green") {
                    lens.defringe.green =
                        parse_band(g, "lens.defringe.green", lens.defringe.green)?;
                }
            }
        }
    }
    Ok(lens)
}

/// `lens` as written (every field).
pub fn lens_to_value(lens: &Lens) -> Value {
    let band = |b: &FringeBand| {
        let mut m = Map::new();
        m.insert("amount".into(), num(b.amount));
        m.insert("hueLo".into(), num(b.hue_lo));
        m.insert("hueHi".into(), num(b.hue_hi));
        Value::Object(m)
    };
    let mut defringe = Map::new();
    defringe.insert("purple".into(), band(&lens.defringe.purple));
    defringe.insert("green".into(), band(&lens.defringe.green));
    let mut o = Map::new();
    o.insert("distortion".into(), num(lens.distortion));
    o.insert("vignetting".into(), num(lens.vignetting));
    o.insert("vignettingMidpoint".into(), num(lens.vignetting_midpoint));
    o.insert(
        "removeChromaticAberration".into(),
        Value::from(lens.remove_chromatic_aberration),
    );
    o.insert("defringe".into(), Value::Object(defringe));
    Value::Object(o)
}

/// Range checks: `distortion` / `vignetting` `-100..100`, the midpoint, the
/// amounts and the hues `0..100`, and each hue range in order
/// (`invalidRange` when `hueLo > hueHi`).
pub fn validate_lens(lens: &Lens, issues: &mut Vec<SettingsError>) {
    let mut check = |path: &str, value: f64, lo: f64, hi: f64| {
        if !value.is_finite() || value < lo || value > hi {
            issues.push(SettingsError::new(
                path,
                "outOfRange",
                &format!("must be within {lo}..{hi}"),
            ));
        }
    };
    check("lens.distortion", lens.distortion, -100.0, 100.0);
    check("lens.vignetting", lens.vignetting, -100.0, 100.0);
    check(
        "lens.vignettingMidpoint",
        lens.vignetting_midpoint,
        0.0,
        100.0,
    );
    for (name, band) in [
        ("purple", &lens.defringe.purple),
        ("green", &lens.defringe.green),
    ] {
        check(
            &format!("lens.defringe.{name}.amount"),
            band.amount,
            0.0,
            100.0,
        );
        check(
            &format!("lens.defringe.{name}.hueLo"),
            band.hue_lo,
            0.0,
            100.0,
        );
        check(
            &format!("lens.defringe.{name}.hueHi"),
            band.hue_hi,
            0.0,
            100.0,
        );
    }
    for (name, band) in [
        ("purple", &lens.defringe.purple),
        ("green", &lens.defringe.green),
    ] {
        if band.hue_lo > band.hue_hi {
            issues.push(SettingsError::new(
                &format!("lens.defringe.{name}"),
                "invalidRange",
                "hueLo must not exceed hueHi",
            ));
        }
    }
}

/// The color space of the image the lens reads (the Session's source):
/// JPEG / PNG originals are linear sRGB, working copies linear ProPhoto.
/// Only the fringes' hue and the neutral they are pulled to depend on it.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum LensSpace {
    LinearSrgb,
    LinearProPhoto,
}

/// What a lens renders on one source: the settings with the chromatic
/// aberration the Session estimated for its photo ([`LensRender::new`]).
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct LensRender {
    /// `a` of the radial model (`distortion / 100 * MAX_DISTORTION`).
    pub distortion: f64,
    /// Red and blue scales against green (1: none).
    pub chromatic: [f64; 2],
    /// The corner's exposure change in EV (`vignetting / 100 *
    /// MAX_VIGNETTING_EV`).
    pub vignetting: f64,
    /// Where the vignetting starts (fraction of the half diagonal).
    pub start: f64,
    pub defringe: Defringe,
    pub space: LensSpace,
}

impl LensRender {
    /// The lens of `lens` with `chromatic` (the photo's estimate, read when
    /// `removeChromaticAberration` is on) on a source in `space`. `None`
    /// when it renders nothing (e.g. only the switch on a photo whose
    /// estimate is 0).
    pub fn new(
        lens: &Lens,
        chromatic: Option<ChromaticEstimate>,
        space: LensSpace,
    ) -> Option<Self> {
        let chromatic = match (lens.remove_chromatic_aberration, chromatic) {
            (true, Some(e)) => [1.0 + e.red, 1.0 + e.blue],
            _ => [1.0, 1.0],
        };
        let render = Self {
            distortion: lens.distortion / 100.0 * MAX_DISTORTION,
            chromatic,
            vignetting: lens.vignetting / 100.0 * MAX_VIGNETTING_EV,
            start: VIGNETTING_START_SPAN * lens.vignetting_midpoint / 100.0,
            defringe: lens.defringe,
            space,
        };
        (render.warps() || render.shades() || render.defringes()).then_some(render)
    }

    /// Whether it moves pixels (distortion or chromatic aberration): the
    /// frame is resampled through [`LensMap`].
    pub fn warps(&self) -> bool {
        self.distortion != 0.0 || self.has_chromatic()
    }

    pub fn has_chromatic(&self) -> bool {
        self.chromatic != [1.0, 1.0]
    }

    pub fn shades(&self) -> bool {
        self.vignetting != 0.0
    }

    pub fn defringes(&self) -> bool {
        self.defringe.is_active()
    }

    /// What a window rendered through it depends on (the frame key).
    pub fn key(&self) -> String {
        let d = &self.defringe;
        format!(
            "{:?}|{:?}|{:?}|{:?}|{:?}|{:?}|{:?}|{:?}|{:?}|{:?}|{:?}|{:?}",
            self.distortion,
            self.chromatic,
            self.vignetting,
            self.start,
            d.purple.amount,
            d.purple.hue_lo,
            d.purple.hue_hi,
            d.green.amount,
            d.green.hue_lo,
            d.green.hue_hi,
            self.space,
            self.has_chromatic()
        )
    }
}

/// A Session's lens state ([`crate::Session::lens_stats`]).
#[derive(Debug, Clone, Copy, PartialEq, Default)]
pub struct LensStats {
    /// The photo's chromatic aberration, once estimated.
    pub chromatic: Option<ChromaticEstimate>,
    /// How many times it was estimated (at most once per photo).
    pub chromatic_estimates: usize,
}

/// How much larger a JPEG / PNG must be decoded for `lens` to keep its
/// detail: `1 / zoom` of a negative distortion (which magnifies to fill the
/// corners), else 1.
pub fn decode_zoom(lens: &Lens) -> f64 {
    let a = lens.distortion / 100.0 * MAX_DISTORTION;
    if a < 0.0 {
        1.0 - a
    } else {
        1.0
    }
}

/// [`LensRender`] on a `width x height` frame (continuous pixels, pixel
/// `n`'s center at `n + 0.5`; the lens's center is the frame's, `R` its
/// half diagonal).
///
/// - **Distortion.** An output point at `rho = r / R` takes the photo at
///   `r_src = z * r * (1 - a rho^2)` (`a = distortion / 100 * 0.2`):
///   positive `a` pulls the corners in (a barrel's outward bow is
///   straightened), negative pushes them out (a pincushion). Past the
///   frame's corner (`rho > 1`, only the margin and uncovered perspective
///   corners) the radius continues along the tangent at `rho = 1`, so the
///   map stays monotonic. `z` keeps every output pixel on the photo: `1`
///   for `a >= 0` (the corners already sample inside), `1 / (1 - a)` for
///   `a < 0` (the corners would sample outside: the photo is magnified so
///   they land on its corners, Lightroom's constrained crop).
/// - **Chromatic aberration.** Red and blue take the photo at
///   `center + s * (green's point - center)` (`s` the estimated scale);
///   `z` also divides by the larger scale so their corners stay inside.
/// - **Vignetting.** A gain `2^(ev * t^2)` by green's point on the photo,
///   `t = clamp((rho - start) / (1 - start), 0, 1)`.
#[derive(Debug, Clone, Copy)]
pub(crate) struct LensMap {
    center: [f64; 2],
    radius: f64,
    a: f64,
    zoom: f64,
    chromatic: [f64; 2],
    vignetting: f64,
    start: f64,
}

impl LensMap {
    pub(crate) fn new(lens: &LensRender, width: usize, height: usize) -> Self {
        let (w, h) = (width as f64, height as f64);
        let a = lens.distortion;
        let distortion_zoom = if a < 0.0 { 1.0 / (1.0 - a) } else { 1.0 };
        let widest = lens.chromatic[0].max(lens.chromatic[1]).max(1.0);
        Self {
            center: [w / 2.0, h / 2.0],
            radius: libm::hypot(w, h) / 2.0,
            a,
            zoom: distortion_zoom / widest,
            chromatic: lens.chromatic,
            vignetting: lens.vignetting,
            start: lens.start,
        }
    }

    /// Photo pixels per output pixel at the center (the zoom).
    pub(crate) fn center_scale(&self) -> f64 {
        self.zoom
    }

    fn factor(&self, rho: f64) -> f64 {
        if self.a == 0.0 {
            self.zoom
        } else if rho <= 1.0 {
            self.zoom * (1.0 - self.a * rho * rho)
        } else {
            self.zoom * ((1.0 - self.a) + (rho - 1.0) * (1.0 - 3.0 * self.a)) / rho
        }
    }

    /// Green's point on the photo of frame point `p`.
    pub(crate) fn source(&self, p: [f64; 2]) -> [f64; 2] {
        let d = [p[0] - self.center[0], p[1] - self.center[1]];
        if self.a == 0.0 {
            return [
                self.center[0] + d[0] * self.zoom,
                self.center[1] + d[1] * self.zoom,
            ];
        }
        let f = self.factor((d[0] * d[0] + d[1] * d[1]).sqrt() / self.radius);
        [self.center[0] + d[0] * f, self.center[1] + d[1] * f]
    }

    pub(crate) fn has_chromatic(&self) -> bool {
        self.chromatic != [1.0, 1.0]
    }

    /// Red's (`channel` 0) or blue's (1) point for green's point `g`.
    pub(crate) fn channel(&self, g: [f64; 2], channel: usize) -> [f64; 2] {
        let s = self.chromatic[channel];
        [
            self.center[0] + (g[0] - self.center[0]) * s,
            self.center[1] + (g[1] - self.center[1]) * s,
        ]
    }

    /// The vignetting gain at `rho` (exact).
    fn exact_gain(&self, rho: f64) -> f64 {
        let t = ((rho - self.start) / (1.0 - self.start)).clamp(0.0, 1.0);
        libm::exp2(self.vignetting * t * t)
    }

    /// The vignetting's gains (`None` without vignetting).
    pub(crate) fn shading(&self) -> Option<Shading> {
        (self.vignetting != 0.0).then(|| Shading {
            center: self.center,
            inverse_radius: SHADING_STEPS as f64 / self.radius,
            table: (0..=SHADING_STEPS)
                .map(|k| self.exact_gain(k as f64 / SHADING_STEPS as f64) as f32)
                .collect(),
        })
    }
}

/// Table steps of the vignetting's gain over `rho` in `0..1` (linear
/// between them: within 1e-6 of `2^(ev t^2)`; constant past the corner).
const SHADING_STEPS: usize = 8192;

/// The vignetting gain by the point's radius on the photo ([`LensMap`]),
/// from a table.
pub(crate) struct Shading {
    center: [f64; 2],
    /// Table steps per pixel of radius.
    inverse_radius: f64,
    table: Vec<f32>,
}

impl Shading {
    /// The gain at green's point `g` on the photo.
    #[inline]
    pub(crate) fn gain(&self, g: [f64; 2]) -> f32 {
        let (dx, dy) = (g[0] - self.center[0], g[1] - self.center[1]);
        let at = (dx * dx + dy * dy).sqrt() * self.inverse_radius;
        if at >= SHADING_STEPS as f64 {
            return self.table[SHADING_STEPS];
        }
        let k = at as usize;
        let t = (at - k as f64) as f32;
        let (a, b) = (self.table[k], self.table[k + 1]);
        a + (b - a) * t
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn lens(json: &str) -> Lens {
        parse_lens(&serde_json::from_str(json).unwrap()).unwrap()
    }

    #[test]
    fn the_shape_reads_and_writes() {
        let l = lens(
            r#"{"distortion":12,"vignetting":-30,"vignettingMidpoint":40,"removeChromaticAberration":true,"defringe":{"purple":{"amount":50,"hueLo":20,"hueHi":80},"green":{"amount":5}}}"#,
        );
        assert_eq!(l.distortion, 12.0);
        assert_eq!(l.defringe.green.hue_lo, 40.0);
        assert_eq!(parse_lens(&lens_to_value(&l)).unwrap(), l);
        assert!(l.is_active());
        assert!(!lens(r#"{"vignettingMidpoint":10}"#).is_active());
        assert!(parse_lens(&Value::Null).unwrap().is_default());
        for (json, code) in [
            (r#"{"foo":1}"#, "unknownKey"),
            (r#"{"defringe":{"purple":{"x":1}}}"#, "unknownKey"),
            (r#"{"defringe":{"blue":{}}}"#, "unknownKey"),
            (r#"{"distortion":"1"}"#, "invalidType"),
            (r#"{"removeChromaticAberration":1}"#, "invalidType"),
            (r#"[]"#, "invalidType"),
        ] {
            let e = parse_lens(&serde_json::from_str(json).unwrap()).unwrap_err();
            assert_eq!(e.code, code, "{json}");
        }
        let mut issues = Vec::new();
        validate_lens(
            &lens(r#"{"distortion":101,"defringe":{"green":{"hueLo":70,"hueHi":60}}}"#),
            &mut issues,
        );
        let codes: Vec<(&str, &str)> = issues
            .iter()
            .map(|e| (e.path.as_str(), e.code.as_str()))
            .collect();
        assert_eq!(
            codes,
            [
                ("lens.distortion", "outOfRange"),
                ("lens.defringe.green", "invalidRange")
            ]
        );
    }

    #[test]
    fn the_distortion_map_is_monotonic_and_stays_on_the_photo() {
        for d in [-100.0, -40.0, 30.0, 100.0] {
            let l = Lens {
                distortion: d,
                ..Lens::default()
            };
            let r = LensRender::new(&l, None, LensSpace::LinearSrgb).unwrap();
            let map = LensMap::new(&r, 300, 200);
            let mut last = -1.0;
            for k in 0..=400 {
                // Along the diagonal, out to 1.5 times the corner.
                let t = k as f64 / 400.0 * 1.5;
                let p = map.source([150.0 + 150.0 * t, 100.0 + 100.0 * t]);
                let r = libm::hypot(p[0] - 150.0, p[1] - 100.0);
                assert!(r > last, "{d} {t}");
                last = r;
                if t <= 1.0 {
                    assert!(p[0] <= 300.0 + 1e-9 && p[1] <= 200.0 + 1e-9, "{d} {t}");
                }
            }
            // Every edge point stays inside the frame.
            for k in 0..=100 {
                let s = k as f64 / 100.0;
                for p in [[300.0 * s, 0.0], [300.0, 200.0 * s], [0.0, 200.0 * s]] {
                    let q = map.source(p);
                    assert!((-1e-9..=300.0 + 1e-9).contains(&q[0]), "{d} {p:?}");
                    assert!((-1e-9..=200.0 + 1e-9).contains(&q[1]), "{d} {p:?}");
                }
            }
        }
    }

    #[test]
    fn vignetting_is_symmetric_in_ev() {
        let up = LensRender::new(
            &Lens {
                vignetting: 60.0,
                ..Lens::default()
            },
            None,
            LensSpace::LinearSrgb,
        )
        .unwrap();
        let down = LensRender::new(
            &Lens {
                vignetting: -60.0,
                ..Lens::default()
            },
            None,
            LensSpace::LinearSrgb,
        )
        .unwrap();
        let (a, b) = (
            LensMap::new(&up, 300, 200).shading().unwrap(),
            LensMap::new(&down, 300, 200).shading().unwrap(),
        );
        assert_eq!(a.gain([150.0, 100.0]), 1.0);
        let corner = a.gain([0.0, 0.0]);
        assert!((corner - libm::exp2(0.9) as f32).abs() < 1e-6);
        assert_eq!(a.gain([-50.0, -50.0]), corner);
        for p in [[10.0, 20.0], [290.0, 100.0], [150.0, 199.0], [77.7, 33.3]] {
            assert!((a.gain(p) * b.gain(p) - 1.0).abs() < 2e-6);
        }
        // The table is within 1e-6 of the exact gain.
        let map = LensMap::new(&up, 300, 200);
        for k in 0..=1000 {
            let rho = k as f64 / 1000.0 * 1.2;
            let p = [150.0 + rho * map.radius, 100.0];
            let exact = map.exact_gain(rho);
            assert!((f64::from(a.gain(p)) - exact).abs() < 1e-6 * exact, "{rho}");
        }
        assert!(LensMap::new(
            &LensRender::new(
                &Lens {
                    distortion: 10.0,
                    ..Lens::default()
                },
                None,
                LensSpace::LinearSrgb
            )
            .unwrap(),
            300,
            200
        )
        .shading()
        .is_none());
    }

    #[test]
    fn nothing_renders_without_a_value() {
        let only_switch = Lens {
            remove_chromatic_aberration: true,
            ..Lens::default()
        };
        assert!(LensRender::new(&only_switch, None, LensSpace::LinearSrgb).is_none());
        let none = ChromaticEstimate::default();
        assert!(LensRender::new(&only_switch, Some(none), LensSpace::LinearSrgb).is_none());
        let found = ChromaticEstimate {
            red: 0.002,
            blue: -0.001,
            edges: 100,
        };
        let r = LensRender::new(&only_switch, Some(found), LensSpace::LinearSrgb).unwrap();
        assert!(r.warps() && !r.shades() && !r.defringes());
        assert_eq!(r.chromatic, [1.002, 0.999]);
    }
}
