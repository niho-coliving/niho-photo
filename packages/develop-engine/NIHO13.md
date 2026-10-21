# niho-13 raster の相対 WB を先頭へ（#27）

`niho-13` は Issue #27 の engine で、JPEG / PNG の原本・raster 作業コピー・unsigned（旧）RAW 作業コピーの**新規編集の既定**である。[`niho-12`](NIHO12.md) の数式（raster は `niho-10`、旧 RAW は `niho-2`、色の cube は float）のまま、raster の相対 WB（`relativeTemperature` / `relativeTint`）を**出力の最後ではなく処理の先頭**で当てる。保存済みの `niho-1`〜`niho-12` の補正はその engine のまま描き、`niho-13` へ昇格させない。

## 数式と入力境界

raster（JPEG / PNG 原本と raster 作業コピー）の相対 WB は、`niho-2` 以来の測定（`calibration/jpeg-incremental-wb-v1.bin`。合成 17³ sRGB 色見本を Lightroom で書き出した差分）と同じ節点・補間・組の残差の差分を、入力の符号化 sRGB に float で足す（`crates/niho-develop/src/head_wb.rs`）。1 画素ごとに:

1. 入力を linear sRGB にした直後（原本はデコードした値、raster 作業コピーは linear ProPhoto → sRGB の行列の後）の各 channel を sRGB の OETF で符号化し、byte の尺度（0〜255）にする。負の値は符号を反転して同じ式、1 を超える値は同じ冪の式のまま延長する。
2. 差分 LUT を引く。座標は cube の範囲（0〜255）へ clamp し、節点は色見本の `round(i·255/16)`（15 / 16 byte の段）、段の中の位置を比、補間は cube と同じ三線形（`lut.rs` の lerp。wasm SIMD でも同じ bit）。差分は丸めずに足す。
3. 結果を `[min(e, 0), max(e, 255)]` に収める（`e` は 1 の値）。0〜255 の中の channel は 0〜255 に clip される（8bit の書き出しを測った試作と同じ）。範囲外の channel（広色域の P3 原本の負の値・1 を超える値）は自分のはみ出しを保ち、差分でそれ以上外へは押されない（内側へは動く）。値は端でも連続する。NaN の channel は 0 になる。
4. 1 の逆変換で linear へ戻す。raster 作業コピーは ProPhoto へ戻して持つ。

下流はすべて WB 済みの元画像を見る。`niho-6` の H/S 応答の解析と適用、局所階調（Highlights / Shadows / Texture / Clarity）の pass と統計、自動、色取得（`sampleColor`）、プリセットの見本、drag のフレーム。出力側の差分 LUT は当てない。WB だけでは出力変換（gamut 圧縮・highlight の肩）を有効にしない（WB 済みの有界の元画像は有界のまま）。

- 相対 WB が 0（または `asShot`）なら元画像に手を加えず、`niho-12` と同じ byte 列になる（`tests/niho13.rs`）。
- unsigned RAW 作業コピー: `niho-12` と同じ画素（`niho-2` の数式。相対 WB は `relative_wb.rs` の linear 行列のまま）。
- signed `signed-gamma18-v1` と camera-linear: 拒否（`niho-3/4/5/7/11` を使う）。
- XMP の読み書きは `niho-2`〜`niho-12` と同じ（`WhiteBalance="Custom"` と `IncrementalTemperature` / `IncrementalTint`）。

保存済み `niho-13` の画素は以後変えない。数式を変えるときは新しい engine を足す。

## Session と wasm の cache

WB を変えると元画像が変わるので、Session（native・wasm 共通）は次のように持つ。

- 元画像: デコードしたままの原本と、`niho-13` の WB 済みの元画像を別に持つ。WB 済みの元画像は相対 WB（温度・tint）を key にし、WB が変わると作り直す。そのとき、元画像から作った縮小・切り抜きの窓・統計・色ポイントの plane・`niho-6` の master を捨てる（cube と効果の plane は元画像によらないので残す）。
- `niho-6` の解析: 写真全体の特徴量と exposure ごとの係数を、相対 WB を key に持つ（WB 済みの写真全体から作る。プリセットの見本・自動の候補とも共有）。master の key には元画像の WB と解析の WB の両方を入れ、drag 中の解析で作った master を確定描画に使わない。
- 局所階調の pass: 読んだ元画像の WB を `source_key` に持ち、確定描画（Final）は同じ WB の pass しか使わない。
- 色ポイントの plane: key に設定の JSON（WB を含む）が入る。
- 色取得・自動・プリセットの見本: 色取得と自動は親の WB 済みの元画像を共有した別の Session で描き、見本は原本の縮小を自分のプリセットの WB で作り直す。親の次のフレームは変えない。

