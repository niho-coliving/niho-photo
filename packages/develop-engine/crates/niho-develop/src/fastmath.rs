//! Table-driven per-pixel transfer functions. Deterministic (plain `f32`
//! arithmetic on tables built with `libm`), so native and wasm agree bit for
//! bit, and within `f32` precision of the direct `powf`.

use std::sync::OnceLock;

/// `x^p` on `[0, 1]` through a table indexed by the `f32` bit pattern:
/// 11 mantissa bits per binade and linear interpolation on the rest
/// (relative error ~1e-7 for the exponents used here).
pub struct PowTable {
    exponent: f32,
    /// Bit pattern of the smallest tabulated input (`2^-24`).
    base_bits: u32,
    /// `[x_i^p, x_{i+1}^p]` per bucket (both ends of the interpolation in
    /// one load).
    table: Vec<[f32; 2]>,
}

const MANTISSA_SHIFT: u32 = 12; // keep 11 of 23 mantissa bits
const MIN_EXP: i32 = -24;

impl PowTable {
    pub fn new(exponent: f32) -> Self {
        let base_bits = (2.0f32).powi(MIN_EXP).to_bits();
        let end_bits = 1.0f32.to_bits();
        let count = ((end_bits - base_bits) >> MANTISSA_SHIFT) as usize + 2;
        let values: Vec<f32> = (0..count)
            .map(|i| {
                let bits = base_bits + ((i as u32) << MANTISSA_SHIFT);
                let x = f32::from_bits(bits) as f64;
                libm::pow(x, exponent as f64) as f32
            })
            .collect();
        let table = values.windows(2).map(|w| [w[0], w[1]]).collect();
        Self {
            exponent,
            base_bits,
            table,
        }
    }

    /// `x^p` for `x` in `[0, 1]` (callers clamp first).
    #[inline]
    pub fn eval(&self, x: f32) -> f32 {
        if x <= 0.0 {
            return 0.0;
        }
        if x >= 1.0 {
            return 1.0;
        }
        let bits = x.to_bits();
        if bits < self.base_bits {
            return libm::powf(x, self.exponent);
        }
        let offset = bits - self.base_bits;
        let index = (offset >> MANTISSA_SHIFT) as usize;
        // A bucket never crosses a binade, so the position inside it is the
        // dropped mantissa bits: exactly (x - lo) / (hi - lo).
        let t =
            (offset & ((1 << MANTISSA_SHIFT) - 1)) as f32 * (1.0 / (1 << MANTISSA_SHIFT) as f32);
        let [a, b] = self.table[index];
        a + (b - a) * t
    }
}

/// A monotone function on `[0, 1]` with `f(0) = 0` and `f(1) = 1`, through a
/// table indexed by the `f32` bit pattern like [`PowTable`] (8 mantissa bits
/// per binade; inputs below `2^-24` take the first entry). Built per drag
/// tail for its input (the gamma-1.8 encode and the shaper in one lookup).
pub struct UnitTable {
    base_bits: u32,
    table: Vec<[f32; 2]>,
}

const UNIT_SHIFT: u32 = 15;

impl UnitTable {
    pub fn new(f: impl Fn(f32) -> f32) -> Self {
        let base_bits = (2.0f32).powi(MIN_EXP).to_bits();
        let end_bits = 1.0f32.to_bits();
        let count = ((end_bits - base_bits) >> UNIT_SHIFT) as usize + 2;
        let values: Vec<f32> = (0..count)
            .map(|i| f(f32::from_bits(base_bits + ((i as u32) << UNIT_SHIFT)).min(1.0)))
            .collect();
        let table = values.windows(2).map(|w| [w[0], w[1]]).collect();
        Self { base_bits, table }
    }

    /// `f(x)`, `x` clamped to `[0, 1]`.
    #[inline]
    pub fn eval(&self, x: f32) -> f32 {
        if x.is_nan() || x <= 0.0 {
            return 0.0;
        }
        if x >= 1.0 {
            return 1.0;
        }
        let bits = x.to_bits();
        if bits < self.base_bits {
            return self.table[0][0];
        }
        let offset = bits - self.base_bits;
        let index = (offset >> UNIT_SHIFT) as usize;
        let t = (offset & ((1 << UNIT_SHIFT) - 1)) as f32 * (1.0 / (1 << UNIT_SHIFT) as f32);
        let [a, b] = self.table[index];
        a + (b - a) * t
    }
}

/// `x^(1/1.8)` (cube input encode).
pub fn gamma18_encode() -> &'static PowTable {
    static T: OnceLock<PowTable> = OnceLock::new();
    T.get_or_init(|| PowTable::new((1.0 / 1.8) as f32))
}

/// `x^1.8` (cube output decode).
pub fn gamma18_decode() -> &'static PowTable {
    static T: OnceLock<PowTable> = OnceLock::new();
    T.get_or_init(|| PowTable::new(1.8))
}

