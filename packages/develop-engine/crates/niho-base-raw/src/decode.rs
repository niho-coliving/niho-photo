//! rawler → [`CameraRaw`]: the Bayer mosaic plus the metadata stage 1 needs.

use std::panic::{catch_unwind, AssertUnwindSafe};
use std::path::Path;

use anyhow::{anyhow, bail, Context, Result};
use rawler::decoders::RawDecodeParams;
use rawler::rawimage::RawPhotometricInterpretation;
use rawler::rawsource::RawSource;
use rawler::RawImageData;

use crate::dcp::tag;
use crate::orient::Orientation;
use crate::tiff;

/// Raw sample storage (full sensor frame, one sample per photosite).
pub enum RawData {
    U16(Vec<u16>),
    F32(Vec<f32>),
}

/// Crop rectangle in full-frame coordinates.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Crop {
    pub x: usize,
    pub y: usize,
    pub width: usize,
    pub height: usize,
}

/// A decoded 2×2 Bayer raw. Positions `[dy][dx]` / index `dy * 2 + dx` are relative to the crop
/// origin (the top-left pixel of the output image).
pub struct CameraRaw {
    pub make: String,
    pub model: String,
    pub clean_make: String,
    pub clean_model: String,
    pub full_width: usize,
    pub full_height: usize,
    pub crop: Crop,
    /// CFA colors (0 = R, 1 = G, 2 = B) relative to the crop origin.
    pub pattern: [[u8; 2]; 2],
    /// Black level per 2×2 position relative to the crop origin.
    pub black: [f32; 4],
    /// White level per 2×2 position relative to the crop origin.
    pub white: [f32; 4],
    /// Black levels as reported by the decoder (full-frame repeat pattern).
    pub black_reported: Vec<f64>,
    pub white_reported: Vec<f64>,
    /// As-shot white balance coefficients (R, G, B[, E]) as decoded (G = 1 for most cameras).
    pub wb_coeffs: [f32; 4],
    pub orientation: Orientation,
    /// Where the orientation came from: "decoder", "exif" or "default".
    pub orientation_source: &'static str,
    pub bits_per_sample: u32,
    /// ISO from EXIF (ISOSpeedRatings, else ISOSpeed).
    pub iso: Option<f64>,
    /// The raw's own exposure offset (EV): the DNG BaselineExposure tag, or the extended-low-ISO pull
    /// (see [`extended_low_iso_ev`]). `None` when neither applies.
    pub baseline_exposure: Option<f64>,
    /// Where `baseline_exposure` came from: `"dng"` or `"extended-low-iso"`.
    pub baseline_exposure_source: Option<&'static str>,
    /// Color matrices known to rawler (illuminant name → XYZ → camera, row-major). Informational.
    pub rawler_color_matrices: Vec<(String, Vec<f64>)>,
    pub data: RawData,
}

impl CameraRaw {
    /// CFA pattern name relative to the crop origin, e.g. "RGGB".
    pub fn cfa_name(&self) -> String {
        let c = |v: u8| match v {
            0 => 'R',
            1 => 'G',
            _ => 'B',
        };
        [
            self.pattern[0][0],
            self.pattern[0][1],
            self.pattern[1][0],
            self.pattern[1][1],
        ]
        .iter()
        .map(|&v| c(v))
        .collect()
    }

    /// As-shot multipliers `mul_c = wb_c / min(wb)` (R, G, B).
    pub fn as_shot_multipliers(&self) -> [f64; 3] {
        let wb = [
            self.wb_coeffs[0] as f64,
            self.wb_coeffs[1] as f64,
            self.wb_coeffs[2] as f64,
        ];
        let min = wb[0].min(wb[1]).min(wb[2]);
        [wb[0] / min, wb[1] / min, wb[2] / min]
    }

    /// Camera neutral `n_c = 1 / mul_c` (max component 1).
    pub fn as_shot_neutral(&self) -> [f64; 3] {
        let m = self.as_shot_multipliers();
        [1.0 / m[0], 1.0 / m[1], 1.0 / m[2]]
    }
}

