//! "自動" (F4a #17123, spec `niho-develop-engine.md` "段 2" 自動補正の定義):
//! the six Light sliders and Vibrance that a press of "自動" sets, decided
//! from the photo as the current settings (a preset included) render it.
//! The aim is "pressing it never makes the photo worse", not Lightroom's
//! Auto.
//!
//! - **Proxy.** [`crate::Session::auto_settings`] renders the crop (or the
//!   whole photo) at [`PROXY_LONG_EDGE`] from the Session's working image,
//!   whatever size the screen renders at, so the result does not depend on
//!   the device. It is made for the call and dropped; the Session's kept
//!   frame state is not touched.
//! - **Measure** ([`Measure`]): per output pixel (sRGB 8-bit), the
//!   luminance `L` = the Rec.709 `Y` of the linear sRGB value, sRGB-encoded
//!   (0..1): median, 0.1% / 25% / 75% / 99% / 99.9% points, the share of
//!   pixels clipped white (all three channels >= 254) or black (all <= 1),
//!   and the mean HSV saturation of all but the near-black and white
//!   pixels. The first render is the current settings through the stages
//!   any change goes through (`through_edit_stages`).
//! - **Prediction** ([`ToneChain`]): where an exposure change takes an
//!   output level, along the tone curve of a gray pixel (RAW: ACR3 curve,
//!   cube P, output; JPEG / PNG: the non-RAW exposure formula, cube P,
//!   output).
//! - **Rules** ([`propose`]): deterministic formulas on the histogram, no
//!   search over renders. Exposure is added to the current value: it moves
//!   the median just inside a band (a high top: bright photos are left
//!   bright), at most +1 / -0.5 EV per press, never against the current
//!   exposure's direction; a positive one must not turn the 99% point
//!   white nor clip more than allowed (below), a negative one not clip
//!   more black. Highlights / Shadows / Whites / Blacks / Contrast read the
//!   distribution predicted after it, Vibrance the saturation. Each of
//!   these gives the level the photo needs (0 up to its cap) and the slider
//!   is raised to that level only when the current value is weaker in the
//!   same direction: a value already as strong (a preset's) is kept, and
//!   one set the other way (a preset's lifted blacks, lowered whites,
//!   negative contrast or muted colors) is never pushed back, so a second
//!   press does not move them. Exposure is rounded to 0.05 EV (toward 0),
//!   the rest to integers, all within range; white balance, Saturation and
//!   every other setting are never changed.
//! - **Clipping check** ([`run`]): the proposal is rendered again; if it
//!   clips more than `max(before, 0.1%)` white or black, the changes that
//!   push that way are halved and checked once more, and if that still
//!   clips, nothing is changed. At most three renders.

use crate::color::{mat_vec, srgb_decode, srgb_encode, PROPHOTO_TO_SRGB};
use crate::output::output_transform;
use crate::pipeline::Rendered;
use crate::settings::DevelopSettings;
use crate::spatial::Quality;
use crate::tone_ops::{exposure_non_raw, PreparedPostOps};

/// Long edge of the proxy (the crop, or the whole photo, when larger).
/// The same as the adaptive statistics of a released frame read.
pub const PROXY_LONG_EDGE: usize = 750;

/// Quality of the proxy's renders: the drag frame's (33^3 tail, half
/// resolution Highlights / Shadows), a few times faster than a released
/// frame (whose 64^3 cube bakes alone take ~100 ms each with a preset) and
/// within a few 8-bit steps of it.
pub const PROXY_QUALITY: Quality = Quality::Interactive;

// The rules' constants, tuned on the round6 RAW working copies and camera
// JPEGs (26 scenes each, `examples/auto_eval.rs`).

