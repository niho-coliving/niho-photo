//! R236-frozen `niho-3` RAW preparation and owned profile/tail assets.

use crate::color::mat_vec_f32;
use crate::decode::{LinearImage, WorkingCopyMeta};
use crate::raw_response;
use crate::resize::{self, Filter};
use crate::settings::{DevelopSettings, WhiteBalanceMode};
use crate::spatial::{self, GainScale, Plane, Quality, Shift, SpatialParams};
use std::fmt;
use std::sync::{Arc, OnceLock, Weak};

const ANALYSIS_LONG_EDGE: usize = 750;
const WORKING_COPY_MAX: f64 = 2.0;
const GAMMA: f64 = 1.8;
const VIBRANCE_BYTES: &[u8] = include_bytes!("../niho3/vibrance-delta-sqrt33.f32");
const PROFILE_BYTES: &[u8] = include_bytes!("../niho3/profile-delta-srgb9.f32");

#[derive(Debug)]
pub enum PrepareError {
    Chroma(crate::raw_chroma::RawChromaError),
    Detail(crate::detail::DetailError),
    Response(raw_response::RawResponseError),
    NonFinite(&'static str),
}

impl fmt::Display for PrepareError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Chroma(e) => write!(f, "CNR: {e}"),
            Self::Detail(e) => write!(f, "detail: {e}"),
            Self::Response(e) => write!(f, "H/S response: {e}"),
            Self::NonFinite(stage) => write!(f, "non-finite value during {stage}"),
        }
    }
}

impl std::error::Error for PrepareError {}

pub struct Prepared {
    pub image: LinearImage,
    pub meta: WorkingCopyMeta,
    pub settings: DevelopSettings,
    pub key: String,
    pub approximate_white_balance: bool,
    pub analysis: AnalysisCache,
}

/// Full-source work shared across NIHO 3 master rebuilds.  The CNR result
/// depends only on the source and the effective CNR amount; the canonical
/// response coefficients additionally depend only on that CNR result and
/// the RAW metadata's fixed baseline exposure. Both are shared with the
/// thumbnail and auto Sessions of the same source while this cache holds
/// them ([`AnalysisCache::downgrade`], #17945): the coefficients are set
/// once by whichever session needs them first.
pub struct AnalysisCache {
    cnr_amount: f64,
    luminance_nr_amount: f64,
    source_len: usize,
    cnr_source: Arc<CnrSource>,
    coefficients: Arc<OnceLock<raw_response::CoefficientMaps>>,
    preview_source: Option<PreviewSource>,
}

impl AnalysisCache {
    /// Whether [`prepare`] reuses this cache for `settings` on `image` (its
    /// check, by the effective CNR amount and the source's length).
    pub(crate) fn serves(&self, image: &LinearImage, settings: &DevelopSettings) -> bool {
        self.cnr_amount == effective_cnr_amount(settings)
            && self.luminance_nr_amount == luminance_nr_amount(settings)
            && self.source_len == image.data.len()
    }

    /// A reference that does not keep the CNR result and coefficients
    /// alive (the session holding this cache may drop them).
    pub(crate) fn downgrade(&self) -> AnalysisSeed {
        AnalysisSeed {
            cnr_amount: self.cnr_amount,
            luminance_nr_amount: self.luminance_nr_amount,
            source_len: self.source_len,
            cnr_source: Arc::downgrade(&self.cnr_source),
            coefficients: Arc::downgrade(&self.coefficients),
        }
    }
}

/// [`AnalysisCache::downgrade`].
#[derive(Clone)]
pub(crate) struct AnalysisSeed {
    cnr_amount: f64,
    luminance_nr_amount: f64,
    source_len: usize,
    cnr_source: Weak<CnrSource>,
    coefficients: Weak<OnceLock<raw_response::CoefficientMaps>>,
}

