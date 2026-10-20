//! Candidate lossless container for camera-linear RGB working copies.
//!
//! This codec is deliberately independent of production working-copy routing,
//! metadata, and `baseVersion` decisions. Version 1 has this binary envelope:
//!
//! ```text
//! bytes 0..8    magic (`CAMERA_LINEAR_LOSSLESS_MAGIC`)
//! bytes 8..10   container version, little-endian `u16`
//! bytes 10..14  width, little-endian `u32`
//! bytes 14..18  height, little-endian `u32`
//! bytes 18..    one zlib stream of interleaved RGB `f32` bit patterns,
//!                each stored as four little-endian bytes
//! ```
//!
//! Samples are copied by their IEEE-754 bits. No range mapping, clipping, or
//! floating-point arithmetic is performed.

use crate::LinearImage;
use flate2::{bufread::ZlibDecoder, write::ZlibEncoder, Compression};
use std::fmt;
use std::io::{Read, Write};

/// Format marker at the start of every camera-linear lossless container.
pub const CAMERA_LINEAR_LOSSLESS_MAGIC: [u8; 8] = *b"NIHOCLF\0";
/// Current container version. This is not a production working-copy base version.
pub const CAMERA_LINEAR_LOSSLESS_VERSION: u16 = 1;

const HEADER_LEN: usize = 18;
const CHANNELS: usize = 3;
const BYTES_PER_SAMPLE: usize = 4;
const MAX_PIXELS: usize = 40_000_000;
const SAMPLES_PER_CHUNK: usize = 16_384;

/// Failure categories for the standalone camera-linear container.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum CameraLinearCodecError {
    /// The caller supplied an image or format marker that cannot represent this format.
    InvalidInput(&'static str),
    /// Dimensions or allocation sizes exceed the codec's bounded limits.
    SizeLimit(&'static str),
    /// Encoded bytes are truncated, malformed, inconsistent, or contain trailing data.
    Corrupt(&'static str),
    /// The zlib implementation failed while encoding an otherwise valid image.
    CodecFailure(&'static str),
}

impl fmt::Display for CameraLinearCodecError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::InvalidInput(message) => write!(f, "invalid_input: {message}"),
            Self::SizeLimit(message) => write!(f, "size_limit: {message}"),
            Self::Corrupt(message) => write!(f, "corrupt: {message}"),
            Self::CodecFailure(message) => write!(f, "codec_failure: {message}"),
        }
    }
}

impl std::error::Error for CameraLinearCodecError {}

struct ImageSize {
    width: u32,
    height: u32,
    samples: usize,
    bytes: usize,
}

fn checked_image_size(width: usize, height: usize) -> Result<ImageSize, CameraLinearCodecError> {
    if width == 0 || height == 0 {
        return Err(CameraLinearCodecError::InvalidInput(
            "width and height must be non-zero",
        ));
    }

    let width_u32 = u32::try_from(width)
        .map_err(|_| CameraLinearCodecError::SizeLimit("dimensions exceed u32"))?;
    let height_u32 = u32::try_from(height)
        .map_err(|_| CameraLinearCodecError::SizeLimit("dimensions exceed u32"))?;
    let pixels = width
        .checked_mul(height)
        .ok_or(CameraLinearCodecError::SizeLimit(
            "pixel count arithmetic overflow",
        ))?;
    if pixels > MAX_PIXELS {
        return Err(CameraLinearCodecError::SizeLimit(
            "image exceeds the 40,000,000 pixel limit",
        ));
    }
    let samples = pixels
        .checked_mul(CHANNELS)
        .ok_or(CameraLinearCodecError::SizeLimit(
            "sample count arithmetic overflow",
        ))?;
    let bytes = samples
        .checked_mul(BYTES_PER_SAMPLE)
        .ok_or(CameraLinearCodecError::SizeLimit(
            "expanded byte count arithmetic overflow",
        ))?;

    Ok(ImageSize {
        width: width_u32,
        height: height_u32,
        samples,
        bytes,
    })
}

fn is_finite_f32_bits(bits: u32) -> bool {
    bits & 0x7f80_0000 != 0x7f80_0000
}

/// Encodes interleaved camera-linear RGB without changing any finite `f32` bits.
pub fn encode_lossless_f32_zlib_v1(image: &LinearImage) -> Result<Vec<u8>, CameraLinearCodecError> {
    let size = checked_image_size(image.width, image.height)?;
    if image.data.len() != size.samples {
        return Err(CameraLinearCodecError::InvalidInput(
            "sample count does not match width * height * 3",
        ));
    }
    if image
        .data
        .iter()
        .any(|sample| !is_finite_f32_bits(sample.to_bits()))
    {
        return Err(CameraLinearCodecError::InvalidInput(
            "samples must not contain NaN or infinity",
        ));
    }

    let mut output = Vec::with_capacity(HEADER_LEN);
    output.extend_from_slice(&CAMERA_LINEAR_LOSSLESS_MAGIC);
    output.extend_from_slice(&CAMERA_LINEAR_LOSSLESS_VERSION.to_le_bytes());
    output.extend_from_slice(&size.width.to_le_bytes());
    output.extend_from_slice(&size.height.to_le_bytes());

    let mut encoder = ZlibEncoder::new(output, Compression::fast());
    let mut scratch = Vec::with_capacity(SAMPLES_PER_CHUNK * BYTES_PER_SAMPLE);
    for samples in image.data.chunks(SAMPLES_PER_CHUNK) {
        scratch.clear();
        for sample in samples {
            scratch.extend_from_slice(&sample.to_bits().to_le_bytes());
        }
        encoder
            .write_all(&scratch)
            .map_err(|_| CameraLinearCodecError::CodecFailure("failed to write zlib payload"))?;
    }
    encoder
        .finish()
        .map_err(|_| CameraLinearCodecError::CodecFailure("failed to finish zlib payload"))
}

