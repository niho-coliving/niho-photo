//! Independent OKLCH color mixer contract. This file is also run by the
//! existing wasm-bindgen test command, so native and browser exercise the
//! same composition frame and validation cases.

use niho_develop::color::{mat_vec, srgb_encode, PROPHOTO_TO_SRGB, SRGB_TO_PROPHOTO};
use niho_develop::color_ops::color_points;
use niho_develop::pipeline::bake_color_cube;
use niho_develop::settings::{ColorPoint, DevelopSettings, OklchDelta, OklchRange, OklchTarget};
use niho_develop::xmp::{apply_preset, preset_settings, settings_to_xmp, XmpWriteOptions};
use niho_develop::{encode, parse_settings, Filter, Quality, Session};

fn oklch_to_prophoto([l, c, h]: [f64; 3]) -> [f64; 3] {
    let angle = h * core::f64::consts::PI / 180.0;
    let a = c * libm::cos(angle);
    let b = c * libm::sin(angle);
    let ll = l + 0.396_337_777_4 * a + 0.215_803_757_3 * b;
    let mm = l - 0.105_561_345_8 * a - 0.063_854_172_8 * b;
    let ss = l - 0.089_484_177_5 * a - 1.291_485_548 * b;
    mat_vec(
        &SRGB_TO_PROPHOTO,
        [
            4.076_741_662_1 * ll.powi(3) - 3.307_711_591_3 * mm.powi(3)
                + 0.230_969_929_2 * ss.powi(3),
            -1.268_438_004_6 * ll.powi(3) + 2.609_757_401_1 * mm.powi(3)
                - 0.341_319_396_5 * ss.powi(3),
            -0.004_196_086_3 * ll.powi(3) - 0.703_418_614_7 * mm.powi(3)
                + 1.707_614_701 * ss.powi(3),
        ],
    )
}

fn prophoto_to_oklch(value: [f64; 3]) -> [f64; 3] {
    let rgb = mat_vec(&PROPHOTO_TO_SRGB, value);
    let l =
        libm::cbrt(0.412_221_470_8 * rgb[0] + 0.536_332_536_3 * rgb[1] + 0.051_445_992_9 * rgb[2]);
    let m =
        libm::cbrt(0.211_903_498_2 * rgb[0] + 0.680_699_545_1 * rgb[1] + 0.107_396_956_6 * rgb[2]);
    let s =
        libm::cbrt(0.088_302_461_9 * rgb[0] + 0.281_718_837_6 * rgb[1] + 0.629_978_700_5 * rgb[2]);
    let lab = [
        0.210_454_255_3 * l + 0.793_617_785 * m - 0.004_072_046_8 * s,
        1.977_998_495_1 * l - 2.428_592_205 * m + 0.450_593_709_9 * s,
        0.025_904_037_1 * l + 0.782_771_766_2 * m - 0.808_675_766 * s,
    ];
    let chroma = libm::hypot(lab[1], lab[2]);
    let hue = if chroma <= 1e-12 {
        0.0
    } else {
        (libm::atan2(lab[2], lab[1]) * 180.0 / core::f64::consts::PI).rem_euclid(360.0)
    };
    [lab[0], chroma, hue]
}

fn point(target: [f64; 3], delta: OklchDelta) -> ColorPoint {
    ColorPoint {
        id: format!("p-{}", target[2]),
        target: OklchTarget {
            lightness: target[0],
            chroma: target[1],
            hue: target[2],
        },
        range: OklchRange {
            hue: 20.0,
            chroma: 0.05,
            lightness: 0.1,
        },
        delta,
    }
}

fn hue_distance(a: f64, b: f64) -> f64 {
    ((a - b + 180.0).rem_euclid(360.0) - 180.0).abs()
}

fn srgb8(value: [f64; 3]) -> [u8; 3] {
    let rgb = mat_vec(&PROPHOTO_TO_SRGB, value);
    rgb.map(|channel| libm::round(srgb_encode(channel.clamp(0.0, 1.0)) * 255.0) as u8)
}

