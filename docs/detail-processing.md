# ディテール（シャープ・ノイズ軽減。developSettings v5）

Issue #32。Lightroom のディテール（シャープ・輝度のノイズ軽減・カラーノイズの軽減）を段 2 に足し、JPEG / PNG と RAW のどちらでも描く。XMP の取り込みで「使えない項目」として知らせていたシャープ・ノイズ軽減は、近い式で描く項目（`approximate`）になる。色のパイプラインは変えない。

## 保存形

`developSettings.detail` が存在する設定は `v: 5` とする。形は次の exact object で、未知キー、欠落、非有限値、範囲外を Rust と TypeScript の両方で拒否する。

```json
{
  "sharpening": { "amount": 0, "radius": 1, "detail": 25, "masking": 0 },
  "luminanceNoiseReduction": 0
}
```

- `sharpening.amount` 0〜150、`radius` 0.5〜3.0、`detail` 0〜100、`masking` 0〜100、`luminanceNoiseReduction` 0〜100。
- `colorNoiseReduction`（0〜100）は任意。省略は signed RAW の旧 top-level `colorNoiseReduction`（R209、上限 50）を保ち、明示値は 0 を含めてそれを上書きする。JPEG / PNG・旧（unsigned）RAW は旧 top-level 値を引き続き無視し、v5 内で明示された値だけを使う。従って RAW でも raster でもカラー NR は一回だけ。
- 画面はすべてが既定（シャープ 0・半径 1・ディテール 25・マスク 0・ノイズ軽減 0・カラーの明示なし）に戻ったら `detail` ごと消す。ディテールを使っていない写真は v5 にならない。

## 処理順

immutable float source → カラー NR → edge-preserving 輝度 NR → canonical RAW H/S 解析または NIHO raster 解析 → WB / 露光 → 局所階調 → look / tone / color / color points / grading → output-resolution linear-sRGB luma sharpening → output transform → vignette の output 段・grain → RGBA8。NR 済み source を canonical 解析、local statistics、通常 render、`sampleColor` で共有する。シャープは RGBA8 を decode せず float 出力境界で行い、grain 等の output effect を再適用しない。

NR は linear ProPhoto でカラーを処理する（JPEG / PNG は往復行列変換）。輝度 guided filter と USM の radius は 1500px の whole-image long edge 基準で拡縮する（局所処理と同じ規則。Lightroom の「原寸の画素」単位ではない）。crop は同じ whole-image scale と geometry window の halo を使うため、境界で radius や見た目を変えない（合成チャートで crop と全体の切り出しの差は 1 LSB 以内）。amount 0 は演算を通らず既存 pixel 経路を保持する。

入力ごとの経路:

| 入力 | 数式（engine） | NR の場所 |
| --- | --- | --- |
| JPEG / PNG オリジナル | niho-1 / 2 / 6 / 8 / 10 | `render_linear` の先頭（linear sRGB） |
| raster 作業コピー（HEIC / TIFF / 大きな PNG） | 同上 | `render_linear` の先頭（linear ProPhoto） |
| 旧 RAW 作業コピー（unsigned） | niho-1 / 2 / 8 | `render_raw` の前（linear ProPhoto。この Issue で追加） |
| signed RAW 作業コピー | niho-3 / 4 / 5 / 7 / 11 | canonical master の準備（`niho3.rs` / `niho4.rs`） |

Session の再利用単位は immutable source、NR 量、working size、geometry window、quality。量・サイズ・geometry・Interactive / Final の変更で一致しない cache を再利用しない。RAW の canonical response / statistics cache も effective CNR と輝度 NR 量を key に含める。

明示 v5 カラー NR の 0〜50 は R209 と同じ。50 を超える範囲では同じ guided filter の正則化を連続的に強め、100 で 50 時の 4 倍とする（複数の NR 段を重ねる方式ではない）。輝度に沿った正則化なので、輝度が完全に平らな色ノイズでは 50 と 100 が同じになり、センサーのように各チャンネルに独立なノイズで差が出る。旧 top-level は従来通り 50 で飽和する。新しい 50〜100 の範囲は NIHO の設計値で、Lightroom への一致を校正済みとは主張しない。

