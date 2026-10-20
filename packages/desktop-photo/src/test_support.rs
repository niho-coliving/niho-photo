//! テストの道具（偽の sidecar・校正・一時フォルダ・偽のサムネイル作り）。この crate のテストと、アプリのテスト（feature
//! `test-support`。NIHO Desktop の `dev-dependencies`）が使う。アプリのビルドには入らない。C2 #18390 で NIHO Desktop の
//! `photo_develop_tests.rs`・`photo_library_tests.rs` から移した。

use std::fs;
use std::path::Path;
use std::time::SystemTime;

pub mod develop;
pub mod library;

/// ファイルの更新日時を変える（最終利用の順・古さを作る）。
pub fn set_modified(path: &Path, when: SystemTime) {
  fs::File::options()
    .write(true)
    .open(path)
    .unwrap()
    .set_modified(when)
    .unwrap();
}
