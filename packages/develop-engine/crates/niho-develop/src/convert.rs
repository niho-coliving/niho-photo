//! Versioned, pure conversion from Photo Bench `EditSettings` JSON
//! (`ENGINE_PROTOCOL.md` "編集設定") to `developSettings` v1.
//!
//! Rules (spec "段 2"): values are copied with the same name and unit only
//! when finite and within range (no rounding, no clamping). The ten basic
//! sliders must also be integers. `whiteBalance.mode: "custom"` with a finite
//! 2000..50000K temperature and -150..150 tint becomes `absolute`. A Custom
//! white with only non-zero incremental temperature / tint becomes `niho-2`
//! relative white balance. Anything
//! unsupported, invalid or unknown is kept verbatim in `legacySettings`, and
//! the conversion is then **not** successful (S7 keeps such photos on the
//! Photo Bench rendering). The input value is never modified.

use crate::settings::{
    self, CalibrationSettings, ColorGradingSettings, DevelopSettings, HslAdjustments, ToneCurve,
    WhiteBalance, WhiteBalanceMode, ABSOLUTE_TEMPERATURE_RANGE, ABSOLUTE_TINT_RANGE, ENGINE_NIHO_2,
};
use serde_json::{Map, Value};

/// Converter version: bump when a rule changes.
pub const CONVERTER_VERSION: &str = "photo-bench-edit-settings-to-develop-v3";

/// One reason a key did not convert (or a note about how it converted).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ConvertIssue {
    /// JSON path in the input (`exposure`, `whiteBalance.temperature`, ...).
    pub path: String,
    /// `invalidType | notFinite | outOfRange | notInteger | unsupported |
    /// unknownKey | invalidValue | conflictingValue` (issues) or
    /// `relativeWins` (note).
    pub code: String,
    pub message: String,
}

impl ConvertIssue {
    pub(crate) fn new(path: &str, code: &str, message: &str) -> Self {
        Self {
            path: path.to_string(),
            code: code.to_string(),
            message: message.to_string(),
        }
    }
}

#[derive(Debug, Clone)]
pub struct ConvertOutcome {
    pub converter: &'static str,
    /// The converted settings; failing keys hold neutral values and their
    /// originals are in `settings.legacy_settings`.
    pub settings: DevelopSettings,
    /// `true` only when every key converted.
    pub ok: bool,
    pub issues: Vec<ConvertIssue>,
    /// Defined-but-lossy rules that applied (`relativeWins`).
    pub notes: Vec<ConvertIssue>,
}

/// The ten sliders the spec copies as integers.
const INTEGER_SLIDERS: [&str; 10] = [
    "contrast",
    "highlights",
    "shadows",
    "whites",
    "blacks",
    "texture",
    "clarity",
    "dehaze",
    "vibrance",
    "saturation",
];

struct Ctx {
    issues: Vec<ConvertIssue>,
    legacy: Map<String, Value>,
}

impl Ctx {
    fn fail(&mut self, key: &str, original: &Value, issue: ConvertIssue) {
        self.issues.push(issue);
        self.legacy
            .entry(key.to_string())
            .or_insert_with(|| original.clone());
    }
}

fn finite(v: &Value) -> Result<f64, (&'static str, &'static str)> {
    let n = v.as_f64().ok_or(("invalidType", "must be a number"))?;
    if !n.is_finite() {
        return Err(("notFinite", "must be finite"));
    }
    Ok(n)
}

fn ranged(v: &Value, lo: f64, hi: f64, integer: bool) -> Result<f64, (&'static str, String)> {
    let n = finite(v).map_err(|(c, m)| (c, m.to_string()))?;
    if n < lo || n > hi {
        return Err(("outOfRange", format!("must be within {lo}..{hi}")));
    }
    if integer && n != libm::trunc(n) {
        return Err(("notInteger", "must be an integer".to_string()));
    }
    Ok(n)
}

