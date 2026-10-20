# calibrate — 土台の色補正の当てはめ（Epic #16939 S9 / #16972）

機種ごとに **NIHO 側の係数だけ** を ΔE00 最小化で求め、校正 JSON（`niho-develop-calibration/v1`）を書く。動かすのは白保存の 3×3 行列（linear ProPhoto D50 で掛ける）と `baselineEV`、任意で 2 光源の行列の組と小さな HueSat 表。Lightroom の書き出しは目標の画像としてだけ使い、Adobe の LUT・プロファイル・DCP の数値は写さない。

- 色の数学・揃え方・表示レンダリングは `../colorcheck/`（`colorcheck.compare` / `color` / `calibration` を import する。前提も同じ: python3 + numpy・Pillow・opencv-python-headless、インストール不要）
- 手順全体: `ops/runbooks/photo-color-calibration.md` §2。DC-S5 × Apple 現像の再現用の一括実行: `run-dc-s5-apple.sh`（`--camera` で別カメラ）。参照の選び方は `refs.py`（round6 優先。round2 / round5 の Look 混入が確認済みの 3 場面は round6 を必須とし、不足時は停止。参照のレンズ補正に Apple 側を合わせる）
- 校正 JSON の置き場: `packages/develop-engine/calibration/<make>-<model>/<track>-<version>.json`（登録の無い機種の既定は `generic/apple-<version>.json`・`fit_generic.py`。新しい機種の登録は `register_camera.py`）

`run-dc-s5-apple.sh` は2光源校正の行列を各場面の `neutral.temperatureK` で選びます。`NIHO_DEVELOP_CRATE_REF` 未指定かつ worktree に crate が無い場合は S3 PR2 branch を使い、crate build は解決済み commit ごとに Cargo target を分けます。外部 bridge binary を `NIHO_DEVELOP_BRIDGE_BIN` で使う場合は、対応する完全な40桁のソース commit SHA を `NIHO_DEVELOP_BRIDGE_REF` で指定してください。commit がこの repository で解決できない場合は停止し、解決した SHA と binary の SHA-256 を作業ディレクトリに記録します。以後の各 crate step でも commit と binary hash を照合し、実行中に binary が差し替わった場合は停止します。

## 使い方

```bash
python3 packages/develop-engine/tools/calibrate/fit_base.py --manifest m.json --out cal.json --report fit.md \
  [--illuminants 1|2] [--illuminant-nodes 2856,6504] [--huesat 0|12] [--size 1500] [--blur 2] [--grid 48x32] \
  [--max-iter 100] [--max-cell-std 8] [--clip-max 0.01] [--version v1] [--no-pixel-eval]
```

| オプション | 既定 | 意味 |
|---|---|---|
| `--manifest` | （必須） | 場面の一覧（下記） |
| `--out` | （必須） | 校正 JSON（`niho-develop-calibration/v1`） |
| `--report` | なし | fit レポート（Markdown）。標準出力にも同じものを出す |
| `--size` / `--blur` | 1500 / 2 | 解析の長辺 px と、ぼかし σ（1500px 換算）。`colorcheck compare` と同じ |
| `--grid` | `48x32` | セル数（長辺側が大きい方） |
| `--illuminants` | 1 | 2 にすると 2 光源の行列の組（下記） |
| `--illuminant-nodes` | `2856,6504` | 2 光源の節点 K（低 K, 高 K）。既定は CIE A と D65。DC-S5 は参照セットの実測分布に合わせて `3400,4900` |
| `--huesat` | 0 | HueSat の色相区分数（0 = 使わない、例 12） |
| `--max-iter` | 100 | 最適化の反復の上限 |
| `--max-cell-std` | 8.0 | セル内の L* 標準偏差の上限（超えたセルは除外） |
| `--clip-max` | 0.01 | セル内の白飛び画素の割合の上限 |
| `--version` | `v1` | 校正の版（`baseVersion` の末尾）。**係数を変えたら上げる** |
| `--no-pixel-eval` | オフ | 画素レベルの評価を省く（メモリ節約。場面の画像を保持しない）。各場面のセル ΔE00 mean / p99 と train / val の集計は出す |

終了コード: 0 = 書けた / 2 = manifest の誤り（items が空・split が train / val 以外・訓練場面が無い・節点の指定が逆）。

## manifest

```json
{
  "track": "apple",
  "camera": {"make": "Panasonic", "model": "DC-S5"},
  "decoderVersion": "8",
  "items": [
    {"scene": "P1012822", "candidate": "apple-linear/v8/P1012822.tiff", "candidateSpace": "linear-prophoto",
     "reference": "round2/lr-export-photos/p2_P1012822_neutral.jpg", "neutralTemperatureK": 5213.4, "split": "train"},
    {"scene": "P1013207", "candidate": "apple-linear/v8/P1013207.tiff", "candidateSpace": "linear-prophoto",
     "reference": "round2/lr-export-photos/p2_P1013207_neutral.jpg", "neutralTemperatureK": 4380.0, "split": "val"}
  ]
}
```

