//! 写真入力の能力レジストリ。
//!
//! ファイル選択、フォルダ走査、open/thumbnail/develop の内容検査はこの定義を共有する。一覧走査では拡張子だけを使い、
//! ファイルの中身は読まない。実際に写真を使う段階で [`validate_photo`] が先頭だけを読み、拡張子偽装・空ファイル・
//! クラウド上だけにあるファイルを、パスを画面やログへ出さずに拒否する。

use crate::common::{code, PageError, StaticPageError};
use std::fs::File;
use std::io::{self, Read};
use std::path::Path;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum PhotoKind {
  Raster,
  Raw,
}

impl PhotoKind {
  pub const fn as_str(self) -> &'static str {
    match self {
      Self::Raster => "raster",
      Self::Raw => "raw",
    }
  }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum CapabilityStage {
  Decoder,
  Thumbnail,
  Metadata,
  FullRender,
}

impl CapabilityStage {
  pub const fn as_str(self) -> &'static str {
    match self {
      Self::Decoder => "decoder",
      Self::Thumbnail => "thumbnail",
      Self::Metadata => "metadata",
      Self::FullRender => "fullRender",
    }
  }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct StageSupport {
  pub decoder: bool,
  pub thumbnail: bool,
  pub metadata: bool,
  pub full_render: bool,
}

impl StageSupport {
  pub const fn supports(self, stage: CapabilityStage) -> bool {
    match stage {
      CapabilityStage::Decoder => self.decoder,
      CapabilityStage::Thumbnail => self.thumbnail,
      CapabilityStage::Metadata => self.metadata,
      CapabilityStage::FullRender => self.full_render,
    }
  }
}

const ALL_STAGES: StageSupport = StageSupport {
  decoder: true,
  thumbnail: true,
  metadata: true,
  full_render: true,
};

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SignaturePolicy {
  Jpeg,
  Png,
  Tiff,
  Heif,
  Rw2,
  /// 形式固有の完全な判定は実decoderへ委ねる。ただし、別の強いsignatureに偽装した入力はここで拒否する。
  DecoderProbe,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct PhotoCapability {
  pub format: &'static str,
  pub extension: &'static str,
  pub kind: PhotoKind,
  pub mime_types: &'static [&'static str],
  pub ut_types: &'static [&'static str],
  pub signature: SignaturePolicy,
  pub stages: StageSupport,
}

const JPEG_MIMES: &[&str] = &["image/jpeg"];
const JPEG_UTIS: &[&str] = &["public.jpeg"];
const PNG_MIMES: &[&str] = &["image/png"];
const PNG_UTIS: &[&str] = &["public.png"];
const TIFF_MIMES: &[&str] = &["image/tiff"];
const TIFF_UTIS: &[&str] = &["public.tiff"];
const HEIC_MIMES: &[&str] = &["image/heic", "image/heif"];
const HEIC_UTIS: &[&str] = &["public.heic", "public.heif"];
const RW2_MIMES: &[&str] = &["image/x-panasonic-rw2", "image/x-panasonic-raw"];
const RW2_UTIS: &[&str] = &["com.panasonic.rw2-raw-image", "com.panasonic.raw-image"];
const RAW_MIMES: &[&str] = &["image/x-raw"];
const RAW_UTIS: &[&str] = &["public.camera-raw-image"];

macro_rules! capability {
  ($format:literal, $extension:literal, $kind:ident, $mimes:ident, $utis:ident, $signature:ident) => {
    PhotoCapability {
      format: $format,
      extension: $extension,
      kind: PhotoKind::$kind,
      mime_types: $mimes,
      ut_types: $utis,
      signature: SignaturePolicy::$signature,
      stages: ALL_STAGES,
    }
  };
}

