#!/usr/bin/env python3
"""機種ごとの白の行列の表（`niho-develop-wb-table/v1`・S11 #17108）を Apple の RAW 現像から計測する。式は `wbtable.py`。

1 枚の RAW を、基準の白と格子の節点の白（Lightroom の尺度。校正の `whiteBalanceMap` の逆で Apple の白に直して
`apple-raw-linear render --white` に渡す）で、色域の圧縮を切って小さく描き、節点ごとに `out(w) = M(w) · out(基準)` の 3×3 を
最小二乗で当てはめて逆行列を表にする。続けて、格子の外の白（ランダム）と、ほかの RAW（`--verify-raw`）で、表から予測した
出力と実際に描いた出力を比べる（相対 RMS と表示の ΔE00）。

  python3 fit_wb_table.py --raw <RAW> --calibration <校正 JSON> --out <表 JSON> [--into-calibration <校正 JSON>]
      [--verify-raw <RAW> ...] [--bin apple-raw-linear] [--work <dir>] [--long-edge 384] [--jobs 3] [--report <md>]

- `--calibration` の `decoder.decoderVersion` と `whiteBalanceMap` を読み、校正と同じ decoder で計測する（画素には校正行列を当てない。表は Apple の出力の空間）。
- `--into-calibration` を付けると、その校正 JSON の `whiteBalanceTable` に書き込む（ほかの項目は変えない）。
- 描いた TIFF は `--work`（既定 `$NIHO_COLOR_WORK_DIR/wb-table`）に保存し、RAW・白の写像・decoder・CLI版・macOS build・描画条件が一致した場合だけ再利用する。
"""
from __future__ import annotations

import argparse
import concurrent.futures as cf
import hashlib
import json
import os
import platform
import subprocess
import sys
from pathlib import Path

import cv2
import numpy as np

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))
sys.path.insert(0, str(HERE.parent / "colorcheck"))
import wbtable as WT  # noqa: E402
from wbmodel import temperature_from_xy, xy_from_temperature  # noqa: E402

from colorcheck import color as C  # noqa: E402

ENGINE = HERE.parents[1]
DEFAULT_BIN = ENGINE / "tools" / "apple-raw-linear" / ".build" / "release" / "apple-raw-linear"
# 当てはめに使う画素: 元の描画（白 a）で全チャンネルが (0.0005, 0.6)。センサーの飽和は白によらないので、元で飽和から十分
# 離れていれば行き先（白 b）で 0.6 を超えても線形のまま（行き先には有限であることだけを求める）
VALID_LO, VALID_HI = 0.0005, 0.6


def log(msg: str) -> None:
    print(f"[fit_wb_table] {msg}", file=sys.stderr, flush=True)


class Renderer:
    def __init__(self, binary: Path, work: Path, long_edge: int, white_balance_map: dict | None,
                 decoder_version: str):
        self.binary, self.work, self.long_edge, self.map = binary, work, long_edge, white_balance_map
        self.decoder_version = decoder_version
        self.binary_version = tool_version(binary)
        self.macos = macos_build()
        work.mkdir(parents=True, exist_ok=True)

    def apple_white(self, temperature: float, tint: float) -> tuple[float, float]:
        """Lightroom の尺度の（K, tint）→ Apple の尺度の（K, tint）（`--white` に渡す値。校正を渡さないので写像はこちらで当てる）。"""
        xy = WT.lightroom_to_apple(xy_from_temperature(temperature, tint), self.map)
        return temperature_from_xy(*xy)

    def render(self, raw: Path, temperature: float, tint: float) -> np.ndarray:
        k, t = self.apple_white(temperature, tint)
        key = render_cache_key(
            raw,
            binary=self.binary,
            binary_version=self.binary_version,
            macos=self.macos,
            decoder_version=self.decoder_version,
            long_edge=self.long_edge,
            white_balance_map=self.map,
            lightroom_white=(temperature, tint),
            apple_white=(k, t),
        )
        out = self.work / f"{raw.stem}_{self.long_edge}_{temperature:.1f}_{tint:+.1f}_{key[:32]}.tiff"
        if not out.is_file() or not out.with_suffix(".json").is_file():
            cmd = [str(self.binary), "render", str(raw), "--out", str(out), "--meta", str(out.with_suffix(".json")),
                   "--long-edge", str(self.long_edge), "--space", "linear-prophoto", "--encoding", "tiff32f",
                   "--decoder-version", self.decoder_version, "--lens-correction", "off", "--gamut-mapping", "off",
                   "--white", f"{k:.4f},{t:.4f}"]
            r = subprocess.run(cmd, capture_output=True, text=True)
            if r.returncode != 0:
                raise SystemExit(f"apple-raw-linear failed for {raw.name} at {temperature}K/{tint}: {r.stderr[-400:]}")
        img = cv2.imread(str(out), cv2.IMREAD_UNCHANGED)
        if img is None:
            raise SystemExit(f"cannot read {out}")
        return img[..., ::-1].reshape(-1, 3).astype(np.float64)


