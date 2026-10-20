//! Effects (NIHO extension, #17120 E1): the post-crop vignette and grain.
//!
//! Photo Bench (the port source of every other stage) has neither, so the
//! formulas are NIHO's own, with the constants fitted to Lightroom's round8
//! and round9 exports (6 scenes x 16 + 19 variants,
//! `tools/calibrate/run_e1_effects.py`; round9 = the ends of the sliders,
//! E1c #17259).
//!
//! - Vignette, on the frame being drawn (the output `w x h`; once cropping
//!   exists, the cropped frame). A normalized radius `rho` per pixel (corners
//!   1, [`vignette_radius`]) depends only on the frame and `roundness`, so it
//!   is kept by a [`crate::Session`]; `midpoint`, `feather` and `amount` go
//!   into per-frame tables of `rho` ([`RadialTable`]), so dragging them
//!   rebuilds no plane. `highlightPriority` and `colorPriority` act on the
//!   linear value after the local pass and before the tone cubes (like
//!   exposure); `paintOverlay` acts on the output in linear light.
//! - Grain, last, on the sRGB-encoded output: monochrome value noise whose
//!   lattices are fixed to the photo (spacing relative to the long edge) and
//!   box-filtered exactly over each pixel ([`grain_field`]), so a frame at any
//!   size shows the same grain as a larger frame reduced to that size.
//!
//! Everything is deterministic: `libm` for transcendental functions and an
//! integer hash for the noise, so native and wasm agree bit for bit.

use crate::color::{PP_LUMA_F32, REC709_LUMA_F32};
use crate::fastmath::srgb_encode_power;
use crate::settings::{DevelopSettings, GrainSettings, VignetteSettings, VignetteStyle};
use crate::spatial::Plane;
use std::collections::VecDeque;
use std::sync::OnceLock;

// MARK: - Vignette

/// Darkening (`amount < 0`) of `highlightPriority`, per channel in the
/// square root of the linear value: `sqrt(v') = sqrt(v) * (1 - k) -
/// VIGNETTE_ROOT_OFFSET * k` with `k = |amount| / 100 * mask` (a blend
/// toward a point just below black, clamped at 0: black at -100 where the
/// mask is 1). The offset darkens shadows more than highlights, as
/// Lightroom does (round9: -3.5 EV at linear 0.05 against -2.9 EV at 0.4
/// for -60 where the mask is 1).
pub const VIGNETTE_ROOT_OFFSET: f64 = 0.033;
/// `highlights` (Lightroom's `PostCropVignetteHighlightContrast`) of a
/// darkening `highlightPriority` vignette: a bright pixel takes less of it.
/// The strength `k` is multiplied by `1 - (highlights / 100)^
/// VIGNETTE_HIGHLIGHTS_SHAPE * max(sqrt(Y) - VIGNETTE_HIGHLIGHTS_FROM, 0) /
/// VIGNETTE_HIGHLIGHTS_SPAN` (not below 0), `Y` the pixel's linear
/// luminance before the vignette. Round9 at -60: the factor is the same at
/// every mask value; at 100 it falls from 1 at `Y = 0.15` to 0 at
/// `Y = 0.66`, at 50 to 0.23 at `Y = 0.9`.
pub const VIGNETTE_HIGHLIGHTS_FROM: f64 = 0.39;
pub const VIGNETTE_HIGHLIGHTS_SPAN: f64 = 0.42;
pub const VIGNETTE_HIGHLIGHTS_SHAPE: f64 = 0.75;
/// Darkening of `colorPriority`: the linear gain
/// `(1 - |amount| / 100 * mask)^VIGNETTE_GAMMA_COLOR` (the same at every
/// tone in Lightroom).
pub const VIGNETTE_GAMMA_COLOR: f64 = 2.2;
/// Darkening of `paintOverlay`: the same gain with this exponent on the
/// output in linear light (the sRGB value decoded).
pub const VIGNETTE_GAMMA_PAINT: f64 = 2.4;
/// Brightening (`amount > 0`, every style): a blend toward a white by
/// `(amount / 100 * mask)^VIGNETTE_BRIGHTEN_POWER`, never above white
/// (linear 1). `colorPriority` blends the linear value before the tone
/// cubes toward 1, `paintOverlay` the output in linear light toward 1, and
/// `highlightPriority` the linear value before the tone cubes toward
/// [`VIGNETTE_BRIGHTEN_TARGET`] (past white: it reaches white sooner and
/// lifts the shadows of the corners to a light gray, as Lightroom does).
pub const VIGNETTE_BRIGHTEN_POWER: f64 = 2.0;
pub const VIGNETTE_BRIGHTEN_TARGET: f64 = 1.8;
/// The falloff of a brightening vignette sits further out and is a little
/// wider than the darkening one's: its center moves out by
/// `VIGNETTE_BRIGHTEN_SHIFT` times the falloff's scale, the scale grows by
/// `VIGNETTE_BRIGHTEN_SCALE` (round9: +0.058 and x 1.12 at feather 50 in
/// all three styles).
pub const VIGNETTE_BRIGHTEN_SHIFT: f64 = 0.73;
pub const VIGNETTE_BRIGHTEN_SCALE: f64 = 1.12;
/// A darkening vignette past `amount = -VIGNETTE_DEEP_FROM` also moves out
/// and widens, in proportion to the amount beyond it (at -100: the center
/// by `VIGNETTE_DEEP_SHIFT` times the falloff's scale, the scale by
/// `VIGNETTE_DEEP_SCALE`; round8: the falloff of -100 is centered at 0.700
/// against 0.660 / 0.666 at -50 / -60).
pub const VIGNETTE_DEEP_FROM: f64 = 60.0;
pub const VIGNETTE_DEEP_SHIFT: f64 = 0.44;
pub const VIGNETTE_DEEP_SCALE: f64 = 1.12;
/// `roundness < 0`: the corner radius of the rounded rectangle inscribed in
/// the frame, relative to the long half side, at `roundness = -100`
/// (`1` at 0: the ellipse). Linear in `roundness` between (round9: 0.553 at
/// -50, 0.104 at -100; round8: 0.25 at -80).
pub const VIGNETTE_BOX_RADIUS_MIN: f64 = 0.104;
/// Center of the falloff (in `rho`, corners 1) at `feather = 50`:
/// `VIGNETTE_CENTER_AT_MIDPOINT_0 + VIGNETTE_CENTER_SLOPE * m +
/// VIGNETTE_CENTER_CURVE * max(m - 0.5, 0)^2`, `m = midpoint / 100`
/// (0.45 / 0.58 / 0.665 / 1.02 at midpoint 0 / 30 / 50 / 100: at 100 only
/// the corners change).
pub const VIGNETTE_CENTER_AT_MIDPOINT_0: f64 = 0.4515;
pub const VIGNETTE_CENTER_SLOPE: f64 = 0.427;
pub const VIGNETTE_CENTER_CURVE: f64 = 0.57;
/// `feather` at the knots of the two tables below (linear between).
pub const VIGNETTE_FEATHER_KNOTS: [f64; 5] = [0.0, 20.0, 50.0, 80.0, 100.0];
/// Scale of the falloff (the logistic's, in `rho`): 0 is a hard edge.
/// Lightroom's feather 100 is narrower than its feather 80 (round9 at
/// midpoint 50 against round8 at midpoint 25).
pub const VIGNETTE_FEATHER_SCALE: [f64; 5] = [0.0, 0.0225, 0.079, 0.125, 0.100];
/// Center of the falloff relative to `feather = 50` (the hard edge at
/// feather 0 is the ellipse inscribed in the frame at midpoint 50:
/// `rho = 0.705`; a little feather softens it inward).
pub const VIGNETTE_FEATHER_SHIFT: [f64; 5] = [0.040, -0.009, 0.0, 0.032, 0.075];
/// The corners always take the whole amount: the logistic's argument grows
/// by `VIGNETTE_CORNER_LIFT * exp(-(1 - rho) / VIGNETTE_CORNER_REACH)`
/// (round9 midpoint 100: the mask climbs from 0.25 to 0.93 over the last
/// 8 % of the radius).
pub const VIGNETTE_CORNER_LIFT: f64 = 6.0;
pub const VIGNETTE_CORNER_REACH: f64 = 0.024;
/// Entries of a [`RadialTable`] over `rho` in `[0, 1]`.
const RADIAL_TABLE_SIZE: usize = 4096;

