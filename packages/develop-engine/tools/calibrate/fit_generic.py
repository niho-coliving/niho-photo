#!/usr/bin/env python3
"""fit_generic.py - the default for cameras without a calibration (cal-none) of the NIHO develop engine (#18398).

Fits ONE white-preserving 3x3 matrix in linear ProPhoto (D50) and baselineEV on the scenes of several calibrated
cameras at once (the fit_base.py manifests), every camera with the same total weight, so the result is the part of
"Apple's neutral render vs Lightroom's Adobe Standard neutral" that does not depend on the camera.

Leave-one-out: for every camera, the generic correction is fitted on the OTHER cameras only and measured on the
held-out camera, next to no correction (today's cal-none) and the camera's own calibration (fitted on its own train
split).  Gate: on every held-out camera the generic correction is better than no correction (it may be worse than the
camera's own calibration).  Only when the gate passes, the correction fitted on all cameras is written as the
calibration JSON for the registry's fallback (camera.id "generic", lens.mode "apple").

  python3 fit_generic.py --manifest m-dc-s5.json --manifest m-zv-e10m2.json --manifest m-fx30.json \
      --out packages/develop-engine/calibration/generic/apple-v1.json --report <work>/generic/report.md \
      [--json <work>/generic/loo.json] [--version v1]

See README.md next to this file.
"""
from __future__ import annotations

import argparse
import json
import os
import sys
from dataclasses import dataclass, field

import numpy as np

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)

import fit_base as FB  # noqa: E402  (puts ../colorcheck on sys.path)
from colorcheck import calibration as CAL  # noqa: E402
from colorcheck import color as C  # noqa: E402
from colorcheck import compare as CMP  # noqa: E402
from colorcheck import ref_root, work_dir  # noqa: E402
from colorcheck.util import now_iso, read_json, slug, write_json  # noqa: E402

TOOL = "calibrate/fit_generic.py"
GENERIC_CAMERA_ID = "generic"
# none = today's cal-none (identity, EV 0); generic = pooled fit on the other cameras; average = the mean of the other
# cameras' own fits (the same data, no pooling); own = the camera's own calibration (its train split)
METHODS = ("none", "generic", "average", "own")
METHOD_LABELS = {"none": "補正なし（今の cal-none）", "generic": "汎用（ほかの機種で当てはめ）",
                 "average": "ほかの機種の行列の平均", "own": "その機種の校正（train で当てはめ）"}
LENS_NOTE = ("登録の無い機種はレンズの測定が無いので、校正なしと同じ Core Image の補正（Core Image が直せないレンズは補正なし ="
             " lens-none）")


def log(msg: str) -> None:
    print(msg, file=sys.stderr, flush=True)


@dataclass
class Camera:
    id: str
    make: str
    model: str
    manifest_path: str
    manifest: dict
    r_root: str
    c_root: str
    scenes: list = field(default_factory=list)  # fit_base.Scene, cells only (no pixels kept)


def load_camera(path: str) -> Camera:
    manifest = read_json(path)
    items = manifest.get("items") or []
    if not items:
        raise ValueError(f"{path}: manifest.items is empty")
    FB.validate_manifest_splits(items)
    cam = manifest.get("camera") or {}
    make, model = str(cam.get("make") or "").strip(), str(cam.get("model") or "").strip()
    if not make or not model:
        raise ValueError(f"{path}: camera.make and camera.model are required")
    if manifest.get("track", "apple") != "apple":
        raise ValueError(f"{path}: only the apple track is supported (got {manifest.get('track')!r})")
    return Camera(id=cam.get("id") or slug(f"{make}-{model}"), make=make, model=model, manifest_path=os.path.abspath(path),
                  manifest=manifest, r_root=manifest.get("referenceRoot") or ref_root(),
                  c_root=manifest.get("candidateRoot") or work_dir())


def camera_balanced_weights(cameras: list) -> tuple[list, list]:
    """All scenes of the cameras, each camera with the same total weight (Model normalizes the sum to 1)."""
    scenes, weights = [], []
    for cam in cameras:
        n = len(cam.scenes)
        scenes += cam.scenes
        weights += [1.0 / n] * n
    return scenes, weights


