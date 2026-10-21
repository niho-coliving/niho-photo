//! 部分補正（マスク）の面（ブラシ・被写体・空。docs/local-adjustments.md「面の受け渡し」、niho-photo#68）のこの Mac の置き場。
//! 保存先のフォルダはアプリが渡す（{@link MaskSurfaceStore::new}。NIHO camera は `<app data>/mask-surfaces`）。Tauri に依存しない。
//!
//! - `<dir>/<写真のキー>/<面の id>.png` に 1 面 1 ファイル。写真のキーは写真の中身の SHA-256（保存した補正
//!   `saved_settings.rs` と同じキー。名前を変えても・動かしても同じ写真なら同じ面が付いてくる）、面の id は PNG の中身の
//!   SHA-256（16 進の小文字 64 文字。補正の `masks[].surface.id`）。同じ id の中身は変わらない（不変）。フォルダは 0700、
//!   ファイルは 0600、書き込みは一時ファイル＋rename（`saved_settings.rs` と同じ）。
//! - パスを組む前に、写真のキーと面の id が 16 進の小文字 64 文字かを確かめる（フォルダの外・別の写真の面を指させない）。
//!   シンボリックリンクのファイルは読まない。
//! - 保存（{@link MaskSurfaceStore::save}）: 8 MiB 以下の、8bit グレーの PNG（色の型 0・深さ 8・1〜4096 画素・透明 `tRNS`
//!   とアニメーション `acTL` なし）だけを受け、中身の SHA-256 を id にして返す。同じ中身は書き直さない。画素まで読むのは
//!   エンジン（書き出しの `niho-develop-render --mask-surface`・画面の wasm の `Developer.setMaskSurface`）で、ここでは
//!   ヘッダー（署名・IHDR とその CRC・最初の IDAT までの chunk）と大きさと SHA-256 を確かめる。
//! - 読み出し（{@link MaskSurfaceStore::load}）: 上限の大きさまで読み、中身の SHA-256 を名前と照らす（壊れた・置き換わった
//!   ファイルは渡さない）。
//! - 上限: 写真 1 枚あたり {@link MaskSurfaceLimits::max_per_photo}（既定 64）面・1 面 {@link MaskSurfaceLimits::max_bytes}
//!   （既定 8 MiB）。上限の数に達した写真へ新しい面を保存するときは、残すもの（`keep`。アプリが渡す、保存した補正が参照する面）
//!   以外で最後に使った（保存・読み出し。ファイルの更新日時）のが古いものから消して空ける。消せるものが無ければ
//!   {@link MaskSurfaceError::QuotaExceeded}。古い面は undo の古い版だけが参照していることがあり、その版に戻すと面が無い
//!   （`maskSurfaceMissing`）ことになる。
//! - 掃除: 保存した補正（NIHO camera は古さ・件数では消さない）と同じく、写真の数・古さでは消さない。写真ごとの上限が大きさを
//!   抑える（ふつうのブラシの面は数十 KB）。写真の補正を消すときは {@link MaskSurfaceStore::forget_photo} で面も消す。
//!   途中で落ちた書き込みの一時ファイルは、その写真へ次に保存するときに 1 時間を過ぎたものを消す。

use crate::saved_settings::{ensure_private_dir, hex_lower, is_content_key, write_private_file_atomically};
use serde_json::Value;
use sha2::{Digest, Sha256};
use std::collections::BTreeSet;
use std::fmt;
use std::fs;
use std::io::{self, Read};
use std::path::{Path, PathBuf};
use std::sync::{Mutex, MutexGuard};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

/// NIHO camera の置き場（`<app data>/mask-surfaces`）。
pub const MASK_SURFACES_DIR_NAME: &str = "mask-surfaces";
/// 1 面の PNG の上限（エンジンの `MAX_SURFACE_PNG_BYTES` と同じ）。
pub const MAX_MASK_SURFACE_BYTES: usize = 8 * 1024 * 1024;
/// 面の 1 辺の上限（補正の `surface.width` / `surface.height` と同じ）。
pub const MAX_MASK_SURFACE_SIDE: u32 = 4096;
/// 写真 1 枚あたりの面の数の既定の上限。
pub const DEFAULT_MAX_SURFACES_PER_PHOTO: usize = 64;
/// 途中で落ちた書き込みの一時ファイルを消すまでの時間（書き込み中のものは消さない）。
const ORPHAN_TEMP_AGE: Duration = Duration::from_secs(60 * 60);
const PNG_SIGNATURE: &[u8; 8] = b"\x89PNG\r\n\x1a\n";

