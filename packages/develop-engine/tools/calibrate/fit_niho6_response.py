#!/usr/bin/env python3
"""Fit the `niho-6` JPEG Highlights / Shadows response (#18397, NIHO6.md).

The teachers are Lightroom's JPEG exports of `make_lr_p3_jpeg.py --set teachers`
(single Highlights / Shadows operations on JPEG / HEIC-derived originals). The
model is the RAW responses' form (`raw_response.rs`): the 26 frozen features of
the 750px analysis image -> tanh -> tanh -> softplus (a, b) >= 0 per pixel,
Highlights gain = -(h·a + h²·b), Shadows gain = s·a + s²·b. The features come
from the crate itself (`examples/niho6_features.rs`), so the fitted network
reads exactly what the renderer computes.

- Loss: L* of NIHO's own analysis luminance moved by the gain, against NIHO's
  L* plus Lightroom's L* change (variant − neutral): the response, not the
  base (e² + e⁴/4 with e = ΔL*/5, ridge 1e-3; the RAW fit's form).
- Chroma: `out = rgb·G + (rgb − Y)·(C − G)`, `C = 2^(α·g)`: α per operation by
  weighted least squares of log2 C on log2 G over chromatic, unclipped pixels.
- Folds: whole capture dates are held out together (`--folds dates`).

  python3 fit_niho6_response.py dataset --round <lr-measure>/issue18397/teachers [--round .../teachers2] --features-bin <niho6_features> --out ds.npz
  python3 fit_niho6_response.py fit --dataset ds.npz --out model.npz [--features all|i,j,..] [--hidden 24,16] [--folds dates]
  python3 fit_niho6_response.py preset-context --dataset ds.npz --nohs-renders teachers=<dir> [--nohs-renders teachers2=<dir>] --out pc.npz
  python3 fit_niho6_response.py fit-joint --dataset ds.npz --preset-context pc.npz --warm model.npz --out joint.npz [--preset-weight 0.4]
  python3 fit_niho6_response.py export --model joint.npz --out crates/niho-develop/niho6/response-jpeg.json --highlight-alpha 0.7

Needs numpy, scipy, Pillow, opencv-python-headless (colorcheck's), and the
owner's exports (never in the repository).
"""
from __future__ import annotations

import argparse
import hashlib
import io
import json
import subprocess
import sys
import tempfile
import time
from pathlib import Path

import numpy as np

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE.parent / "colorcheck"))
from colorcheck import color as C  # noqa: E402
from colorcheck import imageops as IM  # noqa: E402
from colorcheck import io as IO  # noqa: E402

FEATURE_SOURCE_SHA256 = "32ffd22017f6d42155fc6826c2f9def0cfcffd895b8a1a89d841d5b87f88277a"
PP_LUMA = np.array([0.2880402, 0.7118741, 0.0000857])
WORKING_LONG_EDGE = 2560
SAMPLES_PER_SCENE = 20000
OPS = {"highlight": (-1.0, "Highlights2012"), "shadow": (1.0, "Shadows2012")}
CLIP_EV = {"highlight": 8.0, "shadow": 4.0}
# Settings every teacher variant carries (make_lr_p3_jpeg.COMMON).
COMMON_KEYS = {"LensProfileEnable", "AutoLateralCA"}


def single_operations(manifest: dict) -> dict[str, dict[str, float]]:
    """{op: {variant: amount in [0, 1]}} of the variants that set one H or S only."""
    out: dict[str, dict[str, float]] = {op: {} for op in OPS}
    for variant, spec in manifest["variants"].items():
        keys = {k: v for k, v in spec["attributes"].items() if k not in COMMON_KEYS}
        if len(keys) != 1 or spec.get("curves"):
            continue
        (key, value), = keys.items()
        for op, (sign, name) in OPS.items():
            if key == name and float(value) * sign > 0:
                out[op][variant] = abs(float(value)) / 100.0
    return out


