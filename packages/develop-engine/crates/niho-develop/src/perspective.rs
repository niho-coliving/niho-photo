//! The perspective of `developSettings.geometry` (niho-photo#46): Lightroom's
//! Transform sliders (`crs:Perspective*`, [`Perspective`]) as a projective
//! warp of the frame onto a canvas of the frame's size. The crop (and its
//! angle) lies on that canvas ([`crate::frame`]).
//!
//! Lightroom does not publish how its sliders map to the warp and no
//! measurement of it is used here: this is NIHO's own model of a virtual
//! camera (`docs/geometry-perspective.md`), not calibrated against
//! Lightroom.
//!
//! Coordinates: frame pixels (pixel `n`'s center at `n + 0.5`), centered and
//! divided by the frame's long side `L` (`u = (x - W/2) / L`, `v = (y -
//! H/2) / L`, y down). The frame -> canvas map is
//! `F = T . S . A . K . R` applied right to left:
//!
//! - `R`: `rotate` degrees, turning the photo counter-clockwise on screen
//!   (`u' = u cos + v sin`, `v' = -u sin + v cos`; the sign of a positive
//!   straighten `angle`).
//! - `K`: the keystone of a tilt of the photo plane in front of a camera of
//!   focal length [`FOCAL_LENGTH`] (over `L`): `q' = q / (1 + p . q)` with
//!   `p = -(horizontal, vertical) / 100 * tan(MAX_TILT_DEGREES) /
//!   FOCAL_LENGTH`. The slider is linear in the tangent of the tilt; +-100
//!   is +-[`MAX_TILT_DEGREES`]. The center stays and its scale is 1 (the
//!   foreshortening is not restored; `aspect` is there for that).
//!   Negative `vertical` widens the top, positive `horizontal` the right.
//! - `A`: `aspect`, across times `ASPECT_STRETCH^(aspect / 100)` and down
//!   divided by it.
//! - `S`: `scale / 100` about the center.
//! - `T`: `x / 100` of half the frame's width right, `y / 100` of half its
//!   height down.
//!
//! The renderer samples each output pixel's center through the inverse
//! `F^-1` (exact inverses of each step, composed in a fixed order in `f64`,
//! `libm` for the trigonometry, so native and wasm agree bit for bit).

use crate::geometry::{CropCorners, Perspective};

/// Focal length of the virtual camera over the frame's long side: a 50 mm
/// lens on a 36 mm long side.
pub const FOCAL_LENGTH: f64 = 50.0 / 36.0;
/// The tilt of the photo plane at `vertical` / `horizontal` +-100, degrees.
pub const MAX_TILT_DEGREES: f64 = 40.0;
/// `aspect` +-100 stretches across (down) by this factor and shrinks down
/// (across) by it.
pub const ASPECT_STRETCH: f64 = 1.25;
/// A homogeneous coordinate at or below this is at or past the vanishing
/// line (no point of the photo maps there).
const W_EPSILON: f64 = 1e-6;

type Mat3 = [[f64; 3]; 3];

fn mul(a: &Mat3, b: &Mat3) -> Mat3 {
    let mut r = [[0.0; 3]; 3];
    for (i, row) in r.iter_mut().enumerate() {
        for (j, cell) in row.iter_mut().enumerate() {
            *cell = a[i][0] * b[0][j] + a[i][1] * b[1][j] + a[i][2] * b[2][j];
        }
    }
    r
}

fn apply(m: &Mat3, p: [f64; 2]) -> [f64; 3] {
    [
        m[0][0] * p[0] + m[0][1] * p[1] + m[0][2],
        m[1][0] * p[0] + m[1][1] * p[1] + m[1][2],
        m[2][0] * p[0] + m[2][1] * p[1] + m[2][2],
    ]
}

