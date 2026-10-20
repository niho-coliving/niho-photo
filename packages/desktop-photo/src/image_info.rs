//! macOS ImageIO でラスタ写真の保存画素寸法と EXIF / HEIF orientation を読む。
//!
//! `sips -g orientation` は Orientation=6 の JPEG でも `<nil>` を返すため、写真を開く metadata には使わない。
//! 画素はここでは展開せず、ImageIO の source properties だけを読む。実際の画素処理は `develop` の sidecar が担う。

use std::path::Path;

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
  use super::RasterInfo;
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
    fn CFRelease(value: CFTypeRef);
  }

  #[link(name = "ImageIO", kind = "framework")]
  extern "C" {
    static kCGImagePropertyPixelWidth: CFStringRef;
    static kCGImagePropertyPixelHeight: CFStringRef;
    static kCGImagePropertyOrientation: CFStringRef;
    fn CGImageSourceCreateWithURL(url: CFURLRef, options: CFDictionaryRef) -> CFTypeRef;
    fn CGImageSourceGetCount(source: CFTypeRef) -> usize;
    fn CGImageSourceGetPrimaryImageIndex(source: CFTypeRef) -> usize;
    fn CGImageSourceGetStatusAtIndex(source: CFTypeRef, index: usize) -> i32;
    fn CGImageSourceCopyPropertiesAtIndex(source: CFTypeRef, index: usize, options: CFDictionaryRef)
      -> CFDictionaryRef;
  }

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

  pub(super) fn read(path: &Path) -> Result<RasterInfo, String> {
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
    let source = OwnedCf(source);
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
}
