//! Color math for stage 1: white points, Bradford adaptation, CCT (Robertson 1968), HSV, the DCP
//! HueSatMap, and the DNG 1.6 camera → XYZ(D50) mapping ("Mapping Camera Color Space to CIE XYZ
//! Space", DNG spec 1.6.0.0 ch. 6). Implemented from the specification text; no DNG SDK code.

use anyhow::{anyhow, bail, Context, Result};

use crate::matrix::{self, Mat3, Vec3};

/// Borrowed color fields of a camera profile. DCP parsing and profile metadata are kept out of
/// this crate so the same transform can run without a RAW decoder.
pub struct ProfileInput<'a> {
    pub illuminant1: u16,
    pub color_matrix1: &'a [f64],
    pub illuminant2: Option<u16>,
    pub color_matrix2: Option<&'a [f64]>,
    pub forward_matrix1: Option<&'a [f64]>,
    pub forward_matrix2: Option<&'a [f64]>,
    pub hue_sat_map: Option<HueSatMapInput<'a>>,
}

/// Borrowed DCP hue/saturation table values in DNG order.
pub struct HueSatMapInput<'a> {
    pub hue_divisions: u32,
    pub sat_divisions: u32,
    pub val_divisions: u32,
    pub encoding: u32,
    pub data1: &'a [[f64; 3]],
    pub data2: Option<&'a [[f64; 3]]>,
}

/// Convert DCP f64 table values to the f32 representation used during rendering.
pub fn table_from_data(
    h: u32,
    s: u32,
    v: u32,
    encoding: u32,
    data: &[[f64; 3]],
) -> Result<HueSatMap> {
    let data32 = data
        .iter()
        .map(|e| [e[0] as f32, e[1] as f32, e[2] as f32])
        .collect();
    HueSatMap::new(h as usize, s as usize, v as usize, encoding, data32)
}

impl HueSatMapInput<'_> {
    pub fn table1(&self) -> Result<HueSatMap> {
        table_from_data(
            self.hue_divisions,
            self.sat_divisions,
            self.val_divisions,
            self.encoding,
            self.data1,
        )
        .context("hueSatMap.data1")
    }

    pub fn table2(&self) -> Result<Option<HueSatMap>> {
        self.data2
            .map(|data| {
                table_from_data(
                    self.hue_divisions,
                    self.sat_divisions,
                    self.val_divisions,
                    self.encoding,
                    data,
                )
                .context("hueSatMap.data2")
            })
            .transpose()
    }
}

/// XYZ(D50) → linear ProPhoto (ROMM) RGB. Bruce Lindbloom, ProPhoto RGB / D50 (contract §2.1).
pub const XYZ_D50_TO_PROPHOTO: Mat3 = [
    [1.3459433, -0.2556075, -0.0511118],
    [-0.5445989, 1.5081673, 0.0205351],
    [0.0000000, 0.0000000, 1.2118128],
];
/// Linear ProPhoto (ROMM) RGB → XYZ(D50) (contract §2.1).
pub const PROPHOTO_TO_XYZ_D50: Mat3 = [
    [0.7976749, 0.1351917, 0.0313534],
    [0.2880402, 0.7118741, 0.0000857],
    [0.0000000, 0.0000000, 0.8252100],
];
/// D50 white, Y = 1 (contract §2.1).
pub const D50_XYZ: Vec3 = [0.96422, 1.00000, 0.82521];
/// D65 white, Y = 1.
pub const D65_XYZ: Vec3 = [0.95047, 1.00000, 1.08883];
/// Bradford cone response matrix (Lam 1985).
pub const BRADFORD: Mat3 = [
    [0.8951, 0.2664, -0.1614],
    [-0.7502, 1.7135, 0.0367],
    [0.0389, -0.0685, 1.0296],
];

/// Name of the fixed CCT method, written to the sidecar (`whiteBalance.cctMethod`).
pub const CCT_METHOD: &str = "robertson1968";

/// Linear Bradford chromatic adaptation from `src` white to `dst` white (both XYZ).
pub fn bradford(src: &Vec3, dst: &Vec3) -> Mat3 {
    let s = matrix::mul_vec(&BRADFORD, src);
    let d = matrix::mul_vec(&BRADFORD, dst);
    let gain = matrix::diag(&[d[0] / s[0], d[1] / s[1], d[2] / s[2]]);
    let inv = matrix::inverse(&BRADFORD).expect("Bradford matrix is invertible");
    matrix::mul(&inv, &matrix::mul(&gain, &BRADFORD))
}

pub fn xyz_to_xy(xyz: &Vec3) -> [f64; 2] {
    let sum = xyz[0] + xyz[1] + xyz[2];
    if !sum.is_finite() || sum <= 0.0 {
        return xyz_to_xy(&D50_XYZ);
    }
    [xyz[0] / sum, xyz[1] / sum]
}

