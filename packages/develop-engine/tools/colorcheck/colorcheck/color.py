"""Color math shared by colorcheck and calibrate (NIHO develop engine, S9).

Every constant here follows the S9 spec ("色の数学（両担当で共通）") so the
Python tools, the Swift track (S9a) and the Rust crate compute the same numbers.
Arrays carry the channel axis last: shape (..., 3).  float32 input stays
float32 (images); everything else is computed in float64.
"""
from __future__ import annotations

import json
import os
from functools import lru_cache

import numpy as np

DATA_DIR = os.path.join(os.path.dirname(os.path.abspath(__file__)), "data")
TONE_CURVE_PATH = os.path.join(DATA_DIR, "acr3_default_tone_curve.json")
COLORCHECKER_PATH = os.path.join(DATA_DIR, "colorchecker_classic_after_nov2014_lab_d50.json")

# linear sRGB (D65) -> XYZ (D50), Bradford-adapted (Lindbloom).
M_SRGB_TO_XYZ_D50 = np.array([
    [0.4360747, 0.3850649, 0.1430804],
    [0.2225045, 0.7168786, 0.0606169],
    [0.0139322, 0.0971045, 0.7141733],
])
# linear ProPhoto / ROMM (D50) -> XYZ (D50).
M_PP_TO_XYZ_D50 = np.array([
    [0.7976749, 0.1351917, 0.0313534],
    [0.2880402, 0.7118741, 0.0000857],
    [0.0, 0.0, 0.8252100],
])
M_XYZ_D50_TO_SRGB = np.linalg.inv(M_SRGB_TO_XYZ_D50)
M_XYZ_D50_TO_PP = np.linalg.inv(M_PP_TO_XYZ_D50)
# linear sRGB -> linear ProPhoto = inv(M_pp_to_xyz_d50) @ M_srgb_to_xyz_d50
M_SRGB_TO_PP = M_XYZ_D50_TO_PP @ M_SRGB_TO_XYZ_D50
# linear ProPhoto -> linear sRGB (display encode path)
M_PP_TO_SRGB = M_XYZ_D50_TO_SRGB @ M_PP_TO_XYZ_D50

D50_WHITE = np.array([0.96422, 1.0, 0.82521])

# Pixel-data interpretations accepted by the CLI (--space / --candidate-space).
SPACE_SRGB = "srgb"                        # display-encoded sRGB (IEC 61966-2-1)
SPACE_LINEAR_SRGB = "linear-srgb"          # linear sRGB primaries, D65 white
SPACE_LINEAR_PROPHOTO = "linear-prophoto"  # linear ProPhoto/ROMM, D50 white
SPACES = (SPACE_SRGB, SPACE_LINEAR_SRGB, SPACE_LINEAR_PROPHOTO)

_LAB_EPS = 216.0 / 24389.0
_LAB_KAPPA = 24389.0 / 27.0
_25_POW_7 = 25.0 ** 7


def _float(x) -> np.ndarray:
    a = np.asarray(x)
    if a.dtype == np.float32 or a.dtype == np.float64:
        return a
    return a.astype(np.float64)


def apply_matrix(img, m) -> np.ndarray:
    """Apply a 3x3 matrix to (..., 3) data: out = m @ rgb for every pixel."""
    a = _float(img)
    return a @ np.asarray(m, dtype=a.dtype).T


# ---------------------------------------------------------------- sRGB transfer

def srgb_decode(v) -> np.ndarray:
    """sRGB-encoded [0,1] -> linear (IEC 61966-2-1 inverse)."""
    a = _float(v)
    hi = np.power((np.maximum(a, 0.04045) + 0.055) / 1.055, 2.4)
    return np.where(a <= 0.04045, a / 12.92, hi).astype(a.dtype, copy=False)


def srgb_encode(v) -> np.ndarray:
    """linear -> sRGB-encoded (IEC 61966-2-1). No clipping here."""
    a = _float(v)
    hi = 1.055 * np.power(np.maximum(a, 0.0031308), 1.0 / 2.4) - 0.055
    return np.where(a <= 0.0031308, 12.92 * a, hi).astype(a.dtype, copy=False)


