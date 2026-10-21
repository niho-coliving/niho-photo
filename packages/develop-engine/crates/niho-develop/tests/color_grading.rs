//! Color grading per luminance zone (niho-photo#39). The shadow / highlight
//! luminance are Photo Bench's Lightroom fits; the midtone / global luminance
//! are NIHO's approximation (not calibrated against Lightroom yet), which
//! only adds its own term: at 0 every pixel stays as before. The pixel checks
//! render synthetic sRGB images through the whole raster pipeline from the
//! JSON the editor writes (`colorGrading.<zone>.{hue, saturation,
//! luminance}`).

use niho_develop::color_ops::{color_grading, needs_color_grading};
use niho_develop::encode::encode_png;
use niho_develop::settings::{ColorGradeBand, ColorGradingSettings};
use niho_develop::RenderOptions;

/// Linear ProPhoto colors across the gamut (grays, tints, saturated).
fn samples() -> Vec<[f64; 3]> {
    let levels = [0.004, 0.03, 0.12, 0.3, 0.55, 0.8];
    let mut out = Vec::new();
    for r in levels {
        for g in levels {
            for b in levels {
                out.push([r, g, b]);
            }
        }
    }
    out
}

/// Grading that exercises every existing term (saturation of all zones,
/// shadow / highlight luminance, blending below 100 and balance).
fn existing_grading() -> ColorGradingSettings {
    ColorGradingSettings {
        shadow: ColorGradeBand {
            hue: 220.0,
            saturation: 40.0,
            luminance: 15.0,
        },
        midtone: ColorGradeBand {
            hue: 90.0,
            saturation: 25.0,
            luminance: 0.0,
        },
        highlight: ColorGradeBand {
            hue: 35.0,
            saturation: 45.0,
            luminance: -20.0,
        },
        global: ColorGradeBand {
            hue: 300.0,
            saturation: 10.0,
            luminance: 0.0,
        },
        blending: 70.0,
        balance: -30.0,
    }
}

#[test]
fn midtone_and_global_luminance_only_add_a_luminance_shift() {
    let base_settings = existing_grading();
    for zone in ["midtone", "global"] {
        for luminance in [-60.0, 35.0] {
            let mut s = base_settings.clone();
            match zone {
                "midtone" => s.midtone.luminance = luminance,
                _ => s.global.luminance = luminance,
            }
            assert!(needs_color_grading(&s));
            let mut moved = 0;
            for v in samples() {
                let base = color_grading(v, &base_settings);
                let with = color_grading(v, &s);
                let clamped = base
                    .iter()
                    .chain(with.iter())
                    .any(|c| *c <= 0.0 || *c >= 1.0);
                if clamped {
                    continue;
                }
                // The same shift on R, G and B (the existing terms are
                // untouched), in the slider's direction.
                let d = [with[0] - base[0], with[1] - base[1], with[2] - base[2]];
                assert!(
                    (d[0] - d[1]).abs() < 1e-12 && (d[1] - d[2]).abs() < 1e-12,
                    "{zone} {luminance} {v:?}: {d:?}"
                );
                assert!(d[0] * luminance >= 0.0, "{zone} {luminance} {v:?}: {d:?}");
                if d[0].abs() > 1e-4 {
                    moved += 1;
                }
            }
            assert!(moved > 50, "{zone} {luminance}: {moved}");
        }
    }
    // Hue alone (no saturation, no luminance) still does nothing.
    let mut hue_only = ColorGradingSettings::default();
    hue_only.midtone.hue = 200.0;
    hue_only.global.hue = 40.0;
    assert!(!needs_color_grading(&hue_only));
    for v in samples() {
        assert_eq!(color_grading(v, &hue_only), v);
    }
}

/// `width` x 2 PNG whose columns are the sRGB grays `levels`.
fn gray_png(levels: &[u8]) -> Vec<u8> {
    let mut rgba = Vec::new();
    for _ in 0..2 {
        for level in levels {
            rgba.extend_from_slice(&[*level, *level, *level, 255]);
        }
    }
    encode_png(&rgba, levels.len(), 2).unwrap()
}

