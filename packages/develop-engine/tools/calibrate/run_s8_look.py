#!/usr/bin/env python3
"""NIHO 標準ルック（S8 #16947）の当てはめと計測を一括で回す（再現用）。

  python3 run_s8_look.py <step> [--reg R (default 0.3)] [--sat-node S] [--hue-nodes N] [--jobs 3]
  steps: manifest fit adopt crate-build render measure page all（all = manifest→fit→crate-build→render→measure→page。adopt は含まない）

- 目標（参照）: round7 の `lr-export-color/`（中立とプリセット 3 本を Adobe Color で書き出したもの。`make_lr_round7.py`）
- 候補: `$NIHO_COLOR_WORK_DIR/s8/working-copy{,-nolens}/<scene>.png`（機種別補正済みの作業コピー。参照の LR レンズ補正に
  合わせて選ぶ = colorful だけ補正あり。`refs.lens_on`）
- fit: 毎回 round7 の現行入力から manifest を再生成し、中立の 20 場面（機種ごとに名前順で偶数番 = train・奇数番 = val）に
  `fit_look.py`。入力画像と係数の指紋を `s8/fit/look.json.provenance.json` に保存し、参照が変わった古い係数は adopt しない
- adopt: `s8/fit/look.json` を crate の `looks/niho-standard-1.json` に写し、Python と Rust の一致の fixture を書く
- crate-build: この worktree の `packages/develop-engine` を `s8/crate-src/` へ写し（worktree は汚さない）、`s8/fit/look.json`
  （`--look-json`）を crate の `looks/` に置いて計測用ブリッジを組む
- render: 場面 × {中立, bluesky2, pastel, colorful} × {niho-interim-1, niho-standard-1} を crate で描く（長辺 2560・JPEG 97）
- measure: `colorcheck preset` で版ごとに近さを出し、gate `stage1.preset` を判定（`s8/results/<look>.json` / `.md`）
- page: 見比べページ（Lightroom・暫定・標準の 3 列、数値つき）を worktree の `.preview/s8-look.html` と `s8/page/` に書く
"""
from __future__ import annotations

import argparse
import base64
import concurrent.futures as cf
import hashlib
import html
import json
import os
import shutil
import subprocess
import sys
from pathlib import Path

HERE = Path(__file__).resolve().parent
ROOT = HERE.parents[3]
ENGINE = ROOT / "packages" / "develop-engine"
sys.path.insert(0, str(HERE))
import refs  # noqa: E402
import make_lr_round7  # noqa: E402

REF = Path(os.environ.get("NIHO_COLOR_REF_ROOT", "OWNER_DATA_ROOT"))
WK = Path(os.environ.get("NIHO_COLOR_WORK_DIR", "OWNER_DATA_ROOT"))
S8 = WK / "s8"
ROUND = REF / "round7"
EXPORT = ROUND / "lr-export-color"
VARIANTS = ("neutral", "bluesky2", "pastel", "colorful")
LOOKS = ("niho-interim-1", "niho-standard-1")
# #16595「決め方（計測）」4 の見た目の区分（夜の屋外は参照に無いので、夜・電球の室内で代える）
GROUPS = {
    "肌": ["P1581387", "P1570923", "P1570755", "DSC09188"],
    "空": ["P1570133", "P1570258", "P1570266", "P1570280"],
    "緑": ["P1570135", "P1570302", "P1570396", "P1570586", "P1013207"],
    "夜・電球の室内": ["DSC01835", "DSC01837", "DSC09206", "P1012822"],
    "昼の室内": ["DSC09207", "DSC09208", "P1013558"],
}
BRIDGE_PRESET = {"neutral": "neutral", "bluesky2": "niho-bluesky2", "pastel": "niho-pastel", "colorful": "niho-colorful"}
CC = [sys.executable, str(ENGINE / "tools" / "colorcheck" / "colorcheck.py")]


def log(msg: str) -> None:
    print(f"[s8] {msg}", flush=True)


def scenes() -> list[dict]:
    manifest = json.loads((ROUND / "manifest.json").read_text(encoding="utf-8"))
    first: dict[str, dict] = {}
    for e in manifest:
        first.setdefault(e["scene"], e)
    out = []
    by_model: dict[str, list[str]] = {}
    for s in sorted(first):
        by_model.setdefault(first[s]["model"], []).append(s)
    for model, names in by_model.items():
        for i, s in enumerate(names):
            out.append({"scene": s, "model": model, "split": "train" if i % 2 == 0 else "val"})
    return sorted(out, key=lambda e: e["scene"])


