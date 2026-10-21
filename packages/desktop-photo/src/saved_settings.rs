//公開移植前の内部構成については docs/migration/mac-client.md を参照。
//! NIHO Desktop の `photo_saved_settings.rs` から C2 #18390 で移した。保存先のフォルダはアプリが渡す（{@link SavedSettingsStore::new}）。
//!
//! - キーは写真の中身の SHA-256（16 進 64 文字）。名前を変えても・別のフォルダへ動かしても、同じ写真なら同じキー。
//! - `<app data>/photo-editing/settings/<キー>.json` に 1 枚 1 ファイル（`{ version, fileName, updatedAtMs, settings }`）。
//!   フォルダは 0700、ファイルは 0600。書き込みは一時ファイル＋rename（途中で落ちても、前の内容か新しい内容のどちらか）。
//!   写真のパスは保存しない（`fileName` は選んだファイルの名前だけで、調べるとき用）。
//! - 読めない・壊れた・知らない版・大きすぎるファイルは、保存が無いものとして扱う（次の保存で上書きされる）。
//! - 掃除: 起動後の最初の保存と、その後は 24 時間ごとの保存のときに、最終更新（ファイルの更新日時）から 1 年を
//!   過ぎたものを消し、2000 件を超えた分を古い順に消す。キーの形でないファイルには触れない。上限はアプリが渡す
//!   （NIHO camera は補正が利用者のデータそのものなので、古さ・件数では消さない）。
//! - 版（NIHO camera。C3 #18391）: {@link SavedSettingsStore::save_revision} は保存のたびに `revision` を 1 つ増やし、
//!   画面が知っている版と違えば書かずに競合を返す。写真の大きさと更新時刻（`sizeBytes`・`modifiedAtMs`）も残し、一覧で
//!   写真を開かずに「補正済み」を見分けられるようにする。どれも足しただけの項目で、NIHO Desktop の {@link SavedSettingsStore::save}
//!   と {@link SavedSettingsStore::load} はそのまま読み書きできる（`revision` の無い記録は版 0）。
//! - 補正の版（niho-photo#42）は同じフォルダの別のファイル `<キー>.versions.json`（`saved_versions.rs`）。記録と一緒に消す
//!   （{@link SavedSettingsStore::forget}・掃除は同じキーの記録と版を 1 件として数える）。

use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::collections::BTreeMap;
use std::fs;
use std::io::{self, Read, Write};
use std::path::{Path, PathBuf};
use std::sync::{Mutex, MutexGuard};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

/// 保存ファイルの形式の版。これ以外の版のファイルは読まない。
pub(crate) const SAVED_SETTINGS_FORMAT_VERSION: u64 = 1;
/// 保存できる設定（`settings` の JSON）の大きさの上限。`EditSettings` はトーンカーブ込みでも数 KB。
pub const MAX_SAVED_SETTINGS_BYTES: usize = 64 * 1024;
/// 保存ファイル 1 つの上限（設定＋元のファイル名と日時）。これを超えるファイルは読まない。
const MAX_RECORD_BYTES: u64 = MAX_SAVED_SETTINGS_BYTES as u64 + 4 * 1024;
/// 途中で落ちた書き込みの一時ファイルを消すまでの時間（書き込み中のものは消さない）。
const ORPHAN_TEMP_AGE: Duration = Duration::from_secs(60 * 60);
/// 中身を読むときの 1 回の大きさ。
const HASH_BUFFER_BYTES: usize = 1024 * 1024;

/// 掃除の上限。
#[derive(Clone, Debug)]
pub struct StoreLimits {
  /// 残す件数の上限（超えた分は最終更新の古い順に消す）
  pub max_entries: usize,
  /// 最終更新からこれを過ぎたら消す
  pub max_age: Duration,
  /// 掃除の間隔（起動後の最初の保存で 1 回、その後はこの間隔をあけた保存のとき）
  pub sweep_interval: Duration,
}

impl Default for StoreLimits {
  fn default() -> Self {
    Self {
      max_entries: 2000,
      max_age: Duration::from_secs(365 * 24 * 60 * 60),
      sweep_interval: Duration::from_secs(24 * 60 * 60),
    }
  }
}

