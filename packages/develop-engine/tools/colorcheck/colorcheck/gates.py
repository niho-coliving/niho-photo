"""S9 gates: definitions and evaluation over result JSONs.

Stage 1 (base / look is close enough to ship the preset path)
  stage1.preset       preset closeness: ΔE00 mean <= 3.0 and p99 <= 8.0, all of
                      bluesky2 / pastel / colorful (mean = mean of scene means,
                      p99 = max of scene p99)
  stage1.cameraJpeg   vs camera JPEG: mean <= 4.0 (guideline -> warn, not fail)
  stage1.versionDrift across decoderVersion / baseVersion: mean <= 0.5
Stage 2 (colorimetric accuracy)
  stage2.referenceNeutral  per camera, vs the Lightroom Adobe Standard neutral export: mean <= 2.0
                      (mean of scene means, per camera x path: base = calibrated reference rendering,
                      crate-base = stage 2 crate). The stage 2 gate until a chart is shot (owner 2026-09-29)
  stage2.chart        ColorChecker ΔE00 mean <= 2.0 and max <= 5.0, for 2 illuminants
  stage2.crossCamera  between cameras: mean <= 2.0

All ΔE00 values are the blurred (main) numbers.
"""
from __future__ import annotations

from dataclasses import dataclass

REQUIRED_PRESETS = ("bluesky2", "pastel", "colorful")
MIN_ILLUMINANTS = 2


@dataclass(frozen=True)
class Gate:
    id: str
    stage: int
    label: str
    applies_to: str
    thresholds: dict
    blocking: bool
    note: str


GATES = (
    Gate("stage1.preset", 1, "プリセットの近さ（bluesky2・pastel・colorful の 3 本とも）", "preset",
         {"mean": 3.0, "p99": 8.0}, True, "mean = 場面ごとの mean の平均、p99 = 場面ごとの p99 の最大"),
    Gate("stage1.cameraJpeg", 1, "カメラ JPEG との差（目安）", "compare:camera-jpeg",
         {"mean": 4.0}, False, "目安。超えたら warn（不合格にはしない）"),
    Gate("stage1.versionDrift", 1, "decoderVersion・baseVersion またぎの差", "compare:version",
         {"mean": 0.5}, True, "新旧の NIHO 出力どうしを compare --kind version で比べた mean"),
    Gate("stage2.referenceNeutral", 2, "カメラごとの Lightroom Adobe Standard 中立との差（チャートが来るまでの段階 2）",
         "compare:reference", {"mean": 2.0}, True,
         "カメラ × 経路（base = 土台の参照レンダリング、crate-base = 段 2 の crate）ごとに場面 mean の平均。補正前（base-uncal）は除く"),
    Gate("stage2.chart", 2, "チャート ΔE00（光源 2 つとも）", "chart",
         {"mean": 2.0, "max": 5.0}, True, "chart の primary 値（--gray-balance 指定時は白合わせ後）"),
    Gate("stage2.crossCamera", 2, "カメラ間の差", "compare:cross-camera",
         {"mean": 2.0}, True, "同じ場面の別カメラの NIHO 出力どうしを compare --kind cross-camera で比べた mean"),
)
GATES_BY_ID = {g.id: g for g in GATES}


def _ok(value, limit) -> bool:
    return value is not None and value <= limit


def _collect(results):
    compares, presets, charts = [], [], []
    for r in results:
        schema = (r or {}).get("schema", "")
        if schema.startswith("colorcheck/compare/"):
            compares.append(r)
        elif schema.startswith("colorcheck/preset/"):
            if r.get("gateExcluded") is not True:
                presets.append(r)
        elif schema.startswith("colorcheck/chart/"):
            charts.append(r)
    return compares, presets, charts


def _compare_gate(g: Gate, compares, kind: str, fail_status: str) -> dict:
    rows = []
    for r in compares:
        if r.get("comparison") != kind:
            continue
        mean = r["metrics"]["deltaE00"]["mean"]
        st = "pass" if _ok(mean, g.thresholds["mean"]) else fail_status
        rows.append({"key": r.get("label") or r["candidate"].get("path"), "mean": mean, "status": st})
    if not rows:
        return {"status": "not-evaluated", "details": [], "summary": f"--kind {kind} の compare 結果が無い"}
    status = fail_status if any(x["status"] != "pass" for x in rows) else "pass"
    worst = max(rows, key=lambda x: x["mean"] if x["mean"] is not None else float("inf"))
    return {"status": status, "details": rows,
            "summary": f"{len(rows)} 件・最大 mean {worst['mean']}（基準 ≤ {g.thresholds['mean']}）"}


