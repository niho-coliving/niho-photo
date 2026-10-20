# apple-raw-linear

macOS の Core Image `CIRAWFilter` で RAW を **線形（`boostAmount 0`）・`decoderVersion` 固定・撮影時の白** で現像し、linear ProPhoto（D50）または linear sRGB の画像と JSON メタデータを書き出す小さな CLI。写真編集 Epic #16939 の土台 A（S9a #16975）の中核で、計測（S9 #16972）と、段 2 の crate（niho-develop）が読む**作業コピー**（旧 `png16-g18`、または 0.5.0 の opt-in `png16-signed-g18` ＋ `--working-copy-meta`）の生成に使う。0.4.2 からはラスタ（HEIC / HEIF・TIFF・PNG・JPEG）の作業コピー（ICC 付き 8bit JPEG）とプレビューも `raster` で書き、0.5.2 では原寸書き出しを追加した（K5 #17153・下の「ラスタの作業コピー」）。設計の正は `specs/initiatives/niho-develop-engine.md`「段 1（土台）」、手順は `ops/runbooks/photo-color-calibration.md`。

- 移植元: Photo Bench の macOS 経路（`Sources/PhotoCore/CoreImageDecoder.swift` の `calibrationBaseline`）。同じ設定値を使う。
- **macOS 14 以上・Apple 製ハードだけ**で動く。ビルドして配るのはワーカー Mac。CI（`desktop-ci.yml` の `apple-raw-linear Swift tests`・macOS ランナー）は `swift test` だけを回し、実 RAW が要る `render` は走らせない（テストは合成画像で、ランナーの CIRAWFilter には依らない）。依存パッケージなし（SwiftPM、Swift 6）。

## ビルドとテスト

```bash
cd packages/develop-engine/tools/apple-raw-linear
swift build -c release          # .build/release/apple-raw-linear
swift test                      # 行列（白→白・Python 値との一致）・エンコード往復（作業コピーは上限 2.0）・校正 JSON の読込（whiteBalanceMap 付き / 無し）・hueSat 拒否・
                                # uv オフセットと DNG 色温度の Python 値との一致（Fixtures/wb-uv-offset-python.json）・作業コピーのメタ・引数解析・
                                # encode-jpeg / retag-jpeg のメタデータの規則（撮影日時だけ・GPS / カメラ / レンズ / IPTC / XMP / サムネイルが残らない・
                                # 撮影日時が無ければ EXIF 無し・向き 1・画素そのまま・retag のスキャンがバイト一致・--in と --out が同じ・ICC を保つ・
                                # JPEG でない入力と失敗で何も残さない・規則の外を見つける検査）・
                                # DNG の K/tint → xy（wbmodel.xy_from_temperature と 1e-12）・白の行列の表（検証・wbtable.py と同じ補間・自己点検の残差・メタ）
                                # raster（Display P3 の 16bit PNG → ICC がそのまま・EXIF の向き 6 → 正立・ICC 無し PNG / グレー / CMYK → sRGB・
                                # 線形の P3・PQ / HLG → Display P3・色の判定の表・ICC のタグ表の判定（行列＋TRC・ほぼ線形・LUT だけ・壊れた ICC）・
                                # 縮めない・線形の光で縮める（1px の縞 → sRGB 188）・プレビュー（sRGB・1MiB 以下・品質の段）・同じバイト列・
                                # メタデータは ICC だけ・HEIC・失敗で何も残さない・JPEG の区切りの読み書き）
```

## 使い方

```
apple-raw-linear info <raw> [--json] [--decoder-version <n>]
apple-raw-linear cameras [--out <file>]
apple-raw-linear render <raw> --out <file> [--meta <file.json>]
    [--decoder-version <n>] [--allow-fallback]
    [--long-edge <px|full>]                       (default 2560)
    [--space linear-prophoto|linear-srgb]         (default linear-prophoto)
    [--encoding tiff32f|tiff16|png16-g18|png16-signed-g18] (default tiff32f)
    [--calibration <json> | --calibration-registry <registry.json>]
    [--working-copy-meta <file.json>]             (working-copy PNG only)
    [--lens-correction auto|apple|embedded|off]   (default auto; on = apple)
    [--gamut-mapping auto|on|off]                 (default auto)
    [--white <temperatureK>,<tint>]               (default as shot)
    [--boost <0..1>]                              (default 0 = linear)
    [--nr default|off] [--sharpen default|off]    (default default)
apple-raw-linear registry <registry.json>
apple-raw-linear encode-jpeg --pixels <srgb.png> --metadata-from <original> --out <file.jpg> [--quality <0..1>]   (default 0.92)
apple-raw-linear retag-jpeg --in <file.jpg> --out <file.jpg>
apple-raw-linear raster <image> --out <working.jpg> [--preview-out <preview.jpg>] [--meta <file.json>]
    [--long-edge <px|full>]                       (default 2560。full は原寸)
    [--quality <0..1>]                            (default 0.94)
apple-raw-linear version
```

