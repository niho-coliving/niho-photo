#!/usr/bin/env python3
"""Make a synthetic detail chart for Lightroom sharpening / noise reduction (#32).

One 1500x1000 sRGB chart (1500 px long edge = the radius reference of NIHO's
detail processing) holds step edges at three contrasts, sine gratings at four
frequencies, and flat gray / colored patches with seeded luminance and chroma
noise. Each variant embeds one Sharpening / Noise Reduction setting.

  python3 make_lr_round32.py --out <private-dir> [--dry-run | --check]

Pillow, numpy and exiftool are required. No personal photos are used.
"""
from __future__ import annotations

import argparse
import json
import shutil
import subprocess
from pathlib import Path

from make_lr_p3_jpeg import COMMON, packet

WIDTH, HEIGHT = 1500, 1000
SEED = 32
NEUTRAL = {"Sharpness": "0", "SharpenRadius": "+1.0", "SharpenDetail": "25", "SharpenEdgeMasking": "0",
           "LuminanceSmoothing": "0", "ColorNoiseReduction": "0"}


def _variants() -> dict[str, dict[str, str]]:
    out = {"neutral": {}}
    for amount in (40, 80, 150):
        out[f"sharp_a{amount}"] = {"Sharpness": str(amount)}
    for radius in ("0.5", "2.0", "3.0"):
        out[f"sharp_a80_r{radius.replace('.', '')}"] = {"Sharpness": "80", "SharpenRadius": f"+{radius}"}
    for detail in (0, 75, 100):
        out[f"sharp_a80_d{detail}"] = {"Sharpness": "80", "SharpenDetail": str(detail)}
    for masking in (50, 90):
        out[f"sharp_a80_m{masking}"] = {"Sharpness": "80", "SharpenEdgeMasking": str(masking)}
    for amount in (25, 50, 75, 100):
        out[f"lnr_{amount}"] = {"LuminanceSmoothing": str(amount), "LuminanceNoiseReductionDetail": "50",
                                "LuminanceNoiseReductionContrast": "0"}
    for amount in (25, 50, 100):
        out[f"cnr_{amount}"] = {"ColorNoiseReduction": str(amount), "ColorNoiseReductionDetail": "50",
                                "ColorNoiseReductionSmoothness": "50"}
    out["combo"] = {"Sharpness": "80", "LuminanceSmoothing": "50", "LuminanceNoiseReductionDetail": "50",
                    "LuminanceNoiseReductionContrast": "0", "ColorNoiseReduction": "25",
                    "ColorNoiseReductionDetail": "50", "ColorNoiseReductionSmoothness": "50"}
    return {name: {**NEUTRAL, **settings} for name, settings in out.items()}


VARIANTS = _variants()