/// xy → XYZ with Y = 1.
pub fn xy_to_xyz(xy: &[f64; 2]) -> Vec3 {
    let [x, y] = *xy;
    if y <= 0.0 {
        return D50_XYZ;
    }
    [x / y, 1.0, (1.0 - x - y) / y]
}

/// CIE 1960 UCS (u, v).
pub fn xy_to_uv1960(xy: &[f64; 2]) -> [f64; 2] {
    let [x, y] = *xy;
    let d = -2.0 * x + 12.0 * y + 3.0;
    [4.0 * x / d, 6.0 * y / d]
}

/// Shared DNG temperature / Robertson isotherms. Both absolute-white generation and two-set DCP
/// interpolation use this table so a white cannot be assigned different temperatures by the
/// forward and inverse paths. Columns: reciprocal temperature (mired), u, v (CIE 1960), slope t.
const ROBERTSON_1968: [[f64; 4]; 31] = [
    [0.0, 0.18006, 0.26352, -0.24341],
    [10.0, 0.18066, 0.26589, -0.25479],
    [20.0, 0.18133, 0.26846, -0.26876],
    [30.0, 0.18208, 0.27119, -0.28539],
    [40.0, 0.18293, 0.27407, -0.30470],
    [50.0, 0.18388, 0.27709, -0.32675],
    [60.0, 0.18494, 0.28021, -0.35156],
    [70.0, 0.18611, 0.28342, -0.37915],
    [80.0, 0.18740, 0.28668, -0.40955],
    [90.0, 0.18880, 0.28997, -0.44278],
    [100.0, 0.19032, 0.29326, -0.47888],
    [125.0, 0.19462, 0.30141, -0.58204],
    [150.0, 0.19962, 0.30921, -0.70471],
    [175.0, 0.20525, 0.31647, -0.84901],
    [200.0, 0.21142, 0.32312, -1.0182],
    [225.0, 0.21807, 0.32909, -1.2168],
    [250.0, 0.22511, 0.33439, -1.4512],
    [275.0, 0.23247, 0.33904, -1.7298],
    [300.0, 0.24010, 0.34308, -2.0637],
    [325.0, 0.24702, 0.34655, -2.4681],
    [350.0, 0.25591, 0.34951, -2.9641],
    [375.0, 0.26400, 0.35200, -3.5814],
    [400.0, 0.27218, 0.35407, -4.3633],
    [425.0, 0.28039, 0.35577, -5.3762],
    [450.0, 0.28863, 0.35714, -6.7262],
    [475.0, 0.29685, 0.35823, -8.5955],
    [500.0, 0.30505, 0.35907, -11.324],
    [525.0, 0.31320, 0.35968, -15.628],
    [550.0, 0.32129, 0.36011, -23.325],
    [575.0, 0.32931, 0.36038, -40.770],
    [600.0, 0.33724, 0.36051, -116.45],
];

/// Lowest / highest reciprocal temperature reported (mired). 10 mired = 100 000 K, 600 = 1667 K.
const MIRED_MIN: f64 = 10.0;
const MIRED_MAX: f64 = 600.0;
const TINT_SCALE: f64 = -3000.0;

/// DNG `kTempTable` forward mapping from absolute Kelvin / tint to CIE xy.
/// Temperatures below 2000 K follow the existing DevelopSettings clamp.
pub fn xy_from_temperature(temperature: f64, tint: f64) -> [f64; 2] {
    let clamped = temperature.max(2000.0);
    let r = 1.0e6 / clamped;
    let offset = tint * (1.0 / TINT_SCALE);
    let n = ROBERTSON_1968.len();
    for index in 0..(n - 1) {
        if !(r < ROBERTSON_1968[index + 1][0] || index == n - 2) {
            continue;
        }
        let a = ROBERTSON_1968[index];
        let b = ROBERTSON_1968[index + 1];
        let f = (b[0] - r) / (b[0] - a[0]);
        let mut u = a[1] * f + b[1] * (1.0 - f);
        let mut v = a[2] * f + b[2] * (1.0 - f);
        let len1 = libm::sqrt(1.0 + a[3] * a[3]);
        let len2 = libm::sqrt(1.0 + b[3] * b[3]);
        let (uu1, vv1) = (1.0 / len1, a[3] / len1);
        let (uu2, vv2) = (1.0 / len2, b[3] / len2);
        let mut uu3 = uu1 * f + uu2 * (1.0 - f);
        let mut vv3 = vv1 * f + vv2 * (1.0 - f);
        let len3 = libm::sqrt(uu3 * uu3 + vv3 * vv3);
        uu3 /= len3;
        vv3 /= len3;
        u += uu3 * offset;
        v += vv3 * offset;
        let d = u - 4.0 * v + 2.0;
        return [1.5 * u / d, v / d];
    }
    let sum = D50_XYZ[0] + D50_XYZ[1] + D50_XYZ[2];
    [D50_XYZ[0] / sum, D50_XYZ[1] / sum]
}