/// Median `L` band. Outside it, exposure moves the median to
/// `MEDIAN_MARGIN` inside the near edge (so the rounding toward 0 still
/// lands inside, and a second press does not move it). The top is high
/// and darkening is at most `EXPOSURE_DOWN_MAX`: a bright, airy photo is
/// meant so (the golden fixtures have medians of 0.86..0.89 and the
/// bundled presets brighten by 0.4..0.6 EV), only a nearly white one is
/// darkened.
pub const MEDIAN_LOW: f64 = 0.41;
pub const MEDIAN_HIGH: f64 = 0.90;
const MEDIAN_MARGIN: f64 = 0.02;
/// Largest exposure change of one press (EV) up / down, and its step.
const EXPOSURE_MAX: f64 = 1.0;
const EXPOSURE_DOWN_MAX: f64 = 0.5;
const EXPOSURE_STEP: f64 = 0.05;
/// White (a code of 254 or more after rounding): a positive exposure must
/// not bring the 99% point here from below.
const WHITE_L: f64 = 253.5 / 255.0;
/// Black: 1 or less after rounding.
const BLACK_L: f64 = 1.5 / 255.0;
/// Highlights: the predicted share of pixels above `HIGHLIGHT_L`, from
/// `..._FROM` (level 0) to `..._FULL` (`HIGHLIGHTS_MAX`). Blown areas are
/// counted too: Highlights only lowers the share, so a second press finds
/// no more to do (leaving them out, the areas it brings below white would
/// count the next time).
const HIGHLIGHT_L: f64 = 0.95;
const HIGHLIGHT_FROM: f64 = 0.02;
const HIGHLIGHT_FULL: f64 = 0.20;
const HIGHLIGHTS_MAX: f64 = 70.0;
/// Shadows: the larger of the predicted share of pixels below `SHADOW_L`
/// (`..._FROM` to `..._FULL`) and how far the predicted median stays below
/// the band (0 to `SHADOW_MEDIAN_SPAN`: when exposure could not lift it).
const SHADOW_L: f64 = 0.08;
const SHADOW_FROM: f64 = 0.03;
const SHADOW_FULL: f64 = 0.25;
const SHADOW_MEDIAN_SPAN: f64 = 0.25;
const SHADOWS_MAX: f64 = 60.0;
/// Whites: how far the predicted 99.9% point is below `WHITE_TARGET`
/// (Whites +40 raises a low one by about `WHITE_SPAN`).
const WHITE_TARGET: f64 = 0.93;
const WHITE_SPAN: f64 = 0.05;
const WHITES_MAX: f64 = 40.0;
/// Blacks: how far the predicted 0.1% point is above `BLACK_TARGET`
/// (Blacks -40 lowers one `BLACK_SPAN` above it to about the target).
const BLACK_TARGET: f64 = 0.04;
const BLACK_SPAN: f64 = 0.06;
const BLACKS_MAX: f64 = 40.0;
/// Contrast: how far the predicted interquartile range of `L` is below
/// `IQR_TARGET` (a flat, "sleepy" photo).
const IQR_TARGET: f64 = 0.25;
const IQR_SPAN: f64 = 0.10;
const CONTRAST_MAX: f64 = 20.0;
/// Vibrance: how far the mid tones' mean saturation is below
/// `SATURATION_TARGET`, faded in from `..._GRAY` to `..._GRAY_FULL` so a
/// nearly gray photo keeps its (lack of) color.
const SATURATION_TARGET: f64 = 0.25;
const SATURATION_SPAN: f64 = 0.10;
const SATURATION_GRAY: f64 = 0.03;
const SATURATION_GRAY_FULL: f64 = 0.06;
const VIBRANCE_MAX: f64 = 25.0;
/// The pixels of the saturation mean (`L`): all but the near black and
/// the white (the band stays wide so Highlights / Shadows moving pixels
/// within it do not change which ones count).
const MID_LOW: f64 = 0.10;
const MID_HIGH: f64 = 0.99;

/// The clipping allowed after the press: `max(before, CLIP_FLOOR)`.
pub const CLIP_FLOOR: f64 = 0.001;

/// Bins of the luminance histogram (linear `Y`, 0..1).
const Y_BINS: usize = 1 << 14;

/// `(x - from) / (full - from)` in `[0, 1]`.
fn ramp(x: f64, from: f64, full: f64) -> f64 {
    ((x - from) / (full - from)).clamp(0.0, 1.0)
}

/// A gray pixel's way from the scene to the output `L`, which an exposure
/// change moves it along: RAW `x 2^ev` (the scene after the current
/// exposure) -> ACR3 curve -> cube P -> output transform; JPEG / PNG the
/// non-RAW exposure at `current + ev` -> cube P -> output transform. The
/// local pass and the colors are left out: the exact tone of a gray pixel,
/// a close one of the rest.
pub struct ToneChain {
    raw: bool,
    exposure: f64,
    /// Cube P without the exposure.
    post: PreparedPostOps,
}

