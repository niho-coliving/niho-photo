//! One mark's brush at one image size: the stroke in pixels, the distance
//! to it, the hole (the pixels the mark fills), the blend of its edge
//! (`feather`), the working scale and the tiles it is filled in, and the
//! pixels it reads and writes (`docs/heal.md` "印の形").
//!
//! Everything here is a function of the mark and the image size only, so a
//! plan and its application (and the plan cache's keys) agree.

use super::{HealMark, HealMode};

/// Patch half size (7 x 7 patches).
pub(super) const PATCH_RADIUS: usize = 3;
/// Most hole pixels of one mark at its working scale (larger marks are
/// filled on a reduced copy and blended back).
const MARK_HOLE_BUDGET: usize = 1 << 20;
/// Most cells of one piece's region (one PatchMatch).
const REGION_BUDGET: usize = 3 << 19;
/// Most distance evaluations (cell x segment) of one mark before the
/// distances are taken on a coarser grid.
const FIELD_BUDGET: f64 = (1u64 << 23) as f64;
/// Largest working scale.
const MAX_SCALE: usize = 64;
/// Douglas–Peucker tolerance of the stroke (pixels).
const SIMPLIFY_PX: f64 = 0.25;

/// Cells `[x0, x1) x [y0, y1)` (pixels at scale 1).
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub(super) struct Area {
    pub x0: usize,
    pub y0: usize,
    pub x1: usize,
    pub y1: usize,
}

impl Area {
    pub fn new(x0: usize, y0: usize, x1: usize, y1: usize) -> Self {
        Self { x0, y0, x1, y1 }
    }

    pub fn width(&self) -> usize {
        self.x1.saturating_sub(self.x0)
    }

    pub fn height(&self) -> usize {
        self.y1.saturating_sub(self.y0)
    }

    pub fn cells(&self) -> usize {
        self.width() * self.height()
    }

    pub fn is_empty(&self) -> bool {
        self.x0 >= self.x1 || self.y0 >= self.y1
    }

    pub fn contains(&self, x: usize, y: usize) -> bool {
        x >= self.x0 && x < self.x1 && y >= self.y0 && y < self.y1
    }

    pub fn intersects(&self, o: &Area) -> bool {
        !self.is_empty()
            && !o.is_empty()
            && self.x0 < o.x1
            && o.x0 < self.x1
            && self.y0 < o.y1
            && o.y0 < self.y1
    }

    pub fn intersect(&self, o: &Area) -> Area {
        Area::new(
            self.x0.max(o.x0),
            self.y0.max(o.y0),
            self.x1.min(o.x1),
            self.y1.min(o.y1),
        )
    }

    pub fn union(&self, o: &Area) -> Area {
        if self.is_empty() {
            *o
        } else if o.is_empty() {
            *self
        } else {
            Area::new(
                self.x0.min(o.x0),
                self.y0.min(o.y0),
                self.x1.max(o.x1),
                self.y1.max(o.y1),
            )
        }
    }

    /// Grown by `by` on every side, within `0..w x 0..h`.
    pub fn grown(&self, by: usize, w: usize, h: usize) -> Area {
        Area::new(
            self.x0.saturating_sub(by),
            self.y0.saturating_sub(by),
            (self.x1 + by).min(w),
            (self.y1 + by).min(h),
        )
    }

    /// Moved by `(dx, dy)`, within `0..w x 0..h`.
    pub fn shifted(&self, dx: i64, dy: i64, w: usize, h: usize) -> Area {
        let f = |v: usize, d: i64, max: usize| (v as i64 + d).clamp(0, max as i64) as usize;
        Area::new(
            f(self.x0, dx, w),
            f(self.y0, dy, h),
            f(self.x1, dx, w),
            f(self.y1, dy, h),
        )
    }
}

/// Distance from `(px, py)` to the segment `a..b`.
fn segment_distance(px: f64, py: f64, a: [f64; 2], b: [f64; 2]) -> f64 {
    let (dx, dy) = (b[0] - a[0], b[1] - a[1]);
    let len2 = dx * dx + dy * dy;
    let t = if len2 > 0.0 {
        (((px - a[0]) * dx + (py - a[1]) * dy) / len2).clamp(0.0, 1.0)
    } else {
        0.0
    };
    let (ex, ey) = (px - (a[0] + t * dx), py - (a[1] + t * dy));
    (ex * ex + ey * ey).sqrt()
}

