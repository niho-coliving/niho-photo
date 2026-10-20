#!/usr/bin/env python3
"""Make a synthetic JPEG color chart for Lightroom incremental WB (#17523).

  python3 make_lr_round11.py [--ref <lr-measure>] [--dry-run | --check]

Pillow and exiftool are required. No personal photos enter the repository.
"""
from __future__ import annotations

import argparse
import json
import os
import re
import shutil
import subprocess
from io import BytesIO
from pathlib import Path

from make_lr_round6 import PHOTOBENCH
from make_lr_round10 import packet

LEVELS = [round(i * 255 / 16) for i in range(17)]
PATCH = 12
COLUMNS = 71
VARIANTS: dict[str, dict[str, str]] = {
    "neutral": {},
    "temp_m80": {"IncrementalTemperature": "-80"},
    "temp_m30": {"IncrementalTemperature": "-30"},
    "temp_p30": {"IncrementalTemperature": "+30"},
    "temp_p80": {"IncrementalTemperature": "+80"},
    "tint_m50": {"IncrementalTint": "-50"},
    "tint_m20": {"IncrementalTint": "-20"},
    "tint_p20": {"IncrementalTint": "+20"},
    "tint_p50": {"IncrementalTint": "+50"},
    "wb_cool": {"IncrementalTemperature": "-30", "IncrementalTint": "-20"},
    "wb_warm": {"IncrementalTemperature": "+30", "IncrementalTint": "+20"},
}


def xmp_settings(variant: str, settings: dict[str, str]) -> dict[str, str]:
    if variant == "neutral":
        return {"WhiteBalance": "As Shot", "IncrementalTemperature": "0", "IncrementalTint": "0"}
    return {"WhiteBalance": "Custom", "IncrementalTemperature": "0", "IncrementalTint": "0", **settings}


