//! Local adjustments (`masks`, Epic #31) drawn: the per-mask plane, the
//! local settings and the fixed-point blend (M2 = #66). The contract is
//! `docs/local-adjustments.md` ("座標", "面の式", "局所の補正", "描画と混ぜ方");
//! the layered render around it is `Session::render` (`mask_session.rs`).
//!
//! - [`SourceMap`]: an output pixel's centre `((i + 0.5) / W, (j + 0.5) / H)`
//!   back to the working image `(u, v)` (`0..1`, EXIF orientation applied,
//!   before the geometry), the same map as TypeScript's
//!   `geometryOutputToSource` (`tests/fixtures/masks/geometry-map-cases.json`
//!   holds its values; both sides check them).
//! - [`mask_weights`]: the plane `m` of one mask in `f32` with IEEE `+ - * /
//!   sqrt` only (the radial angle's sine and cosine once per mask, `libm`), so
//!   native and wasm agree bit for bit, quantised to `w = floor(m * 65536 +
//!   0.5)` (`0..=65536`, one `u32` per output pixel).
//! - [`local_settings`]: the global settings plus a mask's `adjust`, clamped
//!   to the global ranges.
//! - [`blend`]: `out = clamp(R0 + sum_k ((R_k - R0) * w_k + 32768) >> 16, 0,
//!   255)` per 8-bit channel (`i32`, arithmetic shift), alpha 255; the sum is
//!   independent of the masks' order.

use crate::geometry::Geometry;
use crate::local_mask::{LocalAdjust, LocalMask, MaskShape};
use crate::settings::{DevelopSettings, WhiteBalanceMode};

/// The weight of `m = 1`.
pub const FULL_WEIGHT: u32 = 65536;
/// `radial` with `feather` 0: the edge still blends over `0.2 %` of the
/// radius (about one pixel), so the plane has no aliased step.
const MIN_RADIAL_FEATHER: f32 = 0.002;

/// Maps output pixel centres to working-image positions (`u`, `v` in `0..1`
/// of the working image's width and height, y down) through a geometry:
/// the crop on the frame (a turned crop whose corners leave the frame
/// shrunk about its centre, as the renderer does), then the flips undone,
/// then the quarter turn undone. Without a geometry (or an identity one)
/// the output is the working image itself.
#[derive(Debug, Clone, PartialEq)]
pub struct SourceMap {
    /// The working image's size (`Ws x Hs`).
    width: f64,
    height: f64,
    turned: Option<TurnedMap>,
}

#[derive(Debug, Clone, PartialEq)]
struct TurnedMap {
    rotate: u32,
    flip_h: bool,
    flip_v: bool,
    /// The frame (the working image turned by `rotate`).
    frame_width: f64,
    frame_height: f64,
    /// The crop box on the frame: its centre and size.
    cx: f64,
    cy: f64,
    box_width: f64,
    box_height: f64,
    /// The crop's axes on the frame: `(cos a, sin a)` and `(-sin a, cos a)`.
    u: [f64; 2],
    v: [f64; 2],
}

/// The crop does not make a rectangle on this frame (the renderer's
/// `geometry.crop` / `invalidCrop`).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct InvalidCrop;