/// Correlated color temperature (K) and Duv (CIE 1960 uv distance from the Planckian locus,
/// positive above the locus = greenish) of a chromaticity, by Robertson's method.
/// The CCT is clamped to 1667 K … 100 000 K.
pub fn cct_duv(xy: &[f64; 2]) -> (f64, f64) {
    let [u, v] = xy_to_uv1960(xy);
    let line = |i: usize| -> (f64, f64, f64, f64, f64) {
        let [m, ui, vi, ti] = ROBERTSON_1968[i];
        let len = (1.0 + ti * ti).sqrt();
        // Signed distance from (u, v) to isotemperature line i.
        let d = ((v - vi) - ti * (u - ui)) / len;
        (m, ui, vi, ti, d)
    };
    let (mut m_prev, mut u_prev, mut v_prev, mut t_prev, mut d_prev) = line(0);
    let mut found: Option<(f64, [f64; 2], [f64; 2])> = None;
    for i in 1..ROBERTSON_1968.len() {
        let (m, ui, vi, ti, d) = line(i);
        let crossed = (d_prev >= 0.0 && d < 0.0) || (d_prev > 0.0 && d <= 0.0);
        if crossed {
            let f = d_prev / (d_prev - d);
            let mired = m_prev + f * (m - m_prev);
            let locus = [u_prev + f * (ui - u_prev), v_prev + f * (vi - v_prev)];
            // Direction of the isotemperature line, interpolated.
            let (a_len, b_len) = ((1.0 + t_prev * t_prev).sqrt(), (1.0 + ti * ti).sqrt());
            let dir = [
                (1.0 - f) / a_len + f / b_len,
                (1.0 - f) * t_prev / a_len + f * ti / b_len,
            ];
            found = Some((mired, locus, dir));
            break;
        }
        (m_prev, u_prev, v_prev, t_prev, d_prev) = (m, ui, vi, ti, d);
    }
    let (mired, locus, dir) = match found {
        Some(hit) => hit,
        None => {
            // Outside the table: colder than 1667 K (all d > 0 … never flips) or hotter than ∞.
            let idx = if line(0).4 < 0.0 {
                0
            } else {
                ROBERTSON_1968.len() - 1
            };
            let (m, ui, vi, ti, _) = line(idx);
            let len = (1.0 + ti * ti).sqrt();
            (m, [ui, vi], [1.0 / len, ti / len])
        }
    };
    let mired = mired.clamp(MIRED_MIN, MIRED_MAX);
    let norm = (dir[0] * dir[0] + dir[1] * dir[1]).sqrt();
    let dir = [dir[0] / norm, dir[1] / norm];
    // dir points toward +u / −v (t < 0); "above the locus" is the opposite side.
    let duv = -((u - locus[0]) * dir[0] + (v - locus[1]) * dir[1]);
    (1.0e6 / mired, duv)
}

/// Nominal CCT (K) of an EXIF LightSource / DNG CalibrationIlluminant code, for the DNG two-set
/// interpolation. `None` for unknown / other.
pub fn illuminant_cct(code: u16) -> Option<f64> {
    Some(match code {
        1 => 5500.0,  // Daylight
        2 => 4150.0,  // Fluorescent (cool white)
        3 => 2856.0,  // Tungsten (incandescent) ≈ Standard A
        4 => 5500.0,  // Flash
        9 => 5500.0,  // Fine weather
        10 => 6500.0, // Cloudy weather
        11 => 7500.0, // Shade
        12 => 6400.0, // Daylight fluorescent (D 5700 – 7100 K)
        13 => 5000.0, // Day white fluorescent (N 4600 – 5500 K)
        14 => 4150.0, // Cool white fluorescent (W 3800 – 4500 K)
        15 => 3450.0, // White fluorescent (WW 3250 – 3800 K)
        16 => 2925.0, // Warm white fluorescent (L 2600 – 3250 K)
        17 => 2856.0, // Standard light A
        18 => 4874.0, // Standard light B
        19 => 6774.0, // Standard light C
        20 => 5503.0, // D55
        21 => 6504.0, // D65
        22 => 7504.0, // D75
        23 => 5003.0, // D50
        24 => 3200.0, // ISO studio tungsten
        _ => return None,
    })
}

/// Weight of calibration set 1 for white temperature `t` (DNG: linear in 1/T between the two
/// calibration illuminants, the closest set outside).
pub fn interpolation_weight(t: f64, t1: f64, t2: f64) -> f64 {
    if (t1 - t2).abs() < 1e-9 {
        return 1.0;
    }
    let (lo, hi, lo_is_set1) = if t1 < t2 {
        (t1, t2, true)
    } else {
        (t2, t1, false)
    };
    let w_lo = if t <= lo {
        1.0
    } else if t >= hi {
        0.0
    } else {
        (1.0 / t - 1.0 / hi) / (1.0 / lo - 1.0 / hi)
    };
    if lo_is_set1 {
        w_lo
    } else {
        1.0 - w_lo
    }
}

