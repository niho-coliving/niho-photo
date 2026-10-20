//! NIHO effects (#17120 E1): black & white, the post-crop vignette and grain
//! rendered through the JPEG / PNG and RAW working-copy paths.

use niho_develop::decode::{self, LinearImage};
use niho_develop::resize::{resample, Filter};
use niho_develop::settings::{HslBand, VignetteStyle};
use niho_develop::{DevelopSettings, Quality, RenderOptions, Rendered, Session};

fn png(width: u32, height: u32, pixel: impl Fn(u32, u32) -> [u8; 3]) -> Vec<u8> {
    let mut rgb = Vec::with_capacity((width * height * 3) as usize);
    for y in 0..height {
        for x in 0..width {
            rgb.extend_from_slice(&pixel(x, y));
        }
    }
    let img = image::RgbImage::from_raw(width, height, rgb).unwrap();
    let mut out = Vec::new();
    img.write_to(&mut std::io::Cursor::new(&mut out), image::ImageFormat::Png)
        .unwrap();
    out
}

fn gray_png(width: u32, height: u32) -> Vec<u8> {
    png(width, height, |_, _| [128, 128, 128])
}

fn render(input: &[u8], s: &DevelopSettings, max_dimension: usize) -> Rendered {
    let mut settings = s.clone();
    if settings.grayscale || settings.vignette.is_active() || settings.grain.is_active() {
        settings.v = 3;
    }
    niho_develop::render(
        input,
        &settings.to_json(),
        &RenderOptions {
            max_dimension,
            ..Default::default()
        },
    )
    .unwrap()
}

fn px(f: &Rendered, x: usize, y: usize) -> [u8; 3] {
    let i = (y * f.width + x) * 4;
    [f.rgba[i], f.rgba[i + 1], f.rgba[i + 2]]
}

/// Largest channel spread of a frame: black & white output is gray up to
/// one code (ProPhoto D50 gray through the 4-digit DNG matrices is not
/// exactly neutral in sRGB: row sums 0.99978 / 1.00009 / 0.99971).
fn max_spread(f: &Rendered) -> u8 {
    f.rgba
        .chunks_exact(4)
        .map(|p| p[0].max(p[1]).max(p[2]) - p[0].min(p[1]).min(p[2]))
        .max()
        .unwrap()
}

fn lum(p: [u8; 3]) -> f64 {
    0.2126 * p[0] as f64 + 0.7152 * p[1] as f64 + 0.0722 * p[2] as f64
}

/// Red, green and blue patches side by side (30 x 30 each).
fn patches() -> Vec<u8> {
    png(90, 30, |x, _| match x / 30 {
        0 => [210, 40, 40],
        1 => [60, 170, 60],
        _ => [40, 70, 210],
    })
}

#[test]
fn black_and_white_is_gray_and_the_mix_moves_each_band() {
    let input = patches();
    let mut gray = DevelopSettings::neutral();
    gray.v = 3;
    gray.grayscale = true;
    for quality in [Quality::Final, Quality::Interactive] {
        let mut session = Session::open_raster(&input, 0, Filter::Lanczos3).unwrap();
        let frame = session.render(&gray, 0, quality).unwrap();
        assert!(max_spread(&frame) <= 1, "{quality:?}");
    }
    let plain = render(&input, &gray, 0);
    let mut mixed = gray.clone();
    mixed.gray_mixer.set(HslBand::Red, 50.0);
    mixed.gray_mixer.set(HslBand::Blue, -50.0);
    let mixed = render(&input, &mixed, 0);
    let (red, green, blue) = ((15, 15), (45, 15), (75, 15));
    assert!(px(&mixed, red.0, red.1)[0] > px(&plain, red.0, red.1)[0] + 10);
    assert!(px(&mixed, blue.0, blue.1)[0] + 3 < px(&plain, blue.0, blue.1)[0]);
    // Green is between the two moved bands' neighbors: untouched.
    assert_eq!(px(&mixed, green.0, green.1), px(&plain, green.0, green.1));

    // The gray takes the grading (split toning a black & white photo).
    let mut toned = gray.clone();
    toned.color_grading.shadow.hue = 220.0;
    toned.color_grading.shadow.saturation = 40.0;
    toned.color_grading.highlight.hue = 40.0;
    toned.color_grading.highlight.saturation = 40.0;
    let toned = render(&input, &toned, 0);
    let chroma = |p: [u8; 3]| p.iter().max().unwrap() - p.iter().min().unwrap();
    assert!(
        toned
            .rgba
            .chunks_exact(4)
            .all(|p| chroma([p[0], p[1], p[2]]) > 2),
        "toned pixels stay colored"
    );
}

