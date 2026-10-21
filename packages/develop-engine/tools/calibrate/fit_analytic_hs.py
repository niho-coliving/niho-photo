#!/usr/bin/env python3
"""Calibrate analytic H/S candidate B (#26, RESEARCH26-27.md) on development teachers.

Development teachers only: the work directory's `data/teachers` and
`data/teachers2` (manifest.json, inputs/, lr-export/ as written by
make_lr_p3_jpeg.py). A sealed manifest, a cohort that resolves to an
`independent` directory and a work directory inside the repository are refused.
Everything with scene names, paths or hashes of inputs stays in the work
directory; `publish` writes only anonymous aggregates.

The crate does not fit: `examples/analytic_hs_calibrate.rs` renders the
candidate for proposed coefficients and returns a reduced-size stand-in of the
gate error (H/S gains at 1024px, downstream and CIEDE2000 at 512px on flat
reference pixels). Coefficients are chosen with capture-date folds: each
fold's coefficients see only the other dates, and families / objectives are
compared by the held-out error, never by looking at a held-out fold. The gate
itself (`gate`) is measured like color-review-teachers.py: 2048px renders of
`examples/analytic_hs_probe.rs` (A = niho-10, B = candidate) compared with
colorcheck at 1500px, blur 2, flat pixels.

  fit_analytic_hs.py --repo <checkout> --work <private> plan
  fit_analytic_hs.py --repo <checkout> --work <private> cv [--folds dates|models]
  fit_analytic_hs.py --repo <checkout> --work <private> fit
  fit_analytic_hs.py --repo <checkout> --work <private> oracle
  fit_analytic_hs.py --repo <checkout> --work <private> gate --family B1|B2 [--folds dates]
  fit_analytic_hs.py --repo <checkout> --work <private> publish --family B1 --out <summary.json>
  fit_analytic_hs.py --repo <checkout> --work <private> holdout --cohort <new-photos> --freeze <freeze.json>
      [--calibrate <frozen analytic_hs_calibrate>] [--probe <frozen analytic_hs_probe>]
      (once, only after the freeze; see RESEARCH26-27.md)

Needs numpy, scipy, Pillow, opencv-python-headless (colorcheck's) and release
builds of `analytic_hs_calibrate`, `analytic_hs_probe` (cargo +1.98.1 build
--release --locked -p niho-develop --example ...).
"""
from __future__ import annotations

import argparse
import concurrent.futures
import hashlib
import json
import os
import subprocess
import sys
import time
from pathlib import Path

# One thread per worker process: the work is parallel across items.
for _variable in ("OMP_NUM_THREADS", "OPENBLAS_NUM_THREADS", "VECLIB_MAXIMUM_THREADS", "MKL_NUM_THREADS"):
    os.environ.setdefault(_variable, "1")

import numpy as np  # noqa: E402

COHORTS = ("teachers", "teachers2")
H_ONLY = ("h30", "h60", "h100")
S_ONLY = ("s30", "s60", "s100")
COMBOS = ("h60s30", "h100s100")
PRESETS = ("preset_bluesky2", "preset_pastel", "preset_colorful")
HS_VARIANTS = H_ONLY + S_ONLY + COMBOS + PRESETS
VARIANTS = ("neutral",) + HS_VARIANTS
SUBSETS = ("dark", "brightIphone", "daylight")
FOLD_COUNT = 5
MAX_RESIDUAL_EV = 0.5

# Objective (fixed before any fit; surrogate units).
PRESET_WEIGHT = 2.0
P99_WEIGHT = 0.25
TAIL_START = 6.0
TAIL_WEIGHT = 0.5
GUARD_MARGIN = 0.2
GUARD_WEIGHT = 2.0

# Start of every fit, from NIHO6.md "原因" (not from the teachers' pixels):
# Highlights act on brightness relative to the mean log luminance, stronger in
# darker photos; Shadows on darkness relative to p90; Lightroom keeps
# highlight chroma (alpha ~0.3-0.5) and shadow chroma ~1.05.
FORMULA_KEYS = (
    ("highlightScale", 0), ("highlightScale", 1), ("highlightShift", 0), ("highlightShift", 1),
    ("highlightChromaAlpha", None),
    ("shadowScale", 0), ("shadowScale", 1), ("shadowShift", 0), ("shadowShift", 1),
    ("shadowChromaAlpha", None),
)
START = np.array([0.0, -0.35, 6.5, 1.0, 0.5, 1.0, 0.0, 0.5, 1.0, 1.05])
STEP = np.array([0.25, 0.05, 0.5, 0.1, 0.1, 0.25, 0.05, 0.5, 0.1, 0.1])
LOWER = np.array([-3.0, -1.0, -4.0, 0.0, 0.0, 0.0, -0.5, -6.0, 0.0, 0.5])
UPPER = np.array([4.0, 0.5, 12.0, 1.5, 1.5, 3.0, 0.5, 6.0, 1.5, 1.5])
HIGHLIGHT_PARAMS = (0, 1, 2, 3, 4)
SHADOW_PARAMS = (5, 6, 7, 8, 9)
RESIDUAL_STEP = 0.5
RESIDUAL_BOUND = 8.0


def digest(path: Path) -> str:
    with open(path, "rb") as f:
        return hashlib.file_digest(f, "sha256").hexdigest()


def validate_frozen_executables(record: dict, probe: Path, calibrate: Path) -> None:
    executables = record.get("executables", {})
    if not probe.is_file() or digest(probe) != executables.get("analyticHsProbeSha256"):
        raise SystemExit("analytic_hs_probe differs from the frozen executable")
    if not calibrate.is_file() or digest(calibrate) != executables.get("analyticHsCalibrateSha256"):
        raise SystemExit("analytic_hs_calibrate differs from the frozen executable")


def validate_frozen_tool(record: dict, tool: Path) -> None:
    if not tool.is_file() or digest(tool) != record.get("evaluationToolSha256"):
        raise SystemExit("fit_analytic_hs.py differs from the frozen evaluation tool")


def baseline_fingerprint(plan_path: Path, config_path: Path, calibrate: Path) -> str:
    """Bind cached baseline rows to the exact plan, renderer inputs, settings and executable."""
    config = json.loads(config_path.read_text())
    paths = {plan_path, config_path, calibrate}
    for scene in config["scenes"]:
        paths.add(Path(scene["input"]))
    for item in config["items"]:
        paths.update(Path(item[key]) for key in ("settings", "reference") if item.get(key))

    fingerprint = hashlib.sha256()
    for path in sorted((p.resolve() for p in paths), key=str):
        fingerprint.update(str(path).encode("utf-8"))
        fingerprint.update(b"\0")
        fingerprint.update(digest(path).encode("ascii"))
        fingerprint.update(b"\0")
    return fingerprint.hexdigest()


