"""compare / render / preset pipelines.

compare:
  reference (8-bit sRGB) -> linear sRGB -> area-resize to the analysis long edge
  candidate -> linear (sRGB display, or ProPhoto pre-render) -> same long edge
  align (scale + translation) -> resample candidate into the reference frame
  [--render] calibration (matrix, hueSat) -> render_display(ev + baselineEV) -> 8 bit
  blur both in linear light (sigma 2 px @ 1500 px) -> crop 4 % -> metrics
"""
from __future__ import annotations

import os
from dataclasses import dataclass

import numpy as np

from . import __version__
from . import align as A
from . import calibration as CAL
from . import color as C
from . import imageops
from . import io as IO
from . import metrics as MET
from . import ref_root, work_dir
from .util import now_iso, safe_name

DEFAULT_SIZE = 1500
DEFAULT_BLUR = 2.0  # Gaussian sigma in px at a 1500 px long edge; scaled with the analysis size
SAMPLE_LONG_EDGE = 480
SAMPLE_QUALITY = 80
LOW_CORR = 0.3
COMPARISONS = ("reference", "camera-jpeg", "version", "cross-camera", "preset")

COMPARE_SCHEMA = "colorcheck/compare/v1"
PRESET_SCHEMA = "colorcheck/preset/v1"


@dataclass
class Pair:
    ref_lin: np.ndarray       # analysis frame, display-referred linear sRGB
    cand: np.ndarray          # candidate resampled into the frame
    cand_space: str           # linear-srgb (display-referred) | linear-prophoto (pre-render)
    renderable: bool
    valid: np.ndarray
    alignment: A.Alignment
    crop: tuple
    reference: dict
    candidate: dict
    warnings: list
    cand_clip: np.ndarray | None = None  # fraction of clipped source pixels (see load_pair)

    @property
    def frame_size(self) -> list:
        return [int(self.ref_lin.shape[1]), int(self.ref_lin.shape[0])]


def sigma_for(blur: float, frame_long_edge: int) -> float:
    return float(blur) * frame_long_edge / 1500.0 if blur and blur > 0 else 0.0


def load_pair(reference: str, candidate: str, candidate_space: str = C.SPACE_SRGB, render: bool = False,
              size: int = DEFAULT_SIZE, do_align: bool = True, crop: float = A.CROP) -> Pair:
    if candidate_space not in C.SPACES:
        raise ValueError(f"--candidate-space must be one of {C.SPACES}")
    if render and candidate_space == C.SPACE_SRGB:
        raise ValueError("--render は線形の候補（linear-srgb / linear-prophoto）にだけ使える")
    warnings = []
    ref = IO.load_image(reference)
    if ref.bit_depth == 32:
        warnings.append("参照が浮動小数点（線形の可能性）。sRGB エンコードとみなして読んだ")
    ref_desc = ref.describe()
    ref_lin, _ = ref.linear(C.SPACE_SRGB)
    ref_shape = ref.raw.shape
    del ref

    cand = IO.load_image(candidate)
    cand_desc = cand.describe()
    cand_desc["space"] = candidate_space
    cand_lin, lin_space = cand.linear(candidate_space)
    cand_shape = cand.raw.shape
    clip_src = None
    if cand.raw.dtype in (np.uint8, np.uint16):
        top = np.iinfo(cand.raw.dtype).max
        clip_src = (cand.raw.max(axis=-1) >= top).astype(np.float32)
    else:
        top = float(np.max(cand.raw))
        if 0.99 <= top <= 1.01:  # float output capped at 1.0: treat >= 99.9 % of the cap as clipped
            clip_src = (cand.raw.max(axis=-1) >= 0.999 * top).astype(np.float32)
    del cand
    if render:
        cand_lin = C.to_linear(cand_lin, lin_space, C.SPACE_LINEAR_PROPHOTO)
        space = C.SPACE_LINEAR_PROPHOTO
    else:
        cand_lin = C.to_linear(cand_lin, lin_space, C.SPACE_LINEAR_SRGB)
        space = C.SPACE_LINEAR_SRGB

    n = int(min(size, max(ref_shape[:2]), max(cand_shape[:2])))
    if n < size:
        warnings.append(f"解析の長辺を {n}px に下げた（入力が {size}px 未満）")
    ref_a = imageops.resize_long_edge(ref_lin, n)
    del ref_lin
    cand_a = imageops.resize_long_edge(cand_lin, n)
    del cand_lin

    y_ref = C.luminance(ref_a, C.SPACE_LINEAR_SRGB)
    y_cand = C.luminance(cand_a, space)
    al = A.estimate(y_ref, y_cand) if do_align else A.identity(y_ref, y_cand)
    if al.corr is not None and al.corr < LOW_CORR:
        warnings.append(f"位置合わせの相関が低い（corr={al.corr:.3f}）。別の場面・向き違いの可能性")
    cand_w, valid = A.apply(cand_a, al, ref_a.shape[:2])
    clip_w = None
    if clip_src is not None:
        clip_a = imageops.resize(clip_src, (cand_a.shape[1], cand_a.shape[0]))
        clip_w, _ = A.apply(clip_a[..., None] if clip_a.ndim == 2 else clip_a, al, ref_a.shape[:2])
        clip_w = np.asarray(clip_w).reshape(ref_a.shape[:2]).astype(np.float32)
    box = imageops.crop_box(ref_a.shape[0], ref_a.shape[1], crop)
    return Pair(ref_a, cand_w.astype(np.float32, copy=False), space, render, valid, al, box,
                ref_desc, cand_desc, warnings, clip_w)


