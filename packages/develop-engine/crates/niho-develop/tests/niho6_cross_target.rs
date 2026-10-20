//! `niho-6` renders the same bytes natively and in browser wasm (spec
//! "段 2" 決まりごと 2, #18397 DoD): the analysis, the response networks
//! (`libm`, fixed accumulation order) and the gain. This test runs on both
//! targets and pins the RGBA hash of one synthetic photo.

use niho_develop::{encode, render, RenderOptions};

fn photo() -> Vec<u8> {
    let (w, h) = (160usize, 120usize);
    let mut rgba = Vec::with_capacity(w * h * 4);
    let mut state = 0x2f6b_4e1du32;
    for y in 0..h {
        for x in 0..w {
            state ^= state << 13;
            state ^= state >> 17;
            state ^= state << 5;
            let noise = (state % 7) as i32 - 3;
            // A dark room with a bright window and a saturated object.
            let window = x > 100 && y < 50;
            let object = (x as i32 - 40).pow(2) + (y as i32 - 80).pow(2) < 400;
            let (r, g, b) = if window {
                (235, 240, 250)
            } else if object {
                (170, 40, 30)
            } else {
                (20 + x as i32 / 8, 18 + y as i32 / 10, 16)
            };
            let c = |v: i32| (v + noise).clamp(0, 255) as u8;
            rgba.extend_from_slice(&[c(r), c(g), c(b), 255]);
        }
    }
    encode::encode_png(&rgba, w, h).unwrap()
}

fn fnv1a64(bytes: &[u8]) -> u64 {
    bytes.iter().fold(0xcbf2_9ce4_8422_2325u64, |hash, byte| {
        (hash ^ u64::from(*byte)).wrapping_mul(0x0100_0000_01b3)
    })
}

#[cfg_attr(target_arch = "wasm32", wasm_bindgen_test::wasm_bindgen_test)]
#[cfg_attr(not(target_arch = "wasm32"), test)]
fn native_and_wasm_render_the_same_niho_6_bytes() {
    // The H/S response, the RAW Vibrance and HSL luminance, and the RAW
    // positive Blacks (#18397 R14 / R18).
    let settings = r#"{"v":1,"engine":"niho-6","look":"niho-standard-1","exposure":0.2,"highlights":-75,"shadows":55,"blacks":40,"vibrance":10,"hsl":{"orange":{"hue":0,"saturation":-10,"luminance":20}}}"#;
    let frame = render(
        &photo(),
        settings,
        &RenderOptions {
            max_dimension: 0,
            ..Default::default()
        },
    )
    .unwrap();
    assert_eq!((frame.width, frame.height), (160, 120));
    assert_eq!(fnv1a64(&frame.rgba), 10_959_845_526_522_411_298);
}

#[cfg_attr(target_arch = "wasm32", wasm_bindgen_test::wasm_bindgen_test)]
#[cfg_attr(not(target_arch = "wasm32"), test)]
fn native_and_wasm_render_the_same_niho_8_bytes() {
    let input = photo();
    let settings = niho_develop::parse_settings(r#"{"v":1,"engine":"niho-8","look":"niho-standard-1","exposure":0.2,"highlights":-75,"shadows":55,"blacks":40,"vibrance":10,"hsl":{"orange":{"hue":0,"saturation":-10,"luminance":20}}}"#).unwrap();
    let final_frame = render(
        &input,
        &settings.to_json(),
        &RenderOptions {
            max_dimension: 0,
            ..Default::default()
        },
    )
    .unwrap();
    let mut session =
        niho_develop::Session::open_raster(&input, 0, niho_develop::Filter::Lanczos3).unwrap();
    let drag = session
        .render(&settings, 0, niho_develop::Quality::Interactive)
        .unwrap();
    println!(
        "NIHO8_FNV_FINAL={} NIHO8_FNV_INTERACTIVE={}",
        fnv1a64(&final_frame.rgba),
        fnv1a64(&drag.rgba)
    );
    assert_eq!((final_frame.width, final_frame.height), (160, 120));
    assert_eq!(
        session
            .render(&settings, 0, niho_develop::Quality::Final)
            .unwrap()
            .rgba,
        final_frame.rgba
    );
}
