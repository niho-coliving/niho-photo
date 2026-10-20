//! Raster incremental white balance (`niho-2`, Issue #17523).

use niho_develop::decode::{self, LinearImage};
use niho_develop::settings::{WhiteBalanceMode, ENGINE_NIHO_1, ENGINE_NIHO_2};
use niho_develop::{DevelopSettings, Filter, Quality, RenderOptions, Session};

fn input() -> Vec<u8> {
    let rgb = vec![
        0, 0, 0, 16, 128, 239, 64, 143, 207, 128, 128, 128, 255, 255, 255,
    ];
    let image = image::RgbImage::from_raw(5, 1, rgb).unwrap();
    let mut png = Vec::new();
    image
        .write_to(&mut std::io::Cursor::new(&mut png), image::ImageFormat::Png)
        .unwrap();
    png
}

fn settings(engine: &str, temperature: f64, tint: f64) -> DevelopSettings {
    let mut settings = DevelopSettings::neutral();
    settings.engine = engine.into();
    settings.white_balance.mode = WhiteBalanceMode::Relative;
    settings.relative_temperature = temperature;
    settings.relative_tint = tint;
    settings
}

fn render(settings: &DevelopSettings) -> Vec<u8> {
    niho_develop::render(
        &input(),
        &settings.to_json(),
        &RenderOptions {
            max_dimension: 0,
            ..Default::default()
        },
    )
    .unwrap()
    .rgba
}

fn working_copy() -> Vec<u8> {
    decode::encode_working_copy(&LinearImage {
        width: 3,
        height: 1,
        data: vec![0.05, 0.1, 0.2, 0.25, 0.4, 0.15, 0.8, 0.7, 0.6],
    })
}

fn render_working_copy(meta: &str, settings: &DevelopSettings) -> Vec<u8> {
    let mut session = Session::open_working_copy(&working_copy(), meta, Filter::Lanczos3).unwrap();
    session.render(settings, 0, Quality::Final).unwrap().rgba
}

#[test]
fn niho_2_zero_relative_white_is_byte_identical_to_neutral() {
    assert_eq!(
        render(&settings(ENGINE_NIHO_2, 0.0, 0.0)),
        render(&DevelopSettings::neutral())
    );
}

#[test]
fn niho_1_relative_white_keeps_the_legacy_pixel_snapshot() {
    assert_eq!(
        render(&settings(ENGINE_NIHO_1, -30.0, -20.0)),
        vec![
            0, 0, 0, 255, 23, 130, 245, 255, 43, 144, 217, 255, 120, 130, 135, 255, 229, 245, 254,
            255,
        ]
    );
}

#[test]
fn niho_2_combined_white_uses_a_different_calibrated_formula() {
    let legacy = render(&settings(ENGINE_NIHO_1, -30.0, -20.0));
    let calibrated = render(&settings(ENGINE_NIHO_2, -30.0, -20.0));
    assert_ne!(calibrated, legacy);
    assert_eq!(calibrated.len(), 5 * 4);
    assert!(calibrated.chunks_exact(4).all(|pixel| pixel[3] == 255));
}

#[test]
fn niho_2_uses_the_lut_for_raster_working_copies_but_not_raw() {
    let legacy = settings(ENGINE_NIHO_1, 30.0, 20.0);
    let calibrated = settings(ENGINE_NIHO_2, 30.0, 20.0);
    let raster_meta = r#"{"kind":"raster","iccSha256":"sRGB"}"#;
    assert_ne!(
        render_working_copy(raster_meta, &legacy),
        render_working_copy(raster_meta, &calibrated)
    );

    let raw_meta = r#"{"kind":"raw","baselineEV":0,"asShotWhite":{"x":0.33,"y":0.34},"dcpSha256":"test","lookTableIncluded":true}"#;
    assert_eq!(
        render_working_copy(raw_meta, &legacy),
        render_working_copy(raw_meta, &calibrated)
    );
}
