//! Research-only calibration evaluator for analytic H/S candidate B (#26).
//!
//! It never fits anything itself: a driver outside the crate
//! (`tools/calibrate/fit_analytic_hs.py`) proposes coefficients and reads
//! the errors back. Inputs and references are paths supplied at run time
//! (private teachers stay outside the repository); nothing is written but
//! the requested settings / manifest files and stdout.
//!
//! ```text
//! analytic_hs_calibrate settings <out-dir>
//!     developSettings JSON of every evaluated variant on a new niho-10 edit
//!     (H/S amounts, and the bundled presets through xmp::apply_preset).
//! analytic_hs_calibrate freeze <coefficients.json> <manifest.json>
//!     a frozen niho.analytic-hs-candidate.v1 with its canonical SHA-256.
//! analytic_hs_calibrate serve <config.json>
//!     loads the items once, then answers one JSON request per stdin line:
//!     {"op":"eval","candidate":{formula,residual},"items":[...]} or
//!     {"op":"baseline","items":[...]} -> {"rows":[[mean,p99,p95,dL],...]}.
//! ```
//!
//! The error is a reduced-size stand-in of the gate (the gate itself is
//! measured on 2048px renders with colorcheck). The H/S gains are computed at
//! `longEdge` (1024 keeps the local-Laplacian depths of 2048 relative to the
//! frame); the prepared image is then area-reduced to `metricLongEdge`
//! (512), rendered there by the unchanged downstream stages, blurred in
//! linear light with sigma `2 * edge / 1500`, and CIEDE2000 (Lab D50) is
//! taken on a fixed sample of the reference's flat pixels (4% border
//! removed).
//!
//! `"gains": "exact"` uses `analytic_hs::prepare_with_statistics`.
//! `"gains": "fast"` (default) caches the curve-independent parts of the two
//! local-Laplacian stages per photo: the Highlights stage is
//! `ln + up(curve(G_L))` exactly; the Shadows stage is
//! `R(ln) + up(curve(G_L))` with `R` the remapped detail, taken as
//! `R(ln0) + (ln - ln0)` (exact for exposure, and for the very smooth
//! Highlights gain an approximation). Only `exact` is used for gate numbers.

use niho_develop::decode::LinearImage;
use niho_develop::decode::{decode_raster, Raster};
use niho_develop::niho6::SourceSpace;
use niho_develop::pipeline::{render_raster, SettingsCubes};
use niho_develop::research::analytic_hs::{
    analysis_from_statistics, apply_gains, downstream_settings, exposed_luminance,
    prepare_with_statistics, resolve, scene_statistics, Candidate, GainPlanes,
};
use niho_develop::research::linear_jpeg_wb::delta_e00;
use niho_develop::spatial::{self, GainScale, Plane, SpatialParams};
use niho_develop::{xmp, DevelopSettings, Filter, Quality};
use serde_json::{json, Value};
use std::io::{BufRead, Write};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::Mutex;
use std::time::Instant;

const ENGINE: &str = "niho-10";
const LOOK: &str = "niho-standard-1";
const CROP: f64 = 0.04;
const EDGE_GRAD_L_AT_1500: f64 = 1.5;
const EDGE_DILATE_AT_1500: f64 = 2.0;
const FLAT_MIN_FRACTION: f64 = 0.05;

/// Lindbloom's Bradford-adapted linear sRGB -> XYZ (D50), as colorcheck.
const SRGB_TO_XYZ_D50: [[f64; 3]; 3] = [
    [0.4360747, 0.3850649, 0.1430804],
    [0.2225045, 0.7168786, 0.0606169],
    [0.0139322, 0.0971045, 0.7141733],
];
const D50_WHITE: [f64; 3] = [0.96422, 1.0, 0.82521];

fn lab(rgb: [f64; 3]) -> [f64; 3] {
    let mut xyz = [0.0; 3];
    for (row, out) in SRGB_TO_XYZ_D50.iter().zip(xyz.iter_mut()) {
        *out = row[0] * rgb[0] + row[1] * rgb[1] + row[2] * rgb[2];
    }
    let eps = 216.0 / 24389.0;
    let kappa = 24389.0 / 27.0;
    let f = |t: f64| {
        if t > eps {
            t.cbrt()
        } else {
            (kappa * t + 16.0) / 116.0
        }
    };
    let fx = f(xyz[0] / D50_WHITE[0]);
    let fy = f(xyz[1] / D50_WHITE[1]);
    let fz = f(xyz[2] / D50_WHITE[2]);
    [116.0 * fy - 16.0, 500.0 * (fx - fy), 200.0 * (fy - fz)]
}