def valid(src: np.ndarray, dst: np.ndarray) -> np.ndarray:
    return (src.min(axis=-1) > VALID_LO) & (src.max(axis=-1) < VALID_HI) & np.all(np.isfinite(dst), axis=-1)


def fit_matrix(src: np.ndarray, dst: np.ndarray) -> tuple[np.ndarray, float, int]:
    """dst ≈ M · src の M と相対 RMS。"""
    m = valid(src, dst)
    if m.sum() < 1000:
        raise SystemExit(f"too few usable pixels ({int(m.sum())}) to fit a matrix")
    x = np.linalg.lstsq(src[m], dst[m], rcond=None)[0]
    return x.T, relative_rms(src[m] @ x, dst[m]), int(m.sum())


def relative_rms(pred: np.ndarray, actual: np.ndarray) -> float:
    return float(np.sqrt(np.mean((pred - actual) ** 2)) / np.sqrt(np.mean(actual ** 2)))


def display_delta_e(pred: np.ndarray, actual: np.ndarray, m: np.ndarray) -> tuple[float, float]:
    a = C.linear_srgb_to_lab(C.render_display_linear(np.clip(pred[m], 0, None), 0.0, None))
    b = C.linear_srgb_to_lab(C.render_display_linear(np.clip(actual[m], 0, None), 0.0, None))
    d = C.delta_e00(a, b)
    return float(d.mean()), float(np.percentile(d, 99))


def tool_version(binary: Path) -> str:
    r = subprocess.run([str(binary), "version"], capture_output=True, text=True)
    return (r.stdout.strip() or r.stderr.strip()).splitlines()[0] if (r.stdout or r.stderr) else "unknown"


def macos_build() -> str:
    r = subprocess.run(["sw_vers"], capture_output=True, text=True)
    info = {k.strip(): v.strip() for k, v in (line.split(":", 1) for line in r.stdout.strip().splitlines() if ":" in line)}
    return f"{info.get('ProductVersion', platform.mac_ver()[0])} ({info.get('BuildVersion', '?')})"


def calibration_decoder_version(calibration: dict) -> str:
    decoder = calibration.get("decoder")
    value = decoder.get("decoderVersion") if isinstance(decoder, dict) else None
    if isinstance(value, bool) or not isinstance(value, (str, int)):
        raise SystemExit("calibration.decoder.decoderVersion must be a positive integer")
    version = str(value).strip()
    if not version.isdecimal() or int(version) < 1:
        raise SystemExit("calibration.decoder.decoderVersion must be a positive integer")
    return version


def render_cache_key(
    raw: Path,
    *,
    binary: Path,
    binary_version: str,
    macos: str,
    decoder_version: str,
    long_edge: int,
    white_balance_map: dict | None,
    lightroom_white: tuple[float, float],
    apple_white: tuple[float, float],
) -> str:
    stat = raw.stat()
    identity = {
        "schema": "apple-raw-linear-render-cache/v2",
        "source": {
            "path": str(raw.resolve()),
            "size": stat.st_size,
            "mtimeNs": stat.st_mtime_ns,
        },
        "render": {
            "binary": str(binary.resolve()),
            "binaryVersion": binary_version,
            "macOS": macos,
            "decoderVersion": decoder_version,
            "longEdge": int(long_edge),
            "space": "linear-prophoto",
            "encoding": "tiff32f",
            "lensCorrection": "off",
            "gamutMapping": "off",
        },
        "whiteBalanceMap": white_balance_map,
        "lightroomWhite": [float(lightroom_white[0]), float(lightroom_white[1])],
        "appleWhite": [float(apple_white[0]), float(apple_white[1])],
    }
    encoded = json.dumps(identity, sort_keys=True, separators=(",", ":"), ensure_ascii=False, allow_nan=False)
    return hashlib.sha256(encoded.encode("utf-8")).hexdigest()


