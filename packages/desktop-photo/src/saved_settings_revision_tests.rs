//! 版つきの保存（{@link SavedSettingsStore::save_revision}。NIHO camera。C3 #18391）のテスト。

use super::*;
use std::sync::atomic::{AtomicU64, Ordering};

/// テストごとの一時フォルダ（Drop で消す）。
struct TempDir(PathBuf);

impl TempDir {
  fn new(name: &str) -> Self {
    static COUNTER: AtomicU64 = AtomicU64::new(1);
    let dir = std::env::temp_dir().join(format!(
      "niho-photo-saved-revision-{name}-{}-{}",
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

fn source(file_name: &str) -> RecordSource<'_> {
  RecordSource {
    file_name,
    size_bytes: 36 << 20,
    modified_at_ms: Some(1_790_000_000_000),
  }
}

#[test]
fn revisions_start_at_one_and_a_stale_revision_is_a_conflict() {
  let temp = TempDir::new("conflict");
  let store = SavedSettingsStore::new(temp.0.join("edits"), StoreLimits::default());
  let photo = key('a');
  let at = UNIX_EPOCH + Duration::from_millis(1_790_000_000_123);

  assert_eq!(
    store
      .save_revision(&photo, &source("P1.RW2"), &json!({ "exposure": 0.4 }), 0, at)
      .unwrap(),
    SaveRevision::Saved {
      revision: 1,
      swept: Some(0)
    }
  );
  assert_eq!(
    store
      .save_revision(&photo, &source("P1.RW2"), &json!({ "exposure": 0.6 }), 1, at)
      .unwrap(),
    SaveRevision::Saved {
      revision: 2,
      swept: None
    }
  );
  // 古い版（別の窓・前の読み込み）からの保存は書かない
  assert_eq!(
    store
      .save_revision(&photo, &source("P1.RW2"), &json!({ "exposure": 9 }), 1, at)
      .unwrap(),
    SaveRevision::Conflict { current: 2 }
  );
  let record = store.load_record(&photo).unwrap();
  assert_eq!(record.settings, json!({ "exposure": 0.6 }));
  assert_eq!(record.revision, 2);
  assert_eq!(record.updated_at_ms, 1_790_000_000_123);
  assert_eq!(record.file_name, "P1.RW2");
  assert_eq!(record.size_bytes, Some(36 << 20));
  assert_eq!(record.modified_at_ms, Some(1_790_000_000_000));
  // NIHO Desktop の読み方でも同じ設定
  assert_eq!(store.load(&photo), Some(json!({ "exposure": 0.6 })));
}

#[test]
fn a_record_without_a_revision_is_revision_zero_and_a_broken_one_is_overwritten() {
  let temp = TempDir::new("legacy");
  let store = SavedSettingsStore::new(temp.0.join("edits"), StoreLimits::default());
  let photo = key('b');
  // NIHO Desktop の save（revision を書かない）
  store
    .save(&photo, "DSC1.JPG", &json!({ "exposure": 1 }), SystemTime::now())
    .unwrap();
  let record = store.load_record(&photo).unwrap();
  assert_eq!(
    (record.revision, record.size_bytes, record.modified_at_ms),
    (0, None, None)
  );
  assert_eq!(
    store
      .save_revision(
        &photo,
        &source("DSC1.JPG"),
        &json!({ "exposure": 2 }),
        0,
        SystemTime::now()
      )
      .unwrap(),
    // 起動後の最初の掃除は Desktop の save で済んでいる
    SaveRevision::Saved {
      revision: 1,
      swept: None
    }
  );

  // 壊れた記録は版 0（無いのと同じ。次の保存で上書きする）
  let broken = key('c');
  fs::write(temp.0.join("edits").join(format!("{broken}.json")), b"{not json").unwrap();
  assert!(store.load_record(&broken).is_none());
  assert_eq!(
    store
      .save_revision(&broken, &source("x.heic"), &json!({}), 0, SystemTime::now())
      .unwrap(),
    SaveRevision::Saved {
      revision: 1,
      swept: None
    }
  );
}

#[test]
fn limits_that_never_expire_keep_every_record() {
  // NIHO camera は補正が利用者のデータそのものなので、古さ・件数では消さない上限を渡す
  let temp = TempDir::new("no-expiry");
  let limits = StoreLimits {
    max_entries: usize::MAX,
    max_age: Duration::MAX,
    sweep_interval: Duration::ZERO,
  };
  let store = SavedSettingsStore::new(temp.0.join("edits"), limits);
  let long_ago = UNIX_EPOCH + Duration::from_secs(60);
  for fill in ['d', 'e', 'f'] {
    store
      .save_revision(&key(fill), &source("a.jpg"), &json!({}), 0, long_ago)
      .unwrap();
  }
  let now = SystemTime::now();
  let swept = store
    .save_revision(&key('d'), &source("a.jpg"), &json!({ "exposure": 1 }), 1, now)
    .unwrap();
  assert_eq!(
    swept,
    SaveRevision::Saved {
      revision: 2,
      swept: Some(0)
    }
  );
  for fill in ['d', 'e', 'f'] {
    assert!(store.load_record(&key(fill)).is_some(), "{fill}");
  }
}

#[test]
fn records_lists_the_readable_records_only() {
  let temp = TempDir::new("records");
  let store = SavedSettingsStore::new(temp.0.join("edits"), StoreLimits::default());
  assert!(store.records().is_empty());
  store
    .save_revision(
      &key('a'),
      &source("P1.RW2"),
      &json!({ "exposure": 1 }),
      0,
      SystemTime::now(),
    )
    .unwrap();
  store
    .save(&key('b'), "DSC1.JPG", &json!({}), SystemTime::now())
    .unwrap();
  fs::write(temp.0.join("edits").join(format!("{}.json", key('c'))), b"{broken").unwrap();
  fs::write(
    temp.0.join("edits").join("notes.json"),
    br#"{"version":1,"settings":{}}"#,
  )
  .unwrap();
  let mut names: Vec<(String, Option<u64>)> = store
    .records()
    .into_iter()
    .map(|record| (record.file_name, record.size_bytes))
    .collect();
  names.sort();
  assert_eq!(
    names,
    [("DSC1.JPG".to_string(), None), ("P1.RW2".to_string(), Some(36 << 20))]
  );
}
