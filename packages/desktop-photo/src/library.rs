//公開移植前の内部構成については docs/migration/mac-client.md を参照。
//! `features.photoEditingFolders`）。NIHO Desktop の `photo_library.rs` から C2 #18390 で移した。フォルダの選択ダイアログ・
//! Tauri のコマンド・アプリのキャッシュとデータのフォルダの解決はアプリが持ち、ここはパスとフォルダ（{@link LibraryConfig}）を受け取る。
//!
//! - フォルダはスタッフがネイティブのフォルダの選択ダイアログで選んだもの（`photo_editing_add_folder`）の中だけを読む。
//!   選んだフォルダと下のサブフォルダは不透明な `folderId`、写真は不透明な `entryId` で覚え（同じパスなら同じ ID。
//!   アプリを閉じるまで有効で、`photo_editing_release` でも忘れない）、ページへはフォルダ名・ファイル名・ID・大きさ・
//!   更新日時だけを返す。パスは返さない。ページはこの ID でしかフォルダ・写真を指せない（任意のパスは読ませない）。
//! - 走査: 拡張子は「写真を開く」と同じ一覧（大文字・小文字を区別しない）。隠しファイル・隠しフォルダ（`.` 始まり）と
//!   シンボリックリンク（ファイルもフォルダも。選んだフォルダの外へ出ない）は出さず、パッケージ（`.app`・
//!   `.photoslibrary` など）の中は見ない。深さは選んだフォルダを 0 として 8 まで、写真は合計 5,000 枚まで（フォルダは
//!   10,000 まで）。超えたらそこで止め、止めたフォルダとその上の各段（根を含む）を `truncated: true` にする。読めない
//!   サブフォルダは飛ばす。自動では読み直さない（ページが `photo_editing_list_folder` で読み直す）。
//! - サムネイル（`photo_editing_thumbnail`）はエンジンで開かずに作る（エンジンは 24MP の RAW 1 枚で約 1.6GB 使う）。
//!   まず QuickLook（`qlmanage -t`。RAW は埋め込みのプレビューから速い。PNG）、作れなければ ImageIO（`sips`。RAW も
//!   現像できるが遅い。JPEG）。1 枚 20 秒まで（壊れたファイルで QuickLook が戻らないことがあるので、QuickLook は
//!   10 秒で打ち切って sips へ回す）で、超えたらプロセスを止めて `internal`。同時に作るのは 2 枚まで。
//! - サムネイルのキャッシュは `<app cache>/photo-thumbnails/<キー>.<png|jpg>`（macOS では
//!   `~/Library/Caches/life.niho.desktop/photo-thumbnails/`）。キーはパス・大きさ・更新時刻・長辺の SHA-256 で、写真を
//!   書き換えると別のキーになる。合計 500MB を超えたら最終利用（ファイルの更新日時。使ったときに更新する）の古い順に
//!   消す。フォルダ 0700・ファイル 0600。
//! - 一覧から選んだ写真を開く（`photo_editing_open_entries`）のは NIHO Desktop の `photo_editing.rs` の `open_listed`（ダイアログを
//!   出さない。同じ写真を開いていればエンジンで開き直さない）。
//! - 覚えて次回も出す（#16578、v16、`features.photoEditingRemembered`）: 「フォルダを追加」で読めたフォルダと、
//!   「この Mac の写真」（`photo_editing_add_photos`。「写真を開く」と同じダイアログ）で選んだ写真のパスを
//!   `remembered.rs` の置き場に覚える（書けなくてもコマンドは失敗にしない）。`photo_editing_add_photos` は写真を
//!   開かずに一覧の写真（`entryId`）にして返す。`photo_editing_remembered` は覚えたもののうち、いまあるフォルダを
//!   「フォルダを追加」と同じ木で、いまある写真を一覧の写真で返す。見つからない・読めないものは黙って出さず、覚えたまま
//!   にする（SD カードを戻せばまた出る）。あるかどうかは `metadata` だけで見る（外したボリュームで待たない）。
//! - `photo_editing_remembered` の走査には予算がある（`RememberedBudget`。覚えたフォルダを毎回すべて最後まで読むと、
//!   大きなフォルダを 1 つ足しただけでタブを開くたびに遅くなるため）。覚えたフォルダは新しい順に走査し、木に載せる写真の
//!   合計が予算（5,000 枚）に達するか走査を始めてからの時間が予算（5 秒）を過ぎたら、次のフォルダからは中を読まず
//!   根だけ返す（`children` と `photos` は空・`truncated: true`）。どのフォルダも `folderId` は振るので、ページは
//!   選ばれたときに `photo_editing_list_folder` で読める（サムネイルも、ページが見せるときに `photo_editing_thumbnail`
//!   で作る。Desktop は先回りして作らない）。
//! - `cache_purge`（Mac を返す・渡すとき）は覚えたフォルダ・写真も消す（`purge_remembered`。パスにユーザー名や
//!   フォルダ名が入るため）。
//! - テスト（`library_tests.rs`）は一時フォルダで確かめ、qlmanage / sips は `ThumbnailMaker` を差し替えて呼ばない。

pub use crate::capabilities::PHOTO_FILE_EXTENSIONS;
use crate::capabilities::{capability_for_file_name, validate_photo, CapabilityStage};
use crate::common::{
  code, is_regular_file, lock, mark_used, new_opaque_id, random_hex, LogFn, PageError, MAX_ID_CHARS,
};
use crate::remembered::{RememberedEntry, RememberedStore, MAX_REMEMBERED_PHOTOS};
use crate::saved_settings::{ensure_private_dir, hex_lower, is_content_key, set_mode};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::collections::{HashMap, HashSet};
use std::ffi::OsString;
use std::io;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::sync::{Arc, Condvar, Mutex};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