/// A 2×2 Bayer tile: the two greens on one diagonal, red and blue on the other.
fn is_bayer(p: &[[u8; 2]; 2]) -> bool {
    let (a, b) = if p[0][0] == 1 && p[1][1] == 1 {
        (p[0][1], p[1][0])
    } else if p[0][1] == 1 && p[1][0] == 1 {
        (p[0][0], p[1][1])
    } else {
        return false;
    };
    (a == 0 && b == 2) || (a == 2 && b == 0)
}

/// Lowest native ISO of the cameras whose extended low ISO (e.g. "ISO 50" on a base-100 sensor) is the base
/// gain with more light: Lightroom renders such a frame darker by log2(base / ISO) EV. Checked on the Sony
/// ZV-E10M2 (round6: the ISO 50 frames, MakerNote StopsAboveBaseISO = -1.0, need -1 EV more than the ISO
/// 2000 frame to meet the Lightroom neutral export). The FX30 shares Sony's convention; other cameras are not
/// verified and get no pull.
const EXTENDED_LOW_ISO_BASE: &[(&str, &str, f64)] =
    &[("Sony", "ZV-E10M2", 100.0), ("Sony", "ILME-FX30", 100.0)];

/// Exposure (EV, negative) a frame shot below the camera's base ISO needs; `None` at or above it, for an
/// unknown ISO and for cameras outside [`EXTENDED_LOW_ISO_BASE`].
pub fn extended_low_iso_ev(clean_make: &str, clean_model: &str, iso: Option<f64>) -> Option<f64> {
    let iso = iso.filter(|v| v.is_finite() && *v > 0.0)?;
    let base = EXTENDED_LOW_ISO_BASE
        .iter()
        .find(|(make, model, _)| {
            make.eq_ignore_ascii_case(clean_make.trim())
                && model.eq_ignore_ascii_case(clean_model.trim())
        })?
        .2;
    (iso < base).then(|| (iso / base).log2())
}

#[derive(Clone, Copy, Debug, PartialEq)]
struct DngRawMetadata {
    is_dng: bool,
    baseline_exposure: Option<f64>,
}

fn dng_raw_metadata(bytes: &[u8]) -> DngRawMetadata {
    const PHOTOMETRIC_INTERPRETATION: u16 = 262;
    const CFA_PHOTOMETRIC: f64 = 32803.0;
    let Ok(root) = tiff::read_first_ifd(bytes) else {
        return DngRawMetadata {
            is_dng: false,
            baseline_exposure: None,
        };
    };
    if root.magic != tiff::MAGIC_TIFF {
        return DngRawMetadata {
            is_dng: false,
            baseline_exposure: None,
        };
    }
    let is_dng = root.has(tag::DNG_VERSION);
    let sub_ifds = tiff::read_sub_ifds(bytes).unwrap_or_default();
    let is_raw_ifd = |ifd: &&tiff::Ifd| {
        ifd.numbers(PHOTOMETRIC_INTERPRETATION)
            .and_then(|v| v.first().copied())
            == Some(CFA_PHOTOMETRIC)
            || ifd.has(33421) // CFARepeatPatternDim is another raw-IFD marker.
    };
    let baseline = |ifd: &tiff::Ifd| {
        ifd.numbers(tag::BASELINE_EXPOSURE)
            .and_then(|values| values.first().copied())
    };
    let from_raw_sub_ifd = sub_ifds.iter().filter(is_raw_ifd).find_map(baseline);
    let from_any_sub_ifd = sub_ifds.iter().find_map(baseline);
    let baseline_exposure = from_raw_sub_ifd.or(from_any_sub_ifd).or_else(|| {
        root.numbers(tag::BASELINE_EXPOSURE)
            .and_then(|values| values.first().copied())
    });
    DngRawMetadata {
        is_dng,
        baseline_exposure,
    }
}

