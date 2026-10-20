# colorcheck — 色の計測 CLI（Epic #16939 S9 / #16972）

NIHO 現像エンジンの段 1（土台）の色を **数値（ΔE00）で追い込む** ための共通の計測基盤。参照画像（Lightroom の書き出し・カメラ JPEG・ColorChecker の基準値）と NIHO の出力を同じ寸法に揃え、ΔE00 の平均・99 パーセンタイル、露出の差（EV）、彩度の比、白の推定を JSON に出す。追い込みは AI が数値で自動的に行い、owner は `report` の見比べページで要所だけ見る。

- 手順（参照セット・Apple 現像・当てはめ・ColorChecker の撮り方）: `ops/runbooks/photo-color-calibration.md`
- 設計の正: `specs/initiatives/niho-develop-engine.md`「段 1（土台）」
- 補正の当てはめ: `../calibrate/`（`fit_base.py`。同じ色の数学を import する）

## 前提

- `python3` と numpy・Pillow・opencv-python-headless（`import cv2`）。**インストール作業は要らない**（入っている環境でそのまま動く。pip install しない）。
- cv2 が無いと 16bit PNG / TIFF の読み書き、`chart` の自動検出と `--debug` が使えない（8bit の JPEG / PNG どうしの `compare` は numpy だけで動く）。
- 実行は `python3 packages/develop-engine/tools/colorcheck/colorcheck.py <サブコマンド> ...`（どこからでも。`colorcheck.py` が自分のフォルダを import パスに足す）。
- 写真（参照セット・RAW・作業中間物）は hihirohub に置き、**リポジトリに入れない**。リポジトリに置くのは数値の fixture・長辺 480px 以下の見本 JPEG・`report.html` だけ（`packages/develop-engine/fixtures/color/<track>/<camera>/`）。

| 環境変数 | 既定 | 使い道 |
|---|---|---|
| `NIHO_COLOR_REF_ROOT` | `OWNER_DATA_ROOT` | manifest（`preset` と `fit_base.py`）の相対 `reference` の基準。manifest の `referenceRoot` が優先 |
| `NIHO_COLOR_WORK_DIR` | `OWNER_DATA_ROOT` | manifest の相対 `candidate`・`calibration` の基準（`candidateRoot` が優先）。作業中間物の置き場 |

`compare` / `render` / `chart` の `--reference`・`--candidate`・`--image` は渡したパスのまま読む（環境変数で解決しない）。

## サブコマンド

| サブコマンド | すること | 主な出力 |
|---|---|---|
| `compare` | 参照と候補（NIHO の出力）を同じ寸法・位置に揃え、ΔE00・EV 差・彩度比・白を測る | `colorcheck/compare/v1` |
| `render` | 線形の入力を NIHO 表示レンダリングで sRGB にする（png / jpg / 16bit sRGB TIFF） | 画像 |
| `preset` | manifest の組をまとめて `compare` し、プリセットごとに集計して gate `stage1.preset` を判定（診断用 manifest は `--no-gate` で除外可） | `colorcheck/preset/v1`（+ Markdown） |
| `chart` | ColorChecker Classic 24 パッチの ΔE00（自動検出 or 四隅指定） | `colorcheck/chart/v1` |
| `report` | 結果 JSON（混在可）から見比べページ（自己完結の 1 枚 HTML）を作る | HTML |
| `fixture write` / `fixture check` | 数値だけの fixture を書く / 今の結果と照合する（差 0.2 以内と gate） | `colorcheck/fixture/v2` / `colorcheck/fixture-check/v1` |
| `gates` | gate の表を出す（`--results` があれば判定も） | Markdown + JSON |

終了コード: 0 = OK / 1 = `fixture check` が NG・`gates` が fail / 2 = 入力の誤り（ファイルが無い・引数の組み合わせ・`render` の出力失敗や TIFF 用 cv2 の不足） / 3 = `chart` がチャートを見つけられない。

### 代表例