def binaries(repo: Path) -> dict[str, Path]:
    root = repo / "packages/develop-engine/target/release"
    return {
        "calibrate": root / "examples/analytic_hs_calibrate",
        "probe": root / "examples/analytic_hs_probe",
    }


def guard_work(repo: Path, work: Path) -> None:
    repo, work = repo.resolve(), work.resolve()
    if work == repo or repo in work.parents:
        raise SystemExit("private inputs/outputs must be outside the repository")


def cohort_root(work: Path, cohort: str) -> Path:
    root = (work / "data" / cohort).resolve()
    if "independent" in root.parts:
        raise SystemExit("an independent holdout is never a development cohort")
    manifest = json.loads((root / "manifest.json").read_text())
    if manifest.get("sealed"):
        raise SystemExit("sealed cohort is forbidden for development")
    return root


def subset_of(scene: dict) -> str:
    """Metadata only: band is the teachers' ISO stratum (bright <= 100 < mid <= 640 < dark)."""
    if scene.get("band") == "dark":
        return "dark"
    if str(scene.get("model", "")).startswith("iPhone") and scene.get("band") == "bright":
        return "brightIphone"
    return "daylight"


def model_group(scene: dict) -> str:
    model = str(scene.get("model", ""))
    if model.startswith("iPhone 13"):
        return "iphone13"
    if model.startswith("iPhone 11"):
        return "iphone11"
    return "camera"


# ---------------------------------------------------------------- plan

def plan(args) -> None:
    sys.path.insert(0, str(args.repo / "packages/develop-engine/tools/calibrate"))
    from fit_niho6_response import blank_input

    bins = binaries(args.repo)
    settings_dir = args.work / "settings"
    subprocess.run([str(bins["calibrate"]), "settings", str(settings_dir)], check=True)
    scenes, skipped, manifests = [], 0, {}
    for cohort in COHORTS:
        root = cohort_root(args.work, cohort)
        manifests[cohort] = digest(root / "manifest.json")
        for scene in json.loads((root / "manifest.json").read_text())["scenes"]:
            source = root / "inputs" / f"{scene['scene']}__neutral.jpg"
            if blank_input(source):
                skipped += 1
                continue
            scenes.append({
                "cohort": cohort, "scene": scene["scene"], "date": scene["date"],
                "model": scene["model"], "iso": scene.get("iso"), "band": scene.get("band"),
                "subset": subset_of(scene), "modelGroup": model_group(scene),
                "input": str(source), "lrExport": str(root / "lr-export"),
            })
    dates = sorted({s["date"] for s in scenes})
    date_groups = [dates[i::FOLD_COUNT] for i in range(FOLD_COUNT)]
    groups = sorted({s["modelGroup"] for s in scenes})
    for s in scenes:
        s["dateFold"] = next(k for k, g in enumerate(date_groups) if s["date"] in g)
        s["modelFold"] = groups.index(s["modelGroup"])
    items = [{"scene": i, "variant": v} for i, s in enumerate(scenes) for v in VARIANTS]
    config = {
        "longEdge": 1024, "metricLongEdge": 512, "samples": 8000, "threads": args.threads,
        "seed": 26, "gains": "fast",
        "scenes": [{"input": s["input"]} for s in scenes],
        "items": [{"scene": it["scene"], "settings": str(settings_dir / f"{it['variant']}.json"),
                   "reference": str(Path(scenes[it["scene"]]["lrExport"]) / f"{scenes[it['scene']]['scene']}__{it['variant']}.jpg")}
                  for it in items],
    }
    (args.work / "server-config.json").write_text(json.dumps(config, indent=1))
    (args.work / "plan.json").write_text(json.dumps({
        "scenes": scenes, "items": items, "blankExcluded": skipped, "manifestSha256": manifests,
        "modelGroups": groups,
    }, indent=1, ensure_ascii=False))
    counts = {k: sum(s["subset"] == k for s in scenes) for k in SUBSETS}
    folds = [sum(s["dateFold"] == k for s in scenes) for k in range(FOLD_COUNT)]
    print(json.dumps({"scenes": len(scenes), "items": len(items), "blankExcluded": skipped,
                      "subsets": counts, "dateFoldSizes": folds}, indent=1))


# ---------------------------------------------------------------- server

class Server:
    def __init__(self, binary: Path, config: Path, gains: str | None = None):
        if gains:
            value = json.loads(config.read_text())
            value["gains"] = gains
            config = config.with_name(f"server-config-{gains}.json")
            config.write_text(json.dumps(value))
        self.process = subprocess.Popen(["nice", "-n", "10", str(binary), "serve", str(config)],
                                        stdin=subprocess.PIPE, stdout=subprocess.PIPE, text=True)
        self.description = json.loads(self.process.stdout.readline())
        self.calls = 0

    def request(self, value: dict) -> np.ndarray:
        self.process.stdin.write(json.dumps(value) + "\n")
        self.process.stdin.flush()
        reply = json.loads(self.process.stdout.readline())
        if "error" in reply:
            raise RuntimeError(reply["error"])
        self.calls += 1
        return np.asarray(reply["rows"], dtype=np.float64)

    def eval(self, candidate: dict, items: list[int]) -> np.ndarray:
        return self.request({"op": "eval", "candidate": candidate, "items": items})

    def baseline(self, items: list[int]) -> np.ndarray:
        return self.request({"op": "baseline", "items": items})

    def close(self) -> None:
        try:
            self.process.stdin.write('{"op":"quit"}\n')
            self.process.stdin.flush()
        except BrokenPipeError:
            pass
        self.process.wait()


def candidate_of(theta: np.ndarray, residual: np.ndarray | None) -> dict:
    formula: dict = {"highlightScale": [0.0, 0.0], "highlightShift": [0.0, 0.0],
                     "shadowScale": [0.0, 0.0], "shadowShift": [0.0, 0.0]}
    for value, (key, index) in zip(theta, FORMULA_KEYS):
        if index is None:
            formula[key] = float(value)
        else:
            formula[key][index] = float(value)
    if residual is None:
        res = {"highlight": [0.0] * 3, "shadow": [0.0] * 3, "maxResidualEV": 0.0}
    else:
        res = {"highlight": [float(v) for v in residual[:3]], "shadow": [float(v) for v in residual[3:]],
               "maxResidualEV": MAX_RESIDUAL_EV}
    return {"formula": formula, "residual": res}