### drag と final

Interactive（つまみを動かしている間）はシャープを省き、Final（離した後・書き出し）は float plane から必ず確定する（Issue の「drag は final だけ」）。crate は NR を Interactive でも描く（RAW などの作業コピーで drag 中に NR を描き直さないのは画面側の送り方。下の「プレビューへの送り方」）。合成チャートの全入力で、Interactive のシャープあり / なしが同じ画素になり、Final でエッジの鋭さが上がることをテストで固定する（`tests/detail_effect.rs`）。

## XMP（Lightroom のディテール）

読み（`src/xmp/detail.rs`）は Lightroom のプリセットと同じパッチで、XMP にあるキーだけが写真の値を置き換える。値は有限数だけを範囲に丸めて使う。

| XMP | developSettings | 範囲 | Camera Raw の既定 | NIHO の読み | 書き（群） |
| --- | --- | --- | --- | --- | --- |
| `Sharpness` | `detail.sharpening.amount` | 0〜150 | RAW 40 / JPEG・TIFF 0 | approximate（0 は exact） | `sharpening` |
| `SharpenRadius` | `detail.sharpening.radius` | 0.5〜3.0 | 1.0 | approximate（量 0 は exact） | `sharpening`（小数 1 桁・符号付き） |
| `SharpenDetail` | `detail.sharpening.detail` | 0〜100 | 25 | approximate（量 0 は exact） | `sharpening` |
| `SharpenEdgeMasking` | `detail.sharpening.masking` | 0〜100 | 0 | approximate（量 0 は exact） | `sharpening` |
| `LuminanceSmoothing` | `detail.luminanceNoiseReduction` | 0〜100 | 0 | approximate（0 は exact） | `noiseReduction` |
| `LuminanceNoiseReductionDetail` / `Contrast` | なし（保持のみ） | 0〜100 | 50 / 0 | 既定値なら approximate、ほかは unsupported（輝度 0 なら exact） | 書かない |
| `ColorNoiseReduction` | `detail.colorNoiseReduction`（signed RAW で 50 以下なら旧 top-level） | 0〜100 | RAW 25 / JPEG・TIFF 0 | approximate（描く量が 0 なら exact） | `noiseReduction` |
| `ColorNoiseReductionDetail` / `Smoothness` | 旧 top-level（保持のみ） | 0〜100 | 50 / 50 | 50 なら approximate、ほかは unsupported（カラー 0 なら exact） | `noiseReduction` |

Photo Bench はどれも描かなかったので、Photo Bench の level は unsupported のまま。範囲外の値は丸めて approximate とし、丸めたことを注記する。読めない値は unsupported で `legacySettings` に残す。

既定値の扱い（テストで固定: `tests/xmp_detail.rs`）:

- XMP に無いキーは写真の今の値（`detail` が無ければ NIHO の既定）を保つ。片方だけある組では、無い側は Camera Raw の既定（半径 1.0・ディテール 25・マスク 0・輝度 0）と同じ NIHO の既定になる。
- Camera Raw の種類別の既定（RAW: `Sharpness` 40 / `ColorNoiseReduction` 25、JPEG・TIFF: 0 / 0）は、値が XMP に書かれていないときに補わない。NIHO の neutral の描画は既存の画素を保つためで、XMP が書いた値は写真の種類によらずそのまま当てる（Lightroom がプリセットを当てるのと同じ）。
- `detail` は、旧の形で表せない値のときだけ作る: シャープ（または既定でない半径・ディテール・マスク）、輝度 NR、旧 top-level が描かないカラー NR（JPEG / PNG・旧 RAW の 0 より大きい値、signed RAW の 50 を超える値）。JPEG の既定（全部 0）の XMP やカラー NR 25 だけの signed RAW 向け XMP は形の版を上げず、画素も以前と同じ。
- プリセットの適用量（0〜150%）は、写真の値（`detail` が無ければ既定、カラー NR は今描いている量）からプリセットの値へ各量を動かす。

