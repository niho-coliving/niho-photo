//! DNG camera profiles (.dcp): the spec JSON (contract §2.4), a writer and a reader.
//!
//! File layout: little-endian TIFF, magic 0x4352 ("IIRC"), one IFD with the DNG camera-profile tags.
//! Tag numbers follow DNG 1.6.0.0 (and exiftool): ProfileCalibrationSignature is 0xC6F4,
//! ProfileHueSatMapEncoding 0xC7A3, ProfileLookTableEncoding 0xC7A4.

use std::path::Path;

use anyhow::{anyhow, bail, Context, Result};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

use crate::tiff::{self, Value};
use niho_camera_color::color::{HueSatMap, HueSatMapInput, ProfileInput};

pub const SPEC_SCHEMA: &str = "niho-base-raw.dcp-spec/1";
pub const NIHO_CALIBRATION_SIGNATURE: &str = "com.niho.develop-engine";

pub mod tag {
    /// DNG raw-file tag (not a profile tag); identifies DNG input files.
    pub const DNG_VERSION: u16 = 0xC612;
    pub const UNIQUE_CAMERA_MODEL: u16 = 0xC614;
    pub const COLOR_MATRIX1: u16 = 0xC621;
    pub const COLOR_MATRIX2: u16 = 0xC622;
    pub const CALIBRATION_ILLUMINANT1: u16 = 0xC65A;
    pub const CALIBRATION_ILLUMINANT2: u16 = 0xC65B;
    pub const PROFILE_CALIBRATION_SIGNATURE: u16 = 0xC6F4;
    pub const PROFILE_NAME: u16 = 0xC6F8;
    pub const PROFILE_HUE_SAT_MAP_DIMS: u16 = 0xC6F9;
    pub const PROFILE_HUE_SAT_MAP_DATA1: u16 = 0xC6FA;
    pub const PROFILE_HUE_SAT_MAP_DATA2: u16 = 0xC6FB;
    pub const PROFILE_TONE_CURVE: u16 = 0xC6FC;
    pub const PROFILE_EMBED_POLICY: u16 = 0xC6FD;
    pub const PROFILE_COPYRIGHT: u16 = 0xC6FE;
    pub const FORWARD_MATRIX1: u16 = 0xC714;
    pub const FORWARD_MATRIX2: u16 = 0xC715;
    pub const PROFILE_LOOK_TABLE_DIMS: u16 = 0xC725;
    pub const PROFILE_LOOK_TABLE_DATA: u16 = 0xC726;
    pub const PROFILE_HUE_SAT_MAP_ENCODING: u16 = 0xC7A3;
    pub const PROFILE_LOOK_TABLE_ENCODING: u16 = 0xC7A4;
    pub const BASELINE_EXPOSURE_OFFSET: u16 = 0xC7A5;
    pub const DEFAULT_BLACK_RENDER: u16 = 0xC7A6;
    /// DNG raw-file tag (not a profile tag); read from DNG input for `baselineEV`.
    pub const BASELINE_EXPOSURE: u16 = 0xC62A;
}

