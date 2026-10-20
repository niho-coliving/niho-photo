//! Research candidate for incremental JPEG white balance in linear
//! ProPhoto D50 (#27).
//!
//! The fit reads only the eight axis measurements in the public
//! `jpeg-incremental-wb-v1.bin`. The two same-sign combination measurements
//! are not visible to the optimizer. A frozen fit can then be evaluated in
//! a separate pass over all ten variants. This module does not replace the
//! production encoded-output LUT in `jpeg_wb.rs`.

use crate::color::{
    bradford_xyz, mat_mul, mat_vec, srgb_decode, xy_from_temperature, Mat3, PROPHOTO_TO_XYZ_D50,
    SRGB_TO_PROPHOTO, XYZ_D50_TO_PROPHOTO,
};

pub const DIMENSION: usize = 17;
const NODE_COUNT: usize = DIMENSION * DIMENSION * DIMENSION;
const CHANNELS: usize = 3;
const VARIANT_COUNT: usize = 10;
const FIXED_SCALE: f64 = 16.0;
const LUT_BYTES: usize = VARIANT_COUNT * NODE_COUNT * CHANNELS * 2;
pub const MEAN_GATE: f64 = 0.5;

pub const LEVELS: [u8; DIMENSION] = [
    0, 16, 32, 48, 64, 80, 96, 112, 128, 143, 159, 175, 191, 207, 223, 239, 255,
];

static LUT: &[u8; LUT_BYTES] = include_bytes!("../../../../calibration/jpeg-incremental-wb-v1.bin");

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Variant {
    TempM80,
    TempM30,
    TempP30,
    TempP80,
    TintM50,
    TintM20,
    TintP20,
    TintP50,
    WbCool,
    WbWarm,
}

impl Variant {
    pub const ALL: [Self; VARIANT_COUNT] = [
        Self::TempM80,
        Self::TempM30,
        Self::TempP30,
        Self::TempP80,
        Self::TintM50,
        Self::TintM20,
        Self::TintP20,
        Self::TintP50,
        Self::WbCool,
        Self::WbWarm,
    ];
    pub const FIT_AXES: [Self; 8] = [
        Self::TempM80,
        Self::TempM30,
        Self::TempP30,
        Self::TempP80,
        Self::TintM50,
        Self::TintM20,
        Self::TintP20,
        Self::TintP50,
    ];
    pub const HELD_OUT_COMBINATIONS: [Self; 2] = [Self::WbCool, Self::WbWarm];

    pub fn name(self) -> &'static str {
        match self {
            Self::TempM80 => "temp_m80",
            Self::TempM30 => "temp_m30",
            Self::TempP30 => "temp_p30",
            Self::TempP80 => "temp_p80",
            Self::TintM50 => "tint_m50",
            Self::TintM20 => "tint_m20",
            Self::TintP20 => "tint_p20",
            Self::TintP50 => "tint_p50",
            Self::WbCool => "wb_cool",
            Self::WbWarm => "wb_warm",
        }
    }

    pub fn sliders(self) -> (f64, f64) {
        match self {
            Self::TempM80 => (-80.0, 0.0),
            Self::TempM30 => (-30.0, 0.0),
            Self::TempP30 => (30.0, 0.0),
            Self::TempP80 => (80.0, 0.0),
            Self::TintM50 => (0.0, -50.0),
            Self::TintM20 => (0.0, -20.0),
            Self::TintP20 => (0.0, 20.0),
            Self::TintP50 => (0.0, 50.0),
            Self::WbCool => (-30.0, -20.0),
            Self::WbWarm => (30.0, 20.0),
        }
    }

    fn index(self) -> usize {
        self as usize
    }
}

/// Bounded mapping from a slider to DNG temperature/tint coordinates.
/// Temperature is a signed mired delta around 5000 K. The second term lets
/// the outer and inner knots have different slopes; the mapping is odd in mired.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct Mapping {
    pub mired_linear: f64,
    pub mired_quadratic: f64,
    pub tint_linear: f64,
    pub tint_quadratic: f64,
}

impl Default for Mapping {
    fn default() -> Self {
        Self {
            mired_linear: 0.5,
            mired_quadratic: 0.0,
            tint_linear: 0.5,
            tint_quadratic: 0.0,
        }
    }
}

impl Mapping {
    const BOUNDS: [(f64, f64); 4] = [(-2.0, 2.0); 4];