#[cfg_attr(target_arch = "wasm32", wasm_bindgen_test::wasm_bindgen_test)]
#[cfg_attr(not(target_arch = "wasm32"), test)]
fn native_and_wasm_share_the_same_synthetic_frame_within_one_lsb() {
    let cases = [
        (
            [0.72, 0.08, 50.0],
            OklchDelta {
                hue: 10.0,
                chroma_scale: 1.0,
                lightness: 0.0,
            },
        ),
        (
            [0.70, 0.12, 250.0],
            OklchDelta {
                hue: -10.0,
                chroma_scale: 1.0,
                lightness: 0.0,
            },
        ),
        (
            [0.65, 0.10, 359.0],
            OklchDelta {
                hue: 4.0,
                chroma_scale: 1.1,
                lightness: -0.02,
            },
        ),
        (
            [0.50, 0.0, 0.0],
            OklchDelta {
                hue: 0.0,
                chroma_scale: 1.0,
                lightness: 0.05,
            },
        ),
    ];
    let mut max_lsb = 0u8;
    for (target, delta) in cases {
        let actual = srgb8(color_points(
            oklch_to_prophoto(target),
            &[point(target, delta)],
        ));
        let expected = srgb8(oklch_to_prophoto([
            target[0] + delta.lightness,
            target[1] * delta.chroma_scale,
            (target[2] + delta.hue).rem_euclid(360.0),
        ]));
        for channel in 0..3 {
            max_lsb = max_lsb.max(actual[channel].abs_diff(expected[channel]));
        }
    }
    assert!(
        max_lsb <= 1,
        "synthetic frame max channel difference: {max_lsb} LSB"
    );
}

#[cfg_attr(target_arch = "wasm32", wasm_bindgen_test::wasm_bindgen_test)]
#[cfg_attr(not(target_arch = "wasm32"), test)]
fn skin_and_sky_hue_move_without_l_or_c_drift_in_exact_and_final_cube_paths() {
    for target in [[0.72, 0.08, 50.0], [0.70, 0.12, 250.0]] {
        for delta_hue in [-10.0, 10.0] {
            let p = point(
                target,
                OklchDelta {
                    hue: delta_hue,
                    chroma_scale: 1.0,
                    lightness: 0.0,
                },
            );
            let input = oklch_to_prophoto(target);
            let exact = prophoto_to_oklch(color_points(input, std::slice::from_ref(&p)));
            assert!((exact[0] - target[0]).abs() <= 0.005);
            assert!((exact[1] / target[1] - 1.0).abs() <= 0.02);
            assert!(hue_distance(exact[2], target[2] + delta_hue) < 0.02);

            let mut settings = DevelopSettings::neutral();
            settings.v = 4;
            settings.engine = "niho-10".into();
            settings.look = "niho-standard-1".into();
            settings.color_points = vec![p];
            let sampled = prophoto_to_oklch(bake_color_cube(&settings, 64).apply(input));
            assert!(
                (sampled[0] - exact[0]).abs() <= 0.005,
                "{target:?} {sampled:?} {exact:?}"
            );
            assert!(
                (sampled[1] / exact[1] - 1.0).abs() <= 0.02,
                "{target:?} {sampled:?} {exact:?}"
            );
        }
    }
}

#[cfg_attr(target_arch = "wasm32", wasm_bindgen_test::wasm_bindgen_test)]
#[cfg_attr(not(target_arch = "wasm32"), test)]
fn session_picker_samples_pre_point_pre_grading_float_color() {
    let source = [0.72, 0.08, 50.0];
    let rgb = mat_vec(&PROPHOTO_TO_SRGB, oklch_to_prophoto(source));
    let mut rgba = vec![0u8; 4 * 4 * 4];
    for pixel in rgba.chunks_exact_mut(4) {
        pixel.copy_from_slice(&[
            libm::round(srgb_encode(rgb[0]) * 255.0) as u8,
            libm::round(srgb_encode(rgb[1]) * 255.0) as u8,
            libm::round(srgb_encode(rgb[2]) * 255.0) as u8,
            255,
        ]);
    }
    let png = encode::encode_png(&rgba, 4, 4).unwrap();
    let mut settings = DevelopSettings::neutral();
    settings.v = 4;
    settings.engine = "niho-10".into();
    settings.look = "niho-standard-1".into();
    settings.color_points = vec![point(
        source,
        OklchDelta {
            hue: 80.0,
            chroma_scale: 2.5,
            lightness: -0.2,
        },
    )];
    settings.color_grading.global.hue = 220.0;
    settings.color_grading.global.saturation = 100.0;
    let mut session = Session::open_raster(&png, 0, Filter::Lanczos3).unwrap();
    let sampled = session.sample_color(&settings, 4, 0.5, 0.5).unwrap();
    assert!((sampled[0] - source[0]).abs() <= 0.005, "{sampled:?}");
    assert!((sampled[1] / source[1] - 1.0).abs() <= 0.02, "{sampled:?}");
    assert!(hue_distance(sampled[2], source[2]) <= 1.0, "{sampled:?}");

    let center = color_points(
        oklch_to_prophoto(sampled),
        &[point(
            sampled,
            OklchDelta {
                hue: 10.0,
                chroma_scale: 1.0,
                lightness: 0.0,
            },
        )],
    );
    assert!(hue_distance(prophoto_to_oklch(center)[2], sampled[2] + 10.0) < 0.02);
}

