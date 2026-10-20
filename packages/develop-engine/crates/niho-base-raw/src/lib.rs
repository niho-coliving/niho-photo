//! `niho-base-raw` — stage 1 ("base") of the NIHO develop engine (S9b #16976).
//!
//! RAW (rawler) → normalize + as-shot white balance on the CFA (highlight clip) → bilinear demosaic →
//! NIHO DCP (ColorMatrix / ForwardMatrix / HueSatMap, DNG 1.6 "Mapping Camera Color Space to CIE XYZ
//! Space") → linear ProPhoto RGB (D50) → orientation → Lanczos3 → 16-bit PNG (power 1/1.8, linear max
//! 2.0) plus a sidecar JSON (`niho-base-raw.working-copy/1`). Exposure (BaselineExposure) is *not*
//! applied; it travels as `baselineEV` in the sidecar. ProfileToneCurve and LookTable are not applied.
//!
//! Everything here is a pure function over buffers; `main.rs` is only the CLI.

pub mod color;
pub mod dcp;
pub mod decode;
pub mod demosaic;
pub mod encode;
pub mod matrix;
pub mod orient;
pub mod par;
pub mod pipeline;
pub mod resize;
pub mod sidecar;
pub mod tiff;

/// Version of the stage-1 processing math (demosaic, WB, color model, resample).
pub const PROCESSING_VERSION: &str = "niho-base-raw/1";
/// Version of the PNG working-copy encoding (16-bit, power 1/1.8, linear max 2.0).
pub const ENCODING_VERSION: &str = "png16-g1.8-max2/1";
/// Prefix of `baseVersion`: track b (own decode) 1 · processing 1 · encoding 1.
pub const BASE_VERSION_PREFIX: &str = "b1.p1.e1";
/// `baseVersion` used by `dump-camera` outputs (not a working copy).
pub const DUMP_BASE_VERSION: &str = "dump";
pub const DECODER_NAME: &str = "rawler";
/// Must match the exact version pinned in Cargo.toml.
pub const DECODER_VERSION: &str = "0.8.0";

/// `baseVersion` of a working copy rendered with the DCP whose SHA-256 (lowercase hex) is given.
pub fn base_version(dcp_sha256_hex: &str) -> String {
    format!("{BASE_VERSION_PREFIX}.dcp-{dcp_sha256_hex}")
}

/// True when `s` has the form `b1.p1.e1.dcp-<64 lowercase hex>`.
pub fn is_valid_base_version(s: &str) -> bool {
    let Some(rest) = s.strip_prefix(BASE_VERSION_PREFIX) else {
        return false;
    };
    let Some(hex) = rest.strip_prefix(".dcp-") else {
        return false;
    };
    hex.len() == 64
        && hex
            .bytes()
            .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
}
