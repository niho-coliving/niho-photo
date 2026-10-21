//! 選別のフラグの置き場（{@link FlagStore}。niho-photo#47）のテスト。

use super::*;
use crate::saved_settings::temp_path;
use crate::test_support::library::{entry_id, Fixture};
use crate::test_support::set_modified;
use std::os::unix::fs::{symlink, PermissionsExt};
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::Duration;

/// テストごとの一時フォルダ（Drop で消す）。本物のアプリのデータには触れない。
struct TempDir(PathBuf);

impl TempDir {
  fn new(name: &str) -> Self {
    static COUNTER: AtomicU64 = AtomicU64::new(1);
    let dir = std::env::temp_dir().join(format!(
      "niho-photo-saved-flags-{name}-{}-{}",
      std::process::id(),
      COUNTER.fetch_add(1, Ordering::SeqCst)
    ));
    let _ = fs::remove_dir_all(&dir);
    fs::create_dir_all(&dir).unwrap();
    Self(dir)
  }

  /// 置き場のファイル（`<app data>/photo-editing/flags.json`）。
  fn file(&self) -> PathBuf {
    flags_path(&self.0.join("app-data"))
  }

  fn store(&self, limits: FlagLimits) -> FlagStore {
    FlagStore::new(self.file(), limits)
  }

  fn record(&self) -> Value {
    serde_json::from_slice(&fs::read(self.file()).unwrap()).unwrap()
  }

  /// 置き場のファイルを直接書く（途中のフォルダも作る）。
  fn write(&self, body: &[u8]) {
    fs::create_dir_all(self.file().parent().unwrap()).unwrap();
    fs::write(self.file(), body).unwrap();
  }
}

impl Drop for TempDir {
  fn drop(&mut self) {
    let _ = fs::remove_dir_all(&self.0);
  }
}

fn at(millis: u64) -> SystemTime {
  UNIX_EPOCH + Duration::from_millis(millis)
}

fn key(fill: char) -> String {
  fill.to_string().repeat(64)
}

fn mode(path: &Path) -> u32 {
  fs::metadata(path).unwrap().permissions().mode() & 0o777
}

#[test]
fn flags_round_trip_in_a_private_file_without_names_or_paths() {
  let temp = TempDir::new("round-trip");
  let store = temp.store(FlagLimits::default());
  assert!(store.is_empty());
  assert!(!temp.file().exists(), "読むだけでは作らない");

  let picked = flag_key("P1000001.RW2", 25_000_000, "2026-10-01T01:02:03.000Z");
  let rejected = flag_key("P1000002.RW2", 25_000_000, "2026-10-01T01:02:05.000Z");
  store
    .set(std::slice::from_ref(&picked), Some(PhotoFlag::Pick), at(1_000))
    .unwrap();
  store
    .set(std::slice::from_ref(&rejected), Some(PhotoFlag::Reject), at(2_000))
    .unwrap();
  assert_eq!(store.get(&picked), Some(PhotoFlag::Pick));
  assert_eq!(store.get(&rejected), Some(PhotoFlag::Reject));
  assert_eq!(store.get(&key('a')), None);

  // 形と権限（フォルダ 0700・ファイル 0600）。名前・パスは残さない
  assert_eq!(
    temp.record(),
    json!({
      "version": 1,
      "flags": {
        picked.clone(): { "flag": "pick", "updatedAtMs": 1_000 },
        rejected.clone(): { "flag": "reject", "updatedAtMs": 2_000 },
      },
    })
  );
  assert_eq!(mode(&temp.file()), 0o600);
  assert_eq!(mode(temp.file().parent().unwrap()), 0o700);
  let text = fs::read_to_string(temp.file()).unwrap();
  assert!(!text.contains("P1000001") && !text.contains(temp.0.to_str().unwrap()));
  assert!(!temp_path(&temp.file()).exists(), "一時ファイルを残さない");

  // 次の起動（ファイルから読む）。外すと記録から消える
  let restarted = temp.store(FlagLimits::default());
  assert_eq!(restarted.get(&picked), Some(PhotoFlag::Pick));
  assert_eq!(restarted.get(&rejected), Some(PhotoFlag::Reject));
  restarted.set(std::slice::from_ref(&picked), None, at(3_000)).unwrap();
  assert_eq!(restarted.get(&picked), None);
  assert_eq!(restarted.len(), 1);
  assert!(temp.record()["flags"].get(&picked).is_none());
}