```bash
CC="python3 packages/develop-engine/tools/colorcheck/colorcheck.py"
REF="${NIHO_COLOR_REF_ROOT:-OWNER_DATA_ROOT}"
WK="${NIHO_COLOR_WORK_DIR:-OWNER_DATA_ROOT}"

# 土台の色: Apple の線形出力（校正あり）を NIHO 表示レンダリングして Lightroom 中立書き出しと比べる
$CC compare --reference "$REF/round2/lr-export-photos/p2_P1012822_neutral.jpg" \
  --candidate "$WK/apple-linear/v8/P1012822.tiff" --candidate-space linear-prophoto --render \
  --calibration packages/develop-engine/calibration/panasonic-dc-s5/apple-v1.json --neutral-k 5200 \
  --kind reference --label base/P1012822 --scene P1012822 --normalize-exposure \
  --camera-make Panasonic --camera-model DC-S5 --decoder-version 8 --base-version <校正 JSON の baseVersion> \
  --out "$WK/results/base/P1012822.json" --save-pair "$WK/results/pairs"

# カメラ JPEG との差 / decoderVersion またぎ / カメラ間は --kind を変えるだけ
$CC compare --reference "$WK/camera-jpeg/P1012822.jpg" --candidate ... --kind camera-jpeg --label camjpeg/P1012822 --out ...
$CC compare --reference "$WK/renders/v8/P1012822.png" --candidate "$WK/renders/v7/P1012822.png" --kind version --label decoder-7vs8/P1012822 --out ...

# 線形 → 表示（16bit sRGB TIFF は段 2 の代役 photobench-render への入力に使う）
$CC render --input "$WK/apple-linear/v8/P1012822.tiff" --space linear-prophoto --calibration ... --neutral-k 5200 \
  --long-edge 2560 --out "$WK/base16/P1012822.tif"

# プリセットの近さ（3 本 × 場面）
$CC preset --manifest "$WK/preset/manifest.json" --camera-make Panasonic --camera-model DC-S5 --decoder-version 8 \
  --out "$WK/results/preset.json" --markdown "$WK/results/preset.md" --save-pairs "$WK/results/pairs"

# ColorChecker（光源ごとに 1 枚。--gray-balance の有無で主値が変わるだけで、両方の値は常に出る）
$CC chart --image "$WK/charts/dc-s5-daylight-1.tiff" --space linear-prophoto --illuminant daylight \
  --label chart/dc-s5/daylight --out "$WK/results/chart-daylight.json" --debug "$WK/results/chart-daylight.png"
$CC chart --image ... --corners 812,604,3310,655,3290,2270,790,2215 --illuminant tungsten --gray-balance --out ...

# 見比べページ・fixture・gate
$CC report --results "$WK"/results/*/*.json "$WK"/results/*.json \
  --out packages/develop-engine/fixtures/color/apple/panasonic-dc-s5/report.html --title "DC-S5 × Apple 現像 v1"
$CC fixture write --results ... --out packages/develop-engine/fixtures/color/apple/panasonic-dc-s5/v1.json
$CC fixture check --fixture packages/develop-engine/fixtures/color/apple/panasonic-dc-s5/v1.json --results ... [--tolerance 0.2] [--allow-missing] [--out check.json]
$CC gates --results ...
```

`preset` の manifest（相対パスは `referenceRoot` / `candidateRoot`、無ければ環境変数の既定）:

```json
{
  "referenceRoot": "OWNER_DATA_ROOT",
  "candidateRoot": "OWNER_DATA_ROOT",
  "camera": {"make": "Panasonic", "model": "DC-S5"},
  "decoderVersion": "8",
  "items": [
    {"preset": "bluesky2", "scene": "P1012822", "reference": "round5/lr-export/p5_P1012822_full_bluesky2.jpg",
     "candidate": "preset/bluesky2/P1012822.jpg", "candidateSpace": "srgb"}
  ]
}
```

item には `render`・`ev`・`calibration`・`neutralTemperatureK` も書ける（`compare` の同名オプションと同じ意味）。`scene` を省くと参照のファイル名。結果の名前は `<preset>/<scene>`。

## 結果 JSON の要点

