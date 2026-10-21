//! Upright (niho-photo#46, Lightroom's 自動 / 水平 / 垂直 / フル): the
//! perspective ([`Perspective`]'s `rotate`, `vertical` and `horizontal`)
//! that stands the photo's straight lines upright, found from the photo
//! itself. `docs/geometry-perspective.md` ("Upright") has the reasoning.
//!
//! 1. **The frame.** The working image after the quarter turns and flips
//!    (before the perspective), its luminance box-reduced to a long side of
//!    [`ANALYSIS_LONG_SIDE`], square-rooted (about perceptual) and scaled so
//!    its 99.5th percentile is 255 ([`LumaFrame`]).
//! 2. **Line segments** ([`line_segments`], LSD-like, no dependency): a
//!    Gaussian blur (sigma 1), Sobel gradients, then from the strongest
//!    pixel down, regions of 8-connected pixels whose gradient direction
//!    stays within 22.5 degrees of the region's (sign included). A region is
//!    a segment when its principal axis is at least 2.5% of the long side,
//!    its pixels spread at most 2 px (RMS) across it and fill half its
//!    rectangle; a region too curved for that is grown again at 11.25 and
//!    5.6 degrees (shorter, straighter pieces).
//! 3. **Families.** Segments within 25 degrees of vertical are the vertical
//!    lines, within 25 degrees of horizontal the horizontal ones (in the
//!    output's axes: the crop's straighten `angle` is taken off), weighted
//!    by length.
//! 4. **The fit.** The model is the renderer's own frame -> canvas map
//!    ([`crate::perspective`], `F = K . R` with aspect, scale and offsets
//!    neutral) followed by the crop's angle. Each line's end points go
//!    through it and the residual is the sine of its deviation from its
//!    axis. A coarse grid picks the start, then Levenberg-Marquardt on the
//!    iteratively reweighted Tukey biweight (5, 3 then 2 degrees) refines
//!    it; the families are taken again through the fitted model (lines
//!    near the edges of a strongly converging photo come in) and refined
//!    once more. Parameters stay within the sliders' ranges.
//!    - 水平 (Level): `rotate` from both families.
//!    - 垂直 (Vertical): `rotate` and `vertical` from the vertical lines.
//!    - フル (Full): `rotate`, `vertical` and `horizontal` from both.
//!    - 自動 (Auto): the three, scored by their misfit on every line plus a
//!      cost for each extra parameter and for the size of the correction;
//!      the lowest valid one.
//!
//!    A family a parameter needs without enough lines leaves it at 0 (Full
//!    falls back to Vertical, Vertical to Level).
//! 5. **No false corrections.** A fit is kept only when its lines agree:
//!    at least half the long side of length within 2 degrees, 3 lines for a
//!    perspective parameter (2 for Level) and 30% of the family's length.
//!    Otherwise the estimate is the identity with `reason` "noLines" and
//!    confidence 0. A correction past a slider's range stops at the range
//!    and halves the confidence.
//!
//! Everything is `f32` / `f64` arithmetic in a fixed order with `libm` for
//! the trigonometry (no threads, no hashing), so native and wasm agree bit
//! for bit and the same input gives the same estimate. The analysis image
//! is at most 1024 px and the loops are bounded (each pixel is grown at
//! most three times, at most [`MAX_LINES`] lines reach the fit).

use crate::decode::LinearImage;
use crate::geometry::{Geometry, Perspective};
use crate::perspective::{FOCAL_LENGTH, MAX_TILT_DEGREES};
use crate::{DevelopSettings, Session};
use serde_json::{json, Value};

/// Long side of the luminance image the lines are looked for on.
pub const ANALYSIS_LONG_SIDE: usize = 1024;
/// `reason` of an estimate that found no lines to stand upright.
pub const REASON_NO_LINES: &str = "noLines";
/// Most lines the fit reads (the longest).
const MAX_LINES: usize = 2048;
/// Lines the coarse grid reads (the longest).
const GRID_LINES: usize = 256;
/// Gradient magnitude (0..255 luminance per pixel) below which a pixel's
/// direction is not trusted (LSD's `q / sin(tau)` with `q = 2`).
const GRADIENT_THRESHOLD: f32 = 5.2;
/// Region growing's direction tolerances (degrees), the widest first.
const GROW_TOLERANCES_DEGREES: [f64; 3] = [22.5, 11.25, 5.625];
/// Most pixels one region may hold.
const MAX_REGION_PIXELS: usize = 16_384;
/// Shortest segment, over the analysis image's long side.
const MIN_SEGMENT_FRACTION: f64 = 0.025;
/// Most root-mean-square spread of a segment's pixels across it (pixels).
const MAX_SPREAD: f64 = 2.0;
/// Least share of a segment's rectangle its region fills.
const MIN_DENSITY: f64 = 0.5;
/// Most the mean gradient may lean along a segment (cosine): a line's
/// gradients cross it.
const MAX_ALONG: f64 = 0.4;
/// A line within this of vertical (horizontal) is a vertical (horizontal)
/// line, degrees.
const FAMILY_WINDOW_DEGREES: f64 = 25.0;
/// The robust loss's scales (degrees), the widest first.
const LOSS_SCHEDULE_DEGREES: [f64; 3] = [5.0, 3.0, 2.0];
/// A line within this of its axis after the correction agrees with it
/// (degrees; also the scale of the misfit).
const INLIER_DEGREES: f64 = 2.0;
/// Least agreeing length (over the frame's long side) a family needs.
const MIN_SUPPORT: f64 = 0.5;
/// Least agreeing lines for a perspective parameter, and for Level.
const MIN_PERSPECTIVE_LINES: usize = 3;
const MIN_LEVEL_LINES: usize = 2;
/// Least share of a family's length that agrees.
const MIN_INLIER_SHARE: f64 = 0.3;
/// Agreeing length (over the long side) at which the confidence stops
/// growing.
const FULL_SUPPORT: f64 = 2.0;
/// Auto: what Vertical's and Full's extra parameters cost against the
/// misfit (a share of the lines' length), and what a correction of 100 on
/// `vertical` / `horizontal` costs (quadratic).
const AUTO_VERTICAL_COST: f64 = 0.03;
const AUTO_FULL_COST: f64 = 0.05;
const AUTO_CORRECTION_COST: f64 = 0.1;
/// A small pull of `vertical` / `horizontal` toward 0 (cost at 100), so a
/// fit whose lines barely tell them apart stays small.
const REGULARIZATION: f64 = 0.05;
/// Levenberg-Marquardt's iterations per loss scale.
const MAX_ITERATIONS: usize = 40;
/// Central-difference steps of `rotate` (degrees), `vertical` and
/// `horizontal`.
const JACOBIAN_STEPS: [f64; 3] = [1e-3, 1e-2, 1e-2];

