//! Lightroom's Detail panel (sharpening, luminance and color noise
//! reduction) <-> v6 `developSettings.detail` (Issue #32).
//!
//! Photo Bench never rendered these, so like the NIHO effects they bypass
//! its parser and the converter. Reading follows Lightroom's preset patch:
//! only the keys an XMP carries replace the photo's values. A key missing
//! next to one that is present takes the photo's value, else NIHO's default,
//! which equals Camera Raw's default for the companions (`SharpenRadius`
//! 1.0, `SharpenDetail` 25, `SharpenEdgeMasking` 0, `LuminanceSmoothing` 0).
//! Camera Raw's per-file-type defaults for an *absent* amount (RAW:
//! `Sharpness` 40 / `ColorNoiseReduction` 25; JPEG and other rendered
//! files: 0 / 0) are deliberately not injected: NIHO's neutral render keeps
//! every existing pixel, so only a value the XMP actually writes acts.
//!
//! The `detail` object is created only when it changes something the old
//! fields cannot express: active sharpening (or non-default companions),
//! luminance NR, or a color NR that the legacy top-level field does not
//! render (any amount on a raster / unsigned-RAW engine, more than 50 on a
//! signed RAW engine whose frozen R209 path saturates at 50). Otherwise the
//! settings keep their shape version, so a preset whose detail values are
//! all zero does not force `v: 6`.

use super::{swift_double, Level, XmpDocument};
use crate::settings::{
    DetailSettings, DevelopSettings, SharpeningSettings, ENGINE_NIHO_11, ENGINE_NIHO_3,
    ENGINE_NIHO_4, ENGINE_NIHO_5, ENGINE_NIHO_7,
};

/// `Sharpness` (Camera Raw: Integer 0..150).
pub(super) const SHARPNESS_RANGE: (f64, f64) = (0.0, 150.0);
/// `SharpenRadius` (Camera Raw: Real 0.5..3.0).
pub(super) const SHARPEN_RADIUS_RANGE: (f64, f64) = (0.5, 3.0);
/// `SharpenDetail`, `SharpenEdgeMasking`, `LuminanceSmoothing`,
/// `ColorNoiseReduction` and their companions (Integer 0..100).
pub(super) const PERCENT_RANGE: (f64, f64) = (0.0, 100.0);

/// Every Detail-panel key this module reads or reports.
pub const DETAIL_KEYS: [&str; 10] = [
    "Sharpness",
    "SharpenRadius",
    "SharpenDetail",
    "SharpenEdgeMasking",
    "LuminanceSmoothing",
    "LuminanceNoiseReductionDetail",
    "LuminanceNoiseReductionContrast",
    "ColorNoiseReduction",
    "ColorNoiseReductionDetail",
    "ColorNoiseReductionSmoothness",
];

/// Camera Raw's defaults of the sub-controls NIHO renders with a fixed
/// characteristic.
const LUMINANCE_DETAIL_DEFAULT: f64 = 50.0;
const LUMINANCE_CONTRAST_DEFAULT: f64 = 0.0;
const COLOR_SUB_DEFAULT: f64 = 50.0;
/// The frozen R209 path renders the legacy top-level amount up to this.
const LEGACY_RAW_CNR_MAX: f64 = 50.0;

const NOTE_SHARPEN: &str =
    "出力解像度の線形光・輝度だけの USM（エッジマスク付き）で近似。Lightroom との統計比較は未実施";
const NOTE_SHARPEN_OFF: &str = "シャープの量が 0 なので効果なし";
const NOTE_LUMINANCE: &str =
    "局所階調の前の輝度ガイド付きフィルタで近似。Lightroom との統計比較は未実施";
const NOTE_LUMINANCE_OFF: &str = "輝度のノイズ軽減が 0 なので効果なし";
const NOTE_LUMINANCE_SUB_DEFAULT: &str =
    "Lightroom の既定（ディテール 50・コントラスト 0）の特性として描く（値は保持）";
const NOTE_LUMINANCE_SUB_KEPT: &str =
    "既定（ディテール 50・コントラスト 0）以外は値を保持するのみ（描画は既定の特性）";
