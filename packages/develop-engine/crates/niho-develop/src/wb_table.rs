//! The white-balance matrix table (`niho-develop-wb-table/v1`, S11 #17108):
//! a RAW working copy re-rendered at another white exactly as Apple's RAW
//! decoder renders it, instead of the chromatic adaptation that
//! approximates it.
//!
//! With gamut mapping off, Core Image's linear ProPhoto output of a RAW
//! rendered at white `w` is `out(w) = M(w) · out(reference)`, a 3x3 that
//! depends only on the camera model and `w` (the structure of Lightroom's
//! white balance too). Stage 1 (`apple-raw-linear` 0.4.2) copies the model's
//! table into the working-copy metadata (`whiteBalanceTable`) after its
//! self-check on that RAW. The table holds `I(w) = M(w)^-1` (row-major) on a
//! (mired, tint) grid of Lightroom-scale whites, node (`i_mired`, `i_tint`)
//! at `i_mired * len(tint) + i_tint`. The arithmetic is the reference
//! implementation's (`tools/calibrate/wbtable.py`), in the same order:
//!
//! - `I(w)`: the node inverses interpolated bilinearly, entry-wise, in
//!   (`1e6 / K`, tint), the white clamped to the grid;
//! - `M(w) = I(w)^-1`;
//! - the working copy (Core Image's output times the calibration matrix `C`)
//!   from the as-shot white `w0` to the target `w1`:
//!   `C · M(w1) · I(w0) · C^-1`.

use crate::color::{mat_inverse, mat_mul, Mat3, IDENTITY};
use serde_json::Value;

/// `whiteBalanceTable.schema` read by this version.
pub const WB_TABLE_SCHEMA: &str = "niho-develop-wb-table/v1";
/// `whiteBalanceTable.space`: Core Image's linear output in ProPhoto (D50).
pub const WB_TABLE_SPACE: &str = "apple-linear-prophoto-d50";
/// `whiteBalanceTable.scale`: the whites are Lightroom's (K, tint).
pub const WB_TABLE_SCALE: &str = "lightroom";
/// `whiteBalanceTable.targetMap.schema` read by this version.
pub const WB_TARGET_MAP_SCHEMA: &str = "niho-develop-wb-target-map/v1";
/// A matrix with `|det|` at or below this is singular (`wbtable.py`).
const SINGULAR_DETERMINANT: f64 = 1e-9;
const MINIMUM_KELVIN: f64 = 2000.0;
const MAXIMUM_KELVIN: f64 = 50000.0;
const MINIMUM_TINT: f64 = -150.0;
const MAXIMUM_TINT: f64 = 150.0;

/// A camera-specific correction from the requested Lightroom white to the
/// table white that best reproduces that target. It applies only to `w1`;
/// the working copy's as-shot `w0` remains on the table's original scale.
#[derive(Debug, Clone, PartialEq)]
struct WhiteBalanceTargetMap {
    kelvin: Vec<f64>,
    temperature_offsets: Vec<f64>,
    tint_offsets: Vec<f64>,
    full_delta_mired: f64,
    full_delta_tint: f64,
}

impl WhiteBalanceTargetMap {
    fn from_json(value: &Value) -> Result<Self, String> {
        let object = value
            .as_object()
            .ok_or("whiteBalanceTable.targetMap must be an object")?;
        if object.get("schema").and_then(Value::as_str) != Some(WB_TARGET_MAP_SCHEMA) {
            let got = object.get("schema").unwrap_or(&Value::Null);
            return Err(format!(
                "whiteBalanceTable.targetMap.schema must be '{WB_TARGET_MAP_SCHEMA}' (got {got})"
            ));
        }
        let kelvin = object
            .get("kelvin")
            .and_then(finite_numbers)
            .filter(|v| v.len() >= 2 && v.windows(2).all(|w| w[0] < w[1]))
            .ok_or(
                "whiteBalanceTable.targetMap.kelvin must be a strictly ascending list of at least 2 finite numbers",
            )?;
        if !kelvin
            .iter()
            .all(|k| (MINIMUM_KELVIN..=MAXIMUM_KELVIN).contains(k))
        {
            return Err("whiteBalanceTable.targetMap.kelvin must be within 2000..50000".into());
        }
        let offsets = |key: &str| {
            object
                .get(key)
                .and_then(finite_numbers)
                .filter(|v| v.len() == kelvin.len())
                .ok_or_else(|| {
                    format!(
                        "whiteBalanceTable.targetMap.{key} must be {} finite numbers",
                        kelvin.len()
                    )
                })
        };
        let temperature_offsets = offsets("temperatureOffsets")?;
        let tint_offsets = offsets("tintOffsets")?;
        for (key, values) in [
            ("temperatureOffsets", &temperature_offsets),
            ("tintOffsets", &tint_offsets),
        ] {
            if values.first() != Some(&0.0) || values.last() != Some(&0.0) {
                return Err(format!(
                    "whiteBalanceTable.targetMap.{key} must be 0 at both endpoints"
                ));
            }
        }
        let mapped_kelvin: Vec<f64> = kelvin
            .iter()
            .zip(&temperature_offsets)
            .map(|(k, offset)| k + offset)
            .collect();
        if !mapped_kelvin
            .iter()
            .all(|k| (MINIMUM_KELVIN..=MAXIMUM_KELVIN).contains(k))
        {
            return Err(
                "whiteBalanceTable.targetMap mapped kelvin must be within 2000..50000".into(),
            );
        }
        if !mapped_kelvin.windows(2).all(|w| w[0] < w[1]) {
            return Err(
                "whiteBalanceTable.targetMap mapped kelvin must be strictly ascending".into(),
            );
        }
        let positive = |key: &str| {
            object
                .get(key)
                .and_then(Value::as_f64)
                .filter(|v| v.is_finite() && *v > 0.0)
                .ok_or_else(|| {
                    format!("whiteBalanceTable.targetMap.{key} must be a positive finite number")
                })
        };
        Ok(Self {
            kelvin,
            temperature_offsets,
            tint_offsets,
            full_delta_mired: positive("fullDeltaMired")?,
            full_delta_tint: positive("fullDeltaTint")?,
        })
    }