UNCALIBRATED = candidate_of(np.array([0.72, -0.11, 4.0, 1.0, 1.0, 0.82, 0.10, 1.0, 1.0, 1.0]), None)


# ---------------------------------------------------------------- objective

def loss(rows: np.ndarray, base: np.ndarray, weights: np.ndarray, guarded: np.ndarray) -> float:
    mean, p99 = rows[:, 0], rows[:, 1]
    value = mean + P99_WEIGHT * p99 + TAIL_WEIGHT * np.maximum(p99 - TAIL_START, 0.0) ** 2
    value = value + GUARD_WEIGHT * guarded * np.maximum(mean - base[:, 0] - GUARD_MARGIN, 0.0)
    return float(np.sum(weights * value) / np.sum(weights))


class Objective:
    def __init__(self, server: Server, plan_doc: dict, items: list[int], base_rows: np.ndarray):
        self.server = server
        self.items = items
        variants = [plan_doc["items"][i]["variant"] for i in items]
        self.weights = np.array([PRESET_WEIGHT if v in PRESETS else 1.0 for v in variants])
        self.guarded = np.array([plan_doc["scenes"][plan_doc["items"][i]["scene"]]["subset"] != "dark"
                                 for i in items], dtype=np.float64)
        self.base = base_rows[items]
        self.evaluations = 0

    def __call__(self, theta: np.ndarray, residual: np.ndarray | None) -> float:
        self.evaluations += 1
        rows = self.server.eval(candidate_of(theta, residual), self.items)
        return loss(rows, self.base, self.weights, self.guarded)


def minimize(fun, x0: np.ndarray, step: np.ndarray, lower: np.ndarray, upper: np.ndarray,
             maxfev: int) -> tuple[np.ndarray, float, int]:
    """Bounded Nelder-Mead in step-scaled coordinates (deterministic)."""
    from scipy.optimize import minimize as scipy_minimize

    scaled = lambda z: np.clip(x0 + z * step, lower, upper)
    simplex = np.vstack([np.zeros(len(x0))] + [np.eye(len(x0))[i] for i in range(len(x0))])
    result = scipy_minimize(lambda z: fun(scaled(z)), np.zeros(len(x0)), method="Nelder-Mead",
                            bounds=list(zip((lower - x0) / step, (upper - x0) / step)),
                            options={"maxfev": maxfev, "initial_simplex": simplex,
                                     "xatol": 1e-2, "fatol": 1e-4, "adaptive": True})
    return scaled(result.x), float(result.fun), int(result.nfev)


def oracle_start(server: Server, work: Path, scene_ids: set[int]) -> np.ndarray:
    """Start of a fit from the per-photo constants (`oracle`) of `scene_ids`
    only: least squares of each gain scale / shift on its statistic (mean for
    Highlights, p90 for Shadows), median chroma alphas, clipped to the bounds."""
    oracle_doc = json.loads((work / "runs" / "oracle.json").read_text())
    scenes = server.description["scenes"]
    ids = sorted(scene_ids)
    theta = np.array([oracle_doc[str(j)]["theta"] for j in ids])
    mean = np.array([scenes[j]["meanLog2Y"] for j in ids])
    p90 = np.array([scenes[j]["p90Log2Y"] for j in ids])
    start = START.copy()
    for target, statistic, slots in ((0, mean, (0, 1)), (2, mean, (2, 3)), (5, p90, (5, 6)), (7, p90, (7, 8))):
        design = np.stack([np.ones_like(statistic), statistic], axis=1)
        start[list(slots)] = np.linalg.lstsq(design, theta[:, target], rcond=None)[0]
    start[4] = float(np.median(theta[:, 4]))
    start[9] = float(np.median(theta[:, 9]))
    return np.clip(start, LOWER, UPPER)


def fit_family(server: Server, plan_doc: dict, scene_ids: set[int], base_rows: np.ndarray,
               budget: dict, log, start: np.ndarray | None = None) -> dict:
    """B1 (formula) then B2 (B1 + bounded residual) on the scenes `scene_ids`."""
    def items_of(variants):
        return [i for i, it in enumerate(plan_doc["items"])
                if it["scene"] in scene_ids and it["variant"] in variants]

    theta = (START if start is None else start).copy()
    start_candidate = candidate_of(theta, None)
    trace = []
    for name, params, variants in (("highlights", HIGHLIGHT_PARAMS, H_ONLY),
                                   ("shadows", SHADOW_PARAMS, S_ONLY)):
        objective = Objective(server, plan_doc, items_of(variants), base_rows)
        idx = list(params)

        def stage(sub, idx=idx):
            full = theta.copy()
            full[idx] = sub
            return objective(full, None)

        start = stage(theta[idx])
        best, value, nfev = minimize(stage, theta[idx], STEP[idx], LOWER[idx], UPPER[idx], budget[name])
        theta[idx] = best
        trace.append({"stage": name, "items": len(objective.items), "start": start, "loss": value, "nfev": nfev})
        log(f"  {name}: {start:.4f} -> {value:.4f} ({nfev})")
    joint = Objective(server, plan_doc, items_of(HS_VARIANTS), base_rows)
    start = joint(theta, None)
    theta, value, nfev = minimize(lambda t: joint(t, None), theta, STEP, LOWER, UPPER, budget["joint"])
    trace.append({"stage": "joint", "items": len(joint.items), "start": start, "loss": value, "nfev": nfev})
    log(f"  joint: {start:.4f} -> {value:.4f} ({nfev})")
    b1 = candidate_of(theta, None)
    residual = np.zeros(6)
    start = joint(theta, residual)
    residual, value_r, nfev = minimize(lambda r: joint(theta, r), residual, np.full(6, RESIDUAL_STEP),
                                       np.full(6, -RESIDUAL_BOUND), np.full(6, RESIDUAL_BOUND),
                                       budget["residual"])
    trace.append({"stage": "residual", "items": len(joint.items), "start": start, "loss": value_r, "nfev": nfev})
    log(f"  residual: {start:.4f} -> {value_r:.4f} ({nfev})")
    return {"B1": b1, "B2": candidate_of(theta, residual), "trace": trace,
            "trainLoss": {"B1": value, "B2": value_r}, "start": start_candidate}


