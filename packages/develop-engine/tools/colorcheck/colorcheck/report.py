"""Owner-facing comparison page: ``colorcheck report`` -> one self-contained HTML.

Sections: gates (gates.evaluate over all results) -> preset results (per preset,
preset x scene) -> compare results grouped by --kind (numbers table, then the
reference / NIHO sample pairs side by side) -> ColorChecker results (24
patches as 4 x 6 with reference and measured colour chips) -> input files.

No external assets: CSS is inline, colour chips are inline styles, and the
sample JPEGs written by ``compare --save-pair`` are linked with paths relative
to the HTML.  A copy under ``<html dir>/samples/`` (the fixtures layout, found
by file name) wins over the path recorded in the result JSON, so the page can
be moved together with its samples/ folder.
"""
from __future__ import annotations

import html
import math
import os
from urllib.parse import quote

import numpy as np

from . import __version__
from . import color as C
from . import gates as G
from .util import now_iso

DEFAULT_TITLE = "色の計測 見比べ"
KIND_ORDER = ("reference", "camera-jpeg", "version", "cross-camera", "preset")
KIND_TITLES = {
    "reference": "参照（Lightroom の書き出しなど）との比較",
    "camera-jpeg": "カメラ JPEG との比較（gate の目安 mean ≤ 4.0）",
    "version": "decoderVersion / baseVersion またぎ（gate mean ≤ 0.5）",
    "cross-camera": "カメラ間（gate mean ≤ 2.0）",
    "preset": "プリセット（単発の compare）",
}
KIND_LIMIT = {"camera-jpeg": 4.0, "version": 0.5, "cross-camera": 2.0}
PRESET_LIMIT = {"mean": 3.0, "p99": 8.0}
CHART_LIMIT = {"mean": 2.0, "max": 5.0}
STATUS_JA = {"pass": "合格", "fail": "不合格", "warn": "目安超え", "incomplete": "不足", "not-evaluated": "未評価",
             "missing": "欠け"}

CSS = """
:root { color-scheme: light dark; --fg: #1d1d1f; --bg: #ffffff; --muted: #6b6b6b; --line: #d9d9d9;
  --ok: #1a7f37; --warn: #9a6700; --bad: #cf222e; --na: #6e7781; --card: #f6f6f6; }
@media (prefers-color-scheme: dark) { :root { --fg: #e8e8e8; --bg: #161616; --muted: #a0a0a0; --line: #3a3a3a;
  --ok: #3fb950; --warn: #d29922; --bad: #f85149; --na: #8b949e; --card: #202020; } }
body { margin: 24px; color: var(--fg); background: var(--bg);
  font: 14px/1.55 -apple-system, "Hiragino Sans", "Noto Sans JP", system-ui, sans-serif; }
h1 { font-size: 22px; margin: 0 0 4px; } h2 { font-size: 18px; margin: 32px 0 8px; border-bottom: 1px solid var(--line); }
h3 { font-size: 15px; margin: 20px 0 6px; } h4 { font-size: 14px; margin: 14px 0 6px; }
.meta, .muted, .note { color: var(--muted); } .note { font-size: 12px; }
table { border-collapse: collapse; margin: 6px 0 12px; font: 12px/1.45 ui-monospace, "SF Mono", Menlo, monospace; }
th, td { border: 1px solid var(--line); padding: 3px 7px; text-align: right; vertical-align: top; white-space: nowrap; }
td.w { white-space: normal; min-width: 14em; }
th { background: var(--card); font-weight: 600; }
th.l, td.l { text-align: left; }
.bad { color: var(--bad); font-weight: 700; } .warnc { color: var(--warn); font-weight: 700; } .okc { color: var(--ok); }
.badge { display: inline-block; white-space: nowrap; padding: 0 7px; border-radius: 4px; color: #fff; font: 600 12px/1.6 system-ui, sans-serif; }
.st-pass { background: var(--ok); } .st-fail { background: var(--bad); } .st-warn { background: var(--warn); }
.st-incomplete, .st-not-evaluated, .st-missing { background: var(--na); }
.grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(440px, 1fr)); gap: 14px; }
.card { background: var(--card); border: 1px solid var(--line); border-radius: 6px; padding: 8px; margin: 0; }
.card > .cap { font: 12px/1.4 ui-monospace, Menlo, monospace; margin-bottom: 6px; word-break: break-all; }
.pair { display: grid; grid-template-columns: 1fr 1fr; gap: 4px; }
.pair figure { margin: 0; } .pair img { width: 100%; height: auto; display: block; background: #808080; }
.pair figcaption { font-size: 11px; color: var(--muted); text-align: center; }
.nums { font: 12px/1.5 ui-monospace, Menlo, monospace; margin-top: 6px; }
.chip { display: inline-block; width: 26px; height: 20px; border: 1px solid rgba(0,0,0,.25); vertical-align: middle; }
table.cc td { text-align: left; min-width: 118px; }
table.cc .pn { font-size: 11px; color: var(--muted); white-space: nowrap; }
ul.warn { color: var(--warn); font-size: 12px; margin: 4px 0 12px; }
code { font: 12px ui-monospace, Menlo, monospace; }
"""