    /// Piecewise-linear full offsets at a requested target. Outside the
    /// knot interval the map is the identity.
    fn offsets(&self, temperature: f64) -> (f64, f64) {
        if temperature < self.kelvin[0] || temperature > self.kelvin[self.kelvin.len() - 1] {
            return (0.0, 0.0);
        }
        let (index, weight) = cell(&self.kelvin, temperature);
        let interpolate =
            |values: &[f64]| values[index] + weight * (values[index + 1] - values[index]);
        (
            interpolate(&self.temperature_offsets),
            interpolate(&self.tint_offsets),
        )
    }

    fn weight(&self, as_shot: (f64, f64), target: (f64, f64)) -> f64 {
        let distance = ((1e6 / target.0 - 1e6 / as_shot.0).abs() / self.full_delta_mired)
            .max((target.1 - as_shot.1).abs() / self.full_delta_tint)
            .clamp(0.0, 1.0);
        distance * distance * (3.0 - 2.0 * distance)
    }

    /// Maps target temperature through monotone nodes for this as-shot white
    /// and tint. Interpolating the already-faded knot values avoids the
    /// reversals that can occur when a temperature offset is multiplied by a
    /// target-dependent fade at every queried Kelvin.
    fn mapped_temperature(&self, as_shot: (f64, f64), target: (f64, f64)) -> f64 {
        let first = self.kelvin[0];
        let last = self.kelvin[self.kelvin.len() - 1];
        if target.0 < first || target.0 > last {
            return target.0;
        }

        let mut nodes: Vec<(f64, f64)> = self
            .kelvin
            .iter()
            .map(|&kelvin| {
                let (offset, _) = self.offsets(kelvin);
                let weight = self.weight(as_shot, (kelvin, target.1));
                (kelvin, (kelvin + weight * offset).clamp(first, last))
            })
            .collect();
        let has_as_shot_anchor = (first..=last).contains(&as_shot.0);
        let anchor_mapped = if has_as_shot_anchor {
            let (offset, _) = self.offsets(as_shot.0);
            (as_shot.0 + self.weight(as_shot, (as_shot.0, target.1)) * offset).clamp(first, last)
        } else {
            as_shot.0
        };
        if has_as_shot_anchor {
            if let Some(anchor) = nodes.iter_mut().find(|(kelvin, _)| *kelvin == as_shot.0) {
                anchor.1 = anchor_mapped;
            } else {
                nodes.push((as_shot.0, anchor_mapped));
                nodes.sort_by(|a, b| a.0.total_cmp(&b.0));
            }
        }

        if has_as_shot_anchor {
            let anchor = nodes
                .iter()
                .position(|(kelvin, _)| *kelvin == as_shot.0)
                .expect("the as-shot white is a map node");
            for index in (0..anchor).rev() {
                nodes[index].1 = nodes[index].1.min(nodes[index + 1].1);
            }
            for index in anchor + 1..nodes.len() {
                nodes[index].1 = nodes[index].1.max(nodes[index - 1].1).min(last);
            }
        } else {
            for index in 1..nodes.len() {
                nodes[index].1 = nodes[index].1.max(nodes[index - 1].1).min(last);
            }
        }

        let index = nodes
            .windows(2)
            .position(|pair| target.0 <= pair[1].0)
            .unwrap_or(nodes.len() - 2);
        let (left_kelvin, left_mapped) = nodes[index];
        let (right_kelvin, right_mapped) = nodes[index + 1];
        let fraction = (target.0 - left_kelvin) / (right_kelvin - left_kelvin);
        left_mapped + fraction * (right_mapped - left_mapped)
    }

