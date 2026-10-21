//! Lightroom's local adjustments in an XMP preset -> NIHO `masks` (Epic #31
//! M6, #69). The contract is `docs/local-adjustments.md` ("Lightroom の XMP
//! の読み"); this module only reads, the caller places the result.
//!
//! - Read: `crs:MaskGroupBasedCorrections` (Lightroom 11+), one correction
//!   = one NIHO mask when it has exactly one `Mask/Gradient` (linear) or an
//!   unrotated `Mask/CircularGradient` (radial).
//! - Legacy lists are not read: no real export of
//!   `crs:GradientBasedCorrections` / `crs:CircularGradientBasedCorrections`
//!   has confirmed their units and shapes, so every correction is reported
//!   (`<List>.<n>.legacyList`; `crs:PaintBasedCorrections` as `brush`).
//!   Next to `crs:MaskGroupBasedCorrections` (which then carries the same
//!   masks) they are only `metadata`.
//! - Coordinates: a preset's mask coordinates are relative to the visible
//!   frame of the photo it is applied to (cropped, rotated, flipped), so the
//!   masks come out in that frame ([`super::PresetResult::masks`]); the
//!   caller maps them into the working image. Linear: `Zero*` -> `zero`,
//!   `Full*` -> `full`. Radial: the centre of `Left..Right` x `Top..Bottom`
//!   and half its width / height; `Feather` 0..100 straight into `feather`
//!   (an approximation of Lightroom's falloff).
//! - `adjust`: the bipolar `Local*` sliders are stored as slider / 100 (x 100
//!   here), `LocalExposure2012` in EV; `CorrectionAmount` (0..1) scales every
//!   delta, `CorrectionActive` / `MaskActive` = `false` is `enabled: false`,
//!   `MaskInverted` = `true` is `invert`. `LocalTemperature` / `LocalTint`
//!   become the relative white balance deltas (approximate).
//! - Not read (reported as `unsupported` items `<List>.<n>.<reason>`, the
//!   correction left out): brushes, AI masks (`Mask/Image`), range masks,
//!   several masks or a blend mode in one correction, `MaskValue` other than
//!   1, rotated radials (their parameters are not known), `Roundness`,
//!   `Midpoint` other than 50, `Flipped` other than `true`, shapes outside
//!   NIHO's ranges and the 9th mask on. Non-zero `Local*` sliders NIHO has
//!   no local twin for are reported per key while the mask keeps the rest.

use super::{swift_double, CompatibilityItem, Level, XmlNode, XmpDocument};
use crate::local_mask::{validate_masks, LocalAdjust, LocalMask, MaskKind, MaskPoint, MaskShape};
use crate::settings::{WhiteBalanceMode, MAX_LOCAL_MASKS};
use std::collections::BTreeMap;

/// The local correction lists of the root description that [`super::parse`]
/// keeps as element trees ([`XmpDocument::local_corrections`]).
pub const LOCAL_CORRECTION_LISTS: [&str; 4] = [
    "crs:MaskGroupBasedCorrections",
    "crs:GradientBasedCorrections",
    "crs:CircularGradientBasedCorrections",
    "crs:PaintBasedCorrections",
];

const MASK_GROUP_LIST: &str = "crs:MaskGroupBasedCorrections";
const PAINT_LIST: &str = "crs:PaintBasedCorrections";

/// The kinds of a correction's masks (`crs:What`, joined), for a report.
fn correction_what(li: &XmlNode) -> String {
    let whats: Vec<String> = Resource::of(li)
        .structure("CorrectionMasks")
        .map(|masks| {
            rdf_items(masks)
                .filter_map(|mask| Resource::of(mask).get("What").map(str::to_string))
                .collect()
        })
        .unwrap_or_default();
    if whats.is_empty() {
        "Correction".into()
    } else {
        whats.join(",")
    }
}

const PM: (f64, f64) = (-100.0, 100.0);

