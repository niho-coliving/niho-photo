# Issue #26 / #27 公開研究経路

#26 と #27 の不採用の候補は production renderer から隔離した研究経路である。`niho-8` や既存 engine の既定には接続せず、private Lightroom reference や独立 holdout の合格を主張しない。#27 で採用した方式は `niho-13` として production に入った（下）。

## #27 JPEG の相対 WB: 採用した方式

採用したのは、測った変換（`calibration/jpeg-incremental-wb-v1.bin` の差分 LUT と同じ節点・補間・組の残差）を、出力の最後ではなく処理の先頭（入力の符号化 sRGB）に float で当てる方式で、新 engine [`niho-13`](NIHO13.md) として raster・旧 RAW の新規編集の既定にした（owner 判断 2026-10-21）。合成 17³ 色見本の Lightroom 書き出し（round27）で、WB 単独の mean の平均は 0.49 → 0.15、WB と編集を重ねた 44 組の mean の平均は 2.77 → 1.99（`niho-12` の出力側 → `niho-13`）。p99 の悪化は端の飽和色に集まり、測定の範囲（8bit で clip された色見本の外側）の限界として残す。数値・限界・再現手順は [NIHO13.md](NIHO13.md)。

### 不採用: linear ProPhoto の色順応

最初の候補は、入力の linear ProPhoto D50 上で Bradford の色順応を当てる `research::linear_jpeg_wb` だった（production renderer から隔離。`color.rs` の `xy_from_temperature`・`bradford_xyz`・ProPhoto D50 行列を使い、Core Image の `relative_wb` の尺度は使わない）。fit は公開測定の軸 8 条件（温度 ±30/±80、tint ±20/±50）だけを読み、温度は 5000K 周りのミレッド差、tint は DNG tint に写して節点ごとに当てはめ、節点間は線形補間した。`wb_cool` / `wb_warm` の 2 条件は fit から隠して validation で初めて読んだ。

```sh
cargo +1.98.1 run --release --locked \
  --manifest-path packages/develop-engine/Cargo.toml \
  -p niho-develop --example linear_jpeg_wb_fit \
  > /tmp/linear-jpeg-wb-fit.json
```

2026-10-20 の [公開 chart の測定](fixtures/color/review-2026-10-20/linear-jpeg-wb.json)は全 10 条件の mean ΔE00 = 6.3315、fit 未使用の 2 複合条件の mean = 5.2123 で、各条件 mean ≤ 0.5 の gate に届かなかった。

さらに、制約の無い線形光の 3×3（Bradford・CAT16・対角はすべてその特殊形）を 10 条件それぞれに当てはめても、最小二乗で mean 0.84〜10.55、平均 ΔE00 を直接最小化しても 0.57〜6.83 で、どの条件も gate に届かない（[当てはめ](fixtures/color/review-2026-10-21/round27-linear-3x3.json)、`tools/calibrate/fit_linear_wb_3x3.py`）。Lightroom の JPEG の相対 WB は白（255）を動かさず中間調を大きく持ち上げる非線形な処理で、線形の色順応では表せない。この research path は比較の記録として残し、production には入れない。

## #26 analytic image-adaptive H/S candidate B

`research::analytic_hs` は production renderer から隔離した候補である。写真全体を長辺最大750へ area reduction し、linear ProPhoto の平均 log2 輝度 `m` と p90 `q` を測り、露出 EV を両方に足す（Lightroom は露出後の写真で H/S を決める: NIHO6.md R20）。既存 `spatial.rs` の局所ラプラシアン（Highlights は粗い段への表、Shadows は remap 付き）に、次の直線で決まる振幅と shift を渡す。表・remap・ピラミッドの深さは `spatial.rs` のまま変えない。

| 項 | 式（係数の数） | 固定の範囲 |
| --- | --- | --- |
| Highlights の振幅 | `kH = c0 + c1·m`（2） | 0..3.5 |
| Highlights の shift | `sH = c0 + c1·m`（2） | −12..8 |
| Shadows の振幅 | `kS = c0 + c1·q`（2） | 0..2.5 |
| Shadows の shift | `sS = c0 + c1·q`（2） | −12..8 |
| 色差の指数 | `out = rgb·G + (rgb − Y)·(C − G)`、`C = 2^(αH·gH + αS·gS)`（2） | 0..1.5 |
| 有界残差 | `tanh(r·[1, m/8, q/8])·maxResidualEV`（3＋3、明部・暗部の重み付き） | `maxResidualEV <= 0.5` |

