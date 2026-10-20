#!/usr/bin/env python3
"""Render private round6 RAWs for the V3 measurement tool.

Pass only DC-S5 and ZV-E10M2 scene IDs. Outputs stay under --out.
"""

from __future__ import annotations

import argparse
import subprocess
from pathlib import Path


def run(*args: object) -> None:
    result = subprocess.run([str(arg) for arg in args], capture_output=True, text=True)
    if result.returncode:
        raise RuntimeError(result.stderr[-1000:] or result.stdout[-1000:])


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--raw-dir", type=Path, required=True)
    parser.add_argument("--out", type=Path, required=True)
    parser.add_argument("--scenes", required=True, help="comma-separated scene IDs")
    parser.add_argument("--dc-dcp", type=Path, required=True)
    parser.add_argument("--sony-dcp", type=Path, required=True)
    parser.add_argument("--probe-bin", type=Path, required=True)
    parser.add_argument("--base-bin", type=Path, required=True)
    args = parser.parse_args()
    args.out.mkdir(parents=True, exist_ok=True)
    scenes = [scene.strip() for scene in args.scenes.split(",") if scene.strip()]
    for scene in scenes:
        matches = [p for p in args.raw_dir.glob(f"{scene}.*") if p.suffix.upper() in (".RW2", ".ARW")]
        if len(matches) != 1:
            raise ValueError(f"{scene}: expected exactly one RAW, got {len(matches)}")
        raw = matches[0]
        profile = args.dc_dcp if raw.suffix.upper() == ".RW2" else args.sony_dcp
        camera = args.out / f"{scene}-camera.png"
        run(args.probe_bin, "make", "--raw", raw, "--dcp", profile, "--out", camera, "--long-edge", 2560)
        run(args.base_bin, "render", "--raw", raw, "--dcp", profile, "--out", args.out / f"{scene}-old.png", "--long-edge", 2560)
        render = [args.probe_bin, "render", "--input", camera, "--meta", camera.with_suffix(".json"), "--dcp", profile]
        run(*render, "--out", args.out / f"{scene}-as-shot.png")
        for kelvin in (4000, 5500, 7500):
            run(*render, "--out", args.out / f"{scene}-wb-{kelvin}.png", "--kelvin", kelvin)
        print(scene, flush=True)
    print(f"rendered {len(scenes)} scenes / {len(scenes) * 3} white variants")


if __name__ == "__main__":
    main()
