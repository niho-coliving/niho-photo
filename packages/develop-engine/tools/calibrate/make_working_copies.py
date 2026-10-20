#!/usr/bin/env python3
"""Apple の線形出力（tiff32f・linear ProPhoto）と校正 JSON から、段 2 の crate が読む作業コピーを作る。

作業コピーの契約（crate `decode.rs`、spec「作業コピー」）: 16bit RGB PNG、値 = 2.0 × (code/65535)^1.8、
linear ProPhoto（D50）、露出前。メタ JSON: {"kind":"raw","baselineEV":..,"asShotWhite":{x,y,temperature,tint},
"dcpSha256":..,"lookTableIncluded":false}。

校正の行列は画素に焼き、baselineEV はメタで渡す（段 2 が 2^(baselineEV + exposure) を掛ける）。
校正 JSON に whiteBalanceMap があれば、Adobe が as-shot と見る白（asShotWhiteAdobe: x, y, temperature, tint）も
メタに書く（段 2 が Lightroom の絶対 WB を再現する色順応の出発点。提案。crate はまだ読まない）。
校正 JSON に白の行列の表（whiteBalanceTable・S11 #17108）があれば、表と当てた校正の行列（calibrationMatrix）をメタに写す
（計測用。本番の作業コピーは apple-raw-linear 0.4.2 以降が描くたびの自己点検つきで書く。ここでは点検しないので check.status = not-run）。
表は `appliedSettings.assigned.isGamutMappingEnabled` が明示的に `false` の入力だけに付ける。複数の校正行列（2 光源）とは組み合わせられない。

使い方:
  python3 make_working_copies.py --calibration <apple-v1.json> --linear-dir <work>/apple-linear/v8 \
      --out-dir <work>/working-copy [--scenes P1012822 ...]
"""
from __future__ import annotations

import argparse
import glob
import json
import os
import sys

import cv2
import numpy as np

sys.path.insert(0, os.path.abspath(os.path.join(os.path.dirname(__file__), "..", "colorcheck")))
from colorcheck.calibration import from_dict as load_calibration  # noqa: E402

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from wbmodel import temperature_from_xy  # noqa: E402
import wbtable as WT  # noqa: E402

WORKING_COPY_GAMMA = 1.8
WORKING_COPY_MAX = 2.0


def matrix_for_scene(calibration, neutral: dict, scene: str) -> np.ndarray:
    """Resolve a scene-specific matrix when the calibration has illuminant nodes."""
    if not calibration.illuminants:
        return calibration.matrix

    raw_temperature = (neutral or {}).get("temperatureK")
    try:
        neutral_k = float(raw_temperature)
    except (TypeError, ValueError, OverflowError) as exc:
        raise ValueError(f"{scene}: 2 光源校正には入力メタの neutral.temperatureK が必要") from exc
    if not np.isfinite(neutral_k) or neutral_k <= 0:
        raise ValueError(f"{scene}: neutral.temperatureK は有限の正数である必要があります")
    return calibration.matrix_for(neutral_k)


def gamut_mapping_is_disabled(meta: dict) -> bool:
    applied = meta.get("appliedSettings") or {}
    assigned = applied.get("assigned") if isinstance(applied, dict) else None
    return isinstance(assigned, dict) and assigned.get("isGamutMappingEnabled") is False


