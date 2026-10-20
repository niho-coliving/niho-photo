#!/usr/bin/env python3
"""段 2 の効果（白黒・周辺光量補正・粒子。E1 #17120・端の値 E1c #17259）の計測と当てはめを一括で回す（再現用）。

  python3 run_e1_effects.py <step> [--round 8|9] [--tag before|after|<name>] [--src <engine>] [--coeffs coeffs.json] [--jobs 3]
  steps: refs crate-build render measure grain-stats vig-fit bw-fit grain-fit page all
         all = refs → crate-build/render/measure/grain-stats(before) → vig-fit → bw-fit → grain-fit
               → crate-build/render/measure/grain-stats(after: --src-after に --coeffs か fit/coeffs-after.json) → page

- 目標（参照）: `$NIHO_COLOR_REF_ROOT/round<N>/lr-export/p<N>_<scene>_<variant>.jpg`（`make_lr_round8.py` / `make_lr_round9.py`。
  6 場面 × 16 / 19 通り、全変種が Adobe Standard・Look 無し・撮影時の WB・Linear・レンズ補正なし）。変種の一覧と設定は各 round の
  `manifest.json` から読む。`--round`（既定 8）で計測する round を選ぶ: round8 の結果・キャッシュは `e1/` の直下（今まで通り）、
  round9 は `e1/round9/` の下。`-2` の付いた 2 回目の書き出しは Lightroom 自身の揺れを見るのに使う（粒子も含めてほぼ同じ画素 =
  Lightroom の粒の seed は固定）。1 回目が途中で切れている（JPEG の終端が無い）ときは 2 回目を参照にする（`export_source`）。
- 候補: `$NIHO_COLOR_WORK_DIR/s8/working-copy-nolens/<scene>.png`（レンズ補正なしの作業コピー）を crate で描く。
  設定は各変種の XMP を `xmp::preset_settings`（neutral の上・`--look=niho-interim-1`）で変換したもの。長辺 2560・PNG。
- refs: Lightroom の書き出し（フルサイズ）を線形光の面積平均で作業コピーの大きさに縮め、16bit PNG（sRGB 符号化）で
  `cache/lr/` に置く（以降の step はここだけを読む）。
- crate-build: `--src`（既定はこのファイルのある engine、無ければ `e1/crate-src`）を `e1/build/<tag>/src` に写し、
  `--coeffs`（{定数名: 値 か 値の並び}。`CONST_FILES`）と `--patch`（-p1 の diff）を当てて、計測用ブリッジ（`crate-bridge/
  render_working_copy.rs`）と probe（`probe_stage.rs`: 最初の cube の入力・cube Q の入力・neutral の tail・ACR3・灰の表・粒の場）を組む。
- render: 場面 × 変種を描く（`render/<tag>/<variant>/<scene>.png`）。
- measure: `colorcheck` の compare（1500px・blur 2px・平坦画素、S8 と同じ）で ΔE00 の mean / p99 を出す
  （`results/<tag>.json` / `.md`）。受入は白黒・周辺光量補正の変種ごとに「場面ごとの mean の平均 ≤ 3.0」。
- grain-stats: 「粒子あり − neutral」の残差の統計（標準偏差・自己相関の半値幅・平均のずれ・彩度の揺れ）を Lightroom と crate で
  比べる（`results/grain-<tag>.json` / `.md`。目安: sd ±20%・半値幅 ±25%）。Lightroom は粒子のサイズが大きいと像そのものも
  ぼかすので、粒そのものは像の細部の少ないタイルで測った値（「平坦」の列）で比べる。
- vig-fit: 周辺光量補正の式と係数を、両 round の Lightroom の書き出し（「変種 と neutral」を pre-tone に戻したもの）から直接出す
  （`fit/vig.json`。下の「vignette」の節）。crate は描かない。
- bw-fit: 白黒ミックス（トーンカーブの前の倍率）の帯ごとの強さを、round8 の bw_warm / bw_cool と round9 の全色 ±100 に ΔE00 で
  当てはめる（`fit/bw.json`。`FitScene`: 1000px・colorcheck と同じ位置合わせ・blur・平坦画素。`--loo` で場面の leave-one-out）。
- grain-fit: 環境変数で粒子の定数を上書きできる probe（`env_probe_build`。計測専用）で格子 1 枚の場の統計を取り、2 枚の格子の
  間隔・振幅を両 round の Lightroom の粒（平坦なタイル・2560px）の sd と半値幅に合わせる（`fit/grain.json`）。
- page: 見比べページ（Lightroom・`--tag-before`・`--tag-after` の 3 列）を `page/index.html` に書く（人の写った場面を
  含むので volume の中だけ）。
- 当てはめ（vig-fit / bw-fit / grain-fit）は round をまたぐ（両 round の参照を使う）ので、先に両 round の refs を済ませる。
  結果（`fit/*.json`）と probe の段の出力・build は round によらず `e1/` の直下。係数は目で見て effects.rs / color_ops.rs に写す。

パスは `NIHO_COLOR_REF_ROOT`（lr-measure）・`NIHO_COLOR_WORK_DIR`（niho-color-work）・`NIHO_COLOR_E1_DIR`（結果の置き場。既定は
`<work>/e1`）で上書きできる。重い処理は `--jobs`（既定 3）まで並列。
"""
from __future__ import annotations

import argparse
import base64
import concurrent.futures as cf
import html
import json
import os
import re
import shutil
import subprocess
import sys
from pathlib import Path

import numpy as np

HERE = Path(__file__).resolve().parent
REF = Path(os.environ.get("NIHO_COLOR_REF_ROOT", "OWNER_DATA_ROOT"))
WK = Path(os.environ.get("NIHO_COLOR_WORK_DIR", "OWNER_DATA_ROOT"))
E1 = Path(os.environ.get("NIHO_COLOR_E1_DIR", WK / "e1"))


def _requested_round() -> int:
    """`--round`（既定 8）。変種の一覧とパスが module の定数なので、import の時点で決める。"""
    for i, a in enumerate(sys.argv):
        if a == "--round" and i + 1 < len(sys.argv):
            return int(sys.argv[i + 1])
        if a.startswith("--round="):
            return int(a.split("=", 1)[1])
    return int(os.environ.get("NIHO_E1_ROUND", "8"))


ROUND_N = _requested_round()
ROUNDS = (8, 9)
if ROUND_N not in ROUNDS:
    raise SystemExit(f"--round は {ROUNDS} のどれか")
ROUND = REF / f"round{ROUND_N}"
EXPORT = ROUND / "lr-export"
XMPS = ROUND / f"round{ROUND_N}-photos"
PREFIX = f"p{ROUND_N}"
# round8 の結果・キャッシュは e1/ の直下（今まで通り）、ほかの round は e1/round<N>/ の下（互いに上書きしない）。
# build（crate-build の写しと target）と probe の段の出力（場面ごと）は round によらないので e1/ の直下で共有する。
OUT = E1 if ROUND_N == 8 else E1 / f"round{ROUND_N}"
WC = WK / "s8" / "working-copy-nolens"
ENGINE = HERE.parents[1] if (HERE.parent / "colorcheck").is_dir() else E1 / "crate-src"
sys.path.insert(0, str(ENGINE / "tools" / "colorcheck"))

SCENES = ("P1570133", "P1570302", "P1570923", "P1581387", "DSC09206", "DSC01835")
BANDS = ("Red", "Orange", "Yellow", "Green", "Aqua", "Blue", "Purple", "Magenta")
# manifest の settings のうち、どの変種にも共通の土台（Adobe Standard・撮影時の WB・Linear・レンズ補正なし）
BASE_SETTINGS = ("CameraProfile", "WhiteBalance", "ToneCurveName2012", "LensProfileEnable", "AutoLateralCA")


def manifest_variants(n: int) -> dict:
    """round の manifest（`make_lr_round<N>.py` が書く）から {変種: 効果の設定}（manifest の順）。"""
    path = REF / f"round{n}" / "manifest.json"
    if not path.exists():
        return {}
    out = {}
    for e in json.loads(path.read_text(encoding="utf-8")):
        out.setdefault(e["variant"], {k: v for k, v in e["settings"].items() if k not in BASE_SETTINGS})
    return out


def _is_bw(s: dict) -> bool:
    return s.get("ConvertToGrayscale") == "True"


MANIFEST = {n: manifest_variants(n) for n in ROUNDS}
# volume が無いとき（import だけするテスト）は round8 の一覧を既定にする
VARIANTS = tuple(MANIFEST[ROUND_N]) or (
    "neutral", "bw", "bw_warm", "bw_cool", "bw_toned", "vig_m50", "vig_m100", "vig_p50", "vig_shape",
    "vig_square", "vig_color", "vig_paint", "grain_30", "grain_60", "grain_100", "film_bw")
_SET = MANIFEST[ROUND_N]
# 粒子の入った変種（白黒・周辺光量補正と重ねた film_bw も）は GRAIN、受入（ΔE00 ≤ 3.0）の対象は BW と VIG
GRAIN = tuple(v for v in VARIANTS if "GrainAmount" in _SET.get(v, {})) if _SET else ("grain_30", "grain_60", "grain_100", "film_bw")
BW = tuple(v for v in VARIANTS if _is_bw(_SET.get(v, {})) and v not in GRAIN) if _SET else ("bw", "bw_warm", "bw_cool", "bw_toned")
VIG = (tuple(v for v in VARIANTS if "PostCropVignetteAmount" in _SET.get(v, {}) and v not in GRAIN) if _SET
       else ("vig_m50", "vig_m100", "vig_p50", "vig_shape", "vig_square", "vig_color", "vig_paint"))
# 2 回目の書き出し（-2）も縮めておく変種（Lightroom 自身の揺れを見る。書き出しがあるものだけ）
SECOND = (*(v for v in ("neutral", "bw", "vig_m100") if v in VARIANTS), *GRAIN)
LOOK = "niho-interim-1"
# 係数の定数と置き場所（crate-build の --coeffs が書き換える）
CONST_FILES = {
    "GRAY_MIX_BRIGHTEN": "color_ops.rs", "GRAY_MIX_DARKEN": "color_ops.rs", "GRAY_MIX_BRIGHTEN_SHAPE": "color_ops.rs",
    "GRAY_MIX_DARKEN_SHAPE": "color_ops.rs",
    "VIGNETTE_ROOT_OFFSET": "effects.rs", "VIGNETTE_HIGHLIGHTS_FROM": "effects.rs", "VIGNETTE_HIGHLIGHTS_SPAN": "effects.rs",
    "VIGNETTE_HIGHLIGHTS_SHAPE": "effects.rs", "VIGNETTE_GAMMA_COLOR": "effects.rs", "VIGNETTE_GAMMA_PAINT": "effects.rs",
    "VIGNETTE_BRIGHTEN_POWER": "effects.rs", "VIGNETTE_BRIGHTEN_TARGET": "effects.rs",
    "VIGNETTE_BRIGHTEN_SHIFT": "effects.rs", "VIGNETTE_BRIGHTEN_SCALE": "effects.rs", "VIGNETTE_DEEP_FROM": "effects.rs",
    "VIGNETTE_DEEP_SHIFT": "effects.rs", "VIGNETTE_DEEP_SCALE": "effects.rs", "VIGNETTE_BOX_RADIUS_MIN": "effects.rs",
    "VIGNETTE_CENTER_AT_MIDPOINT_0": "effects.rs", "VIGNETTE_CENTER_SLOPE": "effects.rs", "VIGNETTE_CENTER_CURVE": "effects.rs",
    "VIGNETTE_FEATHER_SCALE": "effects.rs", "VIGNETTE_FEATHER_SHIFT": "effects.rs", "VIGNETTE_CORNER_LIFT": "effects.rs",
    "VIGNETTE_CORNER_REACH": "effects.rs", "GRAIN_AMPLITUDE": "effects.rs", "GRAIN_EVEN_WEIGHT": "effects.rs",
    "GRAIN_EVEN_CELL_AT_SIZE_0": "effects.rs", "GRAIN_EVEN_CELL_AT_SIZE_100": "effects.rs", "GRAIN_CLUMP_CELL_AT_SIZE_0": "effects.rs",
    "GRAIN_CLUMP_CELL_AT_SIZE_100": "effects.rs", "GRAIN_SIZE_SHAPE": "effects.rs", "GRAIN_FINE_BOOST_CELL": "effects.rs",
    "GRAIN_TONE_FLOOR": "effects.rs", "GRAIN_PIXEL_FOOTPRINT": "effects.rs",
}


def log(msg: str) -> None:
    print(f"[e1] {msg}", flush=True)


# ------------------------------------------------------------------ images