/// The Upright button ([`crate::geometry::Geometry::upright`]'s 1..=4).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum UprightMode {
    /// 自動: the best of the three.
    Auto,
    /// 水平: `rotate` only.
    Level,
    /// 垂直: `rotate` and `vertical`.
    Vertical,
    /// フル: `rotate`, `vertical` and `horizontal`.
    Full,
}

impl UprightMode {
    /// The mode of `geometry.upright` (1 auto, 2 level, 3 vertical, 4 full).
    pub fn from_number(n: u32) -> Option<Self> {
        match n {
            1 => Some(UprightMode::Auto),
            2 => Some(UprightMode::Level),
            3 => Some(UprightMode::Vertical),
            4 => Some(UprightMode::Full),
            _ => None,
        }
    }

    pub fn number(self) -> u32 {
        match self {
            UprightMode::Auto => 1,
            UprightMode::Level => 2,
            UprightMode::Vertical => 3,
            UprightMode::Full => 4,
        }
    }
}

/// What [`estimate`] found.
#[derive(Debug, Clone, PartialEq)]
pub struct UprightEstimate {
    /// The correction (`rotate`, `vertical`, `horizontal` to 0.01; the
    /// others neutral). The identity when nothing was found.
    pub perspective: Perspective,
    /// The mode the perspective was fitted in (Auto's choice, or the mode a
    /// family without enough lines fell back to; the asked one when
    /// nothing was found).
    pub mode: UprightMode,
    /// 0..1: how much agreeing line length there is and how well it agrees
    /// (halved when the correction stopped at a slider's range; 0 when
    /// nothing was found).
    pub confidence: f64,
    /// Lines taken as vertical / horizontal (through the correction).
    pub vertical_lines: usize,
    pub horizontal_lines: usize,
    /// [`REASON_NO_LINES`] when nothing was found.
    pub reason: Option<&'static str>,
}

impl UprightEstimate {
    /// `{ perspective: { vertical, horizontal, rotate, aspect, scale, x, y },
    /// mode, confidence, lines: { vertical, horizontal }, reason? }`.
    pub fn to_value(&self) -> Value {
        let p = &self.perspective;
        let mut v = json!({
            "perspective": {
                "vertical": p.vertical,
                "horizontal": p.horizontal,
                "rotate": p.rotate,
                "aspect": p.aspect,
                "scale": p.scale,
                "x": p.x,
                "y": p.y,
            },
            "mode": self.mode.number(),
            "confidence": self.confidence,
            "lines": { "vertical": self.vertical_lines, "horizontal": self.horizontal_lines },
        });
        if let Some(reason) = self.reason {
            v["reason"] = Value::from(reason);
        }
        v
    }
}

impl Session {
    /// Upright: the perspective that stands this photo's lines upright in
    /// `mode` ([`estimate`]), found on the frame of `settings`' quarter
    /// turns and flips with its straighten angle taken off. Reads the
    /// decoded source only (the frames' kept state is left as it was).
    pub fn estimate_upright(
        &self,
        settings: &DevelopSettings,
        mode: UprightMode,
    ) -> UprightEstimate {
        let geometry = settings.geometry.clone().unwrap_or_default();
        estimate_image(self.source.image(), &geometry, mode)
    }
}

/// [`estimate`] on `source` (the working image, EXIF orientation applied)
/// with `geometry`'s quarter turns, flips and straighten angle.
pub fn estimate_image(
    source: &LinearImage,
    geometry: &Geometry,
    mode: UprightMode,
) -> UprightEstimate {
    estimate(&LumaFrame::new(source, geometry), geometry.angle, mode)
}

/// A luminance image of the frame (after the quarter turns and flips,
/// before the perspective) the lines are looked for on.
#[derive(Debug, Clone, PartialEq)]
pub struct LumaFrame {
    pub width: usize,
    pub height: usize,
    /// 0..255, about perceptual (module docs).
    pub data: Vec<f32>,
    /// The frame's size in its own pixels (the perspective's normalized
    /// coordinates are taken over it).
    pub frame_width: f64,
    pub frame_height: f64,
}

impl LumaFrame {
    /// The frame of `geometry` on `source`, reduced to a long side of at
    /// most [`ANALYSIS_LONG_SIDE`].
    pub fn new(source: &LinearImage, geometry: &Geometry) -> Self {
        let (w, h, mut data) = reduced_luminance(source);
        for v in &mut data {
            *v = v.sqrt();
        }
        normalize(&mut data);
        let rotate = geometry.rotate % 360;
        let (width, height, data) = turn(w, h, &data, rotate, geometry.flip_h, geometry.flip_v);
        let (fw, fh) = match rotate {
            90 | 270 => (source.height, source.width),
            _ => (source.width, source.height),
        };
        Self {
            width,
            height,
            data,
            frame_width: fw as f64,
            frame_height: fh as f64,
        }
    }

    /// A frame's luminance as it is (already turned, about perceptual, not
    /// negative; a rendered output measured again), scaled as [`Self::new`].
    pub fn from_plane(width: usize, height: usize, mut data: Vec<f32>) -> Self {
        assert_eq!(data.len(), width * height, "the plane's size");
        normalize(&mut data);
        Self {
            width,
            height,
            data,
            frame_width: width as f64,
            frame_height: height as f64,
        }
    }

    /// [`line_segments`] in the perspective's normalized coordinates (frame
    /// pixels centered and over the long side), the longest first.
    fn lines(&self) -> Vec<Line> {
        let long = self.frame_width.max(self.frame_height);
        let (sx, sy) = (
            self.frame_width / self.width as f64,
            self.frame_height / self.height as f64,
        );
        let normalized = |p: [f64; 2]| {
            [
                (p[0] * sx - self.frame_width / 2.0) / long,
                (p[1] * sy - self.frame_height / 2.0) / long,
            ]
        };
        let mut lines: Vec<Line> = line_segments(self.width, self.height, &self.data)
            .iter()
            .map(|s| {
                let (a, b) = (normalized(s.a), normalized(s.b));
                let (dx, dy) = (b[0] - a[0], b[1] - a[1]);
                Line {
                    a,
                    b,
                    length: (dx * dx + dy * dy).sqrt(),
                }
            })
            .collect();
        lines.sort_by(|p, q| {
            q.length
                .total_cmp(&p.length)
                .then(p.a[0].total_cmp(&q.a[0]))
                .then(p.a[1].total_cmp(&q.a[1]))
        });
        lines.truncate(MAX_LINES);
        lines
    }
}

