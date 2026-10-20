//! Rendering `developSettings.geometry` (F3 #17122, spec "段 2"): the
//! geometry is applied where stage 2 starts, and only the output and a
//! margin around it go through the stage-2 pass. [`crate::geometry`]
//! defines the frame and the crop's coordinates.
//!
//! Order: quarter turns and flips (the order the frame's rows are read from
//! the source) -> the straighten angle (resampled in linear light) -> the
//! crop -> the output size.
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
//!   clamped to its edge (only the margin reaches them).

use crate::decode::{DecodeError, LinearImage};
use crate::geometry::{CropCorners, Geometry};
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
    /// `reduced` (per axis).
    Turned {
        corners: CropCorners,
        pad: usize,
        reduced: (usize, usize),
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
    /// angle. `None` at angle 0.
    pub fn turned_point(&self, i: usize, j: usize) -> Option<[f64; 2]> {
        match &self.sampling {
            Sampling::Turned { corners: c, .. } => {
                let a = (i as f64 + 0.5) / self.width as f64;
                let b = (j as f64 + 0.5) / self.height as f64;
                Some([
                    c.top_left[0] + a * c.across[0] + b * c.down[0],
                    c.top_left[1] + a * c.across[1] + b * c.down[1],
                ])
            }
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
    let orientation = Orientation::new(g, source_width, source_height);
    let (fw, fh) = orientation.frame_size();
    let corners = crop_corners(g, fw, fh)?;
    Ok(if g.angle == 0.0 {
        aligned_plan(g, orientation, max_dimension)
    } else {
        turned_plan(corners, orientation, max_dimension)
    })
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
    }
}

fn turned_plan(corners: CropCorners, orientation: Orientation, m: usize) -> Plan {
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
    let reduced = if k < 1.0 {
        fitted_size(fw, fh, scale_long_edge)
    } else {
        (fw, fh)
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
        },
    }
}

/// What a geometry frame's working image depends on besides the source:
/// the rendered geometry (not its aspect lock) and `max_dimension`.
pub fn frame_key(g: &Geometry, max_dimension: usize) -> String {
    let c = &g.crop;
    format!(
        "{}|{}|{}|{:?}|{:?}|{:?}|{:?}|{:?}|{max_dimension}",
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

/// The long edge to decode a JPEG / PNG original of `width x height` (EXIF
/// orientation applied) at so that its crop reaches `max_dimension`:
/// `min(cap, long edge, ceil(long edge * M / crop long edge))` with the
/// crop's long edge in the original's pixels (`M` 0: the original's size;
/// `cap` 0: no cap). Without a geometry the crop is the whole photo
/// (`min(cap, long edge, M)`).
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
            let corners = crop_corners(g, fw, fh)?;
            libm::ceil(long as f64 * m as f64 / corners.width.max(corners.height)) as usize
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
    let data = match &plan.sampling {
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
        } => turned_window(source, plan, corners, *pad, *reduced, filter),
    };
    LinearImage {
        width: plan.window_width,
        height: plan.window_height,
        data,
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
/// Catmull-Rom at every window pixel's center.
fn turned_window(
    source: &LinearImage,
    plan: &Plan,
    c: &CropCorners,
    pad: usize,
    reduced: (usize, usize),
    filter: Filter,
) -> Vec<f32> {
    let o = &plan.orientation;
    let (fw, fh) = o.frame_size();
    let (rw, rh) = reduced;
    let (sx, sy) = (rw as f64 / fw as f64, rh as f64 / fh as f64);
    let (wo, ho) = (plan.width as f64, plan.height as f64);
    let pad = pad as f64;
    // Window pixel (i, j) on the reduced frame (continuous coordinates).
    let point = |i: usize, j: usize| -> [f64; 2] {
        let a = (i as f64 - pad + 0.5) / wo;
        let b = (j as f64 - pad + 0.5) / ho;
        [
            (c.top_left[0] + a * c.across[0] + b * c.down[0]) * sx,
            (c.top_left[1] + a * c.across[1] + b * c.down[1]) * sy,
        ]
    };
    let (ww, wh) = (plan.window_width, plan.window_height);
    let ends = [
        point(0, 0),
        point(ww - 1, 0),
        point(0, wh - 1),
        point(ww - 1, wh - 1),
    ];
    // The reduced frame's pixels the window reads: the footprint's bounding
    // box, the taps' reach and a pixel for rounding.
    let range = |axis: usize, n: usize| {
        let lo = ends.iter().map(|p| p[axis]).fold(f64::INFINITY, f64::min);
        let hi = ends
            .iter()
            .map(|p| p[axis])
            .fold(f64::NEG_INFINITY, f64::max);
        let last = (n - 1) as f64;
        let first = (libm::floor(lo - 0.5) - 2.0).clamp(0.0, last) as usize;
        let end = (libm::floor(hi - 0.5) + 3.0).clamp(0.0, last) as usize + 1;
        first..end
    };
    let (xs, ys) = (range(0, rw), range(1, rh));
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
}
