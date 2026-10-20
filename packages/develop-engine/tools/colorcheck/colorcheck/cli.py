"""colorcheck command line (python3 colorcheck.py <subcommand> ...).

Exit codes: 0 ok / 1 check or gate failed / 2 bad input / 3 chart not detected.
"""
from __future__ import annotations

import argparse
import json
import os
import sys

from . import __version__
from . import color as C
from .util import read_json, write_json

EXIT_OK, EXIT_FAIL, EXIT_INPUT, EXIT_NOCHART = 0, 1, 2, 3


def _log(msg: str) -> None:
    print(msg, file=sys.stderr, flush=True)


def _meta(p) -> None:
    p.add_argument("--camera-make", help="カメラのメーカー（記録用）")
    p.add_argument("--camera-model", help="カメラの機種（記録用）")
    p.add_argument("--decoder-version", help="decoderVersion（記録用。例: Apple CIRAWFilter の 8）")
    p.add_argument("--base-version", help="baseVersion（記録用。校正 JSON の baseVersion）")


def _camera(args) -> dict:
    return {"make": args.camera_make, "model": args.camera_model}


def build_parser() -> argparse.ArgumentParser:
    from .compare import COMPARISONS, DEFAULT_BLUR, DEFAULT_SIZE

    ap = argparse.ArgumentParser(prog="colorcheck", description="NIHO 現像エンジンの色の計測（Epic #16939 S9）")
    ap.add_argument("--version", action="version", version=f"colorcheck {__version__}")
    sub = ap.add_subparsers(dest="cmd", required=True)

    p = sub.add_parser("compare", help="参照と候補を同じ寸法に揃えて ΔE00・EV 差・彩度比・白を出す")
    p.add_argument("--reference", required=True, help="参照（Lightroom 書き出し・カメラ JPEG など 8bit sRGB）")
    p.add_argument("--candidate", required=True, help="候補（NIHO の出力）")
    p.add_argument("--candidate-space", default=C.SPACE_SRGB, choices=C.SPACES)
    p.add_argument("--render", action="store_true", help="線形の候補を NIHO 表示レンダリングで sRGB にしてから比べる")
    p.add_argument("--ev", type=float, default=0.0, help="--render の露出（段）")
    p.add_argument("--calibration", help="校正 JSON（niho-develop-calibration/v1）。--render のときだけ効く")
    p.add_argument("--neutral-k", type=float, help="as-shot の色温度 K（校正 JSON の illuminants を補間する）")
    p.add_argument("--tone-curve", help="トーンカーブ JSON（既定 ACR3 既定カーブ）")
    p.add_argument("--size", type=int, default=DEFAULT_SIZE, help="解析の長辺 px（既定 1500）")
    p.add_argument("--blur", type=float, default=DEFAULT_BLUR, help="ぼかし σ（1500px 換算 px、既定 2）")
    p.add_argument("--no-align", action="store_true", help="位置合わせをしない（寸法だけ合わせる）")
    p.add_argument("--normalize-exposure", action="store_true", help="露出を揃えた値も出す")
    p.add_argument("--kind", default="reference", choices=COMPARISONS,
                   help="比較の種類（gate の対象判定に使う。既定 reference）")
    p.add_argument("--label", help="結果の名前（report・fixture の key）")
    p.add_argument("--scene", help="場面名（記録用）")
    _meta(p)
    p.add_argument("--out", required=True, help="結果 JSON")
    p.add_argument("--save-pair", help="位置合わせ後の見本 JPEG（長辺 480px）を保存するフォルダ")

    p = sub.add_parser("render", help="線形入力を NIHO 表示レンダリングで sRGB にする")
    p.add_argument("--input", required=True)
    p.add_argument("--space", required=True, choices=(C.SPACE_LINEAR_SRGB, C.SPACE_LINEAR_PROPHOTO))
    p.add_argument("--calibration")
    p.add_argument("--neutral-k", type=float)
    p.add_argument("--ev", type=float, default=0.0)
    p.add_argument("--tone-curve")
    p.add_argument("--long-edge", type=int, help="長辺をこの px 以下に縮める（線形のまま面積平均）")
    p.add_argument("--format", choices=("png", "jpg", "tif16-srgb"), help="既定は --out の拡張子から")
    p.add_argument("--quality", type=int, default=95, help="JPEG 品質")
    p.add_argument("--out", required=True, help=".png / .jpg / .tif（.tif は 16bit sRGB）")

    p = sub.add_parser("preset", help="プリセット書き出しとの近さを場面ごと・プリセットごとに出し gate を判定する")
    p.add_argument("--manifest", required=True)
    p.add_argument("--size", type=int, default=DEFAULT_SIZE)
    p.add_argument("--blur", type=float, default=DEFAULT_BLUR)
    _meta(p)
    p.add_argument("--out", required=True)
    p.add_argument("--markdown", help="表（Markdown）")
    p.add_argument("--save-pairs", help="見本 JPEG のフォルダ")
    p.add_argument("--no-gate", action="store_true", help="gate対象外の診断用 manifest では gate を評価しない")

    p = sub.add_parser("chart", help="ColorChecker Classic 24 パッチの ΔE00")
    p.add_argument("--image", required=True)
    p.add_argument("--space", default=C.SPACE_SRGB, choices=C.SPACES,
                   help="画像の画素の意味（線形なら白パッチ 19 の Y で露出を合わせる）")
    p.add_argument("--corners", help="x1,y1,x2,y2,x3,y3,x4,y4（1 番 dark skin 側の外角から時計回り）")
    p.add_argument("--illuminant", default="D50", help="撮影光源のラベル（D50|A|D65|custom|任意の文字列）")
    p.add_argument("--reference", required=True, help="測定者が由来を確認した独立の基準 Lab JSON。第三者の既定ファイルは同梱しない。")
    p.add_argument("--gray-balance", action="store_true", help="白パッチ 19 合わせを主値にする（両方は常に出す）")
    p.add_argument("--label")
    _meta(p)
    p.add_argument("--out", required=True)
    p.add_argument("--debug", help="検出と計測の位置を描いた PNG")

    p = sub.add_parser("report", help="結果 JSON から見比べページ（自己完結 HTML）を作る")
    p.add_argument("--results", nargs="+", required=True)
    p.add_argument("--out", required=True)
    p.add_argument("--title", default="色の計測 見比べ")

    p = sub.add_parser("fixture", help="数値だけの fixture JSON を書く / 照合する")
    fs = p.add_subparsers(dest="fixture_cmd", required=True)
    q = fs.add_parser("write")
    q.add_argument("--results", nargs="+", required=True)
    q.add_argument("--out", required=True, help="例: fixtures/color/<track>/<camera>/<version>.json")
    q = fs.add_parser("check")
    q.add_argument("--fixture", required=True)
    q.add_argument("--results", nargs="+", required=True)
    q.add_argument("--tolerance", type=float, default=0.2, help="mean ΔE00 の許容差（既定 0.2）")
    q.add_argument("--allow-missing", action="store_true", help="fixture にあって結果に無い key を失敗にしない")
    q.add_argument("--out", help="照合結果 JSON")

    p = sub.add_parser("gates", help="gate の表を出す（--results があれば判定も）")
    p.add_argument("--results", nargs="*")
    return ap