/// ネイティブの選択ダイアログで選べる写真の拡張子（RAW は LibRaw、RAW 以外は Core Image が読む）。
/// クラウドの写真置き場の拡張子も同じ一覧（NIHO Desktop の `photo_cloud.rs`、API の `photo_cloud_file_type_unsupported`）。
/// フォルダの一覧の写真（`entryId`）が知らない ID か、ファイルがもう無い（サムネイルと、一覧から開く NIHO Desktop の `open_listed` も同じ文）。
pub const LISTED_PHOTO_NOT_FOUND_MESSAGE: &str = "写真が見つかりません。";
/// 選んだフォルダを 0 とした深さの上限（この深さのフォルダの写真までは出し、その下は見ない）。
pub const MAX_SCAN_DEPTH: usize = 8;
/// 1 回の一覧で出す写真の合計の上限。
pub const MAX_LISTED_PHOTOS: usize = 5_000;
/// 1 回の一覧で読むフォルダの合計の上限（写真の少ない巨大な木（ホームフォルダなど）を選んでも待たせすぎない）。
pub const MAX_LISTED_FOLDERS: usize = 10_000;
/// `photo_editing_remembered` 1 回で、覚えたフォルダ全体の木に載せる写真の合計の上限（1 回の一覧と同じ 5,000 枚）。
pub const MAX_REMEMBERED_LISTED_PHOTOS: usize = MAX_LISTED_PHOTOS;
/// `photo_editing_remembered` が走査を始めてよい時間。過ぎたら、次のフォルダからは根だけ返す（走査中のフォルダは
/// 最後まで読む。1 つは `MAX_LISTED_PHOTOS` / `MAX_LISTED_FOLDERS` で抑えている）。
pub const REMEMBERED_SCAN_TIME_BUDGET: Duration = Duration::from_secs(5);
/// 中を見ないパッケージのフォルダ（名前の末尾。大文字・小文字を区別しない）。
const PACKAGE_SUFFIXES: [&str; 6] = [".app", ".photoslibrary", ".lrdata", ".lrcat", ".bundle", ".framework"];
/// サムネイルの長辺（px）の範囲。
pub const MIN_THUMBNAIL_DIMENSION: u32 = 64;
pub const MAX_THUMBNAIL_DIMENSION: u32 = 256;
/// サムネイル 1 枚にかける時間の上限と、そのうち QuickLook を待つ時間。
pub const THUMBNAIL_TIMEOUT: Duration = Duration::from_secs(20);
const QUICKLOOK_TIMEOUT: Duration = Duration::from_secs(10);
/// 同時に作るサムネイルの数（qlmanage / sips のプロセスの数）。
pub const MAX_THUMBNAIL_JOBS: usize = 2;
/// サムネイルのキャッシュのフォルダ（アプリのキャッシュのフォルダの中）と、その合計の上限。
pub const THUMBNAIL_CACHE_DIR_NAME: &str = "photo-thumbnails";
pub const THUMBNAIL_CACHE_MAX_BYTES: u64 = 500 * 1024 * 1024;
/// 作ったサムネイルの大きさの上限（長辺 256px の PNG でも数百 KB。超えるものは作れなかったとみなす）。
const MAX_THUMBNAIL_BYTES: u64 = 4 * 1024 * 1024;
/// サムネイルを作る一時フォルダ（キャッシュの中の `work-<乱数>`）。これより古いものは落ちた仕事の残りとして消す。
pub(crate) const WORK_DIR_PREFIX: &str = "work-";
const ORPHAN_WORK_AGE: Duration = Duration::from_secs(60 * 60);
/// macOS の QuickLook と ImageIO のコマンド（PATH から探さない）。
const QLMANAGE: &str = "/usr/bin/qlmanage";
const SIPS: &str = "/usr/bin/sips";
/// sips が書くファイルの名前（一時フォルダの中）。
const SIPS_OUTPUT_NAME: &str = "thumbnail.jpg";
/// 子プロセスが終わったかを見に行く間隔。
const TOOL_POLL_INTERVAL: Duration = Duration::from_millis(20);
/// Desktop が決めたページ向けの文。
const FOLDER_UNREADABLE_MESSAGE: &str = "フォルダを読めませんでした。フォルダを選び直してください。";
pub const FOLDER_NOT_FOUND_MESSAGE: &str = "フォルダが見つかりません。フォルダを選び直してください。";
/// 覚えたフォルダを一覧から外せなかった（置き場に書けない）。
pub const FORGET_FAILED_MESSAGE: &str = "一覧から外せませんでした。もう一度お試しください。";
const THUMBNAIL_FAILED_MESSAGE: &str = "サムネイルを作れませんでした。";
const THUMBNAIL_TIMEOUT_MESSAGE: &str = "サムネイルを作るのに時間がかかりすぎました。";
const THUMBNAIL_CACHE_FAILED_MESSAGE: &str = "サムネイルの置き場を用意できませんでした。";

// ---------------------------------------------------------------------------
// フォルダを読む

/// 走査の上限（テストでは小さくする）。
#[derive(Clone, Copy, Debug)]
pub struct ScanLimits {
  pub max_depth: usize,
  pub max_photos: usize,
  pub max_folders: usize,
}

impl Default for ScanLimits {
  fn default() -> Self {
    Self {
      max_depth: MAX_SCAN_DEPTH,
      max_photos: MAX_LISTED_PHOTOS,
      max_folders: MAX_LISTED_FOLDERS,
    }
  }
}

/// 走査した写真（パスは Desktop の中だけで持つ）。
struct ScannedPhoto {
  path: PathBuf,
  file_name: String,
  kind: &'static str,
  size_bytes: u64,
  modified: SystemTime,
}

/// 走査したフォルダ。`truncated` は、このフォルダかその下に上限で出さなかったものがあること。
struct ScannedFolder {
  path: PathBuf,
  name: String,
  photos: Vec<ScannedPhoto>,
  children: Vec<ScannedFolder>,
  truncated: bool,
}

/// フォルダの直下（どちらも名前順）。
struct Listing {
  photos: Vec<ScannedPhoto>,
  folders: Vec<(PathBuf, String)>,
}

/// 走査の結果と数（ログ用）。
struct Scan {
  tree: ScannedFolder,
  photos: usize,
  folders: usize,
}

/// 写真の種類（`raw` / `raster`）。写真の拡張子（大文字・小文字を区別しない）でなければ None。
pub fn photo_kind(file_name: &str) -> Option<&'static str> {
  capability_for_file_name(file_name).map(|capability| capability.kind.as_str())
}

fn is_hidden(name: &str) -> bool {
  name.starts_with('.')
}

/// 中を見ないパッケージのフォルダ（`.app`・`.photoslibrary`・Lightroom のカタログなど）か。
pub(crate) fn is_package(name: &str) -> bool {
  let lower = name.to_lowercase();
  PACKAGE_SUFFIXES.iter().any(|suffix| lower.ends_with(suffix))
}

/// フォルダの名前（パスの最後の段だけ）。ディスクの根（`/`）なら「フォルダ」。
fn folder_name(path: &Path) -> String {
  path
    .file_name()
    .map(|name| name.to_string_lossy().into_owned())
    .filter(|name| !name.is_empty())
    .unwrap_or_else(|| "フォルダ".to_string())
}

/// フォルダの直下を読む。隠しファイル・隠しフォルダ・シンボリックリンク・パッケージと、写真の拡張子でないファイルは
/// 除く。途中で読めなくなった項目は飛ばす。フォルダ自体を読めなければ Err。
fn read_listing(dir: &Path) -> io::Result<Listing> {
  let mut photos = Vec::new();
  let mut folders = Vec::new();
  for entry in std::fs::read_dir(dir)? {
    let Ok(entry) = entry else { continue };
    let name = entry.file_name().to_string_lossy().into_owned();
    if is_hidden(&name) {
      continue;
    }
    // DirEntry::file_type / metadata はシンボリックリンクをたどらない（symlink_metadata と同じ）。
    // シンボリックリンクはファイルもフォルダも出さない（選んだフォルダの外へ出ない）
    let Ok(file_type) = entry.file_type() else { continue };
    if file_type.is_symlink() {
      continue;
    }
    if file_type.is_dir() {
      if !is_package(&name) {
        folders.push((entry.path(), name));
      }
      continue;
    }
    let Some(kind) = photo_kind(&name) else { continue };
    let Ok(metadata) = entry.metadata() else { continue };
    if !metadata.is_file() {
      continue;
    }
    photos.push(ScannedPhoto {
      path: entry.path(),
      file_name: name,
      kind,
      size_bytes: metadata.len(),
      modified: metadata.modified().unwrap_or(UNIX_EPOCH),
    });
  }
  // 大文字・小文字を区別しない名前順（同じなら元の名前順）
  photos.sort_by_cached_key(|photo| (photo.file_name.to_lowercase(), photo.file_name.clone()));
  folders.sort_by_cached_key(|(_, name)| (name.to_lowercase(), name.clone()));
  Ok(Listing { photos, folders })
}

