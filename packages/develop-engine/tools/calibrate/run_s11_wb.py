#!/usr/bin/env python3
"""S11 #17108: 白を段 2 で Apple と同じ行列で当て直すための計測と校正（再現用）。式は `wbtable.py`、表の計測は `fit_wb_table.py`。

  python3 run_s11_wb.py <step> [--cameras panasonic-dc-s5 sony-zv-e10m2] [--jobs 3]
  steps: render fit table wc accuracy all

- `--cameras` は `wc` と `accuracy` でも選択機種だけに絞る。

- render: 校正と計測の場面を、色域の圧縮を切って Apple の線形出力（長辺 2560・tiff32f・レンズ補正あり / なし）に描く
  （`$NIHO_COLOR_WORK_DIR/s11/apple-linear/{v8,v8-nolens}/`。v2 までの中間物は上書きしない）
- fit: 機種別補正 apple-v3（色域の圧縮オフ）を `fit_base.py` で当てはめる（1 光源と 2 光源を当て、検証 mean が 0.1 以上良いときだけ
  2 光源。白の写像 `whiteBalanceMap` とレンズ `lens` は apple-v2 から引き継ぐ）
- table: 白の行列の表を `fit_wb_table.py` で計測して apple-v3 の `whiteBalanceTable` に入れる
- wc: round7 の 20 場面の作業コピー（v3・表つきのメタ）を作る
- accuracy: round6 の白の変種（20 場面 × 4000 / 5500 / 7500K・Tint 0・Adobe Standard・ルック無し）を、段 2 の crate の描画で
  比べる: 今の近似（v2 の作業コピー＋ Bradford の色順応）/ 表（v3 の作業コピー × `C · M(w1) · I(w0) · C^-1`）/ Apple で目標の白を
  指定して描き直したもの。撮影時の白（中立）も v2 と v3 で比べる。結果は `s11/results/`
"""
from __future__ import annotations

import argparse
import concurrent.futures as cf
import json
import os
import shutil
import subprocess
import sys
from pathlib import Path

import cv2
import numpy as np

HERE = Path(__file__).resolve().parent
ENGINE = HERE.parents[1]
sys.path.insert(0, str(HERE))
sys.path.insert(0, str(HERE.parent / "colorcheck"))
import refs  # noqa: E402
import wbtable as WT  # noqa: E402
from wbmodel import temperature_from_xy, xy_from_temperature  # noqa: E402

from colorcheck import color as C  # noqa: E402
from colorcheck import compare as CMP  # noqa: E402

REF = Path(os.environ.get("NIHO_COLOR_REF_ROOT", "OWNER_DATA_ROOT"))
WK = Path(os.environ.get("NIHO_COLOR_WORK_DIR", "OWNER_DATA_ROOT"))
S11 = WK / "s11"
S8 = WK / "s8"
BIN = Path(os.environ.get("APPLE_RAW_LINEAR_BIN", ENGINE / "tools" / "apple-raw-linear" / ".build" / "release" / "apple-raw-linear"))
BRIDGE = Path(os.environ.get("NIHO_DEVELOP_BRIDGE_BIN", S8 / "crate-target" / "release" / "examples" / "render_working_copy"))
KELVINS = (4000, 5500, 7500)
WORKING_COPY_GAMMA, WORKING_COPY_MAX = 1.8, 2.0

DC_S5_MAIN = ["P1012822", "P1013207", "P1013558", "P1522877", "P1524180", "P1524181"]
DC_S5_EXTRA = ["P1581215", "P1581237", "P1581243", "P1581255", "P1581256", "P1581332", "P1581335", "P1581346", "P1581356", "P1581368"]
DC_S5_ROUND6 = ["P1570133", "P1570135", "P1570258", "P1570266", "P1570280", "P1570302", "P1570396", "P1570586", "P1570755", "P1570923"]
CAMERAS = {
    "panasonic-dc-s5": {"make": "Panasonic", "model": "DC-S5", "lens": "apple",
                        "fit": DC_S5_MAIN + DC_S5_EXTRA + DC_S5_ROUND6, "extra": ["P1581387"],
                        "table_raw": "P1570133", "verify_raw": ["P1581387", "P1012822", "P1570923"], "nodes": "3400,5100"},
    "sony-zv-e10m2": {"make": "SONY", "model": "ZV-E10M2", "lens": "embedded",
                      "fit": ["DSC09188", "DSC09206", "DSC09207", "DSC09208"], "extra": ["DSC01835", "DSC01837"],
                      "table_raw": "DSC09207", "verify_raw": ["DSC09206", "DSC09188", "DSC01837"], "nodes": None},
}