同梱プリセットでは `niho-colorful` だけがシャープ 40・カラー NR 25 を持ち、取り込むとそれを描く（Lightroom で当てたときと同じ）。Photo Bench との golden（`tests/golden.rs`、手元の参照が必要な ignored test）は色の比較なので、ディテールを外して比べる。

書き（`src/xmp/write.rs`）は群 `sharpening`（新規）と `noiseReduction` で、Camera Raw の型（半径だけ Real、ほかは Integer）に丸める。`detail` の無い写真は、signed RAW の旧カラー NR を除いて何も書かず、以前と同じバイト列になる。

## 画面

- PC の右パネルの効果の後ろに「ディテール」の群を足す。並びは Lightroom と同じ: シャープ・半径・ディテール・マスク・ノイズ軽減・カラーノイズの軽減。半径は 0.1 刻みで小数 1 桁、ほかは整数。見出し・ⓘ・スライダーは既存の群と同じ部品（押せる高さ 44px）。
- スマホの面（道具の帯）にはまだ出さない。帯は今の 7 つの道具（プリセット・自動・ライト・カラー・効果・色ミキサー・切り抜き）で幅いっぱいで、8 つ目を足すと 360〜390px で名前が重なり端が欠ける（同じ CSS の帯で実測: 375px で隣との隙間が -10.5px、430px で +4.5px）。効果と同じく、帯の作り替えと合わせて足す。
- シャープが 0 の間は半径・ディテール・マスクを薄くして押せなくする（行は出したまま）。群名の横の ⓘ に項目ごとの 1 行の説明。シャープは「指を離すと反映します」、ノイズ軽減・カラーノイズの軽減は JPEG と挙動が違う所だけ「RAW などは指を離すと反映します」を足す。
- `v: 5` を読める wasm（Worker の `validateSettings` で最小の v5 を確かめる `ready.detail`）で開いた写真に出す。RAW・HEIC / TIFF の作業コピーや、RAW を開いている途中の仮の画にも出す（owner 判断 2026-10-21）。

### プレビューへの送り方（owner 判断 2026-10-21）

「RAW でも群を出す。ディテールを 0 以外にした写真だけ、drag 後の確定描画で当てる（drag 中はシャープを省く）。使わない写真の速さは今のまま」に従い、engine client（`develop-engine-client.ts` と `develop-detail-preview.ts`）が wasm へ送る設定を次のように決める。

| 入力 | drag 中（Interactive） | 確定描画（Final）・見本・色取得・書き出し |
| --- | --- | --- |
| JPEG / PNG・JPEG の作業コピー（`open`） | 今の値（NR を描く。シャープは crate が省く） | 今の値 |
| 旧 RAW・raster の作業コピー（16bit PNG） | `detail` を外す（NR もシャープも描かない） | 今の値 |
| signed RAW の作業コピー（niho-3/4/5/7/11） | 直前の確定描画の NR のまま（シャープは crate が省く） | 今の値 |

- 量の無い `detail`（シャープ 0・輝度 0・カラーの明示なし）はどの写真でも外して送る。ディテールを使わない写真は今までと同じ設定の JSON・同じ経路・同じ速さで描く。
- signed RAW は NR が原寸の canonical master の準備に入っている。drag 中に NR を外すと、master の key が変わって確定描画のたびに master を作り直す（実測で指を離すたびに 1.4〜3.1 秒）。直前の確定描画の NR のまま送ると、同じ master を使い回すので、ディテールを使っていない写真と同じ速さになる。NR を動かした後の確定描画では、今の NR で master を作り直す。
- drag 中の見た目が確定描画で変わるのは許容する（RAW などの NR とシャープは指を離すと反映）。

## 性能（Mac Studio M1 Max・wasm・Node 24 単スレッド）

