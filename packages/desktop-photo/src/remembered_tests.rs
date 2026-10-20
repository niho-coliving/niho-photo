use super::*;
use std::ffi::OsStr;
use std::os::unix::ffi::OsStrExt;
use std::os::unix::fs::{symlink, PermissionsExt};
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::{Duration, UNIX_EPOCH};

/// テストごとの一時フォルダ（Drop で消す）。本物のアプリのデータには触れない。
struct TempDir(PathBuf);

impl TempDir {
  fn new(name: &str) -> Self {
    static COUNTER: AtomicU64 = AtomicU64::new(1);
    let dir = std::env::temp_dir().join(format!(
      "niho-photo-remembered-{name}-{}-{}",
      std::process::id(),
      COUNTER.fetch_add(1, Ordering::SeqCst)
    ));
    let _ = fs::remove_dir_all(&dir);
    fs::create_dir_all(&dir).unwrap();
    Self(dir)
  }

  /// 置き場のファイル（`<app data>/photo-editing/remembered.json`）。
  fn file(&self) -> PathBuf {
    remembered_path(&self.0.join("app-data"))
  }

  fn store(&self, limits: RememberedLimits) -> RememberedStore {
    RememberedStore::new(self.file(), limits)
  }

  fn record(&self) -> Value {
    serde_json::from_slice(&fs::read(self.file()).unwrap()).unwrap()
  }

  /// 置き場のファイルを直接書く（途中のフォルダも作る）。
  fn write(&self, body: &[u8]) {
    fs::create_dir_all(self.file().parent().unwrap()).unwrap();
    fs::write(self.file(), body).unwrap();
  }
}

impl Drop for TempDir {
  fn drop(&mut self) {
    let _ = fs::remove_dir_all(&self.0);
  }
}

fn at(millis: u64) -> SystemTime {
  UNIX_EPOCH + Duration::from_millis(millis)
}

fn path(text: &str) -> PathBuf {
  PathBuf::from(text)
}

fn entry(text: &str, added_at_ms: u64) -> RememberedEntry {
  RememberedEntry {
    path: path(text),
    added_at_ms,
  }
}

fn texts(entries: &[RememberedEntry]) -> Vec<String> {
  entries
    .iter()
    .map(|entry| entry.path.to_string_lossy().into_owned())
    .collect()
}

fn mode(path: &Path) -> u32 {
  fs::metadata(path).unwrap().permissions().mode() & 0o777
}

const SD: &str = "/test-data/volumes/NIKON Z6/DCIM/100NCZ_6";

#[test]
fn remembers_folders_and_photos_newest_first_with_one_entry_per_path() {
  let temp = TempDir::new("order");
  let store = temp.store(RememberedLimits::default());
  assert_eq!(store.load(), Remembered::default());
  assert!(!temp.file().exists(), "reading never creates the file");

  store.remember_folder(Path::new(SD), at(1_000)).unwrap();
  store
    .remember_folder(Path::new("/test-data/users/staff/Pictures/2026"), at(2_000))
    .unwrap();
  // 一度に選んだ写真はダイアログの順に先頭へ。同じ写真を 2 度選んでも 1 つ
  let first = format!("{SD}/DSC_0001.NEF");
  let second = format!("{SD}/DSC_0002.JPG");
  store
    .remember_photos(&[path(&first), path(&second), path(&first)], at(3_000))
    .unwrap();
  store
    .remember_photos(&[path("/test-data/users/staff/Desktop/P1524180.RW2")], at(4_000))
    .unwrap();
  let remembered = store.load();
  assert_eq!(
    remembered.folders,
    [entry("/test-data/users/staff/Pictures/2026", 2_000), entry(SD, 1_000)]
  );
  assert_eq!(
    remembered.photos,
    [
      entry("/test-data/users/staff/Desktop/P1524180.RW2", 4_000),
      entry(&first, 3_000),
      entry(&second, 3_000)
    ]
  );

  // 選び直したら先頭へ動かし、時刻も今にする（1 つのまま）
  store.remember_folder(Path::new(SD), at(5_000)).unwrap();
  store.remember_photos(&[path(&second)], at(6_000)).unwrap();
  let remembered = store.load();
  assert_eq!(
    remembered.folders,
    [entry(SD, 5_000), entry("/test-data/users/staff/Pictures/2026", 2_000)]
  );
  assert_eq!(
    texts(&remembered.photos),
    [
      second.as_str(),
      "/test-data/users/staff/Desktop/P1524180.RW2",
      first.as_str()
    ]
  );
  assert_eq!(remembered.photos[0].added_at_ms, 6_000);

  // ファイルの形（新しい順）
  assert_eq!(
    temp.record(),
    json!({
      "version": 1,
      "folders": [
        { "path": SD, "addedAtMs": 5_000 },
        { "path": "/test-data/users/staff/Pictures/2026", "addedAtMs": 2_000 },
      ],
      "photos": [
        { "path": second, "addedAtMs": 6_000 },
        { "path": "/test-data/users/staff/Desktop/P1524180.RW2", "addedAtMs": 4_000 },
        { "path": first, "addedAtMs": 3_000 },
      ],
    })
  );
  // 次の起動（新しい置き場の値）でも同じものを読む
  assert_eq!(temp.store(RememberedLimits::default()).load(), remembered);
}

