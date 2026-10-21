//! 補正の版（{@link SavedSettingsStore::save_versions}。niho-photo#42）のテスト。

use super::*;
use crate::saved_settings::{temp_path, StoreLimits};
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::{Duration, UNIX_EPOCH};

const DAY: Duration = Duration::from_secs(24 * 60 * 60);

/// テストごとの一時フォルダ（Drop で消す）。本物のアプリのデータには触れない。
struct TempDir(PathBuf);

impl TempDir {
  fn new(name: &str) -> Self {
    static COUNTER: AtomicU64 = AtomicU64::new(1);
    let dir = std::env::temp_dir().join(format!(
      "niho-photo-saved-versions-{name}-{}-{}",
      std::process::id(),
      COUNTER.fetch_add(1, Ordering::SeqCst)
    ));
    let _ = fs::remove_dir_all(&dir);
    fs::create_dir_all(&dir).unwrap();
    Self(dir)
  }

  fn settings_dir(&self) -> PathBuf {
    self.0.join("settings")
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

fn store(temp: &TempDir, limits: StoreLimits) -> SavedSettingsStore {
  SavedSettingsStore::new(temp.settings_dir(), limits)
}

fn version(id: &str, name: &str, kind: &str, exposure: f64) -> Value {
  json!({
    "id": id,
    "name": name,
    "createdAt": "2026-10-21T01:32:00.000Z",
    "kind": kind,
    "developSettings": { "v": 1, "engine": "niho-10", "base": null, "exposure": exposure },
  })
}

fn names(dir: &Path) -> Vec<String> {
  let mut names: Vec<String> = fs::read_dir(dir)
    .unwrap()
    .map(|entry| entry.unwrap().file_name().to_string_lossy().into_owned())
    .collect();
  names.sort();
  names
}

fn set_modified(path: &Path, time: SystemTime) {
  fs::File::options()
    .write(true)
    .open(path)
    .unwrap()
    .set_modified(time)
    .unwrap();
}

#[cfg(unix)]
fn mode(path: &Path) -> u32 {
  use std::os::unix::fs::PermissionsExt;
  fs::metadata(path).unwrap().permissions().mode() & 0o777
}

#[test]
fn versions_round_trip_with_a_revision_in_their_own_private_file() {
  let temp = TempDir::new("round-trip");
  let store = store(&temp, StoreLimits::default());
  let photo = key('a');
  assert!(store.load_versions(&photo).is_none(), "版のファイルが無ければ版なし");
  let first = json!([version("v1", "明るめ", "named", 0.5)]);
  let at = UNIX_EPOCH + Duration::from_millis(1_790_000_000_123);
  assert_eq!(
    store.save_versions(&photo, &first, 0, at).unwrap(),
    SaveRevision::Saved {
      revision: 1,
      swept: None
    }
  );
  assert_eq!(
    store.load_versions(&photo),
    Some(SavedVersions {
      versions: first.clone(),
      revision: 1,
      updated_at_ms: 1_790_000_000_123
    })
  );
  let second = json!([
    version("v1", "明るめ", "named", 0.5),
    version("a1", "自動の版 10:32", "auto", 0.0)
  ]);
  assert_eq!(
    store.save_versions(&photo, &second, 1, SystemTime::now()).unwrap(),
    SaveRevision::Saved {
      revision: 2,
      swept: None
    }
  );
  // 画面が知っている版と違えば書かない
  assert_eq!(
    store.save_versions(&photo, &first, 1, SystemTime::now()).unwrap(),
    SaveRevision::Conflict { current: 2 }
  );
  assert_eq!(store.load_versions(&photo).unwrap().versions, second);

  // 補正の記録（<キー>.json）は作らない・触れない。置き場は 0700、ファイルは 0600
  let dir = temp.settings_dir();
  assert_eq!(names(&dir), vec![format!("{photo}.versions.json")]);
  assert!(store.load(&photo).is_none());
  #[cfg(unix)]
  {
    assert_eq!(mode(&dir), 0o700);
    assert_eq!(mode(&dir.join(format!("{photo}.versions.json"))), 0o600);
  }
  let stored: Value = serde_json::from_slice(&fs::read(dir.join(format!("{photo}.versions.json"))).unwrap()).unwrap();
  assert_eq!(stored["version"], 1);
  assert_eq!(stored["revision"], 2);
  assert_eq!(stored["versions"], second);
  assert!(!stored.to_string().contains(temp.0.to_str().unwrap()), "パスを残さない");
}

#[test]
fn versions_live_beside_the_record_and_an_old_niho_never_touches_them() {
  let temp = TempDir::new("beside");
  let store = store(&temp, StoreLimits::default());
  let photo = key('b');
  // 旧版の NIHO と同じ書き方で補正を保存する（記録は組み立て直して書く）
  store
    .save(&photo, "P1.RW2", &json!({ "exposure": 0.4 }), SystemTime::now())
    .unwrap();
  let versions = json!([version("v1", "版 1", "named", 0.4)]);
  store.save_versions(&photo, &versions, 0, SystemTime::now()).unwrap();
  // 記録を書き直しても版は消えない。版を書いても記録は変わらない
  store
    .save(&photo, "P1.RW2", &json!({ "exposure": 1 }), SystemTime::now())
    .unwrap();
  assert_eq!(store.load(&photo), Some(json!({ "exposure": 1 })));
  assert_eq!(store.load_versions(&photo).unwrap().versions, versions);
  // 一覧の索引（records）は記録だけを読む
  assert_eq!(store.records().len(), 1);
  // 旧版の NIHO が読み書き・掃除するのは <キー>.json と <キー>.json.tmp だけ（版のファイルと、その一時ファイルはその形でない）
  let old_niho_touches = |name: &str| {
    name.strip_suffix(".json").is_some_and(is_content_key) || name.strip_suffix(".json.tmp").is_some_and(is_content_key)
  };
  let versions_file = format!("{photo}.versions.json");
  let versions_temp = temp_path(Path::new(&versions_file));
  assert!(!old_niho_touches(&versions_file));
  assert!(!old_niho_touches(versions_temp.to_str().unwrap()));
  assert!(old_niho_touches(&format!("{photo}.json")));
}

#[test]
fn forgetting_the_record_also_forgets_its_versions() {
  let temp = TempDir::new("forget");
  let store = store(&temp, StoreLimits::default());
  let photo = key('c');
  store.save(&photo, "a.jpg", &json!({}), SystemTime::now()).unwrap();
  store
    .save_versions(
      &photo,
      &json!([version("v1", "版 1", "named", 0.1)]),
      0,
      SystemTime::now(),
    )
    .unwrap();
  // 版だけの写真（補正を保存する前に版にした）も同じ
  let only_versions = key('d');
  store
    .save_versions(
      &only_versions,
      &json!([version("v1", "版 1", "named", 0.0)]),
      0,
      SystemTime::now(),
    )
    .unwrap();
  store.forget(&photo).unwrap();
  store.forget(&only_versions).unwrap();
  assert!(store.load(&photo).is_none() && store.load_versions(&photo).is_none());
  assert!(store.load_versions(&only_versions).is_none());
  assert!(names(&temp.settings_dir()).is_empty());
  // 無いものを消しても成功
  store.forget(&photo).unwrap();
}

#[test]
fn versions_of_a_wrong_shape_or_over_the_limits_are_refused() {
  let temp = TempDir::new("invalid");
  let store = store(&temp, StoreLimits::default());
  let photo = key('e');
  let named = |count: usize| -> Vec<Value> {
    (0..count)
      .map(|index| version(&format!("n{index}"), &format!("版 {index}"), "named", 0.0))
      .collect()
  };
  let autos = |count: usize| -> Vec<Value> {
    (0..count)
      .map(|index| version(&format!("a{index}"), "自動の版 10:32", "auto", 0.0))
      .collect()
  };
  // 上限ちょうど（名前つき 30・自動 10）と、40 文字の名前は通る
  let mut full = named(MAX_NAMED_VERSIONS);
  full.extend(autos(MAX_AUTO_VERSIONS));
  assert!(is_valid_develop_versions(&Value::Array(full.clone())));
  assert!(is_valid_develop_versions(&json!([version(
    "v1",
    &"あ".repeat(40),
    "named",
    0.0
  )])));
  assert!(is_valid_develop_versions(&json!([])));

  let mut extra_key = version("v1", "版 1", "named", 0.0);
  extra_key["note"] = json!("x");
  let mut missing_key = version("v1", "版 1", "named", 0.0);
  missing_key.as_object_mut().unwrap().remove("createdAt");
  let mut not_object = version("v1", "版 1", "named", 0.0);
  not_object["developSettings"] = json!([1]);
  let mut too_large = version("v1", "版 1", "named", 0.0);
  too_large["developSettings"]["blob"] = json!("x".repeat(MAX_SAVED_SETTINGS_BYTES));
  let mut empty_created_at = version("v1", "版 1", "named", 0.0);
  empty_created_at["createdAt"] = json!("");
  let mut over_named = named(MAX_NAMED_VERSIONS + 1);
  over_named.extend(autos(1));
  let invalid = [
    json!({ "versions": [] }),
    json!([1]),
    json!([version("v1", "版 1", "named", 0.0), version("v1", "版 2", "named", 0.0)]),
    json!([version("v/1", "版 1", "named", 0.0)]),
    json!([version("", "版 1", "named", 0.0)]),
    json!([version(&"x".repeat(65), "版 1", "named", 0.0)]),
    json!([version("v1", "", "named", 0.0)]),
    json!([version("v1", " 版 1", "named", 0.0)]),
    json!([version("v1", &"あ".repeat(41), "named", 0.0)]),
    json!([version("v1", "版\n1", "named", 0.0)]),
    json!([version("v1", "版 1", "snapshot", 0.0)]),
    json!([extra_key]),
    json!([missing_key]),
    json!([not_object]),
    json!([too_large]),
    json!([empty_created_at]),
    Value::Array(over_named),
    Value::Array({
      let mut over_auto = autos(MAX_AUTO_VERSIONS + 1);
      over_auto.extend(named(1));
      over_auto
    }),
  ];
  for versions in invalid {
    assert!(!is_valid_develop_versions(&versions), "{versions}");
    let error = store
      .save_versions(&photo, &versions, 0, SystemTime::now())
      .unwrap_err();
    assert_eq!(error.kind(), io::ErrorKind::InvalidInput);
  }
  // 1 つずつは上限内でも、配列全体が大きすぎれば通さない
  let heavy: Vec<Value> = (0..MAX_NAMED_VERSIONS + MAX_AUTO_VERSIONS)
    .map(|index| {
      let kind = if index < MAX_NAMED_VERSIONS { "named" } else { "auto" };
      let mut item = version(&format!("h{index}"), "重い版", kind, 0.0);
      item["developSettings"]["blob"] = json!("x".repeat(MAX_SAVED_SETTINGS_BYTES - 200));
      item
    })
    .collect();
  assert!(heavy.iter().all(|item| is_valid_develop_versions(&json!([item]))));
  assert!(!is_valid_develop_versions(&Value::Array(heavy)));
  // キーの形でないキーはディスクに触れない
  assert_eq!(
    store
      .save_versions("../x", &json!([]), 0, SystemTime::now())
      .unwrap_err()
      .kind(),
    io::ErrorKind::InvalidInput
  );
  assert!(store.load_versions("../x").is_none());
  assert!(!temp.settings_dir().exists());
}

#[test]
fn broken_unknown_or_too_large_version_files_read_as_no_versions_and_are_overwritten() {
  let temp = TempDir::new("broken");
  let store = store(&temp, StoreLimits::default());
  let dir = temp.settings_dir();
  fs::create_dir_all(&dir).unwrap();
  let photo = key('f');
  let path = dir.join(format!("{photo}.versions.json"));
  let too_large = serde_json::to_vec(&json!({
    "version": 1, "revision": 1, "versions": [], "pad": "x".repeat(MAX_VERSIONS_FILE_BYTES as usize),
  }))
  .unwrap();
  for body in [
    b"not json".to_vec(),
    b"[]".to_vec(),
    br#"{"version":2,"revision":1,"versions":[]}"#.to_vec(),
    br#"{"version":1,"versions":[]}"#.to_vec(),
    br#"{"version":1,"revision":1,"versions":{}}"#.to_vec(),
    br#"{"version":1,"revision":1,"versions":[{"id":"v1"}]}"#.to_vec(),
    too_large,
  ] {
    fs::write(&path, &body).unwrap();
    assert!(
      store.load_versions(&photo).is_none(),
      "{}",
      String::from_utf8_lossy(&body[..body.len().min(60)])
    );
    // 版なし（版 0）として上書きできる
    let versions = json!([version("v1", "版 1", "named", 0.2)]);
    assert_eq!(
      store.save_versions(&photo, &versions, 0, SystemTime::now()).unwrap(),
      SaveRevision::Saved {
        revision: 1,
        swept: None
      }
    );
    assert_eq!(store.load_versions(&photo).unwrap().versions, versions);
  }
  // フォルダが同じ名前で置かれていても読まない
  fs::remove_file(&path).unwrap();
  fs::create_dir_all(&path).unwrap();
  assert!(store.load_versions(&photo).is_none());
}

#[test]
fn a_failed_versions_write_keeps_the_previous_versions() {
  let temp = TempDir::new("failed-write");
  let store = store(&temp, StoreLimits::default());
  let photo = key('1');
  let before = json!([version("v1", "版 1", "named", 0.5)]);
  store.save_versions(&photo, &before, 0, SystemTime::now()).unwrap();
  // 一時ファイルの場所をフォルダで塞ぐと書き込みは失敗するが、前の内容は壊れない
  fs::create_dir_all(temp.settings_dir().join(format!("{photo}.versions.json.tmp"))).unwrap();
  assert!(store.save_versions(&photo, &json!([]), 1, SystemTime::now()).is_err());
  assert_eq!(
    store
      .load_versions(&photo)
      .map(|saved| (saved.versions, saved.revision)),
    Some((before, 1))
  );
}

#[test]
fn sweep_counts_a_record_and_its_versions_as_one_entry_and_removes_them_together() {
  let temp = TempDir::new("sweep");
  let limits = StoreLimits {
    max_entries: 2,
    max_age: 10 * DAY,
    sweep_interval: DAY,
  };
  let store = store(&temp, limits);
  let now = SystemTime::now();
  let dir = temp.settings_dir();
  let record = |fill: char| dir.join(format!("{}.json", key(fill)));
  let versions = |fill: char| dir.join(format!("{}.versions.json", key(fill)));
  let save_both = |fill: char, record_days: u32, versions_days: u32| {
    store.save(&key(fill), "x.jpg", &json!({}), now).unwrap();
    store
      .save_versions(&key(fill), &json!([version("v1", "版 1", "named", 0.0)]), 0, now)
      .unwrap();
    set_modified(&record(fill), now - record_days * DAY);
    set_modified(&versions(fill), now - versions_days * DAY);
  };
  // 1: 記録は 20 日前でも、版を 1 日前に直したので残る（新しい方の日時）
  save_both('1', 20, 1);
  // 2: 記録も版も 10 日を過ぎた（一緒に消す）
  save_both('2', 30, 15);
  // 3・4: 新しい順で上限 2 件を超えた古い方（4）は記録も版も消す
  save_both('3', 2, 2);
  save_both('4', 5, 3);
  // 5: 版だけの写真で 10 日を過ぎた
  store
    .save_versions(&key('5'), &json!([version("v1", "版 1", "named", 0.0)]), 0, now)
    .unwrap();
  set_modified(&versions('5'), now - 12 * DAY);
  // 途中で落ちた版の一時ファイル（古いものだけ消す）とキーの形でないファイル
  let orphan = dir.join(format!("{}.versions.json.tmp", key('6')));
  fs::write(&orphan, b"{").unwrap();
  set_modified(&orphan, now - DAY);
  let writing = dir.join(format!("{}.versions.json.tmp", key('7')));
  fs::write(&writing, b"{").unwrap();
  fs::write(dir.join("notes.versions.json"), b"keep").unwrap();

  // 2 の 2 つ、5 の 1 つ、古い一時ファイル 1 つ、上限を超えた 4 の 2 つ
  assert_eq!(store.sweep(now), 6);
  let mut expected = vec![
    format!("{}.json", key('1')),
    format!("{}.versions.json", key('1')),
    format!("{}.json", key('3')),
    format!("{}.versions.json", key('3')),
    format!("{}.versions.json.tmp", key('7')),
    "notes.versions.json".to_string(),
  ];
  expected.sort();
  assert_eq!(names(&dir), expected);
}

#[test]
fn never_expiring_limits_keep_versions_and_only_clear_stale_temp_files() {
  let temp = TempDir::new("never");
  let store = store(
    &temp,
    StoreLimits {
      max_entries: usize::MAX,
      max_age: Duration::MAX,
      sweep_interval: DAY,
    },
  );
  let now = SystemTime::now();
  let dir = temp.settings_dir();
  store
    .save_versions(&key('a'), &json!([version("v1", "版 1", "named", 0.0)]), 0, now)
    .unwrap();
  set_modified(&dir.join(format!("{}.versions.json", key('a'))), UNIX_EPOCH);
  let orphan = dir.join(format!("{}.versions.json.tmp", key('b')));
  fs::write(&orphan, b"{").unwrap();
  set_modified(&orphan, now - DAY);
  assert_eq!(store.sweep(now), 1);
  assert_eq!(names(&dir), vec![format!("{}.versions.json", key('a'))]);
}