/// 置き場の上限。
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct MaskSurfaceLimits {
  /// 写真 1 枚あたりの面の数
  pub max_per_photo: usize,
  /// 1 面の PNG の大きさ（{@link MAX_MASK_SURFACE_BYTES} を超えない）
  pub max_bytes: usize,
}

impl Default for MaskSurfaceLimits {
  fn default() -> Self {
    Self {
      max_per_photo: DEFAULT_MAX_SURFACES_PER_PHOTO,
      max_bytes: MAX_MASK_SURFACE_BYTES,
    }
  }
}

/// 保存した面（`id` は PNG の中身の SHA-256）。
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct MaskSurfaceInfo {
  pub id: String,
  pub width: u32,
  pub height: u32,
}

/// 面の置き場の失敗。
#[derive(Debug)]
pub enum MaskSurfaceError {
  /// 写真のキー・面の id が 16 進の小文字 64 文字でない
  InvalidId,
  /// 受け付けない PNG（理由。8bit グレーでない・寸法が範囲外・壊れたヘッダーなど）
  InvalidPng(&'static str),
  /// 上限の大きさを超える
  TooLarge,
  /// 写真 1 枚の上限の数に達していて、空けられる面が無い
  QuotaExceeded,
  /// その写真にその面が無い
  NotFound,
  /// 置き場のファイルが壊れている・名前と中身が合わない・ふつうのファイルでない
  Corrupt,
  /// 読み書きの失敗
  Io(io::ErrorKind),
}

impl fmt::Display for MaskSurfaceError {
  fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
    match self {
      MaskSurfaceError::InvalidId => write!(f, "not a 64-digit lowercase hex key or surface id"),
      MaskSurfaceError::InvalidPng(reason) => write!(f, "not a mask surface PNG: {reason}"),
      MaskSurfaceError::TooLarge => write!(f, "the mask surface is too large"),
      MaskSurfaceError::QuotaExceeded => write!(f, "the photo has as many mask surfaces as it can keep"),
      MaskSurfaceError::NotFound => write!(f, "no such mask surface"),
      MaskSurfaceError::Corrupt => write!(f, "the stored mask surface is damaged"),
      MaskSurfaceError::Io(kind) => write!(f, "mask surface I/O: {kind}"),
    }
  }
}

impl std::error::Error for MaskSurfaceError {}

impl From<io::Error> for MaskSurfaceError {
  fn from(error: io::Error) -> Self {
    MaskSurfaceError::Io(error.kind())
  }
}

/// 面の置き場（アプリに 1 つ）。
pub struct MaskSurfaceStore {
  dir: PathBuf,
  limits: MaskSurfaceLimits,
  /// 保存・読み出し（更新日時を進める）・削除を直列にする
  guard: Mutex<()>,
}

impl MaskSurfaceStore {
  pub fn new(dir: PathBuf, limits: MaskSurfaceLimits) -> Self {
    Self {
      dir,
      limits,
      guard: Mutex::new(()),
    }
  }

  pub fn limits(&self) -> &MaskSurfaceLimits {
    &self.limits
  }