impl ToneChain {
    pub fn new(current: &DevelopSettings, raw: bool) -> Self {
        Self {
            raw,
            exposure: current.exposure,
            post: PreparedPostOps::new(current),
        }
    }

    /// Output `L` of the scene gray `x` (0..1) after an exposure change of
    /// `ev`. Non-decreasing in `x` and in `ev`.
    pub fn output(&self, x: f64, ev: f64) -> f64 {
        let v = if self.raw {
            crate::acr3::evaluate((x * libm::exp2(ev)).clamp(0.0, 1.0))
        } else {
            exposure_non_raw([x; 3], self.exposure + ev)[0]
        };
        let p = mat_vec(&PROPHOTO_TO_SRGB, self.post.apply([v; 3]));
        let o = output_transform([p[0] as f32, p[1] as f32, p[2] as f32]);
        srgb_encode(0.2126 * o[0] as f64 + 0.7152 * o[1] as f64 + 0.0722 * o[2] as f64)
    }

    /// The scene gray whose output after `ev` is `l` (the lowest, by
    /// bisection).
    fn scene(&self, l: f64, ev: f64) -> f64 {
        let (mut lo, mut hi) = (0.0f64, 1.0f64);
        for _ in 0..40 {
            let mid = 0.5 * (lo + hi);
            if self.output(mid, ev) < l {
                lo = mid;
            } else {
                hi = mid;
            }
        }
        hi
    }

    /// An output `L` now, after an exposure change of `ev`.
    pub fn predict(&self, l: f64, ev: f64) -> f64 {
        if ev == 0.0 {
            return l;
        }
        self.output(self.scene(l, 0.0), ev)
    }

    /// The output `L` now of what reaches `l` after `ev`.
    fn before(&self, l: f64, ev: f64) -> f64 {
        if ev == 0.0 {
            return l;
        }
        self.output(self.scene(l, ev), 0.0)
    }
}

/// What the auto reads of a rendered frame.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct Summary {
    /// Median, quartiles and 0.1% / 99% / 99.9% points of `L`.
    pub median: f64,
    pub p001: f64,
    pub p25: f64,
    pub p75: f64,
    pub p99: f64,
    pub p999: f64,
    /// Share of pixels with all three channels >= 254 / <= 1.
    pub clipped_white: f64,
    pub clipped_black: f64,
    /// Mean HSV saturation of the pixels with `L` from `MID_LOW` to
    /// `MID_HIGH` (all but the near black and the white).
    pub saturation: f64,
}

/// The histograms of a rendered frame ([`Summary`] and the predictions of
/// the rules).
pub struct Measure {
    pixels: u64,
    /// Linear `Y` in [`Y_BINS`] bins.
    y: Vec<u32>,
    /// The smallest / largest channel code of each pixel.
    min_code: [u32; 256],
    max_code: [u32; 256],
    saturation: f64,
}

impl Measure {
    /// Measures an sRGB 8-bit RGBA frame (alpha is ignored).
    pub fn of(frame: &Rendered) -> Self {
        let mut lin = [0.0f64; 256];
        for (c, v) in lin.iter_mut().enumerate() {
            *v = srgb_decode(c as f64 / 255.0);
        }
        let mut y = vec![0u32; Y_BINS];
        let mut min_code = [0u32; 256];
        let mut max_code = [0u32; 256];
        let (mid_low, mid_high) = (srgb_decode(MID_LOW), srgb_decode(MID_HIGH));
        let (mut saturation_sum, mut mid) = (0.0f64, 0u64);
        let scale = (Y_BINS - 1) as f64;
        for px in frame.rgba.chunks_exact(4) {
            let (r, g, b) = (px[0], px[1], px[2]);
            let luminance =
                0.2126 * lin[r as usize] + 0.7152 * lin[g as usize] + 0.0722 * lin[b as usize];
            y[((luminance * scale + 0.5) as usize).min(Y_BINS - 1)] += 1;
            let (lo, hi) = (r.min(g).min(b), r.max(g).max(b));
            min_code[lo as usize] += 1;
            max_code[hi as usize] += 1;
            if luminance >= mid_low && luminance <= mid_high && hi > 0 {
                saturation_sum += (hi - lo) as f64 / hi as f64;
                mid += 1;
            }
        }
        Self {
            pixels: (frame.rgba.len() / 4) as u64,
            y,
            min_code,
            max_code,
            saturation: if mid > 0 {
                saturation_sum / mid as f64
            } else {
                0.0
            },
        }
    }

