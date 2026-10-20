//! この Mac のプリセット（spec `niho-camera-app.md`「データ（この Mac）」の「取り込んだ XMP」・「接続口 PhotoLibrary」のプリセット）。
//!
//! - 同梱の 3 本は wasm（crate の `builtin_presets`）が持つので、ここは利用者が取り込んだ・保存したものだけ。
//公開移植前の内部構成については docs/migration/mac-client.md を参照。
//!   名前は前後の空白を除いて 1〜100 文字で同じ名前は持てない（`presetNameTaken`）、XMP は 512KB まで・`x:xmpmeta` を含む、
//!   並びは作った順、`source` は取り込み（`xmp`）か「今の補正をプリセットに保存」（`user`）。XMP の中身（効く項目・効かない項目）は
//!   画面が wasm の `presetSettings` で読む。
//! - 置き場は `~/Library/Application Support/life.niho.camera/presets/<id>.json`（1 本 1 ファイル。0700 / 0600・一時ファイル＋rename）。
//!   利用者のデータなので、古さ・件数では消さない。

use crate::error::{invalid_request, parse_request, run_blocking, CameraError};
use chrono::{DateTime, SecondsFormat, Utc};
use niho_desktop_photo::common::{code, new_opaque_id};
use niho_desktop_photo::saved_settings::{ensure_private_dir, epoch_ms};
use serde::Deserialize;
use serde_json::{json, Value};
use std::fs;
use std::path::PathBuf;
use std::sync::{Arc, Mutex, MutexGuard};
use std::time::SystemTime;
use tauri::Manager;

pub const PRESETS_DIR_NAME: &str = "presets";
/// 名前の上限（前後の空白を除いた文字数。API の `PHOTO_PRESET_NAME_MAX_CHARS`）
pub const PRESET_NAME_MAX_CHARS: usize = 100;
/// XMP 本文の上限（UTF-8 のバイト数。API の `PHOTO_PRESET_XMP_MAX_BYTES`）
pub const PRESET_XMP_MAX_BYTES: usize = 512 * 1024;
/// 置けるプリセットの数（1 本 512KB まで。読み込みが重くならない上限）
pub const MAX_PRESETS: usize = 500;
const FORMAT_VERSION: u64 = 1;
const XMP_ROOT_ELEMENT_MARKER: &str = "x:xmpmeta";

const NAME_TAKEN_MESSAGE: &str = "同じ名前のプリセットがすでにあります";
const NOT_FOUND_MESSAGE: &str = "プリセットが見つかりません。";
const XMP_INVALID_MESSAGE: &str = "Lightroom のプリセット（XMP）として読めませんでした。";
const XMP_TOO_LARGE_MESSAGE: &str = "XMP は 512KB までです";
const TOO_MANY_MESSAGE: &str = "プリセットが多すぎます。使わないものを削除してください。";
const WRITE_FAILED_MESSAGE: &str = "プリセットを保存できませんでした。";

pub mod preset_code {
  /// 同じ名前のプリセットがある（API の 409 `photo_preset_name_taken` と同じ場面）
  pub const NAME_TAKEN: &str = "presetNameTaken";
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum PresetSource {
  Xmp,
  User,
}

impl PresetSource {
  fn as_str(self) -> &'static str {
    match self {
      Self::Xmp => "xmp",
      Self::User => "user",
    }
  }
}

#[derive(Debug, Clone, PartialEq)]
pub struct Preset {
  pub id: String,
  pub name: String,
  pub xmp: String,
  pub source: &'static str,
  pub created_at_ms: u64,
}

impl Preset {
  pub fn to_json(&self) -> Value {
    json!({ "id": self.id, "name": self.name, "xmp": self.xmp, "source": self.source, "createdAt": created_at_iso(self.created_at_ms) })
  }
}

fn created_at_iso(created_at_ms: u64) -> String {
  let seconds = i64::try_from(created_at_ms / 1_000).unwrap_or(i64::MAX);
  let nanos = ((created_at_ms % 1_000) * 1_000_000) as u32;
  DateTime::<Utc>::from_timestamp(seconds, nanos)
    .unwrap_or(DateTime::<Utc>::UNIX_EPOCH)
    .to_rfc3339_opts(SecondsFormat::Millis, true)
}

/// プリセットの置き場（アプリに 1 つ）。読み書きは 1 つずつ。
pub struct PresetStore {
  dir: PathBuf,
  guard: Mutex<()>,
}

fn is_preset_id(id: &str) -> bool {
  !id.is_empty() && id.len() <= 128 && id.bytes().all(|byte| byte.is_ascii_alphanumeric() || byte == b'-')
}

