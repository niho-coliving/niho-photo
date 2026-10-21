//! 写真の選別のフラグ（採用 / 却下。niho-photo#47。Lightroom のフラグ）を、この Mac に 1 つのファイルで持つ（{@link FlagStore}）。
//!
//! - 鍵は一覧の写真の名前・大きさ・更新日時（一覧の `fileName`・`sizeBytes`・`modifiedAt`）の SHA-256（{@link flag_key}）。一覧では
//!   写真の中身を読まない（中身の SHA-256 は開くまで分からない）ので、一覧で読み書きできる値で鍵を作る。フォルダを読み直しても・
//!   次に起動しても同じ写真に付く。名前を変えた・ほかのアプリで書き換えた写真は外れる（別の写真として扱う）。名前・大きさ・
//!   更新日時の同じ写真（Finder で写したもの）は、別のフォルダにあっても同じ印になる（一覧の「補正済み」の見分け方と同じ）。
//! - 消した写真のフラグ（孤児）は別の写真に付かない: SD カードを初期化して同じ名前で撮り直しても、更新日時が違うので別の鍵になる。
//!   残った記録は件数の上限（{@link MAX_FLAGS}）を超えたら、付けた日時の古い順に消す。
//! - 置き場は `<app data>/photo-editing/flags.json`（{@link flags_path}。`{ version: 1, flags: { <鍵>: { flag, updatedAtMs } } }`、
//!   `flag` は `pick` か `reject`）。写真のパス・名前は残さない（鍵は SHA-256 の 16 進）。フラグを外した写真は記録から消す。
//! - 書き方は補正の保存（`saved_settings.rs`）と同じ: フォルダ 0700・ファイル 0600・一時ファイル＋rename（途中で落ちても前の内容か
//!   新しい内容のどちらか）。読み書きは 1 つずつ。
//! - 読めない・壊れた・知らない版・大きすぎる（{@link MAX_FLAGS_FILE_BYTES} を超える）ファイルとシンボリックリンクは「フラグなし」と
//!   して扱い、次に付けるときに上書きする。形の違う項目（鍵の形・知らないフラグ）は読み飛ばす。
//! - 最初に読んだ内容を覚え、付けるたびに覚えた内容とファイルを書き換える（一覧のたびにファイルを読まない）。書けなければ覚えた内容も
//!   変えない。

use crate::library::iso8601_utc;
use crate::saved_settings::{ensure_private_dir, epoch_ms, hex_lower, is_content_key, write_private_file_atomically};
use serde_json::{json, Map, Value};
use sha2::{Digest, Sha256};
use std::collections::BTreeMap;
use std::fs;
use std::io::{self, Read};
use std::path::{Path, PathBuf};
use std::sync::{Mutex, MutexGuard};
use std::time::{SystemTime, UNIX_EPOCH};

/// 置き場のファイルの形式の版。これ以外の版のファイルは読まない（「フラグなし」として扱う）。
pub(crate) const FLAGS_FORMAT_VERSION: u64 = 1;
/// 覚えるフラグの数の上限（超えたら付けた日時の古い順に消す）。
pub const MAX_FLAGS: usize = 50_000;
/// 1 項目（`"<鍵 64 文字>":{"flag":"reject","updatedAtMs":<u64>},`）の大きさの上限。
const MAX_ENTRY_JSON_BYTES: usize = 128;
/// 置き場のファイルの大きさの上限。これを超えるファイルは読まない（「フラグなし」として扱う）。
pub const MAX_FLAGS_FILE_BYTES: u64 = 8 * 1024 * 1024;
// 上限いっぱいに覚えても、書いたファイルが読めない大きさにならない
const _: () = assert!((MAX_FLAGS * MAX_ENTRY_JSON_BYTES + 1024) as u64 <= MAX_FLAGS_FILE_BYTES);
/// 鍵の SHA-256 の前置き（ほかの SHA-256 と混ざらないように）。
const FLAG_KEY_DOMAIN: &[u8] = b"niho-photo-flag/v1";

/// 置き場のファイル（`<app data>/photo-editing/flags.json`。NIHO camera は
/// `~/Library/Application Support/life.niho.camera/photo-editing/flags.json`）。
pub fn flags_path(app_data_dir: &Path) -> PathBuf {
  app_data_dir.join("photo-editing").join("flags.json")
}