def layout() -> dict:
    """Regions in pixel coordinates (x0, y0, x1, y1); recorded in the manifest."""
    regions = []
    # Row 1: vertical step edges at three contrasts (left half dark, right half light).
    for i, (lo, hi) in enumerate(((64, 192), (100, 156), (120, 136))):
        regions.append({"kind": "edge", "lo": lo, "hi": hi, "box": [i * 500, 0, i * 500 + 500, 250]})
    # Row 2: horizontal sine gratings (period in px), mean 128, amplitude 48.
    for i, period in enumerate((4, 8, 16, 32)):
        regions.append({"kind": "grating", "period": period, "box": [i * 375, 250, i * 375 + 375, 500]})
    # Rows 3-4: flat patches with seeded noise: (base RGB, luma sigma, chroma sigma).
    patches = [((64, 64, 64), 6, 0), ((128, 128, 128), 6, 0), ((192, 192, 192), 6, 0),
               ((128, 128, 128), 12, 0), ((128, 128, 128), 0, 8), ((96, 128, 160), 6, 8),
               ((170, 120, 90), 6, 8), ((80, 140, 80), 0, 12), ((128, 128, 128), 0, 0),
               ((200, 160, 120), 12, 12)]
    for i, (rgb, luma, chroma) in enumerate(patches):
        x, y = (i % 5) * 300, 500 + (i // 5) * 250
        regions.append({"kind": "noise", "rgb": list(rgb), "lumaSigma": luma, "chromaSigma": chroma,
                        "box": [x, y, x + 300, y + 250]})
    return {"width": WIDTH, "height": HEIGHT, "seed": SEED, "regions": regions}


def chart():
    import numpy as np
    from PIL import Image, ImageCms

    spec = layout()
    rng = np.random.default_rng(SEED)
    image = np.zeros((HEIGHT, WIDTH, 3), dtype=np.float64)
    for region in spec["regions"]:
        x0, y0, x1, y1 = region["box"]
        if region["kind"] == "edge":
            mid = (x0 + x1) // 2
            image[y0:y1, x0:mid] = region["lo"]
            image[y0:y1, mid:x1] = region["hi"]
        elif region["kind"] == "grating":
            xs = np.arange(x1 - x0)
            row = 128 + 48 * np.sin(2 * np.pi * xs / region["period"])
            image[y0:y1, x0:x1] = row[None, :, None]
        else:
            h, w = y1 - y0, x1 - x0
            base = np.array(region["rgb"], dtype=np.float64)
            luma = rng.normal(0, region["lumaSigma"], (h, w, 1)) if region["lumaSigma"] else 0
            chroma = 0
            if region["chromaSigma"]:
                cb = rng.normal(0, region["chromaSigma"], (h, w))
                cr = rng.normal(0, region["chromaSigma"], (h, w))
                # Rec.601 chroma offsets with zero luma change.
                chroma = np.stack([1.402 * cr, -0.344136 * cb - 0.714136 * cr, 1.772 * cb], -1)
            image[y0:y1, x0:x1] = base + luma + chroma
    pixels = np.clip(np.round(image), 0, 255).astype(np.uint8)
    icc = ImageCms.ImageCmsProfile(ImageCms.createProfile("sRGB")).tobytes()
    return Image.fromarray(pixels, "RGB"), icc, spec


def create(out_dir: Path, dry_run: bool) -> None:
    inputs = out_dir / "inputs"
    if dry_run:
        print(f"dry-run: {len(VARIANTS)} 合成 JPEG -> {inputs}")
        return
    if inputs.exists() and any(inputs.iterdir()):
        raise SystemExit(f"{inputs} が空でない。上書きしないので中止する。")
    inputs.mkdir(parents=True, exist_ok=True)
    (out_dir / "lr-export").mkdir(exist_ok=True)
    image, icc, spec = chart()
    source = out_dir / "base-chart.jpg"
    image.save(source, quality=100, subsampling=0, icc_profile=icc)
    manifest = []
    for name, settings in VARIANTS.items():
        destination = inputs / f"r32_{name}.jpg"
        shutil.copyfile(source, destination)
        xmp = out_dir / f".{name}.xmp"
        text = packet({**settings, **COMMON}, {})
        try:
            xmp.write_text(text, encoding="utf-8")
            subprocess.run(["exiftool", "-q", "-overwrite_original", "-xmp:all=", f"-xmp<={xmp}", str(destination)],
                           check=True)
        finally:
            xmp.unlink(missing_ok=True)
        manifest.append({"file": destination.name, "variant": name, "settings": settings, "xmp": text})
    (out_dir / "manifest.json").write_text(json.dumps({"round": "issue25-round32", "chart": spec,
                                                       "variants": manifest}, ensure_ascii=False, indent=2) + "\n",
                                           encoding="utf-8")
    (out_dir / "README.md").write_text(
        "# JPEG のシャープ・ノイズ軽減（niho-photo #32）\n\n"
        f"1. Lightroom（Classic ではない方）の「ローカル」で `{inputs}` を開く。\n"
        f"2. {len(manifest)} 枚すべてを選んで書き出す。**JPG・画質 100%・フルサイズ・sRGB・出力シャープ OFF・"
        "ファイル名そのまま**。「元の形式＋設定」は選ばない。現像設定には触らない。\n"
        f"3. 保存先は `{out_dir / 'lr-export'}`。\n"
        "4. `make_lr_round32.py --out <この場所> --check` で枚数と寸法を確かめる。\n\n"
        "合成チャートのみで人物写真は含まない。\n",
        encoding="utf-8",
    )
    print(f"{len(manifest)} 合成 JPEG -> {inputs}")


def check(out_dir: Path) -> int:
    from PIL import Image

    manifest = json.loads((out_dir / "manifest.json").read_text(encoding="utf-8"))
    problems = 0
    for entry in manifest["variants"]:
        path = out_dir / "lr-export" / entry["file"]
        if not path.is_file():
            print(f"missing: {entry['file']}")
            problems += 1
            continue
        with Image.open(path) as image:
            if image.size != (WIDTH, HEIGHT):
                print(f"size {image.size}: {entry['file']}")
                problems += 1
    print(f"{len(manifest['variants'])} variants, {problems} problems")
    return 1 if problems else 0


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("--out", type=Path, required=True)
    mode = parser.add_mutually_exclusive_group()
    mode.add_argument("--dry-run", action="store_true")
    mode.add_argument("--check", action="store_true")
    args = parser.parse_args()
    if args.check:
        return check(args.out)
    create(args.out, args.dry_run)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