impl AnalysisSeed {
    /// The shared cache while another session still holds it.
    pub(crate) fn upgrade(&self) -> Option<AnalysisCache> {
        Some(AnalysisCache {
            cnr_amount: self.cnr_amount,
            luminance_nr_amount: self.luminance_nr_amount,
            source_len: self.source_len,
            cnr_source: self.cnr_source.upgrade()?,
            coefficients: self.coefficients.upgrade()?,
            preview_source: None,
        })
    }
}

/// Amount zero is exactly the immutable Session source. Keeping that state
/// instead of a second full-size allocation preserves both the CNR contract
/// and cache invalidation while the Session owns the source lifetime.
enum CnrSource {
    Original,
    Filtered(Vec<f32>),
}

impl CnrSource {
    fn data<'a>(&'a self, original: &'a [f32]) -> &'a [f32] {
        match self {
            Self::Original => original,
            Self::Filtered(data) => data,
        }
    }
}

/// A reduced CNR-complete source used only to prepare an unframed
/// Interactive master. The full CNR source and its canonical analysis stay
/// authoritative.
struct PreviewSource {
    cnr_amount: f64,
    width: usize,
    height: usize,
    filter: Filter,
    data: Vec<f32>,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct PreparationTarget {
    pub width: usize,
    pub height: usize,
    pub filter: Filter,
}

fn effective_cnr_amount(settings: &DevelopSettings) -> f64 {
    settings
        .detail
        .and_then(|detail| detail.color_noise_reduction)
        .unwrap_or_else(|| settings.color_noise_reduction.min(50.0))
}

fn luminance_nr_amount(settings: &DevelopSettings) -> f64 {
    settings
        .detail
        .map_or(0.0, |detail| detail.luminance_noise_reduction)
}

pub fn preparation_key(
    meta: &WorkingCopyMeta,
    settings: &DevelopSettings,
    white_balance: Option<[[f32; 3]; 3]>,
    target: Option<PreparationTarget>,
) -> String {
    let baseline = match meta {
        WorkingCopyMeta::Raw { baseline_ev, .. } => *baseline_ev,
        WorkingCopyMeta::Raster { .. } => 0.0,
    };
    let target = match target {
        Some(target) => format!(
            "preview:{}x{}:{:?}",
            target.width, target.height, target.filter
        ),
        None => "full".to_owned(),
    };
    format!(
        "niho3|{baseline}|{}|{}|{}|{}|{}|{:?}|{}|{target}",
        effective_cnr_amount(settings),
        luminance_nr_amount(settings),
        settings.highlights.min(0.0),
        settings.shadows.max(0.0),
        settings.texture,
        white_balance,
        settings.exposure,
    )
}

/// Prepares a signed RAW master from the full CNR/analysis cache. `target`
/// reduces that CNR-complete source before the display-only controls; `None`
/// preserves the frozen full-source preparation order.
pub fn prepare(
    image: &LinearImage,
    meta: &WorkingCopyMeta,
    settings: &DevelopSettings,
    white_balance: Option<[[f32; 3]; 3]>,
    approximate_white_balance: bool,
    target: Option<PreparationTarget>,
    cached_analysis: Option<AnalysisCache>,
) -> Result<Prepared, PrepareError> {
    let baseline_ev = match meta {
        WorkingCopyMeta::Raw { baseline_ev, .. } => *baseline_ev,
        WorkingCopyMeta::Raster { .. } => 0.0,
    };
    let key = preparation_key(meta, settings, white_balance, target);
    let cnr_amount = effective_cnr_amount(settings);
    let luminance_nr_amount = luminance_nr_amount(settings);
    let mut analysis = if let Some(cached) = cached_analysis.filter(|cached| {
        cached.cnr_amount == cnr_amount
            && cached.luminance_nr_amount == luminance_nr_amount
            && cached.source_len == image.data.len()
    }) {
        cached
    } else {
        let cnr_source = if cnr_amount == 0.0 && luminance_nr_amount == 0.0 {
            crate::raw_chroma::validate(&image.data, image.width, image.height, cnr_amount)
                .map_err(PrepareError::Chroma)?;
            Arc::new(CnrSource::Original)
        } else {
            let chroma = if cnr_amount == 0.0 {
                image.data.clone()
            } else {
                crate::raw_chroma::apply(&image.data, image.width, image.height, cnr_amount)
                    .map_err(PrepareError::Chroma)?
            };
            Arc::new(CnrSource::Filtered(
                crate::detail::reduce_noise(
                    &chroma,
                    image.width,
                    image.height,
                    image.width.max(image.height),
                    crate::detail::SourceSpace::LinearProPhoto,
                    settings.detail.unwrap_or_default(),
                    None,
                )
                .map_err(PrepareError::Detail)?,
            ))
        };
        AnalysisCache {
            cnr_amount,
            luminance_nr_amount,
            source_len: image.data.len(),
            cnr_source,
            coefficients: Arc::default(),
            preview_source: None,
        }
    };

    // Canonical analysis must finish before allocating the full prepared
    // master (or preview source), so its full-size quantized copy never
    // overlaps an otherwise unnecessary clone of the CNR source.
    if (settings.highlights < 0.0 || settings.shadows > 0.0)
        && analysis.coefficients.get().is_none()
    {
        let (canonical, width, height) = analysis_copy(
            analysis.cnr_source.data(&image.data),
            image.width,
            image.height,
            baseline_ev,
        );
        let coefficients = raw_response::coefficient_maps(&canonical, width, height)
            .map_err(PrepareError::Response)?;
        // Set here unless another session sharing it set the same maps.
        let _ = analysis.coefficients.set(coefficients);
    }

    let (prepare_width, prepare_height, mut data) = match target {
        None => (
            image.width,
            image.height,
            analysis.cnr_source.data(&image.data).to_vec(),
        ),
        Some(target) => {
            let matches = analysis.preview_source.as_ref().is_some_and(|cached| {
                cached.cnr_amount == cnr_amount
                    && cached.width == target.width
                    && cached.height == target.height
                    && cached.filter == target.filter
            });
            if !matches {
                analysis.preview_source = Some(PreviewSource {
                    cnr_amount,
                    width: target.width,
                    height: target.height,
                    filter: target.filter,
                    data: resize::resample(
                        analysis.cnr_source.data(&image.data),
                        image.width,
                        image.height,
                        target.width,
                        target.height,
                        target.filter,
                    ),
                });
            }
            let preview = analysis.preview_source.as_ref().expect("preview source");
            (preview.width, preview.height, preview.data.clone())
        }
    };

    if settings.highlights < 0.0 || settings.shadows > 0.0 {
        let coefficients = analysis.coefficients.get().expect("response coefficients");
        let (highlight_gains, shadow_gains) = raw_response::gain_ev_components(
            coefficients,
            settings.highlights.min(0.0) as f32,
            settings.shadows.max(0.0) as f32,
        )
        .map_err(PrepareError::Response)?;
        let highlight_gains = resize_plane_bilinear(
            &highlight_gains,
            coefficients.width,
            coefficients.height,
            prepare_width,
            prepare_height,
        );
        let shadow_gains = resize_plane_bilinear(
            &shadow_gains,
            coefficients.width,
            coefficients.height,
            prepare_width,
            prepare_height,
        );
        // Preserve the frozen renderer's operation order: H first, then S.
        for ((pixel, highlight_gain), shadow_gain) in data
            .chunks_exact_mut(3)
            .zip(highlight_gains)
            .zip(shadow_gains)
        {
            let scale = libm::exp2f(highlight_gain);
            pixel[0] *= scale;
            pixel[1] *= scale;
            pixel[2] *= scale;
            let scale = libm::exp2f(shadow_gain);
            pixel[0] *= scale;
            pixel[1] *= scale;
            pixel[2] *= scale;
        }
    }

    let exposure = libm::exp2(baseline_ev + settings.exposure) as f32;
    if !exposure.is_finite() {
        return Err(PrepareError::NonFinite("exposure"));
    }
    for pixel in data.chunks_exact_mut(3) {
        let mut value = [pixel[0], pixel[1], pixel[2]];
        if let Some(matrix) = &white_balance {
            value = mat_vec_f32(matrix, value);
        }
        for channel in 0..3 {
            pixel[channel] = value[channel] * exposure;
        }
    }

    if settings.texture != 0.0 {
        apply_rgb_texture(
            &mut data,
            prepare_width,
            prepare_height,
            settings.texture * 1.5,
        );
    }
    if data.iter().any(|v| !v.is_finite()) {
        return Err(PrepareError::NonFinite("master preparation"));
    }

    let downstream = downstream_settings(settings);
    Ok(Prepared {
        image: LinearImage {
            width: prepare_width,
            height: prepare_height,
            data,
        },
        meta: match meta {
            WorkingCopyMeta::Raw {
                as_shot_white,
                as_shot_white_adobe,
                dcp_sha256,
                look_table_included,
                encoding,
                ..
            } => WorkingCopyMeta::Raw {
                baseline_ev: 0.0,
                as_shot_white: *as_shot_white,
                as_shot_white_adobe: *as_shot_white_adobe,
                white_balance_table: None,
                dcp_sha256: dcp_sha256.clone(),
                look_table_included: *look_table_included,
                encoding: *encoding,
            },
            WorkingCopyMeta::Raster { icc_sha256 } => WorkingCopyMeta::Raster {
                icc_sha256: icc_sha256.clone(),
            },
        },
        settings: downstream,
        key,
        approximate_white_balance,
        analysis,
    })
}

/// Removes only controls already baked into the prepared master. This is
/// recomputed for every frame so tail-only slider changes never read a stale
/// settings snapshot from the master cache.
pub(crate) fn downstream_settings(settings: &DevelopSettings) -> DevelopSettings {
    let mut downstream = settings.clone();
    downstream.exposure = 0.0;
    downstream.texture = 0.0;
    if downstream.highlights < 0.0 {
        downstream.highlights = 0.0;
    }
    if downstream.shadows > 0.0 {
        downstream.shadows = 0.0;
    }
    if downstream.white_balance.mode == WhiteBalanceMode::Absolute {
        downstream.white_balance.mode = WhiteBalanceMode::AsShot;
        downstream.white_balance.temperature = None;
        downstream.white_balance.tint = None;
    }
    downstream
}

fn analysis_copy(
    source: &[f32],
    width: usize,
    height: usize,
    baseline_ev: f64,
) -> (Vec<f32>, usize, usize) {
    let exposure = libm::exp2(baseline_ev) as f32;
    // Do not pay the decision-table initialization cost for a small first
    // source. Both paths use the same frozen quantization boundaries.
    let encoder = if source.len() >= 1_000_000 {
        Some(analysis_encoder())
    } else {
        ANALYSIS_ENCODER.get()
    };
    let decode = analysis_decode_table();
    let quantized: Vec<f32> = source
        .iter()
        .map(|value| quantize_analysis_sample(*value, exposure, encoder, decode))
        .collect();
    let (out_width, out_height) = if width >= height {
        (
            ANALYSIS_LONG_EDGE.min(width),
            ((height as f64 * ANALYSIS_LONG_EDGE as f64 / width as f64).round() as usize)
                .max(1)
                .min(height),
        )
    } else {
        (
            ((width as f64 * ANALYSIS_LONG_EDGE as f64 / height as f64).round() as usize)
                .max(1)
                .min(width),
            ANALYSIS_LONG_EDGE.min(height),
        )
    };
    let output = resize::resample(
        &quantized,
        width,
        height,
        out_width,
        out_height,
        Filter::Area,
    );
    (output, out_width, out_height)
}

#[inline]
fn analysis_code_reference(value: f32) -> usize {
    let encoded = libm::pow(
        f64::from(value).clamp(0.0, WORKING_COPY_MAX) / WORKING_COPY_MAX,
        1.0 / GAMMA,
    );
    libm::round(encoded * 65535.0) as usize
}

#[inline]
fn quantize_analysis_sample(
    value: f32,
    exposure: f32,
    encoder: Option<&AnalysisEncoder>,
    decode: &[f32],
) -> f32 {
    let code = match encoder {
        Some(encoder) => encoder.encode(value),
        None => analysis_code_reference(value),
    };
    decode[code] * exposure
}

const ANALYSIS_ENCODE_BINS: usize = 65536;
static ANALYSIS_ENCODER: OnceLock<AnalysisEncoder> = OnceLock::new();

/// First f32 input mapping to each unsigned 16-bit code. The inverse power
/// only seeds the search: the frozen forward pow/round expression decides
/// every boundary, including adjacent f32 inputs on either side.
struct AnalysisEncoder {
    thresholds: Box<[f32]>,
    bin_starts: Box<[u16]>,
}

impl AnalysisEncoder {
    fn new() -> Self {
        let mut thresholds = Vec::with_capacity(65535);
        let mut previous = 0;
        for code in 1..=65535 {
            let guess = (WORKING_COPY_MAX * libm::pow((code as f64 - 0.5) / 65535.0, GAMMA)) as f32;
            let mut bits = guess.to_bits().max(previous);
            while bits > previous && analysis_code_reference(f32::from_bits(bits - 1)) >= code {
                bits -= 1;
            }
            while analysis_code_reference(f32::from_bits(bits)) < code {
                bits += 1;
            }
            previous = bits;
            thresholds.push(f32::from_bits(bits));
        }
        let bin_starts = (0..=ANALYSIS_ENCODE_BINS)
            .map(|i| {
                let x = i as f32 / 32768.0;
                thresholds.partition_point(|threshold| *threshold <= x) as u16
            })
            .collect::<Vec<_>>()
            .into_boxed_slice();
        Self {
            thresholds: thresholds.into_boxed_slice(),
            bin_starts,
        }
    }

