//公開移植前の内部構成については docs/migration/mac-client.md を参照。
//! 「Desktop bridge」の v16、`features.photoEditingRemembered`）。
//! NIHO Desktop の `photo_remembered.rs` から C2 #18390 で移した。置き場のファイルはアプリが渡す（{@link RememberedStore::new}）。
//!
//! - 覚えるのは、スタッフがネイティブのダイアログで選んだフォルダ（`photo_editing_add_folder`）と写真
//!   （`photo_editing_add_photos`）のパスだけ。置き場は `<app data>/photo-editing/remembered.json`（macOS では
//!   `~/Library/Application Support/life.niho.desktop/photo-editing/remembered.json`）で、形は
//!   `{ "version": 1, "folders": [{ "path", "addedAtMs" }], "photos": [{ "path", "addedAtMs" }] }`。
//! - 新しい順。同じパスは 1 つ（選び直したら先頭へ動かし、`addedAtMs` を今にする）。一度に選んだ写真はダイアログが
//!   返した順に先頭へ並べる。上限はフォルダ 50・写真 2,000 で、超えたら古いものから消す。
//! - フォルダ 0700・ファイル 0600。書き込みは一時ファイル（`remembered.json.tmp`）＋rename（編集内容の保存の
//!   `saved_settings.rs` と同じ。途中で落ちても前の内容か新しい内容のどちらか）。読み書きは 1 つずつ。
//! - 読めない・壊れた・知らない版・大きすぎる（8MB を超える）ファイルと、シンボリックリンクは空として扱い、次に覚える
//!   ときに上書きする。形の違う項目・絶対パスでない項目・同じパスの 2 つ目以降・上限を超えた項目は読み飛ばす。
//! - いま見つからないパス（SD カードを抜いた・消した）も消さない（戻れば `photo_editing_remembered` にまた出る）。
//!   個別に忘れるのはフォルダの「一覧から外す」（NIHO camera。{@link RememberedStore::forget_folder}。中の写真は消さない）。
//!   選んだ写真はまとめて一覧から外せる（{@link RememberedStore::forget_photos}。元の写真とフォルダ登録には触れない）。
//!   `cache_purge`（Mac を返す・渡すとき）は置き場ごと消す（`purge`。パスにユーザー名やフォルダ名が入るため）。
//! - パスはページへ渡さない（ページには `library.rs` が振る `folderId` / `entryId` だけ）。ログにも書かない。
//! - 覚えられないパス（UTF-8 でない・JSON の文字列にして 2KB を超える。macOS のパスは 1KB まで）は覚えない
//!   （その起動の間は ID で使える）。

use crate::saved_settings::{ensure_private_dir, epoch_ms, temp_path, write_private_file_atomically};
use serde_json::{json, Value};
use std::collections::HashSet;
use std::fs;
use std::io::{self, Read};
use std::path::{Path, PathBuf};
use std::sync::{Mutex, MutexGuard};
use std::time::SystemTime;

/// 置き場のファイルの形式の版。これ以外の版のファイルは読まない（空として扱う）。
pub(crate) const REMEMBERED_FORMAT_VERSION: u64 = 1;
/// 覚えるフォルダ・写真の数の上限（超えたら古いものから消す）。
pub(crate) const MAX_REMEMBERED_FOLDERS: usize = 50;
pub(crate) const MAX_REMEMBERED_PHOTOS: usize = 2_000;
/// 覚えるパスの大きさの上限（JSON の文字列にしたときのバイト数）。macOS のパスは 1,024 バイトまでなので、`"` や
/// 制御文字だらけでなければ超えない。置き場のファイルの大きさを抑えるための上限。
const MAX_PATH_JSON_BYTES: usize = 2 * 1024;
/// 1 項目（`{"path":…,"addedAtMs":…},`）の大きさの上限。
const MAX_ENTRY_JSON_BYTES: usize = MAX_PATH_JSON_BYTES + 64;
/// 置き場のファイルの大きさの上限。これを超えるファイルは読まない（空として扱う）。
pub(crate) const MAX_REMEMBERED_FILE_BYTES: u64 = 8 * 1024 * 1024;
// 上限いっぱいに覚えても、書いたファイルが読めない大きさにならない
const _: () = assert!(
  ((MAX_REMEMBERED_FOLDERS + MAX_REMEMBERED_PHOTOS) * MAX_ENTRY_JSON_BYTES + 1024) as u64 <= MAX_REMEMBERED_FILE_BYTES
);

