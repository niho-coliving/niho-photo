//! Rendering `developSettings.geometry` (F3 #17122, spec "段 2"): the
//! geometry is applied where stage 2 starts, and only the output and a
//! margin around it go through the stage-2 pass. [`crate::geometry`]
//! defines the frame and the crop's coordinates.
//!
//! Order: quarter turns and flips (the order the frame's rows are read from
//! the source) -> the perspective (niho-photo#46, [`crate::perspective`]:
//! the frame warped onto a canvas of its size) -> the straighten angle
//! (resampled in linear light) -> the crop -> the output size. The crop's
//! coordinates are on the canvas; "余白を埋める" (`constrain`) keeps it
//! inside the corrected photo ([`crate::perspective::constrain_corners`]).
//! The lens (niho-photo#45, [`crate::lens`]) is the end of the inverse map
//! nearest the photo: its distortion and chromatic aberration resample the
//! frame through the Turned path ([`plan_with_lens`]), its vignetting and
//! fringe removal act on the window right after.
//!
//! - **Output size, never enlarged** ([`plan`]). Angle 0: the crop of a
//!   "virtual whole", the frame reduced as a whole render would be, at the
//!   largest size whose crop fits `max_dimension`. With an angle: the
//!   crop's width and height times `k = min(1, M / long side)`.
//! - **Local radii and statistics.** The local pass's radii follow the long
//!   edge of the whole frame at this scale ([`Plan::scale_long_edge`]) and
//!   the adaptive statistics are read from the whole photo before the
//!   geometry, so the crop does not change how Highlights / Shadows /
//!   Texture / Clarity look.
//! - **Margin.** The working image (the window) extends `P = 2A` pixels
//!   past the output (`A = 2^levelsH`, the pyramid's coarsest step of
//!   Highlights) for the local pass and is dropped at the output. At angle
//!   0 its top-left corner is aligned down to a multiple of `A` on the
//!   virtual whole, so the pyramid samples where the whole render does and
//!   moving the crop by a pixel does not change the local result inside;
//!   it stops at the photo's edges (reflected there, as the whole render).
//! - **Resampling.** Angle 0: the whole render's Lanczos taps over the
//!   window only ([`resample_window`]), bit for bit the whole reduction's
//!   pixels (a direct copy when nothing is reduced). With an angle: the
//!   frame reduced per axis, then Catmull-Rom (4 x 4, `a = -0.5`) in
//!   linear light at each pixel's center; indices outside the photo are
//!   clamped to its edge (only the margin reaches them). With a
//!   perspective: the same single Catmull-Rom pass, each pixel's center
//!   taken through the crop (with its angle) onto the canvas and then
//!   through the inverse warp onto the frame; the frame is reduced by the
//!   output's scale over the warp's at the crop's center, so a smaller
//!   `scale` does not alias. Points outside the photo (the corners a
//!   perspective uncovers when `constrain` is off) take its nearest edge:
//!   the stage-2 pass has no alpha, an edge keeps the local pass free of a
//!   hard border, and `constrain` cuts them away.

use crate::decode::{DecodeError, LinearImage};
use crate::geometry::{CropCorners, Geometry};
use crate::lens::{defringe_radius, defringe_window, LensMap, LensRender};
use crate::perspective::{constrain_corners, Warp};
use crate::resize::{fitted_size, resample_window, Filter};
use crate::settings::SettingsError;
use crate::spatial::{levels_for_scale, scale_px};
use image::ImageDecoder;
use std::io::Cursor;
use std::ops::Range;

/// Default long-edge cap of a one-shot render's decode when the settings
/// have a geometry (`RenderOptions::decode_cap`).
pub const DEFAULT_DECODE_CAP: usize = 4096;

/// A rectangle of pixels.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Rect {
    pub x: usize,
    pub y: usize,
    pub width: usize,
    pub height: usize,
}

impl Rect {
    /// All of a `width x height` image.
    pub fn whole(width: usize, height: usize) -> Self {
        Self {
            x: 0,
            y: 0,
            width,
            height,
        }
    }
}

/// The frame: the source turned clockwise by `rotate`, then mirrored.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
struct Orientation {
    rotate: u32,
    flip_h: bool,
    flip_v: bool,
    source_width: usize,
    source_height: usize,
}

impl Orientation {
    fn new(g: &Geometry, source_width: usize, source_height: usize) -> Self {
        Self {
            rotate: g.rotate % 360,
            flip_h: g.flip_h,
            flip_v: g.flip_v,
            source_width,
            source_height,
        }
    }

    /// Whether frame pixels are the source's (a half turn with both flips
    /// is none).
    fn is_identity(&self) -> bool {
        matches!(
            (self.rotate, self.flip_h, self.flip_v),
            (0, false, false) | (180, true, true)
        )
    }

    fn frame_size(&self) -> (usize, usize) {
        match self.rotate {
            90 | 270 => (self.source_height, self.source_width),
            _ => (self.source_width, self.source_height),
        }
    }

    /// The source pixel (index) of frame pixel `(x, y)`.
    #[inline]
    fn source_pixel(&self, x: usize, y: usize) -> usize {
        let (fw, fh) = self.frame_size();
        let x = if self.flip_h { fw - 1 - x } else { x };
        let y = if self.flip_v { fh - 1 - y } else { y };
        let (w, h) = (self.source_width, self.source_height);
        let (sx, sy) = match self.rotate {
            90 => (y, h - 1 - x),
            180 => (w - 1 - x, h - 1 - y),
            270 => (w - 1 - y, x),
            _ => (x, y),
        };
        sy * w + sx
    }

    /// Fills `out` with frame row `y` from column `first`.
    fn frame_row(&self, source: &LinearImage, y: usize, first: usize, out: &mut [f32]) {
        if self.is_identity() {
            let start = (y * self.source_width + first) * 3;
            out.copy_from_slice(&source.data[start..start + out.len()]);
            return;
        }
        for (k, px) in out.chunks_exact_mut(3).enumerate() {
            let s = self.source_pixel(first + k, y) * 3;
            px.copy_from_slice(&source.data[s..s + 3]);
        }
    }
}

#[derive(Debug, Clone, PartialEq)]
enum Sampling {
    /// Angle 0: the frame reduced to `virtual_width x virtual_height` (a
    /// whole render's size; the frame itself when nothing is reduced), the
    /// window at `window` of it.
    Aligned {
        virtual_width: usize,
        virtual_height: usize,
        window: Rect,
    },
    /// Straightened: output pixel `(i, j)`'s center lies at frame point
    /// `top_left + ((i + 0.5) / width) across + ((j + 0.5) / height) down`
    /// (frame pixel `n`'s center at `n + 0.5`), the window `pad` pixels
    /// further on every side (the same map). The frame is read reduced to
    /// `reduced` (per axis). With a `warp` (a perspective) that point is on
    /// the canvas and the frame point is its inverse warp.
    Turned {
        corners: CropCorners,
        pad: usize,
        reduced: (usize, usize),
        warp: Option<Box<Warp>>,
    },
}

/// How one geometry renders a source at one output size ([`plan`]).
#[derive(Debug, Clone, PartialEq)]
pub struct Plan {
    /// Output size.
    pub width: usize,
    pub height: usize,
    /// Long edge of the whole frame at this scale: the local pass's radii
    /// follow it (`spatial::scale_px`), not the window's size.
    pub scale_long_edge: usize,
    /// Size of the working image (the window, [`working_image`]).
    pub window_width: usize,
    pub window_height: usize,
    /// The output inside the window.
    pub output: Rect,
    orientation: Orientation,
    sampling: Sampling,
    /// The lens rendered with the frame ([`plan_with_lens`]).
    lens: Option<LensRender>,
}

