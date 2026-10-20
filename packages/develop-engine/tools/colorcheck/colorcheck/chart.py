"""ColorChecker Classic 24 measurement: ``colorcheck chart`` (Epic #16939 S9 / #16972).

Geometry
  The chart quad is the outer boundary of the 4 x 6 patch array: corner 1 is
  the outer corner of patch 1 (dark skin), then clockwise as seen on the chart
  (outer corners of patch 6, 24 and 19).  Inside the quad the patches sit on a
  regular grid separated by a black gap of GAP x pitch.  Each patch is sampled
  over a centred square whose side is SAMPLE (40 %) of the patch side, mapped
  through the homography; every full-resolution pixel inside it is averaged in
  linear light.

Detection (no ``--corners``; needs cv2)
  display-encoded luminance -> adaptive threshold (3 block sizes x 2 offsets)
  -> contours -> near-square convex blobs ("swatches") -> graph of swatches of
  similar size about one pitch apart -> lattice coordinates by walking the
  graph -> RANSAC homography lattice -> image -> every 6 x 4 / 4 x 6 window of
  the lattice in its 2 possible rotations.  A window is accepted only when the
  gray scale (19 -> 24) gets darker and the sampled squares are uniform; the
  accepted window with the lowest gray-balanced ΔE00 wins.

Colour
  srgb              display-referred pixels: Lab straight from the sRGB decode
                    ("raw" has no exposure or white adjustment)
  linear-srgb /     scene-referred linear data: Lab straight from the linear
  linear-prophoto   values (no display rendering / tone curve), after one gain
                    that makes Y of the exposure anchor (patch 19, or the next
                    unclipped gray patch) equal to its reference Y
  grayBalanced      per-channel gains (least squares in the image's linear RGB)
                    that make patches 19-24 match the reference neutrals,
                    rescaled so that the exposure anchor keeps the Y it has in
                    "raw": raw and grayBalanced differ only in the white.
"""
from __future__ import annotations

import math
import os
from collections import deque

import numpy as np

from . import __version__
from . import color as C
from . import imageops
from . import io as IO
from .util import now_iso

try:  # optional: auto detection and the debug image need it
    import cv2  # type: ignore
except Exception:  # pragma: no cover - depends on the environment
    cv2 = None

SCHEMA = "colorcheck/chart/v1"
ROWS, COLS = 4, 6
GAP = 0.12          # black gap between patches as a fraction of the pitch (model)
SIDE = 1.0 - GAP    # patch side in pitch units
SAMPLE = 0.40       # sampled square: central 40 % of the patch side
GRAY = (19, 20, 21, 22, 23, 24)
CLIP_FRACTION = 0.01     # patches with more clipped pixels are not used for exposure / white
WORK_LONG_EDGE = 1600    # detection runs on a copy with this long edge
DEBUG_LONG_EDGE = 1600
MIN_SWATCHES = 8         # the lattice needs at least this many detected patches
MAX_CANDIDATES = 1500
UNIFORMITY_WARN = 0.08   # relative std of Y inside a sampled square
UNIFORMITY_ACCEPT = 0.15  # detection: median relative std of the 24 squares


class ChartNotFound(Exception):
    """No ColorChecker Classic could be located in the image."""


def _r(x, nd=4):
    return None if x is None or not np.isfinite(x) else round(float(x), nd)


# ------------------------------------------------------------- geometry

def homography(src, dst) -> np.ndarray:
    """Normalized DLT: 3x3 H with dst ~ H @ src (least squares for more than 4 pairs)."""
    src = np.asarray(src, dtype=np.float64).reshape(-1, 2)
    dst = np.asarray(dst, dtype=np.float64).reshape(-1, 2)
    if len(src) < 4 or len(src) != len(dst):
        raise ValueError("homography needs >= 4 point pairs")

    def _norm(p):
        c = p.mean(axis=0)
        s = math.sqrt(2.0) / max(float(np.mean(np.hypot(*(p - c).T))), 1e-12)
        return np.array([[s, 0.0, -s * c[0]], [0.0, s, -s * c[1]], [0.0, 0.0, 1.0]]), (p - c) * s

    ts, ps = _norm(src)
    td, pd = _norm(dst)
    x, y, u, v = ps[:, 0], ps[:, 1], pd[:, 0], pd[:, 1]
    a = np.zeros((2 * len(ps), 9))
    a[0::2, 0], a[0::2, 1], a[0::2, 2] = -x, -y, -1.0
    a[0::2, 6], a[0::2, 7], a[0::2, 8] = u * x, u * y, u
    a[1::2, 3], a[1::2, 4], a[1::2, 5] = -x, -y, -1.0
    a[1::2, 6], a[1::2, 7], a[1::2, 8] = v * x, v * y, v
    _, _, vt = np.linalg.svd(a)
    h = np.linalg.inv(td) @ vt[-1].reshape(3, 3) @ ts
    return h / h[2, 2]