/// Normalized radius per pixel of a `w x h` frame: `rho = d / sqrt(2)` with
/// `d` 1 on the shape inscribed in the frame and `sqrt(2)` at the corners
/// (0 at the center, 1 at the corners for every roundness, so `midpoint`
/// means the same distance to the corner).
///
/// - `roundness >= 0`: with `dx = (x + 0.5 - w/2) / (w/2)` and `dy` likewise
///   (the ellipse inscribed in the frame at 0), `dx, dy` are scaled toward
///   the circle in pixels, `dx * lerp(1, (w/2) / R, r)`,
///   `R = sqrt(((w/2)^2 + (h/2)^2) / 2)`, and `d` is their length divided
///   by the corner's.
/// - `roundness < 0`: a rounded rectangle inscribed in the frame with corner
///   radius `c = L * (1 - (1 - VIGNETTE_BOX_RADIUS_MIN) * -r)` (`L` the long
///   half side), per axis `min(c, half side)` (at 0 the corner's semi-axes
///   are the half sides: the ellipse; below the short half side the corners
///   are circles in pixels). `d` is the distance from the inner box (the
///   frame shrunk by the corner's semi-axes) in units of those semi-axes,
///   negative inside it: the falloff runs parallel to the frame's edges, as
///   Lightroom's does (round9: the same profile in pixels from the long and
///   the short edge at -50 and -100).
///
/// `r = roundness / 100`.
pub fn vignette_radius(w: usize, h: usize, roundness: f64) -> Plane {
    let r = (roundness / 100.0).clamp(-1.0, 1.0);
    let (hw, hh) = (w as f64 / 2.0, h as f64 / 2.0);
    let mut plane = Plane::new(w, h);
    if r < 0.0 {
        let corner = hw.max(hh) * (1.0 - (1.0 - VIGNETTE_BOX_RADIUS_MIN) * -r);
        let axis = |n: usize, half: f64| -> Vec<f64> {
            let radius = corner.min(half);
            (0..n)
                .map(|i| ((i as f64 + 0.5 - half).abs() - (half - radius)) / radius)
                .collect()
        };
        let (ax, ay) = (axis(w, hw), axis(h, hh));
        for (row, qy) in plane.data.chunks_exact_mut(w.max(1)).zip(&ay) {
            for (dst, qx) in row.iter_mut().zip(&ax) {
                let (px, py) = (qx.max(0.0), qy.max(0.0));
                let d = libm::sqrt(px * px + py * py) + qx.max(*qy).min(0.0);
                *dst = (d * std::f64::consts::FRAC_1_SQRT_2) as f32;
            }
        }
        return plane;
    }
    let circle = libm::sqrt((hw * hw + hh * hh) / 2.0);
    let (sx, sy) = (1.0 + (hw / circle - 1.0) * r, 1.0 + (hh / circle - 1.0) * r);
    let axis = |n: usize, half: f64, scale: f64| -> Vec<f64> {
        (0..n)
            .map(|i| {
                let d = (i as f64 + 0.5 - half) / half * scale;
                d * d
            })
            .collect()
    };
    let (ax, ay) = (axis(w, hw, sx), axis(h, hh, sy));
    let corner = libm::sqrt(sx * sx + sy * sy);
    for (row, dy) in plane.data.chunks_exact_mut(w.max(1)).zip(&ay) {
        for (dst, dx) in row.iter_mut().zip(&ax) {
            *dst = (libm::sqrt(dx + dy) / corner) as f32;
        }
    }
    plane
}

/// `ys` at `x` on the knots `xs` (linear between, the ends outside).
fn interpolate(x: f64, xs: &[f64], ys: &[f64]) -> f64 {
    let last = xs.len() - 1;
    if x <= xs[0] {
        return ys[0];
    }
    for i in 0..last {
        if x <= xs[i + 1] {
            let t = (x - xs[i]) / (xs[i + 1] - xs[i]);
            return ys[i] + (ys[i + 1] - ys[i]) * t;
        }
    }
    ys[last]
}

/// The falloff's center and scale in `rho` (the constants above; a
/// brightening vignette's and a deep darkening one's sit further out).
fn vignette_falloff(v: &VignetteSettings) -> (f64, f64) {
    let m = (v.midpoint / 100.0).clamp(0.0, 1.0);
    let past = (m - 0.5).max(0.0);
    let feather = v.feather.clamp(0.0, 100.0);
    let scale = interpolate(feather, &VIGNETTE_FEATHER_KNOTS, &VIGNETTE_FEATHER_SCALE);
    let center = VIGNETTE_CENTER_AT_MIDPOINT_0
        + VIGNETTE_CENTER_SLOPE * m
        + VIGNETTE_CENTER_CURVE * past * past
        + interpolate(feather, &VIGNETTE_FEATHER_KNOTS, &VIGNETTE_FEATHER_SHIFT);
    if v.amount > 0.0 {
        return (
            center + VIGNETTE_BRIGHTEN_SHIFT * scale,
            scale * VIGNETTE_BRIGHTEN_SCALE,
        );
    }
    let deep = ((-v.amount - VIGNETTE_DEEP_FROM) / (100.0 - VIGNETTE_DEEP_FROM)).clamp(0.0, 1.0);
    (
        center + VIGNETTE_DEEP_SHIFT * scale * deep,
        scale * (1.0 + (VIGNETTE_DEEP_SCALE - 1.0) * deep),
    )
}

#[inline]
fn logistic(z: f64) -> f64 {
    1.0 / (1.0 + libm::exp(-z.clamp(-700.0, 700.0)))
}

/// The vignette's mask at `rho`: a logistic of `(rho - center) / scale`
/// (Lightroom's falloff has its long tails) plus the corner's lift,
/// stretched to exactly 0 at the center and 1 at the corners (the center
/// never changes; the corners take the whole amount). 0 everywhere when a
/// hard edge lies past the corners.
pub fn vignette_mask(rho: f64, v: &VignetteSettings) -> f64 {
    let (center, scale) = vignette_falloff(v);
    // feather 0: a hard edge (the logistic of a huge argument).
    let scale = scale.max(1e-9);
    let at = |rho: f64| {
        logistic(
            (rho - center) / scale
                + VIGNETTE_CORNER_LIFT * libm::exp(-(1.0 - rho) / VIGNETTE_CORNER_REACH),
        )
    };
    let (floor, top) = (at(0.0), at(1.0));
    if top <= floor {
        return 0.0;
    }
    ((at(rho.clamp(0.0, 1.0)) - floor) / (top - floor)).clamp(0.0, 1.0)
}

