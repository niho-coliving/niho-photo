//! Completing a hole from its surroundings (`docs/heal.md` "埋め方"): a
//! multi-scale PatchMatch with EM voting on a perceptual encoding (the
//! square root of linear light), helped by the photo's dominant offsets
//! (its periods) for regular structure.
//!
//! - **Scales.** The region (the hole and its context) is halved until the
//!   hole is a few patches across ([`wanted_levels`]); a coarser cell is
//!   unknown when any of its children is. The coarsest starts from the
//!   hole onion-peeled in from its edge and a random field.
//! - **PatchMatch.** 7 x 7 patches; each pass scans in alternating order,
//!   takes a neighbour's offset (propagation), the dominant offsets and a
//!   random search halving from a radius. Sources lie whole in the region
//!   and outside the hole; the patch distance counts the hole's current
//!   estimate at a quarter of the photo ([`HOLE_TRUST`]).
//! - **EM.** Each round votes every unknown cell as the mean of the
//!   sources its patches point at, weighted by `exp(-error / (2 mean
//!   error))` (linear light at the finest scale). A finer scale starts from
//!   the coarser field (offsets doubled) and its fill.
//! - **Periods.** The most frequent offsets between structured patches
//!   around the hole are tried by every patch; with enough of them, the
//!   finest scale also starts once from a greedy copy through them
//!   ([`period_start`]) and keeps the start whose EM energy is lower.
//!
//! Fixed iteration counts, a fixed-seed xorshift, `f32` / `f64`
//! arithmetic in a fixed order and `libm`: native and wasm agree bit for
//! bit.

use super::shape::{dilate, PATCH_RADIUS};

const PR: usize = PATCH_RADIUS;
const SEED: u64 = 0x9e37_79b9_7f4a_7c15;

#[inline]
pub(super) fn encode(v: f32) -> f32 {
    if v < 0.0 {
        -(-v).sqrt()
    } else {
        v.sqrt()
    }
}

#[inline]
pub(super) fn decode(e: f32) -> f32 {
    if e < 0.0 {
        -(e * e)
    } else {
        e * e
    }
}

/// xorshift64* with a fixed seed (the random search).
struct Rng(u64);

impl Rng {
    fn next(&mut self) -> u64 {
        let mut x = self.0;
        x ^= x >> 12;
        x ^= x << 25;
        x ^= x >> 27;
        self.0 = x;
        x.wrapping_mul(0x2545_f491_4f6c_dd1d)
    }

    fn below(&mut self, n: usize) -> usize {
        (self.next() % n as u64) as usize
    }

    /// Uniform in `-r..=r`.
    fn range(&mut self, r: i64) -> i64 {
        (self.next() % (2 * r as u64 + 1)) as i64 - r
    }
}

/// One scale of the completion: the encoded image and its unknown cells.
struct Level {
    w: usize,
    h: usize,
    img: Vec<f32>,
    hole: Vec<u8>,
}

impl Level {
    /// Half the size: known cells average their known children; a cell
    /// with an unknown child is unknown.
    fn down(&self) -> Level {
        let (w, h) = (self.w.div_ceil(2), self.h.div_ceil(2));
        let mut img = vec![0.0f32; w * h * 3];
        let mut hole = vec![0u8; w * h];
        for y in 0..h {
            for x in 0..w {
                let mut sum = [0.0f32; 3];
                let mut n = 0u32;
                let mut unknown = false;
                for (cx, cy) in [
                    (2 * x, 2 * y),
                    (2 * x + 1, 2 * y),
                    (2 * x, 2 * y + 1),
                    (2 * x + 1, 2 * y + 1),
                ] {
                    if cx >= self.w || cy >= self.h {
                        continue;
                    }
                    let k = cy * self.w + cx;
                    if self.hole[k] != 0 {
                        unknown = true;
                    } else {
                        sum[0] += self.img[k * 3];
                        sum[1] += self.img[k * 3 + 1];
                        sum[2] += self.img[k * 3 + 2];
                        n += 1;
                    }
                }
                let k = y * w + x;
                hole[k] = u8::from(unknown || n == 0);
                if n > 0 {
                    let n = n as f32;
                    img[k * 3] = sum[0] / n;
                    img[k * 3 + 1] = sum[1] / n;
                    img[k * 3 + 2] = sum[2] / n;
                }
            }
        }
        Level { w, h, img, hole }
    }