def apply_h(h, pts) -> np.ndarray:
    p = np.asarray(pts, dtype=np.float64).reshape(-1, 2)
    q = np.c_[p, np.ones(len(p))] @ np.asarray(h, dtype=np.float64).T
    return q[:, :2] / q[:, 2:3]


def quad_chart() -> np.ndarray:
    """Outer corners of the patch array in chart units (pitch = 1): patch 1, 6, 24, 19."""
    w, h = COLS - GAP, ROWS - GAP
    return np.array([[0.0, 0.0], [w, 0.0], [w, h], [0.0, h]])


def centers_chart() -> np.ndarray:
    """Patch centres 1..24 (row-major) in chart units."""
    return np.array([[c + SIDE / 2, r + SIDE / 2] for r in range(ROWS) for c in range(COLS)], dtype=np.float64)


def parse_corners(corners) -> np.ndarray:
    """'x1,y1,...,x4,y4' (or 8 numbers) -> (4, 2) image px."""
    if isinstance(corners, str):
        vals = [v for v in corners.replace(";", ",").replace(" ", ",").split(",") if v.strip()]
    else:
        vals = list(np.asarray(corners, dtype=np.float64).ravel())
    try:
        arr = np.array([float(v) for v in vals], dtype=np.float64)
    except ValueError:
        arr = np.zeros(0)
    if arr.size != 8 or not np.all(np.isfinite(arr)):
        raise ValueError("--corners は x1,y1,x2,y2,x3,y3,x4,y4 の 8 個の数"
                         "（1 番 dark skin 側の外角から時計回り、画像の px）")
    return arr.reshape(4, 2)


def _signed_area(q) -> float:
    x, y = q[:, 0], q[:, 1]
    return 0.5 * float(np.sum(x * np.roll(y, -1) - np.roll(x, -1) * y))


def _convex(q) -> bool:
    e = np.roll(q, -1, axis=0) - q
    f = np.roll(e, -1, axis=0)
    cross = e[:, 0] * f[:, 1] - e[:, 1] * f[:, 0]
    return bool(np.all(cross > 0) or np.all(cross < 0))


def _rotation_deg(corners) -> float:
    d = corners[1] - corners[0]  # top edge of the chart, patch 1 -> patch 6
    return round(float(np.degrees(np.arctan2(d[1], d[0])) % 360.0), 2)


# ------------------------------------------------------------- sampling

def _clip_mask(raw: np.ndarray):
    if raw.dtype in (np.uint8, np.uint16):
        return raw.max(axis=-1) >= np.iinfo(raw.dtype).max
    top = float(np.nanmax(raw)) if raw.size else 0.0
    if 0.99 <= top <= 1.01:  # float output capped at 1.0
        return raw.max(axis=-1) >= 0.999 * top
    return None