/// The masks and the report of [`read_local_masks`].
pub(super) struct LocalMasksRead {
    /// Visible-frame coordinates, ids `xmp-1`..., at most [`MAX_LOCAL_MASKS`].
    pub masks: Vec<LocalMask>,
    pub items: Vec<CompatibilityItem>,
}

/// Reads the local corrections of `doc`. `mode` is the white balance mode of
/// the settings the masks go with: an absolute white has no relative local
/// white balance (`localWhiteBalance`), so those deltas are dropped and
/// reported.
pub(super) fn read_local_masks(doc: &XmpDocument, mode: WhiteBalanceMode) -> LocalMasksRead {
    let mut read = LocalMasksRead {
        masks: Vec::new(),
        items: Vec::new(),
    };
    let has_mask_group = doc
        .local_corrections
        .iter()
        .any(|list| list.name == MASK_GROUP_LIST);
    for list in &doc.local_corrections {
        let list_name = list.name.trim_start_matches("crs:");
        if has_mask_group && list.name != MASK_GROUP_LIST {
            read.items.push(item(
                list_name.to_string(),
                format!("{} corrections", rdf_items(list).count()),
                Level::Metadata,
                "MaskGroupBasedCorrections を読むので、旧形式の一覧（同じマスク）は使わない",
            ));
            continue;
        }
        if list.name != MASK_GROUP_LIST {
            // No real export of the legacy lists has been checked yet: their
            // units and shapes are not assumed to be the mask groups'.
            let (reason, note) = if list.name == PAINT_LIST {
                (
                    "brush",
                    "ブラシのマスク（旧形式）は写真ごとに描いた線で、プリセットからは読まない",
                )
            } else {
                (
                    "legacyList",
                    "旧形式の局所補正は、実物の XMP で形を確かめていないため読まない",
                )
            };
            for (index, li) in rdf_items(list).enumerate() {
                read.items.push(item(
                    format!("{list_name}.{}.{reason}", index + 1),
                    correction_what(li),
                    Level::Unsupported,
                    note,
                ));
            }
            continue;
        }
        for (index, li) in rdf_items(list).enumerate() {
            let prefix = format!("{list_name}.{}", index + 1);
            let correction = read_correction(&prefix, li, mode);
            let Some((mask, read_item, mut rest)) = correction.mask else {
                read.items.extend(correction.items);
                continue;
            };
            if read.masks.len() >= MAX_LOCAL_MASKS {
                read.items.push(item(
                    format!("{prefix}.tooMany"),
                    read_item.value,
                    Level::Unsupported,
                    "マスクは 8 枚まで（9 枚目からは読まない）",
                ));
                continue;
            }
            let id = format!("xmp-{}", read.masks.len() + 1);
            read.items.push(CompatibilityItem {
                note: format!("{} → masks の {id}", read_item.note),
                ..read_item
            });
            read.items.append(&mut rest);
            read.masks.push(LocalMask { id, ..mask });
        }
    }
    read
}

/// What one correction became: a mask (with its "read" item and the other
/// items) or only items.
struct CorrectionRead {
    mask: Option<(LocalMask, CompatibilityItem, Vec<CompatibilityItem>)>,
    items: Vec<CompatibilityItem>,
}

fn item(
    property: String,
    value: impl Into<String>,
    level: Level,
    note: impl Into<String>,
) -> CompatibilityItem {
    CompatibilityItem {
        property,
        value: value.into(),
        level,
        // Photo Bench reads no local corrections.
        photo_bench_level: Level::Unsupported,
        note: note.into(),
    }
}

// MARK: - RDF resources

/// The `crs` properties and structures of one RDF resource: an `rdf:li`'s
/// attributes, its simple `crs:` children (`rdf:parseType="Resource"`) and
/// its `rdf:Description`'s, the first value of a key winning.
struct Resource<'a> {
    props: BTreeMap<String, String>,
    structs: Vec<&'a XmlNode>,
}

impl<'a> Resource<'a> {
    fn of(node: &'a XmlNode) -> Self {
        let mut resource = Resource {
            props: BTreeMap::new(),
            structs: Vec::new(),
        };
        resource.collect(node);
        resource
    }

