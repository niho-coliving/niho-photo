//! フォルダの一覧とサムネイルのテスト（NIHO Desktop の `photo_library_tests.rs` のうち、写真を開くエンジン（Photo Bench）と
//! コマンドの引数の確かめを使わないもの。C2 #18390 で移した）。

use super::*;
use crate::capabilities::{validate_photo, CapabilityStage};
use crate::image_info::{detected_ut_type, read_raster_info};
use crate::remembered::{remembered_path, Remembered, RememberedLimits, RememberedStore};
use crate::test_support::library::*;
use crate::test_support::set_modified;
use std::fs;
use std::os::unix::fs::{symlink, PermissionsExt};
use std::sync::atomic::{AtomicUsize, Ordering};

#[cfg(target_os = "macos")]
fn convert_with_sips(source: &Path, format: &str, output: &Path) {
  let status = std::process::Command::new("/usr/bin/sips")
    .args(["-s", "format", format])
    .arg(source)
    .arg("--out")
    .arg(output)
    .status()
    .expect("the public macOS runner provides /usr/bin/sips");
  assert!(status.success(), "unsupported capability: sips cannot encode {format}");
}

#[cfg(target_os = "macos")]
fn make_raster_seed_with_sips(source: &Path, output: &Path) {
  let status = std::process::Command::new("/usr/bin/sips")
    .args(["-z", "24", "32", "-s", "format", "png"])
    .arg(source)
    .arg("--out")
    .arg(output)
    .status()
    .expect("the public macOS runner provides /usr/bin/sips");
  assert!(status.success(), "sips cannot make the synthetic PNG fixture");
}

// --- 走査の規則 ---

#[test]
fn lists_photo_files_by_extension_and_skips_hidden_files_symlinks_and_packages() {
  let fixture = Fixture::new("filter");
  for name in [
    "b.JPG",
    "A.cr3",
    "c.Png",
    "f.RW2",
    "notes.txt",
    "raw",
    ".hidden.jpg",
    "._b.JPG",
  ] {
    fixture.file(name);
  }
  fixture.file(".secret/inside.jpg");
  fixture.file("Sub/y.heic");
  fixture.file("Library.photoslibrary/originals/z.jpg");
  fixture.file("Tool.APP/Contents/w.jpg");
  fixture.file("Catalog.lrdata/p.jpg");
  fixture.file("Plugin.bundle/p.jpg");
  // 選んだフォルダの外を指すシンボリックリンク（ファイルもフォルダも）と、中を指すもの
  let outside = fixture.dir.join("outside");
  fs::create_dir_all(&outside).unwrap();
  fs::write(outside.join("o.jpg"), "o").unwrap();
  symlink(outside.join("o.jpg"), fixture.root().join("link.jpg")).unwrap();
  symlink(&outside, fixture.root().join("LinkedFolder")).unwrap();
  symlink(fixture.root().join("Sub"), fixture.root().join("SubAgain")).unwrap();

  let folder = fixture.library().add_folder(&fixture.root()).unwrap();

  assert_eq!(folder["name"], "root");
  assert_eq!(photo_names(&folder), ["A.cr3", "b.JPG", "c.Png", "f.RW2"]);
  let kinds: Vec<&str> = folder["photos"]
    .as_array()
    .unwrap()
    .iter()
    .map(|photo| photo["kind"].as_str().unwrap())
    .collect();
  assert_eq!(kinds, ["raw", "raster", "raster", "raw"]);
  assert_eq!(child_names(&folder), ["Sub"]);
  assert_eq!(photo_names(child(&folder, "Sub")), ["y.heic"]);
  assert_eq!(child(&folder, "Sub")["photos"][0]["kind"], "raster");
  assert_eq!(folder["truncated"], false);
}

#[test]
fn photo_kind_follows_the_open_dialog_extensions_ignoring_case() {
  for name in ["a.jpg", "a.JPEG", "a.png", "a.TIF", "a.tiff", "a.HEIC", "a.heif"] {
    assert_eq!(photo_kind(name), Some("raster"), "{name}");
  }
  for name in ["a.dng", "a.RW2", "a.cr3", "a.NEF", "a.arw", "a.raf", "a.orf", "a.GPR"] {
    assert_eq!(photo_kind(name), Some("raw"), "{name}");
  }
  for name in ["a.txt", "a.xmp", "a.mov", "jpg", "a.jpg.part", "a."] {
    assert_eq!(photo_kind(name), None, "{name}");
  }
  for name in [
    "Photos Library.photoslibrary",
    "X.APP",
    "Catalog.lrcat",
    "Previews.lrdata",
    "a.Framework",
    "b.bundle",
  ] {
    assert!(is_package(name), "{name}");
  }
  assert!(!is_package("Apps and photos"));
}

#[cfg(target_os = "macos")]
#[test]
fn folder_and_individual_additions_validate_real_imageio_rasters() {
  const PNG_2X2: &[u8] = &[
    0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d, 0x49, 0x48, 0x44, 0x52, 0x00, 0x00, 0x00,
    0x02, 0x00, 0x00, 0x00, 0x02, 0x08, 0x02, 0x00, 0x00, 0x00, 0xfd, 0xd4, 0x9a, 0x73, 0x00, 0x00, 0x00, 0x14, 0x49,
    0x44, 0x41, 0x54, 0x78, 0xda, 0x63, 0xf8, 0xcf, 0xc0, 0xc0, 0xc0, 0xc0, 0xc0, 0xc4, 0xc0, 0xc0, 0xc0, 0xc0, 0xc0,
    0x00, 0x00, 0x0d, 0x1d, 0x01, 0x03, 0x6a, 0xc2, 0x9b, 0xe9, 0x00, 0x00, 0x00, 0x00, 0x49, 0x45, 0x4e, 0x44, 0xae,
    0x42, 0x60, 0x82,
  ];

  let fixture = Fixture::new("real-imageio-raster");
  let seed = fixture.dir.join("seed.png");
  fs::write(&seed, PNG_2X2).unwrap();
  let png = fixture.root().join("actual.PnG");
  make_raster_seed_with_sips(&seed, &png);
  let jpeg = fixture.root().join("actual.JpEg");
  let tiff = fixture.root().join("actual.TiFf");
  let heic = fixture.root().join("actual.HeIc");
  convert_with_sips(&png, "jpeg", &jpeg);
  convert_with_sips(&png, "tiff", &tiff);
  convert_with_sips(&png, "heic", &heic);

  let actual = [&png, &jpeg, &tiff, &heic];
  let library = fixture.library();
  let folder = library.add_folder(&fixture.root()).unwrap();
  let individually_added = library.add_photos(&actual.iter().map(|path| (*path).clone()).collect::<Vec<_>>());
  assert_eq!(folder["photos"].as_array().unwrap().len(), actual.len());
  assert_eq!(individually_added.len(), actual.len());

  for path in actual {
    let capability = validate_photo(path, CapabilityStage::Decoder).unwrap();
    let detected = detected_ut_type(path).expect("ImageIO reports the type from actual bytes");
    assert!(capability
      .ut_types
      .iter()
      .any(|expected| expected.eq_ignore_ascii_case(&detected)));
    assert_eq!(read_raster_info(path).unwrap().display_dimensions(), Some((32, 24)));
  }

  let disguised = fixture.root().join("png-as-jpeg.JpG");
  fs::write(&disguised, PNG_2X2).unwrap();
  assert_eq!(
    validate_photo(&disguised, CapabilityStage::Decoder).unwrap_err().code,
    code::FORMAT_MISMATCH
  );
  assert_eq!(detected_ut_type(&disguised).as_deref(), Some("public.png"));

  let corrupt = fixture.root().join("corrupt.TiFf");
  fs::write(&corrupt, b"II").unwrap();
  assert_eq!(
    validate_photo(&corrupt, CapabilityStage::Decoder).unwrap_err().code,
    code::FORMAT_MISMATCH
  );
  assert!(read_raster_info(&corrupt).is_err());
}

