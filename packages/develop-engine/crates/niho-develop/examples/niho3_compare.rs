//! Comparison renderer for a signed-PNG NIHO 3 working copy.
//!
//! Usage: `niho3_compare <input.png> <metadata.json> <neutral|preset.xmp> <output.jpg|output.rgba> [--engine niho-3|niho-4|niho-5|niho-7|niho-9] [--cache-bench] [--max-dimension N] [--interactive] [--settings-json file.json]`

use niho_develop::settings::{
    ENGINE_NIHO_3, ENGINE_NIHO_4, ENGINE_NIHO_5, ENGINE_NIHO_7, ENGINE_NIHO_9,
    LOOK_NIHO_STANDARD_2, LOOK_NIHO_STANDARD_3, LOOK_NIHO_STANDARD_4, LOOK_NIHO_STANDARD_5,
};
use niho_develop::{encode, xmp, DevelopSettings, Filter, Quality, Session};

fn main() -> Result<(), Box<dyn std::error::Error>> {
    let arguments: Vec<String> = std::env::args().collect();
    if arguments.len() < 5 {
        return Err("usage: niho3_compare <input.png> <metadata.json> <neutral|preset.xmp> <output.jpg|output.rgba> [--engine niho-3|niho-4|niho-5|niho-7|niho-9] [--cache-bench] [--max-dimension N] [--interactive] [--settings-json file.json]".into());
    }
    let mut max_dimension = 0;
    let mut quality = Quality::Final;
    let mut cache_bench = false;
    let mut settings_path = None;
    let mut engine = ENGINE_NIHO_3;
    let mut flags = arguments[5..].iter();
    while let Some(flag) = flags.next() {
        match flag.as_str() {
            "--cache-bench" => cache_bench = true,
            "--interactive" => quality = Quality::Interactive,
            "--settings-json" => settings_path = Some(flags.next().ok_or("missing settings path")?),
            "--engine" => {
                engine = match flags.next().map(String::as_str) {
                    Some(ENGINE_NIHO_3) => ENGINE_NIHO_3,
                    Some(ENGINE_NIHO_4) => ENGINE_NIHO_4,
                    Some(ENGINE_NIHO_5) => ENGINE_NIHO_5,
                    Some(ENGINE_NIHO_7) => ENGINE_NIHO_7,
                    Some(ENGINE_NIHO_9) => ENGINE_NIHO_9,
                    Some(value) => return Err(format!("unsupported engine: {value}").into()),
                    None => return Err("missing engine".into()),
                }
            }
            "--max-dimension" => {
                max_dimension = flags.next().ok_or("missing max dimension")?.parse()?;
            }
            _ => return Err(format!("unknown option: {flag}").into()),
        }
    }
    let png = std::fs::read(&arguments[1])?;
    let metadata = std::fs::read_to_string(&arguments[2])?;
    let mut settings = DevelopSettings::neutral();
    settings.engine = engine.into();
    settings.look = if matches!(engine, ENGINE_NIHO_7 | ENGINE_NIHO_9) {
        LOOK_NIHO_STANDARD_5.into()
    } else if engine == ENGINE_NIHO_5 {
        LOOK_NIHO_STANDARD_4.into()
    } else if engine == ENGINE_NIHO_4 {
        LOOK_NIHO_STANDARD_3.into()
    } else {
        LOOK_NIHO_STANDARD_2.into()
    };
    if arguments[3] != "neutral" {
        let preset = std::fs::read_to_string(&arguments[3])?;
        settings = xmp::preset_settings(&preset, Some(&settings))?.settings;
    }
    if let Some(path) = settings_path {
        settings = niho_develop::parse_settings(&std::fs::read_to_string(path)?)?;
    }
    let mut session = Session::open_working_copy(&png, &metadata, Filter::Lanczos3)?;
    let started = std::time::Instant::now();
    let frame = session.render(&settings, max_dimension, quality)?;
    let initial_ms = started.elapsed().as_secs_f64() * 1000.0;
    if arguments[4].ends_with(".rgba") {
        std::fs::write(&arguments[4], &frame.rgba)?;
    } else {
        let jpeg = encode::encode_jpeg(&frame.rgba, frame.width, frame.height, 97)?;
        std::fs::write(&arguments[4], jpeg)?;
    }
    eprintln!("{}x{}", frame.width, frame.height);
    if cache_bench {
        let mut hs = settings.clone();
        hs.highlights = if hs.highlights <= -50.0 { -25.0 } else { -75.0 };
        hs.shadows = if hs.shadows >= 50.0 { 25.0 } else { 75.0 };
        let started = std::time::Instant::now();
        session.render(&hs, max_dimension, quality)?;
        let hs_drag_ms = started.elapsed().as_secs_f64() * 1000.0;

        let mut tail = hs;
        tail.contrast = if tail.contrast >= 50.0 { 20.0 } else { 80.0 };
        let started = std::time::Instant::now();
        session.render(&tail, max_dimension, quality)?;
        let tail_drag_ms = started.elapsed().as_secs_f64() * 1000.0;
        eprintln!(
            "{{\"initialMs\":{initial_ms:.3},\"hsDragMs\":{hs_drag_ms:.3},\"tailDragMs\":{tail_drag_ms:.3}}}"
        );
    }
    Ok(())
}
