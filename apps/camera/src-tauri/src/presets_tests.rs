use super::*;
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::{Duration, UNIX_EPOCH};

struct TempDir(PathBuf);

impl TempDir {
  fn new(name: &str) -> Self {
    static COUNTER: AtomicU64 = AtomicU64::new(1);
    let dir = std::env::temp_dir().join(format!(
      "niho-camera-presets-{name}-{}-{}",
      std::process::id(),
      COUNTER.fetch_add(1, Ordering::SeqCst)
    ));
    let _ = fs::remove_dir_all(&dir);
    Self(dir)
  }
}

impl Drop for TempDir {
  fn drop(&mut self) {
    let _ = fs::remove_dir_all(&self.0);
  }
}

const XMP: &str = r#"<x:xmpmeta xmlns:x="adobe:ns:meta/"><rdf:RDF/></x:xmpmeta>"#;

fn at(ms: u64) -> SystemTime {
  UNIX_EPOCH + Duration::from_millis(ms)
}

#[test]
fn presets_are_kept_in_creation_order_and_survive_a_restart() {
  let temp = TempDir::new("order");
  let store = PresetStore::new(temp.0.join(PRESETS_DIR_NAME));
  assert!(store.list().is_empty(), "置き場が無ければ空");
  let evening = store.create("  夕方  ", XMP, PresetSource::Xmp, at(2_000)).unwrap();
  let morning = store.create("朝", XMP, PresetSource::User, at(1_000)).unwrap();
  assert_eq!(evening.name, "夕方");
  let names: Vec<String> = PresetStore::new(temp.0.join(PRESETS_DIR_NAME))
    .list()
    .into_iter()
    .map(|preset| preset.name)
    .collect();
  assert_eq!(names, ["朝", "夕方"]);
  assert_eq!(morning.to_json()["source"], "user");
  assert_eq!(evening.to_json()["xmp"], XMP);
  assert_eq!(evening.to_json()["createdAt"], "1970-01-01T00:00:02.000Z");
  // 置き場は利用者だけが開ける
  use std::os::unix::fs::PermissionsExt;
  assert_eq!(
    fs::metadata(temp.0.join(PRESETS_DIR_NAME))
      .unwrap()
      .permissions()
      .mode()
      & 0o777,
    0o700
  );
  let file = temp.0.join(PRESETS_DIR_NAME).join(format!("{}.json", evening.id));
  assert_eq!(fs::metadata(&file).unwrap().permissions().mode() & 0o777, 0o600);
  let record: Value = serde_json::from_slice(&fs::read(file).unwrap()).unwrap();
  assert_eq!(record["createdAt"], "1970-01-01T00:00:02.000Z");
  assert!(record.get("createdAtMs").is_none());
}

#[test]
fn names_are_unique_after_trimming_and_renames_keep_them_unique() {
  let temp = TempDir::new("names");
  let store = PresetStore::new(temp.0.join(PRESETS_DIR_NAME));
  let first = store.create("夕方", XMP, PresetSource::Xmp, at(1)).unwrap();
  let second = store.create("夜", XMP, PresetSource::Xmp, at(2)).unwrap();
  assert_eq!(
    store.create(" 夕方 ", XMP, PresetSource::Xmp, at(3)).unwrap_err().code,
    preset_code::NAME_TAKEN
  );
  assert_eq!(
    store.rename(&second.id, "夕方").unwrap_err().code,
    preset_code::NAME_TAKEN
  );
  // 自分の名前のままの名前の変更は通る
  assert_eq!(store.rename(&first.id, "夕方").unwrap().name, "夕方");
  assert_eq!(store.rename(&second.id, "夜の街").unwrap().name, "夜の街");
  assert_eq!(store.rename("preset-unknown", "x").unwrap_err().code, code::NOT_FOUND);
  store.delete(&second.id).unwrap();
  assert_eq!(store.delete(&second.id).unwrap_err().code, code::NOT_FOUND);
  assert_eq!(
    store.delete("../edits/x").unwrap_err().code,
    code::NOT_FOUND,
    "ID の形でないものは消さない"
  );
  assert_eq!(store.list().len(), 1);
}

#[test]
fn names_and_xmp_are_checked_like_the_api() {
  assert!(normalize_name(&"あ".repeat(PRESET_NAME_MAX_CHARS)).is_ok());
  for name in ["", "   ", "a\nb"] {
    assert_eq!(
      normalize_name(name).unwrap_err().code,
      code::INVALID_REQUEST,
      "{name:?}"
    );
  }
  assert_eq!(
    normalize_name(&"あ".repeat(PRESET_NAME_MAX_CHARS + 1))
      .unwrap_err()
      .code,
    code::INVALID_REQUEST
  );
  assert!(check_xmp(XMP).is_ok());
  assert_eq!(check_xmp("<rdf:RDF/>").unwrap_err().code, code::PRESET_INVALID);
  let large = format!("{XMP}{}", " ".repeat(PRESET_XMP_MAX_BYTES));
  assert_eq!(check_xmp(&large).unwrap_err().code, code::INVALID_REQUEST);
}

#[test]
fn broken_records_are_skipped_without_being_removed() {
  let temp = TempDir::new("broken");
  let dir = temp.0.join(PRESETS_DIR_NAME);
  let store = PresetStore::new(dir.clone());
  store.create("夕方", XMP, PresetSource::Xmp, at(1)).unwrap();
  fs::write(dir.join("preset-broken.json"), b"{not json").unwrap();
  fs::write(
    dir.join("preset-other.json"),
    br#"{"version":1,"id":"preset-mismatch","name":"x","xmp":"x:xmpmeta"}"#,
  )
  .unwrap();
  assert_eq!(store.list().len(), 1);
  assert!(dir.join("preset-broken.json").exists());
}

#[test]
fn legacy_millisecond_timestamps_remain_readable() {
  let temp = TempDir::new("legacy-timestamp");
  let dir = temp.0.join(PRESETS_DIR_NAME);
  fs::create_dir_all(&dir).unwrap();
  fs::write(
    dir.join("preset-legacy.json"),
    br#"{"version":1,"id":"preset-legacy","name":"legacy","xmp":"<x:xmpmeta/>","source":"xmp","createdAtMs":2000}"#,
  )
  .unwrap();
  let preset = PresetStore::new(dir).list().pop().unwrap();
  assert_eq!(preset.to_json()["createdAt"], "1970-01-01T00:00:02.000Z");
}

#[test]
fn the_number_of_presets_is_capped() {
  let temp = TempDir::new("cap");
  let store = PresetStore::new(temp.0.join(PRESETS_DIR_NAME));
  for index in 0..MAX_PRESETS {
    store
      .create(&format!("p{index}"), XMP, PresetSource::Xmp, at(index as u64))
      .unwrap();
  }
  assert_eq!(
    store
      .create("one more", XMP, PresetSource::Xmp, at(9_999))
      .unwrap_err()
      .code,
    code::INVALID_REQUEST
  );
}
