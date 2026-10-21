# 部分補正（マスク）（developSettings の `masks`）

Epic #31 の契約。線形・円形・ブラシ・被写体・空の「面」で、全体と同じ補正を局所に当てる。このファイルが保存の形・座標・面の式・混ぜ方の正で、Rust（`packages/develop-engine/crates/niho-develop`）と TypeScript（`packages/photo-editing`）は同じ fixture でこれに合わせる。

| 子 Issue | 範囲 |
| --- | --- |
| #65 M1 | この契約と、設定の読み書き（検証）。描画はしない |
| #66 M2 | 線形・円形の面と、混ぜる描画（native / wasm の画素一致） |
| #67 M3 | UI（マスクタブ・画像の上の操作） |
| #68 M4 | ブラシ。面の保存と受け渡し（被写体・空の面も同じ口で読む） |
| #69 M6 | Lightroom XMP の読み（線形・円形・ブラシ） |

被写体・空の面を作って保存する側（Mac ワーカー・API）は非公開側（`niho-coliving/niho-app#19218`）で、ここでは「面が来れば同じ経路で混ざる」ところまでを扱う。

## 保存形

`developSettings.masks` は最大 8 枚の配列で、1 枚でもあれば `v` を要求する（下の「版と互換」）。空配列は無いのと同じで `v` を上げない。

```json
{
  "v": 5,
  "masks": [
    {
      "id": "mask-a1",
      "kind": "linear",
      "zero": { "x": 0.5, "y": 0.2 },
      "full": { "x": 0.5, "y": 0.5 },
      "adjust": { "exposure": -0.7, "highlights": -30 }
    },
    {
      "id": "mask-b2",
      "kind": "radial",
      "invert": true,
      "center": { "x": 0.5, "y": 0.45 },
      "radius": { "x": 0.3, "y": 0.2 },
      "angle": 15,
      "feather": 50,
      "adjust": { "exposure": 0.4, "saturation": 10 }
    },
    {
      "id": "mask-c3",
      "kind": "brush",
      "surface": { "id": "<sha256 の 16 進 64 文字>", "width": 1024, "height": 683 },
      "adjust": { "shadows": 25 }
    }
  ]
}
```

- 共通: `id`（1〜64 byte の ASCII `[A-Za-z0-9_-]`・配列内で一意）、`kind`（`linear` `radial` `brush` `subject` `sky`）、`adjust`（必須。空は何もしない）、`enabled`（省略は `true`）、`invert`（省略は `false`）。`enabled: false` は描かない（編集は残す）。
- `linear`: `zero`（面が 0 の点）と `full`（面が 1 の点）。`x` `y` は −1〜2（枠の外にも置ける）。2 点の距離は 0.001 以上。
- `radial`: `center`（0〜1）、`radius`（楕円の半軸。`x` は幅・`y` は高さに対する割合で 0.005〜1.5）、`angle`（度。−180〜180。時計回り）、`feather`（0〜100）。
- `brush` `subject` `sky`: `surface`（`id` は面の PNG の sha256 の小文字 16 進 64 文字、`width` `height` は 1〜4096）。`kind` の違いは由来（利用者が描いた／検出した）を表すだけで、描画は同じ。
- `adjust`（局所の補正。値は全体への**差分**）は次のキーだけを持てる。範囲は全体の同じキーと同じ。
  - `exposure`（−5〜5）、`contrast` `highlights` `shadows` `whites` `blacks`（−100〜100）
  - `texture` `clarity` `dehaze`（−100〜100）、`vibrance` `saturation`（−100〜100）
  - `relativeTemperature` `relativeTint`（−100〜100）
  - `hsl`（全体の `hsl` と同じ形・差分。各値 −100〜100）