#[test]
fn black_and_white_keeps_the_color_values() {
    let mut s = DevelopSettings::neutral();
    s.saturation = 40.0;
    s.grayscale = true;
    let input = patches();
    let mut no_saturation = s.clone();
    no_saturation.saturation = 0.0;
    // Saturation does not act in black & white (Lightroom replaces the color
    // mixer), but its value is kept.
    assert_eq!(
        render(&input, &s, 0).rgba,
        render(&input, &no_saturation, 0).rgba
    );
    assert_eq!(
        DevelopSettings::from_value(&s.to_value())
            .unwrap()
            .saturation,
        40.0
    );
}

fn vignette(amount: f64) -> DevelopSettings {
    let mut s = DevelopSettings::neutral();
    s.v = 3;
    s.vignette.amount = amount;
    s
}

fn assert_symmetric(f: &Rendered) {
    let (w, h) = (f.width, f.height);
    for y in 0..h {
        for x in 0..w {
            let p = px(f, x, y);
            assert_eq!(p, px(f, w - 1 - x, y), "({x}, {y})");
            assert_eq!(p, px(f, x, h - 1 - y), "({x}, {y})");
        }
    }
}

#[test]
fn vignette_changes_the_edges_symmetrically_and_leaves_the_center() {
    let input = gray_png(300, 200);
    let neutral = render(&input, &DevelopSettings::neutral(), 0);
    let center = px(&neutral, 150, 100);
    for style in VignetteStyle::ALL {
        let mut dark = vignette(-60.0);
        dark.vignette.style = style;
        let mut bright = vignette(60.0);
        bright.vignette.style = style;
        let (dark, bright) = (render(&input, &dark, 0), render(&input, &bright, 0));
        // colorPriority / paintOverlay encode through the power table:
        // within one code of the plain encode.
        let near = |a: [u8; 3], b: [u8; 3]| (0..3).all(|c| a[c].abs_diff(b[c]) <= 1);
        assert!(near(px(&dark, 150, 100), center), "{style:?}");
        assert!(near(px(&bright, 150, 100), center), "{style:?}");
        assert!(lum(px(&dark, 0, 0)) + 30.0 < lum(center), "{style:?}");
        assert!(lum(px(&bright, 0, 0)) > lum(center) + 30.0, "{style:?}");
        assert!(lum(px(&dark, 0, 100)) < lum(center), "{style:?}");
        assert_symmetric(&dark);
        assert_symmetric(&bright);
    }
    // Highlight priority: exactly the plain pixels where the mask is 0.
    assert_eq!(px(&render(&input, &vignette(-60.0), 0), 150, 100), center);

    // A larger midpoint darkens fewer pixels.
    let darkened = |midpoint: f64| {
        let mut s = vignette(-60.0);
        s.vignette.midpoint = midpoint;
        let f = render(&input, &s, 0);
        f.rgba
            .chunks_exact(4)
            .filter(|p| (p[0] as f64) < center[0] as f64 - 2.0)
            .count()
    };
    let (near, middle, far) = (darkened(10.0), darkened(50.0), darkened(90.0));
    assert!(
        near > middle && middle > far && far > 0,
        "{near} {middle} {far}"
    );

    // Highlights: bright pixels take less of a darkening highlight-priority
    // vignette (round9), dark ones all of it.
    let bright = png(300, 200, |_, _| [230, 230, 230]);
    let dark = png(300, 200, |_, _| [80, 80, 80]);
    let mut s = vignette(-60.0);
    let plain = render(&bright, &s, 0);
    let plain_dark = render(&dark, &s, 0);
    s.vignette.highlights = 100.0;
    let kept = render(&bright, &s, 0);
    assert!(!kept.approximations.contains(&"vignetteHighlightContrast"));
    assert!(lum(px(&kept, 0, 0)) > lum(px(&plain, 0, 0)) + 60.0);
    assert_eq!(render(&dark, &s, 0).rgba, plain_dark.rgba);
    s.vignette.highlights = 50.0;
    let half = render(&bright, &s, 0);
    assert!(lum(px(&half, 0, 0)) > lum(px(&plain, 0, 0)) + 20.0);
    assert!(lum(px(&half, 0, 0)) + 20.0 < lum(px(&kept, 0, 0)));
    // Color priority keeps the value only.
    s.vignette.style = VignetteStyle::ColorPriority;
    let f = render(&bright, &s, 0);
    assert!(f.approximations.contains(&"vignetteHighlightContrast"));
    s.vignette.highlights = 0.0;
    let without = render(&bright, &s, 0);
    assert!(!without
        .approximations
        .contains(&"vignetteHighlightContrast"));
    assert_eq!(f.rgba, without.rgba);
}