fn det(m: &Mat3) -> f64 {
    m[0][0] * (m[1][1] * m[2][2] - m[1][2] * m[2][1])
        - m[0][1] * (m[1][0] * m[2][2] - m[1][2] * m[2][0])
        + m[0][2] * (m[1][0] * m[2][1] - m[1][1] * m[2][0])
}

fn dot(a: [f64; 2], b: [f64; 2]) -> f64 {
    a[0] * b[0] + a[1] * b[1]
}

/// The warp of one perspective on one frame size, in frame pixels.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct Warp {
    /// Frame -> canvas.
    forward: Mat3,
    /// Canvas -> frame.
    inverse: Mat3,
    width: f64,
    height: f64,
}

impl Warp {
    /// The warp of `p` on a `width x height` frame; `None` for the identity
    /// (which renders without one).
    pub fn new(p: &Perspective, width: usize, height: usize) -> Option<Self> {
        if p.is_identity() {
            return None;
        }
        let (w, h) = (width as f64, height as f64);
        let l = w.max(h);
        let normalize = [
            [1.0 / l, 0.0, -w / (2.0 * l)],
            [0.0, 1.0 / l, -h / (2.0 * l)],
            [0.0, 0.0, 1.0],
        ];
        let denormalize = [[l, 0.0, w / 2.0], [0.0, l, h / 2.0], [0.0, 0.0, 1.0]];
        let (sin, cos) = libm::sincos(p.rotate.to_radians());
        let turn = [[cos, sin, 0.0], [-sin, cos, 0.0], [0.0, 0.0, 1.0]];
        let unturn = [[cos, -sin, 0.0], [sin, cos, 0.0], [0.0, 0.0, 1.0]];
        let strength = libm::tan(MAX_TILT_DEGREES.to_radians()) / FOCAL_LENGTH;
        let ph = -p.horizontal / 100.0 * strength;
        let pv = -p.vertical / 100.0 * strength;
        let keystone = [[1.0, 0.0, 0.0], [0.0, 1.0, 0.0], [ph, pv, 1.0]];
        let unkeystone = [[1.0, 0.0, 0.0], [0.0, 1.0, 0.0], [-ph, -pv, 1.0]];
        // Aspect, scale and offset: one affine step and its inverse.
        let stretch = libm::pow(ASPECT_STRETCH, p.aspect / 100.0);
        let s = p.scale / 100.0;
        let (sx, sy) = (stretch * s, s / stretch);
        let (tx, ty) = (p.x / 100.0 * 0.5 * w / l, p.y / 100.0 * 0.5 * h / l);
        let place = [[sx, 0.0, tx], [0.0, sy, ty], [0.0, 0.0, 1.0]];
        let unplace = [
            [1.0 / sx, 0.0, -tx / sx],
            [0.0, 1.0 / sy, -ty / sy],
            [0.0, 0.0, 1.0],
        ];
        let forward = mul(
            &denormalize,
            &mul(&place, &mul(&keystone, &mul(&turn, &normalize))),
        );
        let inverse = mul(
            &denormalize,
            &mul(&unturn, &mul(&unkeystone, &mul(&unplace, &normalize))),
        );
        Some(Self {
            forward,
            inverse,
            width: w,
            height: h,
        })
    }

    /// The frame point (continuous frame pixels) canvas point `q` comes
    /// from; `None` at or past the vanishing line.
    pub fn to_frame(&self, q: [f64; 2]) -> Option<[f64; 2]> {
        let [x, y, w] = apply(&self.inverse, q);
        (w > W_EPSILON).then(|| [x / w, y / w])
    }

    /// The canvas point frame point `p` goes to; `None` past the vanishing
    /// line.
    pub fn to_canvas(&self, p: [f64; 2]) -> Option<[f64; 2]> {
        let [x, y, w] = apply(&self.forward, p);
        (w > W_EPSILON).then(|| [x / w, y / w])
    }