    fn share(&self, count: u64) -> f64 {
        if self.pixels == 0 {
            0.0
        } else {
            count as f64 / self.pixels as f64
        }
    }

    /// `L` at the `p` quantile (the lowest bin reaching the rank).
    fn l_at(&self, p: f64) -> f64 {
        let rank = (libm::ceil(p * self.pixels as f64) as u64).max(1);
        let mut seen = 0u64;
        for (k, &count) in self.y.iter().enumerate() {
            seen += count as u64;
            if seen >= rank {
                return srgb_encode(k as f64 / (Y_BINS - 1) as f64);
            }
        }
        1.0
    }

    /// Share of pixels with `L` above `l`.
    fn share_above(&self, l: f64) -> f64 {
        let first = libm::floor(srgb_decode(l) * (Y_BINS - 1) as f64) + 1.0;
        let first = (first.max(0.0) as usize).min(Y_BINS);
        self.share(self.y[first..].iter().map(|&c| c as u64).sum())
    }

    /// Share of pixels with `L` below `l`.
    fn share_below(&self, l: f64) -> f64 {
        let end = libm::ceil(srgb_decode(l) * (Y_BINS - 1) as f64);
        let end = (end.max(0.0) as usize).min(Y_BINS);
        self.share(self.y[..end].iter().map(|&c| c as u64).sum())
    }

    /// Share clipped white after an exposure change of `ev` along `chain`
    /// (each pixel's smallest channel moved as a gray level).
    fn clipped_white_after(&self, chain: &ToneChain, ev: f64) -> f64 {
        let first = chain.before(WHITE_L, ev);
        let count = (0..256)
            .filter(|&c| c as f64 / 255.0 >= first)
            .map(|c| self.min_code[c] as u64)
            .sum();
        self.share(count)
    }

    /// Share clipped black after `ev` (each pixel's largest channel).
    fn clipped_black_after(&self, chain: &ToneChain, ev: f64) -> f64 {
        let last = chain.before(BLACK_L, ev);
        let count = (0..256)
            .filter(|&c| c as f64 / 255.0 <= last)
            .map(|c| self.max_code[c] as u64)
            .sum();
        self.share(count)
    }

    /// The measured shares clipped white / black.
    fn clipped(&self) -> (f64, f64) {
        let white = (254..256).map(|c| self.min_code[c] as u64).sum();
        let black = (0..2).map(|c| self.max_code[c] as u64).sum();
        (self.share(white), self.share(black))
    }

    pub fn summary(&self) -> Summary {
        Summary {
            median: self.l_at(0.5),
            p001: self.l_at(0.001),
            p25: self.l_at(0.25),
            p75: self.l_at(0.75),
            p99: self.l_at(0.99),
            p999: self.l_at(0.999),
            clipped_white: self.clipped().0,
            clipped_black: self.clipped().1,
            saturation: self.saturation,
        }
    }
}

/// The changes a press adds to the current settings.
#[derive(Debug, Clone, Copy, PartialEq, Default)]
pub struct Deltas {
    pub exposure: f64,
    pub contrast: f64,
    pub highlights: f64,
    pub shadows: f64,
    pub whites: f64,
    pub blacks: f64,
    pub vibrance: f64,
}

impl Deltas {
    pub fn is_zero(&self) -> bool {
        *self == Deltas::default()
    }

    /// The changes that clip more white (`white`) or black (`black`),
    /// halved toward 0 (exposure in its 0.05 EV steps).
    fn halved(&self, white: bool, black: bool) -> Deltas {
        let half = |v: f64| libm::trunc(v / 2.0) + 0.0;
        let mut d = *self;
        if (white && d.exposure > 0.0) || (black && d.exposure < 0.0) {
            d.exposure = steps_to_ev(libm::trunc(ev_steps(d.exposure) / 2.0));
        }
        if white || black {
            d.contrast = half(d.contrast);
        }
        if white {
            d.whites = half(d.whites);
            d.shadows = half(d.shadows);
        }
        if black {
            d.blacks = half(d.blacks);
            d.highlights = half(d.highlights);
        }
        d
    }
}

