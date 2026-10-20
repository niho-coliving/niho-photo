//! Working-copy encoding (contract §2.1): 16-bit RGB PNG, no ICC / gAMA / sRGB chunks,
//! `code = round(65535 × (clamp(v, 0, 2) / 2)^(1/1.8))`, decode `v = 2 × (code / 65535)^1.8`.

use std::fs::File;
use std::io::{BufWriter, Write};
use std::path::Path;

use anyhow::{bail, Context, Result};

use crate::par;

pub const GAMMA: f32 = 1.8;
pub const LINEAR_MAX: f32 = 2.0;
pub const BITS_PER_SAMPLE: u32 = 16;
/// Exact values for the sidecar (`f32 as f64` would print 1.7999999523162842).
pub const GAMMA_F64: f64 = 1.8;
pub const LINEAR_MAX_F64: f64 = 2.0;

/// Linear value → 16-bit code. NaN and negatives give 0; values above 2.0 clip.
#[inline]
pub fn encode_value(v: f32) -> u16 {
    if v.is_nan() || v <= 0.0 {
        return 0;
    }
    let x = v.min(LINEAR_MAX) / LINEAR_MAX;
    (65535.0 * x.powf(1.0 / GAMMA)).round() as u16
}

/// 16-bit code → linear value.
#[inline]
pub fn decode_value(code: u16) -> f32 {
    LINEAR_MAX * (code as f32 / 65535.0).powf(GAMMA)
}

/// Encode interleaved RGB to big-endian 16-bit samples (PNG sample order).
pub fn to_be_bytes(img: &[f32], w: usize, h: usize) -> Vec<u8> {
    assert_eq!(img.len(), w * h * 3);
    let mut bytes = vec![0u8; w * h * 6];
    par::for_each_row_mut(&mut bytes, w * 6, |y, row| {
        let src = &img[y * w * 3..(y + 1) * w * 3];
        for (dst, &v) in row.as_chunks_mut::<2>().0.iter_mut().zip(src) {
            dst.copy_from_slice(&encode_value(v).to_be_bytes());
        }
    });
    bytes
}

/// PNG bytes of a working copy (RGB, 16-bit).
pub fn png16_bytes(img: &[f32], w: usize, h: usize) -> Result<Vec<u8>> {
    let data = to_be_bytes(img, w, h);
    let mut out = Vec::with_capacity(data.len() / 2);
    write_png16_data(&mut out, &data, w, h)?;
    Ok(out)
}

fn write_png16_data<W: Write>(w: W, data: &[u8], width: usize, height: usize) -> Result<()> {
    let mut enc = png::Encoder::new(w, u32::try_from(width)?, u32::try_from(height)?);
    enc.set_color(png::ColorType::Rgb);
    enc.set_depth(png::BitDepth::Sixteen);
    enc.set_compression(png::Compression::Fast);
    let mut writer = enc.write_header().context("PNG header")?;
    writer.write_image_data(data).context("PNG data")?;
    writer.finish().context("PNG finish")?;
    Ok(())
}

/// Write the working copy to `path` atomically (temp file in the same directory, then rename).
pub fn write_png16(path: &Path, img: &[f32], w: usize, h: usize) -> Result<()> {
    let data = to_be_bytes(img, w, h);
    let tmp = tmp_path(path);
    {
        let file =
            File::create(&tmp).with_context(|| format!("cannot create {}", tmp.display()))?;
        let mut bw = BufWriter::with_capacity(1 << 20, file);
        write_png16_data(&mut bw, &data, w, h)?;
        bw.flush()?;
    }
    std::fs::rename(&tmp, path)
        .with_context(|| format!("cannot move {} to {}", tmp.display(), path.display()))?;
    Ok(())
}

/// Write bytes atomically (temp file + rename).
pub fn write_atomic(path: &Path, bytes: &[u8]) -> Result<()> {
    let tmp = tmp_path(path);
    std::fs::write(&tmp, bytes).with_context(|| format!("cannot write {}", tmp.display()))?;
    std::fs::rename(&tmp, path)
        .with_context(|| format!("cannot move {} to {}", tmp.display(), path.display()))?;
    Ok(())
}

fn tmp_path(path: &Path) -> std::path::PathBuf {
    let mut name = path
        .file_name()
        .map(|s| s.to_os_string())
        .unwrap_or_default();
    name.push(format!(".tmp-{}", std::process::id()));
    path.with_file_name(name)
}

/// Read a 16-bit RGB PNG (as written here) → (codes, width, height).
pub fn read_png16(bytes: &[u8]) -> Result<(Vec<u16>, usize, usize)> {
    let dec = png::Decoder::new(std::io::Cursor::new(bytes));
    let mut reader = dec.read_info().context("PNG header")?;
    let info = reader.info();
    if info.color_type != png::ColorType::Rgb || info.bit_depth != png::BitDepth::Sixteen {
        bail!(
            "expected a 16-bit RGB PNG (got {:?} {:?})",
            info.color_type,
            info.bit_depth
        );
    }
    let (w, h) = (info.width as usize, info.height as usize);
    let mut buf = vec![0u8; reader.output_buffer_size().context("PNG size")?];
    let frame = reader.next_frame(&mut buf).context("PNG data")?;
    let data = &buf[..frame.buffer_size()];
    Ok((
        data.as_chunks::<2>()
            .0
            .iter()
            .map(|c| u16::from_be_bytes([c[0], c[1]]))
            .collect(),
        w,
        h,
    ))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn value_roundtrip() {
        for v in [0.0_f32, 0.18, 1.0, 2.0] {
            let back = decode_value(encode_value(v));
            // One code step near v, relative to the curve's slope.
            let tol = if v == 0.0 {
                1e-9
            } else {
                2.0 * v / (65535.0 * (v / 2.0).powf(1.0 / GAMMA))
            };
            assert!((back - v).abs() <= tol.max(1e-7), "{v} -> {back}");
        }
        assert_eq!(encode_value(0.0), 0);
        assert_eq!(encode_value(2.0), 65535);
        assert_eq!(encode_value(5.0), 65535);
        assert_eq!(encode_value(-1.0), 0);
        assert_eq!(encode_value(f32::NAN), 0);
        // 0.18 → round(65535 × 0.09^(1/1.8))
        let expected = (65535.0_f64 * 0.09_f64.powf(1.0 / 1.8)).round() as u16;
        assert_eq!(encode_value(0.18), expected);
    }

    #[test]
    fn png_roundtrip() {
        let (w, h) = (5, 3);
        let img: Vec<f32> = (0..w * h * 3)
            .map(|i| i as f32 / (w * h * 3) as f32 * 2.0)
            .collect();
        let bytes = png16_bytes(&img, w, h).unwrap();
        let (codes, rw, rh) = read_png16(&bytes).unwrap();
        assert_eq!((rw, rh), (w, h));
        for (c, v) in codes.iter().zip(&img) {
            assert_eq!(*c, encode_value(*v));
        }
        // No color-management chunks.
        for chunk in [b"iCCP", b"gAMA", b"sRGB", b"cHRM"] {
            assert!(!bytes.windows(4).any(|x| x == chunk), "unexpected chunk");
        }
    }
}
