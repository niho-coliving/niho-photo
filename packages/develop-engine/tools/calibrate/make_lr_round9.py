#!/usr/bin/env python3
"""Lightroom の参照 round9 を作る（Epic #17114 E1c #17259・runbook §5）。

round8 で当てはめた効果（白黒・周辺光量補正・粒子）の、round8 に無い端の値を確かめるための参照。round8 と同じ 6 場面に
1 場面 19 通りの XMP を並べる。全変種を round6 の中立と同じ **Adobe Standard・Look 無し・PV 15.4・撮影時の WB・Linear・
レンズ補正なし** に揃える（書き出しだけでよい）。

  python3 make_lr_round9.py [--ref <lr-measure>] [--dry-run] [--check]

- 周辺光量補正の形: 中心点 0 / 100、ぼかし 0 / 100、丸み +100 / −100（量 −60）。負の丸みは round8 で効果の大半が比較で
  切り落とす外周 4% に入ったので、中心点を下げた組み合わせ（丸み −50・中心点 30）も足す。
- 明るくする側: ハイライト優先 +100、色優先 +50、ペイントオーバーレイ +50。
- ハイライト（`PostCropVignetteHighlightContrast`）50 / 100: 今は保持だけ。どれだけ変わるかを測る。
- 粒子: サイズ 0 / 100、粗さ 0 / 100（量 50）。白黒ミックス: 全色 +100 / −100。
- RAW は APFS のクローン（`cp -c`）なので実容量は増えない。出力先が空でなければ上書きせず止まる。
- 書き出し後は `--check`（round8 と同じ確認: 全枚数・Look 無しの Adobe Standard・効果の値が書き出しの XMP に残っていること）。
"""
from __future__ import annotations

import argparse
import json
import os
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from make_lr_round6 import NEUTRAL, PHOTOBENCH, clone, exif, packet  # noqa: E402
from make_lr_round8 import EXPORT_DIR, SCENES, check, grain, gray, round6_raws, vignette  # noqa: E402

BANDS = ("Red", "Orange", "Yellow", "Green", "Aqua", "Blue", "Purple", "Magenta")
# 形を見る変種の量（暗くする側。round8 の形 2 通りと同じ）
SHAPE_AMOUNT = -60


def variants() -> dict[str, dict[str, str]]:
    table = {
        "neutral": {},
        "vig_mid0": vignette(SHAPE_AMOUNT, Midpoint=0),
        "vig_mid100": vignette(SHAPE_AMOUNT, Midpoint=100),
        "vig_fea0": vignette(SHAPE_AMOUNT, Feather=0),
        "vig_fea100": vignette(SHAPE_AMOUNT, Feather=100),
        "vig_round_p100": vignette(SHAPE_AMOUNT, Roundness=100),
        "vig_round_m100": vignette(SHAPE_AMOUNT, Roundness=-100),
        "vig_round_m50_mid30": vignette(SHAPE_AMOUNT, Roundness=-50, Midpoint=30),
        "vig_p100": vignette(100),
        "vig_color_p50": vignette(50, Style=2),
        "vig_paint_p50": vignette(50, Style=3),
        "vig_hc50": vignette(SHAPE_AMOUNT, HighlightContrast=50),
        "vig_hc100": vignette(SHAPE_AMOUNT, HighlightContrast=100),
        "grain_size0": grain(50, 0, 50),
        "grain_size100": grain(50, 100, 50),
        "grain_rough0": grain(50, 50, 0),
        "grain_rough100": grain(50, 50, 100),
        "bw_all_p100": gray({band: 100 for band in BANDS}),
        "bw_all_m100": gray({band: -100 for band in BANDS}),
    }
    return {name: {**NEUTRAL, **settings} for name, settings in table.items()}


def write_readme(round_dir: Path, out: Path, export: Path, manifest: list[dict], n_variants: int) -> None:
    cameras = sorted({e["model"] for e in manifest})
    (round_dir / "README.md").write_text(
        "# LR計測 round9（効果の端の値。E1c #17259）— 書き出し 1 回、10〜15 分\n\n"
        f"1. Lightroom「ローカル」で次のフォルダを開く（Finder ⇧⌘G に貼る）:\n   `{out}`\n"
        "2. 全選択（⌘A）→ 書き出し（⇧⌘E）: **JPG・画質 100%・フルサイズ・sRGB・出力シャープ OFF・ファイル名そのまま**\n"
        f"   保存先: `{export}`\n"
        "3. 写真の現像設定・プロファイルには触らない。終わったら「round9 終わった」と伝える。\n\n"
        f"内容: RAW {len(manifest)} 枚（{len(SCENES)} 場面 × {n_variants} 通り・{', '.join(cameras)}。"
        "APFS のクローンなので実容量は増えない）。\n"
        "1 場面の通り: 中立、周辺光量補正 12 通り（中心点 0 / 100・ぼかし 0 / 100・丸み +100 / −100 / −50・明るくする側 3 通り・"
        "ハイライト 50 / 100）、粒子 4 通り（サイズ 0 / 100・粗さ 0 / 100）、白黒ミックス 2 通り（全色 +100 / −100）。"
        "すべて Adobe Standard・Look 無し（round6 の中立と同じ土台）。\n"
        f"場面: {', '.join(SCENES)}（round8 と同じ RAW）。\n"
        "書き出し後の確認（担当）: `python3 packages/develop-engine/tools/calibrate/make_lr_round9.py --check`"
        "（全枚数・Look 無しの Adobe Standard・効果の値）。\n",
        encoding="utf-8",
    )


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--ref", type=Path, default=Path(os.environ.get("NIHO_COLOR_REF_ROOT", PHOTOBENCH / "exports/lr-measure")))
    ap.add_argument("--dry-run", action="store_true", help="書かずに一覧だけ出す")
    ap.add_argument("--check", action="store_true", help="書き出し後の確認（枚数・プロファイル・効果の値）")
    args = ap.parse_args()
    round_dir = args.ref / "round9"
    if args.check:
        return check(round_dir)
    out, export = round_dir / "round9-photos", round_dir / EXPORT_DIR
    if out.exists() and any(out.iterdir()):
        raise SystemExit(f"{out} が空でない。上書きしないので中止する。")
    table = variants()
    manifest = []
    for scene, raw in round6_raws(args.ref).items():
        meta = exif(raw)
        for variant, attributes in table.items():
            stem = f"p9_{scene}_{variant}"
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