def lstar(y):
    y = np.maximum(y, 0.0)
    f = np.where(y > (6 / 29) ** 3, np.cbrt(y), y / (3 * (6 / 29) ** 2) + 4 / 29)
    return 116 * f - 16


def dlstar(y):
    y = np.maximum(y, 1e-12)
    return np.where(y > (6 / 29) ** 3, 116 / 3 * np.cbrt(y) ** -2, 116 / (3 * (6 / 29) ** 2))


def linear_srgb(path: Path) -> np.ndarray:
    image = IO.load_image(str(path))
    x, _ = image.linear(C.SPACE_SRGB)
    return x.astype(np.float32)


def to_analysis(x: np.ndarray, size: tuple[int, int]) -> np.ndarray:
    """Lightroom's export on the analysis grid: area average, blur σ1, ProPhoto."""
    small = IM.resize(x, size)
    small = IM.gaussian_blur(small, 1.0)
    return C.to_linear(small, C.SPACE_LINEAR_SRGB, C.SPACE_LINEAR_PROPHOTO).astype(np.float32)


# ---------------------------------------------------------------- dataset

BLANK_CLIPPED_FRACTION = 0.9


def blank_input(path: Path) -> bool:
    """A teacher whose input is blank (R17: two Takeout HEICs are white photos):
    90% or more of its pixels clipped. Excluded from training and evaluation."""
    from PIL import Image

    with Image.open(path) as image:
        image.draft("RGB", (256, 256))
        pixels = np.asarray(image.convert("RGB").resize((256, 192)))
    return float((pixels.max(-1) >= 250).mean()) >= BLANK_CLIPPED_FRACTION


def dataset(args) -> None:
    """One dataset from one or more teacher rounds (teachers, teachers2: R21)."""
    out: dict[str, np.ndarray] = {}
    scenes = []
    skipped = []
    rounds = []
    ops = None
    for round_text in args.round:
        round_dir = Path(round_text)
        manifest = json.loads((round_dir / "manifest.json").read_text(encoding="utf-8"))
        if manifest.get("sealed"):
            raise SystemExit("封印された独立評価のフォルダは学習に使わない")
        round_ops = single_operations(manifest)
        if ops is not None and round_ops != ops:
            raise SystemExit(f"{round_dir}: the H / S variants differ from the first round")
        ops = round_ops
        rounds.append({"round": str(round_dir),
                       "manifestSha256": hashlib.sha256((round_dir / "manifest.json").read_bytes()).hexdigest()})
        for scene in manifest["scenes"]:
            name = scene["scene"]
            if any(s["scene"] == name for s in scenes):
                raise SystemExit(f"scene {name} is in two rounds")
            base = round_dir / "inputs" / f"{name}__neutral.jpg"
            if blank_input(base):
                skipped.append(name)
                print("skip (blank input)", name, flush=True)
                continue
            with tempfile.TemporaryDirectory() as tmp:
                run = subprocess.run([args.features_bin, str(base), str(WORKING_LONG_EDGE), tmp],
                                     capture_output=True, text=True, check=True)
                aw, ah = map(int, run.stdout.split())
                analysis = np.load(Path(tmp) / "analysis.npy")
                features = np.load(Path(tmp) / "features.npy").reshape(-1, 26)
            y_n = np.maximum(IM.gaussian_blur(analysis, 1.0) @ PP_LUMA, 1e-6).ravel()
            lr = {v: to_analysis(linear_srgb(round_dir / "lr-export" / f"{name}__{v}.jpg"), (aw, ah)).reshape(-1, 3)
                  for v in ["neutral", *ops["highlight"], *ops["shadow"]]}
            y0, y1, x0, x1 = IM.crop_box(ah, aw, 0.04)
            yy, xx = np.meshgrid(np.arange(y0, y1), np.arange(x0, x1), indexing="ij")
            inner = (yy * aw + xx).ravel()
            seed = int(hashlib.sha256(name.encode()).hexdigest()[:8], 16)
            pick = np.random.default_rng(seed).choice(inner, size=min(args.samples_per_scene, inner.size),
                                                      replace=False)
            out[f"{name}/features"] = features[pick].astype(np.float32)
            out[f"{name}/yN"] = y_n[pick].astype(np.float32)
            out[f"{name}/lr_neutral"] = lr["neutral"][pick]
            for variants in ops.values():
                for v in variants:
                    out[f"{name}/lr_{v}"] = lr[v][pick]
            scenes.append({"scene": name, "date": scene.get("date"), "pool": scene.get("pool"), "size": [aw, ah],
                           "round": round_dir.name})
            print("dataset", name, aw, ah, flush=True)
    meta = {"rounds": rounds, "scenes": scenes, "skippedBlankInputs": skipped, "operations": ops,
            "samplesPerScene": args.samples_per_scene, "workingLongEdge": WORKING_LONG_EDGE}
    out["meta"] = np.frombuffer(json.dumps(meta).encode(), dtype=np.uint8)
    np.savez_compressed(args.out, **out)