def log(msg: str) -> None:
    print(f"[s11] {msg}", flush=True)


def raw_path(scene: str) -> Path:
    if scene in DC_S5_MAIN:
        return REF / "round2" / "round2-photos" / f"p2_{scene}_neutral.RW2"
    if scene in DC_S5_EXTRA:
        return REF / "round2" / "round2-extra-photos" / f"p2_{scene}_neutral.RW2"
    for ext in ("RW2", "ARW"):
        p = REF / "round6" / f"{scene}.{ext}"
        if p.exists():
            return p
    raise SystemExit(f"RAW not found for {scene}")


def calibration_path(camera: str, version: str) -> Path:
    return ENGINE / "calibration" / camera / f"apple-{version}.json"


def linear(scene: str, lens: bool) -> Path:
    return S11 / "apple-linear" / ("v8" if lens else "v8-nolens") / f"{scene}.tiff"


def run(cmd: list[str]) -> None:
    r = subprocess.run(cmd, capture_output=True, text=True)
    if r.returncode != 0:
        raise RuntimeError(f"{' '.join(cmd[:3])}: {r.stderr[-500:]}")


def render_linear(job) -> str:
    scene, lens, lens_mode = job
    out = linear(scene, lens)
    if out.exists() and out.with_suffix(".json").exists():
        return f"skip {out.name}"
    out.parent.mkdir(parents=True, exist_ok=True)
    run([str(BIN), "render", str(raw_path(scene)), "--out", str(out), "--meta", str(out.with_suffix(".json")),
         "--long-edge", "2560", "--space", "linear-prophoto", "--encoding", "tiff32f", "--decoder-version", "8",
         "--lens-correction", lens_mode if lens else "off", "--gamut-mapping", "off"])
    return f"rendered {out.parent.name}/{out.name}"


def step_render(args) -> None:
    jobs = [(s, lens, spec["lens"]) for cam in args.cameras for spec in [CAMERAS[cam]]
            for s in spec["fit"] + spec["extra"] for lens in (True, False)]
    with cf.ThreadPoolExecutor(args.jobs) as ex:
        for i, line in enumerate(ex.map(render_linear, jobs), 1):
            if i % 10 == 0 or i == len(jobs):
                log(f"render {i}/{len(jobs)} {line}")


def step_fit(args) -> None:
    for cam in args.cameras:
        spec = CAMERAS[cam]
        v2 = json.loads(calibration_path(cam, "v2").read_text(encoding="utf-8"))
        settings = dict(v2["decoder"]["settings"], gamutMapping=False)
        items = []
        for i, s in enumerate(sorted(spec["fit"])):
            ref = refs.neutral(str(REF), s)
            lens = refs.linear_subdir(ref) == "v8"
            meta = json.loads(linear(s, lens).with_suffix(".json").read_text(encoding="utf-8"))
            items.append({"scene": s, "candidate": str(linear(s, lens)), "candidateSpace": "linear-prophoto", "reference": ref,
                          "neutralTemperatureK": round(float(meta["neutral"]["temperatureK"]), 1),
                          "split": "train" if i % 2 == 0 else "val"})
        fit_dir = S11 / "fit"
        fit_dir.mkdir(parents=True, exist_ok=True)
        manifest = {"track": "apple", "camera": {"make": spec["make"], "model": spec["model"]}, "decoderVersion": "8",
                    "decoder": {"kind": "apple-cirawfilter", "settings": settings}, "items": items}
        mpath = fit_dir / f"manifest-{cam}-v3.json"
        mpath.write_text(json.dumps(manifest, ensure_ascii=False, indent=1), encoding="utf-8")
        candidates = {}
        for label, extra in (("1ill", ["--illuminants", "1"]),
                             ("2ill", ["--illuminants", "2", "--illuminant-nodes", spec["nodes"]] if spec["nodes"] else None)):
            if extra is None:
                continue
            out = fit_dir / f"cal-{cam}-{label}-v3.json"
            shutil.copyfile(calibration_path(cam, "v2"), out)  # fit_base が whiteBalanceMap と lens を引き継ぐ
            log(f"fit {cam} {label} ({len(items)} scenes)")
            r = subprocess.run([sys.executable, str(HERE / "fit_base.py"), "--manifest", str(mpath), "--out", str(out),
                                "--report", str(fit_dir / f"report-{cam}-{label}-v3.md"), "--huesat", "12", "--version", "v3", *extra],
                               capture_output=True, text=True)
            if r.returncode != 0:
                raise SystemExit(f"fit_base failed: {r.stderr[-800:]}")
            candidates[label] = json.loads(out.read_text(encoding="utf-8"))
        chosen = "1ill"
        if "2ill" in candidates:
            va, vb = candidates["1ill"]["fit"]["val"]["mean"], candidates["2ill"]["fit"]["val"]["mean"]
            if va is not None and vb is not None and vb < va - 0.1:
                chosen = "2ill"
        cal = candidates[chosen]
        cal.setdefault("fit", {})["selection"] = {
            "candidates": {k: {"train": v["fit"]["train"], "val": v["fit"]["val"]} for k, v in candidates.items()},
            "rule": "val mean が 0.1 以上良ければ 2 光源、そうでなければ 1 光源", "chosen": chosen}
        for key in ("whiteBalanceMap", "lens"):
            if v2.get(key) and not cal.get(key):
                cal[key] = v2[key]
        calibration_path(cam, "v3").write_text(json.dumps(cal, ensure_ascii=False, indent=1) + "\n", encoding="utf-8")
        log(f"{cam} v3 ({chosen}): train {cal['fit']['train']} val {cal['fit']['val']} | v2 train {v2['fit']['train']} val {v2['fit']['val']}")


