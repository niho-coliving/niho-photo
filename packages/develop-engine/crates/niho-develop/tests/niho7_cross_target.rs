//! Signed RAW highlight math must produce identical native/browser bytes.
use niho_develop::{
    decode::encode_signed_working_copy, DevelopSettings, Filter, LinearImage, Quality, Session,
};

fn source() -> LinearImage {
    let (width, height) = (96, 64);
    let mut data = Vec::with_capacity(width * height * 3);
    for y in 0..height {
        for x in 0..width {
            let pixel = if (36..76).contains(&x) && (8..40).contains(&y) {
                if x < 56 {
                    [1.25, 1.25, 1.25]
                } else {
                    [2.5, 2.5, 2.5]
                }
            } else {
                [-0.02 + x as f32 / 400.0, 0.03 + y as f32 / 500.0, 0.12]
            };
            data.extend_from_slice(&pixel);
        }
    }
    LinearImage {
        width,
        height,
        data,
    }
}

fn fnv1a64(bytes: &[u8]) -> u64 {
    bytes.iter().fold(0xcbf2_9ce4_8422_2325u64, |hash, byte| {
        (hash ^ u64::from(*byte)).wrapping_mul(0x0100_0000_01b3)
    })
}

#[cfg_attr(target_arch = "wasm32", wasm_bindgen_test::wasm_bindgen_test)]
#[cfg_attr(not(target_arch = "wasm32"), test)]
fn native_and_wasm_render_the_same_niho7_signed_highlights() {
    let (png, encoding) = encode_signed_working_copy(&source()).unwrap();
    let mut hashes = Vec::new();
    for calibration in [
        "cal-panasonic-dc-s5-apple-v4",
        "cal-sony-zv-e10m2-apple-v3",
        "cal-sony-ilme-fx30-apple-v2",
    ] {
        let meta = format!(
            r#"{{"kind":"raw","baselineEV":-0.25,"asShotWhite":{{"x":0.3127,"y":0.329,"temperature":5500,"tint":0}},"asShotWhiteAdobe":null,"whiteBalanceTable":null,"dcpSha256":"apple-ciraw8/linear-prophoto-d50/{calibration}","lookTableIncluded":false,"encoding":{{"kind":"signed-gamma18-v1","ceiling":{}}}}}"#,
            encoding.ceiling()
        );
        let mut session = Session::open_working_copy(&png, &meta, Filter::Lanczos3).unwrap();
        let mut settings = DevelopSettings::neutral();
        settings.engine = "niho-7".into();
        settings.look = "niho-standard-5".into();
        settings.exposure = -0.2;
        for highlights in [-60.0, -100.0] {
            settings.highlights = highlights;
            let frame = session.render(&settings, 0, Quality::Final).unwrap();
            assert_eq!((frame.width, frame.height), (96, 64));
            hashes.push(fnv1a64(&frame.rgba));
        }
    }
    assert_eq!(
        hashes,
        vec![
            11_166_030_038_259_872_439,
            11_935_309_187_505_674_098,
            92_659_659_674_820_852,
            5_245_709_920_478_308_088,
            1_005_213_338_478_388_658,
            8_547_202_297_625_291_642
        ]
    );
}
