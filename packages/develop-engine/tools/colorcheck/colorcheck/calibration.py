"""Calibration JSON (schema niho-develop-calibration/v1): load / apply / build.

Applied to linear ProPhoto (D50) data before the NIHO display rendering:

    rgb' = M @ rgb            (M: matrix, or illuminant interpolation by --neutral-k)
    rgb' = max(rgb', 0)
    rgb' = HueSat(rgb')       (optional small table, linear-ProPhoto HSV)
    render_display(rgb', ev + baselineEV)

Illuminant interpolation is linear in mired (1e6 / K) between the two nearest
nodes and clamped outside the node range (DNG dual-illuminant style).
"""
from __future__ import annotations

import os
from dataclasses import dataclass

import numpy as np

from . import color as C
from .util import read_json

SCHEMA = "niho-develop-calibration/v1"


def _matrix(value, label: str) -> np.ndarray:
    try:
        matrix = np.asarray(value, dtype=np.float64)
    except (TypeError, ValueError, OverflowError) as exc:
        raise ValueError(f"{label} must be a finite 3x3 matrix") from exc
    if matrix.shape != (3, 3):
        raise ValueError(f"{label} must be 3x3")
    if not np.isfinite(matrix).all():
        raise ValueError(f"{label} must contain only finite values")
    return matrix


def white_preserving(p6) -> np.ndarray:
    """3x3 with free off-diagonals and diag = 1 - (row off-diagonal sum): rows sum to 1."""
    a = np.asarray(p6, dtype=np.float64).reshape(3, 2)
    m = np.zeros((3, 3))
    for i in range(3):
        cols = [j for j in range(3) if j != i]
        m[i, cols[0]] = a[i, 0]
        m[i, cols[1]] = a[i, 1]
        m[i, i] = 1.0 - a[i, 0] - a[i, 1]
    return m


def offdiag_params(m) -> np.ndarray:
    m = np.asarray(m, dtype=np.float64)
    out = []
    for i in range(3):
        out.extend(m[i, j] for j in range(3) if j != i)
    return np.array(out)


def mired_weight(neutral_k: float, k_low: float, k_high: float) -> float:
    """Weight of the low-K node (clamped to [0, 1])."""
    inv, inv_lo, inv_hi = 1.0 / neutral_k, 1.0 / k_low, 1.0 / k_high
    if inv_lo == inv_hi:
        return 1.0
    return float(np.clip((inv - inv_hi) / (inv_lo - inv_hi), 0.0, 1.0))


def interpolate_matrix(nodes, neutral_k: float) -> np.ndarray:
    """nodes: [(K, 3x3), ...]; linear in mired between neighbours, clamped."""
    nodes = sorted(((float(k), np.asarray(m, dtype=np.float64)) for k, m in nodes), key=lambda t: t[0])
    if len(nodes) == 1:
        return nodes[0][1]
    if neutral_k <= nodes[0][0]:
        return nodes[0][1]
    if neutral_k >= nodes[-1][0]:
        return nodes[-1][1]
    for (k0, m0), (k1, m1) in zip(nodes[:-1], nodes[1:]):
        if k0 <= neutral_k <= k1:
            w = mired_weight(neutral_k, k0, k1)
            return w * m0 + (1.0 - w) * m1
    return nodes[-1][1]  # pragma: no cover


@dataclass
class Calibration:
    matrix: np.ndarray
    baseline_ev: float = 0.0
    illuminants: list | None = None  # [(K, 3x3)]
    huesat: np.ndarray | None = None  # (N, 2)
    data: dict | None = None
    path: str | None = None

    def matrix_for(self, neutral_k: float | None = None) -> np.ndarray:
        if neutral_k and self.illuminants:
            return interpolate_matrix(self.illuminants, float(neutral_k))
        return self.matrix

    def apply(self, linear_pp: np.ndarray, neutral_k: float | None = None) -> np.ndarray:
        m = self.matrix_for(neutral_k)
        out = C.apply_matrix(linear_pp, m)
        out = np.clip(out, 0.0, None)
        if self.huesat is not None:
            out = C.apply_huesat(out, self.huesat)
        return out

    def describe(self, neutral_k: float | None = None) -> dict:
        d = self.data or {}
        return {
            "path": os.path.abspath(self.path) if self.path else None,
            "version": d.get("version"),
            "baseVersion": d.get("baseVersion"),
            "baselineEV": round(float(self.baseline_ev), 6),
            "matrix": np.round(self.matrix_for(neutral_k), 6).tolist(),
            "neutralTemperatureK": None if not (neutral_k and self.illuminants) else float(neutral_k),
            "illuminants": None if not self.illuminants else [k for k, _ in self.illuminants],
            "hueSat": self.huesat is not None,
        }


def identity() -> Calibration:
    return Calibration(matrix=np.eye(3), baseline_ev=0.0, data={"schema": SCHEMA, "version": "identity"})


def from_dict(d: dict, path: str | None = None) -> Calibration:
    source = path or "calibration"
    if not isinstance(d, dict):
        raise ValueError(f"{source}: calibration must be an object")
    if d.get("schema") != SCHEMA:
        raise ValueError(f"{source}: schema must be {SCHEMA!r}, got {d.get('schema')!r}")
    mat = d.get("matrix")
    if not isinstance(mat, dict):
        raise ValueError(f"{source}: matrix is required")
    if "rowMajor" not in mat:
        raise ValueError(f"{source}: matrix.rowMajor is required")
    space = mat.get("space", "linear-prophoto-d50")
    if space != "linear-prophoto-d50":
        raise ValueError(f"{source}: matrix.space {space!r} is not supported (linear-prophoto-d50 only)")
    m = _matrix(mat["rowMajor"], f"{source}: matrix.rowMajor")
    ills = None
    if d.get("illuminants"):
        ills = []
        for index, e in enumerate(d["illuminants"]):
            if not isinstance(e, dict) or "matrix" not in e:
                raise ValueError(f"{source}: illuminants[{index}].matrix is required")
            mm = _matrix(e["matrix"], f"{source}: illuminants[{index}].matrix")
            ills.append((float(e["neutralTemperatureK"]), mm))
        ills.sort(key=lambda t: t[0])
    hs = None
    if d.get("hueSat"):
        h = d["hueSat"]
        if h.get("space", "linear-prophoto-hsv") != "linear-prophoto-hsv":
            raise ValueError(f"{path}: hueSat.space must be linear-prophoto-hsv")
        hs = np.asarray(h["entries"], dtype=np.float64)
        if hs.ndim != 2 or hs.shape[1] != 2 or len(hs) != int(h.get("hueDivisions", len(hs))):
            raise ValueError(f"{path}: hueSat.entries must be hueDivisions x [hueShiftDeg, satScale]")
    return Calibration(matrix=m, baseline_ev=float(d.get("baselineEV", 0.0) or 0.0),
                       illuminants=ills, huesat=hs, data=d, path=path)


def load(path: str) -> Calibration:
    return from_dict(read_json(path), path)