impl SourceMap {
    /// The map of `geometry` (`None`: none) on a `width x height` working
    /// image. Follows TypeScript's `geometryOutputToSource` operation by
    /// operation.
    pub fn new(
        geometry: Option<&Geometry>,
        width: usize,
        height: usize,
    ) -> Result<Self, InvalidCrop> {
        let (sw, sh) = (width as f64, height as f64);
        let Some(g) = geometry.filter(|g| !g.is_identity()) else {
            return Ok(Self {
                width: sw,
                height: sh,
                turned: None,
            });
        };
        let rotate = g.rotate % 360;
        let (fw, fh) = if rotate % 180 == 90 {
            (sh, sw)
        } else {
            (sw, sh)
        };
        let theta = g.angle * core::f64::consts::PI / 180.0;
        let (cos, sin) = (libm::cos(theta), libm::sin(theta));
        let u = [cos, sin];
        let v = [-sin, cos];
        let c = &g.crop;
        let left = c.left * fw;
        let top = c.top * fh;
        let dx = c.right * fw - left;
        let dy = c.bottom * fh - top;
        let cx = left + dx / 2.0;
        let cy = top + dy / 2.0;
        let mut box_width = dx * u[0] + dy * u[1];
        let mut box_height = dx * v[0] + dy * v[1];
        if !(box_width > 0.0 && box_height > 0.0) {
            return Err(InvalidCrop);
        }
        if g.angle != 0.0 {
            if !(cx > 0.0 && cx < fw && cy > 0.0 && cy < fh) {
                return Err(InvalidCrop);
            }
            // The inscribed scale (TypeScript `inscribedScale`).
            let (ac, asn) = (u[0].abs(), u[1].abs());
            let ex = (box_width * ac + box_height * asn) / 2.0;
            let ey = (box_width * asn + box_height * ac) / 2.0;
            let mut scale = 1.0f64;
            if cx + ex > fw {
                scale = scale.min((fw - cx) / ex);
            }
            if cx - ex < 0.0 {
                scale = scale.min(cx / ex);
            }
            if cy + ey > fh {
                scale = scale.min((fh - cy) / ey);
            }
            if cy - ey < 0.0 {
                scale = scale.min(cy / ey);
            }
            if scale < 1.0 {
                box_width *= scale;
                box_height *= scale;
            }
        }
        Ok(Self {
            width: sw,
            height: sh,
            turned: Some(TurnedMap {
                rotate,
                flip_h: g.flip_h,
                flip_v: g.flip_v,
                frame_width: fw,
                frame_height: fh,
                cx,
                cy,
                box_width,
                box_height,
                u,
                v,
            }),
        })
    }

    /// `A = Ws / Hs` (lengths of the plane in units of the image height).
    pub fn aspect(&self) -> f64 {
        self.width / self.height
    }

    /// The working-image position `(u, v)` of output position `(px, py)`
    /// (`0..1` of the output; a pixel centre is `(i + 0.5) / W`).
    #[inline]
    pub fn source_of(&self, px: f64, py: f64) -> [f64; 2] {
        let Some(t) = &self.turned else {
            return [px, py];
        };
        let a = (px - 0.5) * t.box_width;
        let b = (py - 0.5) * t.box_height;
        let mut x = t.cx + a * t.u[0] + b * t.v[0];
        let mut y = t.cy + a * t.u[1] + b * t.v[1];
        if t.flip_h {
            x = t.frame_width - x;
        }
        if t.flip_v {
            y = t.frame_height - y;
        }
        let (sx, sy) = match t.rotate {
            90 => (y, self.height - x),
            180 => (self.width - x, self.height - y),
            270 => (self.width - y, x),
            _ => (x, y),
        };
        [sx / self.width, sy / self.height]
    }

    /// What the planes of this map depend on (a cache key).
    pub fn key(&self) -> String {
        format!("{self:?}")
    }
}

/// A mask the plane cannot be made for.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum PlaneError {
    /// A `brush` / `subject` / `sky` mask: its surface is not in this build
    /// (the surface store is M4, #68). Holds the mask id.
    SurfaceMissing(String),
}

/// One mask's shape in plane units (`X = u * A`, `Y = v`), `f32`.
#[derive(Debug, Clone, Copy)]
enum Shape {
    Linear {
        zx: f32,
        zy: f32,
        dx: f32,
        dy: f32,
        /// `dx^2 + dy^2`.
        den: f32,
    },
    Radial {
        cx: f32,
        cy: f32,
        cos: f32,
        sin: f32,
        a: f32,
        b: f32,
        /// `max(feather / 100, 0.002)`.
        f: f32,
    },
}

impl Shape {
    fn of(mask: &LocalMask, aspect: f64) -> Result<Self, PlaneError> {
        match &mask.shape {
            MaskShape::Linear { zero, full } => {
                let (zx, zy) = ((zero.x * aspect) as f32, zero.y as f32);
                let (fx, fy) = ((full.x * aspect) as f32, full.y as f32);
                let (dx, dy) = (fx - zx, fy - zy);
                Ok(Shape::Linear {
                    zx,
                    zy,
                    dx,
                    dy,
                    den: dx * dx + dy * dy,
                })
            }
            MaskShape::Radial {
                center,
                radius_x,
                radius_y,
                angle,
                feather,
            } => {
                let theta = angle * core::f64::consts::PI / 180.0;
                Ok(Shape::Radial {
                    cx: (center.x * aspect) as f32,
                    cy: center.y as f32,
                    cos: libm::cos(theta) as f32,
                    sin: libm::sin(theta) as f32,
                    a: (radius_x * aspect) as f32,
                    b: *radius_y as f32,
                    f: ((feather / 100.0) as f32).max(MIN_RADIAL_FEATHER),
                })
            }
            MaskShape::Surface(_) => Err(PlaneError::SurfaceMissing(mask.id.clone())),
        }
    }