const NOTE_COLOR_RAW: &str =
    "signed RAW は R209 の guided CNR（0..50 は Lightroom 近似、50 を超える範囲は NIHO の延長）";
const NOTE_COLOR_RASTER: &str =
    "R209 と同じ guided CNR を JPEG / PNG / 旧 RAW にも当てる（50 を超える範囲は NIHO の延長。Lightroom との統計比較は未実施）";
const NOTE_COLOR_OFF: &str = "カラーノイズの軽減が 0 なので効果なし";
const NOTE_COLOR_SUB_DEFAULT: &str =
    "frozen CNR の特性（ディテール・滑らかさ 50）として描く（値は保持）";
const NOTE_COLOR_SUB_KEPT: &str = "50 以外は値を保持するのみ（描画は 50 の特性）";

/// Engines whose signed RAW path renders the legacy top-level
/// `colorNoiseReduction` (R209, saturating at 50).
pub(super) fn renders_legacy_raw_cnr(engine: &str) -> bool {
    matches!(
        engine,
        ENGINE_NIHO_3 | ENGINE_NIHO_4 | ENGINE_NIHO_5 | ENGINE_NIHO_7 | ENGINE_NIHO_11
    )
}

/// The color NR amount `settings` render: the explicit v6 value, else the
/// legacy top-level amount on a signed RAW engine (capped like R209), else 0.
pub(super) fn effective_color_noise_reduction(settings: &DevelopSettings) -> f64 {
    match settings
        .detail
        .and_then(|detail| detail.color_noise_reduction)
    {
        Some(amount) => amount,
        None if renders_legacy_raw_cnr(&settings.engine) => {
            settings.color_noise_reduction.min(LEGACY_RAW_CNR_MAX)
        }
        None => 0.0,
    }
}

impl XmpDocument {
    fn detail_number(&self, key: &str, range: (f64, f64)) -> Option<f64> {
        self.optional_number(key).map(|v| v.clamp(range.0, range.1))
    }

    /// Replaces the Detail-panel values of `s` this XMP carries (finite
    /// values, clamped). Call after `s.engine` and the legacy top-level
    /// color NR are final.
    pub fn apply_detail(&self, s: &mut DevelopSettings) {
        let amount = self.detail_number("Sharpness", SHARPNESS_RANGE);
        let radius = self.detail_number("SharpenRadius", SHARPEN_RADIUS_RANGE);
        let detail = self.detail_number("SharpenDetail", PERCENT_RANGE);
        let masking = self.detail_number("SharpenEdgeMasking", PERCENT_RANGE);
        let luminance = self.detail_number("LuminanceSmoothing", PERCENT_RANGE);
        let color = self.detail_number("ColorNoiseReduction", PERCENT_RANGE);
        if [amount, radius, detail, masking, luminance, color]
            .iter()
            .all(Option::is_none)
        {
            return;
        }
        let mut next = s.detail.unwrap_or_default();
        let sharpening = &mut next.sharpening;
        if let Some(v) = amount {
            sharpening.amount = v;
        }
        if let Some(v) = radius {
            sharpening.radius = v;
        }
        if let Some(v) = detail {
            sharpening.detail = v;
        }
        if let Some(v) = masking {
            sharpening.masking = v;
        }
        if let Some(v) = luminance {
            next.luminance_noise_reduction = v;
        }
        if let Some(v) = color {
            next.color_noise_reduction = Some(v);
        }
        let legacy_raw = renders_legacy_raw_cnr(&s.engine);
        let needed = s.detail.is_some()
            || next.sharpening != SharpeningSettings::default()
            || next.luminance_noise_reduction != 0.0
            || next.color_noise_reduction.is_some_and(|v| {
                if legacy_raw {
                    v > LEGACY_RAW_CNR_MAX
                } else {
                    v > 0.0
                }
            });
        if needed {
            s.detail = Some(next);
        }
    }