- `info`: カメラの make / model、`supportedDecoderVersions` と既定版、nativeSize、撮影時の白（温度 K・tint・xy）、Apple の既定値（`baselineExposure`・`shadowBias`・ノイズ除去・シャープ・レンズ補正の有無）、`CIRAWFilter.supportedCameraModels` の数。撮影時の白は **info 用の別インスタンス**で読み、描画に使うインスタンスの neutral プロパティは読みも書きもしない（Photo Bench の as-shot 経路と同じ純度）。
- `cameras`: 対応機種を 1 行 1 機種（先頭行は件数）。macOS 27.0 (26A428) では 928 機種。
- `render`: `scaleFactor = min(1, longEdge / nativeLongEdge)` を `outputImage` の前に設定し、Core Image の作業空間 extended linear sRGB（RGBAf）で描いて Float バッファへ取り出し、CPU で行列・校正・エンコードを当てる。
- `render --lens-correction`（S10 #17031）: `apple` = Core Image の補正（歪みだけ。**周辺減光は直さない**）。`embedded` = Core Image の補正を切り、RAW 埋め込みの補正データ（Sony ARW の SubIFD `0x7037 DistortionCorrParams`・`0x7032 VignettingCorrParams`）をこのツールが当てる（`LensCorrection.swift`。周辺減光 → 歪みの順。歪みは節点 r_i = i/(n−1)・倍率 1 + v·2⁻¹⁴ の Catmull-Rom、正規化半径 = 半対角 × `lens.distortionRadiusScale`、枠を満たす倍率を掛け、Catmull-Rom の bicubic で描き直す。周辺減光は 2^−(0.5 − 2^(v·2⁻¹³ − 1)) を半径 × `lens.vignettingRadiusScale` で線形補間）。データの無い RAW は `apple` に戻して `warnings` に書く。`auto`（既定）= 校正 JSON の `lens.mode`、無ければ `apple`。`off` = 補正なし（色の計測で、Lightroom の補正なしの書き出しと幾何を 0.1px で揃えるときに使う。作業コピーでは使わない）。使った補正はツールのメタ `appliedSettings.lensCorrection` と作業コピーのメタ `_source.lensCorrection` に残す。
- `render --encoding png16-g18 --working-copy-meta <file.json>`: 段 2 の crate が読む作業コピー（PNG ＋ メタ JSON）を書く（下の「作業コピー」）。`--meta` を省くとツールのメタは `<out>.meta.json`（`<out>.json` は作業コピーのメタの置き場のため）。
- `render --encoding png16-signed-g18 --nr off --gamut-mapping off`（0.5.0・p3/e4）: signed RAW 作業コピーを明示生成する。Core Image は常に `scaleFactor=1`、レンズ補正と f32 sRGB→ProPhoto は full 解像度、その後に自作 Lanczos4（8 tap・half-pixel・f32 weight・境界複製）で `--long-edge` へ縮小し、校正行列を f32 で別に掛ける。`--long-edge full` は縮小だけを省く。撮影時の白・boost 0・Apple 既定 sharpening・レンズ補正 ON 以外、または `--nr off` / `--gamut-mapping off` の明示が無い呼び出しは描画前に exit 1。既定は切り替えない。
- `render --gamut-mapping auto|on|off`（0.4.2・S11 #17108）: Core Image の `isGamutMappingEnabled`（色域の圧縮）。`auto`（既定）= 校正 JSON の `decoder.settings.gamutMapping` が真偽値ならそれ、無ければ（校正なしも）`on`。既存の校正は `true` なので、省けば 0.4.1 と同じ画素。白の行列の表（下の「白の行列の表」）は `off` のときだけ成り立つ。要求と解決した値はツールのメタ `appliedSettings.gamutMapping`（`requested`・`resolved`・`source`）に残る。
- `render --white <temperatureK>,<tint>`（0.4.2）: 撮影時の白の代わりに、**Lightroom の尺度**（developSettings / XMP の Temperature・Tint）の白で描く（例 `--white 5001,10`・`--white 3200,-15.5`）。受け付けるのは有限な 1000〜100000 K・tint −250〜250（developSettings の 2000〜50000 K・±150 より広い。`calibrate/fit_wb_table.py` が格子の節点を Apple の尺度に移して渡すと 1900 K・tint ±160 あたりに出るため）。それ以外は exit 1。K・tint → xy は DNG の温度モデル（`DNGTemperature.xy` = `dng_temperature::Get_xy_coord`。`wbmodel.xy_from_temperature` と同じ表・式で 1e-12 一致）。ただし参照実装の「2000 K 未満は 2000 K に丸める」は掛けない（Core Image は 1903.25 K・tint 160.04 をそのまま読み返す。丸めると Apple の尺度の節点が別の白になる。1667 K = 600 mired 未満は表の外挿で `warnings` に書く）。校正に `whiteBalanceMap`（`uv-offset`）があれば逆向き（`uv_apple = uv_adobe − (du, dv)`）で Apple の白へ、無ければ xy のまま、描画用インスタンスの `neutralChromaticity` に代入する（`decoderVersion` と他の設定の後、`scaleFactor` の前。`assignmentOrder` に出る）。tint の強い白は色度図の外（x + y > 1。Lightroom の角 2000 K・+150 も）になるが、Core Image はそのまま受け取って同じ K・tint を読み返すので拒否しない。ツールのメタの `renderedWhite`（`temperature`・`tint`・`lightroom {x, y}`・`apple {x, y}`・`mapApplied`）と、描画後に読み戻した `appliedSettings.effective` の `neutralChromaticity`・`neutralTemperature`・`neutralTint`（`--white` のときだけ）で効いたか確かめられる。作業コピーは常に撮影時の白なので、`--white` と `--working-copy-meta` の組み合わせは exit 1。`--white` を省けば描画用インスタンスの neutral は読みも書きもしない（0.4.0 と同じ）。
- `render --calibration-registry <registry.json>`（0.4.0・S4b #17034）: 登録表（`niho-develop-calibration-registry/v1`。例 `packages/develop-engine/calibration/apple-registry.json`）から、RAW の make / model に厳密に合う 1 件の校正を選んで当てる（`--calibration` と一緒には使えない）。合う機種が無ければ校正なし、2 件以上合えば `invalid_calibration`。登録の `file` は登録表のフォルダの中だけ。選んだ登録はツールのメタと作業コピーのメタの `_source.calibration`（`cameraId`・`track`・`registry` を足した）に残る。本番のワーカーはこの形で呼ぶ。選んだ校正の `decoderVersion` はRAWへ実際に適用する版（fallback後）と一致させ、不一致なら描画前に `invalid_calibration` で停止する。登録表の `fallback`（0.5.1・#18398。`{"file": "generic/apple-v1.json"}`）は、機種の行が無い RAW に当てる汎用の補正（`calibrate/fit_generic.py`）で、その校正の `decoderVersion` と同じ RAW の版のときだけ当てる（DNG の `8.DNG` などは校正なしのまま）。signed の作業コピー（`png16-signed-g18`）には当てない。fallback の校正は機種を持たず（`camera.make` / `model` が空、`camera.id` はある）、`lens.mode` は `apple`、色域の圧縮は on、白の写像・白の行列の表を持たない（どれも機種ごとの測定。違えば `invalid_calibration`）ので、レンズ・色域・白は校正なしと同じに決まり、違うのは行列と `baselineEV` だけ。選んだときはメタの `_source.calibration.registry.fallback` が `true`。`registry` の出力には `fallback`（`file`・`id`・`cameraId`・`version`・`decoderVersion`・`lensMode`、無ければ null）が増え、fallback の `camera.id` が機種の行と同じなら `invalid_calibration`。`registry <registry.json>` は登録表と全部の校正を `--calibration` と同じ契約で読み（機種と track の一致・重複・`lens.mode` が apple / embedded。0.4.2 から `whiteBalanceTable` の検証も。各 entry に `whiteBalanceTable: true|false`）、ワーカーが起動時に呼ぶ。Core Image がその RAW のレンズ補正に対応していない（埋め込みデータも無い）ときは描画を止めず、作業コピーのメタの `_source.lensCorrection.mode` を `none`（`reason: unsupported`）にする。0.4.0 から `embedded` の歪みの節点は、枠の倍率 k を掛けた後の半径（|p|·k / (半対角 × `lens.distortionRadiusScale`)）で引く（k は固定点で解く。S10b: 1.01 で ZV-E10 II の 16〜49mm と FX30 ＋ 16-55mm G の 16・55mm が Lightroom と 0.1〜0.3px。以前の |p| / R だと最適な倍率が焦点距離で変わった。ZV-E10 II の校正は `apple-v2`。`tools/lens-check/README.md`）。また、作業コピー（`--working-copy-meta`）でレンズ補正が `off` になる呼び出し（`--lens-correction off`、または校正の `lens.mode: off`）は描く前に exit 1（`invalid_arguments`）で止める。`off` は `tiff32f` などの計測用だけ。`embedded` 以外の組み合わせの画素は 0.3.0 と同じ。
- `encode-jpeg`（0.4.1・S7c-1 #16946）: 原寸の書き出しの JPEG を書く。`retag-jpeg`（W2b-1 #17145）: 書き出し済みの JPEG のメタデータを同じ規則に、再符号化せずに差し替える（どちらも下の「原寸の書き出しの JPEG」）。
- `raster`（0.4.3・K5-c1 #17153）: ラスタの作業コピー（ICC 付き 8bit JPEG）とプレビュー（sRGB の JPEG）を書く（下の「ラスタの作業コピー」）。
- エラーは stdout に 1 行 JSON `{"error":"<code>","message":"..."}`。終了コード: 0 ok / 1 invalid_arguments / 2 `unsupported_camera`（`CIRAWFilter` が開けない・出力が無い・作業コピーなのに撮影時の白が読めない） / 3 `unsupported_decoder_version`・`unsupported_calibration_feature`・`unsupported_profile`（`raster`: 色空間が無い・sRGB / Display P3 に変換できない色モデル） / 4 入出力エラー（`input_not_found`・`read_failed`・`invalid_calibration`・`write_failed`、`raster` の `decode_failed`（ImageIO が画像として読めない・0 画素）・`encode_failed`（JPEG にできない・プレビューが 1MiB に収まらない））。

## 出力の契約