    /// [`Self::to_frame`] for sampling: a point at or past the vanishing
    /// line goes far out of the frame (an edge is sampled there).
    pub fn sample_point(&self, q: [f64; 2]) -> [f64; 2] {
        let [x, y, w] = apply(&self.inverse, q);
        let w = w.max(W_EPSILON);
        [x / w, y / w]
    }

    /// How many frame pixels one canvas pixel spans around canvas point
    /// `q` (the square root of the inverse's Jacobian determinant, 1 when
    /// it cannot be told).
    pub fn inverse_scale(&self, q: [f64; 2]) -> f64 {
        let w = apply(&self.inverse, q)[2];
        if w.is_nan() || w <= W_EPSILON {
            return 1.0;
        }
        let s = libm::sqrt((det(&self.inverse) / (w * w * w)).abs());
        if s.is_finite() && s > 0.0 {
            s
        } else {
            1.0
        }
    }

    /// The corrected photo's outline on the canvas: the frame's corners
    /// (top-left, top-right, bottom-right, bottom-left) through the warp.
    /// `None` when one is past the vanishing line (not with the settings'
    /// ranges).
    pub fn photo_outline(&self) -> Option<[[f64; 2]; 4]> {
        let (w, h) = (self.width, self.height);
        Some([
            self.to_canvas([0.0, 0.0])?,
            self.to_canvas([w, 0.0])?,
            self.to_canvas([w, h])?,
            self.to_canvas([0.0, h])?,
        ])
    }
}

/// A half-plane `n . x <= k`.
#[derive(Debug, Clone, Copy)]
struct HalfPlane {
    n: [f64; 2],
    k: f64,
}

/// The part of convex polygon `poly` with `n . x <= k` (Sutherland-Hodgman;
/// empty when none).
fn clip(poly: &[[f64; 2]], n: [f64; 2], k: f64) -> Vec<[f64; 2]> {
    let mut out = Vec::with_capacity(poly.len() + 1);
    for (i, &a) in poly.iter().enumerate() {
        let b = poly[(i + 1) % poly.len()];
        let da = dot(n, a) - k;
        let db = dot(n, b) - k;
        if da <= 0.0 {
            out.push(a);
        }
        if (da < 0.0 && db > 0.0) || (da > 0.0 && db < 0.0) {
            let t = da / (da - db);
            out.push([a[0] + t * (b[0] - a[0]), a[1] + t * (b[1] - a[1])]);
        }
    }
    out
}

/// Twice the signed area of a polygon (shoelace).
fn area2(poly: &[[f64; 2]]) -> f64 {
    (0..poly.len())
        .map(|i| {
            let (a, b) = (poly[i], poly[(i + 1) % poly.len()]);
            a[0] * b[1] - b[0] * a[1]
        })
        .sum()
}

/// The point of convex polygon `poly`'s boundary nearest to `p` (the first
/// one of equal distance).
fn nearest_on_boundary(poly: &[[f64; 2]], p: [f64; 2]) -> [f64; 2] {
    let mut best = poly[0];
    let mut best_d = f64::INFINITY;
    for (i, &a) in poly.iter().enumerate() {
        let b = poly[(i + 1) % poly.len()];
        let e = [b[0] - a[0], b[1] - a[1]];
        let len2 = dot(e, e);
        let t = if len2 > 0.0 {
            (dot([p[0] - a[0], p[1] - a[1]], e) / len2).clamp(0.0, 1.0)
        } else {
            0.0
        };
        let c = [a[0] + t * e[0], a[1] + t * e[1]];
        let d = (c[0] - p[0]) * (c[0] - p[0]) + (c[1] - p[1]) * (c[1] - p[1]);
        if d < best_d {
            best_d = d;
            best = c;
        }
    }
    best
}

