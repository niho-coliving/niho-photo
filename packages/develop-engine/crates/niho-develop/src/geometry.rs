//! `developSettings.geometry` (F3 #17122): quarter turns, flips, the
//! straighten angle and the crop. Settings with a geometry that is not the
//! identity are `v: 2`, so readers that do not know it refuse them instead
//! of rendering the uncropped photo (spec "段 2").
//!
//! Frame and coordinates (the ones Lightroom's `crs:CropLeft / CropTop /
//! CropRight / CropBottom / CropAngle` use, on NIHO's frame):
//!
//! - The frame is the working image (EXIF orientation already applied)
//!   turned clockwise by `rotate`, then mirrored left-right by `flipH` and
//!   top-bottom by `flipV`. Lightroom's crop is on the stored pixels before
//!   the orientation; a sidecar maps through the orientation first (a
//!   mirrored one reverses the angle).
//! - `crop.left / top` is the crop rectangle's top-left corner and
//!   `crop.right / bottom` its bottom-right corner, where they actually lie
//!   on the frame: x over the frame's width, y over its height, `0..1`,
//!   y down.
//! - `angle` (degrees, `-45..45`) turns the crop rectangle clockwise about
//!   its center relative to the frame (the photo appears turned
//!   counter-clockwise in the result).
//!
//! In frame pixels (`W x H`): `UL = (left W, top H)`, `LR = (right W,
//! bottom H)`, `d = LR - UL`, `u = (cos a, sin a)`, `v = (-sin a, cos a)`;
//! the crop is `d.u` wide and `d.v` tall, output pixel `(x, y)` lies at
//! `UL + x u + y v` ([`CropRect::corners`]).
//!
//! `aspect` is the ratio the editor keeps while the crop is dragged
//! (`free`, `original`, `originalSwapped` or `<w>:<h>`); rendering does not
//! read it.

use crate::settings::{num, SettingsError};
use serde_json::{Map, Value};

/// `v` of settings whose geometry is not the identity.
pub const GEOMETRY_SETTINGS_VERSION: u32 = 2;
/// Straighten limit (degrees, both ways).
pub const MAX_ANGLE_DEGREES: f64 = 45.0;

/// The crop's corners on the frame (see the module docs).
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct CropRect {
    pub left: f64,
    pub top: f64,
    pub right: f64,
    pub bottom: f64,
}

impl Default for CropRect {
    fn default() -> Self {
        Self {
            left: 0.0,
            top: 0.0,
            right: 1.0,
            bottom: 1.0,
        }
    }
}

impl CropRect {
    pub fn is_full(&self) -> bool {
        *self == Self::default()
    }

    /// The crop on a `width x height` frame turned by `angle` degrees, in
    /// frame pixels: the top-left corner and the edge directions scaled by
    /// the crop's width and height (`top_left + x * across + y * down` for
    /// `x, y` in `0..1`). A width or height that is not positive means the
    /// corners do not make a rectangle at this angle on this frame.
    pub fn corners(&self, width: f64, height: f64, angle: f64) -> CropCorners {
        let (sin, cos) = libm::sincos(angle.to_radians());
        let top_left = [self.left * width, self.top * height];
        let d = [
            self.right * width - top_left[0],
            self.bottom * height - top_left[1],
        ];
        let crop_width = d[0] * cos + d[1] * sin;
        let crop_height = -d[0] * sin + d[1] * cos;
        CropCorners {
            top_left,
            across: [crop_width * cos, crop_width * sin],
            down: [-crop_height * sin, crop_height * cos],
            width: crop_width,
            height: crop_height,
        }
    }
}

/// [`CropRect::corners`].
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct CropCorners {
    pub top_left: [f64; 2],
    /// Top-left to top-right corner.
    pub across: [f64; 2],
    /// Top-left to bottom-left corner.
    pub down: [f64; 2],
    pub width: f64,
    pub height: f64,
}