/// `x^(1/3)`.
pub fn cube_root() -> &'static PowTable {
    static T: OnceLock<PowTable> = OnceLock::new();
    T.get_or_init(|| PowTable::new(0.333_333_34))
}

/// `x^(1/2.4)` (sRGB encode power).
pub fn srgb_encode_power() -> &'static PowTable {
    static T: OnceLock<PowTable> = OnceLock::new();
    T.get_or_init(|| PowTable::new((1.0 / 2.4) as f32))
}

/// Uniform `f64` table of a smooth function on `[lo, 1]` with linear
/// interpolation.
pub struct UniformTable {
    lo: f64,
    scale: f64,
    values: Vec<f64>,
}

impl UniformTable {
    pub fn new(lo: f64, intervals: usize, f: impl Fn(f64) -> f64) -> Self {
        let values = (0..=intervals)
            .map(|i| f(lo + (1.0 - lo) * i as f64 / intervals as f64))
            .collect();
        Self {
            lo,
            scale: intervals as f64 / (1.0 - lo),
            values,
        }
    }

    #[inline]
    pub fn eval(&self, x: f64) -> f64 {
        let pos = ((x - self.lo) * self.scale).max(0.0);
        let last = self.values.len() - 1;
        let i = (pos as usize).min(last - 1);
        let t = pos - i as f64;
        self.values[i] + (self.values[i + 1] - self.values[i]) * t
    }
}

/// `((c + 0.055) / 1.055)^2.4` on `[0.04045, 1]`.
pub fn srgb_decode_table() -> &'static UniformTable {
    static T: OnceLock<UniformTable> = OnceLock::new();
    T.get_or_init(|| {
        UniformTable::new(0.0031308 * 12.92, 8192, |c| {
            libm::pow((c + 0.055) / 1.055, 2.4)
        })
    })
}

/// Linear `[0,1]` -> sRGB 8-bit code, exactly `round(oetf(x) * 255)` via
/// the 255 decision thresholds (binary search, no `pow`).
pub struct Srgb8Encoder {
    thresholds: [f32; 255],
    /// Code at the start of each 1/65536 bin of `[0, 1]`: a bin holds at
    /// most one decision threshold (the steepest slope is 12.92 * 255 codes
    /// per unit), so one comparison finishes the lookup.
    start: Vec<u8>,
}

impl Srgb8Encoder {
    fn new() -> Self {
        let mut thresholds = [0.0f32; 255];
        for (k, slot) in thresholds.iter_mut().enumerate() {
            // Smallest linear value whose code is k+1: oetf(x)*255 >= k+0.5.
            let target = (k as f64 + 0.5) / 255.0;
            let mut lo = 0.0f32;
            let mut hi = 1.0f32;
            for _ in 0..60 {
                let mid = lo + (hi - lo) * 0.5;
                if mid == lo || mid == hi {
                    break;
                }
                if (crate::color::srgb_oetf_f32(mid) as f64) >= target {
                    hi = mid;
                } else {
                    lo = mid;
                }
            }
            *slot = hi;
        }
        let mut start = Vec::with_capacity(BINS + 1);
        for i in 0..=BINS {
            let x = i as f32 / BINS as f32;
            start.push(thresholds.iter().filter(|t| **t <= x).count() as u8);
        }
        Self { thresholds, start }
    }

    #[inline]
    pub fn encode(&self, x: f32) -> u8 {
        let x = if x.is_nan() { 0.0 } else { x.clamp(0.0, 1.0) };
        let bin = (x * BINS as f32) as usize;
        let code = self.start[bin.min(BINS)];
        if (code as usize) < 255 && x >= self.thresholds[code as usize] {
            code + 1
        } else {
            code
        }
    }

    /// Reference binary search (tests).
    pub fn encode_search(&self, x: f32) -> u8 {
        let x = if x.is_nan() { 0.0 } else { x };
        // Number of thresholds <= x (thresholds ascend).
        let t = &self.thresholds;
        let mut lo = 0usize;
        let mut hi = 255usize;
        while lo < hi {
            let mid = (lo + hi) / 2;
            if x >= t[mid] {
                lo = mid + 1;
            } else {
                hi = mid;
            }
        }
        lo as u8
    }
}

const BINS: usize = 65536;

pub fn srgb8() -> &'static Srgb8Encoder {
    static T: OnceLock<Srgb8Encoder> = OnceLock::new();
    T.get_or_init(Srgb8Encoder::new)
}

/// NIHO 3's frozen final conversion, exactly
/// `(srgb_oetf_f32(x) * 255.0 + 0.5) as u8`, without a per-pixel `powf`.
/// This is separate from [`Srgb8Encoder`] so legacy engines retain their
/// existing threshold contract.
pub(crate) struct Niho3Srgb8Encoder {
    thresholds: [f32; 255],
    start: Vec<u8>,
}

#[inline]
fn niho3_srgb8_reference(x: f32) -> u8 {
    (crate::color::srgb_oetf_f32(x) * 255.0 + 0.5) as u8
}