/// 木をたどる（深さ優先。各フォルダの写真を先に、サブフォルダを名前順に）。写真かフォルダの合計が上限に達したら
/// それ以上は読まない。
struct Walk {
  limits: ScanLimits,
  photos: usize,
  folders: usize,
  stopped: bool,
}

impl Walk {
  fn folder(&mut self, path: PathBuf, name: String, listing: Listing, depth: usize) -> ScannedFolder {
    self.folders += 1;
    let mut folder = ScannedFolder {
      path,
      name,
      photos: Vec::new(),
      children: Vec::new(),
      truncated: false,
    };
    for photo in listing.photos {
      if self.photos >= self.limits.max_photos {
        self.stopped = true;
        folder.truncated = true;
        break;
      }
      self.photos += 1;
      folder.photos.push(photo);
    }
    for (child_path, child_name) in listing.folders {
      if !self.stopped && self.folders >= self.limits.max_folders {
        self.stopped = true;
      }
      // 深さの上限はこのフォルダの下だけを出さない（ほかの枝は続ける）。合計の上限は木全体を止める
      if self.stopped || depth >= self.limits.max_depth {
        folder.truncated = true;
        break;
      }
      // 読めないサブフォルダ（権限など）は飛ばす
      let Ok(child_listing) = read_listing(&child_path) else {
        continue;
      };
      let child = self.folder(child_path, child_name, child_listing, depth + 1);
      folder.truncated |= child.truncated;
      folder.children.push(child);
    }
    folder
  }
}

/// `path` がいまある写真のファイルなら、一覧の写真（「この Mac の写真」で選んだ写真と覚えた写真、#16578）。
/// フォルダの一覧と同じ決まりで、写真の拡張子の、隠しファイル（`.` 始まり）でない、ふつうのファイル（シンボリック
/// リンクはたどらない）だけ。無い・読めなければ None。`metadata` だけで決める（外したボリュームでもすぐ返る）。
fn existing_photo(path: PathBuf) -> Option<ScannedPhoto> {
  let file_name = path.file_name()?.to_string_lossy().into_owned();
  if is_hidden(&file_name) {
    return None;
  }
  let kind = photo_kind(&file_name)?;
  let metadata = std::fs::symlink_metadata(&path).ok()?;
  if !metadata.is_file() {
    return None;
  }
  Some(ScannedPhoto {
    size_bytes: metadata.len(),
    modified: metadata.modified().unwrap_or(UNIX_EPOCH),
    path,
    file_name,
    kind,
  })
}

/// `root` の木を読む。`root` がフォルダでない（シンボリックリンクを含む）・読めなければ Err。
fn scan_tree(root: &Path, limits: ScanLimits) -> io::Result<Scan> {
  if !std::fs::symlink_metadata(root)?.is_dir() {
    return Err(io::Error::new(io::ErrorKind::NotFound, "not a folder"));
  }
  let listing = read_listing(root)?;
  let mut walk = Walk {
    limits,
    photos: 0,
    folders: 0,
    stopped: false,
  };
  let tree = walk.folder(root.to_path_buf(), folder_name(root), listing, 0);
  Ok(Scan {
    tree,
    photos: walk.photos,
    folders: walk.folders,
  })
}

/// UTC の ISO 8601（`2026-09-24T01:02:03.456Z`。JavaScript の `toISOString` と同じ形）。1970 年より前は 1970 年にする。
/// 一覧の写真の `modifiedAt` の形（ISO 8601・UTC・ミリ秒）。NIHO camera が保存した補正の更新時刻と照らすのにも使う。
pub fn iso8601_utc(time: SystemTime) -> String {
  let since_epoch = time.duration_since(UNIX_EPOCH).unwrap_or_default();
  let seconds = since_epoch.as_secs();
  let (year, month, day) = civil_from_days((seconds / 86_400) as i64);
  let second_of_day = seconds % 86_400;
  format!(
    "{year:04}-{month:02}-{day:02}T{:02}:{:02}:{:02}.{:03}Z",
    second_of_day / 3_600,
    second_of_day % 3_600 / 60,
    second_of_day % 60,
    since_epoch.subsec_millis()
  )
}

/// 1970-01-01 からの日数 → (年, 月, 日)（グレゴリオ暦。Howard Hinnant の civil_from_days）。
fn civil_from_days(days: i64) -> (i64, u32, u32) {
  let z = days + 719_468;
  let era = z.div_euclid(146_097);
  let day_of_era = z.rem_euclid(146_097);
  let year_of_era = (day_of_era - day_of_era / 1_460 + day_of_era / 36_524 - day_of_era / 146_096) / 365;
  let day_of_year = day_of_era - (365 * year_of_era + year_of_era / 4 - year_of_era / 100);
  let month_index = (5 * day_of_year + 2) / 153;
  let day = (day_of_year - (153 * month_index + 2) / 5 + 1) as u32;
  let month = (if month_index < 10 {
    month_index + 3
  } else {
    month_index - 9
  }) as u32;
  let year = year_of_era + era * 400 + i64::from(month <= 2);
  (year, month, day)
}

// ---------------------------------------------------------------------------
// ID

/// Desktop が振った ID と、それが指すパス（アプリを閉じるまで持つ。`photo_editing_release` でも忘れない）。
#[derive(Default)]
struct LibraryIds {
  /// `folderId` → フォルダ（追加したフォルダとその下のサブフォルダ）
  library_folders: HashMap<String, PathBuf>,
  folder_ids: HashMap<PathBuf, String>,
  /// `entryId` → 写真のファイル
  entries: HashMap<String, PathBuf>,
  entry_ids: HashMap<PathBuf, String>,
}

impl LibraryIds {
  /// フォルダの `folderId`（同じフォルダなら同じ ID）。
  fn folder_id(&mut self, path: &Path) -> String {
    if let Some(folder_id) = self.folder_ids.get(path) {
      return folder_id.clone();
    }
    let folder_id = new_opaque_id("folder");
    self.folder_ids.insert(path.to_path_buf(), folder_id.clone());
    self.library_folders.insert(folder_id.clone(), path.to_path_buf());
    folder_id
  }

  /// 写真の `entryId`（同じファイルなら同じ ID）。
  fn entry_id(&mut self, path: &Path) -> String {
    if let Some(entry_id) = self.entry_ids.get(path) {
      return entry_id.clone();
    }
    let entry_id = new_opaque_id("entry");
    self.entry_ids.insert(path.to_path_buf(), entry_id.clone());
    self.entries.insert(entry_id.clone(), path.to_path_buf());
    entry_id
  }

  /// ページへ返す写真（`{ entryId, fileName, kind, sizeBytes, modifiedAt }`。フォルダの一覧・「この Mac の写真」・
  /// 覚えた写真で同じ形）。パスは入れない。
  fn page_entry(&mut self, photo: ScannedPhoto) -> Value {
    json!({
      "entryId": self.entry_id(&photo.path),
      "fileName": photo.file_name,
      "kind": photo.kind,
      "sizeBytes": photo.size_bytes,
      "modifiedAt": iso8601_utc(photo.modified),
    })
  }