/// 選別のフラグ（画面の `PhotoLibraryFlag`）。
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum PhotoFlag {
  /// 採用
  Pick,
  /// 却下
  Reject,
}

impl PhotoFlag {
  /// 画面とファイルの形（`pick` / `reject`）。
  pub fn as_str(self) -> &'static str {
    match self {
      Self::Pick => "pick",
      Self::Reject => "reject",
    }
  }

  /// `pick` / `reject`（ほかは None）。
  pub fn parse(text: &str) -> Option<Self> {
    match text {
      "pick" => Some(Self::Pick),
      "reject" => Some(Self::Reject),
      _ => None,
    }
  }
}

/// 覚えたフラグと、付けた時刻（UNIX ミリ秒。上限を超えたときに古い順に消す）。
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct StoredFlag {
  pub flag: PhotoFlag,
  pub updated_at_ms: u64,
}

/// 覚える数の上限（テストでは小さくする）。
#[derive(Clone, Copy, Debug)]
pub struct FlagLimits {
  pub max_flags: usize,
}

impl Default for FlagLimits {
  fn default() -> Self {
    Self { max_flags: MAX_FLAGS }
  }
}

/// 一覧の写真のフラグの鍵（名前・大きさ・一覧の `modifiedAt` の形の更新日時の SHA-256。16 進の小文字 64 文字）。
pub fn flag_key(file_name: &str, size_bytes: u64, modified_at: &str) -> String {
  let mut hasher = Sha256::new();
  hasher.update(FLAG_KEY_DOMAIN);
  for part in [
    file_name.as_bytes(),
    size_bytes.to_string().as_bytes(),
    modified_at.as_bytes(),
  ] {
    hasher.update([0]);
    hasher.update(part);
  }
  hex_lower(&hasher.finalize())
}

/// いまのファイルの鍵（一覧と同じ決まり: 名前はパスの最後の段、大きさと更新日時はシンボリックリンクをたどらない `metadata`）。
/// 無い・ふつうのファイルでない・名前の無いパスは None。
pub fn flag_key_for_file(path: &Path) -> Option<String> {
  let file_name = path.file_name()?.to_string_lossy().into_owned();
  let metadata = fs::symlink_metadata(path).ok()?;
  if !metadata.is_file() {
    return None;
  }
  let modified = metadata.modified().unwrap_or(UNIX_EPOCH);
  Some(flag_key(&file_name, metadata.len(), &iso8601_utc(modified)))
}

/// 選別のフラグの置き場（アプリに 1 つ）。
pub struct FlagStore {
  path: PathBuf,
  limits: FlagLimits,
  /// 読んだ内容（最初に使うときに読む）。読み書きを直列にする
  state: Mutex<Option<BTreeMap<String, StoredFlag>>>,
}

impl FlagStore {
  pub fn new(path: PathBuf, limits: FlagLimits) -> Self {
    Self {
      path,
      limits,
      state: Mutex::new(None),
    }
  }

  fn lock(&self) -> MutexGuard<'_, Option<BTreeMap<String, StoredFlag>>> {
    self.state.lock().unwrap_or_else(|poison| poison.into_inner())
  }

  /// 鍵のフラグ（無ければ None）。
  pub fn get(&self, key: &str) -> Option<PhotoFlag> {
    self.with_lookup(|lookup| lookup(key))
  }

  /// 覚えたフラグを鍵で引く関数を `run` に渡す（一覧の写真に印を付ける間、1 回だけ読む）。
  pub fn with_lookup<R>(&self, run: impl FnOnce(&dyn Fn(&str) -> Option<PhotoFlag>) -> R) -> R {
    let mut guard = self.lock();
    let flags = guard.get_or_insert_with(|| read_flags(&self.path, self.limits));
    run(&|key: &str| flags.get(key).map(|stored| stored.flag))
  }

  /// 覚えたフラグの数。
  pub fn len(&self) -> usize {
    let mut guard = self.lock();
    guard.get_or_insert_with(|| read_flags(&self.path, self.limits)).len()
  }

  /// 覚えたフラグが無いか。
  pub fn is_empty(&self) -> bool {
    self.len() == 0
  }

  /// `keys` の写真のフラグを `flag` にする（None は外す = 記録から消す）。付けた時刻は `now`。変わらなければ書かない。上限を超えたら
  /// 付けた日時の古い順に消す。鍵の形でない（16 進の小文字 64 文字でない）ものがあれば何もせず `InvalidInput`。書けなければ Err で、
  /// 覚えた内容も変えない。
  pub fn set(&self, keys: &[String], flag: Option<PhotoFlag>, now: SystemTime) -> io::Result<()> {
    if keys.iter().any(|key| !is_content_key(key)) {
      return Err(io::Error::new(io::ErrorKind::InvalidInput, "not a flag key"));
    }
    let mut guard = self.lock();
    let current = guard.get_or_insert_with(|| read_flags(&self.path, self.limits));
    let updated_at_ms = epoch_ms(now);
    let mut next = current.clone();
    for key in keys {
      match flag {
        Some(flag) => {
          if next.get(key).map(|stored| stored.flag) != Some(flag) {
            next.insert(key.clone(), StoredFlag { flag, updated_at_ms });
          }
        }
        None => {
          next.remove(key);
        }
      }
    }
    keep_newest(&mut next, self.limits.max_flags);
    if next == *current {
      return Ok(());
    }
    write_flags(&self.path, &next)?;
    *current = next;
    Ok(())
  }
}