fn srgb_decode(v: f64) -> f64 {
    if v <= 0.04045 {
        v / 12.92
    } else {
        ((v + 0.055) / 1.055).powf(2.4)
    }
}

fn neutral_edit() -> DevelopSettings {
    let mut settings = DevelopSettings::neutral();
    settings.engine = ENGINE.into();
    settings.look = LOOK.into();
    settings
}

fn variant_settings() -> Result<Vec<(String, DevelopSettings)>, String> {
    let base = neutral_edit();
    let mut out = vec![("neutral".to_string(), base.clone())];
    for (name, highlights, shadows) in [
        ("h30", -30.0, 0.0),
        ("h60", -60.0, 0.0),
        ("h100", -100.0, 0.0),
        ("s30", 0.0, 30.0),
        ("s60", 0.0, 60.0),
        ("s100", 0.0, 100.0),
        ("h60s30", -60.0, 30.0),
        ("h100s100", -100.0, 100.0),
    ] {
        let mut settings = base.clone();
        settings.highlights = highlights;
        settings.shadows = shadows;
        out.push((name.to_string(), settings));
    }
    for preset in ["bluesky2", "pastel", "colorful"] {
        let builtin = xmp::builtin_preset(&format!("niho-{preset}"))
            .ok_or_else(|| format!("unknown preset {preset}"))?;
        let applied = xmp::apply_preset(builtin.xmp, &base, 1.0, None)
            .map_err(|error| format!("{error:?}"))?;
        out.push((format!("preset_{preset}"), applied.settings));
    }
    Ok(out)
}

/// The curve-independent parts of one direction's local-Laplacian stage.
struct Level {
    /// Dimensions of Gaussian levels 0..=L.
    dims: Vec<(usize, usize)>,
    base: Plane,
    /// Shadows only: `R(ln0) - ln0`, the remapped detail.
    detail: Vec<f32>,
}

/// One photo's cached stages at the gain size.
struct Cached {
    ln0: Plane,
    highlight: Level,
    shadow: Level,
}

struct Scene {
    /// The source at the gain size.
    raster: Raster,
    /// The source at the metric size (baseline renders).
    small: Raster,
    statistics: (f64, f64),
    cached: Option<Cached>,
}

struct Item {
    scene: usize,
    settings: DevelopSettings,
    downstream: DevelopSettings,
    /// Sample pixel indices of the frame and the reference Lab there.
    samples: Vec<usize>,
    reference_lab: Vec<[f64; 3]>,
    baseline_cubes: Mutex<Option<SettingsCubes>>,
    candidate_cubes: Mutex<Option<SettingsCubes>>,
}

const GRID_START: f64 = -14.0;
const GRID_STEP: f64 = 0.5;
/// `spatial.rs` `SHADOWS_LEVELS_OFFSET`.
const SHADOWS_LEVELS_OFFSET: isize = -3;

/// `np.interp` on the tables' grid (`spatial.rs` `interp_curve`).
fn interp_curve(x: f64, curve: &[f64; 29]) -> f64 {
    let last = GRID_START + 28.0 * GRID_STEP;
    if x <= GRID_START {
        return curve[0];
    }
    if x >= last {
        return curve[28];
    }
    let t = (x - GRID_START) / GRID_STEP;
    let i = (t.floor() as usize).min(27);
    curve[i] + (curve[i + 1] - curve[i]) * (t - i as f64)
}

fn pyramid_dims(width: usize, height: usize, levels: usize) -> Vec<(usize, usize)> {
    let mut dims = vec![(width, height)];
    for _ in 0..levels {
        let (w, h) = *dims.last().unwrap();
        dims.push((w.div_ceil(2), h.div_ceil(2)));
    }
    dims
}

fn coarse(plane: &Plane, levels: usize) -> Plane {
    let mut level = plane.clone();
    for _ in 0..levels {
        level = spatial::pyr_down(&level);
    }
    level
}

/// `up^L(values)` from level L to level 0 through the pyramid's sizes.
fn upsample(mut values: Plane, dims: &[(usize, usize)]) -> Plane {
    for &(w, h) in dims[..dims.len() - 1].iter().rev() {
        values = spatial::pyr_up(&values, w, h);
    }
    values
}