| 項目 | 値 |
|---|---|
| 現像の設定 | `decoderVersion` 固定（既定 8。RAW ごとに `supportedDecoderVersions` を確かめ、無ければ exit 3。`--allow-fallback` で filter の既定版を使いメタに記録）、`boostAmount 0`・`boostShadowAmount 1`・`exposure 0`・`shadowBias 0`・`extendedDynamicRangeAmount 0`・`isGamutMappingEnabled`（`--gamut-mapping`。既定 `auto` = 校正の `decoder.settings.gamutMapping`、無ければ true）・`isDraftModeEnabled false`・`localToneMapAmount 0`・`contrastAmount 0`・撮影時の白（`--white` のときだけその白） |
| ノイズ除去・シャープ | 当面 Apple の既定（ISO で変わりうる）。実効値をメタ JSON `appliedSettings` に残す。`--nr off` / `--sharpen off` で 0 |
| 色空間 | Apple の extended linear sRGB（D65、撮影時の白で中性化済み）を `inv(M_prophoto_to_xyz_d50) · M_srgb_to_xyz_d50`（Lindbloom・Bradford）で linear ProPhoto（D50）へ。**0 未満・1 超はクリップしない**（`tiff32f`） |
| `tiff32f` | 32bit float RGB・非圧縮・クリップなし。計測用。cv2 の `imread(..., IMREAD_UNCHANGED)` で float32 3ch が値のまま読める。ICC は「linear ProPhoto（ROMM 原色・D50・gamma 1.0）」を付ける |
| `tiff16` | [0,1] クリップの線形 16bit |
| `png16-g18` | **段 2 の作業コピー**（crate `decode.rs` の契約。下の「作業コピー」）: `code = round((clip(x, 0, 2) / 2)^(1/1.8) × 65535)`、値 = `2.0 × (code/65535)^1.8`、ROMM RGB の ICC。校正の**行列だけ**焼き、`2^baselineEV` は焼かない |
| `png16-signed-g18` | **p3/e4 signed 作業コピー（opt-in）**: `ceiling = ceilPower2(max(1,maxAbs))`（上限 65536）、`code = roundToNearestEven(32768 + sign(x) × (abs(x)/ceiling)^(1/1.8) × 32767)`。負値・超白をクリップせず、0→32768、`-ceiling`→1、`+ceiling`→65535。`WorkingCopy.metadata.encoding = {kind:"signed-gamma18-v1",ceiling}`。ICC は内部表現の記述で表示意図ではなく、ビューアの表示は正しくならない |
| 校正 | `--calibration` の `niho-develop-calibration/v1`（`matrix.rowMajor` を作業空間で掛け、`tiff32f` / `tiff16` では `baselineEV` で `× 2^EV`。`png16-g18` は EV を焼かずメタで渡す。`illuminants` があれば撮影時の白のミレッド 1e6/K で線形補間。`hueSat` が非 null ならこの版は exit 3 で拒否。任意の `whiteBalanceMap`（`model: "uv-offset"`・`du`・`dv`）は画素に触れず、作業コピーのメタの `asShotWhiteAdobe` と `--white` の換算にだけ使う。任意の `whiteBalanceTable`（下の「白の行列の表」）も画素に触れず、作業コピーのメタに写すだけ）。`decoder.decoderVersion` が実際の版と違えば `warnings` に残す |
| メタ JSON（`--meta`。省くと `<out>.json`、`--working-copy-meta` があれば `<out>.meta.json`） | `tool`・`input`・`camera`・`decoderVersion`・`decoderVersionRequested`・`supportedDecoderVersions`・`appliedSettings`（設定した全プロパティと読み戻した実効値・代入順・`gamutMapping` の要求と解決）・`appleDefaults`・`neutral`・`renderedWhite`（`--white` の白。無ければ null）・`shooting`（ISO・露出・F 値）・`orientation`・`nativeSize`・`decoderExtent`・`outputSize`・`scaleFactor`・`space`（変換行列込み）・`encoding`（`png16-g18` は `ceiling: 2`・`gamma`・式・`note`）・`calibration`（`baselineEVApplied`・`exposureScaleApplied`・`whiteBalanceMap`・`whiteBalanceTable` の格子の要約）・`workingCopyMeta`（`whiteBalanceTableCheck` 込み）・`stats`（`negativePixelCount`・`ceiling`・`aboveCeilingPixelCount` 込み）・`timingMs`（decode+render・color・encode・total。表の自己点検をしたら `whiteBalanceTableCheck`）・`peakRSSBytes`・`environment`（macOS 版 / build・`hw.model`・CPU・Metal device・Core Image 版）・`warnings`・`createdAt` |

## 作業コピー（段 2 の入力）

契約の正は段 2 の crate `niho-develop` の `src/decode.rs`（`WORKING_COPY_GAMMA = 1.8`・`WORKING_COPY_MAX = 2.0`・`decode_working_copy`・`WorkingCopyMeta::from_json`）。Python の参照実装は `tools/calibrate/make_working_copies.py`（`tiff32f` から同じものを作る）。

```bash
.build/release/apple-raw-linear render <raw> --encoding png16-g18 \
  --calibration ../../calibration/panasonic-dc-s5/apple-v1.json \
  --out <dir>/<scene>.png --working-copy-meta <dir>/<scene>.json   # ツールのメタは <dir>/<scene>.meta.json
```

- 画素: 16bit RGB PNG、linear ProPhoto（D50）・撮影時の白・**露出の前**。校正の行列（`illuminants` があれば補間後）だけを焼き、`2^baselineEV` は焼かない（段 2 が `2^(baselineEV + exposure)` を掛ける）。`code = round((clip(x, 0, 2) / 2)^(1/1.8) × 65535)`（0 未満は 0、2 超は 2 にクリップ。割合はメタの `clippedAbove2Fraction`・`negativeFraction`）。
- **ビューアでは 1 段暗く見える**: ICC は ROMM RGB（gamma 1.8）のままなので、ICC を解釈するビューアは `code/65535` を `(x/2)` の線形値として表示する。作業コピーは段 2 の入力で、表示用ではない（ツールのメタ `encoding.note` と作業コピーのメタ `_source.note` にも書く）。
- `--working-copy-meta` の JSON（crate の `WorkingCopyMeta`。crate は知らないキーを無視する）:

| キー | 値 |
|---|---|
| `kind` | `"raw"` |
| `baselineEV` | 校正 JSON の `baselineEV`（`--calibration` が無ければ 0） |
| `asShotWhite` | info 用インスタンスで読んだ撮影時の白 `{x, y, temperature, tint}`（ツールのメタの `neutral` と同じ値）。読めない RAW は描く前に exit 2 |
| `dcpSha256` | Apple 経路に DCP は無いので、校正の `baseVersion`（例 `apple-ciraw8/linear-prophoto-d50/cal-panasonic-dc-s5-apple-v1`）。校正無しは `apple-ciraw<decoderVersion>/linear-prophoto-d50/uncalibrated` |
| `lookTableIncluded` | `false` |
| `asShotWhiteAdobe` | **提案（crate はまだ読まない）**。Adobe（Lightroom）が as-shot と見る白 `{x, y, temperature, tint, source, du, dv}`: `asShotWhite` の xy を CIE 1960 uv にして校正の `whiteBalanceMap`（`uv-offset`）の `(du, dv)` を足し、xy に戻したもの。`temperature`・`tint` は DNG の温度モデル（`wbmodel.temperature_from_xy` と同じ表・式）。段 2 が Lightroom の絶対 WB（K・tint）を再現するときの色順応の出発点（DC-S5 の実測で ΔE00 4.7 → 3.75。`calibration/panasonic-dc-s5/apple-v1.json` の `whiteBalanceMap.fit`）。写像が無い・未知の model なら `null`（未知の model は `warnings`） |
| `whiteBalanceTable` | 0.4.2。校正の白の行列の表を、この RAW での自己点検の後に写したもの（下の「白の行列の表」）。点検が通れば表そのもの（`measured` などすべてのキー）＋ `calibrationMatrix`（この作業コピーの画素に焼いた校正の行列。行優先の 9 個。`illuminants` があれば補間後）＋ `check`。通らなければ `{schema, status: "mismatch", check}`（`inverseMatrices` が無いので段 2 は近似に戻る）。校正が無い・表が無い・色域の圧縮が on なら `null` |
| `_source` | 出どころ: `tool`（名前と版）・`input`・`camera`・`decoderVersion`・`calibration`（path・sha256・id・version・baseVersion）・`matrixApplied`・`baselineEVApplied: false`・`encoding`（式）・`clippedAbove2Fraction`・`negativeFraction`・`outputSize`・`lensCorrectionEnabled`（Core Image の補正）・`lensCorrection`（方式と、`embedded` なら使った節点数・半径の倍率・枠の倍率・周辺減光の最大増幅）・`output`・`toolMeta`・`note`・`createdAt` |