  fn lock(&self) -> MutexGuard<'_, ()> {
    self.guard.lock().unwrap_or_else(|poison| poison.into_inner())
  }

  fn photo_dir(&self, photo_key: &str) -> Result<PathBuf, MaskSurfaceError> {
    if !is_content_key(photo_key) {
      return Err(MaskSurfaceError::InvalidId);
    }
    Ok(self.dir.join(photo_key))
  }

  fn surface_path(&self, photo_key: &str, id: &str) -> Result<PathBuf, MaskSurfaceError> {
    let dir = self.photo_dir(photo_key)?;
    if !is_content_key(id) {
      return Err(MaskSurfaceError::InvalidId);
    }
    Ok(dir.join(format!("{id}.png")))
  }

  /// 面を保存して `{ id, width, height }` を返す（module docs の形の PNG だけ）。同じ中身が既にあれば書き直さず、最後に使った
  /// 日時だけを進める。写真の面が上限の数に達していれば、`keep` 以外で最後に使ったのが古いものから消して空ける。
  pub fn save(
    &self,
    photo_key: &str,
    png: &[u8],
    keep: &BTreeSet<String>,
    now: SystemTime,
  ) -> Result<MaskSurfaceInfo, MaskSurfaceError> {
    let dir = self.photo_dir(photo_key)?;
    if png.len() > self.limits.max_bytes.min(MAX_MASK_SURFACE_BYTES) {
      return Err(MaskSurfaceError::TooLarge);
    }
    let (width, height) = inspect_mask_surface_png(png)?;
    let id = mask_surface_id(png);
    let info = MaskSurfaceInfo { id, width, height };
    let path = dir.join(format!("{}.png", info.id));
    let _guard = self.lock();
    if self.read_verified(&path, &info.id).is_ok() {
      touch(&path, now);
      return Ok(info);
    }
    let surfaces = self.surfaces_in(&dir, now);
    let others: Vec<&(SystemTime, String)> = surfaces.iter().filter(|(_, id)| *id != info.id).collect();
    if others.len() >= self.limits.max_per_photo {
      // 最後に使ったのが古い順に、残すもの以外を消して 1 つ空ける
      let excess = others.len() + 1 - self.limits.max_per_photo;
      let evictable: Vec<&&(SystemTime, String)> = others.iter().filter(|(_, id)| !keep.contains(id)).collect();
      if evictable.len() < excess {
        return Err(MaskSurfaceError::QuotaExceeded);
      }
      for (_, id) in evictable.into_iter().take(excess) {
        fs::remove_file(dir.join(format!("{id}.png")))?;
      }
    }
    ensure_private_dir(&self.dir)?;
    ensure_private_dir(&dir)?;
    write_private_file_atomically(&path, png)?;
    touch(&path, now);
    Ok(info)
  }

  /// 面の PNG（中身の SHA-256 を名前と照らしたもの）。読めたら最後に使った日時を進める。
  pub fn load(&self, photo_key: &str, id: &str, now: SystemTime) -> Result<Vec<u8>, MaskSurfaceError> {
    let path = self.surface_path(photo_key, id)?;
    let _guard = self.lock();
    let bytes = self.read_verified(&path, id)?;
    touch(&path, now);
    Ok(bytes)
  }

  /// その写真にその面があるか（ファイルがあるかだけを見る。中身は {@link MaskSurfaceStore::load} で照らす）。
  pub fn contains(&self, photo_key: &str, id: &str) -> bool {
    let Ok(path) = self.surface_path(photo_key, id) else {
      return false;
    };
    fs::symlink_metadata(path).is_ok_and(|metadata| metadata.is_file())
  }

  /// その写真の面の id（辞書順）。
  pub fn list(&self, photo_key: &str) -> Vec<String> {
    let Ok(dir) = self.photo_dir(photo_key) else {
      return Vec::new();
    };
    let _guard = self.lock();
    let mut ids: Vec<String> = self
      .surfaces_in(&dir, SystemTime::now())
      .into_iter()
      .map(|(_, id)| id)
      .collect();
    ids.sort();
    ids
  }

  /// その写真の面をすべて消す（写真の補正を消すとき）。面の形でないファイルには触れず、フォルダが空なら消す。
  pub fn forget_photo(&self, photo_key: &str) -> Result<(), MaskSurfaceError> {
    let dir = self.photo_dir(photo_key)?;
    let _guard = self.lock();
    let entries = match fs::read_dir(&dir) {
      Ok(entries) => entries,
      Err(err) if err.kind() == io::ErrorKind::NotFound => return Ok(()),
      Err(err) => return Err(err.into()),
    };
    for entry in entries.flatten() {
      let name = entry.file_name();
      let Some(name) = name.to_str() else { continue };
      if surface_name(name).is_some() || temp_name(name) {
        match fs::remove_file(entry.path()) {
          Err(err) if err.kind() != io::ErrorKind::NotFound => return Err(err.into()),
          _ => {}
        }
      }
    }
    let _ = fs::remove_dir(&dir);
    Ok(())
  }

  /// `path` を上限の大きさまで読み、中身の SHA-256 が `id` であるものだけを返す。
  fn read_verified(&self, path: &Path, id: &str) -> Result<Vec<u8>, MaskSurfaceError> {
    let metadata = match fs::symlink_metadata(path) {
      Ok(metadata) => metadata,
      Err(err) if err.kind() == io::ErrorKind::NotFound => return Err(MaskSurfaceError::NotFound),
      Err(err) => return Err(err.into()),
    };
    let max = self.limits.max_bytes.min(MAX_MASK_SURFACE_BYTES) as u64;
    if !metadata.is_file() || metadata.len() > max {
      return Err(MaskSurfaceError::Corrupt);
    }
    let mut bytes = Vec::with_capacity(metadata.len() as usize);
    fs::File::open(path)?.take(max + 1).read_to_end(&mut bytes)?;
    if bytes.len() as u64 > max || mask_surface_id(&bytes) != id {
      return Err(MaskSurfaceError::Corrupt);
    }
    Ok(bytes)
  }

  /// 写真のフォルダの面（最後に使った日時が古い順・同じなら名前順）。1 時間を過ぎた一時ファイルはここで消す。
  fn surfaces_in(&self, dir: &Path, now: SystemTime) -> Vec<(SystemTime, String)> {
    let Ok(entries) = fs::read_dir(dir) else {
      return Vec::new();
    };
    let mut surfaces = Vec::new();
    for entry in entries.flatten() {
      let name = entry.file_name();
      let Some(name) = name.to_str() else { continue };
      let Ok(metadata) = entry.metadata() else { continue };
      if !metadata.is_file() {
        continue;
      }
      let modified = metadata.modified().unwrap_or(UNIX_EPOCH);
      if let Some(id) = surface_name(name) {
        surfaces.push((modified, id.to_string()));
      } else if temp_name(name) && now.duration_since(modified).unwrap_or(Duration::ZERO) > ORPHAN_TEMP_AGE {
        let _ = fs::remove_file(entry.path());
      }
    }
    surfaces.sort();
    surfaces
  }
}