/// Douglas–Peucker: the points whose removal moves the stroke by at most
/// `tolerance` pixels go (hand-drawn strokes are dense).
fn simplify(points: &[[f64; 2]], tolerance: f64) -> Vec<[f64; 2]> {
    let n = points.len();
    if n <= 2 {
        return points.to_vec();
    }
    let mut keep = vec![false; n];
    keep[0] = true;
    keep[n - 1] = true;
    let mut stack = vec![(0usize, n - 1)];
    while let Some((a, b)) = stack.pop() {
        let mut far = (0.0f64, 0usize);
        for (i, p) in points.iter().enumerate().take(b).skip(a + 1) {
            let d = segment_distance(p[0], p[1], points[a], points[b]);
            if d > far.0 {
                far = (d, i);
            }
        }
        if far.0 > tolerance {
            keep[far.1] = true;
            stack.push((a, far.1));
            stack.push((far.1, b));
        }
    }
    points
        .iter()
        .zip(keep)
        .filter_map(|(p, k)| k.then_some(*p))
        .collect()
}

/// The stroke in pixels and its bounds (no simplification: the footprint
/// and the working scale come from these alone).
struct Basics {
    points: Vec<[f64; 2]>,
    radius: f64,
    write: Area,
    /// An upper bound of the hole's pixels.
    holes: usize,
}

fn basics(mark: &HealMark, width: usize, height: usize) -> Basics {
    let (w, h) = (width as f64, height as f64);
    let mut points: Vec<[f64; 2]> = Vec::with_capacity(mark.points.len());
    for p in &mark.points {
        let q = [p[0] * w, p[1] * h];
        if points.last() != Some(&q) {
            points.push(q);
        }
    }
    let radius = mark.radius * w.max(h);
    let reach = radius + 0.5;
    let write = if points.is_empty() {
        Area::default()
    } else {
        let (mut x0, mut y0, mut x1, mut y1) = (f64::MAX, f64::MAX, f64::MIN, f64::MIN);
        for p in &points {
            x0 = x0.min(p[0]);
            y0 = y0.min(p[1]);
            x1 = x1.max(p[0]);
            y1 = y1.max(p[1]);
        }
        let lo = |v: f64| libm::floor(v - reach).max(0.0) as usize;
        let hi = |v: f64, max: usize| (libm::ceil(v + reach).max(0.0) as usize).min(max);
        Area::new(lo(x0), lo(y0), hi(x1, width), hi(y1, height))
    };
    let disc = std::f64::consts::PI * reach * reach;
    let mut bound = disc;
    for s in points.windows(2) {
        let (dx, dy) = (s[1][0] - s[0][0], s[1][1] - s[0][1]);
        bound += 2.0 * reach * (dx * dx + dy * dy).sqrt() + disc;
    }
    let holes = (libm::ceil(bound) as usize).min(write.cells());
    Basics {
        points,
        radius,
        write,
        holes,
    }
}

/// Tile side (cells): long strokes are filled a tile at a time.
fn tile_cells(radius: f64, p: usize) -> usize {
    (libm::ceil(6.0 * radius / p as f64) as usize).max(384)
}

/// Context around a piece's hole (cells).
fn margin_cells(radius: f64, p: usize) -> usize {
    libm::ceil(((2.0 * radius).max(24.0) + 16.0) / p as f64) as usize + PATCH_RADIUS + 1
}

/// The working scale: 1, or the reduction a very large mark is filled at.
fn scale_of(b: &Basics, width: usize, height: usize) -> usize {
    let mut p = 1usize;
    while p < MAX_SCALE {
        let tile = tile_cells(b.radius, p);
        let margin = margin_cells(b.radius, p);
        let (cw, ch) = (width.div_ceil(p), height.div_ceil(p));
        let (ww, wh) = (b.write.width().div_ceil(p), b.write.height().div_ceil(p));
        let region = (tile.min(ww) + 2 * margin).min(cw) * (tile.min(wh) + 2 * margin).min(ch);
        if b.holes.div_ceil(p * p) <= MARK_HOLE_BUDGET && region <= REGION_BUDGET {
            break;
        }
        p *= 2;
    }
    p
}