#[test]
fn photos_and_folders_are_ordered_by_name_ignoring_case() {
  let fixture = Fixture::new("order");
  for name in ["img_2.jpg", "IMG_10.jpg", "Img_1.JPG", "b.jpg", "A.jpg"] {
    fixture.file(name);
  }
  for name in ["beta/x.jpg", "Alpha/x.jpg", "gamma/x.jpg"] {
    fixture.file(name);
  }
  let folder = fixture.library().add_folder(&fixture.root()).unwrap();
  assert_eq!(
    photo_names(&folder),
    ["A.jpg", "b.jpg", "Img_1.JPG", "IMG_10.jpg", "img_2.jpg"]
  );
  assert_eq!(child_names(&folder), ["Alpha", "beta", "gamma"]);
}

#[test]
fn stops_below_the_depth_limit_and_marks_the_branch_truncated() {
  let fixture = Fixture::new("depth");
  for name in [
    "top.jpg",
    "d1/one.jpg",
    "d1/d2/two.jpg",
    "d1/d2/d3/three.jpg",
    "e1/e.jpg",
  ] {
    fixture.file(name);
  }
  let folder = fixture
    .library_with(limits(2, MAX_LISTED_PHOTOS, MAX_LISTED_FOLDERS), failing_maker())
    .add_folder(&fixture.root())
    .unwrap();

  let d1 = child(&folder, "d1");
  let d2 = child(d1, "d2");
  assert_eq!(photo_names(d2), ["two.jpg"]);
  assert!(
    child_names(d2).is_empty(),
    "the folder at the depth limit does not list its subfolders"
  );
  assert_eq!(d2["truncated"], true);
  assert_eq!(d1["truncated"], true);
  assert_eq!(
    folder["truncated"], true,
    "the root tells the page that something was left out"
  );
  // ほかの枝は続けて読む
  assert_eq!(photo_names(child(&folder, "e1")), ["e.jpg"]);
  assert_eq!(child(&folder, "e1")["truncated"], false);
}

#[test]
fn the_default_depth_limit_is_eight_below_the_chosen_folder() {
  let fixture = Fixture::new("depth-default");
  fixture.file("l1/l2/l3/l4/l5/l6/l7/l8/p8.jpg");
  fixture.file("l1/l2/l3/l4/l5/l6/l7/l8/l9/p9.jpg");
  let folder = fixture.library().add_folder(&fixture.root()).unwrap();
  let mut node = &folder;
  for depth in 1..=8 {
    node = child(node, &format!("l{depth}"));
  }
  assert_eq!(photo_names(node), ["p8.jpg"]);
  assert!(child_names(node).is_empty());
  assert_eq!(node["truncated"], true);
  assert_eq!(folder["truncated"], true);
}

#[test]
fn stops_at_the_photo_limit_and_marks_the_folder_and_the_root_truncated() {
  let fixture = Fixture::new("photo-limit");
  for name in ["a.jpg", "b.jpg", "A/c.jpg", "A/d.jpg", "B/e.jpg"] {
    fixture.file(name);
  }
  let folder = fixture
    .library_with(limits(MAX_SCAN_DEPTH, 3, MAX_LISTED_FOLDERS), failing_maker())
    .add_folder(&fixture.root())
    .unwrap();
  assert_eq!(photo_names(&folder), ["a.jpg", "b.jpg"]);
  let a = child(&folder, "A");
  assert_eq!(photo_names(a), ["c.jpg"]);
  assert_eq!(a["truncated"], true);
  assert_eq!(child_names(&folder), ["A"], "nothing is read after the limit");
  assert_eq!(folder["truncated"], true);
  assert!(fixture.has_log("photo_editing.folder_listed"));

  // ちょうど上限なら止めない（写真の無いフォルダも出す）
  fs::create_dir_all(fixture.root().join("C")).unwrap();
  let exact = fixture
    .library_with(limits(MAX_SCAN_DEPTH, 5, MAX_LISTED_FOLDERS), failing_maker())
    .add_folder(&fixture.root())
    .unwrap();
  assert_eq!(exact["truncated"], false);
  assert_eq!(child_names(&exact), ["A", "B", "C"]);
  assert_eq!(photo_names(child(&exact, "B")), ["e.jpg"]);
}

#[test]
fn the_default_photo_limit_is_five_thousand() {
  let fixture = Fixture::new("photo-limit-default");
  for index in 0..=MAX_LISTED_PHOTOS {
    fs::write(fixture.root().join(format!("p{index:05}.jpg")), b"x").unwrap();
  }
  let folder = fixture.library().add_folder(&fixture.root()).unwrap();
  assert_eq!(folder["photos"].as_array().unwrap().len(), MAX_LISTED_PHOTOS);
  assert_eq!(folder["truncated"], true);
}

#[test]
fn stops_at_the_folder_limit() {
  let fixture = Fixture::new("folder-limit");
  for name in ["A/a.jpg", "B/b.jpg", "C/c.jpg"] {
    fixture.file(name);
  }
  let folder = fixture
    .library_with(limits(MAX_SCAN_DEPTH, MAX_LISTED_PHOTOS, 2), failing_maker())
    .add_folder(&fixture.root())
    .unwrap();
  assert_eq!(child_names(&folder), ["A"]);
  assert_eq!(folder["truncated"], true);
}

#[test]
fn unreadable_subfolders_are_skipped_and_an_unreadable_root_is_not_found() {
  let fixture = Fixture::new("unreadable");
  fixture.file("ok/a.jpg");
  fixture.file("Locked/secret.jpg");
  let locked = fixture.root().join("Locked");
  fs::set_permissions(&locked, fs::Permissions::from_mode(0o000)).unwrap();
  let blocked = fs::read_dir(&locked).is_err();
  let folder = fixture.library().add_folder(&fixture.root());
  fs::set_permissions(&locked, fs::Permissions::from_mode(0o755)).unwrap();
  let folder = folder.unwrap();
  if blocked {
    // root で走るときは権限で読めなくならないので確かめない
    assert_eq!(child_names(&folder), ["ok"]);
  }

  let library = fixture.library();
  for missing in [fixture.dir.join("nope"), fixture.file("plain.jpg")] {
    let err = library.add_folder(&missing).unwrap_err();
    assert_eq!(err.code, "notFound");
    assert_eq!(err.message, FOLDER_UNREADABLE_MESSAGE);
  }
}

// --- ID・形・パスを返さない ---