def surrogate_baseline(server: Server, work: Path, plan_doc: dict, plan_path: Path,
                       config_path: Path, calibrate: Path) -> np.ndarray:
    path = work / "surrogate-baseline.json"
    count = len(plan_doc["items"])
    fingerprint = baseline_fingerprint(plan_path, config_path, calibrate)
    if path.exists():
        try:
            cached = json.loads(path.read_text())
            rows = np.asarray(cached["rows"])
            if cached.get("fingerprint") == fingerprint and rows.shape == (count, 4) and np.isfinite(rows).all():
                return rows
        except (KeyError, TypeError, ValueError, json.JSONDecodeError):
            pass
    rows = server.baseline(list(range(count)))
    temporary = path.with_suffix(".tmp")
    temporary.write_text(json.dumps({"fingerprint": fingerprint, "rows": rows.tolist()}))
    temporary.replace(path)
    return rows


def fold_key(folds: str) -> str:
    return {"dates": "dateFold", "models": "modelFold"}[folds]


def budget_of(args) -> dict:
    return {"highlights": args.stage_fev, "shadows": args.stage_fev, "joint": args.joint_fev,
            "residual": args.residual_fev}


def cv(args) -> None:
    plan_path = args.work / "plan.json"
    plan_doc = json.loads(plan_path.read_text())
    bins = binaries(args.repo)
    server = Server(bins["calibrate"], args.work / "server-config.json")
    base_rows = surrogate_baseline(
        server, args.work, plan_doc, plan_path, args.work / "server-config.json", bins["calibrate"])
    key = fold_key(args.folds)
    folds = sorted({s[key] for s in plan_doc["scenes"]})
    out_dir = args.work / "runs" / f"cv-{args.folds}"
    out_dir.mkdir(parents=True, exist_ok=True)
    log = lambda msg: print(msg, flush=True)
    rows_oof = {name: np.full((len(plan_doc["items"]), 4), np.nan) for name in ("B0", "B1", "B2")}
    for k in folds:
        held = {i for i, s in enumerate(plan_doc["scenes"]) if s[key] == k}
        train = set(range(len(plan_doc["scenes"]))) - held
        path = out_dir / f"fold{k}.json"
        if path.exists():
            fitted = json.loads(path.read_text())
        else:
            started = time.monotonic()
            log(f"fold {k}: train {len(train)} held {len(held)}")
            fitted = fit_family(server, plan_doc, train, base_rows, budget_of(args), log,
                                oracle_start(server, args.work, train))
            fitted["seconds"] = time.monotonic() - started
            fitted["heldScenes"] = sorted(held)
            path.write_text(json.dumps(fitted, indent=1))
        held_items = [i for i, it in enumerate(plan_doc["items"]) if it["scene"] in held]
        for name, candidate in (("B0", UNCALIBRATED), ("B1", fitted["B1"]), ("B2", fitted["B2"])):
            rows_oof[name][held_items] = server.eval(candidate, held_items)
    server.close()
    (out_dir / "oof-surrogate.json").write_text(json.dumps(
        {name: rows.tolist() for name, rows in rows_oof.items()} | {"baseline": base_rows.tolist()}))
    for name in ("B0", "B1", "B2"):
        print(name, json.dumps(surrogate_summary(plan_doc, rows_oof[name], base_rows), ensure_ascii=False))
    print("niho-10", json.dumps(surrogate_summary(plan_doc, base_rows, base_rows), ensure_ascii=False))
    selection = select_family(plan_doc, rows_oof)
    (out_dir / "selection.json").write_text(json.dumps(selection, indent=1))
    print("selected", json.dumps(selection))


def select_family(plan_doc: dict, rows_oof: dict) -> dict:
    """Fixed before the folds were fitted: fewer held-out preset p99 > 8 on the
    target photos (dark + bright iPhone), then the lower held-out preset mean;
    the residual (B2) is kept only if the daylight preset mean does not rise
    by more than 0.05 over B1."""
    items = plan_doc["items"]
    presets = [i for i, it in enumerate(items) if it["variant"] in PRESETS]
    target = [i for i in presets if plan_doc["scenes"][items[i]["scene"]]["subset"] in ("dark", "brightIphone")]
    daylight = [i for i in presets if plan_doc["scenes"][items[i]["scene"]]["subset"] == "daylight"]
    score = {name: {"targetPresetP99Over8": int((rows_oof[name][target, 1] > 8).sum()),
                    "presetMean": round(float(rows_oof[name][presets, 0].mean()), 4),
                    "daylightPresetMean": round(float(rows_oof[name][daylight, 0].mean()), 4)}
             for name in ("B1", "B2")}
    better = (score["B2"]["targetPresetP99Over8"], score["B2"]["presetMean"]) < \
        (score["B1"]["targetPresetP99Over8"], score["B1"]["presetMean"])
    keeps_daylight = score["B2"]["daylightPresetMean"] <= score["B1"]["daylightPresetMean"] + 0.05
    return {"family": "B2" if better and keeps_daylight else "B1", "surrogateOutOfFold": score}


def surrogate_summary(plan_doc: dict, rows: np.ndarray, base: np.ndarray) -> dict:
    out = {}
    for group, variants in (("presets", PRESETS), ("single", H_ONLY + S_ONLY), ("combos", COMBOS)):
        for subset in SUBSETS + ("all",):
            sel = [i for i, it in enumerate(plan_doc["items"]) if it["variant"] in variants
                   and (subset == "all" or plan_doc["scenes"][it["scene"]]["subset"] == subset)]
            r = rows[sel]
            out[f"{group}/{subset}"] = {
                "n": len(sel), "mean": round(float(r[:, 0].mean()), 3), "p99Mean": round(float(r[:, 1].mean()), 3),
                "p99Over8": int((r[:, 1] > 8).sum()), "worseMean": int((r[:, 0] > base[sel, 0] + 1e-9).sum()),
            }
    return out


