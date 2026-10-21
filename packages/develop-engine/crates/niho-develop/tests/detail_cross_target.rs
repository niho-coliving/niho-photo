//! Synthetic v6 detail frame shared by native and wasm CI. No private photo
//! is needed. One-shot/session entry points must agree within one RGBA LSB;
//! the neutral v6 route must remain byte-identical to the old fused route.

use niho_develop::decode::encode_signed_working_copy;
use niho_develop::settings::{
    ColorPoint, DetailSettings, DevelopSettings, OklchDelta, OklchRange, OklchTarget,
    SharpeningSettings,
};
use niho_develop::{encode, render, Filter, LinearImage, Quality, RenderOptions, Session};

fn photo() -> Vec<u8> {
    let (width, height) = (96usize, 64usize);
    let mut rgba = Vec::with_capacity(width * height * 4);
    let mut state = 0x32d3_91abu32;
    for y in 0..height {
        for x in 0..width {
            state ^= state << 13;
            state ^= state >> 17;
            state ^= state << 5;
            let noise = (state % 13) as i32 - 6;
            let edge = if x >= width / 2 { 75 } else { 0 };
            let r = (45 + edge + x as i32 + noise).clamp(0, 255) as u8;
            let g = (35 + edge + y as i32 + noise).clamp(0, 255) as u8;
            let b = (30 + edge / 2 + noise).clamp(0, 255) as u8;
            rgba.extend_from_slice(&[r, g, b, 255]);
        }
    }
    encode::encode_png(&rgba, width, height).unwrap()
}

fn settings() -> DevelopSettings {
    let mut settings = DevelopSettings::neutral();
    settings.v = 6;
    settings.engine = "niho-10".into();
    settings.look = "niho-standard-1".into();
    settings.contrast = 30.0;
    settings.color_grading.shadow.hue = 215.0;
    settings.color_grading.shadow.saturation = 35.0;
    settings.detail = Some(DetailSettings {
        sharpening: SharpeningSettings {
            amount: 85.0,
            radius: 1.4,
            detail: 70.0,
            masking: 45.0,
        },
        luminance_noise_reduction: 55.0,
        color_noise_reduction: Some(35.0),
    });
    settings.color_points.push(ColorPoint {
        id: "synthetic-warm".into(),
        target: OklchTarget {
            lightness: 0.55,
            chroma: 0.08,
            hue: 45.0,
        },
        range: OklchRange {
            hue: 50.0,
            chroma: 0.2,
            lightness: 0.3,
        },
        delta: OklchDelta {
            hue: 12.0,
            chroma_scale: 1.2,
            lightness: 0.03,
        },
    });
    settings
}

fn max_lsb(a: &[u8], b: &[u8]) -> u8 {
    a.iter()
        .zip(b)
        .map(|(a, b)| a.abs_diff(*b))
        .max()
        .unwrap_or(0)
}

fn changed_bytes(a: &[u8], b: &[u8]) -> (usize, u64) {
    a.iter()
        .zip(b)
        .fold((0usize, 0u64), |(count, total), (a, b)| {
            let delta = a.abs_diff(*b);
            (count + usize::from(delta != 0), total + u64::from(delta))
        })
}

fn signed_raw() -> (Vec<u8>, String) {
    let (width, height) = (256usize, 160usize);
    let mut state = 0x90ab_32d3u32;
    let mut data = Vec::with_capacity(width * height * 3);
    for y in 0..height {
        for x in 0..width {
            state ^= state << 13;
            state ^= state >> 17;
            state ^= state << 5;
            let noise = (state as f32 / u32::MAX as f32 - 0.5) * 0.055;
            let step = if x >= width / 2 { 0.28 } else { 0.0 };
            data.extend_from_slice(&[
                -0.025 + x as f32 / 420.0 + step + noise,
                0.04 + y as f32 / 360.0 + step * 0.8 - noise * 0.35,
                0.12 + (x + y) as f32 / 900.0 + step * 0.55 + noise * 0.7,
            ]);
        }
    }
    let (png, encoding) = encode_signed_working_copy(&LinearImage {
        width,
        height,
        data,
    })
    .unwrap();
    let metadata = format!(
        r#"{{"kind":"raw","baselineEV":-0.2,"asShotWhite":{{"x":0.3127,"y":0.329,"temperature":5500,"tint":0}},"asShotWhiteAdobe":null,"whiteBalanceTable":null,"dcpSha256":"apple-ciraw8/linear-prophoto-d50/cal-panasonic-dc-s5-apple-v4","lookTableIncluded":false,"encoding":{{"kind":"signed-gamma18-v1","ceiling":{}}}}}"#,
        encoding.ceiling()
    );
    (png, metadata)
}