def sample_patches(lin: np.ndarray, h: np.ndarray, lin_space: str, clip=None):
    """Mean linear RGB (24 x 3, float64) of the central SAMPLE square of each patch + per-patch info."""
    hh, ww = lin.shape[:2]
    hinv = np.linalg.inv(h)
    half = 0.5 * SAMPLE * SIDE
    means = np.full((24, 3), np.nan)
    info = []
    for n, (cx, cy) in enumerate(centers_chart()):
        sq = np.array([[cx - half, cy - half], [cx + half, cy - half], [cx + half, cy + half], [cx - half, cy + half]])
        poly = apply_h(h, sq)
        area = abs(_signed_area(poly))
        x0 = max(int(math.floor(poly[:, 0].min())), 0)
        x1 = min(int(math.ceil(poly[:, 0].max())), ww - 1)
        y0 = max(int(math.floor(poly[:, 1].min())), 0)
        y1 = min(int(math.ceil(poly[:, 1].max())), hh - 1)
        cnt = 0
        if x1 >= x0 and y1 >= y0:
            xs, ys = np.meshgrid(np.arange(x0, x1 + 1, dtype=np.float64), np.arange(y0, y1 + 1, dtype=np.float64))
            uv = apply_h(hinv, np.c_[xs.ravel(), ys.ravel()])
            inside = (np.abs(uv[:, 0] - cx) <= half) & (np.abs(uv[:, 1] - cy) <= half)
            cnt = int(inside.sum())
        if cnt == 0:
            info.append({"pixels": 0, "coverage": 0.0, "clipped": None, "uniformity": None})
            continue
        px = lin[y0:y1 + 1, x0:x1 + 1].reshape(-1, 3)[inside].astype(np.float64)
        means[n] = px.mean(axis=0)
        y = C.luminance(px, lin_space)
        my = float(y.mean())
        cl = float(clip[y0:y1 + 1, x0:x1 + 1].ravel()[inside].mean()) if clip is not None else 0.0
        info.append({"pixels": cnt, "coverage": round(min(cnt / area, 1.0), 3) if area > 0 else 0.0,
                     "clipped": round(cl, 4), "uniformity": _r(y.std() / my) if my > 0 else None})
    return means, info


# ------------------------------------------------------------- colour

def _to_lab(lin_space: str):
    return C.linear_srgb_to_lab if lin_space == C.SPACE_LINEAR_SRGB else C.linear_prophoto_to_lab


def _ref_rgb(lab_ref, lin_space: str) -> np.ndarray:
    return C.lab_to_linear_srgb(lab_ref) if lin_space == C.SPACE_LINEAR_SRGB else C.lab_to_linear_prophoto(lab_ref)


def gray_ramp_ok(y_gray) -> bool:
    """Luminance of 19..24 must not rise (3 % tolerance) and white must be clearly brighter than black."""
    y = np.asarray(y_gray, dtype=np.float64)
    if not np.all(np.isfinite(y)):
        return False
    steps = all(y[i + 1] <= y[i] * 1.03 + 1e-4 for i in range(len(y) - 1))
    return bool(steps and y[0] > 2.0 * max(y[-1], 1e-6))


def colorimetry(means: np.ndarray, clipped, lin_space: str, space: str, lab_ref: np.ndarray) -> dict:
    """raw / grayBalanced Lab(D50) and ΔE00 of the 24 patch means (linear RGB in lin_space)."""
    to_lab = _to_lab(lin_space)
    ref_rgb = _ref_rgb(lab_ref, lin_space)
    y_ref = C.lab_to_xyz(lab_ref)[:, 1]
    y = C.luminance(means, lin_space)
    clipped = np.asarray(clipped, dtype=np.float64)
    usable = (clipped <= CLIP_FRACTION) & np.isfinite(y) & (y > 0)
    warnings = []
    anchor = next((i for i in GRAY if usable[i - 1]), None)
    if space == C.SPACE_SRGB:
        k = 1.0
        exposure = {"method": "none", "patch": anchor, "gain": 1.0, "ev": 0.0}
    else:
        if anchor is None:
            raise ValueError("灰色スケール（19〜24）が全部白飛びか真っ黒で、露出を合わせられない")
        k = float(y_ref[anchor - 1] / y[anchor - 1])
        exposure = {"method": "gray-patch-Y", "patch": anchor, "gain": _r(k, 6), "ev": _r(math.log2(k), 4)}
    lab_raw = to_lab(means * k)

    used = [i for i in GRAY if usable[i - 1]]
    gains = None
    if anchor is not None and len(used) >= 2:
        m = means[np.array(used) - 1]
        r = ref_rgb[np.array(used) - 1]
        den = (m * m).sum(axis=0)
        if np.all(den > 0):
            g = (m * r).sum(axis=0) / den
            if np.all(np.isfinite(g)) and np.all(g > 0):
                target = y_ref[anchor - 1] if space != C.SPACE_SRGB else y[anchor - 1]
                g = g * float(target / C.luminance(means[anchor - 1] * g, lin_space))
                gains = g
    if gains is None:
        warnings.append("灰色スケールから白を推定できなかった（使えるパッチが 2 枚未満）。白合わせ後 = raw")
        lab_gb = lab_raw.copy()
        gray_balance = {"method": "none", "patches": used, "gains": None, "gainsRelative": None}
    else:
        lab_gb = to_lab(means * gains)
        gray_balance = {"method": "least-squares-gray-scale", "patches": used,
                        "gains": [_r(v, 6) for v in gains], "gainsRelative": [_r(v / gains[1], 5) for v in gains]}
    return {
        "lab_raw": lab_raw, "lab_gb": lab_gb,
        "de_raw": C.delta_e00(lab_ref, lab_raw), "de_gb": C.delta_e00(lab_ref, lab_gb),
        "exposure": exposure, "grayBalance": dict(gray_balance, space=lin_space),
        "y": y, "warnings": warnings,
    }