#[test]
fn bright_highlight_priority_vignette_blends_toward_white_without_overshoot() {
    // round8: Lightroom brightens by blending toward white before the tone
    // stages, so white stays white (no clipped overshoot) and gray lifts.
    let white = png(300, 200, |_, _| [255, 255, 255]);
    let mut settings = vignette(100.0);
    assert!(niho_develop::pipeline::has_active_color_edits(&settings));
    let frame = render(&white, &settings, 0);
    // White stays at the output shoulder's white everywhere: no overshoot.
    assert_eq!(px(&frame, 0, 0), px(&frame, 150, 100));
    assert!(px(&frame, 150, 100).iter().all(|c| *c >= 254));

    let gray = png(300, 200, |_, _| [118, 118, 118]);
    let frame = render(&gray, &settings, 0);
    let (center, corner) = (px(&frame, 150, 100), px(&frame, 0, 0));
    assert!(corner[0] > center[0] + 20, "{center:?} {corner:?}");

    // Encoded-output styles do not apply the linear highlight shoulder.
    settings.vignette.style = VignetteStyle::ColorPriority;
    assert!(!niho_develop::pipeline::has_active_color_edits(&settings));
}

#[test]
fn vignette_follows_the_frame_at_any_size() {
    let input = gray_png(1200, 800);
    for roundness in [-60.0, 0.0, 60.0] {
        let mut s = vignette(-70.0);
        s.vignette.roundness = roundness;
        s.vignette.feather = 30.0;
        let small = render(&input, &s, 600);
        let large = render(&input, &s, 1200);
        assert_eq!((small.width, large.width), (600, 1200));
        let mut max_diff = 0.0f64;
        for y in 0..small.height {
            for x in 0..small.width {
                // The 2 x 2 block of the large frame has the same center.
                let block: f64 = [(0, 0), (1, 0), (0, 1), (1, 1)]
                    .iter()
                    .map(|(dx, dy)| px(&large, 2 * x + dx, 2 * y + dy)[0] as f64)
                    .sum::<f64>()
                    / 4.0;
                max_diff = max_diff.max((px(&small, x, y)[0] as f64 - block).abs());
            }
        }
        assert!(max_diff <= 2.0, "roundness {roundness}: {max_diff}");
    }
}

fn grain(amount: f64, seed: Option<f64>) -> DevelopSettings {
    let mut s = DevelopSettings::neutral();
    s.v = 3;
    s.grain.amount = amount;
    s.grain.seed = seed;
    s
}