/// 置き場のファイル（`<app data>/photo-editing/remembered.json`。macOS では
/// `~/Library/Application Support/life.niho.desktop/photo-editing/remembered.json`）。
pub fn remembered_path(app_data_dir: &Path) -> PathBuf {
  app_data_dir.join("photo-editing").join("remembered.json")
}

/// 覚える数の上限（テストでは小さくする）。
#[derive(Clone, Copy, Debug)]
pub struct RememberedLimits {
  pub max_folders: usize,
  pub max_photos: usize,
}

impl Default for RememberedLimits {
  fn default() -> Self {
    Self {
      max_folders: MAX_REMEMBERED_FOLDERS,
      max_photos: MAX_REMEMBERED_PHOTOS,
    }
  }
}

/// 覚えたフォルダか写真（パスは Desktop の中だけで持つ）。
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct RememberedEntry {
  pub path: PathBuf,
  /// 覚えた（選び直した）時刻（UNIX ミリ秒）
  pub added_at_ms: u64,
}

/// 覚えたもの（どちらも新しい順）。
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct Remembered {
  pub folders: Vec<RememberedEntry>,
  pub photos: Vec<RememberedEntry>,
}

#[derive(Clone, Copy)]
enum Kind {
  Folders,
  Photos,
}

/// 覚えたフォルダ・写真の置き場（アプリに 1 つ）。
pub struct RememberedStore {
  path: PathBuf,
  limits: RememberedLimits,
  /// 読み書きを直列にする（覚えるのは、読んで先頭に足して書く）
  guard: Mutex<()>,
}

impl RememberedStore {
  pub fn new(path: PathBuf, limits: RememberedLimits) -> Self {
    Self {
      path,
      limits,
      guard: Mutex::new(()),
    }
  }

  pub(crate) fn max_photos(&self) -> usize {
    self.limits.max_photos
  }

