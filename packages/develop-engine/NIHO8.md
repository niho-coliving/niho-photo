# niho-8 float cube 評価候補

`niho-8` は Issue #29 の opt-in 評価候補であり、製品既定・新規編集・preset の既定ではない。crate の reader capability は保存済み `niho-8` を読めるが、`DevelopSettings::neutral()` と `new_edit()` は引き続き `niho-1` を作る。

## 数式と入力境界

- JPEG / PNG original と raster working copy: `niho-6` と同じ数式。H/S response、正の Blacks、Vibrance、HSL luminance、incremental WB LUT を変えない。
- legacy unsigned RAW working copy: `niho-2` と同じ数式。absolute WB と relative WB の意味を変えない。
- signed `signed-gamma18-v1`: 非対応として拒否する。`niho-3/4/5/7` の意味を流用しない。
- camera-linear: 非対応として拒否する。legacy working-copy RAW と同一視しない。

差は cube entry のみである。RAW の look + ACR3、全入力の cube P / cube Q を 8-bit に丸めず f32 で保持する。grid は Interactive 33³、Final 64³、index gamma は 1.8、適用は既存と同じ入力 clamp・trilinear interpolation・出力 decode を使う。既存 `niho-1`〜`niho-7` の bake 分岐、grid、出力 encode は変更しない。

## 公開測定

`examples/niho8_measure.rs` は次を一つの JSON に出す。

- 公開 golden input 4件すべてについて、同じ `niho-6` raster 数式からの changed pixel、平均／最大 code 差
- 入力8bit量子化のないlinear f32合成 1024-step sky / skin ramp（rasterとlegacy RAW） の隣接差 `>= 2`、同値隣接、最大隣接差
- 1024×64ランプのnative cold render時間（wasm性能gateとは区別）

Mac Studioでexact commitをpush後に実行する。2026-10-20の測定結果とsource commitは下記JSONへ記録した。

```sh
cargo +1.98.1 run --release --locked \
  --manifest-path packages/develop-engine/Cargo.toml \
  -p niho-develop --example niho8_measure \
  > /tmp/niho8-measure.json
```

公開 repository に Photo Bench / Lightroom の reference output は含まれない。そのため上の `publicFixtures` は「新出力同士の equality」ではなく、凍結済み `niho-6` を明示した差分測定だが、外部 reference に対する品質回帰ではない。Lightroom preset + WB と独立 teacher/holdout の gate が完了するまで promotion しない。

## 対象テスト

```sh
cargo +1.98.1 test --locked \
  --manifest-path packages/develop-engine/Cargo.toml \
  -p niho-develop --test niho8
```

既存版の互換確認は `niho6`、`niho7`、`golden`、`golden_raw` を別に実行する。非公開 reference が無い環境では ignored golden の品質結果を作らない。


wasmの性能確認は `tools/color-review-wasm-bench.cjs` を使う。固定1024×768の合成画像を生成し、同じ設定のniho-6/8についてcold/cached描画と編集中5フレームを記録する。Studio上のNode/wasm SIMDという実行環境を結果に明示し、ブラウザや利用端末の性能と同一視しない。

```sh
cargo +1.98.1 build --release --locked --target wasm32-unknown-unknown \
  --config packages/develop-engine/.cargo/config.toml \
  --manifest-path packages/develop-engine/Cargo.toml -p niho-develop-wasm
wasm-bindgen --target nodejs --out-dir /tmp/niho8-wasm \
  packages/develop-engine/target/wasm32-unknown-unknown/release/niho_develop_wasm.wasm
node packages/develop-engine/tools/color-review-wasm-bench.cjs /tmp/niho8-wasm/niho_develop_wasm.js
```


## 2026-10-20の計測

[float cube測定](fixtures/color/review-2026-10-20/float-cubes.json)では、linear f32の1024段ランプの隣接差≥2は、legacy RAWの空色が1→0、肌色は0→0。rasterの空・肌はともに0→0だった。この入力ではRAWの1件だけ改善し、rasterの段差減少を実証したとは言わない。公開golden inputとの差はJSONに残し、Photo Bench/Lightroomへの一致とは区別する。

[Studio/Node/wasm SIMD計測](fixtures/color/review-2026-10-20/wasm-performance.json)は合成1024×768・同一設定で、niho-8の編集中5フレームの最大65.2ms、初回drag後の確定描画448.9ms、解析込み最初のInteractive966.0msだった。継続編集100ms・確定1秒の目安はこの環境では維持したが、初回解析は100ms内に収まらない（niho-6も1148.3ms）。各engineは同一processで6→8の順に測るため、cold値を公平な速度比較や実ブラウザ全般の保証には使わない。

既存niho-6のFinalと候補niho-8のFinal/Interactive固定画素テストはnative/wasm両方で一致した。candidateでも保存されたengineの意味は固定する。今後WBや暗所H/Sの式を採用する場合は別engineとして追加し、niho-8の画素を後から変えない。