/// The strength `|amount| / 100 * mask` of a darkening vignette, or the
/// blend `(amount / 100 * mask)^VIGNETTE_BRIGHTEN_POWER` of a brightening
/// one, at `rho`.
fn vignette_strength(rho: f64, v: &VignetteSettings) -> f64 {
    let k = (v.amount.abs() / 100.0).min(1.0) * vignette_mask(rho, v);
    if v.amount > 0.0 {
        libm::pow(k, VIGNETTE_BRIGHTEN_POWER)
    } else {
        k
    }
}

/// A function of `rho` in `[0, 1]`, tabulated per frame (linear
/// interpolation; values outside `[0, 1]` take the ends).
pub struct RadialTable {
    values: Vec<f32>,
}

impl RadialTable {
    pub fn new(f: impl Fn(f64) -> f64) -> Self {
        let last = (RADIAL_TABLE_SIZE - 1) as f64;
        Self {
            values: (0..RADIAL_TABLE_SIZE)
                .map(|i| f(i as f64 / last) as f32)
                .collect(),
        }
    }

    #[inline]
    pub fn eval(&self, rho: f32) -> f32 {
        let t = rho.clamp(0.0, 1.0) * (RADIAL_TABLE_SIZE - 1) as f32;
        let i = (t as usize).min(RADIAL_TABLE_SIZE - 2);
        let w = t - i as f32;
        let (a, b) = (self.values[i], self.values[i + 1]);
        a + (b - a) * w
    }
}

/// What `highlightPriority` / `colorPriority` do to the linear value.
enum LinearLaw {
    /// `v * gain` (`colorPriority`, darkening).
    Gain(RadialTable),
    /// `max(sqrt(v) * (1 - k) - VIGNETTE_ROOT_OFFSET * k, 0)^2` per channel
    /// (`highlightPriority`, darkening), `k` the strength at `rho` times
    /// the pixel's highlights factor ([`VIGNETTE_HIGHLIGHTS_FROM`];
    /// `highlights` is `(highlights / 100)^VIGNETTE_HIGHLIGHTS_SHAPE /
    /// VIGNETTE_HIGHLIGHTS_SPAN`, 0 without).
    Root {
        strength: RadialTable,
        highlights: f32,
    },
    /// `min(v * keep + add, 1)` below white, `v` from white on
    /// (brightening: a blend toward a white that never passes white).
    Blend { keep: RadialTable, add: RadialTable },
}

/// `highlightPriority` / `colorPriority`: the linear stage of each pixel
/// (the constants above).
pub struct LinearVignette<'a> {
    radius: &'a [f32],
    law: LinearLaw,
}

impl LinearVignette<'_> {
    /// `rho` per pixel.
    #[inline]
    pub fn radius(&self) -> &[f32] {
        self.radius
    }

    /// The linear value `v` with the vignette at `rho`.
    #[inline]
    pub fn apply(&self, v: [f32; 3], rho: f32) -> [f32; 3] {
        match &self.law {
            LinearLaw::Gain(gain) => {
                let g = gain.eval(rho);
                [v[0] * g, v[1] * g, v[2] * g]
            }
            LinearLaw::Root {
                strength,
                highlights,
            } => {
                let mut k = strength.eval(rho);
                if *highlights > 0.0 {
                    let y = v[0] * PP_LUMA_F32[0] + v[1] * PP_LUMA_F32[1] + v[2] * PP_LUMA_F32[2];
                    let bright = (y.max(0.0).sqrt() - VIGNETTE_HIGHLIGHTS_FROM as f32).max(0.0);
                    k *= (1.0 - highlights * bright).max(0.0);
                }
                if k <= 0.0 {
                    // Untouched, to the bit (not the square of a root).
                    return v;
                }
                let (s, o) = (1.0 - k, VIGNETTE_ROOT_OFFSET as f32 * k);
                let one = |c: f32| {
                    let root = (c.max(0.0).sqrt() * s - o).max(0.0);
                    root * root
                };
                [one(v[0]), one(v[1]), one(v[2])]
            }
            LinearLaw::Blend { keep, add } => {
                let (k, a) = (keep.eval(rho), add.eval(rho));
                let one = |c: f32| if c < 1.0 { (c * k + a).min(1.0) } else { c };
                [one(v[0]), one(v[1]), one(v[2])]
            }
        }
    }
}

impl LinearLaw {
    fn new(v: &VignetteSettings) -> Self {
        let vc = *v;
        let strength = move |rho: f64| vignette_strength(rho, &vc);
        if v.amount > 0.0 {
            let target = if v.style == VignetteStyle::ColorPriority {
                1.0
            } else {
                VIGNETTE_BRIGHTEN_TARGET
            };
            return Self::Blend {
                keep: RadialTable::new(|rho| 1.0 - strength(rho)),
                add: RadialTable::new(|rho| strength(rho) * target),
            };
        }
        if v.style == VignetteStyle::ColorPriority {
            return Self::Gain(RadialTable::new(|rho| {
                libm::pow(1.0 - strength(rho), VIGNETTE_GAMMA_COLOR)
            }));
        }
        let highlights = (v.highlights / 100.0).clamp(0.0, 1.0);
        Self::Root {
            strength: RadialTable::new(strength),
            highlights: if highlights > 0.0 {
                (libm::pow(highlights, VIGNETTE_HIGHLIGHTS_SHAPE) / VIGNETTE_HIGHLIGHTS_SPAN) as f32
            } else {
                0.0
            },
        }
    }
}

/// `paintOverlay`, on the sRGB-encoded output but in linear light.
enum OutputVignette {
    /// Darkening: `lin * keep`, `keep = (1 - k)^VIGNETTE_GAMMA_PAINT`. Above
    /// the sRGB toe that is `e' = root * (e + 0.055) - 0.055` with
    /// `root = keep^(1 / 2.4)` (no decode).
    Darken {
        root: RadialTable,
        keep: RadialTable,
    },
    /// Brightening: `lin * keep + add` (a blend toward white).
    Brighten { keep: RadialTable, add: RadialTable },
}

/// Uniform tables for the brightening paint overlay: the sRGB decode of
/// `i / PAINT_TABLE_STEPS`, and the sRGB encode of `(i / PAINT_TABLE_STEPS)^2`
/// (indexed by the square root of the linear value, which spreads the steep
/// start of the encode). Within 2e-6 of the exact functions.
struct PaintTables {
    decode: Vec<f32>,
    encode_of_square: Vec<f32>,
}

const PAINT_TABLE_STEPS: usize = 4096;