#[test]
fn keeps_at_most_the_limits_and_drops_the_oldest() {
  let temp = TempDir::new("limits");
  let store = temp.store(RememberedLimits {
    max_folders: 2,
    max_photos: 3,
  });
  for (index, name) in ["a", "b", "c"].into_iter().enumerate() {
    store
      .remember_folder(&path(&format!("/folders/{name}")), at(index as u64))
      .unwrap();
  }
  assert_eq!(texts(&store.load().folders), ["/folders/c", "/folders/b"]);
  // 上限より多く一度に選んだら、ダイアログの順で先の方を残す
  let batch: Vec<PathBuf> = (1..=5).map(|number| path(&format!("/photos/{number}.jpg"))).collect();
  store.remember_photos(&batch, at(10)).unwrap();
  assert_eq!(
    texts(&store.load().photos),
    ["/photos/1.jpg", "/photos/2.jpg", "/photos/3.jpg"]
  );
  store.remember_photos(&[path("/photos/9.jpg")], at(11)).unwrap();
  assert_eq!(
    texts(&store.load().photos),
    ["/photos/9.jpg", "/photos/1.jpg", "/photos/2.jpg"]
  );
  // 選び直した写真は先頭へ動くだけで、ほかを押し出さない
  store.remember_photos(&[path("/photos/2.jpg")], at(12)).unwrap();
  assert_eq!(
    texts(&store.load().photos),
    ["/photos/2.jpg", "/photos/9.jpg", "/photos/1.jpg"]
  );
  // フォルダを覚えても写真は変わらない（逆も）
  assert_eq!(texts(&store.load().folders), ["/folders/c", "/folders/b"]);
}

#[test]
fn the_default_limits_are_fifty_folders_and_two_thousand_photos() {
  let temp = TempDir::new("default-limits");
  let store = temp.store(RememberedLimits::default());
  for number in 0..(MAX_REMEMBERED_FOLDERS + 3) {
    store
      .remember_folder(
        &path(&format!("/test-data/volumes/SD/DCIM/{number:03}")),
        at(number as u64),
      )
      .unwrap();
  }
  let batch: Vec<PathBuf> = (0..(MAX_REMEMBERED_PHOTOS + 5))
    .map(|number| path(&format!("/test-data/volumes/SD/DCIM/100MSDCF/DSC{number:05}.ARW")))
    .collect();
  store.remember_photos(&batch, at(100)).unwrap();
  let remembered = store.load();
  assert_eq!((MAX_REMEMBERED_FOLDERS, MAX_REMEMBERED_PHOTOS), (50, 2_000));
  assert_eq!(remembered.folders.len(), 50);
  assert_eq!(remembered.folders[0].path, path("/test-data/volumes/SD/DCIM/052"));
  assert_eq!(remembered.folders[49].path, path("/test-data/volumes/SD/DCIM/003"));
  assert_eq!(remembered.photos.len(), 2_000);
  assert_eq!(remembered.photos[1_999].path, batch[1_999]);
  assert!(fs::metadata(temp.file()).unwrap().len() < MAX_REMEMBERED_FILE_BYTES);
}

