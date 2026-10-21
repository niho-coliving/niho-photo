//! macOS ImageIO でラスタ写真の保存画素寸法と EXIF / HEIF orientation を読む。
//!
//! `sips -g orientation` は Orientation=6 の JPEG でも `<nil>` を返すため、写真を開く metadata には使わない。
//! 画素はここでは展開せず、ImageIO の source properties だけを読む。実際の画素処理は `develop` の sidecar が担う。
//!
//! 右パネルの「情報」（niho-photo#43）の撮影条件・カメラ・レンズ・撮影日時・場所も同じ properties から読む
//! （[`read_photo_info`]。RAW も ImageIO が読める範囲）。

use std::path::Path;

/// 写真の情報の文字列（カメラ・レンズの名前）の上限の文字数。EXIF の文字列は長さに上限が無いので、画面に出す前に切る。
const MAX_INFO_TEXT_CHARS: usize = 120;

/// 写真の情報（右パネルの「情報」。niho-photo#43）。ImageIO が primary image の properties から読めた項目だけを Some にする。
#[derive(Debug, Clone, Default, PartialEq)]
pub struct PhotoInfo {
  pub make: Option<String>,
  pub model: Option<String>,
  pub lens: Option<String>,
  /// ISO 感度（EXIF ISOSpeedRatings の最初の値）
  pub iso: Option<f64>,
  /// シャッター速度（秒）
  pub exposure_time_seconds: Option<f64>,
  /// 絞り（F 値）
  pub f_number: Option<f64>,
  /// 焦点距離（mm。35mm 判換算ではない）
  pub focal_length_mm: Option<f64>,
  /// 撮影日時（EXIF DateTimeOriginal、無ければ DateTimeDigitized）。撮影した場所の時計のまま `YYYY-MM-DDTHH:MM:SS`
  /// （時差は付けない）
  pub captured_at: Option<String>,
  /// 向きを反映した寸法（幅・高さの画素）
  pub dimensions: Option<(u64, u64)>,
  /// 撮影した場所
  pub gps: Option<GpsPosition>,
}

/// 撮影した場所（10 進の度。南緯・西経は負）。
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct GpsPosition {
  pub latitude: f64,
  pub longitude: f64,
}

/// 0 より大きい有限の値だけ（ISO・シャッター速度・F 値・焦点距離）。
#[cfg_attr(not(target_os = "macos"), allow(dead_code))]
fn positive(value: Option<f64>) -> Option<f64> {
  value.filter(|value| value.is_finite() && *value > 0.0)
}

/// 前後の空白・NUL を除いた文字列（空なら None。長すぎる文字列は {@link MAX_INFO_TEXT_CHARS} 文字で切る）。
#[cfg_attr(not(target_os = "macos"), allow(dead_code))]
fn clean_text(value: &str) -> Option<String> {
  let trimmed = value.trim_matches(|ch: char| ch.is_whitespace() || ch == '\0');
  (!trimmed.is_empty()).then(|| trimmed.chars().take(MAX_INFO_TEXT_CHARS).collect())
}

/// EXIF の日時（`YYYY:MM:DD HH:MM:SS`）を `YYYY-MM-DDTHH:MM:SS` にする。形の違う値・空の値（`0000:00:00 00:00:00`）は None。
#[cfg_attr(not(target_os = "macos"), allow(dead_code))]
fn exif_date_time(text: &str) -> Option<String> {
  let bytes = text.trim().as_bytes().get(..19)?;
  let separators_ok = matches!(bytes[4], b':' | b'-')
    && matches!(bytes[7], b':' | b'-')
    && matches!(bytes[10], b' ' | b'T')
    && bytes[13] == b':'
    && bytes[16] == b':';
  if !separators_ok {
    return None;
  }
  let number = |start: usize, len: usize| -> Option<u32> {
    let digits = bytes.get(start..start + len)?;
    if !digits.iter().all(u8::is_ascii_digit) {
      return None;
    }
    std::str::from_utf8(digits).ok()?.parse().ok()
  };
  let (year, month, day) = (number(0, 4)?, number(5, 2)?, number(8, 2)?);
  let (hour, minute, second) = (number(11, 2)?, number(14, 2)?, number(17, 2)?);
  if year == 0 || !(1..=12).contains(&month) || !(1..=31).contains(&day) || hour > 23 || minute > 59 || second > 59 {
    return None;
  }
  Some(format!(
    "{year:04}-{month:02}-{day:02}T{hour:02}:{minute:02}:{second:02}"
  ))
}