pub fn normalize_name(name: &str) -> Result<String, CameraError> {
  let trimmed = name.trim();
  let chars = trimmed.chars().count();
  if chars == 0 || chars > PRESET_NAME_MAX_CHARS || trimmed.chars().any(char::is_control) {
    return Err(invalid_request());
  }
  Ok(trimmed.to_string())
}

pub fn check_xmp(xmp: &str) -> Result<(), CameraError> {
  if xmp.len() > PRESET_XMP_MAX_BYTES {
    return Err(CameraError::new(code::INVALID_REQUEST, XMP_TOO_LARGE_MESSAGE));
  }
  if xmp.is_empty() || !xmp.contains(XMP_ROOT_ELEMENT_MARKER) {
    return Err(CameraError::new(code::PRESET_INVALID, XMP_INVALID_MESSAGE));
  }
  Ok(())
}

impl PresetStore {
  pub fn new(dir: PathBuf) -> Self {
    Self {
      dir,
      guard: Mutex::new(()),
    }
  }

  fn lock(&self) -> MutexGuard<'_, ()> {
    self.guard.lock().unwrap_or_else(|poison| poison.into_inner())
  }

  fn path(&self, id: &str) -> Option<PathBuf> {
    is_preset_id(id).then(|| self.dir.join(format!("{id}.json")))
  }

  fn read(path: &std::path::Path) -> Option<Preset> {
    let metadata = fs::symlink_metadata(path).ok()?;
    if !metadata.is_file() || metadata.len() > (PRESET_XMP_MAX_BYTES * 2) as u64 {
      return None;
    }
    let record: Value = serde_json::from_slice(&fs::read(path).ok()?).ok()?;
    if record.get("version").and_then(Value::as_u64) != Some(FORMAT_VERSION) {
      return None;
    }
    let id = record.get("id")?.as_str()?.to_string();
    let name = record.get("name")?.as_str()?.to_string();
    let xmp = record.get("xmp")?.as_str()?.to_string();
    let source = if record.get("source").and_then(Value::as_str) == Some("user") {
      "user"
    } else {
      "xmp"
    };
    let created_at_ms = record
      .get("createdAt")
      .and_then(Value::as_str)
      .and_then(|created_at| DateTime::parse_from_rfc3339(created_at).ok())
      .and_then(|created_at| u64::try_from(created_at.timestamp_millis()).ok())
      // Read the first on-disk version written by prerelease builds.
      .or_else(|| record.get("createdAtMs").and_then(Value::as_u64))
      .unwrap_or(0);
    (path.file_stem()?.to_str()? == id).then_some(Preset {
      id,
      name,
      xmp,
      source,
      created_at_ms,
    })
  }

  fn list_locked(&self) -> Vec<Preset> {
    let Ok(entries) = fs::read_dir(&self.dir) else {
      return Vec::new();
    };
    let mut presets: Vec<Preset> = entries
      .flatten()
      .filter(|entry| entry.file_name().to_str().is_some_and(|name| name.ends_with(".json")))
      .filter_map(|entry| Self::read(&entry.path()))
      .collect();
    presets.sort_by(|a, b| a.created_at_ms.cmp(&b.created_at_ms).then_with(|| a.id.cmp(&b.id)));
    presets
  }

  /// 作った順。読めない・壊れたファイルは出さない（消さない）。
  pub fn list(&self) -> Vec<Preset> {
    let _guard = self.lock();
    self.list_locked()
  }

  fn write(&self, preset: &Preset) -> Result<(), CameraError> {
    let failed = || CameraError::new(code::INTERNAL, WRITE_FAILED_MESSAGE);
    let path = self.path(&preset.id).ok_or_else(failed)?;
    let body = serde_json::to_vec(&json!({
      "version": FORMAT_VERSION,
      "id": preset.id,
      "name": preset.name,
      "xmp": preset.xmp,
      "source": preset.source,
      "createdAt": created_at_iso(preset.created_at_ms),
    }))
    .map_err(|_| failed())?;
    ensure_private_dir(&self.dir).map_err(|_| failed())?;
    let temp = self.dir.join(format!(".{}.json.tmp", preset.id));
    let written = (|| {
      use std::io::Write;
      use std::os::unix::fs::OpenOptionsExt;
      let mut file = fs::OpenOptions::new()
        .write(true)
        .create(true)
        .truncate(true)
        .mode(0o600)
        .open(&temp)?;
      file.write_all(&body)?;
      file.flush()?;
      fs::rename(&temp, &path)
    })();
    if written.is_err() {
      let _ = fs::remove_file(&temp);
      return Err(failed());
    }
    Ok(())
  }

  fn name_taken(presets: &[Preset], name: &str, except: Option<&str>) -> bool {
    presets
      .iter()
      .any(|preset| preset.name == name && Some(preset.id.as_str()) != except)
  }

  /// 取り込む・保存する（新しい ID）。
  pub fn create(&self, name: &str, xmp: &str, source: PresetSource, now: SystemTime) -> Result<Preset, CameraError> {
    let name = normalize_name(name)?;
    check_xmp(xmp)?;
    let _guard = self.lock();
    let presets = self.list_locked();
    if Self::name_taken(&presets, &name, None) {
      return Err(CameraError::new(preset_code::NAME_TAKEN, NAME_TAKEN_MESSAGE));
    }
    if presets.len() >= MAX_PRESETS {
      return Err(CameraError::new(code::INVALID_REQUEST, TOO_MANY_MESSAGE));
    }
    let preset = Preset {
      id: new_opaque_id("preset"),
      name,
      xmp: xmp.to_string(),
      source: source.as_str(),
      created_at_ms: epoch_ms(now),
    };
    self.write(&preset)?;
    Ok(preset)
  }

  pub fn rename(&self, id: &str, name: &str) -> Result<Preset, CameraError> {
    let name = normalize_name(name)?;
    let _guard = self.lock();
    let presets = self.list_locked();
    let mut preset = presets
      .iter()
      .find(|preset| preset.id == id)
      .cloned()
      .ok_or_else(|| CameraError::new(code::NOT_FOUND, NOT_FOUND_MESSAGE))?;
    if Self::name_taken(&presets, &name, Some(id)) {
      return Err(CameraError::new(preset_code::NAME_TAKEN, NAME_TAKEN_MESSAGE));
    }
    preset.name = name;
    self.write(&preset)?;
    Ok(preset)
  }

  pub fn delete(&self, id: &str) -> Result<(), CameraError> {
    let path = self
      .path(id)
      .ok_or_else(|| CameraError::new(code::NOT_FOUND, NOT_FOUND_MESSAGE))?;
    let _guard = self.lock();
    match fs::remove_file(path) {
      Ok(()) => Ok(()),
      Err(err) if err.kind() == std::io::ErrorKind::NotFound => {
        Err(CameraError::new(code::NOT_FOUND, NOT_FOUND_MESSAGE))
      }
      Err(_) => Err(CameraError::new(code::INTERNAL, WRITE_FAILED_MESSAGE)),
    }
  }
}

