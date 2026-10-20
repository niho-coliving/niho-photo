//! "自動" over a directory of photos (diagnostics, F4a #17123): working
//! copies (`<name>.png` with `<name>.json`) and JPEGs (opened at 2560px, as
//! the browser opens them).
//!
//!   cargo run --release -p niho-develop --example auto_eval -- <dir> <out_dir> \
//!     [--preset <id>] [--geometry <geometry.json>] [--compare <long edge>] [--sensitivity]
//!
//! Writes `<out_dir>/results.jsonl` (per photo: the proxy's summary before
//! and after, the changes, the step, the time and a second press). With
//! `--compare`, before / after JPEGs at that long edge and `index.html`.
//! `--sensitivity` instead measures how the proxy's statistics move with
//! each slider (`sensitivity.jsonl`, for tuning the rules). Keep the output
//! outside the repository (the photos are the owner's).

use niho_develop::auto::{self, Measure, Summary};
use niho_develop::{encode, xmp, DevelopSettings, Filter, Quality, Session};
use serde_json::{json, Value};
use std::io::Write;
use std::path::Path;
use std::time::Instant;

fn open(dir: &Path, name: &str) -> Session {
    let json = dir.join(format!("{name}.json"));
    if json.exists() {
        let png = std::fs::read(dir.join(format!("{name}.png"))).expect("png");
        let meta = std::fs::read_to_string(json).expect("meta");
        Session::open_working_copy(&png, &meta, Filter::Lanczos3).expect("working copy")
    } else {
        let bytes = std::fs::read(dir.join(format!("{name}.jpg"))).expect("jpg");
        Session::open_raster(&bytes, 2560, Filter::Lanczos3).expect("jpeg")
    }
}

fn summary(s: &Summary) -> Value {
    json!({
        "median": s.median, "p001": s.p001, "p25": s.p25, "p75": s.p75, "p99": s.p99, "p999": s.p999,
        "clippedWhite": s.clipped_white, "clippedBlack": s.clipped_black,
        "saturation": s.saturation,
    })
}

fn deltas(d: &auto::Deltas) -> Value {
    json!({
        "exposure": d.exposure, "contrast": d.contrast, "highlights": d.highlights,
        "shadows": d.shadows, "whites": d.whites, "blacks": d.blacks, "vibrance": d.vibrance,
    })
}

fn light(s: &DevelopSettings) -> [f64; 7] {
    [
        s.exposure,
        s.contrast,
        s.highlights,
        s.shadows,
        s.whites,
        s.blacks,
        s.vibrance,
    ]
}

