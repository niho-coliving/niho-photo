use super::*;
use crate::photos::{edits_limits, EDITS_DIR_NAME};
use niho_desktop_photo::saved_settings::SavedSettingsStore;
use niho_desktop_photo::test_support::develop::*;
use std::fs;

fn camera_develop(harness: &SidecarHarness) -> Arc<PhotoDevelop> {
  harness.develop_with(|config| config.local_raster = LocalRaster::Camera)
}

fn camera_photos(harness: &SidecarHarness) -> CameraPhotos {
  CameraPhotos::new(Some(SavedSettingsStore::new(
    harness.dir.join("app-data").join(EDITS_DIR_NAME),
    edits_limits(),
  )))
}

fn photo_file(harness: &SidecarHarness, name: &str, bytes: &[u8]) -> PathBuf {
  let path = harness.dir.join("photos").join(name);
  fs::create_dir_all(path.parent().unwrap()).unwrap();
  fs::write(&path, bytes).unwrap();
  path
}

#[test]
fn export_file_names_follow_the_suggestion_or_the_original_name() {
  assert_eq!(export_file_name(None, "P1524180.RW2"), "P1524180.jpg");
  assert_eq!(export_file_name(Some(""), "IMG_0001.HEIC"), "IMG_0001.jpg");
  assert_eq!(export_file_name(Some(" -- "), "IMG_0001.HEIC"), "IMG_0001.jpg");
  assert_eq!(export_file_name(Some("鎌倉の朝.jpeg"), "a.RW2"), "鎌倉の朝.jpeg");
  assert_eq!(export_file_name(Some("../../etc/passwd"), "a.RW2"), "passwd.jpg");
  assert_eq!(export_file_name(Some(".hidden.jpg"), "a.RW2"), "hidden.jpg");
  assert_eq!(export_file_name(Some("a:b\u{7}c.png"), "a.RW2"), "abc.jpg");
  let long = export_file_name(Some(&format!("{}.jpg", "写".repeat(200))), "a.RW2");
  assert!(long.len() <= 255 && long.ends_with(".jpg"), "{}", long.len());
  // 名前が記号だけになるときは photo
  assert_eq!(export_file_name(None, "...RW2"), "photo.jpg");
}

#[test]
fn numbered_names_keep_the_extension_and_the_byte_limit() {
  assert_eq!(numbered_file_name("P1.jpg", 1), "P1.jpg");
  assert_eq!(numbered_file_name("P1.jpg", 2), "P1-2.jpg");
  let long = format!("{}.jpg", "a".repeat(251));
  let numbered = numbered_file_name(&long, 999);
  assert!(numbered.len() <= 255 && numbered.ends_with("-999.jpg"), "{numbered}");
}

#[test]
fn export_refuses_any_open_photo_as_its_destination() {
  let harness = SidecarHarness::new("camera-export-open-original");
  let photos = camera_photos(&harness);
  let source = photo_file(&harness, "A.RW2", b"source");
  let other_open_photo = photo_file(&harness, "B.RW2", b"other");
  photos.open("entry-1", &source).unwrap();
  photos.open("entry-2", &other_open_photo).unwrap();

  assert_eq!(
    refuse_original(&photos, &other_open_photo).unwrap_err().code,
    code::EXPORT_FAILED
  );
}

#[test]
fn heic_opened_in_camera_gets_a_raster_working_copy_through_the_camera_photos() {
  let harness = SidecarHarness::new("camera-heic-source");
  let develop = camera_develop(&harness);
  let photos = camera_photos(&harness);
  let (photo_id, _) = photos
    .open("entry-1", &photo_file(&harness, "IMG_0001.HEIC", b"heic"))
    .unwrap();
  let value = develop.source_with_options(&photos, &photo_id, None, false).unwrap();
  assert_eq!(value["kind"], json!("workingCopy"));
  assert!(
    value["baseVersion"].as_str().unwrap().starts_with("raster.ci2."),
    "{value}"
  );
  assert_eq!(
    develop
      .source_bytes(&photos, &photo_id, value["token"].as_str().unwrap())
      .unwrap(),
    FAKE_RASTER_JPEG
  );
}