def srgb_decode(e: np.ndarray) -> np.ndarray:
    e = np.asarray(e, dtype=np.float32)
    return np.where(e <= 0.04045, e / 12.92, ((e + 0.055) / 1.055) ** 2.4).astype(np.float32)


def srgb_encode(v: np.ndarray) -> np.ndarray:
    v = np.clip(np.asarray(v, dtype=np.float32), 0.0, 1.0)
    return np.where(v <= 0.0031308, v * 12.92, 1.055 * np.power(v, 1 / 2.4) - 0.055).astype(np.float32)


def read_encoded(path: Path) -> np.ndarray:
    """sRGB 符号化値（[0,1]・float32・RGB）。"""
    import cv2
    a = cv2.imread(str(path), cv2.IMREAD_UNCHANGED)
    if a is None:
        raise FileNotFoundError(path)
    a = a[..., :3][..., ::-1]
    top = 65535.0 if a.dtype == np.uint16 else 255.0
    return np.ascontiguousarray(a, dtype=np.float32) / np.float32(top)


def write_png16(path: Path, encoded: np.ndarray) -> None:
    import cv2
    path.parent.mkdir(parents=True, exist_ok=True)
    u16 = np.round(np.clip(encoded, 0, 1) * 65535).astype(np.uint16)
    cv2.imwrite(str(path), np.ascontiguousarray(u16[..., ::-1]))


def wc_size(scene: str) -> tuple[int, int]:
    import cv2
    a = cv2.imread(str(WC / f"{scene}.png"), cv2.IMREAD_UNCHANGED)
    return a.shape[1], a.shape[0]


def round_out(n: int | None = None) -> Path:
    n = ROUND_N if n is None else n
    return E1 if n == 8 else E1 / f"round{n}"


def split_variant(key: str) -> tuple[int, str]:
    """変種の鍵: `vig_m50`（今の round）か `8/vig_m50`（round を名指し。round をまたぐ当てはめ用）。"""
    if "/" in key:
        n, name = key.split("/", 1)
        return int(n), name
    return ROUND_N, key


def variant_settings(key: str) -> dict:
    n, name = split_variant(key)
    return MANIFEST[n][name]


def export_path(scene: str, variant: str, second: bool = False) -> Path:
    n, name = split_variant(variant)
    return REF / f"round{n}" / "lr-export" / f"p{n}_{scene}_{name}{'-2' if second else ''}.jpg"


def jpeg_complete(path: Path) -> bool:
    """JPEG が終端（EOI）まで書かれているか（書き出しが途中で止まったファイルを見分ける）。"""
    with open(path, "rb") as f:
        f.seek(-2, os.SEEK_END)
        return f.read() == b"\xff\xd9"


def export_source(scene: str, variant: str, second: bool = False) -> Path:
    """縮める元の書き出し。1 回目が途中で切れているときは 2 回目（-2）を使う（round9 の DSC09206 の
    grain_size0 / grain_rough100 は 1 回目が 2 MiB / 8 MiB で切れている）。"""
    first = export_path(scene, variant, second)
    again = export_path(scene, variant, True)
    if not second and first.exists() and not jpeg_complete(first) and again.exists() and jpeg_complete(again):
        log(f"{first.name} は途中で切れているので {again.name} を使う")
        return again
    return first


def ref_path(scene: str, variant: str, second: bool = False) -> Path:
    n, name = split_variant(variant)
    return round_out(n) / "cache" / "lr" / f"{scene}_{name}{'-2' if second else ''}.png"


def render_path(tag: str, variant: str, scene: str) -> Path:
    n, name = split_variant(variant)
    return round_out(n) / "render" / tag / name / f"{scene}.png"


# ------------------------------------------------------------------ refs

def _ref_one(job) -> str:
    import cv2
    scene, variant, second, size = job
    out = ref_path(scene, variant, second)
    if out.exists():
        return f"{out.name} (cached)"
    src = export_source(scene, variant, second)
    if not jpeg_complete(src):
        raise SystemExit(f"{src} が途中で切れている（書き出し直す）")
    lin = srgb_decode(read_encoded(src))
    small = cv2.resize(lin, size, interpolation=cv2.INTER_AREA)
    write_png16(out, srgb_encode(small))
    return f"{out.name} {lin.shape[1]}x{lin.shape[0]} -> {size[0]}x{size[1]}"


def refs_for(n: int, workers: int) -> None:
    """round n の書き出しを縮める（当てはめは両 round の参照を使う）。"""
    names = tuple(MANIFEST[n]) or VARIANTS
    second = (*(v for v in ("neutral", "bw", "vig_m100") if v in names), *(v for v in names if "GrainAmount" in MANIFEST[n].get(v, {})))
    sizes = {s: wc_size(s) for s in SCENES}
    jobs = [(s, f"{n}/{v}", False, sizes[s]) for s in SCENES for v in names]
    jobs += [(s, f"{n}/{v}", True, sizes[s]) for s in SCENES for v in second if export_path(s, f"{n}/{v}", True).exists()]
    missing = [str(export_path(s, v, b)) for s, v, b, _ in jobs if not export_path(s, v, b).exists()]
    if missing:
        raise SystemExit(f"書き出しが {len(missing)} 枚足りない（例 {missing[0]}）")
    with cf.ProcessPoolExecutor(max_workers=workers) as ex:
        for i, line in enumerate(ex.map(_ref_one, jobs), 1):
            if i % 12 == 0 or i == len(jobs):
                log(f"refs round{n} {i}/{len(jobs)}: {line}")


def step_refs(args) -> None:
    refs_for(ROUND_N, args.jobs)


# ------------------------------------------------------------------ crate

def build_dir(tag: str) -> Path:
    return E1 / "build" / tag


def bridge_bin(tag: str, name: str = "render_working_copy") -> Path:
    return E1 / "crate-target" / tag / "release" / "examples" / name


def probe_source() -> Path:
    """計測用 probe の Rust（tools/calibrate/crate-bridge/probe_stage.rs に置く想定。今は e1/tools/）。"""
    for p in (HERE / "crate-bridge" / "probe_stage.rs", HERE / "probe_stage.rs", E1 / "tools" / "probe_stage.rs"):
        if p.exists():
            return p
    raise FileNotFoundError("probe_stage.rs")


def patch_constants(src: Path, coeffs: dict) -> list[str]:
    changed = []
    for name, value in coeffs.items():
        if name.startswith("_"):
            continue
        f = src / "crates" / "niho-develop" / "src" / CONST_FILES[name]
        text = f.read_text(encoding="utf-8")
        # 数（f64 / f32）か、数の並び（[f64; N]。JSON も同じ長さの並び）
        pat = re.compile(rf"(pub const {name}: (?:f64|f32|\[f64; \d+\]) =\s*)([^;]+);")
        m = pat.search(text)
        if not m:
            raise SystemExit(f"{name} が {f} に無い")
        new = "[" + ", ".join(repr(float(v)) for v in value) + "]" if isinstance(value, list) else repr(float(value))
        text = pat.sub(lambda m: f"{m.group(1)}{new};", text, count=1)
        f.write_text(text, encoding="utf-8")
        changed.append(f"{name} {' '.join(m.group(2).split())} -> {new}")
    return changed


def step_crate_build(args) -> None:
    src_root = Path(args.src) if args.src else ENGINE
    out = build_dir(args.tag) / "src"
    if out.exists():
        shutil.rmtree(out)
    shutil.copytree(src_root, out, ignore=shutil.ignore_patterns("target", ".build", "pkg", "node_modules", "__pycache__"))
    if args.patch:
        subprocess.run(["patch", "-p1", "-i", str(Path(args.patch).resolve())], cwd=out, check=True)
    if args.coeffs:
        coeffs = json.loads(Path(args.coeffs).read_text(encoding="utf-8"))
        for line in patch_constants(out, coeffs):
            log(f"coeff {line}")
    ex_dir = out / "crates" / "niho-develop" / "examples"
    shutil.copyfile(ENGINE / "tools" / "calibrate" / "crate-bridge" / "render_working_copy.rs", ex_dir / "render_working_copy.rs")
    shutil.copyfile(probe_source(), ex_dir / "probe_stage.rs")
    env = dict(os.environ, CARGO_TARGET_DIR=str(E1 / "crate-target" / args.tag), CARGO_INCREMENTAL="0")
    subprocess.run(["cargo", "build", "--release", "-p", "niho-develop", "--example", "render_working_copy", "--example",
                    "probe_stage", "-j", str(args.jobs)], cwd=out, check=True, env=env)
    log(f"bridge {bridge_bin(args.tag)}")


def _render_one(job) -> str:
    tag, variant, scene = job
    out = render_path(tag, variant, scene)
    out.parent.mkdir(parents=True, exist_ok=True)
    xmp = XMPS / f"{PREFIX}_{scene}_{variant}.xmp"
    r = subprocess.run([str(bridge_bin(tag)), str(WC / f"{scene}.png"), str(WC / f"{scene}.json"), str(xmp), "0", str(out),
                        f"--look={LOOK}"], capture_output=True, text=True)
    if r.returncode != 0:
        raise RuntimeError(f"render {job}: {r.stderr[-400:]}")
    extra = r.stderr.strip().replace("\n", " ")
    return f"{variant} {scene} {r.stdout.strip()} {extra[:160]}"


def step_render(args) -> None:
    variants = args.variants or VARIANTS
    jobs = [(args.tag, v, s) for v in variants for s in SCENES]
    with cf.ThreadPoolExecutor(max_workers=args.jobs) as ex:
        for i, line in enumerate(ex.map(_render_one, jobs), 1):
            if i % 12 == 0 or i == len(jobs) or "unsupported" in line:
                log(f"render {i}/{len(jobs)}: {line}")


# ------------------------------------------------------------------ measure

def _measure_one(job) -> dict:
    from colorcheck.compare import run_compare
    tag, variant, scene, reference = job
    res = run_compare(reference=str(reference), candidate=str(render_path(tag, variant, scene)) if tag else str(job[4]),
                      candidate_space="srgb", comparison="preset", scene=scene, preset=variant, label=f"{variant}/{scene}")
    m = res["metrics"]
    return {"variant": variant, "scene": scene, "mean": m["deltaE00"]["mean"], "p99": m["deltaE00"]["p99"],
            "p95": m["deltaE00"]["p95"], "meanAll": m["deltaE00All"]["mean"], "evDiff": m["evDiff"],
            "saturationRatio": m["saturationRatio"], "alignment": res["alignment"], "warnings": res["warnings"]}


def summarize(items: list[dict]) -> dict:
    out = {}
    for v in VARIANTS:
        rs = [r for r in items if r["variant"] == v and r["mean"] is not None]
        if not rs:
            continue
        out[v] = {"mean": float(np.mean([r["mean"] for r in rs])), "p99Mean": float(np.mean([r["p99"] for r in rs])),
                  "p99Max": float(np.max([r["p99"] for r in rs])),
                  "worst": max(rs, key=lambda r: r["p99"])["scene"], "evDiff": float(np.mean([r["evDiff"] or 0 for r in rs])),
                  "scenes": {r["scene"]: [round(r["mean"], 3), round(r["p99"], 3)] for r in rs}}
    return out


def measure_markdown(tag: str, summ: dict) -> str:
    base = summ.get("neutral", {})
    lines = [f"# E1 round{ROUND_N} ΔE00（{tag}）", "",
             "colorcheck compare（1500px・blur 2px・平坦画素）。mean = 場面ごとの mean の平均、p99 = 場面ごとの p99 の平均 / 最大。"
             "上乗せ = mean − neutral の mean（土台の差を引いた効果の分）。受入 = 白黒・周辺光量補正の変種で mean ≤ 3.0。", "",
             "| 変種 | mean | 上乗せ | p99 平均 | p99 最大（場面） | EV 差 | 受入 | " + " | ".join(SCENES) + " |",
             "|---|---|---|---|---|---|---|" + "---|" * len(SCENES)]
    for v, s in summ.items():
        cells = " | ".join(f"{s['scenes'][sc][0]:.2f} / {s['scenes'][sc][1]:.1f}" if sc in s["scenes"] else "" for sc in SCENES)
        ok = ("合格" if s["mean"] <= 3.0 else "不合格") if v in BW or v in VIG else ""
        lines.append(f"| {v} | {s['mean']:.2f} | {s['mean'] - base.get('mean', 0):+.2f} | {s['p99Mean']:.2f} | "
                     f"{s['p99Max']:.2f}（{s['worst']}） | {s['evDiff']:+.3f} | {ok} | {cells} |")
    return "\n".join(lines) + "\n"


