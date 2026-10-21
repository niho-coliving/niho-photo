//! 補正の版（niho-photo#42。Lightroom の「バージョン」）。写真ごとに、名前を付けて残した補正と、切り替える前に残した自動の版の
//! 配列を持つ（{@link SavedSettingsStore::load_versions}・{@link SavedSettingsStore::save_versions}）。
//!
//! - 置き場は補正と同じフォルダの `<キー>.versions.json`（`{ version, revision, updatedAtMs, versions }`）。補正の記録
//!   （`<キー>.json`）には足さない: 旧版の NIHO は記録を `serde_json::Value` から組み立て直して書くので、足した項目は消える。別の
//!   ファイルなら、旧版の NIHO は読まず・消さず（旧版の掃除が見るのは `<キー>.json` と `<キー>.json.tmp` だけ）、版の無い今までどおりに
//!   開ける。
//! - 書き方は補正と同じ（フォルダ 0700・ファイル 0600・一時ファイル＋rename・写真のパスは残さない）。読めない・壊れた・知らない
//!   形式・大きすぎる・中身の形が違うファイルは「版なし」（`revision` 0。次の保存で上書きされる）。
//! - 保存の番号 `revision` は保存のたびに 1 つ増やし、画面が知っている番号と違えば書かずに競合を返す（{@link SaveRevision::Conflict}）。
//!   補正の記録の `revision` とは別に数える。
//! - 上限: 名前つき {@link MAX_NAMED_VERSIONS}・自動 {@link MAX_AUTO_VERSIONS}、1 つの版の補正は {@link MAX_SAVED_SETTINGS_BYTES}、
//!   版の配列全体は {@link MAX_SAVED_VERSIONS_BYTES}。
//! - 版のファイルは補正の記録と一緒に消す（{@link SavedSettingsStore::forget} と掃除。掃除は同じキーの記録と版を 1 件として、新しい方の
//!   更新日時で古さ・件数を数える）。

use super::{
  ensure_private_dir, epoch_ms, is_content_key, write_private_file_atomically, SaveRevision, SavedSettingsStore,
  MAX_SAVED_SETTINGS_BYTES,
};
use serde_json::{json, Value};
use std::collections::HashSet;
use std::fs;
use std::io;
use std::path::{Path, PathBuf};
use std::time::SystemTime;

/// 版のファイルの形式の版。これ以外の版のファイルは読まない。
pub(crate) const SAVED_VERSIONS_FORMAT_VERSION: u64 = 1;
/// 版のファイルの名前の末尾（`<キー>.versions.json`）。
pub(crate) const VERSIONS_FILE_SUFFIX: &str = ".versions.json";
/// 名前つきの版の数の上限。
pub const MAX_NAMED_VERSIONS: usize = 30;
/// 自動の版（切り替える前の補正）の数の上限。画面があふれた分を古い順に消してから保存する。
pub const MAX_AUTO_VERSIONS: usize = 10;
/// 版の名前の上限（文字数。前後の空白は画面が除いてから送る）。
pub const MAX_VERSION_NAME_CHARS: usize = 40;
/// 版の配列（`versions` の JSON）の大きさの上限。
pub const MAX_SAVED_VERSIONS_BYTES: usize = 2 * 1024 * 1024;
/// 版のファイル 1 つの上限（配列＋形式の版・日時）。これを超えるファイルは読まない。
const MAX_VERSIONS_FILE_BYTES: u64 = MAX_SAVED_VERSIONS_BYTES as u64 + 4 * 1024;
/// 版の ID・日時の文字列の上限（バイト）。
const MAX_VERSION_ID_BYTES: usize = 64;
const MAX_VERSION_CREATED_AT_BYTES: usize = 64;
/// 版 1 つの項目（これ以外の項目を持つ版は形が違う）。
const VERSION_KEYS: [&str; 5] = ["id", "name", "createdAt", "kind", "developSettings"];

/// 保存した版（{@link SavedSettingsStore::load_versions}）。`versions` は版の配列（{@link is_valid_develop_versions} を満たす）。
#[derive(Clone, Debug, PartialEq)]
pub struct SavedVersions {
  pub versions: Value,
  /// 保存のたびに 1 ずつ増える番号（版のファイルが無ければ 0）
  pub revision: u64,
  pub updated_at_ms: u64,
}

/// `<キー>.versions.json` の名前のキー（版のファイルでなければ None）。
pub(crate) fn versions_file_key(name: &str) -> Option<&str> {
  name
    .strip_suffix(VERSIONS_FILE_SUFFIX)
    .filter(|key| is_content_key(key))
}