/// Converts Photo Bench `EditSettings` JSON. `base` is the working-copy
/// `baseVersion` to record (`None` for a JPEG/PNG original).
pub fn convert_edit_settings(input: &Value, base: Option<&str>) -> ConvertOutcome {
    let mut out = DevelopSettings::neutral();
    out.base = base.map(str::to_string);
    let mut ctx = Ctx {
        issues: Vec::new(),
        legacy: Map::new(),
    };
    let mut notes = Vec::new();
    let Some(object) = input.as_object() else {
        ctx.issues.push(ConvertIssue::new(
            "",
            "invalidType",
            "EditSettings must be a JSON object",
        ));
        let mut legacy = Map::new();
        legacy.insert("$".into(), input.clone());
        out.legacy_settings = Some(legacy);
        return ConvertOutcome {
            converter: CONVERTER_VERSION,
            settings: out,
            ok: false,
            issues: ctx.issues,
            notes,
        };
    };

    let mut white_balance_value: Option<&Value> = None;
    for (key, value) in object {
        let k = key.as_str();
        let scalar = |ctx: &mut Ctx, lo: f64, hi: f64, integer: bool| -> Option<f64> {
            match ranged(value, lo, hi, integer) {
                Ok(n) => Some(n),
                Err((code, message)) => {
                    ctx.fail(k, value, ConvertIssue::new(k, code, &message));
                    None
                }
            }
        };
        match k {
            "exposure" => {
                if let Some(n) = scalar(&mut ctx, -5.0, 5.0, false) {
                    out.exposure = n;
                }
            }
            "contrast" | "highlights" | "shadows" | "whites" | "blacks" | "texture" | "clarity"
            | "dehaze" | "vibrance" | "saturation" => {
                debug_assert!(INTEGER_SLIDERS.contains(&k));
                if let Some(n) = scalar(&mut ctx, -100.0, 100.0, true) {
                    let slot = match k {
                        "contrast" => &mut out.contrast,
                        "highlights" => &mut out.highlights,
                        "shadows" => &mut out.shadows,
                        "whites" => &mut out.whites,
                        "blacks" => &mut out.blacks,
                        "texture" => &mut out.texture,
                        "clarity" => &mut out.clarity,
                        "dehaze" => &mut out.dehaze,
                        "vibrance" => &mut out.vibrance,
                        _ => &mut out.saturation,
                    };
                    *slot = n;
                }
            }
            "relativeTemperature"
            | "relativeTint"
            | "parametricShadows"
            | "parametricDarks"
            | "parametricLights"
            | "parametricHighlights" => {
                if let Some(n) = scalar(&mut ctx, -100.0, 100.0, false) {
                    let slot = match k {
                        "relativeTemperature" => &mut out.relative_temperature,
                        "relativeTint" => &mut out.relative_tint,
                        "parametricShadows" => &mut out.parametric_shadows,
                        "parametricDarks" => &mut out.parametric_darks,
                        "parametricLights" => &mut out.parametric_lights,
                        _ => &mut out.parametric_highlights,
                    };
                    *slot = n;
                }
            }
            "parametricShadowSplit" | "parametricMidtoneSplit" | "parametricHighlightSplit" => {
                if let Some(n) = scalar(&mut ctx, 0.0, 100.0, false) {
                    let slot = match k {
                        "parametricShadowSplit" => &mut out.parametric_shadow_split,
                        "parametricMidtoneSplit" => &mut out.parametric_midtone_split,
                        _ => &mut out.parametric_highlight_split,
                    };
                    *slot = n;
                }
            }
            "curveRefineSaturation" => {
                if let Some(n) = scalar(&mut ctx, 0.0, 100.0, false) {
                    if n != 100.0 {
                        ctx.fail(
                            k,
                            value,
                            ConvertIssue::new(
                                k,
                                "unsupported",
                                "only the neutral value 100 is supported by the renderer",
                            ),
                        );
                    } else {
                        out.curve_refine_saturation = n;
                    }
                }
            }
            "whiteBalance" => white_balance_value = Some(value),
            "toneCurves" => match convert_tone_curves(value) {
                Ok(curves) => out.tone_curves = curves,
                Err(issue) => ctx.fail(k, value, issue),
            },
            "hsl" => match convert_hsl(value) {
                Ok(hsl) => out.hsl = hsl,
                Err(issue) => ctx.fail(k, value, issue),
            },
            "calibration" => match convert_calibration(value) {
                Ok(c) => out.calibration = c,
                Err(issue) => ctx.fail(k, value, issue),
            },
            "colorGrading" => match convert_color_grading(value) {
                Ok(g) => out.color_grading = g,
                Err(issue) => ctx.fail(k, value, issue),
            },
            _ => ctx.fail(
                k,
                value,
                ConvertIssue::new(k, "unknownKey", "not an EditSettings key"),
            ),
        }
    }

    if let Some(value) = white_balance_value {
        match convert_white_balance(value, out.relative_temperature, out.relative_tint) {
            Ok(wb) => {
                out.white_balance = wb.white_balance;
                if let Some((temperature, tint)) = wb.incremental {
                    out.relative_temperature = temperature;
                    out.relative_tint = tint;
                    out.engine = ENGINE_NIHO_2.to_string();
                }
            }
            Err(issue) => ctx.fail("whiteBalance", value, issue),
        }
    }
    // Relative values in effect win over absolute / as-shot (spec).
    let relative_set = out.relative_temperature != 0.0 || out.relative_tint != 0.0;
    if relative_set {
        if out.white_balance.mode == WhiteBalanceMode::Absolute {
            notes.push(ConvertIssue::new(
                "whiteBalance",
                "relativeWins",
                "relative temperature/tint and an absolute white balance were both set; relative is used and the absolute values are kept",
            ));
        }
        out.white_balance.mode = WhiteBalanceMode::Relative;
    }

    let ok = ctx.issues.is_empty();
    if !ctx.legacy.is_empty() {
        out.legacy_settings = Some(ctx.legacy);
    }
    ConvertOutcome {
        converter: CONVERTER_VERSION,
        settings: out,
        ok,
        issues: ctx.issues,
        notes,
    }
}

