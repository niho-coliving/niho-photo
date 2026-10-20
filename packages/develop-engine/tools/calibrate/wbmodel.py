"""Adobe / DNG の色温度モデル（Robertson 等温線）と Bradford 色順応。段 2 の crate（niho-develop `color.rs`）と同じ定数・同じ式。

- `xy_from_temperature(K, tint)`: DNG SDK `dng_temperature` の LegacyGetXY（tint は uv 距離 × −3000）。
- `temperature_from_xy(x, y)`: 同 `Set_xy_coord` の逆変換。
- `wb_matrix_prophoto(as_shot_xy, target_xy)`: crate の `raw_white_balance_prophoto` と同じ、linear ProPhoto に掛ける 3×3。

xy は CIE 1931。uv は CIE 1960。
"""
from __future__ import annotations

import numpy as np

TEMP_TABLE = [  # (mired, u, v, slope)
    (0.0, 0.18006, 0.26352, -0.24341), (10.0, 0.18066, 0.26589, -0.25479), (20.0, 0.18133, 0.26846, -0.26876),
    (30.0, 0.18208, 0.27119, -0.28539), (40.0, 0.18293, 0.27407, -0.30470), (50.0, 0.18388, 0.27709, -0.32675),
    (60.0, 0.18494, 0.28021, -0.35156), (70.0, 0.18611, 0.28342, -0.37915), (80.0, 0.18740, 0.28668, -0.40955),
    (90.0, 0.18880, 0.28997, -0.44278), (100.0, 0.19032, 0.29326, -0.47888), (125.0, 0.19462, 0.30141, -0.58204),
    (150.0, 0.19962, 0.30921, -0.70471), (175.0, 0.20525, 0.31647, -0.84901), (200.0, 0.21142, 0.32312, -1.0182),
    (225.0, 0.21807, 0.32909, -1.2168), (250.0, 0.22511, 0.33439, -1.4512), (275.0, 0.23247, 0.33904, -1.7298),
    (300.0, 0.24010, 0.34308, -2.0637), (325.0, 0.24702, 0.34655, -2.4681), (350.0, 0.25591, 0.34951, -2.9641),
    (375.0, 0.26400, 0.35200, -3.5814), (400.0, 0.27218, 0.35407, -4.3633), (425.0, 0.28039, 0.35577, -5.3762),
    (450.0, 0.28863, 0.35714, -6.7262), (475.0, 0.29685, 0.35823, -8.5955), (500.0, 0.30505, 0.35907, -11.324),
    (525.0, 0.31320, 0.35968, -15.628), (550.0, 0.32129, 0.36011, -23.325), (575.0, 0.32931, 0.36038, -40.770),
    (600.0, 0.33724, 0.36051, -116.45),
]
TINT_SCALE = -3000.0
D50_XY = (0.3457, 0.3585)
PROPHOTO_TO_XYZ_D50 = np.array([[0.7977, 0.1352, 0.0313], [0.2880, 0.7119, 0.0001], [0.0, 0.0, 0.8249]])
XYZ_D50_TO_PROPHOTO = np.linalg.inv(PROPHOTO_TO_XYZ_D50)
BRADFORD = np.array([[0.8951, 0.2664, -0.1614], [-0.7502, 1.7135, 0.0367], [0.0389, -0.0685, 1.0296]])
BRADFORD_INV = np.linalg.inv(BRADFORD)


def xy_from_temperature(temperature: float, tint: float) -> tuple[float, float]:
    r = 1.0e6 / max(float(temperature), 2000.0)
    offset = float(tint) / TINT_SCALE
    n = len(TEMP_TABLE)
    for index in range(n - 1):
        if not (r < TEMP_TABLE[index + 1][0] or index == n - 2):
            continue
        a, b = TEMP_TABLE[index], TEMP_TABLE[index + 1]
        f = (b[0] - r) / (b[0] - a[0])
        u = a[1] * f + b[1] * (1.0 - f)
        v = a[2] * f + b[2] * (1.0 - f)
        len1 = np.sqrt(1.0 + a[3] * a[3])
        len2 = np.sqrt(1.0 + b[3] * b[3])
        uu1, vv1 = 1.0 / len1, a[3] / len1
        uu2, vv2 = 1.0 / len2, b[3] / len2
        uu3 = uu1 * f + uu2 * (1.0 - f)
        vv3 = vv1 * f + vv2 * (1.0 - f)
        len3 = np.sqrt(uu3 * uu3 + vv3 * vv3)
        uu3 /= len3
        vv3 /= len3
        u += uu3 * offset
        v += vv3 * offset
        return 1.5 * u / (u - 4.0 * v + 2.0), v / (u - 4.0 * v + 2.0)
    return D50_XY