def step_measure(args) -> None:
    variants = args.variants or VARIANTS
    jobs = [(args.tag, v, s, ref_path(s, v)) for v in variants for s in SCENES]
    with cf.ProcessPoolExecutor(max_workers=args.jobs) as ex:
        items = list(ex.map(_measure_one, jobs))
    out = OUT / "results" / f"{args.tag}.json"
    out.parent.mkdir(parents=True, exist_ok=True)
    old = json.loads(out.read_text(encoding="utf-8"))["items"] if out.exists() and args.variants else []
    keep = [r for r in old if r["variant"] not in variants]
    items = sorted(keep + items, key=lambda r: (VARIANTS.index(r["variant"]), SCENES.index(r["scene"])))
    summ = summarize(items)
    out.write_text(json.dumps({"tag": args.tag, "round": ROUND_N, "summary": summ, "items": items}, ensure_ascii=False, indent=1),
                   encoding="utf-8")
    md = measure_markdown(args.tag, summ)
    (OUT / "results" / f"{args.tag}.md").write_text(md, encoding="utf-8")
    print(md)


# ------------------------------------------------------------------ fitting frame (Python の近似描画)
#
# 当てはめは crate を毎回描かずに、crate の段の出力（probe_stage）を使って Python で近似描画して LR と比べる:
# - pre: neutral の最初の cube の入力（作業コピー × 2^baselineEV。linear ProPhoto）。ハイライト優先の周辺光量補正は
#   ここに掛かる（露出と同じ位置）ので、pre に倍率・合成を掛けて probe の --tail（ACR3 cube → linear sRGB → 出力変換）で描く
# - qin: neutral の cube Q の入力（linear ProPhoto）。白黒の灰はここから作り、--gray-table（灰 g → 出力）で描く
# - out: neutral の出力（sRGB 符号化値）。色優先・ペイントオーバーレイ・粒子はここに掛かる
# LR の書き出しと crate の枠の位置合わせは colorcheck と同じ（neutral の組で 1 回推定して全変種に使う）。
# 解析は長辺 FIT_EDGE・blur・平坦画素（colorcheck の既定を長辺に合わせて縮めたもの）。

FIT_EDGE = 1000
# 当てはめの土台にする build（`--base-tag`）: その probe と neutral の描画を使う
BASE_TAG = "before"


def probe_bin() -> Path:
    return bridge_bin(BASE_TAG, "probe_stage")


def probe_cache_dir(tag: str | None = None) -> Path:
    """Probe outputs are isolated by the build tag that produced them."""
    return E1 / "cache" / "probe" / (tag or BASE_TAG)


def read_f32_image(path: Path) -> np.ndarray:
    raw = np.fromfile(path, dtype="<u4", count=2)
    w, h = int(raw[0]), int(raw[1])
    return np.fromfile(path, dtype="<f4", offset=8).reshape(h, w, 3)


def write_f32_image(path: Path, img: np.ndarray) -> None:
    h, w = img.shape[:2]
    with open(path, "wb") as f:
        f.write(np.array([w, h], dtype="<u4").tobytes())
        f.write(np.ascontiguousarray(img, dtype="<f4").tobytes())


def ensure_probe(scene: str) -> None:
    d = probe_cache_dir()
    d.mkdir(parents=True, exist_ok=True)
    wc, meta = WC / f"{scene}.png", WC / f"{scene}.json"
    if not (d / f"pre_{scene}.f32").exists():
        subprocess.run([str(probe_bin()), "--pretone", str(wc), str(meta), str(d / f"pre_{scene}.f32")], check=True)
    if not (d / f"qin_{scene}.f32").exists():
        subprocess.run([str(probe_bin()), str(wc), str(meta), str(d / f"qin_{scene}.f32")], check=True)
    for table in ("tone", "gray"):
        if not (d / f"{table}.f32").exists():
            subprocess.run([str(probe_bin()), f"--{table}-table", str(d / f"{table}.f32")], check=True)


def gray_table() -> np.ndarray:
    """灰 g = i/4096（ProPhoto の (g,g,g)、cube Q の出力）→ 出力の sRGB 符号化値（RGB）。"""
    return np.fromfile(probe_cache_dir() / "gray.f32", dtype="<f4").reshape(-1, 3)


def tail(pre: np.ndarray) -> np.ndarray:
    """neutral の RAW の tail（crate の probe）: pre-tone linear ProPhoto → sRGB 符号化値。"""
    import tempfile
    with tempfile.TemporaryDirectory(dir=E1 / "cache") as td:
        a, b = Path(td) / "in.f32", Path(td) / "out.f32"
        write_f32_image(a, np.nan_to_num(pre, nan=0.0))
        subprocess.run([str(probe_bin()), "--tail", str(a), str(b)], check=True)
        return read_f32_image(b)


def luminance_srgb(lin: np.ndarray) -> np.ndarray:
    return lin[..., 0] * 0.2126 + lin[..., 1] * 0.7152 + lin[..., 2] * 0.0722


class FitScene:
    """1 場面の当てはめ用の枠（LR の枠に位置合わせ済み・長辺 FIT_EDGE）。"""

    def __init__(self, scene: str, variants=VARIANTS, edge: int = FIT_EDGE, blur: float = 2.0, crop: float | None = None):
        from colorcheck import align as A
        from colorcheck import color as C
        from colorcheck import imageops as IM
        from colorcheck import metrics as MET
        ensure_probe(scene)
        self.scene = scene
        pre = read_f32_image(probe_cache_dir() / f"pre_{scene}.f32")
        h0, w0 = pre.shape[:2]
        self.crate_hw = (h0, w0)
        n_w, n_h = IM.size_for_long_edge(w0, h0, edge)
        rs = lambda img: IM.resize(img, (n_w, n_h))
        pre = rs(pre)
        qin = rs(read_f32_image(probe_cache_dir() / f"qin_{scene}.f32"))
        out_lin = rs(srgb_decode(read_encoded(render_path(BASE_TAG, "neutral", scene))))
        # 作業コピーの枠の座標（中心 0・辺 ±1）。roundness の違う ρ はここから作る
        u = (np.arange(n_w) + 0.5) / n_w * 2 - 1
        v = (np.arange(n_h) + 0.5) / n_h * 2 - 1
        coords = np.stack(np.broadcast_arrays(u[None, :], v[:, None]), axis=-1).astype(np.float32)
        self.refs = {}
        for var in variants:
            ref = srgb_decode(read_encoded(ref_path(scene, var)))
            self.refs[var] = IM.resize(ref, (n_w, n_h))
        y_ref = luminance_srgb(self.refs["neutral"])
        al = A.estimate(y_ref, luminance_srgb(out_lin))
        self.alignment = al
        warp = lambda img: A.apply(img, al, y_ref.shape)
        self.pre, valid = warp(pre)
        self.qin, _ = warp(qin)
        self.out_lin, _ = warp(out_lin)
        self.coords, _ = warp(coords)
        self.frame_wh = (w0, h0)
        self.sigma = blur * max(n_w, n_h) / 1500.0
        y0, y1, x0, x1 = IM.crop_box(n_h, n_w, A.CROP if crop is None else crop)
        crop = np.zeros_like(valid)
        crop[y0:y1, x0:x1] = True
        self.valid = valid & crop
        self.C, self.IM, self.MET = C, IM, MET
        self.ref_lab = {}
        for var, ref in self.refs.items():
            self.ref_lab[var] = C.linear_srgb_to_lab(IM.gaussian_blur(ref, self.sigma))
        # 平坦画素: neutral の組の縁（LR と crate の両方）を除く。変種ごとに LR の縁も除く（measure と同じ考え方）
        cand_b, valid_b = IM.blur_masked(self.out_lin, self.valid, self.sigma)
        self.base_mask = valid_b & ~MET.edge_mask(self.ref_lab["neutral"], C.linear_srgb_to_lab(cand_b)) & self.valid
        self.masks = {var: self.base_mask & ~MET.edge_mask(lab, lab) for var, lab in self.ref_lab.items()}

    def delta_e(self, variant: str, cand_lin: np.ndarray, stats: bool = False):
        cb, vb = self.IM.blur_masked(np.nan_to_num(cand_lin), self.valid, self.sigma)
        m = self.masks[variant] & vb
        de = self.C.delta_e00(self.ref_lab[variant][m], self.C.linear_srgb_to_lab(cb[m]))
        if stats:
            return float(de.mean()), float(np.percentile(de, 99))
        return float(de.mean())


def nelder_mead(f, x0, step, iters=400, tol=1e-5, log_every=0):
    """numpy だけの Nelder–Mead（scipy が無い環境用）。"""
    n = len(x0)
    pts = [np.asarray(x0, dtype=float)]
    for i in range(n):
        x = np.array(x0, dtype=float)
        x[i] += step[i]
        pts.append(x)
    vals = [f(x) for x in pts]
    for it in range(iters):
        order = np.argsort(vals)
        pts = [pts[i] for i in order]
        vals = [vals[i] for i in order]
        if log_every and it % log_every == 0:
            log(f"  nm {it}: {vals[0]:.4f} {np.round(pts[0], 4).tolist()}")
        if abs(vals[-1] - vals[0]) < tol:
            break
        c = np.mean(pts[:-1], axis=0)
        xr = c + (c - pts[-1])
        fr = f(xr)
        if fr < vals[0]:
            xe = c + 2 * (c - pts[-1])
            fe = f(xe)
            pts[-1], vals[-1] = (xe, fe) if fe < fr else (xr, fr)
        elif fr < vals[-2]:
            pts[-1], vals[-1] = xr, fr
        else:
            xc = c + 0.5 * (pts[-1] - c)
            fc = f(xc)
            if fc < vals[-1]:
                pts[-1], vals[-1] = xc, fc
            else:
                for i in range(1, len(pts)):
                    pts[i] = pts[0] + 0.5 * (pts[i] - pts[0])
                    vals[i] = f(pts[i])
    i = int(np.argmin(vals))
    return pts[i], vals[i]


# ------------------------------------------------------------------ vignette
#
# 周辺光量補正は crate を描かずに、Lightroom の書き出しそのもの（「変種 と neutral」）から式と係数を決める（E1c #17259）:
# - neutral の表示の輝度を crate の tone の表（probe --tone-table）で pre-tone の値 v に戻し、(|x|, |y|) の格子（長辺 = x・
#   辺 = 1）× 明るさの帯ごとに Σv・Σ√v・Σy（表示の線形輝度）を積む（`vig_map`）。6 場面は同じ縦横比（3:2）なので足せる。
# - ハイライト優先で暗くする側は √v' = √v (1 − k) − VIGNETTE_ROOT_OFFSET k（k = |量|/100 × マスク）なので、
#   k = (Σ√v − Σ√v') / (Σ√v + offset·n) と格子ごとに直接出る（−50 / −60 / −100 で同じマスクになる = 式の確認）。
# - マスクは ρ（角 1）の logistic（中心 c・スケール s）＋ 角の項。変種ごとに (c, s) と、負の丸みは角の半径 R を当てはめ、
#   中心点 → c・ぼかし → (c のずれ, s)・丸み → R の表にする（crate の VIGNETTE_CENTER_* / VIGNETTE_FEATHER_* / VIGNETTE_BOX_RADIUS_MIN）。
# - 色優先は倍率 (1 − k)^γ、ペイントは表示の線形光で同じ形、明るくする側は白へ (k)^p で寄せる（`vig_law_fit`）。
# - ハイライト（HighlightContrast）は、画素の明るさごとに実効の強さ ÷ 予測（`vig_highlights`）。

def vig_settings(key: str) -> dict:
    """変種（`vig_m50` か `8/vig_m50`）の周辺光量補正の設定（manifest の XMP の値）。"""
    s = variant_settings(key)
    return {"amount": float(s["PostCropVignetteAmount"]), "midpoint": float(s["PostCropVignetteMidpoint"]),
            "feather": float(s["PostCropVignetteFeather"]), "roundness": float(s["PostCropVignetteRoundness"]),
            "style": int(s["PostCropVignetteStyle"]), "highlights": float(s.get("PostCropVignetteHighlightContrast", 0))}


class _VigSettings(dict):
    def __missing__(self, key):
        self[key] = vig_settings(key)
        return self[key]