#[test]
fn grain_is_seeded_zero_mean_and_off_at_zero() {
    let input = gray_png(512, 512);
    let neutral = render(&input, &DevelopSettings::neutral(), 0);
    let mut off = grain(0.0, Some(9.0));
    off.grain.size = 80.0;
    off.grain.roughness = 10.0;
    assert_eq!(render(&input, &off, 0).rgba, neutral.rgba);

    let a = render(&input, &grain(60.0, Some(1.0)), 0);
    let b = render(&input, &grain(60.0, Some(1.0)), 0);
    let c = render(&input, &grain(60.0, Some(2.0)), 0);
    let d = render(&input, &grain(60.0, None), 0);
    assert_eq!(a.rgba, b.rgba);
    let differing = |x: &Rendered, y: &Rendered| {
        x.rgba
            .chunks_exact(4)
            .zip(y.rgba.chunks_exact(4))
            .filter(|(p, q)| p != q)
            .count()
    };
    assert!(differing(&a, &c) > 512 * 512 / 2);
    assert!(differing(&a, &d) > 512 * 512 / 2);
    // Monochrome, zero mean.
    let base = px(&neutral, 0, 0)[0] as f64;
    let mut sum = 0.0;
    for p in a.rgba.chunks_exact(4) {
        assert!(p[0] == p[1] && p[1] == p[2], "{p:?}");
        sum += p[0] as f64 - base;
    }
    let mean = sum / (512.0 * 512.0);
    assert!(mean.abs() < 0.25, "{mean}");
    assert!(differing(&a, &neutral) > 512 * 512 / 2);
}

/// Standard deviation and the autocorrelation's half width (pixels, mean
/// of x and y) of the green channel's deviation from its mean.
fn grain_statistics(rgb: &[f64], w: usize, h: usize) -> (f64, f64) {
    let g: Vec<f64> = rgb.chunks_exact(3).map(|p| p[1]).collect();
    let mean = g.iter().sum::<f64>() / g.len() as f64;
    let d: Vec<f64> = g.iter().map(|v| v - mean).collect();
    let var = d.iter().map(|v| v * v).sum::<f64>() / d.len() as f64;
    let corr = |dx: usize, dy: usize| {
        let mut sum = 0.0;
        let mut n = 0.0;
        for y in 0..h - dy {
            for x in 0..w - dx {
                sum += d[y * w + x] * d[(y + dy) * w + x + dx];
                n += 1.0;
            }
        }
        sum / n / var
    };
    let half = |step: &dyn Fn(usize) -> f64| {
        let mut previous = 1.0;
        for k in 1..20 {
            let r = step(k);
            if r <= 0.5 {
                return (k - 1) as f64 + (previous - 0.5) / (previous - r);
            }
            previous = r;
        }
        20.0
    };
    let hx = half(&|k| corr(k, 0));
    let hy = half(&|k| corr(0, k));
    (var.sqrt(), (hx + hy) / 2.0)
}

fn encoded(f: &Rendered) -> Vec<f64> {
    f.rgba
        .chunks_exact(4)
        .flat_map(|p| [p[0] as f64, p[1] as f64, p[2] as f64])
        .collect()
}

#[test]
fn grain_looks_the_same_at_any_output_size() {
    // A 2048 px frame reduced to 1280 px by area averaging against a frame
    // drawn at 1280 px: the same grain relative to the photo.
    let input = gray_png(2048, 1366);
    for (size, roughness) in [(25.0, 50.0), (0.0, 0.0), (70.0, 100.0)] {
        let mut s = grain(100.0, Some(5.0));
        s.grain.size = size;
        s.grain.roughness = roughness;
        let large = render(&input, &s, 2048);
        let direct = render(&input, &s, 1280);
        let (w, h) = (direct.width, direct.height);
        assert_eq!((large.width, large.height), (2048, 1366));
        let large_f32: Vec<f32> = encoded(&large).iter().map(|v| *v as f32).collect();
        let reduced: Vec<f64> = resample(&large_f32, 2048, 1366, w, h, Filter::Area)
            .iter()
            .map(|v| *v as f64)
            .collect();
        let (sd_direct, half_direct) = grain_statistics(&encoded(&direct), w, h);
        let (sd_reduced, half_reduced) = grain_statistics(&reduced, w, h);
        eprintln!(
            "grain size {size} roughness {roughness}: sd {sd_direct:.3} vs reduced {sd_reduced:.3}, half width {half_direct:.3} vs {half_reduced:.3}"
        );
        assert!(
            (sd_direct / sd_reduced - 1.0).abs() <= 0.15,
            "size {size}: sd {sd_direct} vs {sd_reduced}"
        );
        assert!(
            (half_direct / half_reduced - 1.0).abs() <= 0.20,
            "size {size}: half width {half_direct} vs {half_reduced}"
        );
    }
}

