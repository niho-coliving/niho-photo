#!/usr/bin/env python3
"""fit_base.py - fit the base (段 1) color correction of the NIHO develop engine (Epic #16939 S9).

Moves only NIHO's own coefficients: a white-preserving 3x3 matrix in linear
ProPhoto (D50) and baselineEV, optionally a 2-illuminant pair of matrices
(mired interpolation by the as-shot temperature) and a small 12-division HueSat
table.  The Lightroom exports are used only as the target images; no Adobe
profile / LUT values are copied.

  python3 fit_base.py --manifest m.json --out cal.json --report fit.md \
      [--illuminants 1|2] [--huesat 0|12] [--size 1500] [--blur 2] [--grid 48x32]

See README.md next to this file.
"""
from __future__ import annotations

import argparse
import os
import sys
import time
from dataclasses import dataclass, field

import numpy as np

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.normpath(os.path.join(HERE, "..", "colorcheck")))

from colorcheck import calibration as CAL  # noqa: E402
from colorcheck import color as C  # noqa: E402
from colorcheck import compare as CMP  # noqa: E402
from colorcheck import imageops  # noqa: E402
from colorcheck import ref_root, work_dir  # noqa: E402
from colorcheck.util import now_iso, read_json, slug, write_json  # noqa: E402

TOOL = "calibrate/fit_base.py"
DEFAULT_GRID = (48, 32)
DEFAULT_NODES = (2856.0, 6504.0)  # CIE A and D65, as in DNG dual-illuminant profiles
APPLE_DECODER = {
    "kind": "apple-cirawfilter",
    "settings": {"boostAmount": 0, "boostShadowAmount": 1, "exposure": 0, "shadowBias": 0,
                 "extendedDynamicRangeAmount": 0, "gamutMapping": True, "lensCorrection": True,
                 "localToneMapAmount": 0, "contrastAmount": 0},
}
APPLE_INPUT_SPACE = "extended-linear-srgb-d65-as-shot"
REFERENCE_SET = "lr-measure round2 neutral (Adobe Standard, PV 15.4, As Shot)"
LOOK = "acr3-default-tone-curve + RGBTone (temporary until S8)"
HUESAT_MIN_GAIN = 0.2  # adopt the HueSat table only if validation mean ΔE00 improves by >= 0.2


def log(msg: str) -> None:
    print(msg, file=sys.stderr, flush=True)


# ------------------------------------------------------------------ data

@dataclass
class Scene:
    name: str
    split: str
    neutral_k: float | None
    rgb: np.ndarray  # (n, 3) cell means, linear ProPhoto (blurred)
    lab: np.ndarray  # (n, 3) cell means, reference Lab (blurred)
    cells_total: int
    cells_dropped: dict
    alignment: dict
    pair: CMP.Pair | None = None
    info: dict = field(default_factory=dict)


def _grid_for(h: int, w: int, grid) -> tuple[int, int]:
    """(columns, rows): the long axis gets the larger count."""
    g_long, g_short = max(grid), min(grid)
    return (g_long, g_short) if w >= h else (g_short, g_long)


def cell_means(img: np.ndarray, weight: np.ndarray, cols: int, rows: int):
    """Weighted cell means; returns (means (rows, cols, C), coverage (rows, cols))."""
    h, w = weight.shape
    ys = np.linspace(0, h, rows + 1).astype(np.int64)
    xs = np.linspace(0, w, cols + 1).astype(np.int64)
    wt = weight.astype(np.float64)
    x = img.astype(np.float64) if img.ndim == 3 else img.astype(np.float64)[..., None]
    s = np.add.reduceat(np.add.reduceat(x * wt[..., None], ys[:-1], axis=0), xs[:-1], axis=1)
    n = np.add.reduceat(np.add.reduceat(wt, ys[:-1], axis=0), xs[:-1], axis=1)
    area = np.outer(np.diff(ys), np.diff(xs))
    means = s / np.maximum(n, 1e-12)[..., None]
    return means, n / area