/// "写す" with a source: the offset in pixels, kept so the copied area
/// stays on the photo.
fn clone_offset(write: Area, source: [f64; 2], width: usize, height: usize) -> (i64, i64) {
    let dx = libm::round(source[0] * width as f64) as i64;
    let dy = libm::round(source[1] * height as f64) as i64;
    (
        dx.clamp(-(write.x0 as i64), (width - write.x1) as i64),
        dy.clamp(-(write.y0 as i64), (height - write.y1) as i64),
    )
}

/// How far "写す" without a source looks for its place (pixels), and the
/// ring around the hole it compares.
fn auto_reach(radius: f64) -> (usize, usize) {
    (
        libm::ceil(4.0 * radius) as usize + 8,
        (libm::ceil(0.5 * radius) as usize).clamp(2, 32),
    )
}

/// Most cells of the grid "写す" searches its place on.
const SEARCH_CELLS: usize = 1 << 20;

/// Where "写す" without a source searches (pixels) and the reduction it
/// searches at: the hole about 16 cells across at most, the grid within
/// [`SEARCH_CELLS`].
fn auto_search(write: Area, radius: f64, width: usize, height: usize) -> (Area, usize) {
    let (reach, ring) = auto_reach(radius);
    let window = write.grown(reach + ring + 2, width, height);
    let mut q = 1usize;
    while (2.0 * radius / q as f64 > 16.0 || window.cells() / (q * q) > SEARCH_CELLS)
        && q < MAX_SCALE
    {
        q *= 2;
    }
    (window, q)
}

/// The pixels a mark writes and reads at one size (the plan cache's keys).
#[derive(Clone, Copy, Debug)]
pub(super) struct Footprint {
    pub write: Area,
    pub read: Area,
}

pub(super) fn footprint(mark: &HealMark, width: usize, height: usize) -> Footprint {
    let b = basics(mark, width, height);
    let p = scale_of(&b, width, height);
    let remove = b
        .write
        .grown((margin_cells(b.radius, p) + 2) * p, width, height);
    let read = match (mark.mode, mark.source) {
        (HealMode::Remove, _) => remove,
        (HealMode::Clone, Some(source)) => {
            let (dx, dy) = clone_offset(b.write, source, width, height);
            let near = b.write.grown(2 * p, width, height);
            near.union(&near.shifted(dx, dy, width, height))
        }
        (HealMode::Clone, None) => {
            // The search window, the refined place (one search cell more)
            // and the copy around the hole; or "消す" when no place fits.
            let (window, q) = auto_search(b.write, b.radius, width, height);
            let (reach, _) = auto_reach(b.radius);
            let copy = b.write.grown(reach + 3 * q + 2 * p + 2, width, height);
            remove.union(&window).union(&copy)
        }
    };
    Footprint {
        write: b.write,
        read,
    }
}

/// Distances are exact up to `reach + pad(p)` from the stroke, enough for
/// the coarse hole test at scale `p` ([`Shape::mask`]).
fn pad(p: usize) -> f64 {
    2.0 + 1.5 * p as f64
}

/// One mark at one image size.
pub(super) struct Shape {
    /// The stroke (pixels, simplified) as segments and their bounds.
    segments: Vec<([f64; 2], [f64; 2])>,
    bounds: Vec<[f64; 4]>,
    pub radius: f64,
    feather: f64,
    pub width: usize,
    pub height: usize,
    /// Pixels the mark may write (alpha > 0).
    pub write: Area,
    /// Working scale (cells of `scale x scale` pixels).
    pub scale: usize,
    /// Distance grid step (pixels).
    step: usize,
    /// Tile side and a piece's context (cells).
    pub tile: usize,
    pub margin: usize,
    /// The written cells (at `scale`) and the tile grid's size.
    pub write_cells: Area,
    tiles_x: usize,
    tiles_y: usize,
}

