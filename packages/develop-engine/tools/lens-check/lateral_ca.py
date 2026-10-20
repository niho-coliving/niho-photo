#!/usr/bin/env python3
"""倍率色収差の確かめ: R・B が G に対して半径方向にどれだけずれているかを、長辺 2560px（作業コピーの大きさ）の px で出す。

  python3 lateral_ca.py <label> <image> <space> [<label> <image> <space> ...]

space は sRGB の書き出し（`srgb`）か線形（`linear-prophoto` など）。線形の入力は linear sRGB へ変換してから比べる
（参照の書き出しと同じ原色でチャンネルを比べる）。64px のタイルごとに G と R / B の位相相関でずれを取り、
タイル中心の半径方向の成分を「ずれ = k × 半径 / 半対角」とみて、半径 0.5 より外のタイルの中央値で k（四隅でのずれ）を取る。
中心付近（半対角の 0.15 未満）・平坦なタイル・G または測定対象チャンネルに 0.999 以上の値を含むタイルは除く。
半径 0.5 より外の有効タイルが 20 未満なら測定不能にする。外側（半対角の 0.7 より外）の中央値も出す。
"""
import json
import os
import sys

import cv2
import numpy as np

sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "colorcheck"))
from colorcheck import color as C  # noqa: E402
from colorcheck import imageops  # noqa: E402
from colorcheck import io as IO  # noqa: E402

LONG_EDGE = 2560
TILE = 64
MIN_VALID_TILES = 20
MIN_FAR_TILES = 20
SATURATION_THRESHOLD = 0.999


def load(path, space):
    lin, sp = IO.load_image(path).linear(space)
    rgb = C.to_linear(lin, sp, C.SPACE_LINEAR_SRGB)
    rgb = imageops.resize_long_edge(np.clip(rgb, 0.0, None), LONG_EDGE)
    return (np.clip(rgb, 0.0, 1.0) ** (1 / 2.2)).astype(np.float32)


def refine(gp, cp, window, dx, dy, rounds=3):
    """phaseCorrelate のサブピクセル推定は 0 寄りに偏る（1.5px を 1.2px と出す）。推定分を戻して残りを測り直して足す。"""
    for _ in range(rounds):
        back = np.float32([[1, 0, dx], [0, 1, dy]])
        moved = cv2.warpAffine(cp, back, (cp.shape[1], cp.shape[0]), flags=cv2.INTER_CUBIC | cv2.WARP_INVERSE_MAP,
                               borderMode=cv2.BORDER_REFLECT)
        (rx, ry), _ = cv2.phaseCorrelate(gp, moved, window)
        dx, dy = dx + rx, dy + ry
        if abs(dx) > 4 or abs(dy) > 4:
            return None, None  # 発散（平坦に近いタイル）
        if abs(rx) < 0.01 and abs(ry) < 0.01:
            break
    return dx, dy


def radial_shift(img, channel, tile=TILE):
    """G に対する `channel` の半径方向のずれ（px）。有効タイルまたは外周タイルが 20 未満なら None。"""
    h, w = img.shape[:2]
    cy, cx = (h - 1) / 2, (w - 1) / 2
    half_diagonal = np.hypot(cx, cy)
    g = img[..., 1]
    c = img[..., channel]
    window = cv2.createHanningWindow((tile, tile), cv2.CV_32F)
    rows = []
    for y in range(0, h - tile + 1, tile // 2):
        for x in range(0, w - tile + 1, tile // 2):
            gp = np.ascontiguousarray(g[y:y + tile, x:x + tile])
            cp = np.ascontiguousarray(c[y:y + tile, x:x + tile])
            gx = cv2.Sobel(gp, cv2.CV_32F, 1, 0)
            gy = cv2.Sobel(gp, cv2.CV_32F, 0, 1)
            if (
                float(np.mean(gx * gx + gy * gy)) < 2e-3
                or gp.mean() > 0.95
                or np.any(gp >= SATURATION_THRESHOLD)
                or np.any(cp >= SATURATION_THRESHOLD)
            ):
                continue
            (dx, dy), response = cv2.phaseCorrelate(gp, cp, window)
            if response < 0.3 or abs(dx) > 4 or abs(dy) > 4:
                continue
            dx, dy = refine(gp, cp, window, dx, dy)
            if dx is None:
                continue
            px, py = x + tile / 2 - cx, y + tile / 2 - cy
            r = np.hypot(px, py)
            if r < 0.15 * half_diagonal:
                continue
            rows.append((r / half_diagonal, (dx * px + dy * py) / r))
    if len(rows) < MIN_VALID_TILES:
        return None
    a = np.array(rows)
    # ずれ = k × 半径。外れ値（繰り返し模様・動いた被写体）に強いよう、半径 0.5 より外のタイルの ずれ / 半径 の中央値で取る
    far = a[a[:, 0] > 0.5]
    if len(far) < MIN_FAR_TILES:
        return None
    k = float(np.median(far[:, 1] / far[:, 0]))
    outer = a[a[:, 0] > 0.7, 1]
    return {
        "tiles": len(rows),
        "cornerPx": round(k, 2),
        "outerMedianPx": round(float(np.median(outer)), 2) if len(outer) else None,
    }


def measure(path, space):
    img = load(path, space)
    return {"red": radial_shift(img, 0), "blue": radial_shift(img, 2)}


def main(argv):
    if not argv or len(argv) % 3:
        print(__doc__, file=sys.stderr)
        return 2
    out = []
    for i in range(0, len(argv), 3):
        label, path, space = argv[i:i + 3]
        out.append({"label": label, "path": os.path.basename(path), **measure(path, space)})
    print(json.dumps(out, ensure_ascii=False, indent=1))
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
