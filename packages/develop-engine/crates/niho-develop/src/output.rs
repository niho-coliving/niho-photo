//! Terminal output stage, from Photo Bench `SRGBOutputTransform`
//! (`extended-linear-to-srgb-soft-output-v2`) as its production Core Image
//! kernels compute it (`f32`): a ratio-preserving highlight shoulder, then
//! fixed-lightness / fixed-hue OKLCh chroma compression into sRGB, then the
//! final clamp. Also the 8-bit sRGB encode.
//!
//! One difference (NIHO, #16942 / S9 #16999): a color outside sRGB is first
//! clipped per channel (what Lightroom's sRGB conversion does) and only then
//! goes through the OKLCh knee. Compressing the unclipped color at its own
//! OKLab lightness and hue, as Photo Bench does, turns saturated blue to
//! violet (night lights) into a dull cyan blue: 0.54 of the clipped chroma
//! and 38° of hue on `fixtures/golden/input/saturated-blue.png`, the same in
//! photobench-engine. Colors inside sRGB are unchanged.

use crate::color::{linear_srgb_to_oklab, oklab_to_linear_srgb, srgb_oetf_f32};
use std::sync::OnceLock;

const KNEE: f32 = 0.99;
const SOFTNESS: f32 = 0.008;

/// `photoBenchHighlightShoulder`.
#[inline]
pub fn highlight_shoulder(rgb: [f32; 3]) -> [f32; 3] {
    let maximum = rgb[0].max(rgb[1].max(rgb[2]));
    if maximum.is_nan() || maximum <= KNEE {
        return rgb;
    }
    let distance = maximum - KNEE;
    let mapped = KNEE + SOFTNESS * distance / (distance + SOFTNESS);
    let s = mapped / maximum;
    [rgb[0] * s, rgb[1] * s, rgb[2] * s]
}

#[inline]
fn in_srgb_gamut(rgb: [f32; 3]) -> bool {
    let lo = -0.000_000_1f32;
    let hi = 1.000_000_1f32;
    rgb[0] >= lo && rgb[0] <= hi && rgb[1] >= lo && rgb[1] <= hi && rgb[2] >= lo && rgb[2] <= hi
}

#[inline]
fn clamp01(rgb: [f32; 3]) -> [f32; 3] {
    [
        rgb[0].clamp(0.0, 1.0),
        rgb[1].clamp(0.0, 1.0),
        rgb[2].clamp(0.0, 1.0),
    ]
}

/// Conservative lower bound of the in-gamut maximum OKLCh chroma over all
/// hues, per lightness bin. Used only to skip the bisection for pixels whose
/// chroma is far below the boundary: for those the kernel's answer is
/// `clamp(rgb)` whatever the bisection finds, so the result is identical.
struct ChromaFloor {
    bins: Vec<f32>,
}

const FLOOR_BINS: usize = 256;

fn max_chroma_f64(l: f64, hue: f64) -> f64 {
    let (c, s) = (libm::cos(hue), libm::sin(hue));
    let (mut lo, mut hi) = (0.0f64, 0.5f64);
    for _ in 0..24 {
        let mid = 0.5 * (lo + hi);
        let rgb = oklab_to_linear_srgb([l as f32, (c * mid) as f32, (s * mid) as f32]);
        if in_srgb_gamut(rgb) {
            lo = mid;
        } else {
            hi = mid;
        }
    }
    lo
}

fn chroma_floor() -> &'static ChromaFloor {
    static T: OnceLock<ChromaFloor> = OnceLock::new();
    T.get_or_init(|| {
        let hues = 256;
        let edge: Vec<f64> = (0..=FLOOR_BINS)
            .map(|i| {
                let l = i as f64 / FLOOR_BINS as f64;
                if l <= 0.0 || l >= 1.0 {
                    return 0.0;
                }
                (0..hues)
                    .map(|h| max_chroma_f64(l, h as f64 / hues as f64 * core::f64::consts::TAU))
                    .fold(f64::INFINITY, f64::min)
            })
            .collect();
        let bins = (0..FLOOR_BINS)
            .map(|i| ((edge[i].min(edge[i + 1])) * 0.95 - 0.002).max(0.0) as f32)
            .collect();
        ChromaFloor { bins }
    })
}

