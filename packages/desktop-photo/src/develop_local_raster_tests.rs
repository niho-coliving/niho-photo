//! {@link LocalRaster::Camera}（NIHO camera。C3 #18391）の作業コピーと原寸の書き出しのテスト。偽の sidecar
//! （`test_support::develop`）と、写真を開いたことにする偽の {@link DevelopPhotos} で確かめる。

use super::*;
use crate::saved_settings::content_digest;
use crate::test_support::develop::*;
use std::collections::HashMap;
use std::fs;

/// 開いた写真（`photoId` → ファイル）。
struct FakePhotos {
  photos: HashMap<String, OpenPhoto>,
  has_saved_settings: bool,
}

impl FakePhotos {
  fn new(files: &[(&str, &Path)]) -> Self {
    let photos = files
      .iter()
      .map(|(photo_id, path)| {
        let open = OpenPhoto {
          path: path.to_path_buf(),
          file_name: path.file_name().unwrap().to_string_lossy().into_owned(),
          digest: content_digest(path).unwrap(),
        };
        (photo_id.to_string(), open)
      })
      .collect();
    Self {
      photos,
      has_saved_settings: false,
    }
  }

  fn with_saved_settings(mut self) -> Self {
    self.has_saved_settings = true;
    self
  }
}

impl DevelopPhotos for FakePhotos {
  fn open_photo(&self, photo_id: &str) -> Option<OpenPhoto> {
    self.photos.get(photo_id).cloned()
  }

  fn has_saved_settings(&self, _photo_id: &str) -> bool {
    self.has_saved_settings
  }
}

fn camera_develop(harness: &SidecarHarness) -> Arc<PhotoDevelop> {
  harness.develop_with(|config| config.local_raster = LocalRaster::Camera)
}

fn photo_file(harness: &SidecarHarness, name: &str, bytes: &[u8]) -> PathBuf {
  let path = harness.dir.join("photos").join(name);
  fs::create_dir_all(path.parent().unwrap()).unwrap();
  fs::write(&path, bytes).unwrap();
  path
}

#[test]
fn camera_input_rules_follow_the_web_and_desktop_keeps_its_own() {
  let camera = LocalRaster::Camera;
  assert_eq!(develop_input_for("P1.RW2", 36 << 20, camera), Some(DevelopInput::Raw));
  // JPEG は 64MiB まで、PNG は 10MiB までオリジナルのまま（web の develop-work-target.ts と同じ）
  for name in ["a.jpg", "a.JPEG"] {
    assert_eq!(
      develop_input_for(name, DIRECT_JPEG_MAX_BYTES, camera),
      Some(DevelopInput::Raster),
      "{name}"
    );
    assert_eq!(
      develop_input_for(name, DIRECT_JPEG_MAX_BYTES + 1, camera),
      Some(DevelopInput::RasterWorkingCopy),
      "{name}"
    );
  }
  assert_eq!(
    develop_input_for("a.png", DIRECT_RASTER_MAX_BYTES, camera),
    Some(DevelopInput::Raster)
  );
  assert_eq!(
    develop_input_for("a.png", DIRECT_RASTER_MAX_BYTES + 1, camera),
    Some(DevelopInput::RasterWorkingCopy)
  );
  for name in ["a.heic", "a.HEIF", "a.tif", "a.tiff"] {
    assert_eq!(
      develop_input_for(name, 1, camera),
      Some(DevelopInput::RasterWorkingCopy),
      "{name}"
    );
  }
  assert_eq!(develop_input_for("a.webp", 1, camera), None);
  // NIHO Desktop は今までどおり JPEG も 10MiB まで
  assert_eq!(
    develop_input("a.jpg", DIRECT_RASTER_MAX_BYTES + 1),
    Some(DevelopInput::RasterWorkingCopy)
  );
  assert_eq!(
    develop_input_for("a.jpg", DIRECT_RASTER_MAX_BYTES + 1, LocalRaster::Desktop),
    Some(DevelopInput::RasterWorkingCopy)
  );

  assert_eq!(export_input_for("P1.RW2", camera), Some(ExportInput::Raw));
  assert_eq!(export_input_for("big.jpg", camera), Some(ExportInput::Raster));
  for name in ["a.heic", "a.HEIF", "a.tif", "a.TIFF"] {
    assert_eq!(
      export_input_for(name, camera),
      Some(ExportInput::RasterFullSize),
      "{name}"
    );
    assert_eq!(
      export_input(name),
      None,
      "Desktop は HEIC / TIFF を原寸で書き出さない: {name}"
    );
  }
}

