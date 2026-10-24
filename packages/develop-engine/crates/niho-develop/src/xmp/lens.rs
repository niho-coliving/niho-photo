//! Lightroom's Lens Corrections panel <-> `developSettings.lens`
//! (niho-photo#45).
//!
//! Photo Bench rendered none of these, so like the NIHO effects they bypass
//! its parser and the converter: only the keys an XMP carries replace the
//! photo's values (clamped into range).
//!
//! - `LensManualDistortionAmount` (`-100..100`) -> `distortion`, the same
//!   sign. NIHO's positive straightens a barrel; that Lightroom's does too
//!   is not calibrated.
//! - `VignetteAmount` / `VignetteMidpoint` (the lens's manual vignetting,
//!   not the post-crop vignette `PostCropVignette*`) -> `vignetting` /
//!   `vignettingMidpoint`.
//! - `AutoLateralCA` (`0` / `1`) -> `removeChromaticAberration`.
//! - `DefringePurpleAmount` / `DefringeGreenAmount` (Lightroom's `0..20`)
//!   -> `defringe.<color>.amount` times 5 (`0..100`); `Defringe*HueLo / Hi`
//!   (`0..100`) as they are (a reversed pair is put in order).
//! - Profile corrections (`LensProfile*`) are not rendered: the RAW working
//!   copy already carries the camera's (the sidecar bakes them, owner
//!   decision 2026-09-29) and a JPEG / PNG its camera's. `LensProfileEnable
//!   = 1` and the profile's names are kept as metadata (nothing to report);
//!   `LensProfileEnable = 0` (turning it off) and profile amounts other than
//!   100 cannot be applied and are `unsupported`.
//! - Process 2010's single `Defringe` switch is `unsupported` unless 0.

use super::{swift_double, Level, XmpDocument};
use crate::lens::Lens;
use crate::settings::DevelopSettings;

/// The Lens Corrections keys NIHO renders.
pub const LENS_KEYS: [&str; 10] = [
    "LensManualDistortionAmount",
    "VignetteAmount",
    "VignetteMidpoint",
    "AutoLateralCA",
    "DefringePurpleAmount",
    "DefringePurpleHueLo",
    "DefringePurpleHueHi",
    "DefringeGreenAmount",
    "DefringeGreenHueLo",
    "DefringeGreenHueHi",
];

/// Lightroom's fringe amount slider (`0..20`) per NIHO's `0..100`.
pub(super) const DEFRINGE_AMOUNT_SCALE: f64 = 5.0;
pub(super) const SIGNED_RANGE: (f64, f64) = (-100.0, 100.0);
pub(super) const PERCENT_RANGE: (f64, f64) = (0.0, 100.0);
pub(super) const DEFRINGE_AMOUNT_RANGE: (f64, f64) = (0.0, 20.0);

/// The range a lens key's XMP value is clamped into.
pub(super) fn lens_range(key: &str) -> Option<(f64, f64)> {
    match key {
        "LensManualDistortionAmount" | "VignetteAmount" => Some(SIGNED_RANGE),
        "DefringePurpleAmount" | "DefringeGreenAmount" => Some(DEFRINGE_AMOUNT_RANGE),
        "VignetteMidpoint"
        | "DefringePurpleHueLo"
        | "DefringePurpleHueHi"
        | "DefringeGreenHueLo"
        | "DefringeGreenHueHi" => Some(PERCENT_RANGE),
        _ => None,
    }
}

const NOTE_NONE: &str = "効果なし（既定値）";
const NOTE_DISTORTION: &str =
    "NIHO の放射状の近似モデル（向き・大きさは Lightroom の実測による校正は未実施）";
const NOTE_VIGNETTING: &str =
    "線形光の放射状のゲイン（NIHO の近似。Lightroom の実測による校正は未実施）";
const NOTE_VIGNETTING_OFF: &str = "レンズの周辺光量の補正が 0 なので効果なし";
const NOTE_CA: &str = "写真から推定した赤・青の倍率のずれを補正（NIHO の推定）";
const NOTE_DEFRINGE: &str =
    "強い縁の近くの紫・緑を中立に寄せる（NIHO の近似。Lightroom の実測による校正は未実施）";
const NOTE_DEFRINGE_OFF: &str = "その色のフリンジ軽減が 0 なので効果なし";
const NOTE_PROFILE_ON: &str =
    "プロファイルの補正は RAW の作業コピーで適用済み（JPEG / PNG はカメラの補正のまま）";
const NOTE_PROFILE_OFF: &str = "作業コピーに焼き込み済みのプロファイルの補正は切れない";
const NOTE_PROFILE_SCALE: &str = "プロファイルの補正の量は変えられない（100 として描く）";
const NOTE_PROFILE_KEPT: &str = "値を保持（プロファイルの補正は作業コピーで適用）";
const NOTE_LEGACY_DEFRINGE: &str = "旧方式（PV2010）のフリンジ軽減は未対応";

impl XmpDocument {
    fn lens_number(&self, key: &str) -> Option<f64> {
        let (lo, hi) = lens_range(key)?;
        self.optional_number(key)
            .filter(|v| v.is_finite())
            .map(|v| v.clamp(lo, hi))
    }