def main(argv=None) -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--raw", required=True, type=Path)
    ap.add_argument("--calibration", required=True, type=Path)
    ap.add_argument("--out", required=True, type=Path)
    ap.add_argument("--into-calibration", type=Path)
    ap.add_argument("--verify-raw", type=Path, nargs="*", default=[])
    ap.add_argument("--bin", type=Path, default=Path(os.environ.get("APPLE_RAW_LINEAR_BIN", DEFAULT_BIN)))
    ap.add_argument("--work", type=Path, default=Path(os.environ.get("NIHO_COLOR_WORK_DIR", "OWNER_DATA_ROOT")) / "wb-table")
    ap.add_argument("--long-edge", type=int, default=384)
    ap.add_argument("--jobs", type=int, default=3)
    ap.add_argument("--random-checks", type=int, default=24)
    ap.add_argument("--report", type=Path)
    args = ap.parse_args(argv)

    cal = json.loads(args.calibration.read_text(encoding="utf-8"))
    decoder_version = calibration_decoder_version(cal)
    target_cal = None
    if args.into_calibration:
        target_cal = json.loads(args.into_calibration.read_text(encoding="utf-8"))
        try:
            WT.require_single_illuminant_for_table(target_cal, str(args.into_calibration))
        except ValueError as exc:
            raise SystemExit(str(exc)) from exc
    rnd = Renderer(args.bin, args.work, args.long_edge, cal.get("whiteBalanceMap"), decoder_version)
    ref_w = (WT.REFERENCE["temperature"], WT.REFERENCE["tint"])
    ref = rnd.render(args.raw, *ref_w)
    nodes = [(1e6 / m, t) for m in WT.DEFAULT_MIRED for t in WT.DEFAULT_TINT]
    log(f"{args.raw.name}: {len(nodes)} nodes (mired {WT.DEFAULT_MIRED[0]:.0f}..{WT.DEFAULT_MIRED[-1]:.0f} × tint {len(WT.DEFAULT_TINT)})")
    with cf.ThreadPoolExecutor(args.jobs) as ex:
        images = list(ex.map(lambda w: rnd.render(args.raw, *w), nodes))
    inverses, residuals = [], []
    for img in images:
        m, res, _ = fit_matrix(ref, img)
        inverses.append(np.linalg.inv(m))
        residuals.append(res)
    inverses = np.asarray(inverses).reshape(len(WT.DEFAULT_MIRED), len(WT.DEFAULT_TINT), 3, 3)
    measured = {"raw": args.raw.name, "longEdge": args.long_edge, "tool": rnd.binary_version, "macOS": rnd.macos,
                "decoderVersion": decoder_version, "gamutMapping": False, "lensCorrection": "off",
                "validPixels": f"source render: every channel in ({VALID_LO}, {VALID_HI})",
                "nodeFitResidual": {"max": round(max(residuals), 6), "mean": round(float(np.mean(residuals)), 6)},
                "whiteBalanceMap": cal.get("whiteBalanceMap", {}).get("model") if cal.get("whiteBalanceMap") else None}
    table_json = WT.build(WT.DEFAULT_MIRED, WT.DEFAULT_TINT, inverses, measured)
    table = WT.WhiteBalanceTable(table_json)

    # 格子の外の白（ランダム）: 表の補間で予測した出力 vs 実際に描いた出力
    rng = np.random.default_rng(17108)
    checks = []
    for _ in range(args.random_checks):
        mired = rng.uniform(1e6 / 12000, 1e6 / 2200)
        tint = float(rng.choice([rng.uniform(-60, 60), rng.uniform(-150, 150)], p=[0.75, 0.25]))
        w = (1e6 / mired, tint)
        actual = rnd.render(args.raw, *w)
        pred = ref @ table.transfer(ref_w, w).T
        m = valid(ref, actual)
        de = display_delta_e(pred, actual, m)
        checks.append({"white": [round(w[0], 1), round(w[1], 1)], "relativeRms": round(relative_rms(pred[m], actual[m]), 6),
                       "deltaE00Mean": round(de[0], 4), "deltaE00P99": round(de[1], 4)})
    # ほかの RAW: 撮影時に近い白 → 大きく動かした白（写真によらないことの確認）
    others = []
    for raw in args.verify_raw:
        for a, b in (((3400.0, 5.0), (6500.0, -10.0)), ((5000.0, 0.0), (7500.0, 20.0)), ((5500.0, 0.0), (3000.0, -20.0))):
            src, dst = rnd.render(raw, *a), rnd.render(raw, *b)
            pred = src @ table.transfer(a, b).T
            m = valid(src, dst)
            de = display_delta_e(pred, dst, m)
            others.append({"raw": raw.name, "from": list(a), "to": list(b), "relativeRms": round(relative_rms(pred[m], dst[m]), 6),
                           "deltaE00Mean": round(de[0], 4), "deltaE00P99": round(de[1], 4)})
    table_json["measured"]["offGridChecks"] = {
        "count": len(checks), "relativeRmsMax": max(c["relativeRms"] for c in checks),
        "deltaE00MeanMax": max(c["deltaE00Mean"] for c in checks), "deltaE00P99Max": max(c["deltaE00P99"] for c in checks)}
    if others:
        table_json["measured"]["otherRaws"] = {
            "raws": sorted({o["raw"] for o in others}), "relativeRmsMax": max(o["relativeRms"] for o in others),
            "deltaE00MeanMax": max(o["deltaE00Mean"] for o in others), "deltaE00P99Max": max(o["deltaE00P99"] for o in others)}
    args.out.parent.mkdir(parents=True, exist_ok=True)
    args.out.write_text(WT.dumps(table_json), encoding="utf-8")
    if args.into_calibration and target_cal is not None:
        target_cal["whiteBalanceTable"] = table_json
        args.into_calibration.write_text(WT.dumps(target_cal), encoding="utf-8")
    lines = [f"# 白の行列の表 — {cal.get('camera', {}).get('model', '?')}（{args.raw.name}）", "",
             f"- 節点 {len(nodes)}（当てはめの相対 RMS 最大 {measured['nodeFitResidual']['max']:.2e}）・{measured['tool']}・macOS {measured['macOS']}",
             f"- 格子の外の白 {len(checks)} 通り: 相対 RMS 最大 {table_json['measured']['offGridChecks']['relativeRmsMax']:.4f}・"
             f"表示 ΔE00 mean 最大 {table_json['measured']['offGridChecks']['deltaE00MeanMax']:.3f}・p99 最大 {table_json['measured']['offGridChecks']['deltaE00P99Max']:.3f}"]
    if others:
        o = table_json["measured"]["otherRaws"]
        lines.append(f"- ほかの RAW {len(o['raws'])} 枚 × 3 通り: 相対 RMS 最大 {o['relativeRmsMax']:.4f}・表示 ΔE00 mean 最大 {o['deltaE00MeanMax']:.3f}・p99 最大 {o['deltaE00P99Max']:.3f}")
    lines += ["", "| 白 (K / tint) | 相対 RMS | ΔE00 mean | p99 |", "|---|---:|---:|---:|"]
    lines += [f"| {c['white'][0]:.0f} / {c['white'][1]:+.0f} | {c['relativeRms']:.4f} | {c['deltaE00Mean']:.3f} | {c['deltaE00P99']:.3f} |" for c in checks]
    lines += [f"| {o['raw']} {o['from'][0]:.0f}/{o['from'][1]:+.0f} → {o['to'][0]:.0f}/{o['to'][1]:+.0f} | {o['relativeRms']:.4f} | {o['deltaE00Mean']:.3f} | {o['deltaE00P99']:.3f} |" for o in others]
    md = "\n".join(lines) + "\n"
    print(md)
    if args.report:
        args.report.write_text(md, encoding="utf-8")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