    fn collect(&mut self, node: &'a XmlNode) {
        for (key, value) in &node.attributes {
            if let Some(name) = key.strip_prefix("crs:") {
                self.props
                    .entry(name.to_string())
                    .or_insert_with(|| value.clone());
            }
        }
        for child in &node.children {
            if child.name == "rdf:Description" {
                self.collect(child);
            } else if let Some(name) = child.name.strip_prefix("crs:") {
                let has_crs_attributes =
                    child.attributes.iter().any(|(k, _)| k.starts_with("crs:"));
                if child.children.is_empty() && !has_crs_attributes {
                    let text = child.text.trim();
                    if !text.is_empty() {
                        self.props
                            .entry(name.to_string())
                            .or_insert_with(|| text.to_string());
                    }
                } else {
                    self.structs.push(child);
                }
            }
        }
    }

    fn get(&self, key: &str) -> Option<&str> {
        self.props.get(key).map(String::as_str)
    }

    /// `None` when absent, `Some(None)` when not a finite number.
    fn number(&self, key: &str) -> Option<Option<f64>> {
        self.get(key)
            .map(|raw| swift_double(raw.trim()).filter(|v| v.is_finite()))
    }

    /// `None` when absent, `Some(None)` when neither `true` nor `false`.
    fn boolean(&self, key: &str) -> Option<Option<bool>> {
        self.get(key)
            .map(|raw| match raw.trim().to_ascii_lowercase().as_str() {
                "true" => Some(true),
                "false" => Some(false),
                _ => None,
            })
    }

    fn structure(&self, name: &str) -> Option<&'a XmlNode> {
        self.structs
            .iter()
            .copied()
            .find(|node| node.name.strip_prefix("crs:") == Some(name))
    }
}

/// The `rdf:li` items of the `rdf:Seq` / `rdf:Bag` / `rdf:Alt` in `node`.
fn rdf_items(node: &XmlNode) -> impl Iterator<Item = &XmlNode> {
    node.children
        .iter()
        .filter(|child| matches!(child.name.as_str(), "rdf:Seq" | "rdf:Bag" | "rdf:Alt"))
        .flat_map(|seq| seq.children.iter().filter(|li| li.name == "rdf:li"))
}

// MARK: - One correction

/// A reason a correction is left out: the item key's last part, its value
/// and the note.
struct Blocker {
    reason: &'static str,
    value: String,
    note: String,
}

impl Blocker {
    fn new(reason: &'static str, value: impl Into<String>, note: impl Into<String>) -> Self {
        Blocker {
            reason,
            value: value.into(),
            note: note.into(),
        }
    }
}

const NOTE_INVALID: &str = "値が欠けているか有限数として読めないため読まない";

/// The kind of one Lightroom mask (`crs:What`).
enum LrMask<'a> {
    Linear(Resource<'a>),
    Radial(Resource<'a>),
    Brush,
    Ai(String),
    Range,
    Unknown(String),
    Missing,
}

fn classify(node: &XmlNode) -> LrMask<'_> {
    let resource = Resource::of(node);
    let Some(what) = resource.get("What").map(str::to_string) else {
        return LrMask::Missing;
    };
    match what.as_str() {
        "Mask/Gradient" => LrMask::Linear(resource),
        "Mask/CircularGradient" => LrMask::Radial(resource),
        "Mask/Paint" => LrMask::Brush,
        "Mask/Aggregate" => {
            let painted = resource.structure("Masks").is_some_and(|masks| {
                rdf_items(masks).any(|sub| Resource::of(sub).get("What") == Some("Mask/Paint"))
            });
            if painted {
                LrMask::Brush
            } else {
                LrMask::Unknown(what)
            }
        }
        "Mask/Image" => {
            let subtype = resource.get("MaskSubType").unwrap_or("").to_string();
            LrMask::Ai(if subtype.is_empty() {
                what
            } else {
                format!("{what} (MaskSubType={subtype})")
            })
        }
        _ if what.contains("Range") => LrMask::Range,
        _ => LrMask::Unknown(what),
    }
}

