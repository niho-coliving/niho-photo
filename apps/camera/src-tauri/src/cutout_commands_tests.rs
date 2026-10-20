use super::*;
use serde_json::json;

#[test]
fn operation_ids_are_opaque_and_bounded() {
  assert!(check_operation_id("detect-0123_abCD").is_ok());
  for bad in [
    "",
    "../detect",
    "detect/1",
    "検出",
    &"a".repeat(MAX_OPERATION_ID_BYTES + 1),
  ] {
    assert_eq!(check_operation_id(bad).unwrap_err().code, code::INVALID_REQUEST);
  }
}

#[test]
fn cancellation_only_marks_the_matching_current_operation() {
  let root = std::env::temp_dir().join(format!("niho-camera-cutout-operation-{}", new_opaque_id("test")));
  let camera = Arc::new(CameraCutout::new(
    PhotoCutout::new(CutoutConfig {
      sidecar: root.join("missing-sidecar"),
      expected_version: "0.2.0".to_string(),
      data_dir: root.join("data"),
      timeouts: CutoutTimeouts::default(),
    }),
    true,
  ));

  let first = camera.begin("first".to_string()).unwrap();
  camera.cancel("other");
  assert!(!first.cancelled());
  camera.cancel("first");
  assert!(first.cancelled());
  drop(first);

  let second = camera.begin("second".to_string()).unwrap();
  camera.cancel("first");
  assert!(!second.cancelled(), "古い operationId の取消を新しい仕事へ持ち越さない");
}

#[test]
fn recipes_must_be_bound_to_the_open_photo_hash() {
  let key = "a".repeat(64);
  let recipe = json!({ "v": 1, "detection": { "inputSHA256": key } });
  assert!(recipe_for_photo(&recipe, &"a".repeat(64)).is_ok());
  assert_eq!(
    recipe_for_photo(&recipe, &"b".repeat(64)).unwrap_err().code,
    code::INVALID_REQUEST
  );
  assert_eq!(
    recipe_for_photo(&json!({"v": 2}), &"a".repeat(64)).unwrap_err().code,
    code::INVALID_REQUEST
  );
}

#[test]
fn native_rejects_geometry_together_with_cutout() {
  for geometry in [
    json!({"rotate": 90}),
    json!({"flipH": true}),
    json!({"angle": 0.1}),
    json!({"crop": {"left": 0.1, "top": 0, "right": 1, "bottom": 1}}),
    json!({"rotate": "0"}),
    json!({"crop": {"left": "0"}}),
  ] {
    assert!(has_develop_geometry(&json!({"geometry": geometry})));
  }
  for settings in [
    json!({}),
    json!({"geometry": null}),
    json!({"geometry": {}}),
    json!({"geometry": {"rotate": 180, "flipH": true, "flipV": true}}),
    json!({"geometry": {"crop": {"left": 0, "top": 0, "right": 1, "bottom": 1}}}),
  ] {
    assert!(!has_develop_geometry(&settings), "{settings}");
  }
}

#[test]
fn jpeg_turns_transparency_white_and_colors_are_strict() {
  let transparent = json!({"background": {"kind": "transparent"}});
  assert_eq!(
    background_argument(&transparent, ExportFormat::Png).unwrap(),
    "transparent"
  );
  assert_eq!(background_argument(&transparent, ExportFormat::Jpeg).unwrap(), "white");
  assert_eq!(
    background_argument(
      &json!({"background": {"kind": "color", "color": "#12abef"}}),
      ExportFormat::Png
    )
    .unwrap(),
    "#12abef"
  );
  assert!(background_argument(
    &json!({"background": {"kind": "color", "color": "#FFFFFF"}}),
    ExportFormat::Png
  )
  .is_err());
}

#[test]
fn export_names_keep_only_the_original_stem() {
  assert_eq!(export_file_name("P1.RW2", ExportFormat::Png), "P1.png");
  assert_eq!(export_file_name("photo", ExportFormat::Jpeg), "photo.jpg");
}
