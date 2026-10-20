#!/usr/bin/env python3
"""NIHO 標準ルックの係数を当てはめる（Epic #16939 S8 #16947）。式は `look.py`、手順は README「NIHO 標準ルック」。

目標は Lightroom の中立＋Adobe Color の書き出し（round7 `lr-export-color/p7_<scene>_color_neutral.jpg`）。候補は
作業コピー（`make_working_copies.py` の 16bit PNG・gamma 1.8・上限 2.0・校正済み）に 2^baselineEV を掛けた「ルックの前」の
線形 ProPhoto で、モデルは段 2 の neutral と同じ `ルックの HSV → ACR3（RGBTone）→ ルックのトーン（--tone-stage point-curve
なら点カーブの段、pre-acr3 なら ACR3 の前）→ sRGB`（`render_look`）。
場面の揃え方・セル・除外条件・目的関数（場面ごとに等しい重みの ΔE00 の平均）・解き方（IRLS + LM）は `fit_base.py` と同じ。

  python3 fit_look.py --manifest m.json --out look.json [--report fit.md] [--hue-nodes 12] [--sat-node 0.3]
      [--tone-stage point-curve|pre-acr3] [--size 1500] [--blur 2] [--grid 48x32] [--max-iter 60] [--reg 0.3] [--no-pixel-eval]

manifest: {"items": [{"scene", "reference", "workingCopy", "split": "train|val"}]}（`workingCopy` の隣に同名の .json メタ）。
"""
from __future__ import annotations

import argparse
import hashlib
import json
import os
import sys
import time

import cv2
import numpy as np

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
sys.path.insert(0, os.path.normpath(os.path.join(HERE, "..", "colorcheck")))

import fit_base as FB  # noqa: E402
from look import STAGE_POINT_CURVE, SPACE_FOR_STAGE, Look  # noqa: E402

from colorcheck import color as C  # noqa: E402
from colorcheck import compare as CMP  # noqa: E402
from colorcheck.util import now_iso  # noqa: E402

WORKING_COPY_GAMMA = 1.8
WORKING_COPY_MAX = 2.0
HUE_UNIT_DEG = 10.0  # θ の色相のずれの単位（LM の条件を揃える）


def render_look(look: Look, rgb: np.ndarray, curve) -> np.ndarray:
    """段 2 の neutral（RAW）と同じ順の表示レンダリング（線形 sRGB・[0, 1]）。"""
    t = C.rgb_tone(np.clip(look.pre_acr3(rgb), 0.0, None), curve)
    t = look.point_curve(t)
    return np.clip(C.apply_matrix(t, C.M_PP_TO_SRGB), 0.0, 1.0)


def log(msg: str) -> None:
    print(f"[fit_look] {msg}", file=sys.stderr, flush=True)


def prelook_cache_path(working_copy: str, cache_dir: str, baseline_ev: float) -> str:
    ev_key = hashlib.sha256(baseline_ev.hex().encode("ascii")).hexdigest()[:12]
    stem = os.path.splitext(os.path.basename(working_copy))[0]
    return os.path.join(cache_dir, f"{stem}-ev-{ev_key}.tiff")


def prelook_tiff(working_copy: str, cache_dir: str) -> tuple[str, float]:
    """作業コピー → 露出前の線形 ProPhoto × 2^baselineEV の float TIFF（crate の neutral がルックに渡す値）。"""
    with open(os.path.splitext(working_copy)[0] + ".json", encoding="utf-8") as f:
        meta = json.load(f)
    ev = float(meta.get("baselineEV") or 0.0)
    os.makedirs(cache_dir, exist_ok=True)
    out = prelook_cache_path(working_copy, cache_dir, ev)
    if not os.path.exists(out) or os.path.getmtime(out) < os.path.getmtime(working_copy):
        raw = cv2.imread(working_copy, cv2.IMREAD_UNCHANGED)
        if raw is None or raw.dtype != np.uint16:
            raise SystemExit(f"{working_copy}: 16bit PNG の作業コピーではない")
        rgb = raw[..., ::-1].astype(np.float32) / 65535.0
        lin = WORKING_COPY_MAX * rgb ** WORKING_COPY_GAMMA * np.float32(2.0 ** ev)
        cv2.imwrite(out, lin[..., ::-1].astype(np.float32))
    return out, ev