impl Plan {
    /// At angle 0: the virtual whole's size and the output's rectangle on
    /// it (a whole render of that size, cut there, is this frame; tests
    /// and tools). `None` at an angle.
    pub fn virtual_crop(&self) -> Option<((usize, usize), Rect)> {
        match &self.sampling {
            Sampling::Aligned {
                virtual_width,
                virtual_height,
                window,
            } => Some((
                (*virtual_width, *virtual_height),
                Rect {
                    x: window.x + self.output.x,
                    y: window.y + self.output.y,
                    width: self.width,
                    height: self.height,
                },
            )),
            Sampling::Turned { .. } => None,
        }
    }

    /// The frame point (continuous frame pixels, pixel `n`'s center at
    /// `n + 0.5`) where output pixel `(i, j)`'s center comes from, at an
    /// angle, with a perspective or with a lens that warps (green's point).
    /// `None` at angle 0 without one.
    pub fn turned_point(&self, i: usize, j: usize) -> Option<[f64; 2]> {
        match &self.sampling {
            Sampling::Turned {
                corners: c, warp, ..
            } => {
                let a = (i as f64 + 0.5) / self.width as f64;
                let b = (j as f64 + 0.5) / self.height as f64;
                let q = [
                    c.top_left[0] + a * c.across[0] + b * c.down[0],
                    c.top_left[1] + a * c.across[1] + b * c.down[1],
                ];
                let p = warp.as_ref().map_or(q, |w| w.sample_point(q));
                Some(match self.lens.filter(LensRender::warps) {
                    Some(lens) => {
                        let (fw, fh) = self.orientation.frame_size();
                        LensMap::new(&lens, fw, fh).source(p)
                    }
                    None => p,
                })
            }
            Sampling::Aligned { .. } => None,
        }
    }

    /// The crop's corners on the canvas (on the frame without a
    /// perspective) the output covers, at an angle or with a perspective
    /// (after "余白を埋める"). `None` at angle 0 without one.
    pub fn crop_corners(&self) -> Option<CropCorners> {
        match &self.sampling {
            Sampling::Turned { corners, .. } => Some(*corners),
            Sampling::Aligned { .. } => None,
        }
    }

    /// The frame's size (the source turned by the quarter turns).
    pub fn frame_size(&self) -> (usize, usize) {
        self.orientation.frame_size()
    }

    /// Whether the working image is the source itself (angle 0, no turn,
    /// nothing reduced and the window covering the whole frame, e.g. a
    /// slight crop at the working size): no copy needs to be made.
    pub fn window_is_source(&self) -> bool {
        match &self.sampling {
            Sampling::Aligned {
                virtual_width,
                virtual_height,
                window,
            } => {
                let (fw, fh) = self.orientation.frame_size();
                self.orientation.is_identity()
                    && (*virtual_width, *virtual_height) == (fw, fh)
                    && *window == Rect::whole(fw, fh)
                    && self.lens.is_none()
            }
            Sampling::Turned { .. } => false,
        }
    }
}

/// `(A, P)`: the coarsest step of the Highlights pyramid at this scale and
/// the margin the window keeps around the output.
fn margin(scale_long_edge: usize) -> (usize, usize) {
    let levels = levels_for_scale(scale_px(scale_long_edge as f64));
    let step = 1usize << levels;
    (step, 2 * step)
}

fn invalid_crop(message: &str) -> SettingsError {
    SettingsError::new("geometry.crop", "invalidCrop", message)
}

/// The crop on a `width x height` frame in frame pixels. At an angle it
/// must make a rectangle (positive width and height); corners outside the
/// frame are brought in by shrinking the crop about its center (the
/// largest one inside; a center outside the frame is an error). At angle 0
/// the corners are the crop's own (validated to lie inside).
fn crop_corners(g: &Geometry, width: usize, height: usize) -> Result<CropCorners, SettingsError> {
    let (w, h) = (width as f64, height as f64);
    let c = g.crop.corners(w, h, g.angle);
    if !(c.width > 0.0 && c.height > 0.0) {
        return Err(invalid_crop(
            "the corners do not make a rectangle at this angle on this photo",
        ));
    }
    if g.angle == 0.0 {
        return Ok(c);
    }
    let center = [
        c.top_left[0] + (c.across[0] + c.down[0]) / 2.0,
        c.top_left[1] + (c.across[1] + c.down[1]) / 2.0,
    ];
    if !(center[0] > 0.0 && center[0] < w && center[1] > 0.0 && center[1] < h) {
        return Err(invalid_crop("the crop's center is outside the photo"));
    }
    let mut s = 1.0f64;
    for (a, b) in [(0.0, 0.0), (1.0, 0.0), (0.0, 1.0), (1.0, 1.0)] {
        for (axis, limit) in [(0, w), (1, h)] {
            let corner = c.top_left[axis] + a * c.across[axis] + b * c.down[axis];
            let d = corner - center[axis];
            if d > 0.0 && corner > limit {
                s = s.min((limit - center[axis]) / d);
            } else if d < 0.0 && corner < 0.0 {
                s = s.min(center[axis] / -d);
            }
        }
    }
    if s >= 1.0 {
        return Ok(c);
    }
    let scaled = |axis: usize| center[axis] + (c.top_left[axis] - center[axis]) * s;
    Ok(CropCorners {
        top_left: [scaled(0), scaled(1)],
        across: [c.across[0] * s, c.across[1] * s],
        down: [c.down[0] * s, c.down[1] * s],
        width: c.width * s,
        height: c.height * s,
    })
}

/// The perspective's warp of `g` on a `width x height` frame (`None`
/// without one).
fn warp_of(g: &Geometry, width: usize, height: usize) -> Option<Warp> {
    g.active_perspective()
        .and_then(|p| Warp::new(p, width, height))
}

/// [`crop_corners`] on the canvas, kept inside the corrected photo when
/// `constrain` is on with a perspective.
fn framed_corners(
    g: &Geometry,
    width: usize,
    height: usize,
    warp: Option<&Warp>,
) -> Result<CropCorners, SettingsError> {
    let c = crop_corners(g, width, height)?;
    Ok(match warp {
        Some(warp) if g.constrain => constrain_corners(c, warp),
        _ => c,
    })
}

fn corners_center(c: &CropCorners) -> [f64; 2] {
    [
        c.top_left[0] + (c.across[0] + c.down[0]) / 2.0,
        c.top_left[1] + (c.across[1] + c.down[1]) / 2.0,
    ]
}

/// How `g` renders a `source_width x source_height` source (the working
/// image, EXIF orientation applied) at `max_dimension` (0 = no reduction).
/// A crop that is not a rectangle at its angle is `geometry.crop` /
/// `invalidCrop`.
pub fn plan(
    g: &Geometry,
    source_width: usize,
    source_height: usize,
    max_dimension: usize,
) -> Result<Plan, SettingsError> {
    plan_with_lens(g, None, source_width, source_height, max_dimension)
}