| キー | 既定 | 意味 |
|---|---|---|
| `track` | `apple` | 土台の系統。`apple` なら decoder は `apple-cirawfilter`（設定は固定: boost 0・boostShadow 1・exposure 0・shadowBias 0・EDR 0・gamut mapping と lens correction 有効・local tone map 0・contrast 0）、それ以外は `kind = track` |
| `camera` | — | `make`・`model`（`id` を省くと `<make>-<model>` の slug） |
| `decoderVersion` | — | 記録用（`decoder.decoderVersion` と `baseVersion` に入る） |
| `candidateRoot` | `NIHO_COLOR_WORK_DIR` | 相対の `candidate` の基準 |
| `referenceRoot` | `NIHO_COLOR_REF_ROOT` | 相対の `reference` の基準 |
| `baseVersion`・`decoder`・`inputSpace`・`referenceSet` | 自動 | 校正 JSON の同名の値を上書きしたいときだけ |
| `items[].scene` | 候補のファイル名 | 場面名 |
| `items[].candidate` | （必須） | 土台の線形出力（Apple なら `apple-raw-linear render --space linear-prophoto --encoding tiff32f`） |
| `items[].candidateSpace` | `linear-prophoto` | `linear-prophoto` / `linear-srgb` / `srgb` |
| `items[].reference` | （必須） | 目標の画像（Lightroom の中立書き出し。8bit sRGB） |
| `items[].neutralTemperatureK` | なし | 撮影時の白の色温度 K。`--illuminants 2` に要る |
| `items[].split` | `train` | `train`（当てはめに使う）/ `val`（検証だけに使う） |

## 何を最適化するか

1. **場面の準備**（場面ごと）: `colorcheck.compare.load_pair(render=True)` で参照と候補を長辺 1500px に揃えて位置合わせし、両方を線形光で σ2px ぼかし（候補ははみ出しを除いた正規化畳み込み）、周囲 4% を切る。これを **48×32 のセル** に分け、有効画素で重み付けしたセル平均（候補の線形 ProPhoto RGB と参照の Lab）を作る。
2. **セルの除外**: 有効画素 < 90%・セル内 L* の標準偏差 > 8（輪郭をまたぐセル）・白飛び画素 > 1%・L* が 2〜97 の外。使えるセルが 20 未満の場面は丸ごと外す。
3. **モデル**: `rgb' = max(M · rgb, 0)` → `render_display_linear(rgb', baselineEV)`（ACR3 既定カーブを RGBTone で当てる暫定ルック → 線形 sRGB）→ Lab → 参照のセル Lab との ΔE00。`M` は **白保存**（各行の和 = 1。非対角 6 個が自由度。白は撮影時の白のまま動かさず、明るさは `baselineEV` が受け持つ）。パラメータは 7 個。
4. **目的関数**: 訓練場面のセル ΔE00 の平均（**場面ごとに等しい重み**。セルの数で偏らない）。二乗でなく ΔE00 そのもの（L1）なので、ローカル補正などで合わない一部のセルに引っ張られにくい。
5. **解き方**: IRLS（|ΔE| を ΔE²/(2ΔE₀) + ΔE₀/2 で上から押さえる。ΔE₀ の下限 0.1）+ Levenberg–Marquardt（前進差分のヤコビアン h = 1e-5）。本当の目的関数が下がったステップだけ採る。止める条件: 相対の減少 < 1e-6 が 2 回続く・ステップ < 1e-8・どの減衰でも下がらない・`--max-iter`。
6. **`--illuminants 2`**: 節点（既定 2856K / 6504K）に 1 つずつ行列を置き、場面の `neutralTemperatureK` でミレッド（1e6/K）線形に補間する（範囲外は端の行列）。初期値は 1 行列の解。訓練場面に色温度の無いものがある、またはミレッドの中点の片側に訓練場面が 2 未満なら、自動で 1 行列に戻してレポートに書く。出力の `matrix` は中点の補間値、`illuminants[]` に節点ごとの行列。
7. **`--huesat N`**: 行列と EV を固定したあとに、linear ProPhoto の HSV で N 区分の HueSat 表（節点ごとに色相のずれ［度］と彩度の倍率。色相方向に循環の線形補間、明度は保つ）を当てはめる。隣どうしの差と大きさに正則化を掛ける。**検証場面の ΔE00 mean が 0.2 以上良くならなければ採用しない**（`--no-pixel-eval` のときはセル単位で判定。検証場面が無ければ採用しない）。
8. **評価**: 通常は場面ごとに校正前（単位行列・EV 0）と校正後を、`colorcheck compare` と同じ画素レベル（8bit に丸めた表示レンダリング、ぼかし後）で測る。全体は mean = 場面 mean の平均、p99 = 場面 p99 の最大を train / val 別に出す。`--no-pixel-eval` では画像を保持せず、同じ集計規則でセル ΔE00 の mean / p99 を出し、`fit.metric` にセル指標であることを示す。

