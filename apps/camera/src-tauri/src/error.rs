//! 画面へ返す失敗（`{ code, message }`）と、コマンドの引数の読み取り・重い処理の逃がし先。パスは画面へ渡さない。

use niho_desktop_photo::common::{code, PageError};
use niho_desktop_photo::develop::DevelopError;
use serde::de::DeserializeOwned;
use serde::Serialize;
use serde_json::Value;

/// NIHO photo だけの code（ほかは `niho_desktop_photo::common::code` と `develop_code`）。
pub mod camera_code {
  /// 補正の保存で、画面が知っている版と今の版が違う（`currentRevision` に今の版）
  pub const REVISION_CONFLICT: &str = "revisionConflict";
}

pub const INVALID_REQUEST_MESSAGE: &str = "操作を受け付けられませんでした。NIHO photo を開き直してください。";
pub const INTERNAL_MESSAGE: &str = "予期しないエラーが起きました。もう一度お試しください。";
/// crate の文は NIHO Desktop 向けなので、現像を使えないときは camera の文にする。
pub const DEVELOP_UNAVAILABLE_MESSAGE: &str = "この NIHO photo では現像を使えません。NIHO photo を入れ直してください。";

/// 画面へ返す失敗。`message` は画面にそのまま出せる文で、パス・写真の中身を含めない。
#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct CameraError {
  pub code: String,
  pub message: String,
  /// `revisionConflict` のときの今の版
  #[serde(skip_serializing_if = "Option::is_none")]
  pub current_revision: Option<u64>,
}

impl CameraError {
  pub fn new(code: &str, message: &str) -> Self {
    Self {
      code: code.to_string(),
      message: message.to_string(),
      current_revision: None,
    }
  }

  pub fn revision_conflict(current: u64) -> Self {
    Self {
      code: camera_code::REVISION_CONFLICT.to_string(),
      message: "別の操作で補正が変わりました。写真を開き直してください。".to_string(),
      current_revision: Some(current),
    }
  }
}

impl From<PageError> for CameraError {
  fn from(error: PageError) -> Self {
    Self {
      code: error.code,
      message: error.message,
      current_revision: None,
    }
  }
}

impl From<DevelopError> for CameraError {
  fn from(error: DevelopError) -> Self {
    let message = if error.code == code::ENGINE_UNAVAILABLE {
      DEVELOP_UNAVAILABLE_MESSAGE
    } else {
      error.message
    };
    Self::new(error.code, message)
  }
}

pub fn invalid_request() -> CameraError {
  CameraError::new(code::INVALID_REQUEST, INVALID_REQUEST_MESSAGE)
}

pub fn internal() -> CameraError {
  CameraError::new(code::INTERNAL, INTERNAL_MESSAGE)
}

/// コマンドの引数（`request`）を読む。無い・形が違うときは `invalidRequest`。
pub fn parse_request<T: DeserializeOwned>(request: Option<Value>) -> Result<T, CameraError> {
  serde_json::from_value(request.unwrap_or(Value::Null)).map_err(|_| invalid_request())
}

/// ファイルの読み書き・sidecar の実行をコマンドの async から逃がす。仕事の間は App Nap を止める（窓が隠れても現像・書き出しを
/// 続ける。`activity.rs`）。
pub async fn run_blocking<T: Send + 'static>(
  work: impl FnOnce() -> Result<T, CameraError> + Send + 'static,
) -> Result<T, CameraError> {
  tauri::async_runtime::spawn_blocking(move || {
    let _activity = crate::activity::hold();
    work()
  })
  .await
  .map_err(|_| internal())?
}

#[cfg(test)]
mod tests {
  use super::*;
  use serde_json::json;

  #[test]
  fn errors_serialize_as_code_and_message_and_the_conflict_adds_the_current_revision() {
    assert_eq!(
      serde_json::to_value(CameraError::new("notFound", "x")).unwrap(),
      json!({ "code": "notFound", "message": "x" })
    );
    assert_eq!(
      serde_json::to_value(CameraError::revision_conflict(3)).unwrap()["currentRevision"],
      json!(3)
    );
  }

  #[test]
  fn the_develop_unavailable_message_names_niho_camera() {
    let error = CameraError::from(DevelopError::new(
      code::ENGINE_UNAVAILABLE,
      "この NIHO Desktop では…",
      "detail",
    ));
    assert_eq!(error.message, DEVELOP_UNAVAILABLE_MESSAGE);
    let other = CameraError::from(DevelopError::new(code::NOT_FOUND, "写真が見つかりません。", "detail"));
    assert_eq!(other.message, "写真が見つかりません。");
  }

  #[test]
  fn a_missing_or_malformed_request_is_an_invalid_request() {
    #[derive(serde::Deserialize)]
    #[allow(dead_code)]
    struct Request {
      folder_id: String,
    }
    assert_eq!(
      parse_request::<Request>(None).err().unwrap().code,
      code::INVALID_REQUEST
    );
    assert_eq!(
      parse_request::<Request>(Some(json!({ "folder_id": 1 })))
        .err()
        .unwrap()
        .code,
      code::INVALID_REQUEST
    );
    assert!(parse_request::<Request>(Some(json!({ "folder_id": "a" }))).is_ok());
  }
}
