//! Calibrated Lightroom incremental white balance for encoded raster output.
//!
//! `jpeg-incremental-wb-v1.bin` is a NIHO-owned measurement of synthetic
//! 17^3 sRGB chart exports, not an Adobe LUT.  It stores signed RGB deltas in
//! 1/16-byte units, little endian, in this fixed order:
//! `temp_m80`, `temp_m30`, `temp_p30`, `temp_p80`, `tint_m50`, `tint_m20`,
//! `tint_p20`, `tint_p50`, `wb_cool`, `wb_warm`.
//!
//! Temperature and tint are interpolated independently between their measured
//! knots.  Same-sign quadrants add the measured (-30,-20) / (+30,+20)
//! interaction residual.  The resulting delta cube is prepared once per
//! frame; applying it allocates nothing per pixel.

pub(crate) const DIMENSION: usize = 17;
const NODE_COUNT: usize = DIMENSION * DIMENSION * DIMENSION;
const CHANNELS: usize = 3;
const VARIANT_COUNT: usize = 10;
const FIXED_SCALE: f32 = 16.0;
const LUT_BYTES: usize = VARIANT_COUNT * NODE_COUNT * CHANNELS * 2;

/// Python's `[round(i * 255 / 16) for i in range(17)]`, used by the measured
/// chart.  The 15/16-byte steps are intentionally not treated as uniform.
pub(crate) const LEVELS: [u8; DIMENSION] = [
    0, 16, 32, 48, 64, 80, 96, 112, 128, 143, 159, 175, 191, 207, 223, 239, 255,
];

static LUT: &[u8; LUT_BYTES] = include_bytes!("../../../calibration/jpeg-incremental-wb-v1.bin");

#[derive(Clone, Copy)]
#[repr(usize)]
enum Variant {
    TempM80 = 0,
    TempM30 = 1,
    TempP30 = 2,
    TempP80 = 3,
    TintM50 = 4,
    TintM20 = 5,
    TintP20 = 6,
    TintP50 = 7,
    WbCool = 8,
    WbWarm = 9,
}

#[derive(Clone, Copy)]
struct GridCoordinate {
    low: usize,
    fraction: f32,
}

const fn grid_coordinate(value: u8) -> GridCoordinate {
    let mut low = 0usize;
    while low + 1 < DIMENSION - 1 && value >= LEVELS[low + 1] {
        low += 1;
    }
    let a = LEVELS[low] as f32;
    let b = LEVELS[low + 1] as f32;
    GridCoordinate {
        low,
        fraction: (value as f32 - a) / (b - a),
    }
}

const fn grid_coordinates() -> [GridCoordinate; 256] {
    let mut result = [GridCoordinate {
        low: 0,
        fraction: 0.0,
    }; 256];
    let mut value = 0usize;
    while value < result.len() {
        result[value] = grid_coordinate(value as u8);
        value += 1;
    }
    result
}

const GRID: [GridCoordinate; 256] = grid_coordinates();

fn fixed_delta(variant: Variant, node: usize, channel: usize) -> i16 {
    let offset = (((variant as usize) * NODE_COUNT + node) * CHANNELS + channel) * 2;
    i16::from_le_bytes([LUT[offset], LUT[offset + 1]])
}

fn add_axis_weights(
    weights: &mut [f32; VARIANT_COUNT],
    value: f64,
    knots: [f64; 5],
    variants: [Option<Variant>; 5],
) {
    let segment = if value < knots[1] {
        0
    } else if value < knots[2] {
        1
    } else if value <= knots[3] {
        2
    } else {
        3
    };
    let fraction = ((value - knots[segment]) / (knots[segment + 1] - knots[segment])) as f32;
    if let Some(variant) = variants[segment] {
        weights[variant as usize] += 1.0 - fraction;
    }
    if let Some(variant) = variants[segment + 1] {
        weights[variant as usize] += fraction;
    }
}

fn parameter_weights(temperature: f64, tint: f64) -> [f32; VARIANT_COUNT] {
    let mut weights = [0.0; VARIANT_COUNT];
    add_axis_weights(
        &mut weights,
        temperature,
        [-80.0, -30.0, 0.0, 30.0, 80.0],
        [
            Some(Variant::TempM80),
            Some(Variant::TempM30),
            None,
            Some(Variant::TempP30),
            Some(Variant::TempP80),
        ],
    );
    add_axis_weights(
        &mut weights,
        tint,
        [-50.0, -20.0, 0.0, 20.0, 50.0],
        [
            Some(Variant::TintM50),
            Some(Variant::TintM20),
            None,
            Some(Variant::TintP20),
            Some(Variant::TintP50),
        ],
    );

    if temperature * tint > 0.0 {
        let amount =
            (temperature.abs() / 30.0).min(1.0) as f32 * (tint.abs() / 20.0).min(1.0) as f32;
        let (combo, temperature_axis, tint_axis) = if temperature < 0.0 {
            (Variant::WbCool, Variant::TempM30, Variant::TintM20)
        } else {
            (Variant::WbWarm, Variant::TempP30, Variant::TintP20)
        };
        weights[combo as usize] += amount;
        weights[temperature_axis as usize] -= amount;
        weights[tint_axis as usize] -= amount;
    }
    weights
}

/// A parameter-blended 17^3 delta cube.  Construction does one allocation
/// per non-neutral frame; lookup and application allocate nothing.
pub(crate) struct PreparedJpegWhiteBalance {
    deltas: Box<[[f32; CHANNELS]]>,
}