SRGB8_TO_LINEAR = srgb_decode(np.arange(256, dtype=np.float64) / 255.0)
SRGB8_TO_LINEAR_F32 = SRGB8_TO_LINEAR.astype(np.float32)


@lru_cache(maxsize=1)
def _srgb16_to_linear_f32() -> np.ndarray:
    return srgb_decode(np.arange(65536, dtype=np.float64) / 65535.0).astype(np.float32)


def srgb8_decode(u8) -> np.ndarray:
    """uint8 sRGB -> linear float32 via LUT."""
    return SRGB8_TO_LINEAR_F32[np.asarray(u8, dtype=np.uint8)]


def srgb16_decode(u16) -> np.ndarray:
    """uint16 sRGB -> linear float32 via LUT."""
    return _srgb16_to_linear_f32()[np.asarray(u16, dtype=np.uint16)]


def quantize8(encoded) -> np.ndarray:
    """Encoded [0,1] float -> uint8 with rounding."""
    return np.clip(np.round(_float(encoded) * 255.0), 0, 255).astype(np.uint8)


def quantize16(encoded) -> np.ndarray:
    """Encoded [0,1] float -> uint16 with rounding."""
    return np.clip(np.round(_float(encoded) * 65535.0), 0, 65535).astype(np.uint16)


# ------------------------------------------------------------------------- Lab

def xyz_to_lab(xyz, white=D50_WHITE) -> np.ndarray:
    a = _float(xyz)
    t = a / np.asarray(white, dtype=a.dtype)
    f = np.where(t > _LAB_EPS, np.cbrt(t), (_LAB_KAPPA * t + 16.0) / 116.0)
    L = 116.0 * f[..., 1] - 16.0
    aa = 500.0 * (f[..., 0] - f[..., 1])
    bb = 200.0 * (f[..., 1] - f[..., 2])
    return np.stack([L, aa, bb], axis=-1)


def lab_to_xyz(lab, white=D50_WHITE) -> np.ndarray:
    a = _float(lab)
    L, aa, bb = a[..., 0], a[..., 1], a[..., 2]
    fy = (L + 16.0) / 116.0
    fx = fy + aa / 500.0
    fz = fy - bb / 200.0
    fx3, fz3 = fx ** 3, fz ** 3
    x = np.where(fx3 > _LAB_EPS, fx3, (116.0 * fx - 16.0) / _LAB_KAPPA)
    y = np.where(L > _LAB_KAPPA * _LAB_EPS, fy ** 3, L / _LAB_KAPPA)
    z = np.where(fz3 > _LAB_EPS, fz3, (116.0 * fz - 16.0) / _LAB_KAPPA)
    return np.stack([x, y, z], axis=-1) * np.asarray(white, dtype=a.dtype)


def linear_srgb_to_lab(rgb) -> np.ndarray:
    return xyz_to_lab(apply_matrix(rgb, M_SRGB_TO_XYZ_D50))


def linear_prophoto_to_lab(rgb) -> np.ndarray:
    return xyz_to_lab(apply_matrix(rgb, M_PP_TO_XYZ_D50))


def srgb_to_lab(encoded) -> np.ndarray:
    """sRGB-encoded [0,1] -> Lab(D50) via linear sRGB and Bradford D50 matrix."""
    return linear_srgb_to_lab(srgb_decode(encoded))


def srgb8_to_lab(u8) -> np.ndarray:
    """8-bit sRGB -> Lab(D50): 8bit -> inverse gamma -> M_srgb_to_xyz_d50 -> Lab."""
    return linear_srgb_to_lab(SRGB8_TO_LINEAR[np.asarray(u8, dtype=np.uint8)])


def lab_to_linear_srgb(lab) -> np.ndarray:
    return apply_matrix(lab_to_xyz(lab), M_XYZ_D50_TO_SRGB)


def lab_to_linear_prophoto(lab) -> np.ndarray:
    return apply_matrix(lab_to_xyz(lab), M_XYZ_D50_TO_PP)