    #[inline]
    fn encode(&self, value: f32) -> usize {
        if value.is_nan() || value <= 0.0 {
            return 0;
        }
        if value >= WORKING_COPY_MAX as f32 {
            return 65535;
        }
        // Power-of-two scaling gives exact bin endpoints. Search only the
        // code interval in this bin; near zero a bin spans many codes.
        let bin = (value * 32768.0) as usize;
        let mut low = self.bin_starts[bin] as usize;
        let mut high = self.bin_starts[bin + 1] as usize;
        while low < high {
            let middle = low + (high - low) / 2;
            if self.thresholds[middle] <= value {
                low = middle + 1;
            } else {
                high = middle;
            }
        }
        low
    }
}

fn analysis_encoder() -> &'static AnalysisEncoder {
    ANALYSIS_ENCODER.get_or_init(AnalysisEncoder::new)
}

/// Exact decoded values of the frozen unsigned 16-bit gamma-1.8 analysis
/// copy. The code-dependent `pow` is memoized; the f64-to-f32 cast and
/// exposure multiplication retain their original order.
fn analysis_decode_table() -> &'static [f32] {
    static TABLE: OnceLock<Box<[f32]>> = OnceLock::new();
    TABLE.get_or_init(|| {
        (0..=65535)
            .map(|code| (WORKING_COPY_MAX * libm::pow(code as f64 / 65535.0, GAMMA)) as f32)
            .collect::<Vec<_>>()
            .into_boxed_slice()
    })
}

