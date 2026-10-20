//! Shared ΔE00 helpers for the integration tests.
#![allow(dead_code)]

pub fn srgb_to_lab(rgb: [u8; 3]) -> [f64; 3] {
    let lin = |v: u8| {
        let c = v as f64 / 255.0;
        if c <= 0.04045 {
            c / 12.92
        } else {
            ((c + 0.055) / 1.055).powf(2.4)
        }
    };
    let (r, g, b) = (lin(rgb[0]), lin(rgb[1]), lin(rgb[2]));
    let x = 0.4124564 * r + 0.3575761 * g + 0.1804375 * b;
    let y = 0.2126729 * r + 0.7151522 * g + 0.0721750 * b;
    let z = 0.0193339 * r + 0.1191920 * g + 0.9503041 * b;
    let f = |t: f64| {
        if t > 216.0 / 24389.0 {
            t.cbrt()
        } else {
            (24389.0 / 27.0 * t + 16.0) / 116.0
        }
    };
    let (fx, fy, fz) = (f(x / 0.95047), f(y), f(z / 1.08883));
    [116.0 * fy - 16.0, 500.0 * (fx - fy), 200.0 * (fy - fz)]
}

/// CIEDE2000 (Sharma et al. 2005).
pub fn delta_e00(l1: [f64; 3], l2: [f64; 3]) -> f64 {
    let (lp1, a1, b1) = (l1[0], l1[1], l1[2]);
    let (lp2, a2, b2) = (l2[0], l2[1], l2[2]);
    let c1 = (a1 * a1 + b1 * b1).sqrt();
    let c2 = (a2 * a2 + b2 * b2).sqrt();
    let cbar = (c1 + c2) / 2.0;
    let g = 0.5 * (1.0 - (cbar.powi(7) / (cbar.powi(7) + 25f64.powi(7))).sqrt());
    let a1p = (1.0 + g) * a1;
    let a2p = (1.0 + g) * a2;
    let c1p = (a1p * a1p + b1 * b1).sqrt();
    let c2p = (a2p * a2p + b2 * b2).sqrt();
    let hp = |b: f64, a: f64| {
        if a == 0.0 && b == 0.0 {
            0.0
        } else {
            let h = b.atan2(a).to_degrees();
            if h < 0.0 {
                h + 360.0
            } else {
                h
            }
        }
    };
    let h1p = hp(b1, a1p);
    let h2p = hp(b2, a2p);
    let dlp = lp2 - lp1;
    let dcp = c2p - c1p;
    let dhp = if c1p * c2p == 0.0 {
        0.0
    } else if (h2p - h1p).abs() <= 180.0 {
        h2p - h1p
    } else if h2p - h1p > 180.0 {
        h2p - h1p - 360.0
    } else {
        h2p - h1p + 360.0
    };
    let dhp_big = 2.0 * (c1p * c2p).sqrt() * (dhp.to_radians() / 2.0).sin();
    let lbar = (lp1 + lp2) / 2.0;
    let cbarp = (c1p + c2p) / 2.0;
    let hbarp = if c1p * c2p == 0.0 {
        h1p + h2p
    } else if (h1p - h2p).abs() <= 180.0 {
        (h1p + h2p) / 2.0
    } else if h1p + h2p < 360.0 {
        (h1p + h2p + 360.0) / 2.0
    } else {
        (h1p + h2p - 360.0) / 2.0
    };
    let t = 1.0 - 0.17 * (hbarp - 30.0).to_radians().cos()
        + 0.24 * (2.0 * hbarp).to_radians().cos()
        + 0.32 * (3.0 * hbarp + 6.0).to_radians().cos()
        - 0.20 * (4.0 * hbarp - 63.0).to_radians().cos();
    let dtheta = 30.0 * (-((hbarp - 275.0) / 25.0).powi(2)).exp();
    let rc = 2.0 * (cbarp.powi(7) / (cbarp.powi(7) + 25f64.powi(7))).sqrt();
    let sl = 1.0 + 0.015 * (lbar - 50.0).powi(2) / (20.0 + (lbar - 50.0).powi(2)).sqrt();
    let sc = 1.0 + 0.045 * cbarp;
    let sh = 1.0 + 0.015 * cbarp * t;
    let rt = -(2.0 * dtheta.to_radians()).sin() * rc;
    ((dlp / sl).powi(2)
        + (dcp / sc).powi(2)
        + (dhp_big / sh).powi(2)
        + rt * (dcp / sc) * (dhp_big / sh))
        .sqrt()
}

