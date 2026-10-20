//! `niho-6` on a non-RAW working copy (linear ProPhoto): the pipeline's public
//! working-copy renders prepare the response from the working copy itself, so
//! they draw the same image as a Session (which keeps the analysis).

use niho_develop::decode::{self, LinearImage, WorkingCopyMeta};
use niho_develop::pipeline::{
    render_working_copy, render_working_copy_marking_out_of_srgb, WorkingCopy,
};
use niho_develop::settings::ENGINE_NIHO_6;
use niho_develop::{DevelopSettings, Filter, Quality, Session};

const RASTER_META: &str = r#"{"kind":"raster","iccSha256":"sRGB"}"#;

fn encoded_working_copy() -> Vec<u8> {
    let (w, h) = (96usize, 64usize);
    let mut data = Vec::with_capacity(w * h * 3);
    for y in 0..h {
        for x in 0..w {
            let v = 0.002 + 0.95 * ((x + y * w) as f32 / (w * h) as f32).powi(2);
            data.extend_from_slice(&[v, v * 0.8 + 0.01, (1.0 - v) * 0.6 + 0.02]);
        }
    }
    decode::encode_working_copy(&LinearImage {
        width: w,
        height: h,
        data,
    })
}

fn niho6_settings() -> DevelopSettings {
    let mut settings = DevelopSettings::neutral();
    settings.engine = ENGINE_NIHO_6.into();
    settings.highlights = -60.0;
    settings.shadows = 40.0;
    settings
}

#[test]
fn pipeline_working_copy_renders_apply_the_niho6_response_as_a_session_does() {
    let png = encoded_working_copy();
    let image = decode::decode_working_copy(&png, 0, Filter::Lanczos3).unwrap();
    let meta = WorkingCopyMeta::Raster {
        icc_sha256: "sRGB".into(),
    };
    let settings = niho6_settings();

    let mut session = Session::open_working_copy(&png, RASTER_META, Filter::Lanczos3).unwrap();
    let from_session = session.render(&settings, 0, Quality::Final).unwrap();

    let wc = WorkingCopy {
        image: &image,
        meta: &meta,
    };
    let (rendered, _) = render_working_copy(&wc, &settings, Quality::Final, None);
    assert!(!rendered
        .approximations
        .contains(&"niho6ResponseUnavailable"));
    assert_eq!(rendered.rgba, from_session.rgba);

    // The response is applied (not the legacy half alone): without it the image differs.
    let mut without = settings.clone();
    without.highlights = 0.0;
    without.shadows = 0.0;
    let (plain, _) = render_working_copy(&wc, &without, Quality::Final, None);
    assert_ne!(plain.rgba, rendered.rgba);

    // The golden-test variant prepares it too.
    let marked = render_working_copy_marking_out_of_srgb(&wc, &settings);
    assert!(!marked.approximations.contains(&"niho6ResponseUnavailable"));
    assert_eq!(marked.width, rendered.width);
}
