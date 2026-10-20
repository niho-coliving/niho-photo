//! E1 計測用: RAW の作業コピーを neutral（niho-interim-1）で描いたときの cube Q の入力（linear ProPhoto・[0,1]）と、
//! 灰 g（ProPhoto の (g,g,g)）→ 出力（sRGB 符号化値）の表を書く。
//!
//!   probe_stage <working.png> <meta.json> <out.f32>   (u32 w, u32 h, then f32 RGB)
//!   probe_stage --tone-table <out.f32>                 (4097 x (v, R, G, B)): pre-tone gray v -> encoded sRGB output
//!   probe_stage --pretone <working.png> <meta.json> <out.f32>   pre-tone linear ProPhoto (working copy x 2^baselineEV)
//!   probe_stage --tail <in.f32> <out.f32>              neutral RAW tail on a pre-tone image -> encoded sRGB
//!   probe_stage --acr3 <in.f32> <out.f32>              ACR3 cube on a pre-tone image -> the cube Q input (linear ProPhoto)
//!   probe_stage --grain-field <w> <h> <size> <roughness> <seed> <out.f32>   the crate's grain field (1 channel)
//!   probe_stage --gray-table <out.f32>                 (4097 entries: encoded sRGB of gray g = i/4096)
use niho_develop::color::PROPHOTO_TO_SRGB_F32;
use niho_develop::decode::{decode_working_copy, WorkingCopyMeta};
use niho_develop::lut::{decode, encode};
use niho_develop::output::output_transform;
use niho_develop::pipeline::acr3_cube;
use niho_develop::Filter;
use std::io::Write;

fn mat(m: &[[f32; 3]; 3], v: [f32; 3]) -> [f32; 3] {
    [
        m[0][0] * v[0] + m[0][1] * v[1] + m[0][2] * v[2],
        m[1][0] * v[0] + m[1][1] * v[1] + m[1][2] * v[2],
        m[2][0] * v[0] + m[2][1] * v[1] + m[2][2] * v[2],
    ]
}

fn srgb_enc(x: f32) -> f32 {
    let c = x.clamp(0.0, 1.0);
    if c <= 0.003_130_8 { c * 12.92 } else { 1.055 * c.powf(1.0 / 2.4) - 0.055 }
}