impl Cached {
    fn new(image: &LinearImage) -> Self {
        let ln0 = exposed_luminance(image, SourceSpace::LinearSrgb, 0.0);
        let long_edge = image.width.max(image.height);
        let scale_px = spatial::scale_px(long_edge as f64);
        let levels_h = spatial::levels_for_scale(scale_px);
        let levels_s = (levels_h as isize + SHADOWS_LEVELS_OFFSET).max(1) as usize;
        let params = SpatialParams {
            highlights: 0.0,
            shadows: 100.0,
            texture: 0.0,
            clarity: 0.0,
            scale_px,
            long_edge,
            gain_scale: GainScale {
                highlights_neg: 0.0,
                highlights_pos: 0.0,
                shadows_neg: 0.0,
                shadows_pos: 0.0,
            },
            shift: Default::default(),
            quality: Quality::Final,
        };
        // A zero curve leaves only the remapped detail R(ln0).
        let detail = spatial::spatial_luminance(&ln0, &params).expect("shadows stage");
        Self {
            highlight: Level {
                dims: pyramid_dims(image.width, image.height, levels_h),
                base: coarse(&ln0, levels_h),
                detail: Vec::new(),
            },
            shadow: Level {
                dims: pyramid_dims(image.width, image.height, levels_s),
                base: coarse(&ln0, levels_s),
                detail: detail
                    .data
                    .iter()
                    .zip(&ln0.data)
                    .map(|(r, l)| r - l)
                    .collect(),
            },
            ln0,
        }
    }

    fn gains(
        &self,
        settings: &DevelopSettings,
        candidate: &Candidate,
        exposure: f32,
        statistics: (f64, f64),
    ) -> GainPlanes {
        let analysis = analysis_from_statistics(statistics, settings.exposure, candidate.residual);
        let resolved = resolve(&candidate.formula, analysis);
        let highlights = settings.highlights.min(0.0);
        let shadows = settings.shadows.max(0.0);
        let curve_plane = |base: &Plane, extra: Option<&Plane>, table: &[f64; 29], shift: f64| {
            let mut out = Plane::new(base.width, base.height);
            for (i, (dst, v)) in out.data.iter_mut().zip(&base.data).enumerate() {
                let x = f64::from(*v + exposure + extra.map_or(0.0, |e| e.data[i]));
                *dst = interp_curve(x - shift, table) as f32;
            }
            out
        };
        let highlight = (highlights < 0.0).then(|| {
            let table = spatial::highlights_gain_curve(
                highlights,
                GainScale {
                    highlights_neg: resolved.highlight_scale,
                    highlights_pos: 0.0,
                    shadows_neg: 0.0,
                    shadows_pos: 0.0,
                },
            );
            let d = curve_plane(&self.highlight.base, None, &table, resolved.highlight_shift);
            upsample(d, &self.highlight.dims)
        });
        let shadow = (shadows > 0.0).then(|| {
            let table = spatial::shadows_gain_curve(
                shadows,
                GainScale {
                    highlights_neg: 0.0,
                    highlights_pos: 0.0,
                    shadows_neg: 0.0,
                    shadows_pos: resolved.shadow_scale,
                },
            );
            let extra = highlight
                .as_ref()
                .map(|gain| coarse(gain, self.shadow.dims.len() - 1));
            let d = curve_plane(
                &self.shadow.base,
                extra.as_ref(),
                &table,
                resolved.shadow_shift,
            );
            let mut d = upsample(d, &self.shadow.dims);
            for (v, r) in d.data.iter_mut().zip(&self.shadow.detail) {
                *v += r;
            }
            d.data
        });
        (highlight.map(|p| p.data), shadow)
    }
}

struct Frame {
    width: usize,
    height: usize,
    sigma: f64,
    kernel: Vec<f64>,
}

impl Frame {
    fn new(width: usize, height: usize) -> Self {
        let long_edge = width.max(height) as f64;
        let sigma = 2.0 * long_edge / 1500.0;
        let radius = (4.0 * sigma).ceil() as isize;
        let mut kernel: Vec<f64> = (-radius..=radius)
            .map(|o| (-((o * o) as f64) / (2.0 * sigma * sigma)).exp())
            .collect();
        let sum: f64 = kernel.iter().sum();
        for k in &mut kernel {
            *k /= sum;
        }
        Self {
            width,
            height,
            sigma,
            kernel,
        }
    }