#[test]
fn folder_exports_number_the_name_and_never_overwrite() {
  let harness = SidecarHarness::new("camera-folder-export");
  let develop = camera_develop(&harness);
  let photos = camera_photos(&harness);
  let raw = photo_file(&harness, "P1524180.RW2", b"raw");
  let (photo_id, _) = photos.open("entry-1", &raw).unwrap();
  let folder = harness.dir.join("exports");
  fs::create_dir_all(&folder).unwrap();
  fs::write(folder.join("P1524180.jpg"), b"someone else's").unwrap();

  let settings = json!({ "exposure": 0.2 });
  assert_eq!(
    export_into_folder(
      &develop,
      &photos,
      &photo_id,
      &settings,
      true,
      true,
      &folder,
      "P1524180.jpg"
    )
    .unwrap(),
    "P1524180-2.jpg"
  );
  assert_eq!(
    export_into_folder(
      &develop,
      &photos,
      &photo_id,
      &settings,
      true,
      true,
      &folder,
      "P1524180.jpg"
    )
    .unwrap(),
    "P1524180-3.jpg"
  );
  assert_eq!(fs::read(folder.join("P1524180.jpg")).unwrap(), b"someone else's");
  assert_eq!(fs::read(folder.join("P1524180-2.jpg")).unwrap(), b"JPEG");
  // 段 2 に渡した補正は画面の補正のまま
  let last: Value = serde_json::from_slice(&fs::read(harness.sidecars.join("last-settings.json")).unwrap()).unwrap();
  assert_eq!(last, settings);

  let missing = harness.dir.join("missing");
  let err = export_into_folder(
    &develop,
    &photos,
    &photo_id,
    &settings,
    true,
    true,
    &missing,
    "P1524180.jpg",
  )
  .unwrap_err();
  assert_eq!(err.code, code::FOLDER_NOT_FOUND);
}

#[test]
fn the_original_is_never_an_export_destination() {
  let harness = SidecarHarness::new("camera-refuse-original");
  let photos = camera_photos(&harness);
  let jpeg = photo_file(&harness, "DSC00001.jpg", b"jpeg");
  let (photo_id, _) = photos.open("entry-1", &jpeg).unwrap();
  assert_eq!(
    refuse_original(&photos, &photo_id, &jpeg).unwrap_err().code,
    code::EXPORT_FAILED
  );
  assert!(refuse_original(&photos, &photo_id, &harness.dir.join("other.jpg")).is_ok());
  // フォルダへの書き出しが元の写真と同じ名前になっても、元の写真は書き換えない（番号を付ける）
  let develop = camera_develop(&harness);
  let folder = jpeg.parent().unwrap().to_path_buf();
  let written = export_into_folder(
    &develop,
    &photos,
    &photo_id,
    &json!({}),
    true,
    true,
    &folder,
    "DSC00001.jpg",
  )
  .unwrap();
  assert_eq!(written, "DSC00001-2.jpg");
  assert_eq!(fs::read(&jpeg).unwrap(), b"jpeg");
}

#[test]
fn native_export_needs_the_sidecars_and_raster_for_heic() {
  let harness = SidecarHarness::new("camera-can-export");
  harness.mark("tool-version", "0.5.2");
  let develop = camera_develop(&harness);
  assert!(develop.is_available());
  for name in ["P1.RW2", "a.jpg", "a.png", "a.heic", "a.tiff"] {
    assert!(can_export(&develop, name), "{name}");
  }
  assert!(!can_export(&develop, "a.webp"));

  harness.mark("tool-version", "0.4.2");
  let old = camera_develop(&harness);
  assert!(old.is_available());
  assert!(can_export(&old, "P1.RW2"));
  assert!(
    !can_export(&old, "a.heic"),
    "raster の無い apple-raw-linear では HEIC を原寸で書き出さない"
  );

  for version in ["0.5.0", "0.5.1"] {
    harness.mark("tool-version", version);
    let without_full_raster = camera_develop(&harness);
    assert!(
      !can_export(&without_full_raster, "a.heic"),
      "full-size raster export needs 0.5.2 (got {version})"
    );
  }
}

#[test]
fn the_jpeg_extension_is_enforced_on_the_save_dialog_path() {
  assert_eq!(
    ensure_jpeg_extension(PathBuf::from("/tmp/a.JPEG")),
    PathBuf::from("/tmp/a.JPEG")
  );
  assert_eq!(
    ensure_jpeg_extension(PathBuf::from("/tmp/a.png")),
    PathBuf::from("/tmp/a.png.jpg")
  );
  assert_eq!(
    ensure_jpeg_extension(PathBuf::from("/tmp/a")),
    PathBuf::from("/tmp/a.jpg")
  );
}

