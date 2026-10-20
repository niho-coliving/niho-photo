use super::*;
use std::sync::atomic::{AtomicU64, Ordering};

const DAY: Duration = Duration::from_secs(24 * 60 * 60);

/// テストごとの一時フォルダ（Drop で消す）。本物のアプリのデータには触れない。
struct TempDir(PathBuf);

impl TempDir {
  fn new(name: &str) -> Self {
    static COUNTER: AtomicU64 = AtomicU64::new(1);
    let dir = std::env::temp_dir().join(format!(
      "niho-photo-saved-settings-{name}-{}-{}",
      std::process::id(),
      COUNTER.fetch_add(1, Ordering::SeqCst)
    ));
    let _ = fs::remove_dir_all(&dir);
    fs::create_dir_all(&dir).unwrap();
    Self(dir)
  }
}

impl Drop for TempDir {
  fn drop(&mut self) {
    let _ = fs::remove_dir_all(&self.0);
  }
}

fn key(fill: char) -> String {
  fill.to_string().repeat(64)
}

fn store(dir: &Path, limits: StoreLimits) -> SavedSettingsStore {
  SavedSettingsStore::new(dir.join("settings"), limits)
}

fn set_modified(path: &Path, time: SystemTime) {
  fs::File::options()
    .write(true)
    .open(path)
    .unwrap()
    .set_modified(time)
    .unwrap();
}

fn names(dir: &Path) -> Vec<String> {
  let mut names: Vec<String> = fs::read_dir(dir)
    .unwrap()
    .map(|entry| entry.unwrap().file_name().to_string_lossy().into_owned())
    .collect();
  names.sort();
  names
}

#[test]
fn content_keys_are_the_sha256_of_the_bytes_whatever_the_name() {
  let temp = TempDir::new("content-key");
  let a = temp.0.join("P1524180.RW2");
  let b = temp.0.join("renamed copy.RW2");
  fs::write(&a, b"abc").unwrap();
  fs::write(&b, b"abc").unwrap();
  // SHA-256("abc")（FIPS 180-2 の例）
  let expected = "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad";
  assert_eq!(
    content_digest(&a).unwrap(),
    ContentDigest {
      key: expected.to_string(),
      size_bytes: 3
    }
  );
  assert_eq!(content_digest(&b).unwrap().key, expected);
  let empty = temp.0.join("empty.jpg");
  fs::write(&empty, b"").unwrap();
  assert_eq!(
    content_digest(&empty).unwrap(),
    ContentDigest {
      key: concat!("e3b0c44298fc1c149afbf4c8996fb924", "27ae41e4649b934ca495991b7852b855").to_string(),
      size_bytes: 0
    }
  );
  // 読み込みの区切り（1MB）をまたぐ大きさでも、まとめて計算したときと同じ。大きさは読んだバイト数
  let large = temp.0.join("large.RW2");
  let bytes: Vec<u8> = (0..(HASH_BUFFER_BYTES * 2 + 17))
    .map(|index| (index % 251) as u8)
    .collect();
  fs::write(&large, &bytes).unwrap();
  let whole: String = Sha256::digest(&bytes)
    .iter()
    .map(|byte| format!("{byte:02x}"))
    .collect();
  assert_eq!(hex_lower(&Sha256::digest(&bytes)), whole);
  assert_eq!(
    content_digest(&large).unwrap(),
    ContentDigest {
      key: whole.clone(),
      size_bytes: bytes.len() as u64
    }
  );
  assert!(is_content_key(&whole));
}

#[test]
fn content_keys_need_a_readable_regular_file() {
  let temp = TempDir::new("content-key-errors");
  assert!(content_digest(&temp.0.join("missing.RW2")).is_err());
  assert!(content_digest(&temp.0).is_err(), "a folder is not a photo");
}

#[test]
fn keys_that_are_not_sha256_hex_never_touch_the_disk() {
  let temp = TempDir::new("bad-keys");
  let store = store(&temp.0, StoreLimits::default());
  for bad in [
    "../../escape",
    "",
    &"A".repeat(64),
    &"g".repeat(64),
    &"a".repeat(63),
    &"a".repeat(65),
  ] {
    assert!(!is_content_key(bad), "{bad}");
    assert!(store.load(bad).is_none());
    assert!(
      store.contains_record(bad),
      "unknown key denies signed eligibility: {bad}"
    );
    assert!(store.save(bad, "x.jpg", &json!({}), SystemTime::now()).is_err());
    assert!(store.forget(bad).is_err());
  }
  assert!(!temp.0.join("settings").exists());
  assert!(is_content_key(&key('0')) && is_content_key(&key('f')));
}