    fn radius(&self) -> isize {
        (self.kernel.len() / 2) as isize
    }

    /// reflect-101 index.
    fn reflect(i: isize, n: usize) -> usize {
        let n = n as isize;
        if n <= 1 {
            return 0;
        }
        let period = 2 * (n - 1);
        let mut r = i.rem_euclid(period);
        if r >= n {
            r = period - r;
        }
        r as usize
    }

    /// Full separable blur of a linear RGB image.
    fn blur(&self, data: &[f32]) -> Vec<f64> {
        let (w, h, r) = (self.width, self.height, self.radius());
        let mut horizontal = vec![0.0f64; w * h * 3];
        for y in 0..h {
            for x in 0..w {
                let mut acc = [0.0f64; 3];
                for (k, weight) in self.kernel.iter().enumerate() {
                    let sx = Self::reflect(x as isize + k as isize - r, w);
                    let p = (y * w + sx) * 3;
                    for c in 0..3 {
                        acc[c] += weight * f64::from(data[p + c]);
                    }
                }
                horizontal[(y * w + x) * 3..(y * w + x) * 3 + 3].copy_from_slice(&acc);
            }
        }
        let mut out = vec![0.0f64; w * h * 3];
        for y in 0..h {
            for x in 0..w {
                let mut acc = [0.0f64; 3];
                for (k, weight) in self.kernel.iter().enumerate() {
                    let sy = Self::reflect(y as isize + k as isize - r, h);
                    let p = (sy * w + x) * 3;
                    for c in 0..3 {
                        acc[c] += weight * horizontal[p + c];
                    }
                }
                out[(y * w + x) * 3..(y * w + x) * 3 + 3].copy_from_slice(&acc);
            }
        }
        out
    }

    /// The blurred linear value of an 8-bit sRGB frame at one pixel.
    fn blurred_at(&self, rgba: &[u8], lut: &[f64; 256], index: usize) -> [f64; 3] {
        let (w, h, r) = (self.width, self.height, self.radius());
        let (x, y) = ((index % w) as isize, (index / w) as isize);
        let mut acc = [0.0f64; 3];
        for (ky, wy) in self.kernel.iter().enumerate() {
            let sy = Self::reflect(y + ky as isize - r, h);
            for (kx, wx) in self.kernel.iter().enumerate() {
                let sx = Self::reflect(x + kx as isize - r, w);
                let p = (sy * w + sx) * 4;
                let weight = wy * wx;
                for c in 0..3 {
                    acc[c] += weight * lut[rgba[p + c] as usize];
                }
            }
        }
        acc
    }
}

/// Flat pixels of the blurred reference (colorcheck's edge rule scaled to
/// this frame) inside the 4% crop, then a deterministic sample of them.
fn sample_flat(frame: &Frame, lab: &[[f64; 3]], count: usize, seed: u64) -> Vec<usize> {
    let (w, h) = (frame.width, frame.height);
    let scale = 1500.0 / w.max(h) as f64;
    let limit = EDGE_GRAD_L_AT_1500 * scale;
    let dilate = (EDGE_DILATE_AT_1500 / scale).round().max(1.0) as isize;
    let l = |x: usize, y: usize| lab[y * w + x][0];
    let mut edge = vec![false; w * h];
    for y in 0..h {
        for x in 0..w {
            let gx = if x == 0 {
                l(1, y) - l(0, y)
            } else if x == w - 1 {
                l(x, y) - l(x - 1, y)
            } else {
                0.5 * (l(x + 1, y) - l(x - 1, y))
            };
            let gy = if y == 0 {
                l(x, 1) - l(x, 0)
            } else if y == h - 1 {
                l(x, y) - l(x, y - 1)
            } else {
                0.5 * (l(x, y + 1) - l(x, y - 1))
            };
            edge[y * w + x] = gx.hypot(gy) > limit;
        }
    }
    let mut grown = edge.clone();
    for y in 0..h as isize {
        for x in 0..w as isize {
            if !edge[y as usize * w + x as usize] {
                continue;
            }
            for dy in -dilate..=dilate {
                for dx in -dilate..=dilate {
                    let (yy, xx) = (y + dy, x + dx);
                    if yy >= 0 && xx >= 0 && (yy as usize) < h && (xx as usize) < w {
                        grown[yy as usize * w + xx as usize] = true;
                    }
                }
            }
        }
    }
    let my = (h as f64 * CROP).round() as usize;
    let mx = (w as f64 * CROP).round() as usize;
    let mut inside = Vec::new();
    let mut flat = Vec::new();
    for y in my..h - my {
        for x in mx..w - mx {
            inside.push(y * w + x);
            if !grown[y * w + x] {
                flat.push(y * w + x);
            }
        }
    }
    let mut pool = if (flat.len() as f64) < FLAT_MIN_FRACTION * inside.len() as f64 {
        inside
    } else {
        flat
    };
    // xorshift64* Fisher-Yates (fixed seed: the same pixels every request).
    let mut state = seed.wrapping_mul(0x9E37_79B9_7F4A_7C15) | 1;
    let mut next = || {
        state ^= state >> 12;
        state ^= state << 25;
        state ^= state >> 27;
        state.wrapping_mul(0x2545_F491_4F6C_DD1D)
    };
    let take = count.min(pool.len());
    for i in 0..take {
        let j = i + (next() % (pool.len() - i) as u64) as usize;
        pool.swap(i, j);
    }
    pool.truncate(take);
    pool.sort_unstable();
    pool
}