    /// Maps target `w1`, fading continuously to identity as it approaches
    /// the as-shot `w0` in mired/tint distance.
    fn target(&self, as_shot: (f64, f64), target: (f64, f64)) -> (f64, f64) {
        let weight = self.weight(as_shot, target);
        let (_, tint_offset) = self.offsets(target.0);
        (
            self.mapped_temperature(as_shot, target),
            (target.1 + weight * tint_offset).clamp(MINIMUM_TINT, MAXIMUM_TINT),
        )
    }
}

/// A camera model's white-balance matrix table, read from a working copy's
/// metadata (see the module docs).
#[derive(Debug, Clone, PartialEq)]
pub struct WhiteBalanceTable {
    /// `1e6 / K` of the grid: strictly ascending, positive.
    mired: Vec<f64>,
    /// Tint of the grid: strictly ascending.
    tint: Vec<f64>,
    /// `I` at node (`i_mired`, `i_tint`) = `inverse[i_mired * tint.len() + i_tint]`.
    inverse: Vec<Mat3>,
    /// `C`: the calibration matrix baked into the working copy's pixels.
    calibration: Mat3,
    /// `C^-1`.
    calibration_inverse: Mat3,
    /// Optional camera-specific target correction. It never changes `w0`.
    target_map: Option<WhiteBalanceTargetMap>,
}

impl WhiteBalanceTable {
    /// Reads the working-copy metadata's `whiteBalanceTable`.
    ///
    /// `Ok(None)` (no table: the renderer keeps its approximation) when the
    /// value is absent or `null`, of another schema than [`WB_TABLE_SCHEMA`]
    /// (a later version), without `inverseMatrices`, or when stage 1's
    /// self-check failed (`status` or `check.status` is `mismatch`; a
    /// measurement render's `not-run` keeps the matrices). A v1 table with
    /// matrices must be well formed; anything else is an error naming the
    /// key. Keys this version does not read (`reference`, `measured`,
    /// `check`'s details) are ignored; no `calibrationMatrix` (or `null`)
    /// is the identity.
    pub fn from_meta(value: &Value) -> Result<Option<Self>, String> {
        if value.get("schema").and_then(Value::as_str) != Some(WB_TABLE_SCHEMA) {
            return Ok(None);
        }
        let mismatch = |v: &Value| v.get("status").and_then(Value::as_str) == Some("mismatch");
        if mismatch(value) || value.get("check").is_some_and(mismatch) {
            return Ok(None);
        }
        let Some(entries) = value.get("inverseMatrices").filter(|m| !m.is_null()) else {
            return Ok(None);
        };
        for (key, expected) in [("space", WB_TABLE_SPACE), ("scale", WB_TABLE_SCALE)] {
            if value.get(key).and_then(Value::as_str) != Some(expected) {
                let got = value.get(key).unwrap_or(&Value::Null);
                return Err(format!(
                    "whiteBalanceTable.{key} must be '{expected}' (got {got})"
                ));
            }
        }
        let grid = |key: &str| {
            value
                .get(key)
                .and_then(finite_numbers)
                .filter(|g| g.len() >= 2 && g.windows(2).all(|w| w[0] < w[1]))
                .ok_or_else(|| {
                    format!(
                        "whiteBalanceTable.{key} must be a strictly ascending list of at least 2 finite numbers"
                    )
                })
        };
        let mired = grid("mired")?;
        if mired[0] <= 0.0 {
            return Err("whiteBalanceTable.mired must be positive (1e6 / K)".into());
        }
        let tint = grid("tint")?;
        let entries = entries
            .as_array()
            .ok_or("whiteBalanceTable.inverseMatrices must be an array")?;
        let nodes = mired.len() * tint.len();
        if entries.len() != nodes {
            return Err(format!(
                "whiteBalanceTable.inverseMatrices has {} entries; {} mired x {} tint nodes need {nodes}",
                entries.len(),
                mired.len(),
                tint.len()
            ));
        }
        let inverse = entries
            .iter()
            .enumerate()
            .map(|(index, entry)| {
                let node = || {
                    format!(
                        "whiteBalanceTable.inverseMatrices[{index}] (mired {}, tint {})",
                        mired[index / tint.len()],
                        tint[index % tint.len()]
                    )
                };
                let m = matrix(entry).ok_or_else(|| {
                    format!("{} must be 9 finite numbers (a row-major 3x3)", node())
                })?;
                let det = determinant(&m);
                if is_singular(det) {
                    return Err(format!("{} is singular (det {det})", node()));
                }
                Ok(m)
            })
            .collect::<Result<Vec<_>, String>>()?;
        let calibration = match value.get("calibrationMatrix") {
            None | Some(Value::Null) => IDENTITY,
            Some(c) => matrix(c).ok_or(
                "whiteBalanceTable.calibrationMatrix must be 9 finite numbers (a row-major 3x3)",
            )?,
        };
        let calibration_inverse = checked_inverse(&calibration).ok_or_else(|| {
            format!(
                "whiteBalanceTable.calibrationMatrix is singular (det {})",
                determinant(&calibration)
            )
        })?;
        let target_map = value
            .get("targetMap")
            .map(WhiteBalanceTargetMap::from_json)
            .transpose()?;
        Ok(Some(Self {
            mired,
            tint,
            inverse,
            calibration,
            calibration_inverse,
            target_map,
        }))
    }