    /// Replaces the Lens Corrections values of `s` this XMP carries.
    pub fn apply_lens(&self, s: &mut DevelopSettings) {
        let mut lens: Lens = s.lens;
        if let Some(v) = self.lens_number("LensManualDistortionAmount") {
            lens.distortion = v;
        }
        if let Some(v) = self.lens_number("VignetteAmount") {
            lens.vignetting = v;
        }
        if let Some(v) = self.lens_number("VignetteMidpoint") {
            lens.vignetting_midpoint = v;
        }
        match self.optional_number("AutoLateralCA") {
            Some(0.0) => lens.remove_chromatic_aberration = false,
            Some(1.0) => lens.remove_chromatic_aberration = true,
            _ => {}
        }
        for (prefix, band) in [
            ("DefringePurple", &mut lens.defringe.purple),
            ("DefringeGreen", &mut lens.defringe.green),
        ] {
            if let Some(v) = self.lens_number(&format!("{prefix}Amount")) {
                band.amount = v * DEFRINGE_AMOUNT_SCALE;
            }
            if let Some(v) = self.lens_number(&format!("{prefix}HueLo")) {
                band.hue_lo = v;
            }
            if let Some(v) = self.lens_number(&format!("{prefix}HueHi")) {
                band.hue_hi = v;
            }
            if band.hue_lo > band.hue_hi {
                std::mem::swap(&mut band.hue_lo, &mut band.hue_hi);
            }
        }
        s.lens = lens;
    }

    fn profile_on(&self) -> bool {
        self.optional_number("LensProfileEnable") == Some(1.0)
    }

    /// NIHO level and note of a Lens Corrections key (`settings`: what
    /// renders after the XMP), `None` for other keys. Photo Bench rendered
    /// none of them (its level is `unsupported`).
    pub(super) fn lens_level(
        &self,
        key: &str,
        raw: &str,
        settings: &DevelopSettings,
    ) -> Option<(Level, Level, String)> {
        let lens = &settings.lens;
        let value = swift_double(raw);
        let zero = value == Some(0.0);
        let (level, note) = match key {
            "LensManualDistortionAmount" => {
                if lens.distortion == 0.0 {
                    (Level::Exact, NOTE_NONE)
                } else {
                    (Level::Approximate, NOTE_DISTORTION)
                }
            }
            "VignetteAmount" => {
                if lens.vignetting == 0.0 {
                    (Level::Exact, NOTE_NONE)
                } else {
                    (Level::Approximate, NOTE_VIGNETTING)
                }
            }
            "VignetteMidpoint" => {
                if lens.vignetting == 0.0 {
                    (Level::Exact, NOTE_VIGNETTING_OFF)
                } else {
                    (Level::Approximate, NOTE_VIGNETTING)
                }
            }
            "AutoLateralCA" => match value {
                Some(0.0) => (Level::Exact, NOTE_NONE),
                Some(1.0) => (Level::Approximate, NOTE_CA),
                _ => (Level::Unsupported, "0 / 1 以外は適用しない"),
            },
            "DefringePurpleAmount"
            | "DefringePurpleHueLo"
            | "DefringePurpleHueHi"
            | "DefringeGreenAmount"
            | "DefringeGreenHueLo"
            | "DefringeGreenHueHi" => {
                let band = if key.starts_with("DefringePurple") {
                    &lens.defringe.purple
                } else {
                    &lens.defringe.green
                };
                if band.amount == 0.0 {
                    (Level::Exact, NOTE_DEFRINGE_OFF)
                } else {
                    (Level::Approximate, NOTE_DEFRINGE)
                }
            }
            "LensProfileEnable" => match value {
                Some(1.0) => (Level::Metadata, NOTE_PROFILE_ON),
                Some(0.0) => (Level::Unsupported, NOTE_PROFILE_OFF),
                _ => (Level::Unsupported, "0 / 1 以外は適用しない"),
            },
            "LensProfileDistortionScale"
            | "LensProfileVignettingScale"
            | "LensProfileChromaticAberrationScale" => {
                if self.profile_on() && value != Some(100.0) {
                    (Level::Unsupported, NOTE_PROFILE_SCALE)
                } else {
                    (Level::Metadata, NOTE_PROFILE_KEPT)
                }
            }
            _ if key.starts_with("LensProfile") => (Level::Metadata, NOTE_PROFILE_KEPT),
            "Defringe" => {
                if zero {
                    (Level::Exact, NOTE_NONE)
                } else {
                    (Level::Unsupported, NOTE_LEGACY_DEFRINGE)
                }
            }
            _ => return None,
        };
        Some((Level::Unsupported, level, note.into()))
    }
}

/// `lens` moved from `base` to `full` at `t` (preset amount): the numbers
/// linearly, stopped at their ranges; the switch and the hue ranges are the
/// preset's above 0%.
pub(super) fn blend_lens(
    base: &Lens,
    full: &Lens,
    t: f64,
    mix_in: impl Fn(f64, f64, f64, (f64, f64)) -> f64,
) -> Lens {
    let mut r = *full;
    r.distortion = mix_in(base.distortion, full.distortion, t, SIGNED_RANGE);
    r.vignetting = mix_in(base.vignetting, full.vignetting, t, SIGNED_RANGE);
    r.vignetting_midpoint = mix_in(
        base.vignetting_midpoint,
        full.vignetting_midpoint,
        t,
        PERCENT_RANGE,
    );
    r.defringe.purple.amount = mix_in(
        base.defringe.purple.amount,
        full.defringe.purple.amount,
        t,
        PERCENT_RANGE,
    );
    r.defringe.green.amount = mix_in(
        base.defringe.green.amount,
        full.defringe.green.amount,
        t,
        PERCENT_RANGE,
    );
    r
}