def prepare_scene(item: dict, size: int, blur: float, grid, max_cell_std: float, clip_max: float,
                  keep_pair: bool, r_root: str, c_root: str) -> Scene:
    ref = CMP.resolve(item["reference"], r_root)
    cand = CMP.resolve(item["candidate"], c_root)
    space = item.get("candidateSpace", C.SPACE_LINEAR_PROPHOTO)
    pair = CMP.load_pair(ref, cand, space, render=True, size=size)
    sigma = CMP.sigma_for(blur, max(pair.frame_size))
    y0, y1, x0, x1 = pair.crop
    s = (slice(y0, y1), slice(x0, x1))
    ref_b = imageops.gaussian_blur(pair.ref_lin, sigma)[s]
    cand_b, valid_b = imageops.blur_masked(pair.cand, pair.valid, sigma)
    cand_b, valid_b = cand_b[s], valid_b[s]
    lab = C.linear_srgb_to_lab(ref_b)
    cols, rows = _grid_for(ref_b.shape[0], ref_b.shape[1], grid)
    m_rgb, cover = cell_means(cand_b, valid_b, cols, rows)
    m_lab, _ = cell_means(lab, valid_b, cols, rows)
    m_l2, _ = cell_means(lab[..., 0] ** 2, valid_b, cols, rows)
    l_std = np.sqrt(np.maximum(m_l2[..., 0] - m_lab[..., 0] ** 2, 0.0))
    if pair.cand_clip is not None:
        clip, _ = cell_means(pair.cand_clip[s], valid_b, cols, rows)
        clip = clip[..., 0]
    else:
        clip = np.zeros_like(l_std)
    ok_cover = cover >= 0.9
    ok_std = l_std <= max_cell_std
    ok_clip = clip <= clip_max
    ok_l = (m_lab[..., 0] >= 2.0) & (m_lab[..., 0] <= 97.0)
    keep = ok_cover & ok_std & ok_clip & ok_l
    dropped = {"coverage": int((~ok_cover).sum()), "heterogeneous": int((ok_cover & ~ok_std).sum()),
               "clipped": int((ok_cover & ok_std & ~ok_clip).sum()),
               "lightness": int((ok_cover & ok_std & ok_clip & ~ok_l).sum())}
    return Scene(
        name=item.get("scene") or os.path.splitext(os.path.basename(cand))[0],
        split=scene_split(item),
        neutral_k=float(item["neutralTemperatureK"]) if item.get("neutralTemperatureK") else None,
        rgb=m_rgb[keep].reshape(-1, 3), lab=m_lab[keep].reshape(-1, 3),
        cells_total=int(cols * rows), cells_dropped=dropped, alignment=pair.alignment.to_json(),
        pair=pair if keep_pair else None, info={"reference": ref, "candidate": cand, "space": space,
                                                "warnings": pair.warnings},
    )


# ----------------------------------------------------------------- model

class Model:
    """Maps a parameter vector to per-cell Lab predictions for a set of scenes."""

    def __init__(self, scenes: list, kind: str, nodes=None, fixed=None, curve=None, scene_weights=None):
        self.kind = kind  # "matrix" | "matrix2" | "huesat"
        self.scenes = scenes
        self.nodes = nodes
        self.fixed = fixed or {}
        self.curve = curve or C.load_tone_curve()
        self.rgb = np.concatenate([s.rgb for s in scenes]) if scenes else np.zeros((0, 3))
        self.lab = np.concatenate([s.lab for s in scenes]) if scenes else np.zeros((0, 3))
        counts = np.array([len(s.rgb) for s in scenes])
        # every scene weighs the same, whatever its number of cells (scene_weights: one weight per scene, normalized
        # to sum 1; fit_generic.py gives every camera the same total weight)
        if scene_weights is None:
            scene_weights = np.full(len(scenes), 1.0)
        scene_weights = np.asarray(scene_weights, dtype=np.float64)
        if len(scene_weights) != len(scenes) or np.any(scene_weights < 0) or (len(scenes) and scene_weights.sum() <= 0):
            raise ValueError("scene_weights needs one non-negative weight per scene and a positive sum")
        scene_weights = scene_weights / scene_weights.sum() if len(scenes) else scene_weights
        self.weights = np.concatenate([np.full(n, w / n) for n, w in zip(counts, scene_weights) if n > 0]) \
            if len(scenes) else np.zeros(0)
        self.scene_index = np.concatenate([np.full(len(s.rgb), i) for i, s in enumerate(scenes)]) \
            if scenes else np.zeros(0, int)
        if kind == "matrix2" or (kind == "huesat" and self.fixed.get("matrix2") is not None):
            k = [s.neutral_k for s in scenes]
            wl = [CAL.mired_weight(kk, nodes[0], nodes[1]) if kk else 0.5 for kk in k]
            self.w_low = np.concatenate([np.full(len(s.rgb), w) for s, w in zip(scenes, wl)])[:, None]

    def unpack(self, theta):
        if self.kind == "matrix":
            return {"M": CAL.white_preserving(theta[:6]), "ev": float(theta[6])}
        if self.kind == "matrix2":
            return {"M_low": CAL.white_preserving(theta[:6]), "M_high": CAL.white_preserving(theta[6:12]),
                    "ev": float(theta[12])}
        n = len(theta) // 2
        return {"huesat": np.column_stack([theta[:n], np.exp(theta[n:])])}

    def linear_in(self, p: dict, rgb=None, w_low=None) -> np.ndarray:
        rgb = self.rgb if rgb is None else rgb
        if "M" in p:
            return np.clip(rgb @ p["M"].T, 0.0, None)
        wl = self.w_low if w_low is None else w_low
        return np.clip(wl * (rgb @ p["M_low"].T) + (1.0 - wl) * (rgb @ p["M_high"].T), 0.0, None)

    def predict(self, theta) -> np.ndarray:
        if self.kind == "huesat":
            base = dict(self.fixed["params"])
            x = self.linear_in(base)
            x = C.apply_huesat(x, self.unpack(theta)["huesat"])
            ev = base["ev"]
        else:
            p = self.unpack(theta)
            x = self.linear_in(p)
            ev = p["ev"]
        return C.linear_srgb_to_lab(C.render_display_linear(x, ev, self.curve))

    def de(self, theta) -> np.ndarray:
        return C.delta_e00(self.predict(theta), self.lab)

    def objective(self, theta, de=None) -> float:
        de = self.de(theta) if de is None else de
        return float(np.sum(self.weights * de))


