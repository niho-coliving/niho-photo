#!/usr/bin/env python3
"""Prepare JPEG references for P1 color acceptance (#17117).

Uses round3's eight neutral JPEG inputs. Lightroom reads Camera Raw settings
embedded in each JPEG; the owner's photos and exports stay outside the repo.

  python3 make_lr_round10.py [--ref <lr-measure>] [--dry-run | --check]
"""
from __future__ import annotations

import argparse
import json
import os
import re
import subprocess
from pathlib import Path
from xml.sax.saxutils import quoteattr

from make_lr_round6 import PHOTOBENCH

VARIANTS: dict[str, dict[str, str]] = {
    "neutral": {},
    "exposure_plus1": {"Exposure2012": "+1.00"},
    "exposure_minus1": {"Exposure2012": "-1.00"},
    "wb_warm": {"IncrementalTemperature": "+30", "IncrementalTint": "+20"},
    "wb_cool": {"IncrementalTemperature": "-30", "IncrementalTint": "-20"},
    "hsl_blue": {"HueAdjustmentBlue": "-30", "SaturationAdjustmentBlue": "+40"},
    "hsl_orange": {"SaturationAdjustmentOrange": "-40"},
}


def scenes(round3: Path) -> list[str]:
    manifest = json.loads((round3 / "manifest.json").read_text(encoding="utf-8"))
    return sorted({entry["scene"] for entry in manifest if entry["variant"] == "neutral"})


def packet(settings: dict[str, str]) -> str:
    attrs = {"Version": "18.3", "ProcessVersion": "15.4", "HasSettings": "True", "AlreadyApplied": "False", **settings}
    lines = "\n".join(f"   crs:{key}={quoteattr(value)}" for key, value in attrs.items())
    return ("<x:xmpmeta xmlns:x=\"adobe:ns:meta/\">\n"
            " <rdf:RDF xmlns:rdf=\"http://www.w3.org/1999/02/22-rdf-syntax-ns#\">\n"
            "  <rdf:Description rdf:about=\"\" xmlns:crs=\"http://ns.adobe.com/camera-raw-settings/1.0/\"\n"
            f"{lines} />\n </rdf:RDF>\n</x:xmpmeta>\n")


