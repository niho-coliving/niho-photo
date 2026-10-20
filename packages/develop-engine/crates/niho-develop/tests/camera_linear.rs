use niho_camera_color::color::{HueSatMapInput, ProfileInput, PROPHOTO_TO_XYZ_D50};
use niho_camera_color::matrix;
use niho_develop::camera_linear::{to_linear_prophoto, CameraLinearError};
use niho_develop::LinearImage;

const CM: [f64; 9] = [1.0, 0.0, 0.0, 0.0, 1.0, 0.0, 0.0, 0.0, 1.0];

fn profile<'a>(fm: &'a [f64], hsm: Option<HueSatMapInput<'a>>) -> ProfileInput<'a> {
    ProfileInput {
        illuminant1: 23,
        color_matrix1: &CM,
        illuminant2: None,
        color_matrix2: None,
        forward_matrix1: Some(fm),
        forward_matrix2: None,
        hue_sat_map: hsm,
    }
}

fn close(actual: &[f32], expected: &[f32]) {
    assert_eq!(actual.len(), expected.len());
    for (a, e) in actual.iter().zip(expected) {
        assert!((a - e).abs() < 2e-5, "{actual:?} != {expected:?}");
    }
}

#[test]
fn as_shot_wb_then_profile_then_hue_sat_map() {
    let fm = matrix::to_row_major(&PROPHOTO_TO_XYZ_D50);
    let table = [[0.0, 1.0, 0.5]; 2];
    let profile = profile(
        &fm,
        Some(HueSatMapInput {
            hue_divisions: 1,
            sat_divisions: 2,
            val_divisions: 1,
            encoding: 0,
            data1: &table,
            data2: None,
        }),
    );
    let camera = LinearImage {
        width: 1,
        height: 1,
        data: vec![0.2, 0.3, 0.4],
    };
    let result = to_linear_prophoto(&camera, &profile, [0.5, 1.0, 0.25]).unwrap();
    close(&result.data, &[0.2, 0.15, 0.5]);
    close(&camera.data, &[0.2, 0.3, 0.4]);
    assert_eq!((result.width, result.height), (1, 1));
}

#[test]
fn changing_profile_reuses_camera_pixels() {
    let fm1 = PROPHOTO_TO_XYZ_D50;
    let fm2 = matrix::scale(&fm1, 2.0);
    let fm1 = matrix::to_row_major(&fm1);
    let fm2 = matrix::to_row_major(&fm2);
    let camera = LinearImage {
        width: 1,
        height: 1,
        data: vec![0.1, 0.2, 0.3],
    };
    let first = to_linear_prophoto(&camera, &profile(&fm1, None), [1.0; 3]).unwrap();
    let second = to_linear_prophoto(&camera, &profile(&fm2, None), [1.0; 3]).unwrap();
    let new_white = to_linear_prophoto(&camera, &profile(&fm1, None), [0.5, 1.0, 1.0]).unwrap();
    close(&first.data, &[0.1, 0.2, 0.3]);
    close(&second.data, &[0.2, 0.4, 0.6]);
    close(&new_white.data, &[0.2, 0.2, 0.3]);
    close(&camera.data, &[0.1, 0.2, 0.3]);
}

#[test]
fn highlights_above_one_remain_linear_and_negative_output_is_clamped() {
    let fm = matrix::to_row_major(&PROPHOTO_TO_XYZ_D50);
    let camera = LinearImage {
        width: 2,
        height: 1,
        data: vec![1.25, 0.1, 0.2, -0.1, 0.2, 0.3],
    };
    let result = to_linear_prophoto(&camera, &profile(&fm, None), [1.0; 3]).unwrap();
    close(&result.data, &[1.0, 0.1, 0.2, 0.0, 0.2, 0.3]);
    assert!(result.data[0] <= 1.0);
    assert_eq!(result.data[3], 0.0);

    let doubled = matrix::to_row_major(&matrix::scale(&PROPHOTO_TO_XYZ_D50, 2.0));
    let headroom_camera = LinearImage {
        width: 1,
        height: 1,
        data: vec![0.75, 0.1, 0.2],
    };
    let headroom =
        to_linear_prophoto(&headroom_camera, &profile(&doubled, None), [1.0; 3]).unwrap();
    close(&headroom.data, &[1.5, 0.2, 0.4]);
    assert!(headroom.data[0] > 1.0);
}

#[test]
fn invalid_dimensions_neutral_pixels_and_profile_are_rejected() {
    let fm = matrix::to_row_major(&PROPHOTO_TO_XYZ_D50);
    let mut camera = LinearImage {
        width: 1,
        height: 1,
        data: vec![0.1, 0.2, 0.3],
    };
    camera.width = 0;
    assert_eq!(
        to_linear_prophoto(&camera, &profile(&fm, None), [1.0; 3]).unwrap_err(),
        CameraLinearError::InvalidDimensions
    );
    camera.width = 1;
    camera.data.pop();
    assert_eq!(
        to_linear_prophoto(&camera, &profile(&fm, None), [1.0; 3]).unwrap_err(),
        CameraLinearError::InvalidDimensions
    );
    camera.data.push(0.3);
    for neutral in [
        [0.0, 1.0, 1.0],
        [f64::NAN, 1.0, 1.0],
        [f64::MIN_POSITIVE, 1.0, 1.0],
    ] {
        assert_eq!(
            to_linear_prophoto(&camera, &profile(&fm, None), neutral).unwrap_err(),
            CameraLinearError::InvalidNeutral
        );
    }
    camera.data[0] = f32::NAN;
    assert_eq!(
        to_linear_prophoto(&camera, &profile(&fm, None), [1.0; 3]).unwrap_err(),
        CameraLinearError::NonFinitePixel
    );
    camera.data[0] = 0.1;
    let mut bad_profile = profile(&fm, None);
    bad_profile.color_matrix1 = &CM[..8];
    assert!(matches!(
        to_linear_prophoto(&camera, &bad_profile, [1.0; 3]),
        Err(CameraLinearError::InvalidProfile(_))
    ));
}