fn paint_tables() -> &'static PaintTables {
    static T: OnceLock<PaintTables> = OnceLock::new();
    T.get_or_init(|| {
        let at = |i: usize| i as f64 / PAINT_TABLE_STEPS as f64;
        PaintTables {
            decode: (0..=PAINT_TABLE_STEPS)
                .map(|i| crate::color::srgb_decode(at(i)) as f32)
                .collect(),
            encode_of_square: (0..=PAINT_TABLE_STEPS)
                .map(|i| crate::color::srgb_encode(at(i) * at(i)) as f32)
                .collect(),
        }
    })
}

/// `table` (of `PAINT_TABLE_STEPS + 1` values over `[0, 1]`) at `x`.
#[inline]
fn paint_table_at(table: &[f32], x: f32) -> f32 {
    let p = x.clamp(0.0, 1.0) * PAINT_TABLE_STEPS as f32;
    let i = (p as usize).min(PAINT_TABLE_STEPS - 1);
    table[i] + (table[i + 1] - table[i]) * (p - i as f32)
}

impl OutputVignette {
    /// The encoded value `e` with the vignette at `rho`.
    #[inline(always)]
    fn apply(&self, e: [f32; 3], rho: f32) -> [f32; 3] {
        match self {
            Self::Darken { root, keep } => {
                let r = root.eval(rho);
                let v = [
                    r * (e[0] + 0.055) - 0.055,
                    r * (e[1] + 0.055) - 0.055,
                    r * (e[2] + 0.055) - 0.055,
                ];
                let least = e[0].min(e[1]).min(e[2]).min(v[0]).min(v[1]).min(v[2]);
                if least > 0.040_45 {
                    v
                } else {
                    Self::darken_through_linear(e, keep.eval(rho))
                }
            }
            Self::Brighten { keep, add } => {
                let (k, a) = (keep.eval(rho), add.eval(rho));
                let t = paint_tables();
                let one = |c: f32| {
                    let lin = paint_table_at(&t.decode, c) * k + a;
                    paint_table_at(&t.encode_of_square, lin.max(0.0).sqrt())
                };
                [one(e[0]), one(e[1]), one(e[2])]
            }
        }
    }

    /// Darkening where a channel is in the sRGB toe (or falls into it).
    #[cold]
    #[inline(never)]
    fn darken_through_linear(e: [f32; 3], keep: f32) -> [f32; 3] {
        let t = paint_tables();
        let one = |c: f32| {
            let lin = paint_table_at(&t.decode, c) * keep;
            paint_table_at(&t.encode_of_square, lin.sqrt())
        };
        [one(e[0]), one(e[1]), one(e[2])]
    }

    fn paint(v: &VignetteSettings) -> Self {
        let vc = *v;
        let strength = move |rho: f64| vignette_strength(rho, &vc);
        if v.amount > 0.0 {
            Self::Brighten {
                keep: RadialTable::new(|rho| 1.0 - strength(rho)),
                add: RadialTable::new(strength),
            }
        } else {
            Self::Darken {
                root: RadialTable::new(|rho| {
                    libm::pow(1.0 - strength(rho), VIGNETTE_GAMMA_PAINT / 2.4)
                }),
                keep: RadialTable::new(|rho| libm::pow(1.0 - strength(rho), VIGNETTE_GAMMA_PAINT)),
            }
        }
    }
}

// MARK: - Grain

/// Encoded-value amplitude of the clumps (the coarse lattice, all of the
/// grain at `roughness = 100`) at `amount = 100`, times the field (variance
/// ~1 where the lattice is coarser than a pixel). Fitted to Lightroom's
/// round8 and round9 exports reduced to 2560 px (standard deviation of the
/// encoded luma in flat midtone tiles).
pub const GRAIN_AMPLITUDE: f64 = 0.0696;
/// Amplitude of the even grain (the fine lattice, all of the grain at
/// `roughness = 0`) relative to [`GRAIN_AMPLITUDE`]. `roughness` crossfades
/// the two amplitudes, `(1 - r) * GRAIN_EVEN_WEIGHT : r`, without
/// renormalizing: Lightroom's roughness 0 is an even, fine grain and 100
/// adds clumps (round9 at size 50 and 2560 px: standard deviation 0.025 ->
/// 0.036, autocorrelation half width 0.50 -> 0.94 px; roughness 70 sits on
/// the same line).
pub const GRAIN_EVEN_WEIGHT: f64 = 0.697;
/// Lattice spacing of the even grain relative to the long edge at
/// `size = 0` / `100`: `at_0 + (at_100 - at_0) * (size / 100)^GRAIN_SIZE_SHAPE`.
pub const GRAIN_EVEN_CELL_AT_SIZE_0: f64 = 1.0 / 6312.0;
pub const GRAIN_EVEN_CELL_AT_SIZE_100: f64 = 1.0 / 3200.0;
/// The same for the clumps. Fitted to the autocorrelation's half width of
/// Lightroom's grain (round8 and round9, 2560 px).
pub const GRAIN_CLUMP_CELL_AT_SIZE_0: f64 = 1.0 / 5120.0;
pub const GRAIN_CLUMP_CELL_AT_SIZE_100: f64 = 1.0 / 884.0;
pub const GRAIN_SIZE_SHAPE: f64 = 1.334;
/// Lattices finer than this spacing (relative to the long edge) get larger
/// values, `sqrt(1 + (GRAIN_FINE_BOOST_CELL / spacing)^2)`: Lightroom's
/// grain keeps its strength at a 2560 px view down to size 0 (0.045 x
/// amount / 100 at roughness 50 for sizes 0, 25 and 100), where a lattice of
/// unit variance averaged over a pixel would fade with its spacing.
pub const GRAIN_FINE_BOOST_CELL: f64 = 1.0 / 2381.0;
/// Tone weight in the deepest shadows and brightest highlights (the
/// midtones take 1): `t(y) = floor + (1 - floor) * 4y(1 - y)`. Lightroom's
/// grain has the same strength at every tone (round8: the encoded standard
/// deviation is flat from shadows to highlights but for the clip at 0 / 1).
pub const GRAIN_TONE_FLOOR: f32 = 1.0;
/// Width (pixels) of the footprint each pixel averages the field over. An
/// exact 1-pixel box would keep more variance than a larger frame reduced
/// by area averaging (a non-integer reduction adds a partial pixel of blur:
/// for 2048 -> 1280, white noise keeps 0.79 of its variance per axis, which
/// a 1.26-pixel box matches), so a frame looks like the export reduced.
/// It also sets the finest grain: an autocorrelation half width of 0.58 px
/// at any size (Lightroom's finest grain, slightly sharpened, reaches
/// 0.46 px at 2560 px; a 1-pixel box would reach 0.5 px but breaks the
/// reduction test above by 22 % in standard deviation).
pub const GRAIN_PIXEL_FOOTPRINT: f64 = 1.25;
/// Finest lattice spacing (pixels) a frame samples: a finer lattice is drawn
/// `k` times coarser with values `1/k` as large (`k` the smallest integer
/// reaching this spacing). Averaged over a footprint much larger than the
/// spacing, both have the same variance (`sigma^2 (s/F)^2` per pixel in
/// 2D), and the cost per pixel stays bounded (the size 0 lattices are
/// 1/6312 and 1/5120 of the long edge: 0.2 and 0.25 px at 1280 px).
pub const GRAIN_MIN_LATTICE_PX: f64 = GRAIN_PIXEL_FOOTPRINT / 4.0;
/// Seed when `grain.seed` is absent.
pub const GRAIN_DEFAULT_SEED: u32 = 0x4E49_484F;
/// Scales the lattice values (triangular on (-1, 1), variance 1/6) so the
/// continuous field has variance 1 on average: with the smooth-hat basis
/// the point variance is `(26/35)^2` of the lattice's, so
/// `sqrt(6 * 35^2 / 26^2)`.
const GRAIN_LATTICE_SCALE: f64 = 3.297_390_038_361_970_5;

