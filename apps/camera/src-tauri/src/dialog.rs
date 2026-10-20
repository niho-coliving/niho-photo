//! ネイティブのダイアログ（フォルダの選択・書き出しの保存先）。同時に 1 つだけ出す（2 つ目は `cancelled`）。
//!
//! 受入用の E2E（cargo の feature `e2e`。配布の build には入らない）では、ダイアログを出さずに環境変数の値を返す:
//! フォルダの選択は `NIHO_CAMERA_E2E_PICK_FOLDER`、書き出し先のフォルダは `NIHO_CAMERA_E2E_EXPORT_DIR`、保存ダイアログは
//! `NIHO_CAMERA_E2E_SAVE_DIR/<既定の名前>`（`scripts/run-e2e.sh`）。値が無ければ閉じたのと同じ。

use crate::error::CameraError;
use niho_desktop_photo::common::code;
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};

static DIALOG_OPEN: AtomicBool = AtomicBool::new(false);

/// 出しているダイアログの印（Drop で外す）。
struct DialogSlot;

impl Drop for DialogSlot {
  fn drop(&mut self) {
    DIALOG_OPEN.store(false, Ordering::SeqCst);
  }
}

fn acquire() -> Result<DialogSlot, CameraError> {
  DIALOG_OPEN
    .compare_exchange(false, true, Ordering::SeqCst, Ordering::SeqCst)
    .map_err(|_| CameraError::new(code::CANCELLED, "ほかのダイアログを閉じてからお試しください。"))?;
  Ok(DialogSlot)
}

/// E2E の build か（feature `e2e`。配布の build では常に false で、環境変数は読まない）。
const E2E: bool = cfg!(feature = "e2e");

/// E2E の答え（環境変数が無ければ None = 閉じた）。
fn e2e_path(name: &str) -> Option<PathBuf> {
  std::env::var_os(name)
    .filter(|value| !value.is_empty())
    .map(PathBuf::from)
}

/// フォルダの選択ダイアログ（写真のフォルダを足す）。閉じたら None。
pub async fn pick_folder(title: &str) -> Result<Option<PathBuf>, CameraError> {
  let _slot = acquire()?;
  if E2E {
    return Ok(e2e_path("NIHO_CAMERA_E2E_PICK_FOLDER"));
  }
  Ok(
    rfd::AsyncFileDialog::new()
      .set_title(title)
      .pick_folder()
      .await
      .map(|folder| folder.path().to_path_buf()),
  )
}

/// 書き出し先のフォルダの選択ダイアログ（複数枚の原寸の書き出し）。閉じたら None。
pub async fn pick_export_folder(title: &str) -> Result<Option<PathBuf>, CameraError> {
  let _slot = acquire()?;
  if E2E {
    return Ok(e2e_path("NIHO_CAMERA_E2E_EXPORT_DIR"));
  }
  Ok(
    rfd::AsyncFileDialog::new()
      .set_title(title)
      .pick_folder()
      .await
      .map(|folder| folder.path().to_path_buf()),
  )
}

/// 保存ダイアログ（`file_name` は既定の名前、`filter` は種類の名前と拡張子）。閉じたら None。既存のファイルへの上書きは
/// ダイアログの確かめに任せる。
pub async fn save_file(title: &str, file_name: &str, filter: (&str, &[&str])) -> Result<Option<PathBuf>, CameraError> {
  let _slot = acquire()?;
  if E2E {
    return Ok(e2e_path("NIHO_CAMERA_E2E_SAVE_DIR").map(|dir| dir.join(file_name)));
  }
  Ok(
    rfd::AsyncFileDialog::new()
      .set_title(title)
      .set_file_name(file_name)
      .add_filter(filter.0, filter.1)
      .save_file()
      .await
      .map(|file| file.path().to_path_buf()),
  )
}

/// JPEG の保存ダイアログ（`file_name` は既定の名前）。閉じたら None。
pub async fn save_jpeg(file_name: &str) -> Result<Option<PathBuf>, CameraError> {
  save_file("書き出す", file_name, ("JPEG", &["jpg", "jpeg"])).await
}

#[cfg(test)]
mod tests {
  use super::*;

  #[test]
  fn only_one_dialog_at_a_time() {
    let first = acquire().unwrap();
    assert_eq!(acquire().err().unwrap().code, code::CANCELLED);
    drop(first);
    assert!(acquire().is_ok());
  }
}
