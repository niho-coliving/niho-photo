#!/usr/bin/env python3
"""ΔE00 between the crate's and Core Image's decode of LUT-profile PNGs.

  cargo run --release -p niho-develop --example icc_lut_profiles -- <dir>
  swiftc -O scripts/golden/icc_reference.swift -o /tmp/icc_reference && /tmp/icc_reference <dir>
  python3 scripts/golden/icc_compare.py <dir>

Per case: crate vs Core Image, and each against `p3-matrix` decoded by the
crate (the exact Display P3 colors the LUT profiles sample). Needs numpy.
"""
import glob, os, sys
import numpy as np

# DNG SDK linear sRGB -> XYZ (D50), as in the crate.
SRGB_TO_XYZ = np.array([[0.4361, 0.3851, 0.1431], [0.2225, 0.7169, 0.0606], [0.0139, 0.0971, 0.7141]])


def lab(rgb):
    xyz = rgb @ SRGB_TO_XYZ.T / (SRGB_TO_XYZ @ np.ones(3))
    e = (6 / 29) ** 3
    f = np.where(xyz > e, np.cbrt(np.maximum(xyz, 0)), xyz / (3 * (6 / 29) ** 2) + 4 / 29)
    return np.stack([116 * f[:, 1] - 16, 500 * (f[:, 0] - f[:, 1]), 200 * (f[:, 1] - f[:, 2])], 1)


def de00(p, q):
    (L1, a1, b1), (L2, a2, b2) = p.T, q.T
    cb = (np.hypot(a1, b1) + np.hypot(a2, b2)) / 2
    g = 0.5 * (1 - np.sqrt(cb**7 / (cb**7 + 25**7)))
    a1p, a2p = (1 + g) * a1, (1 + g) * a2
    c1p, c2p = np.hypot(a1p, b1), np.hypot(a2p, b2)
    h1, h2 = np.degrees(np.arctan2(b1, a1p)) % 360, np.degrees(np.arctan2(b2, a2p)) % 360
    dh = h2 - h1
    dh = np.where(np.abs(dh) > 180, dh - 360 * np.sign(dh), dh)
    dH = 2 * np.sqrt(c1p * c2p) * np.sin(np.radians(dh / 2))
    lb, cbp = (L1 + L2) / 2, (c1p + c2p) / 2
    hb = np.where(np.abs(h1 - h2) > 180, (h1 + h2 + 360) / 2, (h1 + h2) / 2)
    t = (1 - 0.17 * np.cos(np.radians(hb - 30)) + 0.24 * np.cos(np.radians(2 * hb))
         + 0.32 * np.cos(np.radians(3 * hb + 6)) - 0.2 * np.cos(np.radians(4 * hb - 63)))
    sl = 1 + 0.015 * (lb - 50) ** 2 / np.sqrt(20 + (lb - 50) ** 2)
    sc, sh = 1 + 0.045 * cbp, 1 + 0.015 * cbp * t
    rt = -2 * np.sqrt(cbp**7 / (cbp**7 + 25**7)) * np.sin(np.radians(60 * np.exp(-(((hb - 275) / 25) ** 2))))
    dl, dc = L2 - L1, c2p - c1p
    return np.sqrt((dl / sl) ** 2 + (dc / sc) ** 2 + (dH / sh) ** 2 + rt * (dc / sc) * (dH / sh))


def main(d):
    load = lambda name, kind: np.fromfile(os.path.join(d, f"{name}.{kind}.f32"), dtype="<f4").reshape(-1, 3).astype(np.float64)
    truth = lab(load("p3-matrix", "crate"))
    print("| case | crate vs Core Image mean / p99 / max | crate vs P3 mean | Core Image vs P3 mean |")
    print("|---|---|---|---|")
    for path in sorted(glob.glob(os.path.join(d, "*.crate.f32"))):
        name = os.path.basename(path)[: -len(".crate.f32")]
        if not os.path.exists(os.path.join(d, f"{name}.ci.f32")):
            continue
        c, ci = lab(load(name, "crate")), lab(load(name, "ci"))
        x = de00(c, ci)
        print(f"| {name} | {x.mean():.3f} / {np.percentile(x, 99):.3f} / {x.max():.3f} | "
              f"{de00(c, truth).mean():.3f} | {de00(ci, truth).mean():.3f} |")


if __name__ == "__main__":
    main(sys.argv[1])