# ---------------------------------------------------------------- model

def layout(n_in, h1, h2):
    shapes = [(n_in, h1), (h1,), (h1, h2), (h2,), (h2, 2), (2,)]
    sizes = [int(np.prod(s)) for s in shapes]
    return shapes, np.r_[0, np.cumsum(sizes)]


def unpack(p, shapes, offsets):
    return [p[a:b].reshape(s) for a, b, s in zip(offsets[:-1], offsets[1:], shapes)]


def forward(p, x, shapes, offsets):
    w1, b1, w2, b2, w3, b3 = unpack(p, shapes, offsets)
    a = np.tanh(x @ w1 + b1)
    c = np.tanh(a @ w2 + b2)
    v = c @ w3 + b3
    return np.logaddexp(0, v), a, c, v


def fit_response(x, y_n, targets, amounts, sign, clip, hidden, maxiter, seed=18397):
    from scipy.optimize import minimize

    n_in = x.shape[1]
    shapes, offsets = layout(n_in, *hidden)
    rng = np.random.default_rng(seed)
    p0 = np.concatenate([rng.normal(0, 1 / np.sqrt(n_in), shapes[0]).ravel(), np.zeros(hidden[0]),
                         rng.normal(0, 1 / np.sqrt(hidden[0]), shapes[2]).ravel(), np.zeros(hidden[1]),
                         rng.normal(0, .1, shapes[4]).ravel(), np.full(2, -2.)])
    amounts = np.asarray(amounts, float)
    H = np.stack([amounts, amounts * amounts])
    reg = 1e-3

    def objective(p):
        coef, a, c, v = forward(p, x, shapes, offsets)
        mag0 = coef @ H
        mag = np.clip(mag0, 0.0, clip)
        y = y_n[:, None] * np.exp2(sign * mag)
        yc = np.minimum(y, 1.0)
        e = (lstar(yc) - targets) / 5.0
        loss = np.mean(e * e + .25 * e ** 4) + reg * np.mean(p * p)
        dpred = (2 * e + e ** 3) / e.size / 5.0
        dmag = dpred * dlstar(yc) * (y < 1.0) * y * np.log(2.0) * sign * ((mag0 > 0) & (mag0 < clip))
        dc = (dmag @ H.T) / (1 + np.exp(-np.clip(v, -50, 50)))
        w1, b1, w2, b2, w3, b3 = unpack(p, shapes, offsets)
        db = (dc @ w3.T) * (1 - c * c)
        da = (db @ w2.T) * (1 - a * a)
        grad = np.concatenate([(x.T @ da).ravel(), da.sum(0), (a.T @ db).ravel(), db.sum(0),
                               (c.T @ dc).ravel(), dc.sum(0)]) + 2 * reg * p / len(p)
        return loss, grad

    started = time.monotonic()
    res = minimize(objective, p0, jac=True, method="L-BFGS-B",
                   options={"maxiter": maxiter, "maxls": 30, "ftol": 1e-10, "gtol": 1e-6, "maxcor": 20})
    return res.x, {"iterations": int(res.nit), "loss": float(res.fun), "converged": bool(res.success),
                   "message": str(res.message), "seconds": round(time.monotonic() - started, 1)}