- 各マスク・各入れ子は上のキーだけを持つ厳密な形とし、欠落、未知キー、種類に合わないキー、非有限値、範囲外、重複 id、9 枚以上を Rust と TypeScript の双方で拒む。
- 正規形（`to_value` / `writeDevelopMasks`）: キー順は上の例の順（`id` `kind` `enabled`（`false` のときだけ）`invert`（`true` のときだけ）、種類のキー、`adjust`）。`adjust` は 0 の項目を書かない。`adjust.hsl` は全体の `hsl` と同じ交互配列（帯の順は赤→マゼンタ。0 の帯は書かず、帯の中も 0 でない `hue` `saturation` `luminance` だけ）。TypeScript は数値を小数 6 桁に丸めて書く。Rust の `to_value` は JSON のキーが辞書順になるため、キー順はこの TypeScript の `writeDevelopMasks` が保ち、Rust は値の等価で突き合わせる（`tests/fixtures/masks/settings-cases.json` の `canonical`）。
- 設定全体の上限（Rust の 64 KiB・下書きの 32 KiB）に面の画素は入れない。ブラシ・被写体・空は `surface` で参照するだけにし、undo の 100 版にも面を載せない。

## 座標

マスクは**作業画像**（EXIF の向きを反映済み・`geometry` の回転／反転／角度補正／切り抜きの前）の上に置く。`x` `y` は作業画像の幅・高さに対する 0〜1（y は下向き）。切り抜き・回転・反転を変えても、マスクは画像の内容に付いたまま動く。

描画は出力の画素 `(i, j)` の中心 `((i + 0.5) / W, (j + 0.5) / H)` を、切り抜き（`geometry.rs` の座標・`frame.rs` の plan）で作業画像の位置 `(u, v)` に戻して面を評価する。TypeScript の `geometryOutputToSource` と同じ写像（切り抜き枠の上の位置。角度つきで角が枠から出る切り抜きは中心の回りに縮めて収める → 反転を戻す → 回転を戻す。幾何が無い・恒等なら `(u, v)` は出力の位置そのもの）で、Rust（`local_render::SourceMap`）と TS は同じ fixture（`tests/fixtures/masks/geometry-map-cases.json`。TS のテストがこの関数から作り、関数とずれたら落ちる）で突き合わせる。要求は 1e-6 以内、実測の差は 1e-12 未満。写像は倍精度で計算する。

形の計算は、作業画像の幅 `Ws` と高さ `Hs` から `A = Ws / Hs` を取り、長さの単位を高さにそろえた座標 `X = u·A, Y = v` で行う。円形が回しても楕円のままで、縦横比に引き延ばされない。`Ws` `Hs` と写像の作業画像の寸法は、JPEG / PNG の原本では EXIF の向きを反映した元の寸法（縮めて読んだ Session・書き出しの one-shot・プリセットの見本でも同じ値。`RasterInfo.source_width / source_height`）、作業コピーではその PNG の寸法（作業コピーは元の寸法を持たないため。2560 と原寸の作業コピーでは丸めの分だけ `A` が違い、差は半径 0.3 の円で 4000px の高さに対して 1 画素未満）。描画そのもの（切り抜きの plan）は読んだ寸法で行うので、縮めて読んだときのマスクの位置は内容に対して 1 画素未満ずれうる。

## 面の式

画素ごとの面の値 `m`（0〜1、f32）。画素ごとの計算は IEEE 754 の `+ − × ÷ sqrt` だけで、三角関数などは**マスク 1 枚につき 1 回**（libm）求めて使う。native と wasm で同じ結果にするためで、`fastmath` や FMA は使わない。実装（`local_render.rs`）は、上の写像で求めた `(u, v)`（f64）から `X = (u·A) as f32`・`Y = v as f32` を作り、形の定数（`Z` `d` `d.x² + d.y²`、`c` `a` `b` `cosθ` `sinθ` `max(f, 0.002)`）はマスクごとに f64 から f32 にして、画素ごとの式を f32 で計算する（角度は `angle·π/180`）。重みは `floor(m·65536 + 0.5)` を f64 で求め、`u32`（0〜65536）で持つ（`m = 1` の 65536 を表すため 2 byte に詰めない）。

