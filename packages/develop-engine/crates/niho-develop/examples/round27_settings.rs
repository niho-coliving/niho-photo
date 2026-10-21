//! Develop settings for the #27 white balance × edit chart round
//! (`tools/calibrate/make_lr_round27.py`).
//!
//!   cargo run --release -p niho-develop --example round27_settings -- \
//!     <round27/manifest.json> <engine> <out-dir>
//!
//! For every variant, the embedded Camera Raw packet goes through the same
//! XMP preset converter as the product (on a new edit of `<engine>`) and is
//! written twice: `<variant>.tail.json` keeps the relative white balance
//! (the engine's own placement) and `<variant>.head.json` zeroes it, so the
//! caller can apply the measured white balance to the input first.
//! `<variant>.white.json` records the parsed relative temperature / tint.

use niho_develop::{xmp, DevelopSettings};
use serde_json::{json, Value};
use std::path::Path;

fn main() {
    let args: Vec<String> = std::env::args().collect();
    assert_eq!(
        args.len(),
        4,
        "usage: round27_settings <manifest.json> <engine> <out-dir>"
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
        let tail = xmp::preset_settings(packet, Some(&base))
            .expect("preset")
            .settings;
        assert_eq!(tail.engine, base.engine, "{variant}: engine changed");
        let mut head = tail.clone();
        head.relative_temperature = 0.0;
        head.relative_tint = 0.0;
        std::fs::write(out.join(format!("{variant}.tail.json")), tail.to_json()).expect("tail");
        std::fs::write(out.join(format!("{variant}.head.json")), head.to_json()).expect("head");
        let white = json!({
            "temperature": tail.relative_temperature,
            "tint": tail.relative_tint,
        });
        std::fs::write(out.join(format!("{variant}.white.json")), white.to_string())
            .expect("white");
    }
}