WB の drag（Interactive）だけは、直前のフレームの `niho-6` の解析と局所階調の pass を使い回し、`niho-6` の応答の gain（解析・量・大きさだけで決まり、画素によらない）も持ち続ける。drag の 1 コマで作り直すのは WB 済みの元画像と master だけになる。確定描画は常にその WB で balance した元画像の解析と pass を使う（drag 中に使い回したものは使わない）ので、確定の画素は one-shot の描画と同じ（`tests/niho13.rs` の `session_caches_follow_the_white_balance`）。

## 線形の色順応を採らなかった根拠

Issue #27 は当初、linear ProPhoto の Bradford / CAT16 の色順応を先頭に当てる案だった。公開 17³ 測定の 10 条件それぞれに、線形光の**制約の無い 3×3**（Bradford・CAT16・対角はすべてその特殊形）を当てはめても、Lightroom の書き出しとの差は単独 WB の合格線（平均 ΔE00 ≤ 0.5）に届かない（[公開測定](fixtures/color/review-2026-10-21/round27-linear-3x3.json)、`tools/calibrate/fit_linear_wb_3x3.py`）。

| 条件 | 最小二乗（linear） mean / p99 | 平均 ΔE00 を直接最小化 mean / p99 |
| --- | ---: | ---: |
| 温度 −80 | 10.55 / 24.95 | 6.83 / 18.78 |
| 温度 −30 | 4.11 / 9.55 | 2.75 / 10.70 |
| 温度 +30 | 4.35 / 9.87 | 2.77 / 9.49 |
| 温度 +80 | 8.70 / 21.41 | 5.55 / 17.23 |
| tint −50 | 3.22 / 9.50 | 1.89 / 7.73 |
| tint −20 | 1.05 / 3.29 | 0.67 / 2.81 |
| tint +20 | 0.84 / 2.83 | 0.57 / 2.61 |
| tint +50 | 2.65 / 8.46 | 1.72 / 7.37 |
| 温度 −30 + tint −20 | 3.39 / 7.36 | 2.34 / 10.18 |
| 温度 +30 + tint +20 | 4.12 / 8.78 | 2.65 / 8.79 |

Lightroom の JPEG の相対 WB は、白（255）を動かさず中間調を大きく持ち上げる（温度 +30 で灰 64 → (97, 82, 61)）非線形な処理で、線形の行列では表せない。owner は 2026-10-21 に、線形の色順応を不採用とし、測った変換を出力の最後から処理の先頭へ移すと決めた（Issue #27。判断時のメモの当てはめは ΔE00 平均 3.5〜9.8 で、上の表と同じく合格線に届かない）。単独 WB の精度は今の差分 LUT と同じ測定を使うので変わらない。

## Lightroom との比較（round27）

合成 17³ 色見本（4,913 パッチ、12px）に、相対 WB 5 通り（なし・温度 ±30・tint +20・温度 +30 と tint +20）× 編集 11 通り（なし・HSL・パラメトリックカーブ・カラーグレーディング・彩度 +40・自然な彩度 +40・コントラスト +40・露光量 +0.7・プリセット 3 本の画素ごとの設定）を埋め込み、Lightroom の書き出しと比べた（`tools/calibrate/make_lr_round27.py`、`round27_measure.py`。パッチ内側 6×6 の平均の CIEDE2000）。[公開測定](fixtures/color/review-2026-10-21/round27-niho-13.json)（全行）。

- `niho-12`: 今の出力側（同じ設定に WB を入れて描く）。
- `niho-13`: engine の先頭（同じ設定に WB を入れて描く）。
- 試作: 入力の符号化 sRGB に同じ差分を float で足して 16bit PNG にし、WB を 0 にした設定で描く。owner 判断の根拠は `niho-10` で描いた[試作の測定](fixtures/color/review-2026-10-21/round27-prototype-niho-10.json)（WB あり 44 組の mean の平均 2.77 → 1.99、mean 改善 38 組・p99 改善 36 組）。