impl Shape {
    pub fn new(mark: &HealMark, width: usize, height: usize) -> Shape {
        let b = basics(mark, width, height);
        let scale = scale_of(&b, width, height);
        let points = simplify(&b.points, SIMPLIFY_PX);
        let segments: Vec<([f64; 2], [f64; 2])> = match points.len() {
            0 => Vec::new(),
            1 => vec![(points[0], points[0])],
            _ => points.windows(2).map(|s| (s[0], s[1])).collect(),
        };
        let bounds: Vec<[f64; 4]> = segments
            .iter()
            .map(|(a, b)| {
                [
                    a[0].min(b[0]),
                    a[1].min(b[1]),
                    a[0].max(b[0]),
                    a[1].max(b[1]),
                ]
            })
            .collect();
        let rp = b.radius + 0.5 + pad(scale);
        let work: f64 = bounds
            .iter()
            .map(|r| {
                let w = ((r[2] + rp).min(width as f64) - (r[0] - rp).max(0.0)).max(0.0) + 1.0;
                let h = ((r[3] + rp).min(height as f64) - (r[1] - rp).max(0.0)).max(0.0) + 1.0;
                w * h
            })
            .sum();
        let mut step = 1usize;
        while work / (step * step) as f64 > FIELD_BUDGET && step < MAX_SCALE {
            step *= 2;
        }
        let write_cells = Area::new(
            b.write.x0 / scale,
            b.write.y0 / scale,
            b.write.x1.div_ceil(scale),
            b.write.y1.div_ceil(scale),
        );
        let tile = tile_cells(b.radius, scale);
        Shape {
            segments,
            bounds,
            radius: b.radius,
            feather: mark.feather,
            width,
            height,
            write: b.write,
            scale,
            step,
            tile,
            margin: margin_cells(b.radius, scale),
            write_cells,
            tiles_x: write_cells.width().div_ceil(tile),
            tiles_y: write_cells.height().div_ceil(tile),
        }
    }

    /// Pixels whose centers are closer than this to the stroke are filled.
    pub fn reach(&self) -> f64 {
        self.radius + 0.5
    }

    /// The blend of the fill over the photo at distance `d`: 1 inside, a
    /// smooth step to 0 at [`Shape::reach`] over `feather x radius / 2`
    /// (plus one pixel of anti-aliasing): the inner half of the brush is
    /// always filled whole.
    pub fn alpha(&self, d: f32) -> f32 {
        let reach = self.reach() as f32;
        if d.is_nan() || d >= reach {
            return 0.0;
        }
        let ramp = (0.5 * self.feather * self.radius) as f32 + 1.0;
        let t = ((reach - d) / ramp).min(1.0);
        t * t * (3.0 - 2.0 * t)
    }

    /// Global cells at this mark's scale.
    pub fn cells_size(&self) -> (usize, usize) {
        (
            self.width.div_ceil(self.scale),
            self.height.div_ceil(self.scale),
        )
    }

    /// The tiles holding part of the stroke, in order (cells at `scale`).
    pub fn tiles(&self) -> Vec<(usize, Area)> {
        let p = self.scale as f64;
        let mut out = Vec::new();
        for ty in 0..self.tiles_y {
            for tx in 0..self.tiles_x {
                let x0 = self.write_cells.x0 + tx * self.tile;
                let y0 = self.write_cells.y0 + ty * self.tile;
                let cells = Area::new(
                    x0,
                    y0,
                    (x0 + self.tile).min(self.write_cells.x1),
                    (y0 + self.tile).min(self.write_cells.y1),
                );
                let (px0, py0) = (cells.x0 as f64 * p, cells.y0 as f64 * p);
                let (px1, py1) = (cells.x1 as f64 * p, cells.y1 as f64 * p);
                let rp = self.reach() + pad(self.scale);
                let touched = self.bounds.iter().any(|r| {
                    r[0] - rp < px1 && r[2] + rp > px0 && r[1] - rp < py1 && r[3] + rp > py0
                });
                if touched {
                    out.push((ty * self.tiles_x + tx, cells));
                }
            }
        }
        out
    }