## 出力

### 校正 JSON（`niho-develop-calibration/v1`）

`schema`・`track`・`camera{make,model,id}`・`decoder{kind,decoderVersion,settings,...}`・`inputSpace`（Apple は `extended-linear-srgb-d65-as-shot`）・`workingSpace: linear-prophoto-d50`・`matrix{space: linear-prophoto-d50, rowMajor, whitePreserving: true}`・`baselineEV`・`illuminants[{neutralTemperatureK, matrix}] | null`・`hueSat{space: linear-prophoto-hsv, hueDivisions, entries[[hueShiftDeg, satScale]]} | null`・`version`・`createdAt`・`fit{trainScenes, valScenes, metric, train{mean,p99}, val{mean,p99}, before, optimizer[], cells, illuminantsNote, hueSatNote, referenceSet, look}`・`baseVersion`。

`baseVersion` の既定は `<prefix><decoderVersion>/linear-prophoto-d50/cal-<camera id>-<track>-<version>`（Apple の prefix は `apple-ciraw`。例 `apple-ciraw8/linear-prophoto-d50/cal-panasonic-dc-s5-apple-v1`）。作業コピーは `baseVersion` ごとに作り直せる。

当て方（`colorcheck/calibration.py`。`colorcheck compare --render --calibration` と `render --calibration` が使う）: `rgb' = M · rgb`（`--neutral-k` と `illuminants` があれば補間した行列）→ 負を 0 に → HueSat → 表示レンダリング（`ev + baselineEV`）。

### fit レポート（`--report`）

条件（解析寸法・セル・除外条件・ルック・目的関数）、結果の行列と `baselineEV`（2 光源なら節点ごとの行列）、HueSat の採否、最適化の経過（反復回数・終了理由・目的関数の前後・秒数）、場面ごとの表（split・K・使ったセル数・校正前後の画素 mean / p99 とセル mean / p99・校正後の EV 差と彩度比）、train / val の全体、注意（除外した場面・位置合わせの warning など）。`--no-pixel-eval` では画素値を省き、セル単位の集計を train / val に表示する。

## 過学習を避ける

- **場面で分ける**: 当てはめは `split: train` の場面だけ、`val` は検証だけ。DC-S5 は場面名の昇順で偶数番を train、奇数番を val（`run-dc-s5-apple.sh manifest`）。
- 自由度を小さく保つ（1 行列 7 個・2 光源 13 個・HueSat 2N 個）。HueSat は正則化つきで、検証が 0.2 以上良くならなければ捨てる。
- 2 光源は片側 2 場面以上の訓練場面が無ければ使わない。`run-dc-s5-apple.sh fit` は 1 光源と 2 光源の両方を当て、**検証 mean が 0.1 以上良いときだけ** 2 光源を採る（節点の片側の場面が少ないと外挿になるため）。
- 場面ごとに等しい重み（大きな一様面の多い場面に引っ張られない）。
- チャート（段階 2）が来たら、同じ仕組みで基準値に対して当て直す（runbook §5）。

## 決めたこと

- セル 48×32、除外条件（有効 90%・L* 標準偏差 8・白飛び 1%・L* 2〜97）、使えるセル 20 未満の場面は除外。
- 目的関数は L1（ΔE00 の平均）で場面ごとに等しい重み。解き方は IRLS + LM（前進差分）。
- 行列は白保存（白は撮影時の白に任せ、明るさは `baselineEV`）。
- 2 光源の節点の既定は A（2856K）と D65（6504K）、補間はミレッド線形・範囲外は端に固定（DNG の dual-illuminant と同じ考え方）。`matrix` には中点の補間値を入れる。
- HueSat は採用の閾値 0.2（検証 mean の改善）。
- 評価の p99 は場面 p99 の最大（`colorcheck preset` と同じ決め方）。
- 係数を変えたら `--version` を上げる（`baseVersion` が変わり、作業コピーが作り直される）。
- テストは `../colorcheck/tests`（色の数学・compare の揃え方・manifest split 検証・no-pixel 集計）と `tests/`（温度モデル・色順応）で持つ。実データによる補正品質は `run-dc-s5-apple.sh` で確認する。

