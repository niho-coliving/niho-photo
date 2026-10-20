//! LUT-based ICC profiles (an RGB profile whose device -> PCS conversion is
//! an A2B table instead of matrix/TRC tags): lutAtoBType (`mAB `), lut16Type
//! (`mft2`) and lut8Type (`mft1`), evaluated stage by stage (ICC.1:2022
//! 10.10–10.12) on the tables moxcms parses. The stages that act on one
//! channel become tables over the decoder's sample values, so a pixel costs
//! three lookups, one trilinear CLUT interpolation and the output curves.
//!
//! moxcms' own transform would sample the whole conversion into a 33^3
//! grid of encoded input (mean ΔE00 0.13 against Core Image on a Display P3
//! lutAtoB, against 0.03 here) and brings its CMYK / gray executors into the
//! wasm (+250 KB), so only its parser is used.

use crate::decode::{trc_from, Trc};
use moxcms::{ColorProfile, LutDataType, LutMultidimensionalType, LutStore, LutWarehouse};

/// Samples of a curve applied after the CLUT (linear interpolation between).
const CURVE_SAMPLES: usize = 4096;

/// PCS white (D50) of ICC XYZ / Lab.
const PCS_WHITE: [f32; 3] = [0.9642, 1.0, 0.8249];

#[derive(Debug, Clone, Copy, PartialEq)]
enum Pcs {
    Xyz,
    XyzLut8,
    /// v4 encoding (lutAtoB, lut8): L* 0..100 and a*, b* -128..127 over 0..1.
    Lab,
    /// lut16Type's legacy encoding: 0xFF00 is L* 100, 0x8000 is a* 0.
    LabLegacy,
}

/// One channel's curve, sampled over 0..1 and read back with linear
/// interpolation; `None` = identity.
#[derive(Debug, Clone)]
struct Curve(Option<Vec<f32>>);

impl Curve {
    fn identity() -> Self {
        Curve(None)
    }

    fn from_trc(trc: &Trc) -> Self {
        Curve(Some(
            (0..CURVE_SAMPLES)
                .map(|i| trc.eval(i as f64 / (CURVE_SAMPLES - 1) as f64) as f32)
                .collect(),
        ))
    }

    fn from_table(table: Vec<f32>) -> Self {
        Curve(Some(table))
    }

    #[inline]
    fn apply(&self, v: f32) -> f32 {
        let Some(t) = &self.0 else {
            return v.clamp(0.0, 1.0);
        };
        let pos = v.clamp(0.0, 1.0) * (t.len() - 1) as f32;
        let i = (pos as usize).min(t.len() - 2);
        let f = pos - i as f32;
        t[i] + (t[i + 1] - t[i]) * f
    }
}

/// A 3-input, 3-output CLUT; values normalized to 0..1.
#[derive(Debug, Clone)]
struct Clut {
    grid: [usize; 3],
    values: Vec<f32>,
}

impl Clut {
    fn new(grid: [usize; 3], store: &LutStore) -> Result<Self, String> {
        if grid.iter().any(|&g| g < 2) {
            return Err(format!("CLUT grid {grid:?}"));
        }
        let values = normalized(store);
        if values.len() != grid[0] * grid[1] * grid[2] * 3 {
            return Err(format!(
                "CLUT has {} values for grid {grid:?}",
                values.len()
            ));
        }
        Ok(Clut { grid, values })
    }

    /// Trilinear interpolation (the first input channel varies slowest), as
    /// ColorSync evaluates it: on a coarse Lab CLUT, tetrahedral left a
    /// ΔE00 5.5 difference to Core Image where trilinear leaves 0.27.
    #[inline]
    fn eval(&self, c: [f32; 3]) -> [f32; 3] {
        let [g0, g1, g2] = self.grid;
        let pos = |v: f32, g: usize| {
            let p = v.clamp(0.0, 1.0) * (g - 1) as f32;
            let i = (p as usize).min(g - 2);
            (i, p - i as f32)
        };
        let (i0, f0) = pos(c[0], g0);
        let (i1, f1) = pos(c[1], g1);
        let (i2, f2) = pos(c[2], g2);
        let (s0, s1, s2) = (g1 * g2 * 3, g2 * 3, 3);
        let base = i0 * s0 + i1 * s1 + i2 * s2;
        let v = |offset: usize, k: usize| self.values[base + offset + k];
        let lerp = |a: f32, b: f32, f: f32| a + (b - a) * f;
        [0, 1, 2].map(|k| {
            let c00 = lerp(v(0, k), v(s0, k), f0);
            let c01 = lerp(v(s2, k), v(s0 + s2, k), f0);
            let c10 = lerp(v(s1, k), v(s0 + s1, k), f0);
            let c11 = lerp(v(s1 + s2, k), v(s0 + s1 + s2, k), f0);
            lerp(lerp(c00, c10, f1), lerp(c01, c11, f1), f2)
        })
    }
}

fn normalized(store: &LutStore) -> Vec<f32> {
    match store {
        LutStore::Store8(v) => v.iter().map(|&x| x as f32 / 255.0).collect(),
        LutStore::Store16(v) => v.iter().map(|&x| x as f32 / 65535.0).collect(),
    }
}