/// Parses JSON text first (convenience for the wasm / CLI boundary).
pub fn convert_edit_settings_json(
    text: &str,
    base: Option<&str>,
) -> Result<ConvertOutcome, settings::SettingsError> {
    let value: Value = serde_json::from_str(text)
        .map_err(|e| settings::SettingsError::new("", "invalidJson", &e.to_string()))?;
    Ok(convert_edit_settings(&value, base))
}

struct ConvertedWhiteBalance {
    white_balance: WhiteBalance,
    incremental: Option<(f64, f64)>,
}

fn convert_white_balance(
    value: &Value,
    top_level_temperature: f64,
    top_level_tint: f64,
) -> Result<ConvertedWhiteBalance, ConvertIssue> {
    let o = value
        .as_object()
        .ok_or_else(|| ConvertIssue::new("whiteBalance", "invalidType", "must be an object"))?;
    for key in o.keys() {
        if !matches!(
            key.as_str(),
            "mode" | "temperature" | "tint" | "incrementalTemperature" | "incrementalTint"
        ) {
            return Err(ConvertIssue::new(
                &format!("whiteBalance.{key}"),
                "unknownKey",
                "not a WhiteBalanceSettings key",
            ));
        }
    }
    let optional = |key: &str| -> Result<Option<f64>, ConvertIssue> {
        match o.get(key) {
            None | Some(Value::Null) => Ok(None),
            Some(v) => finite(v).map(Some).map_err(|(code, message)| {
                ConvertIssue::new(&format!("whiteBalance.{key}"), code, message)
            }),
        }
    };
    let temperature = optional("temperature")?;
    let tint = optional("tint")?;
    let incremental_temperature = optional("incrementalTemperature")?;
    let incremental_tint = optional("incrementalTint")?;
    for (key, value) in [
        ("incrementalTemperature", incremental_temperature),
        ("incrementalTint", incremental_tint),
    ] {
        if value.is_some_and(|v| !(-100.0..=100.0).contains(&v)) {
            return Err(ConvertIssue::new(
                &format!("whiteBalance.{key}"),
                "outOfRange",
                "must be within -100..100",
            ));
        }
    }
    let incremental_active =
        incremental_temperature.unwrap_or(0.0) != 0.0 || incremental_tint.unwrap_or(0.0) != 0.0;
    let mode = o.get("mode").map(|m| m.as_str());
    if incremental_active {
        if top_level_temperature != 0.0 || top_level_tint != 0.0 {
            return Err(ConvertIssue::new(
                "whiteBalance",
                "conflictingValue",
                "top-level relative temperature/tint and nested incremental white balance cannot both be non-zero",
            ));
        }
        if matches!(mode, Some(Some("custom"))) && temperature.is_none() && tint.is_none() {
            return Ok(ConvertedWhiteBalance {
                white_balance: WhiteBalance {
                    mode: WhiteBalanceMode::Relative,
                    temperature: None,
                    tint: None,
                },
                incremental: Some((
                    incremental_temperature.unwrap_or(0.0),
                    incremental_tint.unwrap_or(0.0),
                )),
            });
        }
        return Err(ConvertIssue::new(
            "whiteBalance.incrementalTemperature",
            "unsupported",
            "incremental white balance requires Custom mode without absolute temperature/tint",
        ));
    }
    let white_balance = match mode {
        None | Some(Some("asShot")) => WhiteBalance {
            mode: WhiteBalanceMode::AsShot,
            temperature,
            tint,
        },
        Some(Some("custom")) => match (temperature, tint) {
            (Some(t), Some(tn)) => {
                if t < ABSOLUTE_TEMPERATURE_RANGE.0 || t > ABSOLUTE_TEMPERATURE_RANGE.1 {
                    return Err(ConvertIssue::new(
                        "whiteBalance.temperature",
                        "outOfRange",
                        "must be within 2000..50000",
                    ));
                }
                if tn < ABSOLUTE_TINT_RANGE.0 || tn > ABSOLUTE_TINT_RANGE.1 {
                    return Err(ConvertIssue::new(
                        "whiteBalance.tint",
                        "outOfRange",
                        "must be within -150..150",
                    ));
                }
                WhiteBalance {
                    mode: WhiteBalanceMode::Absolute,
                    temperature: Some(t),
                    tint: Some(tn),
                }
            }
            // Photo Bench renders a custom mode without both values as shot
            // (`Handle.image(settings:)`), e.g. bluesky2's Custom with zero
            // incremental values: same meaning, so it converts exactly.
            (None, None) => WhiteBalance {
                mode: WhiteBalanceMode::AsShot,
                temperature: None,
                tint: None,
            },
            _ => {
                return Err(ConvertIssue::new(
                    "whiteBalance",
                    "invalidValue",
                    "custom white balance needs both temperature and tint",
                ))
            }
        },
        Some(Some("unknown")) => {
            return Err(ConvertIssue::new(
                "whiteBalance.mode",
                "unsupported",
                "unknown white balance mode is not rendered",
            ))
        }
        _ => {
            return Err(ConvertIssue::new(
                "whiteBalance.mode",
                "invalidValue",
                "must be asShot, custom or unknown",
            ))
        }
    };
    Ok(ConvertedWhiteBalance {
        white_balance,
        incremental: None,
    })
}

