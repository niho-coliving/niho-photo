//! Image operations: bilinear and Lanczos keep constant images constant, the working-copy encoding
//! round trips through a PNG file, orientation swaps the axes.

use niho_base_raw::orient::{self, Orientation};
use niho_base_raw::{demosaic, encode, resize};

#[test]
fn bilinear_constant_image_is_constant() {
    for pattern in [
        [[0u8, 1], [1, 2]],
        [[2, 1], [1, 0]],
        [[1, 0], [2, 1]],
        [[1, 2], [0, 1]],
    ] {
        // Odd sizes exercise the reflected right / bottom borders.
        for (w, h) in [(37, 23), (38, 24), (2, 2)] {
            let cfa = vec![0.4375_f32; w * h];
            let rgb = demosaic::bilinear(&cfa, w, h, pattern);
            assert_eq!(rgb.len(), w * h * 3);
            assert!(rgb.iter().all(|&v| v == 0.4375), "{pattern:?} {w}x{h}");
        }
    }
}

#[test]
fn lanczos_constant_image_is_constant() {
    let (w, h) = (600, 400);
    let img = vec![0.7_f32; w * h * 3];
    for (ow, oh) in [(256, 171), (97, 64), (599, 400), (600, 400)] {
        let out = resize::lanczos3_rgb(&img, w, h, ow, oh);
        assert_eq!(out.len(), ow * oh * 3);
        assert!(out.iter().all(|&v| (v - 0.7).abs() < 2e-6), "{ow}x{oh}");
    }
}

#[test]
fn working_copy_png_file_roundtrip() {
    // Contract §2.1 sample values.
    let values = [0.0_f32, 0.18, 1.0, 2.0];
    let img: Vec<f32> = values.iter().flat_map(|&v| [v, v, v]).collect();
    let dir = std::env::temp_dir().join(format!("niho-base-raw-image-ops-{}", std::process::id()));
    std::fs::create_dir_all(&dir).unwrap();
    let path = dir.join("roundtrip.png");
    encode::write_png16(&path, &img, 4, 1).unwrap();
    let (codes, w, h) = encode::read_png16(&std::fs::read(&path).unwrap()).unwrap();
    std::fs::remove_dir_all(&dir).ok();
    assert_eq!((w, h), (4, 1));
    let expected =
        |v: f32| (65535.0_f64 * ((v as f64).clamp(0.0, 2.0) / 2.0).powf(1.0 / 1.8)).round() as u16;
    for (i, &v) in values.iter().enumerate() {
        for c in 0..3 {
            assert_eq!(codes[i * 3 + c], expected(v), "v={v}");
        }
        let back = encode::decode_value(codes[i * 3]);
        // Within one code step of the curve.
        let step = if v == 0.0 {
            0.0
        } else {
            2.0 * 1.8 * (v / 2.0).powf(1.0 - 1.0 / 1.8) / 65535.0
        };
        assert!((back - v).abs() <= step + 1e-7, "{v} → {back}");
    }
    assert_eq!(codes[0], 0);
    assert_eq!(codes[9], 65535);
}

#[test]
fn orientation_swaps_axes() {
    let img = vec![0.5_f32; 6 * 4 * 3];
    for (o, dims) in [
        (Orientation::Normal, (6, 4)),
        (Orientation::Rotate180, (6, 4)),
        (Orientation::Rotate90, (4, 6)),
        (Orientation::Rotate270, (4, 6)),
        (Orientation::Transpose, (4, 6)),
    ] {
        let (_, w, h) = orient::apply(img.clone(), 6, 4, o);
        assert_eq!((w, h), dims, "{o:?}");
    }
}