fn read_correction(prefix: &str, li: &XmlNode, mode: WhiteBalanceMode) -> CorrectionRead {
    let correction = Resource::of(li);
    let mask_nodes: Vec<&XmlNode> = correction
        .structure("CorrectionMasks")
        .map(|masks| rdf_items(masks).collect())
        .unwrap_or_default();
    let blocked = |blockers: Vec<Blocker>| CorrectionRead {
        mask: None,
        items: blockers
            .into_iter()
            .map(|b| {
                item(
                    format!("{prefix}.{}", b.reason),
                    b.value,
                    Level::Unsupported,
                    b.note,
                )
            })
            .collect(),
    };
    let mut blockers = Vec::new();
    if correction.structure("CorrectionRangeMask").is_some() {
        blockers.push(Blocker::new(
            "rangeMask",
            "CorrectionRangeMask",
            "範囲マスク（輝度・色・深度）は未対応",
        ));
    }
    if mask_nodes.is_empty() {
        blockers.push(Blocker::new(
            "invalid",
            "CorrectionMasks",
            "マスクの形が無い補正は読まない",
        ));
        return blocked(blockers);
    }
    let kinds: Vec<LrMask> = mask_nodes.iter().map(|node| classify(node)).collect();
    // Kinds NIHO cannot read are named first (a brush of several strokes is
    // still "a brush", not "several masks").
    if kinds.iter().any(|k| matches!(k, LrMask::Brush)) {
        blockers.push(Blocker::new(
            "brush",
            "Mask/Paint",
            "ブラシのマスクは写真ごとに描いた線で、プリセットからは読まない",
        ));
    }
    for kind in &kinds {
        if let LrMask::Ai(value) = kind {
            blockers.push(Blocker::new(
                "aiMask",
                value.clone(),
                "AI のマスク（被写体・空・背景・人物など）は写真ごとの検出で、プリセットからは作らない",
            ));
        }
    }
    if kinds.iter().any(|k| matches!(k, LrMask::Range)) {
        blockers.push(Blocker::new(
            "rangeMask",
            "Mask/RangeMask",
            "範囲マスク（輝度・色・深度）は未対応",
        ));
    }
    for kind in &kinds {
        match kind {
            LrMask::Unknown(what) => blockers.push(Blocker::new(
                "unknownMask",
                what.clone(),
                "未認識の種類のマスクは読まない",
            )),
            LrMask::Missing => blockers.push(Blocker::new("invalid", "What", NOTE_INVALID)),
            _ => {}
        }
    }
    if blockers.is_empty() && kinds.len() > 1 {
        blockers.push(Blocker::new(
            "multipleMasks",
            format!("{} masks", kinds.len()),
            "1 つの補正に重ねた複数のマスク（追加・交差・除外）は未対応",
        ));
    }
    if !blockers.is_empty() {
        return blocked(blockers);
    }
    let mask_resource = match kinds.into_iter().next() {
        Some(LrMask::Linear(r)) => (MaskKind::Linear, r),
        Some(LrMask::Radial(r)) => (MaskKind::Radial, r),
        _ => unreachable!("other kinds are blocked above"),
    };
    let (kind, mask) = mask_resource;
    let what = mask.get("What").unwrap_or_default().to_string();

    // The mask's own switches.
    let blend = mask.number("MaskBlendMode");
    if blend.is_some_and(|v| v != Some(0.0)) {
        blockers.push(Blocker::new(
            "maskBlend",
            mask.get("MaskBlendMode").unwrap_or_default(),
            "マスクの重ね方（MaskBlendMode が 0 以外）は未対応",
        ));
    }
    match mask.number("MaskValue") {
        Some(Some(v)) if v != 1.0 => blockers.push(Blocker::new(
            "maskValue",
            mask.get("MaskValue").unwrap_or_default(),
            "マスクの不透明度（MaskValue が 1 以外）は未対応",
        )),
        Some(None) => blockers.push(Blocker::new("invalid", "MaskValue", NOTE_INVALID)),
        _ => {}
    }
    let switch =
        |resource: &Resource, key: &'static str, default: bool, blockers: &mut Vec<Blocker>| {
            match resource.boolean(key) {
                None => default,
                Some(Some(v)) => v,
                Some(None) => {
                    blockers.push(Blocker::new(
                        "invalid",
                        format!("{key}={}", resource.get(key).unwrap_or_default()),
                        "true / false 以外の値は読まない",
                    ));
                    default
                }
            }
        };
    let mask_active = switch(&mask, "MaskActive", true, &mut blockers);
    let invert = switch(&mask, "MaskInverted", false, &mut blockers);
    let correction_active = switch(&correction, "CorrectionActive", true, &mut blockers);
    let amount = match correction.number("CorrectionAmount") {
        None => 1.0,
        Some(Some(v)) if (0.0..=1.0).contains(&v) => v,
        Some(_) => {
            blockers.push(Blocker::new(
                "invalid",
                format!(
                    "CorrectionAmount={}",
                    correction.get("CorrectionAmount").unwrap_or_default()
                ),
                "補正の量（CorrectionAmount）は 0〜1 の有限数だけ読む",
            ));
            1.0
        }
    };
    let shape = match kind {
        MaskKind::Linear => linear_shape(&mask, &mut blockers),
        _ => radial_shape(&mask, &mut blockers),
    };
    if !blockers.is_empty() {
        return blocked(blockers);
    }
    let Some(shape) = shape else {
        return blocked(vec![Blocker::new("invalid", what, NOTE_INVALID)]);
    };

    let mut items = Vec::new();
    let adjust = local_adjust(prefix, &correction, amount, mode, &mut items);
    let candidate = LocalMask {
        id: "xmp-0".into(),
        kind,
        enabled: mask_active && correction_active,
        invert,
        shape,
        adjust,
    };
    let issues = validate_masks(std::slice::from_ref(&candidate), mode);
    if !issues.is_empty() {
        let paths: Vec<String> = issues
            .iter()
            .map(|issue| issue.path.trim_start_matches("masks[0].").to_string())
            .collect();
        return blocked(vec![Blocker::new(
            "outOfRange",
            what,
            format!(
                "NIHO のマスクの範囲（中心は枠の中・半軸 0.005〜1.5・線形の点 −1〜2）の外なので読まない（{}）",
                paths.join(", ")
            ),
        )]);
    }
    let (property, note) = match kind {
        MaskKind::Linear => (
            format!("{prefix}.linear"),
            "線形グラデーション（座標は当てる写真の見えている枠。NIHO の部分補正で描く）",
        ),
        _ => (
            format!("{prefix}.radial"),
            "円形グラデーション（座標は当てる写真の見えている枠。ぼかしは Feather をそのまま使う近似）",
        ),
    };
    let read_item = item(property, what, Level::Approximate, note);
    CorrectionRead {
        mask: Some((candidate, read_item, items)),
        items: Vec::new(),
    }
}