fn resize_plane_bilinear(
    source: &[f32],
    in_width: usize,
    in_height: usize,
    out_width: usize,
    out_height: usize,
) -> Vec<f32> {
    let mut output = vec![0.0; out_width * out_height];
    let scale_x = in_width as f64 / out_width as f64;
    let scale_y = in_height as f64 / out_height as f64;
    for y in 0..out_height {
        let sy = ((y as f64 + 0.5) * scale_y - 0.5).clamp(0.0, (in_height - 1) as f64);
        let y0 = libm::floor(sy) as usize;
        let y1 = (y0 + 1).min(in_height - 1);
        let ty = (sy - y0 as f64) as f32;
        for x in 0..out_width {
            let sx = ((x as f64 + 0.5) * scale_x - 0.5).clamp(0.0, (in_width - 1) as f64);
            let x0 = libm::floor(sx) as usize;
            let x1 = (x0 + 1).min(in_width - 1);
            let tx = (sx - x0 as f64) as f32;
            let top = source[y0 * in_width + x0]
                + tx * (source[y0 * in_width + x1] - source[y0 * in_width + x0]);
            let bottom = source[y1 * in_width + x0]
                + tx * (source[y1 * in_width + x1] - source[y1 * in_width + x0]);
            output[y * out_width + x] = top + ty * (bottom - top);
        }
    }
    output
}

