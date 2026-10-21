use super::*;
use niho_desktop_photo::common::code;
use niho_desktop_photo::test_support::library::{assert_no_path, entry_id, Fixture};
use niho_desktop_photo::test_support::set_modified;
use std::time::{Duration, UNIX_EPOCH};

fn camera_flags(fixture: &Fixture) -> CameraFlags {
  CameraFlags::new(Some(FlagStore::new(
    flags_path(&fixture.app_data()),
    FlagLimits::default(),
  )))
}

fn at(millis: u64) -> SystemTime {
  UNIX_EPOCH + Duration::from_millis(millis)
}

fn request(value: Value) -> Result<SetFlagsRequest, CameraError> {
  parse_request(Some(value))
}

#[test]
fn set_flags_requests_are_checked_before_touching_the_library() {
  let ok = request(json!({ "entryIds": ["entry-1"], "flag": "pick" })).unwrap();
  assert_eq!(validate_set_flags_request(&ok).unwrap(), Some(PhotoFlag::Pick));
  let reject = request(json!({ "entryIds": ["entry-1"], "flag": "reject" })).unwrap();
  assert_eq!(validate_set_flags_request(&reject).unwrap(), Some(PhotoFlag::Reject));
  let clear = request(json!({ "entryIds": ["entry-1"], "flag": null })).unwrap();
  assert_eq!(validate_set_flags_request(&clear).unwrap(), None);

  // フラグを省く・知らないフラグ・形の違う値・知らない項目（パスを渡そうとする）は断る
  assert_eq!(
    request(json!({ "entryIds": ["entry-1"] })).unwrap_err().code,
    code::INVALID_REQUEST
  );
  assert_eq!(
    request(json!({ "entryIds": ["entry-1"], "flag": "pick", "path": "/test-data/users/x" }))
      .unwrap_err()
      .code,
    code::INVALID_REQUEST
  );
  for flag in [json!("star"), json!(true), json!(1), json!({ "flag": "pick" })] {
    let parsed = request(json!({ "entryIds": ["entry-1"], "flag": flag })).unwrap();
    assert_eq!(
      validate_set_flags_request(&parsed).unwrap_err().code,
      code::INVALID_REQUEST
    );
  }
  // 1〜500 枚
  let empty = request(json!({ "entryIds": [], "flag": "pick" })).unwrap();
  assert_eq!(
    validate_set_flags_request(&empty).unwrap_err().code,
    code::INVALID_REQUEST
  );
  let ids: Vec<String> = (0..=MAX_FLAG_PHOTOS_PER_REQUEST)
    .map(|index| format!("entry-{index}"))
    .collect();
  let too_many = request(json!({ "entryIds": ids, "flag": "pick" })).unwrap();
  assert_eq!(
    validate_set_flags_request(&too_many).unwrap_err().code,
    code::INVALID_REQUEST
  );
  let most = request(json!({ "entryIds": ids[..MAX_FLAG_PHOTOS_PER_REQUEST], "flag": null })).unwrap();
  assert!(validate_set_flags_request(&most).is_ok());
}

#[test]
fn flags_set_by_entry_id_show_up_in_the_folder_listing_and_survive_a_rescan_and_restart() {
  let fixture = Fixture::new("camera-flags");
  fixture.file("SD/P1000001.RW2");
  fixture.file("SD/P1000002.RW2");
  fixture.file("SD/sub/P1000003.JPG");
  let library = fixture.library();
  let flags = camera_flags(&fixture);
  let mut folder = library.add_folder(&fixture.root().join("SD")).unwrap();
  flags.annotate(&mut folder);
  assert!(folder["photos"]
    .as_array()
    .unwrap()
    .iter()
    .all(|photo| photo.get("flag").is_none()));

  let first = entry_id(&folder, "P1000001.RW2");
  let second = entry_id(&folder, "P1000002.RW2");
  let nested = entry_id(&folder["children"][0], "P1000003.JPG");
  let answer = flags
    .set(
      &library,
      vec![first.clone(), nested.clone(), first.clone()],
      Some(PhotoFlag::Pick),
      at(1),
    )
    .unwrap();
  assert_eq!(answer, json!({ "updated": [first, nested], "notFound": [] }));
  flags
    .set(&library, vec![second.clone()], Some(PhotoFlag::Reject), at(2))
    .unwrap();

  // フォルダを読み直しても付いている（サブフォルダの写真も）。パスは返さない
  let mut rescanned = library.list_folder(folder["folderId"].as_str().unwrap()).unwrap();
  flags.annotate(&mut rescanned);
  assert_eq!(rescanned["photos"][0]["flag"], json!("pick"));
  assert_eq!(rescanned["photos"][1]["flag"], json!("reject"));
  assert_eq!(rescanned["children"][0]["photos"][0]["flag"], json!("pick"));
  assert_no_path(&rescanned);

  // 次の起動（置き場から読む）。覚えた写真の一覧（`{ folders, photos }`）の形でも付く
  let restarted = camera_flags(&fixture);
  let mut remembered = fixture.library().remembered();
  restarted.annotate(&mut remembered);
  assert_eq!(remembered["folders"][0]["photos"][0]["flag"], json!("pick"));
  assert_eq!(remembered["folders"][0]["photos"][1]["flag"], json!("reject"));

  // 外すと印が消える（足してあった `flag` も外す）
  restarted.set(&library, vec![second], None, at(3)).unwrap();
  restarted.annotate(&mut rescanned);
  assert!(rescanned["photos"][1].get("flag").is_none());
  assert_eq!(rescanned["photos"][0]["flag"], json!("pick"));
}