  /// ページへ返すフォルダ（`{ folderId, name, children, photos, truncated }`）。パスは入れない。
  fn page_folder(&mut self, folder: ScannedFolder) -> Value {
    let photos: Vec<Value> = folder.photos.into_iter().map(|photo| self.page_entry(photo)).collect();
    let children: Vec<Value> = folder
      .children
      .into_iter()
      .map(|child| self.page_folder(child))
      .collect();
    json!({
      "folderId": self.folder_id(&folder.path),
      "name": folder.name,
      "children": children,
      "photos": photos,
      "truncated": folder.truncated,
    })
  }
}

// ---------------------------------------------------------------------------
// サムネイル

/// サムネイルの形。ページも先頭のバイトで見分ける（PNG の signature なら `image/png`、ほかは `image/jpeg`）。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum ThumbnailFormat {
  Png,
  Jpeg,
}

impl ThumbnailFormat {
  fn extension(self) -> &'static str {
    match self {
      Self::Png => "png",
      Self::Jpeg => "jpg",
    }
  }

  /// 先頭のバイトで見分ける。PNG でも JPEG でもなければ None。
  pub(crate) fn sniff(bytes: &[u8]) -> Option<Self> {
    if bytes.starts_with(&[0x89, b'P', b'N', b'G', 0x0d, 0x0a, 0x1a, 0x0a]) {
      Some(Self::Png)
    } else if bytes.starts_with(&[0xff, 0xd8, 0xff]) {
      Some(Self::Jpeg)
    } else {
      None
    }
  }
}

/// サムネイルを作る 1 回の仕事。
pub struct ThumbnailJob<'a> {
  pub source: &'a Path,
  pub max_dimension: u32,
  /// この仕事だけの空の一時フォルダ（作ったファイルはここに置く）
  pub work_dir: &'a Path,
  /// これを過ぎたらプロセスを止める
  pub deadline: Instant,
}

/// サムネイルを作れなかった理由。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum MakeFailure {
  /// 作れなかった（対応していない・壊れている）
  Failed,
  /// 時間切れ（プロセスは止めた）
  TimedOut,
}

/// サムネイルを作り、作ったファイルを返す。テストでは差し替えて qlmanage / sips を呼ばない。
pub type ThumbnailMaker = Arc<dyn Fn(&ThumbnailJob) -> Result<PathBuf, MakeFailure> + Send + Sync>;

/// 子プロセスの終わり方。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum ToolExit {
  /// 終わった（true なら終了コード 0）
  Exited(bool),
  /// `deadline` を過ぎたので止めた
  TimedOut,
}

/// 子プロセスを走らせ、終わるか `deadline` まで待つ。過ぎたら止めて（SIGKILL）`TimedOut`。起動できなければ Err。
/// blocking のスレッドから呼ぶ（`tokio::process` は使っていないので、終わるまで見に行く）。
pub(crate) fn run_tool(program: &Path, args: &[OsString], deadline: Instant) -> io::Result<ToolExit> {
  let mut child = Command::new(program)
    .args(args)
    .stdin(Stdio::null())
    .stdout(Stdio::null())
    .stderr(Stdio::null())
    .spawn()?;
  loop {
    match child.try_wait() {
      Ok(Some(status)) => return Ok(ToolExit::Exited(status.success())),
      Ok(None) if Instant::now() >= deadline => {
        let _ = child.kill();
        let _ = child.wait();
        return Ok(ToolExit::TimedOut);
      }
      Ok(None) => std::thread::sleep(TOOL_POLL_INTERVAL),
      Err(err) => {
        let _ = child.kill();
        let _ = child.wait();
        return Err(err);
      }
    }
  }
}

/// `qlmanage -t -s <長辺> -o <一時フォルダ> <写真>`（出力は `<一時フォルダ>/<写真の名前>.png`）。写真のパスは
/// 選んだフォルダ（絶対パス）の下なので `-` で始まらず、オプションとは読まれない。
pub(crate) fn quicklook_args(source: &Path, max_dimension: u32, work_dir: &Path) -> Vec<OsString> {
  vec![
    "-t".into(),
    "-s".into(),
    max_dimension.to_string().into(),
    "-o".into(),
    work_dir.as_os_str().to_owned(),
    source.as_os_str().to_owned(),
  ]
}

/// `sips -Z <長辺> -s format jpeg <写真> --out <出力>`（長辺を `<長辺>` に縮めた JPEG）。
pub(crate) fn sips_args(source: &Path, max_dimension: u32, output: &Path) -> Vec<OsString> {
  vec![
    "-Z".into(),
    max_dimension.to_string().into(),
    "-s".into(),
    "format".into(),
    "jpeg".into(),
    source.as_os_str().to_owned(),
    "--out".into(),
    output.as_os_str().to_owned(),
  ]
}

/// 一時フォルダにできたファイル（空でないふつうのファイル）。
fn first_made_file(work_dir: &Path) -> Option<PathBuf> {
  std::fs::read_dir(work_dir)
    .ok()?
    .flatten()
    .find(|entry| {
      entry
        .metadata()
        .is_ok_and(|metadata| metadata.is_file() && metadata.len() > 0)
    })
    .map(|entry| entry.path())
}

/// macOS の標準のツールでサムネイルを作る（アプリで使う `ThumbnailMaker`）。
pub fn make_with_macos_tools(job: &ThumbnailJob) -> Result<PathBuf, MakeFailure> {
  // QuickLook。壊れたファイルで戻らないことがあるので、全体の時間の途中で打ち切って sips へ回す
  let quicklook_deadline = job.deadline.min(Instant::now() + QUICKLOOK_TIMEOUT);
  let quicklook = run_tool(
    Path::new(QLMANAGE),
    &quicklook_args(job.source, job.max_dimension, job.work_dir),
    quicklook_deadline,
  );
  if let Ok(ToolExit::Exited(_)) = quicklook {
    // qlmanage は作れなくても 0 で終わるので、できたファイルで決める
    if let Some(made) = first_made_file(job.work_dir) {
      return Ok(made);
    }
  }
  if Instant::now() >= job.deadline {
    return Err(MakeFailure::TimedOut);
  }
  let output = job.work_dir.join(SIPS_OUTPUT_NAME);
  match run_tool(
    Path::new(SIPS),
    &sips_args(job.source, job.max_dimension, &output),
    job.deadline,
  ) {
    Ok(ToolExit::Exited(true)) if is_regular_file(&output) => Ok(output),
    Ok(ToolExit::TimedOut) => Err(MakeFailure::TimedOut),
    _ => Err(MakeFailure::Failed),
  }
}

/// サムネイルのキャッシュのキー（パス・大きさ・更新時刻（UNIX ナノ秒）・長辺を改行でつないだものの SHA-256）。
pub(crate) fn thumbnail_key(path: &Path, size_bytes: u64, modified_nanos: u128, max_dimension: u32) -> String {
  let mut hasher = Sha256::new();
  hasher.update(path_bytes(path));
  hasher.update(format!("\n{size_bytes}\n{modified_nanos}\n{max_dimension}").as_bytes());
  hex_lower(&hasher.finalize())
}

