#!/usr/bin/env python3
"""Prepare the Lightroom JPEG references of P3 #18397 (スマホ写真の経路を niho-4 相当に).

From a metadata-only selection (selection.json: `teachers` / `independent`), build
the JPEG inputs Lightroom opens, each with its Camera Raw settings embedded in
the file (like round10). The owner's photos and the exports stay on hihirohub.

- HEIC / HEIF go through `apple-raw-linear raster` (the raster working copy the
  product edits: long edge 2560, the source's ICC, SDR primary). JPEG originals
  are used as they are (their XMP is replaced).
- teachers: single operations (Highlights / Shadows ladders, their pairs,
  Whites, Blacks, Contrast, Vibrance, Saturation, HSL, Texture), the three
  bundled presets and the presets without Highlights / Shadows.
- independent: neutral and the three presets only. Sealed: `--check` reads the
  exports' metadata, never their pixels, and records their SHA-256.
- Every variant: Version 18.3 / PV 15.4, no profile or Look, lens profile off
  (NIHO does not correct JPEG lenses).

  python3 make_lr_p3_jpeg.py --selection <selection.json> --set teachers|teachers2|independent [--ref <lr-measure>] [--dry-run | --check]
"""
from __future__ import annotations

import argparse
import hashlib
import json
import os
import re
import shutil
import subprocess
import tempfile
from pathlib import Path
from xml.sax.saxutils import quoteattr

from make_lr_round6 import CURVE_ELEMENTS, NON_SETTING, PHOTOBENCH, PROFILE_KEYS, without_look

PRESET_DIR = Path(__file__).resolve().parents[2] / "crates/niho-develop/presets"
PRESETS = ("bluesky2", "pastel", "colorful")
ROUND = "issue18397"
COMMON = {"LensProfileEnable": "0", "AutoLateralCA": "0"}
HSL_KEY = re.compile(r"^(Hue|Saturation|Luminance)Adjustment\w+$")


def preset_settings(name: str) -> tuple[dict[str, str], dict[str, str]]:
    body = without_look((PRESET_DIR / f"niho-{name}.xmp").read_text(encoding="utf-8"))
    attributes = {k: v for k, v in re.findall(r'\bcrs:(\w+)="([^"]*)"', body)
                  if not NON_SETTING.match(k) and k not in PROFILE_KEYS}
    elements = {}
    for element in CURVE_ELEMENTS:
        match = re.search(rf"<crs:{element}>.*?</crs:{element}>", body, re.S)
        if match:
            elements[element] = match.group(0)
    return attributes, elements


def teacher_variants() -> dict[str, tuple[dict[str, str], dict[str, str]]]:
    single = {
        "neutral": {},
        "h30": {"Highlights2012": "-30"},
        "h60": {"Highlights2012": "-60"},
        "h100": {"Highlights2012": "-100"},
        "s30": {"Shadows2012": "+30"},
        "s60": {"Shadows2012": "+60"},
        "s100": {"Shadows2012": "+100"},
        "h60s30": {"Highlights2012": "-60", "Shadows2012": "+30"},
        "h100s100": {"Highlights2012": "-100", "Shadows2012": "+100"},
        "whites_m50": {"Whites2012": "-50"},
        "blacks_p80": {"Blacks2012": "+80"},
        "contrast_m40": {"Contrast2012": "-40"},
        "vibrance_p40": {"Vibrance": "+40"},
        "saturation_p40": {"Saturation": "+40"},
        "texture_p40": {"Texture": "+40"},
    }
    out = {name: ({**COMMON, **settings}, {}) for name, settings in single.items()}
    bluesky2, _ = preset_settings("bluesky2")
    out["hsl_bluesky2"] = ({**COMMON, **{k: v for k, v in bluesky2.items() if HSL_KEY.match(k)}}, {})
    for name in PRESETS:
        attributes, elements = preset_settings(name)
        out[f"preset_{name}"] = ({**attributes, **COMMON}, elements)
        out[f"preset_{name}_nohs"] = ({**attributes, **COMMON, "Highlights2012": "0", "Shadows2012": "0"}, elements)
    return out


def independent_variants() -> dict[str, tuple[dict[str, str], dict[str, str]]]:
    out = {"neutral": (dict(COMMON), {})}
    for name in PRESETS:
        attributes, elements = preset_settings(name)
        out[f"preset_{name}"] = ({**attributes, **COMMON}, elements)
    return out


def packet(attributes: dict[str, str], elements: dict[str, str]) -> str:
    merged = {"Version": "18.3", "ProcessVersion": "15.4", **attributes, "HasSettings": "True",
              "AlreadyApplied": "False"}
    attribute_text = "\n".join(f"   crs:{k}={quoteattr(v)}" for k, v in merged.items())
    element_text = "\n".join(f"   {block}" for block in elements.values())
    return (
        '<x:xmpmeta xmlns:x="adobe:ns:meta/">\n'
        ' <rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#">\n'
        '  <rdf:Description rdf:about=""\n'
        '   xmlns:crs="http://ns.adobe.com/camera-raw-settings/1.0/"\n'
        f"{attribute_text}>\n{element_text}\n"
        "  </rdf:Description>\n </rdf:RDF>\n</x:xmpmeta>\n"
    )


