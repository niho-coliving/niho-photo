use super::*;
use std::fs;
use std::sync::atomic::{AtomicU64, Ordering};

/// テストごとの一時フォルダ（Drop で消す）。
struct TempDir(PathBuf);

impl TempDir {
  fn new(name: &str) -> Self {
    static COUNTER: AtomicU64 = AtomicU64::new(1);
    let dir = std::env::temp_dir().join(format!(
      "niho-camera-photos-{name}-{}-{}",
      std::process::id(),
      COUNTER.fetch_add(1, Ordering::SeqCst)
    ));
    let _ = fs::remove_dir_all(&dir);
    fs::create_dir_all(&dir).unwrap();
    Self(dir)
  }

  fn file(&self, name: &str, bytes: &[u8]) -> PathBuf {
    let path = self.0.join(name);
    fs::create_dir_all(path.parent().unwrap()).unwrap();
    fs::write(&path, bytes).unwrap();
    path
  }
}

impl Drop for TempDir {
  fn drop(&mut self) {
    let _ = fs::remove_dir_all(&self.0);
  }
}

fn camera_photos(temp: &TempDir) -> CameraPhotos {
  CameraPhotos::new(Some(SavedSettingsStore::new(
    temp.0.join("app-data").join(EDITS_DIR_NAME),
    edits_limits(),
  )))
}

#[test]
fn an_opened_photo_has_an_opaque_id_and_no_path() {
  let temp = TempDir::new("open");
  let photos = camera_photos(&temp);
  let path = temp.file("SD/P1524180.RW2", b"raw bytes");
  let (photo_id, photo) = photos.open("entry-1", &path).unwrap();
  assert!(photo_id.starts_with("photo") && is_valid_id(&photo_id), "{photo_id}");
  assert_eq!(photo.digest.size_bytes, 9);
  let value = opened_json(&photo_id, &photo, photos.saved(&photo.digest.key), true);
  assert_eq!(
    value,
    json!({
      "photoId": photo_id, "entryId": "entry-1", "fileName": "P1524180.RW2", "format": "raw", "sizeBytes": 9,
      "contentSha256": photo.digest.key, "modifiedAt": value["modifiedAt"], "nativeExport": true, "saved": null,
    })
  );
  // 中身の SHA-256（16 進の小文字 64 文字。sha256("raw bytes")）と、一覧の modifiedAt と同じ形の更新日時
  assert_eq!(
    value["contentSha256"],
    json!("9ab366ad455508d5f47b0128d7d243a2c0e4f5ce399b5f85cd10b343e745a4dc")
  );
  let modified_at = value["modifiedAt"].as_str().expect("modifiedAt");
  assert!(modified_at.len() == 24 && modified_at.ends_with('Z'), "{modified_at}");
  assert!(
    !value.to_string().contains(temp.0.to_str().unwrap()),
    "パスを画面へ渡さない"
  );
  assert!(!photos.has_saved_settings(&photo_id));
  // 開けないファイル
  assert_eq!(
    photos.open("entry-2", &temp.0.join("missing.jpg")).unwrap_err().code,
    code::NOT_FOUND
  );
  assert_eq!(
    photos.open("entry-3", &temp.0.join("SD")).unwrap_err().code,
    code::NOT_FOUND
  );
}