def reference(scene: str, variant: str) -> Path:
    return EXPORT / f"p7_{scene}_color_{variant}.jpg"


def working_copy(scene: str, variant: str) -> Path:
    lens = refs.lens_on(str(reference(scene, variant)))
    return S8 / ("working-copy" if lens else "working-copy-nolens") / f"{scene}.png"


def render_path(look: str, variant: str, scene: str) -> Path:
    return S8 / "render" / look / variant / f"{scene}.jpg"


def current_fit_manifest() -> dict:
    missing = [str(reference(e["scene"], v)) for e in scenes() for v in VARIANTS if not reference(e["scene"], v).exists()]
    if missing:
        raise SystemExit(f"参照が {len(missing)} 枚足りない（例 {missing[0]}）。make_lr_round7.py --check を先に")
    items = [{"scene": e["scene"], "model": e["model"], "split": e["split"], "reference": str(reference(e["scene"], "neutral")),
              "workingCopy": str(working_copy(e["scene"], "neutral"))} for e in scenes()]
    return {"target": f"Lightroom neutral + Adobe Color ({EXPORT})", "items": items}


def step_manifest(args) -> None:
    manifest = current_fit_manifest()
    (S8 / "fit").mkdir(parents=True, exist_ok=True)
    (S8 / "fit" / "manifest.json").write_text(json.dumps(manifest, ensure_ascii=False, indent=1), encoding="utf-8")
    log(f"fit manifest: {len(manifest['items'])} 場面（train {sum(i['split'] == 'train' for i in manifest['items'])}）")


def sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as fh:
        for block in iter(lambda: fh.read(1024 * 1024), b""):
            digest.update(block)
    return digest.hexdigest()


def fit_manifest_path() -> Path:
    return S8 / "fit" / "manifest.json"


def provenance_path(look_path: Path) -> Path:
    return look_path.with_suffix(look_path.suffix + ".provenance.json")


def fit_input_fingerprint(manifest: dict) -> str:
    """Fingerprint exactly the manifest and image bytes consumed by fit_look.py."""
    digest = hashlib.sha256()
    reference_manifest = ROUND / "manifest.json"
    if not reference_manifest.is_file():
        raise FileNotFoundError("round7 manifest is missing; regenerate and validate the current references")
    digest.update(b"round7-manifest\0")
    digest.update(sha256_file(reference_manifest).encode())
    digest.update(b"\0fit-manifest\0")
    digest.update(json.dumps(manifest, sort_keys=True, separators=(",", ":"), ensure_ascii=False).encode())
    for item in manifest.get("items", []):
        for role in ("reference", "workingCopy"):
            path = Path(item[role])
            if not path.is_file():
                raise FileNotFoundError(f"S8 fit input is missing ({role})")
            digest.update(b"\0")
            digest.update(role.encode())
            digest.update(b"\0")
            digest.update(str(path.resolve()).encode())
            digest.update(b"\0")
            digest.update(sha256_file(path).encode())
    return digest.hexdigest()


