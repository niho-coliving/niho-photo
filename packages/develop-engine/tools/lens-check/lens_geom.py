#!/usr/bin/env python3
"""レンズ補正の幾何の比較: 候補（Apple 現像 lens on/off・カメラ JPEG）を参照（LR 書き出し lens on/off）へ
相似変換（倍率＋平行移動）で合わせた後に残る局所ずれ（7x7 タイル）を、原寸 px で出す。

  python3 lens_geom.py <out.json> <label> <ref> <cand> <cand-space> [<label> <ref> <cand> <space> ...]

参照は sRGB の書き出し（Lightroom / カメラ JPEG）、候補は sRGB か線形（linear-prophoto など）。位置合わせは
colorcheck の align（輝度の帯域通過・タイルの位相相関）。残差は 7x7 タイルの局所ずれを原寸の長辺 px に直したもの。
"""
import os
import json
import sys

import numpy as np

sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "colorcheck"))
from colorcheck import align as A  # noqa: E402
from colorcheck import color as C  # noqa: E402
from colorcheck import imageops  # noqa: E402
from colorcheck import io as IO  # noqa: E402

N = 1500


def lum(path, space):
    im = IO.load_image(path)
    lin, sp = im.linear(space)
    full = max(im.raw.shape[:2])
    if sp == C.SPACE_SRGB:
        lin = C.srgb_decode(lin)
        sp = C.SPACE_LINEAR_SRGB
    y = C.luminance(lin, sp)
    return imageops.resize_long_edge(y[..., None], N)[..., 0], full


def measure(ref, cand, space):
    ry, rfull = lum(ref, "srgb")
    cy, _ = lum(cand, space)
    if cy.shape != ry.shape:
        cy = imageops.resize(cy[..., None], (ry.shape[1], ry.shape[0]))[..., 0]
    al = A.estimate(ry, cy)
    h, w = ry.shape
    warped, _ = imageops.warp_scale_shift(cy, al.scale, al.dx, al.dy, (h, w))
    cs, rs, ps = A._tile_shifts(A._bandpass_log(ry), A._bandpass_log(warped), grid=7, tile=0.2, max_frac=0.2, span=(0.08, 0.92))
    keep = ps >= A.TILE_PEAK
    f = rfull / N
    mag = np.hypot(rs[keep, 0], rs[keep, 1]) * f
    c = np.array([(w - 1) / 2, (h - 1) / 2])
    rho = np.hypot(*(cs[keep] - c).T) / np.hypot(w / 2, h / 2)
    outer = mag[rho >= 0.7]
    residual_rms = round(float(np.sqrt((mag ** 2).mean())), 1) if mag.size else None
    residual_max = round(float(mag.max()), 1) if mag.size else None
    return {"scale": round(al.scale, 5), "corr": round(al.corr, 4), "radialAccepted": al.radial is not None,
            "tiles": int(keep.sum()), "residualPxRms": residual_rms,
            "residualPxMax": residual_max,
            "outerPxMean": round(float(outer.mean()), 1) if outer.size else None, "fullResLongEdge": int(rfull)}


def main():
    if len(sys.argv) < 6 or (len(sys.argv) - 2) % 4:
        print(__doc__, file=sys.stderr)
        raise SystemExit(2)
    out, rest = sys.argv[1], sys.argv[2:]
    rows = []
    for i in range(0, len(rest), 4):
        label, ref, cand, space = rest[i:i + 4]
        r = {"label": label, **measure(ref, cand, space)}
        rows.append(r)
        rms = f"{r['residualPxRms']:.1f}px" if r["residualPxRms"] is not None else "n/a"
        maximum = f"{r['residualPxMax']:.1f}px" if r["residualPxMax"] is not None else "n/a"
        outer = f"{r['outerPxMean']:.1f}px" if r["outerPxMean"] is not None else "n/a"
        print(f"{label:44s} scale {r['scale']:.4f}  corr {r['corr']:.3f}  残差 RMS {rms}  最大 {maximum}  周辺平均 {outer}", flush=True)
    with open(out, "w", encoding="utf-8") as target:
        json.dump(rows, target, indent=1, ensure_ascii=False)


if __name__ == "__main__":
    main()
