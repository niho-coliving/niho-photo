//! Renders one image with every case of a JSON file of Photo Bench
//! `EditSettings` (`{"name": settings, ...}`) into PNGs (diagnostics).
//!
//!   cargo run --release --example render_cases -- input.png cases.json out_dir

use niho_develop::convert::convert_edit_settings;
use niho_develop::pipeline::render_raster;
use niho_develop::{decode, encode, Filter, Quality};

fn main() {
    let args: Vec<String> = std::env::args().collect();
    let input = std::fs::read(&args[1]).expect("input");
    let cases: serde_json::Value =
        serde_json::from_str(&std::fs::read_to_string(&args[2]).expect("cases")).expect("json");
    let out = std::path::Path::new(&args[3]);
    std::fs::create_dir_all(out).expect("out dir");
    if args.len() > 4 {
        let colors: Vec<[u8; 3]> =
            serde_json::from_str(&std::fs::read_to_string(&args[4]).expect("colors"))
                .expect("colors json");
        std::fs::write(out.join("exact.json"), exact(&cases, &colors).to_string()).expect("exact");
    }
    let raster = decode::decode_raster(&input, 0, Filter::Lanczos3).expect("decode");
    for (name, settings) in cases.as_object().expect("object") {
        let outcome = convert_edit_settings(settings, None);
        assert!(outcome.ok, "{name}: {:?}", outcome.issues);
        let (frame, _, _) = render_raster(&raster, &outcome.settings, Quality::Final, None, None);
        let png = encode::encode_png(&frame.rgba, frame.width, frame.height).expect("png");
        std::fs::write(out.join(format!("{name}.png")), png).expect("write");
    }
}

/// `exact <cases.json> <colors.json>`: f64 pointwise evaluation (no cube)
/// of each 8-bit sRGB color, printed as JSON.
#[allow(dead_code)]
pub fn exact(cases: &serde_json::Value, colors: &[[u8; 3]]) -> serde_json::Value {
    use niho_develop::color::{mat_vec, srgb_eotf, PROPHOTO_TO_SRGB, SRGB_TO_PROPHOTO};
    let mut out = serde_json::Map::new();
    for (name, settings) in cases.as_object().unwrap() {
        let s = convert_edit_settings(settings, None).settings;
        let values: Vec<serde_json::Value> = colors
            .iter()
            .map(|c| {
                let lin = [
                    srgb_eotf(c[0] as f64 / 255.0),
                    srgb_eotf(c[1] as f64 / 255.0),
                    srgb_eotf(c[2] as f64 / 255.0),
                ];
                let pp = mat_vec(&SRGB_TO_PROPHOTO, lin);
                let r = niho_develop::pipeline::raster_pointwise(pp, &s);
                let srgb = mat_vec(&PROPHOTO_TO_SRGB, r);
                serde_json::json!(srgb
                    .iter()
                    .map(|v| niho_develop::color::srgb_encode(v.clamp(0.0, 1.0)) * 255.0)
                    .collect::<Vec<_>>())
            })
            .collect();
        out.insert(name.clone(), serde_json::Value::Array(values));
    }
    serde_json::Value::Object(out)
}