def de_summary(de) -> dict:
    de = np.asarray(de, dtype=np.float64)
    if de.size == 0 or not np.all(np.isfinite(de)):
        return {"mean": None, "p95": None, "max": None, "median": None, "worst": None}
    return {"mean": _r(de.mean()), "p95": _r(np.percentile(de, 95)), "max": _r(de.max()),
            "median": _r(np.median(de)), "worst": int(np.argmax(de)) + 1}


# ------------------------------------------------------------- detection

# rotation of the chart in the image (clockwise degrees), lattice window (w, h),
# affine (c, r, 1) -> (i - i0, j - j0, 1).  All keep the handedness (no mirror).
ORIENTATIONS = (
    (0, (6, 4), np.array([[1.0, 0.0, 0.0], [0.0, 1.0, 0.0], [0.0, 0.0, 1.0]])),
    (180, (6, 4), np.array([[-1.0, 0.0, 5.0], [0.0, -1.0, 3.0], [0.0, 0.0, 1.0]])),
    (90, (4, 6), np.array([[0.0, -1.0, 3.0], [1.0, 0.0, 0.0], [0.0, 0.0, 1.0]])),
    (270, (4, 6), np.array([[0.0, 1.0, 0.0], [-1.0, 0.0, 5.0], [0.0, 0.0, 1.0]])),
)
TO_CR = np.array([[1.0, 0.0, -SIDE / 2], [0.0, 1.0, -SIDE / 2], [0.0, 0.0, 1.0]])  # chart units -> (c, r)


def _display_gray8(lin: np.ndarray, lin_space: str, space: str) -> np.ndarray:
    y = C.luminance(lin, lin_space).astype(np.float32)
    if space != C.SPACE_SRGB:
        hi = float(np.percentile(y, 99.5))
        if hi > 0:
            y = y * np.float32(0.9 / hi)
    return C.quantize8(C.srgb_encode(np.clip(y, 0.0, 1.0)))


def find_swatches(g8: np.ndarray) -> np.ndarray:
    """Near-square convex blobs of a uint8 gray image: (n, 5) = cx, cy, area, angle (deg mod 90), fill."""
    hh, ww = g8.shape[:2]
    big = max(hh, ww)
    src = cv2.GaussianBlur(g8, (0, 0), max(0.7, big / 1600.0))
    min_a = max(36.0, (big * 0.005) ** 2)  # patches down to ~1/24 of the long edge for the whole chart
    max_a = (big * 0.25) ** 2
    k3 = np.ones((3, 3), np.uint8)
    out = []
    for frac in (1 / 60, 1 / 30, 1 / 15):
        bs = max(3, int(round(big * frac)) | 1)
        for off in (2, 6):
            m = cv2.adaptiveThreshold(src, 255, cv2.ADAPTIVE_THRESH_MEAN_C, cv2.THRESH_BINARY, bs, off)
            m = cv2.morphologyEx(m, cv2.MORPH_OPEN, k3)
            contours = cv2.findContours(m, cv2.RETR_LIST, cv2.CHAIN_APPROX_SIMPLE)[-2]
            for ct in contours:
                a = cv2.contourArea(ct)
                if a < min_a or a > max_a:
                    continue
                (_cx, _cy), (rw, rh), ang = cv2.minAreaRect(ct)
                if rw <= 0 or rh <= 0 or max(rw, rh) > 1.8 * min(rw, rh):
                    continue
                fill = a / (rw * rh)
                if fill < 0.8:
                    continue
                ha = cv2.contourArea(cv2.convexHull(ct))
                if ha <= 0 or a / ha < 0.92:
                    continue
                mo = cv2.moments(ct)
                if mo["m00"] <= 0:
                    continue
                out.append((mo["m10"] / mo["m00"], mo["m01"] / mo["m00"], a, ang % 90.0, fill))
    if not out:
        return np.zeros((0, 5))
    c = np.array(out, dtype=np.float64)
    kept = []
    for i in np.argsort(-c[:, 4], kind="stable"):  # best fill first; drop the same blob seen by other settings
        if kept:
            k = c[kept]
            d = np.hypot(k[:, 0] - c[i, 0], k[:, 1] - c[i, 1])
            if np.any(d < 0.35 * np.sqrt(np.minimum(k[:, 2], c[i, 2]))):
                continue
        kept.append(int(i))
    c = c[kept]
    return c[:MAX_CANDIDATES]