| 組 | 件数 | mean の平均（niho-12 → niho-13） | p99 の平均 | p99 の最大 | niho-13 が良い（mean / p99） |
| --- | ---: | ---: | ---: | ---: | ---: |
| WB 単独 | 4 | 0.489 → 0.147 | 1.978 → 0.532 | 2.266 → 0.659 | 4 / 4 |
| WB + 編集 | 28 | 2.550 → 1.830 | 7.058 → 5.549 | 11.758 → 10.595 | 24 / 22 |
| プリセット + WB | 12 | 4.050 → 2.960 | 11.027 → 8.977 | 18.510 → 20.790 | 11 / 9 |
| WB ありの全体 | 44 | 2.772 → 1.985 | 7.679 → 6.028 | 18.510 → 20.790 | 39 / 35 |

例: 温度 −30 + 彩度 +40 は mean 4.08 → 1.63、温度 +30 + HSL は 3.39 → 1.04、温度 +30 + tint +20 + 自然な彩度は p99 7.16 → 3.09。

mean が悪化した 5 組はどれも +0.08 以下（温度 −30 + グレーディング 2.306 → 2.380 が最大）。p99 が悪化した 9 組:

| 組 | p99（niho-12 → niho-13） | 端のパッチの p99 | 内側の p99 |
| --- | ---: | ---: | ---: |
| 温度 +30 + グレーディング | 6.22 → 6.50 | 6.17 → 6.34 | 6.36 → 6.54 |
| tint +20 + HSL | 7.78 → 8.04 | 9.18 → 9.93 | 5.31 → 5.95 |
| tint +20 + 彩度 | 6.07 → 6.56 | 7.62 → 8.24 | 4.63 → 5.06 |
| tint +20 + 自然な彩度 | 4.32 → 5.22 | 4.83 → 5.68 | 3.46 → 3.35 |
| tint +20 + コントラスト | 4.33 → 5.04 | 5.12 → 5.62 | 3.27 → 2.93 |
| tint +20 + 露光量 | 4.00 → 4.04 | 4.33 → 4.30 | 3.63 → 3.86 |
| 温度 −30 + bluesky2 | 18.51 → 20.79 | 22.73 → 25.20 | 15.08 → 16.02 |
| tint +20 + bluesky2 | 10.91 → 10.95 | 13.00 → 13.82 | 8.47 → 7.84 |
| tint +20 + colorful | 7.57 → 7.99 | 7.77 → 8.20 | 7.33 → 7.62 |

「端のパッチ」は channel のどれかが 0 か 255 の 1,538 パッチ。

### 端の飽和色の限界

p99 の悪化は端の飽和色（純青・純緑付近）に集まる。悪化した組の最悪 50 パッチのうち端のパッチは 6〜10 割（温度 +30 + グレーディングだけ 2 割）で、内側のパッチだけの p99 は 44 組中 37 組で改善する。端は WB 無しでも、プリセットの HSL などの再現自体が Lightroom から大きくずれている（WB 無しのプリセット 3 本で端のパッチの p99 は 7.4〜11.5、最大 17.8）。測定は 8bit の書き出しで端を clip されているため、色見本の外側（もっと飽和した色）の情報が無く、WB を先頭に当てて飽和色が端へ寄ると、その先の数式の誤差がそのまま出る。プリセット + WB の 12 組で p99 が悪化したのは 3 組（温度 −30 + bluesky2 18.5 → 20.8、tint +20 + colorful 7.6 → 8.0、tint +20 + bluesky2 10.91 → 10.95）。この限界は WB の配置ではなく、端の HSL・プリセットの再現と測定範囲の問題として残す。

### 試作との一致

