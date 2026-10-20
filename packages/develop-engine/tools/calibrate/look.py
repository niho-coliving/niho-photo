#!/usr/bin/env python3
"""NIHO 標準ルック（段 2 の 1 段・S8 #16947）の数式の参照実装。crate `look.rs` と同じ式（1 か所の正はこの docstring）。

ルックの 1・2 は露出と局所階調の後、既定カーブ（ACR3）の前に、linear ProPhoto（D50）の値に当てる。crate は
「1・2 → ACR3」を 1 つの 64^3 cube に焼くので、入力は [0, 1] に丸めてから当てる（cube の入力と同じ）。

  1. HSV（六角錐）: v = max(r,g,b)、s = (v − min) / v（v = 0 なら 0）、h ∈ [0, 6)（0 = 赤、2 = 緑、4 = 青）
  2. 色相ごとの調整: 色相の節点 N 個（h_i = 6i/N）に、彩度の節点 2 つ（`satNodes` = [S1, 1]）の
     (色相のずれ Δh［度］, 彩度の倍率の対数 ls, 明度の倍率の対数 lv) を置く。色相方向は周期の Catmull-Rom、
     彩度方向は s ≤ S1 で 0 から S1 の値へ線形（s = 0 の灰色は動かない）、S1 < s で S1 の値から 1 の値へ線形。
     h' = h + Δh/60（mod 6）、s' = min(s·e^ls, 1)、v' = v·e^lv
  3. トーンカーブ: 節点 `tone.x` に `tone.y` を通る単調な 3 次 Hermite（Fritsch–Carlson。両端は 0→0、1→1）を、色相を保つ
     RGBTone（DNG SDK の RefBaselineRGBTone。各チャンネルを先に [0, 1] に丸める）で当てる。当てる段は `tone.stage`:
     - `point-curve`（niho-standard-1）: 段 2 の cube P の最後（利用者の点カーブと RGB のチャンネルごとのカーブの後）に、
       点カーブと同じ sRGB の符号化値の上で当てる（`tone.space = srgb-encoded`）。Lightroom の Adobe Color は点カーブの段で
       トーンを足す。置き場所は同梱プリセット 3 本の近さで決めた（ACR3 の前 9.05 → 点カーブの後 8.81、3 本の mean の合計。
       ACR3 の前だと bluesky2 の黒レベル +90 がルックの沈めた暗部に重なり 3.50）。
     - `pre-acr3`: 1・2 の直後（ACR3 の前）に x^(1/2.2) の空間で当てる（`tone.space = gamma2.2`）。

係数は Lightroom の書き出し（Adobe Color で描いた目標の画像）に ΔE00 が最小になるよう `fit_look.py` が決める。
Adobe の LookTable・プロファイル・DCP の数値は読まない・写さない（spec「段 1」の合わせ込みの方針）。

JSON（`niho-develop-look/v1`）: {"schema", "look": "niho-standard-1", "hueNodes": N, "satNodes": [S1, 1.0],
"hsv": [[[Δh, ls, lv] × 2 彩度節点] × N 色相節点], "tone": {"stage", "space", "x": [...], "y": [...]}, "fit": {...}}
"""
from __future__ import annotations

import json

import numpy as np

SCHEMA = "niho-develop-look/v1"
TONE_GAMMA = 2.2
STAGE_PRE_ACR3 = "pre-acr3"
STAGE_POINT_CURVE = "point-curve"
SPACE_FOR_STAGE = {STAGE_PRE_ACR3: "gamma2.2", STAGE_POINT_CURVE: "srgb-encoded"}


def srgb_encode(x):
    x = np.clip(x, 0.0, 1.0)
    return np.where(x <= 0.0031308, 12.92 * x, 1.055 * np.power(x, 1.0 / 2.4) - 0.055)


def srgb_decode(e):
    e = np.clip(e, 0.0, 1.0)
    return np.where(e <= 0.04045, e / 12.92, np.power((e + 0.055) / 1.055, 2.4))


def rgb_to_hsv(rgb: np.ndarray):
    """六角錐の HSV（h ∈ [0, 6)）。"""
    r, g, b = rgb[..., 0], rgb[..., 1], rgb[..., 2]
    v = np.maximum(np.maximum(r, g), b)
    mn = np.minimum(np.minimum(r, g), b)
    c = v - mn
    s = np.where(v > 0, c / np.where(v > 0, v, 1.0), 0.0)
    safe = np.where(c > 0, c, 1.0)
    h = np.where(v == r, (g - b) / safe, np.where(v == g, 2.0 + (b - r) / safe, 4.0 + (r - g) / safe))
    h = np.where(c > 0, np.mod(h, 6.0), 0.0)
    return h, s, v


