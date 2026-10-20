//! Research-only A/B renderer for analytic image-adaptive H/S candidate B.
//!
//! Usage:
//! `analytic_hs_probe <input.jpg> <settings.json> <output-dir> [frozen-residual.json]`

use niho_develop::research::analytic_hs::{
    gate_contract_json, render_pair, residual_from_manifest, ResidualModel,
};
use niho_develop::{encode, parse_settings, Filter, Quality, RenderOptions};
use serde_json::json;
use std::path::PathBuf;
use std::time::Instant;

fn main() -> Result<(), Box<dyn std::error::Error>> {
    let mut args = std::env::args_os().skip(1);
    let input_path = PathBuf::from(args.next().ok_or("input path")?);
    let settings_path = PathBuf::from(args.next().ok_or("settings JSON path")?);
    let output_dir = PathBuf::from(args.next().ok_or("output directory")?);
    let residual_path = args.next().map(PathBuf::from);
    if args.next().is_some() {
        return Err("too many arguments".into());
    }

    let input = std::fs::read(&input_path)?;
    let settings_bytes = std::fs::read(&settings_path)?;
    let settings = parse_settings(std::str::from_utf8(&settings_bytes)?)?;
    let (residual, residual_sha256, frozen) = match residual_path {
        Some(path) => {
            let bytes = std::fs::read(path)?;
            let (model, digest) = residual_from_manifest(&bytes).map_err(std::io::Error::other)?;
            (model, Some(digest), true)
        }
        None => (ResidualModel::default(), None, false),
    };
    let options = RenderOptions {
        max_dimension: 2048,
        quality: Quality::Final,
        filter: Filter::Lanczos3,
        ..Default::default()
    };
    let started = Instant::now();
    let (baseline, candidate, summary) = render_pair(&input, &settings, &options, residual)?;
    let elapsed_ms = started.elapsed().as_secs_f64() * 1000.0;

    std::fs::create_dir_all(&output_dir)?;
    let baseline_bytes = encode::encode_png(&baseline.rgba, baseline.width, baseline.height)
        .map_err(std::io::Error::other)?;
    let candidate_bytes = encode::encode_png(&candidate.rgba, candidate.width, candidate.height)
        .map_err(std::io::Error::other)?;
    std::fs::write(output_dir.join("candidate-a-niho2.png"), &baseline_bytes)?;
    std::fs::write(
        output_dir.join("candidate-b-analytic-hs.png"),
        &candidate_bytes,
    )?;
    let digest = niho_camera_profile::dcp::sha256_hex;
    let report = json!({
        "schema": "niho.analytic-hs-probe.v1",
        "status": "research-only-not-production",
        "candidateFrozen": false,
        "residualFrozen": frozen,
        "freezeReason": "Freeze the exact source commit and executable hash before any independent evaluation",
        "executableSha256": digest(&std::fs::read(std::env::current_exe()?)?),
        "residualCoefficientsSha256": residual_sha256,
        "inputSha256": digest(&input),
        "settingsSha256": digest(&settings_bytes),
        "outputs": {
            "candidateA": {
                "file": "candidate-a-niho2.png",
                "sha256": digest(&baseline_bytes)
            },
            "candidateB": {
                "file": "candidate-b-analytic-hs.png",
                "sha256": digest(&candidate_bytes)
            }
        },
        "analysis": {
            "meanLogLuminance": summary.analysis.mean_log_luminance,
            "p90LogLuminance": summary.analysis.p90_log_luminance,
            "exposureEV": summary.analysis.exposure_ev,
            "highlightResidualEV": summary.analysis.highlight_residual_ev,
            "shadowResidualEV": summary.analysis.shadow_residual_ev,
            "minGainEV": summary.min_gain_ev,
            "maxGainEV": summary.max_gain_ev,
            "nonFinitePixels": summary.non_finite_pixels
        },
        "gateContract": gate_contract_json(),
        "gateResult": null,
        "gateResultReason": "private Lightroom references and the independent holdout are not inputs to this public probe",
        "timingMs": elapsed_ms
    });
    std::fs::write(
        output_dir.join("manifest.json"),
        serde_json::to_vec_pretty(&report)?,
    )?;
    println!("{}", serde_json::to_string_pretty(&report)?);
    Ok(())
}