    pub fn coordinates(self, temperature: f64, tint: f64) -> (f64, f64) {
        let mired = 200.0
            + self.mired_linear * temperature
            + self.mired_quadratic * temperature * temperature.abs() / 100.0;
        let effective_temperature =
            (1_000_000.0 / mired.clamp(20.0, 500.0)).clamp(2000.0, 50_000.0);
        let effective_tint = (self.tint_linear * tint
            + self.tint_quadratic * tint * tint.abs() / 100.0)
            .clamp(-150.0, 150.0);
        (effective_temperature, effective_tint)
    }

    pub fn matrix(self, temperature: f64, tint: f64) -> Mat3 {
        if temperature == 0.0 && tint == 0.0 {
            return crate::color::IDENTITY;
        }
        let base = xy_from_temperature(5000.0, 0.0);
        let (kelvin, mapped_tint) = self.coordinates(temperature, tint);
        let effective = xy_from_temperature(kelvin, mapped_tint);
        let adaptation = bradford_xyz(effective, base);
        mat_mul(
            &XYZ_D50_TO_PROPHOTO,
            &mat_mul(&adaptation, &PROPHOTO_TO_XYZ_D50),
        )
    }

    fn values(self) -> [f64; 4] {
        [
            self.mired_linear,
            self.mired_quadratic,
            self.tint_linear,
            self.tint_quadratic,
        ]
    }

    fn from_values(values: [f64; 4]) -> Self {
        Self {
            mired_linear: values[0],
            mired_quadratic: values[1],
            tint_linear: values[2],
            tint_quadratic: values[3],
        }
    }
}

#[derive(Debug, Clone)]
pub struct VariantMetrics {
    pub variant: Variant,
    pub mean_delta_e00: f64,
    pub p99_delta_e00: f64,
    pub samples: usize,
}

#[derive(Debug, Clone)]
pub struct ValidationReport {
    pub variants: Vec<VariantMetrics>,
    pub mean_delta_e00: f64,
    pub p99_delta_e00: f64,
    pub mean_gate_met: bool,
}

fn fixed_delta(variant: Variant, node: usize, channel: usize) -> f64 {
    let offset = ((variant.index() * NODE_COUNT + node) * CHANNELS + channel) * 2;
    f64::from(i16::from_le_bytes([LUT[offset], LUT[offset + 1]])) / FIXED_SCALE
}

fn input_node(node: usize) -> ([f64; 3], [f64; 3]) {
    let r = LEVELS[node / (DIMENSION * DIMENSION)];
    let g = LEVELS[node / DIMENSION % DIMENSION];
    let b = LEVELS[node % DIMENSION];
    let encoded = [r, g, b];
    let linear_srgb = encoded.map(|v| srgb_decode(f64::from(v) / 255.0));
    (linear_srgb, mat_vec(&SRGB_TO_PROPHOTO, linear_srgb))
}

fn measured_node(variant: Variant, node: usize) -> [f64; 3] {
    let r = LEVELS[node / (DIMENSION * DIMENSION)];
    let g = LEVELS[node / DIMENSION % DIMENSION];
    let b = LEVELS[node % DIMENSION];
    let encoded = [r, g, b].map(f64::from);
    let output = std::array::from_fn(|channel| {
        srgb_decode(
            (encoded[channel] + fixed_delta(variant, node, channel)).clamp(0.0, 255.0) / 255.0,
        )
    });
    mat_vec(&SRGB_TO_PROPHOTO, output)
}

fn lab_d50(prophoto: [f64; 3]) -> [f64; 3] {
    let xyz = mat_vec(&PROPHOTO_TO_XYZ_D50, prophoto);
    let white = crate::color::xy_to_xyz(crate::color::D50_XY);
    let f = |t: f64| {
        if t > 216.0 / 24389.0 {
            libm::cbrt(t)
        } else {
            (24389.0 / 27.0 * t + 16.0) / 116.0
        }
    };
    let (fx, fy, fz) = (f(xyz[0] / white[0]), f(xyz[1]), f(xyz[2] / white[2]));
    [116.0 * fy - 16.0, 500.0 * (fx - fy), 200.0 * (fy - fz)]
}

