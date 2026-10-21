#!/usr/bin/env python3
"""How close any linear-light 3×3 gets to Lightroom's JPEG incremental WB (#27).

  python3 fit_linear_wb_3x3.py --repo <checkout> [--out <summary.json>]

For each measured variant of `calibration/jpeg-incremental-wb-v1.bin` (the
synthetic 17³ sRGB chart exported by Lightroom), the chart's input nodes and
their measured outputs are decoded to linear sRGB and one unconstrained 3×3 is
fitted (no white point, Bradford, CAT16 or diagonal restriction: every linear
chromatic adaptation is a special case of it):

- `leastSquares`: ordinary least squares in linear light;
- `minMeanDeltaE`: then Nelder–Mead on the mean CIEDE2000 itself (the best a
  3×3 can do on this chart's metric).

The prediction is clipped to [0, 1] and encoded like an 8-bit export, and
compared with the measured output by CIEDE2000 (mean / p99 over the 4,913
nodes). The calibrated delta LUT reproduces those measurements by
construction; the question is whether a linear model could replace it within
the single-WB gate (mean <= 0.5). Only the public chart measurement is read.
"""
from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

import numpy as np

sys.path.insert(0, str(Path(__file__).resolve().parent))
from round27_measure import LEVELS, LUT_VARIANTS, ciede2000, load_lut, srgb_to_lab  # noqa: E402


def eotf(encoded: np.ndarray) -> np.ndarray:
    v = encoded / 255.0
    return np.where(v <= 0.04045, v / 12.92, ((v + 0.055) / 1.055) ** 2.4)


def oetf(linear: np.ndarray) -> np.ndarray:
    v = np.clip(linear, 0.0, 1.0)
    return 255.0 * np.where(v <= 0.0031308, v * 12.92, 1.055 * v ** (1 / 2.4) - 0.055)


def stats(values: np.ndarray) -> dict:
    return {"mean": round(float(values.mean()), 4), "p99": round(float(np.percentile(values, 99)), 4)}


def main() -> int:
    from scipy.optimize import minimize

    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("--repo", type=Path, required=True)
    parser.add_argument("--out", type=Path)
    args = parser.parse_args()
    lut = load_lut(args.repo)
    nodes = np.stack(np.meshgrid(LEVELS, LEVELS, LEVELS, indexing="ij"), -1).reshape(-1, 3)
    rows = []
    for index, variant in enumerate(LUT_VARIANTS):
        measured = np.clip(nodes + lut[index].reshape(-1, 3), 0, 255)
        source, target = eotf(nodes), eotf(measured)
        lab = srgb_to_lab(measured)

        def error(matrix: np.ndarray) -> np.ndarray:
            return ciede2000(lab, srgb_to_lab(oetf(source @ matrix.reshape(3, 3))))

        least, *_ = np.linalg.lstsq(source, target, rcond=None)
        best = minimize(lambda m: error(m).mean(), least.ravel(), method="Nelder-Mead",
                        options={"maxiter": 4000, "xatol": 1e-6, "fatol": 1e-6}).x
        rows.append({"variant": variant, "leastSquares": stats(error(least.ravel())),
                     "minMeanDeltaE": stats(error(best))})
        print(f"{variant:9s} lsq {rows[-1]['leastSquares']}  minΔE {rows[-1]['minMeanDeltaE']}", flush=True)
    summary = {
        "kind": "synthetic-chart-linear-3x3-fit",
        "source": "calibration/jpeg-incremental-wb-v1.bin (17^3 nodes per variant)",
        "metric": "CIEDE2000 between the measured 8-bit output and the clipped, encoded 3x3 prediction",
        "gate": "single white balance mean <= 0.5",
        "rows": rows,
        "anyVariantWithinGate": any(r["minMeanDeltaE"]["mean"] <= 0.5 for r in rows),
    }
    text = json.dumps(summary, ensure_ascii=False, indent=2) + "\n"
    if args.out:
        args.out.write_text(text, encoding="utf-8")
    else:
        print(text)
    return 0


if __name__ == "__main__":
    sys.exit(main())