def _components(adj: np.ndarray) -> list:
    n = len(adj)
    seen = np.zeros(n, bool)
    comps = []
    for s in range(n):
        if seen[s]:
            continue
        seen[s] = True
        comp, q = [s], deque([s])
        while q:
            p = q.popleft()
            for t in np.flatnonzero(adj[p] & ~seen):
                seen[t] = True
                comp.append(int(t))
                q.append(int(t))
        comps.append(comp)
    return sorted(comps, key=len, reverse=True)


def fit_lattices(sw: np.ndarray) -> list:
    """Lattices (homography lattice (i, j) -> image) from swatch candidates, largest first."""
    if len(sw) < MIN_SWATCHES:
        return []
    pts, area, ang = sw[:, :2], sw[:, 2], sw[:, 3]
    side = np.sqrt(area)
    d = pts[None, :, :] - pts[:, None, :]  # d[p, q] = pts[q] - pts[p]
    dist = np.hypot(d[..., 0], d[..., 1])
    s = np.sqrt(side[:, None] * side[None, :])
    ratio = area[:, None] / area[None, :]
    dang = np.abs((ang[:, None] - ang[None, :] + 45.0) % 90.0 - 45.0)
    adj = (ratio > 0.5) & (ratio < 2.0) & (dist > 0.9 * s) & (dist < 2.2 * s) & (dang < 12.0)
    np.fill_diagonal(adj, False)
    out = []
    for comp in _components(adj):
        if len(comp) < MIN_SWATCHES:
            break
        lat = _lattice(np.array(comp), pts, side, ang, adj, d, s)
        if lat is not None:
            out.append(lat)
    return out


def _lattice(idx, pts, side, ang, adj, d, s):
    a4 = np.radians(ang[idx] * 4.0)
    th = math.atan2(float(np.sin(a4).mean()), float(np.cos(a4).mean())) / 4.0
    u = np.array([math.cos(th), math.sin(th)])
    v = np.array([-math.sin(th), math.cos(th)])
    sub = adj[np.ix_(idx, idx)]
    dd = d[np.ix_(idx, idx)]
    ss = s[np.ix_(idx, idx)]
    pu, pv = dd @ u, dd @ v
    hor = sub & (np.abs(pv) < 0.25 * np.abs(pu)) & (np.abs(pu) < 1.75 * ss)
    ver = sub & (np.abs(pu) < 0.25 * np.abs(pv)) & (np.abs(pv) < 1.75 * ss)
    ru = float(np.median(np.abs(pu[hor]) / ss[hor])) if hor.any() else None
    rv = float(np.median(np.abs(pv[ver]) / ss[ver])) if ver.any() else None
    if ru is None and rv is None:
        return None
    ru, rv = ru or rv, rv or ru
    centre = pts[idx].mean(axis=0)
    root = int(np.argmin(np.hypot(*(pts[idx] - centre).T)))
    coords = {root: (0, 0)}
    taken = {(0, 0)}
    q = deque([root])
    while q:
        p = q.popleft()
        for t in np.flatnonzero(sub[p]):
            t = int(t)
            if t in coords:
                continue
            a = pu[p, t] / (ru * ss[p, t])
            b = pv[p, t] / (rv * ss[p, t])
            di, dj = int(round(a)), int(round(b))
            if (di, dj) == (0, 0) or max(abs(di), abs(dj)) > 2 or abs(a - di) > 0.3 or abs(b - dj) > 0.3:
                continue
            ct = (coords[p][0] + di, coords[p][1] + dj)
            if ct in taken:
                continue
            coords[t] = ct
            taken.add(ct)
            q.append(t)
    if len(coords) < MIN_SWATCHES:
        return None
    loc = np.array(sorted(coords))
    lat = np.array([coords[i] for i in loc], dtype=np.float64)
    img = pts[idx[loc]]
    pitch = 0.5 * (ru + rv) * float(np.median(side[idx]))
    h, mask = cv2.findHomography(lat.astype(np.float32), img.astype(np.float32), cv2.RANSAC, 0.2 * pitch)
    if h is None or mask is None:
        return None
    inl = mask.ravel().astype(bool)
    if inl.sum() < MIN_SWATCHES:
        return None
    h = homography(lat[inl], img[inl])
    return {"H": h, "lattice": lat[inl].astype(np.int64), "points": img[inl], "count": int(inl.sum()),
            "pitch": pitch}