`niho-13` は試作をほぼ再現する。試作の入力を Pillow ではなく NIHO 自身の JPEG デコード（`--head-source engine`）から作ると、44 組の WB ありのパッチ 216,172 個のうち 1,012 個（0.47%）が 1 channel だけ 1 code 違い、2 code 以上の差は 0。違いは試作の 16bit PNG の量子化（8bit で 0.004 code）が 0.5 の丸めの境をまたいだ所だけで、Lightroom との差は mean の平均で同じ 1.985（p99 の平均 6.028 と 6.028）。Pillow のデコードから作ると JPEG デコーダーの違いが加わり、パッチ平均の差は平均 0.0016、最大 1.12。

## 開発用教師 57 場面

[匿名集計](fixtures/color/review-2026-10-21/round27-teacher-development.json)。既存の教師（33 + 24 場面、白紙 2 枚を除外）の中立と 3 プリセットは相対 WB を持たないので、`niho-13` は 228 組すべてで `niho-12` と同じ byte 列を描いた（描画 PNG の SHA-256 が一致）。教師の数値は [NIHO12.md](NIHO12.md) から変わらない。sealed の独立 cohort は開いていない。

## 旧 engine の不変

`niho-1`〜`niho-12` の画素は変えていない。base（`828bbae`）と同じ合成入力で、11 engine × raster・raster 作業コピー・旧 RAW・signed RAW × 12 設定（WB・WB + 編集・切り抜き + WB・効果・プリセット + WB を含む）× Interactive・Final・縮小 Interactive の描画、raster の one-shot と色取得の 1,848 行（描けない組のエラーを含む）を native で比べ、すべて一致した。`niho-6` の応答の適用は gain の計算と掛け算に分けたが、同じ演算順の同じ値。

## wasm 性能

[Studio/Node/wasm SIMD 計測](fixtures/color/review-2026-10-21/round27-wasm-performance.json)。合成の写真（1024×768 と、画面のプレビューの長辺の 1280×960）、Highlights −75・Shadows +55 などの同じ設定で、コントラストの drag の後に相対の色温度を 5 コマ drag して確定する。`niho-12` と `niho-13` の順を入れ替えた 6 process の中央値（測定中の host の load average は 9〜28）。

| 大きさ | engine | コントラストの drag 最大 | WB の drag 1 コマ（中央値 / 最大） | WB の確定 Final |
| --- | --- | ---: | ---: | ---: |
| 1024×768 | niho-12 | 107.7ms | 51.1 / 52.8ms | 643.9ms |
| 1024×768 | niho-13 | 106.9ms | 69.3 / 74.1ms | 1594.2ms |
| 1280×960 | niho-12 | 124.6ms | 79.3 / 82.3ms | 728.0ms |
| 1280×960 | niho-13 | 124.2ms | 106.3 / 113.2ms | 1754.4ms |

- WB の drag の 1 コマは、WB 済みの元画像と `niho-6` の master を作り直す分だけ `niho-12`（出力側の LUT）より遅い。1280×960 で目安の 100ms をわずかに超えるが、同じ写真のコントラストの drag（124ms）より速い。局所階調の pass と応答の gain を drag 中に使い回す前・差分の参照を cube の lerp にする前は、1280×960 で 150ms 前後（負荷の高い時間帯の計測）だった。
- WB の確定は、WB 済みの写真全体から `niho-6` の H/S 応答を解析し直す（特徴量と network）ので 1.6〜1.8 秒かかり、目安の 1 秒を超える。この設定は H/S 応答を使う（Highlights < 0 / Shadows > 0）。H/S 応答を使わない設定には解析が無く、確定は `niho-12` と同じ程度。露光量の drag の確定も同じ network を回し直す（特徴量は回さない）ので、WB の確定はそれより特徴量の分だけ長い。確定の画素を変えずに短くするには解析そのものの高速化が要り、この Issue の範囲外とする。
- 旧 RAW の作業コピーは `niho-12` と同じ画素で、時間も同じ（[計測](fixtures/color/review-2026-10-21/round27-wasm-performance.json)の `legacyRaw`）。

## 既定と互換