pub struct Stats {
    pub mean: f64,
    pub p999: f64,
    pub max: f64,
}

pub fn lab_of(p: [f64; 3]) -> [f64; 3] {
    // `p` is linear sRGB here.
    let (r, g, b) = (p[0], p[1], p[2]);
    let x = 0.4124564 * r + 0.3575761 * g + 0.1804375 * b;
    let y = 0.2126729 * r + 0.7151522 * g + 0.0721750 * b;
    let z = 0.0193339 * r + 0.1191920 * g + 0.9503041 * b;
    let f = |t: f64| {
        if t > 216.0 / 24389.0 {
            t.cbrt()
        } else {
            (24389.0 / 27.0 * t + 16.0) / 116.0
        }
    };
    let (fx, fy, fz) = (f(x / 0.95047), f(y), f(z / 1.08883));
    [116.0 * fy - 16.0, 500.0 * (fx - fy), 200.0 * (fy - fz)]
}

pub fn lin8(v: u8) -> f64 {
    let c = v as f64 / 255.0;
    if c <= 0.04045 {
        c / 12.92
    } else {
        ((c + 0.055) / 1.055).powf(2.4)
    }
}

/// ΔE00 statistics after averaging 2x2 blocks in linear light.
pub fn compare_box2(a_rgba: &[u8], b_rgb: &[u8], width: usize, height: usize) -> Stats {
    let (w2, h2) = (width / 2, height / 2);
    let mut de = Vec::with_capacity(w2 * h2);
    for y in 0..h2 {
        for x in 0..w2 {
            let mut pa = [0.0; 3];
            let mut pb = [0.0; 3];
            for (dx, dy) in [(0, 0), (1, 0), (0, 1), (1, 1)] {
                let i = (2 * y + dy) * width + 2 * x + dx;
                for c in 0..3 {
                    pa[c] += lin8(a_rgba[i * 4 + c]) / 4.0;
                    pb[c] += lin8(b_rgb[i * 3 + c]) / 4.0;
                }
            }
            de.push(delta_e00(lab_of(pa), lab_of(pb)));
        }
    }
    stats(de)
}

/// [`compare_box2`] without the 2x2 blocks that hold a pixel of `a_rgba`
/// with alpha 0 (the golden test's out-of-sRGB mark), and the fraction of
/// blocks left out.
pub fn compare_box2_unmarked(
    a_rgba: &[u8],
    b_rgb: &[u8],
    width: usize,
    height: usize,
) -> (Stats, f64) {
    let (w2, h2) = (width / 2, height / 2);
    let mut de = Vec::with_capacity(w2 * h2);
    for y in 0..h2 {
        for x in 0..w2 {
            let block =
                [(0, 0), (1, 0), (0, 1), (1, 1)].map(|(dx, dy)| (2 * y + dy) * width + 2 * x + dx);
            if block.iter().any(|i| a_rgba[i * 4 + 3] == 0) {
                continue;
            }
            let mut pa = [0.0; 3];
            let mut pb = [0.0; 3];
            for i in block {
                for c in 0..3 {
                    pa[c] += lin8(a_rgba[i * 4 + c]) / 4.0;
                    pb[c] += lin8(b_rgb[i * 3 + c]) / 4.0;
                }
            }
            de.push(delta_e00(lab_of(pa), lab_of(pb)));
        }
    }
    let excluded = 1.0 - de.len() as f64 / (w2 * h2) as f64;
    (stats(de), excluded)
}

pub fn stats(mut de: Vec<f64>) -> Stats {
    let mean = de.iter().sum::<f64>() / de.len() as f64;
    de.sort_by(|x, y| x.total_cmp(y));
    let p999 = de[((de.len() - 1) as f64 * 0.999).round() as usize];
    Stats {
        mean,
        p999,
        max: *de.last().unwrap(),
    }
}

pub fn compare(a: &[u8], b_rgb: &[u8]) -> Stats {
    let de: Vec<f64> = a
        .chunks_exact(4)
        .zip(b_rgb.chunks_exact(3))
        .map(|(p, q)| {
            delta_e00(
                srgb_to_lab([p[0], p[1], p[2]]),
                srgb_to_lab([q[0], q[1], q[2]]),
            )
        })
        .collect();
    stats(de)
}