- 線形: `Z = (zero.x·A, zero.y)`、`F = (full.x·A, full.y)`、`d = F − Z`、`t = ((X − Z.x)·d.x + (Y − Z.y)·d.y) / (d.x² + d.y²)`、`m = clamp(t, 0, 1)`。
- 円形: 中心 `c = (center.x·A, center.y)`、半軸 `a = radius.x·A`、`b = radius.y`、`θ = angle`（時計回り）。`(dx, dy) = (X − c.x, Y − c.y)`、`p = (dx·cosθ + dy·sinθ, −dx·sinθ + dy·cosθ)`、`r = sqrt((p.x/a)² + (p.y/b)²)`、`f = feather/100`、`s = clamp((1 − r) / max(f, 0.002), 0, 1)`、`m = s²(3 − 2s)`。`feather = 0` は縁だけ約 1 画素でなじませた硬い縁、`100` は中心 1・縁 0。
- 面（ブラシ・被写体・空）: `surface` の PNG（8bit グレー。値 `/255`）を、作業画像全体に重ねて双一次補間する。標本位置は `(u·width − 0.5, v·height − 0.5)`、端は端の値で延ばす（M4。M2 のエンジンには面の置き場が無いので、これらの種類の有効なマスクは `maskSurfaceMissing` で失敗する）。
- `invert` は最後に `m ← 1 − m`。

## 局所の補正

局所の設定 `L` は、全体の設定に `adjust` を足したもの。各キーは `clamp(全体 + 差分, 全体の範囲)`、`hsl` は項目ごとに足して ±100 に収める。それ以外（`engine` `look` `base` `geometry` 曲線・キャリブレーション・カラーグレーディング・色ポイント・効果）は全体と同じで、`masks` だけを除く。

- 相対 WB: 全体の WB が `relative` ならそのまま足す。`asShot` なら `relative` にして差分だけを入れる。`absolute` のときに `relativeTemperature` / `relativeTint` の差分が 0 でないマスクは設定として拒む（`localWhiteBalance`。UI は `absolute` の間このスライダーを出さない）。
- 差分を足しても `L` が全体と同じになるマスク、`enabled: false`、面が全部 0 のマスクは描かない（追加の描画をしない）。
- `hsl` の帯で、全体に無い帯の差分を足して 0 になったものは足さない（`L` が全体と同じかの比較を、値の同じ空の帯で外さない）。

## 描画と混ぜ方

1. 全体の結果 `R0` を、これまでと同じ経路で描く（`masks` を除いた設定）。
2. 描くマスクごとに `L_k` を描いて `R_k` を得る。`R_k` は `R0` と同じ寸法・同じ quality（drag 中は両方 interactive、離したら両方 final。interactive の `R_k` を final の `R0` と混ぜない）。設定が変わらない層の結果は使い回す（下の「層の持ち方」）。
3. マスクの面を出力と同じ寸法で作り、重み `w_k = floor(m·65536 + 0.5)`（0〜65536）にする。
4. 8bit sRGB の各チャンネルを固定小数点で合算する。

   `out = clamp(R0 + Σ_k ((R_k − R0)·w_k + 32768) >> 16, 0, 255)`（整数。`>>` は算術右シフト。alpha は 255）

マスク 1 枚で `m = 1` なら `out = R_k`、`m = 0` なら `R0` に一致する。合算は項の順序に依らないので、配列の順で画が変わらない。重なったマスクは差分が足される（それぞれの補正が重なる）。

`masks` の無い設定（有効なマスクが無い設定も）の描画は、これまでと 1 bit も変えない（`Session` の経路にも追加のコストを入れない。one-shot の JPEG / PNG は有効なマスクがあるときだけ Session を通る。`tests/masks_render.rs` が原本・作業コピーで確かめる）。

### 層の持ち方（`mask_session.rs`）

Session は次の描画のための 1 枠のキャッシュ（cube・局所階調の pass・色ポイントの面・niho-6 / NIHO 3 の master・縮小・切り抜きの窓・統計）を持つ。`R0` と `R_k` を同じ枠で交互に描くと毎回追い出し合うので、層ごとに持つ。別の Session は作らない（source・niho-6 の解析・効果の面は 1 つを共有する）。