fn decode(path: &Path, long_edge: usize) -> Result<Raster, String> {
    let bytes = std::fs::read(path).map_err(|e| format!("{}: {e}", path.display()))?;
    decode_raster(&bytes, long_edge, Filter::Lanczos3).map_err(|e| format!("decode: {e:?}"))
}

fn parallel<T: Send>(threads: usize, count: usize, job: impl Fn(usize) -> T + Sync) -> Vec<T> {
    let next = AtomicUsize::new(0);
    let results: Vec<Mutex<Option<T>>> = (0..count).map(|_| Mutex::new(None)).collect();
    std::thread::scope(|scope| {
        for _ in 0..threads.max(1) {
            scope.spawn(|| loop {
                let i = next.fetch_add(1, Ordering::SeqCst);
                if i >= count {
                    break;
                }
                let value = job(i);
                *results[i].lock().unwrap() = Some(value);
            });
        }
    });
    results
        .into_iter()
        .map(|m| m.into_inner().unwrap().unwrap())
        .collect()
}

fn percentile(sorted: &[f64], p: f64) -> f64 {
    if sorted.is_empty() {
        return f64::NAN;
    }
    let rank = p / 100.0 * (sorted.len() - 1) as f64;
    let lo = rank.floor() as usize;
    let hi = rank.ceil() as usize;
    sorted[lo] + (sorted[hi] - sorted[lo]) * (rank - lo as f64)
}

struct Server {
    scenes: Vec<Scene>,
    items: Vec<Item>,
    frames: Vec<Frame>,
    threads: usize,
    fast: bool,
    lut: [f64; 256],
}

fn reduce(image: &LinearImage, width: usize, height: usize) -> LinearImage {
    LinearImage {
        width,
        height,
        data: niho_develop::resize::resample(
            &image.data,
            image.width,
            image.height,
            width,
            height,
            Filter::Area,
        ),
    }
}