def fit_matrix(scenes: list, weights, curve, max_iter: int) -> tuple[dict, dict]:
    model = FB.Model(scenes, "matrix", curve=curve, scene_weights=weights)
    theta, info = FB.fit_lm(model, np.zeros(7), max_iter)
    return model.unpack(theta), info


def as_calibration(params: dict | None) -> CAL.Calibration:
    if params is None:
        return CAL.identity()
    return CAL.Calibration(matrix=np.asarray(params["M"], dtype=np.float64), baseline_ev=float(params["ev"]))


def totals(rows: list, method: str, split: str | None = None) -> dict:
    selected = [r for r in rows if split is None or r["split"] == split]
    summary = FB.summarize([r["results"][method] for r in selected])
    return {"n": len(selected), **summary}


def gate(per_camera: list, margin: float) -> dict:
    checks = []
    for pc in per_camera:
        none, generic, own = (pc["totals"][m]["all"]["mean"] for m in ("none", "generic", "own"))
        checks.append({"camera": pc["id"], "none": none, "generic": generic, "own": own,
                       "betterThanNone": generic is not None and none is not None and generic < none - margin,
                       "worseThanOwn": generic is not None and own is not None and generic >= own})
    return {"rule": f"外した機種の全場面の ΔE00 mean で、汎用 < 補正なし - {margin:g}（校正済みより悪くてよい）",
            "passed": all(c["betterThanNone"] for c in checks), "checks": checks}


def _fmt(v, nd=2):
    return "—" if v is None else f"{v:.{nd}f}"


def report_markdown(ctx: dict) -> str:
    L = [f"# 未校正機種の既定（汎用の補正）の当てはめと leave-one-out（{ctx['version']}）", "",
         f"- 作成: {ctx['createdAt']}（{TOOL}）",
         "- 機種: " + "、".join(f"{c['make']} {c['model']}（{c['scenes']} 場面: train {c['train']} / val {c['val']}）"
                               for c in ctx["cameras"]),
         f"- 解析: 長辺 {ctx['size']}px、ぼかし σ {ctx['blur']}px@1500、セル {ctx['grid'][0]}×{ctx['grid'][1]}（fit_base.py と同じ）",
         f"- 表示レンダリング: {FB.LOOK}",
         "- 目的関数: セル ΔE00 平均。**機種ごとの重みを等しく**し（機種の中では場面ごとに等しく）、汎用の補正は機種の全場面"
         "（train と val）で当てはめる。その機種の校正は fit_base.py と同じく train の場面だけで当てはめる",
         "- 値: 画素の ΔE00（compare と同じ blur 後の値）。mean = 場面 mean の平均、p99 = 場面 p99 の最大", ""]
    L += ["## 全機種で当てはめた汎用の補正（校正 JSON に書く値）", "", "- 行列（白保存、linear ProPhoto D50）:", ""]
    L += FB._mat_md(ctx["final"]["M"]) + ["", f"- baselineEV: **{ctx['final']['ev']:+.4f}** 段", ""]
    L += ["## Leave-one-out（外した機種で測る）", "",
          "| 外した機種 | 集合 | 場面数 | " + " | ".join(f"{METHOD_LABELS[m]} mean / p99" for m in METHODS) + " |",
          "|---|---|---:|" + "---:|" * len(METHODS)]
    for pc in ctx["perCamera"]:
        for name in ("all", "val"):
            t = pc["totals"]
            L.append(f"| {pc['make']} {pc['model']} | {'全場面' if name == 'all' else 'val'} | {t['none'][name]['n']} | "
                     + " | ".join(f"{_fmt(t[m][name]['mean'])} / {_fmt(t[m][name]['p99'])}" for m in METHODS) + " |")
    L += ["", f"- gate: {ctx['gate']['rule']} → **{'合格' if ctx['gate']['passed'] else '不合格'}**"]
    for c in ctx["gate"]["checks"]:
        L.append(f"  - {c['camera']}: 補正なし {_fmt(c['none'])} → 汎用 {_fmt(c['generic'])}（その機種の校正 {_fmt(c['own'])}）"
                 f"{'' if c['betterThanNone'] else '・補正なしより良くない'}")
    L += ["", "## 外した機種で当てはめた汎用の補正", ""]
    for pc in ctx["perCamera"]:
        g = pc["fits"]["generic"]
        L += [f"- {pc['make']} {pc['model']} を外して当てはめ（baselineEV {g['ev']:+.4f}）:", ""] + \
             ["  " + x for x in FB._mat_md(g["M"])] + [""]
    L += ["## 場面別（画素 ΔE00 mean）", "",
          "| 機種 | 場面 | split | K | " + " | ".join(METHOD_LABELS[m] for m in METHODS) + " | 全機種の汎用 |",
          "|---|---|---|---:|" + "---:|" * (len(METHODS) + 1)]
    for pc in ctx["perCamera"]:
        for r in pc["rows"]:
            L.append(f"| {pc['model']} | {r['scene']} | {r['split']} | {_fmt(r['k'], 0)} | "
                     + " | ".join(_fmt(r["results"][m]["mean"]) for m in METHODS)
                     + f" | {_fmt(r['results']['final']['mean'])} |")
    if ctx.get("notes"):
        L += ["", "## 注意", ""] + [f"- {n}" for n in ctx["notes"]]
    return "\n".join(L) + "\n"


