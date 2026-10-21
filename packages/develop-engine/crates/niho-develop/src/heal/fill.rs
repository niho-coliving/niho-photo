//! Filling one mark (`docs/heal.md` "埋め方"): the plan, found once on the
//! search image, and its application to any image of that size.
//!
//! - **"消す"**: the hole is completed tile by tile (long strokes) with a
//!   multi-scale PatchMatch on a perceptual encoding (`sqrt` of linear
//!   light): 7 x 7 patches, nearest-neighbour fields refined by
//!   propagation and random search inside the tile's region, and an EM
//!   loop whose votes average the matched sources (weighted by how well
//!   they match) from the coarsest scale (the onion-peeled hole) to the
//!   finest. The plan keeps the finest field (offset and weight per
//!   patch); applying it votes those sources again on the image at hand.
//! - **"写す"**: the hole takes the pixels at an offset (the mark's
//!   `source`, or the place whose surroundings match the hole's best).
//! - Both then match the colors at the hole's edge (the difference between
//!   the photo just outside and the fill just inside, smoothed and spread
//!   over the hole) and blend the fill over the photo with the brush's
//!   edge ([`Shape::alpha`]).
//!
//! Every step runs in a fixed order with `f32` / `f64` arithmetic, `libm`
//! and a fixed-seed xorshift, so native and wasm give the same bytes.

use super::complete::{complete, decode, encode};
use super::shape::{dilate, Area, Shape, PATCH_RADIUS};
use super::{HealMark, HealMode};
use crate::decode::LinearImage;

const PR: usize = PATCH_RADIUS;
/// Depth of the ring of photo cells around the hole whose color the fill
/// is matched to (at most [`PR`]: the fill's patches cover it).
const RING_DEPTH: usize = 2;
/// Largest color correction (encoded units, per channel).
const MAX_DELTA: f32 = 0.15;
/// Most cells of the color-correction grid.
const DELTA_CELLS: usize = 1 << 18;

/// A mark's fill at one size.
pub(crate) struct Plan {
    kind: Kind,
}

enum Kind {
    /// Nothing to fill at this size.
    Identity,
    /// "消す": the tiles in order.
    Fill(Vec<Piece>),
    /// "写す": the offset (pixels).
    Copy { dx: i64, dy: i64 },
}

struct Piece {
    /// The tile's order ([`Shape::tile_order`]).
    order: usize,
    fill: PieceFill,
}

enum PieceFill {
    /// The patches over the tile's hole (row-major): source offset and
    /// vote weight.
    Matches(Vec<Match>),
    /// No source patch around: the hole is smoothed in from its edge.
    Smooth,
}

#[derive(Clone, Copy)]
struct Match {
    ox: i32,
    oy: i32,
    weight: f32,
}

impl Plan {
    /// Approximate memory (the plan cache's budget).
    pub(super) fn bytes(&self) -> usize {
        64 + match &self.kind {
            Kind::Fill(pieces) => pieces
                .iter()
                .map(|p| match &p.fill {
                    PieceFill::Matches(m) => 32 + m.len() * std::mem::size_of::<Match>(),
                    PieceFill::Smooth => 32,
                })
                .sum(),
            _ => 0,
        }
    }
}

/// The cells of a mark's scale the fill works on: the image itself at
/// scale 1, else a reduced copy of a window of it.
struct Canvas<'a> {
    data: &'a mut [f32],
    /// The window in global cells.
    area: Area,
}

impl Canvas<'_> {
    #[inline]
    fn index(&self, x: usize, y: usize) -> usize {
        (y - self.area.y0) * self.area.width() + (x - self.area.x0)
    }

    #[inline]
    fn get(&self, x: usize, y: usize) -> [f32; 3] {
        let i = self.index(x, y) * 3;
        [self.data[i], self.data[i + 1], self.data[i + 2]]
    }

    #[inline]
    fn set(&mut self, x: usize, y: usize, v: [f32; 3]) {
        let i = self.index(x, y) * 3;
        self.data[i..i + 3].copy_from_slice(&v);
    }

    /// At `(x + dx, y + dy)` held inside the window.
    #[inline]
    fn get_clamped(&self, x: usize, y: usize, dx: i64, dy: i64) -> [f32; 3] {
        let a = &self.area;
        let cx = (x as i64 + dx).clamp(a.x0 as i64, a.x1 as i64 - 1) as usize;
        let cy = (y as i64 + dy).clamp(a.y0 as i64, a.y1 as i64 - 1) as usize;
        self.get(cx, cy)
    }
}