impl Server {
    fn load(config: &Value) -> Result<Self, String> {
        let long_edge = config["longEdge"].as_u64().unwrap_or(1024) as usize;
        let metric_edge = config["metricLongEdge"].as_u64().unwrap_or(512) as usize;
        let sample_count = config["samples"].as_u64().unwrap_or(8000) as usize;
        let threads = config["threads"].as_u64().unwrap_or(4) as usize;
        let seed = config["seed"].as_u64().unwrap_or(26);
        let fast = config["gains"].as_str().unwrap_or("fast") == "fast";
        let scene_paths: Vec<PathBuf> = config["scenes"]
            .as_array()
            .ok_or("scenes")?
            .iter()
            .map(|s| PathBuf::from(s["input"].as_str().unwrap_or_default()))
            .collect();
        let scenes: Vec<Result<Scene, String>> = parallel(threads, scene_paths.len(), |i| {
            let raster = decode(&scene_paths[i], long_edge)?;
            let small = decode(&scene_paths[i], metric_edge)?;
            let small = Raster {
                image: reduce(&raster.image, small.image.width, small.image.height),
                info: raster.info.clone(),
            };
            let statistics = scene_statistics(&raster.image, SourceSpace::LinearSrgb);
            let cached = fast.then(|| Cached::new(&raster.image));
            Ok(Scene {
                raster,
                small,
                statistics,
                cached,
            })
        });
        let scenes: Vec<Scene> = scenes.into_iter().collect::<Result<_, _>>()?;
        let frames: Vec<Frame> = scenes
            .iter()
            .map(|s| Frame::new(s.small.image.width, s.small.image.height))
            .collect();
        let item_specs = config["items"].as_array().ok_or("items")?.clone();
        let items: Vec<Result<Item, String>> = parallel(threads, item_specs.len(), |i| {
            let spec = &item_specs[i];
            let scene = spec["scene"].as_u64().ok_or("item scene")? as usize;
            let settings_path = spec["settings"].as_str().ok_or("item settings")?;
            let text = std::fs::read_to_string(settings_path).map_err(|e| e.to_string())?;
            let settings = DevelopSettings::from_json(&text).map_err(|e| format!("{e:?}"))?;
            let reference = decode(
                Path::new(spec["reference"].as_str().ok_or("ref")?),
                metric_edge,
            )?;
            let frame = &frames[scene];
            let data = reduce(&reference.image, frame.width, frame.height).data;
            let blurred = frame.blur(&data);
            let lab_plane: Vec<[f64; 3]> = blurred
                .chunks_exact(3)
                .map(|p| lab([p[0], p[1], p[2]]))
                .collect();
            let samples = sample_flat(frame, &lab_plane, sample_count, seed + i as u64);
            let reference_lab = samples.iter().map(|&p| lab_plane[p]).collect();
            Ok(Item {
                scene,
                downstream: downstream_settings(&settings),
                settings,
                samples,
                reference_lab,
                baseline_cubes: Mutex::new(None),
                candidate_cubes: Mutex::new(None),
            })
        });
        let items: Vec<Item> = items.into_iter().collect::<Result<_, _>>()?;
        let mut lut = [0.0f64; 256];
        for (i, v) in lut.iter_mut().enumerate() {
            *v = srgb_decode(i as f64 / 255.0);
        }
        Ok(Self {
            scenes,
            items,
            frames,
            threads,
            fast,
            lut,
        })
    }

    fn metrics(&self, item: &Item, rgba: &[u8]) -> [f64; 4] {
        let frame = &self.frames[item.scene];
        let mut errors = Vec::with_capacity(item.samples.len());
        let mut dl = 0.0;
        for (&index, reference) in item.samples.iter().zip(&item.reference_lab) {
            let candidate = lab(frame.blurred_at(rgba, &self.lut, index));
            errors.push(delta_e00(*reference, candidate));
            dl += candidate[0] - reference[0];
        }
        let n = errors.len().max(1) as f64;
        let mean = errors.iter().sum::<f64>() / n;
        errors.sort_by(f64::total_cmp);
        [
            mean,
            percentile(&errors, 99.0),
            percentile(&errors, 95.0),
            dl / n,
        ]
    }

    fn prepared(&self, item: &Item, candidate: &Candidate) -> Result<LinearImage, String> {
        let scene = &self.scenes[item.scene];
        let settings = &item.settings;
        if settings.highlights >= 0.0 && settings.shadows <= 0.0 {
            return Ok(scene.small.image.clone());
        }
        let full = match &scene.cached {
            Some(cached) => {
                let candidate = candidate.validate()?;
                let analysis = analysis_from_statistics(
                    scene.statistics,
                    settings.exposure,
                    candidate.residual,
                );
                let exposure = analysis.exposure_ev as f32;
                let (gh, gs) = cached.gains(settings, &candidate, exposure, scene.statistics);
                let mut exposed = cached.ln0.clone();
                for v in &mut exposed.data {
                    *v += exposure;
                }
                apply_gains(
                    &scene.raster.image,
                    SourceSpace::LinearSrgb,
                    settings,
                    &candidate,
                    analysis,
                    &exposed,
                    gh.as_deref(),
                    gs.as_deref(),
                )?
                .0
            }
            None => {
                prepare_with_statistics(
                    &scene.raster.image,
                    SourceSpace::LinearSrgb,
                    settings,
                    candidate,
                    scene.statistics,
                )?
                .0
            }
        };
        let small = &scene.small.image;
        Ok(reduce(&full, small.width, small.height))
    }