/// UIに表示する「対応形式」とpicker/走査の許可拡張子の正本。
///
/// RAWの登録はdecoderの到達可能性を表し、すべてのOS・カメラ機種で実証済みという意味ではない。
pub const PHOTO_CAPABILITIES: &[PhotoCapability] = &[
  capability!("jpeg", "jpg", Raster, JPEG_MIMES, JPEG_UTIS, Jpeg),
  capability!("jpeg", "jpeg", Raster, JPEG_MIMES, JPEG_UTIS, Jpeg),
  capability!("png", "png", Raster, PNG_MIMES, PNG_UTIS, Png),
  capability!("tiff", "tif", Raster, TIFF_MIMES, TIFF_UTIS, Tiff),
  capability!("tiff", "tiff", Raster, TIFF_MIMES, TIFF_UTIS, Tiff),
  capability!("heic", "heic", Raster, HEIC_MIMES, HEIC_UTIS, Heif),
  capability!("heif", "heif", Raster, HEIC_MIMES, HEIC_UTIS, Heif),
  capability!("dng", "dng", Raw, RAW_MIMES, RAW_UTIS, DecoderProbe),
  capability!("rw2", "rw2", Raw, RW2_MIMES, RW2_UTIS, Rw2),
  capability!("cr2", "cr2", Raw, RAW_MIMES, RAW_UTIS, DecoderProbe),
  capability!("cr3", "cr3", Raw, RAW_MIMES, RAW_UTIS, DecoderProbe),
  capability!("crw", "crw", Raw, RAW_MIMES, RAW_UTIS, DecoderProbe),
  capability!("nef", "nef", Raw, RAW_MIMES, RAW_UTIS, DecoderProbe),
  capability!("nrw", "nrw", Raw, RAW_MIMES, RAW_UTIS, DecoderProbe),
  capability!("arw", "arw", Raw, RAW_MIMES, RAW_UTIS, DecoderProbe),
  capability!("srf", "srf", Raw, RAW_MIMES, RAW_UTIS, DecoderProbe),
  capability!("sr2", "sr2", Raw, RAW_MIMES, RAW_UTIS, DecoderProbe),
  capability!("raf", "raf", Raw, RAW_MIMES, RAW_UTIS, DecoderProbe),
  capability!("orf", "orf", Raw, RAW_MIMES, RAW_UTIS, DecoderProbe),
  capability!("pef", "pef", Raw, RAW_MIMES, RAW_UTIS, DecoderProbe),
  capability!("srw", "srw", Raw, RAW_MIMES, RAW_UTIS, DecoderProbe),
  capability!("rwl", "rwl", Raw, RAW_MIMES, RAW_UTIS, DecoderProbe),
  capability!("3fr", "3fr", Raw, RAW_MIMES, RAW_UTIS, DecoderProbe),
  capability!("fff", "fff", Raw, RAW_MIMES, RAW_UTIS, DecoderProbe),
  capability!("iiq", "iiq", Raw, RAW_MIMES, RAW_UTIS, DecoderProbe),
  capability!("erf", "erf", Raw, RAW_MIMES, RAW_UTIS, DecoderProbe),
  capability!("mef", "mef", Raw, RAW_MIMES, RAW_UTIS, DecoderProbe),
  capability!("mos", "mos", Raw, RAW_MIMES, RAW_UTIS, DecoderProbe),
  capability!("mrw", "mrw", Raw, RAW_MIMES, RAW_UTIS, DecoderProbe),
  capability!("x3f", "x3f", Raw, RAW_MIMES, RAW_UTIS, DecoderProbe),
  capability!("raw", "raw", Raw, RAW_MIMES, RAW_UTIS, DecoderProbe),
  capability!("kdc", "kdc", Raw, RAW_MIMES, RAW_UTIS, DecoderProbe),
  capability!("dcr", "dcr", Raw, RAW_MIMES, RAW_UTIS, DecoderProbe),
  capability!("gpr", "gpr", Raw, RAW_MIMES, RAW_UTIS, DecoderProbe),
];

pub const PHOTO_CAPABILITY_COUNT: usize = PHOTO_CAPABILITIES.len();

