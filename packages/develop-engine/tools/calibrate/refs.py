#!/usr/bin/env python3
"""Lightroom 参照（Photo Bench の exports/lr-measure）のどの書き出しを使うかの決まり（1 か所）。

round6 にある場面は round6 を使う（全変種が Adobe Standard・Look 無し）。無ければ従来の round2（中立）/
round5（プリセット）。round2 / round1 / round5 の P1012822 / P1013207 / P1013558 は Adobe Color の Look が
混ざっているので、round6 が無いときもこの 3 場面の旧参照は使わない方がよい（LOOK_CONTAMINATED）。

  python3 refs.py neutral <ref> <scene>          → 中立の書き出し JPEG
  python3 refs.py preset <ref> <scene> <preset>  → プリセット全体の書き出し JPEG
  python3 refs.py lens <export.jpg>              → on / off（その書き出しで LR のレンズプロファイル補正が効いているか）

色の比較は、Apple 側のレンズ補正を参照の書き出しに合わせる（off 同士なら幾何は 0.1px で一致する）。
補正ありの参照（colorful プリセットは LensProfileEnable=1）には Apple の補正ありの作業コピーを当てる。
"""
from __future__ import annotations

import functools
import os
import subprocess
import sys

LOOK_CONTAMINATED = ("P1012822", "P1013207", "P1013558")
ROUND6_WB_KELVIN = (4000, 5500, 7500)


def _round6(ref: str, scene: str, variant: str) -> str:
    return os.path.join(ref, "round6", "lr-export", f"p6_{scene}_{variant}.jpg")


def _legacy_or_round6(ref: str, scene: str, variant: str, legacy: str) -> str:
    current = _round6(ref, scene, variant)
    if os.path.exists(current):
        return current
    if scene in LOOK_CONTAMINATED:
        raise FileNotFoundError(
            f"round6 {variant} reference is required for {scene}; older exports contain the Adobe Color Look"
        )
    return legacy


def neutral(ref: str, scene: str) -> str:
    legacy = os.path.join(ref, "round2", "lr-export-photos", f"p2_{scene}_neutral.jpg")
    return _legacy_or_round6(ref, scene, "neutral", legacy)


def preset(ref: str, scene: str, name: str) -> str:
    variant = f"full_{name}"
    legacy = os.path.join(ref, "round5", "lr-export", f"p5_{scene}_{variant}.jpg")
    return _legacy_or_round6(ref, scene, variant, legacy)


def wb_absolute(ref: str, scene: str, kelvin: int) -> str | None:
    """round6 の絶対 WB（Tint 0）。無ければ None（round1 の変種は Look が混ざっているので使わない）。"""
    p = _round6(ref, scene, f"wb_{kelvin}")
    return p if os.path.exists(p) else None


@functools.lru_cache(maxsize=None)
def lens_on(export: str) -> bool:
    out = subprocess.run(["exiftool", "-s3", "-XMP-crs:LensProfileEnable", export], capture_output=True, text=True).stdout.strip()
    return out == "1"


def linear_subdir(export: str) -> str:
    """apple-linear の下のどの版を候補にするか（v8 = Apple の補正あり、v8-nolens = なし）。"""
    return "v8" if lens_on(export) else "v8-nolens"


def working_copy_dir(export: str) -> str:
    return "working-copy" if lens_on(export) else "working-copy-nolens"


def main(argv: list[str]) -> int:
    if len(argv) >= 3 and argv[0] == "neutral":
        print(neutral(argv[1], argv[2]))
    elif len(argv) >= 4 and argv[0] == "preset":
        print(preset(argv[1], argv[2], argv[3]))
    elif len(argv) >= 2 and argv[0] == "lens":
        print("on" if lens_on(argv[1]) else "off")
    else:
        print(__doc__, file=sys.stderr)
        return 2
    return 0


if __name__ == "__main__":
    raise SystemExit(main(sys.argv[1:]))