    fn run_item(&self, index: usize, candidate: Option<&Candidate>) -> Result<[f64; 4], String> {
        let item = &self.items[index];
        let scene = &self.scenes[item.scene];
        let (raster, settings, cubes) = match candidate {
            None => (scene.small.clone(), &item.settings, &item.baseline_cubes),
            Some(candidate) => (
                Raster {
                    image: self.prepared(item, candidate)?,
                    info: scene.small.info.clone(),
                },
                &item.downstream,
                &item.candidate_cubes,
            ),
        };
        let cache = cubes.lock().unwrap().clone();
        let (rendered, made, _) =
            render_raster(&raster, settings, Quality::Final, None, cache.as_ref());
        if cache.is_none() {
            *cubes.lock().unwrap() = Some(made);
        }
        let frame = &self.frames[item.scene];
        if (rendered.width, rendered.height) != (frame.width, frame.height) {
            return Err("rendered size differs from the frame".into());
        }
        Ok(self.metrics(item, &rendered.rgba))
    }

    fn answer(&self, request: &Value) -> Result<Value, String> {
        let items: Vec<usize> = match request["items"].as_array() {
            Some(list) => list
                .iter()
                .map(|v| v.as_u64().map(|i| i as usize).ok_or("item index"))
                .collect::<Result<_, _>>()?,
            None => (0..self.items.len()).collect(),
        };
        if items.iter().any(|&i| i >= self.items.len()) {
            return Err("item index out of range".into());
        }
        let candidate = match request["op"].as_str() {
            Some("eval") => Some(Candidate::from_coefficients_json(&request["candidate"])?),
            Some("baseline") => None,
            _ => return Err("op must be eval or baseline".into()),
        };
        let started = Instant::now();
        let rows: Vec<Result<[f64; 4], String>> = parallel(self.threads, items.len(), |k| {
            self.run_item(items[k], candidate.as_ref())
        });
        let rows: Vec<[f64; 4]> = rows.into_iter().collect::<Result<_, _>>()?;
        Ok(json!({
            "rows": rows,
            "ms": started.elapsed().as_secs_f64() * 1000.0
        }))
    }

    fn describe(&self) -> Value {
        json!({
            "ready": true,
            "gains": if self.fast { "fast" } else { "exact" },
            "scenes": self.scenes.iter().zip(&self.frames).map(|(s, f)| json!({
                "width": s.raster.image.width,
                "height": s.raster.image.height,
                "metricWidth": f.width,
                "metricHeight": f.height,
                "sigma": f.sigma,
                "meanLog2Y": s.statistics.0,
                "p90Log2Y": s.statistics.1
            })).collect::<Vec<_>>(),
            "samples": self.items.iter().map(|i| i.samples.len()).collect::<Vec<_>>()
        })
    }
}

fn main() -> Result<(), Box<dyn std::error::Error>> {
    let args: Vec<String> = std::env::args().skip(1).collect();
    match args.first().map(String::as_str) {
        Some("settings") if args.len() == 2 => {
            let dir = PathBuf::from(&args[1]);
            std::fs::create_dir_all(&dir)?;
            for (name, settings) in variant_settings()? {
                std::fs::write(dir.join(format!("{name}.json")), settings.to_json())?;
            }
            Ok(())
        }
        Some("freeze") if args.len() == 3 => {
            let value: Value = serde_json::from_slice(&std::fs::read(&args[1])?)?;
            let candidate = Candidate::from_coefficients_json(&value)?;
            let manifest = candidate.frozen_manifest();
            let mut bytes = serde_json::to_vec_pretty(&manifest)?;
            bytes.push(b'\n');
            std::fs::write(&args[2], bytes)?;
            println!("{}", manifest["coefficientsSha256"].as_str().unwrap_or_default());
            Ok(())
        }
        Some("serve") if args.len() == 2 => {
            let config: Value = serde_json::from_slice(&std::fs::read(&args[1])?)?;
            let server = Server::load(&config)?;
            let stdout = std::io::stdout();
            let mut out = stdout.lock();
            writeln!(out, "{}", server.describe())?;
            out.flush()?;
            for line in std::io::stdin().lock().lines() {
                let line = line?;
                if line.trim().is_empty() {
                    continue;
                }
                let request: Value = serde_json::from_str(&line)?;
                if request["op"] == "quit" {
                    break;
                }
                let reply = server
                    .answer(&request)
                    .unwrap_or_else(|error| json!({ "error": error }));
                writeln!(out, "{reply}")?;
                out.flush()?;
            }
            Ok(())
        }
        _ => Err("usage: analytic_hs_calibrate settings <out-dir> | freeze <coefficients.json> <manifest.json> | serve <config.json>".into()),
    }
}