def _windows(lat: dict) -> list:
    ij = lat["lattice"]
    imin, jmin = ij.min(axis=0)
    imax, jmax = ij.max(axis=0)
    wins = []
    for rot, (w, h), a in ORIENTATIONS:
        for i0 in range(int(imin) - w + 1, int(imax) + 1):
            for j0 in range(int(jmin) - h + 1, int(jmax) + 1):
                inside = int(np.sum((ij[:, 0] >= i0) & (ij[:, 0] < i0 + w) & (ij[:, 1] >= j0) & (ij[:, 1] < j0 + h)))
                wins.append((inside, rot, i0, j0, a))
    top = max(x[0] for x in wins)
    out = []
    for inside, rot, i0, j0, a in wins:
        if inside < max(MIN_SWATCHES, top - 2):
            continue
        t = np.array([[1.0, 0.0, i0], [0.0, 1.0, j0], [0.0, 0.0, 1.0]])
        out.append({"rotation": rot, "inside": inside, "M": t @ a @ TO_CR})
    return out


def detect(lin: np.ndarray, lin_space: str, space: str, lab_ref: np.ndarray) -> tuple[np.ndarray, dict]:
    """Homography chart units -> full-resolution image px, and detection details."""
    if cv2 is None:
        raise ChartNotFound("自動検出には cv2（opencv-python-headless）が要る")
    hh, ww = lin.shape[:2]
    if max(hh, ww) > WORK_LONG_EDGE:
        work = imageops.resize(lin, imageops.size_for_long_edge(ww, hh, WORK_LONG_EDGE))
    else:
        work = lin
    fx, fy = work.shape[1] / ww, work.shape[0] / hh
    sw = find_swatches(_display_gray8(work, lin_space, space))
    lattices = fit_lattices(sw)
    if not lattices:
        raise ChartNotFound(f"パッチらしい四角が格子に並んでいない（四角の候補 {len(sw)} 個）")
    best = None
    tried = 0
    for li, lat in enumerate(lattices):
        for win in _windows(lat):
            h_work = lat["H"] @ win["M"]
            means, info = sample_patches(work, h_work, lin_space)
            if np.isnan(means).any() or any(i["coverage"] < 0.5 for i in info):
                continue
            tried += 1
            y = C.luminance(means, lin_space)
            if not gray_ramp_ok(y[np.array(GRAY) - 1]):
                continue
            uni = [i["uniformity"] for i in info if i["uniformity"] is not None]
            if not uni or float(np.median(uni)) > UNIFORMITY_ACCEPT:
                continue
            try:
                col = colorimetry(means, np.zeros(24), lin_space, space, lab_ref)
            except ValueError:
                continue
            score = float(np.mean(col["de_gb"]))
            if best is None or score < best["score"]:
                best = {"score": score, "H": h_work, "rotation": win["rotation"], "lattice": li,
                        "count": lat["count"], "points": lat["points"]}
    if best is None:
        raise ChartNotFound(f"四角の格子は見つかったが、灰色スケール（19→24）が暗くなっていく 6×4 の並びが無い"
                            f"（格子 {len(lattices)} 個・候補の並び {tried} 通り）")
    to_full = np.array([[1.0 / fx, 0.0, 0.5 / fx - 0.5], [0.0, 1.0 / fy, 0.5 / fy - 0.5], [0.0, 0.0, 1.0]])
    h_full = to_full @ best["H"]
    swatches = apply_h(to_full, best["points"])
    return h_full, {"swatches": best["count"], "candidates": int(len(sw)), "workLongEdge": int(max(work.shape[:2])),
                    "score": _r(best["score"]), "swatchPoints": swatches}


# ------------------------------------------------------------- debug image

