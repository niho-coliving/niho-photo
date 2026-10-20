//! Native reference frame for the wasm smoke test (native vs wasm must agree
//! within 1 LSB per channel, spec "段 2"):
//!
//!   cargo run --release -p niho-develop --example render_rgba -- \
//!     <input.jpg> <preset-id | settings.json | neutral> <maxDimension> <out.rgba> [settings-out.json] \
//!     [--geometry <geometry.json>] [--auto <auto.json>]
//!
//! Writes the raw RGBA8 frame and prints `width height`. With
//! `settings-out.json`, also writes the `developSettings` it rendered (CI
//! hands them to the native CLI `niho-develop-render` for the same frame).
//! `--geometry` sets `developSettings.geometry` (and `v: 2`) from a JSON
//! object (the smoke test's `fixtures/geometry/smoke.json`). `--auto
//! <auto.json>` also writes what "自動" returns for these settings on a
//! Session of the input opened at 2560px (the smoke test compares wasm's
//! `autoSettings` with it).

use niho_develop::{xmp, DevelopSettings, Filter, RenderOptions, Session};

fn main() {
    let mut args: Vec<String> = std::env::args().collect();
    let mut flag = |name: &str| {
        args.iter().position(|a| a == name).map(|i| {
            let value = args.get(i + 1).expect("flag value").clone();
            args.drain(i..i + 2);
            value
        })
    };
    let geometry = flag("--geometry").map(|path| std::fs::read_to_string(path).expect("geometry"));
    let auto = flag("--auto");
    assert!(
        args.len() == 5 || args.len() == 6,
        "usage: render_rgba <input> <preset|settings.json|neutral> <maxDimension> <out.rgba> [settings-out.json] [--geometry <geometry.json>] [--auto <auto.json>]"
    );
    let input = std::fs::read(&args[1]).expect("input");
    let mut settings = if args[2] == "neutral" {
        DevelopSettings::neutral()
    } else if let Some(preset) = xmp::builtin_preset(&args[2]) {
        xmp::preset_settings(preset.xmp, None)
            .expect("preset")
            .settings
    } else {
        DevelopSettings::from_json(&std::fs::read_to_string(&args[2]).expect("settings"))
            .expect("settings json")
    };
    if let Some(text) = geometry {
        let mut v = settings.to_value();
        v["v"] = 2.into();
        v["geometry"] = serde_json::from_str(&text).expect("geometry json");
        settings = DevelopSettings::from_json(&v.to_string()).expect("settings with geometry");
    }
    let options = RenderOptions {
        max_dimension: args[3].parse().expect("maxDimension"),
        ..RenderOptions::default()
    };
    let frame = niho_develop::render(&input, &settings.to_json(), &options).expect("render");
    std::fs::write(&args[4], &frame.rgba).expect("write");
    if let Some(path) = args.get(5) {
        std::fs::write(path, settings.to_json()).expect("write settings");
    }
    if let Some(path) = auto {
        let mut session = Session::open_raster(&input, 2560, Filter::Lanczos3).expect("session");
        let result = session.auto_settings(&settings).expect("auto");
        std::fs::write(path, result.to_json()).expect("write auto");
    }
    println!("{} {}", frame.width, frame.height);
}
