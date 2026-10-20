//! Per-frame timings of a Session (diagnostics):
//! `cargo run --release --example frame_timing -- <photo.jpg> [size] [runs <= 8]`.
use niho_develop::settings::HslBand;
use niho_develop::{DevelopSettings, Filter, Quality, Session};
use std::time::Instant;

fn main() {
    let path = std::env::args().nth(1).expect("photo");
    let size: usize = std::env::args()
        .nth(2)
        .map(|s| s.parse().unwrap())
        .unwrap_or(1280);
    let runs: usize = std::env::args()
        .nth(3)
        .map(|s| s.parse().unwrap())
        .unwrap_or(8)
        .clamp(1, 8); // the effect sliders stay in range up to 8 steps
    let bytes = std::fs::read(path).unwrap();
    let t = Instant::now();
    let mut session = Session::open_raster(&bytes, size, Filter::Lanczos3).unwrap();
    println!("open {:.1} ms", t.elapsed().as_secs_f64() * 1e3);
    let mut frame = |label: &str, s: &DevelopSettings, q: Quality| {
        let t = Instant::now();
        session.render(s, size, q).unwrap();
        println!("{label}: {:.1} ms", t.elapsed().as_secs_f64() * 1e3);
    };
    let neutral = DevelopSettings::neutral();
    frame("neutral", &neutral, Quality::Interactive);
    let mut e = neutral.clone();
    e.exposure = 0.1;
    frame("exposure 0.1 (bake P)", &e, Quality::Interactive);
    frame("exposure 0.1 (cached)", &e, Quality::Interactive);
    let mut v = neutral.clone();
    v.vibrance = 10.0;
    frame("vibrance 10 (bake Q)", &v, Quality::Interactive);
    frame("vibrance 10 (cached)", &v, Quality::Interactive);
    let mut sh = neutral.clone();
    sh.shadows = 30.0;
    frame("shadows 30 (stats + local)", &sh, Quality::Interactive);
    frame("shadows 30 (local)", &sh, Quality::Interactive);
    frame("shadows 30 final", &sh, Quality::Final);

    // NIHO effects (#17120 E1): a drag frame (the slider of the effect
    // moves every frame; its planes stay) and a released frame, averaged.
    let mut base = neutral.clone();
    base.contrast = 10.0;
    type Nudge = fn(&mut DevelopSettings, f64);
    let cases: [(&str, Nudge); 6] = [
        ("no effect (drag exposure)", |s, t| s.exposure = 0.01 * t),
        ("black & white (drag mix red)", |s, t| {
            s.grayscale = true;
            s.gray_mixer.set(HslBand::Red, 10.0 * t);
        }),
        ("vignette (drag amount)", |s, t| {
            s.vignette.amount = -10.0 * t
        }),
        ("grain (drag amount)", |s, t| s.grain.amount = 10.0 * t),
        ("grain (drag size: new field)", |s, t| {
            s.grain.amount = 30.0;
            s.grain.size = 20.0 + 5.0 * t;
        }),
        ("all (drag vignette amount)", |s, t| {
            s.grayscale = true;
            s.gray_mixer.set(HslBand::Blue, -30.0);
            s.color_grading.shadow.hue = 210.0;
            s.color_grading.shadow.saturation = 15.0;
            s.grain.amount = 30.0;
            s.vignette.amount = -10.0 * t;
        }),
    ];
    println!("| case | drag 1 frame (median) | final (median) |");
    println!("|---|---|---|");
    let median = |mut v: Vec<f64>| {
        v.sort_by(f64::total_cmp);
        v[v.len() / 2]
    };
    for (label, nudge) in cases {
        let at = |t: f64| {
            let mut s = base.clone();
            nudge(&mut s, t);
            s
        };
        session
            .render(&at(1.0), size, Quality::Interactive)
            .unwrap();
        let drag: Vec<f64> = (0..runs)
            .map(|i| {
                let s = at(2.0 + i as f64);
                let t0 = Instant::now();
                session.render(&s, size, Quality::Interactive).unwrap();
                t0.elapsed().as_secs_f64() * 1e3
            })
            .collect();
        let released = at(2.0 + runs as f64);
        session.render(&released, size, Quality::Final).unwrap();
        let fin: Vec<f64> = (0..runs)
            .map(|_| {
                let t0 = Instant::now();
                session.render(&released, size, Quality::Final).unwrap();
                t0.elapsed().as_secs_f64() * 1e3
            })
            .collect();
        println!(
            "| {label} | {:.1} ms | {:.1} ms |",
            median(drag),
            median(fin)
        );
    }
}