def _display_rgb8(lin: np.ndarray, lin_space: str, space: str, gain: float) -> np.ndarray:
    x = lin if lin_space == C.SPACE_LINEAR_SRGB else C.apply_matrix(lin, C.M_PP_TO_SRGB)
    if space != C.SPACE_SRGB:
        x = x * np.float32(gain)
    return C.quantize8(C.srgb_encode(np.clip(x, 0.0, 1.0)))


def write_debug(path: str, lin: np.ndarray, lin_space: str, space: str, gain: float, h: np.ndarray,
                swatches=None) -> str:
    """PNG/JPEG with the chart quad, the sampled squares, patch numbers and corner 1."""
    if cv2 is None:
        raise RuntimeError("--debug の画像には cv2（opencv-python-headless）が要る")
    hh, ww = lin.shape[:2]
    if max(hh, ww) > DEBUG_LONG_EDGE:
        small = imageops.resize(lin, imageops.size_for_long_edge(ww, hh, DEBUG_LONG_EDGE))
    else:
        small = lin
    fx, fy = small.shape[1] / ww, small.shape[0] / hh
    to_small = np.array([[fx, 0.0, 0.5 * fx - 0.5], [0.0, fy, 0.5 * fy - 0.5], [0.0, 0.0, 1.0]])
    hs = to_small @ h
    canvas = np.ascontiguousarray(_display_rgb8(small, lin_space, space, gain))
    big = max(canvas.shape[:2])
    lw = max(1, int(round(big / 800)))
    fs = max(0.35, big / 2400)

    def pts(p):
        return np.round(p).astype(np.int32).reshape(-1, 1, 2)

    cv2.polylines(canvas, [pts(apply_h(hs, quad_chart()))], True, (255, 0, 255), lw, cv2.LINE_AA)
    half = 0.5 * SAMPLE * SIDE
    for n, (cx, cy) in enumerate(centers_chart()):
        sq = np.array([[cx - half, cy - half], [cx + half, cy - half], [cx + half, cy + half], [cx - half, cy + half]])
        cv2.polylines(canvas, [pts(apply_h(hs, sq))], True, (0, 255, 0), lw, cv2.LINE_AA)
        tx, ty = apply_h(hs, [[cx - SIDE / 2 + 0.05, cy - SIDE / 2 + 0.22]])[0]
        for col, th in (((0, 0, 0), lw + 2), ((255, 255, 255), lw)):
            cv2.putText(canvas, str(n + 1), (int(tx), int(ty)), cv2.FONT_HERSHEY_SIMPLEX, fs, col, th, cv2.LINE_AA)
    if swatches is not None and len(swatches):
        for x, y in apply_h(to_small, swatches):
            cv2.circle(canvas, (int(round(x)), int(round(y))), lw + 1, (0, 255, 255), -1, cv2.LINE_AA)
    c1 = apply_h(hs, quad_chart()[:1])[0]
    cv2.circle(canvas, (int(round(c1[0])), int(round(c1[1]))), 4 * lw + 2, (255, 64, 0), lw + 1, cv2.LINE_AA)
    return IO.save_srgb8(path, canvas)


# ------------------------------------------------------------- run

