use niho_camera_color::color::{resolve_profile_color, PROPHOTO_TO_XYZ_D50};
use niho_camera_color::matrix;
use niho_camera_profile::dcp::{self, DcpSpec, SPEC_SCHEMA};
use niho_camera_profile::tiff::{self, Value};
use niho_develop::camera_linear::{
    neutral_for_absolute_white, to_linear_prophoto, to_linear_prophoto_from_dcp_bytes,
    CameraLinearError,
};
use niho_develop::color::xy_from_temperature;
use niho_develop::LinearImage;

const MODEL: &str = "Synthetic Camera";

fn spec() -> DcpSpec {
    DcpSpec {
        schema: SPEC_SCHEMA.into(),
        profile_name: "Synthetic profile".into(),
        unique_camera_model: MODEL.into(),
        copyright: String::new(),
        embed_policy: 0,
        calibration_signature: String::new(),
        illuminant1: 23,
        color_matrix1: vec![1.0, 0.0, 0.0, 0.0, 1.0, 0.0, 0.0, 0.0, 1.0],
        illuminant2: None,
        color_matrix2: None,
        forward_matrix1: Some(matrix::to_row_major(&PROPHOTO_TO_XYZ_D50).to_vec()),
        forward_matrix2: None,
        hue_sat_map: None,
        baseline_exposure_offset: 0.0,
        default_black_render: 0,
        tone_curve: None,
        look_table: None,
    }
}

fn camera() -> LinearImage {
    LinearImage {
        width: 1,
        height: 1,
        data: vec![0.2, 0.3, 0.4],
    }
}

#[test]
fn exact_dcp_identity_produces_the_existing_pure_transform() {
    let bytes = spec().to_dcp_bytes().unwrap();
    let sha = dcp::sha256_hex(&bytes);
    let neutral = [0.5, 1.0, 0.25];
    let image = camera();
    let parsed = DcpSpec::from_dcp_bytes(&bytes).unwrap();
    let expected = to_linear_prophoto(&image, &parsed.color_input(), neutral).unwrap();
    let actual = to_linear_prophoto_from_dcp_bytes(&image, &bytes, &sha, MODEL, neutral).unwrap();
    assert_eq!(actual.data, expected.data);
    assert!((actual.data[0] - 0.4).abs() < 2e-4);
    // The four-times blue white-balance gain is clipped before this identity DCP.
    assert!((actual.data[2] - 1.0).abs() < 2e-4);
    assert_eq!(image.data, vec![0.2, 0.3, 0.4]);
}

#[test]
fn absolute_white_uses_camera_rgb_with_a_real_niho_dcp() {
    let bytes = include_bytes!(
        "../../niho-base-raw/profiles/panasonic-dc-s5/niho-dc-s5-independent-v1.dcp"
    );
    let dcp = DcpSpec::from_dcp_bytes(bytes).unwrap();
    dcp.validate().unwrap();
    let profile = dcp.color_input();
    let mut rendered = Vec::new();
    for kelvin in [4000.0, 5500.0, 7500.0] {
        let neutral = neutral_for_absolute_white(&profile, kelvin, 12.0).unwrap();
        assert!(neutral.iter().all(|v| *v > 0.0 && *v <= 1.0));
        let target = xy_from_temperature(kelvin, 12.0);
        let resolved = resolve_profile_color(&profile, &neutral).unwrap();
        assert!((resolved.white_xy[0] - target.x).abs() < 1e-6);
        assert!((resolved.white_xy[1] - target.y).abs() < 1e-6);
        let output = to_linear_prophoto(&camera(), &profile, neutral).unwrap();
        assert!(output.data.iter().all(|v| v.is_finite()));
        rendered.push(output.data);
    }
    assert_ne!(rendered[0], rendered[1]);
    assert_ne!(rendered[1], rendered[2]);
    // The existing settings range includes some Kelvin/tint pairs whose DNG xy is outside the
    // physical chromaticity triangle. The future camera-linear caller must handle this error.
    assert_eq!(
        neutral_for_absolute_white(&profile, 2000.0, 150.0).unwrap_err(),
        CameraLinearError::InvalidWhiteBalance
    );
}

#[test]
fn absolute_white_rejects_values_outside_develop_settings_bounds() {
    let profile = spec();
    let input = profile.color_input();
    for (temperature, tint) in [
        (1999.0, 0.0),
        (50001.0, 0.0),
        (5500.0, 151.0),
        (5500.0, f64::NAN),
    ] {
        assert_eq!(
            neutral_for_absolute_white(&input, temperature, tint).unwrap_err(),
            CameraLinearError::InvalidWhiteBalance
        );
    }
}

#[test]
fn sha_and_camera_model_mismatches_fail_before_color() {
    let bytes = spec().to_dcp_bytes().unwrap();
    let sha = dcp::sha256_hex(&bytes);
    let image = camera();
    assert_eq!(
        to_linear_prophoto_from_dcp_bytes(&image, &bytes, "0", MODEL, [1.0; 3]).unwrap_err(),
        CameraLinearError::InvalidExpectedSha256
    );
    assert_eq!(
        to_linear_prophoto_from_dcp_bytes(&image, &bytes, &"A".repeat(64), MODEL, [1.0; 3])
            .unwrap_err(),
        CameraLinearError::InvalidExpectedSha256
    );
    assert_eq!(
        to_linear_prophoto_from_dcp_bytes(&image, &bytes, &sha, " ", [1.0; 3]).unwrap_err(),
        CameraLinearError::InvalidExpectedCameraModel
    );
    assert_eq!(
        to_linear_prophoto_from_dcp_bytes(&image, &bytes, &"0".repeat(64), MODEL, [1.0; 3])
            .unwrap_err(),
        CameraLinearError::Sha256Mismatch
    );
    assert_eq!(
        to_linear_prophoto_from_dcp_bytes(&image, &bytes, &sha, "Other Camera", [1.0; 3])
            .unwrap_err(),
        CameraLinearError::CameraModelMismatch
    );
    assert_eq!(
        to_linear_prophoto_from_dcp_bytes(&image, &bytes, &sha, "synthetic camera", [1.0; 3])
            .unwrap_err(),
        CameraLinearError::CameraModelMismatch
    );

    let mut tampered = bytes;
    tampered.push(0);
    assert_eq!(
        to_linear_prophoto_from_dcp_bytes(&image, &tampered, &sha, MODEL, [1.0; 3]).unwrap_err(),
        CameraLinearError::Sha256Mismatch
    );
}

#[test]
fn matching_sha_does_not_bypass_parse_or_spec_validation() {
    let image = camera();
    let malformed = b"invalid DCP";
    let sha = dcp::sha256_hex(malformed);
    assert!(matches!(
        to_linear_prophoto_from_dcp_bytes(&image, malformed, &sha, MODEL, [1.0; 3]),
        Err(CameraLinearError::InvalidProfile(_))
    ));

    let invalid_policy = tiff::write_single_ifd_le(
        tiff::MAGIC_DCP,
        &[
            (dcp::tag::UNIQUE_CAMERA_MODEL, Value::Ascii(MODEL.into())),
            (dcp::tag::COLOR_MATRIX1, Value::SRational(vec![(1, 1); 9])),
            (dcp::tag::PROFILE_EMBED_POLICY, Value::Long(vec![7])),
        ],
    )
    .unwrap();
    assert!(matches!(
        to_linear_prophoto_from_dcp_bytes(
            &image,
            &invalid_policy,
            &dcp::sha256_hex(&invalid_policy),
            MODEL,
            [1.0; 3]
        ),
        Err(CameraLinearError::InvalidProfile(_))
    ));
}
