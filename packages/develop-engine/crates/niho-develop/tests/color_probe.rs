//! Synthetic color probes for the hue-stable saturation engines (#28).

use niho_develop::color::{
    linear_srgb_to_oklab, mat_vec, oklab_to_linear_srgb, PROPHOTO_TO_SRGB, SRGB_TO_PROPHOTO,
};
use niho_develop::color_ops::{color_grading, hsl, saturation, PreparedColorOps};
use niho_develop::settings::{
    DevelopSettings, HslAdjustment, HslBand, ENGINE_NIHO_10, ENGINE_NIHO_11, ENGINE_NIHO_6,
    ENGINE_NIHO_7, LOOK_NIHO_STANDARD_1, LOOK_NIHO_STANDARD_5,
};

type Rgb = [f64; 3];

fn settings(engine: &str) -> DevelopSettings {
    let mut value = DevelopSettings::neutral();
    value.engine = engine.into();
    value.look = if matches!(engine, ENGINE_NIHO_7 | ENGINE_NIHO_11) {
        LOOK_NIHO_STANDARD_5.into()
    } else {
        LOOK_NIHO_STANDARD_1.into()
    };
    value
}

fn prepared(value: &DevelopSettings) -> PreparedColorOps {
    if matches!(value.engine.as_str(), ENGINE_NIHO_7 | ENGINE_NIHO_11) {
        PreparedColorOps::after_default_curve(value)
    } else {
        PreparedColorOps::new(value)
    }
}

fn oklch_to_prophoto(l: f64, c: f64, hue: f64) -> Option<Rgb> {
    let radians = hue.to_radians();
    let srgb = oklab_to_linear_srgb([
        l as f32,
        (c * radians.cos()) as f32,
        (c * radians.sin()) as f32,
    ]);
    if !srgb.iter().all(|channel| (0.0..=1.0).contains(channel)) {
        return None;
    }
    Some(mat_vec(
        &SRGB_TO_PROPHOTO,
        srgb.map(|channel| f64::from(channel)),
    ))
}

fn oklab(value: Rgb) -> [f32; 3] {
    linear_srgb_to_oklab(mat_vec(&PROPHOTO_TO_SRGB, value).map(|channel| channel as f32))
}

fn hue(value: Rgb) -> Option<f64> {
    let lab = oklab(value);
    let chroma = f64::from(lab[1]).hypot(f64::from(lab[2]));
    (chroma > 1e-6).then(|| f64::from(lab[2]).atan2(f64::from(lab[1])).to_degrees())
}

fn hue_distance(a: Rgb, b: Rgb) -> f64 {
    let (Some(a), Some(b)) = (hue(a), hue(b)) else {
        return 0.0;
    };
    ((a - b + 180.0).rem_euclid(360.0) - 180.0).abs()
}

fn assert_finite(value: Rgb) {
    assert!(value.iter().all(|channel| channel.is_finite()), "{value:?}");
}

#[derive(Default)]
struct ProbeMetrics {
    max_hue_drift: f64,
    max_legacy_hue_drift: f64,
    max_delta_l: f64,
    max_delta_c: f64,
}

impl ProbeMetrics {
    fn record(&mut self, output: Rgb, legacy: Rgb, reference: Rgb) {
        self.max_hue_drift = self.max_hue_drift.max(hue_distance(output, reference));
        self.max_legacy_hue_drift = self
            .max_legacy_hue_drift
            .max(hue_distance(legacy, reference));
        let output_lab = oklab(output);
        let legacy_lab = oklab(legacy);
        self.max_delta_l = self
            .max_delta_l
            .max((f64::from(output_lab[0]) - f64::from(legacy_lab[0])).abs());
        let output_chroma = f64::from(output_lab[1]).hypot(f64::from(output_lab[2]));
        let legacy_chroma = f64::from(legacy_lab[1]).hypot(f64::from(legacy_lab[2]));
        self.max_delta_c = self.max_delta_c.max((output_chroma - legacy_chroma).abs());
    }
}

fn probe_saturation_drift(hue_step: usize) -> ProbeMetrics {
    let mut metrics = ProbeMetrics::default();
    for engine in [ENGINE_NIHO_10, ENGINE_NIHO_11] {
        let legacy_engine = if engine == ENGINE_NIHO_10 {
            ENGINE_NIHO_6
        } else {
            ENGINE_NIHO_7
        };
        for (l, c) in [(0.45, 0.10), (0.65, 0.10), (0.80, 0.08)] {
            for hue_degrees in (0..360).step_by(hue_step) {
                let Some(input) = oklch_to_prophoto(l, c, f64::from(hue_degrees)) else {
                    continue;
                };
                for (vibrance, amount) in [(0.0, -50.0), (0.0, 50.0), (20.0, -50.0), (20.0, 50.0)] {
                    let mut reference = settings(engine);
                    reference.vibrance = vibrance;

                    let mut global = reference.clone();
                    global.saturation = amount;
                    let mut legacy_global = global.clone();
                    legacy_global.engine = legacy_engine.into();
                    metrics.record(
                        prepared(&global).apply(input),
                        prepared(&legacy_global).apply(input),
                        prepared(&reference).apply(input),
                    );

                    for band in HslBand::ALL {
                        let mut adjusted = reference.clone();
                        adjusted.hsl.set(
                            band,
                            HslAdjustment {
                                saturation: amount,
                                ..HslAdjustment::default()
                            },
                        );
                        let mut legacy_adjusted = adjusted.clone();
                        legacy_adjusted.engine = legacy_engine.into();
                        metrics.record(
                            prepared(&adjusted).apply(input),
                            prepared(&legacy_adjusted).apply(input),
                            prepared(&reference).apply(input),
                        );
                    }
                }
            }
        }
    }
    metrics
}

