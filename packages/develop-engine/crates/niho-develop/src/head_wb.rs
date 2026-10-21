//! `niho-13`'s relative white balance of raster sources (#27, `NIHO13.md`):
//! the measured Lightroom incremental-WB delta (`jpeg_wb.rs`, the same
//! `calibration/jpeg-incremental-wb-v1.bin` knots, trilinear interpolation
//! and pair residual as `niho-2`'s output-side LUT) applied to the source
//! first, as Lightroom does, instead of to the finished 8-bit output.
//!
//! Per pixel of extended linear sRGB (a JPEG / PNG original as decoded, or a
//! raster working copy right after its linear ProPhoto -> sRGB conversion):
//!
//! 1. encode each channel with the sRGB OETF on the byte scale (`e = 255 ·
//!    oetf(v)`; mirrored for negative values, the plain power above 1);
//! 2. look the delta up at `e` with the coordinate clamped to the cube
//!    (`[0, 255]`) and add it in float (no rounding). The lookup is the
//!    LUT's: the chart's knots `round(i · 255 / 16)` (15- and 16-byte steps,
//!    the position inside a step as the fraction) and trilinear
//!    interpolation of the blended node deltas, evaluated as the cubes' lerp
//!    (`lut.rs`; bit-identical on wasm SIMD);
//! 3. keep the channel within `[min(e, 0), max(e, 255)]` (`max` then
//!    `min`): a channel inside `[0, 255]` stays inside (the prototype's clip
//!    of the measured 8-bit exports), one already outside (wide-gamut or
//!    HDR-ish input) keeps its own excursion and is never pushed further out
//!    by the delta;
//! 4. decode back to linear with the inverse of step 1.
//!
//! Everything downstream (the `niho-6` analysis and response, the local pass
//! and its statistics, Auto, the color picker, the drag frames) reads the
//! balanced source. The transfer functions use `fastmath`'s `f32` tables
//! (`libm` built), so native and wasm draw the same bytes.

use crate::color::{mat_vec_f32, PROPHOTO_TO_SRGB_F32, SRGB_TO_PROPHOTO_F32};
use crate::decode::LinearImage;
use crate::fastmath::PowTable;
use crate::jpeg_wb::{PreparedJpegWhiteBalance, DIMENSION, LEVELS};
use crate::niho6::SourceSpace;
use crate::settings::{uses_head_white_balance, DevelopSettings, WhiteBalanceMode};

/// The relative white balance a `niho-13` frame applies to its raster source.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct HeadWhiteBalance {
    pub temperature: f64,
    pub tint: f64,
}

impl HeadWhiteBalance {
    /// The head white balance of `settings` on a raster source (`None` for
    /// other engines, a non-relative mode or a zero white balance, whose
    /// source is drawn as it is). RAW working copies never take it: callers
    /// ask only for raster sources.
    pub fn of(settings: &DevelopSettings) -> Option<Self> {
        (uses_head_white_balance(&settings.engine)
            && settings.white_balance.mode == WhiteBalanceMode::Relative
            && (settings.relative_temperature != 0.0 || settings.relative_tint != 0.0))
            .then_some(Self {
                temperature: settings.relative_temperature,
                tint: settings.relative_tint,
            })
    }

    /// Cache-key text of an optional head white balance.
    pub(crate) fn key(white: Option<Self>) -> String {
        match white {
            Some(w) => format!("{}/{}", w.temperature, w.tint),
            None => "none".into(),
        }
    }

    pub fn prepare(self) -> PreparedHeadWhiteBalance {
        let blended = PreparedJpegWhiteBalance::new(self.temperature, self.tint)
            .expect("a head white balance is never zero");
        PreparedHeadWhiteBalance {
            deltas: blended
                .node_deltas()
                .iter()
                .map(|d| [d[0], d[1], d[2], 0.0])
                .collect(),
            encode_power: crate::fastmath::srgb_encode_power(),
            decode_power: crate::fastmath::srgb_decode_power(),
        }
    }
}

