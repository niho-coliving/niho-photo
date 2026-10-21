# niho-12 raster・旧 RAW の float cube（#29）

`niho-12` は Issue #29 の engine で、JPEG / PNG の原本・raster 作業コピー・unsigned（旧）RAW 作業コピーの**新規編集の既定**である。保存済みの `niho-1`〜`niho-11` の補正はその engine のまま描き、`niho-12` へ昇格させない。評価候補の [`niho-8`](NIHO8.md) と同じく cube の精度だけを変え、raster の土台を `niho-6` から現行の `niho-10` に替えた。

## 数式と入力境界

- JPEG / PNG 原本と raster 作業コピー: `niho-10` と同じ数式（`niho-6` の H/S 応答、RAW の Vibrance・HSL 輝度・正の Blacks、Oklch の色相保持の彩度、増分 WB の LUT）。
- unsigned RAW 作業コピー（`raw-apple.*` の p0〜2 / e1）: `niho-2` と同じ数式（`niho-8` の RAW 経路と同じ画素。色相保持は当てない）。絶対 WB と相対 WB の意味も変えない。
- signed `signed-gamma18-v1`: 拒否（`niho-3/4/5/7/11` を使う）。
- camera-linear: 拒否。

差は cube の項目だけである。RAW の look + ACR3、全入力の cube P / Q を 8bit に丸めず f32 で持つ。格子は Interactive 33³・Final 64³、index は gamma 1.8、入力の clamp・三線形補間・出力の decode は既存と同じ。`niho-10` の raster の Q は #62 で既に f32 なので、raster で新たに f32 になるのは P だけ。Q だけを動かす設定（彩度・Vibrance・HSL・Color Grading・Calibration）と P を使わない設定（H/S のみ・Texture/Clarity・相対 WB・neutral）は `niho-10` と同じ byte 列になる（`tests/niho12.rs` と下の公開測定）。

保存済み `niho-12` の画素は以後変えない。数式や精度を変えるときは新しい engine を足す。

## 既定と互換

- crate: `ENGINE_VERSION` は `niho-12`（reader capability）、workspace は 0.19.0。`DevelopSettings::neutral()` / `new_edit()` は互換の既定（`niho-1`）のまま。
- 画面（`packages/photo-editing` の `develop-settings.ts`）: `DEVELOP_SETTINGS_ENGINE` は `niho-12`。直接描く JPEG / PNG、`raster.*`、unsigned の `raw-apple.*` の未保存の写真は `niho-12` で開く。作業コピーの無い RAW（`raw: true`）と版の分からない作業コピーは、signed になるか・描ける入力か決まる前なので `niho-2` のまま。signed RAW の既定（`niho-3` / `niho-11`）は変えない。
- 保存済みの `niho-2` / `niho-6` / `niho-10` は、開く・プリセット・初期化・貼り付けで `niho-12` に変えない（Rust の XMP 経路も同じ）。既定の切替前に作った未保存 draft（`niho-2` / `niho-6` / `niho-10`）はその数式のまま戻す。
- NIHO Desktop の原寸書き出しで未編集の写真には、従来どおり `niho-2` の neutral を渡す（`niho-12` を知らない native でも描ける）。raster の neutral は cube を通らないので同じ画、unsigned RAW は look + ACR3 の 8bit 丸めの分だけ違う。
- 画面の wasm は `/develop-engine/niho-12/manifest-0.19.0.json` を読む。`niho-12` の補正を描く非公開側（ワーカー・Web の配備）は、この版の固定 SHA を取り込んでから画面を配る（#2）。

## 2026-10-21 の計測（Mac Studio）

### 開発用教師 57 場面

[匿名集計](fixtures/color/review-2026-10-21/teacher-development.json)。33 + 24 場面（白紙 2 枚を除外）、2048px で描画 → 1500px・blur 2・平坦画素・位置合わせ。既存モデルの調整に使った教師で、独立評価ではない（sealed の独立 cohort は開いていない）。