    /// `I(w)` at the white (`temperature` K > 0, `tint`) in Lightroom's
    /// scale: the node inverses interpolated bilinearly, entry-wise, the
    /// white clamped to the grid.
    pub fn inverse_at(&self, temperature: f64, tint: f64) -> Mat3 {
        let (i, a) = cell(&self.mired, 1e6 / temperature);
        let (j, b) = cell(&self.tint, tint);
        let node = |m: usize, t: usize| &self.inverse[m * self.tint.len() + t];
        let (q00, q10, q01, q11) = (
            node(i, j),
            node(i + 1, j),
            node(i, j + 1),
            node(i + 1, j + 1),
        );
        let (w00, w10, w01, w11) = ((1.0 - a) * (1.0 - b), a * (1.0 - b), (1.0 - a) * b, a * b);
        std::array::from_fn(|r| {
            std::array::from_fn(|c| {
                w00 * q00[r][c] + w10 * q10[r][c] + w01 * q01[r][c] + w11 * q11[r][c]
            })
        })
    }

    /// The matrix taking the working copy (linear ProPhoto, rendered at the
    /// as-shot white) to the `target` white: `C · M(w1) · I(w0) · C^-1`,
    /// both whites `(temperature K, tint)` in Lightroom's scale.
    ///
    /// `None` when a white is not a finite positive temperature with a
    /// finite tint, or when `I(w0)` or `I(w1)` interpolates to a singular
    /// matrix: the caller then approximates.
    pub fn working_copy_transfer(&self, as_shot: (f64, f64), target: (f64, f64)) -> Option<Mat3> {
        let valid = |(k, t): (f64, f64)| k.is_finite() && k > 0.0 && t.is_finite();
        if !valid(as_shot) || !valid(target) {
            return None;
        }
        let i0 = self.inverse_at(as_shot.0, as_shot.1);
        if is_singular(determinant(&i0)) {
            return None;
        }
        let mapped_target = self
            .target_map
            .as_ref()
            .map_or(target, |map| map.target(as_shot, target));
        let m1 = checked_inverse(&self.inverse_at(mapped_target.0, mapped_target.1))?;
        // `(C · (M(w1) · I(w0))) · C^-1`: the evaluation order of `wbtable.py`.
        let transfer = mat_mul(&m1, &i0);
        let m = mat_mul(
            &mat_mul(&self.calibration, &transfer),
            &self.calibration_inverse,
        );
        m.iter().flatten().all(|v| v.is_finite()).then_some(m)
    }
}

/// The finite numbers of a JSON array; `None` for anything else.
fn finite_numbers(value: &Value) -> Option<Vec<f64>> {
    value
        .as_array()?
        .iter()
        .map(|x| x.as_f64().filter(|f| f.is_finite()))
        .collect()
}

/// A row-major 3x3 from 9 finite numbers.
fn matrix(value: &Value) -> Option<Mat3> {
    let v = finite_numbers(value)?;
    (v.len() == 9).then(|| [[v[0], v[1], v[2]], [v[3], v[4], v[5]], [v[6], v[7], v[8]]])
}

fn determinant(m: &Mat3) -> f64 {
    m[0][0] * (m[1][1] * m[2][2] - m[1][2] * m[2][1])
        - m[0][1] * (m[1][0] * m[2][2] - m[1][2] * m[2][0])
        + m[0][2] * (m[1][0] * m[2][1] - m[1][1] * m[2][0])
}

fn is_singular(det: f64) -> bool {
    !det.is_finite() || det.abs() <= SINGULAR_DETERMINANT
}

/// `m^-1`; `None` when `m` is singular ([`mat_inverse`] does not check).
fn checked_inverse(m: &Mat3) -> Option<Mat3> {
    (!is_singular(determinant(m))).then(|| mat_inverse(m))
}

