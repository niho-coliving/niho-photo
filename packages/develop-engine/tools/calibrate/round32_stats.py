#!/usr/bin/env python3
"""Detail statistics of a round32 chart render (#32): edges, gratings, noise.

  python3 round32_stats.py measure <manifest.json> <image> [<image> ...]
  python3 round32_stats.py collect <manifest.json> --pattern '<dir>/{variant}.png' --out <stats.json>
  python3 round32_stats.py compare --lightroom <detail-round32-lightroom.json> \\
      --after <niho-stats.json> [--before <niho-stats.json>] --out <errors.json>

`measure` prints one JSON object per image (`<manifest.json> <image>...` without
the word `measure` is the same):
- edges: 10-90% rise width (px) and overshoot / undershoot (code values) of
  the luma profile across each step edge (rows averaged, 40 px margin from
  region tops).
- gratings: peak-to-peak luma amplitude / input amplitude per period.
- noise: luma std and chroma (Cb, Cr) std per flat patch (inner 60%).
Luma and chroma are Rec.601 on the 8-bit sRGB code values.

`collect` measures every variant of the manifest (`{variant}` in the pattern)
into one JSON object. `compare` writes the per-variant table (Lightroom /
before / after and the errors), the mean absolute error per statistic, and
whether each slider family moves every statistic in Lightroom's direction
(the sign of the change over the family) without a step the opposite way.
"""
from __future__ import annotations

import argparse
import json
import sys

import numpy as np
from PIL import Image


def luma(rgb: np.ndarray) -> np.ndarray:
    return rgb @ np.array([0.299, 0.587, 0.114])


def chroma(rgb: np.ndarray) -> tuple[np.ndarray, np.ndarray]:
    y = luma(rgb)
    return (rgb[..., 2] - y) / 1.772, (rgb[..., 0] - y) / 1.402


def edge_stats(y: np.ndarray, box, lo: float, hi: float) -> dict:
    x0, y0, x1, y1 = box
    profile = y[y0 + 40:y1 - 40, x0:x1].mean(0)
    mid = (x1 - x0) // 2
    window = profile[mid - 30:mid + 30]
    left, right = window[:10].mean(), window[-10:].mean()
    span = right - left
    p10, p90 = left + 0.1 * span, left + 0.9 * span
    xs = np.arange(window.size, dtype=np.float64)

    def crossing(level: float) -> float:
        above = np.nonzero(window >= level)[0]
        if not above.size:
            return float("nan")
        i = above[0]
        if i == 0:
            return 0.0
        return float(xs[i - 1] + (level - window[i - 1]) / (window[i] - window[i - 1]))

    return {"lo": lo, "hi": hi, "rise10to90": round(crossing(p90) - crossing(p10), 3),
            "overshoot": round(float(window.max() - right), 3), "undershoot": round(float(left - window.min()), 3)}


def grating_stats(y: np.ndarray, box, period: int) -> dict:
    x0, y0, x1, y1 = box
    profile = y[y0 + 40:y1 - 40, x0 + 20:x1 - 20].mean(0)
    return {"period": period, "gain": round(float((np.percentile(profile, 99) - np.percentile(profile, 1)) / 96.0), 4)}