/// A required finite number of a mask (`None` reports it as invalid).
fn required(mask: &Resource, key: &str, blockers: &mut Vec<Blocker>) -> Option<f64> {
    match mask.number(key) {
        Some(Some(v)) => Some(v),
        _ => {
            blockers.push(Blocker::new("invalid", key, NOTE_INVALID));
            None
        }
    }
}

fn linear_shape(mask: &Resource, blockers: &mut Vec<Blocker>) -> Option<MaskShape> {
    let zero_x = required(mask, "ZeroX", blockers);
    let zero_y = required(mask, "ZeroY", blockers);
    let full_x = required(mask, "FullX", blockers);
    let full_y = required(mask, "FullY", blockers);
    Some(MaskShape::Linear {
        zero: MaskPoint {
            x: zero_x?,
            y: zero_y?,
        },
        full: MaskPoint {
            x: full_x?,
            y: full_y?,
        },
    })
}

fn radial_shape(mask: &Resource, blockers: &mut Vec<Blocker>) -> Option<MaskShape> {
    let top = required(mask, "Top", blockers);
    let left = required(mask, "Left", blockers);
    let bottom = required(mask, "Bottom", blockers);
    let right = required(mask, "Right", blockers);
    let feather = required(mask, "Feather", blockers);
    let mut optional = |key: &'static str, default: f64| match mask.number(key) {
        None => Some(default),
        Some(Some(v)) => Some(v),
        Some(None) => {
            blockers.push(Blocker::new("invalid", key, NOTE_INVALID));
            None
        }
    };
    let angle = optional("Angle", 0.0);
    let roundness = optional("Roundness", 0.0);
    let midpoint = optional("Midpoint", 50.0);
    let raw = |key: &str| mask.get(key).unwrap_or_default().to_string();
    if angle.is_some_and(|a| a != 0.0) {
        blockers.push(Blocker::new(
            "rotatedRadial",
            format!("Angle={}", raw("Angle")),
            "回転した円形グラデーションは Lightroom の値（Top / Left / Bottom / Right）の意味が未確認のため読まない",
        ));
    }
    if roundness.is_some_and(|r| r != 0.0) {
        blockers.push(Blocker::new(
            "radialRoundness",
            format!("Roundness={}", raw("Roundness")),
            "円形グラデーションの丸み（Roundness が 0 以外）は未対応",
        ));
    }
    if midpoint.is_some_and(|m| m != 50.0) {
        blockers.push(Blocker::new(
            "radialMidpoint",
            format!("Midpoint={}", raw("Midpoint")),
            "円形グラデーションの中点（Midpoint が 50 以外）は未対応",
        ));
    }
    // Only `Flipped="true"` (the effect inside) was observed on Lightroom's
    // radials; anything else has no known meaning yet.
    if mask.boolean("Flipped") != Some(Some(true)) {
        blockers.push(Blocker::new(
            "radialFlipped",
            format!("Flipped={}", mask.get("Flipped").unwrap_or("(なし)")),
            "Flipped が true 以外の円形グラデーションは意味が未確認のため読まない",
        ));
    }
    if mask.number("Version").is_some_and(|v| v != Some(2.0)) {
        blockers.push(Blocker::new(
            "radialVersion",
            format!("Version={}", raw("Version")),
            "未確認の版（Version が 2 以外）の円形グラデーションは読まない",
        ));
    }
    let (top, left, bottom, right, feather) = (top?, left?, bottom?, right?, feather?);
    if right <= left || bottom <= top {
        blockers.push(Blocker::new(
            "outOfRange",
            format!("Left={left} Right={right} Top={top} Bottom={bottom}"),
            "左右・上下の順が逆の円形グラデーションは読まない",
        ));
        return None;
    }
    Some(MaskShape::Radial {
        center: MaskPoint {
            x: (left + right) / 2.0,
            y: (top + bottom) / 2.0,
        },
        radius_x: (right - left) / 2.0,
        radius_y: (bottom - top) / 2.0,
        angle: 0.0,
        feather,
    })
}