- 検証（2026-09-28・Mac mini M4・macOS 27.0、P1012822・decoderVersion 8・2560px・`apple-v1.json`）: `make_working_copies.py` が同じ RAW・同じ校正から作った作業コピーと比べて、PNG の 16bit 値の差は**最大 1**（13,109,760 値のうち 4,796 値 = 0.037%、+1 と −1 がほぼ半々の丸めの差）、crate の式で線形に戻した差は最大 4.0e-5。メタの `baselineEV`・`asShotWhite`（x・y・temperature・tint）・`dcpSha256`・`kind`・`lookTableIncluded` は完全一致、`asShotWhiteAdobe` の x・y は Python（小数 6 桁に丸め）と 3.8e-7 以内・temperature 3384.945 K（Python 3384.9）・tint 4.893（4.89）。crate のブリッジ `render_working_copy <png> <json> neutral 0 <out.jpg> 97` で両方を描いた JPEG の差は 8bit の平均絶対差 **0.0001**（最大 3、差のある値 0.0097%）。
- 処理時間: 2560px の作業コピー（校正・メタ込み）は total 0.93 秒・peak RSS 375 MiB（`/usr/bin/time -l`、2 回）。

## 原寸の書き出しの JPEG（`encode-jpeg`・`retag-jpeg`）

NIHO Desktop の原寸の書き出し（spec「Desktop（S7）」、S7c #16946）は、同じ土台の原寸の作業コピーを段 2 の native CLI `niho-develop-render`（`packages/develop-engine/crates/niho-develop-render`）で 8bit sRGB の PNG に描き、この `encode-jpeg` で撮影日時を付けた JPEG にする。Photo Bench で描く今の書き出しには、書いた後に `retag-jpeg` を当てて同じメタデータにする（W2b-2 #17145）。

```bash
.build/release/apple-raw-linear encode-jpeg --pixels <rendered.png> --metadata-from <original.RW2|jpg|png|heic|tif> --out <export.jpg> [--quality 0.92]
.build/release/apple-raw-linear retag-jpeg --in <export.jpg> --out <export.jpg>
```

### メタデータの規則（撮影日時だけ）

Epic #17114 Decision 10・F7a #17143（crate の `exif.rs`。spec「書き出しの EXIF」）と同じ規則。付けないと iPhone の写真ライブラリで撮影日ではなく保存した日に並ぶ。位置情報は拠点や利用者の自宅を漏らしうるので付けない（W2b-1 #17145 から。0.4.1〜W2b-1 前の `encode-jpeg` は Photo Bench の規則で GPS・カメラ・レンズ・サムネイルも付けていた）。

- EXIF: `DateTimeOriginal`、元にあれば `OffsetTimeOriginal`・`SubsecTimeOriginal`（元の EXIF の値をそのまま写す。crate のように `capturedAt` とオフセットから作らない）、`PixelXDimension` / `PixelYDimension`（書いた大きさ）、`ColorSpace` = 1（sRGB）。TIFF（IFD0）: `Orientation` = 1。
- 付けないもの: GPS、TIFF の Make / Model / Software / Artist / Copyright / DateTime ほか、ExifAux（レンズ）、IPTC、XMP、メーカーノート、埋め込みサムネイル（EXIF の IFD1・JFIF のサムネイル）、コメント。ICC はそのまま（`encode-jpeg` は sRGB なので ImageIO が ICC を付けない）。
- 撮影日時が無い（元を ImageIO が読めない・`DateTimeOriginal` が無い・空欄や `0000:00:00 00:00:00` など `YYYY:MM:DD HH:MM:SS` 形式でない、または実在する暦日付でない）ときは **EXIF を付けない**（APP1 が無い JPEG。向きは既定の 1）。月ごとの日数とうるう年も検証する。stderr に warning。形の崩れたオフセット（`±HH:MM`・±14:00 以内でない）・秒未満（1〜9 桁の数字でない）はその項目だけ落とす。
- `ExifVersion`・`ComponentsConfiguration`・`FlashpixVersion` は書かない（crate は書く）。ImageIO は自分では書かず、`CGImageDestinationCopyImageSource` の経路では渡しても `ExifVersion`・`FlashpixVersion` が落ちるので、`encode-jpeg` と `retag-jpeg` の出力が同じ形になる方を採った（ImageIO は撮影日時をそのまま読む）。
- 書く前に読み直して確かめる（`JPEGExport.ruleViolations`）: APP のセグメントが JFIF（サムネイル無し）・EXIF 1 つ（撮影日時があるときだけ・IFD1 無し）・ICC・Adobe だけ、ImageIO の辞書が `{Exif}`・`{TIFF}`・`{JFIF}` だけ、`{Exif}` / `{TIFF}` のキーが上の規則と画像の構造（`ExifVersion` などと解像度）だけ、向き 1、撮影日時が元のとおり。外れれば `write_failed`（exit 4）で何も書かない（黙って位置情報付きで成功を返さない。NIHO Desktop は失敗なら書きかけを消す）。ImageIO はメタデータを渡さなくても EXIF（大きさ・ColorSpace）や IPTC（APP13）を書くので、書いた後に JFIF・EXIF（撮影日時があるときだけ）・ICC・Adobe 以外の APP とコメントを落としてから確かめる。
- stdout の JSON の `"metadata"` は **撮影日時を書いたか**（W2b-1 から。以前は「元のメタデータを読めたか」）。

### `encode-jpeg`

- 画素はそのまま（再サンプルしない・回転しない）。色空間は sRGB に付け替えるだけで変換しない（`niho-develop-render` の PNG は ICC なし＝sRGB）。ICC が sRGB でない PNG は変換せず書き、stderr に warning。品質 0.92（`--quality` は 0〜1）。
- 撮影日時は `--metadata-from`（RAW・JPEG・PNG・HEIC・TIFF。ImageIO が読めるもの）の EXIF から読む。
- 一時ファイル（`.<name>.partial-<pid>`）に書いてから rename する。途中で失敗したら何も残さない。`--out` は `--pixels`・`--metadata-from` と同じファイルにできない（exit 1）。
- stdout は 1 行 JSON `{"ok","out","width","height","bytes","quality","metadata","encodeMs","totalMs","peakRSSBytes","warnings"}`。エラーは `render` と同じ形・同じ終了コード（`--pixels` が無い 4 `input_not_found`、画像として読めない 4 `read_failed`、書けない・規則の外が残る 4 `write_failed`）。

### `retag-jpeg`（W2b-1 #17145）

書き出し済みの JPEG（NIHO Desktop が Photo Bench で書いた原寸の書き出し）のメタデータを、画素を**再符号化せずに**上の規則に置き換える。撮影日時はその JPEG 自身の EXIF から読む（Photo Bench の書き出しはオリジナルの EXIF を写している）。