/// The luminance of `source` box-reduced to a long side of at most
/// [`ANALYSIS_LONG_SIDE`] (negative values as 0).
fn reduced_luminance(source: &LinearImage) -> (usize, usize, Vec<f32>) {
    let (w, h) = (source.width, source.height);
    if w == 0 || h == 0 {
        return (0, 0, Vec::new());
    }
    let long = w.max(h);
    let (tw, th) = if long <= ANALYSIS_LONG_SIDE {
        (w, h)
    } else {
        (
            ((w * ANALYSIS_LONG_SIDE + long / 2) / long).max(1),
            ((h * ANALYSIS_LONG_SIDE + long / 2) / long).max(1),
        )
    };
    let mut out = vec![0.0f32; tw * th];
    let mut row = vec![0.0f32; w];
    for (j, out_row) in out.chunks_exact_mut(tw.max(1)).enumerate() {
        let y0 = j * h / th;
        let y1 = ((j + 1) * h / th).max(y0 + 1);
        row.fill(0.0);
        for y in y0..y1 {
            let line = &source.data[y * w * 3..(y + 1) * w * 3];
            for (sum, px) in row.iter_mut().zip(line.chunks_exact(3)) {
                let luminance = 0.2126 * px[0] + 0.7152 * px[1] + 0.0722 * px[2];
                *sum += luminance.max(0.0);
            }
        }
        for (i, value) in out_row.iter_mut().enumerate() {
            let x0 = i * w / tw;
            let x1 = ((i + 1) * w / tw).max(x0 + 1);
            let sum: f32 = row[x0..x1].iter().sum();
            *value = sum / ((x1 - x0) * (y1 - y0)) as f32;
        }
    }
    (tw, th, out)
}

/// Scales `data` (not negative) so its 99.5th percentile is 255 (at most
/// ten times its maximum's scale), capped at 255; all 0 when it is black.
fn normalize(data: &mut [f32]) {
    const BINS: usize = 4096;
    let max = data.iter().fold(0.0f32, |m, &v| if v > m { v } else { m });
    if max <= 1e-6 {
        data.fill(0.0);
        return;
    }
    let mut histogram = vec![0usize; BINS];
    for &v in data.iter() {
        let bin = ((v / max) * (BINS - 1) as f32) as usize;
        histogram[bin.min(BINS - 1)] += 1;
    }
    let target = data.len() - data.len() / 200;
    let mut seen = 0;
    let mut high_bin = BINS - 1;
    for (bin, &count) in histogram.iter().enumerate() {
        seen += count;
        if seen >= target {
            high_bin = bin;
            break;
        }
    }
    let high = ((high_bin + 1) as f32 / BINS as f32 * max).max(max * 0.1);
    let scale = 255.0 / high;
    for v in data.iter_mut() {
        *v = (*v * scale).min(255.0);
    }
}

/// `data` (`w x h`) turned clockwise by `rotate` and then mirrored (the
/// frame's order, `frame.rs`).
fn turn(
    w: usize,
    h: usize,
    data: &[f32],
    rotate: u32,
    flip_h: bool,
    flip_v: bool,
) -> (usize, usize, Vec<f32>) {
    if (rotate, flip_h, flip_v) == (0, false, false) {
        return (w, h, data.to_vec());
    }
    let (fw, fh) = match rotate {
        90 | 270 => (h, w),
        _ => (w, h),
    };
    let mut out = Vec::with_capacity(fw * fh);
    for y in 0..fh {
        for x in 0..fw {
            let x = if flip_h { fw - 1 - x } else { x };
            let y = if flip_v { fh - 1 - y } else { y };
            let (sx, sy) = match rotate {
                90 => (y, h - 1 - x),
                180 => (w - 1 - x, h - 1 - y),
                270 => (w - 1 - y, x),
                _ => (x, y),
            };
            out.push(data[sy * w + sx]);
        }
    }
    (fw, fh, out)
}

/// A straight line found on an image: its end points in the image's pixels
/// (pixel `n`'s center at `n + 0.5`).
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct Segment {
    pub a: [f64; 2],
    pub b: [f64; 2],
}

impl Segment {
    pub fn length(&self) -> f64 {
        let (dx, dy) = (self.b[0] - self.a[0], self.b[1] - self.a[1]);
        (dx * dx + dy * dy).sqrt()
    }

    /// The signed angle from vertical (degrees, `-90..=90`; positive when
    /// the line leans right going down, y down).
    pub fn from_vertical_degrees(&self) -> f64 {
        let (mut dx, mut dy) = (self.b[0] - self.a[0], self.b[1] - self.a[1]);
        if dy < 0.0 {
            dx = -dx;
            dy = -dy;
        }
        libm::atan2(dx, dy).to_degrees()
    }

    /// The signed angle from horizontal (degrees, `-90..=90`; positive when
    /// the line goes down to the right).
    pub fn from_horizontal_degrees(&self) -> f64 {
        let (mut dx, mut dy) = (self.b[0] - self.a[0], self.b[1] - self.a[1]);
        if dx < 0.0 {
            dx = -dx;
            dy = -dy;
        }
        libm::atan2(dy, dx).to_degrees()
    }
}

/// The straight line segments of a `width x height` luminance image (0..255)
/// (module docs, step 2), in the order they were found.
pub fn line_segments(width: usize, height: usize, luma: &[f32]) -> Vec<Segment> {
    assert_eq!(luma.len(), width * height, "the image's size");
    if width < 3 || height < 3 {
        return Vec::new();
    }
    let smooth = blur(width, height, luma);
    let gradient = Gradient::new(width, height, &smooth);
    let min_length = (MIN_SEGMENT_FRACTION * width.max(height) as f64).max(8.0);
    let tolerances = GROW_TOLERANCES_DEGREES.map(|d| libm::cos(d.to_radians()));
    let mut used: Vec<bool> = gradient
        .magnitude
        .iter()
        .map(|&m| m < GRADIENT_THRESHOLD)
        .collect();
    let mut segments = Vec::new();
    let mut region = Vec::new();
    for seed in gradient.seeds() {
        if used[seed] {
            continue;
        }
        for (attempt, &tolerance) in tolerances.iter().enumerate() {
            gradient.grow(seed, tolerance, &mut used, &mut region);
            match gradient.fit(&region, min_length) {
                Fitted::Segment(s) => {
                    segments.push(s);
                    break;
                }
                // Tighter tolerances only shorten it.
                Fitted::Short => break,
                Fitted::Curved => {
                    if attempt + 1 < tolerances.len() {
                        for &p in &region {
                            used[p] = false;
                        }
                    }
                }
            }
        }
    }
    segments
}

