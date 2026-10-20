#!/usr/bin/env python3
"""Lightroom の絶対 WB（K・tint）を段 2 で再現する式の検証。

3 つの出発点（色順応の source）を比べる:
  H1 apple-xy   : source = Apple の as-shot xy（crate の今の式）
  H2 adobe-exact: source = Lightroom が as-shot と見た白（LR 書き出しの XMP の K/tint。本番では得られない上限）
  H3 adobe-map  : source = Apple xy を fit_wb_map.py の uv オフセットで写した白（本番で使える式）
target = xy_from_temperature(K, tint)（Adobe の値）。CAT は crate と同じ Bradford（wbmodel.wb_matrix_prophoto）。
校正済みの作業コピーに行列を焼いて crate で描き（neutral、bluesky2 は同梱プリセット）、LR 書き出しと比べる。

  python3 wb_validate.py --map <asshot-map.json> --bridge <render_working_copy> [--work ...] [--ref ...] --out <dir>
"""
from __future__ import annotations

import argparse
import json
import os
import shutil
import subprocess
import sys

import cv2
import numpy as np

import refs
from fit_wb_map import adobe_asshot, uv_to_xy, xy_to_uv
from wbmodel import wb_matrix_prophoto, xy_from_temperature

HERE = os.path.dirname(os.path.abspath(__file__))
CC = os.path.join(HERE, "..", "colorcheck", "colorcheck.py")
GAMMA, CEIL = 1.8, 2.0


def read_wc(png):
    code = cv2.imread(png, cv2.IMREAD_UNCHANGED)[..., ::-1].astype(np.float64)
    return CEIL * np.power(code / 65535.0, GAMMA)


def write_wc(rgb, png):
    code = np.rint(np.power(np.clip(rgb, 0.0, CEIL) / CEIL, 1.0 / GAMMA) * 65535.0).astype(np.uint16)
    cv2.imwrite(png, np.ascontiguousarray(code[..., ::-1]))


def compare(reference, candidate, out, label):
    r = subprocess.run([sys.executable, CC, "compare", "--reference", reference, "--candidate", candidate, "--candidate-space", "srgb",
                        "--kind", "preset", "--label", label, "--out", out], capture_output=True, text=True)
    if r.returncode != 0:
        raise RuntimeError(r.stderr[-500:])
    m = json.load(open(out))["metrics"]
    return m["deltaE00"]["mean"], m["deltaE00"]["p99"], m["evDiff"], m["saturationRatio"]