/// [`plan`] with a lens (niho-photo#45): one that warps (distortion,
/// chromatic aberration) renders through the Turned path even at angle 0;
/// one that only shades or removes fringes keeps the plan and acts on the
/// window ([`working_image`]). The output size does not change.
pub fn plan_with_lens(
    g: &Geometry,
    lens: Option<&LensRender>,
    source_width: usize,
    source_height: usize,
    max_dimension: usize,
) -> Result<Plan, SettingsError> {
    let orientation = Orientation::new(g, source_width, source_height);
    let (fw, fh) = orientation.frame_size();
    let warp = warp_of(g, fw, fh);
    let corners = framed_corners(g, fw, fh, warp.as_ref())?;
    let lens = lens.copied();
    let mut plan = if g.angle == 0.0 && warp.is_none() && !lens.is_some_and(|l| l.warps()) {
        aligned_plan(g, orientation, max_dimension)
    } else {
        turned_plan(corners, orientation, max_dimension, warp, lens.as_ref())
    };
    plan.lens = lens;
    Ok(plan)
}

/// Angle 0 (module docs): the virtual whole `(Wv, Hv)` is the frame when
/// nothing needs reducing; else it starts at `ceil(max(Wf, Hf) M / crop
/// long edge)` and shrinks by a pixel until the rounded crop fits `M`.
fn aligned_plan(g: &Geometry, orientation: Orientation, m: usize) -> Plan {
    let (fw, fh) = orientation.frame_size();
    let c = &g.crop;
    let crop_long = ((c.right - c.left) * fw as f64).max((c.bottom - c.top) * fh as f64);
    // The crop on a `vw x vh` virtual whole: rounded edges, at least 1px.
    let crop_on = |vw: usize, vh: usize| {
        let span = |a: f64, b: f64, n: usize| {
            let lo = (libm::round(a * n as f64).max(0.0) as usize).min(n - 1);
            let hi = (libm::round(b * n as f64).max(0.0) as usize).clamp(lo + 1, n);
            (lo, hi - lo)
        };
        let (x, width) = span(c.left, c.right, vw);
        let (y, height) = span(c.top, c.bottom, vh);
        Rect {
            x,
            y,
            width,
            height,
        }
    };
    let (vw, vh, crop) = if m == 0 || crop_long <= m as f64 {
        (fw, fh, crop_on(fw, fh))
    } else {
        let mut long = libm::ceil(fw.max(fh) as f64 * m as f64 / crop_long) as usize;
        loop {
            let (vw, vh) = fitted_size(fw, fh, long.max(1));
            let crop = crop_on(vw, vh);
            if crop.width.max(crop.height) <= m || long <= 1 {
                break (vw, vh, crop);
            }
            long -= 1;
        }
    };
    let scale_long_edge = vw.max(vh);
    let (step, pad) = margin(scale_long_edge);
    let x = crop.x.saturating_sub(pad) / step * step;
    let y = crop.y.saturating_sub(pad) / step * step;
    let window = Rect {
        x,
        y,
        width: (crop.x + crop.width + pad).min(vw) - x,
        height: (crop.y + crop.height + pad).min(vh) - y,
    };
    Plan {
        width: crop.width,
        height: crop.height,
        scale_long_edge,
        window_width: window.width,
        window_height: window.height,
        output: Rect {
            x: crop.x - x,
            y: crop.y - y,
            width: crop.width,
            height: crop.height,
        },
        orientation,
        sampling: Sampling::Aligned {
            virtual_width: vw,
            virtual_height: vh,
            window,
        },
        lens: None,
    }
}

fn turned_plan(
    corners: CropCorners,
    orientation: Orientation,
    m: usize,
    warp: Option<Warp>,
    lens: Option<&LensRender>,
) -> Plan {
    let (fw, fh) = orientation.frame_size();
    let k = if m == 0 {
        1.0
    } else {
        (m as f64 / corners.width.max(corners.height)).min(1.0)
    };
    let side = |v: f64| {
        let n = (libm::round(v * k) as usize).max(1);
        if m > 0 {
            n.min(m)
        } else {
            n
        }
    };
    let (width, height) = (side(corners.width), side(corners.height));
    let scale_long_edge = (libm::round(fw.max(fh) as f64 * k) as usize).max(1);
    // A lens that warps magnifies the photo by its zoom at the center.
    let lens_scale = lens
        .filter(|l| l.warps())
        .map(|l| LensMap::new(l, fw, fh).center_scale());
    let reduced_to = |r: f64| {
        if r < 1.0 {
            fitted_size(fw, fh, (libm::round(fw.max(fh) as f64 * r) as usize).max(1))
        } else {
            (fw, fh)
        }
    };
    let reduced = match (&warp, lens_scale) {
        (None, None) => {
            if k < 1.0 {
                fitted_size(fw, fh, scale_long_edge)
            } else {
                (fw, fh)
            }
        }
        (None, Some(z)) => reduced_to((k / z).min(1.0)),
        (Some(warp), z) => {
            // An output pixel spans `inverse_scale / k` frame pixels at the
            // crop's center: reduce the frame to about one per output pixel
            // (never enlarged).
            let spread = warp.inverse_scale(corners_center(&corners)) * z.unwrap_or(1.0);
            reduced_to((k / spread).min(1.0))
        }
    };
    let (_, pad) = margin(scale_long_edge);
    Plan {
        width,
        height,
        scale_long_edge,
        window_width: width + 2 * pad,
        window_height: height + 2 * pad,
        output: Rect {
            x: pad,
            y: pad,
            width,
            height,
        },
        orientation,
        sampling: Sampling::Turned {
            corners,
            pad,
            reduced,
            warp: warp.map(Box::new),
        },
        lens: None,
    }
}

/// What a geometry frame's working image depends on besides the source:
/// the rendered geometry (not its aspect lock; the perspective and
/// `constrain` when there is a perspective) and `max_dimension`.
pub fn frame_key(g: &Geometry, max_dimension: usize) -> String {
    let c = &g.crop;
    let perspective = g
        .active_perspective()
        .map(|p| {
            format!(
                "{:?}|{:?}|{:?}|{:?}|{:?}|{:?}|{:?}|{}",
                p.vertical, p.horizontal, p.rotate, p.aspect, p.scale, p.x, p.y, g.constrain
            )
        })
        .unwrap_or_default();
    format!(
        "{}|{}|{}|{:?}|{:?}|{:?}|{:?}|{:?}|{perspective}|{max_dimension}",
        g.rotate % 360,
        g.flip_h,
        g.flip_v,
        g.angle,
        c.left,
        c.top,
        c.right,
        c.bottom
    )
}

/// [`frame_key`] with the lens a plan renders ([`plan_with_lens`]).
pub fn frame_key_with_lens(
    g: &Geometry,
    lens: Option<&LensRender>,
    max_dimension: usize,
) -> String {
    let key = frame_key(g, max_dimension);
    match lens {
        Some(lens) => format!("{key}|lens:{}", lens.key()),
        None => key,
    }
}

/// The long edge to decode a JPEG / PNG original of `width x height` (EXIF
/// orientation applied) at so that its crop reaches `max_dimension`:
/// `min(cap, long edge, ceil(long edge * M / crop long edge))` with the
/// crop's long edge in the original's pixels (`M` 0: the original's size;
/// `cap` 0: no cap). Without a geometry the crop is the whole photo
/// (`min(cap, long edge, M)`). With a perspective the crop is on the canvas
/// and a magnifying warp (`scale` above 100) needs that many more pixels.
pub fn decode_long_edge(
    g: Option<&Geometry>,
    width: usize,
    height: usize,
    max_dimension: usize,
    cap: usize,
) -> Result<usize, SettingsError> {
    let long = width.max(height);
    let wanted = match (max_dimension, g.filter(|g| !g.is_identity())) {
        (0, _) => long,
        (m, None) => m,
        (m, Some(g)) => {
            let (fw, fh) = Orientation::new(g, width, height).frame_size();
            let warp = warp_of(g, fw, fh);
            let corners = framed_corners(g, fw, fh, warp.as_ref())?;
            let crop_long = match &warp {
                None => corners.width.max(corners.height),
                Some(warp) => {
                    corners.width.max(corners.height)
                        * warp.inverse_scale(corners_center(&corners)).min(1.0)
                }
            };
            libm::ceil(long as f64 * m as f64 / crop_long) as usize
        }
    };
    let mut size = wanted.min(long);
    if cap > 0 {
        size = size.min(cap);
    }
    Ok(size.max(1))
}