def huesat_reg(theta, smooth_deg=0.05, ridge_deg=0.01, smooth_log=2.0, ridge_log=0.5) -> np.ndarray:
    n = len(theta) // 2
    sh, q = theta[:n], theta[n:]
    return np.concatenate([smooth_deg * (sh - np.roll(sh, -1)), ridge_deg * sh,
                           smooth_log * (q - np.roll(q, -1)), ridge_log * q])


def fit_lm(model: Model, theta0, max_iter: int = 100, reg=None, h: float = 1e-5, eps: float = 0.1,
           rtol: float = 1e-6) -> tuple[np.ndarray, dict]:
    """IRLS + Levenberg-Marquardt, forward-difference Jacobian.

    Minimizes J = sum_i w_i ΔE00_i (+ sum reg^2).  Each iteration majorizes
    |ΔE| by ΔE^2 / (2 ΔE0) + ΔE0 / 2 and takes an LM step on that weighted
    least-squares surrogate; a step is accepted only when the true J drops.
    Stops when the relative drop of J is < rtol twice in a row, when the step
    is < 1e-8, when no damping gives a descent, or after max_iter iterations.
    """
    theta = np.asarray(theta0, dtype=np.float64).copy()
    w = model.weights

    def total(th, de=None):
        j = model.objective(th, de)
        if reg is not None:
            j += float(np.sum(reg(th) ** 2))
        return j

    lam = 1e-3
    j0_start = total(theta)
    history = [j0_start]
    reason = "max-iter"
    small = 0
    it = 0
    t0 = time.time()
    for it in range(1, max_iter + 1):
        de0 = model.de(theta)
        j0 = total(theta, de0)
        u = np.sqrt(w / (2.0 * np.maximum(de0, eps)))
        r0 = u * de0
        if reg is not None:
            r0 = np.concatenate([r0, reg(theta)])
        jac = np.empty((len(r0), len(theta)))
        for k in range(len(theta)):
            th = theta.copy()
            th[k] += h
            rk = u * model.de(th)
            if reg is not None:
                rk = np.concatenate([rk, reg(th)])
            jac[:, k] = (rk - r0) / h
        g = jac.T @ r0
        hm = jac.T @ jac
        accepted = False
        for _ in range(14):
            a = hm + lam * np.diag(np.diag(hm) + 1e-12)
            try:
                step = np.linalg.solve(a, -g)
            except np.linalg.LinAlgError:
                lam *= 10
                continue
            th_new = theta + step
            j_new = total(th_new)
            if j_new < j0:
                accepted = True
                break
            lam *= 4.0
        if not accepted:
            reason = "no-descent"
            break
        theta = th_new
        lam = max(lam / 3.0, 1e-9)
        history.append(j_new)
        if (j0 - j_new) < rtol * max(j0, 1e-12):
            small += 1
            if small >= 2:
                reason = "converged"
                break
        else:
            small = 0
        if np.linalg.norm(step) < 1e-8:
            reason = "step-small"
            break
    info = {"iterations": it, "reason": reason, "objectiveStart": round(j0_start, 5),
            "objectiveEnd": round(total(theta), 5), "seconds": round(time.time() - t0, 2),
            "criteria": f"relative drop < {rtol:g} twice / step < 1e-8 / max {max_iter} iterations",
            "method": "IRLS (L1 on ΔE00) + Levenberg-Marquardt, forward-difference Jacobian"}
    return theta, info


