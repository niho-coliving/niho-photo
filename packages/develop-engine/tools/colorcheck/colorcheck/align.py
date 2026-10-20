"""Alignment of a candidate image onto the reference frame.

Both images are first brought to the same long edge (area average).  A uniform
scale (default 0.96..1.04) and a translation (default +-3 % of each side) are
estimated from the luminance with phase correlation on band-passed log
luminance (numpy FFT; tone differences between a rendered reference and an
unrendered candidate do not matter much in that domain).  A residual radial
distortion term (two lens-distortion corrections rarely agree) is then fitted
on a 7x7 tile grid.  The candidate is resampled into the reference frame and a
border (default 4 %) is cropped.
"""
from __future__ import annotations

from dataclasses import dataclass

import numpy as np

from . import imageops

SCALE_RANGE = (0.96, 1.04)
MAX_SHIFT = 0.03
CROP = 0.04


@dataclass
class Radial:
    """Residual radial distortion of the candidate after the similarity warp.

    r(p) = (k1 rho^2 + k2 rho^4) (p - c), rho = min(|p - c| / R, rho_max), R = half
    diagonal of the reference frame; beyond the sampled radius rho_max the factor
    is held (linear growth only).  This absorbs the difference between two
    lens-distortion corrections (e.g. Apple's own vs. the camera-embedded one
    Lightroom applies), which a uniform scale cannot.
    """
    k: tuple[float, float]
    norm_radius: float
    rho_max: float
    residual_px_before: float
    residual_px_after: float
    tiles: int

    def to_json(self) -> dict:
        return {"k": [round(float(v), 6) for v in self.k], "normRadius": round(float(self.norm_radius), 2),
                "rhoMax": round(float(self.rho_max), 3),
                "residualPxBefore": round(float(self.residual_px_before), 3),
                "residualPxAfter": round(float(self.residual_px_after), 3), "tiles": int(self.tiles)}


@dataclass
class Alignment:
    scale: float = 1.0
    dx: float = 0.0  # analysis px in the reference frame (+ = candidate moved right)
    dy: float = 0.0  # analysis px (+ = candidate moved down)
    corr: float | None = None  # NCC of band-passed log luminance after alignment
    peak: float | None = None  # phase-correlation peak (0..1)
    method: str = "identity"
    radial: Radial | None = None

    def to_json(self) -> dict:
        return {
            "scale": round(float(self.scale), 6),
            "dx": round(float(self.dx), 3),
            "dy": round(float(self.dy), 3),
            "corr": None if self.corr is None else round(float(self.corr), 4),
            "peak": None if self.peak is None else round(float(self.peak), 4),
            "method": self.method,
            "radial": None if self.radial is None else self.radial.to_json(),
            "units": "analysis-px",
        }


def _bandpass_log(y: np.ndarray) -> np.ndarray:
    long_edge = max(y.shape)
    l = np.log(np.maximum(y.astype(np.float64), 0.0) + 1e-3)
    fine = imageops.gaussian_blur(l, 1.0)
    coarse = imageops.gaussian_blur(l, max(2.0, long_edge / 60.0))
    b = fine - coarse
    b -= b.mean()
    sd = b.std()
    return b / sd if sd > 0 else b


def _window(h: int, w: int) -> np.ndarray:
    return np.outer(np.hanning(h), np.hanning(w))


def phase_correlate(a: np.ndarray, b: np.ndarray, max_dx: float, max_dy: float,
                    win: np.ndarray | None = None) -> tuple[float, float, float]:
    """Shift t with a(x) ~ b(x - t), searched within |t| <= max; returns (tx, ty, peak)."""
    h, w = a.shape
    if win is None:
        win = _window(h, w)
    fa = np.fft.rfft2(a * win)
    fb = np.fft.rfft2(b * win)
    r = fa * np.conj(fb)
    r /= np.abs(r) + 1e-12
    surf = np.fft.fftshift(np.fft.irfft2(r, s=(h, w)))
    cy, cx = h // 2, w // 2
    my = int(min(max(1, np.ceil(max_dy)), cy - 1))
    mx = int(min(max(1, np.ceil(max_dx)), cx - 1))
    sub = surf[cy - my:cy + my + 1, cx - mx:cx + mx + 1]
    iy, ix = np.unravel_index(int(np.argmax(sub)), sub.shape)
    py, px = iy + cy - my, ix + cx - mx
    peak = float(surf[py, px])

    def _parab(vm, v0, vp):
        den = vm - 2 * v0 + vp
        return 0.0 if den >= 0 else float(np.clip(0.5 * (vm - vp) / den, -0.5, 0.5))

    ox = _parab(surf[py, px - 1], surf[py, px], surf[py, px + 1]) if 0 < px < w - 1 else 0.0
    oy = _parab(surf[py - 1, px], surf[py, px], surf[py + 1, px]) if 0 < py < h - 1 else 0.0
    return px - cx + ox, py - cy + oy, peak