## 未校正機種の既定（`fit_generic.py`・#18398）

登録表に無い機種（`cal-none`）に当てる汎用の補正を、校正済みの機種の場面をまとめて当てはめる。動かすのは fit_base.py と同じ白保存の 3×3 行列と `baselineEV` だけ（HueSat・2 光源・白の写像は持たない）。

```bash
W=$NIHO_COLOR_WORK_DIR
python3 packages/develop-engine/tools/calibrate/fit_generic.py \
  --manifest $W/fit/manifest-panasonic-dc-s5-v2.json \
  --manifest $W/sony-zv-e10m2/fit/manifest-sony-zv-e10m2-v1.json \
  --manifest $W/sony-ilme-fx30/fit/manifest-sony-ilme-fx30-v1.json \
  --out packages/develop-engine/calibration/generic/apple-v1.json \
  --report $W/generic/report-v1.md --json $W/generic/loo-v1.json
```

- 入力は機種ごとの fit_base.py の manifest（色域の圧縮 on の Apple 線形 TIFF と Lightroom 中立。今の `cal-none` と同じ描き方）。`decoderVersion` は全部同じでなければならない。
- 目的関数は fit_base.py と同じセル ΔE00 だが、**機種ごとの重みを等しく**する（機種の中では場面ごとに等しく。`fit_base.Model(scene_weights=…)`）。汎用の補正は機種の全場面（train と val）で当てはめる。
- leave-one-out: 機種を 1 つずつ外して残りで当てはめ、外した機種の全場面と val で「補正なし」「汎用」「ほかの機種の行列の平均」「その機種の校正（train で当てはめ）」を画素の ΔE00 で測る。**gate: どの機種でも汎用 < 補正なし**（校正済みより悪くてよい）。合格したときだけ全機種で当てはめた補正を `--out` に書く（不合格は exit 3）。
- 出力の校正 JSON は `camera: {make: null, model: null, id: "generic"}`・`lens.mode: apple`・色域の圧縮 on（apple-raw-linear の fallback の決まり）。`fit.leaveOneOut` に表を残す。係数を変えたら `--version` を上げる（作業コピーの `cal-generic-apple-<版>` が変わる）。

## 新しい機種の登録（`register_camera.py`・#18398）

RAW 4 場面以上＋Lightroom 中立の書き出しから、校正 JSON・登録表・API の写し・Desktop の lock の照合までを 1 本で回す。手順と owner の作業は runbook（`ops/runbooks/photo-color-calibration.md`「新しい機種を登録する」）。

| step | すること |
|---|---|
| `plan --make M --model N [--scenes …] [--val …] [--lens apple\|embedded]` | round6/ 直下のこの機種の RAW を EXIF で集め、Apple の decoderVersion 8 があるかを確かめ、撮影日で train / val を交互に分けて `cameras/<id>.json` を書く（id は make と model から。型番の先頭の make は外す） |
| `lr` | `make_lr_round6.py --add --variants neutral,neutral_lens`（owner が Lightroom で書き出す） |
| `check` | `make_lr_round6.py --check` と、全場面の中立の書き出しがあるか |
| `fit [--version vN]` | run-dc-s5-apple.sh の render → manifest → fit → wb-map → base（機種の設定は `shell-vars` で渡す。case に機種を足さない）。レンズの方式は機種の設定から入れる |
| `gate` | 補正なし・汎用（登録表の fallback）・この機種の校正を画素の ΔE00 で比べる。合格 = val mean ≤ 2.0 かつ補正なしと汎用より良い。結果は `$NIHO_COLOR_WORK_DIR/<id>/results/gate-<版>.json` |
| `register` | 登録表に行を足す（同じ機種なら file を差し替え）→ `apple-raw-linear registry` で確かめ（通らなければ戻す）→ API の写しを `--write` → Desktop の lock を `check --allow-ahead` |
| `status` | どこまで済んだか |

## Lightroom の参照 round6 を作る（`make_lr_round6.py`）

owner が `lr-measure/round6/` 直下に置いた RAW と、round2 で Adobe Color の Look が混ざった旧 3 場面を、1 場面 7 通り（中立・プリセット 3 本・絶対 WB 4000K / 5500K / 7500K）の XMP 付き APFS クローンにして `round6-photos/` に並べ、owner 向けの `README.md` と `manifest.json` を書く。全変種が Adobe Standard・Look 無し・PV 15.4。`--dry-run` で一覧だけ、書き出し後は `--check` で `lr-export/` の枚数と Look 無しの Adobe Standard を確かめる。手順は runbook §5。

## Lightroom の参照 round8 を作る（`make_lr_round8.py`・E1 #17120）