impl Niho3Srgb8Encoder {
    fn new() -> Self {
        let mut thresholds = [0.0f32; 255];
        let one = 1.0f32.to_bits();
        for (code, threshold) in (1u8..=255).zip(&mut thresholds) {
            // Find the first nonnegative f32 input that the frozen f32 OETF
            // and quantization expression maps to this code or above.
            let mut lo = 0u32;
            let mut hi = one;
            while lo < hi {
                let mid = lo + (hi - lo) / 2;
                if niho3_srgb8_reference(f32::from_bits(mid)) >= code {
                    hi = mid;
                } else {
                    lo = mid + 1;
                }
            }
            *threshold = f32::from_bits(lo);
        }
        let mut start = Vec::with_capacity(BINS + 1);
        for i in 0..=BINS {
            let x = i as f32 / BINS as f32;
            start.push(thresholds.partition_point(|threshold| *threshold <= x) as u8);
        }
        Self { thresholds, start }
    }

    #[inline]
    pub(crate) fn encode(&self, x: f32) -> u8 {
        if x.is_nan() || x <= 0.0 {
            return 0;
        }
        if x >= 1.0 {
            return 255;
        }
        let bin = (x * BINS as f32) as usize;
        let mut code = self.start[bin.min(BINS)] as usize;
        // The uniform bin is narrower than one sRGB8 decision interval.
        // Correct in both directions anyway, making the result depend only
        // on the exact thresholds rather than that optimization invariant.
        while code < 255 && x >= self.thresholds[code] {
            code += 1;
        }
        while code > 0 && x < self.thresholds[code - 1] {
            code -= 1;
        }
        code as u8
    }
}

pub(crate) fn niho3_srgb8() -> &'static Niho3Srgb8Encoder {
    static T: OnceLock<Niho3Srgb8Encoder> = OnceLock::new();
    T.get_or_init(Niho3Srgb8Encoder::new)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn pow_table_matches_powf() {
        for table in [gamma18_encode(), gamma18_decode(), cube_root()] {
            let mut worst = 0.0f64;
            let mut x = 1e-7f32;
            while x < 1.0 {
                let got = table.eval(x) as f64;
                let want = libm::pow(x as f64, table.exponent as f64);
                worst = worst.max((got - want).abs() / want.max(1e-12));
                x *= 1.013;
            }
            assert!(worst < 5e-7, "worst relative error {worst}");
        }
    }

    #[test]
    fn fast_srgb_matches_direct() {
        let mut worst: f64 = 0.0;
        for i in 0..=100_000 {
            let x = i as f64 / 100_000.0;
            worst =
                worst.max((crate::color::srgb_encode_fast(x) - crate::color::srgb_encode(x)).abs());
            worst =
                worst.max((crate::color::srgb_decode_fast(x) - crate::color::srgb_decode(x)).abs());
        }
        assert!(worst < 2e-7, "worst {worst}");
    }

    #[test]
    fn srgb8_matches_direct_rounding() {
        let enc = srgb8();
        let mut x = 0.0f32;
        while x <= 1.0 {
            let direct = (crate::color::srgb_oetf_f32(x) * 255.0 + 0.5).floor() as u8;
            let got = enc.encode(x);
            assert!(
                (got as i32 - direct as i32).abs() <= 1,
                "{x}: {got} vs {direct}"
            );
            x += 0.000_37;
        }
        let mut y = 0.0f32;
        while y <= 1.0 {
            assert_eq!(enc.encode(y), enc.encode_search(y), "{y}");
            y += 0.000_011;
        }
        assert_eq!(enc.encode(0.0), 0);
        assert_eq!(enc.encode(1.0), 255);
        assert_eq!(enc.encode(2.0), 255);
        assert_eq!(enc.encode(-1.0), 0);
    }

    #[test]
    fn niho3_srgb8_matches_frozen_f32_quantization() {
        let enc = niho3_srgb8();
        for threshold in enc.thresholds {
            let bits = threshold.to_bits();
            for candidate in [bits.saturating_sub(1), bits, bits.saturating_add(1)] {
                let x = f32::from_bits(candidate);
                assert_eq!(enc.encode(x), niho3_srgb8_reference(x), "{x:?}");
            }
        }
        for x in [
            f32::NEG_INFINITY,
            -1.0,
            -0.0,
            0.0,
            f32::from_bits(1),
            1.0,
            2.0,
            f32::INFINITY,
            f32::NAN,
        ] {
            assert_eq!(enc.encode(x), niho3_srgb8_reference(x), "{x:?}");
        }

        let mut bits = 0x6d2b_79f5u32;
        for _ in 0..250_000 {
            bits = bits.wrapping_mul(1_664_525).wrapping_add(1_013_904_223);
            let x = f32::from_bits(bits);
            assert_eq!(enc.encode(x), niho3_srgb8_reference(x), "{x:?}");
        }
    }
}