/// `lowbias32` (Chris Wellons): an integer mix, the same on every target.
#[inline]
fn mix32(mut x: u32) -> u32 {
    x ^= x >> 16;
    x = x.wrapping_mul(0x7feb_352d);
    x ^= x >> 15;
    x = x.wrapping_mul(0x846c_a68b);
    x ^= x >> 16;
    x
}

/// The lattice value at `(i, j)` of `octave`: triangular on `(-1, 1)`
/// (the sum of the hash's two 16-bit halves), mean 0.
#[inline]
fn lattice_value(seed: u32, octave: u32, i: u32, j: u32) -> f32 {
    let mut h = seed ^ octave.wrapping_add(1).wrapping_mul(0x9e37_79b9);
    h = mix32(h ^ i.wrapping_mul(0x85eb_ca6b));
    h = mix32(h ^ j.wrapping_mul(0xc2b2_ae35));
    ((h & 0xffff) as f32 + (h >> 16) as f32 + 1.0) * (1.0 / 65536.0) - 1.0
}

/// `integral_{-inf}^{z} phi` for the smooth hat `phi(t) = 1 - smoothstep(|t|)`
/// on `[-1, 1]` (a partition of unity on the integer lattice).
#[inline]
fn smooth_hat_cdf(z: f64) -> f64 {
    if z <= -1.0 {
        return 0.0;
    }
    if z >= 1.0 {
        return 1.0;
    }
    let t = z.abs();
    let half = t - t * t * t + t * t * t * t / 2.0;
    if z < 0.0 {
        0.5 - half
    } else {
        0.5 + half
    }
}

/// For each pixel of one axis, the lattice points of spacing `step`
/// (pixels) whose smooth hats touch its footprint and their weights: the
/// exact mean of each hat over the footprint (the weights sum to 1). The
/// footprint is [`GRAIN_PIXEL_FOOTPRINT`] wide around the pixel's center.
/// Lattice indices are relative to `origin` (pixel 0's first, possibly
/// negative).
struct BoxWeights {
    origin: i64,
    /// First lattice index (relative) and count per pixel.
    span: Vec<(usize, usize)>,
    stride: usize,
    weights: Vec<f32>,
}

impl BoxWeights {
    fn new(n: usize, step: f64) -> Self {
        let half = GRAIN_PIXEL_FOOTPRINT / 2.0;
        // At most ceil(footprint / step) + 3 lattice points touch it.
        let stride = libm::ceil(GRAIN_PIXEL_FOOTPRINT / step) as usize + 3;
        let bounds = |p: usize| {
            let center = p as f64 + 0.5;
            ((center - half) / step, (center + half) / step)
        };
        // Hats centered in (a - 1, b + 1).
        let origin = libm::floor(bounds(0).0) as i64;
        let mut span = Vec::with_capacity(n);
        let mut weights = vec![0.0f32; n * stride];
        for p in 0..n {
            let (a, b) = bounds(p);
            let first = libm::floor(a) as i64;
            let count = ((libm::ceil(b) as i64 + 1 - first) as usize).min(stride);
            span.push(((first - origin) as usize, count));
            for k in 0..count {
                let i = (first + k as i64) as f64;
                weights[p * stride + k] = (step / GRAIN_PIXEL_FOOTPRINT
                    * (smooth_hat_cdf(b - i) - smooth_hat_cdf(a - i)))
                    as f32;
            }
        }
        Self {
            origin,
            span,
            stride,
            weights,
        }
    }

    #[inline]
    fn at(&self, p: usize) -> (usize, &[f32]) {
        let (first, count) = self.span[p];
        let offset = p * self.stride;
        (first, &self.weights[offset..offset + count])
    }

    /// Lattice points one row / column of values needs.
    fn lattice_len(&self) -> usize {
        self.span.last().map_or(0, |(first, count)| first + count)
    }
}

/// Adds `gain` times one octave (lattice `step` pixels, anchored at the
/// frame's top-left) to `plane`, each pixel the mean of the field over its
/// footprint: the separable weights run along the lattice rows first (each
/// row kept while output rows need it), then down the rows.
fn accumulate_octave(plane: &mut Plane, step: f64, seed: u32, octave: u32, gain: f32) {
    let (w, h) = (plane.width, plane.height);
    if w == 0 || h == 0 {
        return;
    }
    // Lattices much finer than a pixel ([`GRAIN_MIN_LATTICE_PX`]).
    let (step, gain) = if step < GRAIN_MIN_LATTICE_PX {
        let k = libm::ceil(GRAIN_MIN_LATTICE_PX / step);
        (step * k, gain / k as f32)
    } else {
        (step, gain)
    };
    let cols = BoxWeights::new(w, step);
    let rows = BoxWeights::new(h, step);
    let mut values = vec![0.0f32; cols.lattice_len()];
    let mut window: VecDeque<(usize, Vec<f32>)> = VecDeque::new();
    let mut spare: Vec<Vec<f32>> = Vec::new();
    for (y, out) in plane.data.chunks_exact_mut(w).enumerate() {
        let (j0, wy) = rows.at(y);
        while window.front().is_some_and(|(j, _)| *j < j0) {
            spare.push(window.pop_front().expect("front").1);
        }
        let next = window.back().map_or(j0, |(j, _)| j + 1);
        for j in next..j0 + wy.len() {
            // Lattice indices wrap into the hash's u32 (negative ones too).
            let lattice_j = (rows.origin + j as i64) as u32;
            for (i, v) in values.iter_mut().enumerate() {
                let lattice_i = (cols.origin + i as i64) as u32;
                *v = lattice_value(seed, octave, lattice_i, lattice_j);
            }
            let mut row = spare.pop().unwrap_or_else(|| vec![0.0; w]);
            for (x, dst) in row.iter_mut().enumerate() {
                let (i0, wx) = cols.at(x);
                let mut sum = 0.0f32;
                for (v, k) in values[i0..i0 + wx.len()].iter().zip(wx) {
                    sum += v * k;
                }
                *dst = sum;
            }
            window.push_back((j, row));
        }
        for ((_, row), k) in window.iter().zip(wy) {
            if *k == 0.0 {
                continue;
            }
            let g = gain * k;
            for (dst, v) in out.iter_mut().zip(row) {
                *dst += g * v;
            }
        }
    }
}

/// The seed a frame uses.
pub fn grain_seed(g: &GrainSettings) -> u32 {
    g.seed.map_or(GRAIN_DEFAULT_SEED, |s| s as u32)
}