#[test]
fn camera_makes_raster_working_copies_with_apple_raw_linear() {
  let harness = SidecarHarness::new("camera-raster-source");
  let develop = camera_develop(&harness);
  let heic = photo_file(&harness, "IMG_0001.HEIC", b"heic bytes");
  let photos = FakePhotos::new(&[("p1", &heic)]);

  let value = develop.source(&photos, "p1").unwrap();
  assert_eq!(value["kind"], json!("workingCopy"));
  let base_version = value["baseVersion"].as_str().unwrap();
  assert!(
    base_version.starts_with("raster.ci2."),
    "ワーカー・クラウドと同じ raster の作業コピー: {base_version}"
  );
  let calls = harness.work_calls();
  assert!(
    calls
      .iter()
      .any(|call| call.starts_with("apple-raw-linear raster ") && call.contains(" --long-edge 2560")),
    "{calls:?}"
  );
  let bytes = develop
    .source_bytes(&photos, "p1", value["token"].as_str().unwrap())
    .unwrap();
  assert_eq!(bytes, FAKE_RASTER_JPEG);

  // 2 回目はキャッシュから（作り直さない）
  let again = develop.source(&photos, "p1").unwrap();
  assert_eq!(again["baseVersion"], value["baseVersion"]);
  assert_eq!(
    harness
      .work_calls()
      .iter()
      .filter(|call| call.starts_with("apple-raw-linear raster "))
      .count(),
    1
  );
}

#[test]
fn a_jpeg_stays_the_original_unless_a_working_copy_is_forced() {
  let harness = SidecarHarness::new("camera-force-working-copy");
  let develop = camera_develop(&harness);
  let jpeg = photo_file(&harness, "DSC0001.JPG", b"jpeg bytes");
  let photos = FakePhotos::new(&[("p1", &jpeg)]);

  let original = develop.source(&photos, "p1").unwrap();
  assert_eq!(original["kind"], json!("raster"));
  assert_eq!(
    develop
      .source_bytes(&photos, "p1", original["token"].as_str().unwrap())
      .unwrap(),
    b"jpeg bytes"
  );
  assert!(harness.work_calls().is_empty(), "{:?}", harness.work_calls());

  // 画面が開いて 4,000 万画素を超えると分かった JPEG は作業コピーで開き直す
  let forced = develop.source_with_options(&photos, "p1", None, true).unwrap();
  assert_eq!(forced["kind"], json!("workingCopy"));
  assert!(forced["baseVersion"].as_str().unwrap().starts_with("raster.ci2."));
}

#[test]
fn raw_source_context_generates_only_new_signed_and_restores_exact_drafts() {
  let harness = SidecarHarness::new("camera-signed-source-context");
  harness.mark("tool-version", "0.5.0");
  let develop = harness.develop_with(|config| config.signed_raw_generation = true);
  let legacy_path = photo_file(&harness, "legacy.RW2", b"legacy raw");
  let signed_path = photo_file(&harness, "signed.RW2", b"signed raw");
  let draft_path = photo_file(&harness, "draft.RW2", b"draft raw");
  let photos = FakePhotos::new(&[
    ("legacy", &legacy_path),
    ("signed", &signed_path),
    ("draft", &draft_path),
  ]);

  // flags 欠落は保守的に unsigned。後から新規contextが来ても既存cacheを昇格させない。
  let legacy = develop.source(&photos, "legacy").unwrap();
  assert!(legacy["baseVersion"].as_str().unwrap().contains(".p2.e1."));
  let still_legacy = develop
    .source_with_options_context(
      &photos,
      "legacy",
      Some(DevelopSourceContext {
        has_saved_develop_settings: false,
        has_develop_edits: false,
        base_version: None,
      }),
      false,
    )
    .unwrap();
  assert_eq!(still_legacy["baseVersion"], legacy["baseVersion"]);

  let signed = develop
    .source_with_options_context(
      &photos,
      "signed",
      Some(DevelopSourceContext {
        has_saved_develop_settings: false,
        has_develop_edits: false,
        base_version: None,
      }),
      false,
    )
    .unwrap();
  assert!(signed["baseVersion"].as_str().unwrap().contains(".p3.e4."));

  // producer条件を満たさない編集中draftは、その exact unsigned baseを復元する。
  let old_base = "raw-apple.d8.p2.e1.cal-panasonic-dc-s5-apple-v2.lens-apple";
  let draft = develop
    .source_with_options_context(
      &photos,
      "draft",
      Some(DevelopSourceContext {
        has_saved_develop_settings: false,
        has_develop_edits: true,
        base_version: Some(old_base.into()),
      }),
      false,
    )
    .unwrap();
  assert_eq!(draft["baseVersion"], old_base);

  // 保存ストアが保存ありなら、画面が新規と誤申告してもsignedへ昇格しない。
  let saved_photos =
    FakePhotos::new(&[("saved", &photo_file(&harness, "saved.RW2", b"saved raw"))]).with_saved_settings();
  let saved = develop
    .source_with_options_context(
      &saved_photos,
      "saved",
      Some(DevelopSourceContext {
        has_saved_develop_settings: false,
        has_develop_edits: false,
        base_version: None,
      }),
      false,
    )
    .unwrap();
  assert!(saved["baseVersion"].as_str().unwrap().contains(".p2.e1."));
}

