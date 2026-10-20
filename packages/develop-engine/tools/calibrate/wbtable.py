#!/usr/bin/env python3
"""白の行列の表（`niho-develop-wb-table/v1`・S11 #17108）の参照実装。crate と apple-raw-linear の自己点検が同じ式を使う。

Apple の RAW 現像（CIRAWFilter・boost 0 の線形出力）は、色域の圧縮（`isGamutMappingEnabled`）を切ると、同じ RAW を白 w で
描いた出力が `out(w) = M(w) · out(基準の白)` とちょうど 3×3 で書け、`M(w)` は機種と白だけで決まる（写真によらない）。
色温度が同じなら tint の違いはカメラの色空間での対角の倍率になる（DNG と同じ形）ので、倍率の逆数（カメラが見た白）に
線形な `M(w)` の逆行列を補間する。

表（校正 JSON の `whiteBalanceTable`。作業コピーのメタにも写す）:

    {"schema": "niho-develop-wb-table/v1", "space": "apple-linear-prophoto-d50", "scale": "lightroom",
     "reference": {"temperature": 5000, "tint": 0},
     "mired": [...昇順], "tint": [...昇順],
     "inverseMatrices": [[9 個（行優先の M(w) の逆行列）], ...],   # 節点 (i_mired, i_tint) の添字 = i_mired * len(tint) + i_tint
     "measured": {...}}

- 白は Lightroom の尺度の（K, tint）。ミレッド = 1e6 / K。格子の外は端に丸める。
- `I(w)` = 逆行列の双線形補間（成分ごと）、`M(w) = I(w)^-1`。白 a で描いた Apple の出力を白 b にする行列 = `M(b) · I(a)`。
- 作業コピー（Apple の出力に機種別補正 `C` を掛けたもの）を撮影時の白 w0 から目標の白 w1 にする行列 = `C · M(w1) · I(w0) · C^-1`。
"""
from __future__ import annotations

import json
import re

import numpy as np

SCHEMA = "niho-develop-wb-table/v1"
SPACE = "apple-linear-prophoto-d50"
SCALE = "lightroom"
# 格子: ミレッド 20 刻み（2000〜50000K）× tint は 0 の近くを細かく（逆行列の補間で節点の間 ΔE00 平均 0.02〜0.04・最大 0.2〜0.3）
DEFAULT_MIRED = [float(m) for m in range(20, 501, 20)]
DEFAULT_TINT = [-150.0, -110.0, -80.0, -55.0, -35.0, -20.0, -10.0, 0.0, 10.0, 20.0, 35.0, 55.0, 80.0, 110.0, 150.0]
REFERENCE = {"temperature": 5000.0, "tint": 0.0}


def require_single_illuminant_for_table(calibration: dict, context: str) -> None:
    """The table's working-copy formula carries only one calibration matrix."""
    illuminants = calibration.get("illuminants")
    if illuminants is not None and not isinstance(illuminants, list):
        raise ValueError(f"{context}: illuminants must be an array or null")
    if isinstance(illuminants, list) and len(illuminants) > 1:
        raise ValueError(
            f"{context}: whiteBalanceTable is supported only with a single calibration matrix; "
            "multiple illuminants need WB-specific calibration matrices"
        )


