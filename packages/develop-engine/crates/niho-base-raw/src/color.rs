//! Compatibility path for shared camera color math and the DCP spec adapter.

use anyhow::Result;

use crate::dcp::DcpSpec;
use crate::matrix::Vec3;

pub use niho_camera_color::color::{
    bradford, cct_duv, hsv_to_rgb, illuminant_cct, interpolation_weight, rgb_to_hsv, srgb_decode,
    srgb_encode, xy_to_uv1960, xy_to_xyz, xyz_to_xy, HueSatMap, ProfileColor, BRADFORD, CCT_METHOD,
    D50_XYZ, D65_XYZ, PROPHOTO_TO_XYZ_D50, XYZ_D50_TO_PROPHOTO,
};

/// Resolve the existing DCP spec through the pure color engine. This preserves the stage-1 and
/// probe API while keeping binary DCP I/O and LibRaw data in `niho-base-raw`.
pub fn resolve_profile_color(spec: &DcpSpec, neutral: &Vec3) -> Result<ProfileColor> {
    niho_camera_color::color::resolve_profile_color(&spec.color_input(), neutral)
}