/// Cells of the unit RGB cube (indexed by `sqrt` of each channel, 32 per
/// axis, so dark colors get small cells) whose colors all have OKLCh chroma
/// well below the in-gamut maximum. For a pixel inside such a cell the
/// kernel's answer is `clamp(rgb)` (ratio <= 0.90), so the whole OKLab
/// round trip is skipped. Built with a 0.8 ratio bound on the corners and
/// center; `fast_path_matches_full_kernel` checks it against the kernel.
struct SafeCells {
    safe: Vec<bool>,
}

const SAFE_CELLS: usize = 32;

fn safe_cells() -> &'static SafeCells {
    static T: OnceLock<SafeCells> = OnceLock::new();
    T.get_or_init(|| {
        let floor = chroma_floor();
        let n = SAFE_CELLS;
        let edge = |i: usize| {
            let e = i as f32 / n as f32;
            e * e
        };
        let ratio = |rgb: [f32; 3]| -> f32 {
            let lab = linear_srgb_to_oklab(rgb);
            if lab[0] <= 0.0 || lab[0] >= 1.0 {
                return f32::INFINITY;
            }
            let chroma = (lab[1] * lab[1] + lab[2] * lab[2]).sqrt();
            let f = floor.bins[((lab[0] * FLOOR_BINS as f32) as usize).min(FLOOR_BINS - 1)];
            if f <= 0.0 {
                return f32::INFINITY;
            }
            chroma / (0.999 * f)
        };
        let mut safe = vec![false; n * n * n];
        for b in 0..n {
            for g in 0..n {
                for r in 0..n {
                    let lo = [edge(r), edge(g), edge(b)];
                    let hi = [edge(r + 1), edge(g + 1), edge(b + 1)];
                    let mut worst = 0.0f32;
                    for corner in 0..9 {
                        let pick = |axis: usize| {
                            if corner == 8 {
                                0.5 * (lo[axis] + hi[axis])
                            } else if corner & (1 << axis) != 0 {
                                hi[axis]
                            } else {
                                lo[axis]
                            }
                        };
                        worst = worst.max(ratio([pick(0), pick(1), pick(2)]));
                    }
                    safe[(b * n + g) * n + r] = worst <= 0.8;
                }
            }
        }
        SafeCells { safe }
    })
}

#[inline]
fn in_safe_cell(rgb: [f32; 3]) -> bool {
    if !(rgb[0] >= 0.0
        && rgb[0] <= 1.0
        && rgb[1] >= 0.0
        && rgb[1] <= 1.0
        && rgb[2] >= 0.0
        && rgb[2] <= 1.0)
    {
        return false;
    }
    let n = SAFE_CELLS as f32;
    // `sqrt` is correctly rounded (IEEE 754) in hardware and in `libm`
    // alike, so the hardware instruction gives the same index.
    let idx = |v: f32| ((v.sqrt() * n) as usize).min(SAFE_CELLS - 1);
    safe_cells().safe[(idx(rgb[2]) * SAFE_CELLS + idx(rgb[1])) * SAFE_CELLS + idx(rgb[0])]
}

/// `photoBenchGamutCompression` (12-step bisection for the hue's maximum
/// chroma at this lightness, knee 0.90, boundary scale 0.999).
#[inline]
pub fn gamut_compress(rgb: [f32; 3]) -> [f32; 3] {
    if in_safe_cell(rgb) {
        // Same as the kernel's `ratio <= 0.90` branch.
        return clamp01(rgb);
    }
    gamut_compress_full(rgb)
}

#[inline]
fn gamut_compress_full(rgb: [f32; 3]) -> [f32; 3] {
    if !(rgb[0].is_finite() && rgb[1].is_finite() && rgb[2].is_finite()) {
        return [0.0; 3];
    }
    let lab = linear_srgb_to_oklab(rgb);
    if lab[0] <= 0.0 {
        return [0.0; 3];
    }
    if lab[0] >= 1.0 {
        return [1.0; 3];
    }
    let chroma = (lab[1] * lab[1] + lab[2] * lab[2]).sqrt();
    if chroma <= 0.000_000_1 {
        return clamp01(rgb);
    }
    let floor = chroma_floor().bins[((lab[0] * FLOOR_BINS as f32) as usize).min(FLOOR_BINS - 1)];
    if chroma <= 0.9 * 0.999 * floor {
        return clamp01(rgb);
    }
    // Probe once along the pixel's hue: if the color with a little more
    // than chroma / (0.9 * 0.999) is still in gamut, the 12-step bisection
    // ends at least that far out (it resolves the boundary to 0.5 / 4096),
    // so the kernel returns clamp(rgb).
    let probe = (chroma / (0.9 * 0.999) + 2.5e-4) / chroma;
    if probe * chroma < 0.5
        && in_srgb_gamut(oklab_to_linear_srgb([
            lab[0],
            lab[1] * probe,
            lab[2] * probe,
        ]))
    {
        return clamp01(rgb);
    }
    gamut_compress_slow(rgb, lab, chroma)
}