#[cfg(unix)]
fn path_bytes(path: &Path) -> Vec<u8> {
  use std::os::unix::ffi::OsStrExt;
  path.as_os_str().as_bytes().to_vec()
}

#[cfg(not(unix))]
fn path_bytes(path: &Path) -> Vec<u8> {
  path.to_string_lossy().into_owned().into_bytes()
}

/// ファイルの更新時刻（UNIX ナノ秒）。読めなければ 0。
pub(crate) fn modified_nanos(metadata: &std::fs::Metadata) -> u128 {
  metadata
    .modified()
    .ok()
    .and_then(|modified| modified.duration_since(UNIX_EPOCH).ok())
    .map(|since_epoch| since_epoch.as_nanos())
    .unwrap_or(0)
}

/// キャッシュのサムネイルのファイル名（`<64 桁の 16 進>.png` / `.jpg`）か。
pub(crate) fn is_thumbnail_file_name(name: &str) -> bool {
  name
    .split_once('.')
    .is_some_and(|(key, extension)| is_content_key(key) && matches!(extension, "png" | "jpg"))
}

/// 掃除の結果（ログ用）。
#[derive(Debug, Default, Clone, PartialEq, Eq)]
pub(crate) struct ThumbnailSweep {
  pub removed: usize,
  pub removed_bytes: u64,
  pub total_bytes: u64,
}

/// サムネイルのキャッシュ（`<app cache>/photo-thumbnails/<キー>.<png|jpg>`）。
pub(crate) struct ThumbnailCache {
  dir: PathBuf,
  max_bytes: u64,
  /// キャッシュの合計（起動後の最初の書き込みで数える。None はまだ数えていない）。掃除も直列にする
  total_bytes: Mutex<Option<u64>>,
}

impl ThumbnailCache {
  pub(crate) fn new(dir: PathBuf, max_bytes: u64) -> Self {
    Self {
      dir,
      max_bytes,
      total_bytes: Mutex::new(None),
    }
  }

  pub(crate) fn file_path(&self, key: &str, format: ThumbnailFormat) -> PathBuf {
    self.dir.join(format!("{key}.{}", format.extension()))
  }

  /// キャッシュにあれば中身を返し、最終利用（ファイルの更新日時）を今にする。形が壊れたもの（PNG / JPEG でない・
  /// 拡張子と合わない）は消す。
  pub(crate) fn read(&self, key: &str) -> Option<Vec<u8>> {
    for format in [ThumbnailFormat::Png, ThumbnailFormat::Jpeg] {
      let path = self.file_path(key, format);
      let Ok(metadata) = std::fs::symlink_metadata(&path) else {
        continue;
      };
      if !metadata.is_file() {
        continue;
      }
      match std::fs::read(&path) {
        Ok(bytes) if ThumbnailFormat::sniff(&bytes) == Some(format) => {
          mark_used(&path, SystemTime::now());
          return Some(bytes);
        }
        _ => {
          let _ = std::fs::remove_file(&path);
        }
      }
    }
    None
  }

  /// この仕事だけの一時フォルダ（キャッシュと同じボリュームに作り、できたファイルを rename で入れる）。
  fn work_dir(&self) -> io::Result<PathBuf> {
    ensure_private_dir(&self.dir)?;
    let path = self.dir.join(format!("{WORK_DIR_PREFIX}{}", random_hex(8)));
    std::fs::create_dir(&path)?;
    set_mode(&path, 0o700)?;
    Ok(path)
  }

  /// 作ったサムネイルを rename でキャッシュへ入れる（0600）。合計が上限を超えたら掃除し、その結果を返す。
  fn store(
    &self,
    key: &str,
    format: ThumbnailFormat,
    made: &Path,
    len: u64,
    now: SystemTime,
  ) -> io::Result<Option<ThumbnailSweep>> {
    let path = self.file_path(key, format);
    std::fs::rename(made, &path)?;
    let _ = set_mode(&path, 0o600);
    let mut total = lock(&self.total_bytes);
    if let Some(bytes) = total.as_mut() {
      *bytes += len;
      if *bytes <= self.max_bytes {
        return Ok(None);
      }
    }
    let swept = self.sweep_locked(now);
    *total = Some(swept.total_bytes);
    Ok(Some(swept))
  }

  /// 掃除だけをする（テスト用。アプリでは `store` が合計の上限を超えたときに掃除する）。
  #[cfg(test)]
  pub(crate) fn sweep(&self, now: SystemTime) -> ThumbnailSweep {
    let mut total = lock(&self.total_bytes);
    let swept = self.sweep_locked(now);
    *total = Some(swept.total_bytes);
    swept
  }

  /// 合計が上限を超えていたら、最終利用の古い順に上限以下まで消す。1 時間より古い一時フォルダ（落ちた仕事の残り）も
  /// 消す。キャッシュの形でないファイル・シンボリックリンクには触れない。
  fn sweep_locked(&self, now: SystemTime) -> ThumbnailSweep {
    let mut outcome = ThumbnailSweep::default();
    let Ok(entries) = std::fs::read_dir(&self.dir) else {
      return outcome;
    };
    let mut thumbnails: Vec<(SystemTime, PathBuf, u64)> = Vec::new();
    for entry in entries.flatten() {
      let name = entry.file_name();
      let Some(name) = name.to_str() else { continue };
      // DirEntry::metadata はシンボリックリンクをたどらない
      let Ok(metadata) = entry.metadata() else { continue };
      let modified = metadata.modified().unwrap_or(UNIX_EPOCH);
      if metadata.is_dir() && name.starts_with(WORK_DIR_PREFIX) {
        if now.duration_since(modified).unwrap_or(Duration::ZERO) > ORPHAN_WORK_AGE {
          let _ = std::fs::remove_dir_all(entry.path());
        }
        continue;
      }
      if metadata.is_file() && is_thumbnail_file_name(name) {
        outcome.total_bytes += metadata.len();
        thumbnails.push((modified, entry.path(), metadata.len()));
      }
    }
    if outcome.total_bytes <= self.max_bytes {
      return outcome;
    }
    // 最終利用の古い順（同じ時刻なら名前順）
    thumbnails.sort();
    for (_, path, len) in thumbnails {
      if outcome.total_bytes <= self.max_bytes {
        break;
      }
      if std::fs::remove_file(&path).is_ok() {
        outcome.total_bytes -= len;
        outcome.removed += 1;
        outcome.removed_bytes += len;
      }
    }
    outcome
  }
}

/// 同時に作るサムネイルの数を抑える（blocking のスレッドで空きを待つ）。
struct JobSlots {
  max: usize,
  busy: Mutex<usize>,
  freed: Condvar,
}

struct JobSlot<'a> {
  slots: &'a JobSlots,
}

impl JobSlots {
  fn new(max: usize) -> Self {
    Self {
      max: max.max(1),
      busy: Mutex::new(0),
      freed: Condvar::new(),
    }
  }

  fn acquire(&self) -> JobSlot<'_> {
    let mut busy = lock(&self.busy);
    while *busy >= self.max {
      busy = self.freed.wait(busy).unwrap_or_else(|poison| poison.into_inner());
    }
    *busy += 1;
    JobSlot { slots: self }
  }
}

