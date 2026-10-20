//! Local, post-resize chroma experiment. The scalar luminance guide keeps the
//! memory cost smaller than a three-channel guide. Strong chroma edges are
//! restored from the input. This module is not part of the production engine.

const PP_Y: [f32; 3] = [0.2880402, 0.7118741, 0.0000857];

#[inline]
fn reflect101(mut i: isize, len: usize) -> usize {
    if len == 1 {
        return 0;
    }
    let end = len as isize;
    while i < 0 || i >= end {
        i = if i < 0 { -i } else { 2 * end - 2 - i };
    }
    i as usize
}

fn box_filter(src: &[f32], w: usize, h: usize, radius: usize) -> Vec<f32> {
    let side = 2 * radius + 1;
    let scale = 1.0 / (side * side) as f32;
    let mut tmp = vec![0.0; w * h];
    let mut out = vec![0.0; w * h];
    for y in 0..h {
        let row = &src[y * w..(y + 1) * w];
        let mut sum = (-(radius as isize)..=radius as isize)
            .map(|x| row[reflect101(x, w)])
            .sum::<f32>();
        for x in 0..w {
            tmp[y * w + x] = sum;
            sum += row[reflect101(x as isize + radius as isize + 1, w)]
                - row[reflect101(x as isize - radius as isize, w)];
        }
    }
    for x in 0..w {
        let mut sum = (-(radius as isize)..=radius as isize)
            .map(|y| tmp[reflect101(y, h) * w + x])
            .sum::<f32>();
        for y in 0..h {
            out[y * w + x] = sum * scale;
            sum += tmp[reflect101(y as isize + radius as isize + 1, h) * w + x]
                - tmp[reflect101(y as isize - radius as isize, h) * w + x];
        }
    }
    out
}

fn gaussian(src: &[f32], w: usize, h: usize, sigma: f32) -> Vec<f32> {
    let radius = (3.0 * sigma).ceil() as isize;
    let mut weights: Vec<f32> = (-radius..=radius)
        .map(|i| (-(i * i) as f32 / (2.0 * sigma * sigma)).exp())
        .collect();
    let total: f32 = weights.iter().sum();
    for weight in &mut weights {
        *weight /= total;
    }
    let mut tmp = vec![0.0; w * h];
    let mut out = vec![0.0; w * h];
    for y in 0..h {
        for x in 0..w {
            tmp[y * w + x] = (-radius..=radius)
                .map(|dx| {
                    weights[(dx + radius) as usize] * src[y * w + reflect101(x as isize + dx, w)]
                })
                .sum();
        }
    }
    for y in 0..h {
        for x in 0..w {
            out[y * w + x] = (-radius..=radius)
                .map(|dy| {
                    weights[(dy + radius) as usize] * tmp[reflect101(y as isize + dy, h) * w + x]
                })
                .sum();
        }
    }
    out
}

fn source_chroma(rgb: &[f32], channel: usize) -> Vec<f32> {
    rgb.as_chunks::<3>()
        .0
        .iter()
        .map(|px| (px[channel].max(1e-5) / px[1].max(1e-5)).ln())
        .collect()
}

fn edge_mask(rgb: &[f32], w: usize, h: usize, high_iso: bool) -> Vec<f32> {
    let (sigma, low, high) = if high_iso {
        (4.0, 0.24, 0.56)
    } else {
        (2.0, 0.12, 0.28)
    };
    let mut edge = vec![0.0_f32; w * h];
    for channel in [0, 2] {
        let chroma = source_chroma(rgb, channel);
        let smooth = gaussian(&chroma, w, h, sigma);
        for y in 0..h {
            let up = reflect101(y as isize - 1, h) * w;
            let mid = y * w;
            let down = reflect101(y as isize + 1, h) * w;
            for x in 0..w {
                let left = reflect101(x as isize - 1, w);
                let right = reflect101(x as isize + 1, w);
                let gx = (smooth[up + right] + 2.0 * smooth[mid + right] + smooth[down + right])
                    - (smooth[up + left] + 2.0 * smooth[mid + left] + smooth[down + left]);
                let gy = (smooth[down + left] + 2.0 * smooth[down + x] + smooth[down + right])
                    - (smooth[up + left] + 2.0 * smooth[up + x] + smooth[up + right]);
                edge[mid + x] = edge[mid + x].max(gx.hypot(gy));
            }
        }
    }
    for value in &mut edge {
        *value = ((*value - low) / (high - low)).clamp(0.0, 1.0);
    }
    // OpenCV's 5x5 ellipse: center pixel on the two outer rows, full five
    // pixels on the middle three rows. This expands the protected boundary.
    let mut dilated = vec![0.0; w * h];
    for y in 0..h {
        for x in 0..w {
            let mut peak = 0.0_f32;
            for dy in -2isize..=2 {
                for dx in -2isize..=2 {
                    if dy.abs() == 2 && dx != 0 {
                        continue;
                    }
                    let yy = reflect101(y as isize + dy, h);
                    let xx = reflect101(x as isize + dx, w);
                    peak = peak.max(edge[yy * w + xx]);
                }
            }
            dilated[y * w + x] = peak;
        }
    }
    dilated
}