fn raw_settings(color_noise_reduction: Option<f64>) -> DevelopSettings {
    let mut settings = DevelopSettings::neutral();
    settings.v = 6;
    settings.engine = "niho-11".into();
    settings.look = "niho-standard-5".into();
    settings.color_noise_reduction = 37.0;
    settings.detail = Some(DetailSettings {
        sharpening: SharpeningSettings {
            amount: 90.0,
            radius: 3.0,
            detail: 60.0,
            masking: 55.0,
        },
        luminance_noise_reduction: 50.0,
        color_noise_reduction,
    });
    settings
}

fn with_crop(settings: &DevelopSettings) -> DevelopSettings {
    let mut value = settings.to_value();
    value["geometry"] = serde_json::json!({
        "crop": {"left": 0.25, "top": 0.125, "right": 0.75, "bottom": 0.875}
    });
    DevelopSettings::from_json(&value.to_string()).unwrap()
}

fn rgba_rect(
    rgba: &[u8],
    width: usize,
    x: usize,
    y: usize,
    crop_width: usize,
    crop_height: usize,
) -> Vec<u8> {
    (y..y + crop_height)
        .flat_map(|row| rgba[(row * width + x) * 4..(row * width + x + crop_width) * 4].to_vec())
        .collect()
}

#[cfg_attr(target_arch = "wasm32", wasm_bindgen_test::wasm_bindgen_test)]
#[cfg_attr(not(target_arch = "wasm32"), test)]
fn native_and_wasm_common_detail_frame_uses_the_same_entrypoint_contract() {
    let input = photo();
    let settings = settings();
    let one_shot = render(
        &input,
        &settings.to_json(),
        &RenderOptions {
            max_dimension: 80,
            ..Default::default()
        },
    )
    .unwrap();
    let mut session = Session::open_raster(&input, 0, Filter::Lanczos3).unwrap();
    let repeated = session.render(&settings, 80, Quality::Final).unwrap();
    assert_eq!(
        (one_shot.width, one_shot.height),
        (repeated.width, repeated.height)
    );
    assert!(max_lsb(&one_shot.rgba, &repeated.rgba) <= 1);
    assert!(one_shot.rgba.chunks_exact(4).all(|pixel| pixel[3] == 255));
}

#[cfg_attr(target_arch = "wasm32", wasm_bindgen_test::wasm_bindgen_test)]
#[cfg_attr(not(target_arch = "wasm32"), test)]
fn neutral_detail_is_old_pixel_exact_and_raster_legacy_cnr_stays_ignored() {
    let input = photo();
    let old = DevelopSettings::neutral();
    let old_frame = render(&input, &old.to_json(), &RenderOptions::default()).unwrap();

    let mut neutral = old.clone();
    neutral.v = 6;
    neutral.detail = Some(DetailSettings::default());
    let neutral_frame = render(&input, &neutral.to_json(), &RenderOptions::default()).unwrap();
    assert_eq!(old_frame.rgba, neutral_frame.rgba);

    let mut ignored = old.clone();
    ignored.color_noise_reduction = 100.0;
    let ignored_frame = render(&input, &ignored.to_json(), &RenderOptions::default()).unwrap();
    assert_eq!(old_frame.rgba, ignored_frame.rgba);

    let mut explicit = neutral;
    explicit.detail.as_mut().unwrap().color_noise_reduction = Some(100.0);
    let explicit_frame = render(&input, &explicit.to_json(), &RenderOptions::default()).unwrap();
    assert_ne!(old_frame.rgba, explicit_frame.rgba);
}

#[cfg_attr(target_arch = "wasm32", wasm_bindgen_test::wasm_bindgen_test)]
#[cfg_attr(not(target_arch = "wasm32"), test)]
fn interactive_omission_is_replaced_by_exact_final_and_sample_is_finite() {
    let input = photo();
    let settings = settings();
    let mut session = Session::open_raster(&input, 0, Filter::Lanczos3).unwrap();
    let drag = session.render(&settings, 80, Quality::Interactive).unwrap();
    let final_after_drag = session.render(&settings, 80, Quality::Final).unwrap();
    let fresh_final = Session::open_raster(&input, 0, Filter::Lanczos3)
        .unwrap()
        .render(&settings, 80, Quality::Final)
        .unwrap();
    assert_eq!(
        (drag.width, drag.height),
        (final_after_drag.width, final_after_drag.height)
    );
    assert!(max_lsb(&final_after_drag.rgba, &fresh_final.rgba) <= 1);
    let sample = session.sample_color(&settings, 80, 0.49, 0.5).unwrap();
    assert!(sample.iter().all(|value| value.is_finite()));
}