    /// `m` (`0..1`) at plane point `(x, y)`, before `invert`.
    #[inline(always)]
    fn value(&self, x: f32, y: f32) -> f32 {
        match *self {
            Shape::Linear {
                zx,
                zy,
                dx,
                dy,
                den,
            } => (((x - zx) * dx + (y - zy) * dy) / den).clamp(0.0, 1.0),
            Shape::Radial {
                cx,
                cy,
                cos,
                sin,
                a,
                b,
                f,
            } => {
                let (ox, oy) = (x - cx, y - cy);
                let px = ox * cos + oy * sin;
                let py = -ox * sin + oy * cos;
                let (qx, qy) = (px / a, py / b);
                let r = (qx * qx + qy * qy).sqrt();
                let s = ((1.0 - r) / f).clamp(0.0, 1.0);
                s * s * (3.0 - 2.0 * s)
            }
        }
    }
}

/// `w = floor(m * 65536 + 0.5)` (`m` in `0..1`).
#[inline(always)]
pub fn weight_of(m: f32) -> u32 {
    libm::floor(f64::from(m) * f64::from(FULL_WEIGHT) + 0.5) as u32
}

/// The 8-bit overlay value of a weight: `round(w / 65536 * 255)`.
#[inline(always)]
pub fn weight_to_u8(weight: u32) -> u8 {
    ((weight * 255 + FULL_WEIGHT / 2) >> 16) as u8
}

/// What a mask's plane depends on besides the map and the output size.
pub fn shape_key(mask: &LocalMask) -> String {
    format!("{:?}|{}", mask.shape, mask.invert)
}

/// The blend weights of `mask` on a `width x height` output whose pixels
/// `map` places on the working image ([`weight_of`] per pixel, row-major).
/// `enabled` and `adjust` are not read (the caller decides what is drawn).
pub fn mask_weights(
    mask: &LocalMask,
    map: &SourceMap,
    width: usize,
    height: usize,
) -> Result<Vec<u32>, PlaneError> {
    let aspect = map.aspect();
    let shape = Shape::of(mask, aspect)?;
    let columns: Vec<f64> = (0..width)
        .map(|i| (i as f64 + 0.5) / width as f64)
        .collect();
    let mut weights = Vec::with_capacity(width * height);
    for j in 0..height {
        let py = (j as f64 + 0.5) / height as f64;
        for &px in &columns {
            let [u, v] = map.source_of(px, py);
            let m = shape.value((u * aspect) as f32, v as f32);
            let m = if mask.invert { 1.0 - m } else { m };
            weights.push(weight_of(m));
        }
    }
    Ok(weights)
}

/// The local settings of a mask: `global` (without `masks`) plus `adjust`,
/// each key clamped to its global range; `hsl` per band and component
/// within ±100. A relative white-balance delta adds to a `relative` white
/// balance and turns an `asShot` one into `relative` with only the delta
/// (validation refuses the delta with an `absolute` one, `localWhiteBalance`).
pub fn local_settings(global: &DevelopSettings, adjust: &LocalAdjust) -> DevelopSettings {
    let mut s = global.clone();
    s.masks.clear();
    let add = |value: f64, delta: f64, lo: f64, hi: f64| (value + delta).clamp(lo, hi);
    s.exposure = add(s.exposure, adjust.exposure, -5.0, 5.0);
    for (value, delta) in [
        (&mut s.contrast, adjust.contrast),
        (&mut s.highlights, adjust.highlights),
        (&mut s.shadows, adjust.shadows),
        (&mut s.whites, adjust.whites),
        (&mut s.blacks, adjust.blacks),
        (&mut s.texture, adjust.texture),
        (&mut s.clarity, adjust.clarity),
        (&mut s.dehaze, adjust.dehaze),
        (&mut s.vibrance, adjust.vibrance),
        (&mut s.saturation, adjust.saturation),
    ] {
        *value = add(*value, delta, -100.0, 100.0);
    }
    if adjust.relative_temperature != 0.0 || adjust.relative_tint != 0.0 {
        match s.white_balance.mode {
            WhiteBalanceMode::Relative => {}
            WhiteBalanceMode::AsShot => {
                s.white_balance.mode = WhiteBalanceMode::Relative;
                s.relative_temperature = 0.0;
                s.relative_tint = 0.0;
            }
            // Refused by validation; left as the global one.
            WhiteBalanceMode::Absolute => return s,
        }
        s.relative_temperature = add(
            s.relative_temperature,
            adjust.relative_temperature,
            -100.0,
            100.0,
        );
        s.relative_tint = add(s.relative_tint, adjust.relative_tint, -100.0, 100.0);
    }
    for (band, delta) in adjust.hsl.entries() {
        let mut a = s.hsl.get(*band).unwrap_or_default();
        a.hue = add(a.hue, delta.hue, -100.0, 100.0);
        a.saturation = add(a.saturation, delta.saturation, -100.0, 100.0);
        a.luminance = add(a.luminance, delta.luminance, -100.0, 100.0);
        if a.is_zero() && global.hsl.get(*band).is_none() {
            s.hsl.remove(*band);
        } else {
            s.hsl.set(*band, a);
        }
    }
    s
}