#[test]
fn the_same_folder_and_file_keep_their_ids() {
  let fixture = Fixture::new("ids");
  fixture.file("a.jpg");
  fixture.file("Sub/b.jpg");
  let library = fixture.library();
  let first = library.add_folder(&fixture.root()).unwrap();
  let again = library.add_folder(&fixture.root()).unwrap();
  let folder_id = first["folderId"].as_str().unwrap().to_string();
  assert!(folder_id.starts_with("folder-"), "{folder_id}");
  assert!(entry_id(&first, "a.jpg").starts_with("entry-"));
  assert_eq!(again["folderId"], first["folderId"]);
  assert_eq!(entry_id(&again, "a.jpg"), entry_id(&first, "a.jpg"));
  let sub_id = child(&first, "Sub")["folderId"].as_str().unwrap().to_string();
  assert_ne!(sub_id, folder_id);
  assert_eq!(child(&again, "Sub")["folderId"], sub_id.as_str());

  // 読み直し: 増えた写真だけ新しい ID、消えた写真は出ない
  fixture.file("c.jpg");
  fs::remove_file(fixture.root().join("Sub/b.jpg")).unwrap();
  let listed = library.list_folder(&folder_id).unwrap();
  assert_eq!(listed["folderId"], folder_id.as_str());
  assert_eq!(photo_names(&listed), ["a.jpg", "c.jpg"]);
  assert_eq!(entry_id(&listed, "a.jpg"), entry_id(&first, "a.jpg"));
  assert_ne!(entry_id(&listed, "c.jpg"), entry_id(&first, "a.jpg"));
  assert!(photo_names(child(&listed, "Sub")).is_empty());

  // サブフォルダの ID でも読み直せる（同じ ID のまま）
  fixture.file("Sub/d.jpg");
  let sub = library.list_folder(&sub_id).unwrap();
  assert_eq!(sub["folderId"], sub_id.as_str());
  assert_eq!(sub["name"], "Sub");
  assert_eq!(photo_names(&sub), ["d.jpg"]);
  assert_eq!(
    entry_id(&sub, "d.jpg"),
    entry_id(&library.list_folder(&folder_id).unwrap()["children"][0], "d.jpg")
  );

  // ID はパスから作らない（別のアプリの起動では別の ID）
  let other = fixture.library().add_folder(&fixture.root()).unwrap();
  assert_ne!(other["folderId"], first["folderId"]);
  assert_ne!(entry_id(&other, "a.jpg"), entry_id(&first, "a.jpg"));
}

#[test]
fn page_values_have_the_agreed_shape_and_never_contain_a_path() {
  let fixture = Fixture::new("shape");
  let photo = fixture.file("2026/09/24/P1524180.RW2");
  fixture.file("2026/09/24/DSC02072.JPG");
  set_modified(&photo, UNIX_EPOCH + Duration::from_millis(1_790_235_553_250));
  let folder = fixture.library().add_folder(&fixture.root()).unwrap();

  let mut folder_keys: Vec<&String> = folder.as_object().unwrap().keys().collect();
  folder_keys.sort();
  assert_eq!(folder_keys, ["children", "folderId", "name", "photos", "truncated"]);
  let day = child(child(child(&folder, "2026"), "09"), "24");
  assert_eq!(day["name"], "24");
  let raw = day["photos"]
    .as_array()
    .unwrap()
    .iter()
    .find(|photo| photo["fileName"] == "P1524180.RW2")
    .unwrap();
  let mut entry_keys: Vec<&String> = raw.as_object().unwrap().keys().collect();
  entry_keys.sort();
  assert_eq!(entry_keys, ["entryId", "fileName", "kind", "modifiedAt", "sizeBytes"]);
  assert_eq!(raw["kind"], "raw");
  assert_eq!(raw["sizeBytes"], "photo 2026/09/24/P1524180.RW2".len());
  assert_eq!(raw["modifiedAt"], "2026-09-24T07:39:13.250Z");
  assert_no_path(&folder);
}

#[test]
fn modified_times_are_iso_8601_in_utc() {
  let at = |millis: u64| iso8601_utc(UNIX_EPOCH + Duration::from_millis(millis));
  assert_eq!(at(0), "1970-01-01T00:00:00.000Z");
  assert_eq!(at(951_782_400_000), "2000-02-29T00:00:00.000Z");
  assert_eq!(at(1_790_235_553_250), "2026-09-24T07:39:13.250Z");
  assert_eq!(at(4_107_542_399_999), "2100-02-28T23:59:59.999Z");
  // 1970 年より前は 1970 年にする
  assert_eq!(
    iso8601_utc(UNIX_EPOCH - Duration::from_secs(1)),
    "1970-01-01T00:00:00.000Z"
  );
}

// --- サムネイル ---

#[test]
fn thumbnails_are_cached_by_path_size_modified_time_and_dimension() {
  let fixture = Fixture::new("thumbnail-cache");
  let path = fixture.file("a.jpg");
  let calls = Arc::new(AtomicUsize::new(0));
  let library = fixture.library_with(ScanLimits::default(), png_maker(calls.clone()));
  let folder = library.add_folder(&fixture.root()).unwrap();
  let entry = entry_id(&folder, "a.jpg");

  let first = library.thumbnail(&entry, 128).unwrap();
  assert!(first.starts_with(&PNG_SIGNATURE));
  assert_eq!(calls.load(Ordering::SeqCst), 1);
  assert_eq!(
    library.thumbnail(&entry, 128).unwrap(),
    first,
    "the cache answers the second time"
  );
  assert_eq!(calls.load(Ordering::SeqCst), 1);

  // キャッシュのファイル（パス・大きさ・更新時刻・長辺の SHA-256。0600）。一時フォルダは残らない
  let canonical = fs::canonicalize(&path).unwrap();
  let metadata = fs::metadata(&canonical).unwrap();
  let key = thumbnail_key(&canonical, metadata.len(), modified_nanos(&metadata), 128);
  let cached = fixture.thumbnail_dir().join(format!("{key}.png"));
  assert_eq!(fs::read(&cached).unwrap(), first);
  assert_eq!(fs::metadata(&cached).unwrap().permissions().mode() & 0o777, 0o600);
  assert_eq!(
    fs::metadata(fixture.thumbnail_dir()).unwrap().permissions().mode() & 0o777,
    0o700
  );
  assert!(fixture.work_dirs().is_empty(), "{:?}", fixture.work_dirs());

  // 長辺が違えば別のサムネイル
  assert_ne!(library.thumbnail(&entry, 64).unwrap(), first);
  assert_eq!(calls.load(Ordering::SeqCst), 2);
  // 中身（大きさ）が変わった
  fs::write(&path, b"\xff\xd8\xffrewritten by another app").unwrap();
  library.thumbnail(&entry, 128).unwrap();
  assert_eq!(calls.load(Ordering::SeqCst), 3);
  // 大きさは同じで更新時刻だけ変わった
  set_modified(&path, UNIX_EPOCH + Duration::from_secs(1_000_000));
  library.thumbnail(&entry, 128).unwrap();
  assert_eq!(calls.load(Ordering::SeqCst), 4);
  library.thumbnail(&entry, 128).unwrap();
  assert_eq!(calls.load(Ordering::SeqCst), 4);

  // 壊れたキャッシュは消して作り直す
  let metadata = fs::metadata(&canonical).unwrap();
  let key = thumbnail_key(&canonical, metadata.len(), modified_nanos(&metadata), 128);
  fs::write(fixture.thumbnail_dir().join(format!("{key}.png")), b"junk").unwrap();
  assert!(library.thumbnail(&entry, 128).unwrap().starts_with(&PNG_SIGNATURE));
  assert_eq!(calls.load(Ordering::SeqCst), 5);
}

#[test]
fn jpeg_thumbnails_are_cached_as_jpg() {
  let fixture = Fixture::new("thumbnail-jpeg");
  fixture.file("a.RW2");
  let calls = Arc::new(AtomicUsize::new(0));
  let jpeg = b"\xff\xd8\xff\xe0fake jpeg\xff\xd9".to_vec();
  let library = fixture.library_with(ScanLimits::default(), writing_maker(calls.clone(), jpeg.clone()));
  let entry = entry_id(&library.add_folder(&fixture.root()).unwrap(), "a.RW2");
  assert_eq!(library.thumbnail(&entry, 256).unwrap(), jpeg);
  assert_eq!(library.thumbnail(&entry, 256).unwrap(), jpeg);
  assert_eq!(calls.load(Ordering::SeqCst), 1);
  let names: Vec<String> = fs::read_dir(fixture.thumbnail_dir())
    .unwrap()
    .flatten()
    .map(|entry| entry.file_name().to_string_lossy().into_owned())
    .collect();
  assert_eq!(names.len(), 1);
  assert!(
    names[0].ends_with(".jpg") && is_thumbnail_file_name(&names[0]),
    "{names:?}"
  );
}