#[derive(Debug, Clone, PartialEq)]
pub struct Geometry {
    /// Clockwise quarter turns in degrees: 0, 90, 180 or 270.
    pub rotate: u32,
    pub flip_h: bool,
    pub flip_v: bool,
    /// Straighten angle in degrees (`-45..45`, clockwise turn of the crop).
    pub angle: f64,
    pub crop: CropRect,
    /// The editor's aspect ratio lock (not rendered).
    pub aspect: Option<String>,
    /// Unknown keys, preserved verbatim.
    pub extra: Map<String, Value>,
}

impl Default for Geometry {
    fn default() -> Self {
        Self {
            rotate: 0,
            flip_h: false,
            flip_v: false,
            angle: 0.0,
            crop: CropRect::default(),
            aspect: None,
            extra: Map::new(),
        }
    }
}

impl Geometry {
    /// Whether the frame is the working image itself: no turn (a half turn
    /// with both flips is a turn too), no angle, the whole frame. `aspect`
    /// does not count.
    pub fn is_identity(&self) -> bool {
        let turned = !matches!(
            (self.rotate % 360, self.flip_h, self.flip_v),
            (0, false, false) | (180, true, true)
        );
        !turned && self.angle == 0.0 && self.crop.is_full()
    }

    /// Reads a `geometry` object. Missing keys take the identity; wrong types
    /// and non-finite numbers are errors (ranges are [`Self::validate`]'s).
    pub fn from_value(v: &Value) -> Result<Self, SettingsError> {
        let object = v.as_object().ok_or_else(|| {
            SettingsError::new("geometry", "invalidType", "geometry must be an object")
        })?;
        let mut g = Self::default();
        for (key, value) in object {
            let path = format!("geometry.{key}");
            match key.as_str() {
                "rotate" => {
                    let n = number(value, &path)?;
                    g.rotate = match n {
                        _ if n == 0.0 => 0,
                        _ if n == 90.0 => 90,
                        _ if n == 180.0 => 180,
                        _ if n == 270.0 => 270,
                        _ => {
                            return Err(SettingsError::new(
                                &path,
                                "invalidValue",
                                "must be 0, 90, 180 or 270",
                            ))
                        }
                    };
                }
                "flipH" => g.flip_h = boolean(value, &path)?,
                "flipV" => g.flip_v = boolean(value, &path)?,
                "angle" => g.angle = number(value, &path)?,
                "crop" => g.crop = parse_crop(value)?,
                "aspect" => {
                    g.aspect = match value {
                        Value::Null => None,
                        Value::String(s) => Some(s.clone()),
                        _ => {
                            return Err(SettingsError::new(
                                &path,
                                "invalidType",
                                "must be a string",
                            ))
                        }
                    };
                }
                _ => {
                    g.extra.insert(key.clone(), value.clone());
                }
            }
        }
        Ok(g)
    }

    pub fn to_value(&self) -> Value {
        let mut o = Map::new();
        o.insert("rotate".into(), Value::from(self.rotate));
        o.insert("flipH".into(), Value::from(self.flip_h));
        o.insert("flipV".into(), Value::from(self.flip_v));
        o.insert("angle".into(), num(self.angle));
        let mut crop = Map::new();
        crop.insert("left".into(), num(self.crop.left));
        crop.insert("top".into(), num(self.crop.top));
        crop.insert("right".into(), num(self.crop.right));
        crop.insert("bottom".into(), num(self.crop.bottom));
        o.insert("crop".into(), Value::Object(crop));
        if let Some(aspect) = &self.aspect {
            o.insert("aspect".into(), Value::from(aspect.clone()));
        }
        for (k, v) in &self.extra {
            o.entry(k.clone()).or_insert_with(|| v.clone());
        }
        Value::Object(o)
    }