/// `image` averaged over the cells of `area` at scale `p` (linear).
fn reduce(image: &LinearImage, area: Area, p: usize) -> Vec<f32> {
    let mut out = vec![0.0f32; area.cells() * 3];
    let w = area.width();
    for cy in area.y0..area.y1 {
        let (y0, y1) = (cy * p, ((cy + 1) * p).min(image.height));
        for cx in area.x0..area.x1 {
            let (x0, x1) = (cx * p, ((cx + 1) * p).min(image.width));
            let mut sum = [0.0f32; 3];
            for y in y0..y1 {
                for x in x0..x1 {
                    let i = (y * image.width + x) * 3;
                    sum[0] += image.data[i];
                    sum[1] += image.data[i + 1];
                    sum[2] += image.data[i + 2];
                }
            }
            let n = ((x1 - x0) * (y1 - y0)) as f32;
            let o = ((cy - area.y0) * w + (cx - area.x0)) * 3;
            out[o] = sum[0] / n;
            out[o + 1] = sum[1] / n;
            out[o + 2] = sum[2] / n;
        }
    }
    out
}

/// Finds the plan of `mark` on `image` (the search image; left as it was).
pub(super) fn plan(mark: &HealMark, image: &mut LinearImage) -> Plan {
    let shape = Shape::new(mark, image.width, image.height);
    if shape.write.is_empty() {
        return Plan {
            kind: Kind::Identity,
        };
    }
    let kind = match (mark.mode, mark.source) {
        (HealMode::Clone, Some(source)) => {
            let (dx, dy) = shape.clone_offset(source);
            Kind::Copy { dx, dy }
        }
        (HealMode::Clone, None) => match find_source(&shape, image) {
            Some((dx, dy)) => Kind::Copy { dx, dy },
            None => plan_remove(&shape, image),
        },
        (HealMode::Remove, _) => plan_remove(&shape, image),
    };
    Plan { kind }
}

/// Applies a plan of `mark` to `image` (of the size it was found at).
pub(super) fn apply(plan: &Plan, mark: &HealMark, image: &mut LinearImage) {
    let shape = Shape::new(mark, image.width, image.height);
    match &plan.kind {
        Kind::Identity => {}
        Kind::Fill(pieces) => {
            if shape.scale == 1 {
                let area = Area::new(0, 0, image.width, image.height);
                let mut canvas = Canvas {
                    data: &mut image.data,
                    area,
                };
                let filled = fill_pieces(&shape, pieces, &mut canvas);
                let colors = finish(&shape, &filled);
                composite_fine(&shape, &filled, &colors, &mut canvas);
            } else {
                let area = remove_window(&shape);
                let mut data = reduce(image, area, shape.scale);
                let mut canvas = Canvas {
                    data: &mut data,
                    area,
                };
                let filled = fill_pieces(&shape, pieces, &mut canvas);
                let colors = finish(&shape, &filled);
                for (i, &(x, y)) in filled.cells.iter().enumerate() {
                    canvas.set(x as usize, y as usize, colors[i]);
                }
                composite_coarse(&shape, &canvas, image);
            }
        }
        Kind::Copy { dx, dy } => {
            if shape.scale == 1 {
                let area = Area::new(0, 0, image.width, image.height);
                let mut canvas = Canvas {
                    data: &mut image.data,
                    area,
                };
                let filled = copy_cells(&shape, &canvas, *dx, *dy);
                let colors = finish(&shape, &filled);
                composite_fine(&shape, &filled, &colors, &mut canvas);
            } else {
                let p = shape.scale as i64;
                let (cx, cy) = (div_round(*dx, p), div_round(*dy, p));
                let (cw, ch) = shape.cells_size();
                let near = shape.write_cells.grown(1, cw, ch);
                let area = near.union(&near.shifted(cx, cy, cw, ch));
                let mut data = reduce(image, area, shape.scale);
                let mut canvas = Canvas {
                    data: &mut data,
                    area,
                };
                let filled = copy_cells(&shape, &canvas, cx, cy);
                let colors = finish(&shape, &filled);
                for (i, &(x, y)) in filled.cells.iter().enumerate() {
                    canvas.set(x as usize, y as usize, colors[i]);
                }
                composite_coarse(&shape, &canvas, image);
            }
        }
    }
}

fn div_round(v: i64, p: i64) -> i64 {
    libm::round(v as f64 / p as f64) as i64
}

/// The window a reduced "消す" works on (global cells).
fn remove_window(shape: &Shape) -> Area {
    let (cw, ch) = shape.cells_size();
    shape.write_cells.grown(shape.margin + 1, cw, ch)
}

/// The filled cells of one mark: where (global cells, in order), the fill
/// and the photo there (linear), the blend (scale 1) and the color
/// differences sampled at the hole's edge.
#[derive(Default)]
struct Filled {
    cells: Vec<(u32, u32)>,
    raw: Vec<[f32; 3]>,
    orig: Vec<[f32; 3]>,
    alpha: Vec<f32>,
    /// `(cell, photo - fill)` in encoded units, at hole cells next to the
    /// photo.
    edges: Vec<((u32, u32), [f32; 3])>,
}