def fit_all(args) -> None:
    plan_path = args.work / "plan.json"
    plan_doc = json.loads(plan_path.read_text())
    bins = binaries(args.repo)
    server = Server(bins["calibrate"], args.work / "server-config.json")
    base_rows = surrogate_baseline(
        server, args.work, plan_doc, plan_path, args.work / "server-config.json", bins["calibrate"])
    out_dir = args.work / "runs" / "all"
    out_dir.mkdir(parents=True, exist_ok=True)
    started = time.monotonic()
    every = set(range(len(plan_doc["scenes"])))
    fitted = fit_family(server, plan_doc, every, base_rows, budget_of(args),
                        lambda msg: print(msg, flush=True), oracle_start(server, args.work, every))
    fitted["seconds"] = time.monotonic() - started
    rows = {name: server.eval(fitted[name], list(range(len(plan_doc["items"])))).tolist() for name in ("B1", "B2")}
    server.close()
    (out_dir / "fit.json").write_text(json.dumps(fitted, indent=1))
    (out_dir / "insample-surrogate.json").write_text(json.dumps(rows))
    for name in ("B1", "B2"):
        print(name, json.dumps(surrogate_summary(plan_doc, np.asarray(rows[name]), base_rows), ensure_ascii=False))


def oracle(args) -> None:
    """Diagnostic upper bound of the operator: per photo, constant gain scale,
    shift and chroma alpha fitted on that photo's own single H (or S) items.
    In-sample by construction; it separates "the formula cannot express the
    scene statistics' effect" from "this operator cannot reach Lightroom"."""
    plan_path = args.work / "plan.json"
    plan_doc = json.loads(plan_path.read_text())
    bins = binaries(args.repo)
    server = Server(bins["calibrate"], args.work / "server-config.json")
    base_rows = surrogate_baseline(
        server, args.work, plan_doc, plan_path, args.work / "server-config.json", bins["calibrate"])
    out_path = args.work / "runs" / "oracle.json"
    out_path.parent.mkdir(parents=True, exist_ok=True)
    done = json.loads(out_path.read_text()) if out_path.exists() else {}
    for j, scene in enumerate(plan_doc["scenes"]):
        if str(j) in done:
            continue
        theta = START.copy()
        # Slopes 0: the intercepts are this photo's constants.
        theta[1] = theta[3] = theta[6] = theta[8] = 0.0
        theta[0] = START[0] + START[1] * -4.0
        theta[2] = START[2] + START[3] * -4.0
        theta[5] = START[5] + START[6] * -1.0
        theta[7] = START[7] + START[8] * -1.0
        rows = {}
        for params, variants in (((0, 2, 4), H_ONLY), ((5, 7, 9), S_ONLY)):
            items = [i for i, it in enumerate(plan_doc["items"]) if it["scene"] == j and it["variant"] in variants]
            objective = Objective(server, plan_doc, items, base_rows)
            idx = list(params)

            def stage(sub, idx=idx, objective=objective):
                full = theta.copy()
                full[idx] = sub
                return objective(full, None)

            best, _, _ = minimize(stage, theta[idx], STEP[idx], LOWER[idx], UPPER[idx], args.fev)
            theta[idx] = best
            for i, row in zip(items, server.eval(candidate_of(theta, None), items)):
                rows[str(i)] = row.tolist()
        done[str(j)] = {"theta": theta.tolist(), "rows": rows}
        out_path.write_text(json.dumps(done))
        print(f"oracle {j + 1}/{len(plan_doc['scenes'])}", flush=True)
    server.close()
    oracle_rows = np.full((len(plan_doc["items"]), 4), np.nan)
    for entry in done.values():
        for i, row in entry["rows"].items():
            oracle_rows[int(i)] = row
    summary = {}
    for variants, name in ((H_ONLY, "highlights"), (S_ONLY, "shadows")):
        for subset in SUBSETS + ("all",):
            sel = [i for i, it in enumerate(plan_doc["items"]) if it["variant"] in variants
                   and (subset == "all" or plan_doc["scenes"][it["scene"]]["subset"] == subset)]
            summary[f"{name}/{subset}"] = {
                "n": len(sel),
                "oracle": [round(float(oracle_rows[sel, 0].mean()), 3), round(float(oracle_rows[sel, 1].mean()), 3),
                           int((oracle_rows[sel, 1] > 8).sum())],
                "niho10": [round(float(base_rows[sel, 0].mean()), 3), round(float(base_rows[sel, 1].mean()), 3),
                           int((base_rows[sel, 1] > 8).sum())],
            }
    (args.work / "runs" / "oracle-summary.json").write_text(json.dumps(summary, indent=1))
    print(json.dumps(summary, indent=1))


# ---------------------------------------------------------------- gate

def freeze(bins: dict, coefficients: dict, path: Path) -> str:
    source = path.with_suffix(".coefficients.json")
    source.write_text(json.dumps(coefficients))
    return subprocess.run([str(bins["calibrate"]), "freeze", str(source), str(path)], check=True,
                          capture_output=True, text=True).stdout.strip()


def gate_job(job: dict) -> dict:
    sys.path.insert(0, job["colorcheck"])
    try:
        import cv2

        cv2.setNumThreads(1)
    except ImportError:
        pass
    from colorcheck.compare import run_compare

    probe_dir = Path(job["dir"])
    for name in ("candidate-a-baseline.png", "candidate-b-analytic-hs.png", "manifest.json"):
        (probe_dir / name).unlink(missing_ok=True)
    probe_dir.mkdir(parents=True, exist_ok=True)
    command = ["nice", "-n", "10", job["probe"], job["input"], job["settings"], str(probe_dir)]
    if job.get("manifest"):
        command.append(job["manifest"])
    result = subprocess.run(command, capture_output=True, text=True)
    if result.returncode:
        raise RuntimeError(f"probe failed status={result.returncode}")
    report = json.loads((probe_dir / "manifest.json").read_text())
    row = {"item": job["item"], "fold": job.get("fold"), "coefficientsSha256": report["coefficientsSha256"],
           "baselineEngine": report["baselineEngine"], "analysis": report["analysis"]}
    for side, name in (("A", "candidate-a-baseline.png"), ("B", "candidate-b-analytic-hs.png")):
        if side == "A" and not job["measureA"]:
            continue
        metrics = run_compare(job["reference"], str(probe_dir / name), size=1500, blur=2, do_align=True)
        d = metrics["metrics"]["deltaE00"]
        row[side] = {"mean": d["mean"], "p99": d["p99"], "max": d["max"],
                     "flatFraction": metrics["metrics"]["flatFraction"],
                     "sha256": report["outputs"]["candidate" + side]["sha256"]}
    return row