段 2 の効果（白黒・周辺光量補正・粒子）の係数を当てはめる参照。round6 の 6 場面（DC-S5 4・ZV-E10 II 2・縦位置 1 枚）× 16 通り（中立、白黒 4 通り＝ミックスなし・暖色寄り・寒色寄り・調色、周辺光量補正 7 通り＝−50・−100・+50・形 2 通り・スタイル 2 通り、粒子 3 通り、フィルム調の白黒 1 通り）を `round8/round8-photos/` に並べる。全変種を round6 の中立と同じ Adobe Standard・Look 無しに揃える（round7 の Stubbed な Look の罠は起きない）。粒子は統計で比べるので `GrainSeed` は書かない。`--dry-run` で一覧だけ、書き出し後は `--check` で枚数・プロファイル・効果の値（`ConvertToGrayscale`・`PostCropVignetteAmount`・`GrainAmount`）を確かめる。手順は runbook §5。

## Lightroom の参照 round9 を作る（`make_lr_round9.py`・E1c #17259）

round8 に無い端の値を確かめる参照。round8 と同じ 6 場面 × 19 通り（中立、周辺光量補正 12 通り＝中心点 0 / 100・ぼかし 0 / 100・丸み +100 / −100 / −50（中心点 30）・明るくする側 3 スタイル・ハイライト 50 / 100、粒子 4 通り＝サイズ 0 / 100・粗さ 0 / 100、白黒ミックス全色 +100 / −100）を `round9/round9-photos/` に並べる。変種の作り方と `--check` は round8 の関数をそのまま使う。

## 効果の当てはめ（`run_e1_effects.py`・E1 #17120・E1c #17259）

段 2 の効果（白黒ミックス・周辺光量補正・粒子）の係数と式を round8（E1）と round9（スライダーの端の値。E1c）に当てはめる。`python3 run_e1_effects.py <step> [--round 8|9]`（`refs` → `crate-build` → `render` → `measure` → `grain-stats` → `vig-fit` / `bw-fit` / `grain-fit` → `page`、`all` で通し）。`--round`（既定 8）は計測する round で、変種は各 round の `manifest.json` から読む。作業ディレクトリは `$NIHO_COLOR_WORK_DIR/e1/`（round8 の結果はその直下、round9 は `e1/round9/` の下。build・probe の出力・当てはめの結果 `fit/*.json` は共有）、参照は `$NIHO_COLOR_REF_ROOT/round<N>/`、入力は S8 のレンズ補正なしの作業コピー（`s8/working-copy-nolens/`）。`crate-build` は worktree の crate を写して計測用ブリッジ（`crate-bridge/render_working_copy.rs`・段ごとの値を出す `crate-bridge/probe_stage.rs`）を組み、`--coeffs`（定数の上書き。数か数の並び）・`--patch` で候補を試す（worktree は汚さない）。ΔE00 は colorcheck と同じ位置合わせ、粒子は「粒子あり − neutral」の残差の標準偏差と自己相関の半値幅（Lightroom のフルサイズを線形光の面積平均で 2560px に縮めて比べる。粒そのものは像の細部の少ないタイルで測る）。

- `vig-fit` は crate を描かない: Lightroom の「変種 と neutral」を crate の tone の表で pre-tone に戻し、格子ごとの強さ（ハイライト優先は平方根の空間の一次式）からマスクの logistic（中心・スケール・負の丸みの角の半径）と、色優先・ペイント・明るくする側の法則、ハイライトの係数を出す（`--loo` で場面を 1 つ抜いたときの係数の幅）。
- `bw-fit` は pre-tone の画像に白黒ミックスの倍率を掛けて ACR3 の曲線（probe で取った形）→ 灰 → 出力を numpy で描き、ΔE00 で帯の群ごとの強さを当てはめる（`--loo` つき）。
- `grain-fit` は格子 1 枚の場の統計（環境変数で定数を上書きできる計測専用の probe）から 2 枚の格子の間隔と振幅を当てはめる。
- 書き出しが途中で切れている JPEG（round9 の `p9_DSC09206_grain_size0.jpg`・`…_grain_rough100.jpg`。終端が無い）は 2 回目（`-2`）を参照にする。

見比べページは人の写った場面を含むので hihirohub の中だけ（`e1/page/`・`e1/round9/page/`）。結果（2026-09-30）は crate の README「効果の Lightroom との差」。

## Lightroom の絶対 WB のための白の写像（`fit_wb_map.py` / `wb_validate.py` / `wbmodel.py`）