#[inline(never)]
fn gamut_compress_slow(rgb: [f32; 3], lab: [f32; 3], chroma: f32) -> [f32; 3] {
    let hue = libm::atan2f(lab[2], lab[1]);
    let direction = [libm::cosf(hue), libm::sinf(hue)];
    let mut low = 0.0f32;
    let mut high = 0.5f32;
    for _ in 0..12 {
        let middle = (low + high) * 0.5;
        let candidate =
            oklab_to_linear_srgb([lab[0], direction[0] * middle, direction[1] * middle]);
        if in_srgb_gamut(candidate) {
            low = middle;
        } else {
            high = middle;
        }
    }
    if low <= 0.000_000_1 {
        return clamp01(oklab_to_linear_srgb([lab[0], 0.0, 0.0]));
    }
    let safe_maximum = low * 0.999;
    let ratio = chroma / safe_maximum;
    if ratio <= 0.90 {
        return clamp01(rgb);
    }
    let distance = ratio - 0.90;
    let compressed = 0.90 + 0.10 * distance / (distance + 0.10);
    let c = safe_maximum * compressed;
    clamp01(oklab_to_linear_srgb([
        lab[0],
        direction[0] * c,
        direction[1] * c,
    ]))
}

/// Shoulder, the sRGB clip, then the gamut compression's knee
/// (`SRGBOutputTransform.apply` with the clip moved first, module comment).
#[inline]
pub fn output_transform(rgb: [f32; 3]) -> [f32; 3] {
    gamut_compress(clamp01(highlight_shoulder(rgb)))
}

/// NIHO 3 frozen R23 output: clip scene headroom before gamut compression,
/// without the legacy highlight shoulder.
#[inline]
pub fn output_transform_clip(rgb: [f32; 3]) -> [f32; 3] {
    gamut_compress(clamp01(rgb))
}

/// Linear `[0,1]` -> sRGB 8-bit (round to nearest, like Core Image's
/// RGBA8 render).
#[inline]
pub fn encode_srgb8(v: f32) -> u8 {
    let c = v.clamp(0.0, 1.0);
    let e = srgb_oetf_f32(c);
    (e * 255.0 + 0.5).clamp(0.0, 255.0) as u8
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn in_gamut_neutral_passes_through() {
        let v = [0.18f32, 0.18, 0.18];
        let out = output_transform(v);
        for c in 0..3 {
            assert!((out[c] - v[c]).abs() < 1e-5);
        }
    }

    #[test]
    fn out_of_gamut_lands_in_gamut() {
        let out = output_transform([1.4, -0.2, 0.1]);
        for c in out {
            assert!((0.0..=1.0).contains(&c));
        }
        assert!(out[0] > out[1]);
    }

    #[test]
    fn fast_path_matches_full_kernel() {
        let mut state = 12345u32;
        let mut next = || {
            state ^= state << 13;
            state ^= state >> 17;
            state ^= state << 5;
            (state as f32 / u32::MAX as f32) * 1.3 - 0.15
        };
        for _ in 0..200_000 {
            let rgb = [next(), next(), next()];
            let lab = linear_srgb_to_oklab(rgb);
            if lab[0] <= 0.0 || lab[0] >= 1.0 {
                continue;
            }
            let chroma = (lab[1] * lab[1] + lab[2] * lab[2]).sqrt();
            if chroma <= 0.000_000_1 {
                continue;
            }
            assert_eq!(
                gamut_compress(rgb),
                gamut_compress_slow(rgb, lab, chroma),
                "{rgb:?}"
            );
        }
    }

    #[test]
    fn srgb8_encode_endpoints() {
        assert_eq!(encode_srgb8(0.0), 0);
        assert_eq!(encode_srgb8(1.0), 255);
        assert_eq!(encode_srgb8(0.214_041_14), 128);
    }
}