/// The grain field of a `w x h` frame: mean 0, variance ~1 for the clumps
/// alone where their lattice is coarser than a pixel (lower where it is
/// finer, as when a larger frame is reduced).
///
/// Two lattices of value noise fixed to the photo: the even grain, spacing
/// `GRAIN_EVEN_CELL_AT_SIZE_0 + (GRAIN_EVEN_CELL_AT_SIZE_100 -
/// GRAIN_EVEN_CELL_AT_SIZE_0) * (size / 100)^GRAIN_SIZE_SHAPE` of the long
/// edge, and the clumps (`GRAIN_CLUMP_CELL_*` likewise), with the
/// amplitudes `GRAIN_EVEN_WEIGHT * (1 - r)` and `r` (`r = roughness / 100`)
/// times each lattice's boost ([`GRAIN_FINE_BOOST_CELL`]). Lattice values
/// come from an integer hash of the seed, the lattice and its indices.
pub fn grain_field(w: usize, h: usize, g: &GrainSettings) -> Plane {
    let mut plane = Plane::new(w, h);
    let long = w.max(h) as f64;
    let shape = libm::pow((g.size / 100.0).clamp(0.0, 1.0), GRAIN_SIZE_SHAPE);
    let r = (g.roughness / 100.0).clamp(0.0, 1.0);
    let seed = grain_seed(g);
    let lattices = [
        (
            GRAIN_EVEN_CELL_AT_SIZE_0,
            GRAIN_EVEN_CELL_AT_SIZE_100,
            GRAIN_EVEN_WEIGHT * (1.0 - r),
        ),
        (GRAIN_CLUMP_CELL_AT_SIZE_0, GRAIN_CLUMP_CELL_AT_SIZE_100, r),
    ];
    for (octave, (at_0, at_100, weight)) in lattices.into_iter().enumerate() {
        if weight > 0.0 {
            let cell = at_0 + (at_100 - at_0) * shape;
            let fine = GRAIN_FINE_BOOST_CELL / cell;
            let boost = libm::sqrt(1.0 + fine * fine);
            accumulate_octave(
                &mut plane,
                cell * long,
                seed,
                octave as u32,
                (weight * boost * GRAIN_LATTICE_SCALE) as f32,
            );
        }
    }
    plane
}

// MARK: - Frames

#[derive(Debug, Clone, Copy, PartialEq)]
struct RadiusKey {
    w: usize,
    h: usize,
    roundness: u64,
}

#[derive(Debug, Clone, Copy, PartialEq)]
struct GrainKey {
    w: usize,
    h: usize,
    size: u64,
    roughness: u64,
    seed: u32,
}

/// The planes of the effects, kept by a [`crate::Session`] across frames:
/// the vignette radius (`w`, `h`, `roundness`) and the grain field (`w`,
/// `h`, `size`, `roughness`, `seed`). `amount` (and the vignette's
/// midpoint / feather / style) never rebuild them.
#[derive(Default)]
pub struct EffectsCache {
    radius: Option<(RadiusKey, Plane)>,
    grain: Option<(GrainKey, Plane)>,
}

/// The encoded-output stage of a frame: `paintOverlay` vignette (in linear
/// light), then grain, then the `[0, 1]` clamp.
pub struct OutputEffects<'a> {
    vignette: Option<(&'a [f32], OutputVignette)>,
    grain: Option<(&'a [f32], f32)>,
}

impl OutputEffects<'_> {
    /// Pixel `i`'s sRGB-encoded `[0, 1]` value with the effects.
    #[inline(always)]
    pub fn apply(&self, e: [f32; 3], i: usize) -> [f32; 3] {
        let mut e = e;
        if let Some((radius, style)) = &self.vignette {
            e = style.apply(e, radius[i]);
        }
        if let Some((field, amplitude)) = &self.grain {
            let y =
                (e[0] * REC709_LUMA_F32[0] + e[1] * REC709_LUMA_F32[1] + e[2] * REC709_LUMA_F32[2])
                    .clamp(0.0, 1.0);
            let tone = GRAIN_TONE_FLOOR + (1.0 - GRAIN_TONE_FLOOR) * 4.0 * y * (1.0 - y);
            let d = amplitude * field[i] * tone;
            e = [e[0] + d, e[1] + d, e[2] + d];
        }
        clamp01(e)
    }
}

/// The effects of one frame (`w x h`, the frame drawn).
pub struct FrameEffects<'a> {
    /// `highlightPriority` / `colorPriority` vignette (applied by the
    /// pipeline after the local pass, before the tone cubes).
    pub linear: Option<LinearVignette<'a>>,
    /// The encoded-output stage (`None` when nothing acts there).
    pub output: Option<OutputEffects<'a>>,
    /// `Rendered.approximations` entries.
    pub approximations: Vec<&'static str>,
}

/// Prepares the effects of `s` for a `w x h` frame, building (or reusing)
/// the planes in `cache`.
pub fn prepare<'a>(
    s: &DevelopSettings,
    w: usize,
    h: usize,
    cache: &'a mut EffectsCache,
) -> FrameEffects<'a> {
    let v = &s.vignette;
    let g = &s.grain;
    if v.is_active() {
        let key = RadiusKey {
            w,
            h,
            roundness: v.roundness.to_bits(),
        };
        if cache.radius.as_ref().map(|(k, _)| *k) != Some(key) {
            cache.radius = None;
            cache.radius = Some((key, vignette_radius(w, h, v.roundness)));
        }
    }
    if g.is_active() {
        let key = GrainKey {
            w,
            h,
            size: g.size.to_bits(),
            roughness: g.roughness.to_bits(),
            seed: grain_seed(g),
        };
        if cache.grain.as_ref().map(|(k, _)| *k) != Some(key) {
            cache.grain = None;
            cache.grain = Some((key, grain_field(w, h, g)));
        }
    }
    let cache: &'a EffectsCache = cache;
    let mut approximations = Vec::new();
    let mut linear = None;
    let mut output_vignette = None;
    if v.is_active() {
        // `highlights` acts on a darkening highlight-priority vignette (as
        // measured). Lightroom also offers it for color priority, which
        // keeps the value only here; its paint overlay and brightening
        // vignettes have none.
        if v.highlights != 0.0 && v.amount < 0.0 && v.style == VignetteStyle::ColorPriority {
            approximations.push("vignetteHighlightContrast");
        }
        let radius = cache
            .radius
            .as_ref()
            .expect("vignette radius")
            .1
            .data
            .as_slice();
        match v.style {
            VignetteStyle::HighlightPriority | VignetteStyle::ColorPriority => {
                linear = Some(LinearVignette {
                    radius,
                    law: LinearLaw::new(v),
                });
            }
            VignetteStyle::PaintOverlay => {
                output_vignette = Some((radius, OutputVignette::paint(v)));
            }
        }
    }
    let grain = g.is_active().then(|| {
        (
            cache.grain.as_ref().expect("grain field").1.data.as_slice(),
            (g.amount / 100.0 * GRAIN_AMPLITUDE) as f32,
        )
    });
    let output = (output_vignette.is_some() || grain.is_some()).then_some(OutputEffects {
        vignette: output_vignette,
        grain,
    });
    FrameEffects {
        linear,
        output,
        approximations,
    }
}

#[inline]
fn clamp01(v: [f32; 3]) -> [f32; 3] {
    [
        v[0].clamp(0.0, 1.0),
        v[1].clamp(0.0, 1.0),
        v[2].clamp(0.0, 1.0),
    ]
}

