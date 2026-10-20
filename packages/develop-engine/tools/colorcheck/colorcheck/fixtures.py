"""Numbers-only fixtures: ``colorcheck fixture write`` / ``fixture check``.

A fixture freezes the numbers of a set of result JSONs (compare / preset /
chart) so that a later run on the same inputs can be checked for drift:
the mean ΔE00 of every key must stay within a tolerance (default 0.2, both
directions: an improvement also means the fixture is out of date) and no gate
may get worse.  No image paths or pixels are stored; keys are the compare
label, ``<preset>/<scene>`` for preset items, ``preset:<name>`` for the preset
summaries and the chart label.
"""
from __future__ import annotations

import json
import os
from collections import Counter

from . import __version__
from . import gates as G
from .util import now_iso

SCHEMA = "colorcheck/fixture/v2"
CHECK_SCHEMA = "colorcheck/fixture-check/v1"
STATUS_RANK = {"pass": 0, "warn": 1, "incomplete": 2, "not-evaluated": 2, "missing": 2, "fail": 3}
META_KEYS = ("camera", "decoderVersion", "baseVersion")


def _stem(path) -> str | None:
    return os.path.splitext(os.path.basename(path))[0] if path else None


def _num(d: dict | None, *keys) -> dict:
    d = d or {}
    return {k: d.get(k) for k in keys}


def _compare_key(r: dict) -> str:
    if r.get("label"):
        return str(r["label"])
    kind = r.get("comparison") or "compare"
    return f"{kind}/{r.get('scene') or _stem((r.get('candidate') or {}).get('path')) or 'item'}"


def _chart_key(r: dict) -> str:
    if r.get("label"):
        return str(r["label"])
    return f"chart/{r.get('illuminant') or '-'}/{_stem((r.get('image') or {}).get('path')) or 'image'}"


def _compare_entry(r: dict, key: str, kind: str) -> dict:
    m = r.get("metrics") or {}
    e = {"key": key, "kind": kind, "comparison": r.get("comparison"), "scene": r.get("scene"), "preset": r.get("preset"),
         "deltaE00": _num(m.get("deltaE00"), "mean", "p99"),
         "deltaE00Unblurred": _num(m.get("deltaE00Unblurred"), "mean", "p99"),
         "evDiff": m.get("evDiff"), "saturationRatio": m.get("saturationRatio")}
    if m.get("deltaE00All"):
        e["deltaE00All"] = _num(m.get("deltaE00All"), "mean", "p99")
    if m.get("flatFraction") is not None:
        e["flatFraction"] = m.get("flatFraction")
    w = m.get("white") or {}
    if w:
        e["white"] = {k: _num(w.get(k), "a", "b") for k in ("reference", "candidate")}
    n = r.get("normalized") or {}
    if n:
        e["normalized"] = {"method": n.get("method"), "deltaE00": _num(n.get("deltaE00"), "mean", "p99"),
                           "evOffset": n.get("evOffset"), "gain": n.get("gain")}
    al = r.get("alignment") or {}
    if al:
        e["alignment"] = _num(al, "scale", "corr")
        if al.get("radial"):
            e["alignment"]["radialK"] = (al.get("radial") or {}).get("k")
    if r.get("analysisSize"):
        e["analysisSize"] = r.get("analysisSize")
    return e


def _chart_entry(r: dict, key: str) -> dict:
    s = r.get("summary") or {}
    prim = s.get("primary") or "raw"
    pv = s.get(prim) or {}
    patches = sorted(r.get("patches") or [], key=lambda p: p.get("index", 0))
    return {"key": key, "kind": "chart", "illuminant": r.get("illuminant"), "primary": prim,
            "deltaE00": _num(pv, "mean", "p95", "max"),
            "raw": _num(s.get("raw"), "mean", "p95", "max"),
            "grayBalanced": _num(s.get("grayBalanced"), "mean", "p95", "max"),
            "patchesDeltaE00": {"raw": [p.get("deltaE00_raw") for p in patches],
                                "grayBalanced": [p.get("deltaE00_grayBalanced") for p in patches]},
            "exposureEV": (r.get("exposure") or {}).get("ev"),
            "grayBalanceGains": (r.get("grayBalance") or {}).get("gainsRelative"),
            "detection": (r.get("detection") or {}).get("method")}


def _freeze(v):
    return json.dumps(v, sort_keys=True, ensure_ascii=False)