/// 保存した補正の記録（{@link SavedSettingsStore::load_record}）。
#[derive(Clone, Debug, PartialEq)]
pub struct SavedRecord {
  pub settings: Value,
  /// 保存のたびに 1 ずつ増える版（`revision` の無い記録〔NIHO Desktop の {@link SavedSettingsStore::save}〕は 0）
  pub revision: u64,
  pub updated_at_ms: u64,
  pub file_name: String,
  /// 保存したときの写真の大きさと更新時刻（{@link SavedSettingsStore::save_revision} が書く。無い記録は None）
  pub size_bytes: Option<u64>,
  pub modified_at_ms: Option<u64>,
}

/// {@link SavedSettingsStore::save_revision} で残す写真の情報（パスは残さない）。
#[derive(Clone, Debug)]
pub struct RecordSource<'a> {
  pub file_name: &'a str,
  pub size_bytes: u64,
  pub modified_at_ms: Option<u64>,
}

/// {@link SavedSettingsStore::save_revision} の結果。
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum SaveRevision {
  /// 書いた（`revision` は新しい版。掃除したら消した件数）
  Saved { revision: u64, swept: Option<usize> },
  /// 画面が知っている版と今の版が違うので書かなかった
  Conflict { current: u64 },
}

/// 編集内容の保存先（アプリに 1 つ）。
pub struct SavedSettingsStore {
  dir: PathBuf,
  limits: StoreLimits,
  /// 書き込み・削除・掃除を直列にする。値は最後に掃除した時刻（起動後まだなら None）
  guard: Mutex<Option<Instant>>,
}

impl SavedSettingsStore {
  pub fn new(dir: PathBuf, limits: StoreLimits) -> Self {
    Self {
      dir,
      limits,
      guard: Mutex::new(None),
    }
  }