/// Contract §2.4 (`dcp make --spec` input == `dcp inspect --json` output).
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DcpSpec {
    pub schema: String,
    #[serde(default)]
    pub profile_name: String,
    #[serde(default)]
    pub unique_camera_model: String,
    #[serde(default)]
    pub copyright: String,
    #[serde(default)]
    pub embed_policy: u32,
    #[serde(default)]
    pub calibration_signature: String,
    pub illuminant1: u16,
    pub color_matrix1: Vec<f64>,
    #[serde(default)]
    pub illuminant2: Option<u16>,
    #[serde(default)]
    pub color_matrix2: Option<Vec<f64>>,
    #[serde(default)]
    pub forward_matrix1: Option<Vec<f64>>,
    #[serde(default)]
    pub forward_matrix2: Option<Vec<f64>>,
    #[serde(default)]
    pub hue_sat_map: Option<HueSatMapSpec>,
    #[serde(default)]
    pub baseline_exposure_offset: f64,
    #[serde(default)]
    pub default_black_render: u32,
    /// `[[x, y], ...]` (ProfileToneCurve). Carried, never applied in stage 1.
    #[serde(default)]
    pub tone_curve: Option<Vec<[f64; 2]>>,
    /// Addition to contract §2.4 so `inspect → make` is lossless for DCamProf profiles.
    /// Carried, never applied in stage 1.
    #[serde(default)]
    pub look_table: Option<LookTableSpec>,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct HueSatMapSpec {
    pub hue_divisions: u32,
    pub sat_divisions: u32,
    pub val_divisions: u32,
    #[serde(default)]
    pub encoding: u32,
    /// `[hueShiftDeg, satScale, valScale]` per entry, DNG order (value, hue, saturation innermost).
    pub data1: Vec<[f64; 3]>,
    #[serde(default)]
    pub data2: Option<Vec<[f64; 3]>>,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LookTableSpec {
    pub hue_divisions: u32,
    pub sat_divisions: u32,
    pub val_divisions: u32,
    #[serde(default)]
    pub encoding: u32,
    pub data: Vec<[f64; 3]>,
}

fn table_from(h: u32, s: u32, v: u32, encoding: u32, data: &[[f64; 3]]) -> Result<HueSatMap> {
    niho_camera_color::color::table_from_data(h, s, v, encoding, data)
}

impl HueSatMapSpec {
    pub fn table1(&self) -> Result<HueSatMap> {
        table_from(
            self.hue_divisions,
            self.sat_divisions,
            self.val_divisions,
            self.encoding,
            &self.data1,
        )
        .context("hueSatMap.data1")
    }

    pub fn table2(&self) -> Result<Option<HueSatMap>> {
        match &self.data2 {
            Some(d) => Ok(Some(
                table_from(
                    self.hue_divisions,
                    self.sat_divisions,
                    self.val_divisions,
                    self.encoding,
                    d,
                )
                .context("hueSatMap.data2")?,
            )),
            None => Ok(None),
        }
    }

    pub fn dims(&self) -> [u32; 3] {
        [self.hue_divisions, self.sat_divisions, self.val_divisions]
    }
}

fn check_matrix(name: &str, m: &[f64]) -> Result<()> {
    if m.len() != 9 {
        bail!("{name} must have 9 values (got {})", m.len());
    }
    if m.iter().any(|x| !x.is_finite() || x.abs() > 100_000.0) {
        bail!("{name} has a non-finite or out-of-range value");
    }
    Ok(())
}

impl DcpSpec {
    /// Borrow the fields used by the pure camera-color engine without copying profile tables.
    pub fn color_input(&self) -> ProfileInput<'_> {
        ProfileInput {
            illuminant1: self.illuminant1,
            color_matrix1: &self.color_matrix1,
            illuminant2: self.illuminant2,
            color_matrix2: self.color_matrix2.as_deref(),
            forward_matrix1: self.forward_matrix1.as_deref(),
            forward_matrix2: self.forward_matrix2.as_deref(),
            hue_sat_map: self.hue_sat_map.as_ref().map(|h| HueSatMapInput {
                hue_divisions: h.hue_divisions,
                sat_divisions: h.sat_divisions,
                val_divisions: h.val_divisions,
                encoding: h.encoding,
                data1: &h.data1,
                data2: h.data2.as_deref(),
            }),
        }
    }

    /// Structural checks before writing a DCP.
    pub fn validate(&self) -> Result<()> {
        if self.schema != SPEC_SCHEMA {
            bail!(
                "spec schema must be \"{SPEC_SCHEMA}\" (got \"{}\")",
                self.schema
            );
        }
        if self.unique_camera_model.trim().is_empty() {
            bail!("uniqueCameraModel is required");
        }
        if self.embed_policy > 3 {
            bail!("embedPolicy must be 0..=3");
        }
        check_matrix("colorMatrix1", &self.color_matrix1)?;
        match (&self.illuminant2, &self.color_matrix2) {
            (Some(_), Some(m)) => check_matrix("colorMatrix2", m)?,
            (None, None) => {}
            _ => bail!("illuminant2 and colorMatrix2 must be both set or both null"),
        }
        if let Some(m) = &self.forward_matrix1 {
            check_matrix("forwardMatrix1", m)?;
        }
        if let Some(m) = &self.forward_matrix2 {
            check_matrix("forwardMatrix2", m)?;
            if self.forward_matrix1.is_none() || self.illuminant2.is_none() {
                bail!("forwardMatrix2 needs forwardMatrix1 and illuminant2");
            }
        }
        if let Some(h) = &self.hue_sat_map {
            h.table1()?;
            if h.table2()?.is_some() && self.illuminant2.is_none() {
                bail!("hueSatMap.data2 needs illuminant2");
            }
        }
        if let Some(l) = &self.look_table {
            table_from(
                l.hue_divisions,
                l.sat_divisions,
                l.val_divisions,
                l.encoding,
                &l.data,
            )
            .context("lookTable")?;
        }
        if let Some(tc) = &self.tone_curve {
            if tc.len() < 2 || tc.iter().flatten().any(|x| !x.is_finite()) {
                bail!("toneCurve needs at least 2 finite points");
            }
        }
        if !self.baseline_exposure_offset.is_finite() || self.baseline_exposure_offset.abs() > 100.0
        {
            bail!("baselineExposureOffset out of range");
        }
        Ok(())
    }

    /// Serialize to DCP bytes (deterministic).
    pub fn to_dcp_bytes(&self) -> Result<Vec<u8>> {
        self.validate()?;
        let mut e: Vec<(u16, Value)> = Vec::new();
        e.push((
            tag::UNIQUE_CAMERA_MODEL,
            Value::Ascii(self.unique_camera_model.clone()),
        ));
        e.push((tag::COLOR_MATRIX1, srational9(&self.color_matrix1)));
        e.push((
            tag::CALIBRATION_ILLUMINANT1,
            Value::Short(vec![self.illuminant1]),
        ));
        if let (Some(il2), Some(cm2)) = (self.illuminant2, &self.color_matrix2) {
            e.push((tag::COLOR_MATRIX2, srational9(cm2)));
            e.push((tag::CALIBRATION_ILLUMINANT2, Value::Short(vec![il2])));
        }
        if !self.calibration_signature.is_empty() {
            e.push((
                tag::PROFILE_CALIBRATION_SIGNATURE,
                Value::Ascii(self.calibration_signature.clone()),
            ));
        }
        if !self.profile_name.is_empty() {
            e.push((tag::PROFILE_NAME, Value::Ascii(self.profile_name.clone())));
        }
        if let Some(h) = &self.hue_sat_map {
            e.push((
                tag::PROFILE_HUE_SAT_MAP_DIMS,
                Value::Long(h.dims().to_vec()),
            ));
            e.push((tag::PROFILE_HUE_SAT_MAP_DATA1, floats3(&h.data1)));
            if let Some(d2) = &h.data2 {
                e.push((tag::PROFILE_HUE_SAT_MAP_DATA2, floats3(d2)));
            }
            e.push((
                tag::PROFILE_HUE_SAT_MAP_ENCODING,
                Value::Long(vec![h.encoding]),
            ));
        }
        if let Some(tc) = &self.tone_curve {
            e.push((
                tag::PROFILE_TONE_CURVE,
                Value::Float(tc.iter().flat_map(|p| [p[0] as f32, p[1] as f32]).collect()),
            ));
        }
        e.push((
            tag::PROFILE_EMBED_POLICY,
            Value::Long(vec![self.embed_policy]),
        ));
        if !self.copyright.is_empty() {
            e.push((tag::PROFILE_COPYRIGHT, Value::Ascii(self.copyright.clone())));
        }
        if let Some(fm) = &self.forward_matrix1 {
            e.push((tag::FORWARD_MATRIX1, srational9(fm)));
        }
        if let Some(fm) = &self.forward_matrix2 {
            e.push((tag::FORWARD_MATRIX2, srational9(fm)));
        }
        if let Some(l) = &self.look_table {
            e.push((
                tag::PROFILE_LOOK_TABLE_DIMS,
                Value::Long(vec![l.hue_divisions, l.sat_divisions, l.val_divisions]),
            ));
            e.push((tag::PROFILE_LOOK_TABLE_DATA, floats3(&l.data)));
            e.push((
                tag::PROFILE_LOOK_TABLE_ENCODING,
                Value::Long(vec![l.encoding]),
            ));
        }
        e.push((
            tag::BASELINE_EXPOSURE_OFFSET,
            Value::SRational(vec![srational(self.baseline_exposure_offset)]),
        ));
        e.push((
            tag::DEFAULT_BLACK_RENDER,
            Value::Long(vec![self.default_black_render]),
        ));
        tiff::write_single_ifd_le(tiff::MAGIC_DCP, &e)
    }

    /// Parse DCP bytes. Also reads the profile tags of a DNG's IFD0. Unknown tags are ignored.
    // Keep Rust 1.85 compatibility; `as_chunks` is only stable since Rust 1.88.
    #[allow(clippy::chunks_exact_to_as_chunks)]
    pub fn from_dcp_bytes(bytes: &[u8]) -> Result<Self> {
        let ifd = tiff::read_first_ifd(bytes)?;
        if ifd.magic != tiff::MAGIC_DCP && ifd.magic != tiff::MAGIC_TIFF {
            bail!("not a DNG camera profile (TIFF magic 0x{:04X})", ifd.magic);
        }
        let color_matrix1 = ifd
            .numbers(tag::COLOR_MATRIX1)
            .ok_or_else(|| anyhow!("ColorMatrix1 (0xC621) missing"))?;
        check_matrix("ColorMatrix1", &color_matrix1)?;
        let illuminant1 = ifd
            .numbers(tag::CALIBRATION_ILLUMINANT1)
            .and_then(|v| v.first().copied())
            .unwrap_or(0.0) as u16;
        let (illuminant2, color_matrix2) = match ifd.numbers(tag::COLOR_MATRIX2) {
            Some(m) => {
                check_matrix("ColorMatrix2", &m)?;
                let il2 = ifd
                    .numbers(tag::CALIBRATION_ILLUMINANT2)
                    .and_then(|v| v.first().copied())
                    .unwrap_or(0.0) as u16;
                (Some(il2), Some(m))
            }
            None => (None, None),
        };
        let matrix = |t: u16, name: &str| -> Result<Option<Vec<f64>>> {
            match ifd.numbers(t) {
                Some(m) => {
                    check_matrix(name, &m)?;
                    Ok(Some(m))
                }
                None => Ok(None),
            }
        };
        let forward_matrix1 = matrix(tag::FORWARD_MATRIX1, "ForwardMatrix1")?;
        let forward_matrix2 = matrix(tag::FORWARD_MATRIX2, "ForwardMatrix2")?;

        let triples = |t: u16, expected: usize, name: &str| -> Result<Vec<[f64; 3]>> {
            let v = ifd.floats(t).ok_or_else(|| anyhow!("{name} missing"))?;
            let expected_values = expected
                .checked_mul(3)
                .ok_or_else(|| anyhow!("{name} dimensions overflow"))?;
            if v.len() != expected_values {
                bail!(
                    "{name} has {} values, expected {}",
                    v.len(),
                    expected_values
                );
            }
            Ok(v.chunks_exact(3)
                .map(|c| [clean_f32(c[0]), clean_f32(c[1]), clean_f32(c[2])])
                .collect())
        };
        let hue_sat_map = match ifd.numbers(tag::PROFILE_HUE_SAT_MAP_DIMS) {
            Some(d) if d.len() == 3 && ifd.has(tag::PROFILE_HUE_SAT_MAP_DATA1) => {
                let (h, s, v) = (d[0] as u32, d[1] as u32, d[2] as u32);
                let n = (h as usize)
                    .checked_mul(s as usize)
                    .and_then(|n| n.checked_mul(v as usize))
                    .ok_or_else(|| anyhow!("ProfileHueSatMapDims overflow"))?;
                let data1 = triples(tag::PROFILE_HUE_SAT_MAP_DATA1, n, "ProfileHueSatMapData1")?;
                let data2 = if ifd.has(tag::PROFILE_HUE_SAT_MAP_DATA2) {
                    Some(triples(
                        tag::PROFILE_HUE_SAT_MAP_DATA2,
                        n,
                        "ProfileHueSatMapData2",
                    )?)
                } else {
                    None
                };
                let encoding = ifd
                    .numbers(tag::PROFILE_HUE_SAT_MAP_ENCODING)
                    .and_then(|v| v.first().copied())
                    .unwrap_or(0.0) as u32;
                Some(HueSatMapSpec {
                    hue_divisions: h,
                    sat_divisions: s,
                    val_divisions: v,
                    encoding,
                    data1,
                    data2,
                })
            }
            _ => None,
        };
        let look_table = match ifd.numbers(tag::PROFILE_LOOK_TABLE_DIMS) {
            Some(d) if d.len() == 3 && ifd.has(tag::PROFILE_LOOK_TABLE_DATA) => {
                let (h, s, v) = (d[0] as u32, d[1] as u32, d[2] as u32);
                let n = (h as usize)
                    .checked_mul(s as usize)
                    .and_then(|n| n.checked_mul(v as usize))
                    .ok_or_else(|| anyhow!("ProfileLookTableDims overflow"))?;
                let data = triples(tag::PROFILE_LOOK_TABLE_DATA, n, "ProfileLookTableData")?;
                let encoding = ifd
                    .numbers(tag::PROFILE_LOOK_TABLE_ENCODING)
                    .and_then(|v| v.first().copied())
                    .unwrap_or(0.0) as u32;
                Some(LookTableSpec {
                    hue_divisions: h,
                    sat_divisions: s,
                    val_divisions: v,
                    encoding,
                    data,
                })
            }
            _ => None,
        };
        let tone_curve = ifd.floats(tag::PROFILE_TONE_CURVE).and_then(|v| {
            if v.len() >= 4 && v.len() % 2 == 0 {
                Some(
                    v.chunks_exact(2)
                        .map(|c| [clean_f32(c[0]), clean_f32(c[1])])
                        .collect(),
                )
            } else {
                None
            }
        });
        let first = |t: u16| ifd.numbers(t).and_then(|v| v.first().copied());
        Ok(DcpSpec {
            schema: SPEC_SCHEMA.to_string(),
            profile_name: ifd.string(tag::PROFILE_NAME).unwrap_or_default(),
            unique_camera_model: ifd.string(tag::UNIQUE_CAMERA_MODEL).unwrap_or_default(),
            copyright: ifd.string(tag::PROFILE_COPYRIGHT).unwrap_or_default(),
            embed_policy: first(tag::PROFILE_EMBED_POLICY).unwrap_or(0.0) as u32,
            calibration_signature: ifd
                .string(tag::PROFILE_CALIBRATION_SIGNATURE)
                .unwrap_or_default(),
            illuminant1,
            color_matrix1,
            illuminant2,
            color_matrix2,
            forward_matrix1,
            forward_matrix2,
            hue_sat_map,
            baseline_exposure_offset: first(tag::BASELINE_EXPOSURE_OFFSET).unwrap_or(0.0),
            default_black_render: first(tag::DEFAULT_BLACK_RENDER).unwrap_or(0.0) as u32,
            tone_curve,
            look_table,
        })
    }

    pub fn illuminants(&self) -> Vec<u16> {
        let mut v = vec![self.illuminant1];
        if let Some(il2) = self.illuminant2 {
            v.push(il2);
        }
        v
    }

    /// Pretty JSON as in contract §2.4, keys in contract order. `summary` leaves out the table
    /// data (`data1`, `data2`, look table `data`).
    pub fn to_json_string(&self, summary: bool) -> Result<String> {
        Ok(if summary {
            serde_json::to_string_pretty(&SpecSummary(self))?
        } else {
            serde_json::to_string_pretty(self)?
        })
    }
}

/// Table dimensions without the data (for `dcp inspect --summary`).
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct TableHeader {
    hue_divisions: u32,
    sat_divisions: u32,
    val_divisions: u32,
    encoding: u32,
}

/// [`DcpSpec`] serialized with the same keys and order, but table headers instead of tables.
struct SpecSummary<'a>(&'a DcpSpec);

