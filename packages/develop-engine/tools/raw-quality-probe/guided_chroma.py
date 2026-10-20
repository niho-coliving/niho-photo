"""Local V2 chroma experiment after Stage 1; never used in production.

The input/output format is the existing linear-ProPhoto PNG16 working copy.
This is a research upper bound for wider edge-aware smoothing. It deliberately
does not claim that a browser implementation has the same speed or memory use.
"""

from __future__ import annotations

import argparse
import json
import time
from pathlib import Path

import cv2
import numpy as np


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--input", required=True, type=Path)
    parser.add_argument("--out", required=True, type=Path)
    parser.add_argument("--radius", type=int, default=3)
    parser.add_argument("--eps", type=float, default=0.001)
    args = parser.parse_args()
    if args.radius < 1 or not np.isfinite(args.eps) or args.eps <= 0:
        parser.error("radius must be >= 1 and eps must be finite and positive")
    if args.input.resolve() == args.out.resolve():
        parser.error("input and output must differ")
    if not hasattr(cv2, "ximgproc"):
        parser.error("opencv-contrib-python-headless is required")

    started = time.perf_counter()
    encoded = cv2.imread(str(args.input), cv2.IMREAD_UNCHANGED)
    if encoded is None or encoded.dtype != np.uint16 or encoded.ndim != 3 or encoded.shape[2] != 3:
        parser.error("input must be an RGB PNG16 working copy")
    rgb = 2.0 * np.power(encoded[:, :, ::-1].astype(np.float32) / 65535.0, 1.8)
    y = 0.2880402 * rgb[:, :, 0] + 0.7118741 * rgb[:, :, 1] + 0.0000857 * rgb[:, :, 2]
    green = np.maximum(rgb[:, :, 1], 1e-5)
    original = [
        np.log(np.maximum(rgb[:, :, 0], 1e-5) / green),
        np.log(np.maximum(rgb[:, :, 2], 1e-5) / green),
    ]

    # Joint guided filter uses all three linear channels to follow both
    # luminance and near-isoluminant color boundaries.
    guide = cv2.GaussianBlur(rgb, (0, 0), 1)
    filtered = [cv2.ximgproc.guidedFilter(guide, c, args.radius, args.eps) for c in original]

    # Preserve strong chroma transitions plus a two-pixel neighborhood. The
    # thresholds are exploratory constants, not a camera/ISO noise profile.
    edge = np.zeros(rgb.shape[:2], np.float32)
    for c in original:
        smooth = cv2.GaussianBlur(c, (0, 0), 2)
        gx = cv2.Sobel(smooth, cv2.CV_32F, 1, 0, ksize=3)
        gy = cv2.Sobel(smooth, cv2.CV_32F, 0, 1, ksize=3)
        edge = np.maximum(edge, np.hypot(gx, gy))
    mask = np.clip((edge - 0.12) / (0.28 - 0.12), 0, 1)
    mask = cv2.dilate(mask, cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (5, 5)))
    rg, bg = [f * (1 - mask) + c * mask for f, c in zip(filtered, original)]

    red_ratio = np.exp(np.clip(rg, -4, 4))
    blue_ratio = np.exp(np.clip(bg, -4, 4))
    base = y / (0.2880402 * red_ratio + 0.7118741 + 0.0000857 * blue_ratio)
    output = np.stack([base * red_ratio, base, base * blue_ratio], axis=2)
    code = np.uint16(np.clip(np.rint(np.power(np.clip(output, 0, 2) / 2, 1 / 1.8) * 65535), 0, 65535))
    args.out.parent.mkdir(parents=True, exist_ok=True)
    if not cv2.imwrite(str(args.out), code[:, :, ::-1]):
        raise OSError(f"cannot write {args.out}")
    elapsed_ms = (time.perf_counter() - started) * 1000
    metadata = {
        "schema": "niho-quality-probe.guided-chroma/1",
        "input": str(args.input),
        "output": str(args.out),
        "radius": args.radius,
        "eps": args.eps,
        "height": int(rgb.shape[0]),
        "width": int(rgb.shape[1]),
        "totalMs": round(elapsed_ms, 1),
    }
    args.out.with_suffix(".json").write_text(json.dumps(metadata, indent=2) + "\n", encoding="utf-8")
    print(json.dumps(metadata))


if __name__ == "__main__":
    main()
