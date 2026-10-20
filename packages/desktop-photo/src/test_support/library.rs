//! フォルダの一覧（`crate::library`）のテストの道具: 一時フォルダと、qlmanage / sips の代わりのサムネイル作り。

use crate::common::random_hex;
use crate::library::{
  LibraryConfig, MakeFailure, PhotoLibrary, RememberedBudget, ScanLimits, ThumbnailJob, ThumbnailMaker,
  MAX_THUMBNAIL_JOBS, THUMBNAIL_CACHE_DIR_NAME, THUMBNAIL_CACHE_MAX_BYTES, WORK_DIR_PREFIX,
};
use crate::remembered::{remembered_path, RememberedLimits, RememberedStore};
use serde_json::Value;
use std::fs;
use std::path::PathBuf;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

/// PNG の先頭（偽のサムネイル作りが書く）。
pub const PNG_SIGNATURE: [u8; 8] = [0x89, b'P', b'N', b'G', 0x0d, 0x0a, 0x1a, 0x0a];

/// テストごとの一時フォルダ（`root` が「フォルダを追加」で選ぶフォルダ、`cache` がアプリのキャッシュ、`app-data` が
/// アプリのデータ（覚えたフォルダ・写真の置き場））。
pub struct Fixture {
  pub dir: PathBuf,
  pub logs: Arc<Mutex<Vec<String>>>,
}

impl Fixture {
  pub fn new(name: &str) -> Self {
    let dir = std::env::temp_dir().join(format!(
      "niho-photo-library-test-{name}-{}-{}",
      std::process::id(),
      random_hex(6)
    ));
    fs::create_dir_all(dir.join("root")).unwrap();
    Self {
      dir,
      logs: Arc::new(Mutex::new(Vec::new())),
    }
  }

  pub fn root(&self) -> PathBuf {
    self.dir.join("root")
  }

  /// `root` の下にファイルを作る（途中のフォルダも作る。中身は名前）。
  pub fn file(&self, relative: &str) -> PathBuf {
    let path = self.root().join(relative);
    fs::create_dir_all(path.parent().unwrap()).unwrap();
    fs::write(&path, format!("photo {relative}")).unwrap();
    path
  }

  pub fn thumbnail_dir(&self) -> PathBuf {
    self.dir.join("cache").join(THUMBNAIL_CACHE_DIR_NAME)
  }

  /// アプリのデータのフォルダ（覚えたフォルダ・写真の置き場がある）。
  pub fn app_data(&self) -> PathBuf {
    self.dir.join("app-data")
  }

  /// 覚えたフォルダ・写真（ライブラリと同じ置き場を読む）。
  pub fn remembered_store(&self) -> RememberedStore {
    RememberedStore::new(remembered_path(&self.app_data()), RememberedLimits::default())
  }

  pub fn library(&self) -> Arc<PhotoLibrary> {
    self.library_with(ScanLimits::default(), failing_maker())
  }

  pub fn library_with(&self, limits: ScanLimits, maker: ThumbnailMaker) -> Arc<PhotoLibrary> {
    self.library_config(limits, maker, THUMBNAIL_CACHE_MAX_BYTES, Some(self.thumbnail_dir()))
  }

  pub fn library_config(
    &self,
    limits: ScanLimits,
    maker: ThumbnailMaker,
    thumbnail_cache_max_bytes: u64,
    thumbnail_dir: Option<PathBuf>,
  ) -> Arc<PhotoLibrary> {
    PhotoLibrary::new(self.config(limits, maker, thumbnail_cache_max_bytes, thumbnail_dir))
  }

  /// 同じ一時フォルダを使う設定（`library` を何度作っても、覚えたものは同じ置き場。アプリの起動し直しに当たる）。
  pub fn config(
    &self,
    limits: ScanLimits,
    maker: ThumbnailMaker,
    thumbnail_cache_max_bytes: u64,
    thumbnail_dir: Option<PathBuf>,
  ) -> LibraryConfig {
    let logs = self.logs.clone();
    LibraryConfig {
      limits,
      remembered_budget: RememberedBudget::default(),
      thumbnail_dir,
      thumbnail_cache_max_bytes,
      thumbnail_timeout: Duration::from_secs(5),
      max_thumbnail_jobs: MAX_THUMBNAIL_JOBS,
      maker,
      remembered: Some(self.remembered_store()),
      log: Arc::new(move |kind, payload| logs.lock().unwrap().push(format!("{kind} {payload}"))),
    }
  }

