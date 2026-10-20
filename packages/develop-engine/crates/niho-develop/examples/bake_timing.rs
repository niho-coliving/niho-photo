//! Cube bake timings (diagnostics): `cargo run --release --example bake_timing`.
use niho_develop::{pipeline, xmp};
use std::time::Instant;

fn main() {
    for id in ["niho-bluesky2", "niho-pastel", "niho-colorful"] {
        let s = xmp::preset_settings(xmp::builtin_preset(id).unwrap().xmp, None)
            .unwrap()
            .settings;
        for n in [33, 64] {
            let t = Instant::now();
            let _p = pipeline::bake_post_ops_cube(&s, s.exposure, n);
            let p = t.elapsed().as_secs_f64() * 1000.0;
            let t = Instant::now();
            let _q = pipeline::bake_color_cube(&s, n);
            let q = t.elapsed().as_secs_f64() * 1000.0;
            println!("{id} {n}^3: cube P {p:.1} ms, cube Q {q:.1} ms");
        }
    }
}