def render_candidate(pair: Pair, ev: float = 0.0, cal: CAL.Calibration | None = None,
                     neutral_k: float | None = None, curve: C.ToneCurve | None = None,
                     quantize: bool = True) -> tuple[np.ndarray, np.ndarray | None]:
    """Display-referred linear sRGB of the candidate (+ uint8 when quantized)."""
    if not pair.renderable:
        return pair.cand, None
    x = pair.cand
    ev_total = float(ev)
    if cal is not None:
        x = cal.apply(x, neutral_k)
        ev_total += cal.baseline_ev
    enc = C.render_display_float(x, ev_total, curve)
    if quantize:
        u8 = C.quantize8(enc)
        return C.srgb8_decode(u8), u8
    return C.srgb_decode(enc), None


def measure_pair(pair: Pair, cand_disp: np.ndarray, sigma: float) -> dict:
    y0, y1, x0, x1 = pair.crop
    ref_b = imageops.gaussian_blur(pair.ref_lin, sigma)
    cand_b, valid_b = imageops.blur_masked(cand_disp, pair.valid, sigma)
    s = (slice(y0, y1), slice(x0, x1))
    return MET.measure(pair.ref_lin[s], cand_disp[s], pair.valid[s], ref_b[s], cand_b[s], valid_b[s])


def _ev_offset_to_match(pair: Pair, ev_total: float, cal, neutral_k, curve, sigma: float) -> float | None:
    y0, y1, x0, x1 = pair.crop
    s = (slice(y0, y1), slice(x0, x1))
    ref_b = imageops.gaussian_blur(pair.ref_lin, sigma)[s]
    y_ref = C.luminance(ref_b, C.SPACE_LINEAR_SRGB)
    sel = pair.valid[s] & (y_ref >= MET.MID_Y_RANGE[0]) & (y_ref <= MET.MID_Y_RANGE[1])
    if sel.sum() < 16:
        return None
    target = float(np.median(y_ref[sel]))
    x = pair.cand[s][sel]
    if len(x) > 200_000:
        x = x[np.linspace(0, len(x) - 1, 200_000).astype(np.int64)]
    if cal is not None:
        x = cal.apply(x, neutral_k)

    def med(off):
        return float(np.median(C.luminance(C.render_display_linear(x, ev_total + off, curve), C.SPACE_LINEAR_SRGB)))

    lo, hi = -6.0, 6.0
    if med(lo) > target or med(hi) < target:
        return None
    for _ in range(40):
        mid = 0.5 * (lo + hi)
        if med(mid) < target:
            lo = mid
        else:
            hi = mid
        if hi - lo < 1e-4:
            break
    off = 0.5 * (lo + hi)
    a, b = med(off - 0.1), med(off + 0.1)
    slope = float(np.log2(b / a) / 0.2) if a > 0 and b > 0 else 0.0  # d log2(Y_display) / d EV
    return off, slope


def _save_samples(pair: Pair, cand_u8: np.ndarray | None, cand_disp: np.ndarray, out_dir: str, stem: str) -> dict:
    y0, y1, x0, x1 = pair.crop
    s = (slice(y0, y1), slice(x0, x1))
    ref_u8 = C.quantize8(C.srgb_encode(np.clip(pair.ref_lin[s], 0, 1)))
    if cand_u8 is None:
        cand_u8 = C.quantize8(C.srgb_encode(np.clip(cand_disp, 0, 1)))
    cu = cand_u8[s].copy()
    cu[~pair.valid[s]] = 128
    os.makedirs(out_dir, exist_ok=True)
    rp = IO.save_sample(os.path.join(out_dir, f"{stem}_ref.jpg"), ref_u8, SAMPLE_LONG_EDGE, SAMPLE_QUALITY)
    cp = IO.save_sample(os.path.join(out_dir, f"{stem}_niho.jpg"), cu, SAMPLE_LONG_EDGE, SAMPLE_QUALITY)
    return {"reference": os.path.abspath(rp), "candidate": os.path.abspath(cp)}