def chroma(lab) -> np.ndarray:
    a = _float(lab)
    return np.hypot(a[..., 1], a[..., 2])


def luminance(linear_rgb, space: str) -> np.ndarray:
    """Relative luminance Y (D50 XYZ) of linear data in `space`."""
    a = _float(linear_rgb)
    if space == SPACE_LINEAR_SRGB:
        row = M_SRGB_TO_XYZ_D50[1]
    elif space == SPACE_LINEAR_PROPHOTO:
        row = M_PP_TO_XYZ_D50[1]
    else:
        raise ValueError(f"luminance() needs a linear space, got {space!r}")
    return a @ np.asarray(row, dtype=a.dtype)


def to_linear(img, space: str, target: str) -> np.ndarray:
    """Convert `img` in `space` to linear `target` (linear-srgb | linear-prophoto)."""
    a = _float(img)
    if space == SPACE_SRGB:
        a = srgb_decode(a)
        space = SPACE_LINEAR_SRGB
    if space == target:
        return a
    if space == SPACE_LINEAR_SRGB and target == SPACE_LINEAR_PROPHOTO:
        return apply_matrix(a, M_SRGB_TO_PP)
    if space == SPACE_LINEAR_PROPHOTO and target == SPACE_LINEAR_SRGB:
        return apply_matrix(a, M_PP_TO_SRGB)
    raise ValueError(f"unsupported conversion {space!r} -> {target!r}")


# --------------------------------------------------------------------- ΔE00

def delta_e00(lab1, lab2, kL: float = 1.0, kC: float = 1.0, kH: float = 1.0) -> np.ndarray:
    """CIEDE2000 (Sharma, Wu, Dalal 2005), vectorized over leading axes."""
    p = _float(lab1)
    q = _float(lab2)
    L1, a1, b1 = p[..., 0], p[..., 1], p[..., 2]
    L2, a2, b2 = q[..., 0], q[..., 1], q[..., 2]
    C1 = np.hypot(a1, b1)
    C2 = np.hypot(a2, b2)
    Cbar7 = (0.5 * (C1 + C2)) ** 7
    G = 0.5 * (1.0 - np.sqrt(Cbar7 / (Cbar7 + _25_POW_7)))
    a1p = (1.0 + G) * a1
    a2p = (1.0 + G) * a2
    C1p = np.hypot(a1p, b1)
    C2p = np.hypot(a2p, b2)
    h1p = np.mod(np.degrees(np.arctan2(b1, a1p)), 360.0)
    h2p = np.mod(np.degrees(np.arctan2(b2, a2p)), 360.0)
    zero = (C1p * C2p) == 0

    dLp = L2 - L1
    dCp = C2p - C1p
    dhp = h2p - h1p
    dhp = np.where(dhp > 180.0, dhp - 360.0, np.where(dhp < -180.0, dhp + 360.0, dhp))
    dhp = np.where(zero, 0.0, dhp)
    dHp = 2.0 * np.sqrt(C1p * C2p) * np.sin(np.radians(dhp) / 2.0)

    Lbarp = 0.5 * (L1 + L2)
    Cbarp = 0.5 * (C1p + C2p)
    hsum = h1p + h2p
    hbarp = np.where(np.abs(h1p - h2p) <= 180.0, hsum / 2.0,
                     np.where(hsum < 360.0, (hsum + 360.0) / 2.0, (hsum - 360.0) / 2.0))
    hbarp = np.where(zero, hsum, hbarp)

    T = (1.0 - 0.17 * np.cos(np.radians(hbarp - 30.0))
         + 0.24 * np.cos(np.radians(2.0 * hbarp))
         + 0.32 * np.cos(np.radians(3.0 * hbarp + 6.0))
         - 0.20 * np.cos(np.radians(4.0 * hbarp - 63.0)))
    dtheta = 30.0 * np.exp(-(((hbarp - 275.0) / 25.0) ** 2))
    Cbarp7 = Cbarp ** 7
    RC = 2.0 * np.sqrt(Cbarp7 / (Cbarp7 + _25_POW_7))
    Lm = (Lbarp - 50.0) ** 2
    SL = 1.0 + 0.015 * Lm / np.sqrt(20.0 + Lm)
    SC = 1.0 + 0.045 * Cbarp
    SH = 1.0 + 0.015 * Cbarp * T
    RT = -np.sin(np.radians(2.0 * dtheta)) * RC
    tL = dLp / (kL * SL)
    tC = dCp / (kC * SC)
    tH = dHp / (kH * SH)
    return np.sqrt(np.maximum(tL * tL + tC * tC + tH * tH + RT * tC * tH, 0.0))