    /// Range checks that do not need the photo's size. A same-point crop is
    /// always empty; other corner ordering at a non-zero angle depends on the
    /// frame's aspect ratio, so the renderer checks that.
    pub fn validate(&self, issues: &mut Vec<SettingsError>) {
        if !(-MAX_ANGLE_DEGREES..=MAX_ANGLE_DEGREES).contains(&self.angle) {
            issues.push(SettingsError::new(
                "geometry.angle",
                "outOfRange",
                &format!("must be within -{MAX_ANGLE_DEGREES}..{MAX_ANGLE_DEGREES}"),
            ));
        }
        let c = &self.crop;
        for (key, value) in [
            ("left", c.left),
            ("top", c.top),
            ("right", c.right),
            ("bottom", c.bottom),
        ] {
            if !(0.0..=1.0).contains(&value) {
                issues.push(SettingsError::new(
                    &format!("geometry.crop.{key}"),
                    "outOfRange",
                    "must be within 0..1",
                ));
            }
        }
        if (c.left == c.right && c.top == c.bottom)
            || (self.angle == 0.0 && (c.left >= c.right || c.top >= c.bottom))
        {
            issues.push(SettingsError::new(
                "geometry.crop",
                "emptyCrop",
                "left must be less than right and top less than bottom",
            ));
        }
        if let Some(aspect) = &self.aspect {
            if !is_aspect(aspect) {
                issues.push(SettingsError::new(
                    "geometry.aspect",
                    "invalidValue",
                    "must be free, original, originalSwapped or <w>:<h>",
                ));
            }
        }
    }
}

/// `free`, `original`, `originalSwapped` or `<w>:<h>` (1..9999 each).
fn is_aspect(s: &str) -> bool {
    if matches!(s, "free" | "original" | "originalSwapped") {
        return true;
    }
    let Some((w, h)) = s.split_once(':') else {
        return false;
    };
    let part = |p: &str| {
        !p.is_empty()
            && p.len() <= 4
            && p.bytes().all(|b| b.is_ascii_digit())
            && !p.starts_with('0')
    };
    part(w) && part(h)
}

fn number(v: &Value, path: &str) -> Result<f64, SettingsError> {
    let n = v
        .as_f64()
        .ok_or_else(|| SettingsError::new(path, "invalidType", "must be a number"))?;
    if !n.is_finite() {
        return Err(SettingsError::new(path, "notFinite", "must be finite"));
    }
    Ok(n)
}

fn boolean(v: &Value, path: &str) -> Result<bool, SettingsError> {
    v.as_bool()
        .ok_or_else(|| SettingsError::new(path, "invalidType", "must be a boolean"))
}