    /// Fills the unknown cells from the known ones inward (each ring the
    /// mean of its known 8-neighbours). `false` when nothing is known.
    fn onion(&mut self) -> bool {
        let (w, h) = (self.w, self.h);
        let mut known: Vec<bool> = self.hole.iter().map(|&u| u == 0).collect();
        if !known.iter().any(|&k| k) {
            return false;
        }
        let mut pending: Vec<usize> = (0..w * h).filter(|&k| !known[k]).collect();
        let mut updates: Vec<(usize, [f32; 3])> = Vec::new();
        while !pending.is_empty() {
            updates.clear();
            let mut rest = Vec::new();
            for &k in &pending {
                let (x, y) = (k % w, k / w);
                let mut sum = [0.0f32; 3];
                let mut n = 0u32;
                for ny in y.saturating_sub(1)..(y + 2).min(h) {
                    for nx in x.saturating_sub(1)..(x + 2).min(w) {
                        let j = ny * w + nx;
                        if j != k && known[j] {
                            sum[0] += self.img[j * 3];
                            sum[1] += self.img[j * 3 + 1];
                            sum[2] += self.img[j * 3 + 2];
                            n += 1;
                        }
                    }
                }
                if n > 0 {
                    let n = n as f32;
                    updates.push((k, [sum[0] / n, sum[1] / n, sum[2] / n]));
                } else {
                    rest.push(k);
                }
            }
            if updates.is_empty() {
                break;
            }
            for &(k, v) in &updates {
                self.img[k * 3..k * 3 + 3].copy_from_slice(&v);
                known[k] = true;
            }
            pending = rest;
        }
        true
    }
}

/// Source patches: whole inside the level and free of unknown cells.
struct Sources {
    valid: Vec<u8>,
    list: Vec<u32>,
}

fn sources(lv: &Level) -> Sources {
    let (w, h) = (lv.w, lv.h);
    let mut valid = vec![0u8; w * h];
    let mut list = Vec::new();
    if w <= 2 * PR || h <= 2 * PR {
        return Sources { valid, list };
    }
    let mut sat = vec![0u32; (w + 1) * (h + 1)];
    for y in 0..h {
        let mut row = 0u32;
        for x in 0..w {
            row += u32::from(lv.hole[y * w + x] != 0);
            sat[(y + 1) * (w + 1) + x + 1] = sat[y * (w + 1) + x + 1] + row;
        }
    }
    let side = 2 * PR + 1;
    for y in PR..h - PR {
        for x in PR..w - PR {
            let (x0, y0) = (x - PR, y - PR);
            let (x1, y1) = (x0 + side, y0 + side);
            let n = sat[y1 * (w + 1) + x1] + sat[y0 * (w + 1) + x0]
                - sat[y0 * (w + 1) + x1]
                - sat[y1 * (w + 1) + x0];
            if n == 0 {
                valid[y * w + x] = 1;
                list.push((y * w + x) as u32);
            }
        }
    }
    Sources { valid, list }
}

/// Target patches: cells within [`PR`] of an unknown cell, row-major.
struct Targets {
    centers: Vec<u32>,
    index: Vec<i32>,
}

fn targets(lv: &Level) -> Targets {
    let near = dilate(&lv.hole, lv.w, lv.h, PR);
    let mut centers = Vec::new();
    let mut index = vec![-1i32; lv.w * lv.h];
    for (k, &n) in near.iter().enumerate() {
        if n != 0 {
            index[k] = centers.len() as i32;
            centers.push(k as u32);
        }
    }
    Targets { centers, index }
}

/// Sum of squared differences of the patches at `(px, py)` and `(sx, sy)`
/// (the target patch clipped to the level), each target pixel weighted by
/// `trust` (the photo counts more than the current estimate of the hole),
/// stopping past `best`.
#[allow(clippy::too_many_arguments)]
#[inline]
fn ssd(
    img: &[f32],
    trust: &[f32],
    w: usize,
    h: usize,
    (px, py): (usize, usize),
    (sx, sy): (usize, usize),
    best: f32,
) -> f32 {
    let dy0 = PR.min(py);
    let dy1 = PR.min(h - 1 - py);
    let dx0 = PR.min(px);
    let dx1 = PR.min(w - 1 - px);
    let n = dx0 + dx1 + 1;
    let mut sum = 0.0f32;
    for k in 0..=(dy0 + dy1) {
        let (ty, syy) = (py + k - dy0, sy + k - dy0);
        let t = ty * w + px - dx0;
        let s = syy * w + sx - dx0;
        let (a, b) = (&img[t * 3..(t + n) * 3], &img[s * 3..(s + n) * 3]);
        let wt = &trust[t..t + n];
        for i in 0..n {
            let (d0, d1, d2) = (
                a[i * 3] - b[i * 3],
                a[i * 3 + 1] - b[i * 3 + 1],
                a[i * 3 + 2] - b[i * 3 + 2],
            );
            sum += wt[i] * (d0 * d0 + d1 * d1 + d2 * d2);
        }
        if sum >= best {
            return sum;
        }
    }
    sum
}

/// Weight of the hole's current estimate against the photo in [`ssd`].
const HOLE_TRUST: f32 = 0.25;