#[cfg_attr(target_arch = "wasm32", wasm_bindgen_test::wasm_bindgen_test)]
#[cfg_attr(not(target_arch = "wasm32"), test)]
fn final_sharpening_materially_changes_a_512px_neutral_float_tail() {
    let (width, height) = (512usize, 192usize);
    let mut rgba = Vec::with_capacity(width * height * 4);
    let mut state = 0xa17c_9032u32;
    for _y in 0..height {
        for x in 0..width {
            state ^= state << 13;
            state ^= state >> 17;
            state ^= state << 5;
            let noise = (state % 9) as i32 - 4;
            let step = if x >= width / 2 { 70 } else { 0 };
            let value = (70 + step + noise).clamp(0, 255) as u8;
            rgba.extend_from_slice(&[value, value, value, 255]);
        }
    }
    let input = encode::encode_png(&rgba, width, height).unwrap();
    let mut neutral = DevelopSettings::neutral();
    neutral.v = 6;
    neutral.engine = "niho-10".into();
    neutral.look = "niho-standard-1".into();
    neutral.detail = Some(DetailSettings::default());
    let baseline = render(
        &input,
        &neutral.to_json(),
        &RenderOptions {
            max_dimension: 0,
            quality: Quality::Final,
            ..Default::default()
        },
    )
    .unwrap();
    let mut sharp = neutral;
    sharp.detail.as_mut().unwrap().sharpening = SharpeningSettings {
        amount: 120.0,
        radius: 1.4,
        detail: 40.0,
        masking: 0.0,
    };
    let sharpened = render(
        &input,
        &sharp.to_json(),
        &RenderOptions {
            max_dimension: 0,
            quality: Quality::Final,
            ..Default::default()
        },
    )
    .unwrap();
    let (count, total) = changed_bytes(&baseline.rgba, &sharpened.rgba);
    assert!(count > 512 && total > 1024, "sharp did not materially act");
}

#[cfg_attr(target_arch = "wasm32", wasm_bindgen_test::wasm_bindgen_test)]
#[cfg_attr(not(target_arch = "wasm32"), test)]
fn signed_raw_detail_overrides_are_distinct_and_warm_cache_matches_fresh() {
    let (png, metadata) = signed_raw();
    let open = || Session::open_working_copy(&png, &metadata, Filter::Lanczos3).unwrap();
    let settings = [
        raw_settings(Some(0.0)),
        raw_settings(Some(50.0)),
        raw_settings(Some(100.0)),
    ];
    let mut warm = open();
    assert_eq!(warm.source_size(), (256, 160));
    let mut frames = Vec::new();
    for setting in &settings {
        let actual = warm.render(setting, 0, Quality::Final).unwrap();
        let fresh = open().render(setting, 0, Quality::Final).unwrap();
        assert_eq!((actual.width, actual.height), (256, 160));
        assert_eq!(actual.rgba, fresh.rgba);
        assert_eq!(warm.source_size(), (256, 160));
        frames.push(actual.rgba);
    }
    for pair in frames.windows(2) {
        let (count, total) = changed_bytes(&pair[0], &pair[1]);
        assert!(
            count > 256 && total > 512,
            "CNR override did not materially act: changed={count}, total={total}"
        );
    }
    // Returning to an earlier amount must not retain the last prepared
    // source or apply either NR stage twice.
    let returned = warm.render(&settings[0], 0, Quality::Final).unwrap();
    assert_eq!(returned.rgba, frames[0]);
}

#[cfg_attr(target_arch = "wasm32", wasm_bindgen_test::wasm_bindgen_test)]
#[cfg_attr(not(target_arch = "wasm32"), test)]
fn signed_raw_absent_cnr_preserves_old_top_level_once() {
    let (png, metadata) = signed_raw();
    let open = || Session::open_working_copy(&png, &metadata, Filter::Lanczos3).unwrap();
    let mut old = raw_settings(None);
    old.detail = None;
    old.v = 4;
    let old_frame = open().render(&old, 0, Quality::Final).unwrap();

    let mut inherited = raw_settings(None);
    inherited.detail.as_mut().unwrap().sharpening.amount = 0.0;
    inherited.detail.as_mut().unwrap().luminance_noise_reduction = 0.0;
    let inherited_frame = open().render(&inherited, 0, Quality::Final).unwrap();
    assert_eq!(old_frame.rgba, inherited_frame.rgba);

    let mut explicit = inherited;
    explicit.detail.as_mut().unwrap().color_noise_reduction = Some(37.0);
    let explicit_frame = open().render(&explicit, 0, Quality::Final).unwrap();
    assert_eq!(old_frame.rgba, explicit_frame.rgba);
}