/// RGB (≥ 0) → HSV with h in [0, 6), s in [0, 1], v = max(r, g, b).
#[inline]
pub fn rgb_to_hsv(r: f32, g: f32, b: f32) -> (f32, f32, f32) {
    let v = r.max(g).max(b);
    let mn = r.min(g).min(b);
    let gap = v - mn;
    if v <= 0.0 || gap <= 0.0 {
        return (0.0, 0.0, v.max(0.0));
    }
    let s = gap / v;
    let mut h = if r == v {
        (g - b) / gap
    } else if g == v {
        2.0 + (b - r) / gap
    } else {
        4.0 + (r - g) / gap
    };
    if h < 0.0 {
        h += 6.0;
    }
    if h >= 6.0 {
        h -= 6.0;
    }
    (h, s, v)
}

/// HSV (h in [0, 6)) → RGB.
#[inline]
pub fn hsv_to_rgb(h: f32, s: f32, v: f32) -> [f32; 3] {
    if s <= 0.0 {
        return [v, v, v];
    }
    let mut h = h - 6.0 * (h / 6.0).floor();
    if h >= 6.0 {
        h = 0.0;
    }
    let i = h.floor();
    let f = h - i;
    let p = v * (1.0 - s);
    let q = v * (1.0 - s * f);
    let t = v * (1.0 - s * (1.0 - f));
    match i as u32 {
        0 => [v, t, p],
        1 => [q, v, p],
        2 => [p, v, t],
        3 => [p, q, v],
        4 => [t, p, v],
        _ => [v, p, q],
    }
}

/// sRGB transfer (encode), extended past 1.0 with the same formula.
#[inline]
pub fn srgb_encode(x: f32) -> f32 {
    if x <= 0.003_130_8 {
        12.92 * x
    } else {
        1.055 * x.powf(1.0 / 2.4) - 0.055
    }
}

/// Inverse of [`srgb_encode`].
#[inline]
pub fn srgb_decode(y: f32) -> f32 {
    if y <= 0.040_45 {
        y / 12.92
    } else {
        ((y + 0.055) / 1.055).powf(2.4)
    }
}

/// A DCP ProfileHueSatMap resolved for one image (already interpolated between the two sets).
#[derive(Clone, Debug, PartialEq)]
pub struct HueSatMap {
    pub hue_divisions: usize,
    pub sat_divisions: usize,
    pub val_divisions: usize,
    /// ProfileHueSatMapEncoding: 0 = linear, 1 = sRGB (only used when `val_divisions > 1`).
    pub encoding: u32,
    /// `[hueShiftDeg, satScale, valScale]`, index `((v × hueDiv) + h) × satDiv + s` (DNG order:
    /// value outermost, then hue, saturation innermost).
    pub data: Vec<[f32; 3]>,
}

impl HueSatMap {
    pub fn new(
        hue: usize,
        sat: usize,
        val: usize,
        encoding: u32,
        data: Vec<[f32; 3]>,
    ) -> Result<Self> {
        if hue < 1 || sat < 2 || val < 1 {
            bail!("HueSatMap divisions must be hue>=1, sat>=2, val>=1 (got {hue},{sat},{val})");
        }
        let expected = hue
            .checked_mul(sat)
            .and_then(|n| n.checked_mul(val))
            .ok_or_else(|| anyhow!("HueSatMap dimensions overflow"))?;
        if data.len() != expected {
            bail!(
                "HueSatMap has {} entries, expected {}",
                data.len(),
                expected
            );
        }
        if encoding > 1 {
            bail!("HueSatMap encoding must be 0 or 1 (got {encoding})");
        }
        if data.iter().flatten().any(|x| !x.is_finite()) {
            bail!("HueSatMap contains a non-finite value");
        }
        Ok(Self {
            hue_divisions: hue,
            sat_divisions: sat,
            val_divisions: val,
            encoding,
            data,
        })
    }

    pub fn identity(hue: usize, sat: usize, val: usize) -> Self {
        Self {
            hue_divisions: hue,
            sat_divisions: sat,
            val_divisions: val,
            encoding: 0,
            data: vec![[0.0, 1.0, 1.0]; hue * sat * val],
        }
    }

    /// `w * a + (1 - w) * b`, entry by entry (DNG: same weights as the color matrices).
    pub fn blend(a: &Self, b: &Self, w: f64) -> Result<Self> {
        if (a.hue_divisions, a.sat_divisions, a.val_divisions)
            != (b.hue_divisions, b.sat_divisions, b.val_divisions)
        {
            bail!("HueSatMap tables 1 and 2 have different dimensions");
        }
        let w = w as f32;
        let data = a
            .data
            .iter()
            .zip(&b.data)
            .map(|(x, y)| {
                [
                    w * x[0] + (1.0 - w) * y[0],
                    w * x[1] + (1.0 - w) * y[1],
                    w * x[2] + (1.0 - w) * y[2],
                ]
            })
            .collect();
        Ok(Self { data, ..a.clone() })
    }

