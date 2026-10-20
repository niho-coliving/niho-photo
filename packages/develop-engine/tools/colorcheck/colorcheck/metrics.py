"""Image-level numbers: ΔE00 statistics, EV difference, saturation ratio, white.

Inputs are display-referred *linear sRGB* images of the same size (the sRGB
JPEG decoded with the IEC 61966-2-1 inverse gamma, or the NIHO rendering) and
a boolean mask of pixels to use.  Lab is always computed from XYZ(D50).
"""
from __future__ import annotations

import numpy as np

from . import color as C

MID_Y_RANGE = (0.02, 0.8)  # EV difference uses reference pixels in this Y range
CHROMA_MIN = 5.0           # saturation ratio uses reference pixels with C* > 5
WHITE_L_MIN = 40.0         # white estimate: L* > 40 ...
WHITE_C_MAX = 8.0          # ... and C* < 8 (each image selects its own pixels)
EDGE_GRAD_L = 1.5          # flat pixels: |grad L*| of the blurred images <= 1.5 L*/px (analysis scale)
EDGE_DILATE = 2            # ... after growing the edge set by 2 px on each side
FLAT_MIN_FRACTION = 0.05   # below this share of flat pixels the main numbers fall back to all pixels


def _r(x, nd=4):
    return None if x is None or not np.isfinite(x) else round(float(x), nd)


def de_stats(de: np.ndarray) -> dict:
    de = np.asarray(de, dtype=np.float64).ravel()
    if de.size == 0:
        return {"mean": None, "p50": None, "p95": None, "p99": None, "max": None, "pixels": 0}
    p50, p95, p99 = np.percentile(de, [50, 95, 99])
    return {"mean": _r(de.mean()), "p50": _r(p50), "p95": _r(p95), "p99": _r(p99),
            "max": _r(de.max()), "pixels": int(de.size)}


def ev_diff(y_ref: np.ndarray, y_cand: np.ndarray, mask: np.ndarray) -> float | None:
    """log2(median Y_cand / median Y_ref) over reference mid-tones (+ = candidate brighter)."""
    sel = mask & (y_ref >= MID_Y_RANGE[0]) & (y_ref <= MID_Y_RANGE[1])
    if sel.sum() < 16:
        return None
    mr = float(np.median(y_ref[sel]))
    mc = float(np.median(y_cand[sel]))
    if mr <= 0 or mc <= 0:
        return None
    return float(np.log2(mc / mr))


def saturation_ratio(lab_ref: np.ndarray, lab_cand: np.ndarray, mask: np.ndarray) -> float | None:
    """mean C*ab(candidate) / mean C*ab(reference) over reference pixels with C* > 5."""
    c_ref = C.chroma(lab_ref)
    sel = mask & (c_ref > CHROMA_MIN)
    if sel.sum() < 16:
        return None
    return float(C.chroma(lab_cand)[sel].mean() / c_ref[sel].mean())


def white_estimate(lab: np.ndarray, mask: np.ndarray) -> dict:
    """Mean a*/b* of near-neutral pixels (L* > 40 and C* < 8) of one image."""
    sel = mask & (lab[..., 0] > WHITE_L_MIN) & (C.chroma(lab) < WHITE_C_MAX)
    n = int(sel.sum())
    total = int(mask.sum())
    if n < 16:
        return {"a": None, "b": None, "fraction": _r(n / total if total else 0.0)}
    return {"a": _r(lab[..., 1][sel].mean(), 3), "b": _r(lab[..., 2][sel].mean(), 3),
            "fraction": _r(n / total if total else 0.0)}


def _dilate(mask: np.ndarray, r: int) -> np.ndarray:
    out = mask.copy()
    for dy in range(-r, r + 1):
        for dx in range(-r, r + 1):
            if dy == 0 and dx == 0:
                continue
            sh = np.zeros_like(mask)
            ys = slice(max(dy, 0), mask.shape[0] + min(dy, 0))
            yd = slice(max(-dy, 0), mask.shape[0] + min(-dy, 0))
            xs = slice(max(dx, 0), mask.shape[1] + min(dx, 0))
            xd = slice(max(-dx, 0), mask.shape[1] + min(-dx, 0))
            sh[yd, xd] = mask[ys, xs]
            out |= sh
    return out