def _e(s) -> str:
    return html.escape("" if s is None else str(s), quote=True)


def _f(v, nd=2, signed=False) -> str:
    if v is None or isinstance(v, bool) or not isinstance(v, (int, float)) or not math.isfinite(v):
        return "—"
    v = round(float(v), nd) + 0.0  # no "-0.000"
    return f"{v:+.{nd}f}" if signed else f"{v:.{nd}f}"


def _over(v, limit) -> str:
    return "bad" if limit is not None and isinstance(v, (int, float)) and v > limit else ""


def _td(text, cls="", title=None) -> str:
    t = f' title="{_e(title)}"' if title else ""
    c = f' class="{cls}"' if cls else ""
    return f"<td{c}{t}>{text}</td>"


def _badge(status) -> str:
    st = status or "not-evaluated"
    return f'<span class="badge st-{_e(st)}" title="{_e(st)}">{_e(STATUS_JA.get(st, st))}</span>'


def lab_hex(lab) -> str:
    """Lab(D50) -> '#rrggbb' in sRGB (clipped to the gamut)."""
    lin = C.lab_to_linear_srgb(np.asarray(lab, dtype=np.float64))
    u8 = C.quantize8(C.srgb_encode(np.clip(lin, 0.0, 1.0)))
    return "#" + "".join(f"{int(v):02x}" for v in u8)


def _de_cls(v) -> str:
    if not isinstance(v, (int, float)):
        return ""
    return "okc" if v <= CHART_LIMIT["mean"] else ("warnc" if v <= CHART_LIMIT["max"] else "bad")


class _Samples:
    """Resolves sample JPEG paths to URLs relative to the HTML."""

    def __init__(self, out_dir: str):
        self.out_dir = out_dir
        self._index = None

    def _local(self, name: str):
        if self._index is None:
            self._index = {}
            root = os.path.join(self.out_dir, "samples")
            if os.path.isdir(root):
                for dp, _dn, fns in sorted(os.walk(root)):
                    for fn in sorted(fns):
                        self._index.setdefault(fn, os.path.join(dp, fn))
        return self._index.get(name)

    def src(self, path, base_dir=None):
        """(url relative to the HTML, exists) or (None, False)."""
        if not path:
            return None, False
        p = path if os.path.isabs(path) else os.path.join(base_dir or self.out_dir, path)
        target = self._local(os.path.basename(p)) or p
        rel = os.path.relpath(os.path.abspath(target), self.out_dir)
        return quote(rel.replace(os.sep, "/")), os.path.exists(target)


def _camera_str(cam) -> str | None:
    if not isinstance(cam, dict):
        return None
    s = " ".join(x for x in (cam.get("make"), cam.get("model")) if x)
    return s or None


def _distinct(values) -> list:
    out = []
    for v in values:
        if v in (None, ""):
            continue
        if v not in out:
            out.append(v)
    return out