  pub fn has_log(&self, needle: &str) -> bool {
    self.logs.lock().unwrap().iter().any(|line| line.contains(needle))
  }

  /// キャッシュの中の一時フォルダ（`work-…`）。仕事が終われば残らない。
  pub fn work_dirs(&self) -> Vec<String> {
    fs::read_dir(self.thumbnail_dir())
      .map(|entries| {
        entries
          .flatten()
          .map(|entry| entry.file_name().to_string_lossy().into_owned())
          .filter(|name| name.starts_with(WORK_DIR_PREFIX))
          .collect()
      })
      .unwrap_or_default()
  }
}

impl Drop for Fixture {
  fn drop(&mut self) {
    let _ = fs::remove_dir_all(&self.dir);
  }
}

pub fn limits(max_depth: usize, max_photos: usize, max_folders: usize) -> ScanLimits {
  ScanLimits {
    max_depth,
    max_photos,
    max_folders,
  }
}

/// 呼ばれたら「作れなかった」を返す（サムネイルを使わないテスト用）。
pub fn failing_maker() -> ThumbnailMaker {
  Arc::new(|_job: &ThumbnailJob| Err(MakeFailure::Failed))
}

/// 一時フォルダに `bytes` を書いて「作れた」を返し、呼ばれた回数を数える。
pub fn writing_maker(calls: Arc<AtomicUsize>, bytes: Vec<u8>) -> ThumbnailMaker {
  Arc::new(move |job: &ThumbnailJob| {
    calls.fetch_add(1, Ordering::SeqCst);
    let made = job.work_dir.join("made");
    fs::write(&made, &bytes).unwrap();
    Ok(made)
  })
}

/// 長辺と通し番号の入った PNG（に見えるバイト列）を作る。
pub fn png_maker(calls: Arc<AtomicUsize>) -> ThumbnailMaker {
  Arc::new(move |job: &ThumbnailJob| {
    let number = calls.fetch_add(1, Ordering::SeqCst) + 1;
    let made = job.work_dir.join("made.png");
    let mut bytes = PNG_SIGNATURE.to_vec();
    bytes.extend(format!("{number}:{}", job.max_dimension).as_bytes());
    fs::write(&made, bytes).unwrap();
    Ok(made)
  })
}

pub fn photo_names(folder: &Value) -> Vec<String> {
  folder["photos"]
    .as_array()
    .unwrap()
    .iter()
    .map(|photo| photo["fileName"].as_str().unwrap().to_string())
    .collect()
}

pub fn child_names(folder: &Value) -> Vec<String> {
  folder["children"]
    .as_array()
    .unwrap()
    .iter()
    .map(|child| child["name"].as_str().unwrap().to_string())
    .collect()
}

pub fn child<'a>(folder: &'a Value, name: &str) -> &'a Value {
  folder["children"]
    .as_array()
    .unwrap()
    .iter()
    .find(|child| child["name"] == name)
    .unwrap_or_else(|| panic!("{name} is listed: {folder}"))
}

pub fn entry_id(folder: &Value, file_name: &str) -> String {
  folder["photos"]
    .as_array()
    .unwrap()
    .iter()
    .find(|photo| photo["fileName"] == file_name)
    .and_then(|photo| photo["entryId"].as_str())
    .unwrap_or_else(|| panic!("{file_name} is listed: {folder}"))
    .to_string()
}

/// 値の中のすべての文字列（キーも）。
pub fn all_strings(value: &Value, out: &mut Vec<String>) {
  match value {
    Value::String(text) => out.push(text.clone()),
    Value::Array(items) => items.iter().for_each(|item| all_strings(item, out)),
    Value::Object(fields) => {
      for (key, item) in fields {
        out.push(key.clone());
        all_strings(item, out);
      }
    }
    _ => {}
  }
}

pub fn assert_no_path(value: &Value) {
  let mut strings = Vec::new();
  all_strings(value, &mut strings);
  assert!(!strings.is_empty());
  for text in strings {
    assert!(!text.contains('/'), "a path reaches the page: {text:?} in {value}");
  }
  assert!(!value.to_string().contains("niho-photo-library-test"), "{value}");
}