画素ごとの gain は合計 −4..+3 EV に制限する。α=1 は scalar gain、中立画素は中立のまま、ゼロ補正（H ≥ 0 かつ S ≤ 0）は入力とバイト一致。式の 10 係数だけの族を B1、残差 6 係数を足した族を B2 と呼ぶ。

凍結 manifest は `niho.analytic-hs-candidate.v1`（式と残差の係数、canonical な係数の SHA-256、`frozen: true`）。旧 `niho.analytic-hs-residual.v1` は未校正の式（2026-10-20 の anchor）＋残差として読む。crate は manifest を読むだけで、学習・閾値の選択をしない。独立評価の前に exact source commit・実行ファイル・係数・評価 manifest を固定し（[freeze record](fixtures/color/review-2026-10-21/analytic-hs-freeze.json)）、独立評価を見てから係数・式・閾値を変えない。

probe は A=設定の raster engine（`niho-6`/`niho-8`/`niho-10`。それ以外は `niho-6`）、B=候補の H/S の後に同じ engine の残りの stage を描き、PNG 2枚と input/settings/output hash、係数と manifest の SHA-256、解析値、timing、gate contract を `manifest.json` に書く。reference を受け取らないため `gateResult` は常に null。

```sh
cargo +1.98.1 run --release --locked \
  --manifest-path packages/develop-engine/Cargo.toml \
  -p niho-develop --example analytic_hs_probe -- \
  /path/to/input.jpg /path/to/settings.json /tmp/analytic-hs \
  packages/develop-engine/fixtures/color/review-2026-10-21/analytic-hs-candidate.json
```

校正は crate の外の `tools/calibrate/fit_analytic_hs.py` が行い、評価器 `examples/analytic_hs_calibrate.rs` に係数を渡して誤差を受け取る（手順は `tools/calibrate/README.md`）。合成の unit test は有限性・EV 上限・中立・ゼロ補正の不変性・露出追従（露出 +1 が 2 倍明るい写真と同じ解析になる）・α=1 の scalar gain・manifest の改ざん拒否・probe の engine 保持を検査し、画質改善は主張しない。