fn raw_baseline_exposure(
    bytes: &[u8],
    clean_make: &str,
    clean_model: &str,
    iso: Option<f64>,
) -> (Option<f64>, Option<&'static str>) {
    let metadata = dng_raw_metadata(bytes);
    match metadata.baseline_exposure {
        Some(ev) => (Some(ev), Some("dng")),
        None if metadata.is_dng => (None, None),
        None => match extended_low_iso_ev(clean_make, clean_model, iso) {
            Some(ev) => (Some(ev), Some("extended-low-iso")),
            None => (None, None),
        },
    }
}

/// Decode a raw file with rawler.
pub fn decode_file(path: &Path) -> Result<CameraRaw> {
    let src =
        RawSource::new(path).with_context(|| format!("cannot open raw file {}", path.display()))?;
    let params = RawDecodeParams::default();
    let decoded = catch_unwind(AssertUnwindSafe(|| -> Result<_> {
        let decoder =
            rawler::get_decoder(&src).map_err(|e| anyhow!("unsupported raw file: {e}"))?;
        let raw = decoder
            .raw_image(&src, &params, false)
            .map_err(|e| anyhow!("raw decode failed: {e}"))?;
        let meta = decoder.raw_metadata(&src, &params).ok();
        let exif_orientation = meta.as_ref().and_then(|m| m.exif.orientation);
        let iso = meta.as_ref().and_then(|m| {
            m.exif
                .iso_speed_ratings
                .map(f64::from)
                .or(m.exif.iso_speed.map(f64::from))
        });
        Ok((raw, exif_orientation, iso))
    }))
    .map_err(|_| anyhow!("rawler panicked while decoding {}", path.display()))?;
    let (raw, exif_orientation, iso) = decoded?;

    // Prefer the raw CFA SubIFD; some DNG writers leave BaselineExposure out of IFD0.
    // The extended-low-ISO correction is only for non-DNG raw files.
    let (baseline_exposure, baseline_exposure_source) =
        raw_baseline_exposure(src.buf(), &raw.clean_make, &raw.clean_model, iso);
    drop(src);

    if raw.cpp != 1 {
        bail!(
            "unsupported raw layout: {} samples per pixel (only Bayer CFA is supported)",
            raw.cpp
        );
    }
    let cfa = match &raw.photometric {
        RawPhotometricInterpretation::Cfa(config) => config.cfa.clone(),
        other => {
            bail!("unsupported photometric interpretation {other:?} (only Bayer CFA is supported)")
        }
    };
    if cfa.width != 2 || cfa.height != 2 {
        bail!(
            "unsupported CFA {} ({}x{}); only 2x2 Bayer is supported",
            cfa,
            cfa.width,
            cfa.height
        );
    }
    let (full_width, full_height) = (raw.width, raw.height);
    let n = full_width * full_height;
    let data = match raw.data {
        RawImageData::Integer(v) => RawData::U16(v),
        RawImageData::Float(v) => RawData::F32(v),
    };
    let len = match &data {
        RawData::U16(v) => v.len(),
        RawData::F32(v) => v.len(),
    };
    if len != n {
        bail!("raw data has {len} samples, expected {full_width}x{full_height}");
    }

    let crop = raw
        .crop_area
        .or(raw.active_area)
        .map(|r| Crop {
            x: r.p.x,
            y: r.p.y,
            width: r.d.w,
            height: r.d.h,
        })
        .filter(|c| {
            c.width >= 2
                && c.height >= 2
                && c.x + c.width <= full_width
                && c.y + c.height <= full_height
        })
        .unwrap_or(Crop {
            x: 0,
            y: 0,
            width: full_width,
            height: full_height,
        });

    let pattern = [
        [
            cfa.color_at(crop.y, crop.x) as u8,
            cfa.color_at(crop.y, crop.x + 1) as u8,
        ],
        [
            cfa.color_at(crop.y + 1, crop.x) as u8,
            cfa.color_at(crop.y + 1, crop.x + 1) as u8,
        ],
    ];
    if !is_bayer(&pattern) {
        bail!("unsupported CFA pattern {cfa} (only RGGB/BGGR/GRBG/GBRG)");
    }

    // Black: positional repeat pattern from the full-frame origin (rawler semantics).
    let bl = raw.blacklevel.as_vec();
    let (bw, bh) = (raw.blacklevel.width.max(1), raw.blacklevel.height.max(1));
    let black_at = |row: usize, col: usize| -> f32 {
        if bl.len() == bw * bh {
            bl[(row % bh) * bw + (col % bw)]
        } else {
            bl.first().copied().unwrap_or(0.0)
        }
    };
    let wl = raw.whitelevel.as_vec();
    let white_at = |row: usize, col: usize| -> f32 {
        if wl.len() == 4 {
            wl[(row % 2) * 2 + (col % 2)]
        } else {
            wl.first().copied().unwrap_or(65535.0)
        }
    };
    let mut black = [0.0_f32; 4];
    let mut white = [0.0_f32; 4];
    for dy in 0..2 {
        for dx in 0..2 {
            black[dy * 2 + dx] = black_at(crop.y + dy, crop.x + dx);
            white[dy * 2 + dx] = white_at(crop.y + dy, crop.x + dx);
            if white[dy * 2 + dx] <= black[dy * 2 + dx] {
                bail!(
                    "white level {} is not above black level {}",
                    white[dy * 2 + dx],
                    black[dy * 2 + dx]
                );
            }
        }
    }

    let wb = raw.wb_coeffs;
    if wb[..3].iter().any(|x| !x.is_finite() || *x <= 0.0) {
        bail!("as-shot white balance missing or invalid: {wb:?}");
    }

    let (orientation, orientation_source) = match Orientation::from_rawler(raw.orientation) {
        Some(o) if o != Orientation::Normal => (o, "decoder"),
        _ => match exif_orientation.and_then(Orientation::from_exif) {
            Some(o) => (o, "exif"),
            None => (Orientation::Normal, "default"),
        },
    };

    // rawler's `bps` is the container depth for some formats (16 for DC-S5 RW2); the effective
    // depth follows from the white level (16380 → 14 bits).
    let bits_per_sample = match &data {
        RawData::U16(_) => {
            let max_white = wl.iter().copied().fold(0.0_f32, f32::max).max(1.0);
            ((max_white as f64 + 1.0).log2().ceil() as u32).clamp(1, 16)
        }
        RawData::F32(_) => raw.bps as u32,
    };

    let mut rawler_color_matrices: Vec<(String, Vec<f64>)> = raw
        .color_matrix
        .iter()
        .map(|(k, v)| (format!("{k:?}"), v.iter().map(|&x| x as f64).collect()))
        .collect();
    rawler_color_matrices.sort_by(|a, b| a.0.cmp(&b.0));

    Ok(CameraRaw {
        make: raw.make.clone(),
        model: raw.model.clone(),
        clean_make: raw.clean_make.clone(),
        clean_model: raw.clean_model.clone(),
        full_width,
        full_height,
        crop,
        pattern,
        black,
        white,
        black_reported: bl.iter().map(|&x| x as f64).collect(),
        white_reported: wl.iter().map(|&x| x as f64).collect(),
        wb_coeffs: wb,
        orientation,
        orientation_source,
        bits_per_sample,
        iso,
        baseline_exposure,
        baseline_exposure_source,
        rawler_color_matrices,
        data,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn bayer_patterns() {
        assert!(is_bayer(&[[0, 1], [1, 2]])); // RGGB
        assert!(is_bayer(&[[2, 1], [1, 0]])); // BGGR
        assert!(is_bayer(&[[1, 0], [2, 1]])); // GRBG
        assert!(is_bayer(&[[1, 2], [0, 1]])); // GBRG
        assert!(!is_bayer(&[[0, 1], [2, 1]])); // R G / B G (not Bayer)
        assert!(!is_bayer(&[[0, 0], [1, 2]]));
    }

    #[test]
    fn extended_low_iso_pulls_only_below_the_base_iso_of_known_cameras() {
        assert_eq!(
            extended_low_iso_ev("Sony", "ZV-E10M2", Some(50.0)),
            Some(-1.0)
        );
        assert_eq!(
            extended_low_iso_ev("sony", "ILME-FX30", Some(50.0)),
            Some(-1.0)
        );
        assert_eq!(extended_low_iso_ev("Sony", "ZV-E10M2", Some(100.0)), None);
        assert_eq!(extended_low_iso_ev("Sony", "ZV-E10M2", Some(2000.0)), None);
        assert_eq!(extended_low_iso_ev("Sony", "ZV-E10M2", None), None);
        assert_eq!(extended_low_iso_ev("Panasonic", "DC-S5", Some(50.0)), None);
    }

    #[test]
    fn baseline_exposure_prefers_raw_sub_ifd_over_preview_ifd() {
        let mut bytes = vec![0u8; 80];
        bytes[0..2].copy_from_slice(b"II");
        bytes[2..4].copy_from_slice(&tiff::MAGIC_TIFF.to_le_bytes());
        bytes[4..8].copy_from_slice(&8u32.to_le_bytes());
        bytes[8..10].copy_from_slice(&1u16.to_le_bytes());
        bytes[10..12].copy_from_slice(&330u16.to_le_bytes());
        bytes[12..14].copy_from_slice(&tiff::TYPE_LONG.to_le_bytes());
        bytes[14..18].copy_from_slice(&1u32.to_le_bytes());
        bytes[18..22].copy_from_slice(&26u32.to_le_bytes());
        bytes[22..26].copy_from_slice(&0u32.to_le_bytes());
        bytes[26..28].copy_from_slice(&2u16.to_le_bytes());
        bytes[28..30].copy_from_slice(&262u16.to_le_bytes());
        bytes[30..32].copy_from_slice(&tiff::TYPE_SHORT.to_le_bytes());
        bytes[32..36].copy_from_slice(&1u32.to_le_bytes());
        bytes[36..38].copy_from_slice(&32803u16.to_le_bytes());
        bytes[40..42].copy_from_slice(&tag::BASELINE_EXPOSURE.to_le_bytes());
        bytes[42..44].copy_from_slice(&tiff::TYPE_SRATIONAL.to_le_bytes());
        bytes[44..48].copy_from_slice(&1u32.to_le_bytes());
        bytes[48..52].copy_from_slice(&56u32.to_le_bytes());
        bytes[52..56].copy_from_slice(&0u32.to_le_bytes());
        bytes[56..60].copy_from_slice(&(-1i32).to_le_bytes());
        bytes[60..64].copy_from_slice(&4i32.to_le_bytes());
        assert_eq!(dng_raw_metadata(&bytes).baseline_exposure, Some(-0.25));
    }

    #[test]
    fn extended_low_iso_fallback_is_disabled_for_dng_without_baseline_exposure() {
        let mut dng = vec![0u8; 26];
        dng[0..2].copy_from_slice(b"II");
        dng[2..4].copy_from_slice(&tiff::MAGIC_TIFF.to_le_bytes());
        dng[4..8].copy_from_slice(&8u32.to_le_bytes());
        dng[8..10].copy_from_slice(&1u16.to_le_bytes());
        dng[10..12].copy_from_slice(&tag::DNG_VERSION.to_le_bytes());
        dng[12..14].copy_from_slice(&tiff::TYPE_BYTE.to_le_bytes());
        dng[14..18].copy_from_slice(&4u32.to_le_bytes());
        dng[18..22].copy_from_slice(&[1, 4, 0, 0]);

        assert_eq!(
            raw_baseline_exposure(&dng, "Sony", "ZV-E10M2", Some(50.0)),
            (None, None)
        );

        let non_dng = tiff::write_single_ifd_le(tiff::MAGIC_TIFF, &[]).unwrap();
        assert_eq!(
            raw_baseline_exposure(&non_dng, "Sony", "ZV-E10M2", Some(50.0)),
            (Some(-1.0), Some("extended-low-iso"))
        );
    }
}