# {変種: 設定}。今の round の変種と、round を名指しした鍵（`8/vig_m50`）を引ける
VIG_SETTINGS = _VigSettings()
VIG_GRID = 100
# neutral の表示の線形輝度の帯
VIG_TONES = ((0.004, 0.03), (0.03, 0.08), (0.08, 0.16), (0.16, 0.30), (0.30, 0.5), (0.5, 0.9))
# crate の今の係数（当てはめの初期値・比較用。effects.rs と同じ意味）
VIG_NOW = {"rootOffset": 0.033, "cornerLift": 6.0, "cornerReach": 0.024, "boxRadiusMin": 0.104,
           "center0": 0.4515, "centerSlope": 0.427, "centerCurve": 0.57,
           "featherKnots": (0.0, 20.0, 50.0, 80.0, 100.0), "featherScale": (0.0, 0.0225, 0.079, 0.125, 0.100),
           "featherShift": (0.040, -0.009, 0.0, 0.032, 0.075),
           "brightenShift": 0.73, "brightenScale": 1.12, "deepFrom": 60.0, "deepShift": 0.44, "deepScale": 1.12,
           "gammaColor": 2.2, "gammaPaint": 2.4, "brightenPower": 2.0, "brightenTarget": 1.8}


def vig_keys(style: int | None = None, dark: bool | None = None) -> list[str]:
    """両 round の周辺光量補正の変種（`8/vig_m50` の形）。"""
    out = []
    for n in ROUNDS:
        for v, s in MANIFEST[n].items():
            if "PostCropVignetteAmount" not in s or "GrainAmount" in s:
                continue
            st = vig_settings(f"{n}/{v}")
            if (style is None or st["style"] == style) and (dark is None or (st["amount"] < 0) == dark):
                out.append(f"{n}/{v}")
    return out


def tone_inverse():
    """表示の線形輝度 → pre-tone の灰（crate の neutral の tone の表の逆）。"""
    ensure_probe(SCENES[0])
    t = np.fromfile(probe_cache_dir() / "tone.f32", dtype="<f4").reshape(-1, 4)
    y = np.maximum.accumulate(luminance_srgb(srgb_decode(t[:, 1:4])))
    return lambda lum: np.interp(lum, y, t[:, 0])


def vig_map(key: str) -> np.ndarray:
    """[場面, 明るさの帯, (n, Σv, Σv', Σ√v, Σ√v', Σy, Σy'), |y| の格子, |x| の格子]（' = 変種）。"""
    n, name = split_variant(key)
    cache = E1 / "cache" / "fit" / f"vigmap_{n}_{name}.npy"
    if cache.exists():
        return np.load(cache)
    inv = tone_inverse()
    N = VIG_GRID
    acc = np.zeros((len(SCENES), len(VIG_TONES), 7, N, N), dtype=np.float32)
    for si, sc in enumerate(SCENES):
        a = srgb_decode(read_encoded(ref_path(sc, f"{n}/neutral")))
        b = srgb_decode(read_encoded(ref_path(sc, key)))
        ya, yb = luminance_srgb(a), luminance_srgb(b)
        h, w = ya.shape
        x = np.abs((np.arange(w) + .5) / w * 2 - 1)[None, :].repeat(h, 0)
        y = np.abs((np.arange(h) + .5) / h * 2 - 1)[:, None].repeat(w, 1)
        if h > w:
            x, y = y, x
        va, vb = inv(ya), inv(yb)
        k = (np.minimum((y * N).astype(int), N - 1) * N + np.minimum((x * N).astype(int), N - 1)).ravel()
        sat = (a.max(-1) - a.min(-1)) / np.maximum(a.max(-1), 1e-6)
        good = (a.max(-1) < 0.97) & (b.max(-1) < 0.97) & (sat < 0.5)
        for ti, (lo, hi) in enumerate(VIG_TONES):
            sel = ((ya >= lo) & (ya < hi) & good).ravel()
            for j, arr in enumerate((None, va, vb, np.sqrt(va), np.sqrt(vb), ya, yb)):
                acc[si, ti, j] = np.bincount(k[sel], weights=None if arr is None else arr.ravel()[sel], minlength=N * N).reshape(N, N)
    cache.parent.mkdir(parents=True, exist_ok=True)
    np.save(cache, acc)
    return acc


def vig_grid() -> tuple[np.ndarray, np.ndarray]:
    c = (np.arange(VIG_GRID) + .5) / VIG_GRID
    return np.meshgrid(c, c)      # |x|（長辺）, |y|（短辺）


def vig_rho(roundness: float, box_radius: float | None = None, aspect: float = 1.5) -> np.ndarray:
    """crate の `vignette_radius` と同じ ρ（角 1）を格子の上で。box_radius = 負の丸みの角の半径（長辺の半分に対して）。"""
    xn, yn = vig_grid()
    hw, hh = aspect, 1.0
    r = float(np.clip(roundness / 100.0, -1, 1))
    if r >= 0:
        circle = np.sqrt((hw * hw + hh * hh) / 2)
        sx, sy = 1 + (hw / circle - 1) * r, 1 + (hh / circle - 1) * r
        return np.sqrt((xn * sx) ** 2 + (yn * sy) ** 2) / np.sqrt(sx * sx + sy * sy)
    corner = hw * (1 - (1 - VIG_NOW["boxRadiusMin"]) * -r if box_radius is None else box_radius)
    rx, ry = min(corner, hw), min(corner, hh)
    qx, qy = (xn * hw - (hw - rx)) / rx, (yn * hh - (hh - ry)) / ry
    return (np.sqrt(np.maximum(qx, 0) ** 2 + np.maximum(qy, 0) ** 2) + np.minimum(np.maximum(qx, qy), 0)) / np.sqrt(2)


def vig_logistic(rho: np.ndarray, center: float, scale: float, c: dict = VIG_NOW) -> np.ndarray:
    """crate の `vignette_mask`（logistic ＋ 角の項を、中心 0・角 1 に伸ばしたもの）。"""
    at = lambda r: 1 / (1 + np.exp(-np.clip((r - center) / max(scale, 1e-9) + c["cornerLift"] * np.exp(-(1 - r) / c["cornerReach"]), -60, 60)))
    floor, top = at(0.0), at(1.0)
    return np.clip((at(np.clip(rho, 0, 1)) - floor) / (top - floor), 0, 1) if top > floor else np.zeros_like(rho)


def vig_falloff(v: dict, c: dict = VIG_NOW) -> tuple[float, float]:
    """設定 → (中心, スケール)（crate の `vignette_falloff`。明るくする側と −60 より深い量は外へずれて広がる）。"""
    m = float(np.clip(v["midpoint"] / 100, 0, 1))
    scale = float(np.interp(v["feather"], c["featherKnots"], c["featherScale"]))
    center = (c["center0"] + c["centerSlope"] * m + c["centerCurve"] * max(m - 0.5, 0) ** 2
              + float(np.interp(v["feather"], c["featherKnots"], c["featherShift"])))
    if v["amount"] > 0:
        return center + c["brightenShift"] * scale, scale * c["brightenScale"]
    deep = float(np.clip((-v["amount"] - c["deepFrom"]) / (100 - c["deepFrom"]), 0, 1))
    return center + c["deepShift"] * scale * deep, scale * (1 + (c["deepScale"] - 1) * deep)


def vig_strength(key: str, tones=(1, 2, 3, 4), offset: float | None = None, without: int | None = None) -> tuple[np.ndarray, np.ndarray]:
    """ハイライト優先・暗くする側の強さ k（格子）と重み（画素数）: (Σ√v − Σ√v') / (Σ√v + offset·n)。
    without = 除く場面の番号（leave-one-out）。"""
    offset = VIG_NOW["rootOffset"] if offset is None else offset
    m = vig_map(key).astype(np.float64)
    if without is not None:
        m = np.delete(m, without, axis=0)
    s = m.sum(axis=0)[list(tones)].sum(axis=0)
    n, x, y = s[0], s[3], s[4]
    with np.errstate(all="ignore"):
        k = (x - y) / (x + offset * n)
    return np.nan_to_num(k), np.where(n > 300, n, 0.0)


def _ev_of_strength(k: np.ndarray, offset: float) -> np.ndarray:
    """強さ k を √v = 0.4（v = 0.16）の画素の EV に直す（残差を EV で数えるため）。"""
    return 2 * np.log2(np.maximum((1 - np.clip(k, 0, 1.2)) - offset * np.clip(k, 0, 1.2) / 0.4, 2 ** -3.5))


def vig_profile_fit(key: str, iters: int = 500, without: int | None = None) -> dict:
    """変種 1 つに logistic の (中心, スケール) と、負の丸みなら角の半径を当てはめる（残差は EV の RMS）。"""
    v = VIG_SETTINGS[key]
    a = -v["amount"] / 100
    k_obs, w = vig_strength(key, tones=(1, 2, 3) if v["highlights"] else (1, 2, 3, 4), without=without)
    off = VIG_NOW["rootOffset"]
    ev_obs = _ev_of_strength(k_obs, off)
    negative = v["roundness"] < 0

    def loss(x):
        if x[1] <= 1e-4 or (negative and not 0.03 < x[2] < 1.0):
            return 9.0
        rho = vig_rho(v["roundness"], x[2] if negative else None)
        e = _ev_of_strength(a * vig_logistic(rho, x[0], x[1]), off) - ev_obs
        return float(np.sqrt((w * e * e).sum() / w.sum()))

    c0, s0 = vig_falloff(v)
    x0 = [c0, max(s0, 0.004)] + ([1 - (1 - VIG_NOW["boxRadiusMin"]) * -v["roundness"] / 100] if negative else [])
    x, val = nelder_mead(loss, x0, [.03, .01] + ([.05] if negative else []), iters=iters, tol=1e-7)
    now = loss(x0)
    out = {"center": float(x[0]), "scale": float(x[1]), "rmsEv": val, "rmsEvNow": now, "centerNow": c0, "scaleNow": s0}
    if negative:
        out.update({"boxRadius": float(x[2]), "boxRadiusNow": x0[2]})
    return out


def vig_law_fit(key: str, kind: str) -> dict:
    """ほかのスタイル / 明るくする側の法則を、マスクの (中心, スケール) と一緒に当てはめる。
    kind: `gain`（pre-tone の倍率 (1 − k)^g）・`paint`（表示の線形光で同じ）・`blend`（pre-tone で白へ k^p 寄せる。目標 T）・
    `paint-blend`（表示の線形光で白へ）。"""
    v = VIG_SETTINGS[key]
    a = abs(v["amount"]) / 100
    s = vig_map(key).astype(np.float64).sum(axis=0)[[1, 2, 3, 4]]
    n, ok = s[:, 0], s[:, 0] > 200
    xin, xout = (s[:, 5], s[:, 6]) if kind.startswith("paint") else (s[:, 1], s[:, 2])
    rho = vig_rho(v["roundness"])
    with np.errstate(all="ignore"):
        ev_obs = np.where(ok, np.log2(xout / xin), 0)
    names = {"gain": ("g", "center", "scale"), "paint": ("g", "center", "scale"), "blend": ("p", "target", "center", "scale"),
             "paint-blend": ("p", "center", "scale")}[kind]

    def loss(x):
        p = dict(zip(names, x))
        if min(x) <= 0:
            return 9.0
        k = a * vig_logistic(rho, p["center"], p["scale"])[None]
        if kind in ("gain", "paint"):
            out = xin * np.maximum(1 - k, 1e-6) ** p["g"]
        else:
            wgt = np.minimum(k ** p["p"], 1.0)
            out = xin * (1 - wgt) + wgt * p.get("target", 1.0) * n
        with np.errstate(all="ignore"):
            e = np.where(ok, np.clip(np.log2(np.maximum(out, 1e-9) / xin), -6, 6) - np.clip(ev_obs, -6, 6), 0)
        return float(np.sqrt((n * ok * e * e).sum() / (n * ok).sum()))

    c0, s0 = vig_falloff(v)
    now = VIG_NOW
    x0 = {"gain": [now["gammaColor"], c0, s0], "paint": [now["gammaPaint"], c0, s0],
          "blend": [now["brightenPower"], now["brightenTarget"] if v["style"] == 1 else 1.0, c0, s0],
          "paint-blend": [now["brightenPower"], c0, s0]}[kind]
    x, val = nelder_mead(loss, x0, [0.1 * abs(t) + 0.005 for t in x0], iters=600, tol=1e-7)
    return {**dict(zip(names, (float(t) for t in x))), "rmsEv": val, "rmsEvNow": loss(x0)}


