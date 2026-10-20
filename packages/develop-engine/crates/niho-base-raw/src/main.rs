//! `niho-base-raw` CLI (contract §2.3). Exit code 0 on success, 1 on any error; errors are one line
//! on stderr.

use std::path::PathBuf;
use std::process::ExitCode;

use anyhow::{Context, Result};
use clap::{Parser, Subcommand};

use niho_base_raw::dcp::{self, DcpSpec};
use niho_base_raw::pipeline::{
    self, CameraInfoReport, DEFAULT_DUMP_LONG_EDGE, DEFAULT_RENDER_LONG_EDGE,
};
use niho_base_raw::{encode, par};

#[derive(Parser)]
#[command(
    name = "niho-base-raw",
    version,
    about = "NIHO develop engine stage 1: RAW → linear ProPhoto working copy through a NIHO DCP"
)]
struct Cli {
    #[command(subcommand)]
    cmd: Cmd,
}

#[derive(Subcommand)]
enum Cmd {
    /// Working copy: 16-bit PNG (linear ProPhoto D50, power 1/1.8, max 2.0) + sidecar JSON.
    Render {
        #[arg(long)]
        raw: PathBuf,
        #[arg(long)]
        dcp: PathBuf,
        #[arg(long)]
        out: PathBuf,
        #[arg(long, default_value_t = DEFAULT_RENDER_LONG_EDGE)]
        long_edge: usize,
        /// Sidecar path (default: <out> with .json).
        #[arg(long)]
        meta: Option<PathBuf>,
    },
    /// White-balanced camera RGB without any color matrix (same encoding, demosaic, resize, orientation).
    DumpCamera {
        #[arg(long)]
        raw: PathBuf,
        #[arg(long)]
        out: PathBuf,
        #[arg(long, default_value_t = DEFAULT_DUMP_LONG_EDGE)]
        long_edge: usize,
        #[arg(long)]
        meta: Option<PathBuf>,
    },
    /// DNG camera profile tools.
    Dcp {
        #[command(subcommand)]
        cmd: DcpCmd,
    },
    /// Decode only and print the camera metadata.
    CameraInfo {
        #[arg(long)]
        raw: PathBuf,
        #[arg(long)]
        json: bool,
    },
}

#[derive(Subcommand)]
enum DcpCmd {
    /// Write a DCP from an independently measured explicit spec JSON.
    Make {
        #[arg(long)]
        spec: PathBuf,
        #[arg(long)]
        out: PathBuf,
    },
    /// Print a DCP as the spec JSON (--json) or as text.
    Inspect {
        dcp: PathBuf,
        #[arg(long)]
        json: bool,
        /// Leave out the table data.
        #[arg(long)]
        summary: bool,
    },
    /// SHA-256 of a DCP file (the `dcp-<sha>` part of baseVersion).
    Sha256 { dcp: PathBuf },
}

/// The workspace release profile uses `panic = "abort"`, so a panic (e.g. inside the raw decoder)
/// cannot be caught. Report it as a one-line error and exit 1 like any other failure.
fn install_panic_hook() {
    std::panic::set_hook(Box::new(|info| {
        let msg = if let Some(s) = info.payload().downcast_ref::<&str>() {
            (*s).to_string()
        } else if let Some(s) = info.payload().downcast_ref::<String>() {
            s.clone()
        } else {
            "unknown panic".to_string()
        };
        if msg.contains("Broken pipe") {
            // The reader closed stdout early (e.g. `| head`): nothing to report.
            std::process::exit(1);
        }
        let place = info
            .location()
            .map(|l| format!(" at {}:{}", l.file(), l.line()))
            .unwrap_or_default();
        eprintln!(
            "error: internal panic: {}{place}",
            msg.replace(['\n', '\r'], " ")
        );
        std::process::exit(1);
    }));
}

fn main() -> ExitCode {
    install_panic_hook();
    let cli = match Cli::try_parse() {
        Ok(cli) => cli,
        Err(e) => {
            use clap::error::ErrorKind;
            if matches!(e.kind(), ErrorKind::DisplayHelp | ErrorKind::DisplayVersion) {
                let _ = e.print();
                return ExitCode::SUCCESS;
            }
            let msg = e.to_string();
            let line = msg
                .lines()
                .map(str::trim)
                .find(|l| !l.is_empty())
                .unwrap_or("invalid arguments");
            let line = line.strip_prefix("error: ").unwrap_or(line);
            eprintln!("error: {line} (see --help)");
            return ExitCode::FAILURE;
        }
    };
    match run(cli) {
        Ok(()) => ExitCode::SUCCESS,
        Err(e) => {
            let msg = format!("{e:#}").replace(['\n', '\r'], " ");
            eprintln!("error: {msg}");
            ExitCode::FAILURE
        }
    }
}

fn print_warnings(w: &[String]) {
    for line in w {
        eprintln!("warning: {line}");
    }
}