/// Exposure steps of `ev` (toward 0).
fn ev_steps(ev: f64) -> f64 {
    libm::trunc(ev / EXPOSURE_STEP + if ev > 0.0 { 1e-9 } else { -1e-9 }) + 0.0
}

/// `steps` exposure steps in EV, without binary noise (0.05 x 3 = 0.15).
fn steps_to_ev(steps: f64) -> f64 {
    steps * (EXPOSURE_STEP * 100.0) / 100.0
}

/// The clipping allowed after a press that measured `before`.
fn limits(before: &Summary) -> (f64, f64) {
    (
        before.clipped_white.max(CLIP_FLOOR),
        before.clipped_black.max(CLIP_FLOOR),
    )
}

/// The exposure change (module docs): the median to `MEDIAN_MARGIN`
/// inside the band along `chain`, never against the current exposure's
/// direction, at most [`EXPOSURE_MAX`] up / [`EXPOSURE_DOWN_MAX`] down,
/// toward 0 in 0.05 EV steps; a positive one keeping the 99% point off
/// white (when it is not white already) and the predicted white clipping
/// within `limits.0`, a negative one the predicted black clipping within
/// `limits.1`.
fn exposure_delta(m: &Measure, chain: &ToneChain, limits: (f64, f64)) -> f64 {
    let median = m.l_at(0.5);
    // Never against the current exposure's direction.
    let target = if median < MEDIAN_LOW && chain.exposure >= 0.0 {
        MEDIAN_LOW + MEDIAN_MARGIN
    } else if median > MEDIAN_HIGH && chain.exposure <= 0.0 {
        MEDIAN_HIGH - MEDIAN_MARGIN
    } else {
        return 0.0;
    };
    let x = chain.scene(median, 0.0);
    let (mut lo, mut hi) = if target > median {
        (0.0, EXPOSURE_MAX)
    } else {
        (-EXPOSURE_DOWN_MAX, 0.0)
    };
    for _ in 0..30 {
        let mid = 0.5 * (lo + hi);
        if chain.output(x, mid) < target {
            lo = mid;
        } else {
            hi = mid;
        }
    }
    let mut steps = ev_steps(0.5 * (lo + hi));
    let p99 = m.l_at(0.99);
    while steps > 0.0 {
        let ev = steps_to_ev(steps);
        let p99_turns_white = p99 < WHITE_L && chain.predict(p99, ev) >= WHITE_L;
        if !p99_turns_white && m.clipped_white_after(chain, ev) <= limits.0 {
            break;
        }
        steps -= 1.0;
    }
    while steps < 0.0 && m.clipped_black_after(chain, steps_to_ev(steps)) > limits.1 {
        steps += 1.0;
    }
    steps_to_ev(steps)
}

/// What the rules read: the distribution predicted after the exposure
/// change (`L` points, shares) and the saturation (diagnostics).
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct Inputs {
    pub median: f64,
    pub p001: f64,
    pub p999: f64,
    pub iqr: f64,
    /// Shares above `HIGHLIGHT_L` / below `SHADOW_L`.
    pub bright: f64,
    pub dark: f64,
    pub saturation: f64,
}

/// A slider's `level` (rounded) as a change from `now`: up to the level
/// when `now` is weaker in the same direction, else 0 (already as strong,
/// or set the other way).
fn toward(level: f64, now: f64) -> f64 {
    let level = libm::round(level);
    if level > 0.0 && now >= 0.0 {
        (level - now).max(0.0)
    } else if level < 0.0 && now <= 0.0 {
        (level - now).min(0.0)
    } else {
        0.0
    }
}