def _all_results(results):
    for r in results:
        yield r
        if isinstance(r, dict):
            for it in r.get("items") or []:
                yield it


# ------------------------------------------------------------------ parts

def _gates_section(ev: dict) -> str:
    rows = []
    for g in ev.get("gates", []):
        th = "・".join(f"{k} ≤ {v}" for k, v in (g.get("thresholds") or {}).items())
        rows.append("<tr>" + _td(g.get("stage")) + _td(f"<code>{_e(g.get('id'))}</code>", "l") + _td(_e(g.get("label")), "l w")
                    + _td(_e(th), "l") + _td("止める" if g.get("blocking") else "目安", "l")
                    + _td(_badge(g.get("status")), "l") + _td(_e(g.get("summary")), "l w") + "</tr>")
    return (f'<section id="gates"><h2>gate の判定 {_badge(ev.get("overall"))}</h2>'
            '<table><thead><tr><th>段階</th><th class="l">id</th><th class="l">内容</th><th class="l">基準</th>'
            '<th class="l">扱い</th><th class="l">判定</th><th class="l">要約</th></tr></thead><tbody>'
            + "".join(rows) + "</tbody></table>"
            '<p class="note">合格 = pass・不合格 = fail（止める gate）・目安超え = warn・不足 = incomplete'
            '（光源が 1 つだけ・必須プリセットが欠けているなど）・未評価 = 対象の結果が無い。ΔE00 はすべてぼかし後の主値。</p>'
            "</section>")


def _card(r: dict, samples: _Samples, base_dir, limit=None) -> str | None:
    s = r.get("samples") or {}
    if not s.get("reference") and not s.get("candidate"):
        return None
    m = r.get("metrics") or {}
    d = m.get("deltaE00") or {}
    figs = []
    for key, cap in (("reference", "参照"), ("candidate", "NIHO")):
        url, ok = samples.src(s.get(key), base_dir)
        if url is None:
            figs.append(f"<figure><figcaption>{cap}（見本なし）</figcaption></figure>")
            continue
        miss = "" if ok else "（ファイルが見つからない）"
        figs.append(f'<figure><img src="{_e(url)}" alt="{_e(cap)} {_e(r.get("label"))}" loading="lazy">'
                    f"<figcaption>{cap}{miss}</figcaption></figure>")
    extra = ""
    n = r.get("normalized") or {}
    if (n.get("deltaE00") or {}).get("mean") is not None:
        extra = f" ・ 露出合わせ後 mean {_f(n['deltaE00']['mean'])}"
    all_mean = (m.get("deltaE00All") or {}).get("mean")
    allx = f"（全画素 {_f(all_mean)}）" if all_mean is not None else ""
    nums = (f'ΔE00 mean <span class="{_over(d.get("mean"), limit)}">{_f(d.get("mean"))}</span>{allx} ・ p99 {_f(d.get("p99"))}'
            f" ・ EV 差 {_f(m.get('evDiff'), 3, True)} ・ 彩度比 {_f(m.get('saturationRatio'), 3)}{extra}")
    label, scene = r.get("label"), r.get("scene")
    cap = " ・ ".join(_e(x) for x in (label, scene if scene and scene not in str(label or "") else None) if x)
    return (f'<div class="card"><div class="cap"><b>{cap or "—"}</b></div><div class="pair">{"".join(figs)}</div>'
            f'<div class="nums">{nums}</div></div>')


