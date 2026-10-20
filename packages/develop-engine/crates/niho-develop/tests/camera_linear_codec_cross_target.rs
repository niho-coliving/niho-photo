//! The same container must carry identical camera samples between native and
//! browser wasm. This test runs on both targets and pins an encoded-byte hash.

use niho_develop::camera_linear_codec::{
    decode_lossless_f32_zlib_v1, encode_lossless_f32_zlib_v1, CameraLinearCodecError,
    CAMERA_LINEAR_LOSSLESS_MAGIC, CAMERA_LINEAR_LOSSLESS_VERSION,
};
use niho_develop::LinearImage;

fn sample_image() -> LinearImage {
    let mut bits = vec![
        (-0.0f32).to_bits(),
        0.0f32.to_bits(),
        f32::from_bits(1).to_bits(),
        (-0.25f32).to_bits(),
        1.0f32.to_bits(),
        3.5f32.to_bits(),
    ];
    let mut state = 0x19a4_753bu32;
    while bits.len() < 19 * 17 * 3 {
        state ^= state << 13;
        state ^= state >> 17;
        state ^= state << 5;
        bits.push((state & 0x807f_ffff) | 0x3f00_0000);
    }
    LinearImage {
        width: 19,
        height: 17,
        data: bits.into_iter().map(f32::from_bits).collect(),
    }
}

fn fnv1a64(bytes: &[u8]) -> u64 {
    bytes.iter().fold(0xcbf2_9ce4_8422_2325u64, |hash, byte| {
        (hash ^ u64::from(*byte)).wrapping_mul(0x0100_0000_01b3)
    })
}

#[cfg_attr(target_arch = "wasm32", wasm_bindgen_test::wasm_bindgen_test)]
#[cfg_attr(not(target_arch = "wasm32"), test)]
fn native_and_wasm_encode_the_same_bytes_and_restore_f32_bits() {
    let input = sample_image();
    let encoded = encode_lossless_f32_zlib_v1(&input).unwrap();
    assert_eq!(&encoded[..8], &CAMERA_LINEAR_LOSSLESS_MAGIC);
    assert_eq!(
        u16::from_le_bytes([encoded[8], encoded[9]]),
        CAMERA_LINEAR_LOSSLESS_VERSION
    );
    assert_eq!(fnv1a64(&encoded), 8_167_567_072_605_049_893);

    let decoded = decode_lossless_f32_zlib_v1(&encoded).unwrap();
    assert_eq!((decoded.width, decoded.height), (input.width, input.height));
    assert_eq!(
        decoded
            .data
            .iter()
            .map(|sample| sample.to_bits())
            .collect::<Vec<_>>(),
        input
            .data
            .iter()
            .map(|sample| sample.to_bits())
            .collect::<Vec<_>>()
    );
}

#[cfg_attr(target_arch = "wasm32", wasm_bindgen_test::wasm_bindgen_test)]
#[cfg_attr(not(target_arch = "wasm32"), test)]
fn native_and_wasm_reject_trailing_and_truncated_streams() {
    let encoded = encode_lossless_f32_zlib_v1(&sample_image()).unwrap();
    let mut trailing = encoded.clone();
    trailing.push(0);
    assert!(matches!(
        decode_lossless_f32_zlib_v1(&trailing),
        Err(CameraLinearCodecError::Corrupt(_))
    ));
    assert!(matches!(
        decode_lossless_f32_zlib_v1(&encoded[..encoded.len() - 1]),
        Err(CameraLinearCodecError::Corrupt(_))
    ));
}