def _scaled_frame(cand: np.ndarray, scale: float, out_hw) -> np.ndarray:
    warped, _ = imageops.warp_scale_shift(cand, scale, 0.0, 0.0, out_hw)
    return warped


def _search(ref_b: np.ndarray, cand_y: np.ndarray, scales, max_shift: float):
    h, w = ref_b.shape
    win = _window(h, w)
    best = None
    rows = []
    for s in scales:
        cb = _bandpass_log(_scaled_frame(cand_y, s, (h, w)))
        tx, ty, pk = phase_correlate(ref_b, cb, max_shift * w, max_shift * h, win)
        rows.append((s, tx, ty, pk))
        if best is None or pk > best[3]:
            best = (s, tx, ty, pk)
    return best, rows


def _refine_scale(rows) -> float:
    rows = sorted(rows)
    k = int(np.argmax([r[3] for r in rows]))
    if 0 < k < len(rows) - 1:
        (s0, _, _, p0), (s1, _, _, p1), (s2, _, _, p2) = rows[k - 1], rows[k], rows[k + 1]
        den = p0 - 2 * p1 + p2
        if den < 0:
            off = 0.5 * (p0 - p2) / den
            return float(s1 + np.clip(off, -1, 1) * (s2 - s1))
    return float(rows[k][0])


def ncc(a: np.ndarray, b: np.ndarray, mask: np.ndarray | None = None) -> float:
    if mask is not None:
        a, b = a[mask], b[mask]
    a = a - a.mean()
    b = b - b.mean()
    den = np.sqrt((a * a).sum() * (b * b).sum())
    return float((a * b).sum() / den) if den > 0 else 0.0


def _tile_shifts(ref_b: np.ndarray, cand_b: np.ndarray, grid: int = 5, tile: float = 0.3,
                 max_frac: float = 0.15, span: tuple[float, float] = (0.18, 0.82)):
    """Local shifts r (ref(x) ~ cand(x - r)) at tile centres; returns (centres, shifts, peaks)."""
    h, w = ref_b.shape
    th, tw = max(16, int(h * tile)), max(16, int(w * tile))
    win = _window(th, tw)
    cs, rs, ps = [], [], []
    for fy in np.linspace(span[0], span[1], grid):
        for fx in np.linspace(span[0], span[1], grid):
            y0 = int(round(fy * h - th / 2))
            x0 = int(round(fx * w - tw / 2))
            y0 = min(max(y0, 0), h - th)
            x0 = min(max(x0, 0), w - tw)
            a = ref_b[y0:y0 + th, x0:x0 + tw]
            b = cand_b[y0:y0 + th, x0:x0 + tw]
            if a.std() < 1e-6 or b.std() < 1e-6:
                continue
            tx, ty, pk = phase_correlate(a, b, max_frac * tw, max_frac * th, win)
            cs.append((x0 + (tw - 1) / 2.0, y0 + (th - 1) / 2.0))
            rs.append((tx, ty))
            ps.append(pk)
    return np.array(cs).reshape(-1, 2), np.array(rs).reshape(-1, 2), np.array(ps)


def _fit_similarity(centres, shifts, weights, c):
    """Least squares for r = a (p - c) + t (shared a); returns (a, tx, ty, residuals)."""
    n = len(centres)
    A_ = np.zeros((2 * n, 3))
    y = np.zeros(2 * n)
    A_[0::2, 0] = centres[:, 0] - c[0]
    A_[0::2, 1] = 1.0
    A_[1::2, 0] = centres[:, 1] - c[1]
    A_[1::2, 2] = 1.0
    y[0::2] = shifts[:, 0]
    y[1::2] = shifts[:, 1]
    sw = np.sqrt(np.repeat(weights, 2))
    sol, *_ = np.linalg.lstsq(A_ * sw[:, None], y * sw, rcond=None)
    res = (A_ @ sol - y).reshape(-1, 2)
    return sol[0], sol[1], sol[2], np.hypot(res[:, 0], res[:, 1])


