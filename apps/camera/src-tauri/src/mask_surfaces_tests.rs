use super::*;
use crate::photos::{edits_limits, CameraPhotos, EDITS_DIR_NAME};
use niho_desktop_photo::develop::DevelopPhotos;
use niho_desktop_photo::mask_surfaces::{mask_surface_id, MaskSurfaceLimits, MaskSurfaceStore, MASK_SURFACES_DIR_NAME};
use niho_desktop_photo::saved_settings::SavedSettingsStore;
use std::fs;
use std::path::PathBuf;
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::{Duration, UNIX_EPOCH};

/// テストごとの一時フォルダ（Drop で消す）。
struct TempDir(PathBuf);

impl TempDir {
  fn new(name: &str) -> Self {
    static COUNTER: AtomicU64 = AtomicU64::new(1);
    let dir = std::env::temp_dir().join(format!(
      "niho-camera-mask-surfaces-{name}-{}-{}",
      std::process::id(),
      COUNTER.fetch_add(1, Ordering::SeqCst)
    ));
    let _ = fs::remove_dir_all(&dir);
    fs::create_dir_all(&dir).unwrap();
    Self(dir)
  }
}

impl Drop for TempDir {
  fn drop(&mut self) {
    let _ = fs::remove_dir_all(&self.0);
  }
}

fn crc32(bytes: &[u8]) -> u32 {
  let mut crc = 0xffff_ffffu32;
  for byte in bytes {
    crc ^= u32::from(*byte);
    for _ in 0..8 {
      let mask = (crc & 1).wrapping_neg();
      crc = (crc >> 1) ^ (0xedb8_8320 & mask);
    }
  }
  !crc
}

fn chunk(kind: &[u8; 4], body: &[u8]) -> Vec<u8> {
  let mut out = (body.len() as u32).to_be_bytes().to_vec();
  out.extend_from_slice(kind);
  out.extend_from_slice(body);
  let mut crc_input = kind.to_vec();
  crc_input.extend_from_slice(body);
  out.extend_from_slice(&crc32(&crc_input).to_be_bytes());
  out
}

/// 8bit グレーの PNG の形（置き場が読むのはヘッダーと最初の IDAT まで。画素はエンジンが読む）。`color` 0 がグレー。
fn surface_png(width: u32, color: u8, seed: u8) -> Vec<u8> {
  let mut ihdr = width.to_be_bytes().to_vec();
  ihdr.extend_from_slice(&2u32.to_be_bytes());
  ihdr.extend_from_slice(&[8, color, 0, 0, 0]);
  let mut out = b"\x89PNG\r\n\x1a\n".to_vec();
  out.extend(chunk(b"IHDR", &ihdr));
  out.extend(chunk(b"IDAT", &[seed; 16]));
  out.extend(chunk(b"IEND", &[]));
  out
}

fn at(seconds: u64) -> SystemTime {
  UNIX_EPOCH + Duration::from_secs(1_800_000_000 + seconds)
}

fn camera_photos(temp: &TempDir, limits: MaskSurfaceLimits) -> CameraPhotos {
  let data = temp.0.join("app-data");
  CameraPhotos::new(Some(SavedSettingsStore::new(data.join(EDITS_DIR_NAME), edits_limits())))
    .with_mask_surfaces(MaskSurfaceStore::new(data.join(MASK_SURFACES_DIR_NAME), limits))
}

fn open(temp: &TempDir, photos: &CameraPhotos, name: &str) -> String {
  let path = temp.0.join(name);
  fs::write(&path, [b"\xff\xd8\xff".as_slice(), name.as_bytes()].concat()).unwrap();
  photos.open("entry", &path).unwrap().0
}

#[test]
fn requests_are_checked() {
  let photo_id = "photo-0123456789abcdef".to_string();
  let id = "a".repeat(64);
  let load = |photo_id: &str, surface_id: &str| LoadRequest {
    photo_id: photo_id.to_string(),
    surface_id: surface_id.to_string(),
  };
  assert!(validate_load_request(&load(&photo_id, &id)).is_ok());
  for bad in ["", "../a", &"A".repeat(64), &"a".repeat(63)] {
    assert_eq!(
      validate_load_request(&load(&photo_id, bad)).unwrap_err().code,
      "invalidRequest"
    );
  }
  // `photoId` is an opaque key of the opened photos (never a path): only its length is checked.
  assert_eq!(validate_load_request(&load("", &id)).unwrap_err().code, "notFound");
  let exists = |ids: Vec<String>| ExistsRequest {
    photo_id: photo_id.clone(),
    surface_ids: ids,
  };
  assert!(validate_exists_request(&exists(vec![id.clone()])).is_ok());
  assert!(validate_exists_request(&exists(vec![id.clone(); MAX_EXISTS_SURFACE_IDS])).is_ok());
  for ids in [
    vec![],
    vec![id.clone(); MAX_EXISTS_SURFACE_IDS + 1],
    vec![id.clone(), "x".into()],
  ] {
    assert_eq!(
      validate_exists_request(&exists(ids)).unwrap_err().code,
      "invalidRequest"
    );
  }
  // Unknown keys are refused (deny_unknown_fields).
  assert!(parse_request::<LoadRequest>(Some(json!({ "photoId": photo_id, "surfaceId": id, "path": "/" }))).is_err());
  assert!(parse_request::<ExistsRequest>(Some(json!({ "photoId": photo_id }))).is_err());
  // The raw body of a save.
  assert_eq!(validate_save_body(b"png", Some(&photo_id)).unwrap(), photo_id);
  assert_eq!(validate_save_body(b"png", None).unwrap_err().code, "invalidRequest");
  assert_eq!(
    validate_save_body(b"", Some(&photo_id)).unwrap_err().code,
    "invalidRequest"
  );
  assert_eq!(validate_save_body(b"png", Some("")).unwrap_err().code, "notFound");
  let large = vec![0u8; MAX_MASK_SURFACE_BYTES + 1];
  assert_eq!(
    validate_save_body(&large, Some(&photo_id)).unwrap_err().code,
    "maskSurfaceInvalid"
  );
}