#[test]
fn thumbnail_failures_have_desktop_codes_and_are_not_cached() {
  let fixture = Fixture::new("thumbnail-failures");
  let path = fixture.file("a.jpg");
  let cases: Vec<(ThumbnailMaker, &str, &str)> = vec![
    (failing_maker(), "decodeFailed", THUMBNAIL_FAILED_MESSAGE),
    (
      Arc::new(|_job: &ThumbnailJob| Err(MakeFailure::TimedOut)),
      "internal",
      THUMBNAIL_TIMEOUT_MESSAGE,
    ),
    (
      writing_maker(Arc::new(AtomicUsize::new(0)), b"not an image".to_vec()),
      "decodeFailed",
      THUMBNAIL_FAILED_MESSAGE,
    ),
    (
      writing_maker(Arc::new(AtomicUsize::new(0)), Vec::new()),
      "decodeFailed",
      THUMBNAIL_FAILED_MESSAGE,
    ),
  ];
  for (maker, code, message) in cases {
    let library = fixture.library_with(ScanLimits::default(), maker);
    let entry = entry_id(&library.add_folder(&fixture.root()).unwrap(), "a.jpg");
    let err = library.thumbnail(&entry, 128).unwrap_err();
    assert_eq!((err.code.as_str(), err.message.as_str()), (code, message));
    assert!(fixture.work_dirs().is_empty(), "{:?}", fixture.work_dirs());
    let cached = fs::read_dir(fixture.thumbnail_dir())
      .map(|entries| entries.count())
      .unwrap_or(0);
    assert_eq!(cached, 0, "a failure is not cached");
  }
  assert!(fixture.has_log("photo_editing.thumbnail_failed"));
  assert!(fixture.has_log("\"reason\":\"timeout\""));
  assert!(
    !fixture.logs.lock().unwrap().iter().any(|line| line.contains("a.jpg")),
    "logs never name the photo"
  );

  // 知らない entryId・消えたファイル・シンボリックリンクに置き換わったファイルは notFound
  let calls = Arc::new(AtomicUsize::new(0));
  let library = fixture.library_with(ScanLimits::default(), png_maker(calls.clone()));
  let entry = entry_id(&library.add_folder(&fixture.root()).unwrap(), "a.jpg");
  let err = library.thumbnail("entry-1-unknown", 128).unwrap_err();
  assert_eq!(
    (err.code.as_str(), err.message.as_str()),
    ("notFound", LISTED_PHOTO_NOT_FOUND_MESSAGE)
  );
  fs::remove_file(&path).unwrap();
  assert_eq!(library.thumbnail(&entry, 128).unwrap_err().code, "notFound");
  fs::write(fixture.dir.join("elsewhere.jpg"), "elsewhere").unwrap();
  symlink(fixture.dir.join("elsewhere.jpg"), &path).unwrap();
  assert_eq!(library.thumbnail(&entry, 128).unwrap_err().code, "notFound");
  assert_eq!(calls.load(Ordering::SeqCst), 0);

  // キャッシュのフォルダが分からない
  fs::remove_file(&path).unwrap();
  fixture.file("a.jpg");
  let library = fixture.library_config(
    ScanLimits::default(),
    png_maker(calls.clone()),
    THUMBNAIL_CACHE_MAX_BYTES,
    None,
  );
  let entry = entry_id(&library.add_folder(&fixture.root()).unwrap(), "a.jpg");
  assert_eq!(library.thumbnail(&entry, 128).unwrap_err().code, "internal");
}

#[test]
fn the_thumbnail_cache_removes_the_least_recently_used_over_its_limit() {
  let fixture = Fixture::new("thumbnail-sweep");
  let dir = fixture.thumbnail_dir();
  fs::create_dir_all(&dir).unwrap();
  let now = SystemTime::now();
  let key = |n: u8| format!("{:064x}", n);
  let write = |name: &str, len: usize, age_secs: u64| {
    let path = dir.join(name);
    fs::write(&path, vec![b'x'; len]).unwrap();
    set_modified(&path, now - Duration::from_secs(age_secs));
    path
  };
  let oldest = write(&format!("{}.png", key(1)), 40, 30);
  let middle = write(&format!("{}.jpg", key(2)), 40, 20);
  let newest = write(&format!("{}.png", key(3)), 40, 10);
  let other = write("notes.txt", 500, 100);
  // キャッシュの形の名前のシンボリックリンク（外の大きなファイル）には触れない
  fs::write(fixture.dir.join("big"), vec![b'x'; 500]).unwrap();
  symlink(fixture.dir.join("big"), dir.join(format!("{}.png", key(4)))).unwrap();
  // 1 時間より古い一時フォルダは消し、新しいものは残す
  let old_work = dir.join("work-old");
  fs::create_dir_all(&old_work).unwrap();
  fs::write(old_work.join("left.png"), b"left").unwrap();
  fs::File::open(&old_work)
    .unwrap()
    .set_modified(now - Duration::from_secs(2 * 60 * 60))
    .unwrap();
  let fresh_work = dir.join("work-fresh");
  fs::create_dir_all(&fresh_work).unwrap();

  let cache = ThumbnailCache::new(dir.clone(), 100);
  let swept = cache.sweep(now);
  assert_eq!(
    swept,
    ThumbnailSweep {
      removed: 1,
      removed_bytes: 40,
      total_bytes: 80
    }
  );
  assert!(!oldest.exists());
  assert!(middle.exists() && newest.exists() && other.exists());
  assert!(dir.join(format!("{}.png", key(4))).symlink_metadata().is_ok());
  assert!(fixture.dir.join("big").exists());
  assert!(!old_work.exists());
  assert!(fresh_work.exists());

  // 上限以下なら何も消さない
  assert_eq!(
    cache.sweep(now),
    ThumbnailSweep {
      removed: 0,
      removed_bytes: 0,
      total_bytes: 80
    }
  );
}

#[test]
fn storing_a_thumbnail_sweeps_when_the_cache_grows_past_its_limit() {
  let fixture = Fixture::new("thumbnail-store-sweep");
  for name in ["a.jpg", "b.jpg", "c.jpg"] {
    fixture.file(name);
  }
  let calls = Arc::new(AtomicUsize::new(0));
  // 1 枚 40 バイトで、2 枚までは上限（100 バイト）に収まる
  let library = fixture.library_config(
    ScanLimits::default(),
    writing_maker(calls.clone(), [PNG_SIGNATURE.to_vec(), vec![b'x'; 32]].concat()),
    100,
    Some(fixture.thumbnail_dir()),
  );
  let folder = library.add_folder(&fixture.root()).unwrap();
  let cache_files = || -> Vec<PathBuf> {
    let mut files: Vec<PathBuf> = fs::read_dir(fixture.thumbnail_dir())
      .unwrap()
      .flatten()
      .map(|entry| entry.path())
      .filter(|path| path.extension().is_some_and(|extension| extension == "png"))
      .collect();
    files.sort();
    files
  };
  let now = SystemTime::now();
  library.thumbnail(&entry_id(&folder, "a.jpg"), 128).unwrap();
  let a = cache_files();
  set_modified(&a[0], now - Duration::from_secs(20));
  library.thumbnail(&entry_id(&folder, "b.jpg"), 128).unwrap();
  let b: Vec<PathBuf> = cache_files().into_iter().filter(|path| !a.contains(path)).collect();
  set_modified(&b[0], now - Duration::from_secs(10));
  assert_eq!(cache_files().len(), 2);
  assert!(!fixture.has_log("thumbnail_cache_swept"));

  library.thumbnail(&entry_id(&folder, "c.jpg"), 128).unwrap();
  let remaining = cache_files();
  assert_eq!(remaining.len(), 2);
  assert!(
    !remaining.contains(&a[0]),
    "the least recently used thumbnail is removed"
  );
  assert!(remaining.contains(&b[0]));
  assert!(fixture.has_log("photo_editing.thumbnail_cache_swept"));
  // 消えたサムネイルはもう一度作る
  library.thumbnail(&entry_id(&folder, "a.jpg"), 128).unwrap();
  assert_eq!(calls.load(Ordering::SeqCst), 4);
}