  fn lock(&self) -> MutexGuard<'_, Option<Instant>> {
    self.guard.lock().unwrap_or_else(|poison| poison.into_inner())
  }

  fn record_path(&self, key: &str) -> io::Result<PathBuf> {
    if !is_content_key(key) {
      return Err(io::Error::new(io::ErrorKind::InvalidInput, "not a content key"));
    }
    Ok(self.dir.join(format!("{key}.json")))
  }

  /// 保存した設定。無い・読めない・壊れている・知らない版・大きすぎるときは None。
  pub fn load(&self, key: &str) -> Option<Value> {
    self.load_record(key).map(|record| record.settings)
  }

  /// 保存した記録（設定・版・日時・写真の情報）。無い・読めない・壊れている・知らない版・大きすぎるときは None。
  pub fn load_record(&self, key: &str) -> Option<SavedRecord> {
    let path = self.record_path(key).ok()?;
    let _guard = self.lock();
    Self::read_record(&path)
  }

  fn read_record(path: &Path) -> Option<SavedRecord> {
    let metadata = fs::metadata(path).ok()?;
    if !metadata.is_file() || metadata.len() > MAX_RECORD_BYTES {
      return None;
    }
    let record: Value = serde_json::from_slice(&fs::read(path).ok()?).ok()?;
    if record.get("version").and_then(Value::as_u64) != Some(SAVED_SETTINGS_FORMAT_VERSION) {
      return None;
    }
    let settings = record
      .get("settings")
      .filter(|settings| settings.is_object())
      .cloned()?;
    Some(SavedRecord {
      settings,
      revision: record.get("revision").and_then(Value::as_u64).unwrap_or(0),
      updated_at_ms: record.get("updatedAtMs").and_then(Value::as_u64).unwrap_or(0),
      file_name: record
        .get("fileName")
        .and_then(Value::as_str)
        .unwrap_or_default()
        .to_string(),
      size_bytes: record.get("sizeBytes").and_then(Value::as_u64),
      modified_at_ms: record.get("modifiedAtMs").and_then(Value::as_u64),
    })
  }

  /// 保存 record が存在するか。壊れた・未知版・大きすぎる record も「未編集」へ自動移行させないため true。
  pub fn contains_record(&self, key: &str) -> bool {
    let Ok(path) = self.record_path(key) else { return true };
    let _guard = self.lock();
    match fs::symlink_metadata(path) {
      Err(err) if err.kind() == io::ErrorKind::NotFound => false,
      // 壊れたファイル、フォルダ、symlink、権限エラーも「保存なし」へ倒さない。
      _ => true,
    }
  }

  /// 設定を保存する（同じキーは上書き）。掃除の頃合いなら続けて掃除し、消した件数を返す（掃除しなければ None）。
  pub fn save(&self, key: &str, file_name: &str, settings: &Value, now: SystemTime) -> io::Result<Option<usize>> {
    let path = self.record_path(key)?;
    let body = serde_json::to_vec(&json!({
      "version": SAVED_SETTINGS_FORMAT_VERSION,
      "fileName": file_name,
      "updatedAtMs": epoch_ms(now),
      "settings": settings,
    }))
    .map_err(io::Error::other)?;
    let mut last_sweep = self.lock();
    ensure_private_dir(&self.dir)?;
    write_private_file_atomically(&path, &body)?;
    let due = last_sweep.map_or(true, |at| at.elapsed() >= self.limits.sweep_interval);
    if !due {
      return Ok(None);
    }
    *last_sweep = Some(Instant::now());
    Ok(Some(self.sweep_locked(now)))
  }

  /// 保存した記録を全部読む（NIHO camera が一覧で「補正済み」を見分ける索引を作る。読めない・壊れた記録は飛ばす）。
  pub fn records(&self) -> Vec<SavedRecord> {
    let _guard = self.lock();
    let Ok(entries) = fs::read_dir(&self.dir) else {
      return Vec::new();
    };
    entries
      .flatten()
      .filter(|entry| {
        entry
          .file_name()
          .to_str()
          .and_then(|name| name.strip_suffix(".json"))
          .is_some_and(is_content_key)
      })
      .filter_map(|entry| Self::read_record(&entry.path()))
      .collect()
  }

  /// 版を照らしてから保存する（NIHO camera）。今の版（記録が無い・読めないときは 0）が `expected_revision` と違えば書かずに
  /// {@link SaveRevision::Conflict}。書いたら版を 1 つ増やし、写真の大きさと更新時刻も残す。掃除は {@link SavedSettingsStore::save} と同じ。
  pub fn save_revision(
    &self,
    key: &str,
    source: &RecordSource<'_>,
    settings: &Value,
    expected_revision: u64,
    now: SystemTime,
  ) -> io::Result<SaveRevision> {
    let path = self.record_path(key)?;
    let mut last_sweep = self.lock();
    let current = Self::read_record(&path).map_or(0, |record| record.revision);
    if current != expected_revision {
      return Ok(SaveRevision::Conflict { current });
    }
    let revision = current + 1;
    let body = serde_json::to_vec(&json!({
      "version": SAVED_SETTINGS_FORMAT_VERSION,
      "fileName": source.file_name,
      "updatedAtMs": epoch_ms(now),
      "settings": settings,
      "revision": revision,
      "sizeBytes": source.size_bytes,
      "modifiedAtMs": source.modified_at_ms,
    }))
    .map_err(io::Error::other)?;
    ensure_private_dir(&self.dir)?;
    write_private_file_atomically(&path, &body)?;
    let due = last_sweep.map_or(true, |at| at.elapsed() >= self.limits.sweep_interval);
    if !due {
      return Ok(SaveRevision::Saved { revision, swept: None });
    }
    *last_sweep = Some(Instant::now());
    Ok(SaveRevision::Saved {
      revision,
      swept: Some(self.sweep_locked(now)),
    })
  }

  /// 保存を消す（無ければ何もしない）。補正の版（`<キー>.versions.json`）も一緒に消す（版だけを残さない）。
  pub fn forget(&self, key: &str) -> io::Result<()> {
    let path = self.record_path(key)?;
    let versions = self.dir.join(format!("{key}{}", versions::VERSIONS_FILE_SUFFIX));
    let _guard = self.lock();
    for path in [path, versions] {
      match fs::remove_file(path) {
        Err(err) if err.kind() != io::ErrorKind::NotFound => return Err(err),
        _ => {}
      }
    }
    Ok(())
  }

  /// 古いもの・多すぎる分を消し、消した件数を返す（アプリでは `save` の中から掃除する）。
  #[cfg(test)]
  pub(crate) fn sweep(&self, now: SystemTime) -> usize {
    let _guard = self.lock();
    self.sweep_locked(now)
  }

  /// 掃除の本体。同じキーの記録（`<キー>.json`）と版（`<キー>.versions.json`）は 1 件として、新しい方の更新日時で古さ・件数を
  /// 数え、消すときは一緒に消す（版だけを残さない）。途中で落ちた一時ファイル（`.json.tmp`・`.versions.json.tmp`）は 1 時間で消す。
  /// 消した件数はファイルの数。
  fn sweep_locked(&self, now: SystemTime) -> usize {
    let Ok(entries) = fs::read_dir(&self.dir) else { return 0 };
    let age_of = |modified: SystemTime| now.duration_since(modified).unwrap_or(Duration::ZERO);
    let mut removed = 0;
    // キー → （記録と版の新しい方の更新日時、ファイル）
    let mut stored: BTreeMap<String, (SystemTime, Vec<PathBuf>)> = BTreeMap::new();
    for entry in entries.flatten() {
      let name = entry.file_name();
      let Some(name) = name.to_str() else { continue };
      let Some((key, temp)) = stored_file_key(name) else {
        continue;
      };
      let Ok(metadata) = entry.metadata() else { continue };
      if !metadata.is_file() {
        continue;
      }
      let modified = metadata.modified().unwrap_or(UNIX_EPOCH);
      if temp {
        if age_of(modified) > ORPHAN_TEMP_AGE && fs::remove_file(entry.path()).is_ok() {
          removed += 1;
        }
        continue;
      }
      let slot = stored.entry(key.to_string()).or_insert((UNIX_EPOCH, Vec::new()));
      slot.0 = slot.0.max(modified);
      slot.1.push(entry.path());
    }
    let mut kept: Vec<(SystemTime, Vec<PathBuf>)> = Vec::new();
    for (modified, paths) in stored.into_values() {
      if age_of(modified) > self.limits.max_age {
        removed += remove_files(paths);
      } else {
        kept.push((modified, paths));
      }
    }
    if kept.len() > self.limits.max_entries {
      // 新しい順に並べ（同じ日時はキーの順）、上限を超えた古い分を消す
      kept.sort_by(|a, b| b.0.cmp(&a.0).then_with(|| a.1.cmp(&b.1)));
      for (_, paths) in kept.split_off(self.limits.max_entries) {
        removed += remove_files(paths);
      }
    }
    removed
  }
}