def step_table(args) -> None:
    for cam in args.cameras:
        spec = CAMERAS[cam]
        cal = calibration_path(cam, "v3")
        out = S11 / "table" / f"{cam}.json"
        out.parent.mkdir(parents=True, exist_ok=True)
        log(f"table {cam} from {spec['table_raw']}")
        r = subprocess.run([sys.executable, str(HERE / "fit_wb_table.py"), "--raw", str(raw_path(spec["table_raw"])),
                            "--calibration", str(cal), "--out", str(out), "--into-calibration", str(cal),
                            "--verify-raw", *[str(raw_path(s)) for s in spec["verify_raw"]], "--bin", str(BIN),
                            "--work", str(S11 / "wb-table"), "--jobs", str(args.jobs), "--report", str(out.with_suffix(".md"))],
                           capture_output=True, text=True)
        if r.returncode != 0:
            raise SystemExit(f"fit_wb_table failed: {r.stderr[-800:]}")
        print("\n".join(r.stdout.strip().splitlines()[:6]))


def round7_scenes() -> list[dict]:
    manifest = json.loads((REF / "round7" / "manifest.json").read_text(encoding="utf-8"))
    first: dict[str, dict] = {}
    for e in manifest:
        first.setdefault(e["scene"], e)
    return [first[s] for s in sorted(first)]


def camera_of(model: str) -> str:
    return next(cam for cam, spec in CAMERAS.items() if spec["model"] == model)


def scenes_for_cameras(scenes: list[dict], cameras: list[str]) -> list[dict]:
    selected = set(cameras)
    classified = [(entry, camera_of(entry["model"])) for entry in scenes]
    result = [entry for entry, camera in classified if camera in selected]
    found = {camera for _, camera in classified if camera in selected}
    missing = sorted(selected - found)
    if missing:
        raise SystemExit(f"round7 manifest has no scenes for selected camera(s): {', '.join(missing)}")
    return result


def step_wc(args) -> None:
    by_cam: dict[str, list[str]] = {}
    for e in scenes_for_cameras(round7_scenes(), args.cameras):
        by_cam.setdefault(camera_of(e["model"]), []).append(e["scene"])
    for cam in args.cameras:
        scenes = by_cam[cam]
        for lens in (True, False):
            out = S11 / ("working-copy" if lens else "working-copy-nolens")
            run([sys.executable, str(HERE / "make_working_copies.py"), "--calibration", str(calibration_path(cam, "v3")),
                 "--linear-dir", str(linear(scenes[0], lens).parent), "--out-dir", str(out), "--scenes", *scenes])
        log(f"wc {cam}: {len(scenes)} scenes")


def read_working_copy(png: Path) -> np.ndarray:
    code = cv2.imread(str(png), cv2.IMREAD_UNCHANGED)[..., ::-1].astype(np.float64) / 65535.0
    return WORKING_COPY_MAX * code ** WORKING_COPY_GAMMA


