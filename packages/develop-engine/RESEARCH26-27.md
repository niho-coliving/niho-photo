# Issue #26 / #27 公開研究経路

どちらも production renderer から隔離した候補である。`niho-8` や既存 engine の既定には接続せず、private Lightroom reference や独立 holdout の合格を主張しない。

## #27 linear ProPhoto JPEG WB

`research::linear_jpeg_wb` は input linear ProPhoto D50 上で Bradford XYZ adaptation を評価する。既存 `color.rs` の `xy_from_temperature`、`bradford_xyz`、ProPhoto D50 matrix を使い、production の `jpeg_wb` LUT は変更しない。Core Image `relative_wb` の `30 K / 0.5 tint` scale は使わない。

fit が読むのは公開 `calibration/jpeg-incremental-wb-v1.bin` の axis 8 variant（temperature ±30/±80、tint ±20/±50）だけである。slider temperature は5000K周りのmired差、tintはDNG tintへ写し、測定済みの各非ゼロ節点を別々にfitする。mired差は−160..160、tintは−150..150の有限範囲でcoarse bracket＋golden-sectionを使い、節点間は線形補間する。ゼロは厳密な恒等とする。 `wb_cool` / `wb_warm` の2 variant は optimizer から隠し、fit 凍結後の validation で初めて読む。

別 pass の validation は全10 variantについて 17³ node の measured chart に対する CIEDE2000 mean / p99 を JSON に出し、全 variant のそれぞれの mean `<= 0.5` を真偽値で示す。これは同じ公開 chart 内の calibration/validation であり、独立写真の Lightroom gate ではない。

```sh
cargo +1.98.1 run --release --locked \
  --manifest-path packages/develop-engine/Cargo.toml \
  -p niho-develop --example linear_jpeg_wb_fit \
  > /tmp/linear-jpeg-wb-fit.json
```

2026-10-20、Studioで固定Rust 1.98.1のfitを実行した。[公開chartの測定結果](fixtures/color/review-2026-10-20/linear-jpeg-wb.json)は全10条件meanΔE00=6.3315、fit未使用の2複合条件mean=5.2123で、各条件mean≤0.5のgateに未達だった。このBradford候補は採用しない。表示色の測定結果であり、方式一般の不可能性を示すものではない。

Studio 結果で `validationAllTen.meanGateMet` が false なら候補は calibration gate 不合格、true でも preset + WB の独立 Lightroom reference が無いため production へ入れない。

## #26 analytic image-adaptive H/S candidate B

`research::analytic_hs` は全体を長辺最大750へ area reduction し、linear ProPhoto の mean log luminance と p90 log luminanceを測る。露出を統計と画素の判定へ明示的に加え、negative Highlights と positive Shadows の gain を有限範囲（−4..+3 EV）に制限する。既存 `spatial.rs` の局所ラプラシアンに、平均log輝度・p90で決まる振幅とshiftを渡し、得られたEV差に有界残差を加える。係数・anchorは未校正の研究パラメータであり、改善の根拠にはしない。neutral RGB にはscalar gainだけを掛ける。

learned residual は optional で、module 自身には training/tuning を実装しない。受理する frozen manifest は係数3個ずつ、`maxResidualEV <= 0.5`、canonical coefficient SHA-256 一致を必須とする。manifest を省略すると residual は厳密に0で、残差は未凍結として記録される。残差だけの凍結を候補全体の凍結と同一視せず、candidateFrozenはfalseのまま、実行ファイルSHAを併記する。独立評価の前にexact source commit・実行ファイル・係数・評価manifestを固定する。独立 holdout を見てから係数・式・閾値を変えてはならない。

probe は A=`niho-6`、B=analytic H/S 後に残りの同じ `niho-6` stages を描き、PNG 2枚と input/settings/output hash、解析値、timing、gate contract を `manifest.json` に書く。

```sh
cargo +1.98.1 run --release --locked \
  --manifest-path packages/develop-engine/Cargo.toml \
  -p niho-develop --example analytic_hs_probe -- \
  /path/to/input.jpg /path/to/settings.json /tmp/analytic-hs \
  /path/to/frozen-residual.json
```

private-reference owner は長辺1500、blur 2、flat pixel の同じ評価で neutral mean `<=2`、preset mean `<=3`、p99 `<=8` を比較する。probe は reference を受け取らないため `gateResult` を常に null にし、結果を発明しない。dark/night/bright-window の合成 unit test は finite、gain bounds、neutral、zero no-op、exposure awareness だけを検査し、画質改善は主張しない。

未完了の外部依存は次のとおり。

- 開発教師上での振幅/shift・残差の校正、および案Aを選ぶ場合のownerによる追加教師の撮影・書き出し
- frozen candidate を開く前の manifest/hash 記録
- candidate 凍結後、一度だけの独立 holdout 評価
- preset 3本と WB を含む gate 判定

WB測定は、順応したlinear ProPhotoをlinear sRGBへ戻しclipと8bit符号化を通した表示色を比較するmatrix単体の測定である。負値や範囲外のlinear値を、clip済み参照へ直接比べない。完全な処理順・presetとの相互作用を検証した結果とは扱わない。CIEDE2000は[Sharma/Wu/Dalalの実装検証資料](https://hajim.rochester.edu/ece/sites/gsharma/ciede2000/)の代表的数値例で確認する。


調整用の既存教師データは `tools/color-review-teachers.py --repo <checkout> --work <private-directory>` で比較する。private-directory の `data/teachers` と `data/teachers2` に従来のmanifest・inputs・lr-exportを置く。出力先がrepository内なら拒否し、sealed manifestも拒否する。niho-6/8は全教師のneutral＋3 presetを比較し、原理式Bは各cohortのISO最小・中央値・最大というmetadataだけの部分集合で開発時の失敗を調べる。白紙除外は従来の90%以上clip条件のまま。Bの部分集合の平均を全教師平均と比較せず、同じscene/variantの対で差を確認する。

全入力hash・scene名・画像は非公開出力内に残す。公開するのは `teacher-summary-sanitized.json` の匿名集計、exact commit、renderer hash、測定手順だけである。このツールは独立評価を実行せず、既存164条件・夜24・独立20やRAWの最終gateを完了扱いにしない。


## 2026-10-20の候補B開発比較

[匿名数値](fixtures/color/review-2026-10-20/teacher-development.json)は教師cohortごとのISO最小・中央値・最大というmetadataだけで決めた6場面（24条件）を現行niho-6と対で比較したもの。独立評価の画像は0枚。

| 候補B・6場面 | mean ΔE00 | p99最大 |
| --- | ---: | ---: |
| 中立 | 0.3390 | 1.6171 |
| bluesky2 | 2.5425 | 10.3584 |
| pastel | 3.1935 | 8.6451 |
| colorful | 3.2966 | 12.5389 |

preset mean≤3・p99≤8のgateに未達。同じscene/variantのniho-6比でも最大mean悪化1.4369・p99悪化2.9563があるため、この未校正の原理式を採用しない。教師上で振幅/shift・残差を校正するか、owner側の追加教師案Aを比較する必要がある。これは独立評価の前段階での未達判定であり、教師上で次候補を作り直す段階である。独立評価には進めていない。
