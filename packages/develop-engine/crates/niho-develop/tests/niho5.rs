use niho_develop::decode::encode_signed_working_copy;
use niho_develop::settings::{
    ENGINE_NIHO_4, ENGINE_NIHO_5, LOOK_NIHO_STANDARD_3, LOOK_NIHO_STANDARD_4,
};
use niho_develop::{parse_settings, DevelopSettings, Filter, LinearImage, Quality, Session};

const PANASONIC: &str = "apple-ciraw8/linear-prophoto-d50/cal-panasonic-dc-s5-apple-v4";

fn settings(engine: &str, look: &str, highlights: f64) -> DevelopSettings {
    let mut value = DevelopSettings::neutral();
    value.engine = engine.into();
    value.look = look.into();
    value.highlights = highlights;
    value.exposure = -2.0;
    value
}

#[test]
fn formula_and_look_versions_are_a_locked_pair() {
    let value = settings(ENGINE_NIHO_5, LOOK_NIHO_STANDARD_4, -60.0);
    assert_eq!(parse_settings(&value.to_json()).unwrap(), value);
    for (engine, look) in [
        (ENGINE_NIHO_5, LOOK_NIHO_STANDARD_3),
        (ENGINE_NIHO_4, LOOK_NIHO_STANDARD_4),
    ] {
        assert!(parse_settings(&settings(engine, look, -60.0).to_json()).is_err());
    }
}

#[test]
fn neutral_is_identical_and_switching_back_keeps_frozen_niho4_pixels() {
    let (width, height) = (80, 60);
    let mut data = Vec::with_capacity(width * height * 3);
    for y in 0..height {
        for x in 0..width {
            if (18..62).contains(&x) && (12..48).contains(&y) {
                data.extend_from_slice(&[2.06, 2.06, 2.06]);
            } else {
                data.extend_from_slice(&[0.65, 0.79, 1.12]);
            }
        }
    }
    let (png, encoding) = encode_signed_working_copy(&LinearImage {
        width,
        height,
        data,
    })
    .unwrap();
    let metadata = format!(
        r#"{{"kind":"raw","baselineEV":0,"asShotWhite":{{"x":0.3127,"y":0.329,"temperature":5500,"tint":0}},"asShotWhiteAdobe":null,"whiteBalanceTable":null,"dcpSha256":"{PANASONIC}","lookTableIncluded":false,"encoding":{{"kind":"signed-gamma18-v1","ceiling":{}}}}}"#,
        encoding.ceiling()
    );
    let mut session = Session::open_working_copy(&png, &metadata, Filter::Lanczos3).unwrap();
    let old_neutral = settings(ENGINE_NIHO_4, LOOK_NIHO_STANDARD_3, 0.0);
    let new_neutral = settings(ENGINE_NIHO_5, LOOK_NIHO_STANDARD_4, 0.0);
    assert_eq!(
        session
            .render(&old_neutral, 0, Quality::Final)
            .unwrap()
            .rgba,
        session
            .render(&new_neutral, 0, Quality::Final)
            .unwrap()
            .rgba
    );

    let old = settings(ENGINE_NIHO_4, LOOK_NIHO_STANDARD_3, -100.0);
    let new = settings(ENGINE_NIHO_5, LOOK_NIHO_STANDARD_4, -100.0);
    let old_pixels = session.render(&old, 0, Quality::Final).unwrap().rgba;
    let new_pixels = session.render(&new, 0, Quality::Final).unwrap().rgba;
    assert_ne!(new_pixels, old_pixels);
    assert_eq!(
        session.render(&old, 0, Quality::Final).unwrap().rgba,
        old_pixels
    );
}