def write_working_copy(rgb: np.ndarray, png: Path, meta: dict) -> None:
    rgb = np.clip(rgb, 0.0, WORKING_COPY_MAX)
    code = np.rint(np.power(rgb / WORKING_COPY_MAX, 1.0 / WORKING_COPY_GAMMA) * 65535.0).astype(np.uint16)
    png.parent.mkdir(parents=True, exist_ok=True)
    cv2.imwrite(str(png), np.ascontiguousarray(code[..., ::-1]))
    png.with_suffix(".json").write_text(json.dumps(meta), encoding="utf-8")


def crate_render(wc: Path, settings: str, out: Path) -> None:
    out.parent.mkdir(parents=True, exist_ok=True)
    run([str(BRIDGE), str(wc), str(wc.with_suffix(".json")), settings, "0", str(out), "97", "--look=niho-interim-1"])


def wb_xmp(scene: str, kelvin: int) -> Path:
    for d in ("round6-photos", "round6-photos-2", "round6-photos-3"):
        p = REF / "round6" / d / f"p6_{scene}_wb_{kelvin}.xmp"
        if p.exists():
            return p
    raise SystemExit(f"xmp not found: {scene} {kelvin}")


def measure(ref: Path, cand: Path) -> dict:
    pair = CMP.load_pair(str(ref), str(cand), C.SPACE_SRGB, render=False, size=1500)
    y0, y1, x0, x1 = pair.crop
    sl = (slice(y0, y1), slice(x0, x1))
    sigma = CMP.sigma_for(2.0, max(pair.frame_size))
    m = CMP.measure_pair(pair, pair.cand, sigma)
    rr = C.linear_srgb_to_lab(np.clip(pair.ref_lin[sl], 0, 1))
    cc = C.linear_srgb_to_lab(np.clip(pair.cand[sl], 0, 1))
    val = pair.valid[sl]
    h = np.degrees(np.arctan2(rr[..., 2], rr[..., 1]))
    cr = np.hypot(rr[..., 1], rr[..., 2])
    warm = (h > 30) & (h < 80) & (cr > 10) & (cr < 45) & (rr[..., 0] > 45) & (rr[..., 0] < 92) & val
    ratio = float(np.hypot(cc[..., 1], cc[..., 2])[warm].sum() / max(cr[warm].sum(), 1e-6)) if warm.sum() > 500 else None
    return {"mean": round(m["deltaE00"]["mean"], 4), "p99": round(m["deltaE00"]["p99"], 4), "evDiff": m["evDiff"],
            "warmChromaRatio": None if ratio is None else round(ratio, 4)}


def accuracy_one(job) -> dict:
    scene, model, kelvin = job
    cam = camera_of(model)
    out = S11 / "accuracy" / scene
    res = {"scene": scene, "model": model, "kelvin": kelvin}
    if kelvin is None:  # 撮影時の白: v2 と v3 の作業コピー
        ref = REF / "round6" / "lr-export" / f"p6_{scene}_neutral.jpg"
        for label, wc in (("v2", S8 / "working-copy-nolens" / f"{scene}.png"), ("v3", S11 / "working-copy-nolens" / f"{scene}.png")):
            jpg = out / f"neutral-{label}.jpg"
            crate_render(wc, "neutral", jpg)
            res[label] = measure(ref, jpg)
        return res
    ref = REF / "round6" / "lr-export" / f"p6_{scene}_wb_{kelvin}.jpg"
    # 今の近似: v2 の作業コピー + XMP（絶対 WB → Bradford の色順応）
    jpg = out / f"{kelvin}-current.jpg"
    crate_render(S8 / "working-copy-nolens" / f"{scene}.png", str(wb_xmp(scene, kelvin)), jpg)
    res["current"] = measure(ref, jpg)
    # 表: v3 の作業コピーに C · M(w1) · I(w0) · C^-1
    wc3 = S11 / "working-copy-nolens" / f"{scene}.png"
    meta = json.loads(wc3.with_suffix(".json").read_text(encoding="utf-8"))
    table = WT.WhiteBalanceTable(meta["whiteBalanceTable"])
    w0 = (float(meta["asShotWhiteAdobe"]["temperature"]), float(meta["asShotWhiteAdobe"]["tint"]))
    t = table.working_copy_transfer(meta["whiteBalanceTable"]["calibrationMatrix"], w0, (float(kelvin), 0.0))
    rgb = read_working_copy(wc3)
    tmeta = {k: v for k, v in meta.items() if k != "whiteBalanceTable"}
    twc = out / f"{kelvin}-table.png"
    write_working_copy(rgb @ t.T, twc, tmeta)
    jpg = out / f"{kelvin}-table.jpg"
    crate_render(twc, "neutral", jpg)
    res["table"] = measure(ref, jpg)
    # 描き直し: Apple で目標の白を指定（色域の圧縮オフ・校正なしで描いて C を当てる）
    cal = json.loads(calibration_path(cam, "v3").read_text(encoding="utf-8"))
    xy = WT.lightroom_to_apple(xy_from_temperature(float(kelvin), 0.0), cal.get("whiteBalanceMap"))
    ka, ta = temperature_from_xy(*xy)
    tif = out / f"{kelvin}-direct.tiff"
    if not tif.exists():
        run([str(BIN), "render", str(raw_path(scene)), "--out", str(tif), "--meta", str(tif.with_suffix(".json")),
             "--long-edge", "2560", "--space", "linear-prophoto", "--encoding", "tiff32f", "--decoder-version", "8",
             "--lens-correction", "off", "--gamut-mapping", "off", "--white", f"{ka:.4f},{ta:.4f}"])
    lin = cv2.imread(str(tif), cv2.IMREAD_UNCHANGED)[..., ::-1].astype(np.float64)
    cmat = np.asarray(meta["whiteBalanceTable"]["calibrationMatrix"], dtype=np.float64).reshape(3, 3)
    dwc = out / f"{kelvin}-direct.png"
    write_working_copy(lin @ cmat.T, dwc, tmeta)
    jpg = out / f"{kelvin}-direct.jpg"
    crate_render(dwc, "neutral", jpg)
    res["direct"] = measure(ref, jpg)
    return res