fn parse_crop(v: &Value) -> Result<CropRect, SettingsError> {
    let o = v
        .as_object()
        .ok_or_else(|| SettingsError::new("geometry.crop", "invalidType", "must be an object"))?;
    let mut crop = CropRect::default();
    for (key, value) in o {
        let path = format!("geometry.crop.{key}");
        match key.as_str() {
            "left" => crop.left = number(value, &path)?,
            "top" => crop.top = number(value, &path)?,
            "right" => crop.right = number(value, &path)?,
            "bottom" => crop.bottom = number(value, &path)?,
            _ => {
                return Err(SettingsError::new(
                    &path,
                    "unknownKey",
                    "crop has left, top, right and bottom only",
                ))
            }
        }
    }
    Ok(crop)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn geometry(json: &str) -> Geometry {
        Geometry::from_value(&serde_json::from_str(json).unwrap()).unwrap()
    }

    #[test]
    fn empty_object_is_the_identity_and_round_trips() {
        let g = geometry("{}");
        assert!(g.is_identity());
        assert_eq!(Geometry::from_value(&g.to_value()).unwrap(), g);
        let mut issues = Vec::new();
        g.validate(&mut issues);
        assert!(issues.is_empty());
    }

    #[test]
    fn a_half_turn_with_both_flips_is_the_identity() {
        assert!(geometry(r#"{"rotate":180,"flipH":true,"flipV":true}"#).is_identity());
        assert!(!geometry(r#"{"rotate":180}"#).is_identity());
        assert!(!geometry(r#"{"flipV":true}"#).is_identity());
        assert!(!geometry(r#"{"angle":0.5}"#).is_identity());
        assert!(!geometry(r#"{"crop":{"right":0.9}}"#).is_identity());
        assert!(geometry(r#"{"aspect":"4:5"}"#).is_identity());
    }

    #[test]
    fn rejects_other_turns_types_and_crop_keys() {
        let code = |json: &str| {
            Geometry::from_value(&serde_json::from_str(json).unwrap())
                .unwrap_err()
                .code
        };
        assert_eq!(code(r#"{"rotate":45}"#), "invalidValue");
        assert_eq!(code(r#"{"flipH":1}"#), "invalidType");
        assert_eq!(code(r#"{"angle":"2"}"#), "invalidType");
        assert_eq!(code(r#"{"crop":{"width":1}}"#), "unknownKey");
        assert_eq!(code(r#"{"aspect":4}"#), "invalidType");
        assert_eq!(code("[]"), "invalidType");
    }

    #[test]
    fn validate_reports_ranges_empty_crops_and_aspects() {
        let codes = |json: &str| {
            let mut issues = Vec::new();
            geometry(json).validate(&mut issues);
            issues
                .into_iter()
                .map(|e| (e.path, e.code))
                .collect::<Vec<_>>()
        };
        assert_eq!(
            codes(r#"{"angle":45.5}"#),
            vec![("geometry.angle".into(), "outOfRange".into())]
        );
        assert_eq!(
            codes(r#"{"crop":{"left":-0.1}}"#),
            vec![("geometry.crop.left".into(), "outOfRange".into())]
        );
        assert_eq!(
            codes(r#"{"crop":{"left":0.5,"right":0.5}}"#),
            vec![("geometry.crop".into(), "emptyCrop".into())]
        );
        assert_eq!(
            codes(r#"{"angle":45,"crop":{"left":0.5,"top":0.5,"right":0.5,"bottom":0.5}}"#),
            vec![("geometry.crop".into(), "emptyCrop".into())]
        );
        // At an angle the corners' order depends on the frame's aspect ratio.
        assert!(codes(r#"{"angle":45,"crop":{"top":0.5,"bottom":0.5}}"#).is_empty());
        for ok in [
            "free",
            "original",
            "originalSwapped",
            "4:5",
            "16:9",
            "9999:1",
        ] {
            assert!(codes(&format!(r#"{{"aspect":"{ok}"}}"#)).is_empty(), "{ok}");
        }
        for bad in ["", "4:", "0:1", "04:5", "4/5", "10000:1", "square"] {
            assert_eq!(
                codes(&format!(r#"{{"aspect":"{bad}"}}"#)),
                vec![("geometry.aspect".into(), "invalidValue".into())],
                "{bad}"
            );
        }
    }

    #[test]
    fn corners_follow_lightroom() {
        // No angle: the crop is the rectangle between the corners.
        let c = CropRect {
            left: 0.2,
            top: 0.1,
            right: 0.8,
            bottom: 0.6,
        }
        .corners(3000.0, 2000.0, 0.0);
        assert_eq!(c.top_left, [600.0, 200.0]);
        assert!((c.width - 1800.0).abs() < 1e-9 && (c.height - 1000.0).abs() < 1e-9);
        // A square crop turned 90 degrees clockwise about its center: its
        // top-left corner is where the unturned square's top-right one was.
        let c = CropRect {
            left: 0.6,
            top: 0.4,
            right: 0.4,
            bottom: 0.6,
        }
        .corners(1000.0, 1000.0, 90.0);
        assert!((c.width - 200.0).abs() < 1e-9 && (c.height - 200.0).abs() < 1e-9);
        assert!(c.across[0].abs() < 1e-9 && (c.across[1] - 200.0).abs() < 1e-9);
        assert!((c.down[0] + 200.0).abs() < 1e-9 && c.down[1].abs() < 1e-9);
        // Positive angles turn the crop clockwise (y down): its top edge
        // goes down to the right.
        let c = CropRect::default().corners(1000.0, 1000.0, 10.0);
        assert!(c.across[1] > 0.0 && c.down[0] < 0.0);
    }

    #[test]
    fn unknown_keys_are_preserved() {
        let g = geometry(r#"{"rotate":90,"futureKey":[1]}"#);
        assert_eq!(g.to_value()["futureKey"][0], 1);
        assert_eq!(g.to_value()["rotate"], 90);
    }
}