def chroma_alpha(lr_neutral, lr_variant):
    """α of log2 C = α·log2 G over chromatic, unclipped pixels (ProPhoto)."""
    yn = np.maximum(lr_neutral @ PP_LUMA, 1e-6)
    yv = np.maximum(lr_variant @ PP_LUMA, 1e-6)
    dn = lr_neutral - yn[:, None]
    dv = lr_variant - yv[:, None]
    nn2 = (dn * dn).sum(-1)
    c = (dv * dn).sum(-1) / np.maximum(nn2, 1e-12)
    ok = (np.sqrt(nn2) / yn > 0.08) & (c > 0) & (yn > 1e-3) & (lr_variant.max(-1) < 0.98) & (lr_neutral.max(-1) < 0.98)
    lg = np.log2(yv / yn)[ok]
    lc = np.log2(c[ok])
    m = np.abs(lg) > 0.1
    return float(np.sum(lg[m] * lc[m]) / np.sum(lg[m] * lg[m])) if m.sum() > 100 else 1.0


def load_dataset(path):
    z = np.load(path)
    meta = json.loads(bytes(z["meta"]).decode())
    return z, meta


def arrays(z, meta, scenes, op, features):
    sign = OPS[op][0]
    variants = meta["operations"][op]
    x = np.concatenate([z[f"{s}/features"][:, features] for s in scenes]).astype(np.float64)
    y_n = np.concatenate([z[f"{s}/yN"] for s in scenes]).astype(np.float64)
    l_lrn = {s: lstar(z[f"{s}/lr_neutral"] @ PP_LUMA) for s in scenes}
    t = np.concatenate([np.stack([lstar(z[f"{s}/yN"].astype(np.float64)) + lstar(z[f"{s}/lr_{v}"] @ PP_LUMA) - l_lrn[s]
                                  for v in variants], -1) for s in scenes])
    return x, y_n, t, list(variants.values()), sign


def fit_all(z, meta, scenes, features, hidden, maxiter):
    """features / hidden: {op: [...]}, {op: (h1, h2)}."""
    out = {}
    for op in OPS:
        x, y_n, t, amounts, sign = arrays(z, meta, scenes, op, features[op])
        mean, scale = x.mean(0), np.maximum(x.std(0), .05)
        xn = np.clip((x - mean) / scale, -6, 6)
        p, info = fit_response(xn, y_n, t, amounts, sign, CLIP_EV[op], hidden[op], maxiter)
        alphas = [chroma_alpha(np.concatenate([z[f"{s}/lr_neutral"] for s in scenes]),
                               np.concatenate([z[f"{s}/lr_{v}"] for s in scenes])) for v in meta["operations"][op]]
        out[op] = {"weights": p, "mean": mean, "scale": scale, "info": info,
                   "alpha": float(np.median(alphas)), "alphas": alphas,
                   "features": np.array(features[op]), "hidden": np.array(hidden[op])}
        print(op, info, "alpha", out[op]["alpha"], flush=True)
    return out


