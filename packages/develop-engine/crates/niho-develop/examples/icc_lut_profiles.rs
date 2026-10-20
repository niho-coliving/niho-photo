//! LUT-based ICC profiles (no matrix/TRC tags) for the raster decoder, and
//! the crate's decode of them next to Core Image's (Photo Bench's decoder).
//!
//! Writes 16-bit PNGs of a 21-level RGB grid (441x21, the levels fall
//! between the 17-point CLUT nodes) with these embedded profiles:
//!
//! - `p3-matrix`: Display P3 as matrix/TRC (the existing path; baseline).
//! - `p3-mab-xyz`: Display P3 as a v4 lutAtoBType (A curves = the sRGB
//!   curve, 17-point CLUT of linear RGB -> PCS XYZ).
//! - `p3-mab-lab`: the same with PCS Lab (v4 encoding; the layout of the
//!   ICC's sRGB v4 profiles).
//! - `p3-lut16-lab` / `p3-lut16-lab-v2`: Display P3 as a lut16Type (input
//!   tables = the sRGB curve, 17-point CLUT of linear RGB -> PCS Lab, legacy
//!   16-bit Lab) in a v4.4 / v2.4 header.
//! - `two-intents`: A2B0 = Display P3, A2B1 = Rec. 2020 (both lutAtoBType):
//!   which table a decoder picks.
//!
//! plus `<name>.icc` and `<name>.crate.f32`: `decode_raster` at full size
//! (little-endian `f32`, extended linear sRGB, RGB interleaved).
//! `scripts/golden/icc_reference.swift` writes Core Image's `<name>.ci.f32`
//! and `scripts/golden/icc_compare.py` prints the ΔE00 table (README
//! "忠実度" ICC).
//!
//!   cargo run --release -p niho-develop --example icc_lut_profiles -- <dir>

use image::ImageEncoder;
use moxcms::{
    ColorProfile, DataColorSpace, LocalizableString, LutDataType, LutMultidimensionalType,
    LutStore, LutType, LutWarehouse, Matrix3d, ProfileText, ToneReprCurve, Vector3d,
};
use niho_develop::decode::decode_raster;
use niho_develop::resize::Filter;

const LEVELS: usize = 21;
const GRID: usize = 17;

/// Linear RGB -> XYZ (D50, Bradford-adapted) of Display P3 and Rec. 2020.
const P3_TO_XYZ_D50: [[f64; 3]; 3] = [
    [0.515102, 0.291965, 0.157153],
    [0.241182, 0.692236, 0.066582],
    [-0.001050, 0.041882, 0.784378],
];
const REC2020_TO_XYZ_D50: [[f64; 3]; 3] = [
    [0.673459, 0.165661, 0.125100],
    [0.279033, 0.675338, 0.045629],
    [-0.001931, 0.029979, 0.797162],
];
const D50: [f64; 3] = [0.9642, 1.0, 0.8249];

fn srgb_eotf(v: f64) -> f64 {
    if v <= 0.04045 {
        v / 12.92
    } else {
        ((v + 0.055) / 1.055).powf(2.4)
    }
}

fn srgb_curve() -> ToneReprCurve {
    ToneReprCurve::Parametric(vec![2.4, 1.0 / 1.055, 0.055 / 1.055, 1.0 / 12.92, 0.04045])
}

fn mul(m: &[[f64; 3]; 3], v: [f64; 3]) -> [f64; 3] {
    [0, 1, 2].map(|i| m[i][0] * v[0] + m[i][1] * v[1] + m[i][2] * v[2])
}

/// CLUT nodes in ICC order (the first channel varies slowest).
fn nodes() -> impl Iterator<Item = [f64; 3]> {
    let step = |i: usize| i as f64 / (GRID - 1) as f64;
    (0..GRID).flat_map(move |r| {
        (0..GRID).flat_map(move |g| (0..GRID).map(move |b| [step(r), step(g), step(b)]))
    })
}