/// The changes for a photo (`raw`: a RAW working copy) measured `m` with
/// the `current` settings (module docs; not yet limited to the ranges).
pub fn propose(current: &DevelopSettings, raw: bool, m: &Measure) -> (Deltas, Inputs) {
    let chain = ToneChain::new(current, raw);
    let exposure = exposure_delta(m, &chain, limits(&m.summary()));
    let after = |p: f64| chain.predict(m.l_at(p), exposure);
    let inputs = Inputs {
        median: after(0.5),
        p001: after(0.001),
        p999: after(0.999),
        iqr: after(0.75) - after(0.25),
        bright: m.share_above(chain.before(HIGHLIGHT_L, exposure)),
        dark: m.share_below(chain.before(SHADOW_L, exposure)),
        saturation: m.saturation,
    };
    let i = &inputs;
    let highlights = -HIGHLIGHTS_MAX * ramp(i.bright, HIGHLIGHT_FROM, HIGHLIGHT_FULL);
    let shadows = SHADOWS_MAX
        * ramp(i.dark, SHADOW_FROM, SHADOW_FULL).max(ramp(
            MEDIAN_LOW - i.median,
            0.0,
            SHADOW_MEDIAN_SPAN,
        ));
    let whites = WHITES_MAX * ramp(WHITE_TARGET - i.p999, 0.0, WHITE_SPAN);
    let blacks = -BLACKS_MAX * ramp(i.p001 - BLACK_TARGET, 0.0, BLACK_SPAN);
    let contrast = CONTRAST_MAX * ramp(IQR_TARGET - i.iqr, 0.0, IQR_SPAN);
    let vibrance = if current.saturation < 0.0 {
        // Muted on purpose (a black & white or faded preset).
        0.0
    } else {
        VIBRANCE_MAX
            * ramp(SATURATION_TARGET - i.saturation, 0.0, SATURATION_SPAN)
            * ramp(i.saturation, SATURATION_GRAY, SATURATION_GRAY_FULL)
    };
    let deltas = Deltas {
        exposure,
        contrast: toward(contrast, current.contrast),
        highlights: toward(highlights, current.highlights),
        shadows: toward(shadows, current.shadows),
        whites: toward(whites, current.whites),
        blacks: toward(blacks, current.blacks),
        vibrance: toward(vibrance, current.vibrance),
    };
    (deltas, inputs)
}

/// `current` with `d` added (in range; a value without a change keeps its
/// exact number).
pub fn apply(current: &DevelopSettings, d: &Deltas) -> DevelopSettings {
    let mut s = current.clone();
    let add = |now: f64, delta: f64, lo: f64, hi: f64| {
        if delta == 0.0 {
            now
        } else {
            (libm::round((now + delta) * 1e6) / 1e6).clamp(lo, hi)
        }
    };
    s.exposure = add(s.exposure, d.exposure, -5.0, 5.0);
    s.contrast = add(s.contrast, d.contrast, -100.0, 100.0);
    s.highlights = add(s.highlights, d.highlights, -100.0, 100.0);
    s.shadows = add(s.shadows, d.shadows, -100.0, 100.0);
    s.whites = add(s.whites, d.whites, -100.0, 100.0);
    s.blacks = add(s.blacks, d.blacks, -100.0, 100.0);
    s.vibrance = add(s.vibrance, d.vibrance, -100.0, 100.0);
    s
}

/// `settings_json` (the settings the press started from, `current`) with
/// the Light sliders and Vibrance that `result` changed written into it.
/// Every other key keeps the text it was given: parsing a number into
/// `f64` and printing it back can move its last digit (a curve point), and
/// the press must not change anything else. Keys come out sorted.
pub fn write_changes(
    settings_json: &str,
    current: &DevelopSettings,
    result: &DevelopSettings,
) -> Result<String, serde_json::Error> {
    use serde_json::value::{to_raw_value, RawValue};
    let mut map: std::collections::BTreeMap<String, Box<RawValue>> =
        serde_json::from_str(settings_json)?;
    for (key, now, after) in [
        ("exposure", current.exposure, result.exposure),
        ("contrast", current.contrast, result.contrast),
        ("highlights", current.highlights, result.highlights),
        ("shadows", current.shadows, result.shadows),
        ("whites", current.whites, result.whites),
        ("blacks", current.blacks, result.blacks),
        ("vibrance", current.vibrance, result.vibrance),
    ] {
        if after != now {
            map.insert(key.to_string(), to_raw_value(&after)?);
        }
    }
    serde_json::to_string(&map)
}

/// How the press ended.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Step {
    /// Nothing to change (one render).
    Unchanged,
    /// The proposal passed the clipping check (two renders).
    Proposed,
    /// The proposal clipped; its halved clipping changes passed (three).
    Halved,
    /// Both clipped: nothing is changed (two or three).
    Kept,
}

/// What a press decided and measured.
#[derive(Debug, Clone)]
pub struct Outcome {
    pub settings: DevelopSettings,
    /// The changes applied (0 when kept).
    pub deltas: Deltas,
    pub step: Step,
    /// The proxy with the current settings and with the result.
    pub before: Summary,
    pub after: Summary,
    /// What the rules read.
    pub inputs: Inputs,
    /// Each check: the changes rendered and what they measured.
    pub checks: Vec<(Deltas, Summary)>,
    /// Proxy renders made (1..=3).
    pub renders: usize,
}