fn convert_tone_curves(value: &Value) -> Result<Vec<ToneCurve>, ConvertIssue> {
    let curves = settings::parse_tone_curves(value)
        .map_err(|e| ConvertIssue::new(&e.path, &e.code, &e.message))?;
    for (i, curve) in curves.iter().enumerate() {
        for (j, p) in curve.points.iter().enumerate() {
            if !(0.0..=1.0).contains(&p.x) || !(0.0..=1.0).contains(&p.y) {
                return Err(ConvertIssue::new(
                    &format!("toneCurves[{i}].points[{j}]"),
                    "outOfRange",
                    "x and y must be within 0..1",
                ));
            }
        }
    }
    // Unknown keys inside a curve or point are not EditSettings.
    for (i, item) in value.as_array().into_iter().flatten().enumerate() {
        if let Some(o) = item.as_object() {
            if let Some(key) = o.keys().find(|k| *k != "channel" && *k != "points") {
                return Err(ConvertIssue::new(
                    &format!("toneCurves[{i}].{key}"),
                    "unknownKey",
                    "not a ToneCurve key",
                ));
            }
            if let Some(points) = o.get("points").and_then(Value::as_array) {
                for (j, point) in points.iter().enumerate() {
                    if let Some(key) = point
                        .as_object()
                        .and_then(|p| p.keys().find(|k| !matches!(k.as_str(), "x" | "y")))
                    {
                        return Err(ConvertIssue::new(
                            &format!("toneCurves[{i}].points[{j}].{key}"),
                            "unknownKey",
                            "not a ToneCurve point key",
                        ));
                    }
                }
            }
        }
    }
    Ok(curves)
}

