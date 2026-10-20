//! Separable Lanczos3 downscale for interleaved RGB f32 (edge clamp, center-aligned samples).

use crate::par;

/// Output size for a long edge of `long_edge` px. Never upscales.
pub fn target_size(w: usize, h: usize, long_edge: usize) -> (usize, usize) {
    let long = w.max(h);
    if long_edge == 0 || long <= long_edge {
        return (w, h);
    }
    let s = long_edge as f64 / long as f64;
    if w >= h {
        (long_edge, ((h as f64 * s).round() as usize).max(1))
    } else {
        (((w as f64 * s).round() as usize).max(1), long_edge)
    }
}

fn lanczos3(x: f64) -> f64 {
    let ax = x.abs();
    if ax < 1e-9 {
        return 1.0;
    }
    if ax >= 3.0 {
        return 0.0;
    }
    let px = std::f64::consts::PI * x;
    3.0 * px.sin() * (px / 3.0).sin() / (px * px)
}

/// Taps for every output sample: first source index and normalized weights.
struct Taps {
    first: Vec<usize>,
    weights: Vec<Vec<f32>>,
}

fn taps(src: usize, dst: usize) -> Taps {
    let scale = src as f64 / dst as f64;
    let stretch = scale.max(1.0);
    let radius = 3.0 * stretch;
    let last_index = src as i64 - 1;
    let mut first = Vec::with_capacity(dst);
    let mut weights = Vec::with_capacity(dst);
    for o in 0..dst {
        let center = (o as f64 + 0.5) * scale - 0.5;
        let lo = (center - radius).floor() as i64;
        let hi = (center + radius).ceil() as i64;
        let f = lo.clamp(0, last_index) as usize;
        let l = hi.clamp(0, last_index) as usize;
        let mut w = vec![0.0_f64; l - f + 1];
        let mut sum = 0.0;
        for i in lo..=hi {
            let wt = lanczos3((i as f64 - center) / stretch);
            if wt == 0.0 {
                continue;
            }
            let idx = i.clamp(0, last_index) as usize;
            w[idx - f] += wt;
            sum += wt;
        }
        first.push(f);
        weights.push(w.iter().map(|x| (x / sum) as f32).collect());
    }
    Taps { first, weights }
}

/// Resize `img` (`w × h`, RGB interleaved) to `ow × oh` with Lanczos3.
pub fn lanczos3_rgb(img: &[f32], w: usize, h: usize, ow: usize, oh: usize) -> Vec<f32> {
    if (ow, oh) == (w, h) {
        return img.to_vec();
    }
    // Horizontal pass: w × h → ow × h.
    let tx = taps(w, ow);
    let mut mid = vec![0.0_f32; ow * h * 3];
    par::for_each_row_mut(&mut mid, ow * 3, |y, row| {
        let src = &img[y * w * 3..(y + 1) * w * 3];
        for (ox, px) in row.as_chunks_mut::<3>().0.iter_mut().enumerate() {
            let f = tx.first[ox];
            let (mut r, mut g, mut b) = (0.0_f32, 0.0_f32, 0.0_f32);
            for (k, &wt) in tx.weights[ox].iter().enumerate() {
                let s = (f + k) * 3;
                r += wt * src[s];
                g += wt * src[s + 1];
                b += wt * src[s + 2];
            }
            px[0] = r;
            px[1] = g;
            px[2] = b;
        }
    });
    // Vertical pass: ow × h → ow × oh.
    let ty = taps(h, oh);
    let stride = ow * 3;
    let mut out = vec![0.0_f32; ow * oh * 3];
    par::for_each_row_mut(&mut out, stride, |oy, row| {
        let f = ty.first[oy];
        for (k, &wt) in ty.weights[oy].iter().enumerate() {
            let src = &mid[(f + k) * stride..(f + k + 1) * stride];
            for (d, s) in row.iter_mut().zip(src) {
                *d += wt * s;
            }
        }
    });
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn size_rules() {
        assert_eq!(target_size(6000, 4000, 2560), (2560, 1707));
        assert_eq!(target_size(4000, 6000, 2560), (1707, 2560));
        assert_eq!(target_size(6000, 4000, 1500), (1500, 1000));
        assert_eq!(target_size(2000, 1000, 2560), (2000, 1000));
    }

    #[test]
    fn weights_sum_to_one() {
        for (src, dst) in [(6000, 2560), (4000, 1707), (10, 3), (7, 7)] {
            let t = taps(src, dst);
            for w in &t.weights {
                let s: f32 = w.iter().sum();
                assert!((s - 1.0).abs() < 1e-5, "{src}->{dst}: {s}");
            }
        }
    }
}