/// [`HeadWhiteBalance`] with its delta cube blended (one allocation); each
/// pixel then allocates nothing.
pub struct PreparedHeadWhiteBalance {
    /// The blended node deltas (bytes) as the cubes keep them: `b` fastest,
    /// then `g`, `r`, one spare lane.
    deltas: Vec<[f32; 4]>,
    encode_power: &'static PowTable,
    decode_power: &'static PowTable,
}

const ENCODED_SCALE: f32 = 255.0;

/// The knot below each whole byte (the chart's `round(i · 255 / 16)`): a
/// value in `[k, k + 1)` has the knot of `k` below it, the last step ends
/// at 255.
const fn knot_below() -> [u8; 256] {
    let mut table = [0u8; 256];
    let mut value = 0usize;
    while value < 256 {
        let mut low = 0usize;
        while low + 1 < DIMENSION - 1 && value >= LEVELS[low + 1] as usize {
            low += 1;
        }
        table[value] = low as u8;
        value += 1;
    }
    table
}

const KNOT_BELOW: [u8; 256] = knot_below();

/// `1 / (knot[i + 1] - knot[i])` (the steps are 15 or 16 bytes).
const fn inverse_steps() -> [f32; DIMENSION - 1] {
    let mut table = [0.0f32; DIMENSION - 1];
    let mut i = 0usize;
    while i < DIMENSION - 1 {
        table[i] = if LEVELS[i + 1] - LEVELS[i] == 16 {
            1.0 / 16.0
        } else {
            1.0 / 15.0
        };
        i += 1;
    }
    table
}

const INVERSE_STEPS: [f32; DIMENSION - 1] = inverse_steps();

/// The knot below an encoded value already clamped to `[0, 255]` and the
/// fraction of its step.
#[inline]
fn coordinate(value: f32) -> (usize, f32) {
    // `as usize` saturates (NaN -> 0).
    let low = KNOT_BELOW[(value as usize).min(255)] as usize;
    (low, (value - LEVELS[low] as f32) * INVERSE_STEPS[low])
}

impl PreparedHeadWhiteBalance {
    /// sRGB OETF of a non-negative linear value (`fastmath` table below 1).
    #[inline]
    fn oetf(&self, x: f32) -> f32 {
        if x <= 0.003_130_8 {
            x * 12.92
        } else if x < 1.0 {
            1.055 * self.encode_power.eval(x) - 0.055
        } else {
            1.055 * libm::powf(x, 1.0 / 2.4) - 0.055
        }
    }

    /// Inverse of [`Self::oetf`] for a non-negative encoded value.
    #[inline]
    fn eotf(&self, e: f32) -> f32 {
        if e <= 0.040_45 {
            e / 12.92
        } else if e < 1.0 {
            self.decode_power.eval((e + 0.055) / 1.055)
        } else {
            libm::powf((e + 0.055) / 1.055, 2.4)
        }
    }

    /// Linear -> encoded sRGB on the byte scale, mirrored for negative values.
    #[inline]
    fn encode(&self, v: f32) -> f32 {
        if v < 0.0 {
            -self.oetf(-v) * ENCODED_SCALE
        } else {
            self.oetf(v) * ENCODED_SCALE
        }
    }

    /// Inverse of [`Self::encode`].
    #[inline]
    fn decode(&self, e: f32) -> f32 {
        let e = e / ENCODED_SCALE;
        if e < 0.0 {
            -self.eotf(-e)
        } else {
            self.eotf(e)
        }
    }

    /// The interpolated delta (bytes) at an encoded value, the coordinate
    /// clamped to the cube.
    #[inline]
    fn delta(&self, encoded: [f32; 3]) -> [f32; 3] {
        let [(r, tr), (g, tg), (b, tb)] = encoded.map(|e| coordinate(e.clamp(0.0, ENCODED_SCALE)));
        const STRIDE_G: usize = DIMENSION;
        const STRIDE_R: usize = DIMENSION * DIMENSION;
        let base = r * STRIDE_R + g * STRIDE_G + b;
        // The 8 corners (one bounds check for the whole span).
        let d = &self.deltas[base..base + STRIDE_R + STRIDE_G + 2];
        let corners = [
            d[0],
            d[1],
            d[STRIDE_G],
            d[STRIDE_G + 1],
            d[STRIDE_R],
            d[STRIDE_R + 1],
            d[STRIDE_R + STRIDE_G],
            d[STRIDE_R + STRIDE_G + 1],
        ];
        crate::lut::trilinear(&corners, tb, tg, tr)
    }