# ------------------------------------------------------------ tone / render

class ToneCurve:
    """1D curve sampled at x_i = i/(n-1); input clipped to [0,1], linear interpolation."""

    def __init__(self, y, name: str = "curve", source: str | None = None):
        self.y = np.asarray(y, dtype=np.float64)
        if self.y.ndim != 1 or len(self.y) < 2:
            raise ValueError("tone curve needs >= 2 samples")
        self.name = name
        self.source = source
        self._y32 = self.y.astype(np.float32)

    def __call__(self, v) -> np.ndarray:
        a = _float(v)
        y = self._y32 if a.dtype == np.float32 else self.y
        n1 = len(y) - 1
        xs = np.clip(a, 0.0, 1.0) * n1
        i = np.minimum(xs.astype(np.int64), n1 - 1)
        f = (xs - i).astype(a.dtype, copy=False)
        return y[i] * (1 - f) + y[i + 1] * f


def load_tone_curve(path: str | None = None) -> ToneCurve:
    return _load_tone_curve_cached(os.path.abspath(path or TONE_CURVE_PATH))


@lru_cache(maxsize=8)
def _load_tone_curve_cached(path: str) -> ToneCurve:
    with open(path, encoding="utf-8") as fh:
        d = json.load(fh)
    y = d["y"]
    if "count" in d and int(d["count"]) != len(y):
        raise ValueError(f"{path}: count {d['count']} != len(y) {len(y)}")
    return ToneCurve(y, name=d.get("name", os.path.basename(path)), source=d.get("source"))


def rgb_tone(rgb, curve: ToneCurve) -> np.ndarray:
    """Hue-preserving tone curve (DNG SDK RefBaselineRGBTone).

    hi' = T(hi), lo' = T(lo), mid' = lo' + (hi' - lo') * (mid - lo) / (hi - lo);
    hi == lo -> all T(hi).  Applying the mid formula to all three channels gives
    exactly hi' for the max channel and lo' for the min channel.
    The curve input is clipped to [0,1]; the ratio uses the unclipped values.
    """
    x = _float(rgb)
    hi = x.max(axis=-1, keepdims=True)
    lo = x.min(axis=-1, keepdims=True)
    hi_t = curve(hi)
    lo_t = curve(lo)
    span = hi - lo
    pos = span > 0
    frac = np.where(pos, (x - lo) / np.where(pos, span, 1), 0)
    return lo_t + (hi_t - lo_t) * frac


def render_display_linear(linear_prophoto, ev: float = 0.0, curve: ToneCurve | None = None) -> np.ndarray:
    """NIHO display rendering up to (and including) the [0,1] clip, in linear sRGB.

    x = clip(rgb * 2**ev, 0, None) -> RGBTone -> XYZ(D50) -> inv(M_srgb_to_xyz_d50) -> clip [0,1]
    """
    curve = curve or load_tone_curve()
    a = _float(linear_prophoto)
    x = np.clip(a * (2.0 ** float(ev)), 0.0, None)
    t = rgb_tone(x, curve)
    return np.clip(apply_matrix(t, M_PP_TO_SRGB), 0.0, 1.0)


def render_display_float(linear_prophoto, ev: float = 0.0, curve: ToneCurve | None = None) -> np.ndarray:
    """NIHO display rendering, sRGB-encoded float in [0,1] (no 8-bit rounding)."""
    return srgb_encode(render_display_linear(linear_prophoto, ev, curve))


