//! Local adjustments (`masks` of `developSettings`): the saved shape and its
//! strict validation (Epic #31, M1 = #65). The contract is
//! `docs/local-adjustments.md`; this module only reads, checks and writes the
//! settings. The planes and the blend are `local_render.rs` (M2, #66); the
//! surfaces of `brush` / `subject` / `sky` are set into a Session
//! (`mask_surface.rs`, `Session::set_mask_surface`, M4 #68), and an active
//! mask of those kinds whose surface is not set fails to render
//! (`Error::MaskSurfaceMissing`).
//!
//! Strictness (Rust and `develop-masks.ts` agree through
//! `tests/fixtures/masks/settings-cases.json`): every mask and every nested
//! object has exactly the keys of its kind, no unknown keys, finite numbers
//! inside the documented ranges, unique ids and at most
//! [`MAX_LOCAL_MASKS`] masks.
//!
//! Error codes (`SettingsError::code`):
//!
//! - `invalidType`: a value of the wrong JSON type (also a non-array `masks`).
//! - `notFinite`: a number that is not finite.
//! - `invalidMask`: a missing field, an unknown `kind`, or a `kind` that does
//!   not fit the shape.
//! - `unknownMaskKey`: a key the mask kind (or the nested object) does not have.
//! - `invalidMaskId` / `duplicateMaskId`: a bad or repeated `id`.
//! - `invalidMaskSurface`: a surface `id` that is not 64 lowercase hex digits,
//!   or a non-integer size.
//! - `maskOutOfRange`: a number outside its range.
//! - `tooManyMasks`: more than [`MAX_LOCAL_MASKS`].
//! - `localWhiteBalance`: a relative white-balance delta while the settings'
//!   white balance mode is `absolute`.

use crate::settings::{
    num, number, object, parse_hsl, HslAdjustments, SettingsError, WhiteBalanceMode,
    MAX_LOCAL_MASKS,
};
use serde_json::{Map, Value};
use std::collections::BTreeSet;

/// Longest `id` (bytes).
const MAX_MASK_ID_BYTES: usize = 64;
/// `linear`: the least distance between `zero` and `full`.
const MIN_LINEAR_DISTANCE: f64 = 0.001;
/// Surface PNG side limit (pixels).
const MAX_SURFACE_SIDE: u32 = 4096;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum MaskKind {
    Linear,
    Radial,
    /// Painted by the person (`surface`).
    Brush,
    /// Detected subject (`surface`).
    Subject,
    /// Detected sky (`surface`).
    Sky,
}

impl MaskKind {
    pub const ALL: [MaskKind; 5] = [
        MaskKind::Linear,
        MaskKind::Radial,
        MaskKind::Brush,
        MaskKind::Subject,
        MaskKind::Sky,
    ];

    pub fn as_str(self) -> &'static str {
        match self {
            MaskKind::Linear => "linear",
            MaskKind::Radial => "radial",
            MaskKind::Brush => "brush",
            MaskKind::Subject => "subject",
            MaskKind::Sky => "sky",
        }
    }

    pub fn parse(s: &str) -> Option<Self> {
        MaskKind::ALL.into_iter().find(|k| k.as_str() == s)
    }

    /// The keys of the shape this kind carries (besides the common ones).
    fn shape_keys(self) -> &'static [&'static str] {
        match self {
            MaskKind::Linear => &["zero", "full"],
            MaskKind::Radial => &["center", "radius", "angle", "feather"],
            MaskKind::Brush | MaskKind::Subject | MaskKind::Sky => &["surface"],
        }
    }
}

/// A point in the working image (`x`, `y` as a fraction of width / height).
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct MaskPoint {
    pub x: f64,
    pub y: f64,
}

/// A mask surface stored elsewhere: the sha256 of its 8-bit gray PNG and its
/// size. The pixels never enter the settings.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct MaskSurfaceRef {
    /// 64 lowercase hex digits.
    pub id: String,
    pub width: u32,
    pub height: u32,
}