# ------------------------------------------------------------ evaluation

def cell_stats(model: Model, theta) -> list:
    de = model.de(theta)
    out = []
    for i, s in enumerate(model.scenes):
        d = de[model.scene_index == i]
        out.append({"mean": float(d.mean()) if d.size else None,
                    "p99": float(np.percentile(d, 99)) if d.size else None, "cells": int(d.size)})
    return out


def pixel_stats(scene: Scene, cal: CAL.Calibration | None, blur: float) -> dict:
    pair = scene.pair
    sigma = CMP.sigma_for(blur, max(pair.frame_size))
    disp, _ = CMP.render_candidate(pair, 0.0, cal, scene.neutral_k, None, quantize=True)
    m = CMP.measure_pair(pair, disp, sigma)
    return {"mean": m["deltaE00"]["mean"], "p99": m["deltaE00"]["p99"], "evDiff": m["evDiff"],
            "saturationRatio": m["saturationRatio"]}


def summarize(rows: list) -> dict:
    means = [r["mean"] for r in rows if r and r.get("mean") is not None]
    p99s = [r["p99"] for r in rows if r and r.get("p99") is not None]
    if not means:
        return {"mean": None, "p99": None}
    return {"mean": round(float(np.mean(means)), 4), "p99": round(float(np.max(p99s)), 4)}


def evaluation_totals(rows: list, split: str, cell_metrics: bool = False) -> dict:
    selected = [row for row in rows if row["split"] == split]
    if cell_metrics:
        before = summarize([{"mean": row["cellBefore"], "p99": row["cellBeforeP99"]} for row in selected])
        after = summarize([{"mean": row["cellAfter"], "p99": row["cellAfterP99"]} for row in selected])
    else:
        before = summarize([row.get("before") for row in selected])
        after = summarize([row.get("after") for row in selected])
    return {"n": len(selected), "before": before, "after": after}


def scene_split(item: dict, index: int | None = None) -> str:
    label = f"manifest.items[{index}]" if index is not None else "manifest item"
    if not isinstance(item, dict):
        raise ValueError(f"{label} must be an object")
    split = item.get("split", "train")
    if split not in ("train", "val"):
        raise ValueError(f"{label}.split must be 'train' or 'val', got {split!r}")
    return split


def validate_manifest_splits(items: list) -> None:
    for index, item in enumerate(items):
        scene_split(item, index)


def build_calibration(manifest: dict, params: dict, illum, huesat, fit: dict, version: str,
                      nodes) -> dict:
    track = manifest.get("track", "apple")
    cam = dict(manifest.get("camera") or {})
    cam_id = cam.get("id") or slug(f"{cam.get('make', '')}-{cam.get('model', '')}")
    cam["id"] = cam_id
    decoder = dict(APPLE_DECODER) if track == "apple" else {"kind": track, "settings": {}}
    decoder.update(manifest.get("decoder") or {})
    dv = str(manifest.get("decoderVersion", ""))
    decoder["decoderVersion"] = dv
    decoder = {"kind": decoder.pop("kind"), "decoderVersion": decoder.pop("decoderVersion"),
               "settings": decoder.pop("settings", {}), **decoder}
    input_space = manifest.get("inputSpace") or (APPLE_INPUT_SPACE if track == "apple" else "linear-prophoto-d50")
    prefix = {"apple-cirawfilter": "apple-ciraw"}.get(decoder["kind"], decoder["kind"])
    base_version = manifest.get("baseVersion") or f"{prefix}{dv}/linear-prophoto-d50/cal-{cam_id}-{track}-{version}"
    m = params["M"]
    ill_json = None
    if illum is not None:
        ill_json = [{"neutralTemperatureK": float(nodes[0]), "matrix": np.round(illum[0], 6).tolist()},
                    {"neutralTemperatureK": float(nodes[1]), "matrix": np.round(illum[1], 6).tolist()}]
    hs_json = None
    if huesat is not None:
        hs_json = {"space": "linear-prophoto-hsv", "hueDivisions": int(len(huesat)),
                   "entries": [[round(float(a), 4), round(float(b), 5)] for a, b in huesat]}
    return {
        "schema": CAL.SCHEMA,
        "track": track,
        "camera": {"make": cam.get("make"), "model": cam.get("model"), "id": cam_id},
        "decoder": decoder,
        "inputSpace": input_space,
        "workingSpace": "linear-prophoto-d50",
        "matrix": {"space": "linear-prophoto-d50", "rowMajor": np.round(m, 6).tolist(), "whitePreserving": True},
        "baselineEV": round(float(params["ev"]), 5),
        "illuminants": ill_json,
        "hueSat": hs_json,
        "version": version,
        "createdAt": now_iso(),
        "fit": fit,
        "baseVersion": base_version,
    }