def step_accuracy(args) -> None:
    jobs = [(e["scene"], e["model"], k) for e in scenes_for_cameras(round7_scenes(), args.cameras)
            for k in (None, *KELVINS)]
    results = []
    with cf.ThreadPoolExecutor(args.jobs) as ex:
        for i, r in enumerate(ex.map(accuracy_one, jobs), 1):
            results.append(r)
            if i % 10 == 0 or i == len(jobs):
                log(f"accuracy {i}/{len(jobs)}")
    (S11 / "results").mkdir(parents=True, exist_ok=True)
    (S11 / "results" / "accuracy.json").write_text(json.dumps(results, ensure_ascii=False, indent=1), encoding="utf-8")
    lines = ["# S11: 白の当て直しの精度（round6 の白の変種・Adobe Standard・ルック無し・ΔE00）", "",
             "| 目標の白 | 今の近似（Bradford） | 表（行列） | Apple で描き直し |", "|---|---:|---:|---:|"]
    for k in KELVINS:
        rows = [r for r in results if r["kelvin"] == k]
        cell = lambda key: f"{np.mean([r[key]['mean'] for r in rows]):.2f} / p99 {np.max([r[key]['p99'] for r in rows]):.1f} / 暖色 ×{np.mean([r[key]['warmChromaRatio'] for r in rows if r[key]['warmChromaRatio']]):.3f}"
        lines.append(f"| {k}K（{len(rows)} 場面） | {cell('current')} | {cell('table')} | {cell('direct')} |")
    neutral = [r for r in results if r["kelvin"] is None]
    lines += ["", f"撮影時の白（中立）: v2 の作業コピー {np.mean([r['v2']['mean'] for r in neutral]):.2f} / v3（色域の圧縮オフ） {np.mean([r['v3']['mean'] for r in neutral]):.2f}（{len(neutral)} 場面）", "",
              "| 場面 | 白 | 今の近似 | 表 | 描き直し |", "|---|---:|---:|---:|---:|"]
    for r in sorted((r for r in results if r["kelvin"]), key=lambda r: (r["scene"], r["kelvin"])):
        lines.append(f"| {r['scene']} | {r['kelvin']} | {r['current']['mean']:.2f} | {r['table']['mean']:.2f} | {r['direct']['mean']:.2f} |")
    md = "\n".join(lines) + "\n"
    (S11 / "results" / "accuracy.md").write_text(md, encoding="utf-8")
    print(md[:2500])


STEPS = {"render": step_render, "fit": step_fit, "table": step_table, "wc": step_wc, "accuracy": step_accuracy}


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("step", choices=[*STEPS, "all"])
    ap.add_argument("--cameras", nargs="+", default=list(CAMERAS), choices=list(CAMERAS))
    ap.add_argument("--jobs", type=int, default=3)
    args = ap.parse_args()
    for name in (list(STEPS) if args.step == "all" else [args.step]):
        STEPS[name](args)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