#[test]
fn setting_the_same_flag_again_does_not_rewrite_the_file() {
  let temp = TempDir::new("same");
  let store = temp.store(FlagLimits::default());
  let keys = [key('a'), key('b')];
  store.set(&keys, Some(PhotoFlag::Pick), at(1_000)).unwrap();
  set_modified(&temp.file(), at(5_000));
  // 同じフラグ（付けた時刻も変えない）・付いていない写真を外すのは書かない
  store.set(&keys, Some(PhotoFlag::Pick), at(9_000)).unwrap();
  store.set(&[key('c')], None, at(9_000)).unwrap();
  assert_eq!(fs::metadata(temp.file()).unwrap().modified().unwrap(), at(5_000));
  assert_eq!(temp.record()["flags"][key('a')]["updatedAtMs"], 1_000);
  // 採用から却下へは付け替える
  store.set(&keys[..1], Some(PhotoFlag::Reject), at(9_000)).unwrap();
  assert_eq!(
    temp.record()["flags"][key('a')],
    json!({ "flag": "reject", "updatedAtMs": 9_000 })
  );
}

#[test]
fn keys_must_be_lowercase_hex_and_a_bad_key_writes_nothing() {
  let temp = TempDir::new("bad-key");
  let store = temp.store(FlagLimits::default());
  for bad in ["", "../flags", &"A".repeat(64), &"a".repeat(63)] {
    let err = store
      .set(&[key('a'), bad.to_string()], Some(PhotoFlag::Pick), at(1))
      .unwrap_err();
    assert_eq!(err.kind(), io::ErrorKind::InvalidInput, "{bad:?}");
  }
  assert!(!temp.file().exists());
  assert_eq!(store.get(&key('a')), None);
}

#[test]
fn a_failed_write_keeps_the_previous_flags() {
  let temp = TempDir::new("write-fails");
  // 置き場のフォルダ（photo-editing）の場所にファイルがあると書けない
  fs::create_dir_all(temp.0.join("app-data")).unwrap();
  fs::write(temp.file().parent().unwrap(), b"not a folder").unwrap();
  let store = temp.store(FlagLimits::default());
  assert!(store.set(&[key('a')], Some(PhotoFlag::Pick), at(1)).is_err());
  assert_eq!(store.get(&key('a')), None, "書けなければ覚えた内容も変えない");
}

#[test]
fn broken_unknown_or_too_large_files_and_symlinks_mean_no_flags_and_are_overwritten() {
  let temp = TempDir::new("broken");
  let valid = json!({ "version": 1, "flags": { key('a'): { "flag": "pick", "updatedAtMs": 1 } } });
  let mut too_large = serde_json::to_vec(&valid).unwrap();
  too_large.truncate(too_large.len() - 1);
  too_large.extend(format!(",\"padding\":\"{}\"}}", "x".repeat(MAX_FLAGS_FILE_BYTES as usize)).as_bytes());
  assert!(serde_json::from_slice::<Value>(&too_large).is_ok());
  for body in [
    b"{ not json".to_vec(),
    serde_json::to_vec(&json!({ "version": 2, "flags": valid["flags"] })).unwrap(),
    serde_json::to_vec(&json!({ "version": 1, "flags": [] })).unwrap(),
    serde_json::to_vec(&json!({ "version": 1 })).unwrap(),
    too_large,
  ] {
    temp.write(&body);
    let store = temp.store(FlagLimits::default());
    assert!(
      store.is_empty(),
      "{}",
      String::from_utf8_lossy(&body[..body.len().min(80)])
    );
    store.set(&[key('b')], Some(PhotoFlag::Reject), at(2)).unwrap();
    assert_eq!(
      temp.record(),
      json!({ "version": 1, "flags": { key('b'): { "flag": "reject", "updatedAtMs": 2 } } })
    );
  }

  // シンボリックリンクはたどらず、次に付けるときにふつうのファイルに置き換える（指す先は書き換えない）
  let elsewhere = temp.0.join("elsewhere.json");
  fs::write(&elsewhere, serde_json::to_vec(&valid).unwrap()).unwrap();
  fs::remove_file(temp.file()).unwrap();
  symlink(&elsewhere, temp.file()).unwrap();
  let store = temp.store(FlagLimits::default());
  assert_eq!(store.get(&key('a')), None);
  store.set(&[key('c')], Some(PhotoFlag::Pick), at(3)).unwrap();
  assert!(fs::symlink_metadata(temp.file()).unwrap().is_file());
  assert_eq!(
    serde_json::from_slice::<Value>(&fs::read(&elsewhere).unwrap()).unwrap(),
    valid
  );
}