/// `<id>.png` の id（面の形の名前でなければ None）。
fn surface_name(name: &str) -> Option<&str> {
  name.strip_suffix(".png").filter(|id| is_content_key(id))
}

/// `write_private_file_atomically` の一時ファイル（`<id>.png.tmp`）か。
fn temp_name(name: &str) -> bool {
  name.strip_suffix(".png.tmp").is_some_and(is_content_key)
}

/// 最後に使った日時（ファイルの更新日時）を進める（上限で消す順。失敗しても使える）。
fn touch(path: &Path, now: SystemTime) {
  let _ = fs::File::options()
    .write(true)
    .open(path)
    .and_then(|file| file.set_modified(now));
}

/// 面の id: PNG の中身の SHA-256（16 進の小文字 64 文字）。
pub fn mask_surface_id(png: &[u8]) -> String {
  hex_lower(&Sha256::digest(png))
}

/// 面の PNG のヘッダーを確かめて寸法を返す: 署名、最初の chunk が CRC の合う IHDR（1〜4096 画素・深さ 8・色の型 0・圧縮 0・
/// filter 0・interlace 0 か 1）、最初の IDAT までに PLTE・tRNS・acTL が無いこと。画素（IDAT の中身）はエンジンが読む。
pub fn inspect_mask_surface_png(png: &[u8]) -> Result<(u32, u32), MaskSurfaceError> {
  if png.len() > MAX_MASK_SURFACE_BYTES {
    return Err(MaskSurfaceError::TooLarge);
  }
  let invalid = MaskSurfaceError::InvalidPng;
  if png.len() < 8 + 25 || &png[..8] != PNG_SIGNATURE {
    return Err(invalid("not a PNG"));
  }
  let be32 = |at: usize| u32::from_be_bytes([png[at], png[at + 1], png[at + 2], png[at + 3]]);
  if be32(8) != 13 || &png[12..16] != b"IHDR" {
    return Err(invalid("the first chunk is not IHDR"));
  }
  if crc32(&png[12..29]) != be32(29) {
    return Err(invalid("the IHDR checksum does not match"));
  }
  let (width, height) = (be32(16), be32(20));
  let [depth, color, compression, filter, interlace] = [png[24], png[25], png[26], png[27], png[28]];
  if depth != 8 || color != 0 {
    return Err(invalid("not 8-bit grayscale"));
  }
  if compression != 0 || filter != 0 || interlace > 1 {
    return Err(invalid("an unknown compression, filter or interlace method"));
  }
  if !(1..=MAX_MASK_SURFACE_SIDE).contains(&width) || !(1..=MAX_MASK_SURFACE_SIDE).contains(&height) {
    return Err(invalid("a side outside 1..=4096"));
  }
  let mut at = 33usize;
  loop {
    if at + 8 > png.len() {
      return Err(invalid("no image data"));
    }
    let length = be32(at) as usize;
    match &png[at + 4..at + 8] {
      b"IDAT" => return Ok((width, height)),
      b"IEND" => return Err(invalid("no image data")),
      b"PLTE" => return Err(invalid("a palette")),
      b"tRNS" => return Err(invalid("transparency (tRNS)")),
      b"acTL" => return Err(invalid("an animation (acTL)")),
      _ => {}
    }
    at = at
      .checked_add(12)
      .and_then(|at| at.checked_add(length))
      .filter(|next| *next <= png.len())
      .ok_or_else(|| invalid("a truncated chunk"))?;
  }
}