impl PreparedJpegWhiteBalance {
    pub(crate) fn new(temperature: f64, tint: f64) -> Option<Self> {
        if temperature == 0.0 && tint == 0.0 {
            return None;
        }
        let weights = parameter_weights(temperature, tint);
        let mut deltas = Vec::with_capacity(NODE_COUNT);
        for node in 0..NODE_COUNT {
            let mut delta = [0.0; CHANNELS];
            for (variant, weight) in weights.iter().copied().enumerate() {
                if weight == 0.0 {
                    continue;
                }
                let variant = match variant {
                    0 => Variant::TempM80,
                    1 => Variant::TempM30,
                    2 => Variant::TempP30,
                    3 => Variant::TempP80,
                    4 => Variant::TintM50,
                    5 => Variant::TintM20,
                    6 => Variant::TintP20,
                    7 => Variant::TintP50,
                    8 => Variant::WbCool,
                    _ => Variant::WbWarm,
                };
                for (channel, delta_channel) in delta.iter_mut().enumerate() {
                    *delta_channel +=
                        weight * fixed_delta(variant, node, channel) as f32 / FIXED_SCALE;
                }
            }
            deltas.push(delta);
        }
        Some(Self {
            deltas: deltas.into_boxed_slice(),
        })
    }

    /// The blended delta of every chart node (bytes), `r`-major then `g`,
    /// `b` (`niho-13`'s head white balance interpolates it itself,
    /// `head_wb.rs`).
    pub(crate) fn node_deltas(&self) -> &[[f32; CHANNELS]] {
        &self.deltas
    }

    pub(crate) fn delta(&self, rgb: [u8; 3]) -> [f32; 3] {
        let [r, g, b] = rgb.map(|value| GRID[value as usize]);
        let mut result = [0.0; CHANNELS];
        for dr in 0..=1 {
            let wr = if dr == 0 {
                1.0 - r.fraction
            } else {
                r.fraction
            };
            for dg in 0..=1 {
                let wg = if dg == 0 {
                    1.0 - g.fraction
                } else {
                    g.fraction
                };
                for db in 0..=1 {
                    let wb = if db == 0 {
                        1.0 - b.fraction
                    } else {
                        b.fraction
                    };
                    let node = (r.low + dr) * DIMENSION * DIMENSION
                        + (g.low + dg) * DIMENSION
                        + b.low
                        + db;
                    let weight = wr * wg * wb;
                    for (channel, result_channel) in result.iter_mut().enumerate() {
                        *result_channel += weight * self.deltas[node][channel];
                    }
                }
            }
        }
        result
    }

    pub(crate) fn apply_rgba(&self, rgba: &mut [u8]) {
        for pixel in rgba.chunks_exact_mut(4) {
            let delta = self.delta([pixel[0], pixel[1], pixel[2]]);
            for channel in 0..CHANNELS {
                pixel[channel] =
                    libm::roundf(pixel[channel] as f32 + delta[channel]).clamp(0.0, 255.0) as u8;
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn actual_chart_levels_are_exact_grid_nodes() {
        for (index, level) in LEVELS.into_iter().enumerate() {
            let coordinate = GRID[level as usize];
            assert_eq!(coordinate.low, index.min(DIMENSION - 2));
            assert_eq!(
                coordinate.fraction,
                if index == DIMENSION - 1 { 1.0 } else { 0.0 }
            );
        }
    }

    #[test]
    fn neutral_needs_no_cube_and_preserves_bytes() {
        assert!(PreparedJpegWhiteBalance::new(0.0, 0.0).is_none());
    }

    #[test]
    fn parameters_extrapolate_nearest_segments_and_cross_sign_is_additive() {
        let cold = parameter_weights(-100.0, 0.0);
        assert!((cold[Variant::TempM80 as usize] - 1.4).abs() < 1e-6);
        assert!((cold[Variant::TempM30 as usize] + 0.4).abs() < 1e-6);

        let cross = parameter_weights(-30.0, 20.0);
        assert_eq!(cross[Variant::TempM30 as usize], 1.0);
        assert_eq!(cross[Variant::TintP20 as usize], 1.0);
        assert_eq!(cross[Variant::WbCool as usize], 0.0);
        assert_eq!(cross[Variant::WbWarm as usize], 0.0);
    }

    #[test]
    fn exact_axis_and_combination_knots_are_the_measured_cubes() {
        for (temperature, tint, variant) in [
            (-80.0, 0.0, Variant::TempM80),
            (-30.0, 0.0, Variant::TempM30),
            (30.0, 0.0, Variant::TempP30),
            (80.0, 0.0, Variant::TempP80),
            (0.0, -50.0, Variant::TintM50),
            (0.0, -20.0, Variant::TintM20),
            (0.0, 20.0, Variant::TintP20),
            (0.0, 50.0, Variant::TintP50),
            (-30.0, -20.0, Variant::WbCool),
            (30.0, 20.0, Variant::WbWarm),
        ] {
            let prepared = PreparedJpegWhiteBalance::new(temperature, tint).unwrap();
            for node in 0..NODE_COUNT {
                for channel in 0..CHANNELS {
                    let expected = fixed_delta(variant, node, channel) as f32 / FIXED_SCALE;
                    assert!((prepared.deltas[node][channel] - expected).abs() < 1e-5);
                }
            }
        }
    }

    #[test]
    fn application_preserves_alpha_and_clamps_rgb() {
        let prepared = PreparedJpegWhiteBalance::new(100.0, 100.0).unwrap();
        let mut rgba = [0, 0, 0, 7, 255, 255, 255, 0, 128, 143, 159, 201];
        prepared.apply_rgba(&mut rgba);
        assert_eq!([rgba[3], rgba[7], rgba[11]], [7, 0, 201]);
    }
}