def _empty(v) -> bool:
    return v is None or v == "" or (isinstance(v, dict) and not any(x not in (None, "") for x in v.values()))


def _mode(values):
    vals = [_freeze(v) for v in values if not _empty(v)]
    if not vals:
        return None
    return json.loads(Counter(vals).most_common(1)[0][0])


def _entries(results: list):
    """[(entry, source result, labeled copy for the gates)], skipped schemas."""
    out, skipped = [], []
    for r in results:
        schema = (r or {}).get("schema", "") if isinstance(r, dict) else ""
        if schema.startswith("colorcheck/compare/"):
            key = _compare_key(r)
            out.append((_compare_entry(r, key, "compare"), r, dict(r, label=key)))
        elif schema.startswith("colorcheck/preset/"):
            for it in r.get("items") or []:
                key = it.get("label") or f"{it.get('preset')}/{it.get('scene')}"
                out.append((_compare_entry(it, key, "preset"), it, None))
            for p in r.get("presets") or []:
                e = {"key": f"preset:{p.get('preset')}", "kind": "preset-summary", "preset": p.get("preset"),
                     "scenes": p.get("scenes"), "deltaE00": {"mean": p.get("deltaE00Mean"), "p99": p.get("deltaE00P99")},
                     "worstScene": p.get("worstScene"), "evDiff": p.get("evDiff"),
                     "saturationRatio": p.get("saturationRatio")}
                out.append((e, r, None))
            out.append((None, r, r))  # the preset result itself only feeds the gates
        elif schema.startswith("colorcheck/chart/"):
            key = _chart_key(r)
            out.append((_chart_entry(r, key), r, dict(r, label=key)))
        else:
            skipped.append(schema or type(r).__name__)
    return out, skipped


def build(results: list) -> dict:
    """Fixture JSON (numbers only) for compare / preset / chart results."""
    rows, skipped = _entries(list(results))
    meta = {k: _mode([(src or {}).get(k) for e, src, _ in rows if e is not None]) for k in META_KEYS}
    entries, seen = [], Counter()
    for e, src, _ in rows:
        if e is None:
            continue
        base = e["key"]
        seen[base] += 1
        if seen[base] > 1:
            e["key"] = f"{base}#{seen[base]}"
        for k in META_KEYS:
            v = (src or {}).get(k)
            if not _empty(v) and _freeze(v) != _freeze(meta[k]):
                e[k] = v
        entries.append(e)
    labeled = [g for _e, _s, g in rows if g is not None]
    counts = Counter(e["kind"] for e in entries)
    data = {
        "schema": SCHEMA,
        "createdAt": now_iso(),
        "tool": {"name": "colorcheck", "version": __version__},
        "camera": meta["camera"],
        "decoderVersion": meta["decoderVersion"],
        "baseVersion": meta["baseVersion"],
        "counts": dict(sorted(counts.items())),
        "entries": entries,
        "gates": G.evaluate(labeled),
    }
    if skipped:
        data["skipped"] = skipped
    # Persist descriptive labels under a descriptive field name. Generic secret
    # scanners otherwise treat the old JSON `key` field as an API credential.
    def labels(value):
        if isinstance(value, dict):
            return {("label" if name == "key" else name): labels(item) for name, item in value.items()}
        if isinstance(value, list):
            return [labels(item) for item in value]
        return value

    return labels(data)


def _mean(e: dict | None):
    return ((e or {}).get("deltaE00") or {}).get("mean")


def _gate_rows(fixture_gates: dict, current_gates: dict, allow_missing: bool) -> dict:
    fg = {g.get("id"): g for g in (fixture_gates or {}).get("gates", [])}
    cg = {g.get("id"): g for g in (current_gates or {}).get("gates", [])}
    ids = list(fg) + [i for i in cg if i not in fg]
    rows = []

    def worse(fs, cs):
        if allow_missing and cs in ("not-evaluated", "incomplete"):
            return False
        return STATUS_RANK.get(cs, 2) > STATUS_RANK.get(fs, 2)

    for gid in ids:
        fs = (fg.get(gid) or {}).get("status", "not-evaluated")
        cs = (cg.get(gid) or {}).get("status", "not-evaluated")
        rows.append({"id": gid, "fixture": fs, "current": cs, "ok": not worse(fs, cs)})
    fo = (fixture_gates or {}).get("overall", "not-evaluated")
    co = (current_gates or {}).get("overall", "not-evaluated")
    overall_ok = not worse(fo, co)
    return {"ok": overall_ok and all(r["ok"] for r in rows), "fixtureOverall": fo, "currentOverall": co,
            "rows": rows}


