//! The mask plane's output-to-working-image map ([`SourceMap`]) is
//! TypeScript's `geometryOutputToSource` (`docs/local-adjustments.md` "座標"):
//! `fixtures/masks/geometry-map-cases.json` holds that function's values
//! (written and checked by `develop-masks-geometry-map.test.ts`), and the
//! Rust map must give them to 1e-6 for every quarter turn, flip, crop and
//! turned crop (the inscribed shrink included). Also run by the wasm-bindgen
//! test command.

use niho_develop::local_render::SourceMap;
use niho_develop::Geometry;
use serde_json::Value;

const CASES: &str = include_str!("fixtures/masks/geometry-map-cases.json");

#[cfg_attr(target_arch = "wasm32", wasm_bindgen_test::wasm_bindgen_test)]
#[cfg_attr(not(target_arch = "wasm32"), test)]
fn the_map_is_typescripts_geometry_output_to_source() {
    let doc: Value = serde_json::from_str(CASES).unwrap();
    let cases = doc["cases"].as_array().unwrap();
    assert!(cases.len() >= 50, "{} cases", cases.len());
    let mut points = 0;
    for case in cases {
        let name = case["name"].as_str().unwrap();
        let geometry = Geometry::from_value(&case["geometry"]).unwrap();
        let width = case["source"]["width"].as_u64().unwrap() as usize;
        let height = case["source"]["height"].as_u64().unwrap() as usize;
        let map = SourceMap::new(Some(&geometry), width, height)
            .unwrap_or_else(|_| panic!("{name}: a rectangle"));
        for point in case["points"].as_array().unwrap() {
            let at = |key: &str| point[key].as_f64().unwrap();
            let [sx, sy] = map.source_of(at("px"), at("py"));
            assert!(
                (sx - at("sx")).abs() < 1e-6 && (sy - at("sy")).abs() < 1e-6,
                "{name} at ({}, {}): ({sx}, {sy}) vs ({}, {})",
                at("px"),
                at("py"),
                at("sx"),
                at("sy")
            );
            points += 1;
        }
    }
    assert!(points >= 300, "{points} points");
}
