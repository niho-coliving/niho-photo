# NIHO 標準ルック niho-standard-1 の計測（S8 #16947・2026-09-29）

- 目標: Lightroom（Classic でない方・ローカル）で **Adobe カラー** を当てて書き出した round7（`exports/lr-measure/round7/lr-export-color/`）。20 場面（DC-S5 14・ZV-E10 II 6。FX30 は色の校正が無いので除く）× 中立とプリセット 3 本。
- 候補: 機種別補正済みの作業コピー（DC-S5 apple-v2・ZV-E10 II apple-v2 の色の係数）を段 2 の crate（`niho-develop` 0.3.0）で描いた JPEG。
- 式: `tools/calibrate/look.py`。係数: `crates/niho-develop/looks/niho-standard-1.json`（色相 12 節点 × 彩度 2 節点の HSV の調整を ACR3 の前に、トーンを cube P の最後＝利用者の点カーブの後に）。
- 当てはめ（`fit_look.py`・中立・画素の ΔE00 mean）: train 1.99 → **0.91**・val 2.12 → **0.97**（10 場面ずつ。正則化 0.3）。
- 数値だけの fixture: `v1.json`（`colorcheck fixture write`、niho-standard-1 の 80 組）。見本: `samples/<preset>_<scene>_{lr,interim,standard}.jpg`（人の写っていない 3 場面だけ・長辺 480px）。

## プリセットの近さ（ΔE00 mean / p99。p99 は場面の最大）

| プリセット | 暫定 niho-interim-1 | **標準 niho-standard-1** | 段 2 の下限 |
|---|---:|---:|---:|
| neutral | 2.07 / 6.27 | **1.03 / 5.94** | 1.06 / 6.40 |
| bluesky2 | 3.38 / 22.40 | **3.17 / 21.99** | 3.07 / 23.15 |
| pastel | 2.90 / 14.48 | **2.71 / 15.69** | 2.46 / 14.41 |
| colorful | 3.23 / 23.22 | **2.93 / 24.02** | 2.86 / 23.62 |

- 暫定・標準は Adobe カラーの参照（round7）と、段 2 の下限は **ルック無しの描画を Adobe Standard の参照（round6）** と比べた値（ルックでは縮まらない、段 2 のプリセット再現の差）。
- gate `stage1.preset`（mean ≤ 3.0・p99 ≤ 8.0、3 本とも）は **fail**: p99 は 3 本とも 15〜24、bluesky2 の mean は 3.17。どちらも段 2 の下限（ルック無しでも p99 14〜23・bluesky2 3.07）で決まっている。p99 の外れは DSC01837・DSC01835（ZV-E10 II の夜の室内イベント）・P1570923 など。段 2 の課題として #16942 に渡す。

## トーンの置き場所（中立の当てはめは同じ・3 本の mean）

| 置き場所 | bluesky2 | pastel | colorful | 合計 |
|---|---:|---:|---:|---:|
| ACR3 の前（`pre-acr3`） | 3.50 | 2.74 | 2.81 | 9.05 |
| cube P の先頭（コントラストの前） | 3.45 | 2.68 | 2.82 | 8.95 |
| パラメトリックの後・点カーブの前 | 3.25 | 2.75 | 2.97 | 8.97 |
| **点カーブ（と RGB のカーブ）の後（採用）** | **3.17** | **2.71** | **2.93** | **8.81** |

ACR3 の前に置くと、bluesky2 の黒レベル +90 がルックの沈めた暗部に重なり、Lightroom（Adobe カラーにしても bluesky2 の明るさはほぼ変わらない）より 0.1〜0.2 EV 暗くなった（P1012822 −0.22 EV）。

## 再現

```bash
python3 packages/develop-engine/tools/calibrate/make_lr_round7.py --check
python3 packages/develop-engine/tools/calibrate/run_s8_look.py all      # manifest → fit → crate-build → render → measure → page
python3 packages/develop-engine/tools/calibrate/run_s8_look.py adopt    # 係数を crate の looks/ に写し、parity の fixture を書く
```