class LookModel:
    """θ → ルック → 表示 → Lab。`fit_base.fit_lm` が使う weights / de / objective を持つ。"""

    def __init__(self, scenes: list, template: Look):
        self.scenes = scenes
        self.template = template
        self.curve = C.load_tone_curve()
        self.rgb = np.concatenate([s.rgb for s in scenes])
        self.lab = np.concatenate([s.lab for s in scenes])
        counts = [len(s.rgb) for s in scenes]
        self.weights = np.concatenate([np.full(n, 1.0 / (n * len(scenes))) for n in counts])
        self.scene_index = np.concatenate([np.full(n, i) for i, n in enumerate(counts)])
        self.n_hsv = template.hsv.size
        self.inner = np.arange(1, len(template.tone_x) - 1)

    def size(self) -> int:
        return self.n_hsv + len(self.inner)

    def unpack(self, theta) -> Look:
        hsv = np.asarray(theta[: self.n_hsv], dtype=np.float64).reshape(self.template.hsv.shape).copy()
        hsv[..., 0] *= HUE_UNIT_DEG
        ty = self.template.tone_x.copy()
        ty[self.inner] += theta[self.n_hsv:]
        return Look(hsv, self.template.sat_nodes, self.template.tone_x, ty, self.template.name,
                    tone_stage=self.template.tone_stage)

    def pack(self, look: Look) -> np.ndarray:
        hsv = look.hsv.copy()
        hsv[..., 0] /= HUE_UNIT_DEG
        return np.concatenate([hsv.ravel(), (look.tone_y - look.tone_x)[self.inner]])

    def predict(self, theta, rgb=None) -> np.ndarray:
        return C.linear_srgb_to_lab(render_look(self.unpack(theta), self.rgb if rgb is None else rgb, self.curve))

    def de(self, theta) -> np.ndarray:
        return C.delta_e00(self.predict(theta), self.lab)

    def objective(self, theta, de=None) -> float:
        de = self.de(theta) if de is None else de
        return float(np.sum(self.weights * de))


def make_reg(model: LookModel, strength: float):
    """色相方向の 2 階差分（なめらかさ）・彩度の節点間の差・大きさ（控えめ）・トーンの 2 階差分と単調性。"""
    shape = model.template.hsv.shape  # (N, 2, 3)
    smooth = strength * np.array([0.6, 3.0, 3.0])   # Δh/10°・ls・lv の 2 階差分
    ridge = strength * np.array([0.08, 0.4, 0.4])   # 大きさ（観測の少ない色相を 0 へ）
    across = strength * np.array([0.1, 0.5, 0.5])   # 彩度の節点どうしの差

    def reg(theta):
        p = np.asarray(theta[: model.n_hsv]).reshape(shape)
        d2 = np.roll(p, 1, axis=0) - 2.0 * p + np.roll(p, -1, axis=0)
        t = np.asarray(theta[model.n_hsv:])
        y = model.template.tone_x.copy()
        y[model.inner] += t
        steps = np.diff(y)
        mono = 50.0 * np.minimum(steps - 0.02 * np.diff(model.template.tone_x), 0.0)  # 傾きが 0.02 未満にならない
        td2 = np.diff(np.concatenate([[0.0], t, [0.0]]), 2)
        return np.concatenate([(d2 * smooth).ravel(), (p * ridge).ravel(),
                               ((p[:, 1] - p[:, 0]) * across).ravel(), strength * 4.0 * td2, mono])
    return reg