/// The output size of `g` on a `width x height` source at `max_dimension`
/// (without a geometry: the source fitted to it), without rendering.
pub fn output_size(
    g: Option<&Geometry>,
    width: usize,
    height: usize,
    max_dimension: usize,
) -> Result<(usize, usize), SettingsError> {
    match g.filter(|g| !g.is_identity()) {
        None => Ok(fitted_size(width, height, max_dimension)),
        Some(g) => plan(g, width, height, max_dimension).map(|p| (p.width, p.height)),
    }
}

/// A JPEG / PNG's size with its EXIF orientation applied, from the header
/// only.
pub fn image_size(bytes: &[u8]) -> Result<(usize, usize), DecodeError> {
    use image::metadata::Orientation::*;
    let failed = |e: image::ImageError| DecodeError::DecodeFailed(e.to_string());
    let format = image::guess_format(bytes).map_err(failed)?;
    let ((width, height), orientation) = match format {
        image::ImageFormat::Jpeg => {
            let mut decoder =
                image::codecs::jpeg::JpegDecoder::new(Cursor::new(bytes)).map_err(failed)?;
            let orientation = decoder.orientation().unwrap_or(NoTransforms);
            (decoder.dimensions(), orientation)
        }
        image::ImageFormat::Png => {
            let mut decoder =
                image::codecs::png::PngDecoder::new(Cursor::new(bytes)).map_err(failed)?;
            let orientation = decoder.orientation().unwrap_or(NoTransforms);
            (decoder.dimensions(), orientation)
        }
        other => {
            return Err(DecodeError::DecodeFailed(format!(
                "unsupported format {other:?} (JPEG / PNG only)"
            )))
        }
    };
    let (width, height) = (width as usize, height as usize);
    Ok(
        if matches!(
            orientation,
            Rotate90 | Rotate270 | Rotate90FlipH | Rotate270FlipH
        ) {
            (height, width)
        } else {
            (width, height)
        },
    )
}

/// The working image of `plan` (`window_width x window_height`, the output
/// at `plan.output`) from the source it was planned for, in the source's
/// color space.
pub fn working_image(source: &LinearImage, plan: &Plan, filter: Filter) -> LinearImage {
    let o = &plan.orientation;
    assert_eq!(
        (source.width, source.height),
        (o.source_width, o.source_height),
        "the plan's source size"
    );
    let (fw, fh) = o.frame_size();
    let mut data = match &plan.sampling {
        Sampling::Aligned {
            virtual_width,
            virtual_height,
            window,
        } => {
            if (*virtual_width, *virtual_height) == (fw, fh) {
                frame_region(source, o, *window)
            } else {
                resample_window(
                    fw,
                    fh,
                    *virtual_width,
                    *virtual_height,
                    filter,
                    window.x..window.x + window.width,
                    window.y..window.y + window.height,
                    |y, first, out| o.frame_row(source, y, first, out),
                )
            }
        }
        Sampling::Turned {
            corners,
            pad,
            reduced,
            warp,
        } => turned_window(
            source,
            plan,
            corners,
            *pad,
            *reduced,
            warp.as_deref(),
            filter,
        ),
    };
    if let Some(lens) = &plan.lens {
        lens_window(&mut data, plan, lens);
    }
    LinearImage {
        width: plan.window_width,
        height: plan.window_height,
        data,
    }
}

/// The lens's work on a window after the resampling: an aligned window's
/// vignetting (a warped one is shaded while it is sampled) and the fringes.
fn lens_window(data: &mut [f32], plan: &Plan, lens: &LensRender) {
    if let Sampling::Aligned {
        virtual_width,
        virtual_height,
        window,
    } = &plan.sampling
    {
        let (fw, fh) = plan.orientation.frame_size();
        if let Some(shading) = LensMap::new(lens, fw, fh).shading() {
            let (kx, ky) = (
                fw as f64 / *virtual_width as f64,
                fh as f64 / *virtual_height as f64,
            );
            for (j, row) in data.chunks_exact_mut(window.width * 3).enumerate() {
                let y = ((window.y + j) as f64 + 0.5) * ky;
                for (i, px) in row.chunks_exact_mut(3).enumerate() {
                    let gain = shading.gain([((window.x + i) as f64 + 0.5) * kx, y]);
                    for c in px {
                        *c *= gain;
                    }
                }
            }
        }
    }
    if lens.defringes() {
        let (_, pad) = margin(plan.scale_long_edge);
        let radius = defringe_radius(plan.scale_long_edge, pad);
        defringe_window(data, plan.window_width, plan.window_height, lens, radius);
    }
}

/// `r` of the frame, unreduced.
fn frame_region(source: &LinearImage, o: &Orientation, r: Rect) -> Vec<f32> {
    let mut data = vec![0.0f32; r.width * r.height * 3];
    for (j, row) in data.chunks_exact_mut(r.width * 3).enumerate() {
        o.frame_row(source, r.y + j, r.x, row);
    }
    data
}

/// The four Catmull-Rom taps (`a = -0.5`) at continuous `coordinate`
/// (pixel `n`'s center at `n + 0.5`) on an axis of `n` pixels, clamped to
/// the edge (and to `range`, the pixels held), and their weights.
#[inline]
fn catmull_rom_taps(coordinate: f64, n: usize, range: &Range<usize>) -> ([usize; 4], [f32; 4]) {
    let x = coordinate - 0.5;
    let base = libm::floor(x);
    let t = x - base;
    let base = base as isize;
    let index = |k: isize| {
        let i = (base + k).clamp(0, n as isize - 1) as usize;
        i.clamp(range.start, range.end - 1)
    };
    let (t2, t3) = (t * t, t * t * t);
    let weights = [
        (-t3 + 2.0 * t2 - t) * 0.5,
        (3.0 * t3 - 5.0 * t2 + 2.0) * 0.5,
        (-3.0 * t3 + 4.0 * t2 + t) * 0.5,
        (t3 - t2) * 0.5,
    ];
    (
        [index(-1), index(0), index(1), index(2)],
        weights.map(|w| w as f32),
    )
}