struct GuideContext<'a> {
    guide: &'a [f32],
    mean_guide: &'a [f32],
    var_guide: &'a [f32],
    mask: &'a [f32],
    w: usize,
    h: usize,
    radius: usize,
    eps: f32,
}

impl GuideContext<'_> {
    fn filter_chroma(&self, src: Vec<f32>) -> Vec<f32> {
        let mean_src = box_filter(&src, self.w, self.h, self.radius);
        let product: Vec<f32> = self.guide.iter().zip(&src).map(|(i, p)| i * p).collect();
        let mean_product = box_filter(&product, self.w, self.h, self.radius);
        drop(product);
        let mut a = vec![0.0; self.w * self.h];
        let mut b = vec![0.0; self.w * self.h];
        for i in 0..src.len() {
            a[i] = (mean_product[i] - self.mean_guide[i] * mean_src[i])
                / (self.var_guide[i] + self.eps);
            b[i] = mean_src[i] - a[i] * self.mean_guide[i];
        }
        let mean_a = box_filter(&a, self.w, self.h, self.radius);
        drop(a);
        let mean_b = box_filter(&b, self.w, self.h, self.radius);
        drop(b);
        src.iter()
            .enumerate()
            .map(|(i, &original)| {
                let filtered = mean_a[i] * self.guide[i] + mean_b[i];
                filtered * (1.0 - self.mask[i]) + original * self.mask[i]
            })
            .collect()
    }
}

/// Post-resize linear-ProPhoto guided chroma denoise. The luma component is
/// algebraically preserved, and strong color boundaries retain input chroma.
pub fn apply(rgb: &mut [f32], w: usize, h: usize, radius: usize, eps: f32, high_iso: bool) {
    assert_eq!(rgb.len(), w * h * 3);
    assert!(radius > 0 && radius < 32 && eps.is_finite() && eps > 0.0);
    let y: Vec<f32> = rgb
        .as_chunks::<3>()
        .0
        .iter()
        .map(|px| PP_Y[0] * px[0] + PP_Y[1] * px[1] + PP_Y[2] * px[2])
        .collect();
    let guide = gaussian(&y, w, h, 1.0);
    let mask = edge_mask(rgb, w, h, high_iso);
    let mean_guide = box_filter(&guide, w, h, radius);
    let square: Vec<f32> = guide.iter().map(|v| v * v).collect();
    let mut var_guide = box_filter(&square, w, h, radius);
    drop(square);
    for (variance, &mean) in var_guide.iter_mut().zip(&mean_guide) {
        *variance = (*variance - mean * mean).max(0.0);
    }
    let context = GuideContext {
        guide: &guide,
        mean_guide: &mean_guide,
        var_guide: &var_guide,
        mask: &mask,
        w,
        h,
        radius,
        eps,
    };
    let rg = context.filter_chroma(source_chroma(rgb, 0));
    let bg = context.filter_chroma(source_chroma(rgb, 2));
    for (i, px) in rgb.as_chunks_mut::<3>().0.iter_mut().enumerate() {
        if !y[i].is_finite() {
            continue;
        }
        let red_ratio = rg[i].clamp(-4.0, 4.0).exp();
        let blue_ratio = bg[i].clamp(-4.0, 4.0).exp();
        let base = y[i] / (PP_Y[0] * red_ratio + PP_Y[1] + PP_Y[2] * blue_ratio);
        px.copy_from_slice(&[base * red_ratio, base, base * blue_ratio]);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn constant_color_is_unchanged() {
        let mut rgb = [0.4, 0.3, 0.2].repeat(12 * 12);
        apply(&mut rgb, 12, 12, 4, 0.0001, false);
        for px in rgb.as_chunks::<3>().0 {
            for (a, b) in px.iter().zip([0.4, 0.3, 0.2]) {
                assert!((a - b).abs() < 1e-4);
            }
        }
    }

    #[test]
    fn removes_flat_chroma_noise_and_preserves_color_edge() {
        let (w, h) = (32, 16);
        let mut rgb = vec![0.0; w * h * 3];
        for y in 0..h {
            for x in 0..w {
                let value = if x < w / 2 {
                    [0.5, 0.2, 0.1]
                } else {
                    [0.1, 0.2, 0.5]
                };
                let noise = if (x + y) % 2 == 0 { 0.012 } else { -0.012 };
                rgb[(y * w + x) * 3..(y * w + x) * 3 + 3].copy_from_slice(&[
                    value[0] + noise,
                    value[1],
                    value[2] - noise,
                ]);
            }
        }
        let before = rgb.clone();
        apply(&mut rgb, w, h, 4, 0.0001, false);
        let idx = (8 * w + 4) * 3;
        assert!((rgb[idx] - 0.5).abs() < (before[idx] - 0.5).abs());
        let left = (8 * w + 15) * 3;
        let right = (8 * w + 16) * 3;
        assert!(rgb[left] - rgb[right] > 0.35);
        for (new, old) in rgb
            .as_chunks::<3>()
            .0
            .iter()
            .zip(before.as_chunks::<3>().0.iter())
        {
            let lum = |px: &[f32]| PP_Y[0] * px[0] + PP_Y[1] * px[1] + PP_Y[2] * px[2];
            assert!((lum(new) - lum(old)).abs() < 1e-5);
        }
    }
}