def pixel_eval(scene, look: Look, blur: float) -> dict:
    pair = scene.pair
    sigma = CMP.sigma_for(blur, max(pair.frame_size))
    enc = C.srgb_encode(render_look(look, pair.cand, C.load_tone_curve()))
    disp = C.srgb8_decode(C.quantize8(enc))
    m = CMP.measure_pair(pair, disp, sigma)
    return {"mean": m["deltaE00"]["mean"], "p99": m["deltaE00"]["p99"], "evDiff": m["evDiff"],
            "saturationRatio": m["saturationRatio"]}


def totals(rows: list, split: str, key: str) -> dict:
    rs = [r[key] for r in rows if r["split"] == split and r.get(key)]
    if not rs:
        return {}
    return {"mean": round(float(np.mean([r["mean"] for r in rs])), 3), "p99": round(float(max(r["p99"] for r in rs)), 3),
            "scenes": len(rs)}


def report_markdown(ctx: dict) -> str:
    out = [f"# NIHO 標準ルック {ctx['look']} の当てはめ", "", f"- 作成: {ctx['createdAt']}",
           f"- 目標: {ctx['target']}", f"- 場面: train {ctx['train']} / val {ctx['val']}（セル {ctx['grid']}・長辺 {ctx['size']}px・σ{ctx['blur']}）",
           f"- 最適化: {ctx['optimizer']['method']}・{ctx['optimizer']['iterations']} 回・{ctx['optimizer']['reason']}・"
           f"{ctx['optimizer']['seconds']} 秒・目的関数 {ctx['optimizer']['objectiveStart']} → {ctx['optimizer']['objectiveEnd']}",
           "", "| 場面 | split | セル | 前 mean | 前 p99 | 後 mean | 後 p99 | 後 EV 差 | 後 彩度比 |", "|---|---|---:|---:|---:|---:|---:|---:|---:|"]
    for r in ctx["rows"]:
        b, a = r.get("before") or r["cellBefore"], r.get("after") or r["cellAfter"]
        ev = a.get("evDiff")
        sat = a.get("saturationRatio")
        out.append(f"| {r['scene']} | {r['split']} | {r['cells']} | {b['mean']:.2f} | {b['p99']:.2f} | {a['mean']:.2f} | {a['p99']:.2f} | "
                   f"{'' if ev is None else f'{ev:+.3f}'} | {'' if sat is None else f'{sat:.3f}'} |")
    out += ["", "| 集計 | 前 mean | 前 p99 | 後 mean | 後 p99 |", "|---|---:|---:|---:|---:|"]
    for split in ("train", "val"):
        b, a = ctx["totals"][split]["before"], ctx["totals"][split]["after"]
        if a:
            out.append(f"| {split} | {b['mean']:.2f} | {b['p99']:.2f} | {a['mean']:.2f} | {a['p99']:.2f} |")
    out += ["", "（前 = ルック無し（niho-interim-1 = 恒等）、後 = 当てはめたルック。"
            + ("画素" if ctx["pixel"] else "セル") + "の ΔE00。mean は場面の平均、p99 は場面の最大）", ""]
    return "\n".join(out)