- 手順: (1) 入力の APP1〜APP15（EXIF とその IFD1 のサムネイル・メーカーノート・GPS、XMP、IPTC など）とコメントを落とす（JFIF・ICC・Adobe と符号化の表は残す）。(2) 撮影日時があれば、`CGImageDestinationCopyImageSource` で規則の EXIF / TIFF だけを `kCGImageDestinationMetadata` として付ける（`kCGImageDestinationMergeMetadata` は使わない。`kCGImageMetadataShouldExcludeGPS`・`kCGImageMetadataShouldExcludeXMP` も付ける）。無ければ (1) のまま（EXIF 無し）。(3) 上の確かめに加え、表（DQT・DHT・SOF・DRI）と SOS から末尾までが入力と**バイト一致**することを確かめ、違えば `write_failed`。(4) 一時ファイル → rename。
- (1) を先にするのは、`CGImageDestinationCopyImageSource` はマージしなくても元の EXIF の IFD1（サムネイル）を残し、元に IPTC（APP13）があると撮影日時を IPTC にも書くため（macOS 27.0 で確認）。落とした後の JPEG に当てると、JFIF と規則の EXIF だけになる。同じ画素・同じ撮影日時なら `encode-jpeg` の出力とバイト単位で同じ。
- `--in` と `--out` は同じパスでよい（入力を読み切ってから一時ファイルに書き、rename で置き換える。失敗したら入力はそのまま）。
- 入力が JPEG でない（ImageIO の型が `public.jpeg` でない・区切りが壊れている）ときと、向きが 1 でないとき（向き 1 を書くと写真が回ってしまう。Photo Bench の書き出しは常に 1）は `read_failed`（exit 4）。無い入力は `input_not_found`。
- ICC は残す。ICC が sRGB でない JPEG は `ColorSpace` = 65535（uncalibrated）にして stderr に warning。
- stdout は 1 行 JSON `{"ok","out","width","height","bytes","metadata","totalMs","peakRSSBytes","warnings"}`（`encode-jpeg` から `quality`・`encodeMs` を除いた形）。

### 実測

- 2026-09-30（W2b-1・Mac mini M4 16GB・macOS 27.0・`/usr/bin/time -l`、DC-S5 の P1524180.RW2・6000×4000。画素は ImageIO が描いた RAW を 8bit sRGB の PNG にしたもの、`retag-jpeg` の入力はその画素に Photo Bench の書き出しの規則のメタデータと GPS を付けた JPEG・4.6MB・EXIF 6.7KB（IFD1 のサムネイル・GPS IFD・Make / Model・ExifAux）＋XMP）: `encode-jpeg` は 0.65 秒・peak RSS 155 MiB、`retag-jpeg` は 8〜9ms・44 MiB（別のファイルへ・同じパスへ）。どちらの出力も JFIF と 132 バイトの EXIF だけ（IFD0 は `Orientation` 1 と EXIF へのポインタ、EXIF は `DateTimeOriginal` 2025:06:22 10:57:54・`SubSecTimeOriginal` 394・`ColorSpace`・大きさ。この RW2 に `OffsetTimeOriginal` は無い）で、GPS も IFD1 も無い。`retag-jpeg` の前後でスキャン（4,603,727 バイト）と表がバイト一致し、2 つの出力は互いにバイト一致した。
- 2026-09-29（0.4.1 の規則、DC-S5 の RW2 3 枚・6000×4000）: `encode-jpeg` は 0.45〜0.48 秒・peak RSS 131〜136 MiB・JPEG 4.2〜4.9MB。前段の `render --long-edge full --encoding png16-g18 --calibration-registry …`（原寸の作業コピー・約 100MB）は 4.5〜6.0 秒・peak RSS 705〜790 MiB（peak memory footprint は 1.4〜1.5 GiB）、`niho-develop-render` の原寸は 4.7〜5.1 秒・867〜882 MiB（`packages/develop-engine/README.md`「native CLI」）。3 つは順に動くので、原寸の書き出し 1 枚は計 10〜11.5 秒・同時に持つのは 1 つ分。

## 白の行列の表（`whiteBalanceTable`・0.4.2・S11 #17108）

色域の圧縮を切る（`isGamutMappingEnabled false`）と、同じ RAW を白 w で描いた Core Image の linear ProPhoto 出力（校正の行列の前）は `out(w) = M(w) · out(基準の白)` とちょうど 3×3 で書け、`M(w)` は機種と白だけで決まる（写真によらない）。段 2 はこの表で Core Image の白の変更をそのまま再現する（Bradford の近似の代わり）。表は `calibrate/fit_wb_table.py` が測り、参照実装は `calibrate/wbtable.py`。このツールは読んで検証し、作業コピーのメタへ写すだけで、画素には触れない。

- 校正 JSON の任意のキー `whiteBalanceTable`（`null` / 無し = 表なし）。契約 `niho-develop-wb-table/v1`:

```json
"whiteBalanceTable": {
  "schema": "niho-develop-wb-table/v1",
  "space": "apple-linear-prophoto-d50",
  "scale": "lightroom",
  "reference": { "temperature": 5000, "tint": 0 },
  "mired": [20, 40, 60, ...],
  "tint": [-150, -110, ..., 150],
  "inverseMatrices": [[m00, m01, m02, m10, m11, m12, m20, m21, m22], ...],
  "measured": { ... }
}
```

- `schema`・`space`・`scale` は上の文字列と一致。`mired`（1e6 / K、正）と `tint` は 2 個以上の有限な数の狭義単調増加。`inverseMatrices` は節点ごとの `M(w)` の**逆行列** `I(w)`（行優先の 9 個の有限な数、|det| > 1e-9）で、節点 (i_mired, i_tint) の添字は `i_mired × tint.length + i_tint`、個数は `mired.length × tint.length`。白は Lightroom の尺度（developSettings の K・tint）。ほかのキー（`measured` など）は読まずに写す。違反は exit 4（`invalid_calibration`、`<path>: whiteBalanceTable.inverseMatrices[37] (mired 60.0, tint -35.0) is singular ...` のように場所を書く）。`registry` も同じ検証をする。
- 評価（`WhiteBalanceTable`。`wbtable.py` と同じ式・同じ順の演算）: 白 (K, tint) で m = 1e6 / K を `[mired の先頭, 末尾]`、tint を `[tint の先頭, 末尾]` に丸め、入るセルの双線形の重みで `I(w) = Σ 重み · inverseMatrices[節点]`（成分ごと）、`M(w) = I(w)^-1`。白 a で描いた Core Image の出力を白 b にする行列は `M(b) · I(a)`。作業コピー（校正の行列 C を焼いたもの）なら `C · M(w1) · I(w0) · C^-1`（C はメタの `calibrationMatrix`）。
- 作業コピーのメタに写すのは、解決した色域の圧縮が **off** のときだけ（表は off でだけ成り立つ）。そのときこの RAW で**自己点検**する（表は別の RAW で測ったもので、macOS の更新で Core Image が変わりうるため）: 同じ RAW を 384px（`scaleFactor` で縮めて decode）・同じ `decoderVersion`・同じ色域の圧縮・boost 0 ほか同じ固定値・Core Image のレンズ補正 off・NR / シャープは本描画と同じで、1 つのインスタンスからもう 2 回描く。r0 = 撮影時の白（neutral に触れない）、続けて r1 = 点検の白（`--white` と同じ換算で `neutralChromaticity` に代入。新しいインスタンスで描いたのと同じ画素で、2 回で約 0.24 秒。別々のインスタンスだと 0.34〜0.55 秒）。撮影時の白 w0 は Lightroom の尺度で、`whiteBalanceMap` があれば `asShotWhiteAdobe` の temperature・tint、無ければ Core Image の撮影時の K・tint（未知の model の写像なら尺度が分からないので不一致）。点検の白は K0 < 5000 なら K0 + 2000、でなければ K0 − 2000（[2000, 50000] に丸め）、tint0 + 20（±150 に丸め）。r0・r1 を linear ProPhoto（校正の行列なし）にし、予測 p = M(wc) · I(w0) · r0 と r1 を、両方の全チャネルが (0.001, 0.8) の画素で比べる。残差 = sqrt(mean((p − r1)²)) / sqrt(mean(r1²))（全チャネル）。**1000 画素以上かつ残差 0.01 以下**で合格。
- 合格 → `whiteBalanceTable` = 表のすべてのキー ＋ `calibrationMatrix` ＋ `check: {status: "ok", white: {temperature, tint}, asShot: {temperature, tint}, residual, pixels, ms}`。不合格 → `{schema: "niho-develop-wb-table/v1", status: "mismatch", check: {同じ項目, status: "mismatch", reason}}` と `warnings` の `white-balance table check failed: residual …`。点検の失敗（描画できない場合も）で作業コピーの描画は失敗にしない。点検の時間はツールのメタの `timingMs.whiteBalanceTableCheck`、結果は `workingCopyMeta.whiteBalanceTableCheck`。
- 実測（2026-09-29・Mac mini M4・macOS 27.0 26A428。`s11/table` の表を `apple-v2` に入れ `gamutMapping: false` にした校正で、表を測ったのとは別の RAW を 2560px の作業コピーに）: DC-S5 の P1570135・P1570266 は残差 5.1e-4・8.8e-5（96,158・86,133 画素）、ZV-E10 II の DSC01837・DSC09188 は 1.8e-4・3.0e-4。ZV-E10 II の表を DC-S5 の RAW に当てると 0.0168、FX30 の RAW（DSC01843）に当てると 0.022 で不一致になる。点検は多くが 0.24〜0.26 秒（最初の 1 枚は 0.5 秒まで）で、作業コピーの total は表なしの 1.06〜1.11 秒に対し 1.32〜1.47 秒。