/// The hole cells of `tile` (row-major) with the mask of `apron`
/// (`tile` grown by one cell) and the field.
struct TileHole {
    apron: Area,
    mask: Vec<u8>,
    field: super::shape::Field,
    cells: Vec<(usize, usize)>,
}

fn tile_hole(shape: &Shape, tile: Area, bounds: Area) -> TileHole {
    let (cw, ch) = shape.cells_size();
    let apron = tile.grown(RING_DEPTH, cw, ch).intersect(&bounds);
    let (mask, field) = shape.mask(apron, shape.scale);
    let w = apron.width();
    let mut cells = Vec::new();
    for y in tile.y0..tile.y1 {
        for x in tile.x0..tile.x1 {
            if apron.contains(x, y) && mask[(y - apron.y0) * w + (x - apron.x0)] != 0 {
                cells.push((x, y));
            }
        }
    }
    TileHole {
        apron,
        mask,
        field,
        cells,
    }
}

impl TileHole {
    /// The photo cells within [`RING_DEPTH`] of this tile's hole cells
    /// (row-major, inside `bounds`): where the fill meets the photo.
    fn ring(&self, bounds: &Area) -> Vec<(usize, usize)> {
        let ap = self.apron;
        let (w, h) = (ap.width(), ap.height());
        let mut mine = vec![0u8; w * h];
        for &(x, y) in &self.cells {
            mine[(y - ap.y0) * w + (x - ap.x0)] = 1;
        }
        let near = dilate(&mine, w, h, RING_DEPTH);
        let mut out = Vec::new();
        for y in ap.y0..ap.y1 {
            for x in ap.x0..ap.x1 {
                let k = (y - ap.y0) * w + (x - ap.x0);
                if near[k] != 0 && self.mask[k] == 0 && bounds.contains(x, y) {
                    out.push((x, y));
                }
            }
        }
        out
    }
}

fn push_cell(
    shape: &Shape,
    filled: &mut Filled,
    hole: &TileHole,
    x: usize,
    y: usize,
    raw: [f32; 3],
    orig: [f32; 3],
) {
    filled.cells.push((x as u32, y as u32));
    filled.raw.push(raw);
    filled.orig.push(orig);
    if shape.scale == 1 {
        filled.alpha.push(shape.alpha(hole.field.at(x, y)));
    }
}

// MARK: - "消す": applying

/// Votes each piece's matches on the canvas tile by tile (each tile's fill
/// is written before the next reads it, as when it was planned).
fn fill_pieces(shape: &Shape, pieces: &[Piece], canvas: &mut Canvas<'_>) -> Filled {
    let mut filled = Filled::default();
    let tiles = shape.tiles();
    let bounds = canvas.area;
    for piece in pieces {
        let Some(&(_, tile)) = tiles.iter().find(|(o, _)| *o == piece.order) else {
            continue;
        };
        let hole = tile_hole(shape, tile, bounds);
        if hole.cells.is_empty() {
            continue;
        }
        let voted = match &piece.fill {
            PieceFill::Matches(matches) => vote_tile(&hole, matches, canvas),
            PieceFill::Smooth => {
                smooth_tile(shape, &hole, tile, piece.order, canvas).map(|f| (f, Vec::new()))
            }
        };
        let Some((fills, ring)) = voted else {
            continue;
        };
        for (&(x, y), raw) in hole.cells.iter().zip(&fills) {
            let orig = canvas.get(x, y);
            push_cell(shape, &mut filled, &hole, x, y, *raw, orig);
        }
        // The color difference where the photo and the patches' vote meet:
        // the pixels next to the hole, photo against vote.
        for ((x, y), vote) in ring {
            let photo = canvas.get(x, y);
            filled.edges.push((
                (x as u32, y as u32),
                [
                    encode(photo[0]) - encode(vote[0]),
                    encode(photo[1]) - encode(vote[1]),
                    encode(photo[2]) - encode(vote[2]),
                ],
            ));
        }
        for (&(x, y), raw) in hole.cells.iter().zip(&fills) {
            canvas.set(x, y, *raw);
        }
    }
    filled
}

