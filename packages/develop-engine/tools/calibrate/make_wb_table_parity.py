#!/usr/bin/env python3
"""crate の白の行列の表（`crates/niho-develop/src/wb_table.rs`）が参照実装 `wbtable.py` と同じ行列を出すかを確かめる
fixture を作る（S11 #17108）。

  python3 make_wb_table_parity.py --calibration ../../calibration/panasonic-dc-s5/apple-v3.json \
      --out ../../crates/niho-develop/tests/fixtures/wb/wb-table-parity.json

- 表は作業コピーのメタが運ぶ形（校正の `whiteBalanceTable` ＋ 画素に焼いた校正の行列 `calibrationMatrix` ＋ `check`）にする。
  `apple-raw-linear` 0.4.2 の自己点検が合格したときと同じ形。
- 撮影時の白 w0 → 目標の白 w1 の組ごとに、作業コピーを移す行列 `C · M(w1) · I(w0) · C^-1`（行優先の 9 個）を書く。
  組は格子の節点・節点の間・同じ白（恒等）・格子の外（端に丸める）・2000K 未満を含む。
- `wbtable.py` と校正 apple-v3 は PR #17115 で入る。
"""
from __future__ import annotations

import argparse
import json
from pathlib import Path

import numpy as np

import wbtable as WT

# (撮影時の白, 目標の白)。白は Lightroom の尺度の (K, tint)。
CASES = [
    ((5000.0, 0.0), (5000.0, 0.0)),            # 基準の白どうし（恒等）
    ((3384.945, 4.893), (3384.945, 4.893)),    # 同じ白（恒等）
    ((3384.945, 4.893), (5500.0, 0.0)),        # 電球色の室内 → bluesky2 に近い白（P1581387 の撮影時の白）
    ((3384.945, 4.893), (7500.0, 0.0)),
    ((5399.499, 16.256), (4000.0, 0.0)),       # 昼光 → 暖かく
    ((5001.0, 10.0), (3200.0, -15.5)),         # Lightroom の Custom の既定 → 節点の間
    ((1e6 / 240.0, -20.0), (1e6 / 300.0, 35.0)),  # 格子の節点どうし
    ((2500.0, 0.0), (60000.0, 170.0)),         # 目標が格子の外（ミレッドも tint も端に丸める）
    ((1800.0, -160.0), (6500.0, 5.0)),         # 撮影時の白が 2000K 未満・tint も外
    ((7000.0, 30.0), (2000.0, 150.0)),         # 格子の角
    ((10000.0, -55.0), (2900.0, 0.0)),
    ((3190.911, 11.329), (5190.911, 31.329)),  # apple-raw-linear の自己点検と同じ組（DSC01837）
]


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    ap.add_argument("--calibration", type=Path, required=True)
    ap.add_argument("--out", type=Path, required=True)
    args = ap.parse_args()

    cal = json.loads(args.calibration.read_text(encoding="utf-8"))
    if cal.get("illuminants"):
        raise SystemExit("2 光源の校正は C が白で変わるので、この fixture の対象外")
    c = np.asarray(cal["matrix"]["rowMajor"], dtype=np.float64)
    table_json = dict(cal["whiteBalanceTable"])
    table_json["calibrationMatrix"] = [float(v) for v in c.ravel()]
    table_json["check"] = {"status": "ok", "source": "make_wb_table_parity.py (the shape apple-raw-linear writes after its check)"}
    table = WT.WhiteBalanceTable(table_json)

    cases = []
    for w0, w1 in CASES:
        t = table.working_copy_transfer(c, w0, w1)
        cases.append({"asShot": list(w0), "target": list(w1), "transfer": [float(v) for v in t.ravel()]})
    out = {
        "source": "tools/calibrate/make_wb_table_parity.py: wbtable.WhiteBalanceTable.working_copy_transfer "
                  f"（calibration/{cal['camera']['id']}/{cal['track']}-{cal['version']}.json）",
        "whiteBalanceTable": table_json,
        "cases": cases,
    }
    args.out.parent.mkdir(parents=True, exist_ok=True)
    args.out.write_text(WT.dumps(out), encoding="utf-8")
    print(f"wrote {args.out} ({len(cases)} cases)")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