def create(round_dir: Path, round3: Path, dry_run: bool) -> None:
    target = round_dir / "round10-jpeg"
    if not dry_run and target.exists() and any(target.iterdir()):
        raise SystemExit(f"{target} が空でない。上書きしないので中止する。")
    manifest = []
    for scene in scenes(round3):
        source = round3 / "round3-jpeg" / f"r3_{scene}_neutral.jpg"
        if not source.is_file():
            raise SystemExit(f"入力がない: {source}")
        for variant, settings in VARIANTS.items():
            file = f"r10_{scene}_{variant}.jpg"
            manifest.append({"file": file, "scene": scene, "variant": variant, "kind": "jpeg-embedded",
                             "settings": settings, "source": str(source)})
            if dry_run:
                continue
            target.mkdir(parents=True, exist_ok=True)
            destination = target / file
            subprocess.run(["cp", "-c", str(source), str(destination)], check=True)
            xmp = round_dir / f".{file}.xmp"
            try:
                xmp.write_text(packet(settings), encoding="utf-8")
                subprocess.run(["exiftool", "-q", "-overwrite_original", "-xmp:all=", f"-xmp<={xmp}", str(destination)], check=True)
            finally:
                xmp.unlink(missing_ok=True)
    if dry_run:
        print(f"dry-run: {len(manifest)} JPEG（{len(manifest) // len(VARIANTS)} 場面 × {len(VARIANTS)} 設定） -> {target}")
        return
    (round_dir / "lr-export-jpeg").mkdir(exist_ok=True)
    (round_dir / "manifest.json").write_text(json.dumps(manifest, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    (round_dir / "README.md").write_text(
        "# Lightroom JPEG 参照 round10（P1 #17117）\n\n"
        f"1. Lightroom の「ローカル」で `{target}` を開く。\n"
        "2. 全選択（⌘A）→ 書き出し（⇧⌘E）。**JPG・画質 100%・フルサイズ・sRGB・出力シャープ OFF・ファイル名そのまま**。\n"
        "   「元の形式＋設定」では XMP だけが残り、補正が画素へ反映されないため選ばない。\n"
        f"3. 保存先は `{round_dir / 'lr-export-jpeg'}`。補正設定を変更しない。\n"
        "4. 書き出しが終わったら担当へ伝える。担当が `make_lr_round10.py --check` で設定と枚数を確認する。\n\n"
        f"{len(manifest)} 枚（{len(manifest) // len(VARIANTS)} 場面 × {len(VARIANTS)} 設定）。露出単独の ±1 EV、"
        "JPEG の色温度・色かぶり、青と橙の HSL を Lightroom と NIHO で比較するための参照。\n",
        encoding="utf-8",
    )
    print(f"{len(manifest)} JPEG -> {target}")


def check(round_dir: Path) -> int:
    try:
        from PIL import Image
    except ImportError as exc:
        raise SystemExit("--check には Pillow が必要（colorcheck/requirements.txt）") from exc

    manifest = json.loads((round_dir / "manifest.json").read_text(encoding="utf-8"))
    missing, mismatch, unchanged = [], [], []
    pixels: dict[str, dict[str, bytes]] = {}
    for entry in manifest:
        file = round_dir / "lr-export-jpeg" / entry["file"]
        if not file.is_file():
            missing.append(entry["file"])
            continue
        xmp = subprocess.run(["exiftool", "-b", "-XMP", str(file)], check=True, capture_output=True, text=True).stdout
        for key, value in entry["settings"].items():
            actual = re.search(rf'\bcrs:{key}="([^"]+)"', xmp)
            if actual is None or float(actual.group(1)) != float(value):
                mismatch.append(f"{entry['file']}: {key}={value}")
        if 'crs:HasSettings="True"' not in xmp:
            mismatch.append(f"{entry['file']}: HasSettings")
        if 'crs:AlreadyApplied="True"' not in xmp:
            mismatch.append(f"{entry['file']}: Lightroom の補正未適用")
        with Image.open(file) as image:
            image.draft("RGB", (64, 64))
            pixels.setdefault(entry["scene"], {})[entry["variant"]] = image.convert("RGB").resize((64, 64)).tobytes()
    for scene, variants in pixels.items():
        neutral = variants.get("neutral")
        if neutral is None:
            continue
        for variant in ("exposure_plus1", "exposure_minus1"):
            if variants.get(variant) == neutral:
                unchanged.append(f"{scene}: {variant} の画素が中立と同一")
    for variant in VARIANTS:
        if variant in {"neutral", "exposure_plus1", "exposure_minus1"}:
            continue
        complete = [variants for variants in pixels.values() if "neutral" in variants and variant in variants]
        if complete and all(variants[variant] == variants["neutral"] for variants in complete):
            unchanged.append(f"{variant}: 全場面の画素が中立と同一")
    print(f"round10: {len(manifest)} 枚中 欠け {len(missing)}・設定違い {len(mismatch)}・画素未変化 {len(unchanged)}")
    for item in (missing + mismatch + unchanged)[:20]:
        print(" ", item)
    return 1 if missing or mismatch or unchanged else 0


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--ref", type=Path, default=Path(os.environ.get("NIHO_COLOR_REF_ROOT", PHOTOBENCH / "exports/lr-measure")))
    parser.add_argument("--dry-run", action="store_true")
    parser.add_argument("--check", action="store_true")
    args = parser.parse_args()
    if args.dry_run and args.check:
        parser.error("--dry-run と --check は同時に指定できません")
    round_dir = args.ref / "round10"
    if args.check:
        return check(round_dir)
    create(round_dir, args.ref / "round3", args.dry_run)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