  fn lock(&self) -> MutexGuard<'_, ()> {
    self.guard.lock().unwrap_or_else(|poison| poison.into_inner())
  }

  /// 覚えたもの。無い・読めない・壊れている・知らない版・大きすぎるときは空。
  pub fn load(&self) -> Remembered {
    let _guard = self.lock();
    self.read().unwrap_or_default()
  }

  /// 覚えたものを全部消す（`cache_purge`＝スタッフの Mac を返す・渡すとき）。置き場のファイル（シンボリックリンクなら
  /// リンク自体）と、書き込み途中の一時ファイルを消す。無ければ何もしない。消せなければ Err（残ったままにしない）。
  pub fn purge(&self) -> io::Result<()> {
    let _guard = self.lock();
    for path in [self.path.clone(), temp_path(&self.path)] {
      match fs::remove_file(&path) {
        Err(err) if err.kind() != io::ErrorKind::NotFound => return Err(err),
        _ => {}
      }
    }
    Ok(())
  }

  /// フォルダを覚える（同じパスは先頭へ動かす）。
  pub fn remember_folder(&self, folder: &Path, now: SystemTime) -> io::Result<()> {
    self.remember(Kind::Folders, &[folder.to_path_buf()], now)
  }

  /// 覚えたフォルダを一覧から外す（NIHO camera の「一覧から外す」。フォルダと中の写真には触れない）。覚えていなければ何もせず
  /// false。
  pub fn forget_folder(&self, folder: &Path) -> io::Result<bool> {
    let _guard = self.lock();
    let Some(mut remembered) = self.read() else {
      return Ok(false);
    };
    let before = remembered.folders.len();
    remembered.folders.retain(|entry| entry.path != folder);
    if remembered.folders.len() == before {
      return Ok(false);
    }
    self.write(&remembered).map(|()| true)
  }

  /// 一度に選んだ写真を覚える（選んだ順に先頭へ。同じパスは先頭へ動かす）。
  pub fn remember_photos(&self, photos: &[PathBuf], now: SystemTime) -> io::Result<()> {
    self.remember(Kind::Photos, photos, now)
  }

  /// 選んだ写真をすべて一覧から外す。元の写真と覚えたフォルダには触れない。置き場が無ければ false。
  /// 置き場があるのに読めない場合は、参照が残っている可能性があるため成功として扱わない。
  pub fn forget_photos(&self) -> io::Result<bool> {
    let _guard = self.lock();
    match fs::symlink_metadata(&self.path) {
      Err(err) if err.kind() == io::ErrorKind::NotFound => return Ok(false),
      Err(err) => return Err(err),
      Ok(metadata) if !metadata.is_file() || metadata.len() > MAX_REMEMBERED_FILE_BYTES => {
        return Err(io::Error::new(
          io::ErrorKind::InvalidData,
          "remembered store is unreadable",
        ));
      }
      Ok(_) => {}
    }
    let mut remembered = self
      .read()
      .ok_or_else(|| io::Error::new(io::ErrorKind::InvalidData, "remembered store is unreadable"))?;
    if remembered.photos.is_empty() {
      return Ok(false);
    }
    remembered.photos.clear();
    self.write(&remembered).map(|()| true)
  }

  fn remember(&self, kind: Kind, paths: &[PathBuf], now: SystemTime) -> io::Result<()> {
    let added_at_ms = epoch_ms(now);
    let mut chosen = HashSet::new();
    let fresh: Vec<RememberedEntry> = paths
      .iter()
      .filter(|path| is_rememberable(path) && chosen.insert(path.to_path_buf()))
      .map(|path| RememberedEntry {
        path: path.clone(),
        added_at_ms,
      })
      .collect();
    if fresh.is_empty() {
      return Ok(());
    }
    let _guard = self.lock();
    // 読めない・壊れたファイルは空として上書きする
    let mut remembered = self.read().unwrap_or_default();
    let (list, max) = match kind {
      Kind::Folders => (&mut remembered.folders, self.limits.max_folders),
      Kind::Photos => (&mut remembered.photos, self.limits.max_photos),
    };
    let older = std::mem::take(list)
      .into_iter()
      .filter(|entry| !chosen.contains(&entry.path));
    *list = fresh.into_iter().chain(older).take(max).collect();
    self.write(&remembered)
  }

  /// 置き場のファイルを読む。読めない・形が違うときは None。
  fn read(&self) -> Option<Remembered> {
    // シンボリックリンクは辿らない（次に覚えるときに rename でふつうのファイルに置き換わる）
    let metadata = fs::symlink_metadata(&self.path).ok()?;
    if !metadata.is_file() || metadata.len() > MAX_REMEMBERED_FILE_BYTES {
      return None;
    }
    let mut bytes = Vec::new();
    fs::File::open(&self.path)
      .ok()?
      .take(MAX_REMEMBERED_FILE_BYTES + 1)
      .read_to_end(&mut bytes)
      .ok()?;
    if bytes.len() as u64 > MAX_REMEMBERED_FILE_BYTES {
      return None;
    }
    let record: Value = serde_json::from_slice(&bytes).ok()?;
    if record.get("version").and_then(Value::as_u64) != Some(REMEMBERED_FORMAT_VERSION) {
      return None;
    }
    let folders = record.get("folders")?.as_array()?;
    let photos = record.get("photos")?.as_array()?;
    Some(Remembered {
      folders: read_entries(folders, self.limits.max_folders),
      photos: read_entries(photos, self.limits.max_photos),
    })
  }

  fn write(&self, remembered: &Remembered) -> io::Result<()> {
    let body = serde_json::to_vec(&json!({
      "version": REMEMBERED_FORMAT_VERSION,
      "folders": remembered.folders.iter().map(entry_json).collect::<Vec<_>>(),
      "photos": remembered.photos.iter().map(entry_json).collect::<Vec<_>>(),
    }))
    .map_err(io::Error::other)?;
    if let Some(dir) = self.path.parent() {
      ensure_private_dir(dir)?;
    }
    write_private_file_atomically(&self.path, &body)
  }
}

fn entry_json(entry: &RememberedEntry) -> Value {
  json!({ "path": entry.path.to_string_lossy(), "addedAtMs": entry.added_at_ms })
}

/// ファイルの項目を読む（形の違う項目・覚えられないパス・同じパスの 2 つ目以降は飛ばし、`max` 個まで）。
fn read_entries(items: &[Value], max: usize) -> Vec<RememberedEntry> {
  let mut seen = HashSet::new();
  items
    .iter()
    .filter_map(read_entry)
    .filter(|entry| seen.insert(entry.path.clone()))
    .take(max)
    .collect()
}

fn read_entry(item: &Value) -> Option<RememberedEntry> {
  let path = PathBuf::from(item.get("path")?.as_str()?);
  let added_at_ms = item.get("addedAtMs")?.as_u64()?;
  is_rememberable(&path).then_some(RememberedEntry { path, added_at_ms })
}

/// 覚えられるパスか（UTF-8 の絶対パスで、NUL を含まず、JSON の文字列にして 2KB まで）。
fn is_rememberable(path: &Path) -> bool {
  let Some(text) = path.to_str() else { return false };
  path.is_absolute()
    && !text.contains('\0')
    && serde_json::to_string(text).is_ok_and(|quoted| quoted.len() <= MAX_PATH_JSON_BYTES)
}

#[cfg(test)]
#[path = "remembered_tests.rs"]
mod tests;