#[test]
fn malformed_entries_are_skipped() {
  let temp = TempDir::new("entries");
  temp.write(
    &serde_json::to_vec(&json!({
      "version": 1,
      "flags": {
        key('a'): { "flag": "pick", "updatedAtMs": 1 },
        key('b'): { "flag": "star" },
        key('c'): "pick",
        "not-a-key": { "flag": "reject", "updatedAtMs": 1 },
        "A".repeat(64): { "flag": "reject", "updatedAtMs": 1 },
        key('d'): { "flag": "reject" },
      },
    }))
    .unwrap(),
  );
  let store = temp.store(FlagLimits::default());
  assert_eq!(store.len(), 2);
  assert_eq!(store.get(&key('a')), Some(PhotoFlag::Pick));
  // 付けた時刻の無い項目は 0（上限を超えたら先に消える）
  assert_eq!(store.get(&key('d')), Some(PhotoFlag::Reject));
}

#[test]
fn over_the_limit_the_oldest_flags_go_first() {
  let temp = TempDir::new("limit");
  let store = temp.store(FlagLimits { max_flags: 3 });
  store.set(&[key('a')], Some(PhotoFlag::Pick), at(1)).unwrap();
  store.set(&[key('b')], Some(PhotoFlag::Reject), at(2)).unwrap();
  store.set(&[key('c')], Some(PhotoFlag::Pick), at(3)).unwrap();
  store.set(&[key('d'), key('e')], Some(PhotoFlag::Pick), at(4)).unwrap();
  assert_eq!(store.len(), 3);
  assert_eq!(store.get(&key('a')), None);
  assert_eq!(store.get(&key('b')), None);
  for fill in ['c', 'd', 'e'] {
    assert!(store.get(&key(fill)).is_some(), "{fill}");
  }
  // 上限より多いファイルは新しいものから読む
  let small = temp.store(FlagLimits { max_flags: 2 });
  assert_eq!(small.len(), 2);
  assert_eq!(small.get(&key('c')), None);
}

#[test]
fn the_key_is_the_listed_name_size_and_modified_time() {
  let base = flag_key("IMG_0001.JPG", 100, "2026-10-01T00:00:00.000Z");
  assert!(is_content_key(&base));
  assert_eq!(base, flag_key("IMG_0001.JPG", 100, "2026-10-01T00:00:00.000Z"));
  for other in [
    flag_key("IMG_0002.JPG", 100, "2026-10-01T00:00:00.000Z"),
    flag_key("IMG_0001.JPG", 101, "2026-10-01T00:00:00.000Z"),
    flag_key("IMG_0001.JPG", 100, "2026-10-01T00:00:00.001Z"),
    // 区切りで名前と大きさが混ざらない
    flag_key("IMG_0001.JPG1", 0, "2026-10-01T00:00:00.000Z"),
  ] {
    assert_ne!(base, other);
  }
}

#[test]
fn the_key_of_a_file_matches_its_folder_listing_and_a_replaced_photo_gets_a_new_key() {
  let fixture = Fixture::new("flag-key");
  let path = fixture.file("DCIM/P1000001.JPG");
  set_modified(&path, at(1_700_000_000_123));
  let library = fixture.library();
  let folder = library.add_folder(&fixture.root().join("DCIM")).unwrap();
  let listed = &folder["photos"][0];
  let listed_key = flag_key(
    listed["fileName"].as_str().unwrap(),
    listed["sizeBytes"].as_u64().unwrap(),
    listed["modifiedAt"].as_str().unwrap(),
  );
  assert_eq!(flag_key_for_file(&path), Some(listed_key.clone()));
  assert!(library.entry_path(&entry_id(&folder, "P1000001.JPG")).is_some());

  let temp = TempDir::new("orphan");
  let store = temp.store(FlagLimits::default());
  store
    .set(std::slice::from_ref(&listed_key), Some(PhotoFlag::Reject), at(1))
    .unwrap();

  // 消した写真（孤児）: 同じ名前・同じ大きさで撮り直した別の写真には付かない（更新日時が違う）
  fs::remove_file(&path).unwrap();
  assert_eq!(flag_key_for_file(&path), None);
  let replaced = fixture.file("DCIM/P1000001.JPG");
  set_modified(&replaced, at(1_800_000_000_000));
  let replaced_key = flag_key_for_file(&replaced).unwrap();
  assert_ne!(replaced_key, listed_key);
  assert_eq!(store.get(&replaced_key), None);

  // フォルダ・シンボリックリンクは鍵にしない
  assert_eq!(flag_key_for_file(&fixture.root().join("DCIM")), None);
  let link = fixture.root().join("link.jpg");
  symlink(&replaced, &link).unwrap();
  assert_eq!(flag_key_for_file(&link), None);
}
