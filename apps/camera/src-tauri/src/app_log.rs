//! NIHO photo のログ（`~/Library/Logs/life.niho.camera/camera.log`。1 行 1 JSON）。現像・フォルダの一覧の crate が書く
//! kind と payload（パスは入らない）を残し、問い合わせのときに読む。NIHO Desktop の `desktop-bridge.log` と同じ形・同じ回し方。

use std::fs;
use std::io::Write;
use std::path::Path;
use std::sync::{Arc, Mutex};
use std::time::{SystemTime, UNIX_EPOCH};
use tauri::Manager;

const LOG_FILE_NAME: &str = "camera.log";
/// これを超えたら `camera.log.1` へ回す（`.1`〜`.3` を残す）
const LOG_MAX_BYTES: u64 = 5 * 1024 * 1024;
const LOG_MAX_BACKUPS: u32 = 3;
/// Tauri commands can finish concurrently; keep rotation and each JSONL append in one critical section.
static APP_LOG_LOCK: Mutex<()> = Mutex::new(());

/// crate に渡すログの書き手。
pub fn log_fn(app: &tauri::AppHandle) -> niho_desktop_photo::common::LogFn {
  let dir = app.path().app_log_dir().ok();
  Arc::new(move |kind, payload| {
    if let Some(dir) = &dir {
      append(dir, kind, payload);
    }
  })
}

pub fn append(dir: &Path, kind: &str, payload: serde_json::Value) {
  let epoch_ms = SystemTime::now()
    .duration_since(UNIX_EPOCH)
    .map(|elapsed| elapsed.as_millis())
    .unwrap_or_default();
  let line = serde_json::json!({ "epochMs": epoch_ms, "kind": kind, "data": payload });
  let Ok(mut bytes) = serde_json::to_vec(&line) else {
    return;
  };
  bytes.push(b'\n');

  let _guard = APP_LOG_LOCK.lock().unwrap_or_else(|poison| poison.into_inner());
  if fs::create_dir_all(dir).is_err() {
    return;
  }
  let path = dir.join(LOG_FILE_NAME);
  if fs::metadata(&path).is_ok_and(|metadata| metadata.len() > LOG_MAX_BYTES) {
    for index in (1..LOG_MAX_BACKUPS).rev() {
      let _ = fs::rename(
        dir.join(format!("{LOG_FILE_NAME}.{index}")),
        dir.join(format!("{LOG_FILE_NAME}.{}", index + 1)),
      );
    }
    let _ = fs::rename(&path, dir.join(format!("{LOG_FILE_NAME}.1")));
  }
  if let Ok(mut file) = fs::OpenOptions::new().create(true).append(true).open(&path) {
    let _ = file.write_all(&bytes);
  }
}

#[cfg(test)]
mod tests {
  use super::*;
  use std::collections::HashSet;

  fn test_dir(name: &str) -> std::path::PathBuf {
    let unique = SystemTime::now().duration_since(UNIX_EPOCH).unwrap().as_nanos();
    std::env::temp_dir().join(format!("niho-camera-log-test-{}-{name}-{unique}", std::process::id()))
  }

  #[test]
  fn appends_json_lines_and_rotates_over_the_limit() {
    let dir = test_dir("rotation");
    append(&dir, "photo_editing.folder_listed", serde_json::json!({ "photos": 3 }));
    let first: serde_json::Value = serde_json::from_str(
      fs::read_to_string(dir.join(LOG_FILE_NAME))
        .unwrap()
        .lines()
        .next()
        .unwrap(),
    )
    .unwrap();
    assert_eq!(first["kind"], "photo_editing.folder_listed");
    assert_eq!(first["data"]["photos"], 3);

    fs::write(dir.join(LOG_FILE_NAME), vec![b'x'; LOG_MAX_BYTES as usize + 1]).unwrap();
    append(&dir, "next", serde_json::json!({}));
    assert!(fs::metadata(dir.join(format!("{LOG_FILE_NAME}.1"))).unwrap().len() > LOG_MAX_BYTES);
    assert_eq!(fs::read_to_string(dir.join(LOG_FILE_NAME)).unwrap().lines().count(), 1);
    let _ = fs::remove_dir_all(&dir);
  }

  #[test]
  fn concurrent_appends_keep_complete_unique_json_lines_across_rotation() {
    const WORKERS: usize = 8;
    const ENTRIES_PER_WORKER: usize = 160;
    let dir = test_dir("concurrent");
    let mut workers = Vec::new();
    for worker in 0..WORKERS {
      let dir = dir.clone();
      workers.push(std::thread::spawn(move || {
        for sequence in 0..ENTRIES_PER_WORKER {
          append(
            &dir,
            "concurrent_test",
            serde_json::json!({ "worker": worker, "sequence": sequence, "payload": "x".repeat(4096) }),
          );
        }
      }));
    }
    for worker in workers {
      worker.join().unwrap();
    }

    let mut keys = HashSet::new();
    let mut parsed_lines = 0;
    for index in 0..=LOG_MAX_BACKUPS {
      let path = if index == 0 {
        dir.join(LOG_FILE_NAME)
      } else {
        dir.join(format!("{LOG_FILE_NAME}.{index}"))
      };
      if !path.exists() {
        continue;
      }
      for line in fs::read_to_string(path).unwrap().lines() {
        let value: serde_json::Value = serde_json::from_str(line).expect("each append remains one JSON line");
        assert_eq!(value["kind"], "concurrent_test");
        let key = (
          value["data"]["worker"].as_u64().unwrap(),
          value["data"]["sequence"].as_u64().unwrap(),
        );
        assert!(keys.insert(key), "no event is appended twice: {key:?}");
        parsed_lines += 1;
      }
    }
    assert_eq!(
      parsed_lines,
      WORKERS * ENTRIES_PER_WORKER,
      "every concurrent event survives rotation"
    );
    assert!(
      dir.join(format!("{LOG_FILE_NAME}.1")).exists(),
      "concurrent appends exercised log rotation"
    );
    let _ = fs::remove_dir_all(&dir);
  }
}
