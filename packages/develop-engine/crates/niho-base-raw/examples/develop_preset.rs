//! Stage 2 (`niho-develop`, S3) on a stage-1 working copy of this crate: renders the output of
//! `niho-base-raw render` (16-bit PNG + `niho-base-raw.working-copy/1` sidecar) with a bundled NIHO
//! preset, for the preset-closeness measurement of S9 (`tools/colorcheck/presets.py`).
//!
//!   cargo run --release -p niho-base-raw --example develop_preset -- \
//!     <working.png> <sidecar.json> <niho-bluesky2|niho-pastel|niho-colorful|neutral> \
//!     <maxDimension> <out.png> [--ev-offset <EV>] [--white-balance <K>,<tint>]
//!
//! The sidecar becomes the stage-2 metadata read by `WorkingCopyMeta::from_json`:
//!
//! | stage 2 (`kind: raw`)      | stage-1 sidecar                                  |
//! |----------------------------|--------------------------------------------------|
//! | `baselineEV`               | `baselineEV` + `--ev-offset`                     |
//! | `asShotWhite.x` / `.y`     | `whiteBalance.xy`                                |
//! | `asShotWhite.temperature`  | `whiteBalance.cct` (Robertson)                   |
//! | `asShotWhite.tint`         | 3000 × `whiteBalance.duv`                        |
//! | `dcpSha256`                | `dcp.sha256`                                     |
//! | `lookTableIncluded`        | `lookTableIncluded`                              |
//!
//! Tint: stage 2 reads the DNG convention (`color::xy_from_temperature`): the white sits at
//! `tint / -3000` along the Robertson isotherm in CIE 1960 uv, the isotherm direction pointing to
//! +u / -v, so a positive tint is a greener white. The sidecar's Duv is the same distance with the
//! opposite sign (positive above the Planckian locus = greener), hence `tint = 3000 × Duv`. Stage 2
//! only uses x / y (absolute white balance); temperature / tint are carried for the UI.
//!
//! `--white-balance` (diagnostics only) replaces the preset's white balance with an absolute one,
//! e.g. the 5001 K / +10 that Lightroom records when it applies bluesky2 (`Custom` without values)
//! to a RAW file; the preset-closeness gate itself never uses it.
//!
//! Writes an sRGB 8-bit PNG and prints one line: `<width> <height> <JSON>`, the JSON holding the
//! preset's `approximate` / `unsupported` items, the render approximations and the metadata used.

use anyhow::{anyhow, bail, Context, Result};
use niho_develop::settings::{WhiteBalance, WhiteBalanceMode};
use niho_develop::{color, encode, xmp, DevelopSettings, Filter, Quality, Session};
use serde_json::{json, Value};

const USAGE: &str = "usage: develop_preset <working.png> <sidecar.json> \
<niho-bluesky2|niho-pastel|niho-colorful|neutral> <maxDimension> <out.png> \
[--ev-offset <EV>] [--white-balance <K>,<tint>]";

const SIDECAR_SCHEMA: &str = "niho-base-raw.working-copy/1";

/// DNG `kTintScale` is -3000 (`niho_develop::color`): tint = -3000 × offset = 3000 × Duv.
const TINT_PER_DUV: f64 = 3000.0;

struct Args {
    png: String,
    sidecar: String,
    preset: String,
    max_dimension: usize,
    out: String,
    ev_offset: f64,
    white_balance: Option<(f64, f64)>,
}

fn main() {
    if let Err(e) = run() {
        eprintln!("develop_preset: {e:#}");
        std::process::exit(1);
    }
}

fn parse_args() -> Result<Args> {
    let mut positional = Vec::new();
    let mut ev_offset = 0.0;
    let mut white_balance = None;
    let mut it = std::env::args().skip(1);
    while let Some(arg) = it.next() {
        if arg == "-h" || arg == "--help" {
            println!("{USAGE}");
            std::process::exit(0);
        }
        let (flag, inline) = match arg.split_once('=') {
            Some((f, v)) if f.starts_with("--") => (f.to_string(), Some(v.to_string())),
            _ => (arg.clone(), None),
        };
        if flag != "--ev-offset" && flag != "--white-balance" {
            positional.push(arg);
            continue;
        }
        let value = match inline {
            Some(v) => v,
            None => it.next().ok_or_else(|| anyhow!("{flag} needs a value"))?,
        };
        let numbers = value
            .split(',')
            .map(|v| v.trim().parse::<f64>().ok().filter(|x| x.is_finite()))
            .collect::<Option<Vec<f64>>>()
            .ok_or_else(|| anyhow!("{flag} {value}: not a finite number"))?;
        match (flag.as_str(), numbers.as_slice()) {
            ("--ev-offset", [ev]) => ev_offset = *ev,
            ("--white-balance", [t, tint]) => white_balance = Some((*t, *tint)),
            _ => bail!("{flag} {value}: {USAGE}"),
        }
    }
    let [png, sidecar, preset, max_dimension, out]: [String; 5] =
        positional.try_into().map_err(|_| anyhow!("{USAGE}"))?;
    let max_dimension = max_dimension
        .parse::<usize>()
        .with_context(|| format!("maxDimension {max_dimension}"))?;
    Ok(Args {
        png,
        sidecar,
        preset,
        max_dimension,
        out,
        ev_offset,
        white_balance,
    })
}

