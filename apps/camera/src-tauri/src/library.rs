//! この Mac の `PhotoLibrary` のうち、フォルダ（追加・一覧・覚えたフォルダ・一覧から外す・サムネイル）。spec
//! `niho-camera-app.md`「接続口 PhotoLibrary」の `list`・`delete`（この Mac は一覧から外すだけ）。
//!
//! 走査・不透明な `folderId` / `entryId`・サムネイル（QuickLook / sips・キャッシュ）・覚えたフォルダの本体は
//! `packages/desktop-photo`（NIHO Desktop と同じ関数）。ここはコマンドとその引数の確かめ、フォルダの選択ダイアログ、
//! 置き場（`~/Library/Caches/life.niho.camera/photo-thumbnails/`・`~/Library/Application Support/life.niho.camera/
//! photo-editing/remembered.json`）の解決だけを持つ。パスは画面へ渡さない。

use crate::error::{invalid_request, parse_request, run_blocking, CameraError};
use crate::photos::{photos, CameraPhotos};
use crate::{app_log, dialog};
use niho_desktop_photo::library::{
  folder_not_found, is_valid_id, make_with_macos_tools, photo_not_found, LibraryConfig, PhotoLibrary, RememberedBudget,
  ScanLimits, MAX_THUMBNAIL_DIMENSION, MAX_THUMBNAIL_JOBS, MIN_THUMBNAIL_DIMENSION, THUMBNAIL_CACHE_DIR_NAME,
  THUMBNAIL_CACHE_MAX_BYTES, THUMBNAIL_TIMEOUT,
};
use niho_desktop_photo::remembered::{remembered_path, RememberedLimits, RememberedStore};
use serde::Deserialize;
use serde_json::{json, Value};
use std::sync::Arc;
use tauri::Manager;

const INVALID_PHOTOS_MESSAGE: &str = "選んだ写真を追加できませんでした。写真を選び直してください。";

pub struct LibraryState(pub Arc<PhotoLibrary>);

/// 起動時に 1 回。フォルダは最初の「フォルダを追加」か `camera_library_remembered` まで読まない。
pub fn install(app: &tauri::AppHandle) {
  let config = LibraryConfig {
    limits: ScanLimits::default(),
    remembered_budget: RememberedBudget::default(),
    thumbnail_dir: app
      .path()
      .app_cache_dir()
      .ok()
      .map(|dir| dir.join(THUMBNAIL_CACHE_DIR_NAME)),
    thumbnail_cache_max_bytes: THUMBNAIL_CACHE_MAX_BYTES,
    thumbnail_timeout: THUMBNAIL_TIMEOUT,
    max_thumbnail_jobs: MAX_THUMBNAIL_JOBS,
    maker: Arc::new(make_with_macos_tools),
    remembered: app
      .path()
      .app_data_dir()
      .ok()
      .map(|dir| RememberedStore::new(remembered_path(&dir), RememberedLimits::default())),
    log: app_log::log_fn(app),
  };
  app.manage(LibraryState(PhotoLibrary::new(config)));
}

pub fn library(app: &tauri::AppHandle) -> Result<Arc<PhotoLibrary>, CameraError> {
  app
    .try_state::<LibraryState>()
    .map(|state| state.0.clone())
    .ok_or_else(crate::error::internal)
}

// ---------------------------------------------------------------------------
// 引数

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct FolderRequest {
  pub folder_id: String,
}

/// `maxDimension` は 64〜256 の整数。
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ThumbnailRequest {
  pub entry_id: String,
  pub max_dimension: u32,
}

/// 空・128 文字を超える `folderId` は `notFound`（知らない ID と同じ）。
pub fn validate_folder_request(request: &FolderRequest) -> Result<(), CameraError> {
  if is_valid_id(&request.folder_id) {
    Ok(())
  } else {
    Err(folder_not_found().into())
  }
}

pub fn validate_thumbnail_request(request: &ThumbnailRequest) -> Result<(), CameraError> {
  if !(MIN_THUMBNAIL_DIMENSION..=MAX_THUMBNAIL_DIMENSION).contains(&request.max_dimension) {
    return Err(invalid_request());
  }
  if !is_valid_id(&request.entry_id) {
    return Err(photo_not_found().into());
  }
  Ok(())
}

fn added_photos_value(
  library: &PhotoLibrary,
  photo_state: &CameraPhotos,
  picked: &[std::path::PathBuf],
) -> Result<Value, CameraError> {
  let selected = library.add_photos(picked);
  if selected.is_empty() {
    return Err(CameraError::new(
      niho_desktop_photo::common::code::INVALID_REQUEST,
      INVALID_PHOTOS_MESSAGE,
    ));
  }
  // annotate_has_edits は `photos` を持つオブジェクトを辿る。同じ応答オブジェクトをそのまま返し、パスは足さない。
  let mut value = json!({ "photos": selected });
  photo_state.annotate_has_edits(&mut value);
  Ok(value)
}

// ---------------------------------------------------------------------------
// コマンド

/// フォルダの選択ダイアログで選んだフォルダを覚え、その木と写真の一覧を返す（`{ folder }`。閉じたら `{ folder: null }`）。
#[tauri::command]
pub async fn camera_library_add_folder(app: tauri::AppHandle) -> Result<Value, CameraError> {
  let (library, photos) = (library(&app)?, photos(&app)?);
  let Some(picked) = dialog::pick_folder("フォルダを追加").await? else {
    return Ok(json!({ "folder": null }));
  };
  run_blocking(move || {
    let mut folder = library.add_folder(&picked)?;
    photos.annotate_has_edits(&mut folder);
    Ok(json!({ "folder": folder }))
  })
  .await
}

