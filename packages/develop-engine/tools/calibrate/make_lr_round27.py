#!/usr/bin/env python3
"""Make synthetic chart JPEGs for JPEG white balance with other edits (#27).

The round11 17^3 sRGB chart is reused. Every variant embeds one relative white
balance (none, single temperature / tint, or the warm pair) crossed with one
per-pixel edit (HSL, parametric curve, color grading, saturation, vibrance,
contrast, exposure, or a bundled preset without its local operations). The
Lightroom exports show whether white balance interacts with those edits the
way NIHO's output-side delta LUT assumes, or as if it were applied first.

  python3 make_lr_round27.py --out <private-dir> [--dry-run | --check]

Pillow and exiftool are required. No personal photos are used; the exports
stay in <private-dir> and only aggregate numbers are published.
"""
from __future__ import annotations

import argparse
import json
import shutil
import subprocess
from pathlib import Path

from make_lr_p3_jpeg import COMMON, packet, preset_settings
from make_lr_round11 import COLUMNS, LEVELS, PATCH, chart, is_srgb_export

WHITE_BALANCES: dict[str, dict[str, str]] = {
    "w0": {},
    "tp30": {"IncrementalTemperature": "+30"},
    "tm30": {"IncrementalTemperature": "-30"},
    "gp20": {"IncrementalTint": "+20"},
    "warm": {"IncrementalTemperature": "+30", "IncrementalTint": "+20"},
}

# Local / image-adaptive operations would make a patch depend on its
# neighbours, so the chart presets keep only their per-pixel settings.
LOCAL_ZERO = {"Highlights2012": "0", "Shadows2012": "0", "Texture": "0", "Clarity2012": "0", "Dehaze": "0"}

EDITS: dict[str, tuple[dict[str, str], dict[str, str]]] = {
    "e0": ({}, {}),
    "hsl": ({"HueAdjustmentOrange": "+50", "SaturationAdjustmentBlue": "-50", "LuminanceAdjustmentGreen": "+30"}, {}),
    "param": ({"ParametricDarks": "-30", "ParametricLights": "+30"}, {}),
    "grade": ({"SplitToningShadowHue": "200", "SplitToningShadowSaturation": "40",
               "SplitToningHighlightHue": "40", "SplitToningHighlightSaturation": "40",
               "ColorGradeBlending": "50"}, {}),
    "sat": ({"Saturation": "+40"}, {}),
    "vib": ({"Vibrance": "+40"}, {}),
    "contrast": ({"Contrast2012": "+40"}, {}),
    "exposure": ({"Exposure2012": "+0.70"}, {}),
}
for _name in ("bluesky2", "pastel", "colorful"):
    _attributes, _elements = preset_settings(_name)
    EDITS[f"preset_{_name}"] = ({**_attributes, **LOCAL_ZERO}, _elements)


def variants() -> dict[str, tuple[dict[str, str], dict[str, str]]]:
    out = {}
    for wb_name, wb in WHITE_BALANCES.items():
        for edit_name, (edit, elements) in EDITS.items():
            white = ({"WhiteBalance": "Custom", "IncrementalTemperature": "0", "IncrementalTint": "0", **wb}
                     if wb else {"WhiteBalance": "As Shot", "IncrementalTemperature": "0", "IncrementalTint": "0"})
            out[f"{wb_name}__{edit_name}"] = ({**edit, **COMMON, **white}, elements)
    return out


def create(out_dir: Path, dry_run: bool) -> None:
    inputs = out_dir / "inputs"
    table = variants()
    if dry_run:
        print(f"dry-run: {len(table)} 合成 JPEG -> {inputs}")
        return
    if inputs.exists() and any(inputs.iterdir()):
        raise SystemExit(f"{inputs} が空でない。上書きしないので中止する。")
    inputs.mkdir(parents=True, exist_ok=True)
    (out_dir / "lr-export").mkdir(exist_ok=True)
    image, icc = chart()
    source = out_dir / "base-chart.jpg"
    image.save(source, quality=100, subsampling=0, icc_profile=icc)
    manifest = []
    for name, (attributes, elements) in table.items():
        destination = inputs / f"r27_{name}.jpg"
        shutil.copyfile(source, destination)
        xmp = out_dir / f".{name}.xmp"
        text = packet(attributes, elements)
        try:
            xmp.write_text(text, encoding="utf-8")
            subprocess.run(["exiftool", "-q", "-overwrite_original", "-xmp:all=", f"-xmp<={xmp}", str(destination)],
                           check=True)
        finally:
            xmp.unlink(missing_ok=True)
        white, edit = name.split("__")
        manifest.append({"file": destination.name, "variant": name, "whiteBalance": white, "edit": edit,
                         "xmp": text})
    (out_dir / "manifest.json").write_text(json.dumps({
        "round": "issue25-round27",
        "chart": {"levels": LEVELS, "patch": PATCH, "columns": COLUMNS,
                  "rows": image.height // PATCH, "count": len(LEVELS) ** 3},
        "variants": manifest,
    }, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    (out_dir / "README.md").write_text(
        "# JPEG の相対 WB と他の補正の組（niho-photo #27）\n\n"
        f"1. Lightroom（Classic ではない方）の「ローカル」で `{inputs}` を開く。\n"
        f"2. {len(manifest)} 枚すべてを選んで書き出す。**JPG・画質 100%・フルサイズ・sRGB・出力シャープ OFF・"
        "ファイル名そのまま**。「元の形式＋設定」は選ばない。現像設定には触らない。\n"
        f"3. 保存先は `{out_dir / 'lr-export'}`。\n"
        "4. `make_lr_round27.py --out <この場所> --check` で枚数と色空間を確かめる。\n\n"
        "合成色見本のみで人物写真は含まない。\n",
        encoding="utf-8",
    )
    print(f"{len(manifest)} 合成 JPEG -> {inputs}")


def check(out_dir: Path) -> int:
    from PIL import Image, ImageCms

    manifest = json.loads((out_dir / "manifest.json").read_text(encoding="utf-8"))
    srgb = ImageCms.ImageCmsProfile(ImageCms.createProfile("sRGB"))
    expected = (manifest["chart"]["columns"] * PATCH, manifest["chart"]["rows"] * PATCH)
    problems = 0
    for entry in manifest["variants"]:
        path = out_dir / "lr-export" / entry["file"]
        if not path.is_file():
            print(f"missing: {entry['file']}")
            problems += 1
            continue
        with Image.open(path) as image:
            if image.size != expected:
                print(f"size {image.size} != {expected}: {entry['file']}")
                problems += 1
            if not is_srgb_export(image, srgb):
                print(f"not sRGB: {entry['file']}")
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
    repo = Path(__file__).resolve().parents[4]
    if args.out.resolve() == repo or repo in args.out.resolve().parents:
        raise SystemExit("出力は repository の外に置く")
    if args.check:
        return check(args.out)
    create(args.out, args.dry_run)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