/// Stage-2 metadata (`WorkingCopyMeta::from_json`, `kind: raw`) for a stage-1 sidecar.
fn stage2_meta(sidecar: &Value, ev_offset: f64) -> Result<Value> {
    let schema = sidecar["schema"].as_str().unwrap_or_default();
    if schema != SIDECAR_SCHEMA {
        bail!("sidecar schema {schema:?} is not {SIDECAR_SCHEMA}");
    }
    let baseline_ev = sidecar["baselineEV"]
        .as_f64()
        .ok_or_else(|| anyhow!("sidecar baselineEV missing"))?;
    let wb = &sidecar["whiteBalance"];
    let (Some(x), Some(y)) = (wb["xy"][0].as_f64(), wb["xy"][1].as_f64()) else {
        bail!("sidecar whiteBalance.xy missing");
    };
    Ok(json!({
        "kind": "raw",
        "baselineEV": baseline_ev + ev_offset,
        "asShotWhite": {
            "x": x,
            "y": y,
            "temperature": wb["cct"].as_f64(),
            "tint": wb["duv"].as_f64().map(|duv| duv * TINT_PER_DUV),
        },
        "dcpSha256": sidecar["dcp"]["sha256"].as_str().unwrap_or_default(),
        "lookTableIncluded": sidecar["lookTableIncluded"].as_bool().unwrap_or(false),
    }))
}

/// Largest |Δx|, |Δy| between the as-shot xy and stage 2's own temperature / tint → xy.
fn white_round_trip(meta: &Value) -> Option<f64> {
    let w = &meta["asShotWhite"];
    let xy = color::xy_from_temperature(w["temperature"].as_f64()?, w["tint"].as_f64()?);
    Some(
        (xy.x - w["x"].as_f64()?)
            .abs()
            .max((xy.y - w["y"].as_f64()?).abs()),
    )
}

fn run() -> Result<()> {
    let args = parse_args()?;
    let png = std::fs::read(&args.png).with_context(|| format!("read {}", args.png))?;
    let sidecar_text =
        std::fs::read_to_string(&args.sidecar).with_context(|| format!("read {}", args.sidecar))?;
    let sidecar: Value =
        serde_json::from_str(&sidecar_text).with_context(|| format!("parse {}", args.sidecar))?;
    let meta = stage2_meta(&sidecar, args.ev_offset)?;

    let mut issues = json!({"preset": args.preset, "approximate": [], "unsupported": []});
    let mut settings = if args.preset == "neutral" {
        DevelopSettings::neutral()
    } else {
        let preset = xmp::builtin_preset(&args.preset)
            .ok_or_else(|| anyhow!("unknown preset {:?} ({USAGE})", args.preset))?;
        let result =
            xmp::preset_settings(preset.xmp, None).map_err(|e| anyhow!("{}: {e}", preset.id))?;
        issues["approximate"] = json!(result.approximate);
        issues["unsupported"] = json!(result.unsupported);
        if !result.converted {
            issues["convertIssues"] = Value::Array(
                result
                    .convert_issues
                    .iter()
                    .map(|i| json!({"path": i.path, "code": i.code}))
                    .collect(),
            );
        }
        result.settings
    };
    issues["whiteBalance"] = json!(settings.white_balance.mode.as_str());
    if let Some((temperature, tint)) = args.white_balance {
        settings.white_balance = WhiteBalance {
            mode: WhiteBalanceMode::Absolute,
            temperature: Some(temperature),
            tint: Some(tint),
        };
        issues["whiteBalanceOverride"] = json!({"temperature": temperature, "tint": tint});
    }

    let mut session = Session::open_working_copy(&png, &meta.to_string(), Filter::Lanczos3)
        .map_err(|e| anyhow!("open working copy: {e}"))?;
    let frame = session
        .render(&settings, args.max_dimension, Quality::Final)
        .map_err(|e| anyhow!("render: {e}"))?;
    let encoded = encode::encode_png(&frame.rgba, frame.width, frame.height)
        .map_err(|e| anyhow!("encode: {e}"))?;
    std::fs::write(&args.out, encoded).with_context(|| format!("write {}", args.out))?;

    issues["renderApproximations"] = json!(frame.approximations);
    issues["asShotWhiteRoundTrip"] = json!(white_round_trip(&meta));
    issues["meta"] = meta;
    println!("{} {} {}", frame.width, frame.height, issues);
    Ok(())
}