/// 既存API。値は [`PHOTO_CAPABILITIES`] からconst生成し、pickerと走査が別の許可一覧を持たないようにする。
pub const PHOTO_FILE_EXTENSIONS: [&str; PHOTO_CAPABILITY_COUNT] = {
  let mut extensions = [""; PHOTO_CAPABILITY_COUNT];
  let mut index = 0;
  while index < PHOTO_CAPABILITY_COUNT {
    extensions[index] = PHOTO_CAPABILITIES[index].extension;
    index += 1;
  }
  extensions
};

pub fn capability_for_file_name(file_name: &str) -> Option<&'static PhotoCapability> {
  let (_, extension) = file_name.rsplit_once('.')?;
  capability_for_extension(extension)
}

pub fn capability_for_extension(extension: &str) -> Option<&'static PhotoCapability> {
  PHOTO_CAPABILITIES
    .iter()
    .find(|capability| capability.extension.eq_ignore_ascii_case(extension))
}

pub fn capability_for_mime(mime: &str) -> Option<&'static PhotoCapability> {
  PHOTO_CAPABILITIES.iter().find(|capability| {
    capability
      .mime_types
      .iter()
      .any(|candidate| candidate.eq_ignore_ascii_case(mime))
  })
}

pub fn capability_for_ut_type(ut_type: &str) -> Option<&'static PhotoCapability> {
  PHOTO_CAPABILITIES.iter().find(|capability| {
    capability
      .ut_types
      .iter()
      .any(|candidate| candidate.eq_ignore_ascii_case(ut_type))
  })
}

fn is_jpeg(bytes: &[u8]) -> bool {
  bytes.starts_with(&[0xff, 0xd8, 0xff])
}

fn is_png(bytes: &[u8]) -> bool {
  bytes.starts_with(&[0x89, b'P', b'N', b'G', 0x0d, 0x0a, 0x1a, 0x0a])
}

fn is_tiff(bytes: &[u8]) -> bool {
  bytes.starts_with(b"II*\0") || bytes.starts_with(b"MM\0*")
}

fn is_rw2(bytes: &[u8]) -> bool {
  bytes.starts_with(b"IIU\0")
}

/// `ftyp`だけを事前検査する上限。通常のbrand列（数十byte）より十分大きく、写真全体は読まない。
const MAX_FTYP_BOX_BYTES: usize = 64 * 1024;

fn ftyp_layout(bytes: &[u8]) -> Option<(usize, usize, usize)> {
  if bytes.len() < 8 || &bytes[4..8] != b"ftyp" {
    return None;
  }
  let size32 = u32::from_be_bytes(bytes[..4].try_into().ok()?);
  let (box_size, major_brand, compatible_brands) = if size32 == 1 {
    let size64 = u64::from_be_bytes(bytes.get(8..16)?.try_into().ok()?);
    (usize::try_from(size64).ok()?, 16, 24)
  } else {
    // size=0（EOFまで）は、後続media boxまでbrandとして扱わないためftypでは受け入れない。
    (usize::try_from(size32).ok()?, 8, 16)
  };
  if box_size > MAX_FTYP_BOX_BYTES
    || box_size < compatible_brands
    || box_size > bytes.len()
    || (box_size - compatible_brands) % 4 != 0
  {
    return None;
  }
  Some((box_size, major_brand, compatible_brands))
}

fn is_hevc_heif_brand(brand: &[u8]) -> bool {
  matches!(brand, b"heic" | b"heix" | b"hevc" | b"hevx" | b"heim" | b"heis")
}

fn is_heif(bytes: &[u8]) -> bool {
  let Some((box_size, major_brand, compatible_brands)) = ftyp_layout(bytes) else {
    return false;
  };
  is_hevc_heif_brand(&bytes[major_brand..major_brand + 4])
    || bytes[compatible_brands..box_size]
      .chunks_exact(4)
      .any(is_hevc_heif_brand)
}

