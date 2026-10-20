//! Writes `fixtures/golden/input/saturated-blue.png`: 16-bit ProPhoto (ROMM,
//! embedded ICC) patches of saturated blue to violet, CIELab (D50) L* 25..55,
//! C* 40..100, h 240..300, each 32x32, row-major in that order, plus a
//! neutral and an in-gamut blue for reference. Colors outside sRGB, as a
//! night scene's colored lights (S9 #16999): the output transform must keep
//! their chroma and hue close to a plain sRGB clip (Lightroom).
//!
//!   cargo run --release -p niho-develop --example saturated_patches -- fixtures/golden/input/saturated-blue.png

use image::ImageEncoder;

pub const PATCH: usize = 32;
pub const COLUMNS: usize = 8;

/// XYZ (D50) -> linear ProPhoto (ROMM RGB).
const XYZ_TO_PROPHOTO: [[f64; 3]; 3] = [
    [1.3459433, -0.2556075, -0.0511118],
    [-0.5445989, 1.5081673, 0.0205351],
    [0.0, 0.0, 1.2118128],
];

fn prophoto_from_lab(l: f64, c: f64, h: f64) -> [f64; 3] {
    let (a, b) = (c * h.to_radians().cos(), c * h.to_radians().sin());
    let fy = (l + 16.0) / 116.0;
    let (fx, fz) = (fy + a / 500.0, fy - b / 200.0);
    let inv = |t: f64| {
        if t > 6.0 / 29.0 {
            t * t * t
        } else {
            3.0 * (6.0f64 / 29.0).powi(2) * (t - 4.0 / 29.0)
        }
    };
    let xyz = [0.9642 * inv(fx), inv(fy), 0.8249 * inv(fz)];
    let m = XYZ_TO_PROPHOTO;
    [0, 1, 2].map(|i| m[i][0] * xyz[0] + m[i][1] * xyz[1] + m[i][2] * xyz[2])
}

fn main() {
    let out = std::env::args().nth(1).expect("output path");
    let mut colors: Vec<[f64; 3]> = vec![
        prophoto_from_lab(50.0, 0.0, 0.0),
        prophoto_from_lab(45.0, 40.0, 270.0),
    ];
    for l in [25.0, 35.0, 45.0, 55.0] {
        for c in [40.0, 60.0, 80.0, 100.0] {
            for h in [240.0, 255.0, 270.0, 285.0, 300.0] {
                let pp = prophoto_from_lab(l, c, h);
                if pp.iter().all(|v| (0.0..=1.0).contains(v)) {
                    colors.push(pp);
                }
            }
        }
    }
    let rows = colors.len().div_ceil(COLUMNS);
    let (w, h) = (COLUMNS * PATCH, rows * PATCH);
    let mut pixels = vec![0u16; w * h * 3];
    let enc = |v: f64| (v.clamp(0.0, 1.0).powf(1.0 / 1.8) * 65535.0).round() as u16;
    for (i, c) in colors.iter().enumerate() {
        let (px, py) = ((i % COLUMNS) * PATCH, (i / COLUMNS) * PATCH);
        for y in py..py + PATCH {
            for x in px..px + PATCH {
                let o = (y * w + x) * 3;
                pixels[o..o + 3].copy_from_slice(&[enc(c[0]), enc(c[1]), enc(c[2])]);
            }
        }
    }
    let bytes: Vec<u8> = pixels.iter().flat_map(|v| v.to_ne_bytes()).collect();
    let mut png = Vec::new();
    let encoder = image::codecs::png::PngEncoder::new(&mut png);
    encoder
        .write_image(&bytes, w as u32, h as u32, image::ExtendedColorType::Rgb16)
        .unwrap();
    std::fs::write(&out, png).unwrap();
    println!("{out}: {} patches, {w}x{h}", colors.len());
}