    #[inline]
    fn entry(&self, v: usize, h: usize, s: usize) -> [f32; 3] {
        self.data[(v * self.hue_divisions + h) * self.sat_divisions + s]
    }

    /// Table lookup: (hueShiftDeg, satScale, valScale) at HSV (h in [0, 6)). Hue wraps around,
    /// saturation and value are clamped to the table; a dimension with one division is constant.
    #[inline]
    pub fn lookup(&self, h: f32, s: f32, v: f32) -> [f32; 3] {
        let hd = self.hue_divisions;
        let hf = h * (hd as f32 / 6.0);
        let hfl = hf.floor();
        let fh = hf - hfl;
        let h0 = (hfl as isize).rem_euclid(hd as isize) as usize;
        let h1 = if h0 + 1 >= hd { 0 } else { h0 + 1 };

        let sd = self.sat_divisions;
        let sf = s.clamp(0.0, 1.0) * (sd - 1) as f32;
        let s0 = (sf.floor() as usize).min(sd - 2);
        let fs = sf - s0 as f32;

        let (v0, v1, fv) = if self.val_divisions == 1 {
            (0, 0, 0.0)
        } else {
            let vd = self.val_divisions;
            let vin = if self.encoding == 1 {
                srgb_encode(v)
            } else {
                v
            };
            let vf = vin.clamp(0.0, 1.0) * (vd - 1) as f32;
            let v0 = (vf.floor() as usize).min(vd - 2);
            (v0, v0 + 1, vf - v0 as f32)
        };

        let mut out = [0.0_f32; 3];
        let corners = [
            (v0, h0, s0, (1.0 - fv) * (1.0 - fh) * (1.0 - fs)),
            (v0, h1, s0, (1.0 - fv) * fh * (1.0 - fs)),
            (v0, h0, s0 + 1, (1.0 - fv) * (1.0 - fh) * fs),
            (v0, h1, s0 + 1, (1.0 - fv) * fh * fs),
            (v1, h0, s0, fv * (1.0 - fh) * (1.0 - fs)),
            (v1, h1, s0, fv * fh * (1.0 - fs)),
            (v1, h0, s0 + 1, fv * (1.0 - fh) * fs),
            (v1, h1, s0 + 1, fv * fh * fs),
        ];
        let n = if self.val_divisions == 1 { 4 } else { 8 };
        for &(vv, hh, ss, w) in &corners[..n] {
            let e = self.entry(vv, hh, ss);
            out[0] += w * e[0];
            out[1] += w * e[1];
            out[2] += w * e[2];
        }
        out
    }

    /// Apply to one linear ProPhoto pixel (components ≥ 0), contract §2.5 step 7:
    /// `h' = h + hueShift`, `s' = min(s × satScale, 1)`, `v' = v × valScale` (not clipped: stage 1
    /// is scene-referred; with the sRGB encoding and a 3-D table, valScale applies to the encoded v).
    #[inline]
    pub fn apply(&self, rgb: [f32; 3]) -> [f32; 3] {
        let (h, s, v) = rgb_to_hsv(rgb[0], rgb[1], rgb[2]);
        if v <= 0.0 {
            return [0.0; 3];
        }
        let [hue_shift, sat_scale, val_scale] = self.lookup(h, s, v);
        let h2 = h + hue_shift * (6.0 / 360.0);
        let s2 = (s * sat_scale).clamp(0.0, 1.0);
        let v2 = if self.encoding == 1 && self.val_divisions > 1 {
            srgb_decode(srgb_encode(v) * val_scale)
        } else {
            v * val_scale
        };
        hsv_to_rgb(h2, s2, v2.max(0.0))
    }
}

/// The per-image color transform resolved from a DCP and the as-shot neutral.
#[derive(Clone, Debug)]
pub struct ProfileColor {
    /// White-balanced camera RGB → XYZ(D50).
    pub camera_to_xyz_d50: Mat3,
    /// White-balanced camera RGB → linear ProPhoto RGB.
    pub camera_to_prophoto: Mat3,
    pub hue_sat_map: Option<HueSatMap>,
    /// Chromaticity of the camera neutral (via the ColorMatrix, DNG "camera neutral → xy").
    pub white_xy: [f64; 2],
    pub cct: f64,
    pub duv: f64,
    /// Weight of calibration set 1 (1.0 for single-illuminant profiles).
    pub weight1: f64,
    pub uses_forward_matrix: bool,
}