#[derive(Debug, Clone, PartialEq)]
pub enum MaskShape {
    /// 0 at `zero`, 1 at `full`.
    Linear { zero: MaskPoint, full: MaskPoint },
    /// An ellipse: half axes as a fraction of width (`radius_x`) and height
    /// (`radius_y`), `angle` in degrees clockwise, `feather` 0..100.
    Radial {
        center: MaskPoint,
        radius_x: f64,
        radius_y: f64,
        angle: f64,
        feather: f64,
    },
    /// `brush`, `subject` and `sky`.
    Surface(MaskSurfaceRef),
}

impl MaskShape {
    fn fits(&self, kind: MaskKind) -> bool {
        match self {
            MaskShape::Linear { .. } => kind == MaskKind::Linear,
            MaskShape::Radial { .. } => kind == MaskKind::Radial,
            MaskShape::Surface(_) => {
                matches!(kind, MaskKind::Brush | MaskKind::Subject | MaskKind::Sky)
            }
        }
    }
}

/// The local adjustment: **deltas** on the global values of the same key
/// (0 = unchanged). Ranges are the global ones.
#[derive(Debug, Clone, PartialEq, Default)]
pub struct LocalAdjust {
    pub exposure: f64,
    pub contrast: f64,
    pub highlights: f64,
    pub shadows: f64,
    pub whites: f64,
    pub blacks: f64,
    pub texture: f64,
    pub clarity: f64,
    pub dehaze: f64,
    pub vibrance: f64,
    pub saturation: f64,
    pub relative_temperature: f64,
    pub relative_tint: f64,
    /// Per-band deltas (same shape as the global `hsl`).
    pub hsl: HslAdjustments,
}

/// `adjust` scalar keys in the canonical order, with their ranges.
const ADJUST_SCALARS: [(&str, f64, f64); 13] = [
    ("exposure", -5.0, 5.0),
    ("contrast", -100.0, 100.0),
    ("highlights", -100.0, 100.0),
    ("shadows", -100.0, 100.0),
    ("whites", -100.0, 100.0),
    ("blacks", -100.0, 100.0),
    ("texture", -100.0, 100.0),
    ("clarity", -100.0, 100.0),
    ("dehaze", -100.0, 100.0),
    ("vibrance", -100.0, 100.0),
    ("saturation", -100.0, 100.0),
    ("relativeTemperature", -100.0, 100.0),
    ("relativeTint", -100.0, 100.0),
];

impl LocalAdjust {
    fn scalar(&self, key: &str) -> f64 {
        match key {
            "exposure" => self.exposure,
            "contrast" => self.contrast,
            "highlights" => self.highlights,
            "shadows" => self.shadows,
            "whites" => self.whites,
            "blacks" => self.blacks,
            "texture" => self.texture,
            "clarity" => self.clarity,
            "dehaze" => self.dehaze,
            "vibrance" => self.vibrance,
            "saturation" => self.saturation,
            "relativeTemperature" => self.relative_temperature,
            "relativeTint" => self.relative_tint,
            _ => 0.0,
        }
    }

    fn set_scalar(&mut self, key: &str, value: f64) {
        match key {
            "exposure" => self.exposure = value,
            "contrast" => self.contrast = value,
            "highlights" => self.highlights = value,
            "shadows" => self.shadows = value,
            "whites" => self.whites = value,
            "blacks" => self.blacks = value,
            "texture" => self.texture = value,
            "clarity" => self.clarity = value,
            "dehaze" => self.dehaze = value,
            "vibrance" => self.vibrance = value,
            "saturation" => self.saturation = value,
            "relativeTemperature" => self.relative_temperature = value,
            "relativeTint" => self.relative_tint = value,
            _ => {}
        }
    }

    /// Whether no key moves anything (an empty `adjust` draws nothing).
    pub fn is_zero(&self) -> bool {
        ADJUST_SCALARS
            .iter()
            .all(|(key, _, _)| self.scalar(key) == 0.0)
            && self.hsl.is_zero()
    }
}

#[derive(Debug, Clone, PartialEq)]
pub struct LocalMask {
    /// `[A-Za-z0-9_-]`, 1..=64 bytes, unique in the list.
    pub id: String,
    pub kind: MaskKind,
    /// `false` keeps the edit but draws nothing.
    pub enabled: bool,
    pub invert: bool,
    pub shape: MaskShape,
    pub adjust: LocalAdjust,
}