WB測定は、順応したlinear ProPhotoをlinear sRGBへ戻しclipと8bit符号化を通した表示色を比較するmatrix単体の測定である。負値や範囲外のlinear値を、clip済み参照へ直接比べない。完全な処理順・presetとの相互作用を検証した結果とは扱わない。CIEDE2000は[Sharma/Wu/Dalalの実装検証資料](https://hajim.rochester.edu/ece/sites/gsharma/ciede2000/)の代表的数値例で確認する。


調整用の既存教師データは `tools/color-review-teachers.py --repo <checkout> --work <private-directory>` で比較する。private-directory の `data/teachers` と `data/teachers2` に従来のmanifest・inputs・lr-exportを置く。出力先がrepository内なら拒否し、sealed manifestも拒否する。niho-6/8は全教師のneutral＋3 presetを比較し、原理式Bは各cohortのISO最小・中央値・最大というmetadataだけの部分集合で開発時の失敗を調べる。白紙除外は従来の90%以上clip条件のまま。Bの部分集合の平均を全教師平均と比較せず、同じscene/variantの対で差を確認する。

全入力hash・scene名・画像は非公開出力内に残す。公開するのは `teacher-summary-sanitized.json` の匿名集計、exact commit、renderer hash、測定手順だけである。このツールは独立評価を実行せず、既存164条件・夜24・独立20やRAWの最終gateを完了扱いにしない。


## 2026-10-20の候補B開発比較（未校正の anchor）

[匿名数値](fixtures/color/review-2026-10-20/teacher-development.json)は教師cohortごとのISO最小・中央値・最大というmetadataだけで決めた6場面（24条件）を現行niho-6と対で比較したもの。独立評価の画像は0枚。

| 候補B・6場面 | mean ΔE00 | p99最大 |
| --- | ---: | ---: |
| 中立 | 0.3390 | 1.6171 |
| bluesky2 | 2.5425 | 10.3584 |
| pastel | 3.1935 | 8.6451 |
| colorful | 3.2966 | 12.5389 |

preset mean≤3・p99≤8のgateに未達。同じscene/variantのniho-6比でも最大mean悪化1.4369・p99悪化2.9563があるため、この未校正の原理式を採用しない。教師上で振幅/shift・残差を校正するか、owner側の追加教師案Aを比較する必要がある。これは独立評価の前段階での未達判定であり、教師上で次候補を作り直す段階である。独立評価には進めていない。

## 2026-10-21 開発教師での校正（案B、owner 判断 2026-10-21）

案B を既存の開発教師だけで校正し、撮影日 fold の交差検証で汎化を確かめてから凍結した。封印済みの独立評価セットは開いていない（読んだ画像 0 枚）。[匿名集計](fixtures/color/review-2026-10-21/analytic-hs-teachers-B1.json)・[凍結した係数](fixtures/color/review-2026-10-21/analytic-hs-candidate.json)・[freeze record](fixtures/color/review-2026-10-21/analytic-hs-freeze.json)。

### 方法

- 教師: teachers 33＋teachers2 24 = 57 場面（白紙 2 枚を従来の決まりで除外）。各場面の中立と H/S を含む 11 設定（h30/h60/h100、s30/s60/s100、h60s30、h100s100、preset bluesky2/pastel/colorful）。部分集合は metadata だけで決める: 夜・暗い室内 = band dark（ISO > 640）23 場面、明るい iPhone = iPhone かつ band bright（ISO ≤ 100）18 場面、その他（カメラの明・中、iPhone の中）16 場面。
- fold: 撮影日を並べて `d[k::5]` の 5 fold（11/11/11/14/10 場面。NIHO6.md R12 と同じ規則）。各 fold の係数は残りの撮影日の写真だけで決め、fold 外の写真で測る。
- 最適化用の代理評価: H/S の gain を 1024px（2048px と局所ラプラシアンの段数が frame に対して同じ）、下流の描画と ΔE00 を 512px（blur 2·512/1500、参照の平坦画素 8000 点）で測る。H/S を含む 627 条件で gate の測り方（下表）との相関は mean 0.99・p99 0.93〜0.97、平均の差は mean 0.05・p99 0.2 以内（代理評価がやや大きい）だった。
- 目的関数（交差検証の前に固定）: 条件ごとに `mean + 0.25·p99 + 0.5·max(p99 − 6, 0)²`。dark 以外の場面は niho-10 より mean が 0.2 を超えて悪い分の 2 倍を足す（昼光を悪くしない）。preset の重み 2。
- 段階: 写真ごとの定数（その写真の単独 H 3 条件・単独 S 3 条件で振幅・shift・α を決める診断）→ 学習側の写真だけで統計へ回帰した開始点 → H 単独（5 係数）→ S 単独（5 係数）→ 全 11 設定で 10 係数 = **B1** → 残差 6 係数（maxResidualEV 0.5）= **B2**。有界 Nelder–Mead（評価 120/120/120/80 回）。
- B1/B2 の選択（交差検証の前に固定した規則）: fold 外の代理評価で、夜・暗所・明るい iPhone の preset p99 > 8 の件数、次に preset mean。B2 は昼光の preset mean が 0.05 を超えて悪化しないこと。fold 外は B1 29 件・2.848、B2 30 件・2.850 で **B1** を選んだ。凍結したのは全 57 場面で同じ手順の B1（10 係数）。
- 式の族・目的関数・段階・開始点の作り方は、交差検証の前の全教師での試行（in-sample）と写真ごとの定数の診断で決めた。fold 外の数字を見てからの変更はしていない。

### gate と同じ測り方の結果（2048px 描画 → 長辺 1500・blur 2・平坦画素）

niho-10（H/S は niho-6 と同じ）の応答はこの 57 場面で学習済みなので、niho-10 の数字は in-sample である。B1 は fold 外が主、全教師で当てはめた in-sample を別に示す。各欄は mean / p99 平均 / p99 最大 / p99 > 8 の件数。

| 設定（57 場面） | niho-10 | B1 fold 外 | B1 in-sample | fold 外の niho-10 比: mean 悪化件数・最大増 / p99 悪化件数・最大増 |
| --- | --- | --- | --- | --- |
| 中立 | 0.26 / 0.92 / 2.21 / 0 | 同一 | 同一 | — |
| bluesky2 | 2.11 / 4.88 / 9.92 / 4 | 2.37 / 5.32 / 12.46 / 5 | 2.36 / 5.26 / 11.69 / 5 | 49・+1.66 / 40・+5.43 |
| pastel | 2.78 / 6.22 / 9.57 / 5 | 2.90 / 6.34 / 12.94 / 7 | 2.86 / 6.26 / 12.73 / 7 | 32・+1.98 / 32・+3.86 |
| colorful | 2.58 / 6.39 / 13.61 / 14 | **3.04** / 7.83 / 21.94 / 20 | 2.99 / 7.64 / 18.49 / 20 | 49・+1.49 / 48・+16.82 |
| preset 計（171） | 2.49 / 5.83 / 13.61 / 23 | 2.77 / 6.49 / 21.94 / **32** | 2.74 / 6.39 / 18.49 / 32 | 130・+1.98 / 120・+16.82 |
| h30 | 0.70 / 2.21 / 6.19 / 0 | 0.99 / 2.89 / 9.91 / 1 | 0.98 / 2.82 / 7.12 / 0 | 51・+1.35 / 52・+7.86 |
| h60 | 1.23 / 4.22 / 13.39 / 1 | 1.84 / 5.69 / 19.18 / 7 | 1.81 / 5.54 / 17.06 / 7 | 51・+2.62 / 51・+15.68 |
| h100 | 1.96 / 7.03 / 16.55 / 19 | 2.95 / 9.60 / 30.04 / 29 | 2.91 / 9.31 / 25.41 / 29 | 49・+4.16 / 49・+24.65 |
| s30 | 0.62 / 1.93 / 4.99 / 0 | 0.83 / 2.43 / 6.56 / 0 | 0.82 / 2.39 / 6.35 / 0 | 52・+0.65 / 51・+1.90 |
| s60 | 1.08 / 3.61 / 9.73 / 2 | 1.56 / 4.93 / 12.61 / 7 | 1.55 / 4.84 / 12.21 / 6 | 51・+1.61 / 55・+3.92 |
| s100 | 1.81 / 6.80 / 19.32 / 19 | 2.66 / 8.80 / 22.12 / 29 | 2.62 / 8.65 / 21.21 / 28 | 50・+3.29 / 48・+6.72 |
| h60s30 | 1.27 / 3.88 / 11.48 / 1 | 1.77 / 5.17 / 20.19 / 3 | 1.74 / 5.00 / 14.99 / 3 | 49・+2.29 / 51・+16.77 |
| h100s100 | 3.11 / 7.49 / 12.73 / 23 | 3.75 / 9.23 / 34.98 / 36 | 3.67 / 8.84 / 24.35 / 31 | 40・+4.46 / 42・+25.10 |

部分集合ごとの preset 3 本（fold 外、mean / p99 > 8 の件数）:

| 部分集合 | 条件 | niho-10 | B1 fold 外 | niho-10 比 mean 悪化 / p99 +2 以上 |
| --- | ---: | --- | --- | --- |
| 夜・暗い室内 | 69 | 2.52 / 10 | 2.75 / 15 | 48 / 8 |
| 明るい iPhone | 54 | 2.63 / 7 | 2.87 / 10 | 43 / 4 |
| その他（昼光） | 48 | 2.29 / 6 | 2.69 / 7 | 39 / 2 |

単独の h100 / s100 も同じ傾向（fold 外の mean / p99 > 8）: 夜・暗所 h100 1.37/6 → 1.97/9、s100 1.51/4 → 2.51/6、明るい iPhone h100 2.78/7 → 4.22/11、s100 2.29/9 → 3.18/13、昼光 h100 1.87/6 → 2.94/9、s100 1.71/6 → 2.31/10。

**gate 判定: 未達。** fold 外は中立 mean ≤ 2 を満たすが、colorful mean 3.04 > 3、preset の p99 > 8 が 32/171（18.7%）で全件 p99 ≤ 8 も JPEG gate の 15% 以下も満たさない。in-sample でも p99 > 8 は 32/171。夜・暗い室内・明るい iPhone の尾は niho-10 より減らず、昼光も悪化した。niho-10 は in-sample なので有利だが、NIHO6.md の niho-6 の撮影日 CV の見込み（bluesky2 / pastel / colorful の mean 2.26 / 2.88 / 2.69、p99 > 8 が 26/171）と fold 外どうしで比べても、B1（2.37 / 2.90 / 3.04、32/171）は悪い。

### 原因の切り分け（代理評価、mean / p99 > 8 の件数）

| | h100（57） | s100（57） | preset 計（171） |
| --- | --- | --- | --- |
| niho-10（この教師で学習済み） | 2.01 / 22 | 1.85 / 20 | 2.59 / 29 |
| 写真ごとの定数（in-sample の上限） | 1.73 / 12 | 1.57 / 9 | — |
| B1 全教師（in-sample） | 2.93 / 29 | 2.65 / 29 | 2.82 / 39 |
| B1 fold 外 | 2.98 / 30 | 2.68 / 29 | 2.85 / 38 |
| B0 未校正（2026-10-20 の anchor） | 3.19 / 40 | 2.54 / 26 | 2.77 / 45 |

1. **局所ラプラシアン（演算子）の表現力は足りる。** 写真ごとに振幅・shift・α を選べば、単独の H/S は niho-10 より Lightroom に近い（H 単独 3 設定の mean 1.17 対 1.34、S 単独 1.05 対 1.20）。
2. **足りないのは「平均 log 輝度・p90 の 2 統計 → 振幅/shift」の写像（原理式の表現力）。** 全 57 場面で当てはめた in-sample でも fold 外とほぼ同じで、写真ごとの定数との差が大きい。写真ごとの最適な Highlights 振幅と平均 log 輝度の相関は −0.61、shift（平均からの距離）は −0.26 で、p90 や明部の面積比を使っても相関は同程度だった。metadata で選んだ 6 場面の Lightroom の応答では、平均 log 輝度が −2.8〜−3.8 EV の 4 場面で、平均付近の明るさの H −100 による変化が −0.2 EV（カメラ）から −0.9 EV（明るい iPhone）まで分かれた（明るい iPhone は平均より 4 EV 暗い所も約 −0.6 EV 下がる）。NIHO6.md「原因」の「平均 log 輝度に対する明るさで決まる」は round3 の 8 場面では成り立ったが、57 場面には当てはまらない。
3. **教師の分布外が主因ではない。** fold 外と in-sample の差は gate で preset mean 0.03、p99 > 8 は同数で、B の誤差は教師の量・撮影日の偏りを増やしても減らない見込み。案A（夜・暗所・明るい iPhone の教師追加）は、学習した応答（niho-6/10）の尾を減らす手段としては残るが、この原理式 B を救う見込みは低い。
4. 有界残差（B2）は fold 外で効かない（代理評価で夜・暗所・明るい iPhone の preset p99 > 8 が B2 30 件、B1 29 件）。明部・暗部に一様な ±0.5 EV では写真ごとの違いを吸収できない。
5. 校正は尾を減らしたが平均を悪くした設定もある（代理評価、fold 外の B0 → B1: h100 の p99 > 8 が 40 → 30、preset 計 45 → 38、一方 colorful mean 2.86 → 3.08、h100s100 2.84 → 3.76）。目的関数が尾を重く見た結果で、重みの選び方で尾と平均の配分は動くが、2 の差（in-sample の B1 と写真ごとの定数）は埋まらない見込み（重みの比較はしていない）。

### 凍結した候補

- `analytic-hs-candidate.json`: B1 の 10 係数（残差 0）、`coefficientsSha256` `6127d3edbf0bf7c62779e10ed368764dc0313a2e7f8f03faa1f30816c53e76b3`。集計 JSON の係数は当てはめ側の表示で、正は manifest（JSON の読み書きで最下位桁が 1 違うことがある）。
- `analytic-hs-freeze.json`: source commit（crates は実行ファイルを作った commit と同一）、`analytic_hs_probe` / `analytic_hs_calibrate` の SHA-256（Studio の build。非公開の作業ディレクトリに同じ実行ファイルを保管）、評価 manifest（撮る場面・設定・描画・比較・gate・一度きりの規則）。
- 教師上で gate 未達のまま、owner 判断に従って凍結した。独立評価で合格する見込みは低い（教師の fold 外で preset p99 > 8 が 18.7%、colorful mean 3.04）。製品の既定・既存 engine の画素は変えていない。

### 独立評価の手順（owner の新しい撮影が届いてから 1 回だけ）

封印済みの既存 independent は使わない（開かない）。owner が新しく撮る。

1. 撮る場面: 夜（屋外の夜景・街灯、band dark = ISO > 640）、暗い室内（band dark）、明るい iPhone（iPhone・band bright = ISO ≤ 100、明るい窓や空を含む）を**各 8 場面以上**。教師（teachers / teachers2）と封印済み independent のどの撮影日とも重ならない別の撮影日、1 撮影日 1 場面。選ぶのは撮影日・機種・ISO の metadata だけで、画素を見て選ばない。入力の 90% 以上が白飛び（8bit で 250 以上）の場面は除外する（既存の決まり）。案A の教師を撮る場合も、独立評価と撮影日を重ねない。
2. Lightroom の書き出し: `make_lr_p3_jpeg.py` の 22 設定、少なくとも neutral＋preset 3 本（bluesky2 / pastel / colorful）。JPEG 100%・sRGB・フルサイズ・出力シャープ OFF・レンズ補正 OFF。置き方は教師と同じ（`manifest.json`、`inputs/<scene>__neutral.jpg`、`lr-export/<scene>__<variant>.jpg`）。写真と書き出しは公開しない。
3. 凍結の確認: `sourceCommit` と `executableBuildCommit` の crates / `Cargo.lock` が一致し、`sourceCommit` の colorcheck と、freeze に記録した評価スクリプトの SHA-256 が一致することを確認する。`analytic_hs_calibrate` と `analytic_hs_probe` は両方とも凍結記録の SHA-256 に一致するものを使う（`--calibrate` / `--probe` で非公開作業ディレクトリの実行ファイルを指定できる）。`analytic-hs-candidate.json` も file と係数の SHA-256 を照合し、どれかが違えば評価しない。
4. 実行は 1 回だけ: `python3 packages/develop-engine/tools/calibrate/fit_analytic_hs.py --repo <checkout> --work <新しい非公開ディレクトリ> holdout --cohort <新しい撮影> --freeze packages/develop-engine/fixtures/color/review-2026-10-21/analytic-hs-freeze.json --calibrate <保管した analytic_hs_calibrate> --probe <保管した analytic_hs_probe>`。必要な入力・書き出しを確認し、白飛び入力を除いた後に暗所・明るい iPhone・日中の各部分集合が最低 8 場面あることを検査する。不足時は `holdout-started.json` を作らず停止する。条件を満たした場合は、参照を読む前に同 marker を書き、2 回目を拒否する。2048px 描画（A=niho-10、B=候補）→ colorcheck 1500px・blur 2・平坦画素。中立 mean ≤ 2、preset mean ≤ 3、p99 ≤ 8（全件）と JPEG gate（p99 > 8 が 15% 以下）を全体と各部分集合で、niho-10 との対の悪化と一緒に報告する。結果JSONの `verdict` は全体を `all`、部分集合ごとの合否を `bySubset` に出す（`holdout-summary-sanitized.json`）。
5. 結果を見て係数・式・閾値・場面を変えない。不合格なら候補 B は採用せず、次の候補にはさらに別の独立評価が要る。

`holdout` は開発教師 1 枚・使い捨ての作業ディレクトリで動作を確かめただけで、独立評価は 0 回である。

### 再現（非公開の作業ディレクトリで）

```sh
cargo +1.98.1 build --release --locked --manifest-path packages/develop-engine/Cargo.toml \
  -p niho-develop --example analytic_hs_calibrate --example analytic_hs_probe
T=packages/develop-engine/tools/calibrate/fit_analytic_hs.py
python3 $T --repo . --work <private> plan
python3 $T --repo . --work <private> oracle
python3 $T --repo . --work <private> cv --folds dates
python3 $T --repo . --work <private> fit
python3 $T --repo . --work <private> gate --family B1
python3 $T --repo . --work <private> publish --family B1 --out <summary.json>
```

Studio（10 コア、他の計測と同時、`nice -n 10`・4 並列）で oracle 6 分、交差検証 1 時間 45 分、全件 fit 30 分、gate 57 分。残りは owner の撮影後の独立評価 1 回と、案A を選ぶ場合の教師の追加・比較。新しい engine 版としての採用は独立評価の合格が前提で、現時点では行わない。