#[cfg_attr(target_arch = "wasm32", wasm_bindgen_test::wasm_bindgen_test)]
#[cfg_attr(not(target_arch = "wasm32"), test)]
fn signed_raw_sharpened_crop_is_the_same_scale_full_frame_cut() {
    let (png, metadata) = signed_raw();
    let open = || Session::open_working_copy(&png, &metadata, Filter::Lanczos3).unwrap();
    let mut settings = raw_settings(Some(50.0));
    settings.color_points.push(ColorPoint {
        id: "crop-halo-point".into(),
        target: OklchTarget {
            lightness: 0.55,
            chroma: 0.08,
            hue: 45.0,
        },
        range: OklchRange {
            hue: 180.0,
            chroma: 1.0,
            lightness: 1.0,
        },
        delta: OklchDelta {
            hue: 12.0,
            chroma_scale: 1.15,
            lightness: 0.025,
        },
    });
    let whole = open().render(&settings, 0, Quality::Final).unwrap();
    let cropped = open()
        .render(&with_crop(&settings), 0, Quality::Final)
        .unwrap();
    assert_eq!((cropped.width, cropped.height), (128, 120));
    let expected = rgba_rect(&whole.rgba, whole.width, 64, 20, 128, 120);
    assert_eq!(cropped.rgba, expected);

    // The crop is one pixel from the real source boundary: its remaining
    // halo is legitimately smaller than the Gaussian reach, not an error.
    let mut near_edge = settings.to_value();
    near_edge["geometry"] = serde_json::json!({"crop": {
        "left": 1.0 / 256.0, "top": 1.0 / 160.0,
        "right": 255.0 / 256.0, "bottom": 159.0 / 160.0
    }});
    let near_edge = DevelopSettings::from_json(&near_edge.to_string()).unwrap();
    let near_frame = open().render(&near_edge, 0, Quality::Final).unwrap();
    assert_eq!((near_frame.width, near_frame.height), (254, 158));
    assert_eq!(
        near_frame.rgba,
        rgba_rect(&whole.rgba, whole.width, 1, 1, 254, 158)
    );
}

#[cfg_attr(target_arch = "wasm32", wasm_bindgen_test::wasm_bindgen_test)]
#[cfg_attr(not(target_arch = "wasm32"), test)]
fn raw_nr_and_strong_grading_picker_is_pre_point_with_or_without_a_point() {
    let (png, metadata) = signed_raw();
    let mut without = raw_settings(Some(80.0));
    without.color_grading.shadow.hue = 220.0;
    without.color_grading.shadow.saturation = 90.0;
    without.color_grading.highlight.hue = 35.0;
    without.color_grading.highlight.saturation = 85.0;
    let mut with = without.clone();
    with.color_points.push(ColorPoint {
        id: "first-wide-point".into(),
        target: OklchTarget {
            lightness: 0.55,
            chroma: 0.09,
            hue: 45.0,
        },
        range: OklchRange {
            hue: 180.0,
            chroma: 1.0,
            lightness: 1.0,
        },
        delta: OklchDelta {
            hue: 80.0,
            chroma_scale: 1.8,
            lightness: 0.2,
        },
    });
    let mut session = Session::open_working_copy(&png, &metadata, Filter::Lanczos3).unwrap();
    let before = session.sample_color(&without, 0, 0.49, 0.5).unwrap();
    let through_first_point = session.sample_color(&with, 0, 0.49, 0.5).unwrap();
    for (actual, expected) in through_first_point.iter().zip(before) {
        assert!((actual - expected).abs() <= 2e-6, "{actual} vs {expected}");
    }
}

#[cfg_attr(target_arch = "wasm32", wasm_bindgen_test::wasm_bindgen_test)]
#[cfg_attr(not(target_arch = "wasm32"), test)]
fn niho6_noise_source_and_shared_analysis_change_together() {
    let input = photo();
    let open = || Session::open_raster(&input, 0, Filter::Lanczos3).unwrap();
    let mut warm = open();
    let mut settings = settings();
    settings.highlights = -85.0;
    settings.detail.as_mut().unwrap().sharpening.amount = 0.0;
    let mut frames = Vec::new();
    for amount in [0.0, 45.0, 90.0, 0.0] {
        settings.detail.as_mut().unwrap().luminance_noise_reduction = amount;
        let actual = warm.render(&settings, 80, Quality::Final).unwrap();
        let expected = open().render(&settings, 80, Quality::Final).unwrap();
        assert_eq!(actual.rgba, expected.rgba, "LNR {amount}");
        let sampled = warm.sample_color(&settings, 80, 0.4, 0.4).unwrap();
        assert!(sampled.iter().all(|value| value.is_finite()));
        frames.push(actual.rgba);
    }
    assert_eq!(frames[0], frames[3]);
    assert!(changed_bytes(&frames[0], &frames[1]).0 > 32);
    assert!(changed_bytes(&frames[1], &frames[2]).0 > 32);
}