def run_compare(reference: str, candidate: str, candidate_space: str = C.SPACE_SRGB, render: bool = False,
                ev: float = 0.0, calibration: str | CAL.Calibration | None = None, neutral_k: float | None = None,
                size: int = DEFAULT_SIZE, blur: float = DEFAULT_BLUR, do_align: bool = True,
                normalize_exposure: bool = False, camera: dict | None = None, decoder_version: str | None = None,
                base_version: str | None = None, label: str | None = None, comparison: str = "reference",
                save_pair: str | None = None, scene: str | None = None, preset: str | None = None,
                tone_curve: str | None = None) -> dict:
    if comparison not in COMPARISONS:
        raise ValueError(f"--kind must be one of {COMPARISONS}")
    pair = load_pair(reference, candidate, candidate_space, render, size, do_align)
    warnings = list(pair.warnings)
    cal = None
    if calibration is not None:
        cal = calibration if isinstance(calibration, CAL.Calibration) else CAL.load(calibration)
        if not render:
            warnings.append("--calibration は --render のときだけ効く（無視した）")
            cal = None
    curve = C.load_tone_curve(tone_curve) if render else None
    if not render and ev:
        warnings.append("--ev は --render のときだけ効く（無視した）")

    sigma = sigma_for(blur, max(pair.frame_size))
    cand_disp, cand_u8 = render_candidate(pair, ev, cal, neutral_k, curve)
    pair_metrics = measure_pair(pair, cand_disp, sigma)

    result = {
        "schema": COMPARE_SCHEMA,
        "label": label,
        "comparison": comparison,
        "scene": scene,
        "preset": preset,
        "reference": pair.reference,
        "candidate": dict(pair.candidate, rendered=bool(render), ev=float(ev) if render else None,
                          calibration=cal.describe(neutral_k) if cal else None,
                          toneCurve=(curve.name if curve else None)),
        "camera": camera or {"make": None, "model": None},
        "decoderVersion": decoder_version,
        "baseVersion": base_version,
        "alignment": pair.alignment.to_json(),
        "analysisSize": pair.frame_size,
        "crop": A.CROP,
        "blurSigma": round(sigma, 4),
        "metrics": pair_metrics,
    }

    if normalize_exposure:
        if render:
            ev_total = float(ev) + (cal.baseline_ev if cal else 0.0)
            found = _ev_offset_to_match(pair, ev_total, cal, neutral_k, curve, sigma)
            if found is None:
                result["normalized"] = {"method": "pre-tone-ev", "evOffset": None, "note": "一致する EV が見つからない"}
            else:
                off, slope = found
                disp_n, _ = render_candidate(pair, float(ev) + off, cal, neutral_k, curve)
                m_n = measure_pair(pair, disp_n, sigma)
                # one Newton step on the full (blurred) pipeline so the reported evDiff is ~0
                if m_n["evDiff"] is not None and abs(m_n["evDiff"]) > 0.005 and slope > 0.05:
                    off -= m_n["evDiff"] / slope
                    disp_n, _ = render_candidate(pair, float(ev) + off, cal, neutral_k, curve)
                    m_n = measure_pair(pair, disp_n, sigma)
                result["normalized"] = dict(m_n, method="pre-tone-ev", evOffset=round(off, 4))
        else:
            y0, y1, x0, x1 = pair.crop
            s = (slice(y0, y1), slice(x0, x1))
            ref_b = imageops.gaussian_blur(pair.ref_lin, sigma)[s]
            cand_b, valid_b = imageops.blur_masked(cand_disp, pair.valid, sigma)
            ev_d = MET.ev_diff(C.luminance(ref_b, C.SPACE_LINEAR_SRGB),
                               C.luminance(cand_b[s], C.SPACE_LINEAR_SRGB), valid_b[s])
            if ev_d is None:
                result["normalized"] = {"method": "display-linear-gain", "gain": None, "note": "中間調の画素が足りない"}
            else:
                g = float(2.0 ** (-ev_d))
                result["normalized"] = dict(measure_pair(pair, cand_disp * np.float32(g), sigma),
                                            method="display-linear-gain", gain=round(g, 5))

    if save_pair:
        stem = safe_name(label or os.path.splitext(os.path.basename(candidate))[0])
        result["samples"] = _save_samples(pair, cand_u8, cand_disp, save_pair, stem)
    result["warnings"] = warnings
    result["tool"] = {"name": "colorcheck", "version": __version__}
    result["createdAt"] = now_iso()
    return result