    /// NIHO level and note of a Detail-panel key, `None` for other keys.
    /// Photo Bench rendered none of them (its level is `unsupported`).
    pub(super) fn detail_level(
        &self,
        key: &str,
        raw: &str,
        settings: &DevelopSettings,
    ) -> Option<(Level, Level, String)> {
        if !DETAIL_KEYS.contains(&key) {
            return None;
        }
        let detail = settings.detail.unwrap_or_default();
        let value = swift_double(raw);
        let (level, note) = match key {
            "Sharpness" | "SharpenRadius" | "SharpenDetail" | "SharpenEdgeMasking" => {
                if detail.sharpening.amount == 0.0 {
                    (Level::Exact, NOTE_SHARPEN_OFF)
                } else {
                    (Level::Approximate, NOTE_SHARPEN)
                }
            }
            "LuminanceSmoothing" => {
                if detail.luminance_noise_reduction == 0.0 {
                    (Level::Exact, NOTE_LUMINANCE_OFF)
                } else {
                    (Level::Approximate, NOTE_LUMINANCE)
                }
            }
            "LuminanceNoiseReductionDetail" | "LuminanceNoiseReductionContrast" => {
                let default = if key == "LuminanceNoiseReductionDetail" {
                    LUMINANCE_DETAIL_DEFAULT
                } else {
                    LUMINANCE_CONTRAST_DEFAULT
                };
                if detail.luminance_noise_reduction == 0.0 {
                    (Level::Exact, NOTE_LUMINANCE_OFF)
                } else if value == Some(default) {
                    (Level::Approximate, NOTE_LUMINANCE_SUB_DEFAULT)
                } else {
                    (Level::Unsupported, NOTE_LUMINANCE_SUB_KEPT)
                }
            }
            "ColorNoiseReduction" => {
                if effective_color_noise_reduction(settings) == 0.0 {
                    (Level::Exact, NOTE_COLOR_OFF)
                } else if renders_legacy_raw_cnr(&settings.engine) {
                    (Level::Approximate, NOTE_COLOR_RAW)
                } else {
                    (Level::Approximate, NOTE_COLOR_RASTER)
                }
            }
            _ => {
                // ColorNoiseReductionDetail / ColorNoiseReductionSmoothness
                if effective_color_noise_reduction(settings) == 0.0 {
                    (Level::Exact, NOTE_COLOR_OFF)
                } else if value == Some(COLOR_SUB_DEFAULT) {
                    (Level::Approximate, NOTE_COLOR_SUB_DEFAULT)
                } else {
                    (Level::Unsupported, NOTE_COLOR_SUB_KEPT)
                }
            }
        };
        Some((Level::Unsupported, level, note.into()))
    }
}

/// `DetailSettings` with every amount moved from `base` to `full` at `t`
/// (preset amount). A side without `detail` stands for NIHO's default and,
/// for color NR, for what it renders today (`effective`).
pub(super) fn blend_detail(
    base: &DevelopSettings,
    full: &DevelopSettings,
    t: f64,
    mix_in: impl Fn(f64, f64, f64, (f64, f64)) -> f64,
) -> Option<DetailSettings> {
    let after = full.detail?;
    let before = base.detail.unwrap_or_default();
    let color = after.color_noise_reduction.map(|f| {
        let b = before
            .color_noise_reduction
            .unwrap_or_else(|| effective_color_noise_reduction(base));
        mix_in(b, f, t, PERCENT_RANGE)
    });
    Some(DetailSettings {
        sharpening: SharpeningSettings {
            amount: mix_in(
                before.sharpening.amount,
                after.sharpening.amount,
                t,
                SHARPNESS_RANGE,
            ),
            radius: mix_in(
                before.sharpening.radius,
                after.sharpening.radius,
                t,
                SHARPEN_RADIUS_RANGE,
            ),
            detail: mix_in(
                before.sharpening.detail,
                after.sharpening.detail,
                t,
                PERCENT_RANGE,
            ),
            masking: mix_in(
                before.sharpening.masking,
                after.sharpening.masking,
                t,
                PERCENT_RANGE,
            ),
        },
        luminance_noise_reduction: mix_in(
            before.luminance_noise_reduction,
            after.luminance_noise_reduction,
            t,
            PERCENT_RANGE,
        ),
        color_noise_reduction: color.or(before.color_noise_reduction),
    })
}
