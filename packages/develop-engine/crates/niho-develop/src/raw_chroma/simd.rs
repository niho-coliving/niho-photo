//! Window sums of adjacent outputs, two f64 lanes per vector. Each lane adds
//! its own taps in the frozen order with plain f64 adds (no reassociation,
//! no FMA), so every output has the bits of the scalar sum.

/// Outputs per call.
pub(super) const LANES: usize = 8;

/// `out[lane] = sum over tap in 0..taps of f64(row[start + tap + lane])`,
/// taps in order.
pub(super) fn horizontal(row: &[f32], start: usize, taps: usize) -> [f64; LANES] {
    // Check all loads once, before the unchecked SIMD loads.
    assert!(start + taps + LANES - 1 <= row.len());
    horizontal_inner(&row[start..start + taps + LANES - 1], taps)
}

/// `out[lane] = sum over rows (in order) of row[x + lane]`.
pub(super) fn vertical(rows: &[&[f64]], x: usize) -> [f64; LANES] {
    assert!(rows.iter().all(|row| x + LANES <= row.len()));
    vertical_inner(rows, x)
}

#[cfg(target_arch = "aarch64")]
#[inline]
fn horizontal_inner(row: &[f32], taps: usize) -> [f64; LANES] {
    use core::arch::aarch64::*;
    // The safe entry checks the last load of the last tap.
    unsafe {
        let mut sums = [vdupq_n_f64(0.0); LANES / 2];
        for tap in 0..taps {
            let p = row.as_ptr().add(tap);
            for (pair, sum) in sums.iter_mut().enumerate() {
                *sum = vaddq_f64(*sum, vcvt_f64_f32(vld1_f32(p.add(2 * pair))));
            }
        }
        let mut out = [0.0; LANES];
        for (pair, sum) in sums.iter().enumerate() {
            vst1q_f64(out.as_mut_ptr().add(2 * pair), *sum);
        }
        out
    }
}

#[cfg(target_arch = "aarch64")]
#[inline]
fn vertical_inner(rows: &[&[f64]], x: usize) -> [f64; LANES] {
    use core::arch::aarch64::*;
    // The safe entry checks every row's last load.
    unsafe {
        let mut sums = [vdupq_n_f64(0.0); LANES / 2];
        for row in rows {
            let p = row.as_ptr().add(x);
            for (pair, sum) in sums.iter_mut().enumerate() {
                *sum = vaddq_f64(*sum, vld1q_f64(p.add(2 * pair)));
            }
        }
        let mut out = [0.0; LANES];
        for (pair, sum) in sums.iter().enumerate() {
            vst1q_f64(out.as_mut_ptr().add(2 * pair), *sum);
        }
        out
    }
}

#[cfg(all(target_arch = "wasm32", target_feature = "simd128"))]
#[inline]
fn horizontal_inner(row: &[f32], taps: usize) -> [f64; LANES] {
    use core::arch::wasm32::*;
    // The safe entry checks the last load of the last tap. v128_load64_zero
    // allows unaligned access.
    unsafe {
        let mut sums = [f64x2_splat(0.0); LANES / 2];
        for tap in 0..taps {
            let p = row.as_ptr().add(tap);
            for (pair, sum) in sums.iter_mut().enumerate() {
                let two = v128_load64_zero(p.add(2 * pair).cast());
                *sum = f64x2_add(*sum, f64x2_promote_low_f32x4(two));
            }
        }
        let mut out = [0.0; LANES];
        for (pair, sum) in sums.iter().enumerate() {
            v128_store(out.as_mut_ptr().add(2 * pair).cast(), *sum);
        }
        out
    }
}

#[cfg(all(target_arch = "wasm32", target_feature = "simd128"))]
#[inline]
fn vertical_inner(rows: &[&[f64]], x: usize) -> [f64; LANES] {
    use core::arch::wasm32::*;
    // The safe entry checks every row's last load.
    unsafe {
        let mut sums = [f64x2_splat(0.0); LANES / 2];
        for row in rows {
            let p = row.as_ptr().add(x);
            for (pair, sum) in sums.iter_mut().enumerate() {
                *sum = f64x2_add(*sum, v128_load(p.add(2 * pair).cast()));
            }
        }
        let mut out = [0.0; LANES];
        for (pair, sum) in sums.iter().enumerate() {
            v128_store(out.as_mut_ptr().add(2 * pair).cast(), *sum);
        }
        out
    }
}

#[cfg(not(any(
    target_arch = "aarch64",
    all(target_arch = "wasm32", target_feature = "simd128")
)))]
#[inline]
fn horizontal_inner(row: &[f32], taps: usize) -> [f64; LANES] {
    let mut out = [0.0; LANES];
    for tap in 0..taps {
        for (lane, sum) in out.iter_mut().enumerate() {
            *sum += f64::from(row[tap + lane]);
        }
    }
    out
}

#[cfg(not(any(
    target_arch = "aarch64",
    all(target_arch = "wasm32", target_feature = "simd128")
)))]
#[inline]
fn vertical_inner(rows: &[&[f64]], x: usize) -> [f64; LANES] {
    let mut out = [0.0; LANES];
    for row in rows {
        for (lane, sum) in out.iter_mut().enumerate() {
            *sum += row[x + lane];
        }
    }
    out
}
