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
//!
//! `perspective` (niho-photo#46) is Lightroom's Transform (`crs:Perspective*`,
//! same units and ranges, [`Perspective`]): a projective warp of the frame
//! onto a canvas of the frame's size, applied after the quarter turns and
//! flips and before the crop, so the crop (and its angle) lies on the
//! corrected canvas ([`crate::perspective`], `docs/geometry-perspective.md`).
//! Settings with a perspective that is not the identity are `v: 7`.
//! `constrain` ("余白を埋める", Lightroom's Constrain Crop) keeps the crop
//! inside the corrected photo; `upright` (`crs:PerspectiveUpright`, 0..5) is
//! kept but not rendered. Neither makes the geometry non-identity.

use crate::settings::{num, SettingsError};
use serde_json::{Map, Value};

/// `v` of settings whose geometry is not the identity.
pub const GEOMETRY_SETTINGS_VERSION: u32 = 2;
/// `v` of settings whose geometry has a perspective that is not the
/// identity (niho-photo#46). 5 and 6 belong to other features.
pub const PERSPECTIVE_SETTINGS_VERSION: u32 = 7;
/// Straighten limit (degrees, both ways).
pub const MAX_ANGLE_DEGREES: f64 = 45.0;
/// Largest `upright` (Lightroom's `PerspectiveUpright`: 0 off, 1 auto,
/// 2 level, 3 vertical, 4 full, 5 guided).
pub const MAX_UPRIGHT: u32 = 5;

/// One of the seven Transform sliders ([`Perspective`]).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum PerspectiveField {
    Vertical,
    Horizontal,
    Rotate,
    Aspect,
    Scale,
    X,
    Y,
}

impl PerspectiveField {
    pub const ALL: [PerspectiveField; 7] = [
        PerspectiveField::Vertical,
        PerspectiveField::Horizontal,
        PerspectiveField::Rotate,
        PerspectiveField::Aspect,
        PerspectiveField::Scale,
        PerspectiveField::X,
        PerspectiveField::Y,
    ];

    /// The key in `geometry.perspective`.
    pub fn key(self) -> &'static str {
        match self {
            PerspectiveField::Vertical => "vertical",
            PerspectiveField::Horizontal => "horizontal",
            PerspectiveField::Rotate => "rotate",
            PerspectiveField::Aspect => "aspect",
            PerspectiveField::Scale => "scale",
            PerspectiveField::X => "x",
            PerspectiveField::Y => "y",
        }
    }

    /// The Camera Raw key (`crs:` stripped).
    pub fn xmp(self) -> &'static str {
        match self {
            PerspectiveField::Vertical => "PerspectiveVertical",
            PerspectiveField::Horizontal => "PerspectiveHorizontal",
            PerspectiveField::Rotate => "PerspectiveRotate",
            PerspectiveField::Aspect => "PerspectiveAspect",
            PerspectiveField::Scale => "PerspectiveScale",
            PerspectiveField::X => "PerspectiveX",
            PerspectiveField::Y => "PerspectiveY",
        }
    }

    /// The slider's range (Lightroom's): degrees for `rotate`, percent for
    /// `scale`, -100..100 for the others.
    pub fn range(self) -> (f64, f64) {
        match self {
            PerspectiveField::Rotate => (-10.0, 10.0),
            PerspectiveField::Scale => (50.0, 150.0),
            _ => (-100.0, 100.0),
        }
    }

    /// The identity's value (`scale` 100, the others 0).
    pub fn neutral(self) -> f64 {
        match self {
            PerspectiveField::Scale => 100.0,
            _ => 0.0,
        }
    }

    pub fn get(self, p: &Perspective) -> f64 {
        match self {
            PerspectiveField::Vertical => p.vertical,
            PerspectiveField::Horizontal => p.horizontal,
            PerspectiveField::Rotate => p.rotate,
            PerspectiveField::Aspect => p.aspect,
            PerspectiveField::Scale => p.scale,
            PerspectiveField::X => p.x,
            PerspectiveField::Y => p.y,
        }
    }

    pub fn get_mut(self, p: &mut Perspective) -> &mut f64 {
        match self {
            PerspectiveField::Vertical => &mut p.vertical,
            PerspectiveField::Horizontal => &mut p.horizontal,
            PerspectiveField::Rotate => &mut p.rotate,
            PerspectiveField::Aspect => &mut p.aspect,
            PerspectiveField::Scale => &mut p.scale,
            PerspectiveField::X => &mut p.x,
            PerspectiveField::Y => &mut p.y,
        }
    }

    /// The field of a Camera Raw key.
    pub fn from_xmp(key: &str) -> Option<Self> {
        Self::ALL.into_iter().find(|f| f.xmp() == key)
    }
}