/// [`ssd`]'s weights: 1 for the photo, less for the hole's estimate.
fn trust(lv: &Level) -> Vec<f32> {
    lv.hole
        .iter()
        .map(|&u| if u != 0 { HOLE_TRUST } else { 1.0 })
        .collect()
}

/// Values compared per target patch (its clipped size times 3).
fn patch_values(w: usize, h: usize, x: usize, y: usize) -> f32 {
    ((PR.min(x) + PR.min(w - 1 - x) + 1) * (PR.min(y) + PR.min(h - 1 - y) + 1) * 3) as f32
}

fn random_offset(src: &Sources, w: usize, x: usize, y: usize, rng: &mut Rng) -> (i32, i32) {
    let s = src.list[rng.below(src.list.len())] as usize;
    ((s % w) as i32 - x as i32, (s / w) as i32 - y as i32)
}

/// PatchMatch passes (alternating scan order: propagation from the
/// previous neighbours, the photo's dominant offsets `dominant`, then a
/// random search halving from `radius`); the distances of the field it
/// leaves.
#[allow(clippy::too_many_arguments)]
fn patchmatch(
    lv: &Level,
    src: &Sources,
    tg: &Targets,
    nnf: &mut [(i32, i32)],
    dominant: &[(i32, i32)],
    passes: usize,
    radius: usize,
    rng: &mut Rng,
) -> Vec<f32> {
    let (w, h) = (lv.w, lv.h);
    let lo = PR as i64;
    let (hx, hy) = (w as i64 - 1 - lo, h as i64 - 1 - lo);
    let trust = trust(lv);
    let mut dist: Vec<f32> = tg
        .centers
        .iter()
        .zip(nnf.iter())
        .map(|(&c, &(ox, oy))| {
            let (x, y) = (c as usize % w, c as usize / w);
            let (sx, sy) = (
                (x as i64 + ox as i64) as usize,
                (y as i64 + oy as i64) as usize,
            );
            ssd(&lv.img, &trust, w, h, (x, y), (sx, sy), f32::INFINITY)
        })
        .collect();
    let n = tg.centers.len();
    for pass in 0..passes {
        let forward = pass % 2 == 0;
        for step in 0..n {
            let k = if forward { step } else { n - 1 - step };
            let c = tg.centers[k] as usize;
            let (x, y) = (c % w, c / w);
            let (mut best, mut best_d) = (nnf[k], dist[k]);
            let neighbours = if forward {
                [(x > 0).then(|| c - 1), (y > 0).then(|| c - w)]
            } else {
                [(x + 1 < w).then(|| c + 1), (y + 1 < h).then(|| c + w)]
            };
            for nb in neighbours.into_iter().flatten() {
                let j = tg.index[nb];
                if j < 0 {
                    continue;
                }
                let o = nnf[j as usize];
                if o == best {
                    continue;
                }
                let (sx, sy) = (x as i64 + o.0 as i64, y as i64 + o.1 as i64);
                if sx < lo || sx > hx || sy < lo || sy > hy {
                    continue;
                }
                if src.valid[sy as usize * w + sx as usize] == 0 {
                    continue;
                }
                let d = ssd(
                    &lv.img,
                    &trust,
                    w,
                    h,
                    (x, y),
                    (sx as usize, sy as usize),
                    best_d,
                );
                if d < best_d {
                    best = o;
                    best_d = d;
                }
            }
            for &o in dominant {
                let (sx, sy) = (x as i64 + o.0 as i64, y as i64 + o.1 as i64);
                if o == best || sx < lo || sx > hx || sy < lo || sy > hy {
                    continue;
                }
                if src.valid[sy as usize * w + sx as usize] == 0 {
                    continue;
                }
                let d = ssd(
                    &lv.img,
                    &trust,
                    w,
                    h,
                    (x, y),
                    (sx as usize, sy as usize),
                    best_d,
                );
                if d < best_d {
                    best = o;
                    best_d = d;
                }
            }
            let mut r = radius as i64;
            while r >= 1 {
                let sx = (x as i64 + best.0 as i64 + rng.range(r)).clamp(lo, hx);
                let sy = (y as i64 + best.1 as i64 + rng.range(r)).clamp(lo, hy);
                let o = ((sx - x as i64) as i32, (sy - y as i64) as i32);
                if o != best && src.valid[sy as usize * w + sx as usize] != 0 {
                    let d = ssd(
                        &lv.img,
                        &trust,
                        w,
                        h,
                        (x, y),
                        (sx as usize, sy as usize),
                        best_d,
                    );
                    if d < best_d {
                        best = o;
                        best_d = d;
                    }
                }
                r /= 2;
            }
            nnf[k] = best;
            dist[k] = best_d;
        }
    }
    dist
}