impl Serialize for SpecSummary<'_> {
    fn serialize<S: serde::Serializer>(
        &self,
        serializer: S,
    ) -> std::result::Result<S::Ok, S::Error> {
        use serde::ser::SerializeStruct;
        let d = self.0;
        let hsm = d.hue_sat_map.as_ref().map(|h| TableHeader {
            hue_divisions: h.hue_divisions,
            sat_divisions: h.sat_divisions,
            val_divisions: h.val_divisions,
            encoding: h.encoding,
        });
        let lut = d.look_table.as_ref().map(|l| TableHeader {
            hue_divisions: l.hue_divisions,
            sat_divisions: l.sat_divisions,
            val_divisions: l.val_divisions,
            encoding: l.encoding,
        });
        let mut s = serializer.serialize_struct("DcpSpec", 17)?;
        s.serialize_field("schema", &d.schema)?;
        s.serialize_field("profileName", &d.profile_name)?;
        s.serialize_field("uniqueCameraModel", &d.unique_camera_model)?;
        s.serialize_field("copyright", &d.copyright)?;
        s.serialize_field("embedPolicy", &d.embed_policy)?;
        s.serialize_field("calibrationSignature", &d.calibration_signature)?;
        s.serialize_field("illuminant1", &d.illuminant1)?;
        s.serialize_field("colorMatrix1", &d.color_matrix1)?;
        s.serialize_field("illuminant2", &d.illuminant2)?;
        s.serialize_field("colorMatrix2", &d.color_matrix2)?;
        s.serialize_field("forwardMatrix1", &d.forward_matrix1)?;
        s.serialize_field("forwardMatrix2", &d.forward_matrix2)?;
        s.serialize_field("hueSatMap", &hsm)?;
        s.serialize_field("baselineExposureOffset", &d.baseline_exposure_offset)?;
        s.serialize_field("defaultBlackRender", &d.default_black_render)?;
        s.serialize_field("toneCurve", &d.tone_curve)?;
        s.serialize_field("lookTable", &lut)?;
        s.end()
    }
}