def gate(args) -> None:
    plan_doc = json.loads((args.work / "plan.json").read_text())
    bins = binaries(args.repo)
    key = fold_key(args.folds)
    cv_dir = args.work / "runs" / f"cv-{args.folds}"
    out = args.work / "gate" / args.family
    out.mkdir(parents=True, exist_ok=True)
    manifests = {}
    for k in sorted({s[key] for s in plan_doc["scenes"]}):
        fitted = json.loads((cv_dir / f"fold{k}.json").read_text())
        manifests[k] = out / f"fold{k}.manifest.json"
        freeze(bins, fitted[args.family], manifests[k])
    all_fit = json.loads((args.work / "runs/all/fit.json").read_text())
    manifests["all"] = out / "all.manifest.json"
    freeze(bins, all_fit[args.family], manifests["all"])
    colorcheck = str(args.repo / "packages/develop-engine/tools/colorcheck")
    jobs = []
    for i, it in enumerate(plan_doc["items"]):
        scene = plan_doc["scenes"][it["scene"]]
        common = {"item": i, "probe": str(bins["probe"]), "input": scene["input"], "colorcheck": colorcheck,
                  "settings": str(args.work / "settings" / f"{it['variant']}.json"),
                  "reference": str(Path(scene["lrExport"]) / f"{scene['scene']}__{it['variant']}.jpg")}
        if it["variant"] == "neutral":
            jobs.append(common | {"dir": str(out / "renders" / f"{i}-neutral"), "measureA": True, "kind": "neutral"})
            continue
        jobs.append(common | {"dir": str(out / "renders" / f"{i}-oof"), "manifest": str(manifests[scene[key]]),
                              "fold": scene[key], "measureA": True, "kind": "oof"})
        jobs.append(common | {"dir": str(out / "renders" / f"{i}-insample"), "manifest": str(manifests["all"]),
                              "fold": "all", "measureA": False, "kind": "insample"})
    rows_path = out / "rows-private.json"
    done = {}
    if rows_path.exists():
        for row in json.loads(rows_path.read_text()):
            done[(row["item"], row["kind"])] = row
    pending = [j for j in jobs if (j["item"], j["kind"]) not in done]
    started = time.monotonic()
    with concurrent.futures.ProcessPoolExecutor(max_workers=args.threads) as pool:
        for n, (job, row) in enumerate(zip(pending, pool.map(gate_job, pending)), 1):
            row["kind"] = job["kind"]
            done[(job["item"], job["kind"])] = row
            if n % 25 == 0 or n == len(pending):
                rows_path.write_text(json.dumps(list(done.values())))
                print(f"{n}/{len(pending)} {time.monotonic() - started:.0f}s", flush=True)
    rows_path.write_text(json.dumps(list(done.values())))
    meta = {"family": args.family, "folds": args.folds,
            "manifests": {str(k): {"sha256": digest(p), "coefficientsSha256": json.loads(p.read_text())["coefficientsSha256"]}
                          for k, p in manifests.items()},
            "probeSha256": digest(bins["probe"]), "calibrateSha256": digest(bins["calibrate"]),
            "seconds": time.monotonic() - started}
    (out / "gate-meta.json").write_text(json.dumps(meta, indent=1))


# ---------------------------------------------------------------- publish

def gate_tables(plan_doc: dict, rows: list[dict]) -> dict:
    by = {(r["item"], r["kind"]): r for r in rows}
    items = plan_doc["items"]

    def pick(i, which):
        it = items[i]
        if it["variant"] == "neutral":
            r = by[(i, "neutral")]["A"]
            return r
        if which == "A":
            return by[(i, "oof")]["A"]
        if which == "B":
            return by[(i, "oof")]["B"]
        return by[(i, "insample")]["B"]

    def stats(idx, which):
        vals = [pick(i, which) for i in idx]
        if not vals:
            return None
        p99 = np.array([v["p99"] for v in vals])
        mean = np.array([v["mean"] for v in vals])
        return {"n": len(vals), "mean": round(float(mean.mean()), 4), "p99Mean": round(float(p99.mean()), 4),
                "p99Max": round(float(p99.max()), 4), "p99Over8": int((p99 > 8).sum())}

    def paired(idx, which):
        if not idx:
            return None
        a = [pick(i, "A") for i in idx]
        b = [pick(i, which) for i in idx]
        dm = np.array([y["mean"] - x["mean"] for x, y in zip(a, b)])
        dp = np.array([y["p99"] - x["p99"] for x, y in zip(a, b)])
        return {"meanWorse": int((dm > 0).sum()), "p99Worse": int((dp > 0).sum()),
                "meanWorseBy0.5": int((dm > 0.5).sum()), "p99WorseBy2": int((dp >= 2).sum()),
                "maxMeanIncrease": round(float(dm.max()), 4), "maxP99Increase": round(float(dp.max()), 4),
                "meanDelta": round(float(dm.mean()), 4)}

    tables = {}
    for subset in ("all",) + SUBSETS:
        per_variant = {}
        for v in VARIANTS:
            idx = [i for i, it in enumerate(items) if it["variant"] == v
                   and (subset == "all" or plan_doc["scenes"][it["scene"]]["subset"] == subset)]
            entry = {"niho10": stats(idx, "A")}
            if v != "neutral":
                entry |= {"candidateOutOfFold": stats(idx, "B"), "candidateInSample": stats(idx, "I"),
                          "pairedOutOfFold": paired(idx, "B"), "pairedInSample": paired(idx, "I")}
            per_variant[v] = entry
        preset_idx = [i for i, it in enumerate(items) if it["variant"] in PRESETS
                      and (subset == "all" or plan_doc["scenes"][it["scene"]]["subset"] == subset)]
        per_variant["presetsTotal"] = {"niho10": stats(preset_idx, "A"), "candidateOutOfFold": stats(preset_idx, "B"),
                                       "candidateInSample": stats(preset_idx, "I"),
                                       "pairedOutOfFold": paired(preset_idx, "B")}
        tables[subset] = per_variant
    return tables


def surrogate_tables(plan_doc: dict, cv_dir: Path) -> dict:
    doc = json.loads((cv_dir / "oof-surrogate.json").read_text())
    base = np.asarray(doc["baseline"])
    out = {"niho10": surrogate_summary(plan_doc, base, base)}
    for name in ("B0", "B1", "B2"):
        out[name] = surrogate_summary(plan_doc, np.asarray(doc[name]), base)
    return out


