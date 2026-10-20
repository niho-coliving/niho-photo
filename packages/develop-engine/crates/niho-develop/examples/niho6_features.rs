//! `niho-6` training inputs for `tools/calibrate/fit_niho6_response.py`
//! (#18397): the 750px analysis of a JPEG / PNG original exactly as the
//! renderer makes it, and its 26 features, as `.npy` (little-endian f32).
//!
//!   cargo run --release -p niho-develop --example niho6_features -- \
//!     <input.jpg> <working long edge> <out-dir>
//!
//! Writes `<out-dir>/analysis.npy` (h, w, 3: linear ProPhoto) and
//! `<out-dir>/features.npy` (h, w, 26), and prints `width height`.

use niho_develop::{decode, niho6, raw_response, Filter};

fn write_npy(path: &std::path::Path, shape: &[usize], data: &[f32]) {
    let dims: Vec<String> = shape.iter().map(|d| d.to_string()).collect();
    let mut header = format!(
        "{{'descr': '<f4', 'fortran_order': False, 'shape': ({},), }}",
        dims.join(", ")
    )
    .into_bytes();
    while (10 + header.len() + 1) % 64 != 0 {
        header.push(b' ');
    }
    header.push(b'\n');
    let mut bytes = Vec::with_capacity(10 + header.len() + data.len() * 4);
    bytes.extend_from_slice(b"\x93NUMPY\x01\x00");
    bytes.extend_from_slice(&(header.len() as u16).to_le_bytes());
    bytes.extend_from_slice(&header);
    for v in data {
        bytes.extend_from_slice(&v.to_le_bytes());
    }
    std::fs::write(path, bytes).expect("write npy");
}

fn main() {
    let args: Vec<String> = std::env::args().collect();
    assert!(
        args.len() == 4,
        "usage: niho6_features <input> <working long edge> <out-dir>"
    );
    let input = std::fs::read(&args[1]).expect("input");
    let working: usize = args[2].parse().expect("working long edge");
    let out = std::path::Path::new(&args[3]);
    std::fs::create_dir_all(out).expect("out dir");
    let raster = decode::decode_raster(&input, working, Filter::Lanczos3).expect("decode");
    let analysis = niho6::analysis_image(&raster.image, niho6::SourceSpace::LinearSrgb);
    let (aw, ah) = (analysis.width, analysis.height);
    let small = analysis.data;
    let features = raw_response::feature_vectors(&small, aw, ah).expect("features");
    let flat: Vec<f32> = features.iter().flat_map(|f| f.iter().copied()).collect();
    write_npy(&out.join("analysis.npy"), &[ah, aw, 3], &small);
    write_npy(
        &out.join("features.npy"),
        &[ah, aw, raw_response::FEATURE_COUNT],
        &flat,
    );
    println!("{aw} {ah}");
}