/// `geometry.perspective`: Lightroom's Transform sliders in the units of
/// `crs:Perspective*` ([`PerspectiveField`]). How they warp the frame is
/// NIHO's model ([`crate::perspective`]), not calibrated against Lightroom.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct Perspective {
    /// -100..100; negative widens the top (converging verticals of a
    /// building shot from below are corrected to the left).
    pub vertical: f64,
    /// -100..100; positive widens the right side.
    pub horizontal: f64,
    /// Degrees, -10..10; positive turns the photo counter-clockwise, like a
    /// positive `angle`.
    pub rotate: f64,
    /// -100..100; positive stretches across and shrinks down (+-25% at
    /// +-100).
    pub aspect: f64,
    /// Percent, 50..150.
    pub scale: f64,
    /// -100..100; positive moves the photo right (100: half the frame's
    /// width).
    pub x: f64,
    /// -100..100; positive moves the photo down (100: half the frame's
    /// height).
    pub y: f64,
}

impl Default for Perspective {
    fn default() -> Self {
        Self {
            vertical: 0.0,
            horizontal: 0.0,
            rotate: 0.0,
            aspect: 0.0,
            scale: 100.0,
            x: 0.0,
            y: 0.0,
        }
    }
}

impl Perspective {
    pub fn is_identity(&self) -> bool {
        PerspectiveField::ALL
            .into_iter()
            .all(|f| f.get(self) == f.neutral())
    }

    fn from_value(v: &Value) -> Result<Self, SettingsError> {
        let o = v.as_object().ok_or_else(|| {
            SettingsError::new("geometry.perspective", "invalidType", "must be an object")
        })?;
        let mut p = Self::default();
        for (key, value) in o {
            let path = format!("geometry.perspective.{key}");
            let field = PerspectiveField::ALL
                .into_iter()
                .find(|f| f.key() == key)
                .ok_or_else(|| {
                    SettingsError::new(
                        &path,
                        "unknownKey",
                        "perspective has vertical, horizontal, rotate, aspect, scale, x and y only",
                    )
                })?;
            *field.get_mut(&mut p) = number(value, &path)?;
        }
        Ok(p)
    }

    fn to_value(self) -> Value {
        let mut o = Map::new();
        for f in PerspectiveField::ALL {
            o.insert(f.key().into(), num(f.get(&self)));
        }
        Value::Object(o)
    }

    fn validate(&self, issues: &mut Vec<SettingsError>) {
        for f in PerspectiveField::ALL {
            let (lo, hi) = f.range();
            if !(lo..=hi).contains(&f.get(self)) {
                issues.push(SettingsError::new(
                    &format!("geometry.perspective.{}", f.key()),
                    "outOfRange",
                    &format!("must be within {lo}..{hi}"),
                ));
            }
        }
    }
}

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
    /// Lightroom's Transform (niho-photo#46): warps the frame before the
    /// crop. Written only when it is not the identity.
    pub perspective: Perspective,
    /// "余白を埋める": with a perspective, the crop is kept inside the
    /// corrected photo ([`crate::perspective::constrain_corners`]). Written
    /// only when on.
    pub constrain: bool,
    /// Lightroom's `PerspectiveUpright` (0..=5), kept but not rendered (the
    /// automatic Upright writes its result into `perspective`). Written
    /// only when not 0.
    pub upright: f64,
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
            perspective: Perspective::default(),
            constrain: false,
            upright: 0.0,
            extra: Map::new(),
        }
    }
}

impl Geometry {
    /// Whether the frame is the working image itself: no turn (a half turn
    /// with both flips is a turn too), no angle, the whole frame, no
    /// perspective. `aspect`, `constrain` and `upright` do not count.
    pub fn is_identity(&self) -> bool {
        let turned = !matches!(
            (self.rotate % 360, self.flip_h, self.flip_v),
            (0, false, false) | (180, true, true)
        );
        !turned && self.angle == 0.0 && self.crop.is_full() && self.perspective.is_identity()
    }

