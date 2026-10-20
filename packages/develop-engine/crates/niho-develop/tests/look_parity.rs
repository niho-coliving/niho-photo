//! `niho-standard-1` renders the same numbers as the Python reference
//! (both parts: before ACR3 and the point-curve tone)
//! (`tools/calibrate/look.py`, which the fit and the S8 measurement used):
//! `tools/calibrate/run_s8_look.py adopt` writes the fixture with the
//! coefficients it copies into `looks/niho-standard-1.json`.

use niho_develop::look;
use serde_json::Value;

#[test]
fn standard_1_matches_the_python_reference() {
    let text = include_str!("fixtures/look/niho-standard-1-parity.json");
    let fixture: Value = serde_json::from_str(text).unwrap();
    assert_eq!(fixture["look"], "niho-standard-1");
    let cases = fixture["cases"].as_array().unwrap();
    assert!(cases.len() >= 200);
    let p = look::standard_1();
    let mut worst = 0.0f64;
    for c in cases {
        let v = |key: &str| -> [f64; 3] {
            let a = c[key].as_array().unwrap();
            [
                a[0].as_f64().unwrap(),
                a[1].as_f64().unwrap(),
                a[2].as_f64().unwrap(),
            ]
        };
        let x = v("in");
        let clamped = [
            x[0].clamp(0.0, 1.0),
            x[1].clamp(0.0, 1.0),
            x[2].clamp(0.0, 1.0),
        ];
        for (got, want) in [
            (p.pre_acr3(x), v("preAcr3")),
            (p.point_curve(clamped), v("pointCurve")),
        ] {
            for k in 0..3 {
                worst = worst.max((got[k] - want[k]).abs());
            }
        }
    }
    assert!(worst < 1e-9, "largest difference {worst}");
}