/// 本物の sidecar で、NIHO photo（`LocalRaster::Camera`）と NIHO Desktop（`LocalRaster::Desktop`）の原寸の書き出しを
/// 同じ写真・同じ補正で比べる（C3 #18391 の「byte 一致」）。sidecar は開発ビルドの差し替えと同じ環境変数、写真は
/// `NIHO_CAMERA_REAL_PHOTOS`（`:` 区切り）。書き出しは `NIHO_CAMERA_REAL_OUT` に残す（ブラウザ版との ΔE00 の比較に使う）。
///
/// ```sh
/// NIHO_APPLE_RAW_LINEAR_PATH=… NIHO_DEVELOP_RENDER_PATH=… NIHO_DEVELOP_CALIBRATION_DIR=packages/develop-engine/calibration \
///   NIHO_CAMERA_REAL_PHOTOS=/path/P1.RW2:/path/a.JPG NIHO_CAMERA_REAL_OUT=/tmp/out cargo test --locked -- --ignored real_sidecars
/// ```
#[test]
#[ignore = "本物の sidecar と写真が要る（README「検証」）"]
fn real_sidecars_camera_and_desktop_full_size_exports_are_byte_identical() {
  let env = |name: &str| {
    std::env::var_os(name)
      .map(PathBuf::from)
      .unwrap_or_else(|| panic!("{name} が要る"))
  };
  let sidecars = SidecarPaths {
    apple_raw_linear: env("NIHO_APPLE_RAW_LINEAR_PATH"),
    develop_render: env("NIHO_DEVELOP_RENDER_PATH"),
    calibration_dir: env("NIHO_DEVELOP_CALIBRATION_DIR"),
  };
  let out = env("NIHO_CAMERA_REAL_OUT");
  fs::create_dir_all(&out).unwrap();
  let photos_env = std::env::var("NIHO_CAMERA_REAL_PHOTOS").expect("NIHO_CAMERA_REAL_PHOTOS が要る");
  // 画面と同じく、作業コピーで直した補正は `base` にその作業コピーの版を持つ（JPEG / PNG のオリジナルは null）。niho-3 / niho-4 は
  // signed の RAW の作業コピーだけなので、旧 recipe（signed を新しく作らない。NIHO Desktop の既定）の補正は niho-2
  let settings_for = |base: Option<&str>| {
    json!({
      "v": 1, "engine": "niho-2", "look": "niho-standard-1", "base": base,
      "exposure": 0.35, "contrast": 18, "highlights": -40, "shadows": 35, "clarity": 12, "vibrance": 20,
    })
  };
  let develop_for = |local_raster: LocalRaster, name: &str| {
    PhotoDevelop::new(DevelopConfig {
      sidecars: Some(sidecars.clone()),
      cache_dir: Some(out.join(format!("cache-{name}"))),
      cache_max_bytes: CACHE_MAX_BYTES,
      timeouts: DevelopTimeouts::default(),
      sips: PathBuf::from("/usr/bin/sips"),
      raster_info: None,
      signed_raw_generation: false,
      local_raster,
      log: Arc::new(|_, _| {}),
    })
  };
  let camera = develop_for(LocalRaster::Camera, "camera");
  let desktop = develop_for(LocalRaster::Desktop, "desktop");
  assert!(
    camera.is_available() && desktop.is_available(),
    "sidecar を確かめられない"
  );
  let photos = CameraPhotos::new(None);
  for path in photos_env.split(':').filter(|path| !path.is_empty()).map(PathBuf::from) {
    let (photo_id, photo) = photos.open("entry", &path).unwrap();
    let stem = Path::new(&photo.file_name)
      .file_stem()
      .unwrap()
      .to_string_lossy()
      .into_owned();
    let camera_out = out.join(format!("{stem}.camera.jpg"));
    let source = camera.source(&photos, &photo_id).unwrap();
    let settings = settings_for(source["baseVersion"].as_str());
    fs::write(out.join(format!("{stem}.settings.json")), settings.to_string()).unwrap();
    let started = std::time::Instant::now();
    camera
      .export(&photos, &photo_id, &settings, &camera_out, Overwrite::Allowed)
      .unwrap();
    let camera_ms = started.elapsed().as_millis();
    match export_input_for(&photo.file_name, LocalRaster::Desktop) {
      Some(_) => {
        let desktop_out = out.join(format!("{stem}.desktop.jpg"));
        desktop
          .export(&photos, &photo_id, &settings, &desktop_out, Overwrite::Allowed)
          .unwrap();
        let (a, b) = (fs::read(&camera_out).unwrap(), fs::read(&desktop_out).unwrap());
        eprintln!(
          "{}: camera {} bytes ({camera_ms} ms) / desktop {} bytes / identical={}",
          photo.file_name,
          a.len(),
          b.len(),
          a == b
        );
        assert_eq!(a, b, "{}: camera と Desktop の原寸の書き出しが違う", photo.file_name);
      }
      // HEIC / TIFF は NIHO Desktop が原寸で書き出さない（camera だけ）
      None => eprintln!(
        "{}: camera {} bytes ({camera_ms} ms) / desktop は原寸の書き出しなし",
        photo.file_name,
        fs::metadata(&camera_out).unwrap().len()
      ),
    }
  }
}