fn has_other_strong_signature(expected: SignaturePolicy, bytes: &[u8]) -> bool {
  (expected != SignaturePolicy::Jpeg && is_jpeg(bytes))
    || (expected != SignaturePolicy::Png && is_png(bytes))
    // DNG/CR2/NEF/ARWなどはTIFF containerを使う。DecoderProbeではTIFF magicだけでラスタTIFFと断定しない。
    || (!matches!(expected, SignaturePolicy::Tiff | SignaturePolicy::DecoderProbe) && is_tiff(bytes))
    || (expected != SignaturePolicy::Rw2 && is_rw2(bytes))
    || (expected != SignaturePolicy::Heif && is_heif(bytes))
}

fn signature_matches(policy: SignaturePolicy, bytes: &[u8]) -> bool {
  match policy {
    SignaturePolicy::Jpeg => is_jpeg(bytes),
    SignaturePolicy::Png => is_png(bytes),
    SignaturePolicy::Tiff => is_tiff(bytes),
    SignaturePolicy::Heif => is_heif(bytes),
    SignaturePolicy::Rw2 => is_rw2(bytes),
    SignaturePolicy::DecoderProbe => bytes.len() >= 12 && !has_other_strong_signature(policy, bytes),
  }
}

#[cfg(target_os = "macos")]
fn is_not_downloaded(metadata: &std::fs::Metadata) -> bool {
  use std::os::macos::fs::MetadataExt;
  const UF_OFFLINE: u32 = 0x0000_4000;
  const SF_DATALESS: u32 = 0x4000_0000;
  metadata.st_flags() & (UF_OFFLINE | SF_DATALESS) != 0
}