fn apply_rgb_texture(data: &mut [f32], width: usize, height: usize, amount: f64) {
    let params = SpatialParams {
        highlights: 0.0,
        shadows: 0.0,
        texture: amount,
        clarity: 0.0,
        scale_px: spatial::scale_px(width.max(height) as f64),
        long_edge: width.max(height),
        gain_scale: GainScale::IDENTITY,
        shift: Shift::default(),
        quality: Quality::Final,
    };
    for channel in 0..3 {
        let ln0 = Plane {
            width,
            height,
            data: data
                .chunks_exact(3)
                .map(|pixel| libm::log2f(pixel[channel].max(3e-5)))
                .collect(),
        };
        if let Some(filtered) = spatial::spatial_luminance(&ln0, &params) {
            for ((pixel, after), before) in
                data.chunks_exact_mut(3).zip(filtered.data).zip(ln0.data)
            {
                pixel[channel] *= libm::exp2f(after - before);
            }
        }
    }
}

fn read_f32(bytes: &[u8], index: usize) -> f32 {
    let offset = index * 4;
    f32::from_le_bytes(bytes[offset..offset + 4].try_into().expect("embedded f32"))
}

/// Frozen V65 owned synthetic 33³ vibrance response.
pub fn vibrance(value: [f64; 3], amount: f64) -> [f64; 3] {
    debug_assert_eq!(VIBRANCE_BYTES.len(), 5 * 33 * 33 * 33 * 3 * 4);
    if amount == 0.0 {
        return value;
    }
    let position = value.map(|v| v.clamp(0.0, 1.0).sqrt() * 32.0);
    let cell = position.map(|v| (v as usize).min(31));
    let fraction = [
        position[0] - cell[0] as f64,
        position[1] - cell[1] as f64,
        position[2] - cell[2] as f64,
    ];
    let sample = |slot: usize| -> [f64; 3] {
        let mut output = [0.0; 3];
        for corner in 0..8 {
            let mut at = [0; 3];
            let mut weight = 1.0;
            for axis in 0..3 {
                let bit = (corner >> axis) & 1;
                at[axis] = cell[axis] + bit;
                weight *= if bit == 0 {
                    1.0 - fraction[axis]
                } else {
                    fraction[axis]
                };
            }
            let index = ((slot * 33 + at[0]) * 33 * 33 + at[1] * 33 + at[2]) * 3;
            for (channel, value) in output.iter_mut().enumerate() {
                *value += weight * f64::from(read_f32(VIBRANCE_BYTES, index + channel));
            }
        }
        output
    };
    let amount = amount.clamp(-100.0, 100.0);
    let delta = if amount > 0.0 && amount <= 21.0 {
        sample(2).map(|v| v * amount / 21.0)
    } else if (-30.0..=0.0).contains(&amount) {
        sample(1).map(|v| v * amount / -30.0)
    } else {
        let (low, high, t) = if amount < -30.0 {
            (0, 1, (amount + 100.0) / 70.0)
        } else if amount <= 50.0 {
            (2, 3, (amount - 21.0) / 29.0)
        } else {
            (3, 4, (amount - 50.0) / 50.0)
        };
        let a = sample(low);
        let b = sample(high);
        [
            a[0] + t * (b[0] - a[0]),
            a[1] + t * (b[1] - a[1]),
            a[2] + t * (b[2] - a[2]),
        ]
    };
    [
        (value[0] + delta[0]).clamp(0.0, 1.0),
        (value[1] + delta[1]).clamp(0.0, 1.0),
        (value[2] + delta[2]).clamp(0.0, 1.0),
    ]
}