#[test]
fn the_file_is_private_and_replaced_atomically() {
  let temp = TempDir::new("private");
  let store = temp.store(RememberedLimits::default());
  store.remember_folder(Path::new(SD), at(1)).unwrap();
  let file = temp.file();
  assert_eq!(mode(&file), 0o600);
  assert_eq!(mode(file.parent().unwrap()), 0o700);
  // 前からあった緩いファイル・フォルダも 0600 / 0700 になる
  fs::set_permissions(&file, fs::Permissions::from_mode(0o644)).unwrap();
  fs::set_permissions(file.parent().unwrap(), fs::Permissions::from_mode(0o755)).unwrap();
  store
    .remember_photos(&[path("/test-data/users/staff/a.jpg")], at(2))
    .unwrap();
  assert_eq!(mode(&file), 0o600);
  assert_eq!(mode(file.parent().unwrap()), 0o700);
  // 一時ファイルは残らない
  let names: Vec<String> = fs::read_dir(file.parent().unwrap())
    .unwrap()
    .map(|entry| entry.unwrap().file_name().to_string_lossy().into_owned())
    .collect();
  assert_eq!(names, ["remembered.json"]);
}

#[test]
fn a_failed_write_keeps_the_previous_file() {
  let temp = TempDir::new("failed-write");
  let store = temp.store(RememberedLimits::default());
  store.remember_folder(Path::new(SD), at(1)).unwrap();
  // 一時ファイルの場所をフォルダで塞ぐと書き込みは失敗するが、前の内容は壊れない
  let blocker = temp.file().with_extension("json.tmp");
  fs::create_dir_all(&blocker).unwrap();
  assert!(store
    .remember_folder(Path::new("/test-data/users/staff/Pictures"), at(2))
    .is_err());
  assert!(store
    .remember_photos(&[path("/test-data/users/staff/a.jpg")], at(3))
    .is_err());
  assert_eq!(
    store.load(),
    Remembered {
      folders: vec![entry(SD, 1)],
      photos: vec![]
    }
  );
}

#[test]
fn forgetting_photos_preserves_folders_and_fails_if_the_store_cannot_be_read() {
  let temp = TempDir::new("forget-photos");
  let store = temp.store(RememberedLimits::default());
  assert!(!store.forget_photos().unwrap());
  store.remember_folder(Path::new(SD), at(1)).unwrap();
  store
    .remember_photos(
      &[
        path("/test-data/users/staff/a.jpg"),
        path("/test-data/users/staff/b.nef"),
      ],
      at(2),
    )
    .unwrap();
  assert!(store.forget_photos().unwrap());
  assert_eq!(store.load().folders, [entry(SD, 1)]);
  assert!(store.load().photos.is_empty());
  assert!(!store.forget_photos().unwrap());

  temp.write(b"not json");
  assert!(
    store.forget_photos().is_err(),
    "unknown references must not be reported as forgotten"
  );
  assert_eq!(fs::read(temp.file()).unwrap(), b"not json");

  let blocked = TempDir::new("forget-photos-write-failure");
  let blocked_store = blocked.store(RememberedLimits::default());
  blocked_store
    .remember_photos(&[path("/test-data/users/staff/stays.jpg")], at(3))
    .unwrap();
  fs::create_dir_all(blocked.file().with_extension("json.tmp")).unwrap();
  assert!(blocked_store.forget_photos().is_err());
  assert_eq!(
    blocked_store.load().photos,
    [entry("/test-data/users/staff/stays.jpg", 3)]
  );
}