- crate: `ENGINE_VERSION` は `niho-13`（reader capability）、workspace は 0.20.0。`DevelopSettings::neutral()` / `new_edit()` は互換の既定（`niho-1`）のまま。
- 画面（`packages/photo-editing` の `develop-settings.ts`）: `DEVELOP_SETTINGS_ENGINE` は `niho-13`、保存済みの `niho-12` は `NIHO12_DEVELOP_SETTINGS_ENGINE`。直接描く JPEG / PNG、`raster.*`、unsigned の `raw-apple.*` の未保存の写真は `niho-13` で開く。作業コピーの無い RAW と版の分からない作業コピーは `niho-2`、signed RAW の既定（`niho-3` / `niho-11`）は変えない。
- 保存済みの `niho-2` / `niho-6` / `niho-10` / `niho-12` は、開く・プリセット・初期化・貼り付けで `niho-13` に変えない（Rust の XMP 経路も同じ）。既定の切替前に作った未保存 draft（`niho-2` / `niho-6` / `niho-10` / `niho-12`）はその数式のまま戻す。
- NIHO Desktop の原寸書き出しで未編集の写真には、従来どおり `niho-2` の neutral を渡す（neutral は相対 WB が 0 なので raster は同じ画）。
- 画面の wasm は `/develop-engine/niho-13/manifest-0.20.0.json` を読む。`niho-13` の補正を描く非公開側（ワーカー・Web の配備）は、この版の固定 SHA を取り込んでから画面を配る（#2）。

## 再現手順

exact commit を push した後に Mac Studio で実行する。Lightroom の書き出し・教師の写真・行ごとの結果は repository の外の作業ディレクトリに置き、合成チャートの測定と匿名集計だけを公開する。

```sh
cargo +1.98.1 build --release --locked --manifest-path packages/develop-engine/Cargo.toml -p niho-develop-render --bins
cargo +1.98.1 build --release --locked --manifest-path packages/develop-engine/Cargo.toml -p niho-develop --example round27_settings --example render_rgba

# 線形 3×3 の当てはめ（公開測定だけを読む）
python3 packages/develop-engine/tools/calibrate/fit_linear_wb_3x3.py --repo . --out round27-linear-3x3.json

# round27（<round27> は make_lr_round27.py の出力と Lightroom の書き出し lr-export/）
python3 packages/develop-engine/tools/calibrate/round27_measure.py --round <round27> --repo . \
  --engine niho-13 --tail-engine niho-12 --head-source engine --out <work> --summary round27-niho-13.json

# 開発用教師（<work>/data/teachers と teachers2）
python3 packages/develop-engine/tools/color-review-teachers.py --repo . --work <work> --engines niho-12,niho-13 --workers 6

cargo +1.98.1 build --release --locked --target wasm32-unknown-unknown \
  --config packages/develop-engine/.cargo/config.toml \
  --manifest-path packages/develop-engine/Cargo.toml -p niho-develop-wasm
wasm-bindgen --target nodejs --out-dir <wasm-out> \
  packages/develop-engine/target/wasm32-unknown-unknown/release/niho_develop_wasm.wasm
node packages/develop-engine/tools/color-review-wasm-bench.cjs <wasm-out>/niho_develop_wasm.js niho-12,niho-13 niho-12,niho-13 1280x960
```

## 対象テスト

```sh
cargo +1.98.1 test --locked --manifest-path packages/develop-engine/Cargo.toml -p niho-develop \
  --test niho13 --test niho12 --test niho6 --test niho6_cross_target --lib
CARGO_TARGET_WASM32_UNKNOWN_UNKNOWN_RUNNER=wasm-bindgen-test-runner cargo +1.98.1 test --locked \
  --config packages/develop-engine/.cargo/config.toml --manifest-path packages/develop-engine/Cargo.toml \
  --target wasm32-unknown-unknown -p niho-develop --test niho6_cross_target
npm -C packages/photo-editing test
```

`tests/niho13.rs` は WB が 0 のときの `niho-12` との byte 一致（raster・raster 作業コピー・旧 RAW、切り抜き、Interactive / Final、色取得・自動）、WB 済みの元画像を `niho-12` で描いた画との一致、Session の cache（drag の後の確定・WB を 0 に戻す・プリセットの見本・色取得・自動・色ポイントの plane）、範囲外の入力、旧 RAW・signed・camera-linear、プリセットと XMP を検査する。`head_wb.rs` の単体テストは節点・変換の往復・範囲外の扱いを、`niho6_cross_target` は WB あり・なしの raster と旧 RAW の Final / Interactive の固定画素を native と wasm の両方で検査する。
