//! この Mac の `PhotoLibrary` のうち、選別のフラグ（採用 / 却下。niho-photo#47。Lightroom のフラグ）。spec の
//! `PhotoLibrary.flags`・一覧の行の `flag`・`list` の `flag` の絞り込み。
//!
//! - 本体（置き場・鍵・上限）は crate の `saved_flags.rs`。置き場は `~/Library/Application Support/life.niho.camera/
//!   photo-editing/flags.json`。鍵は一覧の写真の名前・大きさ・更新日時の SHA-256 で、パス・名前は残さない。
//! - 一覧（フォルダの木・覚えたもの・選んだ写真）の写真のうち、フラグの付いたものに `flag`（`pick` / `reject`）を足す
//!   （{@link CameraFlags::annotate}。付いていない写真には足さない）。鍵は一覧の `fileName`・`sizeBytes`・`modifiedAt` から作るので、
//!   写真を開かない。
//! - 付け外しは `camera_library_set_flags`（一覧の `entryId` で受け、パスは受けない・返さない）。鍵は付けるときのファイルの名前・
//!   大きさ・更新日時から作る。知らない `entryId`・もう無い写真は `notFound` に数え、ほかは付ける。
//! - 置き場が使えない（アプリのデータのフォルダが分からない）ときは、一覧には何も足さず、付け外しは `internal`。

use crate::error::{invalid_request, parse_request, run_blocking, CameraError};
use crate::library::library;
use niho_desktop_photo::common::code;
use niho_desktop_photo::library::PhotoLibrary;
use niho_desktop_photo::saved_flags::{flag_key, flag_key_for_file, flags_path, FlagLimits, FlagStore, PhotoFlag};
use serde::Deserialize;
use serde_json::{json, Value};
use std::collections::HashSet;
use std::sync::Arc;
use std::time::SystemTime;
use tauri::Manager;

/// 1 回で付け外しできる写真の数（画面は `limits.photosPerRequest` ずつ送る）。
pub const MAX_FLAG_PHOTOS_PER_REQUEST: usize = 500;

const FLAGS_SAVE_FAILED_MESSAGE: &str = "採用・却下を保存できませんでした。";

/// 選別のフラグの置き場（アプリに 1 つ）。
pub struct CameraFlags {
  store: Option<FlagStore>,
}

impl CameraFlags {
  pub fn new(store: Option<FlagStore>) -> Self {
    Self { store }
  }

  /// 一覧の木（`{ folderId, …, children, photos }` か `{ folders, photos }` か `{ photos }`）の写真のうち、フラグの付いたものに
  /// `flag` を足す（付いていない写真には足さない。足してある `flag` は付け直す）。
  pub fn annotate(&self, value: &mut Value) {
    let Some(store) = self.store.as_ref() else { return };
    store.with_lookup(|lookup| annotate(value, lookup));
  }

  /// `entryIds` の写真のフラグを `flag` にする（None は外す）。`{ updated, notFound }`（どちらも `entryId` の配列。同じ ID は 1 つ）。
  pub fn set(
    &self,
    library: &PhotoLibrary,
    entry_ids: Vec<String>,
    flag: Option<PhotoFlag>,
    now: SystemTime,
  ) -> Result<Value, CameraError> {
    let store = self
      .store
      .as_ref()
      .ok_or_else(|| CameraError::new(code::INTERNAL, FLAGS_SAVE_FAILED_MESSAGE))?;
    let mut seen = HashSet::new();
    let entry_ids: Vec<String> = entry_ids.into_iter().filter(|id| seen.insert(id.clone())).collect();
    let mut keys = Vec::new();
    let mut updated = Vec::new();
    let mut not_found = Vec::new();
    for listed in library.listed_photos(entry_ids) {
      match listed.path.as_deref().and_then(flag_key_for_file) {
        Some(key) => {
          keys.push(key);
          updated.push(listed.entry_id);
        }
        None => not_found.push(listed.entry_id),
      }
    }
    if !keys.is_empty() {
      store
        .set(&keys, flag, now)
        .map_err(|_| CameraError::new(code::INTERNAL, FLAGS_SAVE_FAILED_MESSAGE))?;
    }
    Ok(json!({ "updated": updated, "notFound": not_found }))
  }
}

fn annotate(value: &mut Value, lookup: &dyn Fn(&str) -> Option<PhotoFlag>) {
  let Some(object) = value.as_object_mut() else { return };
  if let Some(Value::Array(photos)) = object.get_mut("photos") {
    for photo in photos.iter_mut() {
      let flag = (|| {
        let key = flag_key(
          photo.get("fileName")?.as_str()?,
          photo.get("sizeBytes")?.as_u64()?,
          photo.get("modifiedAt")?.as_str()?,
        );
        lookup(&key)
      })();
      if let Some(entry) = photo.as_object_mut() {
        match flag {
          Some(flag) => entry.insert("flag".into(), json!(flag.as_str())),
          None => entry.remove("flag"),
        };
      }
    }
  }
  for list in ["children", "folders"] {
    if let Some(Value::Array(folders)) = object.get_mut(list) {
      folders.iter_mut().for_each(|folder| annotate(folder, lookup));
    }
  }
}

pub struct FlagsState(pub Arc<CameraFlags>);

pub fn install(app: &tauri::AppHandle) {
  let store = app
    .path()
    .app_data_dir()
    .ok()
    .map(|dir| FlagStore::new(flags_path(&dir), FlagLimits::default()));
  app.manage(FlagsState(Arc::new(CameraFlags::new(store))));
}

/// 選別のフラグの置き場（入れていなければ None。一覧は印なしで出す）。
pub fn flags(app: &tauri::AppHandle) -> Option<Arc<CameraFlags>> {
  app.try_state::<FlagsState>().map(|state| state.0.clone())
}

// ---------------------------------------------------------------------------
// 引数

/// `camera_library_set_flags` の引数（1〜{@link MAX_FLAG_PHOTOS_PER_REQUEST} 個の `entryId` と、`flag`〔`pick`・`reject`・null〕）。
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SetFlagsRequest {
  pub entry_ids: Vec<String>,
  /// 省かせない（null は外す）
  pub flag: Value,
}

/// 引数を確かめ、付けるフラグ（None は外す）を返す。
pub fn validate_set_flags_request(request: &SetFlagsRequest) -> Result<Option<PhotoFlag>, CameraError> {
  if request.entry_ids.is_empty() || request.entry_ids.len() > MAX_FLAG_PHOTOS_PER_REQUEST {
    return Err(invalid_request());
  }
  match &request.flag {
    Value::Null => Ok(None),
    Value::String(text) => PhotoFlag::parse(text).map(Some).ok_or_else(invalid_request),
    _ => Err(invalid_request()),
  }
}

// ---------------------------------------------------------------------------
// コマンド

/// 一覧の写真に採用・却下を付ける・外す（`{ updated, notFound }`）。
#[tauri::command]
pub async fn camera_library_set_flags(app: tauri::AppHandle, request: Option<Value>) -> Result<Value, CameraError> {
  let request: SetFlagsRequest = parse_request(request)?;
  let flag = validate_set_flags_request(&request)?;
  let library = library(&app)?;
  let flags = flags(&app).ok_or_else(crate::error::internal)?;
  run_blocking(move || flags.set(&library, request.entry_ids, flag, SystemTime::now())).await
}

#[cfg(test)]
#[path = "flags_tests.rs"]
mod tests;