/// lutAtoBType: sRGB curve -> CLUT (linear RGB -> PCS XYZ, u16 = XYZ * 32768).
fn mab_xyz(to_xyz: &[[f64; 3]; 3]) -> LutWarehouse {
    let clut: Vec<u16> = nodes()
        .flat_map(|rgb| mul(to_xyz, rgb))
        .map(|v| (v * 32768.0).round().clamp(0.0, 65535.0) as u16)
        .collect();
    let mut grid_points = [0u8; 16];
    grid_points[..3].fill(GRID as u8);
    LutWarehouse::Multidimensional(LutMultidimensionalType {
        num_input_channels: 3,
        num_output_channels: 3,
        grid_points,
        clut: Some(LutStore::Store16(clut)),
        a_curves: vec![srgb_curve(); 3],
        b_curves: vec![ToneReprCurve::Parametric(vec![1.0]); 3],
        m_curves: Vec::new(),
        matrix: Matrix3d::IDENTITY,
        bias: Vector3d::default(),
    })
}

fn lab(xyz: [f64; 3]) -> [f64; 3] {
    let f = |t: f64| {
        if t > (6.0f64 / 29.0).powi(3) {
            t.cbrt()
        } else {
            t / (3.0 * (6.0f64 / 29.0).powi(2)) + 4.0 / 29.0
        }
    };
    let [fx, fy, fz] = [0, 1, 2].map(|i| f(xyz[i] / D50[i]));
    [116.0 * fy - 16.0, 500.0 * (fx - fy), 200.0 * (fy - fz)]
}

/// lutAtoBType: sRGB curve -> CLUT (linear RGB -> v4 Lab: L* 0..100 and
/// a*, b* -128..127 over 0..65535), the layout of the ICC's sRGB v4 profiles.
fn mab_lab(to_xyz: &[[f64; 3]; 3]) -> LutWarehouse {
    let clut: Vec<u16> = nodes()
        .flat_map(|rgb| {
            let [l, a, b] = lab(mul(to_xyz, rgb));
            [l / 100.0, (a + 128.0) / 255.0, (b + 128.0) / 255.0]
        })
        .map(|v| (v * 65535.0).round().clamp(0.0, 65535.0) as u16)
        .collect();
    let mut grid_points = [0u8; 16];
    grid_points[..3].fill(GRID as u8);
    LutWarehouse::Multidimensional(LutMultidimensionalType {
        num_input_channels: 3,
        num_output_channels: 3,
        grid_points,
        clut: Some(LutStore::Store16(clut)),
        a_curves: vec![srgb_curve(); 3],
        b_curves: vec![ToneReprCurve::Parametric(vec![1.0]); 3],
        m_curves: Vec::new(),
        matrix: Matrix3d::IDENTITY,
        bias: Vector3d::default(),
    })
}

/// lut16Type: sRGB curve (input tables) -> CLUT (linear RGB -> legacy Lab).
fn lut16_lab(to_xyz: &[[f64; 3]; 3]) -> LutWarehouse {
    const ENTRIES: usize = 4096;
    let curve: Vec<u16> = (0..ENTRIES)
        .map(|i| (srgb_eotf(i as f64 / (ENTRIES - 1) as f64) * 65535.0).round() as u16)
        .collect();
    let input_table: Vec<u16> = (0..3).flat_map(|_| curve.iter().copied()).collect();
    let clut: Vec<u16> = nodes()
        .flat_map(|rgb| {
            let [l, a, b] = lab(mul(to_xyz, rgb));
            [
                l * 65280.0 / 100.0,
                (a + 128.0) * 256.0,
                (b + 128.0) * 256.0,
            ]
        })
        .map(|v| v.round().clamp(0.0, 65535.0) as u16)
        .collect();
    let output_table: Vec<u16> = (0..3).flat_map(|_| [0u16, 65535]).collect();
    LutWarehouse::Lut(LutDataType {
        num_input_channels: 3,
        num_output_channels: 3,
        num_clut_grid_points: GRID as u8,
        matrix: Matrix3d::IDENTITY,
        num_input_table_entries: ENTRIES as u16,
        num_output_table_entries: 2,
        input_table: LutStore::Store16(input_table),
        clut_table: LutStore::Store16(clut),
        output_table: LutStore::Store16(output_table),
        lut_type: LutType::Lut16,
    })
}

/// Tags ColorSync requires before it honors an embedded profile.
fn with_required_tags(mut profile: ColorProfile, name: &str) -> Vec<u8> {
    let text = |value: &str| {
        Some(ProfileText::Localizable(vec![LocalizableString {
            language: "en".into(),
            country: "US".into(),
            value: value.into(),
        }]))
    };
    // moxcms writes a `chad` that is the Bradford cone matrix rather than an
    // adaptation, and a `cicp`; ColorSync honors them (Display P3 red turns
    // 1.158 instead of 1.225), so leave both out like Apple's own profiles.
    profile.chromatic_adaptation = None;
    profile.cicp = None;
    profile.description = text(name);
    profile.copyright = text("No copyright, test profile");
    profile.media_white_point = Some(moxcms::Xyzd {
        x: D50[0],
        y: D50[1],
        z: D50[2],
    });
    profile.encode().expect("encode profile")
}