def _fmt(v, nd=2):
    return "—" if v is None else f"{v:.{nd}f}"


def _mat_md(m) -> list:
    return ["| | R | G | B |", "|---|---:|---:|---:|"] + [
        f"| {'RGB'[i]} | " + " | ".join(f"{m[i][j]:+.5f}" for j in range(3)) + " |" for i in range(3)]


def report_markdown(ctx: dict) -> str:
    L = [f"# 土台の色補正 fit レポート（{ctx['track']} / {ctx['cameraLabel']}）", "",
         f"- 作成: {ctx['createdAt']}（{TOOL}）",
         f"- manifest: `{ctx['manifest']}`",
         f"- decoderVersion: {ctx['decoderVersion']} / baseVersion: `{ctx['baseVersion']}`",
         f"- 解析: 長辺 {ctx['size']}px、ぼかし σ {ctx['blur']}px@1500、セル {ctx['grid'][0]}×{ctx['grid'][1]}、"
         f"セル除外（L* 標準偏差 > {ctx['maxCellStd']}・白飛び画素 > {ctx['clipMax']*100:.0f}%・L* ∉ [2, 97]・有効画素 < 90%）",
         f"- 表示レンダリング: {LOOK}",
         f"- 目的関数: 訓練場面の セル ΔE00 平均（場面ごとに等しい重み）", ""]
    L += ["## 結果", "", f"- 行列（白保存、linear ProPhoto D50、`matrix.rowMajor`）:", ""] + _mat_md(ctx["M"]) + [""]
    L += [f"- baselineEV: **{ctx['ev']:+.4f}** 段"]
    if ctx.get("illuminantsNote"):
        L += [f"- 2 光源: {ctx['illuminantsNote']}"]
    if ctx.get("illum") is not None:
        for k, mm in zip(ctx["nodes"], ctx["illum"]):
            L += ["", f"  - {k:.0f}K の行列", ""] + ["    " + x for x in _mat_md(mm)]
    if ctx.get("huesatNote"):
        L += [f"- HueSat: {ctx['huesatNote']}"]
    L += ["", "## 最適化", ""]
    for name, inf in ctx["optimizers"]:
        L += [f"- {name}: 反復 {inf['iterations']}・終了 `{inf['reason']}`・目的関数 {inf['objectiveStart']} → "
              f"{inf['objectiveEnd']}（{inf['seconds']} 秒）・条件 {inf['criteria']}"]
    if ctx.get("noPixelEval"):
        L += ["", "- 画素評価は省略。train / val の集計値はセル単位の mean / p99 です。"]
    L += ["", "## 場面別 ΔE00（画素 = compare と同じ blur 後の値、セル = fit の目的関数の単位）", "",
          "| 場面 | split | K | セル（使用/全体） | 校正前 mean | 校正前 p99 | 校正後 mean | 校正後 p99 | 校正後 EV 差 | 校正後 彩度比 | セル mean（前） | セル p99（前） | セル mean（後） | セル p99（後） |",
          "|---|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|"]
    for r in ctx["rows"]:
        b, a = r.get("before") or {}, r.get("after") or {}
        L.append(f"| {r['scene']} | {r['split']} | {_fmt(r['k'], 0)} | {r['cells']}/{r['cellsTotal']} | "
                 f"{_fmt(b.get('mean'))} | {_fmt(b.get('p99'))} | {_fmt(a.get('mean'))} | {_fmt(a.get('p99'))} | "
                 f"{_fmt(a.get('evDiff'), 3)} | {_fmt(a.get('saturationRatio'), 3)} | "
                 f"{_fmt(r['cellBefore'])} | {_fmt(r['cellBeforeP99'])} | "
                 f"{_fmt(r['cellAfter'])} | {_fmt(r['cellAfterP99'])} |")
    L += ["", "## 全体（mean = 場面 mean の平均、p99 = 場面 p99 の最大）", "",
          "| 集合 | 場面数 | 校正前 mean | 校正前 p99 | 校正後 mean | 校正後 p99 |", "|---|---:|---:|---:|---:|---:|"]
    for name in ("train", "val"):
        t = ctx["totals"][name]
        L.append(f"| {name} | {t['n']} | {_fmt(t['before']['mean'])} | {_fmt(t['before']['p99'])} | "
                 f"{_fmt(t['after']['mean'])} | {_fmt(t['after']['p99'])} |")
    if ctx.get("notes"):
        L += ["", "## 注意", ""] + [f"- {n}" for n in ctx["notes"]]
    return "\n".join(L) + "\n"