/// sRGB-encodes a linear `[0, 1]` value through the power table (the final
/// frame's output stage when effects act on the encoded value).
#[inline]
pub fn encode_srgb3(v: [f32; 3]) -> [f32; 3] {
    let t = srgb_encode_power();
    let one = |x: f32| {
        if x <= 0.003_130_8 {
            x * 12.92
        } else {
            1.055 * t.eval(x) - 0.055
        }
    };
    [one(v[0]), one(v[1]), one(v[2])]
}

#[cfg(test)]
mod tests {
    use super::*;

    fn stats(values: &[f32]) -> (f64, f64) {
        let n = values.len() as f64;
        let mean = values.iter().map(|v| *v as f64).sum::<f64>() / n;
        let var = values
            .iter()
            .map(|v| (*v as f64 - mean).powi(2))
            .sum::<f64>()
            / n;
        (mean, var.sqrt())
    }

    #[test]
    fn smooth_hat_weights_sum_to_one() {
        for step in [0.27, 0.5, 0.9, 1.0, 1.6, 4.2, 17.0] {
            let bw = BoxWeights::new(50, step);
            for p in 0..50 {
                let (_, w) = bw.at(p);
                let sum: f32 = w.iter().sum();
                assert!((sum - 1.0).abs() < 1e-5, "step {step} p {p}: {sum}");
                assert!(w.iter().all(|k| *k >= -1e-7), "step {step}: {w:?}");
            }
        }
    }

    #[test]
    fn lattice_values_are_zero_mean_with_variance_one_sixth() {
        let values: Vec<f32> = (0..200_000u32)
            .map(|k| lattice_value(7, 0, k % 500, k / 500))
            .collect();
        let (mean, sd) = stats(&values);
        assert!(mean.abs() < 0.005, "{mean}");
        assert!((sd * sd - 1.0 / 6.0).abs() < 0.005, "{}", sd * sd);
    }

    #[test]
    fn coarse_grain_field_has_unit_variance() {
        // The clumps alone (roughness 100) at size 100 and 3000 px: a 3.4 px
        // lattice, point sampling nearly (variance 0.92 of the lattice's)
        // with a boost of 1.07.
        let mut g = GrainSettings {
            amount: 50.0,
            size: 100.0,
            roughness: 100.0,
            seed: Some(3.0),
        };
        let field = grain_field(3000, 2000, &g);
        let (mean, clumps) = stats(&field.data);
        assert!(mean.abs() < 0.02, "{mean}");
        assert!((clumps - 1.02).abs() < 0.08, "{clumps}");
        // Roughness 0 is the even grain alone: finer and weaker, and
        // roughness crossfades the two amplitudes.
        g.roughness = 0.0;
        let (_, even) = stats(&grain_field(3000, 2000, &g).data);
        assert!(even > 0.4 && even < clumps * 0.8, "{even} {clumps}");
        g.roughness = 50.0;
        let (_, both) = stats(&grain_field(3000, 2000, &g).data);
        let expected = libm::sqrt(even * even + clumps * clumps) / 2.0;
        assert!((both / expected - 1.0).abs() < 0.05, "{both} {expected}");
    }

    #[test]
    fn fine_grain_keeps_its_strength_down_to_size_0() {
        // At 2560 px the lattices of sizes 0..50 are finer than a pixel: the
        // boost keeps the field's strength (Lightroom: the same standard
        // deviation at roughness 50 for sizes 0, 25 and 100).
        let sd = |size: f64| {
            let g = GrainSettings {
                amount: 50.0,
                size,
                roughness: 50.0,
                seed: Some(3.0),
            };
            stats(&grain_field(1280, 854, &g).data).1
        };
        let (s0, s25, s100) = (sd(0.0), sd(25.0), sd(100.0));
        // A quarter of the 2560 px frame, so half the pixels per lattice
        // spacing: fine lattices lose about half, as a reduced frame does.
        assert!((s25 / s0 - 1.0).abs() < 0.15, "{s0} {s25}");
        assert!(s100 > s0 && s100 < 2.2 * s0, "{s0} {s100}");
    }

    #[test]
    fn vignette_radius_is_zero_at_the_center_and_one_at_the_corners() {
        for roundness in [-100.0, -40.0, 0.0, 60.0, 100.0] {
            let p = vignette_radius(301, 201, roundness);
            let at = |x: usize, y: usize| p.data[y * 301 + x];
            assert!(at(150, 100) < 1e-6, "{roundness}");
            // The corner pixel's center is half a pixel inside the corner
            // (further in the rounded rectangle's units: its corner radius
            // is 16 px at -100).
            let least = if roundness < 0.0 { 0.95 } else { 0.98 };
            assert!(
                at(0, 0) > least && at(0, 0) <= 1.0,
                "{roundness}: {}",
                at(0, 0)
            );
            assert_eq!(at(0, 0), at(300, 200));
            assert_eq!(at(0, 100), at(300, 100));
        }
        // Circle: equal pixel distances are equal radii.
        let c = vignette_radius(400, 200, 100.0);
        let d_right = c.data[100 * 400 + 299]; // 99.5 px right of the center
        let d_down = c.data[199 * 400 + 200]; // 99 px + half below
        assert!((d_right - d_down).abs() < 0.01, "{d_right} {d_down}");
        // Ellipse: the edge midpoints are equal radii.
        let e = vignette_radius(400, 200, 0.0);
        assert!((e.data[100 * 400 + 399] - e.data[199 * 400 + 200]).abs() < 0.01);
        // Rounded rectangle: the same radius at the same pixels from the
        // long and the short edge (the falloff runs parallel to the edges),
        // and the edge midpoints are on the inscribed shape (1 / sqrt 2).
        // (3:2: the corners are circles from about -37 on; a wider frame
        // keeps elliptical corners longer.)
        for roundness in [-50.0, -100.0] {
            let b = vignette_radius(600, 400, roundness);
            let at = |x: usize, y: usize| b.data[y * 600 + x];
            assert!((at(589, 200) - at(300, 389)).abs() < 1e-6, "{roundness}");
            assert!(
                (at(599, 200) - std::f32::consts::FRAC_1_SQRT_2).abs() < 0.03,
                "{roundness}"
            );
            assert!(
                at(300, 200) < 0.0,
                "{roundness}: the center is inside the inner box"
            );
        }
        // Just below 0 it is still nearly the ellipse.
        let near = vignette_radius(400, 200, -1.0);
        let max = near
            .data
            .iter()
            .zip(&e.data)
            .map(|(a, b)| (a - b).abs())
            .fold(0.0f32, f32::max);
        assert!(max < 0.02, "{max}");
    }