/// 掃除が扱うファイルのキーと、一時ファイルか（記録 `<キー>.json`・版 `<キー>.versions.json` とそれぞれの `.tmp`）。ほかは None
/// （触れない）。
fn stored_file_key(name: &str) -> Option<(&str, bool)> {
  let (stem, temp) = match name.strip_suffix(".tmp") {
    Some(stem) => (stem, true),
    None => (name, false),
  };
  versions::versions_file_key(stem)
    .or_else(|| stem.strip_suffix(".json").filter(|key| is_content_key(key)))
    .map(|key| (key, temp))
}

fn remove_files(paths: Vec<PathBuf>) -> usize {
  paths.into_iter().filter(|path| fs::remove_file(path).is_ok()).count()
}

/// 写真の中身。`key` は SHA-256（16 進の小文字 64 文字。編集内容の保存のキーで、クラウドの写真置き場の
/// `contentSha256`）、`size_bytes` は読んだ大きさ（`sizeBytes`、#16365）。どちらも同じ 1 回の読み取りから決める。
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ContentDigest {
  pub key: String,
  pub size_bytes: u64,
}

/// 写真の中身の SHA-256 と大きさ。ふつうのファイルでなければ読まない。
pub fn content_digest(path: &Path) -> io::Result<ContentDigest> {
  if !fs::metadata(path)?.is_file() {
    return Err(io::Error::new(io::ErrorKind::InvalidInput, "not a regular file"));
  }
  let mut file = fs::File::open(path)?;
  let mut hasher = Sha256::new();
  let mut buffer = vec![0u8; HASH_BUFFER_BYTES];
  let mut size_bytes = 0u64;
  loop {
    match file.read(&mut buffer) {
      Ok(0) => break,
      Ok(read) => {
        hasher.update(&buffer[..read]);
        size_bytes += read as u64;
      }
      Err(err) if err.kind() == io::ErrorKind::Interrupted => continue,
      Err(err) => return Err(err),
    }
  }
  Ok(ContentDigest {
    key: hex_lower(&hasher.finalize()),
    size_bytes,
  })
}