def _grid_search(ref_y, cand_y, scale_range, max_shift) -> Alignment:
    """Fallback: scale grid x phase correlation (weaker; used when tiles lack texture)."""
    h, w = ref_y.shape
    lo, hi = scale_range
    f2 = min(1.0, 800.0 / max(h, w))
    r2 = imageops.resize(ref_y, (max(8, round(w * f2)), max(8, round(h * f2))))
    c2 = imageops.resize(cand_y, (max(8, round(cand_y.shape[1] * f2)), max(8, round(cand_y.shape[0] * f2))))
    best, rows = _search(_bandpass_log(r2), c2, np.arange(lo, hi + 1e-9, 0.002), max_shift)
    s = float(np.clip(_refine_scale(rows), lo, hi))
    ref_b = _bandpass_log(ref_y)
    cand_b = _bandpass_log(_scaled_frame(cand_y, s, (h, w)))
    tx, ty, pk = phase_correlate(ref_b, cand_b, max_shift * w, max_shift * h)
    return Alignment(scale=s, dx=tx, dy=ty, peak=pk, method="phase-correlation-grid")


MIN_TILES = 5
TILE_PEAK = 0.04
RADIAL_MIN_TILES = 12
RADIAL_MIN_GAIN = 0.25   # accept the radial term only if it removes >= 25 % of the residual
RADIAL_MAX_DISP = 0.03   # ... and never predicts more than 3 % of the long edge inside the crop box
RADIAL_SPAN = (0.12, 0.88)


def radial_displacement(k, c, norm_radius: float, shape_hw, rho_max: float = 1.0) -> tuple[np.ndarray, np.ndarray]:
    """Displacement field r(p) (rx, ry) of the radial model on an output grid."""
    h, w = int(shape_hw[0]), int(shape_hw[1])
    ys, xs = np.mgrid[0:h, 0:w]
    px = xs - c[0]
    py = ys - c[1]
    rho2 = np.minimum((px * px + py * py) / (norm_radius * norm_radius), rho_max * rho_max)
    f = k[0] * rho2 + k[1] * rho2 ** 2
    return f * px, f * py


def _fit_radial(centres, shifts, weights, c, norm_radius: float) -> Radial | None:
    """Weighted least squares of the radial component of tile shifts on rho^3 and rho^5."""
    d = centres - np.asarray(c)[None, :]
    dist = np.hypot(d[:, 0], d[:, 1])
    ok = dist > 1e-6
    if ok.sum() < RADIAL_MIN_TILES:
        return None
    d, dist, shifts, weights = d[ok], dist[ok], shifts[ok], weights[ok]
    u = d / dist[:, None]
    rad = (shifts * u).sum(1)
    rho = dist / norm_radius
    X = np.stack([rho ** 3, rho ** 5], 1) * norm_radius
    sw = np.sqrt(np.maximum(weights, 1e-6))
    k, *_ = np.linalg.lstsq(X * sw[:, None], rad * sw, rcond=None)
    res = rad - X @ k
    # one robust pass: drop tiles whose residual is far from the rest
    med = np.median(np.abs(res))
    keep = np.abs(res) <= max(3.0 * med, 0.5)
    if keep.sum() >= RADIAL_MIN_TILES and not keep.all():
        k, *_ = np.linalg.lstsq(X[keep] * sw[keep, None], rad[keep] * sw[keep], rcond=None)
        res = rad - X @ k
    before = float(np.sqrt(np.average(rad ** 2, weights=weights)))
    after = float(np.sqrt(np.average(res ** 2, weights=weights)))
    if before <= 1e-9 or after > (1.0 - RADIAL_MIN_GAIN) * before:
        return None
    return Radial((float(k[0]), float(k[1])), float(norm_radius), float(rho.max() + 0.02), before, after, int(len(rad)))


