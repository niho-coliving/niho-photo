//! Embedded lens correction experiment for Sony ARW and Panasonic RW2.
//! Only the quality probe calls this module; no production path uses it.

use std::path::Path;

use anyhow::{bail, Context, Result};
use niho_base_raw::tiff::{self, Ifd, RawEntry, MAGIC_RW2, MAGIC_TIFF, TYPE_SHORT, TYPE_SSHORT};
use serde::Serialize;

#[derive(Debug)]
pub enum Params {
    Sony {
        distortion: Vec<f64>,
        vignetting: Option<Vec<f64>>,
    },
    Panasonic {
        scale: f64,
        a: f64,
        b: f64,
        c: f64,
    },
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Report {
    pub source: &'static str,
    pub frame_scale: f64,
    pub vignetting_gain_max: Option<f64>,
}

fn signed_words(entry: &RawEntry, little_endian: bool) -> Option<Vec<i16>> {
    if !matches!(entry.typ, TYPE_SHORT | TYPE_SSHORT)
        || entry.count < 3
        || entry.count > 100
        || entry.data.len() != entry.count * 2
    {
        return None;
    }
    Some(
        entry
            .data
            .as_chunks::<2>()
            .0
            .iter()
            .map(|b| {
                if little_endian {
                    i16::from_le_bytes([b[0], b[1]])
                } else {
                    i16::from_be_bytes([b[0], b[1]])
                }
            })
            .collect(),
    )
}

fn sony_values(ifd: &Ifd, tag: u16) -> Option<Vec<f64>> {
    let entry = ifd.entries.get(&tag)?;
    let words = signed_words(entry, ifd.little_endian)?;
    let n = usize::try_from(*words.first()?).ok()?;
    if n < 2 || n + 1 > words.len() {
        return None;
    }
    Some(words[1..=n].iter().map(|&v| f64::from(v)).collect())
}

fn panasonic_params(ifd: &Ifd) -> Option<Params> {
    let entry = ifd.entries.get(&0x0119)?;
    if !ifd.little_endian || entry.data.len() != 32 {
        return None;
    }
    let words: Vec<i16> = entry
        .data
        .as_chunks::<2>()
        .0
        .iter()
        .map(|b| i16::from_le_bytes([b[0], b[1]]))
        .collect();
    // The modern DC-S5 files observed here carry additional bits in word 7
    // and use 3605 in word 12; the low bit still enables correction.
    if words[7] & 1 == 0 || words[12] <= 0 {
        return None;
    }
    let scale = 1.0 / (1.0 + f64::from(words[5]) / 32768.0);
    let a = f64::from(words[8]) / 32768.0;
    let b = f64::from(words[4]) / 32768.0;
    let c = f64::from(words[11]) / 32768.0;
    if !(scale.is_finite() && scale > 0.5 && scale < 2.0) {
        return None;
    }
    Some(Params::Panasonic { scale, a, b, c })
}

pub fn load(raw_path: &Path) -> Result<Params> {
    let bytes = std::fs::read(raw_path)
        .with_context(|| format!("cannot read RAW lens data {}", raw_path.display()))?;
    let root = tiff::read_first_ifd(&bytes).context("cannot read RAW TIFF header")?;
    match root.magic {
        MAGIC_RW2 => panasonic_params(&root)
            .context("RW2 has no supported, enabled embedded distortion parameters"),
        MAGIC_TIFF => {
            for ifd in tiff::read_sub_ifds(&bytes).context("cannot read ARW SubIFD")? {
                if let Some(distortion) = sony_values(&ifd, 0x7037) {
                    let vignetting = sony_values(&ifd, 0x7032);
                    return Ok(Params::Sony {
                        distortion,
                        vignetting,
                    });
                }
            }
            bail!("RAW has no Sony SubIFD DistortionCorrParams")
        }
        _ => bail!("RAW has no supported embedded lens correction"),
    }
}

#[inline]
fn reflect101(mut index: isize, len: usize) -> usize {
    if len == 1 {
        return 0;
    }
    let len = len as isize;
    while index < 0 || index >= len {
        index = if index < 0 {
            -index
        } else {
            2 * len - 2 - index
        };
    }
    index as usize
}

#[inline]
fn cubic_weights(t: f32) -> [f32; 4] {
    let t2 = t * t;
    let t3 = t2 * t;
    [
        -0.5 * t3 + t2 - 0.5 * t,
        1.5 * t3 - 2.5 * t2 + 1.0,
        -1.5 * t3 + 2.0 * t2 + 0.5 * t,
        0.5 * t3 - 0.5 * t2,
    ]
}

fn sample_cubic(src: &[f32], width: usize, height: usize, x: f64, y: f64) -> [f32; 3] {
    let x0 = x.floor() as isize;
    let y0 = y.floor() as isize;
    let wx = cubic_weights((x - x0 as f64) as f32);
    let wy = cubic_weights((y - y0 as f64) as f32);
    let mut out = [0.0_f32; 3];
    for (j, weight_y) in wy.iter().enumerate() {
        let yy = reflect101(y0 - 1 + j as isize, height);
        for (i, weight_x) in wx.iter().enumerate() {
            let xx = reflect101(x0 - 1 + i as isize, width);
            let weight = weight_x * weight_y;
            let base = (yy * width + xx) * 3;
            for channel in 0..3 {
                out[channel] += src[base + channel] * weight;
            }
        }
    }
    out
}

fn interpolate_linear(values: &[f64], radius: f64) -> f64 {
    let t = radius.clamp(0.0, 1.0) * (values.len() - 1) as f64;
    let i = (t.floor() as usize).min(values.len() - 2);
    let u = t - i as f64;
    values[i] * (1.0 - u) + values[i + 1] * u
}

fn interpolate_cubic(values: &[f64], radius: f64) -> f64 {
    let t = radius.clamp(0.0, 1.0) * (values.len() - 1) as f64;
    let i = (t.floor() as usize).min(values.len() - 2);
    let u = t - i as f64;
    let p0 = if i == 0 {
        2.0 * values[0] - values[1]
    } else {
        values[i - 1]
    };
    let p1 = values[i];
    let p2 = values[i + 1];
    let p3 = if i + 2 < values.len() {
        values[i + 2]
    } else {
        2.0 * values[values.len() - 1] - values[values.len() - 2]
    };
    0.5 * (2.0 * p1
        + (-p0 + p2) * u
        + (2.0 * p0 - 5.0 * p1 + 4.0 * p2 - p3) * u * u
        + (-p0 + 3.0 * p1 - 3.0 * p2 + p3) * u * u * u)
}

fn sony_frame_scale(width: usize, height: usize, radius: f64, factors: &[f64]) -> f64 {
    let cx = (width - 1) as f64 / 2.0;
    let cy = (height - 1) as f64 / 2.0;
    let mut scale = 1.0;
    for _ in 0..50 {
        let mut next = f64::INFINITY;
        let mut visit = |x: usize, y: usize| {
            let px = x as f64 - cx;
            let py = y as f64 - cy;
            let factor = interpolate_cubic(factors, px.hypot(py) * scale / radius);
            if (px * factor).abs() > 1e-9 {
                next = next.min(cx / (px * factor).abs());
            }
            if (py * factor).abs() > 1e-9 {
                next = next.min(cy / (py * factor).abs());
            }
        };
        for x in 0..width {
            visit(x, 0);
            visit(x, height - 1);
        }
        for y in 0..height {
            visit(0, y);
            visit(width - 1, y);
        }
        if (next - scale).abs() < 1e-12 {
            return next;
        }
        scale = next;
    }
    scale
}

fn panasonic_source_radius(output_radius: f64, scale: f64, a: f64, b: f64, c: f64) -> f64 {
    let mut source_radius = output_radius / scale;
    for _ in 0..8 {
        let r2 = source_radius * source_radius;
        let r4 = r2 * r2;
        let r6 = r4 * r2;
        let f = scale * source_radius * (1.0 + a * r2 + b * r4 + c * r6) - output_radius;
        let slope = scale * (1.0 + 3.0 * a * r2 + 5.0 * b * r4 + 7.0 * c * r6);
        source_radius -= f / slope;
    }
    source_radius
}

pub fn apply(rgb: &mut [f32], width: usize, height: usize, params: &Params) -> Report {
    assert_eq!(rgb.len(), width * height * 3);
    let cx = (width - 1) as f64 / 2.0;
    let cy = (height - 1) as f64 / 2.0;
    let half_diagonal = (width as f64 / 2.0).hypot(height as f64 / 2.0);
    let (source, report, scale) = match params {
        Params::Sony {
            distortion,
            vignetting,
        } => {
            let mut values = distortion.clone();
            if values[0].abs() > 4.0 * values[1].abs().max(1.0) {
                values[0] = 0.0;
            }
            let factors: Vec<f64> = values.iter().map(|v| 1.0 + v * 2.0_f64.powi(-14)).collect();
            let mut source = rgb.to_vec();
            let max_gain = vignetting.as_ref().map(|values| {
                let gains: Vec<f64> = values
                    .iter()
                    .map(|v| 2.0_f64.powf(-(0.5 - 2.0_f64.powf(v * 2.0_f64.powi(-13) - 1.0))))
                    .collect();
                let radius = half_diagonal * 1.146;
                for y in 0..height {
                    for x in 0..width {
                        let r = (x as f64 - cx).hypot(y as f64 - cy) / radius;
                        let gain = interpolate_linear(&gains, r) as f32;
                        for channel in &mut source[(y * width + x) * 3..(y * width + x) * 3 + 3] {
                            *channel *= gain;
                        }
                    }
                }
                gains.into_iter().fold(1.0, f64::max)
            });
            let frame_scale = sony_frame_scale(width, height, half_diagonal * 1.01, &factors);
            let report = Report {
                source: "sony-arw-subifd",
                frame_scale,
                vignetting_gain_max: max_gain,
            };
            (source, report, Some(factors))
        }
        Params::Panasonic { .. } => (
            rgb.to_vec(),
            Report {
                source: "panasonic-rw2-0x0119",
                frame_scale: 1.0,
                vignetting_gain_max: None,
            },
            None,
        ),
    };
    for y in 0..height {
        let py = y as f64 - cy;
        for x in 0..width {
            let px = x as f64 - cx;
            let distance = px.hypot(py);
            let factor = match (params, &scale) {
                (Params::Sony { .. }, Some(factors)) => {
                    let k = report.frame_scale;
                    k * interpolate_cubic(factors, distance * k / (half_diagonal * 1.01))
                }
                (Params::Panasonic { scale, a, b, c }, _) => {
                    let output_radius = distance / half_diagonal;
                    if output_radius < 1e-12 {
                        1.0
                    } else {
                        panasonic_source_radius(output_radius, *scale, *a, *b, *c) / output_radius
                    }
                }
                _ => unreachable!(),
            };
            let pixel = sample_cubic(&source, width, height, cx + px * factor, cy + py * factor);
            rgb[(y * width + x) * 3..(y * width + x) * 3 + 3].copy_from_slice(&pixel);
        }
    }
    report
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::BTreeMap;

    #[test]
    fn panasonic_inverse_round_trip() {
        for r in [0.0, 0.2, 0.5, 0.8, 1.0] {
            let (scale, a, b, c) = (1.032, -0.0325, 0.0032, -0.0015);
            let source = panasonic_source_radius(r, scale, a, b, c);
            let round_trip = scale
                * source
                * (1.0 + a * source.powi(2) + b * source.powi(4) + c * source.powi(6));
            assert!((round_trip - r).abs() < 1e-10);
        }
    }

    #[test]
    fn identity_correction_keeps_pixels() {
        let mut rgb: Vec<f32> = (0..8 * 6 * 3).map(|i| i as f32 / 100.0).collect();
        let before = rgb.clone();
        apply(
            &mut rgb,
            8,
            6,
            &Params::Panasonic {
                scale: 1.0,
                a: 0.0,
                b: 0.0,
                c: 0.0,
            },
        );
        for (a, b) in rgb.iter().zip(before) {
            assert!((a - b).abs() < 1e-5);
        }
    }

    #[test]
    fn accepts_modern_rw2_flag_and_rejects_disabled_flag() {
        let mut words = [0_i16; 16];
        words[4] = 100;
        words[5] = -1000;
        words[7] = 257;
        words[8] = -1000;
        words[11] = -50;
        words[12] = 3605;
        let data = words.iter().flat_map(|word| word.to_le_bytes()).collect();
        let make_ifd = |data| Ifd {
            little_endian: true,
            magic: MAGIC_RW2,
            entries: BTreeMap::from([(
                0x0119,
                RawEntry {
                    typ: tiff::TYPE_UNDEFINED,
                    count: 32,
                    data,
                },
            )]),
        };
        let ifd = make_ifd(data);
        let Some(Params::Panasonic { scale, a, .. }) = panasonic_params(&ifd) else {
            panic!("enabled modern RW2 parameters should parse")
        };
        assert!((scale - 1.0 / (1.0 - 1000.0 / 32768.0)).abs() < 1e-10);
        assert!((a + 1000.0 / 32768.0).abs() < 1e-10);
        let mut data = ifd.entries[&0x0119].data.clone();
        data[14..16].copy_from_slice(&256_i16.to_le_bytes());
        assert!(panasonic_params(&make_ifd(data)).is_none());
    }
}
