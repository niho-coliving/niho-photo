#!/usr/bin/env python3
"""Lightroom の参照 round8 を作る（Epic #17114 E1 #17120・runbook §5）。

段 2 の crate に足した効果（白黒・周辺光量補正・粒子）を Lightroom の書き出しと比べるための参照。round6 と同じ RAW から
6 場面（DC-S5 4・ZV-E10 II 2。縦位置 1 枚を含む。周辺光量補正の楕円が枠の向きに沿うかを見る）を選び、1 場面 16 通りの
XMP を並べる。全変種を round6 の中立と同じ **Adobe Standard・Look 無し・PV 15.4・撮影時の WB・Linear・レンズ補正なし** に
揃える（Look 無しなので round7 の「Stubbed な Look が解決されない」罠は起きない。書き出しだけでよい）。

  python3 make_lr_round8.py [--ref <lr-measure>] [--dry-run] [--check]

- RAW は APFS のクローン（`cp -c`）なので実容量は増えない。出力先が空でなければ上書きせず止まる。
- 書き出し後は `--check` で、全枚数があること・Look 無しの Adobe Standard で書き出されたこと・manifest にある白黒ミキサー、
  周辺光量補正、粒子の全設定値が XMP のとおり書き出しに残っていることを確かめる。
- 粒子は統計（分散と粒の大きさ）で比べるので `GrainSeed` は書かない（Lightroom が決める）。
"""
from __future__ import annotations

import argparse
import json
import os
import re
import subprocess
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from make_lr_round6 import NEUTRAL, PHOTOBENCH, clone, exif, packet  # noqa: E402

# round6 の場面から。明るい空と緑・室内・縦位置・肌・Sony 2 機種ぶん。
SCENES = ("P1570133", "P1570302", "P1570923", "P1581387", "DSC09206", "DSC01835")
EXPORT_DIR = "lr-export"

GRAY_ZERO = {f"GrayMixer{band}": "0" for band in ("Red", "Orange", "Yellow", "Green", "Aqua", "Blue", "Purple", "Magenta")}
WARM_MIX = {"Red": 40, "Orange": 40, "Yellow": 20, "Green": -20, "Aqua": -30, "Blue": -40, "Purple": -10, "Magenta": 10}
VIGNETTE_DEFAULTS = {
    "PostCropVignetteMidpoint": "50",
    "PostCropVignetteRoundness": "0",
    "PostCropVignetteFeather": "50",
    "PostCropVignetteHighlightContrast": "0",
    "PostCropVignetteStyle": "1",
}


def gray(mix: dict[str, int] | None = None, sign: int = 1) -> dict[str, str]:
    values = dict(GRAY_ZERO)
    for band, value in (mix or {}).items():
        values[f"GrayMixer{band}"] = str(sign * value)
    return {"ConvertToGrayscale": "True", **values}


def vignette(amount: int, **overrides: int) -> dict[str, str]:
    values = {**VIGNETTE_DEFAULTS, "PostCropVignetteAmount": str(amount)}
    for key, value in overrides.items():
        values[f"PostCropVignette{key}"] = str(value)
    return values


def grain(amount: int, size: int, frequency: int) -> dict[str, str]:
    return {"GrainAmount": str(amount), "GrainSize": str(size), "GrainFrequency": str(frequency)}


def variants() -> dict[str, dict[str, str]]:
    toned = {
        "SplitToningShadowHue": "215",
        "SplitToningShadowSaturation": "25",
        "SplitToningHighlightHue": "40",
        "SplitToningHighlightSaturation": "25",
        "SplitToningBalance": "0",
    }
    table = {
        "neutral": {},
        "bw": gray(),
        "bw_warm": gray(WARM_MIX),
        "bw_cool": gray(WARM_MIX, sign=-1),
        "bw_toned": {**gray(), **toned},
        "vig_m50": vignette(-50),
        "vig_m100": vignette(-100),
        "vig_p50": vignette(50),
        "vig_shape": vignette(-60, Midpoint=25, Roundness=60, Feather=80),
        "vig_square": vignette(-60, Midpoint=70, Roundness=-80, Feather=20),
        "vig_color": vignette(-60, Style=2),
        "vig_paint": vignette(-60, Style=3),
        "grain_30": grain(30, 25, 50),
        "grain_60": grain(60, 50, 70),
        "grain_100": grain(100, 10, 20),
        # LR のフィルム系モノクロのプリセットの典型（白黒ミックス＋周辺光量補正＋粒子を 1 枚に）。
        "film_bw": {**gray(WARM_MIX), **vignette(-30), **grain(40, 25, 50)},
    }
    return {name: {**NEUTRAL, **settings} for name, settings in table.items()}


def round6_raws(ref: Path) -> dict[str, Path]:
    manifest = json.loads((ref / "round6" / "manifest.json").read_text(encoding="utf-8"))
    raws: dict[str, Path] = {}
    for entry in manifest:
        raws.setdefault(entry["scene"], Path(entry["raw"]))
    missing = [scene for scene in SCENES if scene not in raws or not raws[scene].exists()]
    if missing:
        raise SystemExit(f"round6 に RAW が無い場面: {missing}")
    return {scene: raws[scene] for scene in SCENES}