#[test]
fn at_most_two_thumbnails_are_made_at_once() {
  let fixture = Fixture::new("thumbnail-concurrency");
  let names: Vec<String> = (0..6).map(|index| format!("p{index}.jpg")).collect();
  for name in &names {
    fixture.file(name);
  }
  let running = Arc::new(AtomicUsize::new(0));
  let peak = Arc::new(AtomicUsize::new(0));
  let made = Arc::new(AtomicUsize::new(0));
  let maker: ThumbnailMaker = {
    let (running, peak, made) = (running.clone(), peak.clone(), made.clone());
    Arc::new(move |job: &ThumbnailJob| {
      let now_running = running.fetch_add(1, Ordering::SeqCst) + 1;
      peak.fetch_max(now_running, Ordering::SeqCst);
      std::thread::sleep(Duration::from_millis(60));
      running.fetch_sub(1, Ordering::SeqCst);
      made.fetch_add(1, Ordering::SeqCst);
      let path = job.work_dir.join("made.png");
      fs::write(&path, PNG_SIGNATURE).unwrap();
      Ok(path)
    })
  };
  let library = fixture.library_with(ScanLimits::default(), maker);
  let folder = library.add_folder(&fixture.root()).unwrap();
  let handles: Vec<_> = names
    .iter()
    .map(|name| {
      let (library, entry) = (library.clone(), entry_id(&folder, name));
      std::thread::spawn(move || library.thumbnail(&entry, 128).unwrap())
    })
    .collect();
  for handle in handles {
    handle.join().unwrap();
  }
  assert_eq!(made.load(Ordering::SeqCst), 6);
  assert_eq!(peak.load(Ordering::SeqCst), MAX_THUMBNAIL_JOBS);
}

#[test]
fn quicklook_and_sips_are_called_with_the_expected_arguments() {
  let source = Path::new("/test-data/users/staff/Pictures/IMG 0001.CR3");
  let work_dir = Path::new("/cache/photo-thumbnails/work-1");
  let quicklook: Vec<OsString> = [
    "-t",
    "-s",
    "128",
    "-o",
    "/cache/photo-thumbnails/work-1",
    "/test-data/users/staff/Pictures/IMG 0001.CR3",
  ]
  .iter()
  .map(OsString::from)
  .collect();
  assert_eq!(quicklook_args(source, 128, work_dir), quicklook);
  let sips: Vec<OsString> = [
    "-Z",
    "256",
    "-s",
    "format",
    "jpeg",
    "/test-data/users/staff/Pictures/IMG 0001.CR3",
    "--out",
    "/cache/photo-thumbnails/work-1/thumbnail.jpg",
  ]
  .iter()
  .map(OsString::from)
  .collect();
  assert_eq!(sips_args(source, 256, &work_dir.join(SIPS_OUTPUT_NAME)), sips);
  assert_eq!(ThumbnailFormat::sniff(&PNG_SIGNATURE), Some(ThumbnailFormat::Png));
  assert_eq!(ThumbnailFormat::sniff(b"\xff\xd8\xff\xdb"), Some(ThumbnailFormat::Jpeg));
  assert_eq!(ThumbnailFormat::sniff(b"GIF89a"), None);
}

#[test]
fn run_tool_stops_a_process_that_passes_its_deadline() {
  let started = Instant::now();
  let sleep: Vec<OsString> = vec!["-c".into(), "exec sleep 5".into()];
  let outcome = run_tool(
    Path::new("/bin/sh"),
    &sleep,
    Instant::now() + Duration::from_millis(100),
  )
  .unwrap();
  assert_eq!(outcome, ToolExit::TimedOut);
  assert!(started.elapsed() < Duration::from_secs(3), "{:?}", started.elapsed());
  let far = Instant::now() + Duration::from_secs(10);
  assert_eq!(
    run_tool(Path::new("/bin/sh"), &["-c".into(), "exit 0".into()], far).unwrap(),
    ToolExit::Exited(true)
  );
  assert_eq!(
    run_tool(Path::new("/bin/sh"), &["-c".into(), "exit 13".into()], far).unwrap(),
    ToolExit::Exited(false)
  );
  assert!(run_tool(Path::new("/nonexistent/qlmanage"), &[], far).is_err());
}

// --- 覚えて次回も出す（#16578） ---

fn folder_names(remembered: &Value) -> Vec<String> {
  remembered["folders"]
    .as_array()
    .unwrap()
    .iter()
    .map(|folder| folder["name"].as_str().unwrap().to_string())
    .collect()
}

fn sorted_keys(value: &Value) -> Vec<String> {
  let mut keys: Vec<String> = value.as_object().unwrap().keys().cloned().collect();
  keys.sort();
  keys
}

