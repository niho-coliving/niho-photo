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

Mac Studio で exact reviewed SHA を push 後に実行する（この文書を追加した worker では Cargo 実行を禁止しているため、数値は未記入であり合格主張もしない）。

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