/// 上限を超えた分を、付けた日時の古い順（同じなら鍵の順）に消す。
fn keep_newest(flags: &mut BTreeMap<String, StoredFlag>, max: usize) {
  if flags.len() <= max {
    return;
  }
  let mut order: Vec<(u64, String)> = flags
    .iter()
    .map(|(key, stored)| (stored.updated_at_ms, key.clone()))
    .collect();
  order.sort();
  let excess = flags.len() - max;
  for (_, key) in order.into_iter().take(excess) {
    flags.remove(&key);
  }
}

/// 置き場のファイルを読む。無い・読めない・形が違うときは空（「フラグなし」）。
fn read_flags(path: &Path, limits: FlagLimits) -> BTreeMap<String, StoredFlag> {
  let mut flags = read_file(path).unwrap_or_default();
  keep_newest(&mut flags, limits.max_flags);
  flags
}

fn read_file(path: &Path) -> Option<BTreeMap<String, StoredFlag>> {
  // シンボリックリンクは辿らない（次に付けるときに rename でふつうのファイルに置き換わる）
  let metadata = fs::symlink_metadata(path).ok()?;
  if !metadata.is_file() || metadata.len() > MAX_FLAGS_FILE_BYTES {
    return None;
  }
  let mut bytes = Vec::new();
  fs::File::open(path)
    .ok()?
    .take(MAX_FLAGS_FILE_BYTES + 1)
    .read_to_end(&mut bytes)
    .ok()?;
  if bytes.len() as u64 > MAX_FLAGS_FILE_BYTES {
    return None;
  }
  let record: Value = serde_json::from_slice(&bytes).ok()?;
  if record.get("version").and_then(Value::as_u64) != Some(FLAGS_FORMAT_VERSION) {
    return None;
  }
  let items = record.get("flags")?.as_object()?;
  Some(
    items
      .iter()
      .filter_map(|(key, item)| {
        if !is_content_key(key) {
          return None;
        }
        let flag = PhotoFlag::parse(item.get("flag")?.as_str()?)?;
        let updated_at_ms = item.get("updatedAtMs").and_then(Value::as_u64).unwrap_or(0);
        Some((key.clone(), StoredFlag { flag, updated_at_ms }))
      })
      .collect(),
  )
}

fn write_flags(path: &Path, flags: &BTreeMap<String, StoredFlag>) -> io::Result<()> {
  let items: Map<String, Value> = flags
    .iter()
    .map(|(key, stored)| {
      (
        key.clone(),
        json!({ "flag": stored.flag.as_str(), "updatedAtMs": stored.updated_at_ms }),
      )
    })
    .collect();
  let body =
    serde_json::to_vec(&json!({ "version": FLAGS_FORMAT_VERSION, "flags": items })).map_err(io::Error::other)?;
  if let Some(dir) = path.parent() {
    ensure_private_dir(dir)?;
  }
  write_private_file_atomically(path, &body)
}

#[cfg(test)]
#[path = "saved_flags_tests.rs"]
mod tests;