/// An input-class RGB profile (a camera / scanner profile: A2B tables only,
/// ColorSync rejects a display-class LUT profile without B2A0).
fn lut_profile(
    pcs: DataColorSpace,
    perceptual: LutWarehouse,
    colorimetric: Option<LutWarehouse>,
) -> Vec<u8> {
    let mut profile = ColorProfile::new_display_p3();
    profile.red_colorant = Default::default();
    profile.green_colorant = Default::default();
    profile.blue_colorant = Default::default();
    profile.red_trc = None;
    profile.green_trc = None;
    profile.blue_trc = None;
    profile.profile_class = moxcms::ProfileClass::InputDevice;
    profile.pcs = pcs;
    profile.lut_a_to_b_perceptual = Some(perceptual);
    profile.lut_a_to_b_colorimetric = colorimetric;
    with_required_tags(profile, "NIHO LUT test profile")
}

fn grid_png(icc: Vec<u8>) -> Vec<u8> {
    let level = |i: usize| ((i as f64 / (LEVELS - 1) as f64) * 65535.0).round() as u16;
    let mut samples = Vec::with_capacity(LEVELS * LEVELS * LEVELS * 3);
    for g in 0..LEVELS {
        for r in 0..LEVELS {
            for b in 0..LEVELS {
                samples.extend([level(r), level(g), level(b)]);
            }
        }
    }
    let bytes: Vec<u8> = samples.iter().flat_map(|v| v.to_ne_bytes()).collect();
    let mut png = Vec::new();
    let mut encoder = image::codecs::png::PngEncoder::new(&mut png);
    encoder.set_icc_profile(icc).expect("icc");
    encoder
        .write_image(
            &bytes,
            (LEVELS * LEVELS) as u32,
            LEVELS as u32,
            image::ExtendedColorType::Rgb16,
        )
        .expect("png");
    png
}

fn main() {
    let dir = std::path::PathBuf::from(std::env::args().nth(1).expect("output dir"));
    std::fs::create_dir_all(&dir).expect("mkdir");
    let cases = [
        (
            "p3-matrix",
            with_required_tags(ColorProfile::new_display_p3(), "NIHO P3 test profile"),
        ),
        (
            "p3-mab-xyz",
            lut_profile(DataColorSpace::Xyz, mab_xyz(&P3_TO_XYZ_D50), None),
        ),
        (
            "p3-mab-lab",
            lut_profile(DataColorSpace::Lab, mab_lab(&P3_TO_XYZ_D50), None),
        ),
        (
            "p3-lut16-lab",
            lut_profile(DataColorSpace::Lab, lut16_lab(&P3_TO_XYZ_D50), None),
        ),
        ("p3-lut16-lab-v2", {
            // The same table in a v2.4 header (lut16Type is the v2 era's
            // type; real lut16 profiles are v2).
            let mut icc = lut_profile(DataColorSpace::Lab, lut16_lab(&P3_TO_XYZ_D50), None);
            icc[8..12].copy_from_slice(&[0x02, 0x40, 0, 0]);
            icc
        }),
        (
            "two-intents",
            lut_profile(
                DataColorSpace::Xyz,
                mab_xyz(&P3_TO_XYZ_D50),
                Some(mab_xyz(&REC2020_TO_XYZ_D50)),
            ),
        ),
    ];
    for (name, icc) in cases {
        std::fs::write(dir.join(format!("{name}.icc")), &icc).expect("write icc");
        let png = grid_png(icc);
        std::fs::write(dir.join(format!("{name}.png")), &png).expect("write png");
        let raster = decode_raster(&png, 0, Filter::Lanczos3).expect("decode");
        let bytes: Vec<u8> = raster
            .image
            .data
            .iter()
            .flat_map(|v| v.to_le_bytes())
            .collect();
        std::fs::write(dir.join(format!("{name}.crate.f32")), bytes).expect("write f32");
        eprintln!("{name}: {:?}", raster.info.color);
    }
}
