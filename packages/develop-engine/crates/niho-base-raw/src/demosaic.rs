//! Pre-demosaic normalization + white balance on the CFA, and bilinear demosaic.

use crate::decode::{CameraRaw, RawData};
use crate::par;

/// Normalize, white-balance and clip the crop area of the mosaic (contract §2.5 steps 1–2):
/// `cam = clamp((raw − black) / (white − black), 0, 1)`, `cam_wb = min(cam × mul_c, 1)`
/// (highlight mode "clip"). Returns `crop.width × crop.height` samples.
pub fn prepare_cfa(raw: &CameraRaw, mul: [f32; 3]) -> Vec<f32> {
    let (w, h) = (raw.crop.width, raw.crop.height);
    let mut black = [0.0_f32; 4];
    let mut scale = [0.0_f32; 4];
    let mut gain = [0.0_f32; 4];
    for p in 0..4 {
        black[p] = raw.black[p];
        scale[p] = 1.0 / (raw.white[p] - raw.black[p]);
        gain[p] = mul[raw.pattern[p / 2][p % 2] as usize];
    }
    let consts = Consts { black, scale, gain };
    let mut out = vec![0.0_f32; w * h];
    match &raw.data {
        RawData::U16(v) => fill(&mut out, v, raw, &consts, |s| s as f32),
        RawData::F32(v) => fill(&mut out, v, raw, &consts, |s| s),
    }
    out
}

struct Consts {
    black: [f32; 4],
    scale: [f32; 4],
    gain: [f32; 4],
}

fn fill<T, F>(out: &mut [f32], data: &[T], raw: &CameraRaw, k: &Consts, conv: F)
where
    T: Copy + Sync,
    F: Fn(T) -> f32 + Sync + Send,
{
    let (w, fw) = (raw.crop.width, raw.full_width);
    let (cx, cy) = (raw.crop.x, raw.crop.y);
    par::for_each_row_mut(out, w, |y, row| {
        let start = (cy + y) * fw + cx;
        let src = &data[start..start + w];
        let py = (y & 1) * 2;
        for (x, (o, &s)) in row.iter_mut().zip(src).enumerate() {
            let p = py + (x & 1);
            let n = ((conv(s) - k.black[p]) * k.scale[p]).clamp(0.0, 1.0);
            *o = (n * k.gain[p]).min(1.0);
        }
    });
}

#[derive(Clone, Copy)]
enum Site {
    Red,
    Blue,
    /// Green with red to the left/right (blue above/below).
    GreenRedRow,
    /// Green with blue to the left/right (red above/below).
    GreenBlueRow,
}

/// Bilinear demosaic of a 2×2 Bayer mosaic (`pattern` relative to the top-left sample; colors
/// 0 = R, 1 = G, 2 = B). Missing colors are the mean of the same-color neighbors in the 3×3
/// window; borders reflect (…, 1, 0, 1, …), which keeps the CFA phase. Output is RGB interleaved.
pub fn bilinear(cfa: &[f32], w: usize, h: usize, pattern: [[u8; 2]; 2]) -> Vec<f32> {
    assert!(w >= 2 && h >= 2, "image too small for demosaic");
    assert_eq!(cfa.len(), w * h);
    let site = |py: usize, px: usize| -> Site {
        match pattern[py][px] {
            0 => Site::Red,
            2 => Site::Blue,
            _ => {
                if pattern[py][px ^ 1] == 0 {
                    Site::GreenRedRow
                } else {
                    Site::GreenBlueRow
                }
            }
        }
    };
    let sites = [[site(0, 0), site(0, 1)], [site(1, 0), site(1, 1)]];
    let mut out = vec![0.0_f32; w * h * 3];
    par::for_each_row_mut(&mut out, w * 3, |y, row| {
        let ym = if y == 0 { 1 } else { y - 1 };
        let yp = if y + 1 == h { h - 2 } else { y + 1 };
        let up = &cfa[ym * w..(ym + 1) * w];
        let mid = &cfa[y * w..(y + 1) * w];
        let dn = &cfa[yp * w..(yp + 1) * w];
        let srow = sites[y & 1];
        for (x, px) in row.as_chunks_mut::<3>().0.iter_mut().enumerate() {
            let xm = if x == 0 { 1 } else { x - 1 };
            let xp = if x + 1 == w { w - 2 } else { x + 1 };
            let c = mid[x];
            match srow[x & 1] {
                Site::Red => {
                    px[0] = c;
                    px[1] = 0.25 * (up[x] + dn[x] + mid[xm] + mid[xp]);
                    px[2] = 0.25 * (up[xm] + up[xp] + dn[xm] + dn[xp]);
                }
                Site::Blue => {
                    px[0] = 0.25 * (up[xm] + up[xp] + dn[xm] + dn[xp]);
                    px[1] = 0.25 * (up[x] + dn[x] + mid[xm] + mid[xp]);
                    px[2] = c;
                }
                Site::GreenRedRow => {
                    px[0] = 0.5 * (mid[xm] + mid[xp]);
                    px[1] = c;
                    px[2] = 0.5 * (up[x] + dn[x]);
                }
                Site::GreenBlueRow => {
                    px[0] = 0.5 * (up[x] + dn[x]);
                    px[1] = c;
                    px[2] = 0.5 * (mid[xm] + mid[xp]);
                }
            }
        }
    });
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Mosaic of a smooth RGB field under `pattern`.
    fn mosaic(
        w: usize,
        h: usize,
        pattern: [[u8; 2]; 2],
        f: impl Fn(usize, usize) -> [f32; 3],
    ) -> Vec<f32> {
        let mut v = vec![0.0; w * h];
        for y in 0..h {
            for x in 0..w {
                v[y * w + x] = f(x, y)[pattern[y & 1][x & 1] as usize];
            }
        }
        v
    }

    #[test]
    fn keeps_own_samples_and_phase() {
        // Distinct constant planes: any phase error shows up as a wrong channel value.
        for pattern in [
            [[0, 1], [1, 2]],
            [[2, 1], [1, 0]],
            [[1, 0], [2, 1]],
            [[1, 2], [0, 1]],
        ] {
            let (w, h) = (8, 6);
            let cfa = mosaic(w, h, pattern, |_, _| [0.2, 0.5, 0.9]);
            let rgb = bilinear(&cfa, w, h, pattern);
            for p in rgb.as_chunks::<3>().0.iter() {
                assert!(
                    (p[0] - 0.2).abs() < 1e-6
                        && (p[1] - 0.5).abs() < 1e-6
                        && (p[2] - 0.9).abs() < 1e-6,
                    "{pattern:?} {p:?}"
                );
            }
        }
    }

    #[test]
    fn linear_ramp_is_exact_inside() {
        // Bilinear reproduces a horizontal linear ramp exactly away from the borders.
        let pattern = [[0, 1], [1, 2]];
        let (w, h) = (10, 8);
        let cfa = mosaic(w, h, pattern, |x, _| {
            [x as f32 * 0.1, x as f32 * 0.05, 1.0 - x as f32 * 0.05]
        });
        let rgb = bilinear(&cfa, w, h, pattern);
        for y in 1..h - 1 {
            for x in 1..w - 1 {
                let p = &rgb[(y * w + x) * 3..(y * w + x) * 3 + 3];
                let e = [x as f32 * 0.1, x as f32 * 0.05, 1.0 - x as f32 * 0.05];
                for c in 0..3 {
                    assert!(
                        (p[c] - e[c]).abs() < 1e-5,
                        "({x},{y}) c{c}: {} vs {}",
                        p[c],
                        e[c]
                    );
                }
            }
        }
    }
}