def gate_verdict(table: dict, which: str) -> dict:
    neutral = table["neutral"]["niho10"]
    presets = {v: table[v][which] for v in PRESETS}
    total = table["presetsTotal"][which]
    return {
        "neutralMean<=2": neutral["mean"] <= 2.0,
        "presetMean<=3": all(p["mean"] <= 3.0 for p in presets.values()),
        "presetP99<=8 (every scene)": total["p99Over8"] == 0,
        "presetP99>8 share<=15% (JPEG gate)": total["p99Over8"] <= 0.15 * total["n"],
    }


def require_holdout_subset_counts(scenes: list[dict], minimum: int) -> dict[str, int]:
    if not isinstance(minimum, int) or isinstance(minimum, bool) or minimum < 1:
        raise SystemExit("the frozen holdout minimum per subset is invalid")
    counts = {subset: sum(scene["subset"] == subset for scene in scenes) for subset in SUBSETS}
    if any(count < minimum for count in counts.values()):
        raise SystemExit(f"independent holdout requires at least {minimum} non-blank scenes in every subset")
    return counts


def holdout_verdicts(tables: dict) -> dict:
    return {
        "all": gate_verdict(tables["all"], "candidateOutOfFold"),
        "bySubset": {subset: gate_verdict(tables[subset], "candidateOutOfFold") for subset in SUBSETS},
    }


def publish(args) -> None:
    plan_doc = json.loads((args.work / "plan.json").read_text())
    out = args.work / "gate" / args.family
    rows = json.loads((out / "rows-private.json").read_text())
    meta = json.loads((out / "gate-meta.json").read_text())
    tables = gate_tables(plan_doc, rows)
    cv_dir = args.work / "runs" / f"cv-{meta['folds']}"
    key = fold_key(meta["folds"])
    folds = sorted({s[key] for s in plan_doc["scenes"]})
    fold_info = []
    for k in folds:
        fitted = json.loads((cv_dir / f"fold{k}.json").read_text())
        held = [s for s in plan_doc["scenes"] if s[key] == k]
        fold_info.append({"fold": k, "heldScenes": len(held),
                          "heldSubsets": {x: sum(s["subset"] == x for s in held) for x in SUBSETS},
                          "coefficients": fitted[args.family],
                          "coefficientsSha256": meta["manifests"][str(k)]["coefficientsSha256"],
                          "trace": fitted["trace"], "seconds": round(fitted.get("seconds", 0.0), 1)})
    all_fit = json.loads((args.work / "runs/all/fit.json").read_text())
    commit = subprocess.check_output(["git", "-C", str(args.repo), "rev-parse", "HEAD"], text=True).strip()
    result = {
        "kind": "development-teachers-not-independent",
        "issue": 26,
        "family": args.family,
        "sourceCommit": commit,
        "executables": {"analyticHsProbeSha256": meta["probeSha256"],
                        "analyticHsCalibrateSha256": meta["calibrateSha256"]},
        "manifestSha256": list(plan_doc["manifestSha256"].values()),
        "cohortCounts": {c: sum(s["cohort"] == c for s in plan_doc["scenes"]) for c in COHORTS},
        "subsetCounts": {x: sum(s["subset"] == x for s in plan_doc["scenes"]) for x in SUBSETS},
        "subsetDefinition": {
            "dark": "teacher band dark (ISO > 640): night and dark interiors",
            "brightIphone": "iPhone with band bright (ISO <= 100)",
            "daylight": "every other scene (camera bright/mid, iPhone mid)",
        },
        "blankExcluded": plan_doc["blankExcluded"],
        "independentImagesRead": 0,
        "folds": {"kind": meta["folds"], "rule": "sorted capture dates d, fold k holds d[k::5]",
                  "count": len(folds), "perFold": fold_info},
        "objective": {"surrogate": "H/S gains 1024px, downstream and CIEDE2000 at 512px, blur 2*edge/1500, 8000 flat reference pixels",
                      "loss": f"mean + {P99_WEIGHT}*p99 + {TAIL_WEIGHT}*max(p99-{TAIL_START},0)^2 + {GUARD_WEIGHT}*max(mean-niho10-{GUARD_MARGIN},0) on non-dark scenes",
                      "weights": {"preset": PRESET_WEIGHT, "single": 1.0, "combination": 1.0},
                      "start": "per fold: least squares of the per-photo constants (oracle) of the fold's training photos on their statistic",
                      "stages": ["per-photo constants (oracle) of the training photos -> start",
                                 "highlights on h30/h60/h100", "shadows on s30/s60/s100",
                                 "joint on every H/S variant", "bounded residual (B2) with the formula fixed"]},
        "protocol": {"renderLongEdge": 2048, "compareLongEdge": 1500, "blur": 2, "flatPixels": True,
                     "alignment": True, "baseline": "niho-10 (same H/S as niho-6; its response was trained on these teachers, so its numbers are in-sample)",
                     "settings": "new niho-10 edit; presets through xmp::apply_preset at amount 1"},
        "selection": json.loads((cv_dir / "selection.json").read_text()),
        "surrogateOutOfFold": surrogate_tables(plan_doc, cv_dir),
        "oracleSurrogate": {
            "meaning": "per photo constant gain scale, shift and chroma alpha fitted on that photo's own single H or S items (in-sample upper bound of the operator); [mean, p99Mean, p99>8]",
            "summary": json.loads((args.work / "runs" / "oracle-summary.json").read_text()),
        },
        "allDataCoefficients": all_fit[args.family],
        "allDataCoefficientsSha256": meta["manifests"]["all"]["coefficientsSha256"],
        "tables": tables,
        "verdict": {"outOfFold": gate_verdict(tables["all"], "candidateOutOfFold"),
                    "inSample": gate_verdict(tables["all"], "candidateInSample"),
                    "niho10": gate_verdict(tables["all"], "niho10")},
    }
    args.out.write_text(json.dumps(result, indent=2, ensure_ascii=False) + "\n")
    print(json.dumps(result["verdict"], indent=1))


# ---------------------------------------------------------------- holdout