## ラスタの作業コピー（`raster`・0.4.3、原寸書き出しは 0.5.2）

段 1 のラスタ（HEIC / HEIF・TIFF・PNG・JPEG）の作業コピーは **ICC 付きの 8bit JPEG**（K5 #17153。Epic #17114）。段 2 の crate は、それを **JPEG のオリジナルと同じ経路**（埋め込み ICC → 線形・非 RAW の露出式）で読む。以前の Photo Bench の作業コピー（長辺 2560・linear ProPhoto・16bit PNG）はスマホの HEIC（12MP）で 18MB 前後あり、原本（2〜3MB）の 6〜9 倍だった。あわせてプレビュー（長辺 1024 の JPEG）も同じ読み込みから書く（K6 #17154 の方向。ワーカーの描き手を Photo Bench からこのツールへ寄せる）。

```bash
.build/release/apple-raw-linear raster <IMG.HEIC> --out <dir>/wc.jpg --preview-out <dir>/preview.jpg [--meta <dir>/wc.json] [--long-edge 2560] [--quality 0.94]
```

`--long-edge full` は原寸を維持する（縮小も拡大もしない）。JPEG の寸法上限は各辺 65,535 px のため、出力画像がこの上限を超える場合は `unsupported_dimensions`（exit 3）で失敗する。入力の総画素数の上限は、既定（作業コピー）が 4,000 万画素、`full` が 2 億画素（48MP 級の写真は原寸で書き出せる）。超えたら縮小せず `decode_failed`（exit 4）で失敗する。0.5.2 より前のツールは `full` を指定できない。

- 読む: ImageIO（`CGImageSource`）の主画像（`CGImageSourceGetPrimaryImageIndex`。多ページ・グリッドの HEIC も 1 枚）。**SDR の主画像だけ**（ゲインマップ（HDR）は当てない。NIHO は SDR で描く）。macOS 15 以上は `kCGImageSourceDecodeRequest` に `kCGImageSourceDecodeToSDR` を渡し、PQ / HLG で符号化された HDR の主画像も ImageIO が SDR にして読む（普通の画像は画素もビット数も変わらないことを確かめた）。それより古い macOS は要求を付けずに読む。16bit・10bit の元も 8bit に落とす。読めない・0 画素は `decode_failed`（exit 4）。拡張子では振り分けない（ImageIO が読めるものは読む）。
- 向き: EXIF / HEIF の向き（ImageIO の `Orientation`）を画素に当て、出力は正立。出力に向きのタグは無い（= 1）。
- 色（作業コピーは、作る側のこのツールが段 2 の読める形にそろえる）:
  - 元が RGB で、その ICC を**段 2 がそのまま読める**とき → **その色空間のまま**書き、同じ色空間の ICC を JPEG に埋め込む（Display P3 の HEIC は Display P3 の JPEG）。段 2（crate の `decode.rs` `conversion_for`、moxcms）が読めるのは RGB の行列＋TRC 型（`is_matrix_shaper`）とグレーだけなので、ICC のタグ表（ヘッダ 128 バイトの後のタグ数と 12 バイトの項目）を読み（`ICCProfile.swift`）、次を全部満たすものだけをそのまま使う: ヘッダの色空間が `RGB `、rXYZ・gXYZ・bXYZ（`XYZ ` 型・0 でない）と rTRC・gTRC・bTRC の 6 つのタグがそろう、どの TRC も `curv` か `para` で「ほぼ線形」でない。「ほぼ線形」= `curv` の点数が 0（恒等）、`curv` の点数が 1 でガンマが 1.3 未満、`para` のガンマ（最初の値）が 1.3 未満、のどれか（8bit の線形は暗部に縞が出る）。書けない色空間（`supportsOutput` が偽）もそのままにはしない。埋め込むのは ImageIO が読んだ色空間の ICC（`CGColorSpace.copyICCData`）で、ImageIO が既知の ICC をシステムの版に置き換えることがある（Display P3 は macOS の 536 バイトの版。`Sonoma.heic` ではヘッダの Profile ID（MD5）だけが原本の ICC と違った）。
  - それ以外の RGB（LUT 型だけの ICC、TRC が線形の ICC〔linear sRGB・linear P3・generic linear RGB など〕、ITU-R 2100 の PQ / HLG の色空間〔`CGColorSpaceUsesITUR_2100TF`〕、拡張範囲の色空間〔`CGColorSpaceUsesExtendedRange`。extended sRGB も含む〕、ImageIO が SDR にして読んだ HDR の元）→ Core Image で **Display P3（`kCGColorSpaceDisplayP3`）の 8bit に変換**し、Display P3 の ICC（`copyICCData` の版）を埋め込む。`iccSha256` はその P3 の ICC のハッシュ（P3 の元と同じ値）。P3 の外の色・1 を超える値は切り詰める。変換した理由は stderr に `note:` で 1 行。
  - 元が sRGB（ICC が sRGB のもの・ICC の無いもの。ImageIO はどちらも sRGB として読む）と、ICC の無い RGB（device RGB）→ sRGB として扱い、**ICC を埋め込まない**（段 2 は ICC の無い JPEG を sRGB として読む）。
  - グレー・CMYK・Lab・インデックス → Core Image が sRGB に変換して書く（ICC は埋め込まない）。それ以外の色モデル・色空間が無い画像は `unsupported_profile`（exit 3）。