def sha256(path: Path) -> str:
    with open(path, "rb") as f:
        return hashlib.file_digest(f, "sha256").hexdigest()


def curve_points(block: str) -> list[str]:
    """トーンカーブの要素（`<crs:ToneCurvePV2012…><rdf:Seq><rdf:li>x, y</rdf:li>…`）の点列。空白は落とす。"""
    return [re.sub(r"\s+", "", point) for point in re.findall(r"<rdf:li>([^<]*)</rdf:li>", block)]


def scene_id(item: dict) -> str:
    stem = re.sub(r"[^A-Za-z0-9]+", "", Path(item["source"]).stem)[:16]
    return f"{stem}-{item['date'].replace('-', '')}"


def base_jpeg(item: dict, destination: Path, apple_raw_linear: Path) -> dict:
    source = Path(item["source"])
    # 選定（selection.json）で凍結した写真そのものかを、変換・コピーの前に確かめる。選定の後に同じパスの写真が差し替わった・
    # 別のファイルを指していると、古い digest を記録したまま別の画素で教師・独立評価を作ってしまう。
    expected = item.get("sha256")
    if not expected:
        raise SystemExit(f"{source}: 選定に sha256 が無い。凍結した選定と照らせないので中止する。")
    actual = sha256(source)
    if actual != expected:
        raise SystemExit(f"{source}: sha256 が選定と違う（選定 {expected[:12]}… / 今 {actual[:12]}…）。中止する。")
    with open(source, "rb") as f:
        is_jpeg = f.read(2) == b"\xff\xd8"  # Google Photos exports some HEIC names as JPEG
    if not is_jpeg:
        result = subprocess.run([str(apple_raw_linear), "raster", str(source), "--out", str(destination)],
                                capture_output=True, text=True, check=True)
        return {"conversion": "apple-raw-linear raster", "raster": json.loads(result.stdout.strip().splitlines()[-1])}
    subprocess.run(["cp", "-c", str(source), str(destination)], check=True)
    subprocess.run(["exiftool", "-q", "-overwrite_original", "-xmp:all=", str(destination)], check=True)
    return {"conversion": "original JPEG (XMP removed)"}


def create(out_dir: Path, items: list[dict], variants: dict, apple_raw_linear: Path, dry_run: bool,
           sealed: bool) -> None:
    inputs = out_dir / "inputs"
    if not dry_run and inputs.exists() and any(inputs.iterdir()):
        raise SystemExit(f"{inputs} が空でない。上書きしないので中止する。")
    # curvePoints: 書き出しの検査（--check）で Lightroom の XMP のトーンカーブと照らす期待の点列
    manifest = {"round": ROUND, "sealed": sealed,
                "variants": {k: {"attributes": v[0], "curves": sorted(v[1]),
                                 "curvePoints": {name: curve_points(block) for name, block in sorted(v[1].items())}}
                             for k, v in variants.items()},
                "scenes": [], "files": []}
    with tempfile.TemporaryDirectory() as tmp:
        for item in items:
            scene = scene_id(item)
            entry = {"scene": scene, **{k: item.get(k) for k in ("source", "sha256", "pool", "model", "date", "iso",
                                                                  "band")}}
            if not dry_run:
                inputs.mkdir(parents=True, exist_ok=True)
                base = Path(tmp) / f"{scene}.jpg"
                entry.update(base_jpeg(item, base, apple_raw_linear))
                entry["baseSha256"] = sha256(base)
            manifest["scenes"].append(entry)
            for variant, (attributes, elements) in variants.items():
                file = f"{scene}__{variant}.jpg"
                manifest["files"].append({"file": file, "scene": scene, "variant": variant})
                if dry_run:
                    continue
                destination = inputs / file
                shutil.copyfile(base, destination)
                xmp = Path(tmp) / f"{file}.xmp"
                xmp.write_text(packet(attributes, elements), encoding="utf-8")
                subprocess.run(["exiftool", "-q", "-overwrite_original", "-xmp:all=", f"-xmp<={xmp}",
                                str(destination)], check=True)
    count = len(manifest["files"])
    if dry_run:
        print(f"dry-run: {count} JPEG（{len(items)} 場面 × {len(variants)} 設定） -> {inputs}")
        return
    (out_dir / "lr-export").mkdir(exist_ok=True)
    (out_dir / "manifest.json").write_text(json.dumps(manifest, ensure_ascii=False, indent=1) + "\n", encoding="utf-8")
    (out_dir / "README.md").write_text(
        f"# Lightroom JPEG 参照 {ROUND}/{out_dir.name}（P3 #18397）\n\n"
        f"1. Lightroom（Classic ではない方）の「ローカル」で `{inputs}` を開く。\n"
        "2. 全選択（⌘A）→ 書き出し。**JPG・画質 100%・フルサイズ・sRGB・出力シャープ OFF・ファイル名そのまま**。\n"
        "   「元の形式＋設定」は補正が画素へ反映されないため選ばない。写真の補正・プロファイルは触らない。\n"
        f"3. 保存先は `{out_dir / 'lr-export'}`。\n"
        "4. 終わったら Issue #18397 にコメントする。担当が `make_lr_p3_jpeg.py --check` で枚数と設定を確かめる。\n\n"
        f"{count} 枚（{len(items)} 場面 × {len(variants)} 設定）。"
        + ("独立評価用。担当は niho-6 の候補を凍結するまで画素を開かない。\n" if sealed else
           "niho-6 の教師（操作別・プリセット）。\n"),
        encoding="utf-8")
    print(f"{count} JPEG -> {inputs}")