/// Most dominant offsets tried per patch (and the period start chooses
/// from).
const DOMINANT: usize = 8;
/// How much closer another offset must match to replace the inherited one
/// in the period start.
const COHERENCE: f32 = 0.6;
/// Most photo patches matched to find them.
const DOMINANT_SAMPLES: usize = 4096;
/// Least share of the matched patches the dominant offsets must cover.
const MIN_PERIODIC: f64 = 0.04;

/// The offsets at which the photo around the hole repeats most (He & Sun,
/// "Statistics of Patch Offsets for Image Completion"): every other photo
/// patch within about two radii of the hole is matched (PatchMatch) to its
/// most similar patch at least a patch away, and the most frequent offsets
/// win (the periods of bricks, tiles and fences). Tried for every hole
/// patch at every scale, they keep regular structure in phase.
fn dominant_offsets(lv: &Level, src: &Sources, radius: f64, rng: &mut Rng) -> Vec<(i32, i32)> {
    let (w, h) = (lv.w, lv.h);
    if src.list.is_empty() {
        return Vec::new();
    }
    let reach = (libm::ceil(2.0 * radius) as usize).max(16);
    let near = dilate(&lv.hole, w, h, reach);
    let candidates = (0..w * h)
        .filter(|&k| near[k] != 0 && src.valid[k] != 0)
        .count();
    let mut stride = 2usize;
    while candidates / (stride * stride) > DOMINANT_SAMPLES {
        stride += 1;
    }
    let mut index = vec![-1i32; w * h];
    let mut cells: Vec<u32> = Vec::new();
    for y in (0..h).step_by(stride) {
        for x in (0..w).step_by(stride) {
            let k = y * w + x;
            if near[k] != 0 && src.valid[k] != 0 {
                index[k] = cells.len() as i32;
                cells.push(k as u32);
            }
        }
    }
    if cells.len() < 16 {
        return Vec::new();
    }
    let min = (2 * PR + 1) as i32;
    let far = |o: (i32, i32)| o.0.abs().max(o.1.abs()) >= min;
    let lo = PR as i64;
    let (hx, hy) = (w as i64 - 1 - lo, h as i64 - 1 - lo);
    let trust = vec![1.0f32; w * h];
    let mut nnf: Vec<(i32, i32)> = Vec::with_capacity(cells.len());
    let mut dist: Vec<f32> = Vec::with_capacity(cells.len());
    for &c in &cells {
        let (x, y) = (c as usize % w, c as usize / w);
        let mut o = random_offset(src, w, x, y, rng);
        for _ in 0..8 {
            if far(o) {
                break;
            }
            o = random_offset(src, w, x, y, rng);
        }
        let (sx, sy) = (
            (x as i64 + o.0 as i64) as usize,
            (y as i64 + o.1 as i64) as usize,
        );
        dist.push(if far(o) {
            ssd(&lv.img, &trust, w, h, (x, y), (sx, sy), f32::INFINITY)
        } else {
            f32::INFINITY
        });
        nnf.push(o);
    }
    let n = cells.len();
    for pass in 0..3 {
        let forward = pass % 2 == 0;
        for step in 0..n {
            let k = if forward { step } else { n - 1 - step };
            let c = cells[k] as usize;
            let (x, y) = (c % w, c / w);
            let (mut best, mut best_d) = (nnf[k], dist[k]);
            let neighbours = if forward {
                [
                    (x >= stride).then(|| c - stride),
                    (y >= stride).then(|| c - stride * w),
                ]
            } else {
                [
                    (x + stride < w).then(|| c + stride),
                    (y + stride < h).then(|| c + stride * w),
                ]
            };
            let mut candidates: Vec<(i32, i32)> = neighbours
                .into_iter()
                .flatten()
                .filter(|&nb| index[nb] >= 0)
                .map(|nb| nnf[index[nb] as usize])
                .collect();
            let mut r = w.max(h) as i64;
            while r >= 1 {
                let sx = (x as i64 + best.0 as i64 + rng.range(r)).clamp(lo, hx);
                let sy = (y as i64 + best.1 as i64 + rng.range(r)).clamp(lo, hy);
                candidates.push(((sx - x as i64) as i32, (sy - y as i64) as i32));
                r /= 2;
            }
            for o in candidates {
                let (sx, sy) = (x as i64 + o.0 as i64, y as i64 + o.1 as i64);
                if o == best || !far(o) || sx < lo || sx > hx || sy < lo || sy > hy {
                    continue;
                }
                if src.valid[sy as usize * w + sx as usize] == 0 {
                    continue;
                }
                let d = ssd(
                    &lv.img,
                    &trust,
                    w,
                    h,
                    (x, y),
                    (sx as usize, sy as usize),
                    best_d,
                );
                if d < best_d {
                    best = o;
                    best_d = d;
                }
            }
            nnf[k] = best;
            dist[k] = best_d;
        }
    }
    // The better half of the matches vote (a period matches exactly; its
    // near misses do not), and only patches with structure: a flat patch
    // matches anywhere.
    let median = |mut v: Vec<f32>| -> f32 {
        v.sort_by(f32::total_cmp);
        v.get(v.len() / 2).copied().unwrap_or(0.0)
    };
    let close = median(dist.iter().copied().filter(|d| d.is_finite()).collect());
    let spread: Vec<f32> = cells
        .iter()
        .map(|&c| patch_variance(lv, c as usize % w, c as usize / w))
        .collect();
    let busy = 0.25 * median(spread.clone());
    let mut found: Vec<(i32, i32)> = nnf
        .iter()
        .zip(&dist)
        .zip(&spread)
        .filter(|((o, d), v)| far(**o) && d.is_finite() && **d <= close && **v > busy)
        .map(|((o, _), _)| *o)
        .collect();
    found.sort_unstable();
    let mut counts: Vec<((i32, i32), usize)> = Vec::new();
    for o in found {
        match counts.last_mut() {
            Some((last, count)) if *last == o => *count += 1,
            _ => counts.push((o, 1)),
        }
    }
    counts.sort_by(|a, b| b.1.cmp(&a.1).then(a.0.cmp(&b.0)));
    let least = (n / 1000).max(3);
    let mut out: Vec<(i32, i32)> = Vec::with_capacity(DOMINANT);
    let mut covered = 0usize;
    for (o, count) in counts {
        if count < least || out.len() == DOMINANT {
            break;
        }
        if out
            .iter()
            .all(|p| (p.0 - o.0).abs().max((p.1 - o.1).abs()) > 2)
        {
            covered += count;
            out.push(o);
        }
    }
    // Too few patches repeat at them: not a regular texture.
    if (covered as f64) < MIN_PERIODIC * n as f64 {
        out.clear();
    }
    out
}