- **compare**（`colorcheck/compare/v1`）: `label`・`comparison`（`--kind`）・`scene`・`preset`・`reference{path,size,bitDepth,icc}`・`candidate{path,space,rendered,ev,calibration,toneCurve}`・`camera`・`decoderVersion`・`baseVersion`・`alignment{scale,dx,dy,corr,peak,method,radial}`・`analysisSize`・`crop`・`blurSigma`・`metrics{deltaE00{mean,p50,p95,p99,max,pixels}（主値）, deltaE00All, deltaE00Edges, deltaE00Unblurred, flatFraction, flatFallback, edgeGradLimit, evDiff, saturationRatio, white{reference,candidate}}`・`normalized`（`--normalize-exposure`）・`samples{reference,candidate}`（`--save-pair`）・`warnings`。
- **preset**（`colorcheck/preset/v1`）: `presets[{preset, scenes, deltaE00Mean, deltaE00P99, worstScene, evDiff, saturationRatio}]`・`items[]`（compare 結果）・`p99Rule: "max-of-scenes"`・`gates`。
- **chart**（`colorcheck/chart/v1`）: `illuminant`・`image{path,size,space,linearSpace}`・`reference{path,name}`・`detection{method, corners, patchCenters, rotationDeg, gapFraction, sampleFraction, grayRampMonotonic, swatches}`・`exposure{method,patch,gain,ev}`・`grayBalance{patches,gains,gainsRelative,space}`・`patches[{index,name,lab_ref,lab_raw,lab_grayBalanced,deltaE00_raw,deltaE00_grayBalanced,rgbLinear,pixels,clipped,uniformity}]`・`summary{primary, raw{mean,p95,max,median,worst}, grayBalanced{...}}`・`warnings`・`debugImage`。
- **fixture**（`colorcheck/fixture/v2`）: `camera`・`decoderVersion`・`baseVersion`・`counts`・`entries[{label, kind, deltaE00{mean,...}, ...}]`・`gates`。**画像のパスと画素は入れない**。
- **fixture check**（`colorcheck/fixture-check/v1`）: `ok`・`compared[{key,kind,fixtureMean,currentMean,diff,ok}]`・`missing`・`extra`・`gates{ok,fixtureOverall,currentOverall,rows[]}`。

## 数値の意味

- **ΔE00**: CIEDE2000（Sharma, Wu, Dalal 2005）。Lab は D50: 8bit sRGB → 逆ガンマ（IEC 61966-2-1）→ Bradford 済みの sRGB→XYZ(D50) 行列 → Lab。線形 ProPhoto は ROMM の行列で XYZ(D50) へ。
- **揃え方（compare）**: 参照と候補を線形光の面積平均で長辺 1500px（`--size`）に揃える → 帯域通過した log 輝度の位相相関で倍率（0.96〜1.04）と位置（各辺 ±3%）を推定（5×5 タイルの局所ずれに相似変換を最小二乗で当てる。最大 4 回）→ 残った放射状の歪み（2 つのレンズ補正の違い）を 7×7 タイルで当てる（残差を 25% 以上減らし、ずれが長辺の 3% 以内のときだけ採る。`alignment.radial`）→ 候補を参照の枠へ双線形で再標本化 → 両方を線形光で Gaussian **σ2px（1500px 換算、`--blur`）** でぼかす（候補ははみ出しを除いた正規化畳み込み）→ 周囲 4% を切る → 画素ごとに ΔE00。
- **主値（`deltaE00`）= ぼかし後・平坦な画素**: どちらかの画像（ぼかし後）で |∇L*| > 1.5 / px の輪郭とその周り 2px を除く（位置合わせの 1px 未満の残りが輪郭に大きな ΔE00 を立てるが、色の再現とは関係ないため）。平坦な画素が 5% 未満なら全画素に戻す（`flatFallback`）。全画素は `deltaE00All`、輪郭だけは `deltaE00Edges`、ぼかし無しは `deltaE00Unblurred` に参考として残す。`flatFraction` = 主値に使った画素の割合。
- **mean / p99**: 画素の ΔE00 の平均と 99 パーセンタイル（p50・p95・max も出す）。
- **EV 差**: 参照（ぼかし後）の Y が 0.02〜0.8 の平坦な画素で、median Y（NIHO）/ median Y（参照）の log2。＋は NIHO が明るい。
- **彩度比**: 参照の C*ab > 5 の平坦な画素で、mean C*（NIHO）/ mean C*（参照）。1 より大きいと NIHO が鮮やか。
- **白の推定**: それぞれの画像で L* > 40 かつ C* < 8 の平坦な画素の平均 a*・b*（と、その画素の割合）。参照と NIHO の白の向きを比べる。
- **露出合わせ後**（`--normalize-exposure`）: `--render` のときはトーンカーブの前の EV を二分探索で合わせる（`pre-tone-ev`・`evOffset`）。それ以外は表示の線形値に倍率を掛ける（`display-linear-gain`・`gain`）。
- **preset の集計**: プリセットの mean = 場面ごとの mean の平均、p99 = 場面ごとの p99 の最大。
- **位置合わせの相関**（`alignment.corr`）: 合わせた後の帯域通過 log 輝度の正規化相互相関。0.3 未満は warning（別の場面・向き違い）。