/// A DCP loaded from disk, with its identity.
#[derive(Clone, Debug)]
pub struct LoadedDcp {
    pub spec: DcpSpec,
    pub sha256: String,
}

pub fn load_dcp(path: &Path) -> Result<LoadedDcp> {
    let bytes =
        std::fs::read(path).with_context(|| format!("cannot read DCP {}", path.display()))?;
    load_dcp_bytes(&bytes).with_context(|| format!("cannot parse DCP {}", path.display()))
}

/// Parse caller-supplied DCP bytes and retain the SHA-256 of those exact bytes. Works in wasm.
pub fn load_dcp_bytes(bytes: &[u8]) -> Result<LoadedDcp> {
    Ok(LoadedDcp {
        spec: DcpSpec::from_dcp_bytes(bytes)?,
        sha256: sha256_hex(bytes),
    })
}

pub fn sha256_hex(bytes: &[u8]) -> String {
    let digest = Sha256::digest(bytes);
    digest.iter().map(|b| format!("{b:02x}")).collect()
}

/// Real → SRATIONAL in 1/10000 units (contract §2.4).
pub fn srational(v: f64) -> (i32, i32) {
    ((v * 10_000.0).round() as i32, 10_000)
}

fn srational9(m: &[f64]) -> Value {
    Value::SRational(m.iter().map(|&x| srational(x)).collect())
}

fn floats3(d: &[[f64; 3]]) -> Value {
    Value::Float(
        d.iter()
            .flat_map(|e| [e[0] as f32, e[1] as f32, e[2] as f32])
            .collect(),
    )
}

/// f32 → the shortest f64 that prints the same (so JSON shows 0.1, not 0.10000000149011612) and
/// converts back to the identical f32.
fn clean_f32(x: f32) -> f64 {
    format!("{x}").parse::<f64>().unwrap_or(x as f64)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn srational_rounding() {
        assert_eq!(srational(0.6250), (6250, 10000));
        assert_eq!(srational(-0.1250), (-1250, 10000));
        assert_eq!(srational(-0.00005), (-1, 10000));
    }
}