/// Camera RGB neutral for a requested scene white, before white balance is applied.
///
/// This is the inverse of the ColorMatrix part of [`resolve_profile_color`]: convert the
/// requested xy to XYZ (Y = 1), choose the DNG calibration set at that white's CCT, then
/// multiply by ColorMatrix and normalize the largest camera channel to 1. The profile is
/// DCP-only, so AnalogBalance and CameraCalibration are identity here as in the render path.
pub fn camera_neutral_for_xy(spec: &ProfileInput<'_>, xy: [f64; 2]) -> Result<Vec3> {
    if xy.iter().any(|v| !v.is_finite()) || xy[0] <= 0.0 || xy[1] <= 0.0 || xy[0] + xy[1] >= 1.0 {
        bail!("requested white xy is outside the CIE chromaticity triangle");
    }
    let cm1 = matrix::from_row_major(spec.color_matrix1)
        .ok_or_else(|| anyhow!("ColorMatrix1 must have 9 finite values"))?;
    let cm = match (spec.illuminant2, spec.color_matrix2) {
        (Some(il2), Some(values2)) => {
            let cm2 = matrix::from_row_major(values2)
                .ok_or_else(|| anyhow!("ColorMatrix2 must have 9 finite values"))?;
            match (illuminant_cct(spec.illuminant1), illuminant_cct(il2)) {
                (Some(t1), Some(t2)) => {
                    matrix::blend(&cm1, &cm2, interpolation_weight(cct_duv(&xy).0, t1, t2))
                }
                _ => cm1,
            }
        }
        _ => cm1,
    };
    if matrix::inverse(&cm).is_none() {
        bail!("ColorMatrix is singular at the requested white");
    }
    let camera = matrix::mul_vec(&cm, &xy_to_xyz(&xy));
    if camera.iter().any(|v| !v.is_finite() || *v <= 0.0) {
        bail!("requested white is outside the camera profile gamut");
    }
    let largest = camera.iter().copied().fold(0.0_f64, f64::max);
    let neutral = camera.map(|v| v / largest);
    if neutral
        .iter()
        .any(|v| !v.is_finite() || *v <= 0.0 || !(1.0 / *v as f32).is_finite())
    {
        bail!("requested white produces an unusable camera neutral");
    }
    // A strongly varying dual-illuminant matrix can have another fixed point. Reject a neutral
    // that our render-side inverse would interpret as a different white instead of silently
    // applying the wrong temperature.
    let recovered = resolve_profile_color(spec, &neutral)?.white_xy;
    if recovered
        .iter()
        .zip(xy)
        .any(|(actual, expected)| !actual.is_finite() || (actual - expected).abs() > 1e-6)
    {
        bail!("requested white is ambiguous for this camera profile");
    }
    Ok(neutral)
}