#[cfg(not(target_os = "macos"))]
fn is_not_downloaded(_metadata: &std::fs::Metadata) -> bool {
  false
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum CapabilityFailure {
  NotFound,
  DecodeFailed,
  FormatMismatch,
  DownloadRequired,
  UnsupportedFormat,
  UnsupportedStage,
}

pub(crate) const fn capability_error(stage: CapabilityStage, failure: CapabilityFailure) -> StaticPageError {
  use CapabilityFailure::*;
  let code = match failure {
    NotFound => code::NOT_FOUND,
    DecodeFailed => code::DECODE_FAILED,
    FormatMismatch => code::FORMAT_MISMATCH,
    DownloadRequired => code::DOWNLOAD_REQUIRED,
    UnsupportedFormat | UnsupportedStage => code::UNSUPPORTED_FORMAT,
  };
  let message = match (stage, failure) {
    (_, NotFound) => "写真が見つかりません。写真を選び直してください。",
    (_, UnsupportedFormat) => "この写真形式には対応していません。対応形式の写真を選んでください。",
    (_, UnsupportedStage) => "この写真形式は、この処理には対応していません。別の形式へ変換してからお試しください。",
    (CapabilityStage::Decoder, FormatMismatch) => {
      "写真の拡張子と中身の形式が一致しません。正しい写真を選び直してください。"
    }
    (CapabilityStage::Thumbnail, FormatMismatch) => {
      "サムネイル作成時に写真の拡張子と中身の形式が一致しないことが分かりました。正しい写真を選び直してください。"
    }
    (CapabilityStage::Metadata, FormatMismatch) => {
      "情報の読取時に写真の拡張子と中身の形式が一致しないことが分かりました。正しい写真を選び直してください。"
    }
    (CapabilityStage::FullRender, FormatMismatch) => {
      "原寸の現像時に写真の拡張子と中身の形式が一致しないことが分かりました。正しい写真を選び直してください。"
    }
    (CapabilityStage::Decoder, DownloadRequired) => {
      "写真がこのMacにありません。Finderでダウンロードしてから、もう一度開いてください。"
    }
    (CapabilityStage::Thumbnail, DownloadRequired) => {
      "サムネイルを作る写真がこのMacにありません。Finderでダウンロードしてから、もう一度お試しください。"
    }
    (CapabilityStage::Metadata, DownloadRequired) => {
      "情報を読む写真がこのMacにありません。Finderでダウンロードしてから、もう一度お試しください。"
    }
    (CapabilityStage::FullRender, DownloadRequired) => {
      "原寸を現像する写真がこのMacにありません。Finderでダウンロードしてから、もう一度お試しください。"
    }
    (CapabilityStage::Decoder, DecodeFailed) => {
      "写真の形式を確認できませんでした。破損していない写真を選び直してください。"
    }
    (CapabilityStage::Thumbnail, DecodeFailed) => {
      "サムネイル用に写真を確認できませんでした。破損していない写真を選び直してください。"
    }
    (CapabilityStage::Metadata, DecodeFailed) => {
      "写真の情報を確認できませんでした。破損していない写真を選び直してください。"
    }
    (CapabilityStage::FullRender, DecodeFailed) => {
      "原寸の現像用に写真を確認できませんでした。破損していない写真を選び直してください。"
    }
  };
  StaticPageError::new(code, message)
}

fn read_header(path: &Path, policy: SignaturePolicy, stage: CapabilityStage) -> Result<Vec<u8>, StaticPageError> {
  let metadata = std::fs::symlink_metadata(path).map_err(|_| capability_error(stage, CapabilityFailure::NotFound))?;
  if !metadata.is_file() {
    return Err(capability_error(stage, CapabilityFailure::NotFound));
  }
  if is_not_downloaded(&metadata) {
    return Err(capability_error(stage, CapabilityFailure::DownloadRequired));
  }
  let mut header = Vec::with_capacity(64);
  let result = File::open(path).and_then(|mut file| {
    file.by_ref().take(64).read_to_end(&mut header)?;
    if policy == SignaturePolicy::Heif && header.len() >= 8 && &header[4..8] == b"ftyp" {
      let declared = match u32::from_be_bytes(header[..4].try_into().unwrap()) {
        1 if header.len() >= 16 => usize::try_from(u64::from_be_bytes(header[8..16].try_into().unwrap())).ok(),
        0 => None,
        size => usize::try_from(size).ok(),
      };
      if let Some(size) = declared.filter(|size| *size > header.len() && *size <= MAX_FTYP_BOX_BYTES) {
        file.take((size - header.len()) as u64).read_to_end(&mut header)?;
      }
    }
    Ok(())
  });
  match result {
    Ok(_) => Ok(header),
    Err(error) if matches!(error.kind(), io::ErrorKind::WouldBlock | io::ErrorKind::TimedOut) => {
      Err(capability_error(stage, CapabilityFailure::DownloadRequired))
    }
    Err(_) => Err(capability_error(stage, CapabilityFailure::DecodeFailed)),
  }
}

pub(crate) fn validate_photo_static(
  path: &Path,
  stage: CapabilityStage,
) -> Result<&'static PhotoCapability, StaticPageError> {
  let file_name = path.file_name().and_then(|name| name.to_str()).unwrap_or_default();
  let capability =
    capability_for_file_name(file_name).ok_or_else(|| capability_error(stage, CapabilityFailure::UnsupportedFormat))?;
  if !capability.stages.supports(stage) {
    return Err(capability_error(stage, CapabilityFailure::UnsupportedStage));
  }
  let header = read_header(path, capability.signature, stage)?;
  if !signature_matches(capability.signature, &header) {
    return Err(capability_error(stage, CapabilityFailure::FormatMismatch));
  }
  if capability.kind == PhotoKind::Raster {
    if let Some(detected) = crate::image_info::detected_ut_type(path) {
      if !capability
        .ut_types
        .iter()
        .any(|expected| expected.eq_ignore_ascii_case(&detected))
      {
        return Err(capability_error(stage, CapabilityFailure::FormatMismatch));
      }
    }
  }
  Ok(capability)
}