- 縮小: 長辺を `--long-edge`（既定 2560）以下に縮める（大きくはしない。短辺は四捨五入）。**線形の光で縮める**: Core Image の作業色空間を extended linear sRGB・RGBAf にし、`clampedToExtent` → `CILanczosScaleTransform` → 切り抜き。縮めた後、上の色空間の 8bit（RGBA8 から alpha を落とす。透明は黒の上に合成したのと同じ）にする。1px ごとの白黒の縞を半分に縮めると sRGB で 188 前後（ガンマのまま縮めると 128 前後）になる（`swift test`）。
- 書く: JPEG・品質 `--quality`（既定 0.94）。**メタデータは ICC だけ**: ImageIO の JPEG から APP1（EXIF・XMP）・APP13（IPTC / Photoshop）・COM などを落とし、JFIF（APP0・サムネイル無し）と ICC（APP2）と符号化の表だけを残す。EXIF・GPS・TIFF・IPTC・XMP・MakerNote・サムネイルは入れない（撮影情報・位置情報を持ち出さない）。時刻などを入れないので、同じ入力・同じ引数なら同じバイト列になる。
- 決定的にするため、ImageIO が読んだ画素を普通の `CGImage` に写してから Core Image に渡す。HEIC の `CGImage` をそのまま渡すと Core Image がデコーダの面を自分で変換することがあり、負荷のあるとき（8 本同時）に 11 回中 2 回違う画素になった（macOS 27.0・M4）。写した後は 19 回とも同じバイト列で、同じ画像の PNG から書いたものとも一致した。
- プレビュー（`--preview-out`）: 同じ読み込みから長辺 1024（大きくはしない）・**sRGB に変換**（Core Image。sRGB の外の色は切り詰め）・JPEG・ICC もメタデータも無し・**1MiB 以下**（品質 0.85 → 0.72 → 0.6 → 0.45 の順に、収まるまで。どれでも超えたら `encode_failed`）。
- JSON: stdout に 1 行（`--meta` があれば同じ内容をファイルにも書く）。`--out`・`--preview-out`・`--meta` は互いに別のファイルで、入力を上書きしない（exit 1）。全部を JPEG にできてからファイルを書き（一時ファイル → rename）、途中で書けなければこの実行で書いたものを消す。

```json
{"kind":"raster","encoding":"jpeg8","width":2560,"height":1920,"iccSha256":"<埋め込んだ ICC の SHA-256（小文字 16 進）| null>","colorSpace":"kCGColorSpaceDisplayP3","converted":null,"sourceWidth":4032,"sourceHeight":3024,"orientationApplied":true,"bytes":123456,"preview":{"width":1024,"height":768,"bytes":98765},"tool":{"name":"apple-raw-linear","version":"0.4.3"}}
```

| キー | 値 |
|---|---|
| `width` / `height` | 作業コピーの大きさ（正立の後） |
| `iccSha256` | JPEG に埋め込んだ ICC のバイト列の SHA-256。ICC を埋め込まなかった（sRGB 扱い・sRGB に変換した）ときは `null`。ワーカーは土台の版（`raster.….icc-<sha>` / `icc-srgb`）に使う |
| `colorSpace` | 書いた画素の色空間: `CGColorSpace` の名前（`kCGColorSpaceDisplayP3` など）、名前が無ければ ICC の説明（ImageIO の `ProfileName`）、どちらも無ければ `null`。sRGB は `kCGColorSpaceSRGB` |
| `converted` | 変換した先: `"displayP3"`（段 2 が読めない・縞が出る RGB）、`"srgb"`（グレー・CMYK・Lab・インデックス）。元の ICC をそのまま使った・sRGB（ICC 無し）として扱ったときは `null` |
| `sourceWidth` / `sourceHeight` | 元の画素の大きさ（**向きを当てる前**。ImageIO の `PixelWidth` / `PixelHeight`） |
| `orientationApplied` | 元の向きが 1 以外で、画素に当てたとき `true`（crate の `orientation_applied` と同じ意味） |
| `bytes` | 作業コピーのバイト数 |
| `preview` | `{width, height, bytes}`。`--preview-out` が無ければ `null` |

- 実測（Mac mini M4 16GB・macOS 27.0・`/usr/bin/time -l`、2026-09-30、写真ではなく macOS の壁紙の HEIC）: `Sonoma.heic`（6016×6016・Display P3・20MB）→ 作業コピー 2560×2560・607KB とプレビュー 100KB を 0.57〜0.80 秒・peak RSS 551MB（peak memory footprint 1.48GB）。同じ絵を `sips` で 4032×3024 の HEIC にしたもの → 2560×1920・437KB を 0.23〜0.41 秒・peak RSS 250MB（footprint 553MB）。スマホの写真の大きさ（見込み 1〜2MB）と、今の作業コピーとの ΔE00（受入は 2048px で平均 0.5 以下）は、次の切片で実物の HEIC で測る。

## 参照セットの一括レンダリング

```bash
scripts/render-reference-set.sh [--force]
```

DC-S5 の 16 場面を `NIHO_COLOR_WORK_DIR`（既定 `OWNER_DATA_ROOT`）へ描く: `apple-linear/v8/<scene>.tiff`＋`.json`、`apple-linear/v7/...`、カメラ内 JPEG `camera-jpeg/<scene>.jpg`（`exiftool -b -JpgFromRaw`。1920×1280・EXIF の向きタグ付き・画素は未回転）、`timing/`（原寸と 2560px の `/usr/bin/time -l`・`summary.json`）、`cameras/`。既存の出力は `--force` が無ければスキップ。RAW はオーナーの私物なので出力はリポジトリに入れない。

実測（Mac mini M4 16GB・macOS 27.0・DC-S5 24MP、2026-09-28）: 原寸 6000×4000 の `tiff32f` は total 2.3 秒・peak RSS 619 MiB、2560px の `png16-g18` は 1.25 秒・283 MiB（0.1.0 の [0,1] クリップ版・校正無し。0.2.0 の作業コピーは上の「作業コピー」）、2560px `tiff32f` の 16 場面平均は v8 0.9 秒・v7 0.6 秒（peak RSS 最大 351 MiB）。

## 決めたこと