def fit(args) -> None:
    z, meta = load_dataset(args.dataset)
    scenes = [s["scene"] for s in meta["scenes"]]
    def parse_features(text):
        return list(range(26)) if text == "all" else [int(i) for i in text.split(",")]

    features = {"highlight": parse_features(args.features_highlight or args.features),
                "shadow": parse_features(args.features_shadow or args.features)}
    hidden = {op: tuple(int(h) for h in args.hidden.split(",")) for op in OPS}
    report = {"dataset": str(args.dataset), "features": features, "hidden": list(hidden), "folds": []}
    if args.folds == "dates":
        dates = sorted({s["date"] for s in meta["scenes"]})
        groups = [dates[i::args.fold_count] for i in range(args.fold_count)]
        for k, held_dates in enumerate(groups):
            held = [s["scene"] for s in meta["scenes"] if s["date"] in held_dates]
            train = [s for s in scenes if s not in held]
            models = fit_all(z, meta, train, features, hidden, args.maxiter)
            report["folds"].append({"fold": k, "held": held,
                                    "models": {op: {k2: (v.tolist() if isinstance(v, np.ndarray) else v)
                                                    for k2, v in m.items()} for op, m in models.items()}})
    models = fit_all(z, meta, scenes, features, hidden, args.maxiter)
    np.savez(args.out, **{f"{op}_{k}": v for op, m in models.items() for k, v in m.items()
                          if k in ("weights", "mean", "scale", "alpha", "features", "hidden")})
    report["final"] = {op: {"info": m["info"], "alpha": m["alpha"], "alphas": m["alphas"]} for op, m in models.items()}
    Path(args.out).with_suffix(".json").write_text(json.dumps(report, indent=1))


# ---------------------------------------------------------------- preset context (R23)

# The bundled presets' Highlights, Shadows and Exposure (crates/niho-develop/presets).
PRESET_HS_EV = {"bluesky2": (-59, 20, 0.42), "pastel": (-44, 41, 0.37), "colorful": (-88, 37, 0.56)}


def sample_pick(name: str, size: tuple[int, int], count: int) -> np.ndarray:
    """The dataset's sampled analysis pixels of a scene (the same as `dataset`)."""
    aw, ah = size
    y0, y1, x0, x1 = IM.crop_box(ah, aw, 0.04)
    yy, xx = np.meshgrid(np.arange(y0, y1), np.arange(x0, x1), indexing="ij")
    inner = (yy * aw + xx).ravel()
    seed = int(hashlib.sha256(name.encode()).hexdigest()[:8], 16)
    return np.random.default_rng(seed).choice(inner, size=min(count, inner.size), replace=False)


def nohs_slope(log_in: np.ndarray, log_out: np.ndarray, bins: int = 32) -> np.ndarray:
    """d log2 O / d log2 Y of NIHO's no-H/S rendering of a scene (a monotone binned curve)."""
    edges = np.quantile(log_in, np.linspace(0, 1, bins + 1))
    centers, medians = [], []
    for a, b in zip(edges[:-1], edges[1:]):
        m = (log_in >= a) & (log_in <= b)
        if m.sum() >= 20:
            centers.append(np.median(log_in[m]))
            medians.append(np.median(log_out[m]))
    centers, medians = np.array(centers), np.maximum.accumulate(np.array(medians))
    keep = np.r_[True, np.diff(centers) > 1e-3]
    centers, medians = centers[keep], medians[keep]
    if len(centers) < 3:
        return np.ones_like(log_in)
    d = np.gradient(medians, centers)
    d = np.convolve(np.r_[d[0], d, d[-1]], np.ones(3) / 3, mode="valid")
    return np.clip(np.nan_to_num(np.interp(log_in, centers, d), nan=1.0), 0.05, 2.0)


