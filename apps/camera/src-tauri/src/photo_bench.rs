//! 旧 NIHO camera（Photo Bench・`life.niho.photobench`）で保存した補正があるか（spec `niho-camera-app.md`「データ（この Mac）」:
//! 写さない・初回起動の案内 1 行だけ。owner 2026-09-30「写せなければ捨ててよい」）。
//!
//! Photo Bench は `~/Library/Application Support/PhotoBench/edits/<写真のパスの SHA-256>.json` に補正を置く（Photo Bench の
//! `PhotoBenchStore`）。ここは「ある / ない」だけを返し、中身・パスは読まない・渡さない。

use crate::error::CameraError;
use serde_json::{json, Value};
use std::path::{Path, PathBuf};

/// Photo Bench の補正の置き場（`~/Library/Application Support/PhotoBench/edits`）。
pub fn photo_bench_edits_dir(home: &Path) -> PathBuf {
  home.join("Library/Application Support/PhotoBench/edits")
}

/// 補正の記録（`.json`）が 1 つでもあるか。読めない・無いときは false。
pub fn has_photo_bench_edits(dir: &Path) -> bool {
  std::fs::read_dir(dir).is_ok_and(|entries| {
    entries.flatten().any(|entry| {
      entry
        .file_name()
        .to_str()
        .is_some_and(|name| name.ends_with(".json") && !name.starts_with('.'))
        && entry.file_type().is_ok_and(|kind| kind.is_file())
    })
  })
}

/// `{ found }`。画面は found のときだけ、初回に案内を 1 行出す（閉じたら出さない）。
#[tauri::command]
pub async fn camera_photo_bench_edits() -> Result<Value, CameraError> {
  let found = std::env::var_os("HOME")
    .map(PathBuf::from)
    .is_some_and(|home| has_photo_bench_edits(&photo_bench_edits_dir(&home)));
  Ok(json!({ "found": found }))
}

#[cfg(test)]
mod tests {
  use super::*;

  #[test]
  fn photo_bench_edits_are_found_only_when_a_record_exists() {
    let home = std::env::temp_dir().join(format!("niho-camera-photobench-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&home);
    let dir = photo_bench_edits_dir(&home);
    assert!(!has_photo_bench_edits(&dir), "置き場が無い");
    std::fs::create_dir_all(dir.join("sub.json")).unwrap();
    std::fs::write(dir.join(".DS_Store"), b"").unwrap();
    std::fs::write(dir.join(".hidden.json"), b"{}").unwrap();
    assert!(!has_photo_bench_edits(&dir), "記録の形でないものは数えない");
    std::fs::write(dir.join(format!("{}.json", "a".repeat(64))), b"{}").unwrap();
    assert!(has_photo_bench_edits(&dir));
    let _ = std::fs::remove_dir_all(&home);
  }
}