# ------------------------------------------------------------------ main

def parse_grid(s: str):
    a, b = s.lower().split("x")
    return int(a), int(b)


def main(argv=None) -> int:
    ap = argparse.ArgumentParser(description="土台の色補正（白保存 3x3 + baselineEV）を ΔE00 最小化で求める")
    ap.add_argument("--manifest", required=True)
    ap.add_argument("--out", required=True, help="校正 JSON（niho-develop-calibration/v1）")
    ap.add_argument("--report", help="fit レポート Markdown")
    ap.add_argument("--size", type=int, default=CMP.DEFAULT_SIZE)
    ap.add_argument("--blur", type=float, default=CMP.DEFAULT_BLUR)
    ap.add_argument("--grid", type=parse_grid, default=DEFAULT_GRID, help="セル数（既定 48x32、長辺側が大きい方）")
    ap.add_argument("--illuminants", type=int, choices=(1, 2), default=1)
    ap.add_argument("--illuminant-nodes", default=f"{DEFAULT_NODES[0]:.0f},{DEFAULT_NODES[1]:.0f}",
                    help="2 光源の節点 K（既定 2856,6504）")
    ap.add_argument("--huesat", type=int, default=0, help="HueSat の色相区分数（0 = なし、例 12）")
    ap.add_argument("--max-iter", type=int, default=100)
    ap.add_argument("--max-cell-std", type=float, default=8.0, help="セル内 L* 標準偏差の上限（超えたら除外）")
    ap.add_argument("--clip-max", type=float, default=0.01, help="セル内の白飛び画素の割合の上限")
    ap.add_argument("--version", default="v1", help="校正の version（baseVersion の末尾）")
    ap.add_argument("--no-pixel-eval", action="store_true", help="画素レベルの評価を省く（メモリ節約）")
    args = ap.parse_args(argv)

    manifest = read_json(args.manifest)
    r_root = manifest.get("referenceRoot") or ref_root()
    c_root = manifest.get("candidateRoot") or work_dir()
    nodes = tuple(float(x) for x in args.illuminant_nodes.split(","))
    if len(nodes) != 2 or nodes[0] >= nodes[1]:
        log("error: --illuminant-nodes は 低K,高K")
        return 2
    items = manifest.get("items") or []
    if not items:
        log("error: manifest.items が空")
        return 2
    try:
        validate_manifest_splits(items)
    except ValueError as exc:
        log(f"error: {exc}")
        return 2
    notes = []
    scenes = []
    for it in items:
        log(f"[prepare] {it.get('scene')} ({it.get('split', 'train')})")
        sc = prepare_scene(it, args.size, args.blur, args.grid, args.max_cell_std, args.clip_max,
                           keep_pair=not args.no_pixel_eval, r_root=r_root, c_root=c_root)
        for w in sc.info["warnings"]:
            notes.append(f"{sc.name}: {w}")
        if len(sc.rgb) < 20:
            notes.append(f"{sc.name}: 使えるセルが {len(sc.rgb)} しかない（除外した）")
            continue
        scenes.append(sc)
    train = [s for s in scenes if s.split == "train"]
    val = [s for s in scenes if s.split == "val"]
    if not train:
        log("error: 訓練場面（split=train）が無い")
        return 2
    if not val:
        notes.append("検証場面（split=val）が無い。検証の数値は空、HueSat は採用しない")

    curve = C.load_tone_curve()
    optimizers = []
    # 1) single white-preserving matrix + EV
    m1 = Model(train, "matrix", curve=curve)
    theta1, info1 = fit_lm(m1, np.zeros(7), args.max_iter)
    optimizers.append(("行列＋EV", info1))
    params = m1.unpack(theta1)
    log(f"[fit] matrix+EV: {info1['objectiveStart']} -> {info1['objectiveEnd']} ({info1['iterations']} it, {info1['reason']})")

    illum = None
    illum_note = None
    if args.illuminants == 2:
        t_mid = 1.0 / (0.5 * (1.0 / nodes[0] + 1.0 / nodes[1]))
        ks = [s.neutral_k for s in train]
        warm = [k for k in ks if k and k < t_mid]
        cool = [k for k in ks if k and k >= t_mid]
        if any(k is None for k in ks) or len(warm) < 2 or len(cool) < 2:
            illum_note = (f"訓練場面が片側 2 未満（{t_mid:.0f}K 未満 {len(warm)}・以上 {len(cool)}"
                          f"{'・色温度なし ' + str(sum(k is None for k in ks)) if any(k is None for k in ks) else ''}）"
                          "なので 1 行列に戻した")
            notes.append(illum_note)
        else:
            m2 = Model(train, "matrix2", nodes=nodes, curve=curve)
            theta2, info2 = fit_lm(m2, np.concatenate([theta1[:6], theta1[:6], theta1[6:7]]), args.max_iter)
            optimizers.append(("2 光源 行列＋EV", info2))
            p2 = m2.unpack(theta2)
            illum = (p2["M_low"], p2["M_high"])
            wmid = CAL.mired_weight(t_mid, nodes[0], nodes[1])
            params = {"M": wmid * p2["M_low"] + (1 - wmid) * p2["M_high"], "ev": p2["ev"],
                      "M_low": p2["M_low"], "M_high": p2["M_high"]}
            illum_note = (f"{nodes[0]:.0f}K / {nodes[1]:.0f}K の 2 行列（ミレッド線形補間）。"
                          f"`matrix` は中点 {t_mid:.0f}K の補間値")

    def make_cal(hs=None) -> CAL.Calibration:
        ills = None if illum is None else [(nodes[0], illum[0]), (nodes[1], illum[1])]
        return CAL.Calibration(matrix=params["M"], baseline_ev=params["ev"], illuminants=ills, huesat=hs)

    def model_params():
        if illum is None:
            return {"M": params["M"], "ev": params["ev"]}
        return {"M_low": illum[0], "M_high": illum[1], "ev": params["ev"]}

    # 2) optional HueSat on top (matrix and EV fixed)
    huesat = None
    huesat_note = None
    if args.huesat and args.huesat > 0:
        n = int(args.huesat)
        fixed = {"params": model_params(), "matrix2": illum}
        mh = Model(train, "huesat", nodes=nodes, fixed=fixed, curve=curve)
        theta_h, info_h = fit_lm(mh, np.zeros(2 * n), args.max_iter, reg=huesat_reg)
        optimizers.append((f"HueSat {n}", info_h))
        table = mh.unpack(theta_h)["huesat"]
        if val and not args.no_pixel_eval:
            before = summarize([pixel_stats(s, make_cal(), args.blur) for s in val])["mean"]
            after = summarize([pixel_stats(s, make_cal(table), args.blur) for s in val])["mean"]
            unit = "画素"
        elif val:
            mv0 = Model(val, "huesat", nodes=nodes, fixed=fixed, curve=curve)
            before = mv0.objective(np.zeros(2 * n))
            after = mv0.objective(theta_h)
            unit = "セル"
        else:
            before = after = None
            unit = ""
        if before is not None and after is not None and before - after >= HUESAT_MIN_GAIN:
            huesat = table
            huesat_note = f"採用（検証 {unit} ΔE00 mean {before:.3f} → {after:.3f}）"
        else:
            gain = "検証場面なし" if before is None else f"検証 {unit} ΔE00 mean {before:.3f} → {after:.3f}"
            huesat_note = f"不採用（{gain}。改善 {HUESAT_MIN_GAIN} 未満）。表: " + ", ".join(
                f"{a:+.1f}°/×{b:.3f}" for a, b in table)
        notes.append(f"HueSat {n}: {huesat_note}")

    cal_final = make_cal(huesat)
    cal_before = CAL.identity()

    # 3) evaluation
    rows = []
    for s in scenes:
        model_kind = "matrix" if illum is None else "matrix2"
        mc = Model([s], model_kind, nodes=nodes, curve=curve)
        th = np.concatenate([CAL.offdiag_params(params["M"]), [params["ev"]]]) if illum is None else \
            np.concatenate([CAL.offdiag_params(illum[0]), CAL.offdiag_params(illum[1]), [params["ev"]]])
        cell_before = cell_stats(mc, np.zeros(7 if illum is None else 13))[0]
        if huesat is not None:
            mh1 = Model([s], "huesat", nodes=nodes, fixed={"params": model_params(), "matrix2": illum}, curve=curve)
            cell_after = cell_stats(mh1, np.concatenate([huesat[:, 0], np.log(huesat[:, 1])]))[0]
        else:
            cell_after = cell_stats(mc, th)[0]
        row = {"scene": s.name, "split": s.split, "k": s.neutral_k, "cells": len(s.rgb), "cellsTotal": s.cells_total,
               "cellBefore": cell_before["mean"], "cellBeforeP99": cell_before["p99"],
               "cellAfter": cell_after["mean"], "cellAfterP99": cell_after["p99"],
               "cellsDropped": s.cells_dropped, "alignment": s.alignment}
        if s.pair is not None:
            row["before"] = pixel_stats(s, cal_before, args.blur)
            row["after"] = pixel_stats(s, cal_final, args.blur)
        rows.append(row)

    tot = {split: evaluation_totals(rows, split, cell_metrics=args.no_pixel_eval)
           for split in ("train", "val")}
    metric = f"deltaE00-mean-blur{args.blur:g}-{args.size}px"
    fit = {
        "tool": TOOL,
        "trainScenes": [s.name for s in train],
        "valScenes": [s.name for s in val],
        "metric": metric if not args.no_pixel_eval else f"cell-deltaE00-mean-{args.grid[0]}x{args.grid[1]}",
        "train": tot["train"]["after"],
        "val": tot["val"]["after"] if val else {"mean": None, "p99": None},
        "referenceSet": manifest.get("referenceSet", REFERENCE_SET),
        "look": LOOK,
        "before": {"train": tot["train"]["before"], "val": tot["val"]["before"] if val else None},
        "optimizer": [dict(stage=name, **inf) for name, inf in optimizers],
        "cells": {"grid": list(args.grid), "maxCellStd": args.max_cell_std, "clipMax": args.clip_max,
                  "used": {s.name: len(s.rgb) for s in scenes}},
        "illuminantsNote": illum_note,
        "hueSatNote": huesat_note,
    }
    cal_json = build_calibration(manifest, params, illum, huesat, fit, args.version, nodes)
    # 再 fit で既存の whiteBalanceMap（fit_wb_map.py の結果）を失わない
    if os.path.exists(args.out):
        try:
            prev = read_json(args.out)
            if prev.get("whiteBalanceMap") and not cal_json.get("whiteBalanceMap"):
                cal_json["whiteBalanceMap"] = prev["whiteBalanceMap"]
                notes.append("whiteBalanceMap は既存の校正 JSON から引き継いだ（fit_wb_map.py で作り直せる）")
            # レンズ補正の方式（S10 #17031。色の行列とは独立）も失わない
            if prev.get("lens") and not cal_json.get("lens"):
                cal_json["lens"] = prev["lens"]
                notes.append("lens は既存の校正 JSON から引き継いだ")
        except (OSError, ValueError):
            pass
    write_json(args.out, cal_json)
    cam = manifest.get("camera") or {}
    ctx = {"track": cal_json["track"], "cameraLabel": f"{cam.get('make', '')} {cam.get('model', '')}".strip(),
           "createdAt": cal_json["createdAt"], "manifest": os.path.abspath(args.manifest),
           "decoderVersion": cal_json["decoder"]["decoderVersion"], "baseVersion": cal_json["baseVersion"],
           "size": args.size, "blur": args.blur, "grid": args.grid, "maxCellStd": args.max_cell_std,
           "clipMax": args.clip_max, "M": params["M"], "ev": params["ev"], "illum": illum, "nodes": nodes,
           "illuminantsNote": illum_note, "huesatNote": huesat_note, "optimizers": optimizers, "rows": rows,
           "totals": tot, "notes": notes, "noPixelEval": args.no_pixel_eval}
    md = report_markdown(ctx)
    if args.report:
        os.makedirs(os.path.dirname(os.path.abspath(args.report)), exist_ok=True)
        with open(args.report, "w", encoding="utf-8") as fh:
            fh.write(md)
    print(md)
    print(f"→ {os.path.abspath(args.out)}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
