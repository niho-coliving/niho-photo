#!/usr/bin/env python3
"""周辺減光の確かめ: 候補を参照へ位置合わせ（colorcheck の align）してから、半径の輪ごとに輝度の比（EV）を出す。

  python3 radial_ev.py <label> <ref> <cand> <cand-space> [<label> <ref> <cand> <space> ...]

中心の輪（半対角の 0〜0.2）との差で出すので、全体の明るさの違いは消える。周辺減光を直せていれば輪ごとの差は 0 に近い。
白飛び（参照か候補のどちらかが 0.98 以上）と黒つぶれ（0.02 以下）の画素は除く。
"""
import os
import sys

import numpy as np

sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "colorcheck"))
from colorcheck import align as A  # noqa: E402
from colorcheck import color as C  # noqa: E402
from colorcheck import imageops  # noqa: E402
from colorcheck import io as IO  # noqa: E402

N = 1500
RINGS = np.linspace(0.0, 1.0, 11)


def lum(path, space):
    im = IO.load_image(path)
    lin, sp = im.linear(space)
    if sp == C.SPACE_SRGB:
        lin = C.srgb_decode(lin)
        sp = C.SPACE_LINEAR_SRGB
    return imageops.resize_long_edge(C.luminance(lin, sp)[..., None], N)[..., 0]


def profile(ref, cand, space):
    ry = lum(ref, "srgb")
    cy = lum(cand, space)
    if cy.shape != ry.shape:
        cy = imageops.resize(cy[..., None], (ry.shape[1], ry.shape[0]))[..., 0]
    al = A.estimate(ry, cy)
    warped, valid = A.apply(cy[..., None], al, ry.shape)
    warped = warped[..., 0]
    h, w = ry.shape
    yy, xx = np.mgrid[0:h, 0:w]
    r = np.hypot(xx - (w - 1) / 2, yy - (h - 1) / 2) / np.hypot(w / 2, h / 2)
    ok = valid.astype(bool) & (ry > 0.02) & (ry < 0.98) & (warped > 0.02) & (warped < 0.98)
    # sRGB の参照は表示用のトーンが乗っているので、候補も同じ sRGB で比べる前提（crate の出力 JPEG 同士）
    ev = np.log2(np.maximum(warped, 1e-6) / np.maximum(ry, 1e-6))
    out = []
    for lo, hi in zip(RINGS[:-1], RINGS[1:]):
        m = ok & (r >= lo) & (r < hi)
        out.append(float(np.median(ev[m])) if m.sum() > 200 else float("nan"))
    base = out[0] if not np.isnan(out[0]) else out[1]
    return [v - base for v in out]


def main():
    rest = sys.argv[1:]
    if not rest or len(rest) % 4:
        print(__doc__, file=sys.stderr)
        raise SystemExit(2)
    print(f"{'':42s} " + " ".join(f"{lo:4.1f}-" for lo in RINGS[:-1]))
    for i in range(0, len(rest), 4):
        label, ref, cand, space = rest[i:i + 4]
        p = profile(ref, cand, space)
        print(f"{label:42s} " + " ".join("  -  " if np.isnan(v) else f"{v:+5.2f}" for v in p), flush=True)


if __name__ == "__main__":
    main()