# ------------------------------------------------------------------- render

def run_render(input_path: str, space: str, out: str, calibration: str | None = None, ev: float = 0.0,
               neutral_k: float | None = None, long_edge: int | None = None, fmt: str | None = None,
               tone_curve: str | None = None, quality: int = 95) -> dict:
    if space not in (C.SPACE_LINEAR_SRGB, C.SPACE_LINEAR_PROPHOTO):
        raise ValueError("render --space は linear-srgb か linear-prophoto")
    fmt = _render_format(fmt, out)
    img = IO.load_image(input_path)
    desc = img.describe()
    lin, lin_space = img.linear(space)
    del img
    if long_edge and max(lin.shape[:2]) > long_edge:
        lin = imageops.resize_long_edge(lin, int(long_edge))
    pp = C.to_linear(lin, lin_space, C.SPACE_LINEAR_PROPHOTO)
    del lin
    cal = CAL.load(calibration) if calibration else None
    ev_total = float(ev)
    if cal is not None:
        pp = cal.apply(pp, neutral_k)
        ev_total += cal.baseline_ev
    curve = C.load_tone_curve(tone_curve)
    enc = C.render_display_float(pp, ev_total, curve)
    if fmt in ("tif16-srgb", "tif16", "tiff16"):
        IO.save_tiff16_srgb(out, enc)
    elif fmt in ("png", "jpg", "jpeg"):
        IO.save_srgb8(out, C.quantize8(enc), quality=quality)
    else:
        raise ValueError(f"unknown output format {fmt!r} (png | jpg | tif16-srgb)")
    return {"input": desc, "space": space, "out": os.path.abspath(out), "format": fmt,
            "size": [int(enc.shape[1]), int(enc.shape[0])], "ev": float(ev),
            "calibration": cal.describe(neutral_k) if cal else None, "toneCurve": curve.name}


def _format_from_ext(path: str) -> str:
    ext = os.path.splitext(path)[1].lower()
    if ext in (".tif", ".tiff"):
        return "tif16-srgb"
    if ext in (".jpg", ".jpeg"):
        return "jpg"
    if ext == ".png":
        return "png"
    raise ValueError(f"{path}: cannot infer output format (use .png / .jpg / .tif or --format)")


def _render_format(fmt: str | None, out: str) -> str:
    ext = os.path.splitext(out)[1].lower()
    inferred = _format_from_ext(out)
    if fmt is None:
        return inferred

    aliases = {"jpeg": "jpg", "tif16": "tif16-srgb", "tiff16": "tif16-srgb"}
    selected = aliases.get(fmt.lower(), fmt.lower())
    allowed_extensions = {
        "jpg": {".jpg", ".jpeg"},
        "png": {".png"},
        "tif16-srgb": {".tif", ".tiff"},
    }
    if selected not in allowed_extensions:
        raise ValueError(f"unknown output format {fmt!r} (png | jpg | tif16-srgb)")
    if ext not in allowed_extensions[selected]:
        raise ValueError(f"render --format {selected} does not match --out extension {ext or '(none)'}")
    return selected


# ------------------------------------------------------------------- preset

def resolve(path: str, root: str) -> str:
    return path if os.path.isabs(path) else os.path.join(root, path)


