//! Local masks render the same bytes natively and in browser wasm
//! (`docs/local-adjustments.md` "面の式": the planes use IEEE `+ - * / sqrt`
//! in `f32` and one `libm` sine / cosine per mask; the blend is integer).
//! This test runs on both targets and pins the RGBA hashes of a synthetic
//! photo with a linear and a radial mask under a turned, straightened crop,
//! as a released frame (the one-shot render) and a drag frame (a Session),
//! and of the overlay plane.

use niho_develop::{encode, parse_settings, render, Filter, Quality, RenderOptions, Session};

fn photo() -> Vec<u8> {
    let (w, h) = (160usize, 120usize);
    let mut rgba = Vec::with_capacity(w * h * 4);
    let mut state = 0x6d2b_79f5u32;
    for y in 0..h {
        for x in 0..w {
            state ^= state << 13;
            state ^= state >> 17;
            state ^= state << 5;
            let noise = (state % 7) as i32 - 3;
            // A sky over a dark field with a saturated object.
            let sky = y < 45;
            let object = (x as i32 - 100).pow(2) + (y as i32 - 80).pow(2) < 300;
            let (r, g, b) = if sky {
                (150 + x as i32 / 4, 190 + y as i32, 245)
            } else if object {
                (180, 50, 40)
            } else {
                (30 + x as i32 / 6, 40 + y as i32 / 8, 20)
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

const SETTINGS: &str = r#"{"v":5,"engine":"niho-10","look":"niho-standard-1","base":null,"shadows":25,"vibrance":10,
"geometry":{"rotate":90,"angle":3.5,"crop":{"left":0.05,"top":0.08,"right":0.93,"bottom":0.95}},
"masks":[
 {"id":"sky","kind":"linear","zero":{"x":0.5,"y":0.45},"full":{"x":0.52,"y":0.1},"adjust":{"exposure":-0.9,"highlights":-40,"saturation":15}},
 {"id":"object","kind":"radial","invert":true,"center":{"x":0.62,"y":0.66},"radius":{"x":0.2,"y":0.25},"angle":-25,"feather":45,"adjust":{"clarity":30,"relativeTemperature":-20,"hsl":["red",{"saturation":-30}]}}
]}"#;

#[cfg_attr(target_arch = "wasm32", wasm_bindgen_test::wasm_bindgen_test)]
#[cfg_attr(not(target_arch = "wasm32"), test)]
fn native_and_wasm_render_the_same_masked_bytes() {
    let input = photo();
    let settings = parse_settings(SETTINGS).unwrap();
    let released = render(
        &input,
        SETTINGS,
        &RenderOptions {
            max_dimension: 0,
            ..Default::default()
        },
    )
    .unwrap();
    let mut session = Session::open_raster(&input, 0, Filter::Lanczos3).unwrap();
    let drag = session.render(&settings, 96, Quality::Interactive).unwrap();
    let (w, h, plane) = session.mask_plane(&settings, "object", 96).unwrap();
    assert_eq!((released.width, released.height), (110, 128));
    assert_eq!((drag.width, drag.height), (w, h));
    assert_eq!(
        [
            fnv1a64(&released.rgba),
            fnv1a64(&drag.rgba),
            fnv1a64(&plane)
        ],
        [
            14_224_716_338_317_839_401,
            12_440_713_395_875_544_195,
            2_411_968_078_102_423_582
        ]
    );
}