impl LocalMask {
    /// Whether this mask changes pixels: enabled with a non-zero `adjust`.
    pub fn is_active(&self) -> bool {
        self.enabled && !self.adjust.is_zero()
    }
}

const COMMON_KEYS: [&str; 5] = ["id", "kind", "enabled", "invert", "adjust"];

fn invalid(path: &str, code: &str, message: &str) -> SettingsError {
    SettingsError::new(path, code, message)
}

fn too_many() -> SettingsError {
    invalid("masks", "tooManyMasks", "at most 8 masks are allowed")
}

fn missing(path: &str, key: &str) -> SettingsError {
    invalid(
        &format!("{path}.{key}"),
        "invalidMask",
        "required field is missing",
    )
}

/// An object whose keys are all in `keys` (`unknownMaskKey` otherwise).
fn exact<'a>(
    value: &'a Value,
    path: &str,
    keys: &[&str],
) -> Result<&'a Map<String, Value>, SettingsError> {
    let o = object(value, path)?;
    if let Some(key) = o.keys().find(|key| !keys.contains(&key.as_str())) {
        return Err(invalid(
            &format!("{path}.{key}"),
            "unknownMaskKey",
            "unknown field",
        ));
    }
    Ok(o)
}

fn required_number(o: &Map<String, Value>, path: &str, key: &str) -> Result<f64, SettingsError> {
    match o.get(key) {
        None => Err(missing(path, key)),
        Some(value) => number(value, &format!("{path}.{key}")),
    }
}

fn parse_point(value: &Value, path: &str) -> Result<MaskPoint, SettingsError> {
    let o = exact(value, path, &["x", "y"])?;
    Ok(MaskPoint {
        x: required_number(o, path, "x")?,
        y: required_number(o, path, "y")?,
    })
}

fn optional_bool(
    o: &Map<String, Value>,
    path: &str,
    key: &str,
    default: bool,
) -> Result<bool, SettingsError> {
    match o.get(key) {
        None => Ok(default),
        Some(value) => value
            .as_bool()
            .ok_or_else(|| invalid(&format!("{path}.{key}"), "invalidType", "must be a boolean")),
    }
}

fn surface_side(o: &Map<String, Value>, path: &str, key: &str) -> Result<u32, SettingsError> {
    let n = required_number(o, path, key)?;
    let at = format!("{path}.{key}");
    if n != libm::trunc(n) {
        return Err(invalid(&at, "invalidMaskSurface", "must be an integer"));
    }
    if !(0.0..=f64::from(u32::MAX)).contains(&n) {
        return Err(invalid(&at, "maskOutOfRange", "must be within 1..4096"));
    }
    Ok(n as u32)
}

fn parse_shape(
    kind: MaskKind,
    o: &Map<String, Value>,
    path: &str,
) -> Result<MaskShape, SettingsError> {
    let part = |key: &str| o.get(key).map(|value| (value, format!("{path}.{key}")));
    let need = |key: &str| part(key).ok_or_else(|| missing(path, key));
    match kind {
        MaskKind::Linear => {
            let (zero, zero_path) = need("zero")?;
            let (full, full_path) = need("full")?;
            Ok(MaskShape::Linear {
                zero: parse_point(zero, &zero_path)?,
                full: parse_point(full, &full_path)?,
            })
        }
        MaskKind::Radial => {
            let (center, center_path) = need("center")?;
            let (radius, radius_path) = need("radius")?;
            let (angle, angle_path) = need("angle")?;
            let (feather, feather_path) = need("feather")?;
            let radius_object = exact(radius, &radius_path, &["x", "y"])?;
            Ok(MaskShape::Radial {
                center: parse_point(center, &center_path)?,
                radius_x: required_number(radius_object, &radius_path, "x")?,
                radius_y: required_number(radius_object, &radius_path, "y")?,
                angle: number(angle, &angle_path)?,
                feather: number(feather, &feather_path)?,
            })
        }
        MaskKind::Brush | MaskKind::Subject | MaskKind::Sky => {
            let (surface, surface_path) = need("surface")?;
            let s = exact(surface, &surface_path, &["id", "width", "height"])?;
            let id = match s.get("id") {
                None => return Err(missing(&surface_path, "id")),
                Some(Value::String(id)) => id.clone(),
                Some(_) => {
                    return Err(invalid(
                        &format!("{surface_path}.id"),
                        "invalidType",
                        "must be a string",
                    ))
                }
            };
            Ok(MaskShape::Surface(MaskSurfaceRef {
                id,
                width: surface_side(s, &surface_path, "width")?,
                height: surface_side(s, &surface_path, "height")?,
            }))
        }
    }
}