/// Frozen R218 residual LUT in encoded sRGB. R236 applies the decoded linear
/// residual before Vibrance / Saturation / HSL; this helper only evaluates
/// the owned encoded-sRGB table.
pub fn profile_lut(mut value: [f32; 3]) -> [f32; 3] {
    debug_assert_eq!(PROFILE_BYTES.len(), 9 * 9 * 9 * 3 * 4);
    value = value.map(|v| v.clamp(0.0, 1.0));
    let position = value.map(|v| v * 8.0);
    let cell = position.map(|v| (v as usize).min(7));
    let fraction = [
        position[0] - cell[0] as f32,
        position[1] - cell[1] as f32,
        position[2] - cell[2] as f32,
    ];
    let mut delta = [0.0; 3];
    for corner in 0..8 {
        let mut at = [0; 3];
        let mut weight = 1.0;
        for axis in 0..3 {
            let bit = (corner >> axis) & 1;
            at[axis] = cell[axis] + bit;
            weight *= if bit == 0 {
                1.0 - fraction[axis]
            } else {
                fraction[axis]
            };
        }
        let index = ((at[0] * 9 + at[1]) * 9 + at[2]) * 3;
        for (channel, value) in delta.iter_mut().enumerate() {
            *value += weight * read_f32(PROFILE_BYTES, index + channel);
        }
    }
    [
        (value[0] + delta[0]).clamp(0.0, 1.0),
        (value[1] + delta[1]).clamp(0.0, 1.0),
        (value[2] + delta[2]).clamp(0.0, 1.0),
    ]
}