def render_display(linear_prophoto, ev: float = 0.0, curve: ToneCurve | None = None) -> np.ndarray:
    """NIHO display rendering -> sRGB uint8 (spec: render_display)."""
    return quantize8(render_display_float(linear_prophoto, ev, curve))


def display_encode(linear_prophoto) -> np.ndarray:
    """Display encode without tone: linear ProPhoto -> sRGB uint8."""
    lin = np.clip(apply_matrix(_float(linear_prophoto), M_PP_TO_SRGB), 0.0, 1.0)
    return quantize8(srgb_encode(lin))


# ----------------------------------------------------------------- HueSat

def rgb_to_hsv6(rgb):
    """DNG_RGBtoHSV: hue in [0,6), s = (max-min)/max, v = max."""
    x = _float(rgb)
    r, g, b = x[..., 0], x[..., 1], x[..., 2]
    v = x.max(axis=-1)
    gap = v - x.min(axis=-1)
    pos = gap > 0
    safe = np.where(pos, gap, 1)
    h = np.where(r == v, (g - b) / safe, np.where(g == v, 2.0 + (b - r) / safe, 4.0 + (r - g) / safe))
    h = np.where(h < 0, h + 6.0, h)
    h = np.where(pos, h, 0)
    s = np.where(pos, gap / np.where(v > 0, v, 1), 0)
    return h, s, v


def hsv6_to_rgb(h, s, v) -> np.ndarray:
    """DNG_HSVtoRGB (hue in [0,6))."""
    h = np.mod(h, 6.0)
    i = np.floor(h)
    f = h - i
    p = v * (1 - s)
    q = v * (1 - s * f)
    t = v * (1 - s * (1 - f))
    i = i.astype(np.int64) % 6
    r = np.choose(i, [v, q, p, p, t, v])
    g = np.choose(i, [t, v, v, q, p, p])
    b = np.choose(i, [p, p, t, v, v, q])
    out = np.stack([r, g, b], axis=-1)
    return np.where((s > 0)[..., None], out, np.stack([v, v, v], axis=-1))


def apply_huesat(rgb, entries) -> np.ndarray:
    """Small HueSat table in linear-ProPhoto HSV (DNG HueSatMap, hue divisions only).

    entries[i] = (hueShiftDeg, satScale) at hue node i * 360 / N, interpolated
    linearly and cyclically.  Value (max channel) is preserved; negatives are
    clipped to 0 first.
    """
    e = np.asarray(entries, dtype=np.float64)
    if e.ndim != 2 or e.shape[1] != 2 or len(e) < 1:
        raise ValueError("hueSat entries must be an (N, 2) list of [hueShiftDeg, satScale]")
    x = np.clip(_float(rgb), 0.0, None)
    h, s, v = rgb_to_hsv6(x)
    n = len(e)
    hs = h * (n / 6.0)
    i0 = np.floor(hs).astype(np.int64)
    f = hs - i0
    i0 %= n
    i1 = (i0 + 1) % n
    shift = e[i0, 0] * (1 - f) + e[i1, 0] * f
    scale = e[i0, 1] * (1 - f) + e[i1, 1] * f
    h2 = np.mod(h + shift * (6.0 / 360.0), 6.0)
    s2 = np.clip(s * scale, 0.0, 1.0)
    return hsv6_to_rgb(h2, s2, v).astype(x.dtype, copy=False)


# -------------------------------------------------------------- references

@lru_cache(maxsize=4)
def load_colorchecker(path: str | None = None) -> dict:
    with open(path or COLORCHECKER_PATH, encoding="utf-8") as fh:
        d = json.load(fh)
    patches = sorted(d["patches"], key=lambda p: p["index"])
    if len(patches) != 24:
        raise ValueError(f"expected 24 patches, got {len(patches)}")
    d["patches"] = patches
    return d


def colorchecker_lab(path: str | None = None) -> np.ndarray:
    return np.array([p["lab"] for p in load_colorchecker(path)["patches"]], dtype=np.float64)