def vig_highlights(key: str) -> dict:
    """ハイライト: 画素の明るさ（pre-tone の輝度）ごとの「実効の強さ ÷ |量|/100 × マスク」（マスクの帯の平均）。"""
    import cv2
    n, _ = split_variant(key)
    v = VIG_SETTINGS[key]
    a, off = -v["amount"] / 100, VIG_NOW["rootOffset"]
    inv = tone_inverse()
    center, scale = vig_falloff(v)
    edges = np.array([.03, .06, .1, .15, .2, .25, .3, .36, .42, .5, .58, .66, .75, .85, .95])
    acc = np.zeros((len(edges) - 1, 4))
    for sc in SCENES:
        A = cv2.GaussianBlur(srgb_decode(read_encoded(ref_path(sc, f"{n}/neutral"))), (0, 0), 1.0)
        B = cv2.GaussianBlur(srgb_decode(read_encoded(ref_path(sc, key))), (0, 0), 1.0)
        h, w = A.shape[:2]
        x = ((np.arange(w) + .5) / w * 2 - 1)[None, :]
        y = ((np.arange(h) + .5) / h * 2 - 1)[:, None]
        m = vig_logistic(np.sqrt((x * x + y * y) / 2), center, scale)
        va, vb = inv(luminance_srgb(A)), inv(luminance_srgb(B))
        ok = (A.max(-1) < .985) & (m > 0.2)
        for i in range(len(edges) - 1):
            sel = ok & (va >= edges[i]) & (va < edges[i + 1])
            acc[i] += [np.sqrt(va[sel]).sum(), np.sqrt(vb[sel]).sum(), m[sel].sum(), sel.sum()]
    out = {}
    for i in range(len(edges) - 1):
        sa, sb, sm, cnt = acc[i]
        if cnt > 5000:
            out[f"{(edges[i] + edges[i + 1]) / 2:.3f}"] = float(((sa - sb) / (sa + off * cnt)) / (a * sm / cnt))
    return out


def step_vig_fit(args) -> None:
    """周辺光量補正の式と係数を、両 round の書き出しから出す（`fit/vig.json`。係数は目で見て effects.rs に写す）。"""
    out = {"profiles": {}, "laws": {}, "highlights": {}}
    log("ハイライト優先・暗くする側: 変種ごとの logistic（中心 c・スケール s・負の丸みの角の半径 R）。今 = crate の今の係数")
    for key in vig_keys(style=1, dark=True):
        r = vig_profile_fit(key, iters=args.iters)
        out["profiles"][key] = {**VIG_SETTINGS[key], **r}
        v = VIG_SETTINGS[key]
        log(f"  {key:24s} 量 {v['amount']:5.0f} 中心点 {v['midpoint']:3.0f} ぼかし {v['feather']:3.0f} 丸み {v['roundness']:4.0f}: "
            f"c {r['center']:.4f}（今 {r['centerNow']:.4f}） s {r['scale']:.4f}（今 {r['scaleNow']:.4f}）"
            + (f" R {r['boxRadius']:.3f}（今 {r['boxRadiusNow']:.3f}）" if "boxRadius" in r else "")
            + f"  残差 {r['rmsEv']:.3f} EV（今の係数 {r['rmsEvNow']:.3f}）")
        if args.loo:
            # 場面を 1 つずつ抜いて当てはめ直したときの係数の幅（過学習の目安）
            fits = [vig_profile_fit(key, iters=args.iters, without=i) for i in range(len(SCENES))]
            spread = {k: [min(f[k] for f in fits), max(f[k] for f in fits)] for k in ("center", "scale", "boxRadius") if k in r}
            out["profiles"][key]["loo"] = spread
            log("      LOO（場面を 1 つ抜く）: " + " ".join(f"{k} {lo:.4f}〜{hi:.4f}" for k, (lo, hi) in spread.items()))
    log("ほかの法則（倍率の指数 g・明るくする側の指数 p と目標 T・マスクの中心とスケール）")
    for key in vig_keys():
        v = VIG_SETTINGS[key]
        kind = (("gain" if v["style"] == 2 else "paint") if v["amount"] < 0 else ("paint-blend" if v["style"] == 3 else "blend"))
        if v["style"] == 1 and v["amount"] < 0:
            continue
        r = vig_law_fit(key, kind)
        out["laws"][key] = {**v, "kind": kind, **r}
        log(f"  {key:24s} {kind:11s} " + " ".join(f"{k} {val:.4f}" for k, val in r.items()))
    for key in vig_keys(style=1, dark=True):
        if VIG_SETTINGS[key]["highlights"]:
            out["highlights"][key] = vig_highlights(key)
            log(f"  ハイライト {key}: 明るさ（pre-tone の輝度）→ 実効の強さ ÷ 予測 " +
                " ".join(f"{k}:{val:.2f}" for k, val in out["highlights"][key].items()))
    path = E1 / "fit" / "vig.json"
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(out, ensure_ascii=False, indent=1), encoding="utf-8")
    log(f"-> {path}")


# ------------------------------------------------------------------ black & white
#
# 白黒ミックスはトーンカーブの前の倍率（E1c #17259）: g = max(1 + f·s, 0)^2、f = Σ_b w_b(h)·k_b、k_b = 帯の強さ
# （明るくする側 brighten_b・暗くする側 −darken_b）× (|mix_b|/100)^shape、s = pre-tone の HSV の彩度。当てはめは probe の
# pre-tone の画像に g を掛けて ACR3 の曲線（probe --acr3 で取った 1D の曲線を numpy で当てる）→ 輝度 → 灰の出力で LR と比べる。

PP_LUMA = np.array([0.2880402, 0.7118741, 0.0000857], dtype=np.float32)
HSL_CENTERS = np.array([359.990, 29.883, 55.251, 95.283, 160.041, 229.730, 275.113, 329.638])
# crate の今の係数（color_ops.rs の GRAY_MIX_*）
BW_NOW = {"brighten": (0.90, 0.90, 0.90, 0.85, 0.85, 1.30, 1.00, 1.00), "darken": (1.45, 1.45, 1.45, 1.55, 1.55, 1.75, 1.15, 1.15),
          "brightenShape": 1.0, "darkenShape": 1.35}
# 当てはめで 1 つの値にまとめる帯（画素の少ない帯は隣と同じ値にする）: 暖色 / 緑 / 青 / 紫
BW_GROUPS = ((0, 1, 2), (3, 4), (5,), (6, 7))
BW_FIT_VARIANTS = ("8/bw_warm", "8/bw_cool", "9/bw_all_p100", "9/bw_all_m100")


def wrap180(d):
    return np.mod(d + 180.0, 360.0) - 180.0


def rgb_to_hsv(rgb: np.ndarray):
    """crate の rgb_to_hsv（色相は度）。"""
    r, g, b = rgb[..., 0], rgb[..., 1], rgb[..., 2]
    mx = np.maximum(r, np.maximum(g, b))
    mn = np.minimum(r, np.minimum(g, b))
    d = mx - mn
    ds = np.where(d == 0, 1.0, d)
    rc, gc, bc = (mx - r) / ds, (mx - g) / ds, (mx - b) / ds
    h = np.where(mx == r, bc - gc, np.where(mx == g, 2.0 + rc - bc, 4.0 + gc - rc))
    h = np.where(d == 0, 0.0, h)
    h = np.mod(h / 6.0, 1.0)
    s = np.where(mx > 0, d / np.where(mx > 0, mx, 1), 0.0)
    return h * 360.0, s, mx


def band_weights(h: np.ndarray) -> np.ndarray:
    """crate の hsl_band_weight を 8 帯ぶん（[..., 8]）。"""
    n = len(HSL_CENTERS)
    out = np.zeros(h.shape + (n,), dtype=np.float64)
    for o in range(n):
        c = HSL_CENTERS[o]
        d_prev = wrap180(HSL_CENTERS[(o + n - 1) % n] - c)
        d_next = wrap180(HSL_CENTERS[(o + 1) % n] - c)
        dh = wrap180(h - c)
        left = (dh >= d_prev) & (dh <= 0)
        right = (dh >= 0) & (dh <= d_next)
        out[..., o] = np.where(left, np.cos(dh / d_prev * np.pi / 2) ** 2,
                               np.where(right, np.cos(dh / d_next * np.pi / 2) ** 2, 0.0))
    return out


def gray_encoded(gray: np.ndarray) -> np.ndarray:
    """cube Q の出力の灰 g → 出力の sRGB 符号化値（probe の --gray-table を線形補間）。"""
    t = gray_table()
    x = np.clip(gray, 0, 1) * (len(t) - 1)
    i = np.clip(np.floor(x).astype(np.int64), 0, len(t) - 2)
    w = (x - i)[..., None]
    return t[i] + (t[i + 1] - t[i]) * w


def bw_mix(key: str) -> np.ndarray:
    """変種（`bw_warm` か `8/bw_warm`）の白黒ミックス（8 帯。manifest の GrayMixer*）。"""
    s = variant_settings(key)
    return np.array([float(s.get(f"GrayMixer{b}", 0)) for b in BANDS], dtype=np.float64)


class _BwMix(dict):
    def __missing__(self, key):
        self[key] = bw_mix(key)
        return self[key]


BW_MIX = _BwMix()


def acr3_curve() -> np.ndarray:
    """ACR3 の既定カーブの 1D の形（灰の ramp を probe --acr3 に通したもの。crate の数値は読まない）。"""
    path = probe_cache_dir() / "acr3.f32"
    if not path.exists():
        path.parent.mkdir(parents=True, exist_ok=True)
        n = 4097
        ramp = np.repeat((np.arange(n) / (n - 1))[None, :, None], 3, axis=2).astype(np.float32)
        write_f32_image(path.with_suffix(".in"), ramp)
        subprocess.run([str(probe_bin()), "--acr3", str(path.with_suffix(".in")), str(path)], check=True)
        path.with_suffix(".in").unlink()
    return read_f32_image(path)[0, :, 1].astype(np.float64)


def rgb_tone(v: np.ndarray, curve: np.ndarray) -> np.ndarray:
    """crate の `rgb_tone`（色相を保つ: 最大と最小のチャンネルを曲線に通し、中間は同じ割合で補間）。"""
    v = np.clip(v, 0, 1)
    t = lambda x: np.interp(x, np.linspace(0, 1, len(curve)), curve)
    hi, lo = v.max(-1, keepdims=True), v.min(-1, keepdims=True)
    thi, tlo = t(hi), t(lo)
    den = np.where(hi - lo > 0, hi - lo, 1)
    return np.where(hi - lo > 0, tlo + (thi - tlo) * (v - lo) / den, thi)


class BwScene:
    """白黒の当てはめ用: pre-tone（neutral）に倍率を掛けて ACR3 → 灰 → 出力（--gray-table）→ blur → LR と比べる。"""

    def __init__(self, scene: str, variants=BW_FIT_VARIANTS, stride: int = 2):
        fs = FitScene(scene, variants=("neutral", *variants))
        self.scene, self.fs, self.variants = scene, fs, variants
        self.pre = np.clip(np.nan_to_num(fs.pre).astype(np.float64), 0, None)
        self.curve = acr3_curve()
        h, s, _ = rgb_to_hsv(np.clip(self.pre, 1e-9, None))
        self.h, self.s = h, s
        self.bands = band_weights(h)
        sub = np.zeros_like(fs.valid)
        sub[::stride, ::stride] = True
        self.sub = sub

    def gray(self, mix: np.ndarray, c: dict) -> np.ndarray:
        m = mix / 100.0
        k = np.where(m >= 0, np.asarray(c["brighten"]) * np.abs(m) ** c["brightenShape"],
                     -np.asarray(c["darken"]) * np.abs(m) ** c["darkenShape"])
        g = np.clip(1 + (self.bands @ k) * self.s, 0, None) ** 2
        return np.clip(rgb_tone(self.pre * g[..., None], self.curve) @ PP_LUMA.astype(np.float64), 0, 1)

    def loss(self, variant: str, c: dict, stats: bool = False):
        from colorcheck import color as C
        fs = self.fs
        lin = srgb_decode(gray_encoded(self.gray(BW_MIX[variant], c)))
        cb, vb = fs.IM.blur_masked(lin, fs.valid, fs.sigma)
        m = fs.masks[variant] & vb & self.sub
        de = C.delta_e00(fs.ref_lab[variant][m], C.linear_srgb_to_lab(cb[m]))
        return (float(de.mean()), float(np.percentile(de, 99))) if stats else float(de.mean())


def bw_eval(scenes, c, variants=BW_FIT_VARIANTS) -> dict:
    out = {}
    for v in variants:
        rs = [sc.loss(v, c, stats=True) for sc in scenes]
        out[v] = {"mean": float(np.mean([r[0] for r in rs])), "p99": float(np.mean([r[1] for r in rs])),
                  "scenes": {sc.scene: [round(r[0], 3), round(r[1], 2)] for sc, r in zip(scenes, rs)}}
    return out


def bw_coeffs(x) -> dict:
    """当てはめの変数（群ごとの明 4 つ・暗 4 つ・shape 2 つ）→ 8 帯の係数。"""
    brighten, darken = np.zeros(8), np.zeros(8)
    for gi, g in enumerate(BW_GROUPS):
        brighten[list(g)] = x[gi]
        darken[list(g)] = x[len(BW_GROUPS) + gi]
    return {"brighten": brighten.tolist(), "darken": darken.tolist(), "brightenShape": float(x[-2]), "darkenShape": float(x[-1])}