/// Channel `k` of a lut8 / lut16 table stored channel after channel.
fn table_channel(store: &LutStore, entries: usize, k: usize) -> Result<Vec<f32>, String> {
    let values = normalized(store);
    if entries < 2 || values.len() != entries * 3 {
        return Err(format!(
            "table has {} values for {entries} entries",
            values.len()
        ));
    }
    Ok(values[k * entries..(k + 1) * entries].to_vec())
}

fn curves(list: &[moxcms::ToneReprCurve]) -> Result<[Curve; 3], String> {
    if list.is_empty() {
        return Ok([Curve::identity(), Curve::identity(), Curve::identity()]);
    }
    if list.len() != 3 {
        return Err(format!("{} curves", list.len()));
    }
    let one = |c: &moxcms::ToneReprCurve| {
        let trc = trc_from(&Some(c.clone())).ok_or("unreadable curve")?;
        Ok::<_, String>(Curve::from_trc(&trc))
    };
    Ok([one(&list[0])?, one(&list[1])?, one(&list[2])?])
}

/// Device RGB -> PCS XYZ (D50) of a LUT-based RGB profile.
#[derive(Debug, Clone)]
pub struct LutProfile {
    /// Per channel, before the CLUT (A curves / input tables).
    input: [Curve; 3],
    clut: Option<Clut>,
    /// lutAtoB M curves, then `matrix` (3x3 + offset); `None` = absent.
    m: Option<([Curve; 3], [[f32; 4]; 3])>,
    /// B curves / output tables.
    output: [Curve; 3],
    pcs: Pcs,
}

impl LutProfile {
    /// The A2B table Core Image uses: perceptual (A2B0), else colorimetric
    /// (A2B1), else saturation (A2B2).
    pub fn new(profile: &ColorProfile) -> Result<Self, String> {
        let table = profile
            .lut_a_to_b_perceptual
            .as_ref()
            .or(profile.lut_a_to_b_colorimetric.as_ref())
            .or(profile.lut_a_to_b_saturation.as_ref())
            .ok_or("no A2B table")?;
        let lab = match profile.pcs {
            moxcms::DataColorSpace::Xyz => false,
            moxcms::DataColorSpace::Lab => true,
            other => return Err(format!("PCS {other:?}")),
        };
        match table {
            LutWarehouse::Multidimensional(mab) => {
                Self::from_mab(mab, if lab { Pcs::Lab } else { Pcs::Xyz })
            }
            LutWarehouse::Lut(lut) => {
                let pcs = match (lab, lut.lut_type) {
                    (false, moxcms::LutType::Lut8) => Pcs::XyzLut8,
                    (false, _) => Pcs::Xyz,
                    (true, moxcms::LutType::Lut16) => Pcs::LabLegacy,
                    (true, _) => Pcs::Lab,
                };
                Self::from_lut(lut, pcs)
            }
        }
    }

    fn from_mab(mab: &LutMultidimensionalType, pcs: Pcs) -> Result<Self, String> {
        if mab.num_input_channels != 3 || mab.num_output_channels != 3 {
            return Err(format!(
                "lutAtoB {}->{} channels",
                mab.num_input_channels, mab.num_output_channels
            ));
        }
        let clut = match &mab.clut {
            Some(store) => {
                let g = mab.grid_points;
                Some(Clut::new(
                    [g[0] as usize, g[1] as usize, g[2] as usize],
                    store,
                )?)
            }
            None => None,
        };
        let m = if mab.m_curves.is_empty() {
            None
        } else {
            let (t, b) = (mab.matrix.v, mab.bias.v);
            let row = |i: usize| [t[i][0] as f32, t[i][1] as f32, t[i][2] as f32, b[i] as f32];
            Some((curves(&mab.m_curves)?, [row(0), row(1), row(2)]))
        };
        Ok(LutProfile {
            input: curves(&mab.a_curves)?,
            clut,
            m,
            output: curves(&mab.b_curves)?,
            pcs,
        })
    }

    fn from_lut(lut: &LutDataType, pcs: Pcs) -> Result<Self, String> {
        if lut.num_input_channels != 3 || lut.num_output_channels != 3 {
            return Err(format!(
                "lut {}->{} channels",
                lut.num_input_channels, lut.num_output_channels
            ));
        }
        // The lut8 / lut16 matrix applies only to XYZ input, not to RGB.
        let (inputs, outputs) = (
            lut.num_input_table_entries as usize,
            lut.num_output_table_entries as usize,
        );
        let table = |store, entries, k| table_channel(store, entries, k).map(Curve::from_table);
        let g = lut.num_clut_grid_points as usize;
        Ok(LutProfile {
            input: [
                table(&lut.input_table, inputs, 0)?,
                table(&lut.input_table, inputs, 1)?,
                table(&lut.input_table, inputs, 2)?,
            ],
            clut: Some(Clut::new([g, g, g], &lut.clut_table)?),
            m: None,
            output: [
                table(&lut.output_table, outputs, 0)?,
                table(&lut.output_table, outputs, 1)?,
                table(&lut.output_table, outputs, 2)?,
            ],
            pcs,
        })
    }

