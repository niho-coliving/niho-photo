//! アプリ（NIHO Desktop・NIHO camera）のコマンドが共有する小さな決まり: ページへ返す code と失敗、ログ、不透明な ID、
//! パスを伏せる・ファイルの道具。NIHO Desktop の `photo_engine.rs`（code・`lock`）・`photo_editing.rs`（ID・パス・ファイル）・
//! `photo_cloud.rs`（`mark_used`）から C2 #18390 で移した。

use serde_json::Value;
use std::io::Read;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex, MutexGuard};
use std::time::SystemTime;

/// ページへ返す code。エンジンの code（`docs/ENGINE_PROTOCOL.md` のエラーコード表）と Desktop の
/// `engineUnavailable`・`folderNotFound`・クラウドの写真置き場の `cloud*`。
pub mod code {
  pub const INVALID_REQUEST: &str = "invalidRequest";
  pub const NOT_FOUND: &str = "notFound";
  pub const CANCELLED: &str = "cancelled";
  pub const DECODE_FAILED: &str = "decodeFailed";
  /// 拡張子とmagic bytes（macOSで取得できる場合は実UTType）が一致しない。
  pub const FORMAT_MISMATCH: &str = "formatMismatch";
  /// Finder/iCloud/同期ドライブ上だけにあり、このMacへまだ取得されていない。
  pub const DOWNLOAD_REQUIRED: &str = "downloadRequired";
  /// capability registryに無い形式、または要求段階を提供しない形式。
  pub const UNSUPPORTED_FORMAT: &str = "unsupportedFormat";
  pub const PROFILE_MISSING: &str = "profileMissing";
  pub const PRESET_INVALID: &str = "presetInvalid";
  pub const EXPORT_FAILED: &str = "exportFailed";
  pub const INTERNAL: &str = "internal";
  pub const ENGINE_UNAVAILABLE: &str = "engineUnavailable";
  /// フォルダ指定の書き出しで、`folderId` が知らない ID か、選んだフォルダがもう無い（Desktop の code、#16345）
  pub const FOLDER_NOT_FOUND: &str = "folderNotFound";
  /// クラウドの写真置き場（Desktop の code、#16365）: 送り先・取りに行く先が `https://storage.googleapis.com/<NIHO のバケット>/` でない
  pub const CLOUD_TARGET_REJECTED: &str = "cloudTargetRejected";
  /// クラウドの写真置き場: 通信・HTTP の失敗（リダイレクトを含む）
  pub const CLOUD_TRANSFER_FAILED: &str = "cloudTransferFailed";
  /// クラウドの写真置き場: 落とした中身が大きさ・SHA-256 と合わない（キャッシュに残さない）、または開いた後に元の写真が変わった
  pub const CLOUD_CONTENT_MISMATCH: &str = "cloudContentMismatch";

  /// エンジンが返しうる code。これ以外は `internal` として扱う（ページが知らない code を渡さない）。
  pub const ENGINE_CODES: [&str; 8] = [
    INVALID_REQUEST,
    NOT_FOUND,
    CANCELLED,
    DECODE_FAILED,
    PROFILE_MISSING,
    PRESET_INVALID,
    EXPORT_FAILED,
    INTERNAL,
  ];
}

/// ページへ返す失敗（`code` と、アプリが決めた文。パスや道具の文は入れない）。アプリは自分のコマンドの失敗
/// （NIHO Desktop は `DesktopCommandError`）にして返す。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PageError {
  pub code: String,
  pub message: String,
}

impl PageError {
  /// `code` はページが知っている code（{@link code}）、`message` はアプリが決めたページ向けの文。
  pub fn new(code: &str, message: &str) -> Self {
    Self {
      code: code.to_string(),
      message: message.to_string(),
    }
  }
}

/// 静的な公開code/message。native内部の別error型へ移しても文言の正本を複製せず、`&'static str`を保つ。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct StaticPageError {
  pub code: &'static str,
  pub message: &'static str,
}

impl StaticPageError {
  pub const fn new(code: &'static str, message: &'static str) -> Self {
    Self { code, message }
  }

  pub fn into_page_error(self) -> PageError {
    PageError::new(self.code, self.message)
  }
}

/// ログへ書く（kind, payload）。NIHO Desktop は `desktop-bridge.log` へ書く closure を渡す。パスは書かない。
pub type LogFn = Arc<dyn Fn(&str, Value) + Send + Sync>;

