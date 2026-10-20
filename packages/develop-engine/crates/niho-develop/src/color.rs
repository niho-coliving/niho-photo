//! Color-space constants and helpers shared by every stage.
//!
//! Matrices are the DNG SDK / Photo Bench values (`ColorSpec.swift`
//! `DNGColorSpace`): 4-decimal `ProPhoto -> XYZ(D50)` and `sRGB -> XYZ(D50)`,
//! with the working-space conversions derived from them exactly like Photo
//! Bench does (`srgbLinearToProPhoto = inverse(xyzD50ToSRGB * proPhotoToXYZD50)`).
//! Transcendental functions go through `libm` so native and wasm builds give
//! bit-identical results.

/// Row-major 3x3 matrix.
pub type Mat3 = [[f64; 3]; 3];

pub const IDENTITY: Mat3 = [[1.0, 0.0, 0.0], [0.0, 1.0, 0.0], [0.0, 0.0, 1.0]];

pub const fn mat_mul(a: &Mat3, b: &Mat3) -> Mat3 {
    let mut out = [[0.0; 3]; 3];
    let mut i = 0;
    while i < 3 {
        let mut j = 0;
        while j < 3 {
            out[i][j] = a[i][0] * b[0][j] + a[i][1] * b[1][j] + a[i][2] * b[2][j];
            j += 1;
        }
        i += 1;
    }
    out
}

/// Inverse by cofactors (the matrices here are all well conditioned).
pub const fn mat_inverse(m: &Mat3) -> Mat3 {
    let a = m[0][0];
    let b = m[0][1];
    let c = m[0][2];
    let d = m[1][0];
    let e = m[1][1];
    let f = m[1][2];
    let g = m[2][0];
    let h = m[2][1];
    let i = m[2][2];
    let co00 = e * i - f * h;
    let co01 = -(d * i - f * g);
    let co02 = d * h - e * g;
    let det = a * co00 + b * co01 + c * co02;
    let inv = 1.0 / det;
    [
        [co00 * inv, -(b * i - c * h) * inv, (b * f - c * e) * inv],
        [co01 * inv, (a * i - c * g) * inv, -(a * f - c * d) * inv],
        [co02 * inv, -(a * h - b * g) * inv, (a * e - b * d) * inv],
    ]
}

#[inline]
pub fn mat_vec(m: &Mat3, v: [f64; 3]) -> [f64; 3] {
    [
        m[0][0] * v[0] + m[0][1] * v[1] + m[0][2] * v[2],
        m[1][0] * v[0] + m[1][1] * v[1] + m[1][2] * v[2],
        m[2][0] * v[0] + m[2][1] * v[1] + m[2][2] * v[2],
    ]
}

/// Same as [`mat_vec`] in `f32` (the per-pixel working precision).
#[inline]
pub fn mat_vec_f32(m: &[[f32; 3]; 3], v: [f32; 3]) -> [f32; 3] {
    [
        m[0][0] * v[0] + m[0][1] * v[1] + m[0][2] * v[2],
        m[1][0] * v[0] + m[1][1] * v[1] + m[1][2] * v[2],
        m[2][0] * v[0] + m[2][1] * v[1] + m[2][2] * v[2],
    ]
}

pub const fn to_f32(m: &Mat3) -> [[f32; 3]; 3] {
    [
        [m[0][0] as f32, m[0][1] as f32, m[0][2] as f32],
        [m[1][0] as f32, m[1][1] as f32, m[1][2] as f32],
        [m[2][0] as f32, m[2][1] as f32, m[2][2] as f32],
    ]
}

/// `DNGColorSpace.proPhotoToXYZD50`.
pub const PROPHOTO_TO_XYZ_D50: Mat3 = [
    [0.7977, 0.1352, 0.0313],
    [0.2880, 0.7119, 0.0001],
    [0.0000, 0.0000, 0.8249],
];
pub const XYZ_D50_TO_PROPHOTO: Mat3 = mat_inverse(&PROPHOTO_TO_XYZ_D50);