def check(out_dir: Path) -> int:
    manifest = json.loads((out_dir / "manifest.json").read_text(encoding="utf-8"))
    sealed = manifest["sealed"]
    missing, mismatch, unchanged, hashes = [], [], [], {}
    pixels: dict[str, dict[str, bytes]] = {}
    for entry in manifest["files"]:
        file = out_dir / "lr-export" / entry["file"]
        if not file.is_file():
            missing.append(entry["file"])
            continue
        hashes[entry["file"]] = sha256(file)
        xmp = subprocess.run(["exiftool", "-b", "-XMP", str(file)], check=True, capture_output=True, text=True).stdout
        for key, value in manifest["variants"][entry["variant"]]["attributes"].items():
            actual = re.search(rf'\bcrs:{key}="([^"]*)"', xmp)
            try:
                number = float(value)
            except ValueError:
                number = None
            if actual is None:
                same = number == 0.0 or key in COMMON  # Lightroom may leave out a zero or a default
            elif number is None:
                same = actual.group(1) == value
            else:
                try:
                    same = float(actual.group(1)) == number
                except ValueError:
                    same = False
            if not same:
                mismatch.append(f"{entry['file']}: {key}={value}")
        if 'crs:AlreadyApplied="True"' not in xmp:
            mismatch.append(f"{entry['file']}: Lightroom の補正未適用")
        # プリセットのトーンカーブ（ToneCurvePV2012*）も書き出しに入っているか。点列を記録した manifest は点列まで照らす
        # （曲線を落とした・別の曲線を当てた書き出しを教師・独立評価に使わない）。古い manifest は曲線の有無だけを見る。
        variant = manifest["variants"][entry["variant"]]
        expected_points = variant.get("curvePoints")
        for name in variant.get("curves", []):
            found = re.search(rf"<crs:{name}>.*?</crs:{name}>", xmp, re.S)
            if found is None:
                mismatch.append(f"{entry['file']}: トーンカーブ {name} が無い")
            elif expected_points is not None and curve_points(found.group(0)) != expected_points.get(name):
                mismatch.append(f"{entry['file']}: トーンカーブ {name} の点が違う")
        if not sealed:
            from PIL import Image
            with Image.open(file) as image:
                image.draft("RGB", (64, 64))
                pixels.setdefault(entry["scene"], {})[entry["variant"]] = image.convert("RGB").resize((64, 64)).tobytes()
    if not sealed:
        for variant in manifest["variants"]:
            if variant == "neutral":
                continue
            complete = [v for v in pixels.values() if "neutral" in v and variant in v]
            if complete and all(v[variant] == v["neutral"] for v in complete):
                unchanged.append(f"{variant}: 全場面の画素が中立と同一")
    (out_dir / "lr-export-sha256.json").write_text(json.dumps(hashes, indent=1) + "\n", encoding="utf-8")
    print(f"{out_dir.name}: {len(manifest['files'])} 枚中 欠け {len(missing)}・設定違い {len(mismatch)}・"
          f"画素未変化 {len(unchanged)}" + ("（封印: 画素は見ていない）" if sealed else ""))
    for item in (missing + mismatch + unchanged)[:20]:
        print(" ", item)
    return 1 if missing or mismatch or unchanged else 0


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--ref", type=Path, default=Path(os.environ.get("NIHO_COLOR_REF_ROOT",
                                                                        PHOTOBENCH / "exports/lr-measure")))
    parser.add_argument("--selection", type=Path)
    parser.add_argument("--set", choices=("teachers", "teachers2", "independent"), required=True)
    parser.add_argument("--apple-raw-linear", type=Path, default=Path(os.environ.get(
        "NIHO_APPLE_RAW_LINEAR", Path(__file__).resolve().parents[1] / "apple-raw-linear/.build/release/apple-raw-linear")))
    parser.add_argument("--dry-run", action="store_true")
    parser.add_argument("--check", action="store_true")
    args = parser.parse_args()
    out_dir = args.ref / ROUND / args.set
    if args.check:
        return check(out_dir)
    if args.selection is None:
        parser.error("--selection が要る")
    selection = json.loads(args.selection.read_text(encoding="utf-8"))
    sealed = args.set == "independent"
    variants = independent_variants() if sealed else teacher_variants()
    # teachers2: the second teacher batch (R21: night / dark rooms / bright iPhone scenes), the same 22 settings.
    create(out_dir, selection[args.set], variants, args.apple_raw_linear, args.dry_run, sealed)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