/// The cell of `value` on `grid` (clamped to the grid): the last node at or
/// below it, kept inside `[0, n - 2]` (numpy
/// `searchsorted(grid, v, side="right") - 1`), and the weight of the node
/// above.
fn cell(grid: &[f64], value: f64) -> (usize, f64) {
    let n = grid.len();
    let v = value.clamp(grid[0], grid[n - 1]);
    let i = grid
        .partition_point(|&g| g <= v)
        .saturating_sub(1)
        .min(n - 2);
    (i, (v - grid[i]) / (grid[i + 1] - grid[i]))
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    /// Grid whose nodes are exact reciprocals: `1e6 / K` lands on them
    /// (10000 K, 5000 K, 2500 K).
    const MIRED: [f64; 3] = [100.0, 200.0, 400.0];
    const TINT: [f64; 2] = [-50.0, 50.0];
    const CALIBRATION: [f64; 9] = [0.8, 0.1, 0.1, 0.05, 0.9, 0.05, 0.0, 0.125, 0.875];

    /// Node (`i`, `j`): well conditioned, dyadic entries (so bilinear
    /// weights of quarters and halves interpolate exactly).
    fn node(i: usize, j: usize) -> [f64; 9] {
        let (i, j) = (i as f64, j as f64);
        [
            1.0 + i + 2.0 * j,
            0.5,
            0.0,
            0.0,
            2.0 - 0.25 * i,
            0.25 * j,
            0.125 * i,
            0.0,
            4.0 + j,
        ]
    }

    fn mat(v: [f64; 9]) -> Mat3 {
        [[v[0], v[1], v[2]], [v[3], v[4], v[5]], [v[6], v[7], v[8]]]
    }

    fn table_json() -> Value {
        let inverse: Vec<[f64; 9]> = (0..MIRED.len())
            .flat_map(|i| (0..TINT.len()).map(move |j| node(i, j)))
            .collect();
        json!({
            "schema": WB_TABLE_SCHEMA,
            "space": WB_TABLE_SPACE,
            "scale": WB_TABLE_SCALE,
            "reference": {"temperature": 5000, "tint": 0},
            "mired": MIRED,
            "tint": TINT,
            "inverseMatrices": inverse,
            "measured": {"raw": "synthetic", "nodeFitResidual": {"max": 0.001}},
            "calibrationMatrix": CALIBRATION,
            "check": {"status": "ok", "residual": 0.002, "pixels": 4096}
        })
    }

    fn target_map_json() -> Value {
        json!({
            "schema": WB_TARGET_MAP_SCHEMA,
            "kelvin": [4000.0, 5500.0, 7500.0, 10000.0],
            "temperatureOffsets": [0.0, 50.0, 800.0, 0.0],
            "tintOffsets": [0.0, -10.0, -10.0, 0.0],
            "fullDeltaMired": 12.0,
            "fullDeltaTint": 6.0
        })
    }

    fn table_with_target_map() -> Value {
        with("targetMap", target_map_json())
    }

    fn with(key: &str, value: Value) -> Value {
        let mut v = table_json();
        v[key] = value;
        v
    }

    fn without(key: &str) -> Value {
        let mut v = table_json();
        v.as_object_mut().unwrap().remove(key);
        v
    }

    fn with_entry(index: usize, entry: Value) -> Value {
        let mut v = table_json();
        v["inverseMatrices"][index] = entry;
        v
    }

    fn table(v: &Value) -> WhiteBalanceTable {
        WhiteBalanceTable::from_meta(v).unwrap().expect("a table")
    }

    fn max_abs_difference(a: &Mat3, b: &Mat3) -> f64 {
        a.iter()
            .flatten()
            .zip(b.iter().flatten())
            .map(|(x, y)| (x - y).abs())
            .fold(0.0, f64::max)
    }

    #[test]
    fn a_checked_table_is_read() {
        let t = table(&table_json());
        assert_eq!(t.mired, MIRED);
        assert_eq!(t.tint, TINT);
        assert_eq!(t.inverse.len(), 6);
        assert_eq!(t.inverse[3], mat(node(1, 1)));
        assert_eq!(t.calibration, mat(CALIBRATION));
        // A measurement working copy's table (check not run) is used too;
        // unknown keys are ignored.
        let not_run = with("check", json!({"status": "not-run"}));
        assert_eq!(table(&not_run), t);
        assert_eq!(table(&with("future", json!({"any": [1, 2]}))), t);
        assert_eq!(table(&without("reference")), t);
        assert!(table(&table_with_target_map()).target_map.is_some());
    }

    #[test]
    fn no_usable_table_is_none() {
        let none = |v: &Value| assert_eq!(WhiteBalanceTable::from_meta(v), Ok(None), "{v}");
        none(&Value::Null);
        // Stage 1's failed self-check (the shape apple-raw-linear writes).
        none(&json!({
            "schema": WB_TABLE_SCHEMA,
            "status": "mismatch",
            "check": {"status": "mismatch", "residual": 0.04, "reason": "the residual is above 0.01"}
        }));
        // Matrices whose check failed are not used either.
        none(&with("check", json!({"status": "mismatch"})));
        none(&with("status", json!("mismatch")));
        none(&without("inverseMatrices"));
        none(&with("inverseMatrices", Value::Null));
        // A later schema (or none) is not read, whatever it holds.
        none(&with("schema", json!("niho-develop-wb-table/v2")));
        none(&without("schema"));
        let mut v2 = with("schema", json!("niho-develop-wb-table/v2"));
        v2["space"] = json!("camera-native");
        none(&v2);
    }

    #[test]
    fn a_malformed_v1_table_is_an_error_naming_the_key() {
        let singular = json!([1.0, 0.0, 0.0, 0.0, 1.0, 0.0, 0.0, 0.0, 1e-10]);
        let cases = [
            (with("space", json!("srgb")), "whiteBalanceTable.space"),
            (without("scale"), "whiteBalanceTable.scale"),
            (with("mired", json!([100.0])), "whiteBalanceTable.mired"),
            (with("mired", json!([100.0, 100.0, 400.0])), "whiteBalanceTable.mired"),
            (with("mired", json!([400.0, 200.0, 100.0])), "whiteBalanceTable.mired"),
            (with("mired", json!([0.0, 200.0, 400.0])), "whiteBalanceTable.mired must be positive"),
            (with("mired", json!([-100.0, 200.0, 400.0])), "whiteBalanceTable.mired must be positive"),
            (with("mired", json!(["100", 200.0, 400.0])), "whiteBalanceTable.mired"),
            (without("mired"), "whiteBalanceTable.mired"),
            (without("tint"), "whiteBalanceTable.tint"),
            (with("tint", json!([50.0, -50.0])), "whiteBalanceTable.tint"),
            (with("inverseMatrices", json!({"0": []})), "whiteBalanceTable.inverseMatrices must be an array"),
            (
                with("inverseMatrices", json!([node(0, 0), node(0, 1)])),
                "whiteBalanceTable.inverseMatrices has 2 entries; 3 mired x 2 tint nodes need 6",
            ),
            (
                with_entry(4, json!([1.0, 0.0, 0.0, 0.0, 1.0, 0.0, 0.0, 0.0])),
                "whiteBalanceTable.inverseMatrices[4] (mired 400, tint -50) must be 9 finite numbers",
            ),
            (
                with_entry(2, json!([1.0, 0.0, 0.0, 0.0, "1", 0.0, 0.0, 0.0, 1.0])),
                "whiteBalanceTable.inverseMatrices[2] (mired 200, tint -50) must be 9 finite numbers",
            ),
            (
                with_entry(1, json!(null)),
                "whiteBalanceTable.inverseMatrices[1] (mired 100, tint 50) must be 9 finite numbers",
            ),
            (
                with_entry(3, singular.clone()),
                "whiteBalanceTable.inverseMatrices[3] (mired 200, tint 50) is singular",
            ),
            (
                with_entry(5, json!([1.0, 2.0, 3.0, 2.0, 4.0, 6.0, 0.0, 0.0, 1.0])),
                "whiteBalanceTable.inverseMatrices[5] (mired 400, tint 50) is singular",
            ),
            (
                with("calibrationMatrix", json!([1.0, 0.0, 0.0, 0.0, 1.0, 0.0, 0.0, 0.0])),
                "whiteBalanceTable.calibrationMatrix must be 9 finite numbers",
            ),
            (
                with("calibrationMatrix", json!("identity")),
                "whiteBalanceTable.calibrationMatrix must be 9 finite numbers",
            ),
            (
                with("calibrationMatrix", singular),
                "whiteBalanceTable.calibrationMatrix is singular",
            ),
        ];
        for (v, expected) in cases {
            let err = WhiteBalanceTable::from_meta(&v).unwrap_err();
            assert!(
                err.contains(expected),
                "{err:?} should contain {expected:?}"
            );
        }
    }

    #[test]
    fn a_malformed_present_target_map_is_an_error() {
        let target_with = |key: &str, value: Value| {
            let mut map = target_map_json();
            map[key] = value;
            with("targetMap", map)
        };
        let cases = [
            (
                with("targetMap", Value::Null),
                "whiteBalanceTable.targetMap must be an object",
            ),
            (
                target_with("schema", json!("niho-develop-wb-target-map/v2")),
                "whiteBalanceTable.targetMap.schema",
            ),
            (
                target_with("kelvin", json!([4000.0, 4000.0, 10000.0])),
                "whiteBalanceTable.targetMap.kelvin",
            ),
            (
                target_with("kelvin", json!([1999.0, 5500.0, 10000.0])),
                "whiteBalanceTable.targetMap.kelvin must be within",
            ),
            (
                target_with("temperatureOffsets", json!([0.0, 50.0, 0.0])),
                "whiteBalanceTable.targetMap.temperatureOffsets",
            ),
            (
                target_with("tintOffsets", json!([1.0, -10.0, -10.0, 0.0])),
                "whiteBalanceTable.targetMap.tintOffsets must be 0 at both endpoints",
            ),
            (
                target_with("temperatureOffsets", json!([0.0, -2000.0, 800.0, 0.0])),
                "whiteBalanceTable.targetMap mapped kelvin must be strictly ascending",
            ),
            (
                target_with("temperatureOffsets", json!([0.0, 50.0, 43000.0, 0.0])),
                "whiteBalanceTable.targetMap mapped kelvin must be within",
            ),
            (
                target_with("fullDeltaMired", json!(0.0)),
                "whiteBalanceTable.targetMap.fullDeltaMired",
            ),
            (
                target_with("fullDeltaTint", json!("6")),
                "whiteBalanceTable.targetMap.fullDeltaTint",
            ),
        ];
        for (v, expected) in cases {
            let err = WhiteBalanceTable::from_meta(&v).unwrap_err();
            assert!(
                err.contains(expected),
                "{err:?} should contain {expected:?}"
            );
        }
    }

    #[test]
    fn the_target_map_has_the_calibrated_knots_and_identity_boundaries() {
        let map = table(&table_with_target_map()).target_map.unwrap();
        let far_as_shot = (3000.0, 30.0);
        assert_eq!(map.target(far_as_shot, (4000.0, 0.0)), (4000.0, 0.0));
        assert_eq!(map.target(far_as_shot, (5500.0, 0.0)), (5550.0, -10.0));
        assert_eq!(map.target(far_as_shot, (7500.0, 0.0)), (8300.0, -10.0));
        assert_eq!(map.target(far_as_shot, (10000.0, 0.0)), (10000.0, 0.0));
        assert_eq!(map.target(far_as_shot, (3500.0, 12.0)), (3500.0, 12.0));
        assert_eq!(map.target(far_as_shot, (12000.0, -12.0)), (12000.0, -12.0));
        assert_eq!(map.target(far_as_shot, (5500.0, -149.0)), (5550.0, -150.0));
    }

    #[test]
    fn the_target_map_fades_to_identity_at_the_as_shot_white() {
        let map = table(&table_with_target_map()).target_map.unwrap();
        assert_eq!(map.target((5500.0, 0.0), (5500.0, 0.0)), (5500.0, 0.0));
        // Half of the tint gate gives smoothstep(0.5) = 0.5.
        assert_eq!(map.target((5500.0, -3.0), (5500.0, 0.0)), (5525.0, -5.0));
        // At either full-distance boundary the complete offset applies.
        assert_eq!(map.target((5500.0, -6.0), (5500.0, 0.0)), (5550.0, -10.0));
        let as_shot_at_full_mired = (1e6 / (1e6 / 5500.0 + 12.0), 0.0);
        assert_eq!(
            map.target(as_shot_at_full_mired, (5500.0, 0.0)),
            (5550.0, -10.0)
        );
    }

    #[test]
    fn target_map_temperature_stays_monotone_across_the_as_shot_fade() {
        let map = table(&table_with_target_map()).target_map.unwrap();
        for as_shot_temperature in [7000.0, 7500.0, 8000.0] {
            for target_tint in [-6.0, 0.0, 6.0] {
                let mut previous = map
                    .target((as_shot_temperature, 0.0), (2000.0, target_tint))
                    .0;
                for temperature in 2001..=12000 {
                    let current = map
                        .target(
                            (as_shot_temperature, 0.0),
                            (f64::from(temperature), target_tint),
                        )
                        .0;
                    assert!(
                        current >= previous,
                        "target map reversed at as-shot {as_shot_temperature} K, tint {target_tint}, target {temperature} K: {previous} > {current}"
                    );
                    previous = current;
                }
            }
        }

        // Regression for the reported reversal around 7.5K as-shot.
        let lower = map.target((7500.0, 0.0), (7048.0, 0.0)).0;
        let upper = map.target((7500.0, 0.0), (7379.0, 0.0)).0;
        assert!(
            lower < upper,
            "7048 K mapped to {lower}, 7379 K mapped to {upper}"
        );
    }

    #[test]
    fn only_the_target_is_mapped_and_legacy_tables_are_unchanged() {
        let legacy = table(&table_json());
        let mapped = table(&table_with_target_map());
        let as_shot = (5500.0, 0.0);
        // w1 == w0 remains exactly the old identity even though 5500 K has
        // a non-zero full target offset.
        let identity = mapped.working_copy_transfer(as_shot, as_shot).unwrap();
        assert!(max_abs_difference(&identity, &IDENTITY) < 1e-12);

        let target = (7500.0, 0.0);
        let expected = {
            let i0 = mapped.inverse_at(as_shot.0, as_shot.1);
            let m1 = mat_inverse(&mapped.inverse_at(8300.0, -10.0));
            mat_mul(
                &mat_mul(&mapped.calibration, &mat_mul(&m1, &i0)),
                &mapped.calibration_inverse,
            )
        };
        let got = mapped.working_copy_transfer(as_shot, target).unwrap();
        assert!(max_abs_difference(&got, &expected) < 1e-12);

        // With no map, the old target is still evaluated byte-for-byte by
        // the same arithmetic path.
        let old = legacy.working_copy_transfer(as_shot, target).unwrap();
        let old_expected = {
            let i0 = legacy.inverse_at(as_shot.0, as_shot.1);
            let m1 = mat_inverse(&legacy.inverse_at(target.0, target.1));
            mat_mul(
                &mat_mul(&legacy.calibration, &mat_mul(&m1, &i0)),
                &legacy.calibration_inverse,
            )
        };
        assert_eq!(old, old_expected);
        assert!(max_abs_difference(&got, &old) > 1e-6);
    }

    #[test]
    fn nodes_are_exact_and_whites_outside_the_grid_take_its_edge() {
        let t = table(&table_json());
        for (i, m) in MIRED.iter().enumerate() {
            for (j, tint) in TINT.iter().enumerate() {
                assert_eq!(
                    t.inverse_at(1e6 / m, *tint),
                    mat(node(i, j)),
                    "node ({i}, {j})"
                );
            }
        }
        // Warmer than 2500 K / cooler than 10000 K, tints beyond +-50.
        assert_eq!(t.inverse_at(1000.0, -80.0), mat(node(2, 0)));
        assert_eq!(t.inverse_at(50000.0, 150.0), mat(node(0, 1)));
        assert_eq!(t.inverse_at(2000.0, 10.0), t.inverse_at(2500.0, 10.0));
        assert_eq!(t.inverse_at(12000.0, 0.0), t.inverse_at(10000.0, 0.0));
        assert_eq!(t.inverse_at(5000.0, -150.0), mat(node(1, 0)));
    }

    #[test]
    fn between_nodes_the_inverses_interpolate_bilinearly() {
        let t = table(&table_json());
        // 8000 K = 125 mired: a quarter from 100 to 200; tint 0 halfway.
        let lerp = |p: &Mat3, q: &Mat3, w: f64| -> Mat3 {
            std::array::from_fn(|r| std::array::from_fn(|c| p[r][c] + w * (q[r][c] - p[r][c])))
        };
        let (q00, q10, q01, q11) = (
            mat(node(0, 0)),
            mat(node(1, 0)),
            mat(node(0, 1)),
            mat(node(1, 1)),
        );
        let expected = lerp(&lerp(&q00, &q10, 0.25), &lerp(&q01, &q11, 0.25), 0.5);
        let got = t.inverse_at(8000.0, 0.0);
        assert_eq!(got, expected);
        assert_eq!(got[0][0], 0.375 + 0.125 * 2.0 + 0.375 * 3.0 + 0.125 * 4.0);
        // 4000 K = 250 mired: a quarter from 200 to 400.
        let expected = lerp(&mat(node(1, 1)), &mat(node(2, 1)), 0.25);
        assert_eq!(t.inverse_at(4000.0, 60.0), expected);
    }

    #[test]
    fn the_transfer_goes_through_the_reference_render_in_the_calibrated_space() {
        let t = table(&table_json());
        let (w0, w1) = ((8000.0, 0.0), (4000.0, 25.0));
        let c = mat(CALIBRATION);
        let apple = mat_mul(
            &mat_inverse(&t.inverse_at(w1.0, w1.1)),
            &t.inverse_at(w0.0, w0.1),
        );
        let expected = mat_mul(&mat_mul(&c, &apple), &mat_inverse(&c));
        let got = t.working_copy_transfer(w0, w1).unwrap();
        assert!(max_abs_difference(&got, &expected) < 1e-12, "{got:?}");
        // The same white is the identity, on and off the nodes.
        for w in [w0, w1, (5000.0, 50.0), (1500.0, -200.0)] {
            let same = t.working_copy_transfer(w, w).unwrap();
            assert!(
                max_abs_difference(&same, &IDENTITY) < 1e-12,
                "{w:?}: {same:?}"
            );
        }
    }

    #[test]
    fn no_calibration_matrix_is_the_identity() {
        let t = table(&without("calibrationMatrix"));
        assert_eq!(t.calibration, IDENTITY);
        assert_eq!(t.calibration_inverse, IDENTITY);
        assert_eq!(table(&with("calibrationMatrix", Value::Null)), t);
        let (w0, w1) = ((8000.0, 0.0), (4000.0, 25.0));
        let apple = mat_mul(
            &mat_inverse(&t.inverse_at(w1.0, w1.1)),
            &t.inverse_at(w0.0, w0.1),
        );
        assert_eq!(t.working_copy_transfer(w0, w1), Some(apple));
    }

    #[test]
    fn a_singular_interpolation_or_an_invalid_white_has_no_transfer() {
        // Nodes of determinant +-1 whose mean at 150 mired is singular.
        let flip = [-1.0, 0.0, 0.0, 0.0, 1.0, 0.0, 0.0, 0.0, 1.0];
        let identity = [1.0, 0.0, 0.0, 0.0, 1.0, 0.0, 0.0, 0.0, 1.0];
        let mut v = table_json();
        v["mired"] = json!([100.0, 200.0]);
        v["inverseMatrices"] = json!([identity, identity, flip, flip]);
        let t = table(&v);
        let middle = 1e6 / 150.0;
        assert_eq!(t.working_copy_transfer((10000.0, 0.0), (middle, 0.0)), None);
        assert_eq!(t.working_copy_transfer((middle, 0.0), (10000.0, 0.0)), None);
        assert!(t
            .working_copy_transfer((10000.0, 0.0), (5000.0, 0.0))
            .is_some());

        let t = table(&table_json());
        for white in [
            (0.0, 0.0),
            (-5000.0, 0.0),
            (f64::NAN, 0.0),
            (f64::INFINITY, 0.0),
            (5000.0, f64::NAN),
        ] {
            assert_eq!(
                t.working_copy_transfer(white, (5000.0, 0.0)),
                None,
                "{white:?}"
            );
            assert_eq!(
                t.working_copy_transfer((5000.0, 0.0), white),
                None,
                "{white:?}"
            );
        }
    }
}