#[test]
fn unknown_or_missing_photos_are_not_found_and_a_replaced_photo_has_no_flag() {
  let fixture = Fixture::new("camera-flags-missing");
  let path = fixture.file("SD/P1000001.JPG");
  set_modified(&path, at(1_700_000_000_000));
  let library = fixture.library();
  let flags = camera_flags(&fixture);
  let folder = library.add_folder(&fixture.root().join("SD")).unwrap();
  let listed = entry_id(&folder, "P1000001.JPG");

  let answer = flags
    .set(
      &library,
      vec!["entry-unknown".into(), "".into()],
      Some(PhotoFlag::Pick),
      at(1),
    )
    .unwrap();
  assert_eq!(answer, json!({ "updated": [], "notFound": ["entry-unknown", ""] }));
  assert!(
    !flags_path(&fixture.app_data()).exists(),
    "付ける写真が無ければ書かない"
  );

  flags
    .set(&library, vec![listed.clone()], Some(PhotoFlag::Reject), at(2))
    .unwrap();
  // Finder で消した写真（孤児）は付け外しできず、同じ名前で撮り直した写真には印が付かない
  std::fs::remove_file(&path).unwrap();
  let answer = flags.set(&library, vec![listed], None, at(3)).unwrap();
  assert_eq!(answer["notFound"].as_array().unwrap().len(), 1);
  let replaced = fixture.file("SD/P1000001.JPG");
  set_modified(&replaced, at(1_800_000_000_000));
  let mut rescanned = library.list_folder(folder["folderId"].as_str().unwrap()).unwrap();
  flags.annotate(&mut rescanned);
  assert!(rescanned["photos"][0].get("flag").is_none());
}

#[test]
fn without_a_store_the_listing_is_untouched_and_setting_fails_without_a_path() {
  let fixture = Fixture::new("camera-flags-no-store");
  fixture.file("SD/P1000001.JPG");
  let library = fixture.library();
  let flags = CameraFlags::new(None);
  let mut folder = library.add_folder(&fixture.root().join("SD")).unwrap();
  let before = folder.clone();
  flags.annotate(&mut folder);
  assert_eq!(folder, before);
  let err = flags
    .set(
      &library,
      vec![entry_id(&folder, "P1000001.JPG")],
      Some(PhotoFlag::Pick),
      at(1),
    )
    .unwrap_err();
  assert_eq!(err.code, code::INTERNAL);
  assert!(!err.message.contains('/'));
}

#[test]
fn a_store_that_cannot_be_written_is_an_internal_error() {
  let fixture = Fixture::new("camera-flags-unwritable");
  fixture.file("SD/P1000001.JPG");
  // 置き場のフォルダ（photo-editing）の場所にファイルがあると書けない
  std::fs::create_dir_all(fixture.app_data()).unwrap();
  std::fs::write(fixture.app_data().join("photo-editing"), b"not a folder").unwrap();
  let library = fixture.library();
  let flags = camera_flags(&fixture);
  let folder = library.add_folder(&fixture.root().join("SD")).unwrap();
  let err = flags
    .set(
      &library,
      vec![entry_id(&folder, "P1000001.JPG")],
      Some(PhotoFlag::Pick),
      at(1),
    )
    .unwrap_err();
  assert_eq!(err.code, code::INTERNAL);
  assert_eq!(err.message, FLAGS_SAVE_FAILED_MESSAGE);
}