/// Resolve the DNG camera → XYZ(D50) mapping for one image.
///
/// `neutral` is the camera neutral `n_c = 1 / mul_c` (max component 1). AnalogBalance and
/// CameraCalibration are identity (DCP-only processing).
///
/// * ForwardMatrix present: `XYZ_D50 = FM · cam_wb` (FM1/FM2 interpolated by the white's CCT).
/// * ColorMatrix only: `XYZ_D50 = Bradford(W → D50) · inv(CM) · diag(n) · cam_wb / W_Y` with
///   `W = inv(CM) · n`, so the camera neutral maps to the D50 white with Y = 1 — the same
///   normalization the ForwardMatrix path has by definition (see README「色の数式」).
pub fn resolve_profile_color(spec: &ProfileInput<'_>, neutral: &Vec3) -> Result<ProfileColor> {
    if neutral.iter().any(|x| !x.is_finite() || *x <= 0.0) {
        bail!("camera neutral must be positive and finite: {neutral:?}");
    }
    let cm1 = matrix::from_row_major(spec.color_matrix1)
        .ok_or_else(|| anyhow!("ColorMatrix1 must have 9 finite values"))?;
    let set2 = match (spec.illuminant2, spec.color_matrix2.as_ref()) {
        (Some(il2), Some(cm2)) => {
            let cm2 = matrix::from_row_major(cm2)
                .ok_or_else(|| anyhow!("ColorMatrix2 must have 9 finite values"))?;
            match (illuminant_cct(spec.illuminant1), illuminant_cct(il2)) {
                (Some(t1), Some(t2)) => Some((cm2, t1, t2)),
                _ => None, // unknown illuminant temperatures: use set 1 only
            }
        }
        _ => None,
    };

    // Camera neutral → white xy (DNG: iterate when the matrices depend on the white).
    let cm_at = |w: f64| -> Mat3 {
        match &set2 {
            Some((cm2, _, _)) => matrix::blend(&cm1, cm2, w),
            None => cm1,
        }
    };
    let weight_at = |xy: &[f64; 2]| -> f64 {
        match &set2 {
            Some((_, t1, t2)) => interpolation_weight(cct_duv(xy).0, *t1, *t2),
            None => 1.0,
        }
    };
    let mut xy = xyz_to_xy(&D50_XYZ);
    for iter in 0..100 {
        let w = weight_at(&xy);
        let inv = matrix::inverse(&cm_at(w)).ok_or_else(|| anyhow!("ColorMatrix is singular"))?;
        let next = xyz_to_xy(&matrix::mul_vec(&inv, neutral));
        let delta = (next[0] - xy[0]).abs() + (next[1] - xy[1]).abs();
        xy = if iter >= 30 {
            [(xy[0] + next[0]) * 0.5, (xy[1] + next[1]) * 0.5]
        } else {
            next
        };
        if delta < 1e-12 {
            break;
        }
    }
    let weight1 = weight_at(&xy);
    let cm = cm_at(weight1);
    let inv_cm = matrix::inverse(&cm).ok_or_else(|| anyhow!("ColorMatrix is singular"))?;
    let white = matrix::mul_vec(&inv_cm, neutral);
    if !white[1].is_finite() || white[1] <= 0.0 {
        bail!(
            "camera neutral maps to a non-positive luminance (Y = {})",
            white[1]
        );
    }
    let white_xy = xyz_to_xy(&white);
    let (cct, duv) = cct_duv(&white_xy);

    let fm1 = match &spec.forward_matrix1 {
        Some(v) => Some(
            matrix::from_row_major(v)
                .ok_or_else(|| anyhow!("ForwardMatrix1 must have 9 finite values"))?,
        ),
        None => None,
    };
    let fm2 = match &spec.forward_matrix2 {
        Some(v) => Some(
            matrix::from_row_major(v)
                .ok_or_else(|| anyhow!("ForwardMatrix2 must have 9 finite values"))?,
        ),
        None => None,
    };
    let (camera_to_xyz_d50, uses_forward_matrix) = match (fm1, fm2) {
        (Some(f1), Some(f2)) if set2.is_some() => (matrix::blend(&f1, &f2, weight1), true),
        (Some(f1), _) => (f1, true),
        (None, _) => {
            let white_norm = [white[0] / white[1], 1.0, white[2] / white[1]];
            let ca = bradford(&white_norm, &D50_XYZ);
            let m = matrix::mul(&ca, &matrix::mul(&inv_cm, &matrix::diag(neutral)));
            (matrix::scale(&m, 1.0 / white[1]), false)
        }
    };
    let camera_to_prophoto = matrix::mul(&XYZ_D50_TO_PROPHOTO, &camera_to_xyz_d50);

    let hue_sat_map = match &spec.hue_sat_map {
        Some(hsm) => {
            let t1 = hsm.table1()?;
            match (hsm.table2()?, &set2) {
                (Some(t2), Some(_)) => Some(HueSatMap::blend(&t1, &t2, weight1)?),
                _ => Some(t1),
            }
        }
        None => None,
    };

    Ok(ProfileColor {
        camera_to_xyz_d50,
        camera_to_prophoto,
        hue_sat_map,
        white_xy,
        cct,
        duv,
        weight1,
        uses_forward_matrix,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn robertson_known_illuminants() {
        let d65 = xyz_to_xy(&D65_XYZ);
        let (t, duv) = cct_duv(&d65);
        assert!((t - 6504.0).abs() < 5.0, "D65 CCT {t}");
        assert!((duv - 0.0032).abs() < 3e-4, "D65 Duv {duv}");
        let (t50, _) = cct_duv(&xyz_to_xy(&D50_XYZ));
        assert!((t50 - 5003.0).abs() < 5.0, "D50 CCT {t50}");
        // Standard A lies on the locus.
        let (ta, duva) = cct_duv(&[0.44757, 0.40745]);
        assert!((ta - 2856.0).abs() < 15.0, "A CCT {ta}");
        assert!(duva.abs() < 3e-4, "A Duv {duva}");
    }

    #[test]
    fn dng_temperature_and_cct_share_the_325_mired_isotherm() {
        let temperature = 1.0e6 / 325.0;
        let xy = xy_from_temperature(temperature, 0.0);
        let (cct, duv) = cct_duv(&xy);
        assert!(
            (cct - temperature).abs() < 1.0,
            "CCT {cct} vs {temperature}"
        );
        assert!(duv.abs() < 1e-6, "Duv {duv}");
    }

    #[test]
    fn weight_is_linear_in_mired() {
        assert_eq!(interpolation_weight(2000.0, 2856.0, 6504.0), 1.0);
        assert_eq!(interpolation_weight(9000.0, 2856.0, 6504.0), 0.0);
        let mid = 2.0 / (1.0 / 2856.0 + 1.0 / 6504.0);
        assert!((interpolation_weight(mid, 2856.0, 6504.0) - 0.5).abs() < 1e-12);
        // Order of the sets does not matter.
        assert!((interpolation_weight(mid, 6504.0, 2856.0) - 0.5).abs() < 1e-12);
        assert_eq!(interpolation_weight(2000.0, 6504.0, 2856.0), 0.0);
    }

    #[test]
    fn borrowed_profile_resolves_without_binary_dcp_or_raw_decoder() {
        let cm = [1.0, 0.0, 0.0, 0.0, 1.0, 0.0, 0.0, 0.0, 1.0];
        let profile = ProfileInput {
            illuminant1: 23,
            color_matrix1: &cm,
            illuminant2: None,
            color_matrix2: None,
            forward_matrix1: None,
            forward_matrix2: None,
            hue_sat_map: None,
        };
        let result = resolve_profile_color(&profile, &D50_XYZ).unwrap();
        let white = matrix::mul_vec(&result.camera_to_xyz_d50, &[1.0; 3]);
        for (actual, expected) in white.into_iter().zip(D50_XYZ) {
            assert!((actual - expected).abs() < 1e-9);
        }
        assert!(!result.uses_forward_matrix);
        assert!(result.hue_sat_map.is_none());
    }

    #[test]
    fn requested_white_neutral_roundtrips_through_single_and_dual_illuminant_profiles() {
        let cm1 = [0.98, 0.0, 0.0, 0.0, 1.0, 0.0, 0.0, 0.0, 1.02];
        let cm2 = [1.02, 0.0, 0.0, 0.0, 1.0, 0.0, 0.0, 0.0, 0.98];
        let mut profile = ProfileInput {
            illuminant1: 17,
            color_matrix1: &cm1,
            illuminant2: None,
            color_matrix2: None,
            forward_matrix1: None,
            forward_matrix2: None,
            hue_sat_map: None,
        };
        for xy in [[0.44757, 0.40745], xyz_to_xy(&D50_XYZ)] {
            let neutral = camera_neutral_for_xy(&profile, xy).unwrap();
            let recovered = resolve_profile_color(&profile, &neutral).unwrap().white_xy;
            assert!(
                (recovered[0] - xy[0]).abs() < 1e-8,
                "{recovered:?} vs {xy:?}"
            );
            assert!(
                (recovered[1] - xy[1]).abs() < 1e-8,
                "{recovered:?} vs {xy:?}"
            );
        }

        profile.illuminant2 = Some(21);
        profile.color_matrix2 = Some(&cm2);
        let tungsten = camera_neutral_for_xy(&profile, [0.44757, 0.40745]).unwrap();
        let daylight_xy = xyz_to_xy(&D65_XYZ);
        let daylight = camera_neutral_for_xy(&profile, daylight_xy).unwrap();
        assert_ne!(tungsten, daylight);
        for (xy, neutral) in [([0.44757, 0.40745], tungsten), (daylight_xy, daylight)] {
            let recovered = resolve_profile_color(&profile, &neutral).unwrap().white_xy;
            assert!(
                (recovered[0] - xy[0]).abs() < 1e-8,
                "{recovered:?} vs {xy:?}"
            );
            assert!(
                (recovered[1] - xy[1]).abs() < 1e-8,
                "{recovered:?} vs {xy:?}"
            );
        }
    }

    #[test]
    fn requested_white_rejects_invalid_xy_and_camera_matrix() {
        let cm = [1.0, 0.0, 0.0, 0.0, 1.0, 0.0, 0.0, 0.0, 1.0];
        let mut profile = ProfileInput {
            illuminant1: 23,
            color_matrix1: &cm,
            illuminant2: None,
            color_matrix2: None,
            forward_matrix1: None,
            forward_matrix2: None,
            hue_sat_map: None,
        };
        for xy in [[0.0, 0.3], [0.4, 0.0], [0.8, 0.3], [f64::NAN, 0.3]] {
            assert!(camera_neutral_for_xy(&profile, xy).is_err());
        }
        let negative = [-1.0, 0.0, 0.0, 0.0, 1.0, 0.0, 0.0, 0.0, 1.0];
        profile.color_matrix1 = &negative;
        assert!(camera_neutral_for_xy(&profile, xyz_to_xy(&D50_XYZ)).is_err());
        let singular = [1.0, 0.0, 0.0, 1.0, 0.0, 0.0, 0.0, 0.0, 1.0];
        profile.color_matrix1 = &singular;
        assert!(camera_neutral_for_xy(&profile, xyz_to_xy(&D50_XYZ)).is_err());

        let divergent1 = [0.8, 0.0, 0.0, 0.0, 1.0, 0.0, 0.0, 0.0, 1.1];
        let divergent2 = [1.1, 0.0, 0.0, 0.0, 1.0, 0.0, 0.0, 0.0, 0.8];
        profile.color_matrix1 = &divergent1;
        profile.illuminant1 = 17;
        profile.illuminant2 = Some(21);
        profile.color_matrix2 = Some(&divergent2);
        assert!(camera_neutral_for_xy(&profile, [0.44757, 0.40745]).is_err());
    }

    #[test]
    fn oversized_hue_sat_map_dimensions_are_rejected() {
        assert!(HueSatMap::new(usize::MAX, 2, 2, 0, Vec::new()).is_err());
    }
}