/// Decodes one version-1 container, rejecting non-canonical trailing bytes.
pub fn decode_lossless_f32_zlib_v1(encoded: &[u8]) -> Result<LinearImage, CameraLinearCodecError> {
    if encoded.len() < HEADER_LEN {
        return Err(CameraLinearCodecError::Corrupt("truncated header"));
    }
    if encoded.get(..CAMERA_LINEAR_LOSSLESS_MAGIC.len())
        != Some(CAMERA_LINEAR_LOSSLESS_MAGIC.as_slice())
    {
        return Err(CameraLinearCodecError::InvalidInput("wrong format magic"));
    }

    let version = u16::from_le_bytes(
        encoded[8..10]
            .try_into()
            .map_err(|_| CameraLinearCodecError::Corrupt("truncated version"))?,
    );
    if version != CAMERA_LINEAR_LOSSLESS_VERSION {
        return Err(CameraLinearCodecError::InvalidInput(
            "unsupported container version",
        ));
    }
    let width = u32::from_le_bytes(
        encoded[10..14]
            .try_into()
            .map_err(|_| CameraLinearCodecError::Corrupt("truncated width"))?,
    ) as usize;
    let height = u32::from_le_bytes(
        encoded[14..18]
            .try_into()
            .map_err(|_| CameraLinearCodecError::Corrupt("truncated height"))?,
    ) as usize;
    let size = checked_image_size(width, height)?;

    let mut data = Vec::new();
    data.try_reserve_exact(size.samples)
        .map_err(|_| CameraLinearCodecError::SizeLimit("unable to allocate decoded image"))?;
    let mut decoder = ZlibDecoder::new(&encoded[HEADER_LEN..]);
    let mut scratch = Vec::with_capacity(SAMPLES_PER_CHUNK * BYTES_PER_SAMPLE);
    let mut remaining = size.samples;
    while remaining != 0 {
        let samples_in_chunk = remaining.min(SAMPLES_PER_CHUNK);
        scratch.resize(samples_in_chunk * BYTES_PER_SAMPLE, 0);
        decoder
            .read_exact(&mut scratch)
            .map_err(|_| CameraLinearCodecError::Corrupt("truncated or malformed zlib payload"))?;
        for bytes in scratch.chunks_exact(BYTES_PER_SAMPLE) {
            let bits = u32::from_le_bytes(
                bytes
                    .try_into()
                    .map_err(|_| CameraLinearCodecError::Corrupt("partial f32 sample"))?,
            );
            if !is_finite_f32_bits(bits) {
                return Err(CameraLinearCodecError::Corrupt(
                    "decoded samples contain NaN or infinity",
                ));
            }
            data.push(f32::from_bits(bits));
        }
        remaining -= samples_in_chunk;
    }

    let mut extra = [0u8; 1];
    match decoder.read(&mut extra) {
        Ok(0) => {}
        Ok(_) => {
            return Err(CameraLinearCodecError::Corrupt(
                "expanded payload is longer than dimensions require",
            ))
        }
        Err(_) => {
            return Err(CameraLinearCodecError::Corrupt(
                "truncated or malformed zlib payload",
            ))
        }
    }
    if !decoder.into_inner().is_empty() {
        return Err(CameraLinearCodecError::Corrupt(
            "trailing bytes after zlib stream",
        ));
    }

    debug_assert_eq!(size.bytes, data.len() * BYTES_PER_SAMPLE);
    Ok(LinearImage {
        width,
        height,
        data,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn image(width: usize, height: usize, bits: &[u32]) -> LinearImage {
        LinearImage {
            width,
            height,
            data: bits.iter().copied().map(f32::from_bits).collect(),
        }
    }

    fn envelope(width: u32, height: u32, raw: &[u8]) -> Vec<u8> {
        let mut encoded = Vec::new();
        encoded.extend_from_slice(&CAMERA_LINEAR_LOSSLESS_MAGIC);
        encoded.extend_from_slice(&CAMERA_LINEAR_LOSSLESS_VERSION.to_le_bytes());
        encoded.extend_from_slice(&width.to_le_bytes());
        encoded.extend_from_slice(&height.to_le_bytes());
        let mut encoder = ZlibEncoder::new(encoded, Compression::fast());
        encoder.write_all(raw).unwrap();
        encoder.finish().unwrap()
    }

    fn assert_corrupt(result: Result<LinearImage, CameraLinearCodecError>) {
        assert!(matches!(result, Err(CameraLinearCodecError::Corrupt(_))));
    }

    #[test]
    fn roundtrips_signed_over_range_and_negative_zero_bitwise() {
        let input = image(
            2,
            1,
            &[
                (-0.25f32).to_bits(),
                (-0.0f32).to_bits(),
                0.0f32.to_bits(),
                1.0f32.to_bits(),
                2.75f32.to_bits(),
                f32::from_bits(1).to_bits(),
            ],
        );

        let decoded =
            decode_lossless_f32_zlib_v1(&encode_lossless_f32_zlib_v1(&input).expect("encode"))
                .expect("decode");

        assert_eq!((decoded.width, decoded.height), (2, 1));
        assert_eq!(
            decoded.data.iter().map(|v| v.to_bits()).collect::<Vec<_>>(),
            input.data.iter().map(|v| v.to_bits()).collect::<Vec<_>>()
        );
    }

    #[test]
    fn encoding_is_deterministic() {
        let input = image(
            1,
            2,
            &[
                0.125f32.to_bits(),
                (-0.5f32).to_bits(),
                4.0f32.to_bits(),
                0.25f32.to_bits(),
                0.5f32.to_bits(),
                0.75f32.to_bits(),
            ],
        );
        assert_eq!(
            encode_lossless_f32_zlib_v1(&input).unwrap(),
            encode_lossless_f32_zlib_v1(&input).unwrap()
        );
    }

    #[test]
    fn rejects_wrong_magic_version_and_dimensions() {
        let input = image(1, 1, &[0; 3]);
        let encoded = encode_lossless_f32_zlib_v1(&input).unwrap();

        let mut wrong_magic = encoded.clone();
        wrong_magic[0] ^= 0xff;
        assert!(matches!(
            decode_lossless_f32_zlib_v1(&wrong_magic),
            Err(CameraLinearCodecError::InvalidInput(_))
        ));

        let mut wrong_version = encoded;
        wrong_version[8..10].copy_from_slice(&2u16.to_le_bytes());
        assert!(matches!(
            decode_lossless_f32_zlib_v1(&wrong_version),
            Err(CameraLinearCodecError::InvalidInput(_))
        ));

        assert!(matches!(
            decode_lossless_f32_zlib_v1(&envelope(0, 1, &[])),
            Err(CameraLinearCodecError::InvalidInput(_))
        ));
        assert!(matches!(
            encode_lossless_f32_zlib_v1(&image(2, 1, &[0; 3])),
            Err(CameraLinearCodecError::InvalidInput(_))
        ));
    }

    #[test]
    fn rejects_truncation_corruption_extra_output_and_trailing_bytes() {
        let input = image(
            1,
            1,
            &[0.25f32.to_bits(), 0.5f32.to_bits(), 1.5f32.to_bits()],
        );
        let encoded = encode_lossless_f32_zlib_v1(&input).unwrap();

        assert_corrupt(decode_lossless_f32_zlib_v1(&encoded[..HEADER_LEN - 1]));

        let mut truncated = encoded.clone();
        truncated.pop();
        assert_corrupt(decode_lossless_f32_zlib_v1(&truncated));

        let mut corrupted = encoded.clone();
        *corrupted.last_mut().unwrap() ^= 0xff;
        assert_corrupt(decode_lossless_f32_zlib_v1(&corrupted));

        assert_corrupt(decode_lossless_f32_zlib_v1(&envelope(1, 1, &[0; 16])));

        let mut trailing = encoded;
        trailing.extend_from_slice(b"junk");
        assert_corrupt(decode_lossless_f32_zlib_v1(&trailing));
    }

    #[test]
    fn rejects_oversize_dimensions_before_decompression() {
        let oversized = envelope((MAX_PIXELS + 1) as u32, 1, &[]);
        assert!(matches!(
            decode_lossless_f32_zlib_v1(&oversized),
            Err(CameraLinearCodecError::SizeLimit(_))
        ));
    }

    #[test]
    fn rejects_non_finite_input_and_output() {
        for bits in [
            f32::NAN.to_bits(),
            f32::INFINITY.to_bits(),
            f32::NEG_INFINITY.to_bits(),
        ] {
            let input = image(1, 1, &[bits, 0, 0]);
            assert!(matches!(
                encode_lossless_f32_zlib_v1(&input),
                Err(CameraLinearCodecError::InvalidInput(_))
            ));

            let mut raw = Vec::new();
            raw.extend_from_slice(&bits.to_le_bytes());
            raw.extend_from_slice(&0u32.to_le_bytes());
            raw.extend_from_slice(&0u32.to_le_bytes());
            assert_corrupt(decode_lossless_f32_zlib_v1(&envelope(1, 1, &raw)));
        }
    }
}
