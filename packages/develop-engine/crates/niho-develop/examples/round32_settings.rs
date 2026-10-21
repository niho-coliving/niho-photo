//! Develop settings for the #32 detail chart round
//! (`tools/calibrate/make_lr_round32.py`).
//!
//!   cargo run --release -p niho-develop --example round32_settings -- \
//!     <round32/manifest.json> <engine> <out-dir>
//!
//! For every variant, the embedded Camera Raw packet (Sharpening / Noise
//! Reduction only) goes through the same XMP preset converter as the product,
//! on a new edit of `<engine>`, and is written as `<variant>.json`. Render
//! each with `niho-develop-render render --raster <base-chart.jpg>
//! --settings <variant>.json --out <variant>.png` and measure the PNGs with
//! `tools/calibrate/round32_stats.py`.

use niho_develop::{xmp, DevelopSettings};
use serde_json::Value;
use std::path::Path;

fn main() {
    let args: Vec<String> = std::env::args().collect();
    assert_eq!(
        args.len(),
        4,
        "usage: round32_settings <manifest.json> <engine> <out-dir>"
    );
    let manifest: Value =
        serde_json::from_str(&std::fs::read_to_string(&args[1]).expect("manifest"))
            .expect("manifest json");
    let out = Path::new(&args[3]);
    std::fs::create_dir_all(out).expect("out dir");
    let mut base = DevelopSettings::new_edit();
    base.engine = args[2].clone();
    for entry in manifest["variants"].as_array().expect("variants") {
        let variant = entry["variant"].as_str().expect("variant");
        let packet = entry["xmp"].as_str().expect("xmp");
        let settings = xmp::preset_settings(packet, Some(&base))
            .expect("preset")
            .settings;
        assert_eq!(settings.engine, base.engine, "{variant}: engine changed");
        std::fs::write(out.join(format!("{variant}.json")), settings.to_json()).expect("settings");
    }
}