/// The first row of the render of `png` (RGB per column).
fn render(png: &[u8], engine: &str, grading: &str) -> Vec<[u8; 3]> {
    let look = if engine == "niho-1" {
        String::new()
    } else {
        r#","look":"niho-standard-1""#.to_string()
    };
    let settings = format!(r#"{{"v":1,"engine":"{engine}"{look},"colorGrading":{grading}}}"#);
    let frame = niho_develop::render(
        png,
        &settings,
        &RenderOptions {
            max_dimension: 0,
            ..Default::default()
        },
    )
    .unwrap();
    frame
        .rgba
        .chunks_exact(4)
        .take(frame.width)
        .map(|p| [p[0], p[1], p[2]])
        .collect()
}

/// A grading that changes nothing but still counts as a color edit (the
/// output transform of the graded renders is the same).
const UNGRADED: &str = r#"{"midtone":{"hue":200,"saturation":0,"luminance":0}}"#;

fn luminance_ramp(engine: &str, zone: &str, luminance: i32) -> (Vec<i32>, Vec<i32>) {
    let levels: Vec<u8> = (0..=255).collect();
    let png = gray_png(&levels);
    let base = render(&png, engine, UNGRADED);
    let graded = render(
        &png,
        engine,
        &format!(r#"{{"{zone}":{{"hue":0,"saturation":0,"luminance":{luminance}}}}}"#),
    );
    let gray = |p: &[u8; 3]| p[1] as i32;
    (
        base.iter().map(gray).collect(),
        graded.iter().map(gray).collect(),
    )
}

#[test]
fn midtone_luminance_moves_the_middle_and_keeps_the_ends() {
    for engine in ["niho-1", "niho-10"] {
        for luminance in [50, -50] {
            let (base, graded) = luminance_ramp(engine, "midtone", luminance);
            let sign = luminance.signum();
            // Monotonic, black and white kept.
            assert!(graded.windows(2).all(|w| w[1] >= w[0]), "{engine}");
            assert_eq!(graded[0], base[0], "{engine}");
            assert_eq!(graded[255], base[255], "{engine}");
            // The middle of the zone (sRGB ~ 0.55..0.75) moves several levels,
            // the deep shadows and the brightest highlights barely.
            for v in 140..=190 {
                let d = (graded[v] - base[v]) * sign;
                assert!(d >= 6, "{engine} {luminance} at {v}: {d}");
            }
            for v in (0..=12).chain(248..=255) {
                let d = (graded[v] - base[v]).abs();
                assert!(d <= 1, "{engine} {luminance} at {v}: {d}");
            }
        }
    }
}

#[test]
fn global_luminance_moves_the_whole_range_in_one_direction() {
    for engine in ["niho-1", "niho-10"] {
        for luminance in [50, -50] {
            let (base, graded) = luminance_ramp(engine, "global", luminance);
            let sign = luminance.signum();
            assert!(graded.windows(2).all(|w| w[1] >= w[0]), "{engine}");
            assert_eq!(graded[0], base[0], "{engine}");
            assert_eq!(graded[255], base[255], "{engine}");
            // Every interior level moves the slider's way, from the deep
            // shadows to the light highlights.
            for v in 1..=254 {
                assert!((graded[v] - base[v]) * sign >= 0, "{engine} at {v}");
            }
            for v in 16..=235 {
                assert!(
                    (graded[v] - base[v]) * sign >= 1,
                    "{engine} {luminance} at {v}"
                );
            }
            // Broader than the midtone zone: the shadows move more.
            let (_, midtone) = luminance_ramp(engine, "midtone", luminance);
            assert!((graded[40] - base[40]).abs() > (midtone[40] - base[40]).abs());
        }
    }
}

#[test]
fn blue_shadows_and_orange_highlights_tint_the_dark_and_light_areas() {
    let png = gray_png(&[20, 45, 70, 185, 215, 240]);
    // What the editor writes: the two wheels it touched, full bands.
    let grading = r#"{"shadow":{"hue":220,"saturation":60,"luminance":0},"highlight":{"hue":35,"saturation":60,"luminance":0}}"#;
    for engine in ["niho-1", "niho-10"] {
        let base = render(&png, engine, UNGRADED);
        let graded = render(&png, engine, grading);
        for (i, (b, g)) in base.iter().zip(&graded).enumerate() {
            let tint = g[2] as i32 - g[0] as i32;
            assert_eq!(b[0], b[2], "{engine} {i}: the base stays gray");
            if i < 3 {
                // Dark grays turn blue (B > R).
                assert!(tint >= 3, "{engine} dark {i}: {g:?}");
            } else {
                // Light grays turn orange (R > B).
                assert!(tint <= -3, "{engine} light {i}: {g:?}");
            }
        }
    }
}