def _compare_rows(items, limit=None) -> str:
    rows = []
    for r in items:
        m = r.get("metrics") or {}
        d = m.get("deltaE00") or {}
        a = m.get("deltaE00All") or {}
        u = m.get("deltaE00Unblurred") or {}
        n = (r.get("normalized") or {}).get("deltaE00") or {}
        ff = m.get("flatFraction")
        w = m.get("white") or {}
        wr, wc = w.get("reference") or {}, w.get("candidate") or {}
        al = r.get("alignment") or {}
        white = f"{_f(wr.get('a'), 1, True)}/{_f(wr.get('b'), 1, True)} → {_f(wc.get('a'), 1, True)}/{_f(wc.get('b'), 1, True)}"
        name = r.get("label") or os.path.basename((r.get("candidate") or {}).get("path") or "") or "—"
        rows.append("<tr>" + _td(_e(name), "l", (r.get("candidate") or {}).get("path")) + _td(_e(r.get("scene") or ""), "l")
                    + _td(_f(d.get("mean")), _over(d.get("mean"), limit)) + _td(_f(d.get("p99")))
                    + _td(_f(a.get("mean"))) + _td(_f(ff * 100 if isinstance(ff, (int, float)) else None, 0))
                    + _td(_f(u.get("mean"))) + _td(_f(m.get("evDiff"), 3, True)) + _td(_f(m.get("saturationRatio"), 3))
                    + _td(_f(n.get("mean"))) + _td(white)
                    + _td(f"{_f(al.get('scale'), 4)} / {_f(al.get('corr'), 3)}{' ＋歪み' if al.get('radial') else ''}")
                    + "</tr>")
    return ('<table><thead><tr><th class="l">名前</th><th class="l">場面</th><th>ΔE00 mean</th><th>p99</th>'
            "<th>全画素 mean</th><th>平坦 %</th><th>ぼかし無し mean</th><th>EV 差</th><th>彩度比</th><th>露出合わせ後 mean</th>"
            "<th>白 a*/b*（参照 → NIHO）</th><th>位置合わせ 倍率 / 相関</th></tr></thead><tbody>"
            + "".join(rows) + "</tbody></table>")


def _cards(items, samples, limit=None) -> str:
    cards = [c for c in (_card(r, samples, b, limit) for r, b in items) if c]
    return f'<div class="grid">{"".join(cards)}</div>' if cards else ""


def _compare_sections(compares, samples) -> str:
    groups: dict = {}
    for r, b in compares:
        groups.setdefault(r.get("comparison") or "reference", []).append((r, b))
    out = []
    kinds = [k for k in KIND_ORDER if k in groups] + sorted(k for k in groups if k not in KIND_ORDER)
    for k in kinds:
        items = sorted(groups[k], key=lambda t: str(t[0].get("label") or ""))
        limit = KIND_LIMIT.get(k)
        out.append(f'<section id="compare-{_e(k)}"><h2>{_e(KIND_TITLES.get(k, k))}</h2>'
                   f'<p class="meta">{len(items)} 件</p>' + _compare_rows([r for r, _ in items], limit)
                   + _cards(items, samples, limit) + "</section>")
    return "".join(out)