/// The straightened window: the frame reduced per axis to `reduced` over
/// the window's footprint (plus the interpolation's reach), then
/// Catmull-Rom at every window pixel's center. With a perspective (`warp`)
/// each center goes through the inverse warp first.
fn turned_window(
    source: &LinearImage,
    plan: &Plan,
    c: &CropCorners,
    pad: usize,
    reduced: (usize, usize),
    warp: Option<&Warp>,
    filter: Filter,
) -> Vec<f32> {
    let o = &plan.orientation;
    let (fw, fh) = o.frame_size();
    let (rw, rh) = reduced;
    let (sx, sy) = (rw as f64 / fw as f64, rh as f64 / fh as f64);
    let (wo, ho) = (plan.width as f64, plan.height as f64);
    let pad = pad as f64;
    // Window pixel (i, j) on the canvas.
    let canvas = |i: usize, j: usize| -> [f64; 2] {
        let a = (i as f64 - pad + 0.5) / wo;
        let b = (j as f64 - pad + 0.5) / ho;
        [
            c.top_left[0] + a * c.across[0] + b * c.down[0],
            c.top_left[1] + a * c.across[1] + b * c.down[1],
        ]
    };
    // A warped point far outside the frame takes its edge like one just
    // outside (the taps clamp); held finite so the taps' indices do too.
    let (cx, cy) = (rw as f64 + 4.0, rh as f64 + 4.0);
    // Window pixel (i, j) on the reduced frame (continuous coordinates).
    let point = |i: usize, j: usize| -> [f64; 2] {
        let q = canvas(i, j);
        match warp {
            None => [q[0] * sx, q[1] * sy],
            Some(warp) => {
                let p = warp.sample_point(q);
                [(p[0] * sx).clamp(-4.0, cx), (p[1] * sy).clamp(-4.0, cy)]
            }
        }
    };
    let (ww, wh) = (plan.window_width, plan.window_height);
    let corners = [(0, 0), (ww - 1, 0), (0, wh - 1), (ww - 1, wh - 1)];
    // A lens that warps: green's point (and red's and blue's) of each window
    // pixel on the reduced frame, and its vignetting gain.
    let lens = plan
        .lens
        .filter(LensRender::warps)
        .map(|l| LensMap::new(&l, fw, fh));
    let shading = lens.as_ref().and_then(LensMap::shading);
    let reduce = |p: [f64; 2]| [(p[0] * sx).clamp(-4.0, cx), (p[1] * sy).clamp(-4.0, cy)];
    let lens_sample = |map: &LensMap, i: usize, j: usize| -> LensSample {
        let q = canvas(i, j);
        let p = warp.map_or(q, |warp| warp.sample_point(q));
        let g = map.source(p);
        LensSample {
            green: reduce(g),
            red_blue: map
                .has_chromatic()
                .then(|| [reduce(map.channel(g, 0)), reduce(map.channel(g, 1))]),
            gain: shading.as_ref().map_or(1.0, |s| s.gain(g)),
        }
    };
    let ends: Vec<[f64; 2]> = match &lens {
        None => corners.map(|(i, j)| point(i, j)).to_vec(),
        // The lens bends the window's edges: their image is bounded by
        // samples along them (every 8 pixels), each channel's.
        Some(map) => {
            let mut ends = Vec::new();
            let along = |n: usize| (0..n).step_by(8).chain(std::iter::once(n - 1));
            let edges = along(ww)
                .flat_map(|i| [(i, 0), (i, wh - 1)])
                .chain(along(wh).flat_map(|j| [(0, j), (ww - 1, j)]));
            for (i, j) in edges {
                let s = lens_sample(map, i, j);
                ends.push(s.green);
                ends.extend(s.red_blue.into_iter().flatten());
            }
            ends
        }
    };
    // The warp keeps the window a convex quadrilateral (its corners'
    // bounding box holds it) unless the window reaches the vanishing line:
    // then the whole frame is read.
    let bounded = warp.is_none_or(|warp| {
        corners
            .iter()
            .all(|&(i, j)| warp.to_frame(canvas(i, j)).is_some())
    });
    // The reduced frame's pixels the window reads: the footprint's bounding
    // box, the taps' reach and a pixel for rounding.
    let range = |axis: usize, n: usize| {
        if !bounded {
            return 0..n;
        }
        let lo = ends.iter().map(|p| p[axis]).fold(f64::INFINITY, f64::min);
        let hi = ends
            .iter()
            .map(|p| p[axis])
            .fold(f64::NEG_INFINITY, f64::max);
        let last = (n - 1) as f64;
        // Between the lens's samples an edge can bulge a little further.
        let slack = if lens.is_some() { 2.0 } else { 0.0 };
        let first = (libm::floor(lo - 0.5) - 2.0 - slack).clamp(0.0, last) as usize;
        let end = (libm::floor(hi - 0.5) + 3.0 + slack).clamp(0.0, last) as usize + 1;
        first..end
    };
    let (xs, ys) = (range(0, rw), range(1, rh));
    if let Some(map) = &lens {
        // Through the lens: the pixels read as one block (the source
        // itself when it is the frame, else the frame's or the reduced
        // frame's footprint).
        let sample = |i, j| lens_sample(map, i, j);
        if reduced == (fw, fh) && o.is_identity() {
            let grid = Grid {
                data: &source.data,
                stride: fw,
                x0: 0,
                y0: 0,
            };
            return lens_window_samples(plan, sample, reduced, &xs, &ys, &grid);
        }
        let region = if reduced == (fw, fh) {
            let r = Rect {
                x: xs.start,
                y: ys.start,
                width: xs.len(),
                height: ys.len(),
            };
            frame_region(source, o, r)
        } else {
            resample_window(
                fw,
                fh,
                rw,
                rh,
                filter,
                xs.clone(),
                ys.clone(),
                |y, first, out| o.frame_row(source, y, first, out),
            )
        };
        let grid = Grid {
            data: &region,
            stride: xs.len(),
            x0: xs.start,
            y0: ys.start,
        };
        return lens_window_samples(plan, sample, reduced, &xs, &ys, &grid);
    }
    if reduced == (fw, fh) {
        // Unreduced: the source read through the turns, without a copy of
        // the frame.
        return catmull_rom_window(plan, point, reduced, &xs, &ys, |x, y| {
            let s = o.source_pixel(x, y) * 3;
            [source.data[s], source.data[s + 1], source.data[s + 2]]
        });
    }
    let region = resample_window(
        fw,
        fh,
        rw,
        rh,
        filter,
        xs.clone(),
        ys.clone(),
        |y, first, out| o.frame_row(source, y, first, out),
    );
    let stride = xs.len() * 3;
    catmull_rom_window(plan, point, reduced, &xs, &ys, |x, y| {
        let i = (y - ys.start) * stride + (x - xs.start) * 3;
        [region[i], region[i + 1], region[i + 2]]
    })
}

/// Where a window pixel samples through a lens that warps (on the reduced
/// frame) and its vignetting gain.
struct LensSample {
    green: [f64; 2],
    /// Red's and blue's points with a chromatic aberration.
    red_blue: Option<[[f64; 2]; 2]>,
    gain: f32,
}

/// Pixels held as one row-major block from `(x0, y0)`, `stride` pixels a
/// row (interleaved RGB).
struct Grid<'a> {
    data: &'a [f32],
    stride: usize,
    x0: usize,
    y0: usize,
}

impl Grid<'_> {
    /// The row `y`'s pixels from column `x0`.
    #[inline]
    fn row(&self, y: usize) -> &[f32] {
        let start = (y - self.y0) * self.stride * 3;
        &self.data[start..start + self.stride * 3]
    }
}

/// [`catmull_rom_taps`] with the columns as offsets into a [`Grid`] row.
#[inline]
fn grid_taps(coordinate: f64, n: usize, range: &Range<usize>, x0: usize) -> ([usize; 4], [f32; 4]) {
    let (taps, weights) = catmull_rom_taps(coordinate, n, range);
    (taps.map(|x| (x - x0) * 3), weights)
}