- `wbmodel.py`: crate `color.rs` と同じ DNG の温度モデル（Robertson 等温線・tint = uv × −3000）と Bradford（ほかに CAT02 / XYZ 対角 / ProPhoto 対角）。
- `fit_wb_map.py --out <asshot-map.json>`: Apple の as-shot xy と Lightroom 書き出し XMP の `ColorTemperature/Tint` から、Adobe が as-shot と見る白への uv オフセットを当てる。結果は校正 JSON の `whiteBalanceMap` に入れる（`fit_base.py` は再 fit 時に既存の `whiteBalanceMap` を引き継ぐ）。`make_working_copies.py` はこれを使って作業コピーのメタに `asShotWhiteAdobe` を書く。
- `wb_validate.py --map ... --bridge ... --sources asshot,H1,H2,H3 --cats bradford,...`: round1 の絶対 WB 変種と bluesky2 を、色順応の出発点（Apple xy / Adobe 実値 / 写像）と種類で比べる。DC-S5: 8.05 / 4.74 / 3.51 / 3.75、種類の差は 0.03 以内（v1・round1 の Adobe Color 入りの参照）。v2（round6 の Look 無し 4000/5500/7500K × 13 場面）: 6.71 / 3.62 / 2.12 / 2.21。ZV-E10 II v1（4 場面）: 7.60 / 3.15 / 2.47 / 2.48。既定の場面は round6 に書き出しがある全場面（`--scenes` で絞れる）。
- テスト: `python3 -m unittest discover -s tests -t .`（温度モデルの往復・色順応の恒等）。

## NIHO 標準ルック（S8 #16947。`look.py` / `fit_look.py` / `run_s8_look.py` / `make_lr_round7.py`）

`make_lr_round7.py` の生成・検査では、利用者のAdobe Colorプロファイル識別子（32桁の16進数）を `NIHO_ADOBE_COLOR_PROFILE_ID` に指定する。識別子は公開ソースに固定しない。

段 2 のルック `niho-standard-1`（Adobe Color に近い印象の NIHO 自前のルック）の係数を、Lightroom で Adobe Color を当てた書き出しに合わせて決める。動かすのは NIHO の式の係数だけで、Adobe の LookTable・プロファイルの数値は読まない・写さない。

- `look.py`: 式の正（docstring）。HSV（色相 12 節点 × 彩度 2 節点の色相のずれ・彩度と明度の倍率の対数）を ACR3 の前に、単調なトーン（Fritsch–Carlson）を `tone.stage` の段に当てる。crate `src/look.rs` と 1e-9 で一致（`run_s8_look.py adopt` が parity の fixture を書き、`tests/look_parity.rs` が確かめる）。
- `fit_look.py`: 中立の書き出しに、作業コピー × 2^baselineEV を「ルックの色 → ACR3 → ルックのトーン → sRGB」で描いた値を合わせる（セル・除外・目的関数・IRLS + LM は `fit_base.py` と同じ。正則化は色相方向の 2 階差分・大きさ・彩度の節点間・トーンの単調性）。
- `run_s8_look.py <step>`: `manifest`（round7 の 20 場面。機種ごとに名前順で偶数番 = train）→ `fit`（毎回、現行 round7 からfit manifestを再生成し、参照JPEGと作業コピーPNGの内容指紋を係数ファイルの `.provenance.json` に保存。正則化の既定値 0.3）→ `crate-build`（worktree の crate を作業ディレクトリへ写し、`s8/fit/look.json` を焼いたブリッジを組む。係数ファイルが無い場合は既存 build tree を保ったまま失敗する。worktree は汚さない）→ `render`（場面 × 中立とプリセット 3 本 × 暫定・標準）→ `measure`（`colorcheck preset` と gate）→ `page`（肌・空・緑・夜・室内の見比べページ。人の写った場面を含むので worktree の `.preview/` と hihirohub にだけ置く）。`adopt` はfit manifest・現行参照画像・係数の指紋がすべて一致した場合だけ crate の `looks/` に写す。参照を差し替えたら `fit` からやり直す。
- `make_lr_round7.py`: round6 と同じ場面（FX30 を除く）に「中立＋Adobe Color」とプリセット 3 本＋Adobe Color を並べる。**罠**: Lightroom は読み込み時にサイドカーの Stubbed な Look を解決せず、中身の無い Look で描く（1 回目の `lr-export/` は Adobe Standard と ΔE00 0.00）。owner の Lightroom で 1 枚のプロファイルを「Adobe 標準 → Adobe カラー」と選び直し、「設定をコピー」でプロファイルだけをコピーして全枚に貼ってから `lr-export-color/` へ書き出す（runbook §5）。`--check` はLook解決・Adobe Standard・`AlreadyApplied=True`・manifestに記録した全設定を検査する。manifest未指定の既知設定はLightroomの既定値と照合し、未知の現像設定も不一致として止める。 切り抜き・遠近補正・HDR・カメラ補正などの既定値も検査対象。`RawFileName` は記録情報として除外する。`LensDefaults` の自動レンズ識別情報と `As Shot` の撮影時WBは画像ごとに解決される値として扱い、manifestに指定があれば必ず照合する。絶対値を両方省略した `Custom`（増分0）は既存の `xmp.rs::LIGHTROOM_CUSTOM_WHITE` と同じ5001K/+10だけを許可し、任意のWBは許可しない。
- 結果（2026-09-29・20 場面）: 中立 2.07 → 1.03、bluesky2 3.38 → 3.17、pastel 2.90 → 2.71、colorful 3.23 → 2.93（ΔE00 mean）。トーンの置き場所 4 案の比較と、段 2 の下限（ルック無し × Adobe Standard）は `fixtures/color/look/niho-standard-1/summary-v1.md`。