#[cfg(test)]
mod tests {
    use super::*;

    fn quantize_reference(value: f32, exposure: f32) -> f32 {
        let encoded = libm::pow(
            f64::from(value).clamp(0.0, WORKING_COPY_MAX) / WORKING_COPY_MAX,
            1.0 / GAMMA,
        );
        let code = libm::round(encoded * 65535.0);
        (WORKING_COPY_MAX * libm::pow(code / 65535.0, GAMMA)) as f32 * exposure
    }

    #[test]
    fn analysis_decode_memoization_is_bit_exact() {
        for (code, actual) in analysis_decode_table().iter().enumerate() {
            let expected = (WORKING_COPY_MAX * libm::pow(code as f64 / 65535.0, GAMMA)) as f32;
            assert_eq!(actual.to_bits(), expected.to_bits(), "code {code}");
        }

        let mut samples = vec![f32::from_bits(1), -2.0, -0.0, 0.0, 1.0, 2.0, f32::MAX];
        let mut bits = 0x243f_6a88u32;
        for _ in 0..100_000 {
            bits = bits.wrapping_mul(1_664_525).wrapping_add(1_013_904_223);
            let value = f32::from_bits(bits);
            if value.is_finite() {
                samples.push(value);
            }
        }
        for baseline_ev in [-8.0, 0.0, 0.25, 8.0] {
            let exposure = libm::exp2(baseline_ev) as f32;
            for value in &samples {
                for encoder in [None, Some(analysis_encoder())] {
                    assert_eq!(
                        quantize_analysis_sample(
                            *value,
                            exposure,
                            encoder,
                            analysis_decode_table()
                        )
                        .to_bits(),
                        quantize_reference(*value, exposure).to_bits(),
                        "value {value:?}, baseline {baseline_ev}"
                    );
                }
            }
        }
    }