/// The settings without `masks` (what `R0` renders, what auto and the
/// Stage-Q picker read).
pub fn without_masks(settings: &DevelopSettings) -> DevelopSettings {
    let mut s = settings.clone();
    s.masks.clear();
    s
}

/// `out = clamp(R0 + sum_k ((R_k - R0) * w_k + 32768) >> 16, 0, 255)` per
/// RGB channel, alpha 255. `base` is `R0` (RGBA8); each layer is `R_k`
/// (RGBA8 of the same size) with its weights (one per pixel).
pub fn blend(base: &[u8], layers: &[(&[u8], &[u32])]) -> Vec<u8> {
    let pixels = base.len() / 4;
    for (frame, weights) in layers {
        assert_eq!(frame.len(), base.len(), "a layer of another size");
        assert_eq!(weights.len(), pixels, "a plane of another size");
    }
    let mut out = vec![0u8; base.len()];
    for (p, (dst, src)) in out
        .chunks_exact_mut(4)
        .zip(base.chunks_exact(4))
        .enumerate()
    {
        let mut acc = [i32::from(src[0]), i32::from(src[1]), i32::from(src[2])];
        for (frame, weights) in layers {
            let w = weights[p] as i32;
            if w == 0 {
                continue;
            }
            let layer = &frame[p * 4..p * 4 + 3];
            for c in 0..3 {
                let diff = i32::from(layer[c]) - i32::from(src[c]);
                acc[c] += (diff * w + 32768) >> 16;
            }
        }
        for c in 0..3 {
            dst[c] = acc[c].clamp(0, 255) as u8;
        }
        dst[3] = 255;
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::local_mask::{MaskKind, MaskPoint, MaskSurfaceRef};
    use crate::settings::{HslAdjustment, HslBand};

    fn geometry(json: &str) -> Geometry {
        Geometry::from_value(&serde_json::from_str(json).unwrap()).unwrap()
    }

    fn mask(shape: MaskShape) -> LocalMask {
        let kind = match &shape {
            MaskShape::Linear { .. } => MaskKind::Linear,
            MaskShape::Radial { .. } => MaskKind::Radial,
            MaskShape::Surface(_) => MaskKind::Brush,
        };
        LocalMask {
            id: "m".into(),
            kind,
            enabled: true,
            invert: false,
            shape,
            adjust: LocalAdjust {
                exposure: -1.0,
                ..Default::default()
            },
        }
    }

    fn linear(zero: (f64, f64), full: (f64, f64)) -> LocalMask {
        mask(MaskShape::Linear {
            zero: MaskPoint {
                x: zero.0,
                y: zero.1,
            },
            full: MaskPoint {
                x: full.0,
                y: full.1,
            },
        })
    }

    fn radial(center: (f64, f64), radius: (f64, f64), angle: f64, feather: f64) -> LocalMask {
        mask(MaskShape::Radial {
            center: MaskPoint {
                x: center.0,
                y: center.1,
            },
            radius_x: radius.0,
            radius_y: radius.1,
            angle,
            feather,
        })
    }

    fn plane(mask: &LocalMask, map: &SourceMap, w: usize, h: usize) -> Vec<u32> {
        mask_weights(mask, map, w, h).unwrap()
    }

    #[test]
    fn weights_quantise_zero_one_and_half() {
        assert_eq!(weight_of(0.0), 0);
        assert_eq!(weight_of(1.0), FULL_WEIGHT);
        assert_eq!(weight_of(0.5), 32768);
        // Just below a half step rounds down, at it rounds up.
        assert_eq!(weight_of(0.5 / 65536.0), 1);
        assert_eq!(weight_of(0.49 / 65536.0), 0);
        assert_eq!(weight_to_u8(0), 0);
        assert_eq!(weight_to_u8(FULL_WEIGHT), 255);
        assert_eq!(weight_to_u8(32768), 128);
    }

    #[test]
    fn a_linear_ramp_is_half_at_its_middle_and_flat_outside() {
        // 1 x 4 output, no geometry: pixel centres at v = 1/8, 3/8, 5/8, 7/8.
        let map = SourceMap::new(None, 1, 4).unwrap();
        let m = linear((0.5, 0.25), (0.5, 0.75));
        let w = plane(&m, &map, 1, 4);
        assert_eq!(w[0], 0, "before zero");
        assert_eq!(w[3], FULL_WEIGHT, "past full");
        assert_eq!(w[1], 16384, "a quarter of the way");
        assert_eq!(w[2], 49152);
        // The middle of the ramp exactly (a 1 x 2 output: centres 1/4, 3/4;
        // a ramp from 0 to 1 over the height).
        let map = SourceMap::new(None, 1, 2).unwrap();
        let w = plane(&linear((0.5, 0.0), (0.5, 1.0)), &map, 1, 2);
        assert_eq!(w, vec![16384, 49152]);
        let map = SourceMap::new(None, 1, 1).unwrap();
        assert_eq!(
            plane(&linear((0.5, 0.0), (0.5, 1.0)), &map, 1, 1),
            vec![32768]
        );
    }

    #[test]
    fn invert_is_one_minus_the_plane() {
        let map = SourceMap::new(None, 8, 8).unwrap();
        let m = radial((0.5, 0.5), (0.3, 0.3), 0.0, 50.0);
        let mut inverted = m.clone();
        inverted.invert = true;
        let a = plane(&m, &map, 8, 8);
        let b = plane(&inverted, &map, 8, 8);
        for (x, y) in a.iter().zip(&b) {
            // 1 - m in f32 then quantised: within a step of the complement.
            assert!(
                (i64::from(*x) + i64::from(*y) - 65536).abs() <= 1,
                "{x} {y}"
            );
        }
        assert_eq!(b[0], FULL_WEIGHT, "a corner is outside, inverted to 1");
    }

    #[test]
    fn a_radial_is_one_at_its_centre_and_zero_outside() {
        let map = SourceMap::new(None, 9, 9).unwrap();
        let m = radial((0.5, 0.5), (0.3, 0.3), 0.0, 100.0);
        let w = plane(&m, &map, 9, 9);
        assert_eq!(w[4 * 9 + 4], FULL_WEIGHT, "centre pixel");
        assert_eq!(w[0], 0, "corner");
        assert_eq!(w[4 * 9], 0, "left edge (u = 1/18, r > 1)");
        // feather 100 falls off smoothly; feather 0 is a hard edge.
        let hard = plane(&radial((0.5, 0.5), (0.3, 0.3), 0.0, 0.0), &map, 9, 9);
        let inside = hard.iter().filter(|w| **w == FULL_WEIGHT).count();
        let partial = hard
            .iter()
            .filter(|w| **w != 0 && **w != FULL_WEIGHT)
            .count();
        assert_eq!(partial, 0, "no pixel lands in a 0.2 % rim here");
        assert!(inside >= 9, "{inside}");
        let soft = &w;
        let soft_partial = soft
            .iter()
            .filter(|w| **w != 0 && **w != FULL_WEIGHT)
            .count();
        assert!(soft_partial > 8, "{soft_partial}");
    }

    #[test]
    fn a_circle_stays_circular_on_a_wide_photo() {
        // 300 x 100: radius.x is a fraction of the width, so a circle of
        // radius 0.2 of the height has radius.x = 0.2 / A.
        let (w, h) = (300usize, 100usize);
        let map = SourceMap::new(None, w, h).unwrap();
        let a = map.aspect();
        assert_eq!(a, 3.0);
        let m = radial((0.5, 0.5), (0.2 / 3.0, 0.2), 0.0, 0.0);
        let p = plane(&m, &map, w, h);
        let row = |j: usize| (0..w).filter(|i| p[j * w + i] > 32768).count();
        let column = |i: usize| (0..h).filter(|j| p[j * w + i] > 32768).count();
        // The same number of pixels across and down: 40 px diameter.
        assert_eq!(row(50), column(150));
        assert_eq!(row(50), 40);
    }

    #[test]
    fn a_quarter_turn_on_a_square_swaps_the_axes() {
        let (w, h) = (16usize, 16usize);
        let none = SourceMap::new(None, w, h).unwrap();
        let turned = SourceMap::new(Some(&geometry(r#"{"rotate":90}"#)), w, h).unwrap();
        let m = linear((0.0, 0.2), (0.0, 0.8));
        let a = plane(&m, &none, w, h);
        let b = plane(&m, &turned, w, h);
        // Output (i, j) of a clockwise turn shows source (j, h - 1 - i).
        for j in 0..h {
            for i in 0..w {
                assert_eq!(b[j * w + i], a[(h - 1 - i) * w + j], "({i}, {j})");
            }
        }
        // A radial turned by 90 degrees is the ellipse with its axes swapped
        // (on a square, A = 1; sin / cos of 90 degrees are not exact, so a
        // step of rounding is allowed).
        let e = plane(&radial((0.5, 0.5), (0.4, 0.15), 90.0, 30.0), &none, w, h);
        let f = plane(&radial((0.5, 0.5), (0.15, 0.4), 0.0, 30.0), &none, w, h);
        for (k, (x, y)) in e.iter().zip(&f).enumerate() {
            assert!(x.abs_diff(*y) <= 2, "{k}: {x} vs {y}");
        }
        assert!(e.contains(&FULL_WEIGHT));
    }

    #[test]
    fn a_positive_angle_turns_the_ellipse_clockwise() {
        // y down: clockwise takes the long axis from +x towards +y, so the
        // lower-right diagonal is inside and the upper-right one outside.
        let (w, h) = (64usize, 64usize);
        let map = SourceMap::new(None, w, h).unwrap();
        let p = plane(&radial((0.5, 0.5), (0.45, 0.05), 45.0, 0.0), &map, w, h);
        let at = |i: usize, j: usize| p[j * w + i];
        assert_eq!(at(32 + 12, 32 + 12), FULL_WEIGHT);
        assert_eq!(at(32 + 12, 32 - 13), 0);
    }

    #[test]
    fn the_map_undoes_flips_turns_and_crops() {
        let s = |json: &str, px: f64, py: f64| {
            SourceMap::new(Some(&geometry(json)), 300, 200)
                .unwrap()
                .source_of(px, py)
        };
        let close = |a: [f64; 2], b: [f64; 2]| {
            assert!(
                (a[0] - b[0]).abs() < 1e-12 && (a[1] - b[1]).abs() < 1e-12,
                "{a:?} {b:?}"
            )
        };
        close(s(r#"{"flipH":true}"#, 0.25, 0.5), [0.75, 0.5]);
        close(s(r#"{"flipV":true}"#, 0.25, 0.1), [0.25, 0.9]);
        // Clockwise: the output's top-left is the source's bottom-left.
        close(s(r#"{"rotate":90}"#, 0.0, 0.0), [0.0, 1.0]);
        close(s(r#"{"rotate":270}"#, 0.0, 0.0), [1.0, 0.0]);
        close(s(r#"{"rotate":180}"#, 0.1, 0.2), [0.9, 0.8]);
        close(
            s(
                r#"{"crop":{"left":0.25,"top":0.5,"right":0.75,"bottom":1}}"#,
                0.5,
                0.5,
            ),
            [0.5, 0.75],
        );
        // A turned crop through its centre maps to the crop's centre.
        close(s(r#"{"angle":10}"#, 0.5, 0.5), [0.5, 0.5]);
        assert_eq!(
            SourceMap::new(
                Some(&geometry(
                    r#"{"angle":45,"crop":{"left":0,"top":0.5,"right":1,"bottom":0.5}}"#
                )),
                100,
                100
            ),
            Err(InvalidCrop)
        );
    }

    #[test]
    fn local_settings_add_clamp_and_keep_the_rest() {
        let mut global = DevelopSettings::neutral();
        // The vignette needs v 3.
        global.v = 3;
        global.exposure = 4.5;
        global.contrast = -90.0;
        global.hsl.set(
            HslBand::Red,
            HslAdjustment {
                hue: 95.0,
                saturation: 0.0,
                luminance: 0.0,
            },
        );
        global.vignette.amount = -20.0;
        let mut adjust = LocalAdjust {
            exposure: 1.0,
            contrast: -30.0,
            relative_temperature: 15.0,
            ..Default::default()
        };
        adjust.hsl.set(
            HslBand::Red,
            HslAdjustment {
                hue: 10.0,
                saturation: -5.0,
                luminance: 0.0,
            },
        );
        adjust.hsl.set(
            HslBand::Blue,
            HslAdjustment {
                hue: 0.0,
                saturation: 7.0,
                luminance: 0.0,
            },
        );
        let l = local_settings(&global, &adjust);
        assert_eq!(l.exposure, 5.0);
        assert_eq!(l.contrast, -100.0);
        assert_eq!(l.white_balance.mode, WhiteBalanceMode::Relative);
        assert_eq!(l.relative_temperature, 15.0);
        assert_eq!(l.relative_tint, 0.0);
        let red = l.hsl.get(HslBand::Red).unwrap();
        assert_eq!((red.hue, red.saturation), (100.0, -5.0));
        assert_eq!(l.hsl.get(HslBand::Blue).unwrap().saturation, 7.0);
        assert_eq!(l.vignette, global.vignette);
        assert!(l.validate().is_empty(), "{:?}", l.validate());
        // A delta the clamp swallows gives the global settings back.
        let mut swallowed = global.clone();
        swallowed.exposure = 5.0;
        let none = local_settings(
            &swallowed,
            &LocalAdjust {
                exposure: 0.5,
                ..Default::default()
            },
        );
        assert_eq!(none, swallowed);
        // A relative white balance adds.
        let mut relative = DevelopSettings::neutral();
        relative.white_balance.mode = WhiteBalanceMode::Relative;
        relative.relative_tint = 90.0;
        let l = local_settings(
            &relative,
            &LocalAdjust {
                relative_tint: 30.0,
                ..Default::default()
            },
        );
        assert_eq!(l.relative_tint, 100.0);
    }

    #[test]
    fn the_blend_is_exact_at_zero_and_one_and_order_free() {
        let base = vec![10u8, 200, 128, 255, 0, 255, 7, 255];
        let a = vec![250u8, 0, 128, 255, 255, 0, 9, 255];
        let b = vec![0u8, 255, 100, 255, 255, 255, 3, 255];
        let full = vec![FULL_WEIGHT, FULL_WEIGHT];
        let zero = vec![0u32, 0];
        assert_eq!(blend(&base, &[(&a, &full)]), a);
        assert_eq!(blend(&base, &[(&a, &zero)]), base);
        let half = vec![32768u32, 12345];
        let ab = blend(&base, &[(&a, &half), (&b, &full)]);
        let ba = blend(&base, &[(&b, &full), (&a, &half)]);
        assert_eq!(ab, ba);
        // Two full layers that both brighten clamp at 255 and at 0.
        let up = vec![255u8, 255, 255, 255, 255, 255, 255, 255];
        let out = blend(&base, &[(&up, &full), (&up, &full)]);
        assert_eq!(&out[..4], &[255, 255, 255, 255]);
        let down = vec![0u8; 8];
        let out = blend(&up, &[(&down, &full), (&down, &full)]);
        assert_eq!(out, vec![0, 0, 0, 255, 0, 0, 0, 255]);
        // A half weight of a difference of 1 rounds half up.
        let one = vec![11u8, 200, 128, 255, 0, 255, 7, 255];
        assert_eq!(blend(&base, &[(&one, &half)])[0], 11);
    }

    #[test]
    fn a_surface_mask_has_no_plane_without_its_surface() {
        let m = mask(MaskShape::Surface(MaskSurfaceRef {
            id: "0".repeat(64),
            width: 4,
            height: 4,
        }));
        let map = SourceMap::new(None, 4, 4).unwrap();
        assert_eq!(
            mask_weights(&m, &map, 4, 4),
            Err(PlaneError::SurfaceMissing("m".into()))
        );
    }
}
