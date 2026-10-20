//! Synthetic v5 detail frame shared by native and wasm CI. No private photo
//! is needed. One-shot/session entry points must agree within one RGBA LSB;
//! the neutral v5 route must remain byte-identical to the old fused route.

use niho_develop::settings::{
    ColorPoint, DetailSettings, DevelopSettings, OklchDelta, OklchRange, OklchTarget,
    SharpeningSettings,
};
use niho_develop::{encode, render, Filter, Quality, RenderOptions, Session};

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
    settings.v = 5;
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
    neutral.v = 5;
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
    assert_ne!(drag.rgba, final_after_drag.rgba);
    assert!(max_lsb(&final_after_drag.rgba, &fresh_final.rgba) <= 1);
    let sample = session.sample_color(&settings, 80, 0.49, 0.5).unwrap();
    assert!(sample.iter().all(|value| value.is_finite()));
}