    #[test]
    fn analysis_encoder_matches_every_rounding_boundary_and_uniform_bin() {
        let encoder = analysis_encoder();
        for &threshold in &encoder.thresholds {
            let bits = threshold.to_bits();
            for nearby in bits - 3..=bits + 3 {
                let value = f32::from_bits(nearby);
                assert_eq!(
                    encoder.encode(value),
                    analysis_code_reference(value),
                    "{value:?}"
                );
            }
        }
        for bin in 0..=ANALYSIS_ENCODE_BINS {
            let bits = (bin as f32 / 32768.0).to_bits();
            for nearby in bits.saturating_sub(1)..=bits + 1 {
                let value = f32::from_bits(nearby);
                assert_eq!(
                    encoder.encode(value),
                    analysis_code_reference(value),
                    "{value:?}"
                );
            }
        }
        let mut state = 0x65a1_3057u32;
        for _ in 0..250_000 {
            state = state.wrapping_mul(1_664_525).wrapping_add(1_013_904_223);
            let value = (state as f64 / u32::MAX as f64 * WORKING_COPY_MAX) as f32;
            assert_eq!(
                encoder.encode(value),
                analysis_code_reference(value),
                "{value:?}"
            );
        }
    }

    #[test]
    fn zero_cnr_cache_borrows_session_source_and_invalidates_across_amounts() {
        let image = LinearImage {
            width: 3,
            height: 2,
            data: vec![
                -0.1, 0.2, 1.4, 0.4, 0.3, 0.2, 2.1, 0.5, -0.2, 0.7, 0.8, 0.9, 0.1, 0.2, 0.3, 0.9,
                1.0, 1.1,
            ],
        };
        let meta = WorkingCopyMeta::Raster {
            icc_sha256: "test".into(),
        };
        let mut settings = DevelopSettings::neutral();

        let zero = prepare(&image, &meta, &settings, None, false, None, None).unwrap();
        assert!(matches!(&*zero.analysis.cnr_source, CnrSource::Original));
        assert_eq!(zero.image.data, image.data);

        settings.color_noise_reduction = 25.0;
        let filtered = prepare(
            &image,
            &meta,
            &settings,
            None,
            false,
            None,
            Some(zero.analysis),
        )
        .unwrap();
        assert!(matches!(
            &*filtered.analysis.cnr_source,
            CnrSource::Filtered(_)
        ));

        settings.color_noise_reduction = 0.0;
        let restored = prepare(
            &image,
            &meta,
            &settings,
            None,
            false,
            None,
            Some(filtered.analysis),
        )
        .unwrap();
        assert!(matches!(
            &*restored.analysis.cnr_source,
            CnrSource::Original
        ));
        assert_eq!(restored.image.data, image.data);

        let invalid_length = LinearImage {
            width: 1,
            height: 1,
            data: vec![0.0, 0.0],
        };
        assert!(matches!(
            prepare(&invalid_length, &meta, &settings, None, false, None, None),
            Err(PrepareError::Chroma(
                crate::raw_chroma::RawChromaError::InvalidLength { .. }
            ))
        ));
        let non_finite = LinearImage {
            width: 1,
            height: 1,
            data: vec![0.0, f32::NAN, 0.0],
        };
        assert!(matches!(
            prepare(&non_finite, &meta, &settings, None, false, None, None),
            Err(PrepareError::Chroma(
                crate::raw_chroma::RawChromaError::NonFiniteInput(1)
            ))
        ));
        settings.color_noise_reduction = -1.0;
        assert!(matches!(
            prepare(&image, &meta, &settings, None, false, None, None),
            Err(PrepareError::Chroma(
                crate::raw_chroma::RawChromaError::InvalidAmount(-1.0)
            ))
        ));
    }
}