#[cfg_attr(target_arch = "wasm32", wasm_bindgen_test::wasm_bindgen_test)]
#[cfg_attr(not(target_arch = "wasm32"), test)]
fn minimum_non_grid_range_changes_the_center_exactly_and_not_its_neighbor() {
    // Two 8-bit source colors are deliberately not nodes of the 64^3 cube.
    let pixels = [[191, 126, 91, 255], [89, 143, 196, 255]];
    let mut rgba = Vec::with_capacity(8);
    for pixel in pixels {
        rgba.extend_from_slice(&pixel);
    }
    let png = encode::encode_png(&rgba, 2, 1).unwrap();
    let mut base = DevelopSettings::neutral();
    base.v = 4;
    base.engine = "niho-10".into();
    base.look = "niho-standard-1".into();

    let mut sampler = Session::open_raster(&png, 0, Filter::Lanczos3).unwrap();
    let target = sampler.sample_color(&base, 2, 0.25, 0.5).unwrap();
    let outside = sampler.sample_color(&base, 2, 0.75, 0.5).unwrap();
    assert!(
        hue_distance(target[2], outside[2]) > 1.0
            || (target[1] - outside[1]).abs() > 0.001
            || (target[0] - outside[0]).abs() > 0.001
    );

    let mut adjusted = base.clone();
    let mut selected = point(
        target,
        OklchDelta {
            hue: 0.0,
            chroma_scale: 1.0,
            lightness: 0.08,
        },
    );
    selected.range = OklchRange {
        hue: 1.0,
        chroma: 0.001,
        lightness: 0.001,
    };
    adjusted.color_points = vec![selected];

    // The picker remains at the actual pre-point value even though the
    // point is active, and both final and drag paths apply the narrow point.
    let sampled_with_point = sampler.sample_color(&adjusted, 2, 0.25, 0.5).unwrap();
    for (actual, expected) in sampled_with_point.iter().zip(target) {
        assert!((*actual - expected).abs() < 1e-8);
    }
    for quality in [Quality::Interactive, Quality::Final] {
        let mut plain = Session::open_raster(&png, 0, Filter::Lanczos3).unwrap();
        let baseline = plain.render(&base, 2, quality).unwrap().rgba;
        let mut mixed = Session::open_raster(&png, 0, Filter::Lanczos3).unwrap();
        let rendered = mixed.render(&adjusted, 2, quality).unwrap().rgba;
        assert_ne!(&rendered[0..4], &baseline[0..4], "{quality:?}");
        assert_eq!(&rendered[4..8], &baseline[4..8], "{quality:?}");
    }
}