// MARK: - The local sliders

/// The `adjust` slot of a Lightroom local slider NIHO carries: the slot, the
/// factor from the stored value and the slot's range.
fn local_slot<'a>(
    adjust: &'a mut LocalAdjust,
    key: &str,
) -> Option<(&'a mut f64, f64, (f64, f64))> {
    Some(match key {
        "LocalExposure2012" => (&mut adjust.exposure, 1.0, (-5.0, 5.0)),
        "LocalContrast2012" => (&mut adjust.contrast, 100.0, PM),
        "LocalHighlights2012" => (&mut adjust.highlights, 100.0, PM),
        "LocalShadows2012" => (&mut adjust.shadows, 100.0, PM),
        "LocalWhites2012" => (&mut adjust.whites, 100.0, PM),
        "LocalBlacks2012" => (&mut adjust.blacks, 100.0, PM),
        "LocalTexture" => (&mut adjust.texture, 100.0, PM),
        "LocalClarity2012" => (&mut adjust.clarity, 100.0, PM),
        "LocalDehaze" => (&mut adjust.dehaze, 100.0, PM),
        "LocalSaturation" => (&mut adjust.saturation, 100.0, PM),
        "LocalTemperature" => (&mut adjust.relative_temperature, 100.0, PM),
        "LocalTint" => (&mut adjust.relative_tint, 100.0, PM),
        _ => return None,
    })
}