    /// One pixel of extended linear sRGB, balanced (module docs).
    #[inline]
    pub fn apply_linear_srgb(&self, rgb: [f32; 3]) -> [f32; 3] {
        let encoded = rgb.map(|v| self.encode(v));
        let delta = self.delta(encoded);
        let mut out = [0.0; 3];
        for channel in 0..3 {
            let e = encoded[channel];
            // The bounds always hold `0 <= 255` between them; a NaN channel
            // (never decoded) ends at 0.
            let balanced = (e + delta[channel])
                .max(e.min(0.0))
                .min(e.max(ENCODED_SCALE));
            out[channel] = self.decode(balanced);
        }
        out
    }

    /// `image` (in `space`) balanced, in the same space. A raster working
    /// copy (linear ProPhoto) is balanced in linear sRGB, where its frames
    /// read it, and stored back in ProPhoto.
    pub fn apply_image(&self, image: &LinearImage, space: SourceSpace) -> LinearImage {
        let mut data = Vec::with_capacity(image.data.len());
        match space {
            SourceSpace::LinearSrgb => {
                for px in image.data.chunks_exact(3) {
                    data.extend_from_slice(&self.apply_linear_srgb([px[0], px[1], px[2]]));
                }
            }
            SourceSpace::LinearProPhoto => {
                for px in image.data.chunks_exact(3) {
                    let srgb = mat_vec_f32(&PROPHOTO_TO_SRGB_F32, [px[0], px[1], px[2]]);
                    let balanced = self.apply_linear_srgb(srgb);
                    data.extend_from_slice(&mat_vec_f32(&SRGB_TO_PROPHOTO_F32, balanced));
                }
            }
        }
        LinearImage {
            width: image.width,
            height: image.height,
            data,
        }
    }
}