fn run(cli: Cli) -> Result<()> {
    match cli.cmd {
        Cmd::Render {
            raw,
            dcp,
            out,
            long_edge,
            meta,
        } => {
            let dev = pipeline::render_files(&raw, &dcp, &out, meta.as_deref(), long_edge)?;
            print_warnings(&dev.warnings);
            let t = &dev.sidecar.timings_ms;
            println!(
                "{} {}x{} baseVersion={} decode={}ms demosaic={}ms color={}ms resize={}ms encode={}ms total={}ms threads={}",
                out.display(),
                dev.width,
                dev.height,
                dev.sidecar.base_version,
                t.decode,
                t.demosaic,
                t.color,
                t.resize,
                t.encode,
                t.total,
                par::threads()
            );
        }
        Cmd::DumpCamera {
            raw,
            out,
            long_edge,
            meta,
        } => {
            let dev = pipeline::dump_camera_files(&raw, &out, meta.as_deref(), long_edge)?;
            print_warnings(&dev.warnings);
            let t = &dev.sidecar.timings_ms;
            println!(
                "{} {}x{} camera-rgb-wb total={}ms",
                out.display(),
                dev.width,
                dev.height,
                t.total
            );
        }
        Cmd::Dcp { cmd } => run_dcp(cmd)?,
        Cmd::CameraInfo { raw, json } => {
            let info = pipeline::camera_info(&raw)?;
            if json {
                println!("{}", serde_json::to_string_pretty(&info)?);
            } else {
                print_camera_info(&info);
            }
        }
    }
    Ok(())
}

fn run_dcp(cmd: DcpCmd) -> Result<()> {
    match cmd {
        DcpCmd::Make { spec, out } => {
            let text = std::fs::read_to_string(&spec)
                .with_context(|| format!("cannot read spec {}", spec.display()))?;
            let s: DcpSpec = serde_json::from_str(&text)
                .with_context(|| format!("invalid spec JSON {}", spec.display()))?;
            let bytes = s.to_dcp_bytes()?;
            encode::write_atomic(&out, &bytes)?;
            println!("{} sha256={}", out.display(), dcp::sha256_hex(&bytes));
        }
        DcpCmd::Inspect {
            dcp: path,
            json,
            summary,
        } => {
            let d = dcp::load_dcp(&path)?;
            if json {
                println!("{}", d.spec.to_json_string(summary)?);
            } else {
                print_dcp_text(&d.spec);
                println!("sha256: {}", d.sha256);
            }
        }
        DcpCmd::Sha256 { dcp: path } => {
            let bytes =
                std::fs::read(&path).with_context(|| format!("cannot read {}", path.display()))?;
            println!("{}", dcp::sha256_hex(&bytes));
        }
    }
    Ok(())
}

fn opt<T: std::fmt::Debug>(v: &Option<T>) -> String {
    v.as_ref()
        .map(|x| format!("{x:?}"))
        .unwrap_or_else(|| "-".to_string())
}

fn print_dcp_text(s: &DcpSpec) {
    println!("profileName: {}", s.profile_name);
    println!("uniqueCameraModel: {}", s.unique_camera_model);
    println!("copyright: {}", s.copyright);
    println!("embedPolicy: {}", s.embed_policy);
    println!("calibrationSignature: {}", s.calibration_signature);
    println!("illuminant1: {}", s.illuminant1);
    println!("colorMatrix1: {:?}", s.color_matrix1);
    println!("illuminant2: {}", opt(&s.illuminant2));
    println!("colorMatrix2: {}", opt(&s.color_matrix2));
    println!("forwardMatrix1: {}", opt(&s.forward_matrix1));
    println!("forwardMatrix2: {}", opt(&s.forward_matrix2));
    match &s.hue_sat_map {
        Some(h) => println!(
            "hueSatMap: {}x{}x{} encoding {} tables {}",
            h.hue_divisions,
            h.sat_divisions,
            h.val_divisions,
            h.encoding,
            if h.data2.is_some() { 2 } else { 1 }
        ),
        None => println!("hueSatMap: -"),
    }
    println!("baselineExposureOffset: {}", s.baseline_exposure_offset);
    println!("defaultBlackRender: {}", s.default_black_render);
    match &s.tone_curve {
        Some(t) => println!("toneCurve: {} points (not applied in stage 1)", t.len()),
        None => println!("toneCurve: -"),
    }
    match &s.look_table {
        Some(l) => println!(
            "lookTable: {}x{}x{} encoding {} (not applied in stage 1)",
            l.hue_divisions, l.sat_divisions, l.val_divisions, l.encoding
        ),
        None => println!("lookTable: -"),
    }
}

fn print_camera_info(i: &CameraInfoReport) {
    println!("make: {}", i.make);
    println!("model: {}", i.model);
    println!("cleanMake: {}", i.clean_make);
    println!("cleanModel: {}", i.clean_model);
    println!("full: {}x{}", i.full_width, i.full_height);
    println!(
        "crop: x={} y={} {}x{}",
        i.crop.x, i.crop.y, i.crop.width, i.crop.height
    );
    println!("cfa: {}", i.cfa);
    println!("bitsPerSample: {}", i.bits_per_sample);
    println!(
        "blackLevel: {}",
        serde_json::Value::from(i.black_level.clone())
    );
    println!(
        "whiteLevel: {}",
        serde_json::Value::from(i.white_level.clone())
    );
    println!("wbCoeffs: {:?}", i.wb_coeffs);
    println!("asShotMultipliers: {:?}", i.as_shot_multipliers);
    println!("asShotNeutral: {:?}", i.as_shot_neutral);
    println!(
        "orientation: {} (EXIF {}, from {})",
        i.orientation, i.orientation_exif, i.orientation_source
    );
    println!("iso: {}", opt(&i.iso));
    println!(
        "baselineExposure: {}{}",
        opt(&i.baseline_exposure),
        i.baseline_exposure_source
            .as_deref()
            .map(|s| format!(" ({s})"))
            .unwrap_or_default()
    );
    for (k, v) in &i.rawler_color_matrices {
        println!("rawlerColorMatrix[{k}]: {v:?}");
    }
    println!("decodeMs: {}", i.decode_ms);
}