def write_readme(round_dir: Path, out: Path, export: Path, manifest: list[dict], n_variants: int) -> None:
    cameras = sorted({e["model"] for e in manifest})
    (round_dir / "README.md").write_text(
        "# LR計測 round8（白黒・周辺光量補正・粒子。E1 #17120）— 書き出し 1 回、10〜15 分\n\n"
        f"1. Lightroom「ローカル」で次のフォルダを開く（Finder ⇧⌘G に貼る）:\n   `{out}`\n"
        "2. 全選択（⌘A）→ 書き出し（⇧⌘E）: **JPG・画質 100%・フルサイズ・sRGB・出力シャープ OFF・ファイル名そのまま**\n"
        f"   保存先: `{export}`\n"
        "3. 写真の現像設定・プロファイルには触らない。終わったら「round8 終わった」と伝える。\n\n"
        f"内容: RAW {len(manifest)} 枚（{len(SCENES)} 場面 × {n_variants} 通り・{', '.join(cameras)}。"
        "APFS のクローンなので実容量は増えない）。\n"
        "1 場面の通り: 中立、白黒 4 通り（ミックスなし・暖色寄り・寒色寄り・調色）、周辺光量補正 7 通り（−50・−100・+50・形 2 通り・"
        "スタイル 2 通り）、粒子 3 通り、フィルム調の白黒 1 通り。すべて Adobe Standard・Look 無し（round6 の中立と同じ土台）。\n"
        f"場面: {', '.join(SCENES)}（round6 と同じ RAW）。\n"
        "書き出し後の確認（担当）: `python3 packages/develop-engine/tools/calibrate/make_lr_round8.py --check`"
        "（全枚数・Look 無しの Adobe Standard・効果の値）。\n",
        encoding="utf-8",
    )


def export_xmp(jpg: Path) -> str:
    return subprocess.run(["exiftool", "-b", "-XMP", str(jpg)], capture_output=True, text=True).stdout


# Lightroom は量がプラス（明るくする側）の書き出しに「ハイライト」を書かない（暗くする側だけの項目。round9 で確認）。
OMITTED_AT_DEFAULT = {"PostCropVignetteHighlightContrast"}


def is_effect_key(key: str) -> bool:
    return (
        key == "ConvertToGrayscale"
        or key.startswith(("GrayMixer", "PostCropVignette"))
        or key in {"GrainAmount", "GrainSize", "GrainFrequency"}
    )


def check(round_dir: Path) -> int:
    manifest = json.loads((round_dir / "manifest.json").read_text(encoding="utf-8"))
    export = round_dir / EXPORT_DIR
    missing, bad_profile, bad_effect = [], [], []
    for e in manifest:
        jpg = export / (Path(e["file"]).stem + ".jpg")
        if not jpg.exists():
            missing.append(jpg.name)
            continue
        xmp = export_xmp(jpg)
        profile = re.search(r'crs:CameraProfile="([^"]*)"', xmp)
        if "<crs:Look>" in xmp or not profile or profile.group(1) != "Adobe Standard":
            bad_profile.append(jpg.name)
        for key, want in e["settings"].items():
            if not is_effect_key(key):
                continue
            got = re.search(rf'crs:{key}="([^"]*)"', xmp)
            if not got and key in OMITTED_AT_DEFAULT and want == "0":
                continue
            if not got or got.group(1).lstrip("+") != want.lstrip("+"):
                bad_effect.append(f"{jpg.name} {key}={got.group(1) if got else None}（期待 {want}）")
    print(f"{len(manifest)} 枚中 欠け {len(missing)}・Adobe Standard（Look 無し）でない {len(bad_profile)}・"
          f"効果の値が違う {len(bad_effect)}")
    for line in missing[:20] + bad_profile[:20] + bad_effect[:20]:
        print(" ", line)
    return 1 if missing or bad_profile or bad_effect else 0


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--ref", type=Path, default=Path(os.environ.get("NIHO_COLOR_REF_ROOT", PHOTOBENCH / "exports/lr-measure")))
    ap.add_argument("--dry-run", action="store_true", help="書かずに一覧だけ出す")
    ap.add_argument("--check", action="store_true", help="書き出し後の確認（枚数・プロファイル・効果の値）")
    args = ap.parse_args()
    round_dir = args.ref / "round8"
    if args.check:
        return check(round_dir)
    out, export = round_dir / "round8-photos", round_dir / EXPORT_DIR
    if out.exists() and any(out.iterdir()):
        raise SystemExit(f"{out} が空でない。上書きしないので中止する。")
    table = variants()
    manifest = []
    for scene, raw in round6_raws(args.ref).items():
        meta = exif(raw)
        for variant, attributes in table.items():
            stem = f"p8_{scene}_{variant}"
            manifest.append({"file": f"{stem}{raw.suffix}", "folder": out.name, "scene": scene, "variant": variant,
                             "kind": "raw", "raw": str(raw), **meta, "settings": attributes})
            if not args.dry_run:
                out.mkdir(parents=True, exist_ok=True)
                clone(raw, out / f"{stem}{raw.suffix}")
                (out / f"{stem}.xmp").write_text(packet(attributes, {}), encoding="utf-8")
    if args.dry_run:
        for e in manifest[:: len(table)]:
            print(e["scene"], e["make"], e["model"], e["captured"], e["orientation"])
        print(f"{len(manifest)} files（{len(SCENES)} 場面 × {len(table)} 通り）— dry run")
        return 0
    export.mkdir(parents=True, exist_ok=True)
    (round_dir / "manifest.json").write_text(json.dumps(manifest, ensure_ascii=False, indent=2), encoding="utf-8")
    write_readme(round_dir, out, export, manifest, len(table))
    print(f"{len(manifest)} files -> {out}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