class WhiteBalanceTable:
    def __init__(self, d: dict):
        if d.get("schema") != SCHEMA or d.get("space") != SPACE or d.get("scale") != SCALE:
            raise ValueError(f"whiteBalanceTable must be {SCHEMA} / {SPACE} / {SCALE}")
        self.mired = np.asarray(d["mired"], dtype=np.float64)
        self.tint = np.asarray(d["tint"], dtype=np.float64)
        for name, grid in (("mired", self.mired), ("tint", self.tint)):
            if grid.ndim != 1 or len(grid) < 2 or not np.all(np.isfinite(grid)) or not np.all(np.diff(grid) > 0):
                raise ValueError(f"whiteBalanceTable.{name} must be a strictly ascending list of >= 2 finite numbers")
        if not np.all(self.mired > 0):
            raise ValueError("whiteBalanceTable.mired must be positive")
        inv = np.asarray(d["inverseMatrices"], dtype=np.float64)
        if inv.shape != (len(self.mired) * len(self.tint), 9) or not np.all(np.isfinite(inv)):
            raise ValueError("whiteBalanceTable.inverseMatrices must hold len(mired) * len(tint) rows of 9 finite numbers")
        self.inverse_matrices = inv.reshape(len(self.mired), len(self.tint), 3, 3)
        if np.any(np.abs(np.linalg.det(self.inverse_matrices)) <= 1e-9):
            raise ValueError("whiteBalanceTable.inverseMatrices contains a singular matrix")
        self.reference = dict(d.get("reference") or REFERENCE)
        self.raw = d

    @staticmethod
    def _cell(grid: np.ndarray, value: float) -> tuple[int, float]:
        v = float(np.clip(value, grid[0], grid[-1]))
        i = int(np.clip(np.searchsorted(grid, v, side="right") - 1, 0, len(grid) - 2))
        return i, (v - grid[i]) / (grid[i + 1] - grid[i])

    def inverse(self, temperature: float, tint: float) -> np.ndarray:
        """`I(w)`: 逆行列の双線形補間。"""
        i, a = self._cell(self.mired, 1e6 / float(temperature))
        j, b = self._cell(self.tint, float(tint))
        q = self.inverse_matrices
        return ((1 - a) * (1 - b) * q[i, j] + a * (1 - b) * q[i + 1, j]
                + (1 - a) * b * q[i, j + 1] + a * b * q[i + 1, j + 1])

    def matrix(self, temperature: float, tint: float) -> np.ndarray:
        """`M(w)`: 基準の白で描いた Apple の出力 → 白 w で描いた出力。"""
        return np.linalg.inv(self.inverse(temperature, tint))

    def transfer(self, a: tuple[float, float], b: tuple[float, float]) -> np.ndarray:
        """白 a で描いた Apple の出力 → 白 b で描いた出力（`M(b) · I(a)`）。"""
        return self.matrix(*b) @ self.inverse(*a)

    def working_copy_transfer(self, calibration: np.ndarray, as_shot: tuple[float, float],
                              target: tuple[float, float]) -> np.ndarray:
        """作業コピー（機種別補正 `calibration` 済み）を撮影時の白から目標の白へ（`C · M(w1) · I(w0) · C^-1`）。"""
        c = np.asarray(calibration, dtype=np.float64).reshape(3, 3)
        return c @ self.transfer(as_shot, target) @ np.linalg.inv(c)


def build(mired, tint, inverse_matrices, measured: dict, reference: dict | None = None) -> dict:
    """計測した逆行列から表の JSON を作る（`inverse_matrices` は [i_mired][i_tint] の 3×3）。"""
    inv = np.asarray(inverse_matrices, dtype=np.float64).reshape(len(mired) * len(tint), 9)
    d = {"schema": SCHEMA, "space": SPACE, "scale": SCALE, "reference": dict(reference or REFERENCE),
         "mired": [float(m) for m in mired], "tint": [float(t) for t in tint],
         "inverseMatrices": [[round(float(v), 6) for v in row] for row in inv], "measured": measured}
    WhiteBalanceTable(d)  # validate
    return d


_NUMBER_ARRAY = re.compile(r"\[\s*(-?[\d.eE+-]+(?:\s*,\s*-?[\d.eE+-]+)*)\s*\]")


def dumps(obj) -> str:
    """indent=1 の JSON。数だけの配列は 1 行にする（表の逆行列 375 個が 1 行ずつになり、校正 JSON を読める長さに保つ）。"""
    text = json.dumps(obj, ensure_ascii=False, indent=1)
    return _NUMBER_ARRAY.sub(lambda m: "[" + ", ".join(s.strip() for s in m.group(1).split(",")) + "]", text) + "\n"


def uv_from_xy(x: float, y: float) -> tuple[float, float]:
    d = -2.0 * x + 12.0 * y + 3.0
    return 4.0 * x / d, 6.0 * y / d


def xy_from_uv(u: float, v: float) -> tuple[float, float]:
    d = 2.0 * u - 8.0 * v + 4.0
    return 3.0 * u / d, 2.0 * v / d


def lightroom_to_apple(xy: tuple[float, float], white_balance_map: dict | None) -> tuple[float, float]:
    """Lightroom の尺度の白の xy → Apple の白の xy（校正の `whiteBalanceMap` の逆。無ければそのまま）。"""
    if not white_balance_map or white_balance_map.get("model") != "uv-offset":
        return xy
    u, v = uv_from_xy(*xy)
    return xy_from_uv(u - float(white_balance_map["du"]), v - float(white_balance_map["dv"]))