/// `hsl` of an `adjust`: the global shapes (an alternating `[band, {...}]`
/// array or a band map), with the nested keys checked strictly.
fn parse_adjust_hsl(value: &Value, path: &str) -> Result<HslAdjustments, SettingsError> {
    let mut hsl = parse_hsl(value).map_err(|e| {
        let rest = e.path.strip_prefix("hsl").unwrap_or(&e.path);
        SettingsError::new(&format!("{path}{rest}"), &e.code, &e.message)
    })?;
    let pairs: Vec<(&str, &Value)> = match value {
        Value::Array(items) => items
            .chunks(2)
            .filter_map(|pair| Some((pair[0].as_str()?, &pair[1])))
            .collect(),
        Value::Object(map) => map.iter().map(|(k, v)| (k.as_str(), v)).collect(),
        _ => Vec::new(),
    };
    for (band, adjustment) in pairs {
        if let Some(key) = adjustment.as_object().and_then(|o| {
            o.keys()
                .find(|k| !matches!(k.as_str(), "hue" | "saturation" | "luminance"))
        }) {
            return Err(invalid(
                &format!("{path}.{band}.{key}"),
                "unknownMaskKey",
                "unknown field",
            ));
        }
    }
    // A band that changes nothing is the same as no band.
    for (band, a) in hsl.entries().to_vec() {
        if a.is_zero() {
            hsl.remove(band);
        }
    }
    Ok(hsl)
}

fn parse_adjust(value: &Value, path: &str) -> Result<LocalAdjust, SettingsError> {
    let o = object(value, path)?;
    let mut adjust = LocalAdjust::default();
    for (key, item) in o {
        let at = format!("{path}.{key}");
        if key == "hsl" {
            adjust.hsl = parse_adjust_hsl(item, &at)?;
        } else if ADJUST_SCALARS.iter().any(|(name, _, _)| name == key) {
            adjust.set_scalar(key, number(item, &at)?);
        } else {
            return Err(invalid(&at, "unknownMaskKey", "unknown adjustment"));
        }
    }
    Ok(adjust)
}

fn parse_mask(value: &Value, path: &str) -> Result<LocalMask, SettingsError> {
    let o = object(value, path)?;
    let kind_value = o.get("kind").ok_or_else(|| missing(path, "kind"))?;
    let kind_path = format!("{path}.kind");
    let kind_name = kind_value
        .as_str()
        .ok_or_else(|| invalid(&kind_path, "invalidType", "must be a string"))?;
    let kind = MaskKind::parse(kind_name).ok_or_else(|| {
        invalid(
            &kind_path,
            "invalidMask",
            "must be linear, radial, brush, subject or sky",
        )
    })?;
    let shape_keys = kind.shape_keys();
    if let Some(key) = o
        .keys()
        .find(|k| !COMMON_KEYS.contains(&k.as_str()) && !shape_keys.contains(&k.as_str()))
    {
        return Err(invalid(
            &format!("{path}.{key}"),
            "unknownMaskKey",
            "not a field of this mask kind",
        ));
    }
    let id = match o.get("id") {
        None => return Err(missing(path, "id")),
        Some(Value::String(id)) => id.clone(),
        Some(_) => {
            return Err(invalid(
                &format!("{path}.id"),
                "invalidType",
                "must be a string",
            ))
        }
    };
    let adjust_value = o.get("adjust").ok_or_else(|| missing(path, "adjust"))?;
    Ok(LocalMask {
        id,
        kind,
        enabled: optional_bool(o, path, "enabled", true)?,
        invert: optional_bool(o, path, "invert", false)?,
        shape: parse_shape(kind, o, path)?,
        adjust: parse_adjust(adjust_value, &format!("{path}.adjust"))?,
    })
}

