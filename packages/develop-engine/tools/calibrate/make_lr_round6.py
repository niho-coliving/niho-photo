#!/usr/bin/env python3
"""Lightroom の参照 round6 を作る（Epic #16939 S9 #16972・runbook §5）。

owner が round6 フォルダ直下に置いた RAW と、round2 で Adobe Color の Look が混ざった旧 3 場面
（P1012822 / P1013207 / P1013558。基準サイドカーの Look を引き継いでいた）を、1 場面 8 通り（round6-photos-3 から。それより前は 7 通り）の XMP で並べる。
Photo Bench の scripts/lr_measure/make_round5.py を踏襲する（Photo Bench は読むだけ）。

  python3 make_lr_round6.py [--ref <lr-measure>] [--photobench <photo-edit-app>] [--dry-run] [--add] [--check] [--variants neutral,neutral_lens]

- `--add`: 最初の生成の後に owner が足した RAW（manifest に無い場面）だけを、次の空きフォルダ `round6-photos-<n>` に作り、
  manifest と README に追記する（書き出し先は同じ `lr-export/`。既にある複製と書き出しには触らない）。
- `--variants`: `--add` と組み合わせ、必要な変種だけを作る（例: FX30 の中立と中立＋レンズ補正）。

- RAW は APFS のクローン（`cp -c`）なので実容量は増えない。出力先が空でなければ上書きせず止まる。
- 全変種を **Adobe Standard・Look 無し・PV 15.4** に揃える（round2 の旧 3 場面の Look 混入を繰り返さない）。
  書き出し後は `--check` で、LR が実際に Look 無しの Adobe Standard で書き出したかを確かめる。
- プリセットは round5 と同じ扱い: 管理用の属性・プロファイル（CameraProfile / Look）を落として設定だけを当てる。
  bluesky2 の `WhiteBalance="Custom"`（値なし）もそのまま残す（LR は 5001K / +10 と解釈する）。
"""
from __future__ import annotations

import argparse
import json
import os
import re
import shutil
import subprocess
import sys
from pathlib import Path

from raw_extensions import RAW_SUFFIXES

PHOTOBENCH = Path("OWNER_DATA_ROOT")
# round2 の中立に Adobe Color の Look が入っていた場面（基準サイドカー由来）。Look 無しで取り直す。
REEXPORT = ("P1012822", "P1013207", "P1013558")
PRESETS = {
    "bluesky2": "niho-preset bluesky2.xmp",
    "pastel": "niho-preset pastel.xmp",
    "colorful": "niho-priset_colorful.xmp",
}
WB_KELVIN = (4000, 5500, 7500)
NEUTRAL = {"CameraProfile": "Adobe Standard", "WhiteBalance": "As Shot", "ToneCurveName2012": "Linear",
           "LensProfileEnable": "0", "AutoLateralCA": "0"}
NON_SETTING = re.compile(
    r"^(PresetType|Cluster|UUID|Supports\w+|RequiresRGBTables|ShowInPresets|ShowInQuickActions|"
    r"CameraModelRestriction|Copyright|ContactInfo|Version|ProcessVersion|HasSettings)$"
)
PROFILE_KEYS = {"CameraProfile", "CameraProfileDigest", "LookTable", "Look"}
CURVE_ELEMENTS = ("ToneCurvePV2012", "ToneCurvePV2012Red", "ToneCurvePV2012Green", "ToneCurvePV2012Blue")


def without_look(text: str) -> str:
    start, end = text.find("<crs:Look>"), text.find("</crs:Look>")
    return text if start < 0 or end < 0 else text[:start] + text[end + len("</crs:Look>"):]


def preset_settings(path: Path) -> tuple[dict[str, str], dict[str, str]]:
    body = without_look(path.read_text(encoding="utf-8"))
    attributes = {k: v for k, v in re.findall(r'\bcrs:(\w+)="([^"]*)"', body)
                  if not NON_SETTING.match(k) and k not in PROFILE_KEYS}
    elements = {}
    for name in CURVE_ELEMENTS:
        match = re.search(rf"<crs:{name}>.*?</crs:{name}>", body, re.S)
        if match:
            elements[name] = match.group(0)
    return attributes, elements


def packet(attributes: dict[str, str], elements: dict[str, str]) -> str:
    merged = {"Version": "18.3", "ProcessVersion": "15.4", **attributes, "HasSettings": "True", "AlreadyApplied": "False"}
    attribute_text = "\n".join(f'   crs:{k}="{v}"' for k, v in merged.items())
    element_text = "\n".join(f"   {block}" for block in elements.values())
    return (
        '<x:xmpmeta xmlns:x="adobe:ns:meta/">\n'
        ' <rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#">\n'
        '  <rdf:Description rdf:about=""\n'
        '   xmlns:crs="http://ns.adobe.com/camera-raw-settings/1.0/"\n'
        f"{attribute_text}>\n{element_text}\n"
        "  </rdf:Description>\n </rdf:RDF>\n</x:xmpmeta>\n"
    )