/// A separable Gaussian blur (sigma 1, radius 3, edges clamped).
fn blur(w: usize, h: usize, data: &[f32]) -> Vec<f32> {
    let mut kernel = [0.0f32; 4];
    for (k, value) in kernel.iter_mut().enumerate() {
        *value = libm::expf(-((k * k) as f32) / 2.0);
    }
    let sum = kernel[0] + 2.0 * (kernel[1] + kernel[2] + kernel[3]);
    for value in &mut kernel {
        *value /= sum;
    }
    let tap = |i: usize, k: isize, n: usize| (i as isize + k).clamp(0, n as isize - 1) as usize;
    let mut across = vec![0.0f32; w * h];
    for y in 0..h {
        let row = &data[y * w..(y + 1) * w];
        for x in 0..w {
            let mut v = kernel[0] * row[x];
            for k in 1..4isize {
                v += kernel[k as usize] * (row[tap(x, -k, w)] + row[tap(x, k, w)]);
            }
            across[y * w + x] = v;
        }
    }
    let mut out = vec![0.0f32; w * h];
    for y in 0..h {
        for x in 0..w {
            let mut v = kernel[0] * across[y * w + x];
            for k in 1..4isize {
                v += kernel[k as usize]
                    * (across[tap(y, -k, h) * w + x] + across[tap(y, k, h) * w + x]);
            }
            out[y * w + x] = v;
        }
    }
    out
}

/// Sobel gradients: magnitude (per pixel, 0 on the border) and unit
/// direction.
struct Gradient {
    width: usize,
    height: usize,
    magnitude: Vec<f32>,
    unit: Vec<[f32; 2]>,
}

enum Fitted {
    Segment(Segment),
    /// Shorter than a segment.
    Short,
    /// Long enough but not straight (or a blob).
    Curved,
}

impl Gradient {
    fn new(w: usize, h: usize, data: &[f32]) -> Self {
        let mut magnitude = vec![0.0f32; w * h];
        let mut unit = vec![[0.0f32; 2]; w * h];
        for y in 1..h - 1 {
            for x in 1..w - 1 {
                let p = |dx: usize, dy: usize| data[(y + dy - 1) * w + x + dx - 1];
                let gx = ((p(2, 0) + 2.0 * p(2, 1) + p(2, 2))
                    - (p(0, 0) + 2.0 * p(0, 1) + p(0, 2)))
                    / 8.0;
                let gy = ((p(0, 2) + 2.0 * p(1, 2) + p(2, 2))
                    - (p(0, 0) + 2.0 * p(1, 0) + p(2, 0)))
                    / 8.0;
                let m = (gx * gx + gy * gy).sqrt();
                magnitude[y * w + x] = m;
                if m > 0.0 {
                    unit[y * w + x] = [gx / m, gy / m];
                }
            }
        }
        Self {
            width: w,
            height: h,
            magnitude,
            unit,
        }
    }

    /// The pixels at or above the threshold, the strongest first (1024
    /// bins; a bin in index order).
    fn seeds(&self) -> Vec<usize> {
        const BINS: usize = 1024;
        let max = self
            .magnitude
            .iter()
            .fold(0.0f32, |m, &v| if v > m { v } else { m });
        if max < GRADIENT_THRESHOLD {
            return Vec::new();
        }
        let span = (max - GRADIENT_THRESHOLD).max(1e-6);
        let bin_of = |m: f32| {
            ((((m - GRADIENT_THRESHOLD) / span) * (BINS - 1) as f32) as usize).min(BINS - 1)
        };
        let mut counts = vec![0usize; BINS];
        for &m in &self.magnitude {
            if m >= GRADIENT_THRESHOLD {
                counts[bin_of(m)] += 1;
            }
        }
        // Start of each bin in the output, the highest bin first.
        let mut start = vec![0usize; BINS];
        let mut at = 0;
        for bin in (0..BINS).rev() {
            start[bin] = at;
            at += counts[bin];
        }
        let mut order = vec![0usize; at];
        for (i, &m) in self.magnitude.iter().enumerate() {
            if m >= GRADIENT_THRESHOLD {
                let bin = bin_of(m);
                order[start[bin]] = i;
                start[bin] += 1;
            }
        }
        order
    }

    /// Grows the region of `seed` into `region`: 8-connected free pixels
    /// whose direction is within `tolerance` (cosine) of the region's mean
    /// direction, marked used.
    fn grow(&self, seed: usize, tolerance: f64, used: &mut [bool], region: &mut Vec<usize>) {
        let (w, h) = (self.width, self.height);
        region.clear();
        region.push(seed);
        used[seed] = true;
        let mut sum = [self.unit[seed][0] as f64, self.unit[seed][1] as f64];
        let mut direction = unit_of(sum);
        let mut i = 0;
        'grow: while i < region.len() {
            let p = region[i];
            let (x, y) = (p % w, p / w);
            for ny in y.saturating_sub(1)..(y + 2).min(h) {
                for nx in x.saturating_sub(1)..(x + 2).min(w) {
                    let q = ny * w + nx;
                    if used[q] {
                        continue;
                    }
                    let u = self.unit[q];
                    if u[0] as f64 * direction[0] + u[1] as f64 * direction[1] >= tolerance {
                        used[q] = true;
                        region.push(q);
                        sum = [sum[0] + u[0] as f64, sum[1] + u[1] as f64];
                        direction = unit_of(sum);
                        if region.len() >= MAX_REGION_PIXELS {
                            break 'grow;
                        }
                    }
                }
            }
            i += 1;
        }
    }

    /// The segment of `region` (its principal axis through its weighted
    /// center, between the extreme pixels along it).
    fn fit(&self, region: &[usize], min_length: f64) -> Fitted {
        let w = self.width;
        let center = |p: usize| [(p % w) as f64 + 0.5, (p / w) as f64 + 0.5];
        let (mut weight, mut mx, mut my) = (0.0f64, 0.0f64, 0.0f64);
        let mut gradient = [0.0f64; 2];
        for &p in region {
            let m = self.magnitude[p] as f64;
            let [x, y] = center(p);
            weight += m;
            mx += m * x;
            my += m * y;
            gradient[0] += self.unit[p][0] as f64;
            gradient[1] += self.unit[p][1] as f64;
        }
        if weight <= 0.0 {
            return Fitted::Short;
        }
        mx /= weight;
        my /= weight;
        let (mut cxx, mut cyy, mut cxy) = (0.0f64, 0.0f64, 0.0f64);
        for &p in region {
            let m = self.magnitude[p] as f64;
            let [x, y] = center(p);
            let (dx, dy) = (x - mx, y - my);
            cxx += m * dx * dx;
            cyy += m * dy * dy;
            cxy += m * dx * dy;
        }
        let theta = 0.5 * libm::atan2(2.0 * cxy, cxx - cyy);
        let (sin, cos) = libm::sincos(theta);
        let (mut s_min, mut s_max) = (f64::INFINITY, f64::NEG_INFINITY);
        let (mut d_min, mut d_max) = (f64::INFINITY, f64::NEG_INFINITY);
        let mut across = 0.0f64;
        for &p in region {
            let m = self.magnitude[p] as f64;
            let [x, y] = center(p);
            let (dx, dy) = (x - mx, y - my);
            let s = dx * cos + dy * sin;
            let d = -dx * sin + dy * cos;
            s_min = s_min.min(s);
            s_max = s_max.max(s);
            d_min = d_min.min(d);
            d_max = d_max.max(d);
            across += m * d * d;
        }
        let length = s_max - s_min;
        if length < min_length {
            return Fitted::Short;
        }
        let spread = (across / weight).sqrt();
        let density = region.len() as f64 / ((length + 1.0) * (d_max - d_min + 1.0));
        let g = unit_of(gradient);
        let along = (g[0] * cos + g[1] * sin).abs();
        if region.len() >= MAX_REGION_PIXELS
            || spread > MAX_SPREAD
            || density < MIN_DENSITY
            || along > MAX_ALONG
        {
            return Fitted::Curved;
        }
        Fitted::Segment(Segment {
            a: [mx + s_min * cos, my + s_min * sin],
            b: [mx + s_max * cos, my + s_max * sin],
        })
    }
}