pub struct PresetsState(pub Arc<PresetStore>);

pub fn install(app: &tauri::AppHandle) {
  if let Ok(dir) = app.path().app_data_dir() {
    app.manage(PresetsState(Arc::new(PresetStore::new(dir.join(PRESETS_DIR_NAME)))));
  }
}

fn store(app: &tauri::AppHandle) -> Result<Arc<PresetStore>, CameraError> {
  app
    .try_state::<PresetsState>()
    .map(|state| state.0.clone())
    .ok_or_else(|| CameraError::new(code::INTERNAL, WRITE_FAILED_MESSAGE))
}

// ---------------------------------------------------------------------------
// コマンド

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct CreateRequest {
  pub name: String,
  pub xmp: String,
  pub source: PresetSource,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct RenameRequest {
  pub id: String,
  pub name: String,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct DeleteRequest {
  pub id: String,
}

/// この Mac のプリセット（`{ presets }`。作った順）。
#[tauri::command]
pub async fn camera_presets_list(app: tauri::AppHandle) -> Result<Value, CameraError> {
  let store = store(&app)?;
  run_blocking(move || Ok(json!({ "presets": store.list().iter().map(Preset::to_json).collect::<Vec<_>>() }))).await
}

/// 取り込んだ XMP・今の補正から書いた XMP をプリセットにする（`{ preset }`）。
#[tauri::command]
pub async fn camera_presets_create(app: tauri::AppHandle, request: Option<Value>) -> Result<Value, CameraError> {
  let request: CreateRequest = parse_request(request)?;
  let store = store(&app)?;
  run_blocking(move || {
    let preset = store.create(&request.name, &request.xmp, request.source, SystemTime::now())?;
    Ok(json!({ "preset": preset.to_json() }))
  })
  .await
}

#[tauri::command]
pub async fn camera_presets_rename(app: tauri::AppHandle, request: Option<Value>) -> Result<Value, CameraError> {
  let request: RenameRequest = parse_request(request)?;
  let store = store(&app)?;
  run_blocking(move || Ok(json!({ "preset": store.rename(&request.id, &request.name)?.to_json() }))).await
}

#[tauri::command]
pub async fn camera_presets_delete(app: tauri::AppHandle, request: Option<Value>) -> Result<Value, CameraError> {
  let request: DeleteRequest = parse_request(request)?;
  let store = store(&app)?;
  run_blocking(move || {
    store.delete(&request.id)?;
    Ok(json!({}))
  })
  .await
}

#[cfg(test)]
#[path = "presets_tests.rs"]
mod tests;