/// The variance of the patch at `(x, y)` (encoded units, all channels).
fn patch_variance(lv: &Level, x: usize, y: usize) -> f32 {
    let (mut sum, mut sq, mut n) = (0.0f32, 0.0f32, 0.0f32);
    for yy in y.saturating_sub(PR)..(y + PR + 1).min(lv.h) {
        for xx in x.saturating_sub(PR)..(x + PR + 1).min(lv.w) {
            for c in 0..3 {
                let v = lv.img[(yy * lv.w + xx) * 3 + c];
                sum += v;
                sq += v * v;
                n += 1.0;
            }
        }
    }
    (sq / n - (sum / n) * (sum / n)).max(0.0)
}

/// Vote weights: how well each patch matches, relative to the mean match.
fn vote_weights(lv: &Level, tg: &Targets, dist: &[f32]) -> Vec<f32> {
    let errors: Vec<f32> = tg
        .centers
        .iter()
        .zip(dist)
        .map(|(&c, &d)| {
            let (x, y) = (c as usize % lv.w, c as usize / lv.w);
            d / patch_values(lv.w, lv.h, x, y)
        })
        .collect();
    let mean = errors.iter().map(|&e| f64::from(e)).sum::<f64>() / errors.len().max(1) as f64;
    let scale = (2.0 * mean) as f32 + 1e-12;
    errors
        .iter()
        .map(|&e| libm::expf(-e / scale).max(1e-20))
        .collect()
}

/// The vote for every unknown cell (linear: `linear` holds the level's
/// cells in linear light, else the encoded cells are decoded), indexed by
/// target.
fn vote(
    lv: &Level,
    linear: Option<&[f32]>,
    tg: &Targets,
    nnf: &[(i32, i32)],
    weights: &[f32],
) -> Vec<[f32; 3]> {
    let (w, h) = (lv.w, lv.h);
    let n = tg.centers.len();
    let mut acc = vec![0.0f32; n * 3];
    let mut wsum = vec![0.0f32; n];
    for (k, &c) in tg.centers.iter().enumerate() {
        let (x, y) = (c as usize % w, c as usize / w);
        let (ox, oy) = nnf[k];
        let wk = weights[k];
        for qy in y.saturating_sub(PR)..(y + PR + 1).min(h) {
            for qx in x.saturating_sub(PR)..(x + PR + 1).min(w) {
                let q = qy * w + qx;
                if lv.hole[q] == 0 {
                    continue;
                }
                let j = tg.index[q] as usize;
                let s =
                    ((qy as i64 + oy as i64) as usize * w + (qx as i64 + ox as i64) as usize) * 3;
                let v = match linear {
                    Some(lin) => [lin[s], lin[s + 1], lin[s + 2]],
                    None => [
                        decode(lv.img[s]),
                        decode(lv.img[s + 1]),
                        decode(lv.img[s + 2]),
                    ],
                };
                acc[j * 3] += wk * v[0];
                acc[j * 3 + 1] += wk * v[1];
                acc[j * 3 + 2] += wk * v[2];
                wsum[j] += wk;
            }
        }
    }
    (0..n)
        .map(|j| {
            let ws = wsum[j];
            if ws > 0.0 {
                [acc[j * 3] / ws, acc[j * 3 + 1] / ws, acc[j * 3 + 2] / ws]
            } else {
                [0.0; 3]
            }
        })
        .collect()
}