/// 持ち主のスレッドが panic した Mutex も、そのまま中身を使う。
pub fn lock<T>(mutex: &Mutex<T>) -> MutexGuard<'_, T> {
  mutex.lock().unwrap_or_else(|poison| poison.into_inner())
}

/// `photoId` / `folderId` / `entryId` の長さの上限（Desktop が振る ID は 40 文字ほど）。
pub const MAX_ID_CHARS: usize = 128;

/// ふつうのファイルか（シンボリックリンクはたどらず、ふつうのファイルとみなさない）。
pub fn is_regular_file(path: &Path) -> bool {
  std::fs::symlink_metadata(path).is_ok_and(|metadata| metadata.is_file())
}

/// パスの最後の段（ファイルの名前だけ）。ページ・ログへはこれだけを渡す。
pub fn display_file_name(path: &Path) -> String {
  path
    .file_name()
    .map(|name| name.to_string_lossy().into_owned())
    .unwrap_or_default()
}

/// ページへ渡す不透明な ID（`<prefix>-<通し番号>-<乱数 24 桁>`）。パスや中身から作らない。
pub fn new_opaque_id(prefix: &str) -> String {
  static COUNTER: AtomicU64 = AtomicU64::new(1);
  let counter = COUNTER.fetch_add(1, Ordering::SeqCst);
  format!("{prefix}-{counter}-{}", random_hex(12))
}

/// `len` バイトの乱数の 16 進（ID・multipart の境界・一時ファイルの名前に使う）。/dev/urandom が読めなければ時刻から作る。
pub fn random_hex(len: usize) -> String {
  let mut bytes = vec![0u8; len];
  let random = std::fs::File::open("/dev/urandom").and_then(|mut file| file.read_exact(&mut bytes));
  if random.is_err() {
    let nanos = std::time::SystemTime::now()
      .duration_since(std::time::UNIX_EPOCH)
      .map(|duration| duration.as_nanos())
      .unwrap_or_default();
    for (byte, source) in bytes.iter_mut().zip(nanos.to_le_bytes()) {
      *byte = source;
    }
  }
  bytes.iter().map(|byte| format!("{byte:02x}")).collect()
}

/// 道具の文（標準エラー出力など）の中の `paths`（長いものから）をファイルの名前に、その親のフォルダを `…` に、ホームを `~` に
/// 置き換える（ログに写真や利用者のフォルダの場所を残さない）。
pub fn scrub_paths(text: &str, paths: &[PathBuf], home: Option<&str>) -> String {
  let mut scrubbed = text.to_string();
  let mut paths: Vec<&PathBuf> = paths.iter().collect();
  // 長いパスから置き換える（親フォルダを先に置き換えると子のファイル名が崩れる）
  paths.sort_by_key(|path| std::cmp::Reverse(path.as_os_str().len()));
  for path in paths {
    let Some(full) = path.to_str().filter(|full| !full.is_empty()) else {
      continue;
    };
    let name = display_file_name(path);
    scrubbed = scrubbed.replace(full, &name);
    if let Some(parent) = path.parent().and_then(Path::to_str).filter(|parent| parent.len() > 1) {
      scrubbed = scrubbed.replace(parent, "…");
    }
  }
  if let Some(home) = home.filter(|home| home.len() > 1) {
    scrubbed = scrubbed.replace(home, "~");
  }
  scrubbed
}

/// 実行できるふつうのファイルか（sidecar・エンジンが同梱されているかを、起動せずに見る）。
#[cfg(unix)]
pub fn is_executable_file(path: &Path) -> bool {
  use std::os::unix::fs::PermissionsExt;
  path
    .metadata()
    .map(|meta| meta.is_file() && meta.permissions().mode() & 0o111 != 0)
    .unwrap_or(false)
}

#[cfg(not(unix))]
pub fn is_executable_file(path: &Path) -> bool {
  path.is_file()
}

/// 最終利用を記録する（ファイルの更新日時。中身は変えない）。
pub fn mark_used(path: &Path, when: SystemTime) {
  if let Ok(file) = std::fs::OpenOptions::new().write(true).open(path) {
    let _ = file.set_modified(when);
  }
}

#[cfg(test)]
#[path = "common_tests.rs"]
mod tests;