/// 拡張子、段階の対応宣言、magic bytesを共通に検証する。完全なdecode可否は各段階の実decoderが引き続き判定する。
pub fn validate_photo(path: &Path, stage: CapabilityStage) -> Result<&'static PhotoCapability, PageError> {
  validate_photo_static(path, stage).map_err(StaticPageError::into_page_error)
}

#[cfg(test)]
mod tests {
  use super::*;
  use std::fs;
  use std::path::PathBuf;
  use std::sync::atomic::{AtomicU64, Ordering};
  use std::time::{SystemTime, UNIX_EPOCH};

  static NEXT_TEMP_ID: AtomicU64 = AtomicU64::new(0);

  fn temp_file(name: &str, bytes: &[u8]) -> PathBuf {
    let id = SystemTime::now().duration_since(UNIX_EPOCH).unwrap().as_nanos();
    // clock の分解能が低い runner でも、並行 test の cleanup が別 fixture を消さない。
    let sequence = NEXT_TEMP_ID.fetch_add(1, Ordering::Relaxed);
    let dir = std::env::temp_dir().join(format!("niho-capabilities-{}-{id}-{sequence}", std::process::id()));
    fs::create_dir(&dir).unwrap();
    let path = dir.join(name);
    fs::write(&path, bytes).unwrap();
    path
  }

  #[test]
  fn picker_extensions_and_legacy_kind_are_derived_from_the_registry() {
    assert_eq!(PHOTO_FILE_EXTENSIONS.len(), PHOTO_CAPABILITIES.len());
    for (index, capability) in PHOTO_CAPABILITIES.iter().enumerate() {
      assert_eq!(PHOTO_FILE_EXTENSIONS[index], capability.extension);
      assert!(capability.stages.supports(CapabilityStage::Decoder));
    }
    assert_eq!(capability_for_file_name("photo.RW2").unwrap().format, "rw2");
    assert_eq!(capability_for_mime("IMAGE/PNG").unwrap().format, "png");
    assert_eq!(capability_for_ut_type("public.heic").unwrap().format, "heic");
  }

  #[test]
  fn synthetic_signatures_cover_the_six_product_formats_and_ignore_case() {
    let fixtures: &[(&str, &[u8], &str)] = &[
      ("a.JPEG", b"\xff\xd8\xffsynthetic", "jpeg"),
      ("a.PNG", b"\x89PNG\r\n\x1a\nsynthetic", "png"),
      ("a.TIFF", b"II*\0synthetic", "tiff"),
      ("a.RW2", b"IIU\0synthetic", "rw2"),
      ("a.HEIC", b"\0\0\0\x14ftypheic\0\0\0\0mif1", "heic"),
      ("a.HEIF", b"\0\0\0\x14ftypmif1\0\0\0\0heic", "heif"),
    ];
    for (name, bytes, format) in fixtures {
      let path = temp_file(name, bytes);
      assert_eq!(validate_photo(&path, CapabilityStage::Decoder).unwrap().format, *format);
      fs::remove_dir_all(path.parent().unwrap()).unwrap();
    }
  }

  #[test]
  fn disguised_and_truncated_files_fail_with_stage_specific_public_errors() {
    let disguised = temp_file("not-a-jpeg.JPG", b"\x89PNG\r\n\x1a\nsynthetic");
    let error = validate_photo(&disguised, CapabilityStage::Thumbnail).unwrap_err();
    assert_eq!(error.code, code::FORMAT_MISMATCH);
    assert!(error.message.contains("サムネイル"));
    fs::remove_dir_all(disguised.parent().unwrap()).unwrap();

    let truncated = temp_file("broken.RW2", b"II");
    let error = validate_photo(&truncated, CapabilityStage::FullRender).unwrap_err();
    assert_eq!(error.code, code::FORMAT_MISMATCH);
    assert!(error.message.contains("原寸"));
    fs::remove_dir_all(truncated.parent().unwrap()).unwrap();
  }

