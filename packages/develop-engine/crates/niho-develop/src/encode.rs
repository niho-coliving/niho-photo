//! Output encoders: JPEG (quality 1..100) and PNG from the RGBA frame. The
//! pixels are sRGB; files carry no ICC profile (untagged = sRGB).

use image::codecs::jpeg::JpegEncoder;
use image::codecs::png::PngEncoder;
use image::{ExtendedColorType, ImageEncoder};

pub fn encode_jpeg(
    rgba: &[u8],
    width: usize,
    height: usize,
    quality: u8,
) -> Result<Vec<u8>, String> {
    let rgb: Vec<u8> = rgba
        .chunks_exact(4)
        .flat_map(|p| [p[0], p[1], p[2]])
        .collect();
    let mut out = Vec::new();
    let mut encoder = JpegEncoder::new_with_quality(&mut out, quality.clamp(1, 100));
    encoder
        .encode(&rgb, width as u32, height as u32, ExtendedColorType::Rgb8)
        .map_err(|e| e.to_string())?;
    Ok(out)
}

pub fn encode_png(rgba: &[u8], width: usize, height: usize) -> Result<Vec<u8>, String> {
    let mut out = Vec::new();
    PngEncoder::new(&mut out)
        .write_image(rgba, width as u32, height as u32, ExtendedColorType::Rgba8)
        .map_err(|e| e.to_string())?;
    Ok(out)
}