#[test]
fn producer_off_still_restores_a_saved_signed_source() {
  let harness = SidecarHarness::new("camera-signed-source-reader-after-rollback");
  harness.mark("tool-version", "0.5.0");
  let develop = harness.develop_with(|config| config.signed_raw_generation = false);
  let raw = photo_file(&harness, "saved.RW2", b"saved signed raw");
  let photos = FakePhotos::new(&[("saved", &raw)]).with_saved_settings();
  let base = "raw-apple.d8.p3.e4.cal-panasonic-dc-s5-apple-v4.lens-apple";
  let source = develop
    .source_with_options_context(
      &photos,
      "saved",
      Some(DevelopSourceContext {
        has_saved_develop_settings: true,
        has_develop_edits: true,
        base_version: Some(base.into()),
      }),
      false,
    )
    .unwrap();
  assert_eq!(source["baseVersion"], base);
  assert!(harness
    .work_calls()
    .iter()
    .any(|call| call.contains("--encoding png16-signed-g18")));
}

#[test]
fn native_signed_export_defaults_follow_render_version_and_known_calibration() {
  let run = |name: &str, render_version: &str, generic: bool| {
    let harness = SidecarHarness::new(name);
    harness.mark("tool-version", "0.5.0");
    harness.mark("render-version", render_version);
    if generic {
      harness.mark(
        "wc-meta.json",
        r#"{"kind":"raw","dcpSha256":"apple-ciraw8/linear-prophoto-d50/cal-other-apple-v1","_source":{"tool":{"name":"apple-raw-linear","version":"0.5.0"},"decoderVersion":"8","camera":{"make":"OTHER","model":"RAW"},"calibration":{"id":"cal-other-apple-v1","cameraId":"other","track":"apple","version":"v1","baseVersion":"p3"},"lensCorrection":{"mode":"apple"}}}"#,
      );
    }
    let develop = harness.develop_with(|config| config.signed_raw_generation = true);
    let raw = photo_file(&harness, "new.RW2", name.as_bytes());
    let photos = FakePhotos::new(&[("new", &raw)]);
    let destination = harness.dir.join("out").join("new.jpg");
    fs::create_dir_all(destination.parent().unwrap()).unwrap();
    develop
      .export_with_saved_state(
        &photos,
        "new",
        &json!({ "v": 1, "engine": "niho-2", "look": "niho-standard-1", "base": null }),
        false,
        false,
        &destination,
        Overwrite::Never,
      )
      .unwrap();
    serde_json::from_slice::<Value>(&fs::read(harness.sidecars.join("last-settings.json")).unwrap()).unwrap()
  };

  let hue_stable = run("export-known-signed-niho11", "0.18.0", false);
  assert_eq!(
    (&hue_stable["engine"], &hue_stable["look"]),
    (&json!("niho-11"), &json!("niho-standard-5"))
  );
  let previous = run("export-known-signed-0-17", "0.17.0", false);
  assert_eq!(
    (&previous["engine"], &previous["look"]),
    (&json!("niho-7"), &json!("niho-standard-5"))
  );
  let current = run("export-known-signed-niho7", "0.16.0", false);
  assert_eq!(
    (&current["engine"], &current["look"]),
    (&json!("niho-7"), &json!("niho-standard-5"))
  );
  let old = run("export-known-signed-old-native", "0.15.9", false);
  assert_eq!(
    (&old["engine"], &old["look"]),
    (&json!("niho-4"), &json!("niho-standard-3"))
  );
  let generic = run("export-generic-signed", "0.16.0", true);
  assert_eq!(
    (&generic["engine"], &generic["look"]),
    (&json!("niho-3"), &json!("niho-standard-2"))
  );
}