| 設定 | mean（niho-10 → niho-12） | p99 平均 | p99 最大 | p99 > 8 |
| --- | ---: | ---: | ---: | ---: |
| 中立 | 0.2598 → 0.2598 | 0.9207 → 0.9207 | 2.2148 → 2.2148 | 0 → 0 |
| bluesky2 | 2.1109 → 2.0976 | 4.8796 → 4.8729 | 9.9180 → 10.0498 | 4 → 4 |
| pastel | 2.7762 → 2.7773 | 6.2180 → 6.2172 | 9.5655 → 9.5830 | 5 → 5 |
| colorful | 2.5790 → 2.5397 | 6.3946 → 6.3731 | 13.6148 → 13.6177 | 14 → 13 |

228 組（中立 57 + preset 171）のうち mean 悪化は 66 組（+0.02 超は 14 組）、p99 悪化は 74 組（+0.02 超は 29 組）。最大増加は mean +0.2911、p99 +0.1318、最大改善は mean −0.4753、p99 −0.5017。mean が 0.5 以上増えた組は 0、新たに p99 > 8 になった組も 0。

合格の基準（preset ごとの平均 mean と p99 平均が `niho-10` から +0.02 を超えて悪化しない・各組の mean 増加が 0.5 未満・p99 > 8 の件数が増えない）はすべて満たした。pastel の平均 mean +0.0011 は丸めの雑音の範囲。p99 最大は bluesky2 で +0.13 増えたが、件数（p99 > 8）は増えていない。

最大の mean 悪化（pastel の 1 組、+0.29）は、画素の 98% が 40 code 未満の暗い場面で、`niho-12` の B が平均 +0.8 code ほど一方向に動いた。暗部では P の 8bit 格子（gamma 1.8）の丸めが場面ごとに一方向へ偏っており、f32 化でその偏りが消える。応答と正の Blacks は 8bit の P で fit したので、Lightroom から遠ざかる場面と近づく場面（最大 −0.475）が両方ある。基準内なので数式は変えない。

### 公開 golden 入力

[公開測定](fixtures/color/review-2026-10-21/niho12-public-measurement.json)の `publicFixtures`。4 入力 × `scripts/golden/cases.json` の 10 ケースを同じ設定の `niho-10` と比べた差分で、Photo Bench / Lightroom の reference への一致ではない（公開 repository に reference は無い）。

- 40 組のうち 20 組は byte 一致（neutral・spatial-hs・spatial-texture-clarity・color・relative-wb。P を使わない）。
- 変わった写真の組は平均 code 差 0.24 以下。写真 3 枚 × 10 ケースの 2,880 万画素のうち 1 code を超えて変わったのは 101,274 画素（0.35%）、3 code 以上は 8,830 画素（0.031%）、最大 12 code（最も飽和した青の画素）。
- 合成の `saturated-blue.png`（sRGB 外の色）は平均 0.43・最大 29 code。gamut 外の出力処理で差が拡大する。

### 階調（README「忠実度」）

入力 8bit 量子化の無い linear f32 の 1024 段ランプ（空・肌の 2 色の線形補間）を、中庸の設定と bluesky2 / pastel / colorful の 4 設定で描いた出力 8bit の隣接差 2 以上の数（channel ごとに数えた合計）:

| 経路 | Final | Interactive |
| --- | ---: | ---: |
| raster（niho-10 → niho-12） | 2 → 0 | 0 → 0 |
| 旧 RAW（niho-2 → niho-12） | 12 → 5 | 7 → 5 |

`niho-12` に残る段差はすべてランプの暗端 11 画素以内（x ≤ 10 / 1024）にある。同じ補間を 4096 段にすると、どの engine も 0 件になる。

### wasm 性能

[Studio/Node/wasm SIMD 計測](fixtures/color/review-2026-10-21/wasm-performance.json)。合成 1024×768、同一設定、baseline と `niho-12` の順を入れ替えた 6 process の中央値。測定中は別の処理が host を使っていた（load average 7〜17）。