    #[test]
    fn vignette_mask_follows_midpoint_and_feather() {
        let mut v = VignetteSettings {
            amount: -60.0,
            ..VignetteSettings::default()
        };
        assert_eq!(vignette_mask(0.0, &v), 0.0);
        // The default falloff: half way at rho 0.665 (inside the ellipse
        // inscribed in the frame, 0.707), the corners at the whole amount.
        assert!((vignette_mask(0.665, &v) - 0.5).abs() < 0.01);
        assert_eq!(vignette_mask(1.0, &v), 1.0);
        assert!(vignette_mask(0.3, &v) < 0.02);
        // Midpoint 100: the corners only, and they still take it whole.
        v.midpoint = 100.0;
        assert!(vignette_mask(0.7, &v) < 0.05);
        assert!(vignette_mask(0.9, &v) < 0.3);
        assert_eq!(vignette_mask(1.0, &v), 1.0);
        // ... and nothing when its hard edge lies past the corners.
        v.feather = 0.0;
        assert_eq!(vignette_mask(1.0, &v), 0.0);
        v.feather = 50.0;
        // Midpoint 0 reaches far in, but never the center.
        v.midpoint = 0.0;
        assert!(vignette_mask(0.45, &v) > 0.45);
        assert_eq!(vignette_mask(0.0, &v), 0.0);
        // feather 0: a hard edge at the ellipse inscribed in the frame.
        v.midpoint = 50.0;
        v.feather = 0.0;
        assert_eq!(vignette_mask(0.70, &v), 0.0);
        assert_eq!(vignette_mask(0.71, &v), 1.0);
        v.feather = 100.0;
        assert_eq!(vignette_mask(0.0, &v), 0.0);
        assert!(vignette_mask(0.74, &v) > 0.45 && vignette_mask(0.74, &v) < 0.55);
        // A brightening vignette's falloff sits further out, and so does a
        // darkening one past -60.
        v.feather = 50.0;
        let dark = vignette_mask(0.7, &v);
        v.amount = 60.0;
        assert!(vignette_mask(0.7, &v) < dark - 0.1);
        v.amount = -30.0;
        assert_eq!(vignette_mask(0.7, &v), dark);
        v.amount = -100.0;
        assert!(vignette_mask(0.7, &v) < dark - 0.05);
        assert_eq!(vignette_mask(1.0, &v), 1.0);
    }

    #[test]
    fn paint_overlay_blends_in_linear_light() {
        use crate::color::{srgb_decode, srgb_encode};
        let paint = |amount: f64| {
            OutputVignette::paint(&VignetteSettings {
                amount,
                style: VignetteStyle::PaintOverlay,
                ..VignetteSettings::default()
            })
        };
        for amount in [-100.0, -60.0, -20.0, 30.0, 60.0, 100.0] {
            let p = paint(amount);
            let settings = VignetteSettings {
                amount,
                ..VignetteSettings::default()
            };
            for rho in [0.0f32, 0.4, 0.6, 0.7, 0.8, 0.9, 1.0] {
                let k = vignette_strength(rho as f64, &settings);
                for i in 0..=50 {
                    let e = i as f32 / 50.0;
                    let lin = srgb_decode(e as f64);
                    let expected = if amount < 0.0 {
                        srgb_encode(lin * libm::pow(1.0 - k, VIGNETTE_GAMMA_PAINT))
                    } else {
                        srgb_encode(lin * (1.0 - k) + k)
                    };
                    let got = p.apply([e; 3], rho)[0] as f64;
                    assert!(
                        (got - expected).abs() < 2e-4,
                        "amount {amount} rho {rho} e {e}: {got} vs {expected}"
                    );
                }
            }
            // The center is untouched; -100 / +100 reach black / white.
            assert!((p.apply([0.5; 3], 0.0)[0] - 0.5).abs() < 1e-5, "{amount}");
        }
        assert_eq!(paint(-100.0).apply([0.8; 3], 1.0), [0.0; 3]);
        assert!((paint(100.0).apply([0.2; 3], 1.0)[0] - 1.0).abs() < 1e-5);
    }

    #[test]
    fn vignette_laws_darken_to_black_and_brighten_toward_white() {
        let radius = [0.0f32, 1.0];
        let law = |amount: f64, style: VignetteStyle| LinearVignette {
            radius: &radius,
            law: LinearLaw::new(&VignetteSettings {
                amount,
                style,
                ..VignetteSettings::default()
            }),
        };
        let gray = [0.18f32; 3];
        for style in [
            VignetteStyle::HighlightPriority,
            VignetteStyle::ColorPriority,
        ] {
            for amount in [-100.0, -50.0, 50.0, 100.0] {
                // The center (mask 0) is untouched.
                assert_eq!(
                    law(amount, style).apply(gray, 0.0),
                    gray,
                    "{style:?} {amount}"
                );
            }
            // -100 is black and +100 white where the mask is 1.
            assert_eq!(law(-100.0, style).apply(gray, 1.0), [0.0; 3], "{style:?}");
            let white = law(100.0, style).apply(gray, 1.0);
            assert!(
                white.iter().all(|c| (c - 1.0).abs() < 1e-3),
                "{style:?} {white:?}"
            );
            // White and values past it do not grow.
            assert_eq!(
                law(100.0, style).apply([1.0, 1.5, 0.5], 1.0)[..2],
                [1.0, 1.5]
            );
        }
        // Color priority, -50: the gain 0.5^VIGNETTE_GAMMA_COLOR.
        let c = law(-50.0, VignetteStyle::ColorPriority).apply(gray, 1.0)[0] as f64;
        assert!(
            (c / 0.18 - libm::pow(0.5, VIGNETTE_GAMMA_COLOR)).abs() < 1e-3,
            "{c}"
        );
        // Highlight priority, -50: (0.5 sqrt(v) - offset / 2)^2, so shadows
        // lose more stops than highlights.
        let h = law(-50.0, VignetteStyle::HighlightPriority);
        let expect = |v: f64| libm::pow(0.5 * libm::sqrt(v) - VIGNETTE_ROOT_OFFSET * 0.5, 2.0);
        for v in [0.02f32, 0.18, 0.8] {
            let got = h.apply([v; 3], 1.0)[0] as f64;
            assert!((got - expect(v as f64)).abs() < 1e-4, "{v}: {got}");
        }
        let stops = |v: f32| (h.apply([v; 3], 1.0)[0] / v).log2();
        assert!(stops(0.02) < stops(0.8) - 0.5);
        // Highlights: a bright pixel takes less of the vignette, a dark one
        // all of it, and a brightening vignette none of the slider.
        let with = |amount: f64, highlights: f64| LinearVignette {
            radius: &radius,
            law: LinearLaw::new(&VignetteSettings {
                amount,
                highlights,
                ..VignetteSettings::default()
            }),
        };
        let (plain, half, full) = (with(-60.0, 0.0), with(-60.0, 50.0), with(-60.0, 100.0));
        let at = |l: &LinearVignette, v: f32| l.apply([v; 3], 1.0)[0];
        assert_eq!(at(&full, 0.1), at(&plain, 0.1));
        assert!(at(&half, 0.5) > at(&plain, 0.5) * 1.5);
        assert!(at(&full, 0.5) > at(&half, 0.5) * 1.3);
        // At 100 the brightest pixels stay as they are.
        assert_eq!(at(&full, 0.9), 0.9);
        assert!(at(&half, 0.9) < 0.9);
        assert_eq!(at(&with(60.0, 100.0), 0.5), at(&with(60.0, 0.0), 0.5));
        // Brightening: highlight priority lifts more than color priority.
        let lift = |style| law(50.0, style).apply(gray, 1.0)[0];
        assert!(lift(VignetteStyle::HighlightPriority) > lift(VignetteStyle::ColorPriority));
        assert!(lift(VignetteStyle::ColorPriority) > 0.3);
    }
}