def chart():
    from PIL import Image, ImageCms

    count = len(LEVELS) ** 3
    rows = (count + COLUMNS - 1) // COLUMNS
    image = Image.new("RGB", (COLUMNS * PATCH, rows * PATCH), (128, 128, 128))
    pixels = image.load()
    for index in range(count):
        r, g, b = index // (17 * 17), (index // 17) % 17, index % 17
        x, y = (index % COLUMNS) * PATCH, (index // COLUMNS) * PATCH
        color = (LEVELS[r], LEVELS[g], LEVELS[b])
        for yy in range(y, y + PATCH):
            for xx in range(x, x + PATCH):
                pixels[xx, yy] = color
    icc = ImageCms.ImageCmsProfile(ImageCms.createProfile("sRGB")).tobytes()
    return image, icc


def is_srgb_export(image, srgb_profile) -> bool:
    """Accept an embedded profile only when its RGB transform matches sRGB."""
    from PIL import Image, ImageCms

    if image.mode != "RGB":
        return False
    icc_profile = image.info.get("icc_profile")
    exif_color_space = image.getexif().get(0xA001)
    if not icc_profile:
        return exif_color_space == 1
    if exif_color_space not in (None, 1, 65535):
        return False

    try:
        source_profile = ImageCms.ImageCmsProfile(BytesIO(icc_profile))
        transform = ImageCms.buildTransformFromOpenProfiles(
            source_profile, srgb_profile, "RGB", "RGB"
        )
        probes = [
            (red, green, blue)
            for red in LEVELS
            for green in LEVELS
            for blue in LEVELS
        ]
        probe = Image.new("RGB", (len(probes), 1))
        probe.putdata(probes)
        converted = ImageCms.applyTransform(probe, transform)
        source_bytes = probe.tobytes()
        converted_bytes = converted.tobytes()
        if len(source_bytes) != len(converted_bytes):
            return False
        return all(
            abs(source - target) <= 1
            for source, target in zip(source_bytes, converted_bytes)
        )
    except (ImageCms.PyCMSError, OSError, TypeError, ValueError):
        return False


def create(round_dir: Path, dry_run: bool) -> None:
    inputs = round_dir / "round11-jpeg"
    if dry_run:
        print(f"dry-run: {len(VARIANTS)} 合成 JPEG -> {inputs}")
        return
    if inputs.exists() and any(inputs.iterdir()):
        raise SystemExit(f"{inputs} が空でない。上書きしないので中止する。")
    inputs.mkdir(parents=True, exist_ok=True)
    exports = round_dir / "lr-export-jpeg"
    exports.mkdir(exist_ok=True)
    image, icc = chart()
    source = round_dir / "base-hald.jpg"
    image.save(source, quality=100, subsampling=0, icc_profile=icc)
    manifest = []
    for variant, settings in VARIANTS.items():
        settings = xmp_settings(variant, settings)
        destination = inputs / f"r11_hald_{variant}.jpg"
        shutil.copyfile(source, destination)
        xmp = round_dir / f".{variant}.xmp"
        try:
            xmp.write_text(packet(settings), encoding="utf-8")
            subprocess.run(["exiftool", "-q", "-overwrite_original", "-xmp:all=",
                            f"-xmp<={xmp}", str(destination)], check=True)
        finally:
            xmp.unlink(missing_ok=True)
        manifest.append({"file": destination.name, "variant": variant, "settings": settings})
    (round_dir / "manifest.json").write_text(json.dumps({
        "chart": {"levels": LEVELS, "patch": PATCH, "columns": COLUMNS,
                  "rows": image.height // PATCH, "count": len(LEVELS) ** 3},
        "variants": manifest,
    }, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    (round_dir / "README.md").write_text(
        "# JPEG 色温度・色かぶり較正（#17523）\n\n"
        f"1. Lightroom（Classic ではない方）の「ローカル」で `{inputs}` を開く。\n"
        "2. 11 枚すべてを選んで書き出す。形式は **JPG・画質 100%・フルサイズ・sRGB・出力シャープ OFF・ファイル名そのまま**。「元の形式＋設定」は選ばない。\n"
        f"3. 保存先は `{exports}`。現像設定には触らない。\n"
        "4. 完了したら担当へ連絡する。担当が画素反映と XMP を検査する。\n\n"
        "合成色見本のみで人物写真は含まない。単独の色温度と色かぶりを分け、Lightroom の JPEG 変換を測る。\n",
        encoding="utf-8",
    )
    print(f"{len(manifest)} 合成 JPEG -> {inputs}")


def check(round_dir: Path) -> int:
    from PIL import Image, ImageCms

    manifest = json.loads((round_dir / "manifest.json").read_text(encoding="utf-8"))["variants"]
    srgb_profile = ImageCms.ImageCmsProfile(ImageCms.createProfile("sRGB"))
    missing, mismatch, unchanged = [], [], []
    pixels: dict[str, bytes] = {}
    for entry in manifest:
        file = round_dir / "lr-export-jpeg" / entry["file"]
        if not file.is_file():
            missing.append(entry["file"])
            continue
        xmp = subprocess.run(["exiftool", "-b", "-XMP", str(file)], check=True,
                             capture_output=True, text=True).stdout
        if 'crs:AlreadyApplied="True"' not in xmp:
            mismatch.append(f"{entry['file']}: Lightroom の補正未適用")
        for key, value in entry["settings"].items():
            actual = re.search(rf'\bcrs:{key}="([^"]+)"', xmp)
            if actual is None or (actual.group(1) != value if key == "WhiteBalance"
                                  else float(actual.group(1)) != float(value)):
                mismatch.append(f"{entry['file']}: {key}={value}")
        with Image.open(file) as image:
            rows = (len(LEVELS) ** 3 + COLUMNS - 1) // COLUMNS
            if image.format != "JPEG" or image.size != (COLUMNS * PATCH, rows * PATCH):
                mismatch.append(f"{entry['file']}: JPG・フルサイズでない")
            if not is_srgb_export(image, srgb_profile):
                mismatch.append(f"{entry['file']}: sRGBでない、または色空間を確認できない")
            pixels[entry["variant"]] = image.convert("RGB").tobytes()
    neutral = pixels.get("neutral")
    if neutral is not None:
        for variant in VARIANTS.keys() - {"neutral"}:
            if pixels.get(variant) == neutral:
                unchanged.append(f"{variant}: 中立と同じ画素")
    print(f"round11: {len(manifest)} 枚中 欠け {len(missing)}・設定違い {len(mismatch)}・画素未変化 {len(unchanged)}")
    for item in (missing + mismatch + unchanged)[:20]:
        print(" ", item)
    return 1 if missing or mismatch or unchanged else 0


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--ref", type=Path,
                        default=Path(os.environ.get("NIHO_COLOR_REF_ROOT", PHOTOBENCH / "exports/lr-measure")))
    parser.add_argument("--dry-run", action="store_true")
    parser.add_argument("--check", action="store_true")
    args = parser.parse_args()
    if args.dry_run and args.check:
        parser.error("--dry-run と --check は同時に指定できません")
    round_dir = args.ref / "round11"
    if args.check:
        return check(round_dir)
    create(round_dir, args.dry_run)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