/// `image` balanced for `settings` when they take a head white balance
/// (`None`: draw `image` as it is).
pub(crate) fn balanced(
    image: &LinearImage,
    space: SourceSpace,
    settings: &DevelopSettings,
) -> Option<LinearImage> {
    HeadWhiteBalance::of(settings).map(|white| white.prepare().apply_image(image, space))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn byte_linear(value: u8) -> f32 {
        crate::color::srgb_eotf(value as f64 / 255.0) as f32
    }

    fn prepared(temperature: f64, tint: f64) -> PreparedHeadWhiteBalance {
        HeadWhiteBalance { temperature, tint }.prepare()
    }

    #[test]
    fn coordinates_are_the_charts_knots() {
        for value in 0..=255u8 {
            let (low, fraction) = coordinate(value as f32);
            let below = LEVELS
                .iter()
                .rposition(|&k| k <= value)
                .unwrap()
                .min(DIMENSION - 2);
            assert_eq!(low, below, "{value}");
            let step = (LEVELS[low + 1] - LEVELS[low]) as f32;
            assert!((fraction - (value - LEVELS[low]) as f32 / step).abs() < 1e-6);
        }
        assert_eq!(coordinate(255.0), (DIMENSION - 2, 1.0));
        let (low, fraction) = coordinate(135.5);
        assert_eq!(low, 8);
        assert!((fraction - 0.5).abs() < 1e-6);
    }

    #[test]
    fn transfer_round_trips_across_the_extended_range() {
        let p = prepared(30.0, 0.0);
        for v in [
            -2.0f32, -0.5, -0.01, -1e-4, 0.0, 1e-4, 0.002, 0.01, 0.2, 0.5, 0.999, 1.0, 1.7, 4.0,
        ] {
            let back = p.decode(p.encode(v));
            assert!(
                (back - v).abs() <= 2e-6 * v.abs().max(1e-3),
                "{v} -> {back}"
            );
        }
        for value in 0..=255u8 {
            let e = p.encode(byte_linear(value));
            assert!((e - value as f32).abs() < 2e-3, "{value}: {e}");
        }
    }

    #[test]
    fn whole_bytes_take_the_measured_delta_and_stay_in_range() {
        for (temperature, tint) in [(30.0, 0.0), (-47.0, 13.0), (80.0, 50.0)] {
            let p = prepared(temperature, tint);
            let lut = PreparedJpegWhiteBalance::new(temperature, tint).unwrap();
            for rgb in [
                [64u8, 64, 64],
                [128, 143, 159],
                [0, 0, 0],
                [255, 255, 255],
                [255, 16, 0],
                [12, 200, 255],
                [77, 3, 181],
            ] {
                // The cubes' lerp and the LUT's weighted sum agree to float
                // rounding at the knots and between them.
                let delta = lut.delta(rgb);
                let lerp = p.delta(rgb.map(f32::from));
                for channel in 0..3 {
                    assert!((delta[channel] - lerp[channel]).abs() < 1e-3, "{rgb:?}");
                }
                let out = p.apply_linear_srgb(rgb.map(byte_linear));
                for channel in 0..3 {
                    let expected = (rgb[channel] as f32 + delta[channel]).clamp(0.0, 255.0);
                    let encoded = p.encode(out[channel]);
                    assert!(
                        (encoded - expected).abs() < 5e-3,
                        "{rgb:?}[{channel}]: {encoded} vs {expected}"
                    );
                    assert!((0.0..=1.0).contains(&out[channel]));
                }
            }
        }
    }

    #[test]
    fn extended_channels_keep_their_excursion() {
        let p = prepared(80.0, 50.0);
        // A wide-gamut red (negative G / B) and an over-white highlight.
        for rgb in [[0.8f32, -0.05, -0.02], [1.6, 1.2, 0.9], [-0.3, 0.4, 2.5]] {
            let encoded = rgb.map(|v| p.encode(v));
            // The coordinate is the cube's face; the value is not clipped.
            let delta = p.delta(encoded.map(|e| e.clamp(0.0, 255.0)));
            assert_eq!(delta, p.delta(encoded));
            let out = p.apply_linear_srgb(rgb);
            for channel in 0..3 {
                let e = encoded[channel];
                let expected = (e + delta[channel]).clamp(e.min(0.0), e.max(255.0));
                let got = p.encode(out[channel]);
                assert!(
                    (got - expected).abs() <= 1e-3 * expected.abs().max(1.0),
                    "{rgb:?}[{channel}]: {got} vs {expected}"
                );
                // Never pushed further outside [0, 255] than the input was.
                assert!(got >= e.min(0.0) - 1e-3 && got <= e.max(255.0) + 1e-3);
            }
        }
        // Continuous at the faces: just inside / just outside 255 agree.
        let inside = p.apply_linear_srgb([0.999_99, 0.3, 0.2]);
        let outside = p.apply_linear_srgb([1.000_01, 0.3, 0.2]);
        for channel in 0..3 {
            assert!((inside[channel] - outside[channel]).abs() < 1e-4);
        }
        // A NaN channel (never decoded) ends at 0 without panicking.
        assert_eq!(p.apply_linear_srgb([f32::NAN, 0.2, 0.3])[0], 0.0);
    }

    #[test]
    fn only_niho13_relative_non_zero_settings_take_it() {
        let mut settings = DevelopSettings::neutral();
        settings.engine = crate::settings::ENGINE_NIHO_13.into();
        settings.white_balance.mode = WhiteBalanceMode::Relative;
        assert_eq!(HeadWhiteBalance::of(&settings), None);
        settings.relative_tint = -7.0;
        assert_eq!(
            HeadWhiteBalance::of(&settings),
            Some(HeadWhiteBalance {
                temperature: 0.0,
                tint: -7.0
            })
        );
        settings.white_balance.mode = WhiteBalanceMode::AsShot;
        assert_eq!(HeadWhiteBalance::of(&settings), None);
        settings.white_balance.mode = WhiteBalanceMode::Relative;
        settings.engine = crate::settings::ENGINE_NIHO_12.into();
        assert_eq!(HeadWhiteBalance::of(&settings), None);
    }
}