fn main() {
    let args: Vec<String> = std::env::args().collect();
    if args[1] == "--tone-table" {
        // pre-tone gray v = (i/4096)^2.2 (linear ProPhoto, before the ACR3 cube) -> encoded sRGB output (neutral path)
        let cube = acr3_cube();
        let mut out = std::fs::File::create(&args[2]).unwrap();
        for i in 0..=4096 {
            let v = (i as f32 / 4096.0).powf(2.2);
            let q = decode(cube.lookup_encoded(encode([v, v, v])));
            let o = output_transform(mat(&PROPHOTO_TO_SRGB_F32, q));
            out.write_all(&v.to_le_bytes()).unwrap();
            for c in o {
                out.write_all(&srgb_enc(c).to_le_bytes()).unwrap();
            }
        }
        return;
    }
    if args[1] == "--tail" {
        // pre-tone linear ProPhoto (u32 w, u32 h, f32 RGB) -> the neutral RAW tail (ACR3 cube -> linear sRGB ->
        // output transform) -> encoded sRGB f32 (same header)
        let bytes = std::fs::read(&args[2]).unwrap();
        let cube = acr3_cube();
        let mut out = std::io::BufWriter::new(std::fs::File::create(&args[3]).unwrap());
        out.write_all(&bytes[..8]).unwrap();
        let data: Vec<f32> = bytes[8..].chunks_exact(4).map(|b| f32::from_le_bytes([b[0], b[1], b[2], b[3]])).collect();
        for px in data.chunks_exact(3) {
            let q = decode(cube.lookup_encoded(encode([px[0], px[1], px[2]])));
            let o = output_transform(mat(&PROPHOTO_TO_SRGB_F32, q));
            for c in o {
                out.write_all(&srgb_enc(c).to_le_bytes()).unwrap();
            }
        }
        return;
    }
    if args[1] == "--acr3" {
        // pre-tone linear ProPhoto (u32 w, u32 h, f32 RGB) -> the ACR3 cube's output (the cube Q input of a neutral
        // RAW render; same header). For fitting stages that act before the tone curve (the black & white mix).
        let bytes = std::fs::read(&args[2]).unwrap();
        let cube = acr3_cube();
        let mut out = std::io::BufWriter::new(std::fs::File::create(&args[3]).unwrap());
        out.write_all(&bytes[..8]).unwrap();
        let data: Vec<f32> = bytes[8..].chunks_exact(4).map(|b| f32::from_le_bytes([b[0], b[1], b[2], b[3]])).collect();
        for px in data.chunks_exact(3) {
            for c in decode(cube.lookup_encoded(encode([px[0], px[1], px[2]]))) {
                out.write_all(&c.to_le_bytes()).unwrap();
            }
        }
        return;
    }
    if args[1] == "--pretone" {
        // the working copy times 2^baselineEV (the input of the first cube without edits)
        let png = std::fs::read(&args[2]).unwrap();
        let meta = WorkingCopyMeta::from_json(&std::fs::read_to_string(&args[3]).unwrap()).unwrap();
        let baseline = match meta {
            WorkingCopyMeta::Raw { baseline_ev, .. } => baseline_ev,
            _ => panic!("raw only"),
        };
        let img = decode_working_copy(&png, 0, Filter::Lanczos3).unwrap();
        let gain = libm::exp2(baseline) as f32;
        let mut out = std::io::BufWriter::new(std::fs::File::create(&args[4]).unwrap());
        out.write_all(&(img.width as u32).to_le_bytes()).unwrap();
        out.write_all(&(img.height as u32).to_le_bytes()).unwrap();
        for v in &img.data {
            out.write_all(&(v * gain).to_le_bytes()).unwrap();
        }
        return;
    }
    if args[1] == "--grain-field" {
        // grain_field(w, h, size, roughness, seed) with this build's constants -> (u32 w, u32 h, f32 plane)
        let w: usize = args[2].parse().unwrap();
        let h: usize = args[3].parse().unwrap();
        let g = niho_develop::settings::GrainSettings {
            amount: 50.0,
            size: args[4].parse().unwrap(),
            roughness: args[5].parse().unwrap(),
            seed: Some(args[6].parse().unwrap()),
        };
        let field = niho_develop::effects::grain_field(w, h, &g);
        let mut out = std::io::BufWriter::new(std::fs::File::create(&args[7]).unwrap());
        out.write_all(&(w as u32).to_le_bytes()).unwrap();
        out.write_all(&(h as u32).to_le_bytes()).unwrap();
        for v in &field.data {
            out.write_all(&v.to_le_bytes()).unwrap();
        }
        return;
    }
    if args[1] == "--gray-table" {
        let mut out = std::fs::File::create(&args[2]).unwrap();
        for i in 0..=4096 {
            let g = i as f32 / 4096.0;
            let o = output_transform(mat(&PROPHOTO_TO_SRGB_F32, [g, g, g]));
            for c in o {
                out.write_all(&srgb_enc(c).to_le_bytes()).unwrap();
            }
        }
        return;
    }
    let png = std::fs::read(&args[1]).unwrap();
    let meta = WorkingCopyMeta::from_json(&std::fs::read_to_string(&args[2]).unwrap()).unwrap();
    let baseline = match meta {
        WorkingCopyMeta::Raw { baseline_ev, .. } => baseline_ev,
        _ => panic!("raw only"),
    };
    let img = decode_working_copy(&png, 0, Filter::Lanczos3).unwrap();
    let gain = libm::exp2(baseline) as f32;
    let cube = acr3_cube();
    let mut out = std::io::BufWriter::new(std::fs::File::create(&args[3]).unwrap());
    out.write_all(&(img.width as u32).to_le_bytes()).unwrap();
    out.write_all(&(img.height as u32).to_le_bytes()).unwrap();
    for px in img.data.chunks_exact(3) {
        let v = decode(cube.lookup_encoded(encode([px[0] * gain, px[1] * gain, px[2] * gain])));
        for c in v {
            out.write_all(&c.to_le_bytes()).unwrap();
        }
    }
}