/// CIEDE2000 (Sharma, Wu and Dalal 2005).
pub fn delta_e00(l1: [f64; 3], l2: [f64; 3]) -> f64 {
    let (lp1, a1, b1) = (l1[0], l1[1], l1[2]);
    let (lp2, a2, b2) = (l2[0], l2[1], l2[2]);
    let c1 = libm::sqrt(a1 * a1 + b1 * b1);
    let c2 = libm::sqrt(a2 * a2 + b2 * b2);
    let cbar = (c1 + c2) / 2.0;
    let g = 0.5
        * (1.0 - libm::sqrt(libm::pow(cbar, 7.0) / (libm::pow(cbar, 7.0) + libm::pow(25.0, 7.0))));
    let (a1p, a2p) = ((1.0 + g) * a1, (1.0 + g) * a2);
    let c1p = libm::sqrt(a1p * a1p + b1 * b1);
    let c2p = libm::sqrt(a2p * a2p + b2 * b2);
    let hue = |b: f64, a: f64| {
        if a == 0.0 && b == 0.0 {
            0.0
        } else {
            libm::atan2(b, a).to_degrees().rem_euclid(360.0)
        }
    };
    let (h1p, h2p) = (hue(b1, a1p), hue(b2, a2p));
    let dlp = lp2 - lp1;
    let dcp = c2p - c1p;
    let dhp = if c1p * c2p == 0.0 {
        0.0
    } else if (h2p - h1p).abs() <= 180.0 {
        h2p - h1p
    } else if h2p > h1p {
        h2p - h1p - 360.0
    } else {
        h2p - h1p + 360.0
    };
    let dh = 2.0 * libm::sqrt(c1p * c2p) * libm::sin(dhp.to_radians() / 2.0);
    let lbar = (lp1 + lp2) / 2.0;
    let cbarp = (c1p + c2p) / 2.0;
    let hbarp = if c1p * c2p == 0.0 {
        h1p + h2p
    } else if (h1p - h2p).abs() <= 180.0 {
        (h1p + h2p) / 2.0
    } else if h1p + h2p < 360.0 {
        (h1p + h2p + 360.0) / 2.0
    } else {
        (h1p + h2p - 360.0) / 2.0
    };
    let cos = |degrees: f64| libm::cos(degrees.to_radians());
    let t =
        1.0 - 0.17 * cos(hbarp - 30.0) + 0.24 * cos(2.0 * hbarp) + 0.32 * cos(3.0 * hbarp + 6.0)
            - 0.20 * cos(4.0 * hbarp - 63.0);
    let dtheta = 30.0 * libm::exp(-libm::pow((hbarp - 275.0) / 25.0, 2.0));
    let rc =
        2.0 * libm::sqrt(libm::pow(cbarp, 7.0) / (libm::pow(cbarp, 7.0) + libm::pow(25.0, 7.0)));
    let sl =
        1.0 + 0.015 * libm::pow(lbar - 50.0, 2.0) / libm::sqrt(20.0 + libm::pow(lbar - 50.0, 2.0));
    let sc = 1.0 + 0.045 * cbarp;
    let sh = 1.0 + 0.015 * cbarp * t;
    let rt = -libm::sin(2.0 * dtheta.to_radians()) * rc;
    libm::sqrt(
        libm::pow(dlp / sl, 2.0)
            + libm::pow(dcp / sc, 2.0)
            + libm::pow(dh / sh, 2.0)
            + rt * (dcp / sc) * (dh / sh),
    )
}

fn errors(mapping: Mapping, variants: &[Variant]) -> Vec<(Variant, Vec<f64>)> {
    variants
        .iter()
        .copied()
        .map(|variant| {
            let (temperature, tint) = variant.sliders();
            let matrix = mapping.matrix(temperature, tint);
            let errors = (0..NODE_COUNT)
                .map(|node| {
                    let (_, input) = input_node(node);
                    let adapted = mat_vec(&matrix, input);
                    // Compare observable display colors, rather than penalizing
                    // unbounded scene values against clipped Lightroom output.
                    // This isolates the matrix: it is not an end-to-end preset gate.
                    let display = mat_vec(&PROPHOTO_TO_SRGB, adapted).map(|value| {
                        let code =
                            libm::round(crate::color::srgb_encode(value.clamp(0.0, 1.0)) * 255.0);
                        srgb_decode(code / 255.0)
                    });
                    let candidate = mat_vec(&SRGB_TO_PROPHOTO, display);
                    delta_e00(lab_d50(candidate), lab_d50(measured_node(variant, node)))
                })
                .collect();
            (variant, errors)
        })
        .collect()
}

