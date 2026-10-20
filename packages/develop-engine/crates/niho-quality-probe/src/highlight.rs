//! Probe the simplest highlight change: retain values above 1 caused only by
//! white balance. Sensor-saturated samples still have no recoverable detail.

use niho_base_raw::decode::{CameraRaw, RawData};

fn normalize(sample: f32, black: f32, white: f32, gain: f32) -> f32 {
    ((sample - black) / (white - black)).clamp(0.0, 1.0) * gain
}

pub fn prepare_cfa_preserve_wb(raw: &CameraRaw, gains: [f32; 3]) -> Vec<f32> {
    let width = raw.crop.width;
    let height = raw.crop.height;
    let mut out = vec![0.0_f32; width * height];
    for y in 0..height {
        let row_start = (raw.crop.y + y) * raw.full_width + raw.crop.x;
        for x in 0..width {
            let site = (y & 1) * 2 + (x & 1);
            let channel = raw.pattern[y & 1][x & 1] as usize;
            let sample = match &raw.data {
                RawData::U16(data) => f32::from(data[row_start + x]),
                RawData::F32(data) => data[row_start + x],
            };
            out[y * width + x] =
                normalize(sample, raw.black[site], raw.white[site], gains[channel]);
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::normalize;

    #[test]
    fn keeps_white_balance_headroom_but_not_sensor_overflow() {
        assert!((normalize(800.0, 0.0, 1000.0, 2.0) - 1.6).abs() < 1e-6);
        assert!((normalize(1200.0, 0.0, 1000.0, 2.0) - 2.0).abs() < 1e-6);
    }
}