`scripts/bench-session.mjs` の `detail` scenario で測った（合成チャートの作業コピー 2560×1707 と 24MP の JPEG。他の作業と並行のため負荷のある状態で、5 回の中央値 / 最小、ms）。detailFinal はシャープ 90・輝度 NR 40・カラー NR 25 の Final 2048、plainTail はディテール無しでコントラストだけを変えた Final 2048（同じ session の既存の描画）。

| 入力 | detailFinal 2048 | plainTail 2048（既存） | シャープの drag 1280（6 コマの平均） | 輝度 NR の drag 1280（6 コマの平均） |
| --- | --- | --- | --- | --- |
| JPEG 24MP（2560 で開く） | 750 / 746 | 369 / 368 | 56 / 56 | 165 / 160 |
| JPEG 24MP（原寸で開く） | 926 / 921 | 384 / 376 | 81 / 81 | 189 / 186 |
| 旧 RAW 作業コピー（unsigned, niho-2） | 1391 / 1359 | 801 / 793 | 81 / 79 | 184 / 182 |
| signed RAW 作業コピー（niho-11） | 2271 / 1959 | 2117 / 2059 | 438 / 176 | 667 / 659 |

段ごとの目安（Final 2048、ディテールの各段を足したときの増分）: JPEG ではシャープ 約 125ms・輝度 NR 約 135ms・カラー NR 約 445ms、旧 RAW ではシャープ 約 90ms・輝度 NR 約 150ms・カラー NR 約 360ms。signed RAW は NR が canonical master の準備に入るので、NR を変えるたびに master を作り直す（既存の Final 2048 も約 2 秒で、ディテールで目立って増えない）。

判断: JPEG / PNG はディテールを全部当てても Final 2048 が 1 秒以内なので、drag 中も NR を描く。RAW の確定描画（Final 2048）は、ディテールを使ったときだけ約 1.4〜2.3 秒になる（旧 RAW は既存の約 0.8 秒から約 1.4 秒、signed RAW は既存の時点で約 2 秒で、NR を変えた直後は master を作り直す。開いた直後の初回は最大約 2.9 秒）。owner 判断により RAW でも群を出し、ディテールを 0 以外にした写真だけ確定描画で当てる（drag 中は NR も計算し直さない。上の表）。ディテールを使わない写真の描画は変わらない。

エディタのプレビュー（長辺 1280px）の流れでの実測（同じ合成チャート、`develop-detail-preview.ts` を通して wasm へ送る。3 回の中央値、ms。負荷のある状態）:

| 入力 | 動かす項目 | ディテール | drag 1 コマ | 指を離した後の確定描画 |
| --- | --- | --- | --- | --- |
| signed RAW | コントラスト | なし | 85 | 849 |
| signed RAW | コントラスト | あり（シャープ 70・輝度 40・カラー 25） | 88 | 837 |
| signed RAW | ノイズ軽減 | あり | 40 | 1046（最小 708） |
| 旧 RAW | コントラスト | なし | 65 | 383 |
| 旧 RAW | コントラスト | あり | 64 | 508 |
| 旧 RAW | ノイズ軽減 | あり | 43 | 478 |

以前（drag 中も NR を描き直す）は signed RAW のノイズ軽減の drag が 1 コマ約 670ms だった。

再現: `cargo +1.98.1 build --locked --release --config packages/develop-engine/.cargo/config.toml --manifest-path packages/develop-engine/Cargo.toml --target wasm32-unknown-unknown -p niho-develop-wasm` と `wasm-bindgen --target web` の出力を `--pkg` に渡し、`node scripts/bench-session.mjs run --pkg <dir> --cases <cases.json> --case <id> --scenario detail`。cases.json は作業コピー（`png` / `meta`）か JPEG（`raster` / `workingMaxDimension`）を指す。

## Lightroom との統計比較（未実施）

参照の書き出しがまだ無いので、手順と合成チャートだけを置く。粒子と同じく画素の一致ではなく統計で比べる。