#[cfg_attr(target_arch = "wasm32", wasm_bindgen_test::wasm_bindgen_test)]
#[cfg_attr(not(target_arch = "wasm32"), test)]
fn picker_small_full_small_uses_the_source_for_each_requested_size() {
    let mut rgba = Vec::with_capacity(8 * 2 * 4);
    for _y in 0..2 {
        for x in 0..8 {
            let pixel = if x % 2 == 0 {
                [230, 70, 40, 255]
            } else {
                [30, 130, 230, 255]
            };
            rgba.extend_from_slice(&pixel);
        }
    }
    let png = encode::encode_png(&rgba, 8, 2).unwrap();
    let mut settings = DevelopSettings::neutral();
    settings.v = 4;
    settings.engine = "niho-10".into();
    settings.look = "niho-standard-1".into();

    let mut session = Session::open_raster(&png, 0, Filter::Lanczos3).unwrap();
    session.render(&settings, 2, Quality::Final).unwrap();
    let small_before = session.sample_color(&settings, 2, 0.25, 0.5).unwrap();
    session.render(&settings, 0, Quality::Final).unwrap();
    let full = session.sample_color(&settings, 0, 0.25, 0.5).unwrap();
    session.render(&settings, 2, Quality::Final).unwrap();
    let small_after = session.sample_color(&settings, 2, 0.25, 0.5).unwrap();

    let mut fresh_small = Session::open_raster(&png, 0, Filter::Lanczos3).unwrap();
    let expected_small = fresh_small.sample_color(&settings, 2, 0.25, 0.5).unwrap();
    let mut fresh_full = Session::open_raster(&png, 0, Filter::Lanczos3).unwrap();
    let expected_full = fresh_full.sample_color(&settings, 0, 0.25, 0.5).unwrap();
    assert_eq!(small_before, expected_small);
    assert_eq!(small_after, expected_small);
    assert_eq!(full, expected_full);
    assert_ne!(small_before, full);
}

#[cfg_attr(target_arch = "wasm32", wasm_bindgen_test::wasm_bindgen_test)]
#[cfg_attr(not(target_arch = "wasm32"), test)]
fn picker_normalized_coordinates_follow_the_rendered_crop() {
    let mut rgba = Vec::with_capacity(8 * 4 * 4);
    for _y in 0..4 {
        for x in 0..8 {
            rgba.extend_from_slice(if x < 4 {
                &[220, 80, 45, 255]
            } else {
                &[45, 120, 220, 255]
            });
        }
    }
    let png = encode::encode_png(&rgba, 8, 4).unwrap();
    let mut settings = DevelopSettings::neutral();
    settings.v = 4;
    settings.engine = "niho-10".into();
    settings.look = "niho-standard-1".into();
    let mut cropped_value = settings.to_value();
    cropped_value["geometry"] =
        serde_json::json!({"crop": {"left": 0.5, "top": 0.0, "right": 1.0, "bottom": 1.0}});
    let cropped = DevelopSettings::from_json(&cropped_value.to_string()).unwrap();

    let mut session = Session::open_raster(&png, 0, Filter::Lanczos3).unwrap();
    let expected = session.sample_color(&settings, 0, 0.75, 0.5).unwrap();
    let from_crop = session.sample_color(&cropped, 0, 0.5, 0.5).unwrap();
    for (actual, expected) in from_crop.iter().zip(expected) {
        assert!((*actual - expected).abs() < 1e-8);
    }
}

