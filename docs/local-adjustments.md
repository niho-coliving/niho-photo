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
- 正規形（`to_value` / `writeDevelopMasks`）: キー順は上の例の順（`id` `kind` `enabled`（`false` のときだけ）`invert`（`true` のときだけ）、種類のキー、`adjust`）。`adjust` は 0 の項目を書かない。TypeScript は数値を小数 6 桁に丸めて書く。
- 設定全体の上限（Rust の 64 KiB・下書きの 32 KiB）に面の画素は入れない。ブラシ・被写体・空は `surface` で参照するだけにし、undo の 100 版にも面を載せない。

## 座標

マスクは**作業画像**（EXIF の向きを反映済み・`geometry` の回転／反転／角度補正／切り抜きの前）の上に置く。`x` `y` は作業画像の幅・高さに対する 0〜1（y は下向き）。切り抜き・回転・反転を変えても、マスクは画像の内容に付いたまま動く。

描画は出力の画素 `(i, j)` の中心を、切り抜き（`geometry.rs` の座標・`frame.rs` の plan）で作業画像の位置 `(u, v)` に戻して面を評価する。TypeScript の `geometryOutputToSource` と同じ写像で、Rust と TS は同じ fixture で突き合わせる。

形の計算は、作業画像の幅 `Ws` と高さ `Hs`（縮めて読んだ場合も元の寸法）から `A = Ws / Hs` を取り、長さの単位を高さにそろえた座標 `X = u·A, Y = v` で行う。円形が回しても楕円のままで、縦横比に引き延ばされない。

## 面の式

画素ごとの面の値 `m`（0〜1、f32）。画素ごとの計算は IEEE 754 の `+ − × ÷ sqrt` だけで、三角関数などは**マスク 1 枚につき 1 回**（libm）求めて使う。native と wasm で同じ結果にするためで、`fastmath` や FMA は使わない。

- 線形: `Z = (zero.x·A, zero.y)`、`F = (full.x·A, full.y)`、`d = F − Z`、`t = ((X − Z.x)·d.x + (Y − Z.y)·d.y) / (d.x² + d.y²)`、`m = clamp(t, 0, 1)`。
- 円形: 中心 `c = (center.x·A, center.y)`、半軸 `a = radius.x·A`、`b = radius.y`、`θ = angle`（時計回り）。`(dx, dy) = (X − c.x, Y − c.y)`、`p = (dx·cosθ + dy·sinθ, −dx·sinθ + dy·cosθ)`、`r = sqrt((p.x/a)² + (p.y/b)²)`、`f = feather/100`、`s = clamp((1 − r) / max(f, 0.002), 0, 1)`、`m = s²(3 − 2s)`。`feather = 0` は縁だけ約 1 画素でなじませた硬い縁、`100` は中心 1・縁 0。
- 面（ブラシ・被写体・空）: `surface` の PNG（8bit グレー。値 `/255`）を、作業画像全体に重ねて双一次補間する。標本位置は `(u·width − 0.5, v·height − 0.5)`、端は端の値で延ばす。
- `invert` は最後に `m ← 1 − m`。

## 局所の補正

局所の設定 `L` は、全体の設定に `adjust` を足したもの。各キーは `clamp(全体 + 差分, 全体の範囲)`、`hsl` は項目ごとに足して ±100 に収める。それ以外（`engine` `look` `base` `geometry` 曲線・キャリブレーション・カラーグレーディング・色ポイント・効果）は全体と同じで、`masks` だけを除く。

- 相対 WB: 全体の WB が `relative` ならそのまま足す。`asShot` なら `relative` にして差分だけを入れる。`absolute` のときに `relativeTemperature` / `relativeTint` の差分が 0 でないマスクは設定として拒む（`localWhiteBalance`。UI は `absolute` の間このスライダーを出さない）。
- 差分を足しても `L` が全体と同じになるマスク、`enabled: false`、面が全部 0 のマスクは描かない（追加の描画をしない）。

## 描画と混ぜ方

1. 全体の結果 `R0` を、これまでと同じ経路で描く（`masks` を除いた設定）。
2. 描くマスクごとに `L_k` を描いて `R_k` を得る。`R_k` は `R0` と同じ寸法・同じ quality（drag 中は両方 interactive、離したら両方 final）。層ごとの描画は source を共有する別の Session で行い、設定が変わらない層の結果は使い回す。
3. マスクの面を出力と同じ寸法で作り、重み `w_k = floor(m·65536 + 0.5)`（0〜65536）にする。
4. 8bit sRGB の各チャンネルを固定小数点で合算する。

   `out = clamp(R0 + Σ_k ((R_k − R0)·w_k + 32768) >> 16, 0, 255)`（整数。`>>` は算術右シフト。alpha は 255）

マスク 1 枚で `m = 1` なら `out = R_k`、`m = 0` なら `R0` に一致する。合算は項の順序に依らないので、配列の順で画が変わらない。重なったマスクは差分が足される（それぞれの補正が重なる）。

`masks` の無い設定の描画は、これまでと 1 bit も変えない（`Session` の経路にも追加のコストを入れない）。

## 面の受け渡し

- 面は PNG（8bit グレー・1〜4096 画素・8 MiB 以下）の**内容の sha256** で呼ぶ不変のファイルで、同じ `id` の中身は変わらない。エンジンは受け取るときに sha256 と寸法を `surface` と照合し、合わなければ拒む。
- `Session::set_mask_surface(id, png)` / `drop_mask_surface(id)`、wasm の `Developer.setMaskSurface(id, png)` / `dropMaskSurface(id)`、書き出しの CLI の `--mask-surface <id>=<path>`（繰り返し可）が同じ口。設定が参照する面が無いときは、無言で飛ばさず `maskSurfaceMissing` で失敗する。
- 保存先は M4（Mac は写真の隣のローカル保存、クラウドの写真は非公開側）。

## 版と互換

- `masks` に 1 枚でもあれば `v` を要求する（今の最大は `COLOR_POINTS_SETTINGS_VERSION = 4`。`detail`（#32）と競合したら、先に merge された側が次の番号になる）。古い reader は `v` が未知のため設定を補正なしとして読み替えず、閲覧のみにする。
- 能力の問い合わせ: wasm は `colorPoints` と同じ probe（`acceptsMaskSettings`）で `masks` を出す。Mac の書き出しは sidecar の最小版を超えているときだけ `masks` 付きの設定を渡す。
- 取り扱い: 「初期化」とプリセット適用前の比較は `masks` を除く。プリセット（XMP）の適用・自動補正・設定のコピーは対象の `masks` を変えない（コピー元の `masks` も持ち出さない）。旧形式への変換 (`developSettingsToEditSettings`) は `masks` が有効なら null。XMP の書き出しは `masks` を書かず `notWritten: ["masks"]` を返す。

## 性能の目安と測り方

drag 100ms／final 1 秒（マスク 3 枚まで）が目安。層は枚数 + 1 回の描画になるため、M2 で次を実測して記録する（合成 2048×1365・wasm・Studio）。

- マスク 0 / 1 / 2 / 3 枚の、drag（1280）と final の描画時間
- 1 枚の補正だけを動かすときは、他の層を再描画しない（層の結果の使い回し）
- 局所階調（texture / clarity / highlights / shadows）を使う層とそうでない層の差

目安に届かない箇所は、原因と段の共有などの対策を M2 の PR に書く。

## 対象外（今回）

範囲マスク（輝度・色・深度）、マスクの不透明度、マスクごとのカーブ・カラーグレーディング・シャープ・ノイズ（#32 の後）、順序で結果が変わる重ね方、ブラシの自動なぞり補正。