#[test]
fn edits_are_saved_with_a_revision_and_follow_the_photo_content() {
  let temp = TempDir::new("save");
  let photos = camera_photos(&temp);
  let path = temp.file("SD/DSC00001.JPG", b"jpeg bytes");
  let (photo_id, _) = photos.open("entry-1", &path).unwrap();
  let now = SystemTime::now();
  assert_eq!(photos.save(&photo_id, &json!({ "exposure": 0.3 }), 0, now).unwrap(), 1);
  assert_eq!(photos.save(&photo_id, &json!({ "exposure": 0.5 }), 1, now).unwrap(), 2);
  let conflict = photos.save(&photo_id, &json!({ "exposure": 9 }), 1, now).unwrap_err();
  assert_eq!(
    (conflict.code.as_str(), conflict.current_revision),
    ("revisionConflict", Some(2))
  );
  assert!(photos.has_saved_settings(&photo_id));

  // 名前を変えて別のフォルダへ動かしても、同じ中身なら同じ補正
  let moved = temp.0.join("Pictures/renamed.jpg");
  fs::create_dir_all(moved.parent().unwrap()).unwrap();
  fs::rename(&path, &moved).unwrap();
  let (reopened, photo) = photos.open("entry-9", &moved).unwrap();
  let value = opened_json(&reopened, &photo, photos.saved(&photo.digest.key), false);
  assert_eq!(value["saved"]["developSettings"], json!({ "exposure": 0.5 }));
  assert_eq!(value["saved"]["revision"], json!(2));
  // 置き場は Application Support の edits/<SHA-256>.json
  let record = temp
    .0
    .join("app-data")
    .join(EDITS_DIR_NAME)
    .join(format!("{}.json", photo.digest.key));
  let stored: Value = serde_json::from_slice(&fs::read(record).unwrap()).unwrap();
  assert_eq!(stored["fileName"], "DSC00001.JPG");
  assert_eq!(stored["sizeBytes"], 10);
  assert!(stored["modifiedAtMs"].as_u64().is_some());
}

#[test]
fn closed_or_unknown_photos_cannot_be_saved_or_developed() {
  let temp = TempDir::new("close");
  let photos = camera_photos(&temp);
  let path = temp.file("a.heic", b"heic");
  let (photo_id, _) = photos.open("entry-1", &path).unwrap();
  assert!(photos.open_photo(&photo_id).is_some());
  photos.close(&[photo_id.clone(), "photo-unknown".into()]);
  assert!(photos.open_photo(&photo_id).is_none());
  assert_eq!(
    photos
      .save(&photo_id, &json!({}), 0, SystemTime::now())
      .unwrap_err()
      .code,
    code::NOT_FOUND
  );
  // 写真の状態が分からないときは「保存あり」（crate の約束: signed の新規生成を選ばない）
  assert!(photos.has_saved_settings(&photo_id));
}

#[test]
fn verified_photo_rejects_an_original_replaced_after_opening() {
  let temp = TempDir::new("verified");
  let photos = camera_photos(&temp);
  let path = temp.file("a.jpg", b"first");
  let (photo_id, _) = photos.open("entry-1", &path).unwrap();
  assert!(photos.verified(&photo_id).is_ok());
  fs::write(path, b"second").unwrap();
  assert_eq!(photos.verified(&photo_id).unwrap_err().code, code::NOT_FOUND);
  assert_eq!(photos.verified("photo-unknown").unwrap_err().code, code::NOT_FOUND);
}

#[test]
fn the_oldest_opened_photos_are_closed_over_the_limit() {
  let temp = TempDir::new("limit");
  let photos = camera_photos(&temp);
  let path = temp.file("a.jpg", b"a");
  let (first, _) = photos.open("entry-1", &path).unwrap();
  for index in 0..MAX_OPEN_PHOTOS {
    photos.open(&format!("entry-{index}"), &path).unwrap();
  }
  assert!(photos.get(&first).is_none());
  assert_eq!(photos.lock().photos.len(), MAX_OPEN_PHOTOS);
}

#[test]
fn edits_never_expire_by_age_or_count() {
  let limits = edits_limits();
  assert_eq!(limits.max_entries, usize::MAX);
  assert_eq!(limits.max_age, Duration::MAX);
}