    /// The perspective when it is not the identity.
    pub fn active_perspective(&self) -> Option<&Perspective> {
        (!self.perspective.is_identity()).then_some(&self.perspective)
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
                "perspective" => g.perspective = Perspective::from_value(value)?,
                "constrain" => g.constrain = boolean(value, &path)?,
                "upright" => g.upright = number(value, &path)?,
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
        if !self.perspective.is_identity() {
            o.insert("perspective".into(), self.perspective.to_value());
        }
        if self.constrain {
            o.insert("constrain".into(), Value::from(true));
        }
        if self.upright != 0.0 {
            o.insert("upright".into(), num(self.upright));
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
        self.perspective.validate(issues);
        if self.upright != libm::trunc(self.upright)
            || !(0.0..=f64::from(MAX_UPRIGHT)).contains(&self.upright)
        {
            issues.push(SettingsError::new(
                "geometry.upright",
                "outOfRange",
                &format!("must be an integer within 0..{MAX_UPRIGHT}"),
            ));
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

    #[test]
    fn a_perspective_is_not_the_identity_and_round_trips() {
        let g = geometry(r#"{"perspective":{"vertical":-30,"scale":90,"x":12.5}}"#);
        assert!(!g.is_identity());
        assert_eq!(g.perspective.vertical, -30.0);
        assert_eq!(g.perspective.scale, 90.0);
        assert_eq!(g.perspective.horizontal, 0.0);
        let out = g.to_value();
        // Every key is written once the perspective is not the identity.
        assert_eq!(out["perspective"]["rotate"], 0);
        assert_eq!(out["perspective"]["x"], 12.5);
        assert_eq!(Geometry::from_value(&out).unwrap(), g);
        // The identity's values (scale 100) are the identity, and are not
        // written; `constrain` and `upright` do not count.
        let neutral =
            geometry(r#"{"perspective":{"vertical":0,"scale":100},"constrain":true,"upright":3}"#);
        assert!(neutral.is_identity());
        let out = neutral.to_value();
        assert!(out.get("perspective").is_none());
        assert_eq!(out["constrain"], true);
        assert_eq!(out["upright"], 3);
        assert_eq!(Geometry::from_value(&out).unwrap(), neutral);
        // Off and 0 are not written (an old geometry keeps its shape).
        let plain = geometry(r#"{"rotate":90,"constrain":false,"upright":0}"#).to_value();
        assert!(plain.get("constrain").is_none() && plain.get("upright").is_none());
    }

    #[test]
    fn perspective_ranges_and_shapes_are_checked() {
        let codes = |json: &str| {
            let mut issues = Vec::new();
            geometry(json).validate(&mut issues);
            issues
                .into_iter()
                .map(|e| (e.path, e.code))
                .collect::<Vec<_>>()
        };
        for (key, ok, bad) in [
            ("vertical", -100.0, -100.5),
            ("horizontal", 100.0, 101.0),
            ("rotate", 10.0, 10.1),
            ("aspect", -100.0, -101.0),
            ("scale", 50.0, 49.9),
            ("scale", 150.0, 151.0),
            ("x", 100.0, 100.01),
            ("y", -100.0, -120.0),
        ] {
            assert!(codes(&format!(r#"{{"perspective":{{"{key}":{ok}}}}}"#)).is_empty());
            assert_eq!(
                codes(&format!(r#"{{"perspective":{{"{key}":{bad}}}}}"#)),
                vec![(format!("geometry.perspective.{key}"), "outOfRange".into())]
            );
        }
        for bad in ["-1", "6", "1.5"] {
            assert_eq!(
                codes(&format!(r#"{{"upright":{bad}}}"#)),
                vec![("geometry.upright".into(), "outOfRange".into())]
            );
        }
        let code = |json: &str| {
            Geometry::from_value(&serde_json::from_str(json).unwrap())
                .unwrap_err()
                .code
        };
        assert_eq!(code(r#"{"perspective":{"tilt":1}}"#), "unknownKey");
        assert_eq!(code(r#"{"perspective":{"vertical":"1"}}"#), "invalidType");
        assert_eq!(code(r#"{"perspective":[]}"#), "invalidType");
        assert_eq!(code(r#"{"constrain":1}"#), "invalidType");
        assert_eq!(code(r#"{"upright":"auto"}"#), "invalidType");
    }

    #[test]
    fn perspective_fields_name_lightrooms_keys() {
        for f in PerspectiveField::ALL {
            assert_eq!(PerspectiveField::from_xmp(f.xmp()), Some(f));
            let (lo, hi) = f.range();
            assert!(lo < f.neutral() && f.neutral() < hi);
        }
        assert_eq!(PerspectiveField::from_xmp("PerspectiveUpright"), None);
    }
}