/// The finest field of a completion and the fill of its unknown cells
/// (linear, indexed by target).
pub(super) struct Completed {
    pub centers: Vec<u32>,
    pub index: Vec<i32>,
    pub nnf: Vec<(i32, i32)>,
    pub weights: Vec<f32>,
    pub fill: Vec<[f32; 3]>,
}

/// Coarser scales of a completion: enough for the hole to be a few patches
/// across at the coarsest.
fn wanted_levels(radius: f64) -> usize {
    let r = libm::ceil(libm::log2((2.0 * radius).max(1.0) / 6.0));
    r.clamp(1.0, 8.0) as usize
}

/// (EM rounds, PatchMatch passes of the first round and of the others,
/// random search radius) of scale `l` of `top`.
fn schedule(l: usize, top: usize, w: usize, h: usize) -> (usize, usize, usize, usize) {
    if top == 0 {
        (6, 3, 2, w.max(h))
    } else if l == top {
        (5, 3, 2, w.max(h))
    } else if l == 0 {
        (2, 1, 1, 3)
    } else {
        (3, 1, 1, 6)
    }
}

/// Completes the unknown cells of a region (`linear`, `w x h`): `None`
/// when no source patch exists.
pub(super) fn complete(
    linear: &[f32],
    unknown: Vec<u8>,
    w: usize,
    h: usize,
    radius: f64,
) -> Option<Completed> {
    let img: Vec<f32> = linear.iter().map(|&v| encode(v)).collect();
    let mut levels = vec![Level {
        w,
        h,
        img,
        hole: unknown,
    }];
    let finest = sources(&levels[0]);
    if finest.list.is_empty() {
        return None;
    }
    let mut srcs = vec![finest];
    let wanted = wanted_levels(radius);
    while levels.len() <= wanted {
        let next = levels.last().expect("level").down();
        if next.w.min(next.h) < 4 * PR + 4 {
            break;
        }
        let s = sources(&next);
        if s.list.len() < 8 {
            break;
        }
        levels.push(next);
        srcs.push(s);
    }
    let top = levels.len() - 1;
    let mut rng = Rng(SEED);
    // The photo's periods around the hole, at each scale.
    let dominant = dominant_offsets(&levels[0], &srcs[0], radius, &mut rng);
    let scaled: Vec<Vec<(i32, i32)>> = (0..=top)
        .map(|l| {
            let f = (1u32 << l) as f64;
            let mut list: Vec<(i32, i32)> = Vec::with_capacity(dominant.len());
            for &(ox, oy) in &dominant {
                let o = (
                    libm::round(ox as f64 / f) as i32,
                    libm::round(oy as f64 / f) as i32,
                );
                if o != (0, 0) && !list.contains(&o) {
                    list.push(o);
                }
            }
            list
        })
        .collect();
    if !levels[top].onion() {
        return None;
    }
    let mut tg = targets(&levels[top]);
    let mut nnf: Vec<(i32, i32)> = Vec::with_capacity(tg.centers.len());
    for &c in &tg.centers {
        let (x, y) = (c as usize % levels[top].w, c as usize / levels[top].w);
        nnf.push(random_offset(&srcs[top], levels[top].w, x, y, &mut rng));
    }
    let mut weights = Vec::new();
    let mut fill = Vec::new();
    for l in (0..=top).rev() {
        if l < top {
            let fine = targets(&levels[l]);
            let (cw, ch) = (levels[l + 1].w, levels[l + 1].h);
            nnf = upsample(&tg, &nnf, cw, ch, &fine, &levels[l], &srcs[l], &mut rng);
            // The unknown cells start from the coarser scale's fill.
            let (upper, lower) = levels.split_at_mut(l + 1);
            let (fine_lv, coarse) = (&mut upper[l], &lower[0]);
            for &c in &fine.centers {
                let c = c as usize;
                if fine_lv.hole[c] == 0 {
                    continue;
                }
                let (x, y) = (c % fine_lv.w, c / fine_lv.w);
                let k = ((y / 2).min(ch - 1) * cw + (x / 2).min(cw - 1)) * 3;
                fine_lv.img[c * 3..c * 3 + 3].copy_from_slice(&coarse.img[k..k + 3]);
            }
            tg = fine;
        }
        let plan = schedule(l, top, levels[l].w, levels[l].h);
        let lin = (l == 0).then_some(linear);
        if l == 0 && !scaled[0].is_empty() {
            // Two starts for the finest scale: the coarser scales' fill and
            // the photo's periods carried in from the hole's edge; the one
            // that ends with the closer patches wins.
            let mut alt = None;
            if let Some((img, start)) = period_start(&levels[0], &srcs[0], &tg, &dominant, &nnf) {
                let mut lv = Level {
                    w: levels[0].w,
                    h: levels[0].h,
                    img,
                    hole: levels[0].hole.clone(),
                };
                let mut start = start;
                let mut alt_rng = Rng(rng.0 ^ 0x5bd1_e995);
                let done = em(
                    &mut lv,
                    lin,
                    &srcs[0],
                    &tg,
                    &mut start,
                    &scaled[0],
                    plan,
                    &mut alt_rng,
                );
                alt = Some((lv, start, done));
            }
            let done = em(
                &mut levels[0],
                lin,
                &srcs[0],
                &tg,
                &mut nnf,
                &scaled[0],
                plan,
                &mut rng,
            );
            match alt {
                Some((lv, start, alt_done)) if alt_done.2 < done.2 => {
                    levels[0] = lv;
                    nnf = start;
                    (weights, fill) = (alt_done.0, alt_done.1);
                }
                _ => (weights, fill) = (done.0, done.1),
            }
        } else {
            let done = em(
                &mut levels[l],
                lin,
                &srcs[l],
                &tg,
                &mut nnf,
                &scaled[l],
                plan,
                &mut rng,
            );
            (weights, fill) = (done.0, done.1);
        }
    }
    Some(Completed {
        centers: tg.centers,
        index: tg.index,
        nnf,
        weights,
        fill,
    })
}

