use super::*;
use serde_json::json;
use std::sync::atomic::{AtomicU64, Ordering};

/// テストごとの一時フォルダ（Drop で消す）。本物のアプリのデータには触れない。
struct TempDir(PathBuf);

impl TempDir {
  fn new(name: &str) -> Self {
    static COUNTER: AtomicU64 = AtomicU64::new(1);
    let dir = std::env::temp_dir().join(format!(
      "niho-photo-mask-surfaces-{name}-{}-{}",
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

fn key(fill: char) -> String {
  fill.to_string().repeat(64)
}

fn at(seconds: u64) -> SystemTime {
  UNIX_EPOCH + Duration::from_secs(1_800_000_000 + seconds)
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

/// zlib の無圧縮ブロック（エンコーダーの依存を足さずに正しい PNG を作る）。
fn zlib_stored(data: &[u8]) -> Vec<u8> {
  let mut out = vec![0x78, 0x01];
  let blocks: Vec<&[u8]> = if data.is_empty() {
    vec![&[][..]]
  } else {
    data.chunks(65_535).collect()
  };
  for (index, block) in blocks.iter().enumerate() {
    out.push(u8::from(index + 1 == blocks.len()));
    let len = block.len() as u16;
    out.extend_from_slice(&len.to_le_bytes());
    out.extend_from_slice(&(!len).to_le_bytes());
    out.extend_from_slice(block);
  }
  let (mut a, mut b) = (1u32, 0u32);
  for byte in data {
    a = (a + u32::from(*byte)) % 65_521;
    b = (b + a) % 65_521;
  }
  out.extend_from_slice(&((b << 16) | a).to_be_bytes());
  out
}

/// PNG（`ihdr` の深さ・色の型、`extra` は IHDR と IDAT の間の chunk）。画素は 1 byte / 画素の行に filter 0。
fn png_with(width: u32, height: u32, depth: u8, color: u8, extra: &[Vec<u8>], fill: u8) -> Vec<u8> {
  let mut ihdr = width.to_be_bytes().to_vec();
  ihdr.extend_from_slice(&height.to_be_bytes());
  ihdr.extend_from_slice(&[depth, color, 0, 0, 0]);
  let mut raw = Vec::new();
  for _ in 0..height {
    raw.push(0);
    raw.extend(std::iter::repeat(fill).take(width as usize));
  }
  let mut out = PNG_SIGNATURE.to_vec();
  out.extend(chunk(b"IHDR", &ihdr));
  for extra in extra {
    out.extend_from_slice(extra);
  }
  out.extend(chunk(b"IDAT", &zlib_stored(&raw)));
  out.extend(chunk(b"IEND", &[]));
  out
}

fn gray(width: u32, height: u32, fill: u8) -> Vec<u8> {
  png_with(width, height, 8, 0, &[], fill)
}

fn store(temp: &TempDir, limits: MaskSurfaceLimits) -> MaskSurfaceStore {
  MaskSurfaceStore::new(temp.0.join(MASK_SURFACES_DIR_NAME), limits)
}

fn none() -> BTreeSet<String> {
  BTreeSet::new()
}

#[test]
fn a_surface_round_trips_under_the_sha256_of_its_bytes() {
  use std::os::unix::fs::PermissionsExt;
  let temp = TempDir::new("round-trip");
  let surfaces = store(&temp, MaskSurfaceLimits::default());
  let png = gray(5, 3, 200);
  let info = surfaces.save(&key('a'), &png, &none(), at(0)).unwrap();
  assert_eq!(info.id, hex_lower(&Sha256::digest(&png)));
  assert_eq!((info.width, info.height), (5, 3));
  let path = temp
    .0
    .join(MASK_SURFACES_DIR_NAME)
    .join(key('a'))
    .join(format!("{}.png", info.id));
  assert_eq!(fs::read(&path).unwrap(), png);
  let mode = |path: &Path| fs::metadata(path).unwrap().permissions().mode() & 0o777;
  assert_eq!(mode(&path), 0o600);
  assert_eq!(mode(path.parent().unwrap()), 0o700);
  assert_eq!(mode(&temp.0.join(MASK_SURFACES_DIR_NAME)), 0o700);
  assert_eq!(surfaces.load(&key('a'), &info.id, at(1)).unwrap(), png);
  assert!(surfaces.contains(&key('a'), &info.id));
  assert_eq!(surfaces.list(&key('a')), vec![info.id.clone()]);
  // Another photo does not see it.
  assert!(!surfaces.contains(&key('b'), &info.id));
  assert!(matches!(
    surfaces.load(&key('b'), &info.id, at(1)),
    Err(MaskSurfaceError::NotFound)
  ));
  // The same bytes again: the same id and file.
  assert_eq!(surfaces.save(&key('a'), &png, &none(), at(2)).unwrap(), info);
  assert_eq!(surfaces.list(&key('a')).len(), 1);
  // An interlaced gray PNG is a surface too (its pixels are the engine's to read).
  let mut interlaced = gray(4, 4, 9);
  interlaced[28] = 1;
  let crc = crc32(&interlaced[12..29]);
  interlaced[29..33].copy_from_slice(&crc.to_be_bytes());
  assert_eq!(inspect_mask_surface_png(&interlaced).unwrap(), (4, 4));
}

#[test]
fn a_damaged_or_replaced_file_is_not_handed_out() {
  let temp = TempDir::new("damaged");
  let surfaces = store(&temp, MaskSurfaceLimits::default());
  let info = surfaces.save(&key('a'), &gray(4, 4, 1), &none(), at(0)).unwrap();
  let dir = temp.0.join(MASK_SURFACES_DIR_NAME).join(key('a'));
  let path = dir.join(format!("{}.png", info.id));
  fs::write(&path, gray(4, 4, 2)).unwrap();
  assert!(matches!(
    surfaces.load(&key('a'), &info.id, at(1)),
    Err(MaskSurfaceError::Corrupt)
  ));
  // Saving the right bytes again repairs it.
  surfaces.save(&key('a'), &gray(4, 4, 1), &none(), at(2)).unwrap();
  assert_eq!(surfaces.load(&key('a'), &info.id, at(3)).unwrap(), gray(4, 4, 1));
  // A symbolic link in its place is not read (even to the right bytes).
  let elsewhere = temp.0.join("elsewhere.png");
  fs::write(&elsewhere, gray(4, 4, 1)).unwrap();
  fs::remove_file(&path).unwrap();
  std::os::unix::fs::symlink(&elsewhere, &path).unwrap();
  assert!(matches!(
    surfaces.load(&key('a'), &info.id, at(4)),
    Err(MaskSurfaceError::Corrupt)
  ));
  assert!(!surfaces.contains(&key('a'), &info.id));
  // A file over the size limit is not read.
  let small = store(
    &temp,
    MaskSurfaceLimits {
      max_bytes: 10,
      ..MaskSurfaceLimits::default()
    },
  );
  fs::remove_file(&path).unwrap();
  fs::write(&path, gray(4, 4, 1)).unwrap();
  assert!(matches!(
    small.load(&key('a'), &info.id, at(5)),
    Err(MaskSurfaceError::Corrupt)
  ));
  assert!(matches!(
    small.save(&key('a'), &gray(4, 4, 1), &none(), at(5)),
    Err(MaskSurfaceError::TooLarge)
  ));
}

#[test]
fn keys_and_ids_are_checked_before_any_path_is_made() {
  let temp = TempDir::new("traversal");
  let surfaces = store(&temp, MaskSurfaceLimits::default());
  let png = gray(2, 2, 3);
  let id = mask_surface_id(&png);
  for bad in [
    "..",
    "../a",
    &key('a').to_uppercase(),
    &key('a')[..63],
    &format!("{}/", &key('a')[..63]),
    "",
  ] {
    assert!(
      matches!(
        surfaces.save(bad, &png, &none(), at(0)),
        Err(MaskSurfaceError::InvalidId)
      ),
      "{bad}"
    );
    assert!(
      matches!(surfaces.load(bad, &id, at(0)), Err(MaskSurfaceError::InvalidId)),
      "{bad}"
    );
    assert!(
      matches!(surfaces.load(&key('a'), bad, at(0)), Err(MaskSurfaceError::InvalidId)),
      "{bad}"
    );
    assert!(!surfaces.contains(&key('a'), bad));
    assert!(surfaces.list(bad).is_empty());
    assert!(matches!(surfaces.forget_photo(bad), Err(MaskSurfaceError::InvalidId)));
  }
  assert!(!temp.0.join(MASK_SURFACES_DIR_NAME).exists(), "nothing was written");
}

#[test]
fn only_still_8_bit_gray_pngs_of_1_to_4096_pixels_are_taken() {
  let invalid = |png: Vec<u8>| match inspect_mask_surface_png(&png) {
    Err(MaskSurfaceError::InvalidPng(reason)) => reason,
    other => panic!("{other:?}"),
  };
  assert_eq!(invalid(b"not a png at all, not at all, no".to_vec()), "not a PNG");
  assert_eq!(invalid(png_with(2, 2, 8, 2, &[], 0)), "not 8-bit grayscale");
  assert_eq!(invalid(png_with(2, 2, 16, 0, &[], 0)), "not 8-bit grayscale");
  assert_eq!(invalid(png_with(2, 2, 4, 0, &[], 0)), "not 8-bit grayscale");
  assert_eq!(invalid(png_with(2, 2, 8, 4, &[], 0)), "not 8-bit grayscale");
  assert_eq!(invalid(png_with(2, 2, 8, 3, &[], 0)), "not 8-bit grayscale");
  assert_eq!(invalid(gray(0, 2, 0)), "a side outside 1..=4096");
  assert_eq!(invalid(gray(4097, 1, 0)), "a side outside 1..=4096");
  assert_eq!(inspect_mask_surface_png(&gray(4096, 1, 0)).unwrap(), (4096, 1));
  assert_eq!(
    invalid(png_with(2, 2, 8, 0, &[chunk(b"tRNS", &[0, 0])], 0)),
    "transparency (tRNS)"
  );
  assert_eq!(
    invalid(png_with(2, 2, 8, 0, &[chunk(b"acTL", &[0; 8])], 0)),
    "an animation (acTL)"
  );
  assert_eq!(
    invalid(png_with(2, 2, 8, 0, &[chunk(b"PLTE", &[0; 3])], 0)),
    "a palette"
  );
  // Ancillary chunks before the data are fine.
  let text = chunk(b"tEXt", b"Software\0NIHO");
  assert_eq!(
    inspect_mask_surface_png(&png_with(3, 2, 8, 0, &[text], 0)).unwrap(),
    (3, 2)
  );
  let mut bad_crc = gray(2, 2, 0);
  bad_crc[30] ^= 1;
  assert_eq!(invalid(bad_crc), "the IHDR checksum does not match");
  let mut truncated = gray(2, 2, 0);
  truncated.truncate(40);
  assert!(matches!(
    inspect_mask_surface_png(&truncated),
    Err(MaskSurfaceError::InvalidPng("a truncated chunk" | "no image data"))
  ));
  let mut no_data = PNG_SIGNATURE.to_vec();
  no_data.extend_from_slice(&gray(2, 2, 0)[8..33]);
  no_data.extend(chunk(b"IEND", &[]));
  assert_eq!(invalid(no_data), "no image data");
  let mut large = gray(2, 2, 0);
  large.resize(MAX_MASK_SURFACE_BYTES + 1, 0);
  assert!(matches!(
    inspect_mask_surface_png(&large),
    Err(MaskSurfaceError::TooLarge)
  ));
  // The store refuses them without writing.
  let temp = TempDir::new("formats");
  let surfaces = store(&temp, MaskSurfaceLimits::default());
  assert!(matches!(
    surfaces.save(&key('a'), &png_with(2, 2, 8, 2, &[], 0), &none(), at(0)),
    Err(MaskSurfaceError::InvalidPng(_))
  ));
  assert!(surfaces.list(&key('a')).is_empty());
}

#[test]
fn a_full_photo_makes_room_by_the_least_recently_used_surface_it_may_drop() {
  let temp = TempDir::new("quota");
  let surfaces = store(
    &temp,
    MaskSurfaceLimits {
      max_per_photo: 3,
      ..MaskSurfaceLimits::default()
    },
  );
  let photo = key('c');
  let ids: Vec<String> = (0..3)
    .map(|fill| {
      surfaces
        .save(&photo, &gray(2, 2, fill), &none(), at(u64::from(fill) * 10))
        .unwrap()
        .id
    })
    .collect();
  // Reading the oldest makes it the most recently used.
  surfaces.load(&photo, &ids[0], at(100)).unwrap();
  let fourth = surfaces.save(&photo, &gray(2, 2, 3), &none(), at(110)).unwrap();
  let mut expected = vec![ids[0].clone(), ids[2].clone(), fourth.id.clone()];
  expected.sort();
  assert_eq!(
    surfaces.list(&photo),
    expected,
    "the least recently used (the second) went"
  );
  // What the saved settings use stays; the next oldest goes instead.
  let keep: BTreeSet<String> = [ids[2].clone()].into_iter().collect();
  let fifth = surfaces.save(&photo, &gray(2, 2, 4), &keep, at(120)).unwrap();
  let mut expected = vec![ids[2].clone(), fourth.id.clone(), fifth.id.clone()];
  expected.sort();
  assert_eq!(surfaces.list(&photo), expected);
  // Nothing may go: the quota error, and nothing is written.
  let all: BTreeSet<String> = surfaces.list(&photo).into_iter().collect();
  assert!(matches!(
    surfaces.save(&photo, &gray(2, 2, 5), &all, at(130)),
    Err(MaskSurfaceError::QuotaExceeded)
  ));
  assert_eq!(surfaces.list(&photo), expected);
  // A surface already there is saved again whatever the quota.
  assert_eq!(surfaces.save(&photo, &gray(2, 2, 4), &all, at(140)).unwrap(), fifth);
  // Another photo has its own quota.
  surfaces.save(&key('d'), &gray(2, 2, 5), &none(), at(150)).unwrap();
}

#[test]
fn forgetting_a_photo_removes_its_surfaces_and_stale_temporaries_are_swept() {
  let temp = TempDir::new("forget");
  let surfaces = store(&temp, MaskSurfaceLimits::default());
  let photo = key('e');
  let info = surfaces.save(&photo, &gray(2, 2, 1), &none(), at(0)).unwrap();
  let dir = temp.0.join(MASK_SURFACES_DIR_NAME).join(&photo);
  // A temporary left by a crash: kept while young, swept when old.
  let temp_file = dir.join(format!("{}.png.tmp", key('f')));
  fs::write(&temp_file, b"partial").unwrap();
  let now = SystemTime::now();
  surfaces.save(&photo, &gray(2, 2, 2), &none(), now).unwrap();
  assert!(temp_file.exists());
  crate::test_support::set_modified(&temp_file, now - Duration::from_secs(2 * 60 * 60));
  surfaces.save(&photo, &gray(2, 2, 3), &none(), now).unwrap();
  assert!(!temp_file.exists());
  // Forgetting removes the surfaces; a foreign file stays (and so the folder).
  let foreign = dir.join("notes.txt");
  fs::write(&foreign, b"x").unwrap();
  surfaces.forget_photo(&photo).unwrap();
  assert!(surfaces.list(&photo).is_empty());
  assert!(!surfaces.contains(&photo, &info.id));
  assert!(foreign.exists());
  fs::remove_file(&foreign).unwrap();
  surfaces.forget_photo(&photo).unwrap();
  assert!(!dir.exists());
  // A photo without surfaces is nothing to forget.
  surfaces.forget_photo(&key('9')).unwrap();
}

#[test]
fn the_settings_name_the_surfaces_they_draw_and_keep() {
  let a = key('a');
  let b = key('b');
  let c = key('c');
  let settings = json!({
    "v": 5,
    "masks": [
      { "id": "m1", "kind": "brush", "surface": { "id": a, "width": 4, "height": 4 }, "adjust": { "exposure": -0.5 } },
      { "id": "m2", "kind": "sky", "enabled": false, "surface": { "id": b, "width": 4, "height": 4 }, "adjust": { "exposure": 1 } },
      { "id": "m3", "kind": "subject", "surface": { "id": c, "width": 4, "height": 4 }, "adjust": { "exposure": 0 } },
      { "id": "m4", "kind": "brush", "enabled": true, "surface": { "id": a, "width": 4, "height": 4 }, "adjust": { "hsl": ["red", { "saturation": -20 }] } },
      { "id": "m5", "kind": "linear", "zero": { "x": 0.5, "y": 0.2 }, "full": { "x": 0.5, "y": 0.5 }, "adjust": { "exposure": 1 } },
      { "id": "m6", "kind": "brush", "surface": { "id": c, "width": 4, "height": 4 }, "adjust": { "hsl": ["blue", { "hue": 0 }] } }
    ]
  });
  assert_eq!(mask_surface_ids(&settings, true), vec![a.clone()]);
  assert_eq!(mask_surface_ids(&settings, false), vec![a, b, c]);
  assert!(mask_surface_ids(&json!({ "exposure": 1 }), false).is_empty());
  assert!(mask_surface_ids(&json!({ "masks": [] }), true).is_empty());
}