/// `DNGColorSpace.srgbToXYZD50`.
pub const SRGB_TO_XYZ_D50: Mat3 = [
    [0.4361, 0.3851, 0.1431],
    [0.2225, 0.7169, 0.0606],
    [0.0139, 0.0971, 0.7141],
];
pub const XYZ_D50_TO_SRGB: Mat3 = mat_inverse(&SRGB_TO_XYZ_D50);

/// `DNGColorSpace.proPhotoToSRGBLinear`.
pub const PROPHOTO_TO_SRGB: Mat3 = mat_mul(&XYZ_D50_TO_SRGB, &PROPHOTO_TO_XYZ_D50);
/// `DNGColorSpace.srgbLinearToProPhoto`.
pub const SRGB_TO_PROPHOTO: Mat3 = mat_inverse(&PROPHOTO_TO_SRGB);

pub const PROPHOTO_TO_SRGB_F32: [[f32; 3]; 3] = to_f32(&PROPHOTO_TO_SRGB);
pub const SRGB_TO_PROPHOTO_F32: [[f32; 3]; 3] = to_f32(&SRGB_TO_PROPHOTO);

/// ProPhoto (D50) relative luminance weights (`PP_LUMA` in every Photo Bench
/// reference model).
pub const PP_LUMA: [f64; 3] = [0.2880402, 0.7118741, 0.0000857];
pub const PP_LUMA_F32: [f32; 3] = [0.2880402, 0.7118741, 0.0000857];

/// Rec.709 luma (non-RAW adaptive statistics read the plain sRGB input).
pub const REC709_LUMA_F32: [f32; 3] = [0.2126, 0.7152, 0.0722];

/// `dng_function_GammaEncode_sRGB`: standard sRGB OETF, not clamped above 1
/// (negative input encodes as 0 on the power branch, like Photo Bench).
#[inline]
pub fn srgb_encode(x: f64) -> f64 {
    if x <= 0.0031308 {
        x * 12.92
    } else {
        1.055 * libm::pow(x.max(0.0), 1.0 / 2.4) - 0.055
    }
}

/// Inverse of [`srgb_encode`], clipped to `[0, 1]` first (Photo Bench's
/// `DNGColorSpace.srgbDecode`).
#[inline]
pub fn srgb_decode(y: f64) -> f64 {
    let c = y.clamp(0.0, 1.0);
    if c <= 0.0031308 * 12.92 {
        c / 12.92
    } else {
        libm::pow((c + 0.055) / 1.055, 2.4)
    }
}

/// [`srgb_encode`] for `x` in `[0, 1]` through a table (x^(1/2.4) by the
/// `f32` bit pattern, ~1e-7 relative): the cube bakes call it hundreds of
/// thousands of times.
#[inline]
pub fn srgb_encode_fast(x: f64) -> f64 {
    if x <= 0.0031308 {
        x * 12.92
    } else if x >= 1.0 {
        1.055 * libm::pow(x, 1.0 / 2.4) - 0.055
    } else {
        1.055 * crate::fastmath::srgb_encode_power().eval(x as f32) as f64 - 0.055
    }
}

/// [`srgb_decode`] through a 8192-interval table on `[0.04045, 1]`
/// (linear interpolation, error ~1e-8).
#[inline]
pub fn srgb_decode_fast(y: f64) -> f64 {
    let c = y.clamp(0.0, 1.0);
    if c <= 0.0031308 * 12.92 {
        return c / 12.92;
    }
    crate::fastmath::srgb_decode_table().eval(c)
}

/// Plain IEC 61966-2-1 EOTF for decoding 8/16-bit sRGB samples in `[0, 1]`.
#[inline]
pub fn srgb_eotf(v: f64) -> f64 {
    if v <= 0.04045 {
        v / 12.92
    } else {
        libm::pow((v + 0.055) / 1.055, 2.4)
    }
}