/// Catmull-Rom of all three channels at `p` on a `size` image whose pixels
/// `xs x ys` `grid` holds.
#[inline]
fn catmull_rom_at(
    p: [f64; 2],
    size: (usize, usize),
    xs: &Range<usize>,
    ys: &Range<usize>,
    grid: &Grid,
) -> [f32; 3] {
    let (cols, wx) = grid_taps(p[0], size.0, xs, grid.x0);
    let (rows, wy) = catmull_rom_taps(p[1], size.1, ys);
    let mut acc = [0.0f32; 3];
    for (&row, wr) in rows.iter().zip(wy) {
        let line = grid.row(row);
        let mut h = [0.0f32; 3];
        for (&col, wc) in cols.iter().zip(wx) {
            let px = &line[col..col + 3];
            h[0] += wc * px[0];
            h[1] += wc * px[1];
            h[2] += wc * px[2];
        }
        acc[0] += wr * h[0];
        acc[1] += wr * h[1];
        acc[2] += wr * h[2];
    }
    acc
}

/// [`catmull_rom_at`] of channel `c` only.
#[inline]
fn catmull_rom_channel(
    p: [f64; 2],
    size: (usize, usize),
    xs: &Range<usize>,
    ys: &Range<usize>,
    grid: &Grid,
    c: usize,
) -> f32 {
    let (cols, wx) = grid_taps(p[0], size.0, xs, grid.x0);
    let (rows, wy) = catmull_rom_taps(p[1], size.1, ys);
    let mut acc = 0.0f32;
    for (&row, wr) in rows.iter().zip(wy) {
        let line = grid.row(row);
        let mut h = 0.0f32;
        for (&col, wc) in cols.iter().zip(wx) {
            h += wc * line[col + c];
        }
        acc += wr * h;
    }
    acc
}

/// [`catmull_rom_window`] through a lens: green at its point, red and blue
/// at theirs with a chromatic aberration, times the vignetting gain.
fn lens_window_samples(
    plan: &Plan,
    sample: impl Fn(usize, usize) -> LensSample,
    size: (usize, usize),
    xs: &Range<usize>,
    ys: &Range<usize>,
    grid: &Grid,
) -> Vec<f32> {
    let (ww, wh) = (plan.window_width, plan.window_height);
    let mut data = Vec::with_capacity(ww * wh * 3);
    for j in 0..wh {
        for i in 0..ww {
            let s = sample(i, j);
            let mut px = match s.red_blue {
                None => catmull_rom_at(s.green, size, xs, ys, grid),
                Some([red, blue]) => [
                    catmull_rom_channel(red, size, xs, ys, grid, 0),
                    catmull_rom_channel(s.green, size, xs, ys, grid, 1),
                    catmull_rom_channel(blue, size, xs, ys, grid, 2),
                ],
            };
            if s.gain != 1.0 {
                for c in &mut px {
                    *c *= s.gain;
                }
            }
            data.extend_from_slice(&px);
        }
    }
    data
}

/// Catmull-Rom at every window pixel's center (`point(i, j)`) on a
/// `size` image whose pixels `xs x ys` `pixel(x, y)` reads.
fn catmull_rom_window(
    plan: &Plan,
    point: impl Fn(usize, usize) -> [f64; 2],
    size: (usize, usize),
    xs: &Range<usize>,
    ys: &Range<usize>,
    pixel: impl Fn(usize, usize) -> [f32; 3],
) -> Vec<f32> {
    let (ww, wh) = (plan.window_width, plan.window_height);
    let mut data = Vec::with_capacity(ww * wh * 3);
    for j in 0..wh {
        for i in 0..ww {
            let p = point(i, j);
            let (cols, wx) = catmull_rom_taps(p[0], size.0, xs);
            let (rows, wy) = catmull_rom_taps(p[1], size.1, ys);
            let mut acc = [0.0f32; 3];
            for (&row, wr) in rows.iter().zip(wy) {
                let mut h = [0.0f32; 3];
                for (&col, wc) in cols.iter().zip(wx) {
                    let px = pixel(col, row);
                    h[0] += wc * px[0];
                    h[1] += wc * px[1];
                    h[2] += wc * px[2];
                }
                acc[0] += wr * h[0];
                acc[1] += wr * h[1];
                acc[2] += wr * h[2];
            }
            data.extend_from_slice(&acc);
        }
    }
    data
}

#[cfg(test)]
mod tests {
    use super::*;

    fn geometry(json: &str) -> Geometry {
        Geometry::from_value(&serde_json::from_str(json).unwrap()).unwrap()
    }

    fn size(json: &str, w: usize, h: usize, m: usize) -> (usize, usize) {
        let p = plan(&geometry(json), w, h, m).unwrap();
        (p.width, p.height)
    }

    const CROP_60: &str = r#"{"crop":{"left":0.2,"top":0.2,"right":0.8,"bottom":0.8}}"#;

    #[test]
    fn angle_zero_output_sizes() {
        // The crop fits: the frame itself, cropped (1536 x 1025).
        assert_eq!(size(CROP_60, 2560, 1707, 2048), (1536, 1025));
        // Reduced: the largest virtual whole whose crop fits M.
        let p = plan(&geometry(CROP_60), 2560, 1707, 1280).unwrap();
        assert_eq!((p.width, p.height), (1280, 853));
        assert_eq!(p.scale_long_edge, 2134);
        // M = 0: the working size.
        assert_eq!(size(CROP_60, 2560, 1707, 0), (1536, 1025));
    }

    #[test]
    fn never_enlarges_and_keeps_to_the_cap() {
        for (w, h) in [
            (2560usize, 1707usize),
            (1707, 2560),
            (1200, 800),
            (997, 1003),
        ] {
            for crop in [
                CROP_60,
                r#"{"crop":{"left":0.05,"top":0.31,"right":0.37,"bottom":0.93}}"#,
                r#"{"crop":{"left":0.5,"top":0,"right":0.5001,"bottom":1}}"#,
                r#"{"rotate":90,"crop":{"left":0.1,"top":0.1,"right":0.95,"bottom":0.6}}"#,
            ] {
                let g = geometry(crop);
                let (fw, fh) = Orientation::new(&g, w, h).frame_size();
                let c = &g.crop;
                let crop_w = ((c.right - c.left) * fw as f64).round() as usize;
                for m in [0usize, 64, 333, 1024, 1280, 2048, 4096] {
                    let p = plan(&g, w, h, m).unwrap();
                    assert!(p.width >= 1 && p.height >= 1);
                    // At most the crop's own pixels (its edges are rounded).
                    assert!(p.width <= crop_w + 1, "{crop} {m}: {p:?}");
                    if m > 0 {
                        assert!(p.width.max(p.height) <= m, "{crop} {m}: {p:?}");
                    }
                    // The window holds the output and stays on the photo.
                    assert!(p.output.x + p.output.width <= p.window_width);
                    assert!(p.output.y + p.output.height <= p.window_height);
                    assert!(p.scale_long_edge <= fw.max(fh));
                }
            }
        }
    }