#[test]
fn an_open_photo_saves_loads_and_exports_its_surfaces() {
  let temp = TempDir::new("round-trip");
  let photos = camera_photos(&temp, MaskSurfaceLimits::default());
  let photo_id = open(&temp, &photos, "P1.jpg");
  let png = surface_png(3, 0, 1);
  let info = photos.save_mask_surface(&photo_id, &png, at(0)).unwrap();
  assert_eq!(info.id, mask_surface_id(&png));
  assert_eq!((info.width, info.height), (3, 2));
  assert_eq!(photos.load_mask_surface(&photo_id, &info.id, at(1)).unwrap(), png);
  let other = "b".repeat(64);
  assert_eq!(
    photos
      .missing_mask_surfaces(&photo_id, &[info.id.clone(), other.clone()])
      .unwrap(),
    vec![other.clone()]
  );
  // The export reads them through DevelopPhotos.
  assert_eq!(photos.mask_surface(&photo_id, &info.id), Some(png.clone()));
  assert_eq!(photos.mask_surface(&photo_id, &other), None);
  // Another photo (other content) does not see them.
  let second = open(&temp, &photos, "P2.jpg");
  assert_eq!(
    photos
      .missing_mask_surfaces(&second, std::slice::from_ref(&info.id))
      .unwrap(),
    vec![info.id.clone()]
  );
  let error = photos.load_mask_surface(&second, &info.id, at(2)).unwrap_err();
  assert_eq!(error.code, camera_code::MASK_SURFACE_MISSING);
  // Not 8-bit gray.
  let error = photos
    .save_mask_surface(&photo_id, &surface_png(3, 2, 1), at(3))
    .unwrap_err();
  assert_eq!(error.code, camera_code::MASK_SURFACE_INVALID);
  // A closed photo.
  photos.close(std::slice::from_ref(&photo_id));
  assert_eq!(
    photos.save_mask_surface(&photo_id, &png, at(4)).unwrap_err().code,
    "notFound"
  );
  assert_eq!(
    photos.load_mask_surface(&photo_id, &info.id, at(4)).unwrap_err().code,
    "notFound"
  );
  assert_eq!(photos.mask_surface(&photo_id, &info.id), None);
  // Without a store (no app data folder): an internal error.
  let bare = CameraPhotos::new(None);
  let third = open(&temp, &bare, "P3.jpg");
  assert_eq!(
    bare.save_mask_surface(&third, &png, at(5)).unwrap_err().code,
    "internal"
  );
}

#[test]
fn a_full_photo_keeps_the_surfaces_its_saved_edits_and_versions_use() {
  let temp = TempDir::new("quota");
  let photos = camera_photos(
    &temp,
    MaskSurfaceLimits {
      max_per_photo: 2,
      ..MaskSurfaceLimits::default()
    },
  );
  let photo_id = open(&temp, &photos, "P1.jpg");
  let first = photos
    .save_mask_surface(&photo_id, &surface_png(2, 0, 1), at(0))
    .unwrap();
  let second = photos
    .save_mask_surface(&photo_id, &surface_png(2, 0, 2), at(10))
    .unwrap();
  // The saved edits use the older one: the newer unreferenced one makes room.
  let settings = json!({
    "v": 5,
    "masks": [{ "id": "m1", "kind": "brush", "enabled": false, "surface": { "id": first.id, "width": 2, "height": 2 }, "adjust": { "exposure": 1 } }]
  });
  photos.save(&photo_id, &settings, 0, SystemTime::now()).unwrap();
  let third = photos
    .save_mask_surface(&photo_id, &surface_png(2, 0, 3), at(20))
    .unwrap();
  let versions = json!([{
    "id": "v1",
    "name": "版 1",
    "createdAt": "2026-10-21T01:32:00.000Z",
    "kind": "named",
    "developSettings": {
      "v": 5,
      "masks": [{ "id": "m3", "kind": "brush", "surface": { "id": third.id, "width": 2, "height": 2 }, "adjust": { "exposure": 1 } }]
    }
  }]);
  photos
    .save_versions(&photo_id, &versions, 0, SystemTime::now())
    .unwrap();
  // The current saved edit and named/auto versions are protected; an unreferenced surface was evicted above.
  let error = photos
    .save_mask_surface(&photo_id, &surface_png(2, 0, 4), at(30))
    .unwrap_err();
  assert_eq!(error.code, camera_code::MASK_SURFACE_QUOTA);
  let missing = photos
    .missing_mask_surfaces(&photo_id, &[first.id.clone(), second.id.clone(), third.id.clone()])
    .unwrap();
  assert_eq!(missing, vec![second.id.clone()]);
  assert!(!error.message.is_empty());
}