#[test]
fn record_presence_is_false_only_when_the_valid_record_path_is_not_found() {
  let temp = TempDir::new("record-presence");
  let store = store(&temp.0, StoreLimits::default());
  let missing = key('1');
  assert!(!store.contains_record(&missing));

  let dir = temp.0.join("settings");
  fs::create_dir_all(&dir).unwrap();
  let broken = key('2');
  fs::write(dir.join(format!("{broken}.json")), b"not json").unwrap();
  assert!(store.contains_record(&broken));

  let non_regular = key('3');
  fs::create_dir(dir.join(format!("{non_regular}.json"))).unwrap();
  assert!(store.contains_record(&non_regular));

  #[cfg(unix)]
  {
    use std::os::unix::fs::symlink;
    let linked = key('4');
    symlink(dir.join("missing-target"), dir.join(format!("{linked}.json"))).unwrap();
    assert!(store.contains_record(&linked));
  }
}

#[test]
fn save_load_and_forget_round_trip() {
  let temp = TempDir::new("round-trip");
  let store = store(&temp.0, StoreLimits::default());
  let photo = key('a');
  assert!(store.load(&photo).is_none());
  store
    .save(&photo, "P1.RW2", &json!({ "exposure": 0.4 }), SystemTime::now())
    .unwrap();
  assert_eq!(store.load(&photo), Some(json!({ "exposure": 0.4 })));
  store
    .save(&photo, "P1.RW2", &json!({ "exposure": -1 }), SystemTime::now())
    .unwrap();
  assert_eq!(store.load(&photo), Some(json!({ "exposure": -1 })));
  assert_eq!(names(&temp.0.join("settings")), vec![format!("{photo}.json")]);
  store.forget(&photo).unwrap();
  assert!(store.load(&photo).is_none());
  // 無いものを消しても成功
  store.forget(&photo).unwrap();
  store.forget(&key('b')).unwrap();
}

#[test]
fn the_record_keeps_the_settings_the_update_time_and_the_file_name() {
  let temp = TempDir::new("record");
  let store = store(&temp.0, StoreLimits::default());
  let photo = key('c');
  let at = UNIX_EPOCH + Duration::from_millis(1_790_000_000_123);
  store
    .save(&photo, "DSC02072.JPG", &json!({ "exposure": 1 }), at)
    .unwrap();
  let record: Value =
    serde_json::from_slice(&fs::read(temp.0.join("settings").join(format!("{photo}.json"))).unwrap()).unwrap();
  assert_eq!(
    record,
    json!({ "version": 1, "fileName": "DSC02072.JPG", "updatedAtMs": 1_790_000_000_123u64, "settings": { "exposure": 1 } })
  );
}

#[test]
fn a_failed_write_keeps_the_previous_record() {
  let temp = TempDir::new("failed-write");
  let store = store(&temp.0, StoreLimits::default());
  let photo = key('d');
  store
    .save(&photo, "P1.RW2", &json!({ "exposure": 0.5 }), SystemTime::now())
    .unwrap();
  // 一時ファイルの場所をフォルダで塞ぐと書き込みは失敗するが、前の内容は壊れない
  let temp_file = temp.0.join("settings").join(format!("{photo}.json.tmp"));
  fs::create_dir_all(&temp_file).unwrap();
  assert!(store
    .save(&photo, "P1.RW2", &json!({ "exposure": 2 }), SystemTime::now())
    .is_err());
  assert_eq!(store.load(&photo), Some(json!({ "exposure": 0.5 })));
}