/// バイト列の 16 進（小文字）。
pub fn hex_lower(bytes: &[u8]) -> String {
  bytes.iter().map(|byte| format!("{byte:02x}")).collect()
}

/// `content_digest` のキーの形（16 進の小文字 64 文字）か。保存先・キャッシュのパスを組む前に確かめる。
pub fn is_content_key(key: &str) -> bool {
  key.len() == 64
    && key
      .bytes()
      .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
}

/// `write_private_file_atomically` が書く一時ファイル（`<path>.tmp`）。覚えたフォルダ・写真を消すとき
/// （`remembered.rs`）にも使う。
pub(crate) fn temp_path(path: &Path) -> PathBuf {
  let mut name = path.as_os_str().to_owned();
  name.push(".tmp");
  PathBuf::from(name)
}

/// UNIX ミリ秒（1970 年より前は 0。覚えたフォルダ・写真の `addedAtMs`・保存した写真の `modifiedAtMs` も同じ、`remembered.rs`）。
pub fn epoch_ms(time: SystemTime) -> u64 {
  time
    .duration_since(UNIX_EPOCH)
    .map(|duration| duration.as_millis().min(u128::from(u64::MAX)) as u64)
    .unwrap_or_default()
}

#[cfg(unix)]
pub(crate) fn set_mode(path: &Path, mode: u32) -> io::Result<()> {
  use std::os::unix::fs::PermissionsExt;
  fs::set_permissions(path, fs::Permissions::from_mode(mode))
}

#[cfg(not(unix))]
pub(crate) fn set_mode(_path: &Path, _mode: u32) -> io::Result<()> {
  Ok(())
}

/// フォルダを作り、その Mac の利用者だけが開けるようにする（0700。クラウドの写真のキャッシュも使う）。
pub fn ensure_private_dir(path: &Path) -> io::Result<()> {
  fs::create_dir_all(path)?;
  set_mode(path, 0o700)
}

/// `<path>.tmp` に 0600 で書いてから `path` へ rename する（途中で落ちても前の内容か新しい内容のどちらか）。失敗したら
/// 一時ファイルを消す。`path` がシンボリックリンクでも、指す先ではなくリンク自体を置き換える。覚えたフォルダ・写真の
/// 置き場（`remembered.rs`）も使う。
pub(crate) fn write_private_file_atomically(path: &Path, contents: &[u8]) -> io::Result<()> {
  let temp = temp_path(path);
  if let Err(err) = write_private_file(&temp, contents).and_then(|()| fs::rename(&temp, path)) {
    let _ = fs::remove_file(&temp);
    return Err(err);
  }
  Ok(())
}

fn write_private_file(path: &Path, contents: &[u8]) -> io::Result<()> {
  let mut options = fs::OpenOptions::new();
  options.write(true).create(true).truncate(true);
  #[cfg(unix)]
  {
    use std::os::unix::fs::OpenOptionsExt;
    options.mode(0o600);
  }
  let mut file = options.open(path)?;
  file.write_all(contents)?;
  file.flush()?;
  set_mode(path, 0o600)
}

#[path = "saved_versions.rs"]
mod versions;
pub use versions::{
  is_valid_develop_versions, SavedVersions, MAX_AUTO_VERSIONS, MAX_NAMED_VERSIONS, MAX_SAVED_VERSIONS_BYTES,
  MAX_VERSION_NAME_CHARS,
};

#[cfg(test)]
#[path = "saved_settings_tests.rs"]
mod tests;

#[cfg(test)]
#[path = "saved_settings_revision_tests.rs"]
mod revision_tests;