/// 写真の選択ダイアログで選んだ写真を覚え、安全な一覧行だけを返す（`{ photos }`）。閉じたら空。選んだものが
/// すべて無効なら、パスを含まない失敗を返す。有効な写真が 1 枚でもあれば、無効なものだけ飛ばして続ける。
#[tauri::command]
pub async fn camera_library_add_photos(app: tauri::AppHandle) -> Result<Value, CameraError> {
  let picked = dialog::pick_photos().await?;
  if picked.is_empty() {
    return Ok(json!({ "photos": [] }));
  }
  let (library, photo_state) = (library(&app)?, photos(&app)?);
  run_blocking(move || added_photos_value(&library, &photo_state, &picked)).await
}

/// 覚えたフォルダ・写真のうち、いまあるもの（`{ folders, photos }`）。見つからないものは黙って出さない（覚えたまま）。
#[tauri::command]
pub async fn camera_library_remembered(app: tauri::AppHandle) -> Result<Value, CameraError> {
  let (library, photos) = (library(&app)?, photos(&app)?);
  run_blocking(move || {
    let mut remembered = library.remembered();
    photos.annotate_has_edits(&mut remembered);
    Ok(remembered)
  })
  .await
}

/// 追加したフォルダ（かそのサブフォルダ）を読み直す（`{ folder }`）。
#[tauri::command]
pub async fn camera_library_list_folder(app: tauri::AppHandle, request: Option<Value>) -> Result<Value, CameraError> {
  let request: FolderRequest = parse_request(request)?;
  validate_folder_request(&request)?;
  let (library, photos) = (library(&app)?, photos(&app)?);
  run_blocking(move || {
    let mut folder = library.list_folder(&request.folder_id)?;
    photos.annotate_has_edits(&mut folder);
    Ok(json!({ "folder": folder }))
  })
  .await
}

/// 覚えたフォルダを一覧から外す（フォルダと中の写真は消さない。`{}`）。
#[tauri::command]
pub async fn camera_library_forget_folder(app: tauri::AppHandle, request: Option<Value>) -> Result<Value, CameraError> {
  let request: FolderRequest = parse_request(request)?;
  validate_folder_request(&request)?;
  let library = library(&app)?;
  run_blocking(move || {
    library.forget_folder(&request.folder_id)?;
    Ok(json!({}))
  })
  .await
}

/// 「選んだ写真」を一覧から外す。元の写真・フォルダ登録・補正には触れない（`{}`）。
#[tauri::command]
pub async fn camera_library_forget_photos(app: tauri::AppHandle) -> Result<Value, CameraError> {
  let library = library(&app)?;
  run_blocking(move || {
    library.forget_photos()?;
    Ok(json!({}))
  })
  .await
}

#[cfg(test)]
mod tests {
  use super::*;
  use niho_desktop_photo::common::code;
  use niho_desktop_photo::saved_settings::SavedSettingsStore;
  use niho_desktop_photo::test_support::library::Fixture;
  use std::time::SystemTime;

  #[test]
  fn folder_and_thumbnail_requests_are_checked_before_touching_the_library() {
    assert!(validate_folder_request(&FolderRequest {
      folder_id: "folder-1".into()
    })
    .is_ok());
    for folder_id in ["", &"x".repeat(129)] {
      let err = validate_folder_request(&FolderRequest {
        folder_id: folder_id.to_string(),
      })
      .unwrap_err();
      assert_eq!(err.code, code::NOT_FOUND);
    }
    let thumbnail = |entry_id: &str, max_dimension| ThumbnailRequest {
      entry_id: entry_id.into(),
      max_dimension,
    };
    assert!(validate_thumbnail_request(&thumbnail("entry-1", 64)).is_ok());
    assert!(validate_thumbnail_request(&thumbnail("entry-1", 256)).is_ok());
    assert_eq!(
      validate_thumbnail_request(&thumbnail("entry-1", 63)).unwrap_err().code,
      code::INVALID_REQUEST
    );
    assert_eq!(
      validate_thumbnail_request(&thumbnail("entry-1", 257)).unwrap_err().code,
      code::INVALID_REQUEST
    );
    assert_eq!(
      validate_thumbnail_request(&thumbnail("", 128)).unwrap_err().code,
      code::NOT_FOUND
    );
  }

  #[test]
  fn unknown_request_fields_are_rejected() {
    let parsed: Result<FolderRequest, _> =
      parse_request(Some(json!({ "folderId": "f", "path": "/test-data/users/x" })));
    assert_eq!(parsed.unwrap_err().code, code::INVALID_REQUEST);
  }

  #[test]
  fn added_photos_response_marks_saved_edits_and_never_contains_a_path() {
    let fixture = Fixture::new("camera-add-photos");
    let path = fixture.file("edited.jpg");
    let photo_state = CameraPhotos::new(Some(SavedSettingsStore::new(
      fixture.app_data().join(crate::photos::EDITS_DIR_NAME),
      crate::photos::edits_limits(),
    )));
    let (photo_id, _) = photo_state.open("temporary", &path).unwrap();
    photo_state
      .save(&photo_id, &json!({ "exposure": 0.3 }), 0, SystemTime::now())
      .unwrap();

    let value = added_photos_value(&fixture.library(), &photo_state, std::slice::from_ref(&path)).unwrap();
    assert_eq!(value["photos"][0]["hasEdits"], json!(true));
    assert!(!value.to_string().contains(fixture.dir.to_string_lossy().as_ref()));
    assert_eq!(
      added_photos_value(&fixture.library(), &photo_state, &[fixture.dir.join("missing.jpg")])
        .unwrap_err()
        .message,
      INVALID_PHOTOS_MESSAGE
    );
  }
}
