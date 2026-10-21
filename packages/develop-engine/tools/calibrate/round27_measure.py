#!/usr/bin/env python3
"""Compare JPEG white balance placements against the round27 Lightroom exports (#27).

  python3 round27_measure.py --round <round27-dir> --repo <checkout> --engine niho-10 \
      --out <private-work-dir> [--summary <public-summary.json>]

For every white balance × edit variant of `make_lr_round27.py`:

- tail: NIHO renders the chart with the relative white balance where the
  engine applies it today (the measured delta LUT on the encoded output).
- head: the same measured delta LUT is applied to the encoded input first
  (float, written as a 16-bit PNG), then NIHO renders the other edits with the
  white balance zeroed. This is the placement Lightroom's processing order
  suggests, using the same measurement, so the single-WB accuracy is unchanged.

Each 12 px patch is compared on its inner 6×6 pixels (CIEDE2000 on the mean
sRGB of the patch). Patch interiors avoid JPEG and resampling edges. The
summary contains only the synthetic chart's aggregate numbers.
"""
from __future__ import annotations

import argparse
import json
import subprocess
import sys
from pathlib import Path

import numpy as np

LUT_VARIANTS = ["temp_m80", "temp_m30", "temp_p30", "temp_p80", "tint_m50", "tint_m20", "tint_p20", "tint_p50",
                "wb_cool", "wb_warm"]
LEVELS = np.array([round(i * 255 / 16) for i in range(17)], dtype=np.float64)


def load_lut(repo: Path) -> np.ndarray:
    raw = (repo / "packages/develop-engine/calibration/jpeg-incremental-wb-v1.bin").read_bytes()
    return np.frombuffer(raw, dtype="<i2").reshape(10, 17, 17, 17, 3).astype(np.float64) / 16.0


def _axis(weights: dict[str, float], value: float, knots, names) -> None:
    segment = 0 if value < knots[1] else 1 if value < knots[2] else 2 if value <= knots[3] else 3
    fraction = (value - knots[segment]) / (knots[segment + 1] - knots[segment])
    for name, weight in ((names[segment], 1 - fraction), (names[segment + 1], fraction)):
        if name:
            weights[name] = weights.get(name, 0.0) + weight


def parameter_weights(temperature: float, tint: float) -> dict[str, float]:
    """`jpeg_wb.rs::parameter_weights` (same knots, extrapolation and pair residual)."""
    weights: dict[str, float] = {}
    _axis(weights, temperature, [-80, -30, 0, 30, 80], ["temp_m80", "temp_m30", None, "temp_p30", "temp_p80"])
    _axis(weights, tint, [-50, -20, 0, 20, 50], ["tint_m50", "tint_m20", None, "tint_p20", "tint_p50"])
    if temperature * tint > 0:
        amount = min(abs(temperature) / 30, 1) * min(abs(tint) / 20, 1)
        combo, t_axis, g_axis = (("wb_cool", "temp_m30", "tint_m20") if temperature < 0
                                 else ("wb_warm", "temp_p30", "tint_p20"))
        weights[combo] = weights.get(combo, 0.0) + amount
        weights[t_axis] = weights.get(t_axis, 0.0) - amount
        weights[g_axis] = weights.get(g_axis, 0.0) - amount
    return weights


def apply_head(rgb: np.ndarray, lut: np.ndarray, temperature: float, tint: float) -> np.ndarray:
    """Encoded RGB (0..255 float) + trilinear measured delta, without rounding."""
    if temperature == 0 and tint == 0:
        return rgb.copy()
    cube = np.zeros((17, 17, 17, 3))
    for name, weight in parameter_weights(temperature, tint).items():
        cube += weight * lut[LUT_VARIANTS.index(name)]
    low = np.clip(np.searchsorted(LEVELS, rgb, side="right") - 1, 0, 15)
    frac = (rgb - LEVELS[low]) / (LEVELS[low + 1] - LEVELS[low])
    out = np.zeros_like(rgb)
    for dr in (0, 1):
        wr = frac[..., 0] if dr else 1 - frac[..., 0]
        for dg in (0, 1):
            wg = frac[..., 1] if dg else 1 - frac[..., 1]
            for db in (0, 1):
                wb = frac[..., 2] if db else 1 - frac[..., 2]
                node = cube[low[..., 0] + dr, low[..., 1] + dg, low[..., 2] + db]
                out += (wr * wg * wb)[..., None] * node
    return np.clip(rgb + out, 0, 255)