def validate_fit_provenance(look_path: Path, require_current_inputs: bool = True) -> dict:
    """Refuse coefficients whose fitted inputs or coefficient bytes have drifted."""
    sidecar = provenance_path(look_path)
    if not look_path.is_file() or not sidecar.is_file():
        raise SystemExit("S8係数の出所証跡がありません。現行参照で run_s8_look.py fit を実行してください。")
    try:
        provenance = json.loads(sidecar.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as exc:
        raise SystemExit("S8係数の出所証跡を読めません。現行参照で fit をやり直してください。") from exc
    if provenance.get("schema") != "niho-s8-fit-provenance/v1":
        raise SystemExit("S8係数の出所証跡の形式が不正です。現行参照で fit をやり直してください。")
    if provenance.get("lookSha256") != sha256_file(look_path):
        raise SystemExit("S8係数がfit後に変更されています。現行参照で fit をやり直してください。")
    manifest_path = fit_manifest_path()
    if not manifest_path.is_file() or provenance.get("fitManifestSha256") != sha256_file(manifest_path):
        raise SystemExit("fit manifest と係数の出所が一致しません。現行参照で fit をやり直してください。")
    if require_current_inputs:
        try:
            stored_manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
            expected_manifest = current_fit_manifest()
            if stored_manifest != expected_manifest:
                raise SystemExit("fit manifest が現行参照と一致しません。現行参照で fit をやり直してください。")
            current_fingerprint = fit_input_fingerprint(stored_manifest)
        except (OSError, json.JSONDecodeError, KeyError, TypeError) as exc:
            raise SystemExit("現行S8参照を検証できません。参照を整えて fit をやり直してください。") from exc
        if provenance.get("referenceFingerprint") != current_fingerprint:
            raise SystemExit("fit 後に参照画像または作業コピーが変わりました。現行参照で fit をやり直してください。")
    return provenance


def step_fit(args) -> None:
    # Never let fit_look.py consume a manifest left by a different reference root.
    step_manifest(args)
    manifest = json.loads(fit_manifest_path().read_text(encoding="utf-8"))
    reference_fingerprint = fit_input_fingerprint(manifest)
    cmd = [sys.executable, str(HERE / "fit_look.py"), "--manifest", str(S8 / "fit" / "manifest.json"),
           "--out", str(S8 / "fit" / "look.json"), "--report", str(S8 / "fit" / "fit.md"), "--cache-dir", str(S8 / "prelook"),
           "--reg", str(args.reg), "--sat-node", str(args.sat_node), "--hue-nodes", str(args.hue_nodes), "--max-iter", str(args.max_iter)]
    subprocess.run(cmd, check=True)
    look_path = S8 / "fit" / "look.json"
    if not look_path.is_file():
        raise FileNotFoundError("fit_look.py did not write its coefficient file")
    provenance = {"schema": "niho-s8-fit-provenance/v1", "referenceFingerprint": reference_fingerprint,
                  "fitManifestSha256": sha256_file(fit_manifest_path()), "lookSha256": sha256_file(look_path),
                  "fitOptions": {"reg": args.reg, "satNode": args.sat_node, "hueNodes": args.hue_nodes,
                                 "maxIter": args.max_iter}}
    sidecar = provenance_path(look_path)
    temporary = sidecar.with_suffix(sidecar.suffix + ".tmp")
    temporary.write_text(json.dumps(provenance, ensure_ascii=False, indent=1) + "\n", encoding="utf-8")
    temporary.replace(sidecar)


def step_adopt(args) -> None:
    src = Path(args.look_json) if args.look_json else S8 / "fit" / "look.json"
    validate_fit_provenance(src)
    import numpy as np
    from look import Look
    dst = ENGINE / "crates" / "niho-develop" / "looks" / "niho-standard-1.json"
    if src.resolve() != dst.resolve():
        shutil.copyfile(src, dst)
    look = Look.load(str(dst))
    rng = np.random.default_rng(16947)
    pts = np.concatenate([rng.random((200, 3)), rng.random((40, 3)) ** 3, np.repeat(rng.random((16, 1)), 3, axis=1),
                          np.array([[0, 0, 0], [1, 1, 1], [1, 0, 0], [0, 1, 0], [0, 0, 1], [1.4, 0.3, -0.1]])])
    pre, point = look.pre_acr3(pts), look.point_curve(np.clip(pts, 0.0, 1.0))
    fixture = ENGINE / "crates" / "niho-develop" / "tests" / "fixtures" / "look" / "niho-standard-1-parity.json"
    fixture.parent.mkdir(parents=True, exist_ok=True)
    fixture.write_text(json.dumps({"schema": "niho-develop-look-parity/v2", "look": "niho-standard-1",
                                   "toneStage": look.tone_stage, "source": "tools/calibrate/look.py (Python reference)",
                                   "cases": [{"in": [float(v) for v in p], "preAcr3": [float(v) for v in a],
                                              "pointCurve": [float(v) for v in b]} for p, a, b in zip(pts, pre, point)]},
                                  indent=0) + "\n", encoding="utf-8")
    log(f"adopted {src} -> {dst}（parity {len(pts)} 点 -> {fixture}）")


def source_fingerprint(src: Path, compiler_info: str | None = None) -> str:
    h = hashlib.sha256()
    build_inputs = [src / "Cargo.toml", src / "Cargo.lock", src / "rust-toolchain.toml", src / ".cargo" / "config.toml"]
    build_inputs.extend(p for p in (src / "crates").rglob("*") if p.is_file())
    for path in sorted(build_inputs):
        if path.is_file():
            h.update(str(path.relative_to(src)).encode())
            h.update(path.read_bytes())
    if compiler_info is None:
        rustc_executable = os.environ.get("RUSTC", "rustc")
        rustc = subprocess.run([rustc_executable, "-Vv"], cwd=src, check=True, capture_output=True, text=True).stdout
        cargo = subprocess.run(["cargo", "-Vv"], cwd=src, check=True, capture_output=True, text=True).stdout
        compiler_info = f"rustc\n{rustc}\ncargo\n{cargo}"
    h.update(b"\0compiler\0")
    h.update(compiler_info.encode())
    for name in ("RUSTFLAGS", "CARGO_ENCODED_RUSTFLAGS", "CARGO_BUILD_TARGET", "CARGO_PROFILE_RELEASE_OPT_LEVEL",
                 "CARGO_PROFILE_RELEASE_LTO", "CARGO_PROFILE_RELEASE_CODEGEN_UNITS", "RUSTC", "RUSTC_WRAPPER",
                 "RUSTC_WORKSPACE_WRAPPER"):
        h.update(name.encode())
        h.update(os.environ.get(name, "").encode())
    return h.hexdigest()[:16]


def bridge_bin() -> Path:
    return S8 / "crate-target" / "release" / "examples" / "render_working_copy"


def resolve_look_json(args) -> Path:
    look_json = Path(args.look_json) if args.look_json else S8 / "fit" / "look.json"
    if not look_json.is_file():
        raise FileNotFoundError(f"S8 look coefficients file does not exist: {look_json}")
    return look_json


def step_crate_build(args) -> None:
    look_json = resolve_look_json(args)
    src = S8 / "crate-src"
    if src.exists():
        shutil.rmtree(src)
    shutil.copytree(ENGINE, src, ignore=shutil.ignore_patterns("target", ".build", "pkg", "node_modules", "__pycache__", "fixtures"))
    shutil.copyfile(HERE / "crate-bridge" / "render_working_copy.rs", src / "crates" / "niho-develop" / "examples" / "render_working_copy.rs")
    # 当てはめた係数で組む（worktree の looks/ は adopt までそのまま）
    shutil.copyfile(look_json, src / "crates" / "niho-develop" / "looks" / "niho-standard-1.json")
    subprocess.run(["cargo", "build", "--release", "-p", "niho-develop", "--example", "render_working_copy",
                    "--target-dir", str(S8 / "crate-target")], cwd=src, check=True)
    fp = source_fingerprint(src)
    (S8 / "crate-ref.txt").write_text(fp + "\n")
    log(f"bridge {bridge_bin()} (sources {fp})")


def render_one(job) -> str:
    look, variant, scene = job
    out = render_path(look, variant, scene)
    out.parent.mkdir(parents=True, exist_ok=True)
    wc = working_copy(scene, variant)
    r = subprocess.run([str(bridge_bin()), str(wc), str(wc.with_suffix(".json")), BRIDGE_PRESET[variant], "0", str(out), "97",
                        f"--look={look}"], capture_output=True, text=True)
    if r.returncode != 0:
        raise RuntimeError(f"render {job}: {r.stderr[-400:]}")
    return f"{look} {variant} {scene} {r.stdout.strip()}"


def step_render(args) -> None:
    jobs = [(lk, v, e["scene"]) for lk in args.looks for v in VARIANTS for e in scenes()]
    with cf.ThreadPoolExecutor(max_workers=args.jobs) as ex:
        for i, line in enumerate(ex.map(render_one, jobs), 1):
            if i % 20 == 0 or i == len(jobs):
                log(f"render {i}/{len(jobs)}: {line}")


def step_measure(args) -> None:
    (S8 / "results").mkdir(parents=True, exist_ok=True)
    fp = (S8 / "crate-ref.txt").read_text().strip() if (S8 / "crate-ref.txt").exists() else "unknown"
    for look in args.looks:
        items = [{"preset": v, "scene": e["scene"], "reference": str(reference(e["scene"], v)),
                  "candidate": str(render_path(look, v, e["scene"])), "candidateSpace": "srgb"} for v in VARIANTS for e in scenes()]
        m = S8 / "results" / f"manifest-{look}.json"
        m.write_text(json.dumps({"schema": "colorcheck/preset-manifest/v1",
                                 "stage2": f"niho-develop crate (S8 worktree sources {fp}) on calibrated working copies, look {look}",
                                 "items": items}, ensure_ascii=False, indent=1), encoding="utf-8")
        log(f"measure {look}（{len(items)} 組）")
        subprocess.run(CC + ["preset", "--manifest", str(m), "--base-version", f"apple-cal-v2+niho-develop@{fp}+{look}",
                             "--out", str(S8 / "results" / f"{look}.json"), "--markdown", str(S8 / "results" / f"{look}.md"),
                             "--save-pairs", str(S8 / "results" / f"pairs-{look}")], check=True, stdout=subprocess.DEVNULL)
        print((S8 / "results" / f"{look}.md").read_text(encoding="utf-8").split("\n\n")[0][:1500])


def _img(path: Path) -> str:
    return "data:image/jpeg;base64," + base64.b64encode(path.read_bytes()).decode() if path.exists() else ""


def step_page(args) -> None:
    res = {lk: json.loads((S8 / "results" / f"{lk}.json").read_text(encoding="utf-8")) for lk in LOOKS}
    by = {lk: {(r["preset"], r["scene"]): r for r in res[lk]["items"]} for lk in LOOKS}
    summ = {lk: {p["preset"]: p for p in res[lk]["presets"]} for lk in LOOKS}
    gates = {lk: next((g for g in res[lk]["gates"]["gates"] if g["id"] == "stage1.preset"), {}) for lk in LOOKS}
    fit = json.loads((S8 / "fit" / "look.json").read_text(encoding="utf-8")).get("fit", {})
    floor_path = S8 / "results" / "std-baseline.json"  # 段 2 だけの差（暫定の描画 vs round6 の Adobe Standard）
    floor = {p["preset"]: p for p in json.loads(floor_path.read_text(encoding="utf-8"))["presets"]} if floor_path.exists() else {}
    rows = []
    for v in VARIANTS:
        a, b, f = summ["niho-interim-1"].get(v, {}), summ["niho-standard-1"].get(v, {}), floor.get(v, {})
        rows.append(f"<tr><th>{v}</th><td>{a.get('deltaE00Mean', 0):.2f} / {a.get('deltaE00P99', 0):.2f}</td>"
                    f"<td><b>{b.get('deltaE00Mean', 0):.2f} / {b.get('deltaE00P99', 0):.2f}</b></td>"
                    f"<td>{f.get('deltaE00Mean', 0):.2f} / {f.get('deltaE00P99', 0):.2f}</td>"
                    f"<td>{b.get('saturationRatio') or 0:.3f}</td><td>{b.get('evDiff') or 0:+.3f}</td></tr>")
    model = {e["scene"]: e for e in scenes()}
    cards = []
    for group, names in GROUPS.items():
        cards.append(f"<h2>{html.escape(group)}</h2>")
        for s in names:
            e = model[s]
            for v in VARIANTS:
                ra, rb = by["niho-interim-1"].get((v, s)), by["niho-standard-1"].get((v, s))
                if not ra or not rb:
                    continue
                sa, sb = ra.get("samples") or {}, rb.get("samples") or {}
                ref_img = Path(sb.get("reference") or "")
                da, db = ra["metrics"]["deltaE00"], rb["metrics"]["deltaE00"]
                cards.append(
                    f"<section class=card><h3>{html.escape(s)} · {v} <small>{e['model']} · {e['split'] if v == 'neutral' else 'preset'}</small></h3>"
                    f"<div class=row><figure><img loading=lazy src='{_img(ref_img)}'><figcaption>Lightroom（Adobe Color）</figcaption></figure>"
                    f"<figure><img loading=lazy src='{_img(Path(sa.get('candidate') or ''))}'><figcaption>暫定 niho-interim-1 · ΔE {da['mean']:.2f} / p99 {da['p99']:.2f}</figcaption></figure>"
                    f"<figure><img loading=lazy src='{_img(Path(sb.get('candidate') or ''))}'><figcaption><b>標準 niho-standard-1 · ΔE {db['mean']:.2f} / p99 {db['p99']:.2f}</b></figcaption></figure></div></section>")
    tot = fit.get("totals", {})
    fit_line = "・".join(f"{k} {v['before'].get('mean', 0):.2f}→{v['after'].get('mean', 0):.2f}" for k, v in tot.items() if v.get("after"))
    page = f"""<!doctype html><html lang=ja><meta charset=utf-8><meta name=viewport content="width=device-width,initial-scale=1">
<title>NIHO 標準ルック 見比べ</title><style>
:root{{--bg:#faf8f5;--fg:#2b2a28;--mut:#6f6b66;--line:#e4dfd8;--card:#fff}}
@media (prefers-color-scheme:dark){{:root{{--bg:#1d1c1b;--fg:#ece8e2;--mut:#a39d95;--line:#3a3734;--card:#262523}}}}
body{{margin:0;padding:16px;background:var(--bg);color:var(--fg);font:15px/1.6 -apple-system,"Hiragino Sans",sans-serif}}
h1{{font-size:20px;margin:0 0 4px}} h2{{font-size:17px;margin:24px 0 8px}} p{{color:var(--mut);margin:4px 0 12px}} table{{border-collapse:collapse;margin:8px 0 20px}}
td,th{{border:1px solid var(--line);padding:4px 10px;text-align:right}} th{{text-align:left}}
.card{{background:var(--card);border:1px solid var(--line);border-radius:12px;padding:12px;margin:0 0 14px}}
.card h3{{margin:0 0 8px;font-size:15px}} .card small{{color:var(--mut);font-weight:400}}
.row{{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:8px}} figure{{margin:0}} img{{width:100%;border-radius:6px;display:block}}
figcaption{{font-size:12px;color:var(--mut);margin-top:4px}} @media (max-width:640px){{.row{{grid-template-columns:1fr}}}}
</style><h1>NIHO 標準ルック niho-standard-1 の見比べ</h1>
<p>Lightroom（Adobe Color の中立とプリセット 3 本）と、NIHO の crate で描いた暫定（ルック無し）・標準（S8 のルック）。数値は ΔE00 の mean / p99（1500px・平坦画素）。当てはめ（中立・画素）: {html.escape(fit_line)}</p>
<table><tr><th>プリセット</th><th>暫定 mean / p99</th><th>標準 mean / p99</th><th>段 2 の下限 mean / p99</th><th>標準 彩度比</th><th>標準 EV 差</th></tr>{''.join(rows)}</table>
<p>gate stage1.preset（mean ≤ 3.0・p99 ≤ 8.0、3 本とも）: 暫定 {gates['niho-interim-1'].get('status')} / 標準 <b>{gates['niho-standard-1'].get('status')}</b>。
「段 2 の下限」はルック無しの描画を Lightroom の Adobe Standard と比べた値で、ルックでは縮まらない段 2（プリセットの再現）の差。p99 の外れ（DSC01837 など）はここで決まっている。</p>
{''.join(cards)}</html>"""
    for out in (ROOT / ".preview" / "s8-look.html", S8 / "page" / "s8-look.html"):
        out.parent.mkdir(parents=True, exist_ok=True)
        out.write_text(page, encoding="utf-8")
        log(f"page {out}（{out.stat().st_size / 1e6:.1f} MB）")


STEPS = {"manifest": step_manifest, "fit": step_fit, "adopt": step_adopt, "crate-build": step_crate_build,
         "render": step_render, "measure": step_measure, "page": step_page}


def build_parser() -> argparse.ArgumentParser:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("step", choices=[*STEPS, "all"])
    ap.add_argument("--reg", type=float, default=0.3)
    ap.add_argument("--sat-node", type=float, default=0.3)
    ap.add_argument("--hue-nodes", type=int, default=12)
    ap.add_argument("--max-iter", type=int, default=60)
    ap.add_argument("--jobs", type=int, default=3)
    ap.add_argument("--looks", nargs="+", default=list(LOOKS), choices=LOOKS, help="render / measure で描く版（既定は両方）")
    ap.add_argument("--look-json", help="crate-build で焼く係数（既定 s8/fit/look.json）")
    return ap


def main() -> int:
    args = build_parser().parse_args()
    # A resolved profile alone does not prove the requested edit survived the
    # Lightroom import/profile-copy/export cycle. Check before fitting, adopting
    # coefficients, measuring, or publishing a report from these references.
    if args.step != "crate-build" and make_lr_round7.check(ROUND, EXPORT.name):
        log("参照JPEGの設定がmanifestと一致しないため中止。基準画像を修復して --check を通すこと。")
        return 1
    for name in (["manifest", "fit", "crate-build", "render", "measure", "page"] if args.step == "all" else [args.step]):
        STEPS[name](args)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