#[test]
fn hue_stable_saturation_small_regression() {
    let metrics = probe_saturation_drift(60);
    assert!(
        metrics.max_hue_drift <= 2.0,
        "maximum OKLab hue drift: {:.6} degrees",
        metrics.max_hue_drift
    );
    assert!(
        metrics.max_delta_l < 5e-6,
        "Delta L: {}",
        metrics.max_delta_l
    );
    assert!(
        metrics.max_delta_c < 5e-6,
        "Delta C: {}",
        metrics.max_delta_c
    );
}

#[test]
fn hue_only_neutral_grading_and_legacy_paths_are_independent() {
    let input = oklch_to_prophoto(0.65, 0.10, 355.0).unwrap();

    for (old, new) in [
        (ENGINE_NIHO_6, ENGINE_NIHO_10),
        (ENGINE_NIHO_7, ENGINE_NIHO_11),
    ] {
        assert_eq!(
            prepared(&settings(old)).apply(input),
            prepared(&settings(new)).apply(input),
            "neutral path changed for {old}/{new}"
        );

        let mut old_hue = settings(old);
        old_hue.hsl.set(
            HslBand::Red,
            HslAdjustment {
                hue: 35.0,
                luminance: 20.0,
                ..HslAdjustment::default()
            },
        );
        let mut new_hue = old_hue.clone();
        new_hue.engine = new.into();
        assert_eq!(
            prepared(&old_hue).apply(input),
            prepared(&new_hue).apply(input),
            "hue/luminance-only path changed for {old}/{new}"
        );

        let mut old_saturation = old_hue.clone();
        old_saturation.saturation = 50.0;
        old_saturation.hsl.set(
            HslBand::Red,
            HslAdjustment {
                hue: 35.0,
                saturation: -50.0,
                luminance: 20.0,
            },
        );
        let mut new_saturation = old_saturation.clone();
        new_saturation.engine = new.into();
        let old_lab = oklab(prepared(&old_saturation).apply(input));
        let new_lab = oklab(prepared(&new_saturation).apply(input));
        let old_chroma = f64::from(old_lab[1]).hypot(f64::from(old_lab[2]));
        let new_chroma = f64::from(new_lab[1]).hypot(f64::from(new_lab[2]));
        assert!((f64::from(old_lab[0]) - f64::from(new_lab[0])).abs() < 5e-6);
        assert!((old_chroma - new_chroma).abs() < 5e-6);
        assert!(
            hue_distance(
                prepared(&new_saturation).apply(input),
                prepared(&old_hue).apply(input)
            ) <= 2.0
        );
    }

    // The published niho-6 operation remains the frozen HSV functions.
    let mut legacy = settings(ENGINE_NIHO_6);
    legacy.saturation = 50.0;
    legacy.hsl.set(
        HslBand::Red,
        HslAdjustment {
            saturation: -50.0,
            ..HslAdjustment::default()
        },
    );
    assert_eq!(
        prepared(&legacy).apply(input),
        hsl(saturation(input, 50.0), legacy.hsl.entries())
    );

    let mut corrected = settings(ENGINE_NIHO_10);
    corrected.saturation = 50.0;
    let before_grading = prepared(&corrected).apply(input);
    corrected.color_grading.global.hue = 32.0;
    corrected.color_grading.global.saturation = 25.0;
    assert_eq!(
        prepared(&corrected).apply(input),
        color_grading(before_grading, &corrected.color_grading)
    );

    for input in [[0.3, 0.3, 0.3], [0.3, 0.300_000_1, 0.3], [-0.1, 0.4, 1.2]] {
        for engine in [ENGINE_NIHO_10, ENGINE_NIHO_11] {
            let mut extreme = settings(engine);
            extreme.saturation = 100.0;
            for band in HslBand::ALL {
                extreme.hsl.set(
                    band,
                    HslAdjustment {
                        saturation: 100.0,
                        ..HslAdjustment::default()
                    },
                );
            }
            assert_finite(prepared(&extreme).apply(input));
        }
    }
}

#[test]
#[ignore = "diagnostic 5-degree synthetic sRGB sweep"]
fn full_hue_sweep_stays_within_two_degrees() {
    let metrics = probe_saturation_drift(5);
    eprintln!(
        "maximum OKLab hue drift: legacy={:.6} new={:.6} improvement={:.6} degrees; max |Delta L|={:.9}; max |Delta C|={:.9}",
        metrics.max_legacy_hue_drift,
        metrics.max_hue_drift,
        metrics.max_legacy_hue_drift - metrics.max_hue_drift,
        metrics.max_delta_l,
        metrics.max_delta_c
    );
    assert!(
        metrics.max_hue_drift <= 2.0,
        "maximum OKLab hue drift: {:.6} degrees",
        metrics.max_hue_drift
    );
    assert!(
        metrics.max_delta_l < 5e-6,
        "Delta L: {}",
        metrics.max_delta_l
    );
    assert!(
        metrics.max_delta_c < 5e-6,
        "Delta C: {}",
        metrics.max_delta_c
    );
}