def srgb_to_lab(rgb: np.ndarray) -> np.ndarray:
    v = rgb / 255.0
    lin = np.where(v <= 0.04045, v / 12.92, ((v + 0.055) / 1.055) ** 2.4)
    m = np.array([[0.4124564, 0.3575761, 0.1804375], [0.2126729, 0.7151522, 0.0721750],
                  [0.0193339, 0.1191920, 0.9503041]])
    t = (lin @ m.T) / np.array([0.95047, 1.0, 1.08883])
    f = np.where(t > (6 / 29) ** 3, np.cbrt(t), t / (3 * (6 / 29) ** 2) + 4 / 29)
    return np.stack([116 * f[..., 1] - 16, 500 * (f[..., 0] - f[..., 1]), 200 * (f[..., 1] - f[..., 2])], -1)


def ciede2000(lab1: np.ndarray, lab2: np.ndarray) -> np.ndarray:
    L1, a1, b1 = np.moveaxis(lab1, -1, 0)
    L2, a2, b2 = np.moveaxis(lab2, -1, 0)
    cbar = (np.hypot(a1, b1) + np.hypot(a2, b2)) / 2
    g = 0.5 * (1 - np.sqrt(cbar ** 7 / (cbar ** 7 + 25 ** 7)))
    a1p, a2p = (1 + g) * a1, (1 + g) * a2
    c1p, c2p = np.hypot(a1p, b1), np.hypot(a2p, b2)
    h1 = np.degrees(np.arctan2(b1, a1p)) % 360
    h2 = np.degrees(np.arctan2(b2, a2p)) % 360
    dh = h2 - h1
    dh = np.where(dh > 180, dh - 360, np.where(dh < -180, dh + 360, dh))
    dh = np.where(c1p * c2p == 0, 0, dh)
    d_hp = 2 * np.sqrt(c1p * c2p) * np.sin(np.radians(dh / 2))
    lbar, cbarp = (L1 + L2) / 2, (c1p + c2p) / 2
    hsum = h1 + h2
    hbar = np.where(np.abs(h1 - h2) > 180, np.where(hsum < 360, (hsum + 360) / 2, (hsum - 360) / 2), hsum / 2)
    hbar = np.where(c1p * c2p == 0, hsum, hbar)
    t = (1 - 0.17 * np.cos(np.radians(hbar - 30)) + 0.24 * np.cos(np.radians(2 * hbar))
         + 0.32 * np.cos(np.radians(3 * hbar + 6)) - 0.20 * np.cos(np.radians(4 * hbar - 63)))
    dtheta = 30 * np.exp(-((hbar - 275) / 25) ** 2)
    rc = 2 * np.sqrt(cbarp ** 7 / (cbarp ** 7 + 25 ** 7))
    sl = 1 + 0.015 * (lbar - 50) ** 2 / np.sqrt(20 + (lbar - 50) ** 2)
    sc, sh = 1 + 0.045 * cbarp, 1 + 0.015 * cbarp * t
    rt = -np.sin(np.radians(2 * dtheta)) * rc
    dl, dc = (L2 - L1) / sl, (c2p - c1p) / sc
    dhh = d_hp / sh
    return np.sqrt(dl ** 2 + dc ** 2 + dhh ** 2 + rt * dc * dhh)


def read_rgb(path: Path) -> np.ndarray:
    from PIL import Image, ImageCms

    with Image.open(path) as image:
        icc = image.info.get("icc_profile")
        if icc:
            source = ImageCms.ImageCmsProfile(__import__("io").BytesIO(icc))
            target = ImageCms.ImageCmsProfile(ImageCms.createProfile("sRGB"))
            image = ImageCms.profileToProfile(image, source, target, outputMode="RGB")
        return np.asarray(image.convert("RGB"), dtype=np.float64)


