use niho_camera_profile::dcp::{sha256_hex, DcpSpec};
use niho_develop::camera_linear::{neutral_for_absolute_white, to_linear_prophoto};
use niho_develop::pipeline::{render_working_copy, WorkingCopy};
use niho_develop::settings::{WhiteBalance, WhiteBalanceMode};
use niho_develop::{
    render_camera_linear, AsShotWhite, CameraLinearError, CameraLinearWorkMeta, DevelopSettings,
    Error, LinearImage, Quality, RenderOptions, WorkingCopyMeta,
};

const DCP: &[u8] =
    include_bytes!("../../niho-base-raw/profiles/panasonic-dc-s5/niho-dc-s5-independent-v1.dcp");
const BASE_VERSION: &str = "camera-linear-test-v1";

fn camera() -> LinearImage {
    let (width, height) = (8, 6);
    let mut data = Vec::with_capacity(width * height * 3);
    for y in 0..height {
        for x in 0..width {
            data.extend_from_slice(&[
                0.08 + x as f32 * 0.035,
                0.12 + y as f32 * 0.045,
                0.10 + (x + y) as f32 * 0.025,
            ]);
        }
    }
    LinearImage {
        width,
        height,
        data,
    }
}

fn dcp() -> DcpSpec {
    DcpSpec::from_dcp_bytes(DCP).unwrap()
}

fn meta() -> CameraLinearWorkMeta {
    let profile = dcp();
    CameraLinearWorkMeta {
        expected_dcp_sha256: sha256_hex(DCP),
        expected_unique_camera_model: profile.unique_camera_model,
        base_version: BASE_VERSION.into(),
        as_shot_camera_neutral: [0.58, 1.0, 0.72],
        raw_baseline_ev: 0.17,
        as_shot_white: AsShotWhite {
            x: 0.3324,
            y: 0.3474,
            temperature: Some(5400.0),
            tint: Some(4.0),
        },
    }
}

fn settings() -> DevelopSettings {
    let mut settings = DevelopSettings::neutral();
    settings.base = Some(BASE_VERSION.into());
    settings.exposure = 0.2;
    settings.contrast = 8.0;
    settings
}

fn options() -> RenderOptions {
    RenderOptions {
        max_dimension: 0,
        quality: Quality::Final,
        ..Default::default()
    }
}

fn equivalent_working_copy_render(
    camera: &LinearImage,
    meta: &CameraLinearWorkMeta,
    settings: &DevelopSettings,
    neutral: [f64; 3],
) -> niho_develop::Rendered {
    let profile = dcp();
    let image = to_linear_prophoto(camera, &profile.color_input(), neutral).unwrap();
    let working_meta = WorkingCopyMeta::Raw {
        baseline_ev: meta.raw_baseline_ev + profile.baseline_exposure_offset,
        as_shot_white: meta.as_shot_white,
        as_shot_white_adobe: None,
        white_balance_table: None,
        dcp_sha256: meta.expected_dcp_sha256.clone(),
        look_table_included: false,
        encoding: None,
    };
    render_working_copy(
        &WorkingCopy {
            image: &image,
            meta: &working_meta,
        },
        settings,
        Quality::Final,
        None,
    )
    .0
}

fn assert_same(actual: &niho_develop::Rendered, expected: &niho_develop::Rendered) {
    assert_eq!(
        (actual.width, actual.height),
        (expected.width, expected.height)
    );
    assert_eq!(actual.rgba, expected.rgba);
    assert_eq!(actual.approximations, expected.approximations);
}

fn camera_error(result: Result<niho_develop::Rendered, Error>) -> CameraLinearError {
    match result.unwrap_err() {
        Error::CameraLinear(error) => error,
        other => panic!("expected camera-linear error, got {other}"),
    }
}

#[test]
fn as_shot_and_relative_match_the_existing_working_copy_tail() {
    let camera = camera();
    let meta = meta();

    let as_shot = settings();
    let actual = render_camera_linear(&camera, DCP, &meta, &as_shot, &options()).unwrap();
    let expected =
        equivalent_working_copy_render(&camera, &meta, &as_shot, meta.as_shot_camera_neutral);
    assert_same(&actual, &expected);

    let mut relative = as_shot;
    relative.white_balance.mode = WhiteBalanceMode::Relative;
    relative.relative_temperature = 35.0;
    relative.relative_tint = -12.0;
    let actual = render_camera_linear(&camera, DCP, &meta, &relative, &options()).unwrap();
    let expected =
        equivalent_working_copy_render(&camera, &meta, &relative, meta.as_shot_camera_neutral);
    assert_same(&actual, &expected);
}

#[test]
fn absolute_white_is_applied_in_camera_rgb_only_once() {
    let camera = camera();
    let meta = meta();
    let mut absolute = settings();
    absolute.white_balance = WhiteBalance {
        mode: WhiteBalanceMode::Absolute,
        temperature: Some(4200.0),
        tint: Some(8.0),
    };

    let actual = render_camera_linear(&camera, DCP, &meta, &absolute, &options()).unwrap();
    let profile = dcp();
    let neutral = neutral_for_absolute_white(&profile.color_input(), 4200.0, 8.0).unwrap();
    let mut tail_settings = absolute;
    tail_settings.white_balance.mode = WhiteBalanceMode::AsShot;
    let expected = equivalent_working_copy_render(&camera, &meta, &tail_settings, neutral);

    assert_same(&actual, &expected);
    assert!(!actual.approximations.contains(&"absoluteWhiteBalance"));
}