/// The canvas's half-planes and the corrected photo's: what a constrained
/// crop must stay inside. `None` when the photo's outline cannot be made
/// or leaves no area on the canvas.
fn valid_region(warp: &Warp) -> Option<(Vec<HalfPlane>, Vec<[f64; 2]>)> {
    let (w, h) = (warp.width, warp.height);
    let outline = warp.photo_outline()?;
    let orientation = area2(&outline);
    if orientation.is_nan() || orientation == 0.0 {
        return None;
    }
    let mut planes = vec![
        HalfPlane {
            n: [-1.0, 0.0],
            k: 0.0,
        },
        HalfPlane {
            n: [1.0, 0.0],
            k: w,
        },
        HalfPlane {
            n: [0.0, -1.0],
            k: 0.0,
        },
        HalfPlane {
            n: [0.0, 1.0],
            k: h,
        },
    ];
    for i in 0..4 {
        let (a, b) = (outline[i], outline[(i + 1) % 4]);
        let e = [b[0] - a[0], b[1] - a[1]];
        let n = if orientation > 0.0 {
            [e[1], -e[0]]
        } else {
            [-e[1], e[0]]
        };
        planes.push(HalfPlane { n, k: dot(n, a) });
    }
    let mut region = vec![[0.0, 0.0], [w, 0.0], [w, h], [0.0, h]];
    for p in &planes[4..] {
        region = clip(&region, p.n, p.k);
        if region.is_empty() {
            return None;
        }
    }
    (area2(&region).abs() > 2e-9 * w * h).then_some((planes, region))
}

/// The corrected photo on the canvas where a constrained crop may lie (the
/// canvas and the warped frame's intersection, a convex polygon); `None`
/// when it has no area. The editor draws the same region.
pub fn valid_polygon(warp: &Warp) -> Option<Vec<[f64; 2]>> {
    valid_region(warp).map(|(_, region)| region)
}