def patch_means(rgb: np.ndarray, chart: dict) -> np.ndarray:
    patch, columns, count = chart["patch"], chart["columns"], chart["count"]
    lo, hi = patch // 4, patch - patch // 4
    out = np.empty((count, 3))
    for index in range(count):
        x, y = (index % columns) * patch, (index // columns) * patch
        out[index] = rgb[y + lo:y + hi, x + lo:x + hi].reshape(-1, 3).mean(0)
    return out


def render(binary: Path, settings: Path, source: Path, destination: Path) -> None:
    destination.parent.mkdir(parents=True, exist_ok=True)
    result = subprocess.run([str(binary), "render", "--settings", str(settings), "--out", str(destination),
                             "--raster", str(source)], capture_output=True, text=True)
    if result.returncode:
        raise SystemExit(f"render failed: {destination.name}: {result.stdout.strip()}")


def stats(values: np.ndarray) -> dict:
    return {"mean": round(float(values.mean()), 4), "p99": round(float(np.percentile(values, 99)), 4),
            "max": round(float(values.max()), 4)}


def main() -> int:
    import cv2

    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("--round", type=Path, required=True)
    parser.add_argument("--repo", type=Path, required=True)
    parser.add_argument("--engine", required=True)
    parser.add_argument("--out", type=Path, required=True)
    parser.add_argument("--summary", type=Path)
    args = parser.parse_args()
    manifest = json.loads((args.round / "manifest.json").read_text(encoding="utf-8"))
    chart = manifest["chart"]
    engine_dir = args.repo / "packages/develop-engine"
    binary = engine_dir / "target/release/niho-develop-render"
    settings_dir = args.out / "settings" / args.engine
    subprocess.run([str(engine_dir / "target/release/examples/round27_settings"), str(args.round / "manifest.json"),
                    args.engine, str(settings_dir)], check=True)
    lut = load_lut(args.repo)
    base = args.round / "base-chart.jpg"
    base_rgb = read_rgb(base)
    head_inputs: dict[tuple[float, float], Path] = {}
    rows = []
    for entry in manifest["variants"]:
        variant = entry["variant"]
        white = json.loads((settings_dir / f"{variant}.white.json").read_text())
        key = (white["temperature"], white["tint"])
        if key not in head_inputs:
            encoded = apply_head(base_rgb, lut, *key)
            path = args.out / "head-inputs" / f"t{key[0]:+g}_g{key[1]:+g}.png"
            path.parent.mkdir(parents=True, exist_ok=True)
            sixteen = np.round(encoded / 255.0 * 65535).astype(np.uint16)
            cv2.imwrite(str(path), sixteen[..., ::-1])
            head_inputs[key] = path
        tail_png = args.out / "renders" / args.engine / "tail" / f"{variant}.png"
        head_png = args.out / "renders" / args.engine / "head" / f"{variant}.png"
        render(binary, settings_dir / f"{variant}.tail.json", base, tail_png)
        render(binary, settings_dir / f"{variant}.head.json", head_inputs[key], head_png)
        reference = patch_means(read_rgb(args.round / "lr-export" / entry["file"]), chart)
        lab_ref = srgb_to_lab(reference)
        tail = ciede2000(lab_ref, srgb_to_lab(patch_means(read_rgb(tail_png), chart)))
        head = ciede2000(lab_ref, srgb_to_lab(patch_means(read_rgb(head_png), chart)))
        rows.append({"variant": variant, "whiteBalance": entry["whiteBalance"], "edit": entry["edit"],
                     "temperature": key[0], "tint": key[1], "tail": stats(tail), "head": stats(head)})
        print(f"{variant:28s} tail {tail.mean():6.3f}/{np.percentile(tail, 99):6.3f}  "
              f"head {head.mean():6.3f}/{np.percentile(head, 99):6.3f}", flush=True)
    by_edit = {}
    for row in rows:
        by_edit.setdefault(row["edit"], {})[row["whiteBalance"]] = row
    interaction = []
    for edit, cells in by_edit.items():
        alone = cells["w0"]
        for wb, row in cells.items():
            if wb == "w0":
                continue
            interaction.append({"edit": edit, "whiteBalance": wb,
                                "tailMeanIncrease": round(row["tail"]["mean"] - alone["tail"]["mean"], 4),
                                "headMeanIncrease": round(row["head"]["mean"] - alone["head"]["mean"], 4),
                                "tailP99": row["tail"]["p99"], "headP99": row["head"]["p99"]})
    with_wb = [r for r in rows if r["whiteBalance"] != "w0"]
    summary = {
        "kind": "synthetic-chart-lightroom-round27",
        "engine": args.engine,
        "protocol": {"patch": chart["patch"], "inner": chart["patch"] - 2 * (chart["patch"] // 4),
                     "metric": "CIEDE2000 of patch-mean sRGB", "patches": chart["count"]},
        "rows": rows,
        "interaction": interaction,
        "withWhiteBalance": {
            "variants": len(with_wb),
            "tailMeanOfMeans": round(float(np.mean([r["tail"]["mean"] for r in with_wb])), 4),
            "headMeanOfMeans": round(float(np.mean([r["head"]["mean"] for r in with_wb])), 4),
            "tailP99Max": max(r["tail"]["p99"] for r in with_wb),
            "headP99Max": max(r["head"]["p99"] for r in with_wb),
            "headBetterMean": sum(r["head"]["mean"] < r["tail"]["mean"] for r in with_wb),
            "headBetterP99": sum(r["head"]["p99"] < r["tail"]["p99"] for r in with_wb),
        },
    }
    text = json.dumps(summary, ensure_ascii=False, indent=2) + "\n"
    (args.out / f"round27-{args.engine}.json").write_text(text, encoding="utf-8")
    if args.summary:
        args.summary.write_text(text, encoding="utf-8")
    print(json.dumps(summary["withWhiteBalance"], ensure_ascii=False))
    return 0


if __name__ == "__main__":
    sys.exit(main())
