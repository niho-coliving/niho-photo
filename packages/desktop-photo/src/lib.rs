//! # niho_desktop_photo（Mac の写真の土台）
//!
//! NIHO Desktop（`apps/desktop`）と NIHO camera（`apps/camera`、C3 #18391）が**同じ関数で**使う、Mac の写真編集の土台
//公開移植前の内部構成については docs/migration/mac-client.md を参照。
//! 依らない部分を挙動を変えずに移した。Tauri に依存しない。
//!
//! アプリが持つもの: コマンドの登録・ACL・イベント・窓、ファイルとフォルダの選択ダイアログ、ログの書き先、`.app` の中の
//! sidecar の場所、アプリのキャッシュとデータのフォルダの解決。ここへは設定（パス・フォルダ・ログの closure）として渡す。
//!
//! ## 公開 API
//!
//! ### 現像（[`develop`]）
//!
//! - sidecar（`apple-raw-linear`・`niho-develop-render`）の実行と版の照合: [`develop::probe_sidecars`]・
//!   [`develop::run_sidecar`]・[`develop::is_compatible_tool_version`]・[`develop::SidecarPaths`]・[`develop::Sidecars`]。
//!   同梱の版は `develop-sidecars.lock.json`（アプリの配布のスクリプトが読む）で固定し、起動時にここで照らす。
//! - 作業コピーの作成とキャッシュ・`baseVersion`: [`develop::PhotoDevelop::source`]（作業コピーを作るかオリジナルを渡す）・
//!   [`develop::PhotoDevelop::source_bytes`]・[`develop::PhotoDevelop::work_copy_info`]（クラウドへ上げる作業コピー）。
//!   `baseVersion` の規則はワーカーと同じ（[`develop::describe_working_copy`]・[`develop::build_base_version`]・
//!   [`develop::build_raster_base_version`]）。
//! - 原寸の書き出し: [`develop::PhotoDevelop::export`]（RAW は `apple-raw-linear render --long-edge full` →
//!   `niho-develop-render` → `encode-jpeg`）。
//! - 写真の出どころはアプリが [`develop::DevelopPhotos`] で渡し、設定は [`develop::DevelopConfig`] で渡す。
//!
//! ### フォルダの一覧とサムネイル（[`library`]）
//!
//! - 選んだフォルダの走査（拡張子・隠しファイル・シンボリックリンク・深さ・上限）、不透明な `folderId` / `entryId`、
//!   サムネイル（QuickLook / sips・キャッシュ・上限・同時 2 枚）、覚えたフォルダ・写真の一覧は [`library::PhotoLibrary`]。
//!   設定は [`library::LibraryConfig`]。
//!
//! ### この Mac に保存した補正（[`saved_settings`]）と覚えたフォルダ・写真（[`remembered`]）
//!
//! - [`saved_settings::SavedSettingsStore`]（写真の中身の SHA-256 をキーにした補正の保存）・[`saved_settings::content_digest`]。
//! - [`remembered::RememberedStore`]（覚えたフォルダ・写真の置き場）。
//!
//! ### 共通（[`common`]）
//!
//! - ページへ返す code（[`common::code`]）と失敗（[`common::PageError`]）、ログ（[`common::LogFn`]）、不透明な ID
//!   （[`common::new_opaque_id`]）、パスを伏せる（[`common::scrub_paths`]）。
//!
//! ## テストの道具
//!
//! feature `test-support` で `test_support`（偽の sidecar・一時フォルダ・偽のサムネイル作り）を公開する。アプリの
//! `dev-dependencies` だけが使い、アプリのビルドには入らない。

// 公開移植前の内部構成については docs/migration/mac-client.md を参照。
// いるので Windows ではビルドしない（Windows の NIHO Desktop は web だけの shell。中身は空の crate になる）。
#![cfg(not(target_os = "windows"))]

pub mod common;
pub mod develop;
pub mod image_info;
pub mod library;
pub mod remembered;
pub mod saved_settings;
#[cfg(any(test, feature = "test-support"))]
pub mod test_support;