def params_json(params: dict) -> dict:
    return {"matrix": np.round(params["M"], 6).tolist(), "baselineEV": round(float(params["ev"]), 5)}


def build_calibration(ctx: dict, decoder_version: str, version: str) -> dict:
    final = ctx["final"]
    fit = {
        "tool": TOOL,
        "method": "pooled fit_base.py matrix+EV over the calibrated cameras' scenes (train and val), every camera "
                  "weighted equally; leave-one-out per camera",
        "cameras": [{k: c[k] for k in ("id", "make", "model", "scenes")} for c in ctx["cameras"]],
        "metric": f"deltaE00-mean-blur{ctx['blur']:g}-{ctx['size']}px",
        "train": ctx["inSample"]["final"],
        "before": ctx["inSample"]["none"],
        "leaveOneOut": [
            {"heldOut": pc["id"], **{m: {"all": pc["totals"][m]["all"], "val": pc["totals"][m]["val"]} for m in METHODS},
             "fittedWithout": params_json(pc["fits"]["generic"])}
            for pc in ctx["perCamera"]],
        "gate": ctx["gate"],
        "referenceSet": "lr-measure round6 neutral (Adobe Standard, As Shot), the cameras' fit_base.py manifests",
        "look": FB.LOOK,
        "optimizer": [dict(stage="行列＋EV（全機種）", **ctx["finalInfo"])],
        "whiteBalanceMapNote": "持たない（機種ごとの as-shot の白の差は機種で向きが違い、汎用の値を決めない）",
    }
    return {
        "schema": CAL.SCHEMA,
        "track": "apple",
        "camera": {"make": None, "model": None, "id": GENERIC_CAMERA_ID},
        "decoder": {"kind": FB.APPLE_DECODER["kind"], "decoderVersion": decoder_version,
                    "settings": dict(FB.APPLE_DECODER["settings"])},
        "inputSpace": FB.APPLE_INPUT_SPACE,
        "workingSpace": "linear-prophoto-d50",
        "matrix": {"space": "linear-prophoto-d50", "rowMajor": np.round(final["M"], 6).tolist(), "whitePreserving": True},
        "baselineEV": round(float(final["ev"]), 5),
        "illuminants": None,
        "hueSat": None,
        "version": version,
        "createdAt": ctx["createdAt"],
        "fit": fit,
        "baseVersion": f"apple-ciraw{decoder_version}/linear-prophoto-d50/cal-{GENERIC_CAMERA_ID}-apple-{version}",
        "lens": {"mode": "apple", "note": LENS_NOTE},
    }