def holdout(args) -> None:
    """The one independent evaluation of a frozen candidate (owner's new
    night / dark-interior / bright-iPhone photos). Refuses to run twice, or
    when the source, tool, executables or coefficients differ from the freeze."""
    sys.path.insert(0, str(args.repo / "packages/develop-engine/tools/calibrate"))
    from fit_niho6_response import blank_input

    record = json.loads(args.freeze.read_text())
    marker = args.work / "holdout-started.json"
    if marker.exists():
        raise SystemExit("the independent evaluation already ran; a new candidate needs a new holdout")
    source = record["sourceCommit"]
    executable_build = record["executableBuildCommit"]
    source_changed = subprocess.run(["git", "-C", str(args.repo), "diff", "--quiet", source, "--",
                                     "packages/develop-engine/tools/colorcheck/colorcheck"])
    build_changed = subprocess.run(["git", "-C", str(args.repo), "diff", "--quiet", executable_build, source, "--",
                                    "packages/develop-engine/crates", "packages/develop-engine/Cargo.lock"])
    if source_changed.returncode or build_changed.returncode:
        raise SystemExit("frozen renderer, colorcheck or build sources differ")
    bins = binaries(args.repo)
    probe = args.probe or bins["probe"]
    calibrate = args.calibrate or bins["calibrate"]
    validate_frozen_executables(record, probe, calibrate)
    validate_frozen_tool(record, args.repo / "packages/develop-engine/tools/calibrate/fit_analytic_hs.py")
    manifest = args.freeze.parent / record["candidateManifest"]["path"]
    if digest(manifest) != record["candidateManifest"]["sha256"] or \
            json.loads(manifest.read_text())["coefficientsSha256"] != record["candidateManifest"]["coefficientsSha256"]:
        raise SystemExit("candidate manifest differs from the freeze record")
    cohort = args.cohort.resolve()
    meta = json.loads((cohort / "manifest.json").read_text())
    required = ("neutral",) + PRESETS
    missing = [f"{scene['scene']}__{v}" for scene in meta["scenes"] for v in required
               if not (cohort / "lr-export" / f"{scene['scene']}__{v}.jpg").exists()
               or not (cohort / "inputs" / f"{scene['scene']}__neutral.jpg").exists()]
    if missing:
        raise SystemExit(f"{len(missing)} required inputs / exports are missing (neutral and the 3 presets)")
    scenes, skipped = [], 0
    for scene in meta["scenes"]:
        source_path = cohort / "inputs" / f"{scene['scene']}__neutral.jpg"
        if blank_input(source_path):
            skipped += 1
            continue
        scenes.append({"scene": scene["scene"], "subset": subset_of(scene), "input": str(source_path),
                       "lrExport": str(cohort / "lr-export")})
    minimum = record["evaluationManifest"]["selection"]["minimumScenesPerSubset"]
    subset_counts = require_holdout_subset_counts(scenes, minimum)
    settings_dir = args.work / "holdout-settings"
    subprocess.run([str(calibrate), "settings", str(settings_dir)], check=True)
    args.work.mkdir(parents=True, exist_ok=True)
    marker.write_text(json.dumps({"startedAt": time.strftime("%Y-%m-%dT%H:%M:%S%z"),
                                  "freezeSha256": digest(args.freeze)}))
    items = [{"scene": i, "variant": v} for i, s in enumerate(scenes) for v in VARIANTS
             if (Path(s["lrExport"]) / f"{s['scene']}__{v}.jpg").exists()]
    colorcheck = str(args.repo / "packages/develop-engine/tools/colorcheck")
    out = args.work / "holdout"
    jobs = []
    for i, it in enumerate(items):
        scene = scenes[it["scene"]]
        job = {"item": i, "probe": str(probe), "input": scene["input"], "colorcheck": colorcheck,
               "settings": str(settings_dir / f"{it['variant']}.json"), "measureA": True,
               "reference": str(Path(scene["lrExport"]) / f"{scene['scene']}__{it['variant']}.jpg"),
               "dir": str(out / "renders" / str(i))}
        if it["variant"] != "neutral":
            job["manifest"] = str(manifest)
        jobs.append(job)
    with concurrent.futures.ProcessPoolExecutor(max_workers=args.threads) as pool:
        measured = list(pool.map(gate_job, jobs))
    rows = []
    for row, it in zip(measured, items):
        if it["variant"] == "neutral":
            rows.append(dict(row, kind="neutral"))
        else:
            # One frozen candidate: the held-out and "in-sample" columns are the same rows.
            rows.extend([dict(row, kind="oof"), dict(row, kind="insample")])
    (out / "rows-private.json").write_text(json.dumps(rows))
    tables = gate_tables({"scenes": scenes, "items": items}, rows)
    result = {"kind": "independent-holdout", "issue": 26, "freezeSha256": digest(args.freeze),
              "sourceCommit": source, "coefficientsSha256": record["candidateManifest"]["coefficientsSha256"],
              "scenes": len(scenes), "blankExcluded": skipped,
              "subsetCounts": subset_counts, "tables": tables, "verdict": holdout_verdicts(tables)}
    (out / "holdout-summary-sanitized.json").write_text(json.dumps(result, indent=2) + "\n")
    print(json.dumps(result["verdict"], indent=1))


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--repo", required=True, type=Path)
    ap.add_argument("--work", required=True, type=Path)
    ap.add_argument("--threads", type=int, default=4)
    sub = ap.add_subparsers(dest="command", required=True)
    sub.add_parser("plan")
    p = sub.add_parser("oracle")
    p.add_argument("--fev", type=int, default=60)
    for name in ("cv", "fit"):
        p = sub.add_parser(name)
        p.add_argument("--folds", choices=("dates", "models"), default="dates")
        p.add_argument("--stage-fev", type=int, default=120)
        p.add_argument("--joint-fev", type=int, default=120)
        p.add_argument("--residual-fev", type=int, default=80)
    p = sub.add_parser("gate")
    p.add_argument("--family", choices=("B1", "B2"), required=True)
    p.add_argument("--folds", choices=("dates", "models"), default="dates")
    p = sub.add_parser("holdout")
    p.add_argument("--cohort", required=True, type=Path)
    p.add_argument("--freeze", required=True, type=Path)
    p.add_argument("--calibrate", type=Path)
    p.add_argument("--probe", type=Path)
    p = sub.add_parser("publish")
    p.add_argument("--family", choices=("B1", "B2"), required=True)
    p.add_argument("--out", required=True, type=Path)
    args = ap.parse_args()
    guard_work(args.repo, args.work)
    {"plan": plan, "cv": cv, "fit": fit_all, "oracle": oracle, "gate": gate, "publish": publish,
     "holdout": holdout}[args.command](args)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