impl Drop for JobSlot<'_> {
  fn drop(&mut self) {
    *lock(&self.slots.busy) -= 1;
    self.slots.freed.notify_one();
  }
}

/// 作ったサムネイルを読む。空・大きすぎる・PNG でも JPEG でもないものは None。
fn read_made_thumbnail(made: &Path) -> Option<(Vec<u8>, ThumbnailFormat)> {
  let metadata = std::fs::symlink_metadata(made).ok()?;
  if !metadata.is_file() || metadata.len() == 0 || metadata.len() > MAX_THUMBNAIL_BYTES {
    return None;
  }
  let bytes = std::fs::read(made).ok()?;
  let format = ThumbnailFormat::sniff(&bytes)?;
  Some((bytes, format))
}

/// ログに残す写真の拡張子（小文字。写真の拡張子の一覧にあるものだけ。パスやファイル名は書かない）。
fn log_extension(path: &Path) -> String {
  path
    .extension()
    .and_then(|extension| extension.to_str())
    .map(str::to_lowercase)
    .filter(|extension| PHOTO_FILE_EXTENSIONS.contains(&extension.as_str()))
    .unwrap_or_default()
}

// ---------------------------------------------------------------------------
// フォルダの一覧（アプリに 1 つ）

/// `photo_editing_remembered` の走査の予算（テストでは小さくする）。
#[derive(Clone, Copy, Debug)]
pub struct RememberedBudget {
  /// 覚えたフォルダ全体で、木に載せる写真の合計
  pub max_photos: usize,
  /// 走査を始めてよい時間
  pub max_elapsed: Duration,
}

impl Default for RememberedBudget {
  fn default() -> Self {
    Self {
      max_photos: MAX_REMEMBERED_LISTED_PHOTOS,
      max_elapsed: REMEMBERED_SCAN_TIME_BUDGET,
    }
  }
}

/// フォルダの一覧とサムネイルの設定（テストでは小さな上限・一時フォルダ・偽のサムネイル作りに差し替える）。
pub struct LibraryConfig {
  pub limits: ScanLimits,
  /// `photo_editing_remembered` の走査の予算（#16578）
  pub remembered_budget: RememberedBudget,
  /// サムネイルのキャッシュのフォルダ。None なら作れない（`internal`）
  pub thumbnail_dir: Option<PathBuf>,
  pub thumbnail_cache_max_bytes: u64,
  pub thumbnail_timeout: Duration,
  pub max_thumbnail_jobs: usize,
  pub maker: ThumbnailMaker,
  /// 覚えたフォルダ・写真の置き場（`<app data>/photo-editing/remembered.json`、#16578）。None なら覚えない
  /// （`photo_editing_remembered` は空）
  pub remembered: Option<RememberedStore>,
  /// `desktop-bridge.log` へ書く（kind, payload）
  pub log: LogFn,
}

/// フォルダの一覧から選んだ写真（{@link PhotoLibrary::listed_photos}）。`path` はアプリが覚えている写真のファイルで、
/// 知らない `entryId` なら None。
pub struct ListedPhoto {
  pub entry_id: String,
  pub path: Option<PathBuf>,
}

/// フォルダの一覧（`folderId` / `entryId`）とサムネイル。
pub struct PhotoLibrary {
  config: LibraryConfig,
  ids: Mutex<LibraryIds>,
  /// この起動中に選んだ写真。remembered.json を書けなくても一覧へ出し続け、毎回存在を確かめる。
  selected_session: Mutex<Vec<PathBuf>>,
  thumbnails: Option<ThumbnailCache>,
  jobs: JobSlots,
}

impl PhotoLibrary {
  /// アプリに 1 つ作る。フォルダは最初の {@link PhotoLibrary::add_folder} か {@link PhotoLibrary::remembered} まで読まない。
  pub fn new(config: LibraryConfig) -> Arc<Self> {
    let thumbnails = config
      .thumbnail_dir
      .clone()
      .map(|dir| ThumbnailCache::new(dir, config.thumbnail_cache_max_bytes));
    let jobs = JobSlots::new(config.max_thumbnail_jobs);
    Arc::new(Self {
      config,
      ids: Mutex::new(LibraryIds::default()),
      selected_session: Mutex::new(Vec::new()),
      thumbnails,
      jobs,
    })
  }

  fn log(&self, kind: &str, payload: Value) {
    (self.config.log)(&format!("photo_editing.{kind}"), payload);
  }

  /// フォルダの選択ダイアログで選んだフォルダを覚えて読む（`{ folder }` の `folder`）。読めなければ `notFound`
  /// （覚えない）。読めたフォルダは次の起動でも `photo_editing_remembered` で出す（#16578）。
  pub fn add_folder(&self, picked: &Path) -> Result<Value, PageError> {
    // 選んだパスの途中のシンボリックリンク（スタッフが選んだもの）は解いておく。その下ではたどらない
    let root = std::fs::canonicalize(picked).unwrap_or_else(|_| picked.to_path_buf());
    let folder = self
      .list(&root)
      .map_err(|_| PageError::new(code::NOT_FOUND, FOLDER_UNREADABLE_MESSAGE))?;
    self.remember("addFolder", |store, now| store.remember_folder(&root, now));
    Ok(folder)
  }

  /// 「この Mac の写真」: 写真の選択ダイアログで選んだ写真を覚え、開かずに一覧の写真（`{ photos }` の `photos`、
  /// フォルダの一覧の `photos` と同じ形）にして返す（#16578）。選んだパスの途中のシンボリックリンク（ファイル自身を
  /// 含む。スタッフが選んだもの）は解き、指す先を使う（フォルダの一覧と同じ `entryId` になる）。もう無い・ふつうの
  /// ファイルでない・写真の拡張子でない・隠しファイルのものは黙って飛ばす。同じ写真は 1 つ（選んだ順）。
  pub fn add_photos(&self, picked: &[PathBuf]) -> Vec<Value> {
    let started = Instant::now();
    let max_photos = self
      .config
      .remembered
      .as_ref()
      .map(RememberedStore::max_photos)
      .unwrap_or(MAX_REMEMBERED_PHOTOS);
    let mut seen = HashSet::new();
    let photos: Vec<ScannedPhoto> = picked
      .iter()
      .filter_map(|path| std::fs::canonicalize(path).ok())
      .filter(|path| seen.insert(path.clone()))
      .filter_map(existing_photo)
      .collect();
    // 返す写真は従来どおり全件。上限は再表示用の参照だけに適用する。
    if !photos.is_empty() {
      let paths: Vec<PathBuf> = photos.iter().map(|photo| photo.path.clone()).collect();
      let mut session = lock(&self.selected_session);
      let chosen: HashSet<PathBuf> = paths.iter().cloned().collect();
      let older = std::mem::take(&mut *session)
        .into_iter()
        .filter(|path| !chosen.contains(path));
      *session = paths.iter().cloned().chain(older).take(max_photos).collect();
      drop(session);
      self.remember("addPhotos", |store, now| store.remember_photos(&paths, now));
    }
    let entries = self.page_entries(photos);
    self.log(
      "photos_added",
      json!({ "picked": picked.len(), "added": entries.len(), "elapsedMs": started.elapsed().as_millis() as u64 }),
    );
    entries
  }