### chart（ColorChecker Classic 24）

- **四隅の約束**: 1 点目 = 1 番 dark skin の外側の角、そこから **時計回り**（6 番・24 番・19 番の外角）。単位は colorcheck が読んだ向きの画像 px（JPEG は EXIF の向きを反映、TIFF はそのまま）。反時計回りに渡したら並べ替えて warning。`--debug x.png` に四角（紫）・計測範囲（緑）・番号・1 点目（赤丸）を描くので、それで確かめる。
- **自動検出**: 長辺 1600px の複製で、適応二値化 → 輪郭 → 正方形に近い凸の塊 → 同じ大きさで 1 ピッチ離れた塊の格子 → RANSAC の射影変換 → 6×4 の並びを 90° ずつの向きで試す。**灰色スケール（19→24）が暗くなっていき、計測範囲が均一な並び** だけを認め、その中で白合わせ後の ΔE00 が最小の並びと向きを採る。台形・回転（90°・180° も）はそのまま扱える。目安としてチャート（パッチの並び）の幅が画面の長辺の 1/20 以上、パッチの間に黒い枠があること。見つからなければ終了コード 3 → `--corners` を渡す。
- **計測**: パッチの辺の中央 40% の正方形（パッチ間の黒い隙間はピッチの 12% とみなす）に入る原寸の全画素を、線形光で平均する。
- **raw**: `--space srgb` は表示済みの値としてそのまま Lab にする（露出も白も合わせない）。`linear-srgb` / `linear-prophoto` は **表示レンダリング（トーンカーブ）を通さず、線形の値から直接 Lab にする**。その前に 1 つの倍率でパッチ 19 の Y を基準値の Y に合わせる（19 が白飛びなら次の灰色パッチ）。
- **白合わせ後（grayBalanced）**: 灰色スケール 19〜24（白飛びしたパッチを除く）が基準値の中性色に合う RGB 各チャンネルの倍率を最小二乗で求めて掛ける。明るさの基準は raw と同じ（線形 = パッチ 19 の Y が基準値、sRGB = そのまま）なので、raw との違いは白だけ。`grayBalance.gainsRelative` が白の倍率（G = 1）。
- **sRGB の画像の注意**: 18 番 cyan は sRGB の色域外（基準値を線形 sRGB にすると R < 0）なので、完全に描けていても sRGB 8bit では ΔE00 ≈ 3.4 残る。土台の精度は線形 ProPhoto の出力（`--space linear-prophoto`）で測る。
- warning: 白飛びしたパッチ、灰色スケールが暗くなっていかない（四隅の順番・向き違い）、計測範囲が均一でない、計測範囲が画像の外、計測画素が 25 未満。

### 主指標は輪郭を除いた平坦画素・位置合わせは放射歪みの残差まで（2026-09-28 追記）

- `metrics.deltaE00`（主値）は、ぼかし後の参照・候補どちらかで L* の勾配が 1.5/px を超える画素と、その周囲 2px を除いた**平坦な画素**で取る。全画素の値は `deltaE00All`、輪郭だけは `deltaE00Edges`、平坦画素の割合は `flatFraction`（DC-S5 の実写で約 0.6）。平坦画素が 5% 未満なら全画素に戻して `flatFallback: true`。理由: Apple のレンズ補正と Lightroom が使うカメラ内蔵の歪み補正は一致せず、サブピクセルの位置ずれでも輪郭には 10 を超える ΔE00 が乗り、それは色の差ではないため。
- 位置合わせは倍率・平行移動（5×5 タイル）のあとに、7×7 タイルの局所ずれから放射方向の残差 `r(p) = (k1 ρ² + k2 ρ⁴)(p − c)` を当てて補正する（`alignment.radial` に k・残差 px の前後・タイル数を残す。改善が 25% 未満なら使わない）。DC-S5 の屋内場面（周辺 8〜14px のずれ）で残差は 4.4px → 1.8px。