/// Reads `masks`: the shape of every mask (types, keys, finite numbers). The
/// ranges, ids and the white-balance rule are [`validate_masks`], which
/// `DevelopSettings::from_value` runs right after.
pub(crate) fn parse_masks(value: &Value) -> Result<Vec<LocalMask>, SettingsError> {
    let items = value
        .as_array()
        .ok_or_else(|| invalid("masks", "invalidType", "must be an array"))?;
    if items.len() > MAX_LOCAL_MASKS {
        return Err(too_many());
    }
    items
        .iter()
        .enumerate()
        .map(|(index, item)| parse_mask(item, &format!("masks[{index}]")))
        .collect()
}

fn valid_id(id: &str) -> bool {
    !id.is_empty()
        && id.len() <= MAX_MASK_ID_BYTES
        && id
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b == b'_' || b == b'-')
}

fn valid_surface_id(id: &str) -> bool {
    id.len() == 64 && id.bytes().all(|b| matches!(b, b'0'..=b'9' | b'a'..=b'f'))
}

fn check_range(issues: &mut Vec<SettingsError>, path: &str, value: f64, lo: f64, hi: f64) {
    if !value.is_finite() {
        issues.push(invalid(path, "notFinite", "must be finite"));
    } else if value < lo || value > hi {
        issues.push(invalid(
            path,
            "maskOutOfRange",
            &format!("must be within {lo}..{hi}"),
        ));
    }
}

/// Every problem of `masks` as typed values (an empty list means valid):
/// the count, the ids, `kind` against the shape, every range, and the
/// relative white-balance rule against the settings' white balance mode.
pub(crate) fn validate_masks(masks: &[LocalMask], mode: WhiteBalanceMode) -> Vec<SettingsError> {
    let mut issues = Vec::new();
    if masks.len() > MAX_LOCAL_MASKS {
        issues.push(too_many());
    }
    let mut ids = BTreeSet::new();
    for (index, mask) in masks.iter().enumerate() {
        let path = format!("masks[{index}]");
        if !valid_id(&mask.id) {
            issues.push(invalid(
                &format!("{path}.id"),
                "invalidMaskId",
                "must be 1..64 bytes of A-Z a-z 0-9 _ -",
            ));
        } else if !ids.insert(mask.id.as_str()) {
            issues.push(invalid(
                &format!("{path}.id"),
                "duplicateMaskId",
                "mask ids must be unique",
            ));
        }
        if !mask.shape.fits(mask.kind) {
            issues.push(invalid(
                &format!("{path}.kind"),
                "invalidMask",
                "kind does not match the shape",
            ));
        }
        match &mask.shape {
            MaskShape::Linear { zero, full } => {
                for (name, point) in [("zero", zero), ("full", full)] {
                    check_range(&mut issues, &format!("{path}.{name}.x"), point.x, -1.0, 2.0);
                    check_range(&mut issues, &format!("{path}.{name}.y"), point.y, -1.0, 2.0);
                }
                // Euclidean on the raw x, y (IEEE operations only, so the
                // TypeScript twin gives the same answer).
                let (dx, dy) = (full.x - zero.x, full.y - zero.y);
                let distance = (dx * dx + dy * dy).sqrt();
                if distance.is_finite() && distance < MIN_LINEAR_DISTANCE {
                    issues.push(invalid(
                        &format!("{path}.full"),
                        "maskOutOfRange",
                        "zero and full must be at least 0.001 apart",
                    ));
                }
            }
            MaskShape::Radial {
                center,
                radius_x,
                radius_y,
                angle,
                feather,
            } => {
                let ranges = [
                    ("center.x", center.x, 0.0, 1.0),
                    ("center.y", center.y, 0.0, 1.0),
                    ("radius.x", *radius_x, 0.005, 1.5),
                    ("radius.y", *radius_y, 0.005, 1.5),
                    ("angle", *angle, -180.0, 180.0),
                    ("feather", *feather, 0.0, 100.0),
                ];
                for (name, value, lo, hi) in ranges {
                    check_range(&mut issues, &format!("{path}.{name}"), value, lo, hi);
                }
            }
            MaskShape::Surface(surface) => {
                if !valid_surface_id(&surface.id) {
                    issues.push(invalid(
                        &format!("{path}.surface.id"),
                        "invalidMaskSurface",
                        "must be 64 lowercase hex digits",
                    ));
                }
                for (name, side) in [("width", surface.width), ("height", surface.height)] {
                    check_range(
                        &mut issues,
                        &format!("{path}.surface.{name}"),
                        f64::from(side),
                        1.0,
                        f64::from(MAX_SURFACE_SIDE),
                    );
                }
            }
        }
        for (key, lo, hi) in ADJUST_SCALARS {
            let at = format!("{path}.adjust.{key}");
            check_range(&mut issues, &at, mask.adjust.scalar(key), lo, hi);
        }
        for (band, a) in mask.adjust.hsl.entries() {
            let b = band.as_str();
            for (name, value) in [
                ("hue", a.hue),
                ("saturation", a.saturation),
                ("luminance", a.luminance),
            ] {
                let at = format!("{path}.adjust.hsl.{b}.{name}");
                check_range(&mut issues, &at, value, -100.0, 100.0);
            }
        }
        if mode == WhiteBalanceMode::Absolute {
            for (key, value) in [
                ("relativeTemperature", mask.adjust.relative_temperature),
                ("relativeTint", mask.adjust.relative_tint),
            ] {
                if value != 0.0 {
                    issues.push(invalid(
                        &format!("{path}.adjust.{key}"),
                        "localWhiteBalance",
                        "relative white balance needs whiteBalance.mode other than absolute",
                    ));
                }
            }
        }
    }
    issues
}