/// EM rounds at one scale: PatchMatch, then each unknown cell the
/// weighted vote of its patches. The last vote's weights and fill, and the
/// field's total distance (the energy the rounds lower).
#[allow(clippy::too_many_arguments, clippy::type_complexity)]
fn em(
    lv: &mut Level,
    linear: Option<&[f32]>,
    src: &Sources,
    tg: &Targets,
    nnf: &mut [(i32, i32)],
    dominant: &[(i32, i32)],
    (rounds, first, passes, radius): (usize, usize, usize, usize),
    rng: &mut Rng,
) -> (Vec<f32>, Vec<[f32; 3]>, f64) {
    let mut weights = Vec::new();
    let mut fill = Vec::new();
    let mut energy = 0.0f64;
    for round in 0..rounds {
        let dist = patchmatch(
            lv,
            src,
            tg,
            nnf,
            dominant,
            if round == 0 { first } else { passes },
            radius,
            rng,
        );
        energy = dist.iter().map(|&d| f64::from(d)).sum();
        weights = vote_weights(lv, tg, &dist);
        fill = vote(lv, linear, tg, nnf, &weights);
        for (j, &c) in tg.centers.iter().enumerate() {
            let c = c as usize;
            if lv.hole[c] != 0 {
                let v = fill[j];
                lv.img[c * 3] = encode(v[0]);
                lv.img[c * 3 + 1] = encode(v[1]);
                lv.img[c * 3 + 2] = encode(v[2]);
            }
        }
    }
    (weights, fill, energy)
}