fn objective(mapping: Mapping) -> f64 {
    let values = errors(mapping, &Variant::FIT_AXES);
    let (sum, count) = values
        .iter()
        .flat_map(|(_, values)| values)
        .fold((0.0, 0usize), |(sum, count), value| {
            (sum + value, count + 1)
        });
    sum / count as f64
}

/// Deterministic bounded coordinate descent. Only [`Variant::FIT_AXES`] is
/// read by the objective; combination variants remain held out until
/// [`validate`] is called.
pub fn fit() -> Mapping {
    let mut values = Mapping::default().values();
    let mut steps = [0.5, 0.5, 0.5, 0.5];
    let mut best = objective(Mapping::from_values(values));
    for _ in 0..9 {
        for index in 0..values.len() {
            for direction in [-1.0, 1.0] {
                let mut candidate = values;
                candidate[index] = (candidate[index] + direction * steps[index])
                    .clamp(Mapping::BOUNDS[index].0, Mapping::BOUNDS[index].1);
                let score = objective(Mapping::from_values(candidate));
                if score < best {
                    values = candidate;
                    best = score;
                }
            }
        }
        for step in &mut steps {
            *step *= 0.5;
        }
    }
    Mapping::from_values(values)
}

fn percentile(sorted: &[f64], p: f64) -> f64 {
    if sorted.is_empty() {
        return 0.0;
    }
    let rank = p * (sorted.len() - 1) as f64;
    let low = libm::floor(rank) as usize;
    let high = libm::ceil(rank) as usize;
    sorted[low] + (sorted[high] - sorted[low]) * (rank - low as f64)
}

/// Separate evaluation pass. Call this only after the mapping is frozen.
/// It reports every public variant, including the two combinations hidden
/// from [`fit`].
pub fn validate(mapping: Mapping, variants: &[Variant]) -> ValidationReport {
    let mut all = Vec::new();
    let variants: Vec<VariantMetrics> = errors(mapping, variants)
        .into_iter()
        .map(|(variant, mut values)| {
            values.sort_by(f64::total_cmp);
            let mean = values.iter().sum::<f64>() / values.len() as f64;
            all.extend_from_slice(&values);
            VariantMetrics {
                variant,
                mean_delta_e00: mean,
                p99_delta_e00: percentile(&values, 0.99),
                samples: values.len(),
            }
        })
        .collect();
    all.sort_by(f64::total_cmp);
    let mean = all.iter().sum::<f64>() / all.len().max(1) as f64;
    let mean_gate_met = !variants.is_empty()
        && variants
            .iter()
            .all(|variant| variant.mean_delta_e00 <= MEAN_GATE);
    ValidationReport {
        variants,
        mean_delta_e00: mean,
        p99_delta_e00: percentile(&all, 0.99),
        mean_gate_met,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn fit_and_holdout_sets_are_explicit_and_disjoint() {
        assert_eq!(Variant::FIT_AXES.len(), 8);
        assert_eq!(Variant::HELD_OUT_COMBINATIONS.len(), 2);
        for held_out in Variant::HELD_OUT_COMBINATIONS {
            assert!(!Variant::FIT_AXES.contains(&held_out));
        }
    }

    #[test]
    fn ciede2000_matches_published_sharma_pairs() {
        // Sharma/Wu/Dalal numerical examples, not their MATLAB source.
        // https://hajim.rochester.edu/ece/sites/gsharma/ciede2000/
        for (a, b, expected) in [
            ([50.0, 2.6772, -79.7751], [50.0, 0.0, -82.7485], 2.0425),
            ([50.0, 3.1571, -77.2803], [50.0, 0.0, -82.7485], 2.8615),
            ([50.0, 2.8361, -74.0200], [50.0, 0.0, -82.7485], 3.4412),
        ] {
            assert!((delta_e00(a, b) - expected).abs() < 0.0001);
            assert!((delta_e00(b, a) - expected).abs() < 0.0001);
        }
    }

    #[test]
    fn neutral_mapping_is_identity_and_extremes_are_finite() {
        let mapping = Mapping::default();
        assert_eq!(mapping.matrix(0.0, 0.0), crate::color::IDENTITY);
        for (temperature, tint) in [(-100.0, -100.0), (100.0, 100.0)] {
            let matrix = mapping.matrix(temperature, tint);
            assert!(matrix.iter().flatten().all(|value| value.is_finite()));
        }
    }
}