    #[test]
    fn quarter_turns_swap_the_frame() {
        assert_eq!(size(r#"{"rotate":90}"#, 300, 200, 0), (200, 300));
        assert_eq!(
            size(r#"{"rotate":270,"flipH":true}"#, 300, 200, 0),
            (200, 300)
        );
        assert_eq!(size(r#"{"rotate":180}"#, 300, 200, 0), (300, 200));
        assert_eq!(size(r#"{"rotate":90}"#, 300, 200, 150), (100, 150));
        // A crop is on the turned frame: the left half of a 200-wide frame.
        let half = r#"{"rotate":90,"crop":{"left":0,"top":0,"right":0.5,"bottom":1}}"#;
        assert_eq!(size(half, 300, 200, 0), (100, 300));
    }

    #[test]
    fn frame_pixels_follow_the_turn_and_the_flips() {
        // Source 3 x 2: pixel value = index.
        let source = LinearImage {
            width: 3,
            height: 2,
            data: (0..6).flat_map(|i| [i as f32; 3]).collect(),
        };
        let frame = |json: &str| {
            let g = geometry(json);
            let p = plan(&g, 3, 2, 0).unwrap();
            let img = working_image(&source, &p, Filter::Lanczos3);
            (
                (img.width, img.height),
                img.data
                    .chunks_exact(3)
                    .map(|px| px[0] as usize)
                    .collect::<Vec<_>>(),
            )
        };
        // 0 1 2 / 3 4 5 turned clockwise: 3 0 / 4 1 / 5 2.
        assert_eq!(frame(r#"{"rotate":90}"#), ((2, 3), vec![3, 0, 4, 1, 5, 2]));
        assert_eq!(frame(r#"{"rotate":180}"#), ((3, 2), vec![5, 4, 3, 2, 1, 0]));
        assert_eq!(frame(r#"{"rotate":270}"#), ((2, 3), vec![2, 5, 1, 4, 0, 3]));
        assert_eq!(frame(r#"{"flipH":true}"#), ((3, 2), vec![2, 1, 0, 5, 4, 3]));
        assert_eq!(frame(r#"{"flipV":true}"#), ((3, 2), vec![3, 4, 5, 0, 1, 2]));
        assert_eq!(
            frame(r#"{"rotate":90,"flipH":true}"#),
            ((2, 3), vec![0, 3, 1, 4, 2, 5])
        );
    }

    #[test]
    fn a_turned_crop_is_brought_inside_the_frame() {
        // The whole frame at 10 degrees: its corners leave the frame, so the
        // crop shrinks about the center until they are inside.
        let g = geometry(r#"{"angle":10}"#);
        let c = crop_corners(&g, 3000, 2000).unwrap();
        for (a, b) in [(0.0, 0.0), (1.0, 0.0), (0.0, 1.0), (1.0, 1.0)] {
            let x = c.top_left[0] + a * c.across[0] + b * c.down[0];
            let y = c.top_left[1] + a * c.across[1] + b * c.down[1];
            assert!((-1e-6..=3000.0 + 1e-6).contains(&x), "{x}");
            assert!((-1e-6..=2000.0 + 1e-6).contains(&y), "{y}");
        }
        // The largest inscribed: one corner pair touches the frame.
        assert!(c.width < 3000.0 && c.width > 2000.0, "{c:?}");
        let p = plan(&g, 3000, 2000, 1000).unwrap();
        assert_eq!(p.width, 1000);
        assert_eq!(p.height, (c.height * 1000.0 / c.width).round() as usize);
        assert_eq!(
            p.scale_long_edge,
            (3000.0 * 1000.0 / c.width).round() as usize
        );
    }

    #[test]
    fn every_turned_output_pixel_comes_from_inside_the_frame() {
        for (w, h) in [(3000usize, 2000usize), (1707, 2560), (640, 640)] {
            for json in [
                r#"{"angle":10}"#,
                r#"{"angle":-20}"#,
                r#"{"angle":3,"rotate":90,"crop":{"left":0.1,"top":0.15,"right":0.85,"bottom":0.9}}"#,
                r#"{"angle":-7.5,"flipH":true,"crop":{"left":0.05,"top":0.3,"right":0.6,"bottom":0.95}}"#,
                r#"{"angle":44,"crop":{"left":0.5,"top":0,"right":0.5,"bottom":1}}"#,
            ] {
                let g = geometry(json);
                for m in [0usize, 97, 1280] {
                    let p = plan(&g, w, h, m).unwrap();
                    let (fw, fh) = p.frame_size();
                    // The map is affine: its extremes are on the border.
                    let border = (0..p.width)
                        .flat_map(|i| [(i, 0), (i, p.height - 1)])
                        .chain((0..p.height).flat_map(|j| [(0, j), (p.width - 1, j)]));
                    for (i, j) in border {
                        let [x, y] = p.turned_point(i, j).unwrap();
                        assert!(
                            x > 0.0 && x < fw as f64 && y > 0.0 && y < fh as f64,
                            "{json} {w}x{h} M {m}: ({i}, {j}) at ({x}, {y})"
                        );
                    }
                    assert_eq!(p.output.width, p.width);
                    if m > 0 {
                        assert!(p.width.max(p.height) <= m);
                    }
                }
            }
        }
    }

    #[test]
    fn invalid_turned_crops_are_errors() {
        let code = |json: &str| plan(&geometry(json), 1000, 1000, 0).unwrap_err().code;
        // Not a rectangle at this angle: the top edge would go up-left.
        assert_eq!(
            code(r#"{"angle":45,"crop":{"left":0,"top":0.5,"right":1,"bottom":0.5}}"#),
            "invalidCrop"
        );
        assert_eq!(
            code(r#"{"angle":30,"crop":{"left":0.5,"top":0.5,"right":0.5,"bottom":0.5}}"#),
            "invalidCrop"
        );
        // A center on the frame's edge leaves nothing inside.
        assert_eq!(
            code(r#"{"angle":45,"crop":{"left":0,"top":0,"right":0,"bottom":1}}"#),
            "invalidCrop"
        );
        let e = plan(
            &geometry(r#"{"angle":45,"crop":{"left":0,"top":0.5,"right":1,"bottom":0.5}}"#),
            1000,
            1000,
            0,
        )
        .unwrap_err();
        assert_eq!(e.path, "geometry.crop");
    }

    #[test]
    fn decode_size_reaches_the_crop() {
        let half = geometry(r#"{"crop":{"left":0.25,"top":0.25,"right":0.75,"bottom":0.75}}"#);
        // 1200 x 800, half crop (600 x 400), M = 600: the original's size.
        assert_eq!(
            decode_long_edge(Some(&half), 1200, 800, 600, 4096),
            Ok(1200)
        );
        assert_eq!(decode_long_edge(Some(&half), 1200, 800, 300, 4096), Ok(600));
        assert_eq!(
            decode_long_edge(Some(&half), 6000, 4000, 2048, 4096),
            Ok(4096)
        );
        assert_eq!(decode_long_edge(Some(&half), 6000, 4000, 2048, 0), Ok(4096));
        assert_eq!(decode_long_edge(Some(&half), 6000, 4000, 4000, 0), Ok(6000));
        assert_eq!(decode_long_edge(Some(&half), 6000, 4000, 0, 4096), Ok(4096));
        assert_eq!(decode_long_edge(Some(&half), 6000, 4000, 0, 0), Ok(6000));
        // Without a geometry: the photo fitted to M.
        assert_eq!(decode_long_edge(None, 6000, 4000, 2048, 4096), Ok(2048));
        assert_eq!(decode_long_edge(None, 1200, 800, 2048, 4096), Ok(1200));
        // A quarter turn: the crop is on the turned frame (800 x 1200).
        let top = geometry(r#"{"rotate":90,"crop":{"left":0,"top":0,"right":1,"bottom":0.5}}"#);
        assert_eq!(decode_long_edge(Some(&top), 1200, 800, 400, 0), Ok(600));
    }

    #[test]
    fn output_size_without_a_geometry_is_the_fitted_source() {
        assert_eq!(output_size(None, 6000, 4000, 2560), Ok((2560, 1707)));
        assert_eq!(output_size(None, 600, 400, 0), Ok((600, 400)));
        let turned = geometry(r#"{"rotate":90}"#);
        assert_eq!(output_size(Some(&turned), 600, 400, 300), Ok((200, 300)));
    }

    fn reduced_of(p: &Plan) -> (usize, usize) {
        match &p.sampling {
            Sampling::Turned { reduced, .. } => *reduced,
            Sampling::Aligned { .. } => panic!("not turned"),
        }
    }

    #[test]
    fn a_perspective_samples_the_canvas_like_a_straightened_crop() {
        let g = geometry(r#"{"perspective":{"vertical":-30}}"#);
        // The canvas is the frame's size; angle 0 is not the aligned path.
        let p = plan(&g, 3000, 2000, 0).unwrap();
        assert_eq!((p.width, p.height), (3000, 2000));
        assert!(p.virtual_crop().is_none() && !p.window_is_source());
        let p = plan(&g, 3000, 2000, 1000).unwrap();
        assert_eq!((p.width, p.height), (1000, 667));
        assert_eq!(p.scale_long_edge, 1000);
        assert_eq!(reduced_of(&p), (1000, 667));
        assert_eq!(output_size(Some(&g), 3000, 2000, 1000), Ok((1000, 667)));
        // A perspective and the identity's values: the identity, aligned.
        let neutral = geometry(r#"{"perspective":{"scale":100},"constrain":true}"#);
        assert!(neutral.is_identity());
        let crop = geometry(r#"{"perspective":{"scale":100},"crop":{"right":0.5}}"#);
        assert!(plan(&crop, 3000, 2000, 0).unwrap().virtual_crop().is_some());
    }

    #[test]
    fn output_pixels_come_through_the_inverse_warp() {
        let g = geometry(
            r#"{"perspective":{"vertical":-40,"horizontal":15,"rotate":2,"scale":90},"angle":3,"crop":{"left":0.1,"top":0.05,"right":0.9,"bottom":0.95}}"#,
        );
        let (w, h) = (3000usize, 2000usize);
        let warp = Warp::new(&g.perspective, w, h).unwrap();
        let c = crop_corners(&g, w, h).unwrap();
        for m in [0usize, 700] {
            let p = plan(&g, w, h, m).unwrap();
            assert_eq!(p.crop_corners(), Some(c));
            for (i, j) in [(0, 0), (17, p.height / 2), (p.width - 1, p.height - 1)] {
                let a = (i as f64 + 0.5) / p.width as f64;
                let b = (j as f64 + 0.5) / p.height as f64;
                let q = [
                    c.top_left[0] + a * c.across[0] + b * c.down[0],
                    c.top_left[1] + a * c.across[1] + b * c.down[1],
                ];
                assert_eq!(p.turned_point(i, j), warp.to_frame(q));
            }
        }
    }

    #[test]
    fn constrain_keeps_every_output_pixel_inside_the_photo() {
        for (w, h) in [(3000usize, 2000usize), (1707, 2560)] {
            for json in [
                r#"{"perspective":{"vertical":-60},"constrain":true}"#,
                r#"{"perspective":{"horizontal":70,"rotate":-6,"aspect":40},"constrain":true}"#,
                r#"{"perspective":{"scale":70,"x":-60,"y":30},"constrain":true}"#,
                r#"{"perspective":{"vertical":35},"angle":-4,"constrain":true,"crop":{"left":0.05,"top":0.1,"right":0.8,"bottom":0.9}}"#,
            ] {
                let g = geometry(json);
                for m in [0usize, 97, 1280] {
                    let p = plan(&g, w, h, m).unwrap();
                    let (fw, fh) = p.frame_size();
                    let border = (0..p.width)
                        .flat_map(|i| [(i, 0), (i, p.height - 1)])
                        .chain((0..p.height).flat_map(|j| [(0, j), (p.width - 1, j)]));
                    for (i, j) in border {
                        let [x, y] = p.turned_point(i, j).unwrap();
                        assert!(
                            x > 0.0 && x < fw as f64 && y > 0.0 && y < fh as f64,
                            "{json} {w}x{h} M {m}: ({i}, {j}) at ({x}, {y})"
                        );
                    }
                    if m > 0 {
                        assert!(p.width.max(p.height) <= m);
                    }
                    assert!(p.output.x + p.output.width <= p.window_width);
                }
                // The output is the constrained crop's size.
                let open = plan(
                    &geometry(&json.replace(r#","constrain":true"#, "")),
                    w,
                    h,
                    0,
                )
                .unwrap();
                let fitted = plan(&g, w, h, 0).unwrap();
                assert!(fitted.width <= open.width, "{json}");
                if !json.contains("angle") {
                    assert!(fitted.width < open.width, "{json}");
                }
            }
        }
        // Without constrain the corners a perspective uncovers come from
        // outside the photo (its edge is sampled there).
        let p = plan(
            &geometry(r#"{"perspective":{"vertical":-40}}"#),
            3000,
            2000,
            0,
        )
        .unwrap();
        let [x, _] = p.turned_point(p.width - 1, p.height - 1).unwrap();
        assert!(x > 3000.0, "{x}");
    }

    #[test]
    fn the_frame_is_reduced_by_the_output_and_the_warp() {
        let reduced = |json: &str| reduced_of(&plan(&geometry(json), 4000, 3000, 1000).unwrap());
        // A keystone keeps the scale at the center: like a straightened crop.
        assert_eq!(reduced(r#"{"perspective":{"vertical":-10}}"#), (1000, 750));
        // Half the scale reads twice the frame per output pixel.
        assert_eq!(reduced(r#"{"perspective":{"scale":50}}"#), (500, 375));
        // Magnified: retain the extra source resolution requested before the warp.
        assert_eq!(reduced(r#"{"perspective":{"scale":150}}"#), (1500, 1125));
        // Unreduced when the output reaches the frame.
        let p = plan(&geometry(r#"{"perspective":{"scale":150}}"#), 1000, 800, 0).unwrap();
        assert_eq!(reduced_of(&p), (1000, 800));
    }

    #[test]
    fn the_frame_key_follows_the_perspective_and_constrain() {
        let key = |json: &str| frame_key(&geometry(json), 1280);
        let base = key(r#"{"perspective":{"vertical":-10}}"#);
        assert_ne!(base, key(r#"{"perspective":{"vertical":-11}}"#));
        assert_ne!(base, key(r#"{"perspective":{"vertical":-10,"y":0.5}}"#));
        assert_ne!(
            base,
            key(r#"{"perspective":{"vertical":-10},"constrain":true}"#)
        );
        // Without a perspective `constrain` and `upright` do not render.
        assert_eq!(
            key(r#"{"rotate":90}"#),
            key(r#"{"rotate":90,"constrain":true,"upright":2}"#)
        );
    }

    #[test]
    fn a_magnifying_perspective_decodes_more() {
        let crop = r#""crop":{"left":0.25,"top":0.25,"right":0.75,"bottom":0.75}"#;
        let size = |perspective: &str| {
            decode_long_edge(
                Some(&geometry(&format!("{{{crop}{perspective}}}"))),
                6000,
                4000,
                1000,
                0,
            )
            .unwrap()
        };
        assert_eq!(size(""), 2000);
        assert_eq!(size(r#","perspective":{"vertical":-30}"#), 2000);
        assert_eq!(size(r#","perspective":{"scale":50}"#), 2000);
        assert!((3000..=3001).contains(&size(r#","perspective":{"scale":150}"#)));
    }
}