fn main() {
    let mut args: Vec<String> = std::env::args().skip(1).collect();
    let mut take = |flag: &str| {
        args.iter().position(|a| a == flag).map(|i| {
            let v = args.get(i + 1).cloned().unwrap_or_default();
            args.drain(i..(i + 2).min(args.len()));
            v
        })
    };
    let preset = take("--preset");
    let geometry = take("--geometry");
    let compare: Option<usize> = take("--compare").map(|v| v.parse().expect("--compare size"));
    let sensitivity = args.iter().any(|a| a == "--sensitivity");
    args.retain(|a| a != "--sensitivity");
    let dir = Path::new(&args[0]).to_path_buf();
    let out = Path::new(&args[1]).to_path_buf();
    std::fs::create_dir_all(&out).expect("out dir");

    let mut base = match &preset {
        Some(id) => {
            xmp::preset_settings(xmp::builtin_preset(id).expect("preset id").xmp, None)
                .expect("preset")
                .settings
        }
        None => DevelopSettings::neutral(),
    };
    if let Some(path) = &geometry {
        let mut v = base.to_value();
        v["v"] = 2.into();
        v["geometry"] =
            serde_json::from_str(&std::fs::read_to_string(path).expect("geometry")).expect("json");
        base = DevelopSettings::from_json(&v.to_string()).expect("settings");
    }

    let mut names: Vec<String> = std::fs::read_dir(&dir)
        .expect("dir")
        .filter_map(|e| {
            let p = e.ok()?.path();
            let ext = p.extension()?.to_str()?.to_ascii_lowercase();
            let stem = p.file_stem()?.to_str()?.to_string();
            let wc = ext == "png" && p.with_extension("json").exists();
            (wc || ext == "jpg").then_some(stem)
        })
        .collect();
    names.sort();
    names.dedup();

    if sensitivity {
        let mut file = std::fs::File::create(out.join("sensitivity.jsonl")).expect("file");
        for name in &names {
            let mut session = open(&dir, name);
            let mut m = |s: &DevelopSettings| {
                let f = session
                    .render(s, auto::PROXY_LONG_EDGE, auto::PROXY_QUALITY)
                    .unwrap();
                Measure::of(&f).summary()
            };
            let at = |f: &dyn Fn(&mut DevelopSettings)| {
                let mut s = base.clone();
                f(&mut s);
                s
            };
            let row = json!({
                "name": name,
                "base": summary(&m(&base)),
                "exposure+0.5": summary(&m(&at(&|s| s.exposure += 0.5))),
                "exposure-0.5": summary(&m(&at(&|s| s.exposure -= 0.5))),
                "whites+20": summary(&m(&at(&|s| s.whites += 20.0))),
                "blacks-20": summary(&m(&at(&|s| s.blacks -= 20.0))),
                "contrast+20": summary(&m(&at(&|s| s.contrast += 20.0))),
                "vibrance+20": summary(&m(&at(&|s| s.vibrance += 20.0))),
                "highlights-40": summary(&m(&at(&|s| s.highlights -= 40.0))),
                "shadows+40": summary(&m(&at(&|s| s.shadows += 40.0))),
            });
            writeln!(file, "{row}").unwrap();
            eprintln!("{name}");
        }
        return;
    }

    let mut file = std::fs::File::create(out.join("results.jsonl")).expect("file");
    let mut html = String::from(
        "<!doctype html><meta charset=utf-8><title>自動の見比べ</title>\
         <style>body{font:14px system-ui;margin:16px;background:#111;color:#eee}\
         figure{margin:0 0 28px}img{width:49%;height:auto}p{margin:4px 0}</style>\n",
    );
    html.push_str(&format!(
        "<h1>自動（F4a #17123）: 元（左）／自動の後（右）</h1><p>出発点: {}</p>\n",
        preset.as_deref().unwrap_or("neutral")
    ));
    for name in &names {
        let mut session = open(&dir, name);
        let t = Instant::now();
        let outcome = session.auto_outcome(&base).expect("auto");
        let ms = t.elapsed().as_secs_f64() * 1e3;
        let again = session.auto_outcome(&outcome.settings).expect("auto again");
        let second: Vec<f64> = light(&again.settings)
            .iter()
            .zip(light(&outcome.settings))
            .map(|(a, b)| a - b)
            .collect();
        // The original as the screen shows it (no stage engaged for the
        // measurement), on the proxy.
        let original = Measure::of(
            &session
                .render(&base, auto::PROXY_LONG_EDGE, auto::PROXY_QUALITY)
                .unwrap(),
        )
        .summary();
        let mut finals = Vec::new();
        if let Some(size) = compare {
            for (tag, s) in [("before", &base), ("after", &outcome.settings)] {
                let f = session.render(s, size, Quality::Final).unwrap();
                finals.push(Measure::of(&f).summary());
                let jpeg = encode::encode_jpeg(&f.rgba, f.width, f.height, 88).unwrap();
                std::fs::write(out.join(format!("{name}-{tag}.jpg")), jpeg).unwrap();
            }
        }
        let row = json!({
            "name": name,
            "ms": ms,
            "original": summary(&original),
            "final": finals.iter().map(summary).collect::<Vec<_>>(),
            "step": format!("{:?}", outcome.step),
            "renders": outcome.renders,
            "deltas": deltas(&outcome.deltas),
            "before": summary(&outcome.before),
            "after": summary(&outcome.after),
            "inputs": {
                "median": outcome.inputs.median, "p001": outcome.inputs.p001,
                "p999": outcome.inputs.p999, "iqr": outcome.inputs.iqr,
                "bright": outcome.inputs.bright, "dark": outcome.inputs.dark,
                "saturation": outcome.inputs.saturation,
            },
            "second": second,
            "secondStep": format!("{:?}", again.step),
            "checks": outcome.checks.iter().map(|(d, m)| json!({"deltas": deltas(d), "after": summary(m)})).collect::<Vec<_>>(),
        });
        writeln!(file, "{row}").unwrap();
        let d = &outcome.deltas;
        eprintln!(
            "{name}: {:?} {ms:.0} ms  EV {:+.2} C {:+} H {:+} S {:+} W {:+} B {:+} V {:+}  median {:.3}->{:.3}",
            outcome.step,
            d.exposure,
            d.contrast,
            d.highlights,
            d.shadows,
            d.whites,
            d.blacks,
            d.vibrance,
            outcome.before.median,
            outcome.after.median
        );
        if compare.is_some() {
            let b = &outcome.before;
            let a = &outcome.after;
            html.push_str(&format!(
                "<figure><img src=\"{name}-before.jpg\"><img src=\"{name}-after.jpg\">\
                 <p><b>{name}</b> {:?}（{ms:.0} ms）: 露光量 {:+.2}・コントラスト {:+}・ハイライト {:+}・シャドウ {:+}・白レベル {:+}・黒レベル {:+}・自然な彩度 {:+}</p>\
                 <p>中央値 {:.3}→{:.3}・0.1% {:.3}→{:.3}・99.9% {:.3}→{:.3}・白飛び {:.3}%→{:.3}%・黒つぶれ {:.3}%→{:.3}%</p></figure>\n",
                outcome.step,
                d.exposure, d.contrast, d.highlights, d.shadows, d.whites, d.blacks, d.vibrance,
                b.median, a.median, b.p001, a.p001, b.p999, a.p999,
                b.clipped_white * 100.0, a.clipped_white * 100.0,
                b.clipped_black * 100.0, a.clipped_black * 100.0,
            ));
        }
    }
    if compare.is_some() {
        std::fs::write(out.join("index.html"), html).unwrap();
    }
}