  /// 「選んだ写真」だけを再読込する。フォルダ木の再走査を必要としない。
  pub fn selected_photos(&self) -> Vec<Value> {
    let remembered = self
      .config
      .remembered
      .as_ref()
      .map(RememberedStore::load)
      .unwrap_or_default();
    self.selected_photo_entries(&remembered.photos)
  }

  fn selected_photo_entries(&self, remembered: &[RememberedEntry]) -> Vec<Value> {
    let session = lock(&self.selected_session).clone();
    let mut seen = HashSet::new();
    let max_photos = self
      .config
      .remembered
      .as_ref()
      .map(RememberedStore::max_photos)
      .unwrap_or(MAX_REMEMBERED_PHOTOS);
    let photos = session
      .into_iter()
      .chain(remembered.iter().map(|photo| photo.path.clone()))
      .filter(|path| seen.insert(path.clone()))
      .filter_map(existing_photo)
      .take(max_photos)
      .collect();
    self.page_entries(photos)
  }

  /// 覚えたフォルダ・写真のうち、いまあるものを返す（`{ folders, photos }`、#16578）。フォルダは
  /// `photo_editing_add_folder` と同じ木（同じ `folderId`）で覚えた順（新しい順）、写真はいまある写真の
  /// ファイルだけを一覧の写真で新しい順に返す。見つからない・読めないもの（SD カードを抜いた・消した・権限・
  /// シンボリックリンクに置き換わった）は黙って出さず、覚えたままにする。エンジンは使わない。
  ///
  /// 走査には予算がある（`RememberedBudget`）。木に載せる写真の合計が予算に達したか、走査を始めてからの時間が予算を
  /// 過ぎたら、次のフォルダからは中を読まず根だけ返す（`children` と `photos` は空・`truncated: true`。ページは選ばれた
  /// ときに `photo_editing_list_folder` で読む）。予算の残りが少ないフォルダは、その残りまでの木（`truncated: true`）になる。
  pub fn remembered(&self) -> Value {
    let started = Instant::now();
    let budget = self.config.remembered_budget;
    let remembered = self
      .config
      .remembered
      .as_ref()
      .map(RememberedStore::load)
      .unwrap_or_default();
    let mut photos_left = budget.max_photos;
    let mut deferred = 0usize;
    let mut folders: Vec<Value> = Vec::new();
    for folder in &remembered.folders {
      if photos_left == 0 || started.elapsed() >= budget.max_elapsed {
        if let Some(stub) = self.folder_stub(&folder.path) {
          deferred += 1;
          folders.push(stub);
        }
        continue;
      }
      let limits = ScanLimits {
        max_photos: self.config.limits.max_photos.min(photos_left),
        ..self.config.limits
      };
      if let Ok((value, listed)) = self.list_within(&folder.path, limits) {
        photos_left = photos_left.saturating_sub(listed);
        folders.push(value);
      }
    }
    let photos = self.selected_photo_entries(&remembered.photos);
    self.log(
      "remembered_listed",
      json!({
        "rememberedFolders": remembered.folders.len(),
        "foundFolders": folders.len(),
        "deferredFolders": deferred,
        "listedPhotosInFolders": budget.max_photos - photos_left,
        "rememberedPhotos": remembered.photos.len(),
        "foundPhotos": photos.len(),
        "elapsedMs": started.elapsed().as_millis() as u64,
      }),
    );
    json!({ "folders": folders, "photos": photos })
  }

  /// 予算を使い切ったあとの覚えたフォルダ: 中を読まず、根だけ返す（`children` と `photos` は空・`truncated: true`）。
  /// `folderId` は振るので、ページは `photo_editing_list_folder` で読める。フォルダでない（無い・シンボリックリンクに
  /// 置き換わった）・開けないものは None（黙って出さない）。`metadata` と `read_dir` を開くだけで、中は読まない。
  fn folder_stub(&self, path: &Path) -> Option<Value> {
    if !std::fs::symlink_metadata(path).ok()?.is_dir() || std::fs::read_dir(path).is_err() {
      return None;
    }
    let root = ScannedFolder {
      path: path.to_path_buf(),
      name: folder_name(path),
      photos: Vec::new(),
      children: Vec::new(),
      truncated: true,
    };
    Some(lock(&self.ids).page_folder(root))
  }

  /// 覚えたフォルダ・写真を全部消す（`cache_purge`＝スタッフの Mac を返す・渡すとき）。置き場が無ければ何もしない。
  pub fn purge_remembered(&self) -> io::Result<()> {
    let purged = match self.config.remembered.as_ref() {
      Some(store) => store.purge(),
      None => Ok(()),
    };
    self.log(
      "remembered_purged",
      json!({ "ok": purged.is_ok(), "error": purged.as_ref().err().map(|err| err.kind().to_string()) }),
    );
    if purged.is_ok() {
      lock(&self.selected_session).clear();
    }
    purged
  }

  /// 選んだフォルダ・写真を覚える。書けなくても（ディスクの空き・権限・アプリデータの場所が分からない）コマンドは
  /// 失敗にせず、`remembered_write_failed`（`operation` と `io::ErrorKind` だけ。パスは書かない）を残す。
  fn remember(&self, operation: &str, write: impl FnOnce(&RememberedStore, SystemTime) -> io::Result<()>) {
    let written = match self.config.remembered.as_ref() {
      Some(store) => write(store, SystemTime::now()),
      None => Err(io::Error::new(io::ErrorKind::NotFound, "no app data directory")),
    };
    if let Err(err) = written {
      self.log(
        "remembered_write_failed",
        json!({ "operation": operation, "error": err.kind().to_string() }),
      );
    }
  }

  /// 写真に `entryId` を振ってページへ返す値にする（同じファイルなら同じ ID）。
  fn page_entries(&self, photos: Vec<ScannedPhoto>) -> Vec<Value> {
    let mut ids = lock(&self.ids);
    photos.into_iter().map(|photo| ids.page_entry(photo)).collect()
  }

  /// 覚えたフォルダ（`photo_editing_add_folder` で足した根）を一覧から外す（NIHO camera の「一覧から外す」。フォルダと写真は
  /// 消さない）。知らない `folderId`・サブフォルダは `notFound`。覚えた置き場に書けなければ `internal`。
  pub fn forget_folder(&self, folder_id: &str) -> Result<(), PageError> {
    let path = lock(&self.ids)
      .library_folders
      .get(folder_id)
      .cloned()
      .ok_or_else(folder_not_found)?;
    let remembered = self
      .config
      .remembered
      .as_ref()
      .map(RememberedStore::load)
      .unwrap_or_default();
    if !remembered.folders.iter().any(|folder| folder.path == path) {
      return Err(folder_not_found());
    }
    let forgotten = self.config.remembered.as_ref().map(|store| store.forget_folder(&path));
    self.log(
      "remembered_folder_forgotten",
      json!({ "ok": matches!(forgotten, Some(Ok(_))), "error": forgotten.as_ref().and_then(|result| result.as_ref().err()).map(|err| err.kind().to_string()) }),
    );
    match forgotten {
      Some(Ok(_)) => Ok(()),
      _ => Err(PageError::new(code::INTERNAL, FORGET_FAILED_MESSAGE)),
    }
  }