def _summary_line(res: dict) -> str:
    m = res["metrics"]
    d = m["deltaE00"]
    al = res["alignment"]
    return (f"ΔE00 mean {d['mean']} p99 {d['p99']} | EV差 {m['evDiff']} | 彩度比 {m['saturationRatio']} | "
            f"倍率 {al['scale']} dx {al['dx']} dy {al['dy']} corr {al['corr']}")


def cmd_compare(args) -> int:
    from .compare import run_compare

    res = run_compare(
        reference=args.reference, candidate=args.candidate, candidate_space=args.candidate_space,
        render=args.render, ev=args.ev, calibration=args.calibration, neutral_k=args.neutral_k,
        size=args.size, blur=args.blur, do_align=not args.no_align, normalize_exposure=args.normalize_exposure,
        camera=_camera(args), decoder_version=args.decoder_version, base_version=args.base_version,
        label=args.label, comparison=args.kind, save_pair=args.save_pair, scene=args.scene,
        tone_curve=args.tone_curve)
    write_json(args.out, res)
    for w in res.get("warnings", []):
        _log(f"warning: {w}")
    print(_summary_line(res))
    if "normalized" in res and res["normalized"].get("deltaE00"):
        n = res["normalized"]
        print(f"露出合わせ後（{n['method']}）: ΔE00 mean {n['deltaE00']['mean']} p99 {n['deltaE00']['p99']}")
    print(f"→ {os.path.abspath(args.out)}")
    return EXIT_OK