- 設定の側のキャッシュ（cube・局所階調の pass・色ポイントの面・その層が最後に使った niho-6 の解析）は層ごとに持ち、層を描く間だけ Session と入れ替える。
- source の側のキャッシュ（master・退避した master・縮小・窓・統計）は、層が描く画像が `R0` と同じ（どちらも master が無い、または master の key が同じ＝差分が master の入力を変えない）なら `R0` のものをそのまま使い、層には持たない。差分が master の入力を変える層（signed RAW の露光量・WB・ハイライト／シャドウ・テクスチャ・ノイズ低減、niho-6 系の露光量・ハイライト < 0・シャドウ > 0）は自分の master を持ち、`R0` の解析（CNR の結果・係数）から作る。drag 中の表示寸法の master は持ち続けるが、離した final の原寸の master（と縮小・窓）は層の結果を描いたらすぐ手放す（Session が持つ原寸の master は `R0` の 1 枚だけ。その層の final は結果の使い回しで足り、次に final を描き直すときは同じ key から同じ画素で作り直す）。`R0` の結果が前の描画のもので層だけを描くとき（マスクのスライダーを離した final など）、その層がこの描画の `R0` と同じ画像を描くなら、先に `R0` の master をこの描画の quality・寸法のもの（退避した原寸の master を戻す、drag なら表示寸法のもの）にしてから層を描き、層はそれを共有する（自分の master を描く層しか無いときは `R0` の master を作り直さない）。
- 同じ画像を描く層は、局所階調の pass が `R0` と同じ（入力・適応の値・quality が同じ＝差分がハイライト／シャドウ／テクスチャ／明瞭度の外）なら `R0` の pass を読み、写しを持たない。
- niho-6 系は、その層が最後に使った解析の露光量がちょうど同じなら final でもそれを使う（共有の解析の 1 枠を `R0` と層で取り合わない。同じ写真・同じ露光量の解析なので値は同じ）。
- 結果は `R0` と各 `R_k` を quality ごとに 1 枚、描いた設定の JSON・寸法・quality と組で持つ。1 枚のマスクのスライダーを動かす間はその層だけを描き、全体のスライダーではすべての層を描く。離した final も、ほかの層の final の設定が変わっていなければその層だけを描く。final はドラッグ中に固定して使う niho-6 解析を更新する場合があるため、次のドラッグ前に全 interactive フレームを破棄する。面は層ごとに 1 枚、形・`invert`・幾何・寸法が変わらない間は作り直さない（形だけを動かす間は面と合算だけ）。
- 無くなったマスク・有効でなくなったマスクの層は次の描画で手放し、有効なマスクが無い描画ですべて手放す。
- 自動補正と色の取得（色ポイントの picker）は `masks` を除いた全体の設定で測り、自動補正の結果の `masks` は渡されたまま返す。

### 面の表示（エディタの重ね表示）

`Session::mask_plane(settings, maskId, maxDimension)`・wasm の `Developer.maskPlane(settingsJson, maskId, maxDimension)` は、1 枚のマスクの面を `{ width, height, data }`（`data` は `width·height` byte。`round(w / 65536 · 255)`、行優先、`invert` 込み、`enabled` に依らない）で返す。寸法はその `maxDimension` の描画と同じ（幾何込み）、写像と面の計算も描画と同じで、Session の描画のキャッシュには触れない。面の種類（ブラシ・被写体・空）は `maskSurfaceMissing`、無い id は `maskNotFound`。

## 面の受け渡し

- 面は PNG（8bit グレー・1〜4096 画素・8 MiB 以下）の**内容の sha256** で呼ぶ不変のファイルで、同じ `id` の中身は変わらない。エンジンは受け取るときに sha256 と寸法を `surface` と照合し、合わなければ拒む。
- `Session::set_mask_surface(id, png)` / `drop_mask_surface(id)`、wasm の `Developer.setMaskSurface(id, png)` / `dropMaskSurface(id)`、書き出しの CLI の `--mask-surface <id>=<path>`（繰り返し可）が同じ口（M4）。設定が参照する面が無いときは、無言で飛ばさず `maskSurfaceMissing` で失敗する（M2 のエンジンは面の口を持たないので、ブラシ・被写体・空の有効なマスクは常にこれ。Rust の `Error::MaskSurfaceMissing`、CLI は `unsupported_settings`・exit 2）。
- 保存先は M4（Mac は写真の隣のローカル保存、クラウドの写真は非公開側）。