fn unit_of(v: [f64; 2]) -> [f64; 2] {
    let n = (v[0] * v[0] + v[1] * v[1]).sqrt();
    if n > 0.0 {
        [v[0] / n, v[1] / n]
    } else {
        [0.0, 0.0]
    }
}

/// A line in the perspective's normalized frame coordinates; `length` in
/// them (1 = the frame's long side).
#[derive(Debug, Clone, Copy)]
struct Line {
    a: [f64; 2],
    b: [f64; 2],
    length: f64,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Family {
    Vertical,
    Horizontal,
}

/// The fitted sliders.
#[derive(Debug, Clone, Copy, PartialEq, Default)]
struct Params {
    rotate: f64,
    vertical: f64,
    horizontal: f64,
}

impl Params {
    fn get(&self, i: usize) -> f64 {
        match i {
            0 => self.rotate,
            1 => self.vertical,
            _ => self.horizontal,
        }
    }

    /// `self` with parameter `i` at `value`, within its slider's range.
    fn with(mut self, i: usize, value: f64) -> Self {
        match i {
            0 => self.rotate = value.clamp(-10.0, 10.0),
            1 => self.vertical = value.clamp(-100.0, 100.0),
            _ => self.horizontal = value.clamp(-100.0, 100.0),
        }
        self
    }

    /// Whether a parameter of `free` stopped at its range.
    fn at_range(&self, free: Free) -> bool {
        self.rotate.abs() >= 10.0 - 1e-9
            || (free.vertical && self.vertical.abs() >= 100.0 - 1e-9)
            || (free.horizontal && self.horizontal.abs() >= 100.0 - 1e-9)
    }

    fn correction(&self) -> f64 {
        let (v, h) = (self.vertical / 100.0, self.horizontal / 100.0);
        v * v + h * h
    }
}

/// Which perspective parameters a fit moves (`rotate` always).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
struct Free {
    vertical: bool,
    horizontal: bool,
}

impl Free {
    const LEVEL: Free = Free {
        vertical: false,
        horizontal: false,
    };

    /// The parameter indices it moves.
    fn indices(self) -> Vec<usize> {
        let mut out = vec![0];
        if self.vertical {
            out.push(1);
        }
        if self.horizontal {
            out.push(2);
        }
        out
    }

    /// The families its lines come from: both for Level, else those of its
    /// perspective parameters.
    fn uses(self, family: Family) -> bool {
        match family {
            Family::Vertical => self.vertical || !self.horizontal,
            Family::Horizontal => self.horizontal || !self.vertical,
        }
    }

    fn mode(self) -> UprightMode {
        match (self.vertical, self.horizontal) {
            (false, false) => UprightMode::Level,
            (true, false) => UprightMode::Vertical,
            _ => UprightMode::Full,
        }
    }
}

/// The frame -> output map of some [`Params`]: the renderer's warp
/// (`perspective.rs`, aspect / scale / offsets neutral) on normalized
/// coordinates, then the crop's straighten angle.
struct Model {
    cos: f64,
    sin: f64,
    ph: f64,
    pv: f64,
    out_cos: f64,
    out_sin: f64,
}

impl Model {
    fn new(p: &Params, crop_angle: f64) -> Self {
        let (sin, cos) = libm::sincos(p.rotate.to_radians());
        let strength = libm::tan(MAX_TILT_DEGREES.to_radians()) / FOCAL_LENGTH;
        let (out_sin, out_cos) = libm::sincos(crop_angle.to_radians());
        Self {
            cos,
            sin,
            ph: -p.horizontal / 100.0 * strength,
            pv: -p.vertical / 100.0 * strength,
            out_cos,
            out_sin,
        }
    }

    fn map(&self, q: [f64; 2]) -> Option<[f64; 2]> {
        let u = q[0] * self.cos + q[1] * self.sin;
        let v = -q[0] * self.sin + q[1] * self.cos;
        let w = 1.0 + self.ph * u + self.pv * v;
        (w > 1e-6).then(|| [u / w, v / w])
    }

    /// The line's unit direction in the output's axes.
    fn direction(&self, line: &Line) -> Option<[f64; 2]> {
        let (a, b) = (self.map(line.a)?, self.map(line.b)?);
        let (dx, dy) = (b[0] - a[0], b[1] - a[1]);
        let d = [
            dx * self.out_cos + dy * self.out_sin,
            -dx * self.out_sin + dy * self.out_cos,
        ];
        let n = (d[0] * d[0] + d[1] * d[1]).sqrt();
        (n > 0.0 && n.is_finite()).then(|| [d[0] / n, d[1] / n])
    }

    /// The sine of the line's deviation from its family's axis (1 when it
    /// cannot be told).
    fn residual(&self, line: &Line, family: Family) -> f64 {
        let Some([dx, dy]) = self.direction(line) else {
            return 1.0;
        };
        match family {
            Family::Vertical if dy >= 0.0 => dx,
            Family::Vertical => -dx,
            Family::Horizontal if dx >= 0.0 => dy,
            Family::Horizontal => -dy,
        }
    }

    /// The family the line is taken as through this map (module docs, step
    /// 3), none for a diagonal.
    fn family(&self, line: &Line) -> Option<Family> {
        let [dx, dy] = self.direction(line)?;
        let window = libm::sin(FAMILY_WINDOW_DEGREES.to_radians());
        if dx.abs() <= window {
            Some(Family::Vertical)
        } else if dy.abs() <= window {
            Some(Family::Horizontal)
        } else {
            None
        }
    }