def _preset_section(r: dict, base_dir, samples, ev: dict, n: int) -> str:
    gate = {g["id"]: g for g in ev.get("gates", [])}.get("stage1.preset") or {}
    per = {d.get("preset"): d for d in gate.get("details", [])}
    rows = []
    for p in r.get("presets") or []:
        st = (per.get(p.get("preset")) or {}).get("status")
        rows.append("<tr>" + _td(_e(p.get("preset")), "l") + _td(len(p.get("scenes") or []))
                    + _td(_f(p.get("deltaE00Mean")), _over(p.get("deltaE00Mean"), PRESET_LIMIT["mean"]))
                    + _td(_f(p.get("deltaE00P99")), _over(p.get("deltaE00P99"), PRESET_LIMIT["p99"]))
                    + _td(_e(p.get("worstScene") or "—"), "l") + _td(_f(p.get("evDiff"), 3, True))
                    + _td(_f(p.get("saturationRatio"), 3)) + _td(_badge(st) if st else "—", "l") + "</tr>")
    items = r.get("items") or []
    presets = _distinct(it.get("preset") for it in items)
    scenes = _distinct(it.get("scene") for it in items)
    cell = {(it.get("preset"), it.get("scene")): it for it in items}
    mrows = []
    for s in scenes:
        tds = []
        for p in presets:
            it = cell.get((p, s))
            if it is None:
                tds.append(_td("—"))
                continue
            d = (it.get("metrics") or {}).get("deltaE00") or {}
            txt = (f'<span class="{_over(d.get("mean"), PRESET_LIMIT["mean"])}">{_f(d.get("mean"))}</span> / '
                   f'<span class="{_over(d.get("p99"), PRESET_LIMIT["p99"])}">{_f(d.get("p99"))}</span>')
            tds.append(_td(txt))
        mrows.append("<tr>" + _td(_e(s), "l") + "".join(tds) + "</tr>")
    meta = []
    if r.get("manifest"):
        meta.append(f"manifest <code>{_e(os.path.basename(r['manifest']))}</code>")
    meta.append(f"{len(items)} 件（プリセット {len(presets)} × 場面 {len(scenes)}）")
    meta.append("プリセットの mean = 場面 mean の平均・p99 = 場面 p99 の最大")
    parts = [f'<section id="preset-{n}"><h2>プリセットの近さ{"" if n == 1 else f"（{n}）"}</h2>',
             f'<p class="meta">{" ・ ".join(meta)}</p>',
             '<h3>プリセットごと（gate: mean ≤ 3.0・p99 ≤ 8.0）</h3>'
             '<table><thead><tr><th class="l">プリセット</th><th>場面数</th><th>ΔE00 mean</th><th>ΔE00 p99（場面の最大）</th>'
             '<th class="l">p99 最悪の場面</th><th>EV 差</th><th>彩度比</th><th class="l">gate</th></tr></thead><tbody>'
             + "".join(rows) + "</tbody></table>"]
    if presets and scenes:
        parts.append("<h3>プリセット × 場面（ΔE00 mean / p99）</h3><table><thead><tr><th class=\"l\">場面</th>"
                     + "".join(f"<th>{_e(p)}</th>" for p in presets) + "</tr></thead><tbody>" + "".join(mrows)
                     + "</tbody></table>")
    for p in presets:
        its = [(it, base_dir) for it in items if it.get("preset") == p]
        cards = _cards(its, samples, PRESET_LIMIT["mean"])
        if cards:
            parts.append(f"<h4>{_e(p)}</h4>{cards}")
    parts.append("</section>")
    return "".join(parts)