/// `f32` sRGB OETF for the final 8-bit encode (input already clamped).
#[inline]
pub fn srgb_oetf_f32(x: f32) -> f32 {
    if x <= 0.003_130_8 {
        x * 12.92
    } else {
        1.055 * libm::powf(x, 1.0 / 2.4) - 0.055
    }
}

/// Chromaticity (CIE 1931 xy).
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct Xy {
    pub x: f64,
    pub y: f64,
}

pub const D50_XY: Xy = Xy {
    x: 0.3457,
    y: 0.3585,
};

/// `DNGTemperature.xy(fromTemperature:tint:)` (`dng_temperature.cpp`
/// `LegacyGetXY`). Temperatures below 2000K are clamped to 2000K.
pub fn xy_from_temperature(temperature: f64, tint: f64) -> Xy {
    let [x, y] = niho_camera_color::color::xy_from_temperature(temperature, tint);
    Xy { x, y }
}

/// `dng_color_spec.cpp` `XYtoXYZ` (Y = 1) with the same clamping.
pub fn xy_to_xyz(xy: Xy) -> [f64; 3] {
    let mut x = xy.x.clamp(1e-6, 0.999999);
    let mut y = xy.y.clamp(1e-6, 0.999999);
    if x + y > 0.999999 {
        let scale = 0.999999 / (x + y);
        x *= scale;
        y *= scale;
    }
    [x / y, 1.0, (1.0 - x - y) / y]
}

/// Bradford cone response matrix.
const BRADFORD: Mat3 = [
    [0.8951, 0.2664, -0.1614],
    [-0.7502, 1.7135, 0.0367],
    [0.0389, -0.0685, 1.0296],
];
const BRADFORD_INV: Mat3 = mat_inverse(&BRADFORD);

/// Bradford chromatic adaptation in XYZ from white `from` to white `to`.
pub fn bradford_xyz(from: Xy, to: Xy) -> Mat3 {
    let s = mat_vec(&BRADFORD, xy_to_xyz(from));
    let d = mat_vec(&BRADFORD, xy_to_xyz(to));
    let diag = [
        [d[0] / s[0], 0.0, 0.0],
        [0.0, d[1] / s[1], 0.0],
        [0.0, 0.0, d[2] / s[2]],
    ];
    mat_mul(&BRADFORD_INV, &mat_mul(&diag, &BRADFORD))
}

/// RAW absolute white balance on a working copy rendered at the as-shot white
/// (spec: "段 2 では撮影時の白から目標の白への色順応（linear ProPhoto の
/// CAT）で近似"). A neutral under `target` becomes ProPhoto white: the
/// working copy already mapped `as_shot` to D50, so the composition is
/// `CAT(as_shot -> target)^-1` expressed in linear ProPhoto.
pub fn raw_white_balance_prophoto(as_shot: Xy, target: Xy) -> Mat3 {
    // XYZ_scene = CAT(D50 -> as_shot) * XYZ_ws; XYZ_new = CAT(target -> D50) * XYZ_scene.
    let to_scene = bradford_xyz(D50_XY, as_shot);
    let to_new = bradford_xyz(target, D50_XY);
    let xyz = mat_mul(&to_new, &to_scene);
    mat_mul(&XYZ_D50_TO_PROPHOTO, &mat_mul(&xyz, &PROPHOTO_TO_XYZ_D50))
}