/// Lightroom local sliders without a NIHO local twin (reported when not 0).
/// The 2010 `LocalExposure` / `LocalContrast` / `LocalClarity` lose to their
/// 2012 keys.
const LOCAL_UNSUPPORTED: [(&str, &str); 10] = [
    ("LocalHue", "色相"),
    ("LocalSharpness", "シャープ"),
    ("LocalLuminanceNoise", "ノイズ軽減"),
    ("LocalMoire", "モアレ軽減"),
    ("LocalDefringe", "フリンジ軽減"),
    ("LocalToningSaturation", "カラー（色の塗り）"),
    ("LocalBrightness", "明るさ（旧式）"),
    ("LocalExposure", "露光量（旧式。2012 の値を使う）"),
    ("LocalContrast", "コントラスト（旧式。2012 の値を使う）"),
    ("LocalClarity", "明瞭度（旧式。2012 の値を使う）"),
];

/// The correction's `Local*` sliders as `adjust` (times `amount`), with an
/// item for every key that is not carried over as is.
fn local_adjust(
    prefix: &str,
    correction: &Resource,
    amount: f64,
    mode: WhiteBalanceMode,
    items: &mut Vec<CompatibilityItem>,
) -> LocalAdjust {
    let mut adjust = LocalAdjust::default();
    for (key, raw) in &correction.props {
        // The toning hue has no effect without a toning saturation (which
        // is reported itself when it is not 0).
        if !key.starts_with("Local") || key == "LocalToningHue" {
            continue;
        }
        let property = format!("{prefix}.{key}");
        let Some(value) = swift_double(raw.trim()).filter(|v| v.is_finite()) else {
            items.push(item(
                property,
                raw.clone(),
                Level::Unsupported,
                "有限数として読めないため使わない",
            ));
            continue;
        };
        if key == "LocalCurveRefineSaturation" {
            if value != 100.0 {
                items.push(item(
                    property,
                    raw.clone(),
                    Level::Unsupported,
                    "マスクのトーンカーブの彩度（100 以外）は未対応",
                ));
            }
            continue;
        }
        if value == 0.0 {
            continue;
        }
        if let Some((_, name)) = LOCAL_UNSUPPORTED.iter().find(|(k, _)| k == key) {
            let value_text = if key == "LocalToningSaturation" {
                let hue = correction.get("LocalToningHue").unwrap_or("0");
                format!("{raw} (LocalToningHue={hue})")
            } else {
                raw.clone()
            };
            items.push(item(
                property,
                value_text,
                Level::Unsupported,
                format!("マスクの{name}は未対応（値を使わない）"),
            ));
            continue;
        }
        let white_balance = matches!(key.as_str(), "LocalTemperature" | "LocalTint");
        if white_balance && mode == WhiteBalanceMode::Absolute {
            items.push(item(
                property,
                raw.clone(),
                Level::Unsupported,
                "絶対のホワイトバランス（Custom の色温度など）の写真には局所の色温度・色かぶりを当てない",
            ));
            continue;
        }
        let Some((slot, factor, range)) = local_slot(&mut adjust, key) else {
            items.push(item(
                property,
                raw.clone(),
                Level::Unsupported,
                "未認識の局所補正（値を使わない）",
            ));
            continue;
        };
        let scaled = value * factor * amount;
        *slot = scaled.clamp(range.0, range.1);
        if *slot != scaled {
            items.push(item(
                property,
                raw.clone(),
                Level::Approximate,
                format!("範囲外の値を {}..{} に丸めて使う", range.0, range.1),
            ));
        } else if white_balance {
            items.push(item(
                property,
                raw.clone(),
                Level::Approximate,
                "局所の色温度・色かぶりは NIHO の相対のホワイトバランス（差分）で近似",
            ));
        }
    }
    adjust
}
