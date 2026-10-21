//! 部分補正のマスク（ブラシ・被写体・空）の面のコマンド（docs/local-adjustments.md「面の受け渡し」、niho-photo#68）。面は
//! 開いた写真（`photoId`）ごとに、`packages/desktop-photo` の `MaskSurfaceStore`（`photos.rs` の `CameraPhotos`）へ置く。
//! パスは受け取らない・返さない。
//!
//! - `camera_mask_surface_save`: 面の PNG（raw IPC のバイト列。8bit グレー・8 MiB 以下・1〜4096 画素）を保存して
//!   `{ id, width, height }`（`id` は中身の SHA-256。補正の `masks[].surface` にそのまま書く）。`photoId` は
//!   {@link PHOTO_ID_HEADER} に添える。
//! - `camera_mask_surface_load`: `{ photoId, surfaceId }` → 面の PNG（raw IPC。中身の SHA-256 を `surfaceId` と照らしたもの）。
//! - `camera_mask_surface_exists`: `{ photoId, surfaceIds }`（1〜64 個）→ `{ missing }`（置き場に無い id、渡した順）。
//!
//! 失敗の code: `maskSurfaceInvalid`（受け付けない PNG）・`maskSurfaceQuota`（その写真の面が上限で空けられない）・
//! `maskSurfaceMissing`（読み出す面が無い・壊れている）・`notFound`（開いていない写真）・`invalidRequest`（形の違う引数）。

use crate::error::{camera_code, invalid_request, parse_request, run_blocking, CameraError};
use crate::photos::{check_photo_id, photos, MASK_SURFACE_INVALID_MESSAGE};
use niho_desktop_photo::mask_surfaces::MAX_MASK_SURFACE_BYTES;
use niho_desktop_photo::saved_settings::is_content_key;
use serde::Deserialize;
use serde_json::{json, Value};
use std::time::SystemTime;

/// `camera_mask_surface_save` の `photoId` を添える raw IPC の header。
pub const PHOTO_ID_HEADER: &str = "x-niho-photo-id";
/// `camera_mask_surface_exists` に一度に渡せる id の数（写真 1 枚の面の上限と同じ）。
pub const MAX_EXISTS_SURFACE_IDS: usize = 64;

/// `camera_mask_surface_load` の引数。
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct LoadRequest {
  pub photo_id: String,
  pub surface_id: String,
}

/// `camera_mask_surface_exists` の引数。
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ExistsRequest {
  pub photo_id: String,
  pub surface_ids: Vec<String>,
}

pub fn validate_load_request(request: &LoadRequest) -> Result<(), CameraError> {
  check_photo_id(&request.photo_id)?;
  if !is_content_key(&request.surface_id) {
    return Err(invalid_request());
  }
  Ok(())
}

pub fn validate_exists_request(request: &ExistsRequest) -> Result<(), CameraError> {
  check_photo_id(&request.photo_id)?;
  if request.surface_ids.is_empty()
    || request.surface_ids.len() > MAX_EXISTS_SURFACE_IDS
    || !request.surface_ids.iter().all(|id| is_content_key(id))
  {
    return Err(invalid_request());
  }
  Ok(())
}

/// `camera_mask_surface_save` の raw IPC の中身（PNG のバイト列と header の `photoId`）を確かめる。
pub fn validate_save_body(body: &[u8], photo_id: Option<&str>) -> Result<String, CameraError> {
  let photo_id = photo_id.ok_or_else(invalid_request)?;
  check_photo_id(photo_id)?;
  if body.is_empty() {
    return Err(invalid_request());
  }
  if body.len() > MAX_MASK_SURFACE_BYTES {
    return Err(CameraError::new(
      camera_code::MASK_SURFACE_INVALID,
      MASK_SURFACE_INVALID_MESSAGE,
    ));
  }
  Ok(photo_id.to_string())
}

/// 開いた写真のマスクの面を保存する（`{ id, width, height }`）。PNG は raw IPC のバイト列、`photoId` は {@link PHOTO_ID_HEADER}。
#[tauri::command]
pub async fn camera_mask_surface_save(
  app: tauri::AppHandle,
  request: tauri::ipc::Request<'_>,
) -> Result<Value, CameraError> {
  let tauri::ipc::InvokeBody::Raw(body) = request.body() else {
    return Err(invalid_request());
  };
  let header = request
    .headers()
    .get(PHOTO_ID_HEADER)
    .and_then(|value| value.to_str().ok());
  let photo_id = validate_save_body(body, header)?;
  let png = body.clone();
  let photos = photos(&app)?;
  run_blocking(move || {
    let info = photos.save_mask_surface(&photo_id, &png, SystemTime::now())?;
    Ok(json!({ "id": info.id, "width": info.width, "height": info.height }))
  })
  .await
}

/// 開いた写真のマスクの面の PNG（raw IPC）。
#[tauri::command]
pub async fn camera_mask_surface_load(
  app: tauri::AppHandle,
  request: Option<Value>,
) -> Result<tauri::ipc::Response, CameraError> {
  let request: LoadRequest = parse_request(request)?;
  validate_load_request(&request)?;
  let photos = photos(&app)?;
  let bytes =
    run_blocking(move || photos.load_mask_surface(&request.photo_id, &request.surface_id, SystemTime::now())).await?;
  Ok(tauri::ipc::Response::new(bytes))
}

/// `surfaceIds` のうち、開いた写真の置き場に無い面（`{ missing }`）。
#[tauri::command]
pub async fn camera_mask_surface_exists(app: tauri::AppHandle, request: Option<Value>) -> Result<Value, CameraError> {
  let request: ExistsRequest = parse_request(request)?;
  validate_exists_request(&request)?;
  let photos = photos(&app)?;
  run_blocking(move || {
    let missing = photos.missing_mask_surfaces(&request.photo_id, &request.surface_ids)?;
    Ok(json!({ "missing": missing }))
  })
  .await
}

#[cfg(test)]
#[path = "mask_surfaces_tests.rs"]
mod tests;