def edge_mask(lab_ref_b: np.ndarray, lab_cand_b: np.ndarray, grad_limit: float = EDGE_GRAD_L,
              dilate: int = EDGE_DILATE) -> np.ndarray:
    """Pixels on or next to a lightness edge in either blurred image.

    A residual misregistration of a fraction of a pixel puts a large ΔE00 on
    every contour; those pixels say nothing about colour rendering, so the main
    statistics are computed on the flat pixels (edge_mask == False) and the
    all-pixel numbers are reported alongside.
    """
    edges = np.zeros(lab_ref_b.shape[:2], dtype=bool)
    for lab in (lab_ref_b, lab_cand_b):
        gy, gx = np.gradient(lab[..., 0].astype(np.float64))
        edges |= np.hypot(gx, gy) > grad_limit
    return _dilate(edges, dilate) if dilate > 0 else edges


def measure(ref_u: np.ndarray, cand_u: np.ndarray, mask_u: np.ndarray,
            ref_b: np.ndarray, cand_b: np.ndarray, mask_b: np.ndarray) -> dict:
    """All metrics.  *_u: unblurred, *_b: blurred (main).  Linear sRGB inputs.

    `deltaE00` (main) = blurred, flat pixels (edges excluded, see edge_mask).
    `deltaE00All` = blurred, every valid pixel.  `deltaE00Edges` = blurred, edge
    pixels only.  `deltaE00Unblurred` = unblurred, every valid pixel.
    """
    lab_rb = C.linear_srgb_to_lab(ref_b)
    lab_cb = C.linear_srgb_to_lab(cand_b)
    edges = edge_mask(lab_rb, lab_cb)
    flat = mask_b & ~edges
    n_valid = int(mask_b.sum())
    flat_fraction = int(flat.sum()) / n_valid if n_valid else 0.0
    fallback = flat_fraction < FLAT_MIN_FRACTION
    if fallback:  # e.g. pure noise: nothing is flat, so measure everything
        flat = mask_b
    de_all = C.delta_e00(lab_rb[mask_b], lab_cb[mask_b])
    de_flat = C.delta_e00(lab_rb[flat], lab_cb[flat])
    de_edge = C.delta_e00(lab_rb[mask_b & edges], lab_cb[mask_b & edges])
    lab_ru = C.linear_srgb_to_lab(ref_u[mask_u])
    lab_cu = C.linear_srgb_to_lab(cand_u[mask_u])
    de_u = C.delta_e00(lab_ru, lab_cu)
    y_r = C.luminance(ref_b, C.SPACE_LINEAR_SRGB)
    y_c = C.luminance(cand_b, C.SPACE_LINEAR_SRGB)
    ev = ev_diff(y_r, y_c, flat)
    sat = saturation_ratio(lab_rb, lab_cb, flat)
    return {
        "deltaE00": de_stats(de_flat),
        "deltaE00All": de_stats(de_all),
        "deltaE00Edges": de_stats(de_edge),
        "deltaE00Unblurred": de_stats(de_u),
        "flatFraction": _r(flat_fraction),
        "flatFallback": bool(fallback),
        "edgeGradLimit": EDGE_GRAD_L,
        "evDiff": _r(ev),
        "saturationRatio": _r(sat),
        "white": {"reference": white_estimate(lab_rb, flat), "candidate": white_estimate(lab_cb, flat)},
    }


def median_gain(ref_lin: np.ndarray, cand_lin: np.ndarray, mask: np.ndarray) -> float | None:
    """Gain on candidate linear values that makes its mid-tone median Y match the reference."""
    y_r = C.luminance(ref_lin, C.SPACE_LINEAR_SRGB)
    y_c = C.luminance(cand_lin, C.SPACE_LINEAR_SRGB)
    ev = ev_diff(y_r, y_c, mask)
    return None if ev is None else float(2.0 ** (-ev))
