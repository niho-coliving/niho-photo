# 色ミキサー（developSettings v4）

Issue #30 の色ミキサーは、従来の HSL、彩度、自然な彩度の式を置き換えない独立した補正である。保存済みの v1〜v3 と `colorPoints` の無い設定は従来と同じ演算・cube 精度で描く。

## 保存形

`developSettings.colorPoints` は最大 8 点の配列で、点が 1 つでもあれば `v` は 4 とする。空配列は点なしと同じで v4 を要求しない。v4 を知らない reader は設定を補正なしとして読み替えず、閲覧のみにする。

```json
{
  "v": 4,
  "colorPoints": [
    {
      "id": "color-mh0",
      "target": { "lightness": 0.72, "chroma": 0.08, "hue": 50 },
      "range": { "hue": 30, "chroma": 0.08, "lightness": 0.15 },
      "delta": { "hue": 10, "chromaScale": 1.1, "lightness": 0 }
    }
  ]
}
```

- `id`: 1〜64 byte の ASCII、配列内で一意。
- `target`: `lightness` 0〜1、`chroma` 0〜5、`hue` 0以上360未満。
- `range`: `hue` 1〜180、`chroma` 0.001〜5、`lightness` 0.001〜1。
- `delta`: `hue` -180〜180、`chromaScale` 0〜3（1が無変更）、`lightness` -1〜1。
- 点・各入れ子は上記のキーだけを持つ厳密な形とし、欠落、未知キー、非有限値、範囲外、重複 id、9点以上を Rust と TypeScript の双方で拒む。

## 描画

色段 Q は従来の `Vibrance → Saturation → HSL → niho-10/11 の色相補正` の後、Color Grading の前に色ミキサーを適用する。入力の linear ProPhoto を linear sRGB 経由で OKLab/Oklch にし、各点の hue/chroma/lightness の距離を元の Lab だけから求める。軸ごとの範囲内を smoothstep でフェードし、3軸の積をその点の weight とする。無彩色付近は hue を選択条件にせず、未定義の角度で点が消えないようにする。

土台の niho-10/11 は #28 の全量色相補正をそのまま使う。数値 probe の最大色相誤差は新式 0.000437°、旧式 10.491901°。Lightroom 比較は blue が 0.581062 から 0.559696 へ改善した一方、orange は 0.693452 から 0.850291 へ悪化した。全体彩度の平均 ΔE00 も S+50 は 1.518304 から 1.744041（+0.225737）、S+100 は 2.118434 から 2.478075（+0.359641）へ悪化している。全量色相補正という契約は維持するが、Lightroom 全体への改善とは扱わない。

2026-10-20 のオーナー方針に従い、新式では Lightroom の副作用との一致よりも、意図した軸だけを動かす長期的な品質を優先する。保存済みの旧 engine は従来の描画を維持する。上記は HSL の実写8場面と全体彩度の計測チャートの比較であり、プリセット3本全体の再比較は未実施である。

数式の後で色段 Q の格子値を8bitへ丸めると、64³の補間後でも最大2.251875°のずれが残った。niho-10 の Q は float 格子値を使い、同じ sweep で1.571977°に抑える。旧 engine の精度は変更しない。上の Lightroom 数値はこの精度修正前の測定であり、最終コミットで再計測する。

重なった点は、全点の weight と差分を先に集計する。weight 合計が 1 を超えるときだけ 1 へ正規化し、Δh、`C × (1 + Δscale)`、ΔL を一度に適用する。このため配列順で画が変わらず、重なりで補正が過剰に倍加しない。結果はこの段で gamut clamp せず、既存の出力変換へ渡す。非有限な中間値は入力色を返し、zero range は weight 0 とする防御を持つ（保存値としての zero range は拒否する）。空配列と全点の `delta={hue:0,chromaScale:1,lightness:0}` は画素を変えない。

有効な差分を持つ `colorPoints` では、色段 Q を「従来式から point 選択入力までの float cube」と「point と Color Grading の画素単位 exact tail」に分ける。従来の 8-bit entry は小さい C 変化に対して 2% を超える量子化誤差になり得て、1° / 0.001 の範囲は64³の格子点を一つも含まない場合があるためである。drag 中も近似 tail を使わず同じ exact point tailを通す。点なしと全点ゼロ差分は既存の 8-bit/float 分岐を一切変えない。cube key は canonical `colorPoints` を含み、drag/final の双方で同じ点を適用する。

## 色を拾う操作とプリセット

picker は表示 canvas の `getBoundingClientRect()` から 0〜1 の描画座標へ換算し、Session/Wasm/Worker の `sampleColor` で通常描画と同じ source・geometry・local pass・cube を通した Stage Q の float Oklch を得る。採取位置は niho-10/11 色相補正の後、既存 `colorPoints` と Color Grading と出力変換の前であり、Canvas の 8-bit sRGB を逆変換しない。保存契約外の HDR/負値・非有限値は clamp せずエラーにする。写真や設定の世代、プリセット、補正前比較、crop/cutout、preview pending が変わった非同期結果は破棄する。表示中の crosshair は矢印キー（Shift で大きく移動）で動かし、Enter/Space で確定、Esc で取消す。

Adobe `crs:PointColors` は非公開形式のため、属性・入れ子・point-only XMP のいずれでも「使えない項目」として報告し、読み書きや推測変換をしない。XMP preset を適用しても NIHO の `colorPoints` は保持する。NIHO 点を補間する場合は id ごとに数値を線形補間し、target hue だけ最短角を使う。0% は base と完全一致する。XMP 書き出しは `PointColors` を捏造せず、`notWritten: ["colorPoints"]` を利用者へ返す。