  /// 「選んだ写真」をすべて一覧から外す。元の写真・覚えたフォルダ・補正には触れない。永続参照を書き換えられなければ
  /// セッション参照も残し、成功を返さない。
  pub fn forget_photos(&self) -> Result<(), PageError> {
    let forgotten = match self.config.remembered.as_ref() {
      Some(store) => store.forget_photos(),
      None => Ok(false),
    };
    self.log(
      "remembered_photos_forgotten",
      json!({ "ok": forgotten.is_ok(), "error": forgotten.as_ref().err().map(|err| err.kind().to_string()) }),
    );
    match forgotten {
      Ok(_) => {
        lock(&self.selected_session).clear();
        Ok(())
      }
      Err(_) => Err(PageError::new(code::INTERNAL, FORGET_FAILED_MESSAGE)),
    }
  }

  /// `folderId`（追加したフォルダかそのサブフォルダ）を読み直す。知らない ID・もう無い（シンボリックリンクに置き換わった
  /// ものを含む）・読めないフォルダは `notFound`。
  pub fn list_folder(&self, folder_id: &str) -> Result<Value, PageError> {
    let path = lock(&self.ids)
      .library_folders
      .get(folder_id)
      .cloned()
      .ok_or_else(folder_not_found)?;
    self.list(&path).map_err(|_| folder_not_found())
  }

  fn list(&self, root: &Path) -> io::Result<Value> {
    self.list_within(root, self.config.limits).map(|(folder, _)| folder)
  }

  /// `limits` の上限で `root` の木を読む（木に載せた写真の数も返す。`photo_editing_remembered` の予算の計算に使う）。
  fn list_within(&self, root: &Path, limits: ScanLimits) -> io::Result<(Value, usize)> {
    let started = Instant::now();
    let scan = scan_tree(root, limits)?;
    let truncated = scan.tree.truncated;
    let folder = lock(&self.ids).page_folder(scan.tree);
    self.log(
      "folder_listed",
      json!({
        "photos": scan.photos,
        "folders": scan.folders,
        "truncated": truncated,
        "elapsedMs": started.elapsed().as_millis() as u64,
      }),
    );
    Ok((folder, scan.photos))
  }

  /// `entryId` の写真のファイル（知らない ID は None）。
  pub fn entry_path(&self, entry_id: &str) -> Option<PathBuf> {
    lock(&self.ids).entries.get(entry_id).cloned()
  }

  /// `photo_editing_open_entries` で開く写真（知らない・形の違う `entryId` は `path` が None）。
  pub fn listed_photos(&self, entry_ids: Vec<String>) -> Vec<ListedPhoto> {
    let ids = lock(&self.ids);
    entry_ids
      .into_iter()
      .map(|entry_id| {
        let path = is_valid_id(&entry_id)
          .then(|| ids.entries.get(&entry_id).cloned())
          .flatten();
        ListedPhoto { entry_id, path }
      })
      .collect()
  }

  /// 一覧の写真のサムネイル（PNG か JPEG のバイト列）。キャッシュにあればそれを返し、無ければエンジンを使わずに作る。
  /// 知らない `entryId`・もう無いファイルは `notFound`、作れなければ `decodeFailed`、時間切れは `internal`。
  pub fn thumbnail(&self, entry_id: &str, max_dimension: u32) -> Result<Vec<u8>, PageError> {
    let path = self.entry_path(entry_id).ok_or_else(photo_not_found)?;
    let metadata = std::fs::symlink_metadata(&path)
      .ok()
      .filter(|metadata| metadata.is_file())
      .ok_or_else(photo_not_found)?;
    validate_photo(&path, CapabilityStage::Thumbnail)?;
    let cache = self.thumbnails.as_ref().ok_or_else(thumbnail_cache_failed)?;
    let key = thumbnail_key(&path, metadata.len(), modified_nanos(&metadata), max_dimension);
    if let Some(bytes) = cache.read(&key) {
      return Ok(bytes);
    }
    let _slot = self.jobs.acquire();
    // 空きを待つ間に、同じサムネイルをほかの要求が作り終えていればそれを返す
    if let Some(bytes) = cache.read(&key) {
      return Ok(bytes);
    }
    let work_dir = cache.work_dir().map_err(|err| {
      self.log(
        "thumbnail_cache_failed",
        json!({ "operation": "createDir", "error": err.kind().to_string() }),
      );
      thumbnail_cache_failed()
    })?;
    let made = self.make_thumbnail(cache, &key, &path, max_dimension, &work_dir);
    let _ = std::fs::remove_dir_all(&work_dir);
    made
  }

  fn make_thumbnail(
    &self,
    cache: &ThumbnailCache,
    key: &str,
    source: &Path,
    max_dimension: u32,
    work_dir: &Path,
  ) -> Result<Vec<u8>, PageError> {
    let job = ThumbnailJob {
      source,
      max_dimension,
      work_dir,
      deadline: Instant::now() + self.config.thumbnail_timeout,
    };
    let made = (self.config.maker)(&job).map_err(|failure| {
      let reason = match failure {
        MakeFailure::Failed => "failed",
        MakeFailure::TimedOut => "timeout",
      };
      self.log(
        "thumbnail_failed",
        json!({ "reason": reason, "extension": log_extension(source) }),
      );
      match failure {
        MakeFailure::Failed => PageError::new(code::DECODE_FAILED, THUMBNAIL_FAILED_MESSAGE),
        MakeFailure::TimedOut => PageError::new(code::INTERNAL, THUMBNAIL_TIMEOUT_MESSAGE),
      }
    })?;
    let Some((bytes, format)) = read_made_thumbnail(&made) else {
      self.log(
        "thumbnail_failed",
        json!({ "reason": "invalidOutput", "extension": log_extension(source) }),
      );
      return Err(PageError::new(code::DECODE_FAILED, THUMBNAIL_FAILED_MESSAGE));
    };
    // キャッシュへ入れられなくても、作ったサムネイルは返す（次はもう一度作る）
    match cache.store(key, format, &made, bytes.len() as u64, SystemTime::now()) {
      Ok(Some(swept)) if swept.removed > 0 => self.log(
        "thumbnail_cache_swept",
        json!({ "removed": swept.removed, "removedBytes": swept.removed_bytes, "totalBytes": swept.total_bytes }),
      ),
      Ok(_) => {}
      Err(err) => self.log(
        "thumbnail_cache_failed",
        json!({ "operation": "store", "error": err.kind().to_string() }),
      ),
    }
    Ok(bytes)
  }
}

pub fn is_valid_id(id: &str) -> bool {
  !id.is_empty() && id.len() <= MAX_ID_CHARS
}

pub fn folder_not_found() -> PageError {
  PageError::new(code::NOT_FOUND, FOLDER_NOT_FOUND_MESSAGE)
}

pub fn photo_not_found() -> PageError {
  PageError::new(code::NOT_FOUND, LISTED_PHOTO_NOT_FOUND_MESSAGE)
}

fn thumbnail_cache_failed() -> PageError {
  PageError::new(code::INTERNAL, THUMBNAIL_CACHE_FAILED_MESSAGE)
}

#[cfg(test)]
#[path = "library_tests.rs"]
mod tests;

#[cfg(test)]
#[path = "library_forget_tests.rs"]
mod forget_tests;