/// A contrast / vibrance of this size engages cube P / Q (and, on a JPEG /
/// PNG without edits, the output transform) without changing the picture.
const EDIT_STAGES_EPSILON: f64 = 1e-6;

/// `current` rendered through the stages a change goes through: cube P,
/// cube Q and the output transform (a zero contrast / vibrance set to
/// [`EDIT_STAGES_EPSILON`]). Their rounding near black (a JPEG without
/// edits skips them, and then any edit, even exposure +0.05 alone, adds a
/// few hundredths of a percent of black clipping) is then in the measured
/// "before", not counted as the press's clipping. The local pass is not
/// engaged: its drag-frame approximation moves near-white pixels by itself
/// (a proposal without Highlights / Shadows would then look like it clips
/// more).
fn through_edit_stages(current: &DevelopSettings) -> DevelopSettings {
    let mut s = current.clone();
    for v in [&mut s.contrast, &mut s.vibrance] {
        if *v == 0.0 {
            *v = EDIT_STAGES_EPSILON;
        }
    }
    s
}

/// The press on a photo (`raw`: a RAW working copy): `render` draws the
/// proxy with the settings given (module docs, [`Step`]).
pub fn run(
    current: &DevelopSettings,
    raw: bool,
    mut render: impl FnMut(&DevelopSettings) -> Rendered,
) -> Outcome {
    try_run(current, raw, |settings| {
        Ok::<Rendered, core::convert::Infallible>(render(settings))
    })
    .expect("infallible auto renderer")
}