/// Linear sRGB -> OKLab (Björn Ottosson), `f32` exactly like Photo Bench's
/// `photoBenchGamutCompression` kernel (same literals, rounded to `f32` by the
/// compiler just like the Metal kernel compiler does).
#[inline]
#[allow(clippy::excessive_precision)]
pub fn linear_srgb_to_oklab(rgb: [f32; 3]) -> [f32; 3] {
    let l = 0.4122214708 * rgb[0] + 0.5363325363 * rgb[1] + 0.0514459929 * rgb[2];
    let m = 0.2119034982 * rgb[0] + 0.6806995451 * rgb[1] + 0.1073969566 * rgb[2];
    let s = 0.0883024619 * rgb[0] + 0.2817188376 * rgb[1] + 0.6299787005 * rgb[2];
    let l_ = signed_cbrt(l);
    let m_ = signed_cbrt(m);
    let s_ = signed_cbrt(s);
    [
        0.2104542553 * l_ + 0.7936177850 * m_ - 0.0040720468 * s_,
        1.9779984951 * l_ - 2.4285922050 * m_ + 0.4505937099 * s_,
        0.0259040371 * l_ + 0.7827717662 * m_ - 0.8086757660 * s_,
    ]
}

#[inline]
fn signed_cbrt(v: f32) -> f32 {
    // `sign(v) * pow(abs(v), 1/3)` in the kernel.
    let a = v.abs();
    let magnitude = if a >= 1.0 {
        libm::powf(a, 0.333_333_34)
    } else {
        crate::fastmath::cube_root().eval(a)
    };
    if v < 0.0 {
        -magnitude
    } else if v > 0.0 {
        magnitude
    } else {
        0.0
    }
}

/// OKLab -> linear sRGB (`oklabToLinearSRGB` in the kernel).
#[inline]
#[allow(clippy::excessive_precision)]
pub fn oklab_to_linear_srgb(lab: [f32; 3]) -> [f32; 3] {
    let l_ =
        0.9999999984505196 * lab[0] + 0.3963377921737678 * lab[1] + 0.21580375806075877 * lab[2];
    let m_ =
        1.0000000088817607 * lab[0] - 0.10556134232365633 * lab[1] - 0.0638541747717059 * lab[2];
    let s_ =
        1.0000000546724108 * lab[0] - 0.08948418209496574 * lab[1] - 1.2914855378640917 * lab[2];
    let l = l_ * l_ * l_;
    let m = m_ * m_ * m_;
    let s = s_ * s_ * s_;
    [
        4.076741661347994 * l - 3.3077115904081933 * m + 0.23096992872942793 * s,
        -1.2684380040921763 * l + 2.6097574006633715 * m - 0.3413193963102196 * s,
        -0.00419608654183707 * l - 0.7034186144594495 * m + 1.7076147009309446 * s,
    ]
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn prophoto_round_trip_is_identity() {
        let m = mat_mul(&SRGB_TO_PROPHOTO, &PROPHOTO_TO_SRGB);
        for (i, row) in m.iter().enumerate() {
            for (j, value) in row.iter().enumerate() {
                let want = if i == j { 1.0 } else { 0.0 };
                assert!((value - want).abs() < 1e-12);
            }
        }
    }

    #[test]
    fn temperature_to_xy_matches_photo_bench_gate() {
        // Planckian isotherms (the daylight locus sits ~0.007 above in y).
        let d50 = xy_from_temperature(5000.0, 0.0);
        assert!((d50.x - 0.34510).abs() < 1e-4 && (d50.y - 0.35162).abs() < 1e-4);
        let d65 = xy_from_temperature(6500.0, 0.0);
        assert!((d65.x - 0.3127).abs() < 0.003 && (d65.y - 0.3290).abs() < 0.008);
        let tinted = xy_from_temperature(6500.0, 30.0);
        // DNG SDK: a positive tint is a greener white point (the image turns magenta).
        assert!(tinted.y > d65.y);
    }

    #[test]
    fn raw_white_balance_is_identity_at_as_shot() {
        let white = xy_from_temperature(5200.0, 3.0);
        let m = raw_white_balance_prophoto(white, white);
        for (i, row) in m.iter().enumerate() {
            for (j, value) in row.iter().enumerate() {
                let want = if i == j { 1.0 } else { 0.0 };
                assert!((value - want).abs() < 1e-9);
            }
        }
    }
}