/// 版の配列の形か: 版 1 つは `{ id, name, createdAt, kind, developSettings }` だけを持ち、`id` は写真の中で重ならない英数字・`-`・`_`
/// （64 バイトまで）、`name` は前後に空白の無い 1〜{@link MAX_VERSION_NAME_CHARS} 文字（制御文字なし）、`kind` は `named` か
/// `auto`、`developSettings` はオブジェクト（{@link MAX_SAVED_SETTINGS_BYTES} まで）。名前つき・自動の数と配列全体の大きさの上限も
/// 見る。保存の前（画面の要求）と読むとき（ファイル）の両方で使う。
pub fn is_valid_develop_versions(versions: &Value) -> bool {
  let Some(items) = versions.as_array() else {
    return false;
  };
  let mut ids = HashSet::new();
  let (mut named, mut auto) = (0usize, 0usize);
  for item in items {
    let Some(version) = item.as_object() else {
      return false;
    };
    if version.len() != VERSION_KEYS.len() || !VERSION_KEYS.iter().all(|key| version.contains_key(*key)) {
      return false;
    }
    let id = version["id"].as_str().unwrap_or_default();
    let valid_id = !id.is_empty()
      && id.len() <= MAX_VERSION_ID_BYTES
      && id
        .bytes()
        .all(|byte| byte.is_ascii_alphanumeric() || byte == b'-' || byte == b'_');
    if !valid_id || !ids.insert(id) {
      return false;
    }
    let Some(name) = version["name"].as_str() else {
      return false;
    };
    let length = name.chars().count();
    if name.trim() != name || length == 0 || length > MAX_VERSION_NAME_CHARS || name.chars().any(char::is_control) {
      return false;
    }
    let created_at = version["createdAt"].as_str().unwrap_or_default();
    if created_at.is_empty() || created_at.len() > MAX_VERSION_CREATED_AT_BYTES {
      return false;
    }
    match version["kind"].as_str() {
      Some("named") => named += 1,
      Some("auto") => auto += 1,
      _ => return false,
    }
    let settings = &version["developSettings"];
    let size = serde_json::to_vec(settings).map_or(usize::MAX, |bytes| bytes.len());
    if !settings.is_object() || size > MAX_SAVED_SETTINGS_BYTES {
      return false;
    }
  }
  named <= MAX_NAMED_VERSIONS
    && auto <= MAX_AUTO_VERSIONS
    && serde_json::to_vec(versions).is_ok_and(|bytes| bytes.len() <= MAX_SAVED_VERSIONS_BYTES)
}

impl SavedSettingsStore {
  fn versions_path(&self, key: &str) -> io::Result<PathBuf> {
    if !is_content_key(key) {
      return Err(io::Error::new(io::ErrorKind::InvalidInput, "not a content key"));
    }
    Ok(self.dir.join(format!("{key}{VERSIONS_FILE_SUFFIX}")))
  }

  /// 保存した版。無い・読めない・壊れている・知らない形式・大きすぎる・中身の形が違うときは None（画面は「版なし」・`revision` 0）。
  pub fn load_versions(&self, key: &str) -> Option<SavedVersions> {
    let path = self.versions_path(key).ok()?;
    let _guard = self.lock();
    read_versions(&path)
  }

  /// 版の配列をまるごと保存する。今の `revision`（版のファイルが無い・読めないときは 0）が `expected_revision` と違えば書かずに
  /// {@link SaveRevision::Conflict}。書いたら `revision` を 1 つ増やす（掃除は補正の保存がするので、ここではしない）。形の違う配列は
  /// `InvalidInput`（{@link is_valid_develop_versions}）。
  pub fn save_versions(
    &self,
    key: &str,
    versions: &Value,
    expected_revision: u64,
    now: SystemTime,
  ) -> io::Result<SaveRevision> {
    let path = self.versions_path(key)?;
    if !is_valid_develop_versions(versions) {
      return Err(io::Error::new(io::ErrorKind::InvalidInput, "invalid develop versions"));
    }
    let _guard = self.lock();
    let current = read_versions(&path).map_or(0, |saved| saved.revision);
    if current != expected_revision {
      return Ok(SaveRevision::Conflict { current });
    }
    let revision = current + 1;
    let body = serde_json::to_vec(&json!({
      "version": SAVED_VERSIONS_FORMAT_VERSION,
      "revision": revision,
      "updatedAtMs": epoch_ms(now),
      "versions": versions,
    }))
    .map_err(io::Error::other)?;
    ensure_private_dir(&self.dir)?;
    write_private_file_atomically(&path, &body)?;
    Ok(SaveRevision::Saved { revision, swept: None })
  }
}

fn read_versions(path: &Path) -> Option<SavedVersions> {
  let metadata = fs::metadata(path).ok()?;
  if !metadata.is_file() || metadata.len() > MAX_VERSIONS_FILE_BYTES {
    return None;
  }
  let record: Value = serde_json::from_slice(&fs::read(path).ok()?).ok()?;
  if record.get("version").and_then(Value::as_u64) != Some(SAVED_VERSIONS_FORMAT_VERSION) {
    return None;
  }
  let versions = record
    .get("versions")
    .filter(|versions| is_valid_develop_versions(versions))?;
  Some(SavedVersions {
    versions: versions.clone(),
    revision: record.get("revision").and_then(Value::as_u64)?,
    updated_at_ms: record.get("updatedAtMs").and_then(Value::as_u64).unwrap_or(0),
  })
}

#[cfg(test)]
#[path = "saved_versions_tests.rs"]
mod tests;