fn convert_hsl(value: &Value) -> Result<HslAdjustments, ConvertIssue> {
    let hsl =
        settings::parse_hsl(value).map_err(|e| ConvertIssue::new(&e.path, &e.code, &e.message))?;
    for (band, a) in hsl.entries() {
        for (name, v) in [
            ("hue", a.hue),
            ("saturation", a.saturation),
            ("luminance", a.luminance),
        ] {
            if !(-100.0..=100.0).contains(&v) {
                return Err(ConvertIssue::new(
                    &format!("hsl.{}.{name}", band.as_str()),
                    "outOfRange",
                    "must be within -100..100",
                ));
            }
        }
    }
    let adjustments: Vec<&Value> = match value {
        Value::Array(items) => items.iter().skip(1).step_by(2).collect(),
        Value::Object(map) => map.values().collect(),
        _ => Vec::new(),
    };
    for a in adjustments {
        if let Some(key) = a.as_object().and_then(|o| {
            o.keys()
                .find(|k| !matches!(k.as_str(), "hue" | "saturation" | "luminance"))
        }) {
            return Err(ConvertIssue::new(
                &format!("hsl.{key}"),
                "unknownKey",
                "not an HSLAdjustment key",
            ));
        }
    }
    Ok(hsl)
}

fn convert_calibration(value: &Value) -> Result<CalibrationSettings, ConvertIssue> {
    let c = settings::parse_calibration(value)
        .map_err(|e| ConvertIssue::new(&e.path, &e.code, &e.message))?;
    if let Some(key) = value.as_object().and_then(|o| {
        o.keys().find(|k| {
            !matches!(
                k.as_str(),
                "shadowTint"
                    | "redHue"
                    | "redSaturation"
                    | "greenHue"
                    | "greenSaturation"
                    | "blueHue"
                    | "blueSaturation"
            )
        })
    }) {
        return Err(ConvertIssue::new(
            &format!("calibration.{key}"),
            "unknownKey",
            "not a CalibrationSettings key",
        ));
    }
    for (name, v) in [
        ("shadowTint", c.shadow_tint),
        ("redHue", c.red_hue),
        ("redSaturation", c.red_saturation),
        ("greenHue", c.green_hue),
        ("greenSaturation", c.green_saturation),
        ("blueHue", c.blue_hue),
        ("blueSaturation", c.blue_saturation),
    ] {
        if !(-100.0..=100.0).contains(&v) {
            return Err(ConvertIssue::new(
                &format!("calibration.{name}"),
                "outOfRange",
                "must be within -100..100",
            ));
        }
    }
    Ok(c)
}

fn convert_color_grading(value: &Value) -> Result<ColorGradingSettings, ConvertIssue> {
    let g = settings::parse_color_grading(value)
        .map_err(|e| ConvertIssue::new(&e.path, &e.code, &e.message))?;
    let o = value.as_object().expect("parsed as object");
    for (key, v) in o {
        match key.as_str() {
            "shadow" | "midtone" | "highlight" | "global" => {
                if let Some(inner) = v.as_object().and_then(|b| {
                    b.keys()
                        .find(|k| !matches!(k.as_str(), "hue" | "saturation" | "luminance"))
                }) {
                    return Err(ConvertIssue::new(
                        &format!("colorGrading.{key}.{inner}"),
                        "unknownKey",
                        "not a ColorGradeBand key",
                    ));
                }
            }
            "blending" | "balance" => {}
            other => {
                return Err(ConvertIssue::new(
                    &format!("colorGrading.{other}"),
                    "unknownKey",
                    "not a ColorGradingSettings key",
                ))
            }
        }
    }
    for (name, b) in [
        ("shadow", g.shadow),
        ("midtone", g.midtone),
        ("highlight", g.highlight),
        ("global", g.global),
    ] {
        if !(0.0..=359.0).contains(&b.hue) {
            return Err(ConvertIssue::new(
                &format!("colorGrading.{name}.hue"),
                "outOfRange",
                "must be within 0..359",
            ));
        }
        if !(0.0..=100.0).contains(&b.saturation) {
            return Err(ConvertIssue::new(
                &format!("colorGrading.{name}.saturation"),
                "outOfRange",
                "must be within 0..100",
            ));
        }
        if !(-100.0..=100.0).contains(&b.luminance) {
            return Err(ConvertIssue::new(
                &format!("colorGrading.{name}.luminance"),
                "outOfRange",
                "must be within -100..100",
            ));
        }
        if matches!(name, "midtone" | "global") && b.luminance != 0.0 {
            return Err(ConvertIssue::new(
                &format!("colorGrading.{name}.luminance"),
                "unsupported",
                "midtone and global luminance are retained by Photo Bench but not rendered",
            ));
        }
    }
    if !(0.0..=100.0).contains(&g.blending) {
        return Err(ConvertIssue::new(
            "colorGrading.blending",
            "outOfRange",
            "must be within 0..100",
        ));
    }
    if !(-100.0..=100.0).contains(&g.balance) {
        return Err(ConvertIssue::new(
            "colorGrading.balance",
            "outOfRange",
            "must be within -100..100",
        ));
    }
    Ok(g)
}