#[test]
fn broken_unknown_or_too_large_files_are_read_as_empty_and_overwritten() {
  let temp = TempDir::new("broken");
  let store = temp.store(RememberedLimits::default());
  let valid = json!({ "version": 1, "folders": [{ "path": SD, "addedAtMs": 1 }], "photos": [] });
  let mut too_large = serde_json::to_vec(&valid).unwrap();
  too_large.truncate(too_large.len() - 1);
  too_large.extend(format!(",\"padding\":\"{}\"}}", "x".repeat(MAX_REMEMBERED_FILE_BYTES as usize)).as_bytes());
  assert!(serde_json::from_slice::<Value>(&too_large).is_ok());
  for body in [
    b"not json".to_vec(),
    b"[]".to_vec(),
    b"{}".to_vec(),
    br#"{"version":"1","folders":[{"path":"/a","addedAtMs":1}],"photos":[]}"#.to_vec(),
    br#"{"version":2,"folders":[{"path":"/a","addedAtMs":1}],"photos":[]}"#.to_vec(),
    br#"{"version":1,"folders":{"path":"/a","addedAtMs":1},"photos":[]}"#.to_vec(),
    br#"{"version":1,"folders":[{"path":"/a","addedAtMs":1}]}"#.to_vec(),
    br#"{"version":1,"folders":[{"path":"/a","addedAtMs":1}],"photos":null}"#.to_vec(),
    too_large,
  ] {
    temp.write(&body);
    assert_eq!(
      store.load(),
      Remembered::default(),
      "{}",
      String::from_utf8_lossy(&body[..body.len().min(60)])
    );
  }
  // 次に覚えるときに上書きする
  store
    .remember_photos(&[path("/test-data/users/staff/a.jpg")], at(7))
    .unwrap();
  assert_eq!(
    temp.record(),
    json!({ "version": 1, "folders": [], "photos": [{ "path": "/test-data/users/staff/a.jpg", "addedAtMs": 7 }] })
  );

  // フォルダが同じ名前で置かれていても読まない
  fs::remove_file(temp.file()).unwrap();
  fs::create_dir_all(temp.file()).unwrap();
  assert_eq!(store.load(), Remembered::default());
  fs::remove_dir_all(temp.file()).unwrap();

  // シンボリックリンクはたどらず、覚えるときはリンクを置き換える（指す先には書かない）
  let elsewhere = temp.0.join("elsewhere.json");
  fs::write(&elsewhere, serde_json::to_vec(&valid).unwrap()).unwrap();
  symlink(&elsewhere, temp.file()).unwrap();
  assert_eq!(store.load(), Remembered::default());
  store
    .remember_folder(Path::new("/test-data/users/staff/Pictures"), at(8))
    .unwrap();
  assert!(fs::symlink_metadata(temp.file()).unwrap().is_file());
  assert_eq!(
    serde_json::from_slice::<Value>(&fs::read(&elsewhere).unwrap()).unwrap(),
    valid
  );
  assert_eq!(texts(&store.load().folders), ["/test-data/users/staff/Pictures"]);
}

#[test]
fn entries_of_the_wrong_shape_are_skipped() {
  let temp = TempDir::new("entries");
  let store = temp.store(RememberedLimits {
    max_folders: 50,
    max_photos: 2,
  });
  let too_long = format!("/{}", "x".repeat(MAX_PATH_JSON_BYTES));
  temp.write(
    serde_json::to_string(&json!({
      "version": 1,
      "folders": [
        { "path": "/ok/a", "addedAtMs": 3 },
        { "path": "relative/b", "addedAtMs": 2 },
        { "path": "", "addedAtMs": 2 },
        { "path": 1, "addedAtMs": 2 },
        { "path": "/ok/c" },
        { "path": "/ok/d", "addedAtMs": -1 },
        { "path": "/ok/e", "addedAtMs": "1" },
        { "path": "/ok/a", "addedAtMs": 1 },
        "/ok/f",
        { "path": "/with\u{0}nul", "addedAtMs": 1 },
        { "path": too_long, "addedAtMs": 1 },
        { "path": "/ok/g", "addedAtMs": 0 },
      ],
      "photos": [
        { "path": "/ok/1.jpg", "addedAtMs": 9 },
        { "path": "/ok/2.jpg", "addedAtMs": 8 },
        { "path": "/ok/3.jpg", "addedAtMs": 7 },
      ],
      "unknown": true,
    }))
    .unwrap()
    .as_bytes(),
  );
  let remembered = store.load();
  // 同じパスは先のもの、上限を超えたものは読まない
  assert_eq!(remembered.folders, [entry("/ok/a", 3), entry("/ok/g", 0)]);
  assert_eq!(remembered.photos, [entry("/ok/1.jpg", 9), entry("/ok/2.jpg", 8)]);
}

