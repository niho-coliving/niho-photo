#!/usr/bin/env python3
"""試作: Sony ARW の埋め込み歪み補正（DistortionCorrParams）を、Apple の --lens-correction off の線形 TIFF に当てる。

  python3 sony_embedded_distortion.py <arw> <in.tiff> <out.tiff> [--rscale 1.01] [--vignetting] [--vscale 1.146]

DistortionCorrParams = [n, v0 .. v(n-1), 埋め草]。節点 r_i = i/(n-1)、倍率 f_i = 1 + v_i * 2^-14（Catmull-Rom で補間）。
補正後の画素 p（中心基準）は元画像の p * k * f(|p| * k / R) を読む（節点は枠の倍率を掛けた後の半径で引く）。R = 半対角 × rscale、
k = 枠の全周が元画像の内側を読む最大の倍率（カメラ / Lightroom と同じく黒い縁を出さない。k は両辺に出るので固定点で解く）。
apple-raw-linear 0.4.0 の `--lens-correction embedded` と同じ式。

rscale 1.01 は Lightroom の Adobe プロファイル補正に合わせた実測値（S10b・round6）: ZV-E10 II ＋ E PZ 16-50mm の 16・17・49mm と
FX30 ＋ E 16-55mm F2.8 G の 16・55mm で RMS 0.1〜0.3px。以前の式（p * f(|p| / R) * k）は焦点距離ごとに R を変える必要があった
（16mm 0.955・49mm 1.0・55mm 1.03。0.955 のままだと 55mm で RMS 2.6px）。
先頭の値が並びから外れる RAW（例 DSC09206 の 834）は 0 とみなす（中心付近は幾何にほぼ効かない）。

--vignetting: VignettingCorrParams = [n, v0 .. v(n-1)] の増幅 g_i = 2^-(0.5 - 2^(v_i * 2^-13 - 1))（darktable の埋め込み補正と
同じ形）を、元画像の半径（半対角 × vscale で正規化）で線形の画素に掛けてから歪みを直す。
"""
import argparse
import subprocess

import cv2
import numpy as np


def tag(arw: str, name: str) -> np.ndarray:
    # SubIFD の平文（SR2SubIFD は暗号化の写し。Sony MakerNote の同名タグは別の刻み）
    out = subprocess.run(["exiftool", "-s3", f"-SubIFD:{name}", arw], capture_output=True, text=True, check=True).stdout.split()
    vals = [int(v) for v in out]
    return np.array(vals[1:1 + vals[0]], dtype=np.float64)


def params(arw: str) -> np.ndarray:
    v = tag(arw, "DistortionCorrParams")
    if abs(v[0]) > 4 * max(1.0, abs(v[1])):
        v[0] = 0.0
    return v


def catmull_rom(f: np.ndarray, r: np.ndarray) -> np.ndarray:
    n = len(f)
    t = np.clip(r, 0.0, 1.0) * (n - 1)
    i = np.clip(np.floor(t).astype(int), 0, n - 2)
    u = t - i
    fp = np.concatenate([[2 * f[0] - f[1]], f, [2 * f[-1] - f[-2]]])
    p0, p1, p2, p3 = fp[i], fp[i + 1], fp[i + 2], fp[i + 3]
    return 0.5 * (2 * p1 + (-p0 + p2) * u + (2 * p0 - 5 * p1 + 4 * p2 - p3) * u ** 2 + (-p0 + 3 * p1 - 3 * p2 + p3) * u ** 3)


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    ap.add_argument("arw")
    ap.add_argument("inp")
    ap.add_argument("out")
    ap.add_argument("--rscale", type=float, default=1.01, help="歪みの正規化半径（半対角）の倍率")
    ap.add_argument("--vignetting", action="store_true", help="VignettingCorrParams で周辺減光も直す")
    ap.add_argument("--vscale", type=float, default=1.146, help="周辺減光の正規化半径（半対角）の倍率")
    a = ap.parse_args()
    f = 1.0 + params(a.arw) * 2.0 ** -14
    img = cv2.imread(a.inp, cv2.IMREAD_UNCHANGED)
    h, w = img.shape[:2]
    cx, cy = (w - 1) / 2.0, (h - 1) / 2.0
    yy, xx = np.mgrid[0:h, 0:w].astype(np.float64)
    px, py = xx - cx, yy - cy
    R = np.hypot(w / 2.0, h / 2.0) * a.rscale
    if a.vignetting:
        vv = tag(a.arw, "VignettingCorrParams")
        gain = 2.0 ** -(0.5 - 2.0 ** (vv * 2.0 ** -13 - 1.0))
        g = np.interp(np.clip(np.hypot(px, py) / (np.hypot(w / 2.0, h / 2.0) * a.vscale), 0, 1), np.linspace(0, 1, len(gain)), gain)
        img = (img.astype(np.float64) * g[..., None]).astype(img.dtype)
    rr = np.hypot(px, py)
    k = 1.0
    for _ in range(50):  # k は両辺に出る（節点を |p| * k / R で引く）ので固定点で解く
        fr = catmull_rom(f, rr * k / R)
        border = [(px[0], py[0], fr[0]), (px[-1], py[-1], fr[-1]), (px[:, 0], py[:, 0], fr[:, 0]), (px[:, -1], py[:, -1], fr[:, -1])]
        k_next = min(float(np.min(np.minimum(cx / np.maximum(np.abs(bx * bf), 1e-9), cy / np.maximum(np.abs(by * bf), 1e-9))))
                     for bx, by, bf in border)
        done = abs(k_next - k) < 1e-12
        k = k_next
        if done:
            break
    fr = catmull_rom(f, rr * k / R) * k
    out = cv2.remap(img, (cx + px * fr).astype(np.float32), (cy + py * fr).astype(np.float32),
                    interpolation=cv2.INTER_LANCZOS4, borderMode=cv2.BORDER_REFLECT)
    cv2.imwrite(a.out, out)
    print(f"n={len(f)} f(0)={f[0]:.4f} f(1)={f[-1]:.4f} rscale={a.rscale} vignetting={a.vignetting} k={k:.4f} -> {a.out}")


if __name__ == "__main__":
    main()