    /// The order of the tile holding cell `(x, y)` (`None` outside the
    /// written cells: never part of the hole).
    pub fn tile_order(&self, x: usize, y: usize) -> Option<usize> {
        self.write_cells.contains(x, y).then(|| {
            let tx = (x - self.write_cells.x0) / self.tile;
            let ty = (y - self.write_cells.y0) / self.tile;
            ty * self.tiles_x + tx
        })
    }

    /// The distances over the pixels of `cells` at scale `p` (and one grid
    /// step around them).
    pub fn field(&self, cells: Area, p: usize) -> Field {
        let s = self.step;
        let (gw, gh) = (self.width.div_ceil(s), self.height.div_ceil(s));
        let i0 = (cells.x0 * p / s).saturating_sub(1);
        let j0 = (cells.y0 * p / s).saturating_sub(1);
        let i1 = ((cells.x1 * p).min(self.width).div_ceil(s) + 1).min(gw);
        let j1 = ((cells.y1 * p).min(self.height).div_ceil(s) + 1).min(gh);
        let (cols, rows) = (i1.saturating_sub(i0), j1.saturating_sub(j0));
        let rp = self.reach() + pad(p);
        let far = rp as f32;
        let mut data = vec![far; cols * rows];
        let sf = s as f64;
        for ((a, b), r) in self.segments.iter().zip(&self.bounds) {
            // Cells whose centers `(i + 0.5) s` lie inside the reach.
            let lo_i = (libm::ceil((r[0] - rp) / sf - 0.5).max(0.0) as usize).max(i0);
            let lo_j = (libm::ceil((r[1] - rp) / sf - 0.5).max(0.0) as usize).max(j0);
            let hi_i = libm::floor((r[2] + rp) / sf - 0.5);
            let hi_j = libm::floor((r[3] + rp) / sf - 0.5);
            if hi_i < 0.0 || hi_j < 0.0 {
                continue;
            }
            let hi_i = (hi_i as usize + 1).min(i1);
            let hi_j = (hi_j as usize + 1).min(j1);
            for j in lo_j..hi_j {
                let cy = (j as f64 + 0.5) * sf;
                let row = (j - j0) * cols;
                for i in lo_i..hi_i {
                    let cx = (i as f64 + 0.5) * sf;
                    let d = segment_distance(cx, cy, *a, *b) as f32;
                    let cell = &mut data[row + i - i0];
                    if d < *cell {
                        *cell = d;
                    }
                }
            }
        }
        Field {
            i0,
            j0,
            cols,
            rows,
            step: s,
            far,
            data,
        }
    }

    /// The hole over `cells` (row-major): cells at scale `p` holding a
    /// pixel the mark fills (at scale 1 exactly the pixels with alpha > 0;
    /// at a coarser scale every cell that may hold one), and the field.
    pub fn mask(&self, cells: Area, p: usize) -> (Vec<u8>, Field) {
        let field = self.field(cells, p);
        let reach = self.reach() as f32;
        let mut mask = vec![0u8; cells.cells()];
        let w = cells.width();
        for y in cells.y0..cells.y1 {
            for x in cells.x0..cells.x1 {
                let hole = if p == 1 {
                    field.at(x, y) < reach
                } else {
                    let (x0, y0) = (x * p, y * p);
                    let (x1, y1) = ((x0 + p).min(self.width), (y0 + p).min(self.height));
                    let (mx, my) = ((x0 + x1) as f64 * 0.5, (y0 + y1) as f64 * 0.5);
                    let (hw, hh) = ((x1 - x0) as f64 * 0.5, (y1 - y0) as f64 * 0.5);
                    let half = (hw * hw + hh * hh).sqrt();
                    field.at_point(mx, my) - ((1.5 * half) as f32) < reach
                };
                mask[(y - cells.y0) * w + (x - cells.x0)] = hole as u8;
            }
        }
        (mask, field)
    }

    /// The "写す" offset for a source (pixels).
    pub fn clone_offset(&self, source: [f64; 2]) -> (i64, i64) {
        clone_offset(self.write, source, self.width, self.height)
    }

    /// [`auto_reach`].
    pub fn auto_reach(&self) -> (usize, usize) {
        auto_reach(self.radius)
    }

    /// [`auto_search`].
    pub fn auto_search(&self) -> (Area, usize) {
        auto_search(self.write, self.radius, self.width, self.height)
    }
}