def noise_stats(rgb: np.ndarray, box, region: dict) -> dict:
    x0, y0, x1, y1 = box
    w, h = x1 - x0, y1 - y0
    inner = rgb[y0 + h // 5:y1 - h // 5, x0 + w // 5:x1 - w // 5]
    cb, cr = chroma(inner)
    return {"rgb": region["rgb"], "lumaSigmaIn": region["lumaSigma"], "chromaSigmaIn": region["chromaSigma"],
            "lumaStd": round(float(luma(inner).std()), 3), "cbStd": round(float(cb.std()), 3),
            "crStd": round(float(cr.std()), 3), "mean": [round(float(v), 2) for v in inner.reshape(-1, 3).mean(0)]}


def stats(image_path: str, spec: dict) -> dict:
    with Image.open(image_path) as image:
        rgb = np.asarray(image.convert("RGB"), dtype=np.float64)
    if rgb.shape[:2] != (spec["height"], spec["width"]):
        raise SystemExit(f"{image_path}: size {rgb.shape[1]}x{rgb.shape[0]} != chart")
    y = luma(rgb)
    out = {"edges": [], "gratings": [], "noise": []}
    for region in spec["regions"]:
        if region["kind"] == "edge":
            out["edges"].append(edge_stats(y, region["box"], region["lo"], region["hi"]))
        elif region["kind"] == "grating":
            out["gratings"].append(grating_stats(y, region["box"], region["period"]))
        else:
            out["noise"].append(noise_stats(rgb, region["box"], region))
    return out


# Slider families in Lightroom's order (the neighbour of each step is the
# previous variant of the same family).
FAMILIES = {
    "amount": ["neutral", "sharp_a40", "sharp_a80", "sharp_a150"],
    "radius": ["sharp_a80_r05", "sharp_a80", "sharp_a80_r20", "sharp_a80_r30"],
    "detail": ["sharp_a80_d0", "sharp_a80", "sharp_a80_d75", "sharp_a80_d100"],
    "masking": ["sharp_a80", "sharp_a80_m50", "sharp_a80_m90"],
    "luminanceSmoothing": ["neutral", "lnr_25", "lnr_50", "lnr_75", "lnr_100"],
    "colorNoiseReduction": ["neutral", "cnr_25", "cnr_50", "cnr_100"],
}
# A step smaller than this is "no change" (8-bit outputs: one code value,
# one code of the 96-code grating swing, a tenth of a pixel / code of std).
TOLERANCE = {"rise10to90": 0.15, "overshoot": 1.0, "undershoot": 1.0, "gain": 0.011, "lumaStd": 0.15,
             "chromaStd": 0.15}


def flatten(st: dict) -> dict[str, float]:
    """`statistic name -> value` for every compared statistic."""
    out = {}
    for edge in st["edges"]:
        name = f"edge {edge['lo']}-{edge['hi']}"
        for key in ("rise10to90", "overshoot", "undershoot"):
            out[f"{name} {key}"] = edge[key]
    for grating in st["gratings"]:
        out[f"grating p{grating['period']} gain"] = grating["gain"]
    for patch in st["noise"]:
        rgb = "/".join(str(v) for v in patch["rgb"])
        name = f"patch {rgb} luma{patch['lumaSigmaIn']} chroma{patch['chromaSigmaIn']}"
        if patch["lumaSigmaIn"] or patch["chromaSigmaIn"]:
            out[f"{name} lumaStd"] = patch["lumaStd"]
        if patch["chromaSigmaIn"]:
            out[f"{name} chromaStd"] = round((patch["cbStd"] + patch["crStd"]) / 2, 3)
    return out


def kind(stat: str) -> str:
    return stat.rsplit(" ", 1)[1]


def direction(delta: float, tolerance: float) -> int:
    return 0 if abs(delta) <= tolerance else (1 if delta > 0 else -1)


def compare(lightroom: dict, after: dict, before: dict | None) -> dict:
    variants = {}
    errors: dict[str, dict[str, list[float]]] = {}
    for name, entry in lightroom["variants"].items():
        reference = flatten(entry["lightroom"])
        now = flatten(after[name])
        old = flatten(before[name]) if before else None
        rows = []
        for stat, value in reference.items():
            row = {"stat": stat, "lightroom": value, "after": now[stat], "afterError": round(now[stat] - value, 3)}
            errors.setdefault(kind(stat), {"after": [], "before": []})["after"].append(abs(now[stat] - value))
            if old:
                row["before"] = old[stat]
                row["beforeError"] = round(old[stat] - value, 3)
                errors[kind(stat)]["before"].append(abs(old[stat] - value))
            rows.append(row)
        variants[name] = {"settings": entry["settings"], "rows": rows}
    summary = {key: {side: round(float(np.mean(values)), 3) for side, values in sides.items() if values}
               for key, sides in errors.items()}
    families = {}
    mismatches = []
    for family, names in FAMILIES.items():
        lr = [flatten(lightroom["variants"][n]["lightroom"]) for n in names]
        ni = [flatten(after[n]) for n in names]
        checks = []
        for stat in lr[0]:
            tolerance = TOLERANCE[kind(stat)]
            lr_steps = [direction(b[stat] - a[stat], tolerance) for a, b in zip(lr, lr[1:])]
            ni_steps = [direction(b[stat] - a[stat], tolerance) for a, b in zip(ni, ni[1:])]
            if not any(lr_steps) and not any(ni_steps):
                continue
            # Direction: over the family NIHO moves the way Lightroom does
            # (or stays within three tolerances where Lightroom stays).
            # Monotonicity: no step goes the opposite way to Lightroom's.
            lr_total = lr[-1][stat] - lr[0][stat]
            ni_total = ni[-1][stat] - ni[0][stat]
            if abs(lr_total) > tolerance:
                ok = ni_total * lr_total > 0
            else:
                ok = abs(ni_total) <= 3 * tolerance
            ok = ok and not any(l and n == -l for l, n in zip(lr_steps, ni_steps))
            checks.append({"stat": stat, "lightroom": [v[stat] for v in lr], "after": [v[stat] for v in ni],
                           "lightroomSteps": lr_steps, "afterSteps": ni_steps, "match": ok})
            if not ok:
                mismatches.append(f"{family}: {stat}")
        families[family] = {"variants": names, "checks": checks}
    return {"kind": "synthetic-detail-chart-errors-round32", "tolerance": TOLERANCE, "summary": summary,
            "monotonicity": {"mismatches": mismatches, "families": families}, "variants": variants}


def main() -> int:
    argv = sys.argv[1:]
    if argv and argv[0] not in ("measure", "collect", "compare", "-h", "--help"):
        argv = ["measure", *argv]
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    sub = parser.add_subparsers(dest="command", required=True)
    measure = sub.add_parser("measure")
    measure.add_argument("manifest")
    measure.add_argument("images", nargs="+")
    collect = sub.add_parser("collect")
    collect.add_argument("manifest")
    collect.add_argument("--pattern", required=True)
    collect.add_argument("--out", required=True)
    comparison = sub.add_parser("compare")
    comparison.add_argument("--lightroom", required=True)
    comparison.add_argument("--after", required=True)
    comparison.add_argument("--before")
    comparison.add_argument("--out", required=True)
    args = parser.parse_args(argv)
    if args.command == "compare":
        def load(path):
            with open(path, encoding="utf-8") as handle:
                return json.load(handle)
        after = load(args.after)["variants"]
        # A NIHO statistics file may carry its pre-calibration run as "before".
        before = load(args.before) if args.before else None
        before = before.get("before", before)["variants"] if before else None
        result = compare(load(args.lightroom), after, before)
        with open(args.out, "w", encoding="utf-8") as handle:
            json.dump(result, handle, ensure_ascii=False, indent=2)
            handle.write("\n")
        print(json.dumps({"summary": result["summary"], "mismatches": result["monotonicity"]["mismatches"]},
                         ensure_ascii=False))
        return 0
    with open(args.manifest, encoding="utf-8") as handle:
        manifest = json.load(handle)
    spec = manifest["chart"]
    if args.command == "measure":
        for path in args.images:
            print(json.dumps({"image": path.rsplit("/", 1)[-1], **stats(path, spec)}, ensure_ascii=False))
        return 0
    out = {"variants": {entry["variant"]: stats(args.pattern.format(variant=entry["variant"]), spec)
                        for entry in manifest["variants"]}}
    with open(args.out, "w", encoding="utf-8") as handle:
        json.dump(out, handle, ensure_ascii=False, indent=2)
        handle.write("\n")
    print(f"{len(out['variants'])} variants -> {args.out}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