    /// The sine of the deviation from the nearer axis.
    fn nearest_residual(&self, line: &Line) -> f64 {
        match self.direction(line) {
            Some([dx, dy]) => dx.abs().min(dy.abs()),
            None => 1.0,
        }
    }
}

/// Tukey's biweight at scale `c`: the loss over its ceiling (0..1) and the
/// reweighting factor.
fn tukey(e: f64, c: f64) -> (f64, f64) {
    let t = (e / c) * (e / c);
    if t >= 1.0 {
        (1.0, 0.0)
    } else {
        let r = 1.0 - t;
        (1.0 - r * r * r, r * r)
    }
}

/// The lines a fit reads and their families.
type Assigned = Vec<(Line, Family)>;

fn total_length(lines: &[(Line, Family)]) -> f64 {
    lines.iter().map(|(l, _)| l.length).sum()
}

/// The robust cost (mean Tukey loss over the length, 0..1) plus the pull
/// toward no perspective.
fn cost(lines: &[(Line, Family)], p: &Params, crop_angle: f64, c: f64) -> f64 {
    let model = Model::new(p, crop_angle);
    let (mut sum, mut total) = (0.0, 0.0);
    for (line, family) in lines {
        sum += line.length * tukey(model.residual(line, *family), c).0;
        total += line.length;
    }
    let data = if total > 0.0 { sum / total } else { 0.0 };
    data + REGULARIZATION * p.correction()
}

fn residuals(lines: &[(Line, Family)], p: &Params, crop_angle: f64) -> Vec<f64> {
    let model = Model::new(p, crop_angle);
    lines
        .iter()
        .map(|(line, family)| model.residual(line, *family))
        .collect()
}

/// Solves `a x = b` (`n x n`, Gaussian elimination with partial pivoting);
/// `None` when singular.
fn solve(mut a: [[f64; 3]; 3], mut b: [f64; 3], n: usize) -> Option<[f64; 3]> {
    for col in 0..n {
        let pivot = (col..n)
            .max_by(|&i, &j| a[i][col].abs().total_cmp(&a[j][col].abs()))
            .unwrap_or(col);
        if a[pivot][col].abs() < 1e-300 {
            return None;
        }
        a.swap(col, pivot);
        b.swap(col, pivot);
        let pivot_row = a[col];
        for row in col + 1..n {
            let f = a[row][col] / pivot_row[col];
            for (target, p) in a[row][col..n].iter_mut().zip(&pivot_row[col..n]) {
                *target -= f * p;
            }
            b[row] -= f * b[col];
        }
    }
    let mut x = [0.0; 3];
    for row in (0..n).rev() {
        let mut v = b[row];
        for k in row + 1..n {
            v -= a[row][k] * x[k];
        }
        x[row] = v / a[row][row];
    }
    x.iter().all(|v| v.is_finite()).then_some(x)
}

/// Levenberg-Marquardt on the iteratively reweighted Tukey loss at each of
/// `scales` (degrees), from `start`.
fn refine(
    lines: &[(Line, Family)],
    start: Params,
    free: Free,
    crop_angle: f64,
    scales: &[f64],
) -> Params {
    let indices = free.indices();
    let n = indices.len();
    let total = total_length(lines);
    let mut p = start;
    if total <= 0.0 {
        return p;
    }
    for &degrees in scales {
        let c = libm::sin(degrees.to_radians());
        // The pull toward 0 in the weighted squares' units (module docs).
        let pull = REGULARIZATION * c * c * total / 3.0 / 1e4;
        let mut lambda = 1e-3;
        for _ in 0..MAX_ITERATIONS {
            let current = cost(lines, &p, crop_angle, c);
            let e = residuals(lines, &p, crop_angle);
            let jacobian: Vec<Vec<f64>> = indices
                .iter()
                .map(|&i| {
                    let h = JACOBIAN_STEPS[i];
                    let mut plus = p;
                    let mut minus = p;
                    match i {
                        0 => {
                            plus.rotate += h;
                            minus.rotate -= h;
                        }
                        1 => {
                            plus.vertical += h;
                            minus.vertical -= h;
                        }
                        _ => {
                            plus.horizontal += h;
                            minus.horizontal -= h;
                        }
                    }
                    let (up, down) = (
                        residuals(lines, &plus, crop_angle),
                        residuals(lines, &minus, crop_angle),
                    );
                    up.iter()
                        .zip(&down)
                        .map(|(u, d)| (u - d) / (2.0 * h))
                        .collect()
                })
                .collect();
            let mut a = [[0.0f64; 3]; 3];
            let mut g = [0.0f64; 3];
            for (k, ((line, _), &ek)) in lines.iter().zip(&e).enumerate() {
                let w = line.length * tukey(ek, c).1;
                if w == 0.0 {
                    continue;
                }
                for r in 0..n {
                    g[r] += w * jacobian[r][k] * ek;
                    for s in 0..n {
                        a[r][s] += w * jacobian[r][k] * jacobian[s][k];
                    }
                }
            }
            for (r, &i) in indices.iter().enumerate() {
                if i > 0 {
                    a[r][r] += pull;
                    g[r] += pull * p.get(i);
                }
            }
            let mut accepted = false;
            let mut small = false;
            for _ in 0..10 {
                let mut damped = a;
                for (r, row) in damped.iter_mut().enumerate().take(n) {
                    row[r] += lambda * a[r][r].max(1e-12);
                }
                let Some(delta) = solve(damped, [-g[0], -g[1], -g[2]], n) else {
                    lambda *= 4.0;
                    continue;
                };
                let mut next = p;
                for (r, &i) in indices.iter().enumerate() {
                    next = next.with(i, p.get(i) + delta[r]);
                }
                if cost(lines, &next, crop_angle, c) < current {
                    small = indices
                        .iter()
                        .all(|&i| (next.get(i) - p.get(i)).abs() < 1e-7);
                    p = next;
                    lambda = (lambda / 3.0).max(1e-9);
                    accepted = true;
                    break;
                }
                lambda *= 4.0;
            }
            if !accepted || small {
                break;
            }
        }
    }
    p
}

/// The coarse grid's best start (on the longest [`GRID_LINES`] lines, Tukey
/// at 5 degrees; the first of equal costs).
fn grid_start(lines: &[(Line, Family)], free: Free, crop_angle: f64) -> Params {
    let c = libm::sin(LOSS_SCHEDULE_DEGREES[0].to_radians());
    let sample = &lines[..lines.len().min(GRID_LINES)];
    let best_of = |candidates: &mut dyn Iterator<Item = Params>, on: &[(Line, Family)]| {
        let mut best = (f64::INFINITY, Params::default());
        for p in candidates {
            let k = cost(on, &p, crop_angle, c);
            if k < best.0 {
                best = (k, p);
            }
        }
        best.1
    };
    let steps = |lo: i32, hi: i32, step: f64| (lo..=hi).map(move |i| i as f64 * step);
    match (free.vertical, free.horizontal) {
        (false, false) => best_of(
            &mut steps(-20, 20, 0.5).map(|rotate| Params {
                rotate,
                ..Params::default()
            }),
            sample,
        ),
        (true, false) => best_of(
            &mut steps(-10, 10, 1.0).flat_map(|rotate| {
                steps(-10, 10, 10.0).map(move |vertical| Params {
                    rotate,
                    vertical,
                    horizontal: 0.0,
                })
            }),
            sample,
        ),
        (false, true) => best_of(
            &mut steps(-10, 10, 1.0).flat_map(|rotate| {
                steps(-10, 10, 10.0).map(move |horizontal| Params {
                    rotate,
                    vertical: 0.0,
                    horizontal,
                })
            }),
            sample,
        ),
        (true, true) => {
            // `rotate` and `vertical` from the vertical lines, then
            // `horizontal` (and `rotate` near it) from all.
            let verticals: Assigned = sample
                .iter()
                .filter(|(_, f)| *f == Family::Vertical)
                .copied()
                .collect();
            let first = best_of(
                &mut steps(-10, 10, 1.0).flat_map(|rotate| {
                    steps(-10, 10, 10.0).map(move |vertical| Params {
                        rotate,
                        vertical,
                        horizontal: 0.0,
                    })
                }),
                &verticals,
            );
            best_of(
                &mut steps(-1, 1, 1.0).flat_map(|turn| {
                    steps(-10, 10, 10.0).map(move |horizontal| Params {
                        rotate: (first.rotate + turn).clamp(-10.0, 10.0),
                        vertical: first.vertical,
                        horizontal,
                    })
                }),
                sample,
            )
        }
    }
}

/// One model fitted to the lines and how well they agree with it.
#[derive(Debug, Clone, Copy)]
struct Fit {
    free: Free,
    params: Params,
    /// Mean Tukey loss at [`INLIER_DEGREES`] over the families it read.
    misfit: f64,
    /// Agreeing length of the families it read, and whether each family
    /// it needs has enough agreeing lines.
    support: f64,
    valid: bool,
    clipped: bool,
    vertical_lines: usize,
    horizontal_lines: usize,
}

impl Fit {
    fn confidence(&self) -> f64 {
        let support = (self.support / FULL_SUPPORT).min(1.0);
        let agreement = (1.0 - self.misfit).max(0.0);
        support * agreement * if self.clipped { 0.5 } else { 1.0 }
    }
}

/// The lines of `lines` taken through `model` in families `free` reads.
fn assign(lines: &[Line], model: &Model, free: Free) -> Assigned {
    lines
        .iter()
        .filter_map(|l| model.family(l).filter(|&f| free.uses(f)).map(|f| (*l, f)))
        .collect()
}

/// Fits the model of `free` (module docs, step 4) and checks it (step 5).
fn fit(lines: &[Line], free: Free, crop_angle: f64) -> Fit {
    let identity = Model::new(&Params::default(), crop_angle);
    let first = assign(lines, &identity, free);
    let start = grid_start(&first, free, crop_angle);
    let p1 = refine(&first, start, free, crop_angle, &LOSS_SCHEDULE_DEGREES);
    let second = assign(lines, &Model::new(&p1, crop_angle), free);
    let params = refine(&second, p1, free, crop_angle, &LOSS_SCHEDULE_DEGREES[1..]);
    let model = Model::new(&params, crop_angle);
    let c = libm::sin(INLIER_DEGREES.to_radians());
    // Per family: total length, agreeing length and lines.
    let mut stats = [[0.0f64; 3]; 2];
    let mut loss = 0.0;
    for (line, family) in &second {
        let e = model.residual(line, *family);
        let k = match family {
            Family::Vertical => 0,
            Family::Horizontal => 1,
        };
        stats[k][0] += line.length;
        loss += line.length * tukey(e, c).0;
        if e.abs() <= c {
            stats[k][1] += line.length;
            stats[k][2] += 1.0;
        }
    }
    let total = stats[0][0] + stats[1][0];
    let enough = |s: [f64; 3], min_lines: usize| {
        s[1] >= MIN_SUPPORT && s[2] >= min_lines as f64 && s[1] >= MIN_INLIER_SHARE * s[0]
    };
    let valid = match (free.vertical, free.horizontal) {
        (false, false) => {
            let both = [total, stats[0][1] + stats[1][1], stats[0][2] + stats[1][2]];
            enough(both, MIN_LEVEL_LINES)
        }
        (v, h) => {
            (!v || enough(stats[0], MIN_PERSPECTIVE_LINES))
                && (!h || enough(stats[1], MIN_PERSPECTIVE_LINES))
        }
    };
    let (mut vertical_lines, mut horizontal_lines) = (0, 0);
    for line in lines {
        match model.family(line) {
            Some(Family::Vertical) => vertical_lines += 1,
            Some(Family::Horizontal) => horizontal_lines += 1,
            None => {}
        }
    }
    Fit {
        free,
        params,
        misfit: if total > 0.0 { loss / total } else { 1.0 },
        support: stats[0][1] + stats[1][1],
        valid,
        clipped: params.at_range(free),
        vertical_lines,
        horizontal_lines,
    }
}

/// Mean Tukey loss at [`INLIER_DEGREES`] of `lines` (each from its nearer
/// axis) through `p`: Auto's common measure of the candidates.
fn misfit_on(lines: &[Line], p: &Params, crop_angle: f64) -> f64 {
    let model = Model::new(p, crop_angle);
    let c = libm::sin(INLIER_DEGREES.to_radians());
    let (mut sum, mut total) = (0.0, 0.0);
    for line in lines {
        sum += line.length * tukey(model.nearest_residual(line), c).0;
        total += line.length;
    }
    if total > 0.0 {
        sum / total
    } else {
        1.0
    }
}

fn round2(x: f64) -> f64 {
    (x * 100.0).round() / 100.0 + 0.0
}

/// The perspective that stands `luma`'s lines upright in `mode` (module
/// docs), with the crop's straighten `angle` (degrees) taken off.
pub fn estimate(luma: &LumaFrame, angle: f64, mode: UprightMode) -> UprightEstimate {
    estimate_lines(&luma.lines(), angle, mode)
}

fn estimate_lines(lines: &[Line], crop_angle: f64, mode: UprightMode) -> UprightEstimate {
    let identity = Model::new(&Params::default(), crop_angle);
    let (mut vertical, mut horizontal) = ((0usize, 0.0f64), (0usize, 0.0f64));
    for line in lines {
        match identity.family(line) {
            Some(Family::Vertical) => {
                vertical.0 += 1;
                vertical.1 += line.length;
            }
            Some(Family::Horizontal) => {
                horizontal.0 += 1;
                horizontal.1 += line.length;
            }
            None => {}
        }
    }
    let can_vertical = vertical.0 >= MIN_PERSPECTIVE_LINES && vertical.1 >= MIN_SUPPORT;
    let can_horizontal = horizontal.0 >= MIN_PERSPECTIVE_LINES && horizontal.1 >= MIN_SUPPORT;
    let can_level =
        vertical.0 + horizontal.0 >= MIN_LEVEL_LINES && vertical.1 + horizontal.1 >= MIN_SUPPORT;
    let vertical_model = Free {
        vertical: true,
        horizontal: false,
    };
    // The models to try, in order (explicit modes: the first valid one).
    let mut candidates = Vec::new();
    match mode {
        UprightMode::Full => {
            if can_vertical || can_horizontal {
                candidates.push(Free {
                    vertical: can_vertical,
                    horizontal: can_horizontal,
                });
            }
            if can_vertical && can_horizontal {
                candidates.push(vertical_model);
            }
        }
        UprightMode::Vertical => {
            if can_vertical {
                candidates.push(vertical_model);
            }
        }
        UprightMode::Auto => {
            if can_level {
                candidates.push(Free::LEVEL);
            }
            if can_vertical {
                candidates.push(vertical_model);
                if can_horizontal {
                    candidates.push(Free {
                        vertical: true,
                        horizontal: true,
                    });
                }
            }
        }
        UprightMode::Level => {}
    }
    if can_level && !candidates.contains(&Free::LEVEL) {
        candidates.push(Free::LEVEL);
    }
    let fits: Vec<Fit> = candidates
        .iter()
        .map(|&free| fit(lines, free, crop_angle))
        .filter(|f| f.valid)
        .collect();
    let chosen = if mode == UprightMode::Auto {
        // Every line any model takes as vertical or horizontal.
        let mut models = vec![identity];
        models.extend(fits.iter().map(|f| Model::new(&f.params, crop_angle)));
        let relevant: Vec<Line> = lines
            .iter()
            .filter(|l| models.iter().any(|m| m.family(l).is_some()))
            .copied()
            .collect();
        let mut best: Option<(f64, Fit)> = None;
        for f in &fits {
            let extra = match f.free.mode() {
                UprightMode::Vertical => AUTO_VERTICAL_COST,
                UprightMode::Full => AUTO_FULL_COST,
                _ => 0.0,
            };
            let score = misfit_on(&relevant, &f.params, crop_angle)
                + extra
                + AUTO_CORRECTION_COST * f.params.correction();
            if best.is_none_or(|(s, _)| score < s) {
                best = Some((score, *f));
            }
        }
        best.map(|(_, f)| f)
    } else {
        fits.first().copied()
    };
    match chosen {
        Some(f) => UprightEstimate {
            perspective: Perspective {
                rotate: round2(f.params.rotate),
                vertical: round2(f.params.vertical),
                horizontal: round2(f.params.horizontal),
                ..Perspective::default()
            },
            mode: f.free.mode(),
            confidence: f.confidence(),
            vertical_lines: f.vertical_lines,
            horizontal_lines: f.horizontal_lines,
            reason: None,
        },
        None => UprightEstimate {
            perspective: Perspective::default(),
            mode,
            confidence: 0.0,
            vertical_lines: vertical.0,
            horizontal_lines: horizontal.0,
            reason: Some(REASON_NO_LINES),
        },
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn line(a: [f64; 2], b: [f64; 2]) -> Line {
        let (dx, dy) = (b[0] - a[0], b[1] - a[1]);
        Line {
            a,
            b,
            length: (dx * dx + dy * dy).sqrt(),
        }
    }

    #[test]
    fn modes_round_trip_their_numbers() {
        for n in 1..=4 {
            assert_eq!(UprightMode::from_number(n).unwrap().number(), n);
        }
        assert_eq!(UprightMode::from_number(0), None);
        assert_eq!(UprightMode::from_number(5), None);
    }

    #[test]
    fn the_model_is_the_renderers_warp() {
        // The same map as `perspective::Warp` on normalized coordinates.
        let p = Perspective {
            vertical: -40.0,
            horizontal: 25.0,
            rotate: 3.0,
            ..Perspective::default()
        };
        let (w, h) = (3000usize, 2000usize);
        let warp = crate::perspective::Warp::new(&p, w, h).unwrap();
        let model = Model::new(
            &Params {
                rotate: 3.0,
                vertical: -40.0,
                horizontal: 25.0,
            },
            0.0,
        );
        for frame in [[100.0, 200.0], [2900.0, 1900.0], [1500.0, 300.0]] {
            let canvas = warp.to_canvas(frame).unwrap();
            let q = model
                .map([(frame[0] - 1500.0) / 3000.0, (frame[1] - 1000.0) / 3000.0])
                .unwrap();
            assert!((q[0] * 3000.0 + 1500.0 - canvas[0]).abs() < 1e-6);
            assert!((q[1] * 3000.0 + 1000.0 - canvas[1]).abs() < 1e-6);
        }
    }

    #[test]
    fn level_finds_the_tilt_of_synthetic_lines() {
        // Lines turned 3 degrees clockwise on the frame need +3 (a
        // counter-clockwise turn) to stand.
        let (sin, cos) = libm::sincos(3f64.to_radians());
        let turn = |p: [f64; 2]| [p[0] * cos - p[1] * sin, p[0] * sin + p[1] * cos];
        let mut lines = Vec::new();
        for k in -3..=3 {
            let x = k as f64 * 0.1;
            lines.push(line(turn([x, -0.3]), turn([x, 0.3])));
            lines.push(line(turn([-0.3, x]), turn([0.3, x])));
        }
        let e = estimate_lines(&lines, 0.0, UprightMode::Level);
        assert_eq!(e.reason, None);
        assert!((e.perspective.rotate - 3.0).abs() < 0.02, "{e:?}");
        // With the crop already turned 2 degrees, 1 is left.
        let e = estimate_lines(&lines, 2.0, UprightMode::Level);
        assert!((e.perspective.rotate - 1.0).abs() < 0.02, "{e:?}");
    }

    #[test]
    fn too_few_lines_are_not_corrected() {
        let lines = vec![line([0.0, -0.1], [0.01, 0.1])];
        for mode in [
            UprightMode::Auto,
            UprightMode::Level,
            UprightMode::Vertical,
            UprightMode::Full,
        ] {
            let e = estimate_lines(&lines, 0.0, mode);
            assert_eq!(e.reason, Some(REASON_NO_LINES));
            assert_eq!(e.perspective, Perspective::default());
            assert_eq!(e.confidence, 0.0);
            assert_eq!(e.mode, mode);
        }
    }

    #[test]
    fn solve_handles_singular_systems() {
        let a = [[1.0, 2.0, 0.0], [2.0, 4.0, 0.0], [0.0, 0.0, 0.0]];
        assert_eq!(solve(a, [1.0, 2.0, 0.0], 2), None);
        let x = solve(
            [[2.0, 0.0, 0.0], [0.0, 4.0, 0.0], [0.0; 3]],
            [2.0, 2.0, 0.0],
            2,
        )
        .unwrap();
        assert_eq!([x[0], x[1]], [1.0, 0.5]);
    }
}