  #[test]
  fn heif_uses_only_the_declared_ftyp_brands_and_requires_a_hevc_brand() {
    let outside_box = b"\0\0\0\x14ftypavif\0\0\0\0mif1heic";
    assert!(
      !is_heif(outside_box),
      "bytes after the declared ftyp box are not brands"
    );

    let avif = b"\0\0\0\x18ftypavif\0\0\0\0mif1avis";
    assert!(!is_heif(avif), "mif1 alone does not identify HEVC/HEIC");
    let avif_path = temp_file("avif-as-heic.HEIC", avif);
    assert_eq!(
      validate_photo(&avif_path, CapabilityStage::Decoder).unwrap_err().code,
      code::FORMAT_MISMATCH
    );
    fs::remove_dir_all(avif_path.parent().unwrap()).unwrap();

    let brand_in_minor_version = b"\0\0\0\x10ftypavifheic";
    assert!(
      !is_heif(brand_in_minor_version),
      "the minor-version field is not a compatible brand"
    );

    let truncated = b"\0\0\0\x18ftypheic\0\0\0\0mif1";
    assert!(!is_heif(truncated), "the complete declared ftyp box is required");

    let extended = b"\0\0\0\x01ftyp\0\0\0\0\0\0\0\x1cheic\0\0\0\0mif1";
    assert!(is_heif(extended), "extended-size ftyp uses its extended header range");
  }

  #[test]
  fn heif_reads_a_bounded_ftyp_larger_than_the_old_sixty_four_byte_probe() {
    let mut bytes = vec![0u8; 72];
    bytes[..4].copy_from_slice(&(72u32.to_be_bytes()));
    bytes[4..8].copy_from_slice(b"ftyp");
    bytes[8..12].copy_from_slice(b"mif1");
    for brand in bytes[16..68].chunks_exact_mut(4) {
      brand.copy_from_slice(b"mif1");
    }
    bytes[68..72].copy_from_slice(b"heic");
    let path = temp_file("large.HEIC", &bytes);
    assert_eq!(validate_photo(&path, CapabilityStage::Decoder).unwrap().format, "heic");
    fs::remove_dir_all(path.parent().unwrap()).unwrap();
  }

  #[test]
  fn valid_heif_bytes_with_the_wrong_extension_are_a_format_mismatch() {
    let path = temp_file("heif-as-jpeg.JPG", b"\0\0\0\x14ftypheic\0\0\0\0mif1");
    let error = validate_photo(&path, CapabilityStage::Decoder).unwrap_err();
    assert_eq!(error.code, code::FORMAT_MISMATCH);
    fs::remove_dir_all(path.parent().unwrap()).unwrap();
  }

  #[test]
  fn tiff_container_raw_stays_raw_until_the_real_decoder_decides() {
    let path = temp_file("camera.DNG", b"II*\0synthetic tiff raw");
    let capability = validate_photo(&path, CapabilityStage::Decoder).unwrap();
    assert_eq!(capability.kind, PhotoKind::Raw);
    assert_eq!(capability.format, "dng");
    fs::remove_dir_all(path.parent().unwrap()).unwrap();
  }

  #[test]
  fn not_downloaded_guidance_names_the_action_and_stage() {
    for stage in [
      CapabilityStage::Decoder,
      CapabilityStage::Thumbnail,
      CapabilityStage::Metadata,
      CapabilityStage::FullRender,
    ] {
      let error = capability_error(stage, CapabilityFailure::DownloadRequired).into_page_error();
      assert_eq!(error.code, code::DOWNLOAD_REQUIRED);
      assert!(error.message.contains("Finderでダウンロード"));
      if stage == CapabilityStage::FullRender {
        assert!(error.message.contains("原寸"));
      }
    }
  }

  #[test]
  fn audited_public_rw2_has_the_registered_signature() {
    let fixture = Path::new(env!("CARGO_MANIFEST_DIR")).join("../develop-engine/fixtures/public-raw/dc-s5-owner.rw2");
    assert_eq!(
      validate_photo(&fixture, CapabilityStage::Decoder).unwrap().format,
      "rw2"
    );
  }
}