def preset_context(args) -> None:
    """Lightroom's H/S effect inside each bundled preset (preset_X vs preset_X_nohs), on NIHO's own
    niho-6 rendering of preset_X_nohs: target L* = L*(O_nohs) + L*(LR_preset) - L*(LR_nohs)."""
    z, meta = load_dataset(args.dataset)
    rounds = {Path(r["round"]).name: Path(r["round"]) for r in meta["rounds"]}
    renders = dict(item.split("=", 1) for item in args.nohs_renders)
    out = {}
    for sc in meta["scenes"]:
        name, size, rnd = sc["scene"], tuple(sc["size"]), sc["round"]
        pick = sample_pick(name, size, meta["samplesPerScene"])
        y_n = z[f"{name}/yN"].astype(np.float64)

        def y_at(path):
            return np.maximum(to_analysis(linear_srgb(path), size).reshape(-1, 3) @ PP_LUMA, 1e-6)[pick]

        for p in PRESET_HS_EV:
            lr_p = y_at(rounds[rnd] / "lr-export" / f"{name}__preset_{p}.jpg")
            lr_n = y_at(rounds[rnd] / "lr-export" / f"{name}__preset_{p}_nohs.jpg")
            o_n = y_at(Path(renders[rnd]) / f"{name}__preset_{p}_nohs.png")
            out[f"{name}/{p}/O"] = o_n.astype(np.float32)
            out[f"{name}/{p}/target"] = (lstar(o_n) + lstar(lr_p) - lstar(lr_n)).astype(np.float32)
            out[f"{name}/{p}/slope"] = nohs_slope(np.log2(y_n), np.log2(o_n)).astype(np.float32)
        print("preset context", name, flush=True)
    out["meta"] = np.frombuffer(json.dumps({"presets": PRESET_HS_EV, "renders": renders}).encode(), dtype=np.uint8)
    np.savez_compressed(args.out, **out)


def joint_arrays(z, meta, pc, scenes, preset_weight):
    """Single-operation samples and preset-context samples (features moved by the preset's exposure)."""
    xs, idx, base, slope, h, s, target, weight = [], [], [], [], [], [], [], []
    offset = 0
    for sc in scenes:
        feats = z[f"{sc}/features"].astype(np.float64)
        n = len(feats)
        y_n = z[f"{sc}/yN"].astype(np.float64)
        l_lrn = lstar(z[f"{sc}/lr_neutral"] @ PP_LUMA)
        xs.append(feats)
        for op, variants in meta["operations"].items():
            for v, amount in variants.items():
                idx.append(offset + np.arange(n)); base.append(np.log2(y_n)); slope.append(np.ones(n))
                h.append(np.full(n, amount if op == "highlight" else 0.0))
                s.append(np.full(n, amount if op == "shadow" else 0.0))
                target.append(lstar(y_n) + lstar(z[f"{sc}/lr_{v}"] @ PP_LUMA) - l_lrn)
                weight.append(np.ones(n))
        offset += n
        for p, (hv, sv, ev) in PRESET_HS_EV.items():
            shifted = feats.copy()
            shifted[:, 0] += ev
            shifted[:, 1] += ev
            xs.append(shifted)
            idx.append(offset + np.arange(n))
            offset += n
            base.append(np.log2(np.maximum(pc[f"{sc}/{p}/O"].astype(np.float64), 1e-6)))
            slope.append(pc[f"{sc}/{p}/slope"].astype(np.float64))
            h.append(np.full(n, -hv / 100.0)); s.append(np.full(n, sv / 100.0))
            target.append(pc[f"{sc}/{p}/target"].astype(np.float64))
            weight.append(np.full(n, preset_weight))
    cat = np.concatenate
    return cat(xs), cat(idx), cat(base), cat(slope), cat(h), cat(s), cat(target), cat(weight)


