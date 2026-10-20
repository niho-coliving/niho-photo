#!/usr/bin/env python3
"""Apple の as-shot 白（xy）と Adobe（Lightroom）の as-shot 白の対応を当てる。

Apple（CIRAWFilter の neutralChromaticity / neutralTemperature / neutralTint）と Adobe（Lightroom が
書き出し JPEG の XMP に残す ColorTemperature / Tint）は同じ DNG の温度モデル（Robertson・tint = uv × −3000）を
使っているが、カメラの特性づけが違うので同じ RAW でも as-shot の xy が違う。段 2 が Lightroom の絶対 WB
（K・tint）を再現するには、色順応の出発点を「Adobe が as-shot と見る白」に置く必要がある。

  python3 fit_wb_map.py --work <work> --ref <lr-measure> --out <work>/wb-exp/asshot-map.json

モデル: 定数の uv オフセット（uv_adobe = uv_apple + Δuv）。参照が 3 つの光源群しかないので、それ以上の
自由度（アフィン・ミレッド依存）は当てはまるだけで検証できないため採らない（残差は表で出す）。
"""
from __future__ import annotations

import argparse
import json
import os
import subprocess

import numpy as np

import refs
from wbmodel import temperature_from_xy, xy_from_temperature

SCENES = ("P1012822 P1013207 P1013558 P1522877 P1524180 P1524181 P1581215 P1581237 P1581243 P1581255 P1581256 P1581332 P1581335 P1581346 P1581356 P1581368 "
          "P1570133 P1570135 P1570258 P1570266 P1570280 P1570302 P1570396 P1570586 P1570755 P1570923").split()


def xy_to_uv(x, y):
    d = 1.5 - x + 6.0 * y
    return 2.0 * x / d, 3.0 * y / d


def uv_to_xy(u, v):
    d = u - 4.0 * v + 2.0
    return 1.5 * u / d, v / d


def adobe_asshot(ref: str, scene: str):
    out = subprocess.run(["exiftool", "-s3", "-XMP-crs:ColorTemperature", "-XMP-crs:Tint",
                          refs.neutral(ref, scene)],
                         capture_output=True, text=True).stdout.split()
    return float(out[0]), float(out[1])


def main(argv=None) -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--work", default=os.environ.get("NIHO_COLOR_WORK_DIR", "OWNER_DATA_ROOT"))
    ap.add_argument("--ref", default=os.environ.get("NIHO_COLOR_REF_ROOT", "OWNER_DATA_ROOT"))
    ap.add_argument("--out", required=True)
    ap.add_argument("--scenes", nargs="*", default=SCENES)
    args = ap.parse_args(argv)
    rows = []
    for s in args.scenes:
        m = json.load(open(os.path.join(args.work, "apple-linear/v8", f"{s}.json")))["neutral"]
        k_a, t_a = adobe_asshot(args.ref, s)
        xa = xy_from_temperature(k_a, t_a)
        up, vp = xy_to_uv(m["x"], m["y"])
        ua, va = xy_to_uv(*xa)
        rows.append({"scene": s, "apple": {"x": m["x"], "y": m["y"], "K": m["temperatureK"], "tint": m["tint"]},
                     "adobe": {"K": k_a, "tint": t_a, "x": xa[0], "y": xa[1]}, "du": ua - up, "dv": va - vp})
    du = np.array([r["du"] for r in rows]); dv = np.array([r["dv"] for r in rows])
    du0, dv0 = float(du.mean()), float(dv.mean())
    print(f"{'scene':9s} {'Apple K/tint':>13s} {'Adobe K/tint':>13s} {'Δu':>9s} {'Δv':>9s} | 定数モデルの残差 → K/tint")
    resid = []
    for r in rows:
        up, vp = xy_to_uv(r["apple"]["x"], r["apple"]["y"])
        pred = uv_to_xy(up + du0, vp + dv0)
        kp, tp = temperature_from_xy(*pred)
        resid.append((r["adobe"]["K"] - kp, r["adobe"]["tint"] - tp))
        print(f"{r['scene']:9s} {r['apple']['K']:6.0f}/{r['apple']['tint']:+5.1f} {r['adobe']['K']:6.0f}/{r['adobe']['tint']:+5.0f} {r['du']:+9.5f} {r['dv']:+9.5f} | {resid[-1][0]:+5.0f} K / {resid[-1][1]:+5.1f} tint")
    resid = np.array(resid)
    print(f"\n定数 uv オフセット Δu {du0:+.5f} Δv {dv0:+.5f}（sd {du.std():.5f} / {dv.std():.5f}）。残差: K sd {resid[:,0].std():.0f}（最大 {np.abs(resid[:,0]).max():.0f}）、tint sd {resid[:,1].std():.1f}（最大 {np.abs(resid[:,1]).max():.1f}）")
    out = {"schema": "niho-develop-wb-map/v1", "camera": {"make": "Panasonic", "model": "DC-S5", "id": "panasonic-dc-s5"},
           "track": "apple", "model": "uv-offset", "description": "uv_adobe = uv_apple + [du, dv]（CIE 1960 uv。Apple の as-shot xy から Adobe が as-shot と見る白を予測）",
           "du": round(du0, 6), "dv": round(dv0, 6), "fit": {"scenes": len(rows), "duSd": round(float(du.std()), 6), "dvSd": round(float(dv.std()), 6),
           "residualKSd": round(float(resid[:, 0].std()), 1), "residualTintSd": round(float(resid[:, 1].std()), 2),
           "residualTintMax": round(float(np.abs(resid[:, 1]).max()), 2), "rows": rows}}
    os.makedirs(os.path.dirname(os.path.abspath(args.out)), exist_ok=True)
    json.dump(out, open(args.out, "w"), indent=1, ensure_ascii=False)
    print("→", args.out)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