fn point_value(point: &MaskPoint) -> Value {
    Value::Object(Map::from_iter([
        ("x".into(), num(point.x)),
        ("y".into(), num(point.y)),
    ]))
}

fn adjust_value(adjust: &LocalAdjust) -> Value {
    let mut o = Map::new();
    for (key, _, _) in ADJUST_SCALARS {
        let value = adjust.scalar(key);
        if value != 0.0 {
            o.insert(key.into(), num(value));
        }
    }
    // The global `hsl` encoding (alternating band / values), with the bands
    // and values that are 0 left out.
    let mut hsl = Vec::new();
    for (band, a) in adjust.hsl.entries() {
        let mut values = Map::new();
        for (name, value) in [
            ("hue", a.hue),
            ("saturation", a.saturation),
            ("luminance", a.luminance),
        ] {
            if value != 0.0 {
                values.insert(name.into(), num(value));
            }
        }
        if !values.is_empty() {
            hsl.push(Value::from(band.as_str()));
            hsl.push(Value::Object(values));
        }
    }
    if !hsl.is_empty() {
        o.insert("hsl".into(), Value::Array(hsl));
    }
    Value::Object(o)
}

fn mask_value(mask: &LocalMask) -> Value {
    let mut o = Map::new();
    o.insert("id".into(), Value::from(mask.id.clone()));
    o.insert("kind".into(), Value::from(mask.kind.as_str()));
    if !mask.enabled {
        o.insert("enabled".into(), Value::from(false));
    }
    if mask.invert {
        o.insert("invert".into(), Value::from(true));
    }
    match &mask.shape {
        MaskShape::Linear { zero, full } => {
            o.insert("zero".into(), point_value(zero));
            o.insert("full".into(), point_value(full));
        }
        MaskShape::Radial {
            center,
            radius_x,
            radius_y,
            angle,
            feather,
        } => {
            o.insert("center".into(), point_value(center));
            o.insert(
                "radius".into(),
                Value::Object(Map::from_iter([
                    ("x".into(), num(*radius_x)),
                    ("y".into(), num(*radius_y)),
                ])),
            );
            o.insert("angle".into(), num(*angle));
            o.insert("feather".into(), num(*feather));
        }
        MaskShape::Surface(surface) => {
            o.insert(
                "surface".into(),
                Value::Object(Map::from_iter([
                    ("id".into(), Value::from(surface.id.clone())),
                    ("width".into(), Value::from(surface.width)),
                    ("height".into(), Value::from(surface.height)),
                ])),
            );
        }
    }
    o.insert("adjust".into(), adjust_value(&mask.adjust));
    Value::Object(o)
}

/// The canonical `masks` array (the caller leaves the key out when empty).
pub(crate) fn masks_value(masks: &[LocalMask]) -> Value {
    Value::Array(masks.iter().map(mask_value).collect())
}
