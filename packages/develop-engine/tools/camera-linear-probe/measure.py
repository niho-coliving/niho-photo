#!/usr/bin/env python3
"""V3 measurements using private RAW renders and Lightroom round6 exports.

Inputs are local paths. No photograph or per-pixel output is written to the repo.
The 60 white-balance pairs use the same provisional colorcheck methodology
(`per-image-rgb-tone-curve`) as the Stage-1 color measurements.
"""

from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

import numpy as np

COLORCHECK = Path(__file__).resolve().parents[2] / "crates/niho-base-raw/tools/colorcheck"
sys.path.insert(0, str(COLORCHECK))
import common as C  # noqa: E402
from measure import measure_pair  # noqa: E402

KELVIN = (4000, 5500, 7500)
SKIN_REGIONS = {
    "P1581387": {
        "mother-cheek": (0.475, 0.292, 0.512, 0.335),
        "child-cheek": (0.534, 0.424, 0.574, 0.471),
    },
    "P1570923": {
        "man-cheek": (0.349, 0.352, 0.418, 0.400),
        "upper-arm": (0.128, 0.496, 0.227, 0.591),
    },
}


def as_shot_error(candidate_dir: Path, scene: str) -> dict:
    baseline, _ = C.load_working_copy(str(candidate_dir / f"{scene}-old.png"))
    deferred, _ = C.load_working_copy(str(candidate_dir / f"{scene}-as-shot.png"))
    size = C.fit_long_edge(baseline.shape[1], baseline.shape[0], 750)
    baseline = C.resize_float(baseline, size)
    deferred = C.resize_float(deferred, size)
    valid = (
        (C.luminance_prophoto(baseline) > 0.005)
        & (baseline.max(axis=-1) < 0.98)
        & (deferred.max(axis=-1) < 0.98)
    )
    lab_a = C.prophoto_to_lab(baseline[valid], clip_to_srgb=True)
    lab_b = C.prophoto_to_lab(deferred[valid], clip_to_srgb=True)
    de = C.delta_e00(lab_a, lab_b)
    return {"scene": scene, "mean": float(de.mean()), "p99": float(np.percentile(de, 99))}


def skin_ratios(extra: dict, scene: str, kelvin: int) -> list[dict]:
    candidate, ref, valid = extra["toned"], extra["refLin"], extra["valid"]
    height, width = valid.shape
    rows = []
    for region, (x0, y0, x1, y1) in SKIN_REGIONS.get(scene, {}).items():
        mask = np.zeros((height, width), bool)
        mask[int(y0 * height) : int(y1 * height), int(x0 * width) : int(x1 * width)] = True
        mask &= valid
        lab_c = C.prophoto_to_lab(candidate[mask], clip_to_srgb=True)
        lab_r = C.srgb_linear_to_lab(ref[mask])
        skin = (
            (lab_r[:, 1] > 3)
            & (lab_r[:, 2] > 8)
            & (lab_r[:, 0] > 20)
            & (lab_r[:, 0] < 90)
        )
        if skin.sum() < 50:
            continue
        ratio = C.chroma(lab_c[skin]).mean() / C.chroma(lab_r[skin]).mean()
        rows.append({"scene": scene, "kelvin": kelvin, "region": region, "pixels": int(skin.sum()), "saturationRatio": float(ratio)})
    return rows


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--candidate-dir", type=Path, required=True)
    parser.add_argument("--reference-dir", type=Path, required=True)
    parser.add_argument("--scenes", required=True, help="comma-separated scene IDs, DC-S5 and ZV-E10M2 only")
    parser.add_argument("--out", type=Path, required=True)
    args = parser.parse_args()
    scenes = [scene.strip() for scene in args.scenes.split(",") if scene.strip()]
    shots = []
    wb = []
    skin = []
    for scene in scenes:
        shots.append(as_shot_error(args.candidate_dir, scene))
        registration = None
        for kelvin in KELVIN:
            keep = scene in SKIN_REGIONS
            result, _hist, extra = measure_pair(
                str(args.candidate_dir / f"{scene}-wb-{kelvin}.png"),
                str(args.reference_dir / f"p6_{scene}_wb_{kelvin}.jpg"),
                "lr-neutral",
                long_edge=1000,
                niho_cam=str(args.candidate_dir / f"{scene}-camera.png"),
                tone="per-image-rgb-tone-curve",
                registration=registration,
                keep_images=keep,
            )
            registration = extra["registrationRaw"]
            wb.append({"scene": scene, "kelvin": kelvin, "dE00Mean": result["dE00"]["mean"], "dE00P99": result["dE00"]["p99"], "saturationRatio": result["saturationRatio"], "pixels": result["pixels"]})
            if keep:
                skin.extend(skin_ratios(extra, scene, kelvin))
    report = {"schema": "niho-camera-linear-probe-measure/1", "asShot": shots, "whiteVariants": wb, "skinRegions": skin}
    args.out.parent.mkdir(parents=True, exist_ok=True)
    args.out.write_text(json.dumps(report, indent=2, ensure_ascii=False))
    print(f"as-shot scenes={len(shots)} mean={np.mean([x['mean'] for x in shots]):.4f} max-scene={max(x['mean'] for x in shots):.4f}")
    for kelvin in KELVIN:
        values = [x["dE00Mean"] for x in wb if x["kelvin"] == kelvin]
        print(f"{kelvin}K pairs={len(values)} mean={np.mean(values):.4f}")
    if skin:
        print(f"skin regions={len(skin)} ratio-range={min(x['saturationRatio'] for x in skin):.3f}..{max(x['saturationRatio'] for x in skin):.3f}")
    else:
        print("skin regions=0")


if __name__ == "__main__":
    main()