#[test]
fn added_folders_come_back_in_the_next_launch_and_missing_ones_are_skipped_without_forgetting() {
  let fixture = Fixture::new("remembered-folders");
  fixture.file("SD/DCIM/100MSDCF/DSC00001.JPG");
  fixture.file("SD/DCIM/100MSDCF/DSC00002.ARW");
  fixture.file("Pictures/2026/P1524180.RW2");
  let sd = fixture.root().join("SD/DCIM");
  let pictures = fixture.root().join("Pictures");
  let first_launch = fixture.library();
  let added = first_launch.add_folder(&sd).unwrap();
  first_launch.add_folder(&pictures).unwrap();
  // 読めなかったフォルダは覚えない
  assert!(first_launch.add_folder(&fixture.root().join("missing")).is_err());
  assert_eq!(fixture.remembered_store().load().folders.len(), 2);

  // 次の起動: 覚えたフォルダを新しい順に、「フォルダを追加」と同じ木で返す
  let library = fixture.library();
  let remembered = library.remembered();
  assert_eq!(sorted_keys(&remembered), ["folders", "photos"]);
  assert_eq!(folder_names(&remembered), ["Pictures", "DCIM"]);
  assert_eq!(remembered["photos"], json!([]));
  let dcim = &remembered["folders"][1];
  assert_eq!(sorted_keys(dcim), sorted_keys(&added));
  assert_eq!(dcim["truncated"], false);
  assert_eq!(photo_names(child(dcim, "100MSDCF")), ["DSC00001.JPG", "DSC00002.ARW"]);
  assert_eq!(photo_names(child(&remembered["folders"][0], "2026")), ["P1524180.RW2"]);
  assert_no_path(&remembered);
  // ID はこの起動のもの（前の起動の ID とは別で、読み直し・サムネイル・開くに使える）
  let dcim_id = dcim["folderId"].as_str().unwrap().to_string();
  assert_ne!(added["folderId"], dcim_id.as_str());
  assert_eq!(library.list_folder(&dcim_id).unwrap()["folderId"], dcim_id.as_str());
  assert!(library
    .entry_path(&entry_id(child(dcim, "100MSDCF"), "DSC00001.JPG"))
    .is_some());
  assert!(fixture.has_log("photo_editing.remembered_listed"));
  assert!(fixture.has_log(r#""rememberedFolders":2"#) && fixture.has_log(r#""foundFolders":2"#));

  // SD カードを抜いた（フォルダが無い）: 黙って出さない。覚えたまま
  let ejected = fixture.dir.join("ejected");
  fs::rename(fixture.root().join("SD"), &ejected).unwrap();
  assert_eq!(folder_names(&library.remembered()), ["Pictures"]);
  assert!(fixture.has_log(r#""foundFolders":1"#));
  assert_eq!(fixture.remembered_store().load().folders.len(), 2);
  // 戻すとまた出る（同じ起動なら同じ folderId）
  fs::rename(&ejected, fixture.root().join("SD")).unwrap();
  let back = library.remembered();
  assert_eq!(folder_names(&back), ["Pictures", "DCIM"]);
  assert_eq!(back["folders"][1]["folderId"], dcim_id.as_str());

  // 読めないフォルダ（権限）も黙って飛ばす
  fs::set_permissions(&pictures, fs::Permissions::from_mode(0o000)).unwrap();
  let blocked = fs::read_dir(&pictures).is_err();
  let locked = library.remembered();
  fs::set_permissions(&pictures, fs::Permissions::from_mode(0o755)).unwrap();
  if blocked {
    // root で走るときは権限で読めなくならないので確かめない
    assert_eq!(folder_names(&locked), ["DCIM"]);
  }
  // シンボリックリンクに置き換わったフォルダも出さない（覚えたまま）
  let moved = fixture.dir.join("moved");
  fs::rename(&sd, &moved).unwrap();
  symlink(&moved, &sd).unwrap();
  assert_eq!(folder_names(&library.remembered()), ["Pictures"]);
  assert_eq!(fixture.remembered_store().load().folders.len(), 2);
  // ログにパスを書かない
  assert!(!fixture
    .logs
    .lock()
    .unwrap()
    .iter()
    .any(|line| line.contains("niho-photo-library-test")));
}

#[test]
fn remembered_photos_are_listed_newest_first_and_missing_ones_are_skipped_without_forgetting() {
  let fixture = Fixture::new("remembered-photos");
  let first = fixture.file("SD/DCIM/100MSDCF/DSC00001.JPG");
  let second = fixture.file("SD/DCIM/100MSDCF/DSC00002.ARW");
  let desktop = fixture.file("Desktop/P1524180.RW2");
  let first_launch = fixture.library();
  first_launch.add_photos(&[first.clone(), second.clone()]);
  first_launch.add_photos(std::slice::from_ref(&desktop));

  // 次の起動: 覚えた写真を新しい順に、一覧の写真で返す（フォルダは足していない）
  let library = fixture.library();
  let remembered = library.remembered();
  assert_eq!(remembered["folders"], json!([]));
  assert_eq!(
    photo_names(&remembered),
    ["P1524180.RW2", "DSC00001.JPG", "DSC00002.ARW"]
  );
  for photo in remembered["photos"].as_array().unwrap() {
    assert_eq!(
      sorted_keys(photo),
      ["entryId", "fileName", "kind", "modifiedAt", "sizeBytes"]
    );
  }
  assert_no_path(&remembered);

  // SD カードを抜いた: 黙って出さない。覚えたまま
  let ejected = fixture.dir.join("ejected");
  fs::rename(fixture.root().join("SD"), &ejected).unwrap();
  assert_eq!(photo_names(&library.remembered()), ["P1524180.RW2"]);
  assert_eq!(fixture.remembered_store().load().photos.len(), 3);
  // 戻すとまた出る（同じ起動なら同じ entryId）
  fs::rename(&ejected, fixture.root().join("SD")).unwrap();
  assert_eq!(library.remembered()["photos"], remembered["photos"]);

  // 消した写真・シンボリックリンクに置き換わった写真も出さない（覚えたまま）
  fs::remove_file(&second).unwrap();
  fs::remove_file(&desktop).unwrap();
  symlink(&first, &desktop).unwrap();
  assert_eq!(photo_names(&library.remembered()), ["DSC00001.JPG"]);
  assert!(fixture.has_log(r#""rememberedPhotos":3"#) && fixture.has_log(r#""foundPhotos":1"#));
  assert_eq!(fixture.remembered_store().load().photos.len(), 3);
}

#[test]
fn add_photos_returns_folder_list_entries_without_paths_and_remembers_them() {
  let fixture = Fixture::new("add-photos");
  let raw = fixture.file("2026/09/24/P1524180.RW2");
  let jpeg = fixture.file("2026/09/24/DSC02072.JPG");
  set_modified(&raw, UNIX_EPOCH + Duration::from_millis(1_790_235_553_250));
  let link = fixture.dir.join("link-to-raw.RW2");
  symlink(&raw, &link).unwrap();
  let not_photo = fixture.file("notes.txt");
  let hidden = fixture.file(".hidden.jpg");
  let library = fixture.library();
  let photos = library.add_photos(&[
    jpeg.clone(),
    fixture.root().join("missing.jpg"),
    // シンボリックリンクは指す先の写真にする（フォルダの一覧と同じ entryId）
    link,
    not_photo,
    hidden,
    fixture.root().join("2026"),
    // 同じ写真は 1 つ
    raw.clone(),
    jpeg.clone(),
  ]);
  let names: Vec<&str> = photos.iter().map(|photo| photo["fileName"].as_str().unwrap()).collect();
  assert_eq!(names, ["DSC02072.JPG", "P1524180.RW2"]);
  let raw_entry = &photos[1];
  assert_eq!(
    sorted_keys(raw_entry),
    ["entryId", "fileName", "kind", "modifiedAt", "sizeBytes"]
  );
  assert!(raw_entry["entryId"].as_str().unwrap().starts_with("entry-"));
  assert_eq!(raw_entry["kind"], "raw");
  assert_eq!(photos[0]["kind"], "raster");
  assert_eq!(raw_entry["sizeBytes"], "photo 2026/09/24/P1524180.RW2".len());
  assert_eq!(raw_entry["modifiedAt"], "2026-09-24T07:39:13.250Z");
  assert_no_path(&Value::Array(photos.clone()));
  assert!(fixture.has_log("photo_editing.photos_added"));
  assert!(fixture.has_log(r#""picked":8"#) && fixture.has_log(r#""added":2"#));

  // フォルダの一覧と同じ entryId（同じファイル）
  let folder = library.add_folder(&fixture.root()).unwrap();
  let day = child(child(child(&folder, "2026"), "09"), "24");
  assert_eq!(entry_id(day, "P1524180.RW2"), raw_entry["entryId"].as_str().unwrap());
  assert_eq!(entry_id(day, "DSC02072.JPG"), photos[0]["entryId"].as_str().unwrap());
  // 選んだ写真を選んだ順に覚えた（シンボリックリンクは指す先）
  let remembered: Vec<PathBuf> = fixture
    .remembered_store()
    .load()
    .photos
    .into_iter()
    .map(|photo| photo.path)
    .collect();
  assert_eq!(
    remembered,
    [fs::canonicalize(&jpeg).unwrap(), fs::canonicalize(&raw).unwrap()]
  );

  // どれも使えなければ空で、覚えるものも変えない
  let file = remembered_path(&fixture.app_data());
  let before = fs::read(&file).unwrap();
  assert!(library
    .add_photos(&[fixture.root().join("gone.jpg"), fixture.root().join("notes.txt")])
    .is_empty());
  assert_eq!(fs::read(&file).unwrap(), before);
}

#[test]
fn adding_still_works_when_nothing_can_be_remembered() {
  let fixture = Fixture::new("remember-fails");
  let photo = fixture.file("Sub/a.jpg");
  // アプリのデータの置き場をファイルで塞ぐ（覚える置き場のフォルダを作れない）
  fs::create_dir_all(fixture.app_data()).unwrap();
  fs::write(fixture.app_data().join("photo-editing"), "not a folder").unwrap();
  let library = fixture.library();
  let folder = library.add_folder(&fixture.root()).unwrap();
  assert_eq!(child_names(&folder), ["Sub"]);
  assert_eq!(library.add_photos(std::slice::from_ref(&photo)).len(), 1);
  assert_eq!(photo_names(&library.remembered()), ["a.jpg"]);
  let failures: Vec<String> = fixture
    .logs
    .lock()
    .unwrap()
    .iter()
    .filter(|line| line.starts_with("photo_editing.remembered_write_failed "))
    .cloned()
    .collect();
  assert_eq!(failures.len(), 2, "{failures:?}");
  assert!(failures[0].contains(r#""operation":"addFolder""#), "{failures:?}");
  assert!(failures[1].contains(r#""operation":"addPhotos""#), "{failures:?}");
  assert!(
    failures
      .iter()
      .all(|line| line.contains(r#""error":""#) && !line.contains('/')),
    "{failures:?}"
  );
  // 書けなくてもこの起動では返した行を出し続け、次の起動では出ない（エラーにもならない）
  assert_eq!(fixture.remembered_store().load(), Remembered::default());
  assert_eq!(fixture.library().remembered(), json!({ "folders": [], "photos": [] }));

  // アプリのデータの場所が分からない（置き場が無い）ときも、足すことはでき、覚えたものは空
  let mut config = fixture.config(ScanLimits::default(), failing_maker(), THUMBNAIL_CACHE_MAX_BYTES, None);
  config.remembered = None;
  let without_store = PhotoLibrary::new(config);
  assert!(without_store.add_folder(&fixture.root()).is_ok());
  assert_eq!(without_store.add_photos(&[photo]).len(), 1);
  assert_eq!(photo_names(&without_store.remembered()), ["a.jpg"]);
  assert!(!fixture
    .logs
    .lock()
    .unwrap()
    .iter()
    .any(|line| line.contains("niho-photo-library-test")));
}

#[test]
fn selected_session_uses_the_remembered_photo_limit_and_keeps_picker_group_order() {
  let fixture = Fixture::new("selected-session-limit");
  let a = fixture.file("a.jpg");
  let b = fixture.file("b.jpg");
  let c = fixture.file("c.jpg");
  let d = fixture.file("d.jpg");
  let mut config = fixture.config(ScanLimits::default(), failing_maker(), THUMBNAIL_CACHE_MAX_BYTES, None);
  config.remembered = Some(RememberedStore::new(
    remembered_path(&fixture.app_data()),
    RememberedLimits {
      max_folders: 50,
      max_photos: 2,
    },
  ));
  let library = PhotoLibrary::new(config);

  assert_eq!(library.add_photos(&[a.clone(), b.clone(), c]).len(), 3);
  assert_eq!(photo_names(&library.remembered()), ["a.jpg", "b.jpg"]);
  // 新しい選択グループが先頭、グループ内は picker 順。同じ b は重複せず先頭へ動く。
  assert_eq!(library.add_photos(&[b, d]).len(), 2);
  assert_eq!(photo_names(&library.remembered()), ["b.jpg", "d.jpg"]);
  assert_eq!(fixture.remembered_store().load().photos.len(), 2);
}

#[test]
fn selected_photo_reads_do_not_rescan_remembered_folders() {
  let fixture = Fixture::new("selected-photo-only-read");
  let photo = fixture.file("selected.jpg");
  let library = fixture.library();
  library.add_folder(&fixture.root()).unwrap();
  library.add_photos(std::slice::from_ref(&photo));
  fixture.logs.lock().unwrap().clear();

  let selected = library.selected_photos();

  assert_eq!(selected.len(), 1);
  let logs = fixture.logs.lock().unwrap();
  assert!(
    !logs.iter().any(|line| line.starts_with("photo_editing.folder_listed ")),
    "{logs:?}"
  );
  assert!(
    !logs
      .iter()
      .any(|line| line.starts_with("photo_editing.remembered_listed ")),
    "{logs:?}"
  );
}

#[test]
fn unavailable_session_paths_do_not_consume_the_selected_photo_limit() {
  let fixture = Fixture::new("selected-photo-limit-skips-missing");
  let saved_a = fixture.file("saved-a.jpg");
  let saved_b = fixture.file("saved-b.jpg");
  let session_a = fixture.file("session-a.jpg");
  let session_b = fixture.file("session-b.jpg");
  let mut config = fixture.config(ScanLimits::default(), failing_maker(), THUMBNAIL_CACHE_MAX_BYTES, None);
  config.remembered = Some(RememberedStore::new(
    remembered_path(&fixture.app_data()),
    RememberedLimits {
      max_folders: 50,
      max_photos: 2,
    },
  ));
  let library = PhotoLibrary::new(config);

  library.add_photos(&[saved_a, saved_b]);
  fs::create_dir_all(remembered_path(&fixture.app_data()).with_extension("json.tmp")).unwrap();
  library.add_photos(&[session_a.clone(), session_b.clone()]);
  fs::remove_file(session_a).unwrap();
  fs::remove_file(session_b).unwrap();

  let selected = library.selected_photos();
  assert_eq!(
    selected
      .iter()
      .map(|photo| photo["fileName"].as_str().unwrap())
      .collect::<Vec<_>>(),
    ["saved-a.jpg", "saved-b.jpg"]
  );
  assert_eq!(photo_names(&library.remembered()), ["saved-a.jpg", "saved-b.jpg"]);
}

#[test]
fn forgetting_selected_photos_clears_session_and_persisted_references_but_preserves_sources() {
  let fixture = Fixture::new("selected-forget-success");
  let photo = fixture.file("stays.jpg");
  let library = fixture.library();
  library.add_folder(&fixture.root()).unwrap();
  library.add_photos(std::slice::from_ref(&photo));

  library.forget_photos().unwrap();
  assert!(photo.is_file());
  assert_eq!(photo_names(&library.remembered()), Vec::<String>::new());
  assert_eq!(library.remembered()["folders"].as_array().unwrap().len(), 1);
  assert!(fixture.remembered_store().load().photos.is_empty());
  assert_eq!(photo_names(&fixture.library().remembered()), Vec::<String>::new());
  assert_eq!(library.add_photos(&[photo]).len(), 1);
}

#[test]
fn selected_session_stays_visible_when_forgetting_cannot_persist() {
  let fixture = Fixture::new("selected-forget-failure");
  let photo = fixture.file("stays.jpg");
  let library = fixture.library();
  library.add_photos(std::slice::from_ref(&photo));
  fs::create_dir_all(remembered_path(&fixture.app_data()).with_extension("json.tmp")).unwrap();

  assert!(library.forget_photos().is_err());
  assert_eq!(photo_names(&library.remembered()), ["stays.jpg"]);
  assert_eq!(fixture.remembered_store().load().photos.len(), 1);
}

/// 予算だけを変えたライブラリ（覚えたものは `fixture.library()` と同じ置き場）。
fn library_with_budget(fixture: &Fixture, max_photos: usize, max_elapsed: Duration) -> Arc<PhotoLibrary> {
  let mut config = fixture.config(ScanLimits::default(), failing_maker(), THUMBNAIL_CACHE_MAX_BYTES, None);
  config.remembered_budget = RememberedBudget {
    max_photos,
    max_elapsed,
  };
  PhotoLibrary::new(config)
}

#[test]
fn the_default_remembered_budget_is_five_thousand_photos_and_five_seconds() {
  let budget = RememberedBudget::default();
  assert_eq!(budget.max_photos, 5_000);
  assert_eq!(budget.max_elapsed, Duration::from_secs(5));
}

#[test]
fn remembered_stops_reading_photos_at_the_budget_and_returns_only_the_root_of_the_rest() {
  let fixture = Fixture::new("remembered-photo-budget");
  for folder in ["A", "B", "C"] {
    fixture.file(&format!("{folder}/{}1.JPG", folder.to_lowercase()));
    fixture.file(&format!("{folder}/{}2.JPG", folder.to_lowercase()));
    fixture.file(&format!("{folder}/Sub/{}3.JPG", folder.to_lowercase()));
  }
  let first_launch = fixture.library();
  for folder in ["A", "B", "C"] {
    first_launch.add_folder(&fixture.root().join(folder)).unwrap();
  }

  // 次の起動: 新しい順（C, B, A）に読み、写真の合計が 5 枚に達したら、次のフォルダからは根だけ
  let library = library_with_budget(&fixture, 5, Duration::from_secs(60));
  let remembered = library.remembered();
  assert_eq!(folder_names(&remembered), ["C", "B", "A"]);
  let (c, b, a) = (
    &remembered["folders"][0],
    &remembered["folders"][1],
    &remembered["folders"][2],
  );
  // C は 3 枚（残りは 2 枚）。木のまま全部出る
  assert_eq!(photo_names(c), ["c1.JPG", "c2.JPG"]);
  assert_eq!(photo_names(child(c, "Sub")), ["c3.JPG"]);
  assert_eq!(c["truncated"], false);
  // B は残りの 2 枚まで。Sub の写真で上限に達して止まり、止めたフォルダ（Sub）と上の各段（B）が truncated
  assert_eq!(photo_names(b), ["b1.JPG", "b2.JPG"]);
  assert_eq!(photo_names(child(b, "Sub")), Vec::<String>::new());
  assert_eq!(child(b, "Sub")["truncated"], true);
  assert_eq!(b["truncated"], true);
  // A は予算を使い切ったので根だけ（写真もサブフォルダも空・truncated）
  assert_eq!(sorted_keys(a), sorted_keys(c));
  assert_eq!(a["photos"], json!([]));
  assert_eq!(a["children"], json!([]));
  assert_eq!(a["truncated"], true);
  assert_no_path(&remembered);
  assert!(fixture.has_log(r#""deferredFolders":1"#) && fixture.has_log(r#""listedPhotosInFolders":5"#));
  // 覚えたままで、何も消えていない
  assert_eq!(fixture.remembered_store().load().folders.len(), 3);

  // 根だけのフォルダも folderId で読み直せる（ページが選んだときに読む）。同じ folderId の全体の木になる
  let a_id = a["folderId"].as_str().unwrap().to_string();
  let listed = library.list_folder(&a_id).unwrap();
  assert_eq!(listed["folderId"], a_id.as_str());
  assert_eq!(photo_names(&listed), ["a1.JPG", "a2.JPG"]);
  assert_eq!(photo_names(child(&listed, "Sub")), ["a3.JPG"]);
  assert_eq!(listed["truncated"], false);
  assert!(library.entry_path(&entry_id(&listed, "a1.JPG")).is_some());
}

#[test]
fn remembered_returns_only_roots_once_the_time_budget_is_spent_and_skips_folders_that_are_gone() {
  let fixture = Fixture::new("remembered-time-budget");
  fixture.file("A/a1.JPG");
  fixture.file("B/b1.JPG");
  fixture.file("C/c1.JPG");
  let first_launch = fixture.library();
  for folder in ["A", "B", "C"] {
    first_launch.add_folder(&fixture.root().join(folder)).unwrap();
  }

  // 時間の予算が 0: どのフォルダも中を読まず、根だけ（このあとは走査の `folder_listed` が増えない）
  let count_listed = || {
    fixture
      .logs
      .lock()
      .unwrap()
      .iter()
      .filter(|line| line.starts_with("photo_editing.folder_listed "))
      .count()
  };
  let listed_before = count_listed();
  let library = library_with_budget(&fixture, 5_000, Duration::ZERO);
  let remembered = library.remembered();
  assert_eq!(folder_names(&remembered), ["C", "B", "A"]);
  for folder in remembered["folders"].as_array().unwrap() {
    assert_eq!(folder["photos"], json!([]));
    assert_eq!(folder["children"], json!([]));
    assert_eq!(folder["truncated"], true);
  }
  assert_eq!(count_listed(), listed_before);
  assert!(fixture.has_log(r#""deferredFolders":3"#) && fixture.has_log(r#""listedPhotosInFolders":0"#));

  // 根だけのときも、無いフォルダ・シンボリックリンクに置き換わったフォルダは黙って出さない（覚えたまま）
  fs::rename(fixture.root().join("B"), fixture.dir.join("moved-b")).unwrap();
  symlink(fixture.dir.join("moved-b"), fixture.root().join("B")).unwrap();
  fs::remove_dir_all(fixture.root().join("A")).unwrap();
  assert_eq!(folder_names(&library.remembered()), ["C"]);
  assert_eq!(fixture.remembered_store().load().folders.len(), 3);
  // 選ばれたとき（folderId）は今までどおり読める
  let c_id = library.remembered()["folders"][0]["folderId"]
    .as_str()
    .unwrap()
    .to_string();
  assert_eq!(photo_names(&library.list_folder(&c_id).unwrap()), ["c1.JPG"]);
}

#[test]
fn purging_removes_everything_remembered_and_remembering_works_again_afterwards() {
  let fixture = Fixture::new("remembered-purge");
  let photo = fixture.file("Sub/a.jpg");
  let library = fixture.library();
  library.add_folder(&fixture.root()).unwrap();
  library.add_photos(std::slice::from_ref(&photo));
  assert!(remembered_path(&fixture.app_data()).exists());
  assert_ne!(library.remembered(), json!({ "folders": [], "photos": [] }));

  library.purge_remembered().unwrap();
  assert!(!remembered_path(&fixture.app_data()).exists());
  assert_eq!(fixture.remembered_store().load(), Remembered::default());
  assert_eq!(library.remembered(), json!({ "folders": [], "photos": [] }));
  assert_eq!(fixture.library().remembered(), json!({ "folders": [], "photos": [] }));
  assert!(fixture.has_log("photo_editing.remembered_purged") && fixture.has_log(r#""ok":true"#));
  // 消したあとも足せて、次の起動で出る
  library.add_photos(std::slice::from_ref(&photo));
  assert_eq!(fixture.library().remembered()["photos"].as_array().unwrap().len(), 1);
  // 置き場が無いライブラリ・何も覚えていないときは何もしない
  library.purge_remembered().unwrap();
  library.purge_remembered().unwrap();
  let mut config = fixture.config(ScanLimits::default(), failing_maker(), THUMBNAIL_CACHE_MAX_BYTES, None);
  config.remembered = None;
  let without_store = PhotoLibrary::new(config);
  without_store.add_photos(std::slice::from_ref(&photo));
  assert_eq!(photo_names(&without_store.remembered()), ["a.jpg"]);
  without_store.purge_remembered().unwrap();
  assert_eq!(without_store.remembered(), json!({ "folders": [], "photos": [] }));
  assert!(!fixture
    .logs
    .lock()
    .unwrap()
    .iter()
    .any(|line| line.contains("niho-photo-library-test")));
}