def hsv_to_rgb(h, s, v) -> np.ndarray:
    h = np.mod(h, 6.0)
    i = np.floor(h)
    f = h - i
    p = v * (1.0 - s)
    q = v * (1.0 - s * f)
    t = v * (1.0 - s * (1.0 - f))
    i = i.astype(np.int64) % 6
    r = np.choose(i, [v, q, p, p, t, v])
    g = np.choose(i, [t, v, v, q, p, p])
    b = np.choose(i, [p, p, t, v, v, q])
    return np.stack([r, g, b], axis=-1)


def catmull_rom_periodic(nodes: np.ndarray, t: np.ndarray) -> np.ndarray:
    """nodes (N, ...) を周期 N で補間。t は節点の単位（0..N）。"""
    n = nodes.shape[0]
    i = np.floor(t).astype(np.int64)
    u = (t - i)[..., None] if nodes.ndim > 1 else (t - i)
    p0, p1, p2, p3 = (nodes[(i + k) % n] for k in (-1, 0, 1, 2))
    return 0.5 * (2.0 * p1 + (p2 - p0) * u + (2.0 * p0 - 5.0 * p1 + 4.0 * p2 - p3) * u ** 2
                  + (3.0 * p1 - p0 - 3.0 * p2 + p3) * u ** 3)


def monotone_tangents(x: np.ndarray, y: np.ndarray) -> np.ndarray:
    """Fritsch–Carlson の接線（単調な区間の単調性を保つ）。"""
    d = np.diff(y) / np.diff(x)
    m = np.empty_like(y)
    m[0], m[-1] = d[0], d[-1]
    m[1:-1] = np.where(d[:-1] * d[1:] > 0, (d[:-1] + d[1:]) / 2.0, 0.0)
    for k in range(len(d)):
        if d[k] == 0:
            m[k] = m[k + 1] = 0.0
            continue
        a, b = m[k] / d[k], m[k + 1] / d[k]
        r = a * a + b * b
        if r > 9.0:
            tau = 3.0 / np.sqrt(r)
            m[k], m[k + 1] = tau * a * d[k], tau * b * d[k]
    return m


def hermite(x: np.ndarray, y: np.ndarray, m: np.ndarray, q: np.ndarray) -> np.ndarray:
    q = np.clip(q, x[0], x[-1])
    k = np.clip(np.searchsorted(x, q, side="right") - 1, 0, len(x) - 2)
    h = x[k + 1] - x[k]
    t = (q - x[k]) / h
    t2, t3 = t * t, t * t * t
    return ((2 * t3 - 3 * t2 + 1) * y[k] + (t3 - 2 * t2 + t) * h * m[k]
            + (-2 * t3 + 3 * t2) * y[k + 1] + (t3 - t2) * h * m[k + 1])