def temperature_from_xy(x: float, y: float) -> tuple[float, float]:
    """DNG SDK `dng_temperature::Set_xy_coord`: (temperature K, tint) of a chromaticity."""
    u = 2.0 * x / (1.5 - x + 6.0 * y)
    v = 3.0 * y / (1.5 - x + 6.0 * y)
    last_dt = last_du = last_dv = 0.0
    for index in range(1, len(TEMP_TABLE)):
        du, dv = 1.0, TEMP_TABLE[index][3]
        ln = np.sqrt(1.0 + dv * dv)
        du /= ln
        dv /= ln
        uu = u - TEMP_TABLE[index][1]
        vv = v - TEMP_TABLE[index][2]
        dt = -uu * dv + vv * du
        if dt <= 0.0 or index == len(TEMP_TABLE) - 1:
            dt = -min(dt, 0.0)
            f = 0.0 if index == 1 else dt / (last_dt + dt)
            temperature = 1.0e6 / (TEMP_TABLE[index - 1][0] * f + TEMP_TABLE[index][0] * (1.0 - f))
            uu = u - (TEMP_TABLE[index - 1][1] * f + TEMP_TABLE[index][1] * (1.0 - f))
            vv = v - (TEMP_TABLE[index - 1][2] * f + TEMP_TABLE[index][2] * (1.0 - f))
            du = du * (1.0 - f) + last_du * f
            dv = dv * (1.0 - f) + last_dv * f
            ln = np.sqrt(du * du + dv * dv)
            du /= ln
            dv /= ln
            tint = (uu * du + vv * dv) * TINT_SCALE
            return float(temperature), float(tint)
        last_dt, last_du, last_dv = dt, du, dv
    return float("nan"), float("nan")


def xy_to_xyz(xy) -> np.ndarray:
    x, y = xy
    return np.array([x / y, 1.0, (1.0 - x - y) / y])


def bradford_xyz(from_xy, to_xy) -> np.ndarray:
    s = BRADFORD @ xy_to_xyz(from_xy)
    d = BRADFORD @ xy_to_xyz(to_xy)
    return BRADFORD_INV @ np.diag(d / s) @ BRADFORD


CAT02 = np.array([[0.7328, 0.4296, -0.1624], [-0.7036, 1.6975, 0.0061], [0.0030, 0.0136, 0.9834]])
CAT_MATRICES = {"bradford": BRADFORD, "cat02": CAT02, "xyz": np.eye(3)}


def cat_xyz(from_xy, to_xy, cat: str = "bradford") -> np.ndarray:
    """XYZ の色順応行列（白 from → to）。cat = bradford | cat02 | xyz（XYZ の対角 = 素の von Kries）。"""
    m = CAT_MATRICES[cat]
    s = m @ xy_to_xyz(from_xy)
    d = m @ xy_to_xyz(to_xy)
    return np.linalg.inv(m) @ np.diag(d / s) @ m


def wb_matrix_prophoto(as_shot_xy, target_xy, cat: str = "bradford") -> np.ndarray:
    """crate `raw_white_balance_prophoto`: 撮影時の白 as_shot で中性化済みの linear ProPhoto を、目標の白 target で描き直す行列。

    cat: bradford（crate と同じ）| cat02 | xyz | diag-prophoto（Bradford の白の写りだけを対角で真似る。カメラ RGB の倍率の代用）
    """
    if cat == "diag-prophoto":
        full = wb_matrix_prophoto(as_shot_xy, target_xy, "bradford")
        return np.diag(full @ np.ones(3))
    to_scene = cat_xyz(D50_XY, as_shot_xy, cat)
    to_new = cat_xyz(target_xy, D50_XY, cat)
    return XYZ_D50_TO_PROPHOTO @ (to_new @ to_scene) @ PROPHOTO_TO_XYZ_D50


if __name__ == "__main__":
    import sys
    if len(sys.argv) == 3:
        x, y = float(sys.argv[1]), float(sys.argv[2])
        print("xy → (K, tint):", temperature_from_xy(x, y))
    k, t = 5001.0, 10.0
    xy = xy_from_temperature(k, t)
    print(f"K {k} tint {t} → xy {xy} → back {temperature_from_xy(*xy)}")