## JPEG の露出・白・HSL の参照 round10（P1 #17117・`make_lr_round10.py`）

round3 の中立 JPEG 8 場面を入力に、露出単独 ±1 EV、JPEG の色温度と色かぶり（暖色側 +30/+20・寒色側 −30/−20）、青の色相/彩度、橙の彩度を各場面に当てる。Lightroom の出力と NIHO の crate を同じ JPEG 入力で比べ、P1 の未計測だった色の応答を確認する。入力 JPEG と書き出しは私物なので `NIHO_COLOR_REF_ROOT/round10/` のみへ置き、repo に含めない。

- `python3 packages/develop-engine/tools/calibrate/make_lr_round10.py --dry-run` で 8 場面 × 7 設定 = 56 枚を確認し、引数なしで埋め込み XMP 付き JPEG・manifest・owner 向け README を作る。既にある出力は上書きしない。
- owner が Lightroom「ローカル」で書き出した後、`--check` で 56 枚と設定値を検査する。書き出し条件は `ops/runbooks/photo-color-calibration.md` §5「round10」。
- 比較は `NIHO_LR_MEASURE_DIR=… cargo test --release -p niho-develop --test lightroom -- --ignored --nocapture` の round10 の表で行う。現行 gate（プリセット平均 3.0 / p99 8.0）を、未計測を理由に変更しない。

## JPEG の増分ホワイトバランスの較正 round11（#17523・`make_lr_round11.py`）

round10 では JPEG の色温度・色かぶりの変更が Lightroom の出力画素に現れた一方、現行 NIHO はこの設定を扱えず、中立画素を描いた。単独の温度・色かぶりと組み合わせの応答を分けて測るため、人物写真を使わない sRGB の 17³ 色見本を 11 設定で用意する。入力と書き出しは `NIHO_COLOR_REF_ROOT/round11/` にだけ置く。

- `python3 packages/develop-engine/tools/calibrate/make_lr_round11.py --dry-run` で枚数を確認し、引数なしで JPEG・manifest・owner 向け README を作る。既存の入力があるときは上書きしない。
- 色温度または色かぶりだけを変える入力も `WhiteBalance=Custom` と両軸の `IncrementalTemperature` / `IncrementalTint`（変更しない軸は 0）を明記する。片軸だけでは Lightroom が `As Shot` に戻して補正を画素へ反映しないため、`--check` は書き出し後の3属性も照合する。
- Lightroom の「ローカル」から JPG・画質 100%・フルサイズ・sRGB・出力シャープ OFF で `round11/lr-export-jpeg/` へ書き出す。「元の形式＋設定」は画素に現像を反映しないため使わない。`--check` で枚数・設定値・画素の変化と、埋め込みICCのsRGB変換（ICCなしならEXIF ColorSpace=sRGB）を検査する。
- 出力は温度・色かぶりの変換則を推定する参照。実写真 8 場面の round10 と別の写真でも誤差を確かめ、neutral・露出・HSL の結果を守ってから実装する。

### repo 所有 LUT の生成（`build_jpeg_wb_lut.py`）

owner が保持する round11b の合成チャート書き出しから、repo の `calibration/jpeg-incremental-wb-v1.bin` を再生成する。入力の正確な保管場所は非公開で、コマンドには `<private-round11b-dir>` を渡す。個人写真と元 JPEG は repo に入れない。

```bash
python3 packages/develop-engine/tools/calibrate/build_jpeg_wb_lut.py <private-round11b-dir>
python3 packages/develop-engine/tools/calibrate/build_jpeg_wb_lut.py <private-round11b-dir> --check
```