| 入力 | engine | 編集中 5 フレームの最大 | 初回 Final | drag 後の確定 Final |
| --- | --- | ---: | ---: | ---: |
| raster | niho-10 | 104.9ms | 733.4ms | 621.6ms |
| raster | niho-12 | 104.9ms | 725.8ms | 609.0ms |
| 旧 RAW | niho-2 | 68.5ms | 748.4ms | 764.7ms |
| 旧 RAW | niho-12 | 76.3ms | 797.3ms | 808.8ms |

確定 1 秒はどの経路も守る。drag 中は cube を焼かず 33³ の節点で P / Q を関数のまま評価するので、raster の `niho-12` は `niho-10` と同じ速さになる。raster の編集中は `niho-10` と同じく目安の 100ms をわずかに超える。同じ測定の `niho-6` は 75.2ms で、差の約 30ms は `niho-10` の色相保持の色段にかかる時間（`niho-12` は増やさない）。旧 RAW の編集中は 100ms 内。

## 再現手順

exact commit を push した後に Mac Studio で実行する。教師の写真・Lightroom の書き出し・行ごとの結果は repository の外の作業ディレクトリに置き、匿名集計だけを公開する。

```sh
cargo +1.98.1 build --release --locked --manifest-path packages/develop-engine/Cargo.toml -p niho-develop-render --bins
cargo +1.98.1 build --release --locked --manifest-path packages/develop-engine/Cargo.toml -p niho-develop --example render_rgba
# <work>/data/teachers と <work>/data/teachers2 に既存の教師（manifest / inputs / lr-export）を置く
python3 packages/develop-engine/tools/color-review-teachers.py --repo . --work <work> --engines niho-10,niho-12 --workers 6

cargo +1.98.1 run --release --locked --manifest-path packages/develop-engine/Cargo.toml \
  -p niho-develop --example niho12_measure > niho12-measure.json

cargo +1.98.1 build --release --locked --target wasm32-unknown-unknown \
  --config packages/develop-engine/.cargo/config.toml \
  --manifest-path packages/develop-engine/Cargo.toml -p niho-develop-wasm
wasm-bindgen --target nodejs --out-dir <wasm-out> \
  packages/develop-engine/target/wasm32-unknown-unknown/release/niho_develop_wasm.wasm
node packages/develop-engine/tools/color-review-wasm-bench.cjs <wasm-out>/niho_develop_wasm.js niho-10,niho-12 niho-2,niho-12
```

最初の engine が比較の基準になる。作業ディレクトリの `teacher-summary-sanitized.json` の `comparisons[].byVariant` が preset ごとの判定値を持ち、公開 JSON の `gate` はそこへ上の基準を当てた結果である。

## 対象テスト

```sh
cargo +1.98.1 test --locked --manifest-path packages/develop-engine/Cargo.toml -p niho-develop \
  --test niho12 --test niho8 --test niho6 --test niho7 --test pipeline --test niho6_cross_target
CARGO_TARGET_WASM32_UNKNOWN_UNKNOWN_RUNNER=wasm-bindgen-test-runner cargo +1.98.1 test --locked \
  --config packages/develop-engine/.cargo/config.toml --manifest-path packages/develop-engine/Cargo.toml \
  --target wasm32-unknown-unknown -p niho-develop --test niho6_cross_target
npm -C packages/photo-editing test
```

`niho6_cross_target` は `niho-12` の raster と旧 RAW の Final / Interactive の固定画素を native と wasm の両方で検査する。旧 engine の不変は既存の固定画素テストと、`d99b684` の build との 888 描画（`niho-1`〜`niho-11` × raster・旧 RAW・signed RAW × 12 設定 × Final / Interactive）の byte 比較で確かめた。`golden` / `golden_raw` の Photo Bench 比較は非公開の reference が要るので、この環境では ignored のまま。
