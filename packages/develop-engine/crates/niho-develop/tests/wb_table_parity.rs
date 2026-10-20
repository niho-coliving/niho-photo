//! The white-balance table (`niho-develop-wb-table/v1`, S11 #17108) gives the
//! reference implementation's working-copy matrices
//! (`tools/calibrate/wbtable.py`). The fixture is written by
//! `tools/calibrate/make_wb_table_parity.py` from the DC-S5 calibration
//! apple-v3, in the shape `apple-raw-linear` writes into the working-copy
//! metadata; its cases cover nodes, cells, the same white, whites outside
//! the grid and the tool's own self-check pair.

use niho_develop::color::{Mat3, IDENTITY};
use niho_develop::wb_table::WhiteBalanceTable;
use serde_json::Value;

const FIXTURE: &str = include_str!("fixtures/wb/wb-table-parity.json");

/// `[K, tint]`.
fn white(v: &Value) -> (f64, f64) {
    let w = v.as_array().expect("[K, tint]");
    assert_eq!(w.len(), 2);
    (w[0].as_f64().unwrap(), w[1].as_f64().unwrap())
}

fn max_abs_difference(a: &Mat3, row_major: &[f64]) -> f64 {
    assert_eq!(row_major.len(), 9);
    a.iter()
        .flatten()
        .zip(row_major)
        .map(|(x, y)| (x - y).abs())
        .fold(0.0, f64::max)
}

#[test]
fn working_copy_transfer_matches_the_reference_implementation() {
    let fixture: Value = serde_json::from_str(FIXTURE).unwrap();
    let table = WhiteBalanceTable::from_meta(&fixture["whiteBalanceTable"])
        .unwrap()
        .expect("the fixture's table carries matrices");
    let cases = fixture["cases"].as_array().unwrap();
    assert!(cases.len() >= 12, "{} cases", cases.len());
    let identity: Vec<f64> = IDENTITY.iter().flatten().copied().collect();
    let (mut worst, mut identities) = (0.0f64, 0);
    for case in cases {
        let (as_shot, target) = (white(&case["asShot"]), white(&case["target"]));
        let expected: Vec<f64> = case["transfer"]
            .as_array()
            .unwrap()
            .iter()
            .map(|v| v.as_f64().unwrap())
            .collect();
        let got = table
            .working_copy_transfer(as_shot, target)
            .unwrap_or_else(|| panic!("{as_shot:?} -> {target:?}: no transfer"));
        let error = max_abs_difference(&got, &expected);
        assert!(
            error <= 1e-9,
            "{as_shot:?} -> {target:?}: max |error| {error:e}\n{got:?}\n{expected:?}"
        );
        worst = worst.max(error);
        if as_shot == target {
            let error = max_abs_difference(&got, &identity);
            assert!(error <= 1e-12, "{as_shot:?}: {error:e} off the identity");
            identities += 1;
        }
    }
    assert_eq!(identities, 2);
    eprintln!("{} cases, max |error| {worst:e}", cases.len());
}
