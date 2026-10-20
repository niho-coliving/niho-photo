//! S9 の計測用ブリッジ: 作業コピー（16bit PNG・gamma 1.8・上限 2.0・linear ProPhoto）と
//! そのメタ JSON を段 2 の crate（niho-develop）で描き、sRGB 8bit の JPEG / PNG に書く。
//! crate の examples/ にコピーして `cargo build --release --example render_working_copy` で組む
//! （tools/calibrate/run-dc-s5-apple.sh の crate-build が行う。crate 側のファイルは変えない）。
//!
//!   render_working_copy <working.png> <meta.json> <preset-id | neutral | file.xmp | settings.json> <maxDimension> <out.jpg|out.png> [jpegQuality] [--wb-absolute=K,tint] [--look=<look>]
//!
//! `--wb-absolute=5500,10` は実験用: 変換した設定の whiteBalance を絶対値（K・tint）に上書きしてから描く
//! （Lightroom が「Custom」で Temperature/Tint の無い XMP をどう扱うかの検証に使う）。
//! `--look=niho-standard-1` は設定の `look`（NIHO 標準ルックの版）を上書きしてから描く（S8 #16947 の計測。
//! 省くと設定のまま = プリセットと neutral は `niho-interim-1`）。
//!
//! `file.xmp` は Lightroom の XMP（プリセットやサイドカー）で、crate の xmp::preset_settings で developSettings に変換して当てる
//! （変換できなかった項目は stderr に出す）。

use niho_develop::settings::{WhiteBalance, WhiteBalanceMode};
use niho_develop::{encode, xmp, DevelopSettings, Filter, Quality, Session};

fn main() {
    let mut wb_override: Option<(f64, f64)> = None;
    let mut look_override: Option<String> = None;
    let args: Vec<String> = std::env::args()
        .filter(|a| {
            if let Some(v) = a.strip_prefix("--look=") {
                look_override = Some(v.to_string());
                false
            } else if let Some(v) = a.strip_prefix("--wb-absolute=") {
                let mut it = v.split(',');
                let k: f64 = it.next().and_then(|x| x.parse().ok()).expect("--wb-absolute=K,tint");
                let t: f64 = it.next().and_then(|x| x.parse().ok()).unwrap_or(0.0);
                wb_override = Some((k, t));
                false
            } else {
                true
            }
        })
        .collect();
    if args.len() < 6 {
        eprintln!("usage: render_working_copy <working.png> <meta.json> <preset-id|neutral|settings.json> <maxDimension> <out.jpg|out.png> [jpegQuality]");
        std::process::exit(1);
    }
    let png = std::fs::read(&args[1]).expect("working copy png");
    let meta = std::fs::read_to_string(&args[2]).expect("meta json");
    let mut settings = if args[3] == "neutral" {
        DevelopSettings::neutral()
    } else if let Some(preset) = xmp::builtin_preset(&args[3]) {
        xmp::preset_settings(preset.xmp, None).expect("preset").settings
    } else if args[3].to_lowercase().ends_with(".xmp") {
        let text = std::fs::read_to_string(&args[3]).expect("xmp");
        let outcome = xmp::preset_settings(&text, None).expect("xmp preset");
        if !outcome.unsupported.is_empty() {
            eprintln!("unsupported: {:?}", outcome.unsupported);
        }
        outcome.settings
    } else {
        DevelopSettings::from_json(&std::fs::read_to_string(&args[3]).expect("settings")).expect("settings json")
    };
    if let Some((k, t)) = wb_override {
        settings.white_balance = WhiteBalance { mode: WhiteBalanceMode::Absolute, temperature: Some(k), tint: Some(t) };
    }
    if let Some(look) = look_override {
        assert!(niho_develop::look::is_known(&look), "unknown look {look}");
        settings.look = look;
    }
    let max_dimension: usize = args[4].parse().expect("maxDimension");
    let quality: u8 = args.get(6).map(|q| q.parse().expect("jpegQuality")).unwrap_or(97);
    let started = std::time::Instant::now();
    let mut session = Session::open_working_copy(&png, &meta, Filter::Lanczos3).expect("open working copy");
    let opened = started.elapsed();
    let frame = session.render(&settings, max_dimension, Quality::Final).expect("render");
    let rendered = started.elapsed();
    let out = &args[5];
    let bytes = if out.to_lowercase().ends_with(".png") {
        encode::encode_png(&frame.rgba, frame.width, frame.height).expect("png")
    } else {
        encode::encode_jpeg(&frame.rgba, frame.width, frame.height, quality).expect("jpeg")
    };
    std::fs::write(out, bytes).expect("write");
    println!(
        "{{\"width\":{},\"height\":{},\"openMs\":{:.1},\"renderMs\":{:.1},\"totalMs\":{:.1}}}",
        frame.width,
        frame.height,
        opened.as_secs_f64() * 1000.0,
        (rendered - opened).as_secs_f64() * 1000.0,
        started.elapsed().as_secs_f64() * 1000.0
    );
}