def check(fixture: dict, results: list, tolerance: float = 0.2, allow_missing: bool = False) -> dict:
    """Compare results with a fixture: same-key mean ΔE00 within ±tolerance and no gate worse."""
    if (fixture or {}).get("schema") != SCHEMA:
        raise ValueError(f"fixture の schema が {SCHEMA!r} でない: {(fixture or {}).get('schema')!r}")
    cur = build(results)
    fx = {e["label"]: e for e in fixture.get("entries", [])}
    cu = {e["label"]: e for e in cur["entries"]}
    compared = []
    for key, fe in fx.items():
        if key not in cu:
            continue
        fm, cm = _mean(fe), _mean(cu[key])
        if fm is None or cm is None:
            diff, ok = None, fm is None and cm is None
        else:
            diff = round(cm - fm, 4)
            ok = abs(diff) <= tolerance + 1e-9
        compared.append({"key": key, "kind": fe.get("kind"), "fixtureMean": fm, "currentMean": cm, "diff": diff,
                         "ok": ok})
    missing = [k for k in fx if k not in cu]
    extra = [k for k in cu if k not in fx]
    gates = _gate_rows(fixture.get("gates") or {}, cur["gates"], allow_missing)
    ok = all(c["ok"] for c in compared) and (allow_missing or not missing) and gates["ok"]
    return {
        "schema": CHECK_SCHEMA,
        "ok": bool(ok),
        "tolerance": tolerance,
        "allowMissing": bool(allow_missing),
        "compared": compared,
        "missing": missing,
        "extra": extra,
        "gates": gates,
        "fixture": {k: fixture.get(k) for k in ("createdAt", "camera", "decoderVersion", "baseVersion")},
        "current": {k: cur.get(k) for k in ("camera", "decoderVersion", "baseVersion")},
        "createdAt": now_iso(),
    }


def _f(v, nd=3, signed=False) -> str:
    if v is None:
        return "—"
    v = round(float(v), nd) + 0.0  # no "-0.000"
    return f"{v:+.{nd}f}" if signed else f"{v:.{nd}f}"


def check_markdown(report: dict) -> str:
    """Human-readable table of a check() report."""
    comp = report.get("compared", [])
    ng = [c for c in comp if not c["ok"]]
    miss, extra = report.get("missing", []), report.get("extra", [])
    g = report.get("gates") or {}
    lines = [f"## fixture の照合: {'OK' if report.get('ok') else 'NG'}", "",
             f"- 許容差: mean ΔE00 ±{report.get('tolerance')}（改善も差として数える。数値を更新したら fixture を書き直す）",
             f"- 照合した key: {len(comp)}（NG {len(ng)}）・fixture にだけある: {len(miss)}"
             f"{'（--allow-missing で許容）' if miss and report.get('allowMissing') else ''}・結果にだけある: {len(extra)}",
             f"- gate: fixture {g.get('fixtureOverall')} → 現在 {g.get('currentOverall')}"
             f"（{'悪化なし' if g.get('ok') else '悪化あり'}）", ""]
    if comp:
        lines += ["| key | 種類 | fixture mean | 現在 mean | 差 | 判定 |", "|---|---|---:|---:|---:|---|"]
        for c in sorted(comp, key=lambda c: (c["ok"], c["key"])):
            lines.append(f"| {c['key']} | {c.get('kind') or '—'} | {_f(c['fixtureMean'])} | {_f(c['currentMean'])} | "
                         f"{_f(c['diff'], 3, True)} | {'OK' if c['ok'] else '**NG**'} |")
        lines.append("")
    if miss:
        lines += ["fixture にだけある key（結果が無い）: " + ", ".join(f"`{k}`" for k in miss), ""]
    if extra:
        lines += ["結果にだけある key（fixture に無い。判定には使わない）: " + ", ".join(f"`{k}`" for k in extra), ""]
    if g.get("rows"):
        lines += ["| gate | fixture | 現在 | 判定 |", "|---|---|---|---|"]
        for r in g["rows"]:
            lines.append(f"| `{r['id']}` | {r['fixture']} | {r['current']} | {'OK' if r['ok'] else '**悪化**'} |")
        lines.append("")
    return "\n".join(lines)