def _reference_gate(g: Gate, compares) -> dict:
    groups: dict = {}
    for r in compares:
        label = r.get("label") or ""
        if r.get("comparison") != "reference" or label.startswith("base-uncal"):
            continue
        cam = r.get("camera") or {}
        key = f"{cam.get('make', '?')} {cam.get('model', '?')} / {label.split('/')[0] if '/' in label else 'reference'}"
        groups.setdefault(key, []).append(r["metrics"]["deltaE00"]["mean"])
    if not groups:
        return {"status": "not-evaluated", "details": [], "summary": "--kind reference の compare 結果が無い"}
    rows = []
    for key, means in groups.items():
        mean = round(sum(means) / len(means), 4)
        rows.append({"key": key, "scenes": len(means), "mean": mean, "max": round(max(means), 4),
                     "status": "pass" if _ok(mean, g.thresholds["mean"]) else "fail"})
    status = "fail" if any(x["status"] == "fail" for x in rows) else "pass"
    return {"status": status, "details": rows,
            "summary": "; ".join(f"{x['key']} {x['scenes']} 場面 mean {x['mean']} {x['status']}" for x in rows)}


def _preset_gate(g: Gate, presets) -> dict:
    summaries = {}
    for r in presets:
        for p in r.get("presets", []):
            summaries[p["preset"]] = p  # later runs win
    if not summaries:
        return {"status": "not-evaluated", "details": [], "summary": "preset 結果が無い"}
    rows = []
    for name, p in summaries.items():
        ok = _ok(p.get("deltaE00Mean"), g.thresholds["mean"]) and _ok(p.get("deltaE00P99"), g.thresholds["p99"])
        rows.append({"preset": name, "mean": p.get("deltaE00Mean"), "p99": p.get("deltaE00P99"),
                     "required": name in REQUIRED_PRESETS, "status": "pass" if ok else "fail"})
    missing = [n for n in REQUIRED_PRESETS if n not in summaries]
    for n in missing:
        rows.append({"preset": n, "mean": None, "p99": None, "required": True, "status": "missing"})
    if any(x["required"] and x["status"] == "fail" for x in rows):
        status = "fail"
    elif missing:
        status = "incomplete"
    else:
        status = "pass"
    parts = [f"{x['preset']} {x['mean']}/{x['p99']} {x['status']}" for x in rows]
    return {"status": status, "details": rows, "summary": "; ".join(parts)}


def _chart_gate(g: Gate, charts) -> dict:
    if not charts:
        return {"status": "not-evaluated", "details": [], "summary": "chart 結果が無い"}
    rows = []
    for r in charts:
        prim = r["summary"]["primary"]
        vals = r["summary"][prim]
        ok = _ok(vals.get("mean"), g.thresholds["mean"]) and _ok(vals.get("max"), g.thresholds["max"])
        rows.append({"illuminant": r.get("illuminant"), "key": r.get("label") or r["image"]["path"],
                     "primary": prim, "mean": vals.get("mean"), "max": vals.get("max"),
                     "status": "pass" if ok else "fail"})
    ills = sorted({x["illuminant"] for x in rows if x["illuminant"]})
    if any(x["status"] == "fail" for x in rows):
        status = "fail"
    elif len(ills) < MIN_ILLUMINANTS:
        status = "incomplete"
    else:
        status = "pass"
    return {"status": status, "details": rows,
            "summary": f"光源 {len(ills)} 種（{', '.join(ills) or '—'}）・{len(rows)} 枚"}


def evaluate(results: list) -> dict:
    """Evaluate every gate that has applicable results."""
    compares, presets, charts = _collect(results)
    out = []
    for g in GATES:
        if g.id == "stage1.preset":
            r = _preset_gate(g, presets)
        elif g.id == "stage1.cameraJpeg":
            r = _compare_gate(g, compares, "camera-jpeg", "warn")
        elif g.id == "stage1.versionDrift":
            r = _compare_gate(g, compares, "version", "fail")
        elif g.id == "stage2.referenceNeutral":
            r = _reference_gate(g, compares)
        elif g.id == "stage2.chart":
            r = _chart_gate(g, charts)
        elif g.id == "stage2.crossCamera":
            r = _compare_gate(g, compares, "cross-camera", "fail")
        else:  # pragma: no cover
            continue
        out.append(dict(id=g.id, stage=g.stage, label=g.label, blocking=g.blocking, thresholds=g.thresholds, **r))
    statuses = [x["status"] for x in out]
    if any(x["status"] == "fail" and x["blocking"] for x in out):
        overall = "fail"
    elif "incomplete" in statuses:
        overall = "incomplete"
    elif any(s in ("pass", "warn") for s in statuses):
        overall = "pass"
    else:
        overall = "not-evaluated"
    return {"overall": overall, "gates": out}


def table_markdown() -> str:
    lines = ["| id | 段階 | 内容 | 基準 | 扱い | 補足 |", "|---|---:|---|---|---|---|"]
    for g in GATES:
        th = "・".join(f"{k} ≤ {v}" for k, v in g.thresholds.items())
        lines.append(f"| `{g.id}` | {g.stage} | {g.label} | {th} | {'不合格で止める' if g.blocking else '目安（warn）'} | {g.note} |")
    return "\n".join(lines) + "\n"