def main(argv=None) -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--manifest", required=True)
    ap.add_argument("--out", required=True)
    ap.add_argument("--report")
    ap.add_argument("--name", default="niho-standard-1")
    ap.add_argument("--hue-nodes", type=int, default=12)
    ap.add_argument("--sat-node", type=float, default=0.3)
    ap.add_argument("--tone-stage", default=STAGE_POINT_CURVE, choices=sorted(SPACE_FOR_STAGE))
    ap.add_argument("--size", type=int, default=1500)
    ap.add_argument("--blur", type=float, default=2.0)
    ap.add_argument("--grid", default="48x32")
    ap.add_argument("--max-cell-std", type=float, default=8.0)
    ap.add_argument("--clip-max", type=float, default=0.01)
    ap.add_argument("--max-iter", type=int, default=60)
    ap.add_argument("--reg", type=float, default=0.3, help="正則化の強さ（倍率）")
    ap.add_argument("--cache-dir", help="露出前の線形 TIFF の置き場（既定: manifest の隣の prelook/）")
    ap.add_argument("--no-pixel-eval", action="store_true")
    args = ap.parse_args(argv)

    manifest = json.load(open(args.manifest))
    items = manifest["items"]
    cache = args.cache_dir or os.path.join(os.path.dirname(os.path.abspath(args.manifest)), "prelook")
    grid = FB.parse_grid(args.grid)
    scenes = []
    for it in items:
        cand, ev = prelook_tiff(it["workingCopy"], cache)
        log(f"scene {it['scene']} ({it.get('split', 'train')}) baselineEV {ev:+.3f}")
        sc = FB.prepare_scene({"scene": it["scene"], "reference": it["reference"], "candidate": cand,
                               "candidateSpace": "linear-prophoto", "split": it.get("split", "train")},
                              args.size, args.blur, grid, args.max_cell_std, args.clip_max,
                              keep_pair=not args.no_pixel_eval, r_root="", c_root="")
        if len(sc.rgb) < 20:
            log(f"  skip: usable cells {len(sc.rgb)}")
            continue
        scenes.append(sc)
    train = [s for s in scenes if s.split == "train"]
    if not train:
        raise SystemExit("訓練場面が無い")
    template = Look.identity(args.hue_nodes, (args.sat_node, 1.0), tone_stage=args.tone_stage)
    template.name = args.name
    identity = Look.identity(args.hue_nodes, (args.sat_node, 1.0), tone_stage=args.tone_stage)
    model = LookModel(train, template)
    theta0 = np.zeros(model.size())
    theta, info = FB.fit_lm(model, theta0, max_iter=args.max_iter, reg=make_reg(model, args.reg))
    look = model.unpack(theta)

    rows = []
    for s in scenes:
        m1 = LookModel([s], template)
        d0, d1 = m1.de(model.pack(identity)), m1.de(theta)
        row = {"scene": s.name, "split": s.split, "cells": int(len(s.rgb)),
               "cellBefore": {"mean": float(d0.mean()), "p99": float(np.percentile(d0, 99))},
               "cellAfter": {"mean": float(d1.mean()), "p99": float(np.percentile(d1, 99))}}
        if s.pair is not None:
            row["before"] = pixel_eval(s, identity, args.blur)
            row["after"] = pixel_eval(s, look, args.blur)
        rows.append(row)
    key_b, key_a = ("before", "after") if not args.no_pixel_eval else ("cellBefore", "cellAfter")
    tot = {sp: {"before": totals(rows, sp, key_b), "after": totals(rows, sp, key_a)} for sp in ("train", "val")}
    look.fit = {"createdAt": now_iso(), "target": manifest.get("target", "Lightroom neutral + Adobe Color exports"),
                "trainScenes": [s.name for s in train], "valScenes": [s.name for s in scenes if s.split == "val"],
                "metric": "pixel ΔE00 (blurred, flat)" if not args.no_pixel_eval else "cell ΔE00",
                "totals": tot, "optimizer": info, "grid": args.grid, "size": args.size, "blur": args.blur,
                "regularization": args.reg, "satNode": args.sat_node, "toneStage": args.tone_stage,
                "policy": "NIHO の式の係数だけを Lightroom の書き出し画像に合わせた。Adobe の LookTable・プロファイルの数値は読まない・写さない"}
    with open(args.out, "w", encoding="utf-8") as fh:
        json.dump(look.to_json(), fh, ensure_ascii=False, indent=1)
        fh.write("\n")
    ctx = {"look": args.name, "createdAt": look.fit["createdAt"], "target": look.fit["target"], "train": len(train),
           "val": len(scenes) - len(train), "grid": args.grid, "size": args.size, "blur": args.blur,
           "optimizer": info, "rows": rows, "totals": tot, "pixel": not args.no_pixel_eval}
    md = report_markdown(ctx)
    print(md)
    if args.report:
        with open(args.report, "w", encoding="utf-8") as fh:
            fh.write(md)
    return 0


if __name__ == "__main__":
    t0 = time.time()
    rc = main()
    log(f"done in {time.time() - t0:.1f}s")
    raise SystemExit(rc)