def main(argv=None) -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--work", default=os.environ.get("NIHO_COLOR_WORK_DIR", "OWNER_DATA_ROOT"))
    ap.add_argument("--ref", default=os.environ.get("NIHO_COLOR_REF_ROOT", "OWNER_DATA_ROOT"))
    ap.add_argument("--map", required=True)
    ap.add_argument("--bridge", required=True)
    ap.add_argument("--out", required=True)
    ap.add_argument("--sources", default="asshot,H1,H2,H3", help="比べる出発点（asshot,H1,H2,H3）")
    ap.add_argument("--cats", default="bradford", help="色順応の種類（bradford,cat02,xyz,diag-prophoto）")
    ap.add_argument("--cases", default="round6,bluesky2",
                    help="round6 = round6 の絶対 WB 4000/5500/7500K（Look 無し）、round1 = 旧 3 場面の変種（Adobe Color の Look 入り・履歴用）、bluesky2")
    ap.add_argument("--scenes", nargs="*", default=None, help="round6 の絶対 WB を測る場面（既定: round6 に書き出しがある全場面）")
    ap.add_argument("--preset-scenes", nargs="*", default=["P1012822", "P1013207", "P1013558", "P1524180", "P1581215"],
                    help="bluesky2 を測る場面（参照は refs.preset = round6 優先）")
    args = ap.parse_args(argv)
    sources_sel = args.sources.split(",")
    cats = args.cats.split(",")
    wbmap = json.load(open(args.map))
    os.makedirs(args.out, exist_ok=True)
    cases = []
    if "round6" in args.cases:
        scenes = args.scenes
        if scenes is None:
            d = os.path.join(args.ref, "round6", "lr-export")
            scenes = sorted({n[3:-len("_neutral.jpg")] for n in os.listdir(d) if n.startswith("p6_") and n.endswith("_neutral.jpg")}) if os.path.isdir(d) else []
        for s in scenes:
            if not os.path.exists(os.path.join(args.work, "working-copy-nolens", f"{s}.json")):
                continue   # 別カメラなど、この作業ディレクトリに作業コピーが無い場面
            for k in refs.ROUND6_WB_KELVIN:
                p = refs.wb_absolute(args.ref, s, k)
                if p:
                    cases.append({"scene": s, "name": f"wb_{k}", "K": k, "tint": 0, "settings": "neutral", "reference": p})
    for s in (("P1012822", "P1013207", "P1013558") if "round1" in args.cases else ()):
        for v, k, t in (("Temperature_4000", 4000, 0), ("Temperature_7500", 7500, 0), ("Tint_+30", 5500, 30)):
            cases.append({"scene": s, "name": v, "K": k, "tint": t, "settings": "neutral",
                          "reference": os.path.join(args.ref, "round1/lr-export-photos", f"p1_{s}_{v}.jpg")})
    for s in (args.preset_scenes if "bluesky2" in args.cases else ()):
        cases.append({"scene": s, "name": "bluesky2", "K": 5001, "tint": 10, "settings": "niho-bluesky2",
                      "reference": refs.preset(args.ref, s, "bluesky2")})
    results = []
    cols = [h for h in ("asshot",) if h in sources_sel] + [f"{h}/{c}" for h in ("H1", "H2", "H3") if h in sources_sel for c in cats]
    print(f"{'case':28s} " + " ".join(f"{c:>16s}" for c in cols))
    for c in cases:
        s = c["scene"]
        wcd = os.path.join(args.work, refs.working_copy_dir(c["reference"]))   # 参照のレンズ補正に合わせる
        meta = json.load(open(os.path.join(wcd, f"{s}.json")))
        apple_xy = (meta["asShotWhite"]["x"], meta["asShotWhite"]["y"])
        k_a, t_a = adobe_asshot(args.ref, s)
        u, v = xy_to_uv(*apple_xy)
        sources = {"H1": apple_xy, "H2": xy_from_temperature(k_a, t_a), "H3": uv_to_xy(u + wbmap["du"], v + wbmap["dv"])}
        target = xy_from_temperature(c["K"], c["tint"])
        wc = read_wc(os.path.join(wcd, f"{s}.png"))
        row = {"case": f"{c['name']}/{s}", "K": c["K"], "tint": c["tint"], "results": {}}
        line = f"{row['case']:28s}"
        for col in cols:
            hyp, cat = (col, None) if col == "asshot" else col.split("/")
            d = os.path.join(args.out, col.replace("/", "_")); os.makedirs(d, exist_ok=True)
            png = os.path.join(d, f"{c['name']}_{s}.png"); mjs = os.path.join(d, f"{c['name']}_{s}.json"); jpg = os.path.join(d, f"{c['name']}_{s}.jpg")
            if hyp == "asshot":
                write_wc(wc, png)
            else:
                m = wb_matrix_prophoto(sources[hyp], target, cat)
                write_wc(wc @ m.T, png)
            shutil.copy(os.path.join(wcd, f"{s}.json"), mjs)
            r = subprocess.run([args.bridge, png, mjs, c["settings"], "0", jpg, "97"], capture_output=True, text=True)
            if r.returncode != 0:
                raise RuntimeError(f"bridge failed: {r.stderr[-300:]}")
            de, p99, ev, sat = compare(c["reference"], jpg, os.path.join(d, f"{c['name']}_{s}.compare.json"), f"wb/{col}/{row['case']}")
            row["results"][col] = {"deltaE00Mean": de, "deltaE00P99": p99, "evDiff": ev, "saturationRatio": sat}
            line += f" {de:16.2f}"
        print(line, flush=True)
        results.append(row)
    def avg(sel):
        return {h: round(float(np.mean([r["results"][h]["deltaE00Mean"] for r in sel])), 2) for h in cols}
    print(f"\n平均（全 {len(results)} ケース）:", avg(results))
    r1 = [r for r in results if not r["case"].startswith("bluesky2")]; b2 = [r for r in results if r["case"].startswith("bluesky2")]
    if r1: print(f"平均（絶対 WB の変種 {len(r1)}）:", avg(r1))
    if b2: print(f"平均（bluesky2 {len(b2)} 場面）:", avg(b2))
    json.dump({"schema": "niho-develop-wb-validate/v1", "map": args.map, "cases": results}, open(os.path.join(args.out, "wb-validate.json"), "w"), indent=1, ensure_ascii=False)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