#[test]
fn saved_old_export_pairs_and_exact_bases_are_preserved_on_new_native() {
  let harness = SidecarHarness::new("export-saved-old-pairs-preserved");
  harness.mark("tool-version", "0.5.0");
  harness.mark("render-version", "0.16.0");
  let develop = harness.develop_with(|config| config.signed_raw_generation = true);
  let cases = [
    (
      "saved-2",
      "raw-apple.d8.p2.e1.cal-panasonic-dc-s5-apple-v2.lens-apple",
      "niho-2",
      "niho-standard-1",
    ),
    (
      "saved-3",
      "raw-apple.d8.p3.e4.cal-panasonic-dc-s5-apple-v4.lens-apple",
      "niho-3",
      "niho-standard-2",
    ),
    (
      "saved-4",
      "raw-apple.d8.p3.e4.cal-panasonic-dc-s5-apple-v4.lens-apple",
      "niho-4",
      "niho-standard-3",
    ),
  ];
  for (photo_id, base, engine, look) in cases {
    let raw = photo_file(&harness, &format!("{photo_id}.RW2"), photo_id.as_bytes());
    let photos = FakePhotos::new(&[(photo_id, &raw)]).with_saved_settings();
    let settings = json!({ "v": 1, "engine": engine, "look": look, "base": base, "exposure": 0.4 });
    let destination = harness.dir.join("out").join(format!("{photo_id}.jpg"));
    fs::create_dir_all(destination.parent().unwrap()).unwrap();
    develop
      .export_with_saved_state(&photos, photo_id, &settings, true, true, &destination, Overwrite::Never)
      .unwrap();
    let rendered: Value =
      serde_json::from_slice(&fs::read(harness.sidecars.join("last-settings.json")).unwrap()).unwrap();
    assert_eq!(rendered, settings);
  }
  let calls = harness.work_calls();
  assert!(calls.iter().any(|call| call.contains("--encoding png16-g18")));
  assert!(
    calls
      .iter()
      .filter(|call| call.contains("--encoding png16-signed-g18"))
      .count()
      >= 2
  );
}

#[test]
fn camera_exports_heic_at_full_size_through_raster_then_develop_render() {
  let harness = SidecarHarness::new("camera-heic-export");
  harness.mark("tool-version", "0.5.2");
  let develop = camera_develop(&harness);
  let heic = photo_file(&harness, "IMG_0001.HEIC", b"heic bytes");
  let photos = FakePhotos::new(&[("p1", &heic)]);
  let destination = harness.dir.join("out").join("IMG_0001.jpg");
  fs::create_dir_all(destination.parent().unwrap()).unwrap();

  assert!(develop.check_export(&photos, "p1").is_ok());
  develop
    .export(
      &photos,
      "p1",
      &json!({ "exposure": 0.5 }),
      &destination,
      Overwrite::Never,
    )
    .unwrap();
  assert_eq!(fs::read(&destination).unwrap(), b"JPEG");

  let calls = harness.work_calls();
  let raster = calls
    .iter()
    .position(|call| call.starts_with("apple-raw-linear raster "))
    .expect("raster");
  assert!(calls[raster].contains(" --long-edge full"), "{}", calls[raster]);
  assert!(
    calls[raster].contains(heic.to_str().unwrap()),
    "原本の HEIC から描く: {}",
    calls[raster]
  );
  let render = calls
    .iter()
    .position(|call| call.starts_with("niho-develop-render render "))
    .expect("develop");
  assert!(raster < render, "{calls:?}");
  assert!(
    calls[render].contains(" --raster ") && calls[render].contains("work.jpg"),
    "原寸の raster の JPEG を段 2 へ: {}",
    calls[render]
  );
  assert!(
    !calls[render].contains(heic.to_str().unwrap()),
    "HEIC を直に段 2 へ渡さない: {}",
    calls[render]
  );
  let encode = calls
    .iter()
    .find(|call| call.starts_with("apple-raw-linear encode-jpeg "))
    .expect("encode");
  assert!(
    encode.contains(&format!("--metadata-from {}", heic.display())),
    "撮影日時は原本から: {encode}"
  );
  assert!(
    !calls.iter().any(|call| call.starts_with("apple-raw-linear render ")),
    "RAW 専用の render を使わない: {calls:?}"
  );
}

#[test]
fn heic_is_not_exported_at_full_size_by_desktop_or_an_old_apple_raw_linear() {
  let harness = SidecarHarness::new("camera-heic-export-unsupported");
  let heic = photo_file(&harness, "IMG_0001.HEIC", b"heic bytes");
  let photos = FakePhotos::new(&[("p1", &heic)]);
  let destination = harness.dir.join("IMG_0001.jpg");

  // NIHO Desktop は HEIC / TIFF の原寸書き出し能力を本 Issue では広げない。
  let desktop = harness.develop();
  assert_eq!(
    desktop.check_export(&photos, "p1").unwrap_err().code,
    develop_code::UNSUPPORTED_SOURCE
  );

  // full-size export を持たない apple-raw-linear（0.5.2 より前。0.5.1 は登録表の fallback だけ・0.5.0 は作業コピー用 raster を持つ）
  harness.mark("tool-version", "0.5.1");
  let camera = camera_develop(&harness);
  assert_eq!(
    camera.check_export(&photos, "p1").unwrap_err().code,
    develop_code::UNSUPPORTED_SOURCE
  );
  let err = camera
    .export(&photos, "p1", &json!({}), &destination, Overwrite::Never)
    .unwrap_err();
  assert_eq!(err.code, develop_code::UNSUPPORTED_SOURCE);
  assert!(!destination.exists());
}