def main(argv=None) -> int:
    ap = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    ap.add_argument("--calibration", required=True)
    ap.add_argument("--linear-dir", required=True, help="apple-raw-linear の tiff32f（linear-prophoto）と .json があるフォルダ")
    ap.add_argument("--out-dir", required=True)
    ap.add_argument("--scenes", nargs="*")
    ap.add_argument("--no-matrix", action="store_true", help="校正の行列を当てない（比較用）")
    args = ap.parse_args(argv)

    cal = json.load(open(args.calibration))
    calibration = load_calibration(cal, args.calibration)
    if cal.get("workingSpace") != "linear-prophoto-d50" or cal["matrix"].get("space") != "linear-prophoto-d50":
        print("error: 校正 JSON の作業空間が linear-prophoto-d50 ではない", file=sys.stderr)
        return 2
    if cal.get("hueSat"):
        print("error: hueSat 付きの校正はこのスクリプトでは当てられない", file=sys.stderr)
        return 2
    has_white_balance_table = bool(cal.get("whiteBalanceTable"))
    if has_white_balance_table:
        try:
            WT.require_single_illuminant_for_table(cal, args.calibration)
        except ValueError as exc:
            print(f"error: {exc}", file=sys.stderr)
            return 2
    baseline_ev = float(cal.get("baselineEV") or 0.0)
    scenes = args.scenes or sorted(os.path.splitext(os.path.basename(p))[0] for p in glob.glob(os.path.join(args.linear_dir, "*.tiff")))
    input_metas = {}
    for scene in scenes:
        meta_in = json.load(open(os.path.join(args.linear_dir, f"{scene}.json")))
        if has_white_balance_table and not gamut_mapping_is_disabled(meta_in):
            print(
                f"error: {scene}: whiteBalanceTable を作業コピーへ付けるには "
                "appliedSettings.assigned.isGamutMappingEnabled が明示的に false である必要があります",
                file=sys.stderr,
            )
            return 2
        input_metas[scene] = meta_in
    os.makedirs(args.out_dir, exist_ok=True)
    for scene in scenes:
        tiff = os.path.join(args.linear_dir, f"{scene}.tiff")
        meta_in = input_metas[scene]
        if (meta_in.get("space") or {}).get("name") != "linear-prophoto":
            print(f"error: {scene}: 入力が linear-prophoto ではない", file=sys.stderr)
            return 2
        img = cv2.imread(tiff, cv2.IMREAD_UNCHANGED)
        if img is None or img.dtype != np.float32 or img.ndim != 3:
            print(f"error: {scene}: 32bit float の 3ch TIFF として読めない", file=sys.stderr)
            return 2
        rgb = img[..., :3][..., ::-1].astype(np.float64)
        matrix = np.eye(3)
        if not args.no_matrix:
            try:
                matrix = matrix_for_scene(calibration, meta_in.get("neutral") or {}, scene)
            except ValueError as exc:
                print(f"error: {exc}", file=sys.stderr)
                return 2
            rgb = rgb @ matrix.T
        clipped_hi = float((rgb.max(axis=-1) > WORKING_COPY_MAX).mean())
        clipped_lo = float((rgb.min(axis=-1) < 0).mean())
        rgb = np.clip(rgb, 0.0, WORKING_COPY_MAX)
        code = np.rint(np.power(rgb / WORKING_COPY_MAX, 1.0 / WORKING_COPY_GAMMA) * 65535.0).astype(np.uint16)
        out_png = os.path.join(args.out_dir, f"{scene}.png")
        cv2.imwrite(out_png, np.ascontiguousarray(code[..., ::-1]))
        neutral = meta_in.get("neutral") or {}
        adobe = None
        wbmap = cal.get("whiteBalanceMap")
        if wbmap and wbmap.get("model") == "uv-offset" and neutral.get("x") and neutral.get("y"):
            x, y = float(neutral["x"]), float(neutral["y"])
            d = 1.5 - x + 6.0 * y
            u, v = 2.0 * x / d + float(wbmap["du"]), 3.0 * y / d + float(wbmap["dv"])
            d2 = u - 4.0 * v + 2.0
            ax, ay = 1.5 * u / d2, v / d2
            ak, at = temperature_from_xy(ax, ay)
            adobe = {"x": round(ax, 6), "y": round(ay, 6), "temperature": round(ak, 1), "tint": round(at, 2),
                     "source": "calibration.whiteBalanceMap (uv-offset from Apple as-shot)"}
        meta = {
            "kind": "raw",
            "baselineEV": baseline_ev,
            "asShotWhite": {"x": neutral.get("x"), "y": neutral.get("y"),
                            "temperature": neutral.get("temperatureK"), "tint": neutral.get("tint")},
            "dcpSha256": cal.get("baseVersion") or "",
            "lookTableIncluded": False,
            # 提案（S3/S4 へ）: Lightroom の絶対 WB を再現する色順応の出発点。crate が読むようになるまでは付加情報。
            "asShotWhiteAdobe": adobe,
            "whiteBalanceTable": ({**cal["whiteBalanceTable"], "calibrationMatrix": [round(float(v), 7) for v in np.asarray(matrix).ravel()],
                                   "check": {"status": "not-run", "source": "make_working_copies.py"}}
                                  if cal.get("whiteBalanceTable") else None),
            "_source": {"tool": "make_working_copies.py", "input": tiff, "calibration": os.path.abspath(args.calibration),
                        "matrixApplied": not args.no_matrix, "decoderVersion": meta_in.get("decoderVersion"),
                        "clippedAbove2Fraction": round(clipped_hi, 6), "negativeFraction": round(clipped_lo, 6),
                        "encoding": "png16 gamma 1.8 ceiling 2.0 linear ProPhoto D50"},
        }
        json.dump(meta, open(os.path.join(args.out_dir, f"{scene}.json"), "w"), indent=1)
        print(f"{scene}: {code.shape[1]}x{code.shape[0]} clipped>2 {clipped_hi*100:.3f}% negative {clipped_lo*100:.3f}% → {out_png}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