#[test]
fn sweep_removes_entries_older_than_the_max_age_then_the_oldest_over_the_cap() {
  let temp = TempDir::new("sweep");
  let limits = StoreLimits {
    max_entries: 3,
    max_age: 10 * DAY,
    sweep_interval: DAY,
  };
  let store = store(&temp.0, limits);
  let now = SystemTime::now();
  let dir = temp.0.join("settings");
  // 最終更新が 1 日前〜6 日前の 6 件と、10 日を過ぎた 2 件
  for (fill, days) in [
    ('1', 1),
    ('2', 2),
    ('3', 3),
    ('4', 4),
    ('5', 5),
    ('6', 6),
    ('7', 11),
    ('8', 30),
  ] {
    store.save(&key(fill), "x.jpg", &json!({}), now).unwrap();
    set_modified(&dir.join(format!("{}.json", key(fill))), now - days * DAY);
  }
  // キーの形でないファイルには触れない。途中で落ちた古い一時ファイルは消す
  fs::write(dir.join("notes.txt"), b"keep").unwrap();
  fs::write(dir.join(".DS_Store"), b"keep").unwrap();
  let orphan = dir.join(format!("{}.json.tmp", key('9')));
  fs::write(&orphan, b"{").unwrap();
  set_modified(&orphan, now - DAY);
  let writing = dir.join(format!("{}.json.tmp", key('0')));
  fs::write(&writing, b"{").unwrap();

  // 10 日を過ぎた 2 件と古い一時ファイル 1 件、上限 3 件を超えた古い 3 件（4〜6 日前）
  assert_eq!(store.sweep(now), 6);
  let mut expected: Vec<String> = ['1', '2', '3']
    .iter()
    .map(|fill| format!("{}.json", key(*fill)))
    .collect();
  expected.push(format!("{}.json.tmp", key('0')));
  expected.push(".DS_Store".to_string());
  expected.push("notes.txt".to_string());
  expected.sort();
  assert_eq!(names(&dir), expected);
}

#[test]
fn saves_sweep_on_the_first_save_and_then_once_per_interval() {
  let temp = TempDir::new("sweep-interval");
  let limits = StoreLimits {
    max_entries: 100,
    max_age: 10 * DAY,
    sweep_interval: Duration::from_secs(1),
  };
  let store = store(&temp.0, limits);
  let dir = temp.0.join("settings");
  let plant_stale = |fill: char| {
    let path = dir.join(format!("{}.json", key(fill)));
    fs::create_dir_all(&dir).unwrap();
    fs::write(&path, b"{}").unwrap();
    set_modified(&path, SystemTime::now() - 20 * DAY);
    path
  };
  let first_stale = plant_stale('1');
  assert_eq!(
    store.save(&key('a'), "a.jpg", &json!({}), SystemTime::now()).unwrap(),
    Some(1)
  );
  assert!(!first_stale.exists());
  let second_stale = plant_stale('2');
  assert_eq!(
    store.save(&key('a'), "a.jpg", &json!({}), SystemTime::now()).unwrap(),
    None
  );
  assert!(second_stale.exists(), "not swept again before the interval");
  std::thread::sleep(Duration::from_millis(1100));
  assert_eq!(
    store.save(&key('b'), "b.jpg", &json!({}), SystemTime::now()).unwrap(),
    Some(1)
  );
  assert!(!second_stale.exists());
  // 保存したばかりのものは消えない
  assert!(store.load(&key('a')).is_some() && store.load(&key('b')).is_some());
}

#[test]
fn records_that_are_broken_unknown_or_too_large_are_not_loaded() {
  let temp = TempDir::new("broken");
  let store = store(&temp.0, StoreLimits::default());
  let dir = temp.0.join("settings");
  fs::create_dir_all(&dir).unwrap();
  let photo = key('e');
  let path = dir.join(format!("{photo}.json"));
  let too_large =
    serde_json::to_vec(&json!({ "version": 1, "settings": { "blob": "x".repeat(MAX_RECORD_BYTES as usize) } }))
      .unwrap();
  for body in [
    b"not json".to_vec(),
    b"[]".to_vec(),
    br#"{"version":"1","settings":{}}"#.to_vec(),
    br#"{"version":1,"settings":null}"#.to_vec(),
    br#"{"version":1,"settings":[1,2]}"#.to_vec(),
    too_large,
  ] {
    fs::write(&path, &body).unwrap();
    assert!(
      store.load(&photo).is_none(),
      "{}",
      String::from_utf8_lossy(&body[..body.len().min(40)])
    );
  }
  // フォルダが同じ名前で置かれていても読まない
  fs::remove_file(&path).unwrap();
  fs::create_dir_all(&path).unwrap();
  assert!(store.load(&photo).is_none());
}