/// CRC-32（ISO-HDLC。PNG の chunk の CRC）。
fn crc32(bytes: &[u8]) -> u32 {
  let mut crc = 0xffff_ffffu32;
  for byte in bytes {
    crc ^= u32::from(*byte);
    for _ in 0..8 {
      let mask = (crc & 1).wrapping_neg();
      crc = (crc >> 1) ^ (0xedb8_8320 & mask);
    }
  }
  !crc
}

/// 補正（`developSettings`）の `masks` が参照する面の id（重複なし・配列の順）。`active_only` なら描かれるマスク（`enabled` が
/// false でなく、`adjust` に 0 でない値がある。エンジンの `LocalMask::is_active` と同じ）だけ。書き出しはこれだけを
/// `niho-develop-render` へ渡し、残すもの（{@link MaskSurfaceStore::save} の `keep`）は無効なマスクの面も含めて全部。
pub fn mask_surface_ids(develop_settings: &Value, active_only: bool) -> Vec<String> {
  let mut ids: Vec<String> = Vec::new();
  let Some(masks) = develop_settings.get("masks").and_then(Value::as_array) else {
    return ids;
  };
  for mask in masks {
    let Some(id) = mask
      .get("surface")
      .and_then(|surface| surface.get("id"))
      .and_then(Value::as_str)
    else {
      continue;
    };
    if active_only && !is_active_mask(mask) {
      continue;
    }
    if !ids.iter().any(|known| known == id) {
      ids.push(id.to_string());
    }
  }
  ids
}

fn is_active_mask(mask: &Value) -> bool {
  mask.get("enabled") != Some(&Value::Bool(false)) && mask.get("adjust").is_some_and(has_non_zero)
}

fn has_non_zero(value: &Value) -> bool {
  match value {
    Value::Number(number) => number.as_f64().is_some_and(|x| x != 0.0),
    Value::Array(items) => items.iter().any(has_non_zero),
    Value::Object(entries) => entries.values().any(has_non_zero),
    _ => false,
  }
}

#[cfg(test)]
#[path = "mask_surfaces_tests.rs"]
mod tests;