# ------------------------------------------------------------------ grain

GRAIN_BANDS = np.array([0.0, 0.08, 0.16, 0.25, 0.35, 0.45, 0.55, 0.65, 0.75, 0.85, 0.93, 1.0])
LUMA709 = np.array([0.2126, 0.7152, 0.0722], dtype=np.float32)


def acf_halfwidth(r: np.ndarray, mask: np.ndarray) -> tuple[float, np.ndarray]:
    """残差の自己相関（2D・FFT）の動径平均が 0.5 に落ちる半径（画素）と、その動径平均（0〜16 画素）。"""
    x = np.where(mask, r - r[mask].mean(), 0.0).astype(np.float64)
    h, w = x.shape
    F = np.fft.rfft2(x, s=(2 * h, 2 * w))
    ac = np.fft.irfft2(np.abs(F) ** 2, s=(2 * h, 2 * w))
    m = np.fft.irfft2(np.abs(np.fft.rfft2(mask.astype(np.float64), s=(2 * h, 2 * w))) ** 2, s=(2 * h, 2 * w))
    ac = ac / np.maximum(m, 1.0)
    ac = ac / ac[0, 0]
    R = 17
    yy, xx = np.mgrid[-R:R + 1, -R:R + 1]
    patch = ac[np.ix_(np.arange(-R, R + 1) % (2 * h), np.arange(-R, R + 1) % (2 * w))]
    rr = np.hypot(yy, xx)
    prof = np.array([patch[(rr >= k - 0.5) & (rr < k + 0.5)].mean() for k in range(0, 17)])
    return halfwidth_of(prof), prof


def halfwidth_of(prof: np.ndarray) -> float:
    """動径平均の自己相関が 0.5 に落ちる半径（画素。線形補間）。"""
    below = np.flatnonzero(prof < 0.5)
    if len(below) == 0:
        return float("nan")
    k = below[0]
    return float((k - 1) + (prof[k - 1] - 0.5) / (prof[k - 1] - prof[k])) if k > 0 else 0.0


GRAIN_TILE = 128
GRAIN_TILES = 16