/// `developSettings` -> Photo Bench `EditSettings` JSON (the inverse used to
/// apply an XMP preset on top of saved settings; `absolute` becomes
/// `custom`, `relative` keeps the relative values with `asShot`).
pub fn to_edit_settings_value(s: &DevelopSettings) -> Value {
    let mut v = s.to_value();
    let o = v.as_object_mut().expect("object");
    // The NIHO effects are not `EditSettings` keys (`convert_edit_settings`
    // would keep them as legacy and fail); `xmp::preset_settings` carries
    // them over itself.
    for key in [
        "v",
        "engine",
        "look",
        "base",
        "legacySettings",
        "grayscale",
        "grayMixer",
        "vignette",
        "grain",
        "masks",
    ] {
        o.remove(key);
    }
    for key in s.extra.keys() {
        o.remove(key);
    }
    let mut wb = Map::new();
    match s.white_balance.mode {
        WhiteBalanceMode::Absolute => {
            wb.insert("mode".into(), Value::from("custom"));
        }
        WhiteBalanceMode::AsShot | WhiteBalanceMode::Relative => {
            wb.insert("mode".into(), Value::from("asShot"));
        }
    }
    if let Some(t) = s.white_balance.temperature {
        wb.insert("temperature".into(), settings::num(t));
    }
    if let Some(t) = s.white_balance.tint {
        wb.insert("tint".into(), settings::num(t));
    }
    o.insert("whiteBalance".into(), Value::Object(wb));
    v
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn neutral_edit_settings_convert_to_neutral() {
        let out = convert_edit_settings(&json!({}), None);
        assert!(out.ok);
        assert!(out.settings.is_neutral());
        assert!(out.settings.legacy_settings.is_none());
    }

    #[test]
    fn integer_rule_and_ranges() {
        let out = convert_edit_settings(
            &json!({"contrast": 12.5, "exposure": 5.5, "shadows": 40}),
            None,
        );
        assert!(!out.ok);
        let legacy = out.settings.legacy_settings.clone().unwrap();
        assert_eq!(legacy["contrast"], 12.5);
        assert_eq!(legacy["exposure"], 5.5);
        assert_eq!(out.settings.shadows, 40.0);
        assert_eq!(out.settings.contrast, 0.0);
    }

    #[test]
    fn custom_incremental_white_balance_maps_to_niho_2_relative() {
        let input = json!({
            "whiteBalance": {
                "mode": "custom",
                "incrementalTemperature": -30,
                "incrementalTint": -20
            }
        });
        let out = convert_edit_settings(&input, None);
        assert!(out.ok, "{:?}", out.issues);
        assert_eq!(out.settings.engine, ENGINE_NIHO_2);
        assert_eq!(out.settings.white_balance.mode, WhiteBalanceMode::Relative);
        assert_eq!(out.settings.relative_temperature, -30.0);
        assert_eq!(out.settings.relative_tint, -20.0);
        assert!(out.settings.validate().is_empty());
    }

    #[test]
    fn nested_incremental_conflict_and_range_are_conversion_issues() {
        let conflict = convert_edit_settings(
            &json!({
                "relativeTemperature": 5,
                "whiteBalance": {"mode": "custom", "incrementalTemperature": 12}
            }),
            None,
        );
        assert!(!conflict.ok);
        assert_eq!(conflict.issues[0].code, "conflictingValue");
        assert_eq!(conflict.issues[0].path, "whiteBalance");
        assert_eq!(conflict.settings.relative_temperature, 5.0);
        assert_eq!(conflict.settings.engine, crate::settings::ENGINE_NIHO_1);

        let out_of_range = convert_edit_settings(
            &json!({
                "whiteBalance": {"mode": "custom", "incrementalTint": 101}
            }),
            None,
        );
        assert!(!out_of_range.ok);
        assert_eq!(out_of_range.issues[0].code, "outOfRange");
        assert_eq!(out_of_range.issues[0].path, "whiteBalance.incrementalTint");
    }

    #[test]
    fn zero_incremental_and_absolute_white_keep_their_previous_mapping() {
        let zero = convert_edit_settings(
            &json!({
                "whiteBalance": {
                    "mode": "custom",
                    "incrementalTemperature": 0,
                    "incrementalTint": 0
                }
            }),
            None,
        );
        assert!(zero.ok);
        assert_eq!(zero.settings.engine, crate::settings::ENGINE_NIHO_1);
        assert_eq!(zero.settings.white_balance.mode, WhiteBalanceMode::AsShot);

        let absolute = convert_edit_settings(
            &json!({
                "whiteBalance": {
                    "mode": "custom",
                    "temperature": 5200,
                    "tint": 8,
                    "incrementalTemperature": 0,
                    "incrementalTint": 0
                }
            }),
            None,
        );
        assert!(absolute.ok);
        assert_eq!(absolute.settings.engine, crate::settings::ENGINE_NIHO_1);
        assert_eq!(
            absolute.settings.white_balance.mode,
            WhiteBalanceMode::Absolute
        );

        for input in [
            json!({
                "whiteBalance": {
                    "mode": "custom",
                    "temperature": 5200,
                    "tint": 8,
                    "incrementalTemperature": 5
                }
            }),
            json!({
                "whiteBalance": {"mode": "asShot", "incrementalTint": -5}
            }),
        ] {
            let unchanged = convert_edit_settings(&input, None);
            assert!(!unchanged.ok);
            assert_eq!(unchanged.issues[0].code, "unsupported");
            assert_eq!(unchanged.settings.engine, crate::settings::ENGINE_NIHO_1);
            assert!(unchanged
                .settings
                .legacy_settings
                .unwrap()
                .contains_key("whiteBalance"));
        }
    }

    #[test]
    fn non_neutral_curve_refine_saturation_is_preserved_as_legacy() {
        let out = convert_edit_settings(&json!({"curveRefineSaturation": 75.0}), None);
        assert!(!out.ok);
        assert_eq!(
            out.settings.legacy_settings.unwrap()["curveRefineSaturation"],
            75.0
        );
        assert_eq!(out.issues[0].code, "unsupported");
    }

    #[test]
    fn nonzero_midtone_and_global_luminance_are_preserved_as_legacy() {
        for band in ["midtone", "global"] {
            let out =
                convert_edit_settings(&json!({"colorGrading": {band: {"luminance": 20.0}}}), None);
            assert!(!out.ok, "{band}");
            assert!(out
                .settings
                .legacy_settings
                .unwrap()
                .contains_key("colorGrading"));
            assert_eq!(out.issues[0].code, "unsupported");
        }
    }

    #[test]
    fn unknown_tone_curve_point_keys_preserve_the_full_curve() {
        let value = json!([{"channel": "rgb", "points": [{"x": 0.0, "y": 0.0, "future": 1}]}]);
        let out = convert_edit_settings(&json!({"toneCurves": value.clone()}), None);
        assert!(!out.ok);
        assert_eq!(out.settings.legacy_settings.unwrap()["toneCurves"], value);
        assert_eq!(out.issues[0].code, "unknownKey");
    }

    #[test]
    fn effects_are_not_edit_settings_keys() {
        let mut s = DevelopSettings::neutral();
        s.contrast = 10.0;
        s.grayscale = true;
        s.gray_mixer.set(crate::settings::HslBand::Red, 20.0);
        s.vignette.amount = -20.0;
        s.grain.amount = 30.0;
        let value = to_edit_settings_value(&s);
        for key in ["grayscale", "grayMixer", "vignette", "grain"] {
            assert!(value.get(key).is_none(), "{key}");
        }
        let out = convert_edit_settings(&value, None);
        assert!(out.ok, "{:?}", out.issues);
        assert_eq!(out.settings.contrast, 10.0);
    }
}