/// ΔE00 of an 8-bit RGBA render against a reference given as linear-light
/// sRGB (3 per pixel): the full-resolution statistics of every pixel and of
/// the pixels without the alpha-0 mark (the out-of-sRGB mark), the 2x2 box
/// statistics of every block, those without the blocks holding a marked
/// pixel, and the fraction of blocks left out.
pub struct Comparison {
    pub full: Stats,
    pub full_in_srgb: Stats,
    pub box2: Stats,
    pub box2_in_srgb: Stats,
    pub left_out: f64,
}

pub fn compare_to_linear(
    a_rgba: &[u8],
    b_linear: &[f64],
    width: usize,
    height: usize,
) -> Comparison {
    let lut: Vec<f64> = (0..=255u8).map(lin8).collect();
    let a = |i: usize| {
        [
            lut[a_rgba[i * 4] as usize],
            lut[a_rgba[i * 4 + 1] as usize],
            lut[a_rgba[i * 4 + 2] as usize],
        ]
    };
    let b = |i: usize| [b_linear[i * 3], b_linear[i * 3 + 1], b_linear[i * 3 + 2]];
    let full: Vec<f64> = (0..width * height)
        .map(|i| delta_e00(lab_of(a(i)), lab_of(b(i))))
        .collect();
    let full_in_srgb: Vec<f64> = full
        .iter()
        .enumerate()
        .filter(|(i, _)| a_rgba[i * 4 + 3] != 0)
        .map(|(_, d)| *d)
        .collect();
    let (w2, h2) = (width / 2, height / 2);
    let mut all = Vec::with_capacity(w2 * h2);
    let mut inside = Vec::with_capacity(w2 * h2);
    for y in 0..h2 {
        for x in 0..w2 {
            let block =
                [(0, 0), (1, 0), (0, 1), (1, 1)].map(|(dx, dy)| (2 * y + dy) * width + 2 * x + dx);
            let mut pa = [0.0; 3];
            let mut pb = [0.0; 3];
            for i in block {
                let (va, vb) = (a(i), b(i));
                for c in 0..3 {
                    pa[c] += va[c] / 4.0;
                    pb[c] += vb[c] / 4.0;
                }
            }
            let de = delta_e00(lab_of(pa), lab_of(pb));
            all.push(de);
            if block.iter().all(|i| a_rgba[i * 4 + 3] != 0) {
                inside.push(de);
            }
        }
    }
    let left_out = 1.0 - inside.len() as f64 / all.len() as f64;
    Comparison {
        full: stats(full),
        full_in_srgb: stats(full_in_srgb),
        box2: stats(all),
        box2_in_srgb: stats(inside),
        left_out,
    }
}

/// Linear-light sRGB of 16-bit sRGB-encoded RGB samples.
pub fn linear_of_rgb16(rgb16: &[u16]) -> Vec<f64> {
    let lut: Vec<f64> = (0..=65535u32)
        .map(|v| {
            let c = v as f64 / 65535.0;
            if c <= 0.04045 {
                c / 12.92
            } else {
                ((c + 0.055) / 1.055).powf(2.4)
            }
        })
        .collect();
    rgb16.iter().map(|v| lut[*v as usize]).collect()
}

/// Linear-light sRGB of 8-bit RGBA samples (alpha dropped).
pub fn linear_of_rgba8(rgba: &[u8]) -> Vec<f64> {
    let lut: Vec<f64> = (0..=255u8).map(lin8).collect();
    rgba.chunks_exact(4)
        .flat_map(|p| [lut[p[0] as usize], lut[p[1] as usize], lut[p[2] as usize]])
        .collect()
}

/// Generate a mathematical ROMM profile in memory for the synthetic ProPhoto test pixels.
/// No third-party ICC asset is committed or read from the host filesystem.
pub fn with_synthetic_prophoto_profile(bytes: &[u8]) -> Vec<u8> {
    use image::ImageEncoder;
    let image = image::load_from_memory(bytes).unwrap().to_rgb16();
    let pixels: Vec<u8> = image
        .as_raw()
        .iter()
        .flat_map(|v| v.to_ne_bytes())
        .collect();
    let mut output = Vec::new();
    let mut encoder = image::codecs::png::PngEncoder::new(&mut output);
    encoder
        .set_icc_profile(moxcms::ColorProfile::new_pro_photo_rgb().encode().unwrap())
        .unwrap();
    encoder
        .write_image(
            &pixels,
            image.width(),
            image.height(),
            image::ExtendedColorType::Rgb16,
        )
        .unwrap();
    output
}