#[test]
fn drag_and_final_frames_put_the_effects_at_the_same_places() {
    let input = png(240, 160, |x, y| {
        [(40 + x / 2) as u8, (60 + y / 2) as u8, (200 - x / 3) as u8]
    });
    let mut s = DevelopSettings::neutral();
    s.v = 3;
    s.contrast = 20.0;
    s.vignette.amount = -50.0;
    s.grain.amount = 50.0;
    s.grain.size = 80.0;
    let mut plain = s.clone();
    plain.vignette.amount = 0.0;
    plain.grain.amount = 0.0;
    let mut session = Session::open_raster(&input, 0, Filter::Lanczos3).unwrap();
    let delta = |session: &mut Session, q: Quality| -> Vec<f64> {
        let with = session.render(&s, 0, q).unwrap();
        let without = session.render(&plain, 0, q).unwrap();
        encoded(&with)
            .iter()
            .zip(encoded(&without))
            .map(|(a, b)| a - b)
            .collect()
    };
    let released = delta(&mut session, Quality::Final);
    let dragged = delta(&mut session, Quality::Interactive);
    let n = released.len() as f64;
    let dot: f64 = released.iter().zip(&dragged).map(|(a, b)| a * b).sum();
    let norm = |v: &[f64]| v.iter().map(|x| x * x).sum::<f64>().sqrt();
    let correlation = dot / (norm(&released) * norm(&dragged));
    let mean_abs = released
        .iter()
        .zip(&dragged)
        .map(|(a, b)| (a - b).abs())
        .sum::<f64>()
        / n;
    assert!(correlation > 0.98, "{correlation}");
    assert!(mean_abs < 1.5, "{mean_abs}");
}

/// A RAW-like working copy (linear ProPhoto, a smooth ramp).
fn working_copy() -> Vec<u8> {
    let (w, h) = (160usize, 120usize);
    let mut data = Vec::with_capacity(w * h * 3);
    for y in 0..h {
        for x in 0..w {
            let t = x as f32 / (w - 1) as f32;
            let u = y as f32 / (h - 1) as f32;
            data.extend_from_slice(&[0.05 + 0.3 * t, 0.12, 0.05 + 0.25 * u]);
        }
    }
    decode::encode_working_copy(&LinearImage {
        width: w,
        height: h,
        data,
    })
}

const RAW_META: &str = r#"{"kind":"raw","baselineEV":0.35,"asShotWhite":{"x":0.3324,"y":0.3474},"dcpSha256":"test","lookTableIncluded":true}"#;

#[test]
fn effects_render_on_raw_working_copies() {
    let png = working_copy();
    let mut session = Session::open_working_copy(&png, RAW_META, Filter::Lanczos3).unwrap();
    let neutral = session
        .render(&DevelopSettings::neutral(), 0, Quality::Final)
        .unwrap();
    let mut gray = DevelopSettings::neutral();
    gray.v = 3;
    gray.grayscale = true;
    for q in [Quality::Final, Quality::Interactive] {
        let f = session.render(&gray, 0, q).unwrap();
        assert!(max_spread(&f) <= 1, "{q:?}");
    }
    let f = session.render(&vignette(-60.0), 0, Quality::Final).unwrap();
    assert_eq!(px(&f, 80, 60), px(&neutral, 80, 60));
    assert!(lum(px(&f, 0, 0)) + 10.0 < lum(px(&neutral, 0, 0)));
    let f = session
        .render(&grain(80.0, Some(3.0)), 0, Quality::Final)
        .unwrap();
    assert_ne!(f.rgba, neutral.rgba);
}