def flat_tiles(yn: np.ndarray, tile: int = GRAIN_TILE, keep: int = GRAIN_TILES) -> list:
    """中間調で像の細部の少ないタイル（左上の y, x）。Lightroom は粒子のサイズが大きいと像そのものも少しぼかすので、
    細部のある所の「粒子あり − neutral」には像のぼけの差が混ざる（round9: size 50 以上で半値幅が 2〜3 割小さく、
    sd が 1〜4 割大きく出る）。粒そのものは平坦な所で測る。"""
    import cv2
    h, w = yn.shape
    hp = yn - cv2.GaussianBlur(yn, (0, 0), 3)
    found = []
    for y in range(0, h - tile + 1, tile):
        for x in range(0, w - tile + 1, tile):
            t = yn[y:y + tile, x:x + tile]
            if 0.25 < t.mean() < 0.75 and t.min() > 0.05 and t.max() < 0.95:
                found.append((float(hp[y:y + tile, x:x + tile].std() + 3 * cv2.blur(t, (tile // 4, tile // 4)).std()), y, x))
    found.sort()
    return [(y, x) for _, y, x in found[:keep]]


def grain_stats_flat(neutral_enc: np.ndarray, variant_enc: np.ndarray, tiles: list | None = None) -> dict:
    """平坦なタイル（`flat_tiles`）だけで測った残差の輝度の sd と自己相関の半値幅（タイルの平均）。"""
    yn = neutral_enc @ LUMA709
    ry = (variant_enc - neutral_enc) @ LUMA709
    tiles = flat_tiles(yn) if tiles is None else tiles
    if not tiles:
        return {"sd": float("nan"), "halfWidth": float("nan"), "acf": [], "tiles": 0}
    full = np.ones((GRAIN_TILE, GRAIN_TILE), bool)
    variances, profs = [], []
    for y, x in tiles:
        t = ry[y:y + GRAIN_TILE, x:x + GRAIN_TILE]
        variances.append(float(t.var()))
        profs.append(acf_halfwidth(t, full)[1] * variances[-1])
    prof = np.sum(profs, axis=0) / max(np.sum(variances), 1e-12)
    return {"sd": float(np.sqrt(np.mean(variances))), "halfWidth": halfwidth_of(prof), "acf": [round(float(v), 4) for v in prof],
            "tiles": len(tiles)}


def grain_stats(neutral_enc: np.ndarray, variant_enc: np.ndarray) -> dict:
    """「効果あり − neutral」の残差（sRGB 符号化値）の統計。"""
    yn = neutral_enc @ LUMA709
    r = variant_enc - neutral_enc
    ry = r @ LUMA709
    # 彩度の揺れ: 輝度の残差を引いた各チャンネルの残差
    chroma = r - ry[..., None]
    ok = (neutral_enc.min(axis=-1) > 0.01) & (neutral_enc.max(axis=-1) < 0.99)
    bands = []
    for lo, hi in zip(GRAIN_BANDS[:-1], GRAIN_BANDS[1:]):
        m = ok & (yn >= lo) & (yn < hi)
        if m.sum() < 2000:
            bands.append(None)
            continue
        bands.append({"lo": float(lo), "hi": float(hi), "n": int(m.sum()), "sd": float(ry[m].std()), "mean": float(ry[m].mean()),
                      "chromaSd": float(np.sqrt((chroma[m] ** 2).mean(axis=0)).mean())})
    mid = ok & (yn >= 0.25) & (yn < 0.75)
    # 自己相関は中間調の画素で（明るさの帯ごとの強さの違いを混ぜないよう、帯の sd で割ってから）
    norm = np.zeros_like(ry)
    for b, (lo, hi) in zip(bands, zip(GRAIN_BANDS[:-1], GRAIN_BANDS[1:])):
        if b:
            m = (yn >= lo) & (yn < hi)
            norm[m] = (ry[m] - b["mean"]) / max(b["sd"], 1e-6)
    hw, prof = acf_halfwidth(norm, mid)
    return {"sdMid": float(ry[mid].std()), "meanMid": float(ry[mid].mean()), "chromaSdMid": float(np.sqrt((chroma[mid] ** 2).mean(axis=0)).mean()),
            "halfWidth": hw, "acf": [round(float(v), 4) for v in prof], "bands": bands}


def grain_variants(n: int) -> dict:
    """round の粒子だけの変種 {変種: (量, サイズ, 粗さ)}（白黒などと重ねた film_bw は除く）。"""
    out = {}
    for v, s in MANIFEST[n].items():
        if "GrainAmount" in s and not _is_bw(s) and "PostCropVignetteAmount" not in s:
            out[v] = (float(s["GrainAmount"]), float(s["GrainSize"]), float(s["GrainFrequency"]))
    return out


GRAIN_VARIANTS = grain_variants(ROUND_N) or {"grain_30": (30, 25, 50), "grain_60": (60, 50, 70), "grain_100": (100, 10, 20)}


def grain_field(w: int, h: int, size: float, roughness: float, seed: int, tag: str = "before") -> np.ndarray:
    import tempfile
    with tempfile.TemporaryDirectory(dir=E1 / "cache") as td:
        out = Path(td) / "g.f32"
        subprocess.run([str(bridge_bin(tag, "probe_stage")), "--grain-field", str(w), str(h), str(size), str(roughness),
                        str(seed), str(out)], check=True)
        return np.fromfile(out, dtype="<f4", offset=8).reshape(h, w)


def grain_moments(neutral_enc: np.ndarray, r: np.ndarray, center: int = 2048) -> dict:
    """残差（sRGB 符号化値、RGB）の帯ごとの sd・平均・歪度、中間調の彩度の揺れ（灰色の画素）、中央の自己相関の半値幅。"""
    yn = neutral_enc @ LUMA709
    ry = r @ LUMA709
    ok = (neutral_enc.min(axis=-1) > 0.01) & (neutral_enc.max(axis=-1) < 0.99)
    sat = neutral_enc.max(axis=-1) - neutral_enc.min(axis=-1)
    bands = []
    for lo, hi in zip(GRAIN_BANDS[:-1], GRAIN_BANDS[1:]):
        m = ok & (yn >= lo) & (yn < hi)
        if m.sum() < 5000:
            bands.append(None)
            continue
        v = ry[m].astype(np.float64)
        mu, sd = v.mean(), v.std()
        bands.append({"lo": float(lo), "hi": float(hi), "n": int(m.sum()), "sd": float(sd), "mean": float(mu),
                      "skew": float(((v - mu) ** 3).mean() / max(sd, 1e-9) ** 3)})
    gray = ok & (sat < 0.03) & (yn > 0.2) & (yn < 0.8)
    chroma = r - ry[..., None]
    h, w = yn.shape
    y0, x0 = max((h - center) // 2, 0), max((w - center) // 2, 0)
    sl = (slice(y0, y0 + center), slice(x0, x0 + center))
    norm = np.zeros_like(ry)
    for b in bands:
        if b:
            m = (yn >= b["lo"]) & (yn < b["hi"])
            norm[m] = (ry[m] - b["mean"]) / max(b["sd"], 1e-6)
    mid = ok & (yn >= 0.2) & (yn < 0.8)
    hw, prof = acf_halfwidth(norm[sl], mid[sl])
    return {"sdMid": float(ry[mid].std()), "meanMid": float(ry[mid].mean()),
            "chromaGray": float(np.sqrt((chroma[gray] ** 2).mean())) if gray.sum() > 1000 else None,
            "lumaGray": float(ry[gray].std()) if gray.sum() > 1000 else None,
            "halfWidth": hw, "acf": [round(float(v), 4) for v in prof], "bands": bands}


def env_probe_build(src_tag: str = "before") -> None:
    """粒子の当てはめ用の probe（計測専用。提案の diff には入れない）: `effects.rs` の粒子の定数を環境変数
    （NIHO_GRAIN_EVEN_CELL / CLUMP_CELL = 格子の間隔（長辺比）・EVEN_WEIGHT・BOOST_CELL・FOOT）で上書きできるようにして組む。"""
    src = build_dir(src_tag) / "src"
    dst = build_dir("probeenv") / "src"
    if dst.exists():
        shutil.rmtree(dst)
    shutil.copytree(src, dst)
    f = dst / "crates" / "niho-develop" / "src" / "effects.rs"
    t = f.read_text(encoding="utf-8")
    edits = (
        ("use std::collections::VecDeque;", "use std::collections::VecDeque;\n\nfn env_f64(k: &str, d: f64) -> f64 {\n"
         "    std::env::var(k).ok().and_then(|v| v.parse().ok()).unwrap_or(d)\n}"),
        ("let half = GRAIN_PIXEL_FOOTPRINT / 2.0;", "let foot = env_f64(\"NIHO_GRAIN_FOOT\", GRAIN_PIXEL_FOOTPRINT);\n        let half = foot / 2.0;"),
        ("libm::ceil(GRAIN_PIXEL_FOOTPRINT / step)", "libm::ceil(foot / step)"),
        ("(step / GRAIN_PIXEL_FOOTPRINT\n", "(step / foot\n"),
        ("GRAIN_EVEN_WEIGHT * (1.0 - r),", "env_f64(\"NIHO_GRAIN_EVEN_WEIGHT\", GRAIN_EVEN_WEIGHT) * (1.0 - r),"),
        ("let cell = at_0 + (at_100 - at_0) * shape;", "let cell = env_f64(if octave == 0 { \"NIHO_GRAIN_EVEN_CELL\" } else { \"NIHO_GRAIN_CLUMP_CELL\" }, "
         "at_0 + (at_100 - at_0) * shape);"),
        ("let fine = GRAIN_FINE_BOOST_CELL / cell;", "let fine = env_f64(\"NIHO_GRAIN_BOOST_CELL\", GRAIN_FINE_BOOST_CELL) / cell;"),
    )
    for old, new in edits:
        if t.count(old) != 1:
            raise SystemExit(f"env_probe_build: `{old.strip()}` が effects.rs に {t.count(old)} 個（式が変わった）")
        t = t.replace(old, new)
    f.write_text(t, encoding="utf-8")
    env = dict(os.environ, CARGO_TARGET_DIR=str(E1 / "crate-target" / "probeenv"), CARGO_INCREMENTAL="0")
    subprocess.run(["cargo", "build", "--release", "-p", "niho-develop", "--example", "probe_stage", "-j", "3"], cwd=dst, check=True, env=env)


def grain_field_env(w: int, h: int, size: float, roughness: float, seed: int, c: dict) -> np.ndarray:
    import tempfile
    env = dict(os.environ)
    for k, name in (("evenCell", "NIHO_GRAIN_EVEN_CELL"), ("clumpCell", "NIHO_GRAIN_CLUMP_CELL"), ("evenWeight", "NIHO_GRAIN_EVEN_WEIGHT"),
                    ("boostCell", "NIHO_GRAIN_BOOST_CELL"), ("foot", "NIHO_GRAIN_FOOT")):
        if k in c:
            env[name] = repr(float(c[k]))
    with tempfile.TemporaryDirectory(dir=E1 / "cache") as td:
        out = Path(td) / "g.f32"
        subprocess.run([str(bridge_bin("probeenv", "probe_stage")), "--grain-field", str(w), str(h), str(size), str(roughness),
                        str(seed), str(out)], check=True, env=env)
        return np.fromfile(out, dtype="<f4", offset=8).reshape(h, w)


# ------------------------------------------------------------------ steps (fit / stats / page)

def step_bw_fit(args) -> None:
    """白黒ミックス: 帯の群ごとの強さ（明 / 暗）と shape を、round8 の bw_warm / bw_cool と round9 の全色 ±100 に当てはめる
    （`fit/bw.json`。`--loo` で場面の leave-one-out）。"""
    scenes = [BwScene(s) for s in SCENES]
    ng = len(BW_GROUPS)
    x0 = ([BW_NOW["brighten"][g[0]] for g in BW_GROUPS] + [BW_NOW["darken"][g[0]] for g in BW_GROUPS]
          + [BW_NOW["brightenShape"], BW_NOW["darkenShape"]])

    def fit(sc, start, iters):
        def f(x):
            if min(x) < 0 or max(x[:2 * ng]) > 6 or not (0.4 < x[-2] < 3 and 0.4 < x[-1] < 3):
                return 99.0
            c = bw_coeffs(x)
            return float(np.mean([np.mean([b.loss(v, c) for b in sc]) for v in BW_FIT_VARIANTS]))
        return nelder_mead(f, start, [.1] * (2 * ng) + [.1, .15], iters=iters, tol=1e-4)

    now = bw_eval(scenes, BW_NOW)
    x, _ = fit(scenes, x0, args.iters)
    c = bw_coeffs(x)
    after = bw_eval(scenes, c)
    loo = []
    if args.loo:
        for i, s in enumerate(SCENES):
            xi, _ = fit(scenes[:i] + scenes[i + 1:], list(x), max(args.iters // 2, 15))
            held = bw_eval([scenes[i]], bw_coeffs(xi))
            loo.append({"scene": s, "coeffs": bw_coeffs(xi), "held": {v: round(held[v]["mean"], 3) for v in held},
                        "all": {v: after[v]["scenes"][s][0] for v in BW_FIT_VARIANTS}})
    out = E1 / "fit" / "bw.json"
    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_text(json.dumps({"coeffs": c, "now": now, "after": after, "loo": loo}, ensure_ascii=False, indent=1), encoding="utf-8")
    log(f"bw GRAY_MIX_BRIGHTEN {np.round(c['brighten'], 3).tolist()} GRAY_MIX_DARKEN {np.round(c['darken'], 3).tolist()} "
        f"shape {c['brightenShape']:.3f} / {c['darkenShape']:.3f}")
    for v in BW_FIT_VARIANTS:
        log(f"  {v:16s} 今の係数 {now[v]['mean']:.2f} / {now[v]['p99']:.1f} -> 当てはめ {after[v]['mean']:.2f} / {after[v]['p99']:.1f}")
    for r in loo:
        log(f"  LOO {r['scene']}: held {r['held']} (all-fit {r['all']})")


def grain_targets() -> dict:
    """LR の粒子（平坦なタイル・2560px）の sd と半値幅: {(量, サイズ, 粗さ): (sd, hw)}（両 round・場面の平均）。"""
    out = {}
    for n in ROUNDS:
        for v, key in grain_variants(n).items():
            rs = [grain_stats_flat(read_encoded(ref_path(sc, f"{n}/neutral")), read_encoded(ref_path(sc, f"{n}/{v}"))) for sc in SCENES]
            out[key] = (float(np.nanmean([r["sd"] for r in rs])), float(np.nanmean([r["halfWidth"] for r in rs])))
    return out


def grain_lattice_table(cells) -> list[dict]:
    """格子 1 枚（間隔 cell px・boost なし・2560px）の場の分散と自己相関（probe の実測。3 つの seed の平均）。"""
    path = E1 / "cache" / "fit" / "grain_lattice.json"
    if path.exists():
        return json.loads(path.read_text(encoding="utf-8"))
    mask = np.ones((1024, 1024), bool)
    out = []
    for cell in cells:
        vs, ps = [], []
        for seed in (1, 2, 3):
            f = grain_field_env(2560, 1707, 0, 100, seed, {"clumpCell": cell / 2560, "boostCell": 0.0})
            vs.append(float(f.var()))
            ps.append(acf_halfwidth(f[341:1365, 768:1792], mask)[1])
        out.append({"cell": cell, "var": float(np.mean(vs)), "acf": [float(v) for v in np.mean(ps, axis=0)]})
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(out), encoding="utf-8")
    return out


# footprint 1.25 の白い場の半値幅（これより細かい LR の粒には合わせられない）
GRAIN_HW_FLOOR = 0.59


def step_grain_fit(args) -> None:
    """粒子: 均一な粒 E と かたまり C の 2 枚の格子（重み (1 − r)·A_E と r·A_C、細かい格子の boost）を、両 round の LR の
    平坦なタイルの sd と半値幅（2560px）に当てはめる（`fit/grain.json`）。格子 1 枚の場の統計は環境変数で定数を上書きできる
    probe（`env_probe_build`。計測専用）の実測で、2 枚の混ぜ方は分散と自己相関の重み付き和。"""
    env_probe_build(args.probe_tag)
    targets = grain_targets()
    table = grain_lattice_table([0.15, 0.2, 0.25, 0.3, 0.35, 0.4, 0.45, 0.5, 0.55, 0.6, 0.7, 0.8, 0.9, 1.0, 1.1, 1.25, 1.4, 1.6,
                                 1.8, 2.0, 2.25, 2.5, 2.75, 3.0, 3.5, 4.0, 5.0, 6.0, 8.0])
    cells = np.array([t["cell"] for t in table])
    var = np.array([t["var"] for t in table])
    acf = np.array([t["acf"] for t in table])

    def lattice(cell):
        lc = np.log(np.clip(cell, cells[0], cells[-1]))
        v = np.interp(lc, np.log(cells), var) * min(cell / cells[0], 1.0) ** 2
        return v, np.array([np.interp(lc, np.log(cells), acf[:, k]) for k in range(acf.shape[1])])

    def predict(p, amount, size, rough):
        s, r = (size / 100) ** p["shape"], rough / 100
        tot_v, tot_a = 0.0, 0.0
        for cell, w in ((p["e0"] + (p["e100"] - p["e0"]) * s, (1 - r) * p["ampEven"]), (p["c0"] + (p["c100"] - p["c0"]) * s, r * p["ampClump"])):
            v, a = lattice(cell)
            g = w * np.sqrt(1 + (p["boost"] / cell) ** 2)
            tot_v += g * g * v
            tot_a = tot_a + g * g * v * a
        return amount / 100 * float(np.sqrt(tot_v)), halfwidth_of(tot_a / tot_v)

    # 間隔は 2560px の画素で（長辺比 = ÷ 2560）。E の size 0 / 100 と C の size 0・boost は固定（E は 2560px ではどれも白いので
    # 決まらない。フルサイズの LR の粒の細かさに合わせて 1/6312〜1/3200）
    base = {"e0": 2560 / 6312, "e100": 2560 / 3200, "c0": 2560 / 5120, "boost": 2560 / 2381}
    names = ("c100", "shape", "ampEven", "ampClump")

    def loss(x):
        if min(x) <= 0:
            return 99.0
        p = {**base, **dict(zip(names, x))}
        return sum(np.log(predict(p, *k)[0] / sd) ** 2 + np.log(predict(p, *k)[1] / max(hw, GRAIN_HW_FLOOR)) ** 2 for k, (sd, hw) in targets.items())

    x, val = nelder_mead(loss, [2560 / 884, 1.334, 0.0485, 0.0696], [.2, .1, .004, .005], iters=max(args.iters * 5, 1500), tol=1e-9)
    p = {**base, **dict(zip(names, (float(t) for t in x)))}
    out = E1 / "fit" / "grain.json"
    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_text(json.dumps({"px2560": p, "loss": val, "targets": {str(k): v for k, v in targets.items()},
                               "predicted": {str(k): predict(p, *k) for k in targets}}, indent=1), encoding="utf-8")
    log(f"grain GRAIN_AMPLITUDE {p['ampClump']:.4f} GRAIN_EVEN_WEIGHT {p['ampEven'] / p['ampClump']:.3f} "
        f"GRAIN_CLUMP_CELL_AT_SIZE_100 1/{2560 / p['c100']:.0f} GRAIN_SIZE_SHAPE {p['shape']:.3f}")
    for k, (sd, hw) in targets.items():
        psd, phw = predict(p, *k)
        log(f"  量 {k[0]:.0f} サイズ {k[1]:.0f} 粗さ {k[2]:.0f}: sd {psd:.4f} / LR {sd:.4f}（×{psd / sd:.2f}）  hw {phw:.2f} / LR {hw:.2f}（×{phw / hw:.2f}）")


def step_grain_stats(args) -> None:
    """「粒子あり − neutral」の残差（2560px・sRGB 符号化値）の統計を LR（フルサイズを線形光の面積平均で縮めたもの）と crate で比べる。
    受入の目安: 標準偏差（中間調）±20%、自己相関の半値幅 ±25%（場面と変種ごと）。"""
    rows = []
    for sc in SCENES:
        ln = read_encoded(ref_path(sc, "neutral"))
        cn = read_encoded(render_path(args.tag, "neutral", sc))
        for v in GRAIN_VARIANTS:
            lv, cv_ = read_encoded(ref_path(sc, v)), read_encoded(render_path(args.tag, v, sc))
            a, b = grain_stats(ln, lv), grain_stats(cn, cv_)
            # LR and crate must use the same spatial tiles. Otherwise each
            # side can select a different "flat" area and the comparison
            # measures image content differences instead of grain only.
            common_tiles = sorted(set(flat_tiles(ln @ LUMA709)).intersection(flat_tiles(cn @ LUMA709)))
            fa, fb = grain_stats_flat(ln, lv, common_tiles), grain_stats_flat(cn, cv_, common_tiles)
            rows.append({"scene": sc, "variant": v, "lr": a, "crate": b, "sdRatio": b["sdMid"] / a["sdMid"],
                         "hwRatio": b["halfWidth"] / a["halfWidth"], "lrFlat": fa, "crateFlat": fb,
                         "sdRatioFlat": fb["sd"] / fa["sd"], "hwRatioFlat": fb["halfWidth"] / fa["halfWidth"]})
    out = OUT / "results" / f"grain-{args.tag}.json"
    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_text(json.dumps(rows, ensure_ascii=False, indent=1), encoding="utf-8")
    lines = [f"# E1 round{ROUND_N} 粒子の統計（{args.tag}）", "",
             "2560px の「粒子あり − neutral」の sRGB 符号化値の輝度（Rec.709）の残差。sd = 中間調（0.25〜0.75）の標準偏差、"
             "hw = 自己相関（帯ごとの sd で正規化）の動径平均が 0.5 になる半径（画素）、mean = 中間調の平均のずれ。"
             "LR の彩度の揺れ（chroma）は輝度の残差を引いた各チャンネルの残差の RMS。"
             "「平坦」= 像の細部の少ない中間調のタイル（128px × 16 枚）だけで測った sd / hw（Lightroom はサイズが大きいと像も"
             "ぼかすので、粒そのものはこちらで比べる。合否も平坦の比で付ける）。", "",
             "| 変種 | 場面 | LR sd | crate sd | 比 | LR hw | crate hw | 比 | 平坦 LR sd | crate sd | 比 | 平坦 LR hw | crate hw | 比 | LR mean | crate mean | LR chroma | 合否 |",
             "|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|"]
    for r in rows:
        ok = abs(r["sdRatioFlat"] - 1) <= 0.2 and abs(r["hwRatioFlat"] - 1) <= 0.25
        lines.append(f"| {r['variant']} | {r['scene']} | {r['lr']['sdMid']:.4f} | {r['crate']['sdMid']:.4f} | {r['sdRatio']:.2f} | "
                     f"{r['lr']['halfWidth']:.2f} | {r['crate']['halfWidth']:.2f} | {r['hwRatio']:.2f} | "
                     f"{r['lrFlat']['sd']:.4f} | {r['crateFlat']['sd']:.4f} | {r['sdRatioFlat']:.2f} | "
                     f"{r['lrFlat']['halfWidth']:.2f} | {r['crateFlat']['halfWidth']:.2f} | {r['hwRatioFlat']:.2f} | {r['lr']['meanMid']:+.4f} | "
                     f"{r['crate']['meanMid']:+.4f} | {r['lr']['chromaSdMid']:.4f} | {'OK' if ok else 'NG'} |")
    for v in GRAIN_VARIANTS:
        rs = [r for r in rows if r["variant"] == v]
        lines.append(f"| **{v}** | 平均 | {np.mean([r['lr']['sdMid'] for r in rs]):.4f} | {np.mean([r['crate']['sdMid'] for r in rs]):.4f} | "
                     f"**{np.mean([r['sdRatio'] for r in rs]):.2f}** | {np.mean([r['lr']['halfWidth'] for r in rs]):.2f} | "
                     f"{np.mean([r['crate']['halfWidth'] for r in rs]):.2f} | **{np.mean([r['hwRatio'] for r in rs]):.2f}** | "
                     f"{np.nanmean([r['lrFlat']['sd'] for r in rs]):.4f} | {np.nanmean([r['crateFlat']['sd'] for r in rs]):.4f} | "
                     f"**{np.nanmean([r['sdRatioFlat'] for r in rs]):.2f}** | {np.nanmean([r['lrFlat']['halfWidth'] for r in rs]):.2f} | "
                     f"{np.nanmean([r['crateFlat']['halfWidth'] for r in rs]):.2f} | **{np.nanmean([r['hwRatioFlat'] for r in rs]):.2f}** | | | | |")
    md = "\n".join(lines) + "\n"
    (OUT / "results" / f"grain-{args.tag}.md").write_text(md, encoding="utf-8")
    print(md)


def _img_b64(path: Path, long_edge: int = 900) -> str:
    import cv2
    a = cv2.imread(str(path), cv2.IMREAD_UNCHANGED)
    if a is None:
        return ""
    if a.dtype == np.uint16:
        a = (a.astype(np.float32) / 257.0).round().astype(np.uint8)
    h, w = a.shape[:2]
    k = long_edge / max(h, w)
    a = cv2.resize(a, (round(w * k), round(h * k)), interpolation=cv2.INTER_AREA)
    ok, buf = cv2.imencode(".jpg", a, [cv2.IMWRITE_JPEG_QUALITY, 85])
    return "data:image/jpeg;base64," + base64.b64encode(buf.tobytes()).decode()


def step_page(args) -> None:
    label_b, label_a = args.labels.split(",") if args.labels else ("当てはめ前", "当てはめ後")
    before = json.loads((OUT / "results" / f"{args.tag_before}.json").read_text(encoding="utf-8"))
    after = json.loads((OUT / "results" / f"{args.tag_after}.json").read_text(encoding="utf-8"))
    by_b = {(r["variant"], r["scene"]): r for r in before["items"]}
    by_a = {(r["variant"], r["scene"]): r for r in after["items"]}
    sb, sa = before["summary"], after["summary"]
    base_a = sa["neutral"]["mean"]
    rows = []
    for v in VARIANTS:
        b, a = sb.get(v), sa.get(v)
        if not b or not a:
            continue
        target = v in BW or v in VIG
        ok = "" if not target else ("合格" if a["mean"] <= 3.0 else "不合格")
        rows.append(f"<tr><th>{v}</th><td>{b['mean']:.2f} / {b['p99Mean']:.1f}</td><td><b>{a['mean']:.2f}</b> / {a['p99Mean']:.1f}</td>"
                    f"<td>{a['mean'] - base_a:+.2f}</td><td>{a['p99Max']:.1f}（{a['worst']}）</td><td>{ok}</td></tr>")
    grain_md = ""
    gpath = OUT / "results" / f"grain-{args.tag_after}.json"
    if gpath.exists():
        g = json.loads(gpath.read_text(encoding="utf-8"))
        gb = OUT / "results" / f"grain-{args.tag_before}.json"
        gbr = {(r["variant"], r["scene"]): r for r in json.loads(gb.read_text(encoding="utf-8"))} if gb.exists() else {}
        grows = []
        mean = lambda rows, f: float(np.nanmean([f(r) for r in rows])) if rows else float("nan")
        for v in GRAIN_VARIANTS:
            rs = [r for r in g if r["variant"] == v]
            rb = [gbr[(v, r["scene"])] for r in rs if (v, r["scene"]) in gbr]
            grows.append(f"<tr><th>{v}</th><td>{mean(rs, lambda r: r['lrFlat']['sd']):.4f}</td>"
                         f"<td>{mean(rb, lambda r: r['sdRatioFlat']):.2f} → <b>{mean(rs, lambda r: r['sdRatioFlat']):.2f}</b></td>"
                         f"<td>{mean(rs, lambda r: r['lrFlat']['halfWidth']):.2f}</td>"
                         f"<td>{mean(rb, lambda r: r['hwRatioFlat']):.2f} → <b>{mean(rs, lambda r: r['hwRatioFlat']):.2f}</b></td></tr>")
        grain_md = (f"<h2>粒子（2560px の残差の統計・平坦なタイル。比 = crate ÷ LR、{html.escape(label_b)} → {html.escape(label_a)}）</h2>"
                    "<table><tr><th>変種</th><th>LR sd</th><th>sd の比</th><th>LR 半値幅</th><th>半値幅の比</th></tr>" + "".join(grows) + "</table>")
    cards = []
    for v in VARIANTS:
        cards.append(f"<h2 id='{v}'>{v}</h2>")
        for sc in SCENES:
            rb, ra = by_b.get((v, sc)), by_a.get((v, sc))
            if not rb or not ra:
                continue
            cards.append(
                f"<section class=card><h3>{sc} · {v}</h3><div class=row>"
                f"<figure><img loading=lazy src='{_img_b64(ref_path(sc, v))}'><figcaption>Lightroom</figcaption></figure>"
                f"<figure><img loading=lazy src='{_img_b64(render_path(args.tag_before, v, sc))}'><figcaption>{label_b} · ΔE {rb['mean']:.2f} / p99 {rb['p99']:.1f}</figcaption></figure>"
                f"<figure><img loading=lazy src='{_img_b64(render_path(args.tag_after, v, sc))}'><figcaption><b>{label_a} · ΔE {ra['mean']:.2f} / p99 {ra['p99']:.1f}</b></figcaption></figure>"
                f"</div></section>")
    nav = " ".join(f"<a href='#{v}'>{v}</a>" for v in VARIANTS)
    page = f"""<!doctype html><html lang=ja><meta charset=utf-8><meta name=viewport content="width=device-width,initial-scale=1">
<title>E1 効果の見比べ</title><style>
:root{{--bg:#faf8f5;--fg:#2b2a28;--mut:#6f6b66;--line:#e4dfd8;--card:#fff}}
@media (prefers-color-scheme:dark){{:root{{--bg:#1d1c1b;--fg:#ece8e2;--mut:#a39d95;--line:#3a3734;--card:#262523}}}}
body{{margin:0;padding:16px;background:var(--bg);color:var(--fg);font:15px/1.6 -apple-system,"Hiragino Sans",sans-serif}}
h1{{font-size:20px;margin:0 0 4px}} h2{{font-size:17px;margin:24px 0 8px}} p{{color:var(--mut);margin:4px 0 12px}}
table{{border-collapse:collapse;margin:8px 0 20px;max-width:100%;display:block;overflow-x:auto}}
td,th{{border:1px solid var(--line);padding:4px 10px;text-align:right;white-space:nowrap}} th{{text-align:left}}
nav a{{margin-right:8px;color:var(--mut)}}
.card{{background:var(--card);border:1px solid var(--line);border-radius:12px;padding:12px;margin:0 0 14px}}
.card h3{{margin:0 0 8px;font-size:15px}}
.row{{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:8px}} figure{{margin:0}} img{{width:100%;border-radius:6px;display:block}}
figcaption{{font-size:12px;color:var(--mut);margin-top:4px}} @media (max-width:640px){{.row{{grid-template-columns:1fr}}}}
</style><h1>E1 効果（白黒・周辺光量補正・粒子）の見比べ（round{ROUND_N}）</h1>
<p>Lightroom の書き出し（線形光の面積平均で 2560px）と、NIHO の crate で描いた {html.escape(label_b)}・{html.escape(label_a)}。
ΔE00 は colorcheck（1500px・blur 2px・平坦画素）の mean / p99。受入は白黒・周辺光量補正の変種ごとに mean（場面の平均）≤ 3.0。</p>
<table><tr><th>変種</th><th>{html.escape(label_b)} mean / p99</th><th>{html.escape(label_a)} mean / p99</th><th>{html.escape(label_a)}の上乗せ（− neutral）</th><th>{html.escape(label_a)} p99 最大</th><th>受入</th></tr>{''.join(rows)}</table>
{grain_md}
<nav>{nav}</nav>
{''.join(cards)}</html>"""
    out = OUT / "page" / "index.html"
    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_text(page, encoding="utf-8")
    log(f"page {out}（{out.stat().st_size / 1e6:.1f} MB）")


STEPS = {"refs": step_refs, "crate-build": step_crate_build, "render": step_render, "measure": step_measure,
         "grain-stats": step_grain_stats, "vig-fit": step_vig_fit, "bw-fit": step_bw_fit, "grain-fit": step_grain_fit,
         "page": step_page}


def build_parser() -> argparse.ArgumentParser:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("step", choices=[*STEPS, "all"])
    ap.add_argument("--round", type=int, choices=ROUNDS, default=8,
                    help="Lightroom の書き出しの round（8 = E1 #17120、9 = 端の値 E1c #17259。変種は manifest から読む）")
    ap.add_argument("--tag", default="before")
    ap.add_argument("--src", help="crate-build の元（packages/develop-engine）")
    ap.add_argument("--src-after", help="all の after で組む元（当てはめた式の crate。既定は --src）")
    ap.add_argument("--coeffs", help="crate-build で書き換える係数の JSON（{定数名: 値}）")
    ap.add_argument("--patch", help="crate-build で当てる diff（-p1、engine からの相対）")
    ap.add_argument("--variants", nargs="+", choices=VARIANTS)
    ap.add_argument("--base-tag", default="before", help="当てはめの土台にする build（probe と neutral の描画）")
    ap.add_argument("--jobs", type=int, default=3)
    ap.add_argument("--iters", type=int, default=300)
    ap.add_argument("--loo", action="store_true", help="vig-fit / bw-fit で leave-one-out（場面）も回す")
    ap.add_argument("--probe-tag", help="grain-fit の環境変数版 probe を組む元の build（既定は --base-tag）")
    ap.add_argument("--tag-before", default="before", help="page の左の列（比べる元）の tag")
    ap.add_argument("--tag-after", default="after", help="page の右の列の tag")
    ap.add_argument("--labels", help="page の 2 列の名前（`今の main,変更案`。既定は 当てはめ前,当てはめ後）")
    return ap


ALL = (("refs", {}), ("crate-build", {"tag": "before"}), ("render", {"tag": "before"}), ("measure", {"tag": "before"}),
       ("grain-stats", {"tag": "before"}), ("vig-fit", {}), ("bw-fit", {}), ("grain-fit", {}),
       ("crate-build", {"tag": "after"}), ("render", {"tag": "after"}), ("measure", {"tag": "after"}),
       ("grain-stats", {"tag": "after"}), ("page", {}))


def main() -> int:
    global BASE_TAG
    args = build_parser().parse_args()
    BASE_TAG = args.base_tag
    args.probe_tag = args.probe_tag or args.base_tag
    if args.step != "all":
        STEPS[args.step](args)
        return 0
    # all: before は --src（既定は engine そのもの）を係数そのままで、after は --src-after（当てはめた式の crate）に
    # --coeffs（係数）を当てて組む。当てはめの結果（fit/*.json）は目で見てから --coeffs に写す想定なので、
    # all は既定の係数ファイル（fit/coeffs-after.json）があればそれを使う。
    for n in ROUNDS:
        if n != ROUND_N:
            log(f"== refs round{n}（当てはめ用）")
            refs_for(n, args.jobs)
    for name, over in ALL:
        a = argparse.Namespace(**{**vars(args), **over})
        if name == "crate-build" and over.get("tag") == "after":
            a.src = args.src_after or args.src
            a.coeffs = args.coeffs or (str(E1 / "fit" / "coeffs-after.json") if (E1 / "fit" / "coeffs-after.json").exists() else None)
        elif name == "crate-build":
            a.coeffs = None
        log(f"== {name} {over}")
        STEPS[name](a)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
