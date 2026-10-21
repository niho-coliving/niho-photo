//! Synthetic chart and statistics for comparing v5 detail with Lightroom
//! (Issue #32, `docs/detail-processing.md`). Only generated pixels; no photo.
//!
//!   cargo run --release -p niho-develop --example detail_chart -- write <chart.png>
//!   cargo run --release -p niho-develop --example detail_chart -- measure <export.png|jpg>...
//!
//! The chart is 2048 x 1366 8-bit sRGB: a vertical step edge between two
//! flat halves (88/88/92 and 182/178/170) with seeded, per-channel
//! independent noise of +-13 levels. `measure` prints one JSON line per
//! file with the statistics the tests use (`tests/detail_effect.rs`), scaled
//! to the file's size: the mean squared horizontal luma step across the
//! edge band (sharpening), and the dark half's luma / chroma standard
//! deviation (luminance / color noise reduction).

use niho_develop::encode;

const WIDTH: usize = 2048;
const HEIGHT: usize = 1366;

fn chart() -> Vec<u8> {
    let mut state = 0x0bad_cafe_u32;
    let mut noise = || {
        state ^= state << 13;
        state ^= state >> 17;
        state ^= state << 5;
        state as f32 / u32::MAX as f32 - 0.5
    };
    let mut rgba = Vec::with_capacity(WIDTH * HEIGHT * 4);
    for _y in 0..HEIGHT {
        for x in 0..WIDTH {
            let base: [f32; 3] = if x >= WIDTH / 2 {
                [182.0, 178.0, 170.0]
            } else {
                [88.0, 88.0, 92.0]
            };
            for value in base {
                rgba.push((value + noise() * 26.0).round().clamp(0.0, 255.0) as u8);
            }
            rgba.push(255);
        }
    }
    rgba
}

fn luma(p: &[u8]) -> f64 {
    0.2126 * f64::from(p[0]) + 0.7152 * f64::from(p[1]) + 0.0722 * f64::from(p[2])
}

fn standard_deviation(values: &[f64]) -> f64 {
    let mean = values.iter().sum::<f64>() / values.len() as f64;
    (values.iter().map(|v| (v - mean).powi(2)).sum::<f64>() / values.len() as f64).sqrt()
}

fn measure(path: &str) -> String {
    let image = image::open(path).expect("readable image").to_rgba8();
    let (width, height) = (image.width() as usize, image.height() as usize);
    let pixel = |x: usize, y: usize| image.get_pixel(x as u32, y as u32).0;
    let (top, bottom) = (height / 8, height - height / 8);
    let band = (width * 12 / 512).max(2);
    let middle = width / 2;
    let mut steps = Vec::new();
    for y in top..bottom {
        for x in middle - band..middle + band {
            let step = luma(&pixel(x + 1, y)) - luma(&pixel(x, y));
            steps.push(step * step);
        }
    }
    let acutance = steps.iter().sum::<f64>() / steps.len() as f64;
    let (left, right) = (width / 16, middle - width * 48 / 512);
    let mut lumas = Vec::new();
    let (mut red, mut blue) = (Vec::new(), Vec::new());
    for y in top..bottom {
        for x in left..right {
            let p = pixel(x, y);
            lumas.push(luma(&p));
            red.push(f64::from(p[0]) - f64::from(p[1]));
            blue.push(f64::from(p[2]) - f64::from(p[1]));
        }
    }
    format!(
        r#"{{"file":{:?},"width":{width},"height":{height},"edgeAcutance":{acutance:.3},"flatLumaSd":{:.4},"flatChromaSd":{:.4}}}"#,
        path,
        standard_deviation(&lumas),
        standard_deviation(&red).hypot(standard_deviation(&blue)),
    )
}

fn main() {
    let args: Vec<String> = std::env::args().skip(1).collect();
    match args.first().map(String::as_str) {
        Some("write") => {
            let out = args.get(1).expect("write <chart.png>");
            std::fs::write(out, encode::encode_png(&chart(), WIDTH, HEIGHT).unwrap()).unwrap();
        }
        Some("measure") if args.len() > 1 => {
            for path in &args[1..] {
                println!("{}", measure(path));
            }
        }
        _ => {
            eprintln!("usage: detail_chart write <chart.png> | measure <image>...");
            std::process::exit(2);
        }
    }
}