def cmd_render(args) -> int:
    from .compare import run_render

    try:
        info = run_render(args.input, args.space, args.out, calibration=args.calibration, ev=args.ev,
                          neutral_k=args.neutral_k, long_edge=args.long_edge, fmt=args.format,
                          tone_curve=args.tone_curve, quality=args.quality)
    except (OSError, RuntimeError) as exc:
        _log(f"error: {type(exc).__name__}: {exc}")
        return EXIT_INPUT
    print(f"→ {info['out']} ({info['format']}, {info['size'][0]}x{info['size'][1]})")
    return EXIT_OK


def cmd_preset(args) -> int:
    from .compare import preset_markdown, run_preset

    manifest = read_json(args.manifest)
    cam = _camera(args) if (args.camera_make or args.camera_model) else None
    res = run_preset(manifest, args.manifest, size=args.size, blur=args.blur, save_pairs=args.save_pairs,
                     camera=cam, decoder_version=args.decoder_version, base_version=args.base_version, log=_log,
                     evaluate_gates=not args.no_gate)
    write_json(args.out, res)
    md = preset_markdown(res)
    if args.markdown:
        os.makedirs(os.path.dirname(os.path.abspath(args.markdown)), exist_ok=True)
        with open(args.markdown, "w", encoding="utf-8") as fh:
            fh.write(md)
    print(md)
    print(f"gate: {res['gates']['overall']} → {os.path.abspath(args.out)}")
    return EXIT_OK


def cmd_chart(args) -> int:
    from .chart import ChartNotFound, run_chart

    try:
        res = run_chart(args.image, space=args.space, corners=args.corners, illuminant=args.illuminant,
                        reference=args.reference, gray_balance=args.gray_balance, camera=_camera(args),
                        decoder_version=args.decoder_version, base_version=args.base_version,
                        label=args.label, debug=args.debug)
    except ChartNotFound as exc:
        _log(f"error: {exc}")
        _log("ColorChecker を自動検出できなかった。--corners x1,y1,x2,y2,x3,y3,x4,y4 を渡す"
             "（1 番 dark skin 側の外角から時計回り、画像の px）。")
        return EXIT_NOCHART
    write_json(args.out, res)
    s = res["summary"]
    print(f"ΔE00 mean {s['raw']['mean']} max {s['raw']['max']} | 白合わせ後 mean {s['grayBalanced']['mean']} "
          f"max {s['grayBalanced']['max']} | 検出 {res['detection']['method']}")
    print(f"→ {os.path.abspath(args.out)}")
    return EXIT_OK


def cmd_report(args) -> int:
    from .report import write_report

    path = write_report([read_json(p) for p in args.results], args.out, title=args.title, result_paths=args.results)
    print(f"→ {path}")
    return EXIT_OK


def cmd_fixture(args) -> int:
    from . import fixtures as F

    results = [read_json(p) for p in args.results]
    if args.fixture_cmd == "write":
        data = F.build(results)
        write_json(args.out, data)
        print(f"{len(data['entries'])} entries → {os.path.abspath(args.out)}")
        return EXIT_OK
    report = F.check(read_json(args.fixture), results, tolerance=args.tolerance, allow_missing=args.allow_missing)
    if args.out:
        write_json(args.out, report)
    print(F.check_markdown(report))
    return EXIT_OK if report["ok"] else EXIT_FAIL


def cmd_gates(args) -> int:
    from . import gates as G

    print(G.table_markdown())
    if args.results:
        ev = G.evaluate([read_json(p) for p in args.results])
        print(json.dumps(ev, ensure_ascii=False, indent=2))
        return EXIT_FAIL if ev["overall"] == "fail" else EXIT_OK
    return EXIT_OK


HANDLERS = {"compare": cmd_compare, "render": cmd_render, "preset": cmd_preset, "chart": cmd_chart,
            "report": cmd_report, "fixture": cmd_fixture, "gates": cmd_gates}


def main(argv=None) -> int:
    args = build_parser().parse_args(argv)
    try:
        return HANDLERS[args.cmd](args)
    except (FileNotFoundError, ValueError, KeyError) as exc:
        _log(f"error: {type(exc).__name__}: {exc}")
        return EXIT_INPUT