def _chart_section(r: dict, n: int) -> str:
    s = r.get("summary") or {}
    prim = s.get("primary") or "raw"
    det = r.get("detection") or {}
    ex = r.get("exposure") or {}
    gb = r.get("grayBalance") or {}
    img = r.get("image") or {}
    name = r.get("label") or os.path.basename(img.get("path") or "") or f"chart {n}"
    meta = [f"画像 <code>{_e(os.path.basename(img.get('path') or ''))}</code>（{_e(img.get('space'))}）",
            f"検出 {_e(det.get('method'))}" + (f"（四角 {det['swatches']} 個）" if det.get("swatches") else ""),
            f"回転 {_f(det.get('rotationDeg'), 1)}°"]
    if ex.get("method") and ex.get("method") != "none":
        meta.append(f"露出 {_f(ex.get('ev'), 2, True)} 段（パッチ {_e(ex.get('patch'))} の Y を基準値に）")
    if gb.get("gainsRelative"):
        g = gb["gainsRelative"]
        meta.append(f"白の倍率 R {_f(g[0], 3)} ・ G 1 ・ B {_f(g[2], 3)}")
    cam = _camera_str(r.get("camera"))
    if cam:
        meta.append(_e(cam))
    srows = []
    for key, lab in (("raw", "raw（白はそのまま）"), ("grayBalanced", "白合わせ後（灰色スケール）")):
        v = s.get(key) or {}
        mark = " ★主値" if key == prim else ""
        srows.append("<tr>" + _td(_e(lab) + mark, "l")
                     + _td(_f(v.get("mean")), _over(v.get("mean"), CHART_LIMIT["mean"])) + _td(_f(v.get("p95")))
                     + _td(_f(v.get("max")), _over(v.get("max"), CHART_LIMIT["max"])) + _td(_e(v.get("worst") or "—"))
                     + "</tr>")
    other = "grayBalanced" if prim == "raw" else "raw"
    other_ja = "白合わせ後" if other == "grayBalanced" else "raw"
    patches = sorted(r.get("patches") or [], key=lambda p: p.get("index", 0))
    grid = []
    for row in range(4):
        tds = []
        for p in patches[row * 6:(row + 1) * 6]:
            lab_ref = p.get("lab_ref")
            lab_m = p.get("lab_grayBalanced" if prim == "grayBalanced" else "lab_raw")
            dv = p.get(f"deltaE00_{prim}")
            do = p.get(f"deltaE00_{other}")
            chips = ""
            if lab_ref:
                chips += (f'<span class="chip" style="background:{lab_hex(lab_ref)}" '
                          f'title="基準 L*a*b* {_e(", ".join(_f(x, 1) for x in lab_ref))}"></span>')
            if lab_m:
                chips += (f'<span class="chip" style="background:{lab_hex(lab_m)}" '
                          f'title="実測 L*a*b* {_e(", ".join(_f(x, 1) for x in lab_m))}"></span>')
            tds.append(f'<td><div class="pn">{_e(p.get("index"))} {_e(p.get("name"))}</div><div>{chips}</div>'
                       f'<div><b class="{_de_cls(dv)}">{_f(dv)}</b> <span class="muted">{other_ja} {_f(do)}</span></div></td>')
        grid.append("<tr>" + "".join(tds) + "</tr>")
    warns = "".join(f"<li>{_e(w)}</li>" for w in r.get("warnings") or [])
    return (f'<section id="chart-{n}"><h3>{_e(name)} — 光源 {_e(r.get("illuminant") or "—")}</h3>'
            f'<p class="meta">{" ・ ".join(meta)}</p>'
            '<table><thead><tr><th class="l">ΔE00</th><th>mean</th><th>p95</th><th>max</th><th>最悪のパッチ</th></tr></thead>'
            f'<tbody>{"".join(srows)}</tbody></table>'
            '<p class="note">各パッチ: 左のチップ = 基準値、右 = 実測（主値）。数字は主値の ΔE00（緑 ≤ 2・黄 ≤ 5・赤 > 5）。</p>'
            f'<table class="cc"><tbody>{"".join(grid)}</tbody></table>'
            + (f'<ul class="warn">{warns}</ul>' if warns else "") + "</section>")


NOTES = """<section id="notes"><h2>数値の意味</h2><ul class="note">
<li>ΔE00 = CIEDE2000。Lab は D50（sRGB → 逆ガンマ → Bradford 済みの sRGB→XYZ(D50) 行列 → Lab）。</li>
<li>compare の主値: 参照と NIHO を長辺 1500px に揃え、倍率・位置（と残った放射状の歪み）を合わせ、線形光で σ2px（1500px 換算）のガウスぼかしをかけ、周囲 4% を切り、輪郭（どちらかの画像で |∇L*| &gt; 1.5/px とその周り 2px）を除いた平坦な画素で測る（平坦が 5% 未満なら全画素）。p99 = 画素の 99 パーセンタイル。全画素 mean・ぼかし無し mean は参考。平坦 % = 主値に使った画素の割合。</li>
<li>EV 差 = 参照の中間調（Y 0.02〜0.8）の平坦な画素での median Y の比の log2（＋ = NIHO が明るい）。彩度比 = 参照の C* &gt; 5 の平坦な画素での mean C*（NIHO / 参照）。白 = L* &gt; 40・C* &lt; 8 の平坦な画素の平均 a*/b*（それぞれの画像で選ぶ）。</li>
<li>preset: プリセットの mean = 場面ごとの mean の平均、p99 = 場面ごとの p99 の最大。</li>
<li>chart: パッチ中央 40% の平均色。raw = 線形入力はパッチ 19 の Y で露出だけ合わせる（sRGB 入力はそのまま）。白合わせ後 = 灰色スケール 19〜24 で RGB の倍率を合わせる（明るさの基準は raw と同じ）。sRGB の画像では 18 番 cyan が色域外なので ΔE00 ≈ 3.4 が残る。</li>
</ul></section>"""