def variants(photobench: Path) -> dict[str, tuple[dict[str, str], dict[str, str]]]:
    out: dict[str, tuple[dict[str, str], dict[str, str]]] = {"neutral": (dict(NEUTRAL), {})}
    # S10b #17031: 中立に Lightroom のレンズプロファイル補正だけを足した変種（LR の既定のプロファイル・色収差は切ったまま）。
    # レンズ補正の確かめ（tools/lens-check）の参照。round6-photos-3 から（それより前の場面には無い）。
    out["neutral_lens"] = ({**NEUTRAL, "LensProfileEnable": "1", "LensProfileSetup": "LensDefaults"}, {})
    for name, file in PRESETS.items():
        attributes, elements = preset_settings(photobench / file)
        # 設定に無い項目は中立（Adobe Standard・Linear 以外は LR 既定）に任せる。プリセットの値が優先。
        out[f"full_{name}"] = ({"CameraProfile": "Adobe Standard", **attributes}, elements)
    for k in WB_KELVIN:
        out[f"wb_{k}"] = ({**NEUTRAL, "WhiteBalance": "Custom", "Temperature": str(k), "Tint": "0"}, {})
    return out


def exif(raw: Path) -> dict[str, str]:
    r = subprocess.run(["exiftool", "-j", "-Make", "-Model", "-DateTimeOriginal", "-Orientation", str(raw)],
                       capture_output=True, text=True, check=True)
    d = json.loads(r.stdout)[0]
    return {"make": d.get("Make", ""), "model": d.get("Model", ""), "captured": d.get("DateTimeOriginal", ""),
            "orientation": d.get("Orientation", "")}


def clone(src: Path, dst: Path) -> None:
    if subprocess.run(["cp", "-c", str(src), str(dst)], capture_output=True).returncode != 0:
        shutil.copy2(src, dst)
        print("warning: 通常コピー", dst.name, file=sys.stderr)


def sources(round_dir: Path, photobench: Path, known: set[str]) -> list[tuple[str, Path, str]]:
    raws = sorted(p for p in round_dir.iterdir() if p.is_file() and p.suffix.lower() in RAW_SUFFIXES)
    items = [(p.stem, p, "new") for p in raws if p.stem not in known]
    reference = photobench / "exports/editing-mvp-20260922/lightroom-reference"
    for scene in () if known else REEXPORT:
        raw = reference / f"{scene}.RW2"
        if not raw.exists():
            raise SystemExit(f"旧場面の RAW が無い: {raw}")
        items.append((scene, raw, "reexport-no-look"))
    seen = [s for s, _, _ in items]
    dupes = {s for s in seen if seen.count(s) > 1}
    if dupes:
        raise SystemExit(f"場面名が重複: {sorted(dupes)}")
    return items


def append_readme(round_dir: Path, out: Path, export: Path, added: list[dict], variant_names: list[str]) -> None:
    scenes = sorted({e["scene"] for e in added})
    cameras = sorted({f'{e["make"]} {e["model"]}' for e in added})
    with (round_dir / "README.md").open("a", encoding="utf-8") as f:
        f.write(
            f"\n## 追加分（{out.name}）— 書き出し 1 回\n\n"
            f"1. Lightroom「ローカル」で `{out}` を開き、全選択 → 書き出し（上と同じ設定）。保存先も同じ `{export}`。\n"
            f"2. 内容: RAW {len(added)} 枚（{len(scenes)} 場面 × {len(variant_names)} 通り・{', '.join(cameras)}）: {', '.join(scenes)}。\n"
            f"   変種: {', '.join(variant_names)}。\n"
        )


def write_readme(round_dir: Path, out: Path, export: Path, manifest: list[dict], n_scenes: int, n_variants: int) -> None:
    new = sorted({e["scene"] for e in manifest if e["source"] == "new"})
    (round_dir / "README.md").write_text(
        "# LR計測 round6（昼光の屋外・窓際・肌の追加 ＋ 旧 3 場面の Adobe Standard 取り直し）— 書き出し 1 回、10〜15 分\n\n"
        f"1. Lightroom「ローカル」で次のフォルダを開く（Finder ⇧⌘G に貼る）:\n   `{out}`\n"
        "2. 全選択（⌘A）→ 書き出し（⇧⌘E）: **JPG・画質 100%・フルサイズ・sRGB・出力シャープ OFF・ファイル名そのまま**\n"
        f"   保存先: `{export}`\n"
        "3. 写真の現像設定・プロファイルには触らない。終わったら「round6 終わった」と伝える。\n\n"
        f"内容: RAW {len(manifest)} 枚（{n_scenes} 場面 × {n_variants} 通り。APFS のクローンなので実容量は増えない）。\n"
        f"1 場面の {n_variants} 通り: 中立（Adobe Standard・撮影時の WB・Linear）、中立＋レンズプロファイル補正、プリセット 3 本"
        "（bluesky2 / pastel / colorful）、色温度固定 3 本（4000K / 5500K / 7500K・Tint 0）。すべて Adobe Standard・Look 無し。\n"
        f"新しい場面（{len(new)}）: {', '.join(new)}。\n"
        f"取り直し（{len(REEXPORT)}）: {', '.join(REEXPORT)} — round2 の中立・round1 の色温度・round5 のプリセットで "
        "Adobe Color の Look が混ざっていたため。\n"
        "書き出し後の確認（担当）: `python3 packages/develop-engine/tools/calibrate/make_lr_round6.py --check`"
        "（全枚数があること・Look 無しの Adobe Standard で書き出されたこと）。\n",
        encoding="utf-8",
    )