1. `cargo run --release -p niho-develop --example detail_chart -- write detail-chart.png` で 2048×1366 の合成チャート（平らな左右の段差と、チャンネルごとに独立な seed 固定のノイズ）を作る。
2. Lightroom Classic に取り込み、ほかは既定のまま次の値ごとに、sRGB・JPEG 品質 100・長辺 2048px・出力シャープなしで書き出す（ファイル名に項目と値を入れる）。
   - シャープ: `Sharpness` 0 / 40 / 80 / 150（半径 1.0・ディテール 25・マスク 0）、半径 0.5 / 1.0 / 2.0 / 3.0（量 80）、マスク 0 / 50 / 100（量 80）
   - 輝度: `LuminanceSmoothing` 0 / 25 / 50 / 75 / 100
   - カラー: `ColorNoiseReduction` 0 / 25 / 50 / 75 / 100
3. 同じ値の `developSettings`（`detail`）で `niho-develop-render render --raster detail-chart.png --settings <json> --max-dimension 2048 --out <png>` を描く。
4. `cargo run --release -p niho-develop --example detail_chart -- measure <書き出し>...` でエッジの鋭さ（エッジ帯の輝度の段差の二乗平均）・平坦部の輝度 / 色の標準偏差を出し、値ごとの曲線を Lightroom と比べる。ずれが大きい項目は量の写像（例: Lightroom の 40 を NIHO の何に当てるか）を決め直す。

NIHO 側の今の値（手順 3〜4、niho-10・native CLI、2048×1366）:

| 設定 | edgeAcutance | flatLumaSd | flatChromaSd |
| --- | --- | --- | --- |
| ディテールなし（チャートのまま） | 147.6 | 5.63 | 15.03 |
| シャープ 80（半径 1・ディテール 25・マスク 0） | 544.8 | 9.86 | 15.24 |
| シャープ 150 | 903.8 | 13.76 | 15.60 |
| 輝度 NR 50・カラー NR 50 | 137.4 | 5.36 | 1.94 |
| 輝度 NR 100・カラー NR 100 | 110.8 | 4.10 | 0.96 |

輝度 NR は 50 で平坦部の輝度の標準偏差が約 5% しか下がらず（100 で約 27%）、Lightroom より弱い可能性が高い。比較の結果で強さの写像を決め直す。

## 版 `v` の定義箇所

マスク（Issue #31）も `v` を上げる予定のため、rebase で 5 / 6 を入れ替えるときは次をそろえる。

- Rust `crates/niho-develop/src/settings.rs`: `DETAIL_SETTINGS_VERSION`（5）、`MAX_SETTINGS_VERSION`、`from_value` の `v` の読み（`n == 5.0`）と `unsupportedVersion` の文言、`required_version`、`validate` の `versionTooLow` の文言、同ファイルの test（`{"v":5}` / `{"v":6}`）。
- Rust の test: `tests/detail_cross_target.rs`（`settings.v = 5`）、`tests/niho3.rs`・`tests/xmp_detail.rs`（`v == 5`）、`crates/niho-develop-render/tests/cli.rs`（`MAX_SETTINGS_VERSION + 1` を未来の版として使う）。
- TypeScript `packages/photo-editing/src/develop-engine/develop-settings.ts`: `DevelopSettingsVersion`、`isDevelopSettingsVersion`、`developSettingsVersion`、`readDevelopSettings` の `value.v < 5`。
- TypeScript `develop-engine-worker-core.ts`: `DETAIL_PROBE_SETTINGS_JSON` の `v: 5`。test は `develop-settings.test.ts`・`develop-open-settings.test.ts`・`photo-editing-color-mixer.test.tsx`（未知の版 6）・`photo-editing-detail.test.ts`・`develop-engine-worker-core.test.ts`。
- `packages/develop-engine/scripts/bench-session.mjs` の `detail` scenario（`v: Math.max(5, …)`）。