/// Distances to a stroke on a grid of `step` pixels (cell `(i, j)`'s
/// center at `((i + 0.5) step, (j + 0.5) step)`), exact up to a reach and
/// `far` beyond it.
pub(super) struct Field {
    i0: usize,
    j0: usize,
    cols: usize,
    rows: usize,
    step: usize,
    far: f32,
    data: Vec<f32>,
}

impl Field {
    /// At pixel `(x, y)`'s center.
    pub fn at(&self, x: usize, y: usize) -> f32 {
        if self.step == 1 {
            if x < self.i0 || y < self.j0 || x - self.i0 >= self.cols || y - self.j0 >= self.rows {
                return self.far;
            }
            return self.data[(y - self.j0) * self.cols + (x - self.i0)];
        }
        self.at_point(x as f64 + 0.5, y as f64 + 0.5)
    }

    /// At a point (pixels), interpolated between the grid's cells.
    pub fn at_point(&self, x: f64, y: f64) -> f32 {
        if self.cols == 0 || self.rows == 0 {
            return self.far;
        }
        let s = self.step as f64;
        let gx = x / s - 0.5 - self.i0 as f64;
        let gy = y / s - 0.5 - self.j0 as f64;
        if gx < -1.0 || gy < -1.0 || gx > self.cols as f64 || gy > self.rows as f64 {
            return self.far;
        }
        let (fx, fy) = (libm::floor(gx), libm::floor(gy));
        let (tx, ty) = ((gx - fx).clamp(0.0, 1.0), (gy - fy).clamp(0.0, 1.0));
        let last_i = self.cols as i64 - 1;
        let last_j = self.rows as i64 - 1;
        let ia = (fx as i64).clamp(0, last_i) as usize;
        let ib = (fx as i64 + 1).clamp(0, last_i) as usize;
        let ja = (fy as i64).clamp(0, last_j) as usize;
        let jb = (fy as i64 + 1).clamp(0, last_j) as usize;
        let v = |i: usize, j: usize| f64::from(self.data[j * self.cols + i]);
        let top = v(ia, ja) * (1.0 - tx) + v(ib, ja) * tx;
        let bottom = v(ia, jb) * (1.0 - tx) + v(ib, jb) * tx;
        (top * (1.0 - ty) + bottom * ty) as f32
    }
}