def run_preset(manifest: dict, manifest_path: str | None = None, size: int = DEFAULT_SIZE,
               blur: float = DEFAULT_BLUR, save_pairs: str | None = None, camera: dict | None = None,
               decoder_version: str | None = None, base_version: str | None = None, log=None,
               evaluate_gates: bool = True) -> dict:
    from . import gates as G

    r_root = manifest.get("referenceRoot") or ref_root()
    c_root = manifest.get("candidateRoot") or work_dir()
    camera = camera or manifest.get("camera") or {"make": None, "model": None}
    decoder_version = decoder_version or manifest.get("decoderVersion")
    base_version = base_version or manifest.get("baseVersion")
    items = []
    for it in manifest.get("items", []):
        preset, scene = it["preset"], it.get("scene") or os.path.splitext(os.path.basename(it["reference"]))[0]
        label = f"{preset}/{scene}"
        if log:
            log(f"[preset] {label}")
        res = run_compare(
            reference=resolve(it["reference"], r_root),
            candidate=resolve(it["candidate"], c_root),
            candidate_space=it.get("candidateSpace", C.SPACE_SRGB),
            render=bool(it.get("render", False)),
            ev=float(it.get("ev", 0.0) or 0.0),
            calibration=(resolve(it["calibration"], c_root) if it.get("calibration") else None),
            neutral_k=it.get("neutralTemperatureK"),
            size=size, blur=blur, camera=camera, decoder_version=decoder_version, base_version=base_version,
            label=label, comparison="preset", scene=scene, preset=preset,
            save_pair=(os.path.join(save_pairs, safe_name(preset)) if save_pairs else None),
        )
        items.append(res)
    presets = summarize_presets(items)
    result = {
        "schema": PRESET_SCHEMA,
        "manifest": os.path.abspath(manifest_path) if manifest_path else None,
        "camera": camera,
        "decoderVersion": decoder_version,
        "baseVersion": base_version,
        "analysisLongEdge": size,
        "p99Rule": "max-of-scenes",
        "presets": presets,
        "items": items,
        "tool": {"name": "colorcheck", "version": __version__},
        "createdAt": now_iso(),
    }
    if evaluate_gates:
        result["gates"] = G.evaluate([result])
    else:
        result["gateExcluded"] = True
        result["gates"] = {"overall": "not-evaluated", "gates": []}
    return result


def summarize_presets(items: list) -> list:
    groups: dict = {}
    for r in items:
        groups.setdefault(r.get("preset"), []).append(r)
    out = []
    for preset, rs in groups.items():
        means = [r["metrics"]["deltaE00"]["mean"] for r in rs if r["metrics"]["deltaE00"]["mean"] is not None]
        p99s = [r["metrics"]["deltaE00"]["p99"] for r in rs if r["metrics"]["deltaE00"]["p99"] is not None]
        evs = [r["metrics"]["evDiff"] for r in rs if r["metrics"]["evDiff"] is not None]
        sats = [r["metrics"]["saturationRatio"] for r in rs if r["metrics"]["saturationRatio"] is not None]
        worst = max(rs, key=lambda r: r["metrics"]["deltaE00"]["p99"] or 0)
        out.append({
            "preset": preset,
            "scenes": [r.get("scene") for r in rs],
            "deltaE00Mean": round(float(np.mean(means)), 4) if means else None,
            "deltaE00P99": round(float(np.max(p99s)), 4) if p99s else None,
            "worstScene": worst.get("scene"),
            "evDiff": round(float(np.mean(evs)), 4) if evs else None,
            "saturationRatio": round(float(np.mean(sats)), 4) if sats else None,
        })
    return out


def _fmt(v, nd=2):
    return "—" if v is None else f"{v:.{nd}f}"


def preset_markdown(result: dict) -> str:
    gate = {g["id"]: g for g in result.get("gates", {}).get("gates", [])}.get("stage1.preset")
    per = {d["preset"]: d for d in (gate or {}).get("details", [])}
    lines = ["| プリセット | 場面数 | ΔE00 mean | ΔE00 p99（場面の最大） | EV 差 | 彩度比 | gate |",
             "|---|---:|---:|---:|---:|---:|---|"]
    for p in result["presets"]:
        st = per.get(p["preset"], {}).get("status", "—")
        lines.append(f"| {p['preset']} | {len(p['scenes'])} | {_fmt(p['deltaE00Mean'])} | {_fmt(p['deltaE00P99'])}"
                     f" ({p['worstScene']}) | {_fmt(p['evDiff'], 3)} | {_fmt(p['saturationRatio'], 3)} | {st} |")
    lines += ["", "| プリセット/場面 | ΔE00 mean | p99 | 補正なし mean | EV 差 | 彩度比 | 位置合わせ（倍率・相関） |",
              "|---|---:|---:|---:|---:|---:|---|"]
    for r in result["items"]:
        m = r["metrics"]
        al = r["alignment"]
        lines.append(f"| {r['label']} | {_fmt(m['deltaE00']['mean'])} | {_fmt(m['deltaE00']['p99'])} | "
                     f"{_fmt(m['deltaE00Unblurred']['mean'])} | {_fmt(m['evDiff'], 3)} | {_fmt(m['saturationRatio'], 3)} | "
                     f"{al['scale']:.4f} / {_fmt(al['corr'], 3)} |")
    if gate:
        lines += ["", f"gate stage1.preset: **{gate['status']}** — {gate.get('summary', '')}"]
    return "\n".join(lines) + "\n"