#[test]
fn paths_that_cannot_be_remembered_are_skipped() {
  let temp = TempDir::new("unrememberable");
  let store = temp.store(RememberedLimits::default());
  let not_utf8 = PathBuf::from(OsStr::from_bytes(b"/test-data/volumes/SD/\xff.jpg"));
  let too_long = path(&format!("/{}", "x".repeat(MAX_PATH_JSON_BYTES)));
  // JSON で `"` はエスケープされて長くなる
  let quoted = path(&format!("/{}", "\"".repeat(MAX_PATH_JSON_BYTES / 2)));
  for unrememberable in [
    path("relative/a.jpg"),
    path(""),
    not_utf8.clone(),
    too_long.clone(),
    quoted.clone(),
  ] {
    store.remember_folder(&unrememberable, at(1)).unwrap();
  }
  store
    .remember_photos(&[not_utf8, too_long, quoted, path("relative.jpg")], at(2))
    .unwrap();
  assert!(!temp.file().exists(), "nothing to write");
  // 覚えられるものと一緒なら、それだけを覚える
  let fits = path(&format!("/{}", "x".repeat(MAX_PATH_JSON_BYTES - 3)));
  store
    .remember_photos(
      &[
        path("relative.jpg"),
        fits.clone(),
        path("/test-data/users/staff/\"quoted\".jpg"),
      ],
      at(3),
    )
    .unwrap();
  assert_eq!(
    store.load().photos,
    [
      RememberedEntry {
        path: fits,
        added_at_ms: 3
      },
      entry("/test-data/users/staff/\"quoted\".jpg", 3),
    ]
  );
}

#[test]
fn purging_removes_the_file_the_temp_file_and_a_symlink_but_never_its_target() {
  let temp = TempDir::new("purge");
  let store = temp.store(RememberedLimits::default());
  // 何も無いときは何もしない
  store.purge().unwrap();
  store.remember_folder(Path::new(SD), at(1)).unwrap();
  store
    .remember_photos(&[path("/test-data/users/staff/a.jpg")], at(2))
    .unwrap();
  let file = temp.file();
  // 書き込み途中の一時ファイルが残っていても一緒に消す
  let leftover = file.with_extension("json.tmp");
  fs::write(&leftover, "{}").unwrap();
  assert!(file.exists() && leftover.exists());
  store.purge().unwrap();
  assert!(!file.exists() && !leftover.exists());
  assert_eq!(store.load(), Remembered::default());
  // 消したあとも覚えられる
  store.remember_folder(Path::new(SD), at(3)).unwrap();
  assert_eq!(store.load().folders, vec![entry(SD, 3)]);

  // シンボリックリンクなら、リンク自体だけを消す（指す先は消さない）
  let target = temp.0.join("target.json");
  fs::write(&target, "keep").unwrap();
  fs::remove_file(&file).unwrap();
  symlink(&target, &file).unwrap();
  store.purge().unwrap();
  assert!(fs::symlink_metadata(&file).is_err());
  assert_eq!(fs::read_to_string(&target).unwrap(), "keep");
}

#[test]
fn purging_fails_visibly_when_the_file_cannot_be_removed() {
  let temp = TempDir::new("purge-fails");
  let store = temp.store(RememberedLimits::default());
  // 置き場のパスがフォルダ（remove_file できない）: 黙って成功にしない（残ったままにしない）
  fs::create_dir_all(temp.file()).unwrap();
  assert!(store.purge().is_err());
}