/// Cells within Chebyshev distance `r` of a set cell (`w x h`, row-major).
pub(super) fn dilate(mask: &[u8], w: usize, h: usize, r: usize) -> Vec<u8> {
    let mut rows = vec![0u8; w * h];
    let mut prefix = vec![0u32; w.max(h) + 1];
    for y in 0..h {
        let row = &mask[y * w..(y + 1) * w];
        for x in 0..w {
            prefix[x + 1] = prefix[x] + u32::from(row[x] != 0);
        }
        for x in 0..w {
            let (lo, hi) = (x.saturating_sub(r), (x + r + 1).min(w));
            rows[y * w + x] = u8::from(prefix[hi] > prefix[lo]);
        }
    }
    let mut out = vec![0u8; w * h];
    for x in 0..w {
        for y in 0..h {
            prefix[y + 1] = prefix[y] + u32::from(rows[y * w + x] != 0);
        }
        for y in 0..h {
            let (lo, hi) = (y.saturating_sub(r), (y + r + 1).min(h));
            out[y * w + x] = u8::from(prefix[hi] > prefix[lo]);
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    fn mark(points: &[[f64; 2]], radius: f64, feather: f64) -> HealMark {
        HealMark {
            id: "m".into(),
            mode: HealMode::Remove,
            radius,
            feather,
            points: points.to_vec(),
            source: None,
        }
    }

    #[test]
    fn the_hole_is_the_pixels_within_the_radius() {
        let m = mark(&[[0.25, 0.5], [0.75, 0.5]], 0.05, 0.0);
        let shape = Shape::new(&m, 200, 100);
        assert_eq!(shape.scale, 1);
        let all = Area::new(0, 0, 200, 100);
        let (mask, field) = shape.mask(all, 1);
        // Radius 10 px around y = 50 from x = 50 to 150.
        for (x, y, inside) in [
            (100, 50, true),
            (100, 59, true),
            (100, 61, false),
            (45, 50, true),
            (39, 50, false),
            (155, 50, true),
            (161, 50, false),
        ] {
            assert_eq!(mask[y * 200 + x] != 0, inside, "({x}, {y})");
            assert_eq!(shape.alpha(field.at(x, y)) > 0.0, inside, "({x}, {y})");
        }
        assert!(shape.write.contains(40, 41) && !shape.write.contains(20, 50));
        assert_eq!(shape.alpha(0.0), 1.0);
    }

    #[test]
    fn feather_softens_the_edge() {
        let hard = Shape::new(&mark(&[[0.5, 0.5]], 0.1, 0.0), 100, 100);
        let soft = Shape::new(&mark(&[[0.5, 0.5]], 0.1, 1.0), 100, 100);
        assert_eq!(hard.alpha(5.0), 1.0);
        // The inner half stays whole; the outer half fades.
        assert_eq!(soft.alpha(4.0), 1.0);
        assert!(soft.alpha(8.0) < 0.6 && soft.alpha(8.0) > 0.2);
        assert!(soft.alpha(9.0) < hard.alpha(9.0));
        assert_eq!(soft.alpha(11.0), 0.0);
    }

    #[test]
    fn coarse_cells_cover_every_filled_pixel() {
        let m = mark(&[[0.1, 0.2], [0.7, 0.9], [0.95, 0.1]], 0.013, 0.3);
        let shape = Shape::new(&m, 333, 211);
        for p in [2usize, 4, 8] {
            let (cw, ch) = (333usize.div_ceil(p), 211usize.div_ceil(p));
            let (coarse, _) = shape.mask(Area::new(0, 0, cw, ch), p);
            let (fine, _) = shape.mask(Area::new(0, 0, 333, 211), 1);
            for y in 0..211 {
                for x in 0..333 {
                    if fine[y * 333 + x] != 0 {
                        assert_eq!(coarse[(y / p) * cw + x / p], 1, "p {p} ({x}, {y})");
                    }
                }
            }
        }
    }

    #[test]
    fn simplify_keeps_corners_and_drops_collinear_points() {
        let line: Vec<[f64; 2]> = (0..=100).map(|i| [i as f64, 2.0 * i as f64]).collect();
        assert_eq!(simplify(&line, 0.25), vec![[0.0, 0.0], [100.0, 200.0]]);
        let back = [[0.0, 0.0], [10.0, 0.0], [5.0, 0.0]];
        assert_eq!(simplify(&back, 0.25).len(), 3);
    }

    #[test]
    fn dilate_is_a_square() {
        let mut mask = vec![0u8; 7 * 5];
        mask[2 * 7 + 3] = 1;
        let out = dilate(&mask, 7, 5, 1);
        let set: Vec<usize> = (0..35).filter(|&i| out[i] != 0).collect();
        assert_eq!(set, vec![9, 10, 11, 16, 17, 18, 23, 24, 25]);
    }

    #[test]
    fn a_huge_mark_is_worked_at_a_reduced_scale_and_reads_its_surroundings() {
        let big = mark(&[[0.1, 0.1], [0.9, 0.9], [0.1, 0.9], [0.9, 0.1]], 0.25, 0.0);
        let shape = Shape::new(&big, 4000, 3000);
        assert!(shape.scale > 1);
        let small = mark(&[[0.5, 0.5]], 0.01, 0.0);
        let f = footprint(&small, 1000, 1000);
        assert!(f.read.contains(f.write.x0 - 20, f.write.y0) && f.write.cells() < f.read.cells());
        let clone = HealMark {
            mode: HealMode::Clone,
            source: Some([0.3, 0.0]),
            ..small.clone()
        };
        let f = footprint(&clone, 1000, 1000);
        assert!(f.read.contains(805, 500), "{:?}", f.read);
        // A source off the photo is pushed back onto it.
        let s = Shape::new(&clone, 1000, 1000);
        assert_eq!(
            s.clone_offset([0.9, -0.9]),
            (1000 - s.write.x1 as i64, -(s.write.y0 as i64))
        );
    }
}