## gate（`gates.py` と同じ。`colorcheck gates` でも表示）

| id | 段階 | 内容 | 基準 | 扱い | 補足 |
|---|---:|---|---|---|---|
| `stage1.preset` | 1 | 必須プリセットの近さ（bluesky2・pastel・colorful） | mean ≤ 3.0・p99 ≤ 8.0 | 必須分の不合格で止める | 任意プリセットの失敗は詳細に残すが gate は止めない。mean = 場面ごとの mean の平均、p99 = 場面ごとの p99 の最大 |
| `stage1.cameraJpeg` | 1 | カメラ JPEG との差（目安） | mean ≤ 4.0 | 目安（warn） | 目安。超えたら warn（不合格にはしない） |
| `stage1.versionDrift` | 1 | decoderVersion・baseVersion またぎの差 | mean ≤ 0.5 | 不合格で止める | 新旧の NIHO 出力どうしを compare --kind version で比べた mean |
| `stage2.chart` | 2 | チャート ΔE00（光源 2 つとも） | mean ≤ 2.0・max ≤ 5.0 | 不合格で止める | chart の primary 値（--gray-balance 指定時は白合わせ後） |
| `stage2.crossCamera` | 2 | カメラ間の差 | mean ≤ 2.0 | 不合格で止める | 同じ場面の別カメラの NIHO 出力どうしを compare --kind cross-camera で比べた mean |

判定は `pass` / `fail` / `warn`（目安超え）/ `incomplete`（必須プリセットが欠けている・光源のラベルが 2 種類未満）/ `not-evaluated`（対象の結果が無い）。全体は止める gate に fail があれば fail、incomplete があれば incomplete。ΔE00 はすべてぼかし後の主値。

## 方針

- 合わせ込みで動かすのは **NIHO 側の係数だけ**（白保存の 3×3 行列・`baselineEV`・任意の小さな HueSat 表。`../calibrate/`）。**Adobe の LUT・プロファイル・DCP の数値は写さない**。Lightroom の書き出しは「目標の画像」としてだけ使う。
- 比較用の表示レンダリングは S8 で NIHO のルックが入るまでの暫定（ACR3 既定カーブの形を RGBTone で当てる）。
- テストは合成データだけ（写真の画素をリポジトリに置かない）。

## データの出典

- `colorcheck/data/acr3_default_tone_curve.json`: Adobe DNG SDK 1.4 `dng_render.cpp` の `dng_tone_curve_acr3_default`（`kTable`、1025 点。DNG SDK のライセンスの範囲で使用）。RawTherapee `rtengine/dcp.cc` の `adobe_camera_raw_default_curve` と同値。
- `colorcheck/data/colorchecker_classic_after_nov2014_lab_d50.json`: X-Rite の 2014 年 11 月以降に作られた ColorChecker Classic の基準値（CIELAB・D50・2° 視野）。colour-science（BSD-3-Clause）の `DATA_COLORCHECKER24_AFTER_NOV2014_CIE_LAB` 経由。Calibrite ColorChecker Passport Photo 2 の 24 色面も同じ。実物のチャートは 1 枚ごとに ΔE00 1〜2 のばらつきがあるので、1 未満の差はノイズとみなす。

## テスト

```bash
cd packages/develop-engine/tools/colorcheck && python3 -m unittest discover -s tests -t .
```

87 件。画像は合成だけ（`tests/synth.py` の場面、`tests/chart_synth.py` の ColorChecker）。

## 決めたこと

既存コードの決め事も含めて、ここを正とする（変えるときはこの節も直す）。