class Look:
    def __init__(self, hsv: np.ndarray, sat_nodes, tone_x, tone_y, name: str = "niho-standard-1", fit: dict | None = None,
                 tone_stage: str = STAGE_PRE_ACR3):
        if tone_stage not in SPACE_FOR_STAGE:
            raise ValueError(f"tone.stage must be one of {list(SPACE_FOR_STAGE)}")
        self.tone_stage = tone_stage
        self.hsv = np.asarray(hsv, dtype=np.float64)  # (N, 2, 3)
        self.sat_nodes = [float(sat_nodes[0]), float(sat_nodes[1])]
        self.tone_x = np.asarray(tone_x, dtype=np.float64)
        self.tone_y = np.asarray(tone_y, dtype=np.float64)
        self.tone_m = monotone_tangents(self.tone_x, self.tone_y)
        self.name = name
        self.fit = fit or {}

    @property
    def hue_nodes(self) -> int:
        return int(self.hsv.shape[0])

    def curve(self, u: np.ndarray) -> np.ndarray:
        """曲線そのもの（`tone.space` の値 → 同じ空間の値。[0, 1] に丸める）。"""
        return np.clip(hermite(self.tone_x, self.tone_y, self.tone_m, np.clip(u, 0.0, 1.0)), 0.0, 1.0)

    def tone(self, x: np.ndarray) -> np.ndarray:
        """`pre-acr3` の曲線: [0, 1] の線形値 → 線形値（x^(1/2.2) の空間の曲線）。"""
        return self.curve(np.clip(x, 0.0, 1.0) ** (1.0 / TONE_GAMMA)) ** TONE_GAMMA

    def adjustments(self, h: np.ndarray, s: np.ndarray) -> np.ndarray:
        """(Δh 度, ls, lv) を (…, 3) で返す。"""
        t = h * (self.hue_nodes / 6.0)
        low = catmull_rom_periodic(self.hsv[:, 0, :], t)
        high = catmull_rom_periodic(self.hsv[:, 1, :], t)
        s1 = self.sat_nodes[0]
        a = np.clip(s / s1, 0.0, 1.0)[..., None]
        b = np.clip((s - s1) / (1.0 - s1), 0.0, 1.0)[..., None]
        return np.where(s[..., None] <= s1, a * low, low + b * (high - low))

    def apply_hsv(self, rgb: np.ndarray) -> np.ndarray:
        x = np.clip(np.asarray(rgb, dtype=np.float64), 0.0, 1.0)
        h, s, v = rgb_to_hsv(x)
        adj = self.adjustments(h, s)
        h2 = h + adj[..., 0] / 60.0
        s2 = np.minimum(s * np.exp(adj[..., 1]), 1.0)
        v2 = v * np.exp(adj[..., 2])
        return hsv_to_rgb(h2, s2, v2)

    def pre_acr3(self, rgb: np.ndarray) -> np.ndarray:
        """ACR3 の前に当てる分（HSV の調整と、`pre-acr3` ならトーン）。"""
        y = self.apply_hsv(rgb)
        return rgb_tone(y, self.tone) if self.tone_stage == STAGE_PRE_ACR3 else y

    def point_curve(self, rgb: np.ndarray) -> np.ndarray:
        """点カーブの段で当てる分（`point-curve` のトーン。crate の `encoded_curve` と同じ当て方）。"""
        if self.tone_stage != STAGE_POINT_CURVE:
            return np.asarray(rgb, dtype=np.float64)
        return srgb_decode(rgb_tone(srgb_encode(np.asarray(rgb, dtype=np.float64)), self.curve))

    def apply(self, rgb: np.ndarray) -> np.ndarray:
        """ACR3 の前の分（`point-curve` のトーンは含まない。そちらは ACR3 の後に point_curve で当てる）。"""
        return self.pre_acr3(rgb)

    def to_json(self) -> dict:
        return {"schema": SCHEMA, "look": self.name, "hueNodes": self.hue_nodes, "satNodes": self.sat_nodes,
                "hsv": [[[round(float(v), 6) for v in node] for node in hue] for hue in self.hsv],
                "tone": {"stage": self.tone_stage, "space": SPACE_FOR_STAGE[self.tone_stage],
                         "x": [round(float(v), 6) for v in self.tone_x],
                         "y": [round(float(v), 6) for v in self.tone_y]},
                "fit": self.fit}

    @staticmethod
    def from_json(d: dict) -> "Look":
        if d.get("schema") != SCHEMA:
            raise ValueError(f"schema must be {SCHEMA}")
        stage = d["tone"].get("stage", STAGE_PRE_ACR3)
        if d["tone"].get("space", SPACE_FOR_STAGE.get(stage)) != SPACE_FOR_STAGE.get(stage):
            raise ValueError("tone.space does not match tone.stage")
        return Look(d["hsv"], d["satNodes"], d["tone"]["x"], d["tone"]["y"], d.get("look", "niho-standard-1"), d.get("fit"), stage)

    @staticmethod
    def load(path: str) -> "Look":
        with open(path, encoding="utf-8") as fh:
            return Look.from_json(json.load(fh))

    @staticmethod
    def identity(hue_nodes: int = 12, sat_nodes=(0.3, 1.0), tone_x=None, tone_stage: str = STAGE_PRE_ACR3) -> "Look":
        tx = np.asarray(tone_x if tone_x is not None else [0.0, 0.1, 0.2, 0.35, 0.5, 0.65, 0.8, 0.9, 1.0])
        return Look(np.zeros((hue_nodes, 2, 3)), sat_nodes, tx, tx.copy(), tone_stage=tone_stage)


def rgb_tone(rgb: np.ndarray, curve) -> np.ndarray:
    """色相を保つトーンカーブ（crate `tone_ops::rgb_tone` と同じ。各チャンネルを [0,1] に丸めてから当てる）。"""
    rgb = np.clip(rgb, 0.0, 1.0)
    hi = rgb.max(axis=-1, keepdims=True)
    lo = rgb.min(axis=-1, keepdims=True)
    hi_t, lo_t = curve(hi), curve(lo)
    span = hi - lo
    ratio = np.where(span > 0, (rgb - lo) / np.where(span > 0, span, 1.0), 0.0)
    return np.where(span > 0, lo_t + (hi_t - lo_t) * ratio, hi_t)