- 行列は Python 側（`tools/colorcheck/colorcheck/color.py`）と同じ Lindbloom の 2 行列から計算し、白 (1,1,1) → (1,1,1) を 2e-3 以内・Python の値と 1e-6 以内で一致させる（`swift test`）。
- ビルド生成物 `.build/`・`.swiftpm/` は `.gitignore`。`scripts/render-reference-set.sh` は `APPLE_RAW_LINEAR_BIN` が無ければ `swift build -c release` を自分で回す。
- Apple の内部プロファイル（機種ごとの色変換）は公開 API から観測できない。色の追い込みは Apple の出力を入力とみなし、NIHO 側の係数（校正 JSON）だけで行う。
- 作業コピーは常にレンズ補正あり（owner 2026-09-29）。作業コピーを作るときは `--lens-correction` を渡さず（`auto`）、校正 JSON の `lens.mode` に任せる（`embedded` = 歪みと周辺減光、`apple` = 歪みだけ。`apple` の機種の周辺減光は S10c で足す）。`off` は色の計測専用で、校正 JSON の `lens.mode` には書かない。0.4.0 は `--working-copy-meta` と `off` の組み合わせを拒否し（exit 1）、ワーカーも解決した方式が `off` なら失敗にする。本番のワーカーは S4b #17034（2026-09-29 配備）からこのツールで RAW を描き、登録表 `calibration/apple-registry.json` の機種別補正とレンズ補正を作業コピーに入れている（`ops/runbooks/photo-cloud-work-worker.md`）。
- W2b-1（2026-09-30・#17145。版は 0.4.3 のまま）: `encode-jpeg` のメタデータを撮影日時だけにし（Epic #17114 Decision 10・F7a #17143 と同じ規則）、`retag-jpeg` を足した（上の「原寸の書き出しの JPEG」）。`render`・`raster` の出力は変えないので版を上げない（ワーカーの `0.4` の照合・`baseVersion` はそのまま。NIHO Desktop は同梱の lock のソースの指紋で見分ける）。決めたこと: (1) JSON の `metadata` は「撮影日時を書いたか」に変えた（NIHO Desktop は読んでいない）。(2) サムネイルは入力の APP セグメントを先に落として外す（`CGImageDestinationCopyImageSource` だけでは IFD1 が残る）。(3) 書いた後の確かめは許可リスト（APP セグメント・ImageIO の辞書・`{Exif}` / `{TIFF}` のキー）で、外れたら書かない。macOS の更新で ImageIO が別の無害なキーを足すと書き出しが失敗に倒れるが、位置情報付きで成功するよりよい。(4) `retag-jpeg` は向きが 1 でない入力を回さず失敗にする。(5) `ExifVersion` などは書かない（ImageIO の既定。上の規則の節）。
- 0.5.2（2026-10-15・#18453）: `raster --long-edge full` で原寸 JPEG を書き出す。JPEG の寸法上限（各辺 65,535 px）を超える画像は縮小して成功扱いにせず、`unsupported_dimensions`（exit 3）で明示的に失敗する。`full` では入力の総画素数の上限を 4,000 万 → 2 億画素に広げる（48MP 級の HEIC / TIFF を原寸で書き出せるように。超えたら縮小せず `decode_failed`）。
- 0.5.1（2026-10-15・#18398）: 登録表の `fallback`（登録の無い機種の既定）。パッチ版: fallback の無い登録表と、機種の行がある RAW の画素は 0.5.0 と同じ。fallback で描いた作業コピーは baseVersion の校正が `cal-generic-apple-v1` になる（ワーカー・Desktop は `_source.calibration` から組むので、ほかの変更は要らない）。fallback の `decoderVersion` と違う版を `--allow-fallback` で当てたときは、描画の後でなく描く前に外して校正なしで描く（レンズ・色域・白は fallback の決まりにより変わらない）。
- 0.4.3（2026-09-30・K5-c1 #17153）: `raster` を足した（上の「ラスタの作業コピー」）。段 2 が読めない（LUT 型・PQ / HLG）・縞が出る（線形の TRC）・拡張範囲の RGB は、そのまま埋め込むと作業コピーが開けない・使えない写真ができるので、ツールの側で Display P3 に変換する（JSON の `converted`）。`render`・`encode-jpeg`・`info`・`cameras`・`registry` は変えていない（パッチ版なので `render` の画素は 0.4.0 と同じ。ワーカーの `0.4` の照合もそのまま通る）。エラーの語彙に `decode_failed`（4）・`encode_failed`（4）・`unsupported_profile`（3）を足した（終了コードは既存の分け方: 3 = 対応していない、4 = 入出力）。
- 0.4.2（2026-09-29・S11 #17108）: `--gamut-mapping`・`--white`・校正の `whiteBalanceTable`（作業コピーごとの自己点検つきでメタへ）。新しい引数を使わず、校正が `gamutMapping: true` で表が無ければ、画素は 0.4.1 と同じ（パッチ版）で、作業コピーのメタの違いは `whiteBalanceTable: null` と版の文字列だけ（P1570135・DSC01837 を登録表で 0.4.0 と比べて PNG がバイト単位で一致。0.4.1 の差分は `encode-jpeg` だけ）。ワーカーの照合（`0.4`）と `baseVersion` の `p2` は変わらない。`gamutMapping: false` の校正（apple-v3）で描き方が変わるのは、その校正を当てたときだけで、`baseVersion` は校正の版（`cal-…-apple-v3`）で変わる。決めたこと: (1) `--white` は Lightroom の尺度で、作業コピーには使わない（作業コピーは常に撮影時の白、段 2 が白を変える）。(2) `--white` の K・tint → xy は参照実装の 2000 K の丸めを掛けない（範囲 1000〜100000 K・±250 は計測ツールが Apple の尺度の節点を渡すため）。(3) 表は色域の圧縮 off でだけ成り立つので、on の作業コピーには写さない。(4) 自己点検の 2 回の描画は 1 つのインスタンスで続けて描く（新しいインスタンスと同じ画素で速い。将来ずれても不一致側に倒れるだけ）。(5) 点検の不合格は作業コピーを失敗にせず、行列を外して段 2 を近似に戻す。
- 0.4.1（2026-09-29・S7c-1 #16946）: `encode-jpeg` を足した。**パッチ版（0.4.x）は画素を変えない**: `render` の出力は 0.4.0 と同じ（P1524180・P1522877 の 2560px と原寸の作業コピーで PNG が byte 一致、作業コピーのメタは `tool` の版以外同じ）。本番のワーカーは major.minor（`0.4`）で照合するので、0.4.x に上げてもワーカーの `baseVersion` は変わらない。画素を変える版上げは minor を上げる（`ops/runbooks/photo-cloud-work-worker.md`「版上げ」）。
- 0.3.0（2026-09-29・S10 #17031）: `--lens-correction` を `auto|apple|embedded|off` に（`on` は `apple`）。既定を `auto`（校正 JSON の `lens.mode`）にした。`lens` 節の無い校正と `--lens-correction` を省いた呼び出しは 0.2.0 と同じ画素（Core Image の補正）。校正の `decoder.settings.lensCorrection` は「レンズ補正をしたか（apple / embedded）」と照合する。ZV-E10 II ＋ E PZ 16-50mm（16〜17mm）で `embedded` は Lightroom のレンズプロファイル補正と幾何 RMS 0.2〜0.3px（`apple` は 14.5px・周辺 30px）、周辺減光は周辺の −0.32〜−0.48 EV が解消し、LR の補正ありのプリセットとの ΔE00 は pastel 2.96 → 2.10・bluesky2 2.31 → 2.04。2560px で 40ms。
- 0.2.0（2026-09-28）: `png16-g18` を crate の作業コピーの契約（上限 2.0）に揃えた。0.1.0 の `png16-g18`（[0,1] クリップ・EV 込み）とは画素が違うので `tool.version` で見分ける。`tiff32f`・`tiff16` は変えていない。
- `png16-g18` は `--working-copy-meta` の有無にかかわらず常に作業コピーの画素（行列だけ・EV 無し）にする。メタを書くかどうかで画素が変わらないようにするため。EV 込みで比べたいときは `tiff32f` を使う。
- `--working-copy-meta` は `--encoding png16-g18` と `--boost 0`（線形）でだけ受け付ける（違えば exit 1）。`--calibration` は任意（無ければ `baselineEV: 0`・`asShotWhiteAdobe: null`・`dcpSha256` は `.../uncalibrated`）。
- `--working-copy-meta` があり `--meta` が無いとき、ツールのメタは `<out>.meta.json` に置く（`<out>.json` は `make_working_copies.py` と crate のブリッジが使う作業コピーのメタの名前）。`--out`・`--meta`・`--working-copy-meta` は互いに別のファイルで、入力の RAW と校正 JSON を上書きしない（exit 1）。
- 撮影時の白が読めない RAW で `--working-copy-meta` を指定したら、描く前に exit 2（`unsupported_camera`）。crate は `asShotWhite.x/y` が無いメタを読めないため。
- `asShotWhiteAdobe` の x・y・temperature・tint は丸めずに書く（Python は小数 6 / 1 / 2 桁に丸める。差は xy で 4e-7 未満）。temperature・tint は DNG の温度モデル（`wbmodel.temperature_from_xy` の移植 `DNGTemperature`）で出し、Python の値と 1e-6 以内で一致させる（`swift test`）。
- 校正 JSON の `whiteBalanceMap` は任意。`model: "uv-offset"` で `du`・`dv` が数でなければ exit 4（`invalid_calibration`）。未知の `model` は画素に関わらないので拒否せず、作業コピーのメタを書くときだけ `warnings` に残して `asShotWhiteAdobe: null` にする。
- ガンマの冪は Double で計算する（`Float(1/1.8)` は 1/1.8 より 2.6e-8 大きく、Python 版との差が −1 に偏っていた: 差のある値 0.079% → 0.037%）。行列と値の保持は従来どおり Float。