    /// Channel `k`'s input stage over the samples `0..=max`.
    pub fn input_table(&self, k: usize, max: u32) -> Vec<f32> {
        (0..=max)
            .map(|i| self.input[k].apply(i as f32 / max as f32))
            .collect()
    }

    /// The rest of the conversion from the input stage's output to PCS XYZ
    /// (D50, the PCS white has Y = 1).
    #[inline]
    pub fn to_xyz(&self, c: [f32; 3]) -> [f32; 3] {
        let mut v = match &self.clut {
            Some(clut) => clut.eval(c),
            None => c,
        };
        if let Some((m_curves, matrix)) = &self.m {
            let w = [0, 1, 2].map(|k| m_curves[k].apply(v[k]));
            v = matrix.map(|r| (r[0] * w[0] + r[1] * w[1] + r[2] * w[2] + r[3]).clamp(0.0, 1.0));
        }
        let v = [0, 1, 2].map(|k| self.output[k].apply(v[k]));
        match self.pcs {
            // lutAtoBType / lut16Type use u1Fixed15: 0..1 spans 0..65535/32768.
            Pcs::Xyz => v.map(|x| x * (65535.0 / 32768.0)),
            // lut8Type uses 8-bit u1Fixed7: 0x80 (128) is exactly 1.0.
            Pcs::XyzLut8 => v.map(|x| x * (255.0 / 128.0)),
            Pcs::Lab => lab_to_xyz([v[0] * 100.0, v[1] * 255.0 - 128.0, v[2] * 255.0 - 128.0]),
            Pcs::LabLegacy => lab_to_xyz([
                v[0] * (65535.0 / 65280.0) * 100.0,
                v[1] * (65535.0 / 256.0) - 128.0,
                v[2] * (65535.0 / 256.0) - 128.0,
            ]),
        }
    }
}

fn lab_to_xyz([l, a, b]: [f32; 3]) -> [f32; 3] {
    let fy = (l + 16.0) / 116.0;
    let f = [fy + a / 500.0, fy, fy - b / 200.0];
    let inv = |t: f32| {
        if t > 6.0 / 29.0 {
            t * t * t
        } else {
            3.0 * (6.0f32 / 29.0).powi(2) * (t - 4.0 / 29.0)
        }
    };
    [0, 1, 2].map(|k| PCS_WHITE[k] * inv(f[k]))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn trilinear_interpolation_is_exact_on_a_linear_clut() {
        // v = (0.2 r + 0.3 g + 0.5 b, r, b) on a 3-point grid.
        let mut values = Vec::new();
        for r in 0..3 {
            for g in 0..3 {
                for b in 0..3 {
                    let (r, g, b) = (r as f32 / 2.0, g as f32 / 2.0, b as f32 / 2.0);
                    values.extend([0.2 * r + 0.3 * g + 0.5 * b, r, b]);
                }
            }
        }
        let store = LutStore::Store16(
            values
                .iter()
                .map(|v| (v * 65535.0).round() as u16)
                .collect(),
        );
        let clut = Clut::new([3, 3, 3], &store).unwrap();
        for c in [
            [0.1, 0.7, 0.4],
            [0.9, 0.2, 0.6],
            [0.5, 0.5, 0.5],
            [0.3, 0.8, 0.95],
        ] {
            let v = clut.eval(c);
            let want = [0.2 * c[0] + 0.3 * c[1] + 0.5 * c[2], c[0], c[2]];
            for k in 0..3 {
                assert!((v[k] - want[k]).abs() < 1e-4, "{c:?}: {v:?} vs {want:?}");
            }
        }
    }

    #[test]
    fn lab_encodings_decode_to_the_pcs_white() {
        let white = lab_to_xyz([100.0, 0.0, 0.0]);
        for k in 0..3 {
            assert!((white[k] - PCS_WHITE[k]).abs() < 1e-5);
        }
    }

    #[test]
    fn lut8_xyz_uses_eight_bit_fixed_point_scaling() {
        use moxcms::{LutDataType, LutStore, LutType, LutWarehouse};

        let mut profile = moxcms::ColorProfile::new_srgb();
        profile.profile_class = moxcms::ProfileClass::InputDevice;
        profile.pcs = moxcms::DataColorSpace::Xyz;
        profile.lut_a_to_b_perceptual = Some(LutWarehouse::Lut(LutDataType {
            num_input_channels: 3,
            num_output_channels: 3,
            num_clut_grid_points: 2,
            matrix: moxcms::Matrix3d::IDENTITY,
            num_input_table_entries: 2,
            num_output_table_entries: 2,
            input_table: LutStore::Store8([0, 255].repeat(3)),
            clut_table: LutStore::Store8(vec![128; 2 * 2 * 2 * 3]),
            output_table: LutStore::Store8([0, 255].repeat(3)),
            lut_type: LutType::Lut8,
        }));

        let lut = LutProfile::new(&profile).unwrap();
        let xyz = lut.to_xyz([0.5; 3]);
        for channel in xyz {
            assert!((channel - 1.0).abs() < 1e-6, "{xyz:?}");
        }
    }
}