def render_html(results: list, out_dir: str, title: str | None = None, result_paths=None) -> str:
    title = title or DEFAULT_TITLE
    paths = list(result_paths or [])
    paths += [None] * (len(results) - len(paths))
    compares, presets, charts, others = [], [], [], []
    for r, p in zip(results, paths):
        base = os.path.dirname(os.path.abspath(p)) if p else None
        schema = (r or {}).get("schema", "") if isinstance(r, dict) else ""
        if schema.startswith("colorcheck/compare/"):
            compares.append((r, base))
        elif schema.startswith("colorcheck/preset/"):
            presets.append((r, base))
        elif schema.startswith("colorcheck/chart/"):
            charts.append(r)
        else:
            others.append((schema or type(r).__name__, p))
    samples = _Samples(out_dir)
    ev = G.evaluate([r for r in results if isinstance(r, dict)])
    allr = [r for r in _all_results(results) if isinstance(r, dict)]
    cams = _distinct(_camera_str(r.get("camera")) for r in allr)
    dvs = _distinct(r.get("decoderVersion") for r in allr)
    bvs = _distinct(r.get("baseVersion") for r in allr)
    counts = [f"compare {len(compares)} 件", f"preset {len(presets)} 件", f"chart {len(charts)} 件"]
    head = (f'<!doctype html><html lang="ja"><head><meta charset="utf-8">'
            f'<meta name="viewport" content="width=device-width, initial-scale=1"><title>{_e(title)}</title>'
            f"<style>{CSS}</style></head><body>")
    info = ('<table><tbody>'
            f'<tr><th class="l">カメラ</th><td class="l">{_e(" / ".join(cams) or "—")}</td></tr>'
            f'<tr><th class="l">decoderVersion</th><td class="l">{_e(" / ".join(map(str, dvs)) or "—")}</td></tr>'
            f'<tr><th class="l">baseVersion</th><td class="l">{_e(" / ".join(map(str, bvs)) or "—")}</td></tr>'
            f'<tr><th class="l">結果</th><td class="l">{_e(" ・ ".join(counts))}</td></tr>'
            "</tbody></table>")
    parts = [head, f"<h1>{_e(title)}</h1>",
             f'<p class="meta">生成 {_e(now_iso())} ・ colorcheck {_e(__version__)}</p>', info, _gates_section(ev)]
    for i, (r, b) in enumerate(presets, 1):
        parts.append(_preset_section(r, b, samples, ev, i))
    parts.append(_compare_sections(compares, samples))
    if charts:
        parts.append('<section id="charts"><h2>ColorChecker（gate: mean ≤ 2.0・max ≤ 5.0、光源 2 つ）</h2>'
                     + "".join(_chart_section(r, i) for i, r in enumerate(charts, 1)) + "</section>")
    if others:
        parts.append('<section><h2>読めなかった結果</h2><ul class="note">'
                     + "".join(f"<li>{_e(s)} {_e(p or '')}</li>" for s, p in others) + "</ul></section>")
    if any(paths):
        parts.append('<section id="inputs"><h2>入力</h2><ul class="note">'
                     + "".join(f'<li title="{_e(os.path.abspath(p))}"><code>{_e(os.path.basename(p))}</code></li>'
                               for p in paths if p) + "</ul></section>")
    parts.append(NOTES)
    parts.append("</body></html>\n")
    return "".join(parts)


def write_report(results: list, out: str, title: str | None = None, result_paths=None) -> str:
    """Write the comparison page for compare / preset / chart results (mixed); returns the absolute path."""
    out_abs = os.path.abspath(out)
    out_dir = os.path.dirname(out_abs)
    os.makedirs(out_dir, exist_ok=True)
    text = render_html(list(results), out_dir, title, result_paths)
    with open(out_abs, "w", encoding="utf-8") as fh:
        fh.write(text)
    return out_abs