/// "余白を埋める": the crop `c` (its corners on the canvas, already inside
/// it) kept inside the corrected photo, so no output pixel comes from
/// outside the frame. The crop keeps its angle and its aspect ratio: the
/// largest scale `s <= 1` of it that fits anywhere inside, then the center
/// nearest to its own (a crop already inside is returned as is). The scale
/// is found by bisection (60 halvings) and the centers that fit at it by
/// clipping, all in `f64`, so the result is the same on every target.
/// Without a region (none of the settings' ranges) or when nothing of the
/// crop would remain, `c` is returned unchanged.
pub fn constrain_corners(c: CropCorners, warp: &Warp) -> CropCorners {
    let Some((planes, region)) = valid_region(warp) else {
        return c;
    };
    let (w, h) = (warp.width, warp.height);
    let center = [
        c.top_left[0] + (c.across[0] + c.down[0]) / 2.0,
        c.top_left[1] + (c.across[1] + c.down[1]) / 2.0,
    ];
    // How far each half-plane must move in for the crop's center at scale 1.
    let reach: Vec<f64> = planes
        .iter()
        .map(|p| (dot(p.n, c.across).abs() + dot(p.n, c.down).abs()) / 2.0)
        .collect();
    let fits = |point: [f64; 2], s: f64| {
        planes
            .iter()
            .zip(&reach)
            .all(|(p, r)| dot(p.n, point) <= p.k - s * r)
    };
    if fits(center, 1.0) {
        return c;
    }
    // The centers where the crop at scale `s` fits (empty when none).
    let centers = |s: f64| {
        let mut poly = vec![[0.0, 0.0], [w, 0.0], [w, h], [0.0, h]];
        for (p, r) in planes.iter().zip(&reach) {
            poly = clip(&poly, p.n, p.k - s * r);
            if poly.is_empty() {
                break;
            }
        }
        poly
    };
    let whole = centers(1.0);
    let (s, at) = if whole.is_empty() {
        let (mut lo, mut hi) = (0.0f64, 1.0f64);
        let mut at = region;
        for _ in 0..60 {
            let mid = 0.5 * (lo + hi);
            let poly = centers(mid);
            if poly.is_empty() {
                hi = mid;
            } else {
                lo = mid;
                at = poly;
            }
        }
        (lo, at)
    } else {
        (1.0, whole)
    };
    if s <= 1e-6 {
        return c;
    }
    let moved = if fits(center, s) {
        center
    } else {
        nearest_on_boundary(&at, center)
    };
    CropCorners {
        top_left: [
            moved[0] - s * (c.across[0] + c.down[0]) / 2.0,
            moved[1] - s * (c.across[1] + c.down[1]) / 2.0,
        ],
        across: [c.across[0] * s, c.across[1] * s],
        down: [c.down[0] * s, c.down[1] * s],
        width: c.width * s,
        height: c.height * s,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::geometry::CropRect;

    fn perspective(json: &str) -> Perspective {
        let g = crate::geometry::Geometry::from_value(
            &serde_json::from_str(&format!(r#"{{"perspective":{json}}}"#)).unwrap(),
        )
        .unwrap();
        g.perspective
    }

    fn warp(json: &str, w: usize, h: usize) -> Warp {
        Warp::new(&perspective(json), w, h).unwrap()
    }

    fn close(a: [f64; 2], b: [f64; 2], tolerance: f64) -> bool {
        (a[0] - b[0]).abs() <= tolerance && (a[1] - b[1]).abs() <= tolerance
    }

    #[test]
    fn the_identity_has_no_warp() {
        assert!(Warp::new(&Perspective::default(), 300, 200).is_none());
    }

    #[test]
    fn the_inverse_undoes_the_forward_map() {
        for json in [
            r#"{"vertical":-60}"#,
            r#"{"horizontal":45,"rotate":-3.5}"#,
            r#"{"vertical":100,"horizontal":-100,"rotate":10,"aspect":-100,"scale":50,"x":100,"y":-100}"#,
            r#"{"aspect":80,"scale":150,"x":-30,"y":20}"#,
        ] {
            for (w, h) in [(3000usize, 2000usize), (1707, 2560), (640, 640)] {
                let warp = warp(json, w, h);
                for p in [
                    [0.0, 0.0],
                    [w as f64, 0.0],
                    [w as f64 * 0.3, h as f64 * 0.8],
                    [w as f64, h as f64],
                ] {
                    let q = warp.to_canvas(p).unwrap();
                    let back = warp.to_frame(q).unwrap();
                    assert!(
                        close(back, p, 1e-6 * w.max(h) as f64),
                        "{json}: {p:?} {back:?}"
                    );
                }
            }
        }
    }

    #[test]
    fn vertical_converges_and_keeps_the_center() {
        let (w, h) = (2000usize, 3000usize);
        let center = [1000.0, 1500.0];
        // Negative: the top widens, the bottom narrows; the center stays.
        let warp = warp(r#"{"vertical":-50}"#, w, h);
        assert!(close(warp.to_canvas(center).unwrap(), center, 1e-9));
        let tl = warp.to_canvas([0.0, 0.0]).unwrap();
        let tr = warp.to_canvas([2000.0, 0.0]).unwrap();
        let bl = warp.to_canvas([0.0, 3000.0]).unwrap();
        let br = warp.to_canvas([2000.0, 3000.0]).unwrap();
        assert!(tr[0] - tl[0] > 2000.0 && br[0] - bl[0] < 2000.0);
        // Horizontal lines stay horizontal and the vertical center line stays.
        assert!((tl[1] - tr[1]).abs() < 1e-9 && (bl[1] - br[1]).abs() < 1e-9);
        assert!((warp.to_canvas([1000.0, 0.0]).unwrap()[0] - 1000.0).abs() < 1e-9);
        // The analytic keystone: q' = q / (1 + p v), p = 0.5 tan 40 / f.
        let p = 0.5 * libm::tan(40f64.to_radians()) / FOCAL_LENGTH;
        let v = -0.5; // the top edge over L = 3000
        let expected_half_width = (1000.0 / 3000.0) / (1.0 + p * v) * 3000.0;
        assert!((((tr[0] - tl[0]) / 2.0) - expected_half_width).abs() < 1e-6);
        // Positive does the opposite.
        let up = Warp::new(&perspective(r#"{"vertical":50}"#), w, h).unwrap();
        let tl = up.to_canvas([0.0, 0.0]).unwrap();
        let tr = up.to_canvas([2000.0, 0.0]).unwrap();
        assert!(tr[0] - tl[0] < 2000.0);
    }

    #[test]
    fn horizontal_widens_the_right_side() {
        let warp = warp(r#"{"horizontal":40}"#, 3000, 2000);
        let tr = warp.to_canvas([3000.0, 0.0]).unwrap();
        let br = warp.to_canvas([3000.0, 2000.0]).unwrap();
        let tl = warp.to_canvas([0.0, 0.0]).unwrap();
        let bl = warp.to_canvas([0.0, 2000.0]).unwrap();
        assert!(br[1] - tr[1] > 2000.0 && bl[1] - tl[1] < 2000.0);
        assert!((tr[0] - br[0]).abs() < 1e-9);
    }

    #[test]
    fn rotate_turns_like_the_straighten_angle() {
        // Positive: the photo turns counter-clockwise on screen, so a point
        // right of the center moves up (y down).
        let warp = warp(r#"{"rotate":5}"#, 1000, 1000);
        let q = warp.to_canvas([900.0, 500.0]).unwrap();
        assert!(q[1] < 500.0 && q[0] < 900.0);
        let a = 5f64.to_radians();
        assert!(close(
            q,
            [500.0 + 400.0 * a.cos(), 500.0 - 400.0 * a.sin()],
            1e-9
        ));
        // A positive straighten angle turns the crop clockwise on the frame:
        // the output's right is the frame's down-right, which is the same
        // turn of the photo in the result.
        let corners = CropRect::default().corners(1000.0, 1000.0, 5.0);
        assert!(corners.across[1] > 0.0);
        let back = warp.to_frame([900.0, 500.0]).unwrap();
        assert!(back[1] > 500.0);
    }

    #[test]
    fn aspect_scale_and_offsets_move_the_photo() {
        let (w, h) = (3000usize, 2000usize);
        let at = |json: &str, p: [f64; 2]| warp(json, w, h).to_canvas(p).unwrap();
        // Aspect +100: across x1.25, down /1.25 about the center.
        let q = at(r#"{"aspect":100}"#, [2500.0, 1500.0]);
        assert!(close(
            q,
            [1500.0 + 1000.0 * 1.25, 1000.0 + 500.0 / 1.25],
            1e-6
        ));
        let q = at(r#"{"aspect":-100}"#, [2500.0, 1500.0]);
        assert!(close(
            q,
            [1500.0 + 1000.0 / 1.25, 1000.0 + 500.0 * 1.25],
            1e-6
        ));
        // Scale 50%: half the distance from the center.
        let q = at(r#"{"scale":50}"#, [2500.0, 1500.0]);
        assert!(close(q, [2000.0, 1250.0], 1e-6));
        // X 100: half the width right; Y -100: half the height up.
        assert!(close(at(r#"{"x":100}"#, [0.0, 0.0]), [1500.0, 0.0], 1e-6));
        assert!(close(
            at(r#"{"y":-100}"#, [0.0, 2000.0]),
            [0.0, 1000.0],
            1e-6
        ));
    }

    #[test]
    fn the_inverse_scale_follows_the_scale_slider() {
        let warp = warp(r#"{"scale":50}"#, 3000, 2000);
        assert!((warp.inverse_scale([1500.0, 1000.0]) - 2.0).abs() < 1e-9);
        let zoom = Warp::new(&perspective(r#"{"scale":125}"#), 3000, 2000).unwrap();
        assert!((zoom.inverse_scale([700.0, 300.0]) - 0.8).abs() < 1e-9);
    }

    /// Every corner of `c` inside the corrected photo and the canvas.
    fn inside_photo(c: &CropCorners, warp: &Warp, w: f64, h: f64) {
        for (a, b) in [(0.0, 0.0), (1.0, 0.0), (0.0, 1.0), (1.0, 1.0)] {
            let q = [
                c.top_left[0] + a * c.across[0] + b * c.down[0],
                c.top_left[1] + a * c.across[1] + b * c.down[1],
            ];
            let tolerance = 1e-6 * w.max(h);
            assert!(
                (-tolerance..=w + tolerance).contains(&q[0])
                    && (-tolerance..=h + tolerance).contains(&q[1]),
                "{q:?}"
            );
            let p = warp.to_frame(q).unwrap();
            assert!(
                (-tolerance..=w + tolerance).contains(&p[0])
                    && (-tolerance..=h + tolerance).contains(&p[1]),
                "{q:?} comes from {p:?}"
            );
        }
    }

    #[test]
    fn a_constrained_crop_stays_inside_the_photo() {
        for json in [
            r#"{"vertical":-40}"#,
            r#"{"vertical":100,"horizontal":-60,"rotate":-7}"#,
            r#"{"scale":60,"x":80,"y":-40}"#,
            r#"{"aspect":-100,"rotate":10}"#,
        ] {
            for (w, h) in [(3000usize, 2000usize), (2000, 3000)] {
                let warp = warp(json, w, h);
                for angle in [0.0, 6.0] {
                    let c = CropRect::default().corners(w as f64, h as f64, angle);
                    let c = if angle == 0.0 {
                        c
                    } else {
                        // The whole frame at an angle, brought inside the canvas.
                        let s = 0.7;
                        let center = [w as f64 / 2.0, h as f64 / 2.0];
                        CropCorners {
                            top_left: [
                                center[0] - s * (c.across[0] + c.down[0]) / 2.0,
                                center[1] - s * (c.across[1] + c.down[1]) / 2.0,
                            ],
                            across: [c.across[0] * s, c.across[1] * s],
                            down: [c.down[0] * s, c.down[1] * s],
                            width: c.width * s,
                            height: c.height * s,
                        }
                    };
                    let fitted = constrain_corners(c, &warp);
                    inside_photo(&fitted, &warp, w as f64, h as f64);
                    // The crop keeps its angle and aspect ratio and never grows.
                    assert!(fitted.width <= c.width && fitted.width > 0.0);
                    assert!(
                        (fitted.width / fitted.height - c.width / c.height).abs() < 1e-9,
                        "{json}"
                    );
                    assert!(
                        (fitted.across[1] * c.across[0] - fitted.across[0] * c.across[1]).abs()
                            < 1e-6 * c.width * c.width
                    );
                    // Deterministic.
                    assert_eq!(constrain_corners(c, &warp), fitted);
                }
            }
        }
    }

    #[test]
    fn an_offset_photo_keeps_a_large_crop_moved_inside() {
        // The photo moved a quarter of the width right: the largest crop of
        // the frame's ratio is 3/4 of it, moved right (not shrunk about the
        // middle to 1/2).
        let warp = warp(r#"{"x":50}"#, 4000, 2000);
        let fitted = constrain_corners(CropRect::default().corners(4000.0, 2000.0, 0.0), &warp);
        assert!((fitted.width - 3000.0).abs() < 1e-3, "{fitted:?}");
        assert!((fitted.top_left[0] - 1000.0).abs() < 1e-3, "{fitted:?}");
        assert!((fitted.top_left[1] - 250.0).abs() < 1e-3, "{fitted:?}");
    }

    #[test]
    fn a_crop_inside_the_photo_is_kept_as_is() {
        let warp = warp(r#"{"vertical":-20}"#, 3000, 2000);
        let c = CropRect {
            left: 0.4,
            top: 0.4,
            right: 0.6,
            bottom: 0.6,
        }
        .corners(3000.0, 2000.0, 0.0);
        assert_eq!(constrain_corners(c, &warp), c);
    }
}