def estimate(ref_y: np.ndarray, cand_y: np.ndarray, scale_range=SCALE_RANGE,
             max_shift: float = MAX_SHIFT) -> Alignment:
    """Estimate scale/translation mapping cand_y (same long edge) onto ref_y.

    1) global translation at scale 1 (full-frame phase correlation)
    2) up to 4 rounds: resample the candidate with the current estimate, measure
       local shifts on a 5x5 tile grid, fit r = a (x - c) + t by weighted least
       squares (tiles with a weak peak or a residual > 1.5 px are dropped), and
       compose: s <- (1 + a) s, d <- (1 + a) d + t
    Falls back to a scale grid search when fewer than 5 tiles are usable.
    """
    h, w = ref_y.shape
    lo, hi = scale_range
    c = ((w - 1) / 2.0, (h - 1) / 2.0)
    ref_b = _bandpass_log(ref_y)
    s = 1.0
    cand_b = _bandpass_log(_scaled_frame(cand_y, s, (h, w)))
    dx, dy, pk = phase_correlate(ref_b, cand_b, max_shift * w, max_shift * h)
    ok_rounds = 0
    for _ in range(4):
        warped, _v = imageops.warp_scale_shift(cand_y, s, dx, dy, (h, w))
        cand_b = _bandpass_log(warped)
        cs, rs, ps = _tile_shifts(ref_b, cand_b)
        keep = ps >= TILE_PEAK
        if keep.sum() < MIN_TILES:
            break
        a, tx, ty, res = _fit_similarity(cs[keep], rs[keep], ps[keep], c)
        good = res <= 1.5
        if good.sum() >= MIN_TILES and not good.all():
            idx = np.flatnonzero(keep)[good]
            a, tx, ty, res = _fit_similarity(cs[idx], rs[idx], ps[idx], c)
        s_new = (1.0 + a) * s
        dx, dy = (1.0 + a) * dx + tx, (1.0 + a) * dy + ty
        s = s_new
        ok_rounds += 1
        if abs(a) * max(w, h) < 0.02 and np.hypot(tx, ty) < 0.02:
            break
    in_range = lo - 1e-6 <= s <= hi + 1e-6 and abs(dx) <= max_shift * w + 1 and abs(dy) <= max_shift * h + 1
    if ok_rounds == 0 or not in_range:
        al = _grid_search(ref_y, cand_y, scale_range, max_shift)
    else:
        warped, _v = imageops.warp_scale_shift(cand_y, s, dx, dy, (h, w))
        _tx, _ty, pk = phase_correlate(ref_b, _bandpass_log(warped), 2, 2)
        al = Alignment(scale=float(s), dx=float(dx), dy=float(dy), peak=pk, method="phase-correlation-tiles")
        # 3) residual radial distortion (lens-correction differences): denser tiles on the
        #    similarity-warped candidate, then r(p) = (k1 rho^2 + k2 rho^4 + k3 rho^6)(p - c).
        cs, rs, ps = _tile_shifts(ref_b, _bandpass_log(warped), grid=7, tile=0.2, max_frac=0.2, span=RADIAL_SPAN)
        keep = ps >= TILE_PEAK
        if keep.sum() >= RADIAL_MIN_TILES:
            norm_radius = float(np.hypot(w, h) / 2.0)
            rad = _fit_radial(cs[keep], rs[keep], ps[keep], c, norm_radius)
            if rad is not None:
                rx, ry = radial_displacement(rad.k, c, norm_radius, (h, w), rad.rho_max)
                y0, y1, x0, x1 = imageops.crop_box(h, w, CROP)
                if float(np.hypot(rx, ry)[y0:y1, x0:x1].max()) <= RADIAL_MAX_DISP * max(w, h):
                    al.radial = rad
                    al.method = "phase-correlation-tiles+radial"
    al.corr = alignment_corr(ref_y, cand_y, al)
    return al


def alignment_corr(ref_y: np.ndarray, cand_y: np.ndarray, al: Alignment, crop: float = CROP) -> float:
    h, w = ref_y.shape
    warped, valid = apply(cand_y, al, (h, w))
    y0, y1, x0, x1 = imageops.crop_box(h, w, crop)
    rb = _bandpass_log(ref_y)[y0:y1, x0:x1]
    cb = _bandpass_log(warped)[y0:y1, x0:x1]
    return ncc(rb, cb, valid[y0:y1, x0:x1])


def identity(ref_y: np.ndarray, cand_y: np.ndarray) -> Alignment:
    """No search: the candidate is stretched onto the reference frame."""
    h, w = ref_y.shape
    al = Alignment(scale=1.0, dx=0.0, dy=0.0, method="none")
    stretched = imageops.resize(cand_y, (w, h))
    y0, y1, x0, x1 = imageops.crop_box(h, w, CROP)
    al.corr = ncc(_bandpass_log(ref_y)[y0:y1, x0:x1], _bandpass_log(stretched)[y0:y1, x0:x1])
    return al


def apply(cand: np.ndarray, al: Alignment, ref_hw) -> tuple[np.ndarray, np.ndarray]:
    """Resample the candidate (any channels) into the reference frame; returns (img, valid)."""
    h, w = int(ref_hw[0]), int(ref_hw[1])
    if al.method == "none":
        out = imageops.resize(cand, (w, h))
        return out, np.ones((h, w), dtype=bool)
    out, valid = imageops.warp_scale_shift(cand, al.scale, al.dx, al.dy, (h, w))
    if al.radial is None:
        return out, valid
    c = ((w - 1) / 2.0, (h - 1) / 2.0)
    rx, ry = radial_displacement(al.radial.k, c, al.radial.norm_radius, (h, w), al.radial.rho_max)
    ys, xs = np.mgrid[0:h, 0:w]
    # ref(x) ~ cand_w(x - r(x)): sample the similarity-warped candidate at x - r(x)
    out2, valid2 = imageops.remap(out, xs - rx, ys - ry)
    valid_w, _ = imageops.remap(valid.astype(np.float32), xs - rx, ys - ry)
    return out2, valid2 & (valid_w > 0.999)