def check(round_dir: Path) -> int:
    manifest = json.loads((round_dir / "manifest.json").read_text(encoding="utf-8"))
    export = round_dir / "lr-export"
    bad, missing = [], []
    for e in manifest:
        jpg = export / (Path(e["file"]).stem + ".jpg")
        if not jpg.exists():
            missing.append(jpg.name)
            continue
        xmp = subprocess.run(["exiftool", "-b", "-XMP", str(jpg)], capture_output=True, text=True).stdout
        profile = re.search(r'crs:CameraProfile="([^"]*)"', xmp)
        if "<crs:Look>" in xmp or not profile or profile.group(1) != "Adobe Standard":
            bad.append(jpg.name)
    print(f"{len(manifest)} 枚中 欠け {len(missing)}・Adobe Standard（Look 無し）でない {len(bad)}")
    for name in missing[:20] + bad[:20]:
        print(" ", name)
    return 1 if missing or bad else 0


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--ref", type=Path, default=Path(os.environ.get("NIHO_COLOR_REF_ROOT", PHOTOBENCH / "exports/lr-measure")))
    ap.add_argument("--photobench", type=Path, default=PHOTOBENCH)
    ap.add_argument("--dry-run", action="store_true", help="書かずに一覧だけ出す")
    ap.add_argument("--check", action="store_true", help="書き出し後の確認（lr-export の枚数と Look 無しの Adobe Standard）")
    ap.add_argument("--add", action="store_true", help="manifest に無い RAW だけを次の round6-photos-<n> に足す")
    ap.add_argument("--variants", help="生成する変種のカンマ区切り（省略時は全変種）")
    args = ap.parse_args()
    if args.variants and (not args.add or args.check):
        raise SystemExit("--variants は --add と組み合わせてください")
    round_dir = args.ref / "round6"
    if args.check:
        return check(round_dir)
    out, export = round_dir / "round6-photos", round_dir / "lr-export"
    previous: list[dict] = []
    if args.add:
        previous = json.loads((round_dir / "manifest.json").read_text(encoding="utf-8"))
        n = 2
        while (round_dir / f"round6-photos-{n}").exists():
            n += 1
        out = round_dir / f"round6-photos-{n}"
    elif out.exists() and any(out.iterdir()):
        raise SystemExit(f"{out} が空でない。上書きしないので中止する（足すときは --add）。")
    table = variants(args.photobench)
    if args.variants:
        selected = [name.strip() for name in args.variants.split(",")]
        if not selected or any(name not in table for name in selected) or len(selected) != len(set(selected)):
            raise SystemExit(f"--variants が不正です。選択可能: {', '.join(table)}")
        table = {name: table[name] for name in selected}
    manifest = []
    for scene, raw, source in sources(round_dir, args.photobench, {e["scene"] for e in previous}):
        meta = exif(raw)
        for variant, (attributes, elements) in table.items():
            stem = f"p6_{scene}_{variant}"
            manifest.append({"file": f"{stem}{raw.suffix}", "folder": out.name, "scene": scene, "variant": variant, "kind": "raw",
                             "source": source, "raw": str(raw), **meta, "settings": attributes, "curves": sorted(elements)})
            if not args.dry_run:
                out.mkdir(parents=True, exist_ok=True)
                clone(raw, out / f"{stem}{raw.suffix}")
                (out / f"{stem}.xmp").write_text(packet(attributes, elements), encoding="utf-8")
    scenes = len({e["scene"] for e in manifest})
    if not manifest:
        print("足す RAW が無い")
        return 0
    if args.dry_run:
        for e in manifest[:: len(table)]:
            print(e["scene"], e["source"], e["make"], e["model"], e["captured"], e["orientation"])
        print(f"{len(manifest)} files（{scenes} 場面 × {len(table)} 通り）— dry run")
        return 0
    export.mkdir(parents=True, exist_ok=True)
    (round_dir / "manifest.json").write_text(json.dumps(previous + manifest, ensure_ascii=False, indent=2), encoding="utf-8")
    if args.add:
        append_readme(round_dir, out, export, manifest, list(table))
    else:
        write_readme(round_dir, out, export, manifest, scenes, len(table))
    print(f"{len(manifest)} files -> {out}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