#[cfg_attr(target_arch = "wasm32", wasm_bindgen_test::wasm_bindgen_test)]
#[cfg_attr(not(target_arch = "wasm32"), test)]
fn independent_axes_neutral_wrap_wide_gamut_and_overlap_are_safe() {
    let target = [0.70, 0.12, 359.0];
    let input = oklch_to_prophoto(target);
    let chroma = point(
        target,
        OklchDelta {
            hue: 0.0,
            chroma_scale: 1.5,
            lightness: 0.0,
        },
    );
    let c = prophoto_to_oklch(color_points(input, std::slice::from_ref(&chroma)));
    assert!((c[0] - target[0]).abs() < 1e-9);
    assert!(hue_distance(c[2], target[2]) < 1e-7);
    assert!((c[1] / target[1] - 1.5).abs() < 1e-7);

    let light = point(
        target,
        OklchDelta {
            hue: 0.0,
            chroma_scale: 1.0,
            lightness: 0.05,
        },
    );
    let l = prophoto_to_oklch(color_points(input, std::slice::from_ref(&light)));
    assert!((l[1] / target[1] - 1.0).abs() < 1e-7);
    assert!(hue_distance(l[2], target[2]) < 1e-7);

    let mut wrap = point(
        target,
        OklchDelta {
            hue: 10.0,
            chroma_scale: 1.0,
            lightness: 0.0,
        },
    );
    wrap.target.hue = 1.0;
    wrap.range.hue = 5.0;
    assert!(hue_distance(prophoto_to_oklch(color_points(input, &[wrap]))[2], 9.0) < 0.1);

    let gray = color_points([0.3, 0.3, 0.3], std::slice::from_ref(&chroma));
    assert!(gray.iter().all(|value| value.is_finite()));
    let wide = color_points([-0.1, 0.4, 1.2], std::slice::from_ref(&light));
    assert!(wide.iter().all(|value| value.is_finite()));
    let mut non_finite = chroma.clone();
    non_finite.delta.hue = f64::NAN;
    assert_eq!(color_points(input, &[non_finite]), input);

    let a = point(
        target,
        OklchDelta {
            hue: 20.0,
            chroma_scale: 1.2,
            lightness: 0.02,
        },
    );
    let mut b = point(
        target,
        OklchDelta {
            hue: -10.0,
            chroma_scale: 0.8,
            lightness: -0.01,
        },
    );
    b.id = "b".into();
    assert_eq!(
        color_points(input, &[a.clone(), b.clone()]),
        color_points(input, &[b, a])
    );
    assert_eq!(color_points(input, &[]), input);

    let zero = point(
        target,
        OklchDelta {
            hue: 0.0,
            chroma_scale: 1.0,
            lightness: 0.0,
        },
    );
    assert_eq!(color_points(input, std::slice::from_ref(&zero)), input);
    let neutral = DevelopSettings::neutral();
    let mut zero_settings = neutral.clone();
    zero_settings.v = 4;
    zero_settings.color_points = vec![zero];
    assert_eq!(
        bake_color_cube(&neutral, 16).apply(input),
        bake_color_cube(&zero_settings, 16).apply(input)
    );
}

#[cfg_attr(target_arch = "wasm32", wasm_bindgen_test::wasm_bindgen_test)]
#[cfg_attr(not(target_arch = "wasm32"), test)]
fn malformed_too_many_and_version_too_low_fail_closed() {
    let valid = r#"{"v":4,"engine":"niho-10","look":"niho-standard-1","colorPoints":[{"id":"p","target":{"lightness":0.7,"chroma":0.1,"hue":20},"range":{"hue":20,"chroma":0.1,"lightness":0.2},"delta":{"hue":10,"chromaScale":1,"lightness":0}}]}"#;
    assert!(parse_settings(valid).is_ok());
    assert!(parse_settings(&valid.replace("\"v\":4", "\"v\":3")).is_err());
    assert!(parse_settings(&valid.replace("\"v\":4", "\"v\":5")).is_err());
    assert!(
        parse_settings(&valid.replace("\"range\":{\"hue\":20", "\"range\":{\"hue\":0")).is_err()
    );
    assert!(parse_settings(&valid.replace("\"chromaScale\":1", "\"chromaScale\":1e999")).is_err());
    assert!(parse_settings(&valid.replace(
        "\"target\":{\"lightness\":0.7,\"chroma\":0.1,\"hue\":20",
        "\"target\":{\"lightness\":0.7,\"chroma\":0.1,\"hue\":360"
    ))
    .is_err());
    assert!(parse_settings(&valid.replace("\"lightness\":0.7", "\"lightness\":null")).is_err());
    assert!(parse_settings(&valid.replace("\"delta\":{", "\"unknown\":0,\"delta\":{")).is_err());
    let point = r#"{"id":"p","target":{"lightness":0.7,"chroma":0.1,"hue":20},"range":{"hue":20,"chroma":0.1,"lightness":0.2},"delta":{"hue":10,"chromaScale":1,"lightness":0}}"#;
    let too_many = format!(
        "{{\"v\":4,\"engine\":\"niho-10\",\"look\":\"niho-standard-1\",\"colorPoints\":[{}]}}",
        std::iter::repeat_n(point, 9).collect::<Vec<_>>().join(",")
    );
    assert!(parse_settings(&too_many).is_err());
}