#[test]
fn camera_linear_white_balance_clips_highlights_after_gains() {
    let profile = dcp();
    let neutral = [0.5, 1.0, 0.75];
    let mut above_clip = camera();
    above_clip.data[0] = 0.75;
    let mut at_clip = camera();
    at_clip.data[0] = 0.5;

    let above_clip = to_linear_prophoto(&above_clip, &profile.color_input(), neutral).unwrap();
    let at_clip = to_linear_prophoto(&at_clip, &profile.color_input(), neutral).unwrap();

    assert_eq!(above_clip.data, at_clip.data);
}

#[test]
fn identity_base_and_numeric_metadata_fail_closed() {
    let camera = camera();
    let settings = settings();

    let mut bad = meta();
    bad.expected_dcp_sha256 = "0".repeat(64);
    assert_eq!(
        camera_error(render_camera_linear(
            &camera,
            DCP,
            &bad,
            &settings,
            &options()
        )),
        CameraLinearError::Sha256Mismatch
    );

    let mut bad = meta();
    bad.expected_unique_camera_model.push_str(" mismatch");
    assert_eq!(
        camera_error(render_camera_linear(
            &camera,
            DCP,
            &bad,
            &settings,
            &options()
        )),
        CameraLinearError::CameraModelMismatch
    );

    let mut wrong_base = settings.clone();
    wrong_base.base = Some("other-base".into());
    assert_eq!(
        camera_error(render_camera_linear(
            &camera,
            DCP,
            &meta(),
            &wrong_base,
            &options()
        )),
        CameraLinearError::BaseVersionMismatch
    );

    let mut unversioned_edit = settings.clone();
    unversioned_edit.base = None;
    assert_eq!(
        camera_error(render_camera_linear(
            &camera,
            DCP,
            &meta(),
            &unversioned_edit,
            &options()
        )),
        CameraLinearError::BaseVersionMismatch
    );

    let mut bad = meta();
    bad.base_version = " ".into();
    assert_eq!(
        camera_error(render_camera_linear(
            &camera,
            DCP,
            &bad,
            &settings,
            &options()
        )),
        CameraLinearError::InvalidBaseVersion
    );

    let mut bad = meta();
    bad.raw_baseline_ev = f64::NAN;
    assert_eq!(
        camera_error(render_camera_linear(
            &camera,
            DCP,
            &bad,
            &settings,
            &options()
        )),
        CameraLinearError::NonFiniteBaselineExposure
    );

    let mut bad = meta();
    bad.raw_baseline_ev = 1024.0;
    assert_eq!(
        camera_error(render_camera_linear(
            &camera,
            DCP,
            &bad,
            &settings,
            &options()
        )),
        CameraLinearError::InvalidBaselineExposureGain
    );

    let mut bad = meta();
    bad.as_shot_camera_neutral[0] = 0.0;
    assert_eq!(
        camera_error(render_camera_linear(
            &camera,
            DCP,
            &bad,
            &settings,
            &options()
        )),
        CameraLinearError::InvalidNeutral
    );

    let mut bad = meta();
    bad.as_shot_camera_neutral = [0.29, 0.5, 0.36];
    assert_eq!(
        camera_error(render_camera_linear(
            &camera,
            DCP,
            &bad,
            &settings,
            &options()
        )),
        CameraLinearError::InvalidNeutral
    );

    let mut bad = meta();
    bad.as_shot_white.x = f64::NAN;
    assert_eq!(
        camera_error(render_camera_linear(
            &camera,
            DCP,
            &bad,
            &settings,
            &options()
        )),
        CameraLinearError::InvalidAsShotWhite
    );
}

#[test]
fn malformed_camera_pixels_and_physical_absolute_white_are_rejected() {
    let meta = meta();
    let settings = settings();
    let mut bad_dimensions = camera();
    bad_dimensions.data.pop();
    assert_eq!(
        camera_error(render_camera_linear(
            &bad_dimensions,
            DCP,
            &meta,
            &settings,
            &options()
        )),
        CameraLinearError::InvalidDimensions
    );

    let mut nonfinite = camera();
    nonfinite.data[4] = f32::INFINITY;
    assert_eq!(
        camera_error(render_camera_linear(
            &nonfinite,
            DCP,
            &meta,
            &settings,
            &options()
        )),
        CameraLinearError::NonFinitePixel
    );

    let mut impossible = settings;
    impossible.white_balance = WhiteBalance {
        mode: WhiteBalanceMode::Absolute,
        temperature: Some(2000.0),
        tint: Some(150.0),
    };
    assert_eq!(
        camera_error(render_camera_linear(
            &camera(),
            DCP,
            &meta,
            &impossible,
            &options()
        )),
        CameraLinearError::InvalidWhiteBalance
    );
}

#[test]
fn settings_without_a_base_can_render_a_neutral_preview() {
    let mut neutral = DevelopSettings::neutral();
    neutral.base = None;
    let frame = render_camera_linear(&camera(), DCP, &meta(), &neutral, &options()).unwrap();
    assert_eq!((frame.width, frame.height), (8, 6));
}