/// A start for the finest scale from the photo's periods (a greedy
/// synthesis): breadth first from the hole's edge, each patch takes the
/// dominant offset whose source matches the photo and the cells already
/// filled best (its neighbour's offset on a tie), and its cell is copied
/// through it. `None` without a patch at the edge.
#[allow(clippy::type_complexity)]
fn period_start(
    lv: &Level,
    src: &Sources,
    tg: &Targets,
    dominant: &[(i32, i32)],
    nnf: &[(i32, i32)],
) -> Option<(Vec<f32>, Vec<(i32, i32)>)> {
    let (w, h) = (lv.w, lv.h);
    let lo = PR as i64;
    let (hx, hy) = (w as i64 - 1 - lo, h as i64 - 1 - lo);
    let source = |x: usize, y: usize, o: (i32, i32)| -> Option<(usize, usize)> {
        let (sx, sy) = (x as i64 + o.0 as i64, y as i64 + o.1 as i64);
        (sx >= lo
            && sx <= hx
            && sy >= lo
            && sy <= hy
            && src.valid[sy as usize * w + sx as usize] != 0)
            .then_some((sx as usize, sy as usize))
    };
    // The photo and the cells filled so far count; the rest of the hole not.
    let mut trust: Vec<f32> = lv
        .hole
        .iter()
        .map(|&u| if u != 0 { 0.0 } else { 1.0 })
        .collect();
    let mut img = lv.img.clone();
    let mut start = nnf.to_vec();
    let n = tg.centers.len();
    let mut seen = vec![false; n];
    // The neighbour's offset each patch inherits (None at the edge).
    let mut inherited: Vec<Option<(i32, i32)>> = vec![None; n];
    let mut queue = std::collections::VecDeque::new();
    for (k, &c) in tg.centers.iter().enumerate() {
        let (x, y) = (c as usize % w, c as usize / w);
        let edge = (y.saturating_sub(PR)..(y + PR + 1).min(h)).any(|yy| {
            (x.saturating_sub(PR)..(x + PR + 1).min(w)).any(|xx| lv.hole[yy * w + xx] == 0)
        });
        if edge {
            seen[k] = true;
            queue.push_back(k);
        }
    }
    if queue.is_empty() {
        return None;
    }
    let mut labelled = 0usize;
    while let Some(k) = queue.pop_front() {
        let c = tg.centers[k] as usize;
        let (x, y) = (c % w, c / w);
        // The neighbour's offset holds unless another is clearly closer
        // (texture noise alone does not switch it).
        let mut best: Option<((i32, i32), f32)> = None;
        if let Some(o) = inherited[k] {
            if let Some(s) = source(x, y, o) {
                best = Some((
                    o,
                    COHERENCE * ssd(&img, &trust, w, h, (x, y), s, f32::INFINITY),
                ));
            }
        }
        for &o in dominant {
            let Some(s) = source(x, y, o) else {
                continue;
            };
            let bound = best.map_or(f32::INFINITY, |b| b.1);
            let d = ssd(&img, &trust, w, h, (x, y), s, bound);
            if d < bound {
                best = Some((o, d));
            }
        }
        if let Some((o, _)) = best {
            start[k] = o;
            labelled += 1;
            if lv.hole[c] != 0 {
                let s =
                    ((y as i64 + o.1 as i64) as usize * w + (x as i64 + o.0 as i64) as usize) * 3;
                let v = [img[s], img[s + 1], img[s + 2]];
                img[c * 3..c * 3 + 3].copy_from_slice(&v);
                trust[c] = 1.0;
            }
        }
        for (nx, ny) in [
            (x.wrapping_sub(1), y),
            (x + 1, y),
            (x, y.wrapping_sub(1)),
            (x, y + 1),
        ] {
            if nx >= w || ny >= h {
                continue;
            }
            let j = tg.index[ny * w + nx];
            if j < 0 || seen[j as usize] {
                continue;
            }
            let j = j as usize;
            seen[j] = true;
            inherited[j] = best.map(|b| b.0);
            queue.push_back(j);
        }
    }
    (labelled > 0).then_some((img, start))
}

/// The field of the next finer scale from a coarser one: each patch takes
/// its parent's (or a neighbour's) offset doubled, or a random source.
#[allow(clippy::too_many_arguments)]
fn upsample(
    coarse: &Targets,
    cnnf: &[(i32, i32)],
    cw: usize,
    ch: usize,
    fine: &Targets,
    lv: &Level,
    src: &Sources,
    rng: &mut Rng,
) -> Vec<(i32, i32)> {
    let (fw, fh) = (lv.w, lv.h);
    let lo = PR as i64;
    let mut out = Vec::with_capacity(fine.centers.len());
    for &c in &fine.centers {
        let (x, y) = (c as usize % fw, c as usize / fw);
        let (px, py) = ((x / 2).min(cw - 1), (y / 2).min(ch - 1));
        let mut parent = None;
        for (dx, dy) in [
            (0i64, 0i64),
            (-1, 0),
            (1, 0),
            (0, -1),
            (0, 1),
            (-1, -1),
            (1, -1),
            (-1, 1),
            (1, 1),
        ] {
            let (nx, ny) = (px as i64 + dx, py as i64 + dy);
            if nx < 0 || ny < 0 || nx >= cw as i64 || ny >= ch as i64 {
                continue;
            }
            let j = coarse.index[ny as usize * cw + nx as usize];
            if j >= 0 {
                parent = Some(cnnf[j as usize]);
                break;
            }
        }
        let mut offset = None;
        if let Some((ox, oy)) = parent {
            let sx = (x as i64 + 2 * ox as i64).clamp(lo, fw as i64 - 1 - lo);
            let sy = (y as i64 + 2 * oy as i64).clamp(lo, fh as i64 - 1 - lo);
            if src.valid[sy as usize * fw + sx as usize] != 0 {
                offset = Some(((sx - x as i64) as i32, (sy - y as i64) as i32));
            }
        }
        out.push(offset.unwrap_or_else(|| random_offset(src, fw, x, y, rng)));
    }
    out
}