- **解析の寸法とぼかし**: 長辺 1500px（入力が小さければその長辺に下げて warning）、σ = 2px × 長辺 / 1500、周囲 4% を切る。主値はぼかし後の平坦な画素（輪郭 |∇L*| > 1.5/px と周り 2px を除く。平坦 < 5% なら全画素）。
- **位置合わせ**: 倍率 0.96〜1.04・位置 ±3%。タイルの山が弱い（< 0.04）ものや残差 > 1.5px のものは捨て、使えるタイルが 5 未満なら倍率の格子探索（0.002 刻み）に落とす。放射状の歪みは 12 タイル以上で当て、残差を 25% 以上減らし長辺の 3% 以内のときだけ採る。`--no-align` は寸法だけ合わせる。
- **読み込み**: JPEG と 8bit PNG は Pillow（EXIF の向きを反映、sRGB 以外の ICC は sRGB に変換）、16bit PNG / TIFF は cv2（向きはそのまま、alpha は捨てる）、float TIFF は値のまま。浮動小数点の参照は sRGB 符号化とみなして warning。
- **`--render`**: 線形の候補（`linear-srgb` / `linear-prophoto`）だけ。`--calibration`・`--ev` は `--render` のときだけ効く（それ以外は warning で無視）。トーンカーブの既定は ACR3 既定カーブ。`render --format` は `--out` の拡張子と一致させる（png ↔ `.png`、jpg ↔ `.jpg` / `.jpeg`、tif16-srgb ↔ `.tif` / `.tiff`）。TIFF 書き込みの cv2 不足や画像書き込みエラーは終了コード 2 で返す。
- **見本 JPEG**: 長辺 480px・品質 80、名前は `<label（無ければ候補のファイル名）>_ref.jpg` / `_niho.jpg`（英数字と `._-` 以外は `_`）。位置合わせで候補がはみ出した画素は灰 128。`preset --save-pairs` はプリセットごとのサブフォルダに書く。
- **preset**: プリセットの mean = 場面 mean の平均、p99 = 場面 p99 の最大（`p99Rule: max-of-scenes`）。同じプリセットが複数の結果にあるときは後の結果を使う。CLI の `--camera-*`・`--decoder-version`・`--base-version` は manifest の値より優先。
- **chart の色**: 線形入力は表示レンダリングを通さず Lab に直接落とす（段階 2 は「測色の正しさ」を見る gate で、トーンカーブの見た目を混ぜないため）。露出の基準はパッチ 19（白飛びなら次の灰色）。白飛び = 整数データで最大値の画素、または 1.0 で頭打ちの float で 99.9% 以上の画素が 1% を超えるパッチ（露出の基準と白の推定に使わない）。
- **chart の白合わせ**: 常に raw と grayBalanced の両方を出し、`--gray-balance` は主値（`summary.primary`、gate が使う値）を選ぶだけ。倍率は灰色スケールの絶対値の最小二乗なので明るいパッチほど効く（黒 24 のノイズ・フレアに引っ張られない）。
- **chart の形**: 計測はパッチの辺の中央 40%、黒い隙間はピッチの 12% とみなす。自動検出の四隅もこの約束で出す（実物の隙間が違っても計測位置のずれはピッチの数 % で、計測範囲の外には出ない）。
- **report**: 外部アセット無しの 1 枚 HTML（CSS はインライン、色チップは style）。見本画像は HTML からの相対パスで参照し、**HTML の隣の `samples/` に同じファイル名があればそちらを使う**（runbook の fixtures 配置。HTML と `samples/` を一緒に動かせる）。無ければ結果 JSON に書かれたパス（相対なら結果 JSON のフォルダ基準）。見本が無い結果は数値だけ。引数は増やさない。
- **fixture**: key は compare の `label`（無ければ `<kind>/<scene>`）、preset の各組は `<preset>/<scene>`、プリセットの集計は `preset:<name>`、chart は `label`（無ければ `chart/<illuminant>/<画像名>`）。重なった key は `#2`・`#3` を付ける。上の `camera`・`decoderVersion`・`baseVersion` は最頻値で、違う entry だけ entry にも書く。gate の詳細の key も fixture の key に置き換える（パスを残さない）。
- **fixture check**: 同じ key の mean ΔE00 の差が ±tolerance（既定 0.2）以内。**改善も差として数える**（数値が変わったら fixture を書き直して版を上げる）。fixture にだけある key は `--allow-missing` が無ければ NG。結果にだけある key は判定に使わない。gate は `pass < warn < incomplete = not-evaluated < fail` の順で悪くなったら NG（`--allow-missing` のときは incomplete / not-evaluated への変化は許す）。
- **gate の光源**: `stage2.chart` は `--illuminant` のラベル（文字列）が 2 種類以上で揃ったとき判定する。

## 注意・未対応

- chart の自動検出は合成画像でしか確かめていない。実物の写真で外れたら `--corners` と `--debug` で合わせる。
- report は `samples/` の見本をファイル名で探すので、古い同名ファイルが残っているとそれを出す（fixtures の `samples/` は版ごとに入れ替える）。
