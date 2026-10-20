//! Fit and validate the research-only linear ProPhoto JPEG WB candidate.
//!
//! `cargo run --release -p niho-develop --example linear_jpeg_wb_fit`
//! prints a machine-readable JSON report. The optimizer sees the eight axis
//! variants only; validation is a subsequent pass over all ten variants and
//! separately reports the two held-out same-sign combinations.

use niho_develop::research::linear_jpeg_wb::{self as wb, ValidationReport, Variant};
use serde_json::{json, Value};
use std::time::Instant;

fn report(value: &ValidationReport) -> Value {
    json!({
        "meanDeltaE00": value.mean_delta_e00,
        "p99DeltaE00": value.p99_delta_e00,
        "meanGate": wb::MEAN_GATE,
        "meanGateMet": value.mean_gate_met,
        "variants": value.variants.iter().map(|metrics| json!({
            "variant": metrics.variant.name(),
            "sliders": {
                "temperature": metrics.variant.sliders().0,
                "tint": metrics.variant.sliders().1
            },
            "samples": metrics.samples,
            "meanDeltaE00": metrics.mean_delta_e00,
            "p99DeltaE00": metrics.p99_delta_e00
        })).collect::<Vec<_>>()
    })
}

fn main() {
    let started = Instant::now();
    let mapping = wb::fit();
    let fit_ms = started.elapsed().as_secs_f64() * 1000.0;

    let started = Instant::now();
    let all = wb::validate(mapping, &Variant::ALL);
    let held_out = wb::validate(mapping, &Variant::HELD_OUT_COMBINATIONS);
    let validation_ms = started.elapsed().as_secs_f64() * 1000.0;

    let output = json!({
        "schema": "niho.linear-jpeg-wb-research.v1",
        "status": "research-only-not-production",
        "productionJpegWbChanged": false,
        "inputSpace": "linear ProPhoto D50",
        "adaptation": "Bradford XYZ",
        "displayComparison": "matrix isolation: clip linear sRGB and quantize to 8-bit; not a full pipeline or preset gate",
        "fitData": [
            "temp_m80", "temp_m30", "temp_p30", "temp_p80",
            "tint_m50", "tint_m20", "tint_p20", "tint_p50"
        ],
        "heldOutDuringFit": ["wb_cool", "wb_warm"],
        "mapping": {
            "baseKelvin": 5000.0,
            "miredLinear": mapping.mired_linear,
            "miredQuadratic": mapping.mired_quadratic,
            "tintLinear": mapping.tint_linear,
            "tintQuadratic": mapping.tint_quadratic
        },
        "fitAxisMetrics": report(&wb::validate(mapping, &Variant::FIT_AXES)),
        "validationAllTen": report(&all),
        "validationHeldOutCombinations": report(&held_out),
        "timingsMs": {"fit": fit_ms, "validation": validation_ms},
        "promotionBlockedBy": [
            "mean CIEDE2000 gate if validationAllTen.meanGateMet is false",
            "independent Lightroom preset plus WB references are unavailable"
        ]
    });
    println!("{}", serde_json::to_string_pretty(&output).unwrap());
}