## 版と互換

- `masks` に 1 枚でもあれば `v = 5`（`MASKS_SETTINGS_VERSION`）を要求する。`detail`（#32）も 5 を使う予定で、先に merge された側が 5、後の側が 6 に振り直す。古い reader は `v` が未知のため設定を補正なしとして読み替えず、閲覧のみにする。
- 能力の問い合わせ: `validateSettings` の probe は M1 の wasm（マスクを読めるが描かない）でも通るので使わない。wasm の `capabilities()`（`{"masks":{"kinds":["linear","radial"],"max":8,"maskPlane":true}}`）が描ける種類を返し、この口の無い古い wasm は描けない扱いにする（画面の扱いは M3）。Mac の書き出しは同梱の niho-develop-render が `MASKS_MIN_RENDER_VERSION`（0.19.0）以上のときだけ `masks` 付きの設定を渡し、それより古ければ作業コピーを作る前に `unsupportedSettings` で断る。NIHO camera の `camera_develop_status` は `masks`（`PhotoLibraryCapabilities.nativeExportMasks`）でこれを画面へ知らせる。sidecar の lock（`apps/camera/develop-sidecars.lock.json`）は repo の外の公開の手順で 0.19.0 に上げる。
- 取り扱い: 「初期化」とプリセット適用前の比較は `masks` を除く。プリセット（XMP）の適用・自動補正・設定のコピーは対象の `masks` を変えない（コピー元の `masks` も持ち出さない）。旧形式への変換 (`developSettingsToEditSettings`) は `masks` が有効なら null。XMP の書き出しは `masks` を書かず `notWritten: ["masks"]` を返す。

## 性能の目安と測り方

drag 100ms／final 1 秒（マスク 3 枚まで）が目安。層は「描くマスクの枚数 + 1」回の描画になる。

測り方（どちらも合成の入力だけを使う）:

- native: `cargo run --release -p niho-develop --example mask_timing [-- --source raster|raw --trials 3]`
- wasm: `mask_timing -- --dump <dir>` が書く同じ入力で、`node tools/mask-wasm-bench.mjs <web 向けの wasm-bindgen の出力> <dir>`（Node・SIMD・単一スレッド。場面ごとに新しい process で測り、wasm の linear memory はその場面の最大）。
- 入力: 合成 2048×1365 の JPEG 相当（PNG。`niho-10`、ハイライト −30・シャドウ +20・コントラスト 10・自然な彩度 10 で niho-6 の応答の master を使う）と、同じ寸法の signed RAW の作業コピー（`niho-11`、露光量 −0.2・ハイライト −40・シャドウ +20・コントラスト 10）。
- マスク: 線形（上の空）・円形（小さめ）・反転した円形（大きな周辺）の 1〜3 枚。局所の差分は 3 種: 「cube のみ」（彩度 +20・コントラスト +15。master と局所階調の入力を変えない）、「露光量」（露光量 −0.7。master の入力を変える）、「局所階調」（明瞭度 +25・テクスチャ +20・シャドウ +25・ハイライト −30）。動かすのは 1 枚目のスライダー（2 枚目以降は固定）。
- 場面: 初回 final 1280（新しい Session の最初の 1 枚）、初回 drag（その次の interactive 1280。1 枚目のマスクのスライダー、マスク無しはコントラスト）、drag（その 1 枚）＝続く 6 枚の中央値、離した final 1280、drag（全体）＝全体のコントラストを動かす 6 枚の中央値、final 原寸（新しい Session の作業寸法の final）。
- 値は ms で「wasm / native」。それぞれ 3 回のうち最も速いもの（wasm は 2 回の計測の合計 6 回）。計測した Mac Studio（Apple M1 Max・64 GB）は他の作業の負荷（load average 7〜30）がかかっていて、負荷は時間を増やす向きにしか働かない。2026-10-21、エンジン 0.19.0（engine niho-11）、Node 24.18。