/// The patches over a tile's hole: cells within [`PR`] of it, row-major,
/// in the window `area` (global cells).
fn tile_patches(hole: &TileHole, area: Area) -> (Area, Vec<(usize, usize)>) {
    let grid = Area::new(
        hole.cells
            .iter()
            .map(|c| c.0)
            .min()
            .unwrap_or(0)
            .saturating_sub(PR),
        hole.cells
            .iter()
            .map(|c| c.1)
            .min()
            .unwrap_or(0)
            .saturating_sub(PR),
        hole.cells.iter().map(|c| c.0).max().unwrap_or(0) + PR + 1,
        hole.cells.iter().map(|c| c.1).max().unwrap_or(0) + PR + 1,
    )
    .intersect(&area);
    let w = grid.width();
    let mut mask = vec![0u8; grid.cells()];
    for &(x, y) in &hole.cells {
        mask[(y - grid.y0) * w + (x - grid.x0)] = 1;
    }
    let near = dilate(&mask, w, grid.height(), PR);
    let mut centers = Vec::new();
    for y in grid.y0..grid.y1 {
        for x in grid.x0..grid.x1 {
            if near[(y - grid.y0) * w + (x - grid.x0)] != 0 {
                centers.push((x, y));
            }
        }
    }
    (grid, centers)
}

/// The vote of `matches` for a tile's hole cells (linear, from the
/// canvas), and for the photo cells next to them (where the vote meets the
/// photo).
#[allow(clippy::type_complexity)]
fn vote_tile(
    hole: &TileHole,
    matches: &[Match],
    canvas: &Canvas<'_>,
) -> Option<(Vec<[f32; 3]>, Vec<((usize, usize), [f32; 3])>)> {
    let (grid, centers) = tile_patches(hole, canvas.area);
    if centers.len() != matches.len() {
        return None;
    }
    let w = grid.width();
    let mut slot = vec![u32::MAX; grid.cells()];
    for (i, &(x, y)) in hole.cells.iter().enumerate() {
        slot[(y - grid.y0) * w + (x - grid.x0)] = i as u32;
    }
    let ring = hole.ring(&grid);
    for (j, &(x, y)) in ring.iter().enumerate() {
        slot[(y - grid.y0) * w + (x - grid.x0)] = (hole.cells.len() + j) as u32;
    }
    let n = hole.cells.len() + ring.len();
    let mut acc = vec![0.0f32; n * 3];
    let mut wsum = vec![0.0f32; n];
    let a = canvas.area;
    for (&(cx, cy), m) in centers.iter().zip(matches) {
        let ylo = cy.saturating_sub(PR).max(grid.y0);
        let yhi = (cy + PR + 1).min(grid.y1);
        let xlo = cx.saturating_sub(PR).max(grid.x0);
        let xhi = (cx + PR + 1).min(grid.x1);
        for y in ylo..yhi {
            for x in xlo..xhi {
                let i = slot[(y - grid.y0) * w + (x - grid.x0)];
                if i == u32::MAX {
                    continue;
                }
                let sx = (x as i64 + m.ox as i64).clamp(a.x0 as i64, a.x1 as i64 - 1) as usize;
                let sy = (y as i64 + m.oy as i64).clamp(a.y0 as i64, a.y1 as i64 - 1) as usize;
                let s = canvas.get(sx, sy);
                let i = i as usize;
                acc[i * 3] += m.weight * s[0];
                acc[i * 3 + 1] += m.weight * s[1];
                acc[i * 3 + 2] += m.weight * s[2];
                wsum[i] += m.weight;
            }
        }
    }
    let mean = |i: usize, (x, y): (usize, usize)| {
        let ws = wsum[i];
        if ws > 0.0 {
            [acc[i * 3] / ws, acc[i * 3 + 1] / ws, acc[i * 3 + 2] / ws]
        } else {
            canvas.get(x, y)
        }
    };
    let holes = hole.cells.len();
    let fills = (0..holes).map(|i| mean(i, hole.cells[i])).collect();
    let ring = ring
        .iter()
        .enumerate()
        .filter(|(j, _)| wsum[holes + j] > 0.0)
        .map(|(j, &c)| (c, mean(holes + j, c)))
        .collect();
    Some((fills, ring))
}