def main(argv=None) -> int:
    ap = argparse.ArgumentParser(description="未校正機種の既定: 機種に依らない汎用の補正を当てはめ、leave-one-out で確かめる")
    ap.add_argument("--manifest", action="append", required=True, help="fit_base.py の manifest（機種ごと。2 つ以上）")
    ap.add_argument("--out", help="校正 JSON（gate に合格したときだけ書く）")
    ap.add_argument("--report", help="レポート Markdown（標準出力にも出す）")
    ap.add_argument("--json", help="場面ごとの結果の JSON")
    ap.add_argument("--version", default="v1", help="汎用の補正の version（baseVersion の cal-generic-apple-<version>）")
    ap.add_argument("--gate-margin", type=float, default=0.0, help="補正なしより良いとみなす差（既定 0）")
    ap.add_argument("--size", type=int, default=CMP.DEFAULT_SIZE)
    ap.add_argument("--blur", type=float, default=CMP.DEFAULT_BLUR)
    ap.add_argument("--grid", type=FB.parse_grid, default=FB.DEFAULT_GRID)
    ap.add_argument("--max-iter", type=int, default=100)
    ap.add_argument("--max-cell-std", type=float, default=8.0)
    ap.add_argument("--clip-max", type=float, default=0.01)
    args = ap.parse_args(argv)

    try:
        cameras = [load_camera(p) for p in args.manifest]
    except (OSError, ValueError) as exc:
        log(f"error: {exc}")
        return 2
    if len(cameras) < 2:
        log("error: leave-one-out には 2 機種以上の manifest が要る")
        return 2
    if len({c.id for c in cameras}) != len(cameras):
        log("error: 同じ機種の manifest が 2 つある")
        return 2
    decoders = {str(c.manifest.get("decoderVersion", "")) for c in cameras}
    if len(decoders) != 1 or "" in decoders:
        log(f"error: decoderVersion がそろっていない（{sorted(decoders)}）。汎用の補正は 1 つの decoderVersion ごと")
        return 2
    decoder_version = decoders.pop()
    if args.version and not args.version.startswith("v"):
        log("error: --version は v<数字>")
        return 2

    notes: list = []
    curve = C.load_tone_curve()
    # pass 1: cell means only (no pixels kept; 40+ scenes at 1500 px do not fit in memory at once)
    for cam in cameras:
        for it in cam.manifest["items"]:
            log(f"[prepare] {cam.id} {it.get('scene')} ({it.get('split', 'train')})")
            sc = FB.prepare_scene(it, args.size, args.blur, args.grid, args.max_cell_std, args.clip_max,
                                  keep_pair=False, r_root=cam.r_root, c_root=cam.c_root)
            notes += [f"{cam.id} {sc.name}: {w}" for w in sc.info["warnings"]]
            if len(sc.rgb) < 20:
                notes.append(f"{cam.id} {sc.name}: 使えるセルが {len(sc.rgb)} しかない（除外した）")
                continue
            cam.scenes.append(sc)
        if not any(s.split == "train" for s in cam.scenes):
            log(f"error: {cam.id} に訓練場面（split=train）が無い")
            return 2

    own = {}
    for cam in cameras:
        train = [s for s in cam.scenes if s.split == "train"]
        own[cam.id], _ = fit_matrix(train, None, curve, args.max_iter)
        log(f"[fit] own {cam.id}: ev {own[cam.id]['ev']:+.4f}")
    generic, average = {}, {}
    for held in cameras:
        others = [c for c in cameras if c.id != held.id]
        scenes, weights = camera_balanced_weights(others)
        generic[held.id], info = fit_matrix(scenes, weights, curve, args.max_iter)
        log(f"[fit] generic without {held.id}: {info['objectiveStart']} -> {info['objectiveEnd']} ({info['reason']})")
        average[held.id] = {"M": np.mean([own[c.id]["M"] for c in others], axis=0),
                            "ev": float(np.mean([own[c.id]["ev"] for c in others]))}
    scenes, weights = camera_balanced_weights(cameras)
    final, final_info = fit_matrix(scenes, weights, curve, args.max_iter)
    log(f"[fit] generic (all cameras): {final_info['objectiveStart']} -> {final_info['objectiveEnd']} ({final_info['reason']})")

    # pass 2: pixel-level ΔE00, one scene's pixels at a time
    per_camera = []
    for cam in cameras:
        cals = {"none": as_calibration(None), "generic": as_calibration(generic[cam.id]),
                "average": as_calibration(average[cam.id]), "own": as_calibration(own[cam.id]),
                "final": as_calibration(final)}
        used = {s.name for s in cam.scenes}
        rows = []
        for it in cam.manifest["items"]:
            name = it.get("scene") or os.path.splitext(os.path.basename(it["candidate"]))[0]
            if name not in used:
                continue
            log(f"[measure] {cam.id} {name}")
            sc = FB.prepare_scene(it, args.size, args.blur, args.grid, args.max_cell_std, args.clip_max,
                                  keep_pair=True, r_root=cam.r_root, c_root=cam.c_root)
            rows.append({"scene": sc.name, "split": sc.split, "k": sc.neutral_k,
                         "results": {m: FB.pixel_stats(sc, cal, args.blur) for m, cal in cals.items()}})
            sc.pair = None
        per_camera.append({
            "id": cam.id, "make": cam.make, "model": cam.model, "rows": rows,
            "totals": {m: {"all": totals(rows, m), "val": totals(rows, m, "val")} for m in (*METHODS, "final")},
            "fits": {"generic": generic[cam.id], "average": average[cam.id], "own": own[cam.id]},
        })

    all_rows = [r for pc in per_camera for r in pc["rows"]]
    ctx = {
        "version": args.version, "createdAt": now_iso(), "size": args.size, "blur": args.blur, "grid": args.grid,
        "cameras": [{"id": c.id, "make": c.make, "model": c.model, "scenes": len(c.scenes),
                     "train": sum(s.split == "train" for s in c.scenes), "val": sum(s.split == "val" for s in c.scenes),
                     "manifest": c.manifest_path} for c in cameras],
        "final": final, "finalInfo": final_info, "perCamera": per_camera, "notes": notes,
        "gate": gate(per_camera, args.gate_margin),
        # in-sample, every camera weighted equally: the mean of the cameras' means
        "inSample": {m: {"mean": round(float(np.mean([pc["totals"][m]["all"]["mean"] for pc in per_camera])), 4),
                         "p99": round(float(np.max([pc["totals"][m]["all"]["p99"] for pc in per_camera])), 4),
                         "scenes": len(all_rows)}
                     for m in ("none", "final")},
    }
    md = report_markdown(ctx)
    if args.report:
        os.makedirs(os.path.dirname(os.path.abspath(args.report)), exist_ok=True)
        with open(args.report, "w", encoding="utf-8") as fh:
            fh.write(md)
    if args.json:
        write_json(args.json, {
            "tool": TOOL, "createdAt": ctx["createdAt"], "version": args.version, "cameras": ctx["cameras"],
            "final": params_json(final), "gate": ctx["gate"], "inSample": ctx["inSample"],
            "perCamera": [{"id": pc["id"], "totals": pc["totals"], "rows": pc["rows"],
                           "fits": {k: params_json(v) for k, v in pc["fits"].items()}} for pc in per_camera],
            "notes": notes})
    print(md)
    if not ctx["gate"]["passed"]:
        log("gate: 不合格（汎用の補正が補正なしより良くない機種がある）。校正 JSON は書かない")
        return 3
    if args.out:
        # the same layout as the per-camera calibration JSONs (run-dc-s5-apple.sh fit)
        os.makedirs(os.path.dirname(os.path.abspath(args.out)), exist_ok=True)
        with open(args.out, "w", encoding="utf-8") as fh:
            json.dump(build_calibration(ctx, decoder_version, args.version), fh, indent=1, ensure_ascii=False)
            fh.write("\n")
        print(f"→ {os.path.abspath(args.out)}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