| 元 | 局所の差分 | 枚数 | 初回 final 1280 | 初回 drag | drag（その 1 枚） | 離した final 1280 | drag（全体） | final 原寸 | wasm memory |
| --- | --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| JPEG 相当 | — | 0 | 1296 / 1045 | 148 / 106 | 60 / 39 | 557 / 453 | 59 / 40 | 1759 / 1434 | 187 MiB |
| JPEG 相当 | cube のみ | 1 | 1908 / 1519 | 226 / 152 | 78 / 46 | 836 / 632 | 137 / 87 | 2897 / 2360 | 200 MiB |
| JPEG 相当 | cube のみ | 2 | 2411 / 1888 | 303 / 200 | 78 / 47 | 832 / 638 | 215 / 137 | 3972 / 3184 | 227 MiB |
| JPEG 相当 | cube のみ | 3 | 3033 / 2279 | 378 / 247 | 81 / 49 | 841 / 638 | 289 / 181 | 5010 / 3949 | 254 MiB |
| JPEG 相当 | 露光量 | 1 | 2288 / 1858 | 307 / 216 | 68 / 44 | 1023 / 816 | 125 / 83 | 3292 / 2648 | 260 MiB |
| JPEG 相当 | 露光量 | 2 | 3315 / 2666 | 450 / 318 | 66 / 44 | 994 / 820 | 188 / 124 | 4788 / 3878 | 295 MiB |
| JPEG 相当 | 露光量 | 3 | 3940 / 3162 | 597 / 429 | 68 / 46 | 1007 / 820 | 247 / 168 | 5885 / 4763 | 325 MiB |
| JPEG 相当 | 局所階調 | 1 | 1849 / 1503 | 314 / 223 | 90 / 60 | 575 / 448 | 121 / 80 | 2849 / 2283 | 257 MiB |
| JPEG 相当 | 局所階調 | 2 | 2452 / 1944 | 488 / 342 | 92 / 60 | 572 / 454 | 179 / 121 | 3947 / 3163 | 289 MiB |
| JPEG 相当 | 局所階調 | 3 | 3070 / 2399 | 654 / 465 | 94 / 62 | 595 / 450 | 240 / 160 | 5134 / 4023 | 322 MiB |
| signed RAW | — | 0 | 2631 / 2119 | 261 / 149 | 83 / 54 | 843 / 757 | 84 / 55 | 3829 / 3156 | 192 MiB |
| signed RAW | cube のみ | 1 | 3782 / 3054 | 361 / 212 | 106 / 64 | 1078 / 913 | 186 / 118 | 6260 / 5325 | 215 MiB |
| signed RAW | cube のみ | 2 | 4923 / 3990 | 456 / 275 | 106 / 65 | 1081 / 910 | 282 / 184 | 8649 / 7452 | 232 MiB |
| signed RAW | cube のみ | 3 | 6004 / 4948 | 560 / 342 | 108 / 67 | 1081 / 916 | 385 / 245 | 10993 / 9559 | 253 MiB |
| signed RAW | 露光量 | 1 | 3910 / 3152 | 519 / 302 | 193 / 93 | 1089 / 893 | 168 / 112 | 6327 / 5387 | 278 MiB |
| signed RAW | 露光量 | 2 | 5192 / 4210 | 775 / 462 | 195 / 96 | 1114 / 892 | 248 / 167 | 8816 / 7570 | 333 MiB |
| signed RAW | 露光量 | 3 | 6452 / 5268 | 1059 / 607 | 199 / 96 | 1114 / 893 | 326 / 225 | 11340 / 9755 | 375 MiB |
| signed RAW | 局所階調 | 1 | 4254 / 3461 | 643 / 410 | 112 / 81 | 1492 / 1206 | 163 / 113 | 6703 / 5703 | 278 MiB |
| signed RAW | 局所階調 | 2 | 5940 / 4828 | 1032 / 666 | 111 / 82 | 1474 / 1212 | 238 / 170 | 9635 / 8232 | 333 MiB |
| signed RAW | 局所階調 | 3 | 7641 / 6258 | 1418 / 916 | 114 / 84 | 1436 / 1217 | 321 / 227 | 12617 / 10832 | 390 MiB |

読み方（目安との比較）:

- **1 枚のマスクのスライダーの drag は JPEG 相当で目安内、RAW でほぼ目安**（wasm で JPEG 相当 66〜94 ms、RAW 106〜114 ms）。描き直すのはその層だけで、`R0` とほかの層は結果を使い回すので、枚数に依らずマスク無しの drag（wasm 59 / 84 ms）に面と合算など（native 約 7 ms・wasm 約 20 ms）を足した程度。RAW の露光量のマスクだけは、drag のたびにその層の master を作り直すので約 195 ms（全体の露光量を drag するのと同じ費用）で目安を超える。
- **離した final 1280 はほぼ目安**（wasm で JPEG 相当 0.57〜1.02 s、RAW 1.08〜1.49 s）。`R0` とほかの層の final を使い回し、その層だけを描く。RAW の局所階調の層は自分の原寸の master を作り直す分（約 0.4 s）重い（離した final の原寸の master を層に持たせないため。下の memory）。
- **全体のスライダーの drag は目安を超える**（マスク 3 枚の wasm で JPEG 相当 240〜289 ms、RAW 321〜385 ms）。全体が変わると全部の層を描き直すので、「枚数 + 1」枚の drag の描画になる。
- **初回 final と final 原寸は目安を超える**（マスク 3 枚の wasm で JPEG 相当の初回 3.0〜3.9 s・原寸 5.0〜5.9 s、RAW の初回 6.0〜7.6 s・原寸 11〜12.6 s）。全部の層の final を描く。マスク無しでも初回 final は niho-6 の解析（特徴 約 0.27 s・露光量ごとの係数 約 0.36 s、native）で 1 s を超えている。
- 主な費用（native、1 層あたり）: 1280 の final の全画素の描画 約 0.15 s（原寸 2048 では約 0.5 s）、その層の cube の焼き直し（cube P・Q 各 約 0.1 s）、露光量の層は niho-6 の解析（露光量ごと 約 0.36 s）と master（原寸 約 0.05 s）、局所階調の層は局所階調の pass（1280 で 約 0.1 s）、RAW の層は自分の master と（統計が設定に依るので）局所階調の pass。
- memory（wasm の最大）: マスク無し 187〜192 MiB に対し、3 枚で 253〜390 MiB（自分の master を持つ層が多いほど大きい）。1 層あたり、結果 2 枚（quality ごと）・面（4 byte/画素）と、自分の画像を描く層は表示寸法の master・局所階調の pass を持つ。色ポイントが有効なら、その面（24 byte/画素。2048×1365 で約 64 MiB）も層ごとに持つ。

この PR で入れた対策: 層ごとのキャッシュの入れ替えと結果の使い回し（`R0` と各層・quality ごと）、`R0` と同じ画像を描く層の master・縮小・窓・統計・局所階調の pass の共有、面が全部 0 の層・`L` が全体と同じ層を描かない、面の使い回し（形だけを動かす間は描画しない）、niho-6 の解析を露光量が同じなら final でも使い回す（共有の 1 枠を層と取り合わない）、離した final の前に `R0` の master をその描画のものにそろえる、離した final の原寸の master を層に持たせない。

目安に届かない所の次の対策（提案。どれもこの PR の外の、描画の経路の変更が要る）:

1. **層を面の外接矩形の中だけ描く**: `R_k` が要るのは `w_k > 0` の画素だけ。出力の部分矩形を描く口（効果の位置と局所階調の pass の key は全体の枠のまま）を足すと、小さい円形の層は数分の 1、半分を覆う線形は約半分になる（全体の drag・初回 final・原寸 final のすべてに効く）。
2. **cube だけが違う層を `R0` と同じ走査で描く**: 頭の段と局所階調の pass は 1 回、末尾の cube の段だけを層ごとに通す（「cube のみ」の層の 1 層あたりの費用が全画素の描画から末尾の段だけになる）。
3. 全体のスライダーの drag 中だけ層を縮めて描く、または前の差分を使う（見え方が変わるので owner の判断が要る）。

## 対象外（今回）

範囲マスク（輝度・色・深度）、マスクの不透明度、マスクごとのカーブ・カラーグレーディング・シャープ・ノイズ（#32 の後）、順序で結果が変わる重ね方、ブラシの自動なぞり補正。