/// Fallible form of [`run`]. Rendering failures are returned to the caller;
/// auto never substitutes a neutral frame or silently keeps the settings.
pub fn try_run<E>(
    current: &DevelopSettings,
    raw: bool,
    mut render: impl FnMut(&DevelopSettings) -> Result<Rendered, E>,
) -> Result<Outcome, E> {
    let measured = Measure::of(&render(&through_edit_stages(current))?);
    let before = measured.summary();
    let (white, black) = limits(&before);
    let (proposed, inputs) = propose(current, raw, &measured);
    drop(measured);
    let mut outcome = Outcome {
        settings: current.clone(),
        deltas: Deltas::default(),
        step: Step::Unchanged,
        before,
        after: before,
        inputs,
        checks: Vec::new(),
        renders: 1,
    };
    let mut candidate = proposed;
    for step in [Step::Proposed, Step::Halved] {
        if candidate.is_zero() {
            break;
        }
        let settings = apply(current, &candidate);
        let after = Measure::of(&render(&settings)?).summary();
        outcome.renders += 1;
        outcome.checks.push((candidate, after));
        let (w, b) = (after.clipped_white > white, after.clipped_black > black);
        if !w && !b {
            outcome.settings = settings;
            outcome.deltas = candidate;
            outcome.step = step;
            outcome.after = after;
            return Ok(outcome);
        }
        outcome.step = Step::Kept;
        let halved = candidate.halved(w, b);
        if halved == candidate {
            break;
        }
        candidate = halved;
    }
    Ok(outcome)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn frame(pixels: &[[u8; 3]]) -> Rendered {
        Rendered {
            width: pixels.len(),
            height: 1,
            rgba: pixels
                .iter()
                .flat_map(|p| [p[0], p[1], p[2], 255])
                .collect(),
            approximations: Vec::new(),
        }
    }

    #[test]
    fn the_measure_reads_the_histogram() {
        let mut px = vec![[128u8, 128, 128]; 996];
        px.extend([[255, 255, 255], [254, 255, 254], [0, 0, 1], [0, 0, 2]]);
        let s = Measure::of(&frame(&px)).summary();
        assert!((s.median - 128.0 / 255.0).abs() < 0.002, "{s:?}");
        assert!((s.clipped_white - 0.002).abs() < 1e-12);
        assert!((s.clipped_black - 0.001).abs() < 1e-12);
        assert_eq!(s.saturation, 0.0);
        let colored = Measure::of(&frame(&[[200, 100, 100]; 10])).summary();
        assert!((colored.saturation - 0.5).abs() < 1e-12);
    }

    #[test]
    fn the_tone_chain_moves_gray_along_the_curves() {
        let neutral = DevelopSettings::neutral();
        for raw in [true, false] {
            let chain = ToneChain::new(&neutral, raw);
            assert_eq!(chain.predict(0.4, 0.0), 0.4);
            // Monotone in the level and in the exposure.
            let mut last = 0.0;
            for i in 1..=100 {
                let l = chain.predict(i as f64 / 100.0, 0.5);
                assert!(l >= last && l <= 1.0, "{raw} {i} {l}");
                last = l;
            }
            assert!(chain.predict(0.4, 0.5) > 0.4 && chain.predict(0.4, -0.5) < 0.4);
            let l = chain.before(0.95, 0.5);
            assert!((chain.predict(l, 0.5) - 0.95).abs() < 1e-3, "{raw} {l}");
        }
        // The non-RAW exposure keeps white near white (a clipped JPEG sky
        // stays bright when darkened); the ACR3 curve steepens the mids.
        let jpeg = ToneChain::new(&neutral, false);
        assert!(jpeg.predict(1.0, -1.0) > 0.98);
        let raw = ToneChain::new(&neutral, true);
        let y = srgb_decode;
        let moved = libm::log2(y(raw.predict(0.35, 0.25)) / y(0.35)) / 0.25;
        assert!(moved > 1.1 && moved < 1.6, "{moved}");
    }

    #[test]
    fn exposure_steps_are_clean_numbers() {
        assert_eq!(steps_to_ev(ev_steps(0.15)), 0.15);
        assert_eq!(steps_to_ev(ev_steps(0.649)), 0.6);
        assert_eq!(steps_to_ev(ev_steps(-0.349)), -0.3);
        assert_eq!(steps_to_ev(ev_steps(1.0)), 1.0);
        assert_eq!(steps_to_ev(ev_steps(0.01)).to_bits(), 0.0f64.to_bits());
    }

    #[test]
    fn sliders_go_up_to_the_level_along_the_current_direction() {
        assert_eq!(toward(30.4, 0.0), 30.0);
        assert_eq!(toward(30.0, 12.0), 18.0);
        assert_eq!(toward(30.0, 45.0), 0.0);
        assert_eq!(toward(-30.0, 20.0), 0.0);
        assert_eq!(toward(-30.0, -10.0), -20.0);
        assert_eq!(toward(0.4, -5.0), 0.0);
    }

    #[test]
    fn only_the_changed_keys_are_written() {
        let json = r#"{"v":1,"exposure":0.42,"toneCurves":[{"channel":"rgb","points":[{"x":0,"y":0},{"x":0.24705882352941178,"y":0.3},{"x":1,"y":1}]}],"someFutureKey":{"a":[1,2]}}"#;
        let current = DevelopSettings::from_json(json).unwrap();
        let mut result = current.clone();
        result.exposure = 0.62;
        result.shadows = 20.0;
        let written = write_changes(json, &current, &result).unwrap();
        assert!(written.contains(r#""x":0.24705882352941178"#), "{written}");
        assert!(
            written.contains(r#""someFutureKey":{"a":[1,2]}"#),
            "{written}"
        );
        let back = DevelopSettings::from_json(&written).unwrap();
        assert_eq!((back.exposure, back.shadows), (0.62, 20.0));
        assert_eq!(back.tone_curves, current.tone_curves);
        // Nothing changed: the same values.
        let same = write_changes(json, &current, &current).unwrap();
        assert_eq!(
            serde_json::from_str::<serde_json::Value>(&same).unwrap(),
            serde_json::from_str::<serde_json::Value>(json).unwrap()
        );
    }

    #[test]
    fn halving_touches_only_the_clipping_changes() {
        let d = Deltas {
            exposure: 0.75,
            contrast: 15.0,
            highlights: -41.0,
            shadows: 33.0,
            whites: 21.0,
            blacks: -9.0,
            vibrance: 12.0,
        };
        let w = d.halved(true, false);
        assert_eq!(
            (w.exposure, w.contrast, w.shadows, w.whites),
            (0.35, 7.0, 16.0, 10.0)
        );
        assert_eq!((w.highlights, w.blacks, w.vibrance), (-41.0, -9.0, 12.0));
        let b = d.halved(false, true);
        assert_eq!((b.exposure, b.blacks, b.highlights), (0.75, -4.0, -20.0));
    }
}