#[test]
fn requests_are_checked() {
  let open = |count: usize| OpenRequest {
    entry_ids: (0..count).map(|index| format!("entry-{index}")).collect(),
  };
  assert!(validate_open_request(&open(1)).is_ok());
  assert!(validate_open_request(&open(MAX_PHOTOS_PER_OPEN)).is_ok());
  assert_eq!(validate_open_request(&open(0)).unwrap_err().code, code::INVALID_REQUEST);
  assert_eq!(
    validate_open_request(&open(MAX_PHOTOS_PER_OPEN + 1)).unwrap_err().code,
    code::INVALID_REQUEST
  );

  let save = |settings: Value| SaveSettingsRequest {
    photo_id: "photo-1".into(),
    develop_settings: settings,
    expected_revision: 0,
  };
  assert!(validate_save_settings_request(&save(json!({ "v": 3 }))).is_ok());
  assert_eq!(
    validate_save_settings_request(&save(json!([]))).unwrap_err().code,
    code::INVALID_REQUEST
  );
  let large = json!({ "x": "a".repeat(MAX_SAVED_SETTINGS_BYTES) });
  assert_eq!(
    validate_save_settings_request(&save(large)).unwrap_err().code,
    code::INVALID_REQUEST
  );
  let unknown_id = SaveSettingsRequest {
    photo_id: String::new(),
    develop_settings: json!({}),
    expected_revision: 0,
  };
  assert_eq!(
    validate_save_settings_request(&unknown_id).unwrap_err().code,
    code::NOT_FOUND
  );
}

#[test]
fn photo_formats() {
  for (name, format) in [
    ("P1.RW2", Some("raw")),
    ("a.JPG", Some("jpeg")),
    ("a.jpeg", Some("jpeg")),
    ("a.png", Some("png")),
    ("a.HEIC", Some("heic")),
    ("a.heif", Some("heic")),
    ("a.tif", Some("tiff")),
    ("a.webp", None),
  ] {
    assert_eq!(photo_format(name), format, "{name}");
  }
}

#[test]
fn listed_photos_show_has_edits_from_the_saved_size_and_modified_time() {
  let temp = TempDir::new("has-edits");
  let photos = camera_photos(&temp);
  let edited = temp.file("SD/P1.RW2", b"raw one");
  let untouched = temp.file("SD/P2.RW2", b"raw two");
  let (photo_id, photo) = photos.open("entry-1", &edited).unwrap();
  let modified_at = |path: &Path| iso8601_utc(std::fs::metadata(path).unwrap().modified().unwrap());
  let entry = |name: &str, path: &Path, size: u64| json!({ "entryId": name, "fileName": name, "kind": "raw", "sizeBytes": size, "modifiedAt": modified_at(path) });
  let mut tree = json!({
    "folderId": "folder-1", "name": "SD", "truncated": false,
    "photos": [entry("P1.RW2", &edited, 7)],
    "children": [{ "folderId": "folder-2", "name": "sub", "truncated": false, "children": [], "photos": [entry("P2.RW2", &untouched, 7)] }],
  });
  // 保存する前（索引を作ったあと）
  photos.annotate_has_edits(&mut tree);
  assert_eq!(tree["photos"][0]["hasEdits"], false);
  assert_eq!(photo.digest.size_bytes, 7);
  photos
    .save(&photo_id, &json!({ "exposure": 1 }), 0, SystemTime::now())
    .unwrap();
  photos.annotate_has_edits(&mut tree);
  assert_eq!(tree["photos"][0]["hasEdits"], true, "保存したら一覧に出る");
  // 大きさと更新時刻が同じ別の写真（同じミリ秒に書いた 7 バイト）には付けない
  assert_eq!(tree["children"][0]["photos"][0]["hasEdits"], false);

  // 次の起動（記録から索引を作る）。覚えた写真の一覧の形でも付く
  let restarted = camera_photos(&temp);
  let mut remembered = json!({ "folders": [tree.clone()], "photos": [entry("P1.RW2", &edited, 7)] });
  restarted.annotate_has_edits(&mut remembered);
  assert_eq!(remembered["photos"][0]["hasEdits"], true);
  assert_eq!(remembered["folders"][0]["photos"][0]["hasEdits"], true);
}