builder は manifest の11設定、852×840 の JPEG、埋め込み XMP の `AlreadyApplied=True`・WB値、全10変種と neutral の画素差を検査する。Lightroom が温度単独4枚だけ tint 0 を +1 に正規化するため、その4表は `(tint_p20 - neutral) / 20` を引いて公称 tint 0 に戻す。各 patch の中央 4×4 平均と neutral の差を 1/16 byte 単位の little-endian i16 にし、固定順 `temp_m80, temp_m30, temp_p30, temp_p80, tint_m50, tint_m20, tint_p20, tint_p50, wb_cool, wb_warm`、各 17³ node × RGB、header なしで書く。この binary は NIHO の合成色計測から作った較正値で、Adobe の LUT や個人画像の複製ではない。

## 白の行列の表（S11 #17108。`wbtable.py` / `fit_wb_table.py` / `run_s11_wb.py`）

RAW の白（色温度・色かぶり）を、段 2 で Apple の RAW 現像と同じ計算で当て直すための、機種ごとの表。Lightroom と同じく「白は手前で、いつでも正確に変えられる」構造にする（owner 決定 2026-09-29）。

- **前提（実測）**: Apple の CIRAWFilter は、色域の圧縮（`isGamutMappingEnabled`）を切ると、同じ RAW を白 w で描いた出力が `out(w) = M(w) · out(基準の白)` とちょうど 3×3 になる。`M(w)` は機種と白だけで決まり、写真によらない（DC-S5・ZV-E10 II の各 5 枚で、白飛びしていない画素の相対残差 0.0000〜0.006）。色温度が同じなら tint の違いはカメラの色空間の対角の倍率（行列どうしが 1e-8 で可換）＝ DNG と同じ形。白飛び寸前〜白飛びの画素だけはセンサーの飽和とハイライト復元のため行列にならない。
- **表**（`wbtable.py` が式の正。校正 JSON の `whiteBalanceTable`、作業コピーのメタにも写す）: Lightroom の尺度の（ミレッド 20〜500 を 20 刻み × tint 15 節点）の格子で、基準の白（5000K / 0）に対する `M(w)` の**逆行列**を持つ。逆行列はカメラが見た白（倍率の逆数）に線形なので、逆行列を双線形に補間して `M(w)` に戻す（行列をそのまま補間すると tint 25 刻みで節点の間 ΔE00 最大 1.6、逆行列なら 0.3）。作業コピー（機種別補正 `C` 済み）を撮影時の白 w0 から目標の白 w1 へ: `C · M(w1) · I(w0) · C^-1`。
- **適用条件**: 現行の表メタは校正行列 `C` を1つだけ持つため、複数の `illuminants` を持つ校正 JSON とは組み合わせない。表の入力 RAW は `appliedSettings.assigned.isGamutMappingEnabled` が明示的に `false` の描画だけに限る。2 光源の係数を渡す形式が追加されるまで、計測・作業コピー生成・`apple-raw-linear` は不正な組み合わせを拒否する。
- **計測**（`fit_wb_table.py`）: 校正の `decoder.decoderVersion` で1枚の RAW を基準の白と 375 節点の白で、色域の圧縮を切って長辺 384 で描き（`apple-raw-linear render --white --gamut-mapping off`。Lightroom → Apple の白は校正の `whiteBalanceMap` の逆）、元の描画で飽和から離れた画素（全チャンネル 0.0005〜0.6）で 3×3 を当てはめる。キャッシュはRAWの同一性・白の写像・CLI版・macOS build・decoder・描画条件が一致するときだけ再利用する。格子の外の白 24 通りと、ほかの RAW（`--verify-raw`）で、表の予測と実際の描画を比べる。
- **一括**（`run_s11_wb.py render fit table wc accuracy`）: 色域の圧縮を切った描画で機種別補正 apple-v3 を当てはめ直し（白の写像とレンズは v2 から引き継ぐ）、表を入れ、round6 の白の変種（20 場面 × 4000 / 5500 / 7500K）で「今の近似（Bradford）」「表」「Apple で描き直し」を crate の描画で Lightroom と比べる。作業中間物は `$NIHO_COLOR_WORK_DIR/s11/`。
 - テスト: `python3 -m unittest discover -s tests -t .`（表の補間・キャッシュkey・作業コピー条件・S11のカメラ絞り込みを含む）。

## niho-6（JPEG / PNG のハイライト・シャドウ、#18397）

- `make_lr_p3_jpeg.py`: 教師（`--set teachers`）と封印する独立評価（`--set independent`）の Lightroom 入力を作る（設定を埋め込んだ JPEG。`--check` で書き出しを確かめる）。手順は runbook §5「issue18397」。
- `fit_niho6_response.py`: `dataset`（crate の `examples/niho6_features.rs` の特徴と Lightroom の書き出し）→ `fit`（`--folds dates` で撮影日ごとの検証）→ `export`（`crates/niho-develop/niho6/response-jpeg.json` と、`niho6_response.rs` に写す SHA-256）。式と凍結・独立評価の手順は `../../NIHO6.md`。