def fit_joint_response(xu, idx, base, slope, h, s, target, weight, init, hidden, maxiter, reg=1e-3):
    """Highlights and Shadows fitted together: g = -(h a_H + h^2 b_H) + (s a_S + s^2 b_S),
    predicted log2 Y = base + slope * g, loss on L* (e^2 + e^4/4, e = dL*/5)."""
    from scipy.optimize import minimize

    shapes, offsets = layout(xu.shape[1], *hidden)
    nh = offsets[-1]
    hh, ss = np.stack([h, h * h], -1), np.stack([s, s * s], -1)
    wsum = weight.sum()

    def objective(p):
        pH, pS = p[:nh], p[nh:]
        coefH, aH, cH, vH = forward(pH, xu, shapes, offsets)
        coefS, aS, cS, vS = forward(pS, xu, shapes, offsets)
        magH0, magS0 = (coefH[idx] * hh).sum(-1), (coefS[idx] * ss).sum(-1)
        g = -np.clip(magH0, 0, CLIP_EV["highlight"]) + np.clip(magS0, 0, CLIP_EV["shadow"])
        y = np.exp2(base + slope * g)
        yc = np.minimum(y, 1.0)
        e = (lstar(yc) - target) / 5.0
        loss = np.sum(weight * (e * e + .25 * e ** 4)) / wsum + reg * np.mean(p * p)
        dg = weight * (2 * e + e ** 3) / wsum / 5.0 * dlstar(yc) * (y < 1.0) * y * np.log(2.0) * slope
        grads = []
        for sign, mag0, clip, a, c, v, pp, amt in ((-1.0, magH0, CLIP_EV["highlight"], aH, cH, vH, pH, hh),
                                                   (1.0, magS0, CLIP_EV["shadow"], aS, cS, vS, pS, ss)):
            dmag = sign * dg * ((mag0 > 0) & (mag0 < clip))
            dcoef = np.stack([np.bincount(idx, weights=dmag * amt[:, j], minlength=len(xu)) for j in range(2)], -1)
            dc = dcoef / (1 + np.exp(-np.clip(v, -50, 50)))
            w1, b1, w2, b2, w3, b3 = unpack(pp, shapes, offsets)
            db = (dc @ w3.T) * (1 - c * c)
            da = (db @ w2.T) * (1 - a * a)
            grads.append(np.concatenate([(xu.T @ da).ravel(), da.sum(0), (a.T @ db).ravel(), db.sum(0),
                                         (c.T @ dc).ravel(), dc.sum(0)]))
        return loss, np.concatenate(grads) + 2 * reg * p / len(p)

    started = time.monotonic()
    res = minimize(objective, np.concatenate([init["highlight"], init["shadow"]]), jac=True, method="L-BFGS-B",
                   options={"maxiter": maxiter, "maxls": 30, "ftol": 1e-10, "gtol": 1e-6, "maxcor": 20})
    return res.x[:nh], res.x[nh:], {"iterations": int(res.nit), "loss": float(res.fun),
                                    "seconds": round(time.monotonic() - started, 1)}


def fit_joint(args) -> None:
    """Joint H/S on singles + preset context, warm-started from a `fit` model of the same scenes."""
    z, meta = load_dataset(args.dataset)
    pc = np.load(args.preset_context)
    warm = np.load(args.warm)
    scenes = [s["scene"] for s in meta["scenes"]]
    features = [int(i) for i in warm["highlight_features"]]
    hidden = tuple(int(v) for v in warm["highlight_hidden"])
    assert features == list(range(26)), "the joint fit reads all 26 features"
    xu, idx, base, slope, h, s, target, weight = joint_arrays(z, meta, pc, scenes, args.preset_weight)
    mean, scale = warm["highlight_mean"], warm["highlight_scale"]
    xn = np.clip((xu - mean) / scale, -6, 6)
    pH, pS, info = fit_joint_response(xn, idx, base, slope, h, s, target, weight,
                                      {"highlight": warm["highlight_weights"], "shadow": warm["shadow_weights"]},
                                      hidden, args.maxiter)
    print("joint", info, flush=True)
    out = {}
    for op, w in (("highlight", pH), ("shadow", pS)):
        out.update({f"{op}_weights": w, f"{op}_mean": warm[f"{op}_mean"], f"{op}_scale": warm[f"{op}_scale"],
                    f"{op}_alpha": warm[f"{op}_alpha"], f"{op}_features": warm[f"{op}_features"],
                    f"{op}_hidden": warm[f"{op}_hidden"]})
    np.savez(args.out, **out)
    Path(args.out).with_suffix(".json").write_text(json.dumps({"joint": info, "presetWeight": args.preset_weight,
                                                              "presets": PRESET_HS_EV}, indent=1))