def run_chart(image: str, space: str = C.SPACE_SRGB, corners=None, illuminant: str | None = "D50",
              reference: str | None = None, gray_balance: bool = False, camera: dict | None = None,
              decoder_version: str | None = None, base_version: str | None = None, label: str | None = None,
              debug: str | None = None) -> dict:
    """Measure ColorChecker Classic 24 in `image`; raises ChartNotFound when it cannot be located."""
    if space not in C.SPACES:
        raise ValueError(f"--space must be one of {C.SPACES}")
    if debug and os.path.splitext(debug)[1].lower() not in (".png", ".jpg", ".jpeg"):
        raise ValueError("--debug は .png か .jpg")
    if reference is None:
        raise ValueError("explicit independently measured chart reference is required")
    ref_path = os.path.abspath(reference)
    ref = C.load_colorchecker(ref_path)
    patches_ref = ref["patches"]
    lab_ref = np.array([p["lab"] for p in patches_ref], dtype=np.float64)

    img = IO.load_image(image)
    desc = img.describe()
    desc["space"] = space
    lin, lin_space = img.linear(space)
    clip = _clip_mask(img.raw)
    del img
    desc["linearSpace"] = lin_space
    warnings = []

    if corners is not None and not (isinstance(corners, str) and not corners.strip()):
        q = parse_corners(corners)
        if not _convex(q) or abs(_signed_area(q)) < 16.0:
            raise ValueError("--corners が凸の四角形になっていない（順番か値を確認）")
        if _signed_area(q) < 0:
            q = q[[0, 3, 2, 1]]
            warnings.append("--corners が反時計回りだったので時計回りに並べ替えた（1 点目はそのまま）")
        h = homography(quad_chart(), q)
        method, extra = "corners", {}
    else:
        h, extra = detect(lin, lin_space, space, lab_ref)
        method = "auto"

    means, info = sample_patches(lin, h, lin_space, clip)
    outside = [i + 1 for i, x in enumerate(info) if x["pixels"] == 0]
    if outside:
        raise ValueError(f"パッチ {outside} の計測位置が画像の外（--corners を確認）")
    partial = [i + 1 for i, x in enumerate(info) if x["coverage"] < 0.9]
    if partial:
        warnings.append(f"パッチ {partial} の計測位置の一部が画像の外")
    clipped = np.array([x["clipped"] or 0.0 for x in info])
    col = colorimetry(means, clipped, lin_space, space, lab_ref)
    warnings += col["warnings"]
    over = [i + 1 for i in range(24) if clipped[i] > CLIP_FRACTION]
    if over:
        warnings.append(f"パッチ {over} に白飛びした画素がある（露出の基準・白の推定に使わない）")
    ramp = gray_ramp_ok(col["y"][np.array(GRAY) - 1])
    if not ramp:
        warnings.append("灰色スケール（19→24）が暗くなっていかない（四隅の順番・向きを確認）")
    uneven = [i + 1 for i, x in enumerate(info) if x["uniformity"] is not None and x["uniformity"] > UNIFORMITY_WARN]
    if uneven:
        warnings.append(f"パッチ {uneven} の計測範囲が均一でない（位置ずれ・写り込み・ノイズの可能性）")
    small = [i + 1 for i, x in enumerate(info) if x["pixels"] < 25]
    if small:
        warnings.append(f"パッチ {small} の計測画素が 25 未満（チャートが小さすぎる）")

    corners_img = apply_h(h, quad_chart())
    centers_img = apply_h(h, centers_chart())
    detection = {"method": method, "corners": np.round(corners_img, 2).tolist(),
                 "patchCenters": np.round(centers_img, 2).tolist(), "rotationDeg": _rotation_deg(corners_img),
                 "gapFraction": GAP, "sampleFraction": SAMPLE, "grayRampMonotonic": ramp}
    for k in ("swatches", "candidates", "workLongEdge", "score"):
        if k in extra:
            detection[k] = extra[k]

    lab_raw, lab_gb, de_raw, de_gb = col["lab_raw"], col["lab_gb"], col["de_raw"], col["de_gb"]
    patches = []
    for i, p in enumerate(patches_ref):
        patches.append({
            "index": int(p["index"]), "name": p.get("name"),
            "lab_ref": [round(float(v), 3) for v in lab_ref[i]],
            "lab_raw": [round(float(v), 3) for v in lab_raw[i]],
            "lab_grayBalanced": [round(float(v), 3) for v in lab_gb[i]],
            "deltaE00_raw": _r(de_raw[i]), "deltaE00_grayBalanced": _r(de_gb[i]),
            "rgbLinear": [_r(v, 6) for v in means[i]],
            "pixels": info[i]["pixels"], "clipped": info[i]["clipped"], "uniformity": info[i]["uniformity"],
        })
    result = {
        "schema": SCHEMA,
        "kind": "chart",
        "label": label,
        "illuminant": illuminant,
        "camera": camera or {"make": None, "model": None},
        "decoderVersion": decoder_version,
        "baseVersion": base_version,
        "image": desc,
        "reference": {"path": ref_path, "name": ref.get("name"), "illuminant": ref.get("illuminant")},
        "detection": detection,
        "exposure": col["exposure"],
        "grayBalance": col["grayBalance"],
        "patches": patches,
        "summary": {"primary": "grayBalanced" if gray_balance else "raw",
                    "raw": de_summary(de_raw), "grayBalanced": de_summary(de_gb)},
        "warnings": warnings,
        "tool": {"name": "colorcheck", "version": __version__},
        "createdAt": now_iso(),
    }
    if debug:
        gain = col["exposure"]["gain"] or 1.0
        result["debugImage"] = os.path.abspath(
            write_debug(debug, lin, lin_space, space, float(gain), h, extra.get("swatchPoints")))
    return result