/// GPS の緯度・経度（度）を符号付きにする。南・西（`negative`）は負。向きの印が無い・知らない印・範囲の外は None。
#[cfg_attr(not(target_os = "macos"), allow(dead_code))]
fn signed_degrees(
  value: Option<f64>,
  reference: Option<&str>,
  positive: char,
  negative: char,
  limit: f64,
) -> Option<f64> {
  let value = value.filter(|value| value.is_finite() && (0.0..=limit).contains(value))?;
  let reference = reference?.trim().chars().next()?.to_ascii_uppercase();
  if reference == positive {
    Some(value)
  } else if reference == negative {
    Some(-value)
  } else {
    None
  }
}

#[cfg_attr(not(target_os = "macos"), allow(dead_code))]
fn gps_position(
  latitude: Option<f64>,
  latitude_ref: Option<&str>,
  longitude: Option<f64>,
  longitude_ref: Option<&str>,
) -> Option<GpsPosition> {
  Some(GpsPosition {
    latitude: signed_degrees(latitude, latitude_ref, 'N', 'S', 90.0)?,
    longitude: signed_degrees(longitude, longitude_ref, 'E', 'W', 180.0)?,
  })
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct RasterInfo {
  pub width: u64,
  pub height: u64,
  /// CGImagePropertyOrientation / EXIF Orientation（1...8）。無い場合は 1。
  pub orientation: u32,
}

impl RasterInfo {
  /// ImageIO が返す保存画素寸法へ EXIF / HEIF orientation を適用した表示寸法。
  pub fn display_dimensions(self) -> Option<(u64, u64)> {
    if self.width == 0 || self.height == 0 || !(1..=8).contains(&self.orientation) {
      return None;
    }
    Some(if matches!(self.orientation, 5..=8) {
      (self.height, self.width)
    } else {
      (self.width, self.height)
    })
  }
}

#[cfg(target_os = "macos")]
mod macos {
  use super::{clean_text, exif_date_time, gps_position, positive, PhotoInfo, RasterInfo};
  use std::ffi::{c_char, c_void};
  use std::os::unix::ffi::OsStrExt;
  use std::path::Path;
  use std::ptr;

  type CFTypeRef = *const c_void;
  type CFURLRef = *const c_void;
  type CFDictionaryRef = *const c_void;
  type CFStringRef = *const c_void;
  type CFIndex = isize;
  type Boolean = u8;

  const CF_NUMBER_SINT64_TYPE: CFIndex = 4;
  const CF_NUMBER_FLOAT64_TYPE: CFIndex = 6;

  #[link(name = "CoreFoundation", kind = "framework")]
  extern "C" {
    fn CFURLCreateFromFileSystemRepresentation(
      allocator: CFTypeRef,
      buffer: *const c_char,
      buf_len: CFIndex,
      is_directory: Boolean,
    ) -> CFURLRef;
    fn CFDictionaryGetValueIfPresent(dictionary: CFDictionaryRef, key: CFTypeRef, value: *mut CFTypeRef) -> Boolean;
    fn CFGetTypeID(value: CFTypeRef) -> usize;
    fn CFNumberGetTypeID() -> usize;
    fn CFNumberGetValue(number: CFTypeRef, number_type: CFIndex, value: *mut c_void) -> Boolean;
    fn CFStringGetLength(string: CFStringRef) -> CFIndex;
    fn CFStringGetMaximumSizeForEncoding(length: CFIndex, encoding: u32) -> CFIndex;
    fn CFStringGetCString(string: CFStringRef, buffer: *mut c_char, buffer_size: CFIndex, encoding: u32) -> Boolean;
    fn CFStringGetTypeID() -> usize;
    fn CFDictionaryGetTypeID() -> usize;
    fn CFArrayGetTypeID() -> usize;
    fn CFArrayGetCount(array: CFTypeRef) -> CFIndex;
    fn CFArrayGetValueAtIndex(array: CFTypeRef, index: CFIndex) -> CFTypeRef;
    fn CFRelease(value: CFTypeRef);
  }

  #[link(name = "ImageIO", kind = "framework")]
  extern "C" {
    static kCGImagePropertyPixelWidth: CFStringRef;
    static kCGImagePropertyPixelHeight: CFStringRef;
    static kCGImagePropertyOrientation: CFStringRef;
    static kCGImagePropertyTIFFDictionary: CFStringRef;
    static kCGImagePropertyTIFFMake: CFStringRef;
    static kCGImagePropertyTIFFModel: CFStringRef;
    static kCGImagePropertyExifDictionary: CFStringRef;
    static kCGImagePropertyExifExposureTime: CFStringRef;
    static kCGImagePropertyExifFNumber: CFStringRef;
    static kCGImagePropertyExifISOSpeedRatings: CFStringRef;
    static kCGImagePropertyExifFocalLength: CFStringRef;
    static kCGImagePropertyExifLensModel: CFStringRef;
    static kCGImagePropertyExifDateTimeOriginal: CFStringRef;
    static kCGImagePropertyExifDateTimeDigitized: CFStringRef;
    static kCGImagePropertyExifAuxDictionary: CFStringRef;
    static kCGImagePropertyExifAuxLensModel: CFStringRef;
    static kCGImagePropertyGPSDictionary: CFStringRef;
    static kCGImagePropertyGPSLatitude: CFStringRef;
    static kCGImagePropertyGPSLatitudeRef: CFStringRef;
    static kCGImagePropertyGPSLongitude: CFStringRef;
    static kCGImagePropertyGPSLongitudeRef: CFStringRef;
    fn CGImageSourceCreateWithURL(url: CFURLRef, options: CFDictionaryRef) -> CFTypeRef;
    fn CGImageSourceGetCount(source: CFTypeRef) -> usize;
    fn CGImageSourceGetPrimaryImageIndex(source: CFTypeRef) -> usize;
    fn CGImageSourceGetStatusAtIndex(source: CFTypeRef, index: usize) -> i32;
    fn CGImageSourceGetType(source: CFTypeRef) -> CFStringRef;
    fn CGImageSourceCopyPropertiesAtIndex(source: CFTypeRef, index: usize, options: CFDictionaryRef)
      -> CFDictionaryRef;
  }

  const UTF8_ENCODING: u32 = 0x0800_0100;

  struct OwnedCf(CFTypeRef);

  impl Drop for OwnedCf {
    fn drop(&mut self) {
      if !self.0.is_null() {
        // SAFETY: `OwnedCf` is only constructed from a Create/Copy result and is released exactly once.
        unsafe { CFRelease(self.0) };
      }
    }
  }

  unsafe fn number(dictionary: CFDictionaryRef, key: CFStringRef) -> Option<i64> {
    let mut value: CFTypeRef = ptr::null();
    if CFDictionaryGetValueIfPresent(dictionary, key, &mut value) == 0
      || value.is_null()
      || CFGetTypeID(value) != CFNumberGetTypeID()
    {
      return None;
    }
    let mut result = 0i64;
    (CFNumberGetValue(value, CF_NUMBER_SINT64_TYPE, (&mut result as *mut i64).cast()) != 0).then_some(result)
  }

  unsafe fn string(value: CFStringRef) -> Option<String> {
    if value.is_null() {
      return None;
    }
    let length = CFStringGetLength(value);
    let capacity = CFStringGetMaximumSizeForEncoding(length, UTF8_ENCODING).checked_add(1)?;
    let mut bytes = vec![0u8; usize::try_from(capacity).ok()?];
    if CFStringGetCString(value, bytes.as_mut_ptr().cast(), capacity, UTF8_ENCODING) == 0 {
      return None;
    }
    let end = bytes.iter().position(|byte| *byte == 0).unwrap_or(bytes.len());
    String::from_utf8(bytes[..end].to_vec()).ok()
  }

  /// 辞書の値（借りた参照。辞書が生きている間だけ使う）。
  unsafe fn value(dictionary: CFDictionaryRef, key: CFStringRef) -> Option<CFTypeRef> {
    let mut value: CFTypeRef = ptr::null();
    (CFDictionaryGetValueIfPresent(dictionary, key, &mut value) != 0 && !value.is_null()).then_some(value)
  }

  /// 辞書の中の辞書（`{TIFF}`・`{Exif}` など。借りた参照）。
  unsafe fn dictionary(dictionary: CFDictionaryRef, key: CFStringRef) -> Option<CFDictionaryRef> {
    value(dictionary, key).filter(|value| CFGetTypeID(*value) == CFDictionaryGetTypeID())
  }

  unsafe fn float_value(value: CFTypeRef) -> Option<f64> {
    if CFGetTypeID(value) != CFNumberGetTypeID() {
      return None;
    }
    let mut result = 0f64;
    (CFNumberGetValue(value, CF_NUMBER_FLOAT64_TYPE, (&mut result as *mut f64).cast()) != 0).then_some(result)
  }

  /// 数（配列なら最初の値。EXIF の ISOSpeedRatings は配列）。
  unsafe fn float(dictionary: CFDictionaryRef, key: CFStringRef) -> Option<f64> {
    let value = value(dictionary, key)?;
    if CFGetTypeID(value) == CFArrayGetTypeID() {
      if CFArrayGetCount(value) < 1 {
        return None;
      }
      let first = CFArrayGetValueAtIndex(value, 0);
      return (!first.is_null()).then(|| float_value(first)).flatten();
    }
    float_value(value)
  }

  /// 文字列（前後の空白を除く。空なら None）。
  unsafe fn text(dictionary: CFDictionaryRef, key: CFStringRef) -> Option<String> {
    let value = value(dictionary, key).filter(|value| CFGetTypeID(*value) == CFStringGetTypeID())?;
    clean_text(&string(value)?)
  }

  fn source(path: &Path) -> Result<OwnedCf, String> {
    let bytes = path.as_os_str().as_bytes();
    let length = CFIndex::try_from(bytes.len()).map_err(|_| "file path is too long".to_string())?;
    // SAFETY: `bytes` stays alive for this call. Core Foundation copies the file-system representation.
    let url = unsafe { CFURLCreateFromFileSystemRepresentation(ptr::null(), bytes.as_ptr().cast(), length, 0) };
    if url.is_null() {
      return Err("ImageIO could not create a file URL".into());
    }
    let url = OwnedCf(url);
    // SAFETY: `url` is a retained CFURL and ImageIO accepts null options.
    let source = unsafe { CGImageSourceCreateWithURL(url.0, ptr::null()) };
    if source.is_null() {
      return Err("ImageIO could not open the image".into());
    }
    Ok(OwnedCf(source))
  }

  pub(super) fn read(path: &Path) -> Result<RasterInfo, String> {
    let source = source(path)?;
    // 非incremental source は完全に読めるときだけ Complete (0)。metadataだけ偶然読める壊れた入力を受け入れない。
    // SAFETY: `source` is a valid CGImageSource.
    let count = unsafe { CGImageSourceGetCount(source.0) };
    let index = unsafe { CGImageSourceGetPrimaryImageIndex(source.0) };
    if count == 0 || index >= count || unsafe { CGImageSourceGetStatusAtIndex(source.0, index) } != 0 {
      return Err("ImageIO found incomplete or invalid image data".into());
    }
    // SAFETY: `source` and its primary index are valid; this is the same image selected by apple-raw-linear raster.
    let properties = unsafe { CGImageSourceCopyPropertiesAtIndex(source.0, index, ptr::null()) };
    if properties.is_null() {
      return Err("ImageIO returned no image properties".into());
    }
    let properties = OwnedCf(properties);
    // SAFETY: dictionary and process-lifetime ImageIO key constants are valid during these lookups.
    let (width, height, orientation) = unsafe {
      (
        number(properties.0, kCGImagePropertyPixelWidth),
        number(properties.0, kCGImagePropertyPixelHeight),
        number(properties.0, kCGImagePropertyOrientation).unwrap_or(1),
      )
    };
    let width = width
      .filter(|value| *value > 0)
      .ok_or_else(|| "ImageIO returned no valid pixel width".to_string())? as u64;
    let height = height
      .filter(|value| *value > 0)
      .ok_or_else(|| "ImageIO returned no valid pixel height".to_string())? as u64;
    let orientation = u32::try_from(orientation)
      .ok()
      .filter(|value| (1..=8).contains(value))
      .ok_or_else(|| "ImageIO returned an invalid orientation".to_string())?;
    Ok(RasterInfo {
      width,
      height,
      orientation,
    })
  }

  pub(super) fn type_identifier(path: &Path) -> Option<String> {
    let source = source(path).ok()?;
    // SAFETY: `source` is a valid CGImageSource. The returned type string is borrowed for the source lifetime.
    unsafe { string(CGImageSourceGetType(source.0)) }
  }

  /// 写真の情報。開けない・properties の無いファイルは空（全部 None）。画を最後まで読めるか（status）は問わない
  /// （画面に出すだけで、画素は使わない）。
  pub(super) fn read_info(path: &Path) -> PhotoInfo {
    let Ok(source) = source(path) else {
      return PhotoInfo::default();
    };
    // SAFETY: `source` is a valid CGImageSource.
    let (count, index) = unsafe {
      (
        CGImageSourceGetCount(source.0),
        CGImageSourceGetPrimaryImageIndex(source.0),
      )
    };
    if count == 0 || index >= count {
      return PhotoInfo::default();
    }
    // SAFETY: `source` and its primary index are valid.
    let properties = unsafe { CGImageSourceCopyPropertiesAtIndex(source.0, index, ptr::null()) };
    if properties.is_null() {
      return PhotoInfo::default();
    }
    let properties = OwnedCf(properties);
    // SAFETY: the nested dictionaries and values are borrowed from `properties`, which outlives every lookup below.
    // The ImageIO key constants live for the whole process.
    unsafe {
      let root = properties.0;
      let tiff = dictionary(root, kCGImagePropertyTIFFDictionary);
      let exif = dictionary(root, kCGImagePropertyExifDictionary);
      let exif_aux = dictionary(root, kCGImagePropertyExifAuxDictionary);
      let gps = dictionary(root, kCGImagePropertyGPSDictionary);
      let raster = RasterInfo {
        width: number(root, kCGImagePropertyPixelWidth)
          .and_then(|value| u64::try_from(value).ok())
          .unwrap_or(0),
        height: number(root, kCGImagePropertyPixelHeight)
          .and_then(|value| u64::try_from(value).ok())
          .unwrap_or(0),
        // 向きが読めない・範囲の外なら向きを当てない
        orientation: number(root, kCGImagePropertyOrientation)
          .and_then(|value| u32::try_from(value).ok())
          .filter(|value| (1..=8).contains(value))
          .unwrap_or(1),
      };
      let captured_at = exif.and_then(|exif| {
        text(exif, kCGImagePropertyExifDateTimeOriginal)
          .and_then(|value| exif_date_time(&value))
          .or_else(|| text(exif, kCGImagePropertyExifDateTimeDigitized).and_then(|value| exif_date_time(&value)))
      });
      PhotoInfo {
        make: tiff.and_then(|tiff| text(tiff, kCGImagePropertyTIFFMake)),
        model: tiff.and_then(|tiff| text(tiff, kCGImagePropertyTIFFModel)),
        lens: exif
          .and_then(|exif| text(exif, kCGImagePropertyExifLensModel))
          .or_else(|| exif_aux.and_then(|aux| text(aux, kCGImagePropertyExifAuxLensModel))),
        iso: positive(exif.and_then(|exif| float(exif, kCGImagePropertyExifISOSpeedRatings))),
        exposure_time_seconds: positive(exif.and_then(|exif| float(exif, kCGImagePropertyExifExposureTime))),
        f_number: positive(exif.and_then(|exif| float(exif, kCGImagePropertyExifFNumber))),
        focal_length_mm: positive(exif.and_then(|exif| float(exif, kCGImagePropertyExifFocalLength))),
        captured_at,
        dimensions: raster.display_dimensions(),
        gps: gps.and_then(|gps| {
          gps_position(
            float(gps, kCGImagePropertyGPSLatitude),
            text(gps, kCGImagePropertyGPSLatitudeRef).as_deref(),
            float(gps, kCGImagePropertyGPSLongitude),
            text(gps, kCGImagePropertyGPSLongitudeRef).as_deref(),
          )
        }),
      }
    }
  }
}

/// Primary image の properties を読む。失敗文はログ専用で、ページへ直接返してはならない。
pub fn read_raster_info(path: &Path) -> Result<RasterInfo, String> {
  #[cfg(target_os = "macos")]
  {
    macos::read(path)
  }
  #[cfg(not(target_os = "macos"))]
  {
    let _ = path;
    Err("ImageIO is only available on macOS".into())
  }
}

/// ImageIOが実データから認識したUTType identifier。取得不能はNoneで、拡張子から推測した値は返さない。
pub fn detected_ut_type(path: &Path) -> Option<String> {
  #[cfg(target_os = "macos")]
  {
    macos::type_identifier(path)
  }
  #[cfg(not(target_os = "macos"))]
  {
    let _ = path;
    None
  }
}

/// 写真の情報（右パネルの「情報」。niho-photo#43）を ImageIO で読む。画素は展開しない。読めない項目は None で、開けない・
/// 壊れたファイルも失敗にせず全部 None を返す。
pub fn read_photo_info(path: &Path) -> PhotoInfo {
  #[cfg(target_os = "macos")]
  {
    macos::read_info(path)
  }
  #[cfg(not(target_os = "macos"))]
  {
    let _ = path;
    PhotoInfo::default()
  }
}

#[cfg(test)]
mod tests {
  use super::*;

  #[test]
  #[ignore = "set NIHO_IMAGEIO_TEST_PHOTO to a 640x480 JPEG with EXIF Orientation=6"]
  fn real_imageio_reads_exif_orientation_without_decoding_pixels() {
    let path = std::env::var_os("NIHO_IMAGEIO_TEST_PHOTO")
      .map(std::path::PathBuf::from)
      .expect("NIHO_IMAGEIO_TEST_PHOTO");
    let info = read_raster_info(&path).unwrap();
    assert_eq!(
      info,
      RasterInfo {
        width: 640,
        height: 480,
        orientation: 6
      }
    );
    assert_eq!(info.display_dimensions(), Some((480, 640)));
  }

  // --- 写真の情報（niho-photo#43）: 整える規則 ---

  #[test]
  fn exif_date_times_become_wall_clock_iso_strings() {
    assert_eq!(
      exif_date_time("2024:05:01 10:30:15").as_deref(),
      Some("2024-05-01T10:30:15")
    );
    // 後ろの NUL・空白、`-` と `T` の区切りも受ける
    assert_eq!(
      exif_date_time(" 2024-05-01T10:30:15\0").as_deref(),
      Some("2024-05-01T10:30:15")
    );
    for bad in [
      "0000:00:00 00:00:00",
      "    :  :     :  :  ",
      "2024:13:01 10:30:15",
      "2024:05:01 24:00:00",
      "2024:05:01",
      "2024/05/01 10:30:15",
      "",
    ] {
      assert_eq!(exif_date_time(bad), None, "{bad:?}");
    }
  }

  #[test]
  fn gps_positions_are_signed_by_their_reference_and_range_checked() {
    let position = |lat: f64, lat_ref: &str, lon: f64, lon_ref: &str| {
      gps_position(Some(lat), Some(lat_ref), Some(lon), Some(lon_ref))
    };
    assert_eq!(
      position(35.5, "N", 139.25, "E"),
      Some(GpsPosition {
        latitude: 35.5,
        longitude: 139.25
      })
    );
    assert_eq!(
      position(12.5, "s", 45.25, "w"),
      Some(GpsPosition {
        latitude: -12.5,
        longitude: -45.25
      })
    );
    // 向きの印が無い・知らない印・範囲の外・非有限は出さない（場所を取り違えない）
    assert_eq!(gps_position(Some(35.5), None, Some(139.25), Some("E")), None);
    assert_eq!(position(35.5, "X", 139.25, "E"), None);
    assert_eq!(position(90.5, "N", 139.25, "E"), None);
    assert_eq!(position(35.5, "N", 180.5, "E"), None);
    assert_eq!(position(f64::NAN, "N", 139.25, "E"), None);
    assert_eq!(gps_position(None, Some("N"), Some(139.25), Some("E")), None);
  }

  #[test]
  fn info_text_and_numbers_drop_empty_and_invalid_values() {
    assert_eq!(clean_text("  NIHO 35mm \0").as_deref(), Some("NIHO 35mm"));
    assert_eq!(clean_text(" \0 "), None);
    assert_eq!(
      clean_text(&"a".repeat(MAX_INFO_TEXT_CHARS + 10)).map(|text| text.chars().count()),
      Some(MAX_INFO_TEXT_CHARS)
    );
    assert_eq!(positive(Some(400.0)), Some(400.0));
    for bad in [Some(0.0), Some(-1.0), Some(f64::INFINITY), Some(f64::NAN), None] {
      assert_eq!(positive(bad), None);
    }
  }

  // --- 写真の情報: 実際の ImageIO で、合成のファイルから読む ---

  #[cfg(target_os = "macos")]
  mod imageio {
    use super::super::*;
    use std::fs;
    use std::path::PathBuf;
    use std::sync::atomic::{AtomicU64, Ordering};

    /// テストごとの一時フォルダ（Drop で消す）。
    struct TempDir(PathBuf);

    impl TempDir {
      fn new(name: &str) -> Self {
        static COUNTER: AtomicU64 = AtomicU64::new(1);
        let dir = std::env::temp_dir().join(format!(
          "niho-image-info-{name}-{}-{}",
          std::process::id(),
          COUNTER.fetch_add(1, Ordering::SeqCst)
        ));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        Self(dir)
      }

      fn file(&self, name: &str, bytes: &[u8]) -> PathBuf {
        let path = self.0.join(name);
        fs::write(&path, bytes).unwrap();
        path
      }
    }

    impl Drop for TempDir {
      fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.0);
      }
    }

    /// 2×2 の RGB の PNG（library_tests.rs と同じ合成の画。EXIF は無い）。
    const PNG_2X2: &[u8] = &[
      0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d, 0x49, 0x48, 0x44, 0x52, 0x00, 0x00, 0x00,
      0x02, 0x00, 0x00, 0x00, 0x02, 0x08, 0x02, 0x00, 0x00, 0x00, 0xfd, 0xd4, 0x9a, 0x73, 0x00, 0x00, 0x00, 0x14, 0x49,
      0x44, 0x41, 0x54, 0x78, 0xda, 0x63, 0xf8, 0xcf, 0xc0, 0xc0, 0xc0, 0xc0, 0xc0, 0xc4, 0xc0, 0xc0, 0xc0, 0xc0, 0xc0,
      0x00, 0x00, 0x0d, 0x1d, 0x01, 0x03, 0x6a, 0xc2, 0x9b, 0xe9, 0x00, 0x00, 0x00, 0x00, 0x49, 0x45, 0x4e, 0x44, 0xae,
      0x42, 0x60, 0x82,
    ];

    /// 合成の baseline JPEG（8 bit・灰色 1 成分・`width`×8 画素。各ブロックは DC の差 0 と EOB だけ = 一様な灰色）。
    /// `app1` があれば SOI の直後に APP1 として入れる。
    fn synthetic_jpeg(width: u16, app1: Option<&[u8]>) -> Vec<u8> {
      assert!(width % 8 == 0 && (8..=32).contains(&width));
      let mut jpeg = vec![0xff, 0xd8];
      if let Some(payload) = app1 {
        jpeg.extend_from_slice(&[0xff, 0xe1]);
        jpeg.extend_from_slice(&u16::try_from(payload.len() + 2).unwrap().to_be_bytes());
        jpeg.extend_from_slice(payload);
      }
      // DQT（表 0。全部 1）
      jpeg.extend_from_slice(&[0xff, 0xdb, 0x00, 0x43, 0x00]);
      jpeg.extend_from_slice(&[1; 64]);
      // SOF0（8 bit・高さ 8・幅・1 成分: ID 1・1×1・表 0）
      jpeg.extend_from_slice(&[0xff, 0xc0, 0x00, 0x0b, 0x08, 0x00, 0x08]);
      jpeg.extend_from_slice(&width.to_be_bytes());
      jpeg.extend_from_slice(&[0x01, 0x01, 0x11, 0x00]);
      // DHT（DC 表 0 と AC 表 0。どちらも 1 bit の符号 `0` が記号 0 = DC の差 0 / EOB）
      for class in [0x00, 0x10] {
        jpeg.extend_from_slice(&[0xff, 0xc4, 0x00, 0x14, class, 0x01]);
        jpeg.extend_from_slice(&[0; 15]);
        jpeg.push(0x00);
      }
      // SOS（1 成分・表 0 / 0・Ss 0・Se 63）
      jpeg.extend_from_slice(&[0xff, 0xda, 0x00, 0x08, 0x01, 0x01, 0x00, 0x00, 0x3f, 0x00]);
      // 符号: ブロックごとに 2 bit（`0` `0`）、残りは 1 で埋める
      let bits = usize::from(width / 8) * 2;
      let mut scan = vec![0u8; bits.div_ceil(8)];
      for bit in bits..scan.len() * 8 {
        scan[bit / 8] |= 0x80 >> (bit % 8);
      }
      jpeg.extend_from_slice(&scan);
      jpeg.extend_from_slice(&[0xff, 0xd9]);
      jpeg
    }

    /// IFD の 1 項目（tag・型・数・値のバイト列。big endian）。
    type Entry = (u16, u16, u32, Vec<u8>);

    fn ascii(tag: u16, text: &str) -> Entry {
      let mut bytes = text.as_bytes().to_vec();
      bytes.push(0);
      (tag, 2, u32::try_from(bytes.len()).unwrap(), bytes)
    }

    fn short(tag: u16, value: u16) -> Entry {
      (tag, 3, 1, value.to_be_bytes().to_vec())
    }

    fn long(tag: u16, value: u32) -> Entry {
      (tag, 4, 1, value.to_be_bytes().to_vec())
    }

    fn rationals(tag: u16, values: &[(u32, u32)]) -> Entry {
      let bytes = values
        .iter()
        .flat_map(|(numerator, denominator)| [numerator.to_be_bytes(), denominator.to_be_bytes()].concat())
        .collect();
      (tag, 5, u32::try_from(values.len()).unwrap(), bytes)
    }

    /// TIFF の頭から `start` の位置に置く IFD（4 バイトを超える値は項目の後ろに並べる）。
    fn ifd(start: u32, entries: &[Entry]) -> Vec<u8> {
      let data_start = start as usize + 2 + entries.len() * 12 + 4;
      let mut head = u16::try_from(entries.len()).unwrap().to_be_bytes().to_vec();
      let mut data = Vec::new();
      for (tag, kind, count, bytes) in entries {
        head.extend_from_slice(&tag.to_be_bytes());
        head.extend_from_slice(&kind.to_be_bytes());
        head.extend_from_slice(&count.to_be_bytes());
        if bytes.len() <= 4 {
          let mut inline = bytes.clone();
          inline.resize(4, 0);
          head.extend_from_slice(&inline);
        } else {
          head.extend_from_slice(&u32::try_from(data_start + data.len()).unwrap().to_be_bytes());
          data.extend_from_slice(bytes);
          if data.len() % 2 == 1 {
            data.push(0);
          }
        }
      }
      head.extend_from_slice(&[0, 0, 0, 0]);
      head.extend_from_slice(&data);
      head
    }

    /// APP1 の中身（`Exif\0\0` と TIFF。IFD0 → Exif IFD → GPS IFD の順に置く）。
    fn exif_payload(ifd0: &[Entry], exif: &[Entry], gps: &[Entry]) -> Vec<u8> {
      let with_pointers = |exif_at: u32, gps_at: u32| {
        let mut entries = ifd0.to_vec();
        entries.push(long(0x8769, exif_at));
        entries.push(long(0x8825, gps_at));
        entries.sort_by_key(|entry| entry.0);
        entries
      };
      let exif_at = 8 + u32::try_from(ifd(8, &with_pointers(0, 0)).len()).unwrap();
      let exif_ifd = ifd(exif_at, exif);
      let gps_at = exif_at + u32::try_from(exif_ifd.len()).unwrap();
      let mut payload = b"Exif\0\0MM\0\x2a\0\0\0\x08".to_vec();
      payload.extend_from_slice(&ifd(8, &with_pointers(exif_at, gps_at)));
      payload.extend_from_slice(&exif_ifd);
      payload.extend_from_slice(&ifd(gps_at, gps));
      payload
    }

    /// 合成の撮影条件（実在の写真・場所ではない。南緯・西経で符号を確かめる）。
    fn synthetic_exif() -> Vec<u8> {
      exif_payload(
        &[
          ascii(0x010f, "NIHO"),
          ascii(0x0110, "NIHO Test Camera"),
          // 右に 90° 回す（表示の寸法は幅と高さが入れ替わる）
          short(0x0112, 6),
        ],
        &[
          rationals(0x829a, &[(1, 250)]),
          rationals(0x829d, &[(28, 10)]),
          short(0x8827, 400),
          (0x9000, 7, 4, b"0232".to_vec()),
          ascii(0x9003, "2024:05:01 10:30:15"),
          rationals(0x920a, &[(35, 1)]),
          ascii(0xa434, "NIHO 35mm F2.8"),
        ],
        &[
          (0x0000, 1, 4, vec![2, 3, 0, 0]),
          ascii(0x0001, "S"),
          rationals(0x0002, &[(12, 1), (30, 1), (0, 1)]),
          ascii(0x0003, "W"),
          rationals(0x0004, &[(45, 1), (15, 1), (36, 1)]),
        ],
      )
    }

    #[test]
    fn reads_shooting_conditions_camera_lens_date_and_place_from_a_synthetic_jpeg() {
      let temp = TempDir::new("exif");
      let path = temp.file("synthetic.JPG", &synthetic_jpeg(16, Some(&synthetic_exif())));
      let info = read_photo_info(&path);
      assert_eq!(info.make.as_deref(), Some("NIHO"));
      assert_eq!(info.model.as_deref(), Some("NIHO Test Camera"));
      assert_eq!(info.lens.as_deref(), Some("NIHO 35mm F2.8"));
      assert_eq!(info.iso, Some(400.0));
      assert!((info.exposure_time_seconds.unwrap() - 0.004).abs() < 1e-9, "{info:?}");
      assert!((info.f_number.unwrap() - 2.8).abs() < 1e-9, "{info:?}");
      assert_eq!(info.focal_length_mm, Some(35.0));
      assert_eq!(info.captured_at.as_deref(), Some("2024-05-01T10:30:15"));
      // 16×8 の画を Orientation=6 で表示すると 8×16
      assert_eq!(info.dimensions, Some((8, 16)));
      let gps = info.gps.expect("GPS");
      assert!((gps.latitude + 12.5).abs() < 1e-6, "{gps:?}");
      assert!((gps.longitude + 45.26).abs() < 1e-6, "{gps:?}");
    }

    #[test]
    fn jpeg_and_png_without_exif_have_only_their_dimensions() {
      let temp = TempDir::new("plain");
      let jpeg = temp.file("plain.jpg", &synthetic_jpeg(16, None));
      // 合成の JPEG は ImageIO が最後まで読める正しい画（写真を開く検査と同じ読み方）
      assert_eq!(read_raster_info(&jpeg).unwrap().display_dimensions(), Some((16, 8)));
      assert_eq!(
        read_photo_info(&jpeg),
        PhotoInfo {
          dimensions: Some((16, 8)),
          ..PhotoInfo::default()
        }
      );
      let png = temp.file("plain.png", PNG_2X2);
      assert_eq!(
        read_photo_info(&png),
        PhotoInfo {
          dimensions: Some((2, 2)),
          ..PhotoInfo::default()
        }
      );
    }

    #[test]
    fn broken_or_missing_files_read_as_empty_without_failing() {
      let temp = TempDir::new("broken");
      let truncated_exif = {
        let mut bytes = synthetic_jpeg(16, Some(&synthetic_exif()));
        bytes.truncate(40);
        bytes
      };
      for (name, bytes) in [
        ("empty.jpg", Vec::new()),
        ("garbage.jpg", b"\xff\xd8\xff not really a jpeg".to_vec()),
        ("header.tif", b"II".to_vec()),
        ("truncated.jpg", truncated_exif),
      ] {
        let path = temp.file(name, &bytes);
        let info = read_photo_info(&path);
        // 読めた項目があっても形は正しい（落ちない・非有限の値を出さない）
        assert!(info.iso.map_or(true, f64::is_finite), "{name}: {info:?}");
        assert!(info.gps.is_none(), "{name}: {info:?}");
        assert!(info.dimensions.is_none(), "{name}: {info:?}");
      }
      assert_eq!(read_photo_info(&temp.0.join("missing.jpg")), PhotoInfo::default());
    }
  }
}