# ---------------------------------------------------------------- export

def export(args) -> None:
    z = np.load(args.model)
    doc = {"schema": "niho.jpeg-response-models.v1", "featureSourceSha256": FEATURE_SOURCE_SHA256}
    for op in OPS:
        features = [int(i) for i in z[f"{op}_features"]]
        hidden = [int(h) for h in z[f"{op}_hidden"]]
        part = {k: z[f"{op}_{k}"] for k in ("weights", "mean", "scale")}
        buf = io.BytesIO()
        np.savez(buf, features=np.array(features), hidden=np.array(hidden), **part)
        source_sha = hashlib.sha256(buf.getvalue()).hexdigest()
        doc[op] = {"sourceSha256": source_sha, "features": features, "hidden": hidden,
                   "weights": [float(v) for v in part["weights"]], "mean": [float(v) for v in part["mean"]],
                   "scale": [float(v) for v in part["scale"]]}
        print(f"{op.upper()}_MODEL_SHA256 = {source_sha}")
    alpha = {op: float(z[f"{op}_alpha"]) for op in OPS}
    for op, value in (("highlight", args.highlight_alpha), ("shadow", args.shadow_alpha)):
        if value is not None:
            # Chosen on the teachers' presets (R18: the fitted 0.43 over-saturates a preset's
            # Highlights once contrast / vibrance / curves follow); recorded in NIHO6.md.
            alpha[op] = value
    doc["chroma"] = {"highlightAlpha": alpha["highlight"], "shadowAlpha": alpha["shadow"]}
    Path(args.out).write_text(json.dumps(doc, separators=(",", ":")) + "\n")


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    sub = ap.add_subparsers(dest="cmd", required=True)
    p = sub.add_parser("dataset")
    p.add_argument("--round", required=True, action="append", help="a teacher round (repeat for teachers2)")
    p.add_argument("--features-bin", required=True)
    p.add_argument("--out", required=True)
    p.add_argument("--samples-per-scene", type=int, default=SAMPLES_PER_SCENE)
    p = sub.add_parser("fit")
    p.add_argument("--dataset", required=True)
    p.add_argument("--out", required=True)
    p.add_argument("--features", default="all")
    p.add_argument("--features-highlight")
    p.add_argument("--features-shadow")
    p.add_argument("--hidden", default="24,16")
    p.add_argument("--folds", choices=("none", "dates"), default="none")
    p.add_argument("--fold-count", type=int, default=5)
    p.add_argument("--maxiter", type=int, default=600)
    p = sub.add_parser("preset-context")
    p.add_argument("--dataset", required=True)
    p.add_argument("--nohs-renders", required=True, action="append",
                   help="<round name>=<dir of niho-6 renders of preset_X_nohs inputs (<scene>__preset_X_nohs.png)>")
    p.add_argument("--out", required=True)
    p = sub.add_parser("fit-joint")
    p.add_argument("--dataset", required=True)
    p.add_argument("--preset-context", required=True)
    p.add_argument("--warm", required=True, help="a `fit` model (all 26 features) of the same scenes")
    p.add_argument("--out", required=True)
    p.add_argument("--preset-weight", type=float, default=0.4)
    p.add_argument("--maxiter", type=int, default=300)
    p = sub.add_parser("export")
    p.add_argument("--model", required=True)
    p.add_argument("--out", required=True)
    p.add_argument("--highlight-alpha", type=float)
    p.add_argument("--shadow-alpha", type=float)
    args = ap.parse_args()
    {"dataset": dataset, "fit": fit, "preset-context": preset_context, "fit-joint": fit_joint,
     "export": export}[args.cmd](args)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