/// A tile's hole smoothed in from the photo around it (no source patch):
/// onion peeling, each ring the mean of its filled 8-neighbours. The hole
/// cells of later tiles stay unknown; the earlier tiles' fills count.
fn smooth_tile(
    shape: &Shape,
    hole: &TileHole,
    tile: Area,
    order: usize,
    canvas: &Canvas<'_>,
) -> Option<Vec<[f32; 3]>> {
    let ap = hole.apron;
    let w = ap.width();
    // 0 known, 1 to fill, 2 unknown (a later tile's hole).
    let mut state = vec![0u8; ap.cells()];
    let mut values = vec![[0.0f32; 3]; ap.cells()];
    for y in ap.y0..ap.y1 {
        for x in ap.x0..ap.x1 {
            let k = (y - ap.y0) * w + (x - ap.x0);
            values[k] = canvas.get(x, y);
            if hole.mask[k] != 0 {
                state[k] = if tile.contains(x, y) {
                    1
                } else if shape.tile_order(x, y).is_some_and(|o| o > order) {
                    2
                } else {
                    0
                };
            }
        }
    }
    let mut pending: Vec<usize> = (0..state.len()).filter(|&k| state[k] == 1).collect();
    let mut updates: Vec<(usize, [f32; 3])> = Vec::new();
    while !pending.is_empty() {
        updates.clear();
        let mut rest = Vec::new();
        for &k in &pending {
            let (x, y) = (k % w, k / w);
            let mut sum = [0.0f32; 3];
            let mut n = 0u32;
            for dy in -1i64..=1 {
                for dx in -1i64..=1 {
                    let (nx, ny) = (x as i64 + dx, y as i64 + dy);
                    if (dx, dy) == (0, 0)
                        || nx < 0
                        || ny < 0
                        || nx >= w as i64
                        || ny >= ap.height() as i64
                    {
                        continue;
                    }
                    let j = ny as usize * w + nx as usize;
                    if state[j] == 0 {
                        sum[0] += values[j][0];
                        sum[1] += values[j][1];
                        sum[2] += values[j][2];
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
            values[k] = v;
            state[k] = 0;
        }
        pending = rest;
    }
    Some(
        hole.cells
            .iter()
            .map(|&(x, y)| values[(y - ap.y0) * w + (x - ap.x0)])
            .collect(),
    )
}

// MARK: - "消す": planning

/// Plans "消す" tile by tile on `image` (scale 1: in place, put back after;
/// coarser: on a reduced copy).
fn plan_remove(shape: &Shape, image: &mut LinearImage) -> Kind {
    if shape.scale == 1 {
        let area = Area::new(0, 0, image.width, image.height);
        let mut canvas = Canvas {
            data: &mut image.data,
            area,
        };
        plan_pieces(shape, &mut canvas)
    } else {
        let area = remove_window(shape);
        let mut data = reduce(image, area, shape.scale);
        let mut canvas = Canvas {
            data: &mut data,
            area,
        };
        plan_pieces(shape, &mut canvas)
    }
}

fn plan_pieces(shape: &Shape, canvas: &mut Canvas<'_>) -> Kind {
    let mut pieces = Vec::new();
    let mut saved: Vec<((usize, usize), [f32; 3])> = Vec::new();
    let bounds = canvas.area;
    let radius = shape.radius / shape.scale as f64;
    for (order, tile) in shape.tiles() {
        let hole = tile_hole(shape, tile, bounds);
        if hole.cells.is_empty() {
            continue;
        }
        let committed = Area::new(
            hole.cells.iter().map(|c| c.0).min().unwrap_or(0),
            hole.cells.iter().map(|c| c.1).min().unwrap_or(0),
            hole.cells.iter().map(|c| c.0).max().unwrap_or(0) + 1,
            hole.cells.iter().map(|c| c.1).max().unwrap_or(0) + 1,
        );
        let (cw, ch) = shape.cells_size();
        let region = committed.grown(shape.margin, cw, ch).intersect(&bounds);
        let (rmask, _) = shape.mask(region, shape.scale);
        let (rw, rh) = (region.width(), region.height());
        // The hole still unknown: this tile's and the later tiles'.
        let mut unknown = vec![0u8; rw * rh];
        let mut mine = vec![0u8; rw * rh];
        for y in region.y0..region.y1 {
            for x in region.x0..region.x1 {
                let k = (y - region.y0) * rw + (x - region.x0);
                if rmask[k] != 0 {
                    if tile.contains(x, y) {
                        unknown[k] = 1;
                        mine[k] = 1;
                    } else if shape.tile_order(x, y).is_some_and(|o| o > order) {
                        unknown[k] = 1;
                    }
                }
            }
        }
        let mut lin = vec![0.0f32; rw * rh * 3];
        for y in region.y0..region.y1 {
            for x in region.x0..region.x1 {
                let v = canvas.get(x, y);
                let k = ((y - region.y0) * rw + (x - region.x0)) * 3;
                lin[k..k + 3].copy_from_slice(&v);
            }
        }
        let fills = match complete(&lin, unknown, rw, rh, radius) {
            Some(done) => {
                let near = dilate(&mine, rw, rh, PR);
                let matches: Vec<Match> = done
                    .centers
                    .iter()
                    .zip(&done.nnf)
                    .zip(&done.weights)
                    .filter(|((&c, _), _)| near[c as usize] != 0)
                    .map(|((_, &(ox, oy)), &weight)| Match { ox, oy, weight })
                    .collect();
                let planned = hole
                    .cells
                    .iter()
                    .map(|&(x, y)| {
                        let k = (y - region.y0) * rw + (x - region.x0);
                        done.fill[done.index[k] as usize]
                    })
                    .collect::<Vec<_>>();
                pieces.push(Piece {
                    order,
                    fill: PieceFill::Matches(matches),
                });
                planned
            }
            None => {
                pieces.push(Piece {
                    order,
                    fill: PieceFill::Smooth,
                });
                smooth_tile(shape, &hole, tile, order, canvas).unwrap_or_default()
            }
        };
        for (&(x, y), v) in hole.cells.iter().zip(&fills) {
            saved.push(((x, y), canvas.get(x, y)));
            canvas.set(x, y, *v);
        }
    }
    for &((x, y), v) in saved.iter().rev() {
        canvas.set(x, y, v);
    }
    if pieces.is_empty() {
        Kind::Identity
    } else {
        Kind::Fill(pieces)
    }
}

// MARK: - "写す"

/// The copied fill of every hole cell (`(dx, dy)` cells away on the
/// canvas, held inside it) and the color differences at the edge.
fn copy_cells(shape: &Shape, canvas: &Canvas<'_>, dx: i64, dy: i64) -> Filled {
    let mut filled = Filled::default();
    let bounds = canvas.area;
    for (_, tile) in shape.tiles() {
        let hole = tile_hole(shape, tile, bounds);
        for &(x, y) in &hole.cells {
            let raw = canvas.get_clamped(x, y, dx, dy);
            push_cell(shape, &mut filled, &hole, x, y, raw, canvas.get(x, y));
        }
        for (x, y) in hole.ring(&bounds) {
            let photo = canvas.get(x, y);
            let copy = canvas.get_clamped(x, y, dx, dy);
            filled.edges.push((
                (x as u32, y as u32),
                [
                    encode(photo[0]) - encode(copy[0]),
                    encode(photo[1]) - encode(copy[1]),
                    encode(photo[2]) - encode(copy[2]),
                ],
            ));
        }
    }
    filled
}

/// "写す" without a source: the offset (pixels) whose surroundings match
/// the hole's surroundings best, looked for within [`Shape::auto_reach`]
/// on a reduced grid and refined at full size. The copied area never
/// overlaps the hole. `None` when no place fits.
fn find_source(shape: &Shape, image: &LinearImage) -> Option<(i64, i64)> {
    let (width, height) = (image.width, image.height);
    let (reach, ring) = shape.auto_reach();
    let (window, q) = shape.auto_search();
    let grid = Area::new(
        window.x0 / q,
        window.y0 / q,
        window.x1.div_ceil(q),
        window.y1.div_ceil(q),
    );
    let (gw, gh) = (grid.width(), grid.height());
    let enc: Vec<f32> = reduce(image, grid, q).into_iter().map(encode).collect();
    let (hole, _) = shape.mask(grid, q);
    let rr = ring.div_ceil(q).max(2);
    let near = dilate(&hole, gw, gh, rr);
    let holes: Vec<usize> = (0..hole.len()).filter(|&k| hole[k] != 0).collect();
    let rings: Vec<usize> = (0..hole.len())
        .filter(|&k| near[k] != 0 && hole[k] == 0)
        .collect();
    if holes.is_empty() || rings.is_empty() {
        return None;
    }
    let (mut bx0, mut by0, mut bx1, mut by1) = (gw, gh, 0usize, 0usize);
    for k in (0..near.len()).filter(|&k| near[k] != 0) {
        let (x, y) = (k % gw, k / gw);
        bx0 = bx0.min(x);
        by0 = by0.min(y);
        bx1 = bx1.max(x + 1);
        by1 = by1.max(y + 1);
    }
    let rq = reach.div_ceil(q) as i64;
    let penalty = 1e-4 * rings.len() as f32 * 3.0;
    let mut best: Option<((i64, i64), f32)> = None;
    for oy in -rq..=rq {
        for ox in -rq..=rq {
            if (ox, oy) == (0, 0)
                || (bx0 as i64 + ox) < 0
                || (by0 as i64 + oy) < 0
                || (bx1 as i64 + ox) > gw as i64
                || (by1 as i64 + oy) > gh as i64
            {
                continue;
            }
            let shift = oy * gw as i64 + ox;
            if holes
                .iter()
                .any(|&k| near[(k as i64 + shift) as usize] != 0)
            {
                continue;
            }
            let bound = best.map_or(f32::INFINITY, |b| b.1);
            let mut score = penalty * ((ox * ox + oy * oy) as f32 / (rq * rq) as f32);
            for &k in &rings {
                let s = (k as i64 + shift) as usize;
                for c in 0..3 {
                    let d = enc[k * 3 + c] - enc[s * 3 + c];
                    score += d * d;
                }
                if score >= bound {
                    break;
                }
            }
            if score < bound {
                best = Some(((ox, oy), score));
            }
        }
    }
    let ((ox, oy), _) = best?;
    let (ox, oy) = (ox * q as i64, oy * q as i64);
    if q == 1 || shape.scale != 1 {
        return Some((ox, oy));
    }
    // Refine within a cell, comparing the pixels next to the hole.
    let all = Area::new(0, 0, width, height);
    let mut edge: Vec<(usize, [f32; 3])> = Vec::new();
    for (_, tile) in shape.tiles() {
        let th = tile_hole(shape, tile, all);
        for (x, y) in th.ring(&all) {
            let i = y * width + x;
            let v = &image.data[i * 3..i * 3 + 3];
            edge.push((i, [encode(v[0]), encode(v[1]), encode(v[2])]));
        }
    }
    let w = shape.write.grown(RING_DEPTH, width, height);
    let qi = q as i64;
    let mut refined: Option<((i64, i64), f32)> = None;
    for dy in -qi..=qi {
        for dx in -qi..=qi {
            let (cx, cy) = (ox + dx, oy + dy);
            if (w.x0 as i64 + cx) < 0
                || (w.y0 as i64 + cy) < 0
                || (w.x1 as i64 + cx) > width as i64
                || (w.y1 as i64 + cy) > height as i64
            {
                continue;
            }
            let shift = cy * width as i64 + cx;
            let bound = refined.map_or(f32::INFINITY, |b| b.1);
            let mut score = 0.0f32;
            for &(i, v) in &edge {
                let s = (i as i64 + shift) as usize * 3;
                for (c, &vc) in v.iter().enumerate() {
                    let d = vc - encode(image.data[s + c]);
                    score += d * d;
                }
                if score >= bound {
                    break;
                }
            }
            if score < bound {
                refined = Some(((cx, cy), score));
            }
        }
    }
    Some(refined.map_or((ox, oy), |r| r.0))
}

// MARK: - Colors and blending

/// The fill with the edge's color difference spread over the hole
/// (encoded units, smoothed on a grid of about a radius and pulled in
/// from the edge), as linear colors per filled cell.
fn finish(shape: &Shape, filled: &Filled) -> Vec<[f32; 3]> {
    let n = filled.cells.len();
    if n == 0 {
        return Vec::new();
    }
    let all = || filled.cells.iter().chain(filled.edges.iter().map(|e| &e.0));
    let x0 = all().map(|c| c.0).min().unwrap_or(0) as usize;
    let y0 = all().map(|c| c.1).min().unwrap_or(0) as usize;
    let x1 = all().map(|c| c.0).max().unwrap_or(0) as usize + 1;
    let y1 = all().map(|c| c.1).max().unwrap_or(0) as usize + 1;
    let radius = shape.radius / shape.scale as f64;
    let mut c = (libm::round(2.0 * radius) as usize).max(2);
    while (x1 - x0).div_ceil(c) * (y1 - y0).div_ceil(c) > DELTA_CELLS {
        c *= 2;
    }
    let (gw, gh) = ((x1 - x0).div_ceil(c), (y1 - y0).div_ceil(c));
    let mut sums = vec![0.0f64; gw * gh * 3];
    let mut counts = vec![0u32; gw * gh];
    for &((x, y), d) in &filled.edges {
        let k = ((y as usize - y0) / c) * gw + (x as usize - x0) / c;
        sums[k * 3] += f64::from(d[0]);
        sums[k * 3 + 1] += f64::from(d[1]);
        sums[k * 3 + 2] += f64::from(d[2]);
        counts[k] += 1;
    }
    let mut values = vec![0.0f32; gw * gh * 3];
    let mut weights = vec![0.0f32; gw * gh];
    for k in 0..gw * gh {
        if counts[k] > 0 {
            for ch in 0..3 {
                let v = (sums[k * 3 + ch] / f64::from(counts[k])) as f32;
                values[k * 3 + ch] = v.clamp(-MAX_DELTA, MAX_DELTA);
            }
            weights[k] = 1.0;
        }
    }
    push_pull(&mut values, &mut weights, gw, gh);
    let cf = c as f32;
    (0..n)
        .map(|i| {
            let (x, y) = filled.cells[i];
            let gx = (x as usize - x0) as f32 / cf + 0.5 / cf - 0.5;
            let gy = (y as usize - y0) as f32 / cf + 0.5 / cf - 0.5;
            let d = bilinear(&values, gw, gh, gx, gy);
            let raw = filled.raw[i];
            [
                decode(encode(raw[0]) + d[0]),
                decode(encode(raw[1]) + d[1]),
                decode(encode(raw[2]) + d[2]),
            ]
        })
        .collect()
}

/// Bilinear sample of a 3-channel grid (edges held).
fn bilinear(values: &[f32], w: usize, h: usize, x: f32, y: f32) -> [f32; 3] {
    let (fx, fy) = (libm::floorf(x), libm::floorf(y));
    let (tx, ty) = ((x - fx).clamp(0.0, 1.0), (y - fy).clamp(0.0, 1.0));
    let ia = (fx as i64).clamp(0, w as i64 - 1) as usize;
    let ib = (fx as i64 + 1).clamp(0, w as i64 - 1) as usize;
    let ja = (fy as i64).clamp(0, h as i64 - 1) as usize;
    let jb = (fy as i64 + 1).clamp(0, h as i64 - 1) as usize;
    let mut out = [0.0f32; 3];
    for (ch, o) in out.iter_mut().enumerate() {
        let v = |i: usize, j: usize| values[(j * w + i) * 3 + ch];
        let top = v(ia, ja) * (1.0 - tx) + v(ib, ja) * tx;
        let bottom = v(ia, jb) * (1.0 - tx) + v(ib, jb) * tx;
        *o = top * (1.0 - ty) + bottom * ty;
    }
    out
}

/// Fills the cells without weight from the weighted ones (push-pull: a
/// pyramid of weighted means, then each coarser value blended into the
/// finer cells by what they lack).
fn push_pull(values: &mut [f32], weights: &mut [f32], w: usize, h: usize) {
    if w <= 1 && h <= 1 {
        return;
    }
    let (cw, ch) = (w.div_ceil(2), h.div_ceil(2));
    let mut cv = vec![0.0f32; cw * ch * 3];
    let mut cwt = vec![0.0f32; cw * ch];
    for y in 0..ch {
        for x in 0..cw {
            let mut sum = [0.0f32; 3];
            let mut ws = 0.0f32;
            for (fx, fy) in [
                (2 * x, 2 * y),
                (2 * x + 1, 2 * y),
                (2 * x, 2 * y + 1),
                (2 * x + 1, 2 * y + 1),
            ] {
                if fx >= w || fy >= h {
                    continue;
                }
                let k = fy * w + fx;
                let a = weights[k];
                if a > 0.0 {
                    ws += a;
                    sum[0] += a * values[k * 3];
                    sum[1] += a * values[k * 3 + 1];
                    sum[2] += a * values[k * 3 + 2];
                }
            }
            let k = y * cw + x;
            if ws > 0.0 {
                cv[k * 3] = sum[0] / ws;
                cv[k * 3 + 1] = sum[1] / ws;
                cv[k * 3 + 2] = sum[2] / ws;
                cwt[k] = ws.min(1.0);
            }
        }
    }
    push_pull(&mut cv, &mut cwt, cw, ch);
    for y in 0..h {
        for x in 0..w {
            let k = y * w + x;
            let a = weights[k];
            if a >= 1.0 {
                continue;
            }
            let u = bilinear(&cv, cw, ch, x as f32 * 0.5 - 0.25, y as f32 * 0.5 - 0.25);
            for c in 0..3 {
                values[k * 3 + c] = a * values[k * 3 + c] + (1.0 - a) * u[c];
            }
            weights[k] = 1.0;
        }
    }
}

/// Blends the colors over the photo with the brush's edge (scale 1).
fn composite_fine(shape: &Shape, filled: &Filled, colors: &[[f32; 3]], canvas: &mut Canvas<'_>) {
    debug_assert_eq!(shape.scale, 1);
    for (i, &(x, y)) in filled.cells.iter().enumerate() {
        let a = filled.alpha[i];
        let (fill, orig) = (colors[i], filled.orig[i]);
        let b = 1.0 - a;
        canvas.set(
            x as usize,
            y as usize,
            [
                a * fill[0] + b * orig[0],
                a * fill[1] + b * orig[1],
                a * fill[2] + b * orig[2],
            ],
        );
    }
}

/// Blends a reduced canvas (filled) over the full-size photo: each pixel
/// the brush reaches takes the canvas interpolated at it.
fn composite_coarse(shape: &Shape, canvas: &Canvas<'_>, image: &mut LinearImage) {
    let p = shape.scale;
    let pf = p as f32;
    let a = canvas.area;
    let (w, h) = (a.width(), a.height());
    for (_, tile) in shape.tiles() {
        let px =
            Area::new(tile.x0 * p, tile.y0 * p, tile.x1 * p, tile.y1 * p).intersect(&shape.write);
        if px.is_empty() {
            continue;
        }
        let field = shape.field(px, 1);
        for y in px.y0..px.y1 {
            for x in px.x0..px.x1 {
                let alpha = shape.alpha(field.at(x, y));
                if alpha <= 0.0 {
                    continue;
                }
                let gx = (x as f32 + 0.5) / pf - 0.5 - a.x0 as f32;
                let gy = (y as f32 + 0.5) / pf - 0.5 - a.y0 as f32;
                let v = bilinear(canvas.data, w, h, gx, gy);
                let i = (y * image.width + x) * 3;
                let b = 1.0 - alpha;
                for (c, &vc) in v.iter().enumerate() {
                    image.data[i + c] = alpha * vc + b * image.data[i + c];
                }
            }
        }
    }
}