#[cfg_attr(target_arch = "wasm32", wasm_bindgen_test::wasm_bindgen_test)]
#[cfg_attr(not(target_arch = "wasm32"), test)]
fn adobe_point_colors_are_reported_and_niho_points_survive_presets_and_amount() {
    let point_colors = [
        r#"<x:xmpmeta xmlns:x="adobe:ns:meta/"><rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#"><rdf:Description xmlns:crs="http://ns.adobe.com/camera-raw-settings/1.0/"><crs:PointColors><rdf:Seq><rdf:li>private</rdf:li></rdf:Seq></crs:PointColors></rdf:Description></rdf:RDF></x:xmpmeta>"#,
        r#"<x:xmpmeta xmlns:x="adobe:ns:meta/"><rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#"><rdf:Description xmlns:crs="http://ns.adobe.com/camera-raw-settings/1.0/" crs:PointColors="private"/></rdf:RDF></x:xmpmeta>"#,
        r#"<x:xmpmeta xmlns:x="adobe:ns:meta/"><rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#"><rdf:Description xmlns:crs="http://ns.adobe.com/camera-raw-settings/1.0/"><crs:Look><rdf:Description crs:PointColors="private"/></crs:Look></rdf:Description></rdf:RDF></x:xmpmeta>"#,
    ];
    for xmp in point_colors {
        let report = preset_settings(xmp, None).unwrap();
        assert!(report
            .unsupported
            .iter()
            .any(|property| property == "PointColors"));
    }

    let preset = r#"<x:xmpmeta xmlns:x="adobe:ns:meta/"><rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#"><rdf:Description xmlns:crs="http://ns.adobe.com/camera-raw-settings/1.0/" crs:Exposure2012="+1"/></rdf:RDF></x:xmpmeta>"#;
    let mut base = DevelopSettings::neutral();
    base.v = 4;
    base.engine = "niho-10".into();
    base.look = "niho-standard-1".into();
    base.color_points = vec![point(
        [0.72, 0.08, 50.0],
        OklchDelta {
            hue: 10.0,
            chroma_scale: 1.1,
            lightness: 0.01,
        },
    )];
    for amount in [0.0, 0.5, 1.0] {
        let applied = apply_preset(preset, &base, amount, None).unwrap();
        assert_eq!(applied.settings.color_points, base.color_points);
        if amount == 0.0 {
            assert_eq!(applied.settings, base);
        }
    }
    let written = settings_to_xmp(&base, &XmpWriteOptions::default());
    assert!(written
        .not_written
        .iter()
        .any(|field| field == "colorPoints"));
    assert!(!written.xmp.contains("PointColors"));
}

#[cfg(not(target_arch = "wasm32"))]
#[test]
#[ignore = "manual 2048px drag/final timing probe; run explicitly on Studio"]
fn color_points_2048_drag_and_final_timing() {
    let width = 2048usize;
    let height = 1365usize;
    let mut rgba = vec![0u8; width * height * 4];
    for (index, pixel) in rgba.chunks_exact_mut(4).enumerate() {
        let x = index % width;
        let y = index / width;
        pixel.copy_from_slice(&[(x % 256) as u8, (y % 256) as u8, ((x + y) % 256) as u8, 255]);
    }
    let png = encode::encode_png(&rgba, width, height).unwrap();
    let mut session = Session::open_raster(&png, 0, Filter::Lanczos3).unwrap();
    let mut settings = DevelopSettings::neutral();
    settings.v = 4;
    settings.engine = "niho-10".into();
    settings.look = "niho-standard-1".into();
    settings.color_points = (0..8)
        .map(|i| {
            point(
                [0.55 + i as f64 * 0.03, 0.08, i as f64 * 45.0],
                OklchDelta {
                    hue: 8.0,
                    chroma_scale: 1.1,
                    lightness: 0.01,
                },
            )
        })
        .collect();
    let drag_start = std::time::Instant::now();
    let drag = session
        .render(&settings, 2048, Quality::Interactive)
        .unwrap();
    let drag_elapsed = drag_start.elapsed();
    let final_start = std::time::Instant::now();
    let final_frame = session.render(&settings, 2048, Quality::Final).unwrap();
    let final_elapsed = final_start.elapsed();
    eprintln!(
        "color_points_2048 drag_ms={} final_ms={}",
        drag_elapsed.as_secs_f64() * 1000.0,
        final_elapsed.as_secs_f64() * 1000.0
    );
    assert_eq!((drag.width, drag.height), (width, height));
    assert_eq!((final_frame.width, final_frame.height), (width, height));
}
