# niho-camera-linear-probe（V3 #17161）

本番の段1・段2から参照しない実験用 crate。カメラ固有の線形RGBで16bit PNGを作り、描画時に白とNIHO製DCPを当てたlinear ProPhotoを既存 `niho-develop-render` へ渡す。RAWとLightroom参照画像はリポジトリに置かない。

```bash
cd packages/develop-engine
cargo run --release -p niho-camera-linear-probe -- make \
  --raw /tmp/scene.RW2 --dcp crates/niho-base-raw/profiles/panasonic-dc-s5/niho-dc-s5-v4.dcp \
  --out /tmp/scene-camera.png --long-edge 2560
cargo run --release -p niho-camera-linear-probe -- render \
  --input /tmp/scene-camera.png --meta /tmp/scene-camera.json \
  --dcp crates/niho-base-raw/profiles/panasonic-dc-s5/niho-dc-s5-v4.dcp \
  --out /tmp/scene-5500.png --kelvin 5500 --tint 0
```

`make` は黒白正規化→bilinearデモザイク→Lanczos縮小→向き反映で止める。**WB乗算・ForwardMatrix・HueSatMap・露出は焼かない**。カメラRGBの値を現行と同じ `code=round(65535×(clamp(v,0,2)/2)^(1/1.8))` でPNG16にする。`*-camera.json` に撮影時のカメラ中性値、選んだDCPのSHA-256、RAW固有の露出値と当初の `baselineEV`、寸法と符号化版を保持する。別DCPで描くときの `baselineEV` はRAW固有の値＋選択したDCPのオフセットで再計算する。

`render` はPNG16を線形へ戻し、指定K/tintからDNG温度モデルでxyを得て、DCP ColorMatrix（2光源ならミレッド補間）から目標のカメラ中性値を求める。各チャンネルのWBを掛けた後に上限1でクリップし、`niho-base-raw::color::resolve_profile_color` と `pipeline::apply_color` で ForwardMatrix と HueSatMap を当てる。Kを省けば撮影時の白。生成されたlinear ProPhoto PNGと `kind=raw` のサイドカーを既存 `niho-develop-render` の `--working-copy` / `--meta` に渡せる。段2で白を二重に当てないよう、実験では段2の設定を `asShot` とし、後段へ渡すサイドカーの白を描画済みのxyにする。

`bench` は同じ入力を1プロセスで繰り返し、PNG/DCPの読込・出力を除いた後段増分（プロファイル解決＋WB＋色）を中央値とp95で報告する。

`inspect` は `make` のPNG符号化前のカメラ線形RGBを集計する。出力は寸法、最小・最大値、負値・1超・2超・非有限値の件数だけで、画素・元ファイル名・機種名・DCP SHAを書かない。現行PNG16が0へ丸める負値と2へ丸める値の合計は `currentPng16WouldClip`。新しい符号化を選ぶ前に私的RAWの値域を調べるための道具で、本番の段1には接続しない。

```bash
cargo run --release -p niho-camera-linear-probe -- inspect \
  --raw /tmp/scene.RW2 \
  --dcp crates/niho-base-raw/profiles/panasonic-dc-s5/niho-dc-s5-v4.dcp \
  --long-edge 2560
```

`codec-bench` は同じ符号化前RGBで2候補を測る。`f32` のビット列をzlib fastで圧縮・復号し、全サンプルのビット一致、圧縮サイズと処理時間を集計する。もう一方は全サンプルが−0.25〜2.0の範囲内であることを確認し、この範囲を既存のPNG16の0〜2へ写して実際にPNGを往復させ、線形RGBの平均・p99・最大絶対誤差とサイズを測る。`signedPng16TransformAndEncodeMs` は範囲写像・割り当て・PNG encodeを含む。比較対象の現行PNG16は負値を切るため、サイズだけを比べる。画像・ファイル名を出力せず、本番用の容器形式や符号化版は割り当てない。メモリ・native/wasm一致・最終描画の色差を通過したという意味にはならない。

```bash
cargo run --release -p niho-camera-linear-probe -- codec-bench \
  --raw /tmp/scene.RW2 \
  --dcp crates/niho-base-raw/profiles/panasonic-dc-s5/niho-dc-s5-v4.dcp \
  --long-edge 2560
```

作業コピーPNGには色を焼いていないため、`render` で別のDCPを明示選択してもPNGを作り直す必要はない。PNGのメタには作成時のDCP SHAを残し、後段へ渡す一時サイドカーには**実際に描画した**DCP SHAを記録する。後段の `baseVersion` は作業コピー形式と描画DCPのSHAで区別する。既存の補正が指す土台を黙って切り替えない契約は本番導入時にも必要。

## 本番導入時の契約差分（まだ実装しない）

- RAW作業コピーの `baseVersion` をカメラ線形・デモザイク・符号化版で更新する。現行のlinear ProPhoto作業コピーとは混ぜない。
- `SpotCloudPhotoWork.meta` のRAW unionにカメラ中性値・RAW固有の露出値・当初のDCP SHAと `baselineEV`・出力の色空間と符号化版を入れる。DCP更新時は同じカメラ線形画素を再利用し、選択したプロファイルSHAと再計算した `baselineEV` をレンダリング結果・補正の土台の版へ記録する。保存実体の版と新しい objectKey の扱いはR4仕様の「データと互換の契約」に従う。
- 段2の順序をPNG解凍→白のK/tintからカメラ中性値→WB→ForwardMatrix/HueSatMap→既存の露出・階調・ルック以下へ変える。今のlinear ProPhotoへのCATによる白近似はカメラ線形RAWで使わない。通常のHEIC/JPEGや旧版作業コピーは別契約として残す。
- NIHO Desktopの手元の作業コピーとクラウド作業コピーを同じカメラ線形版にする。既存補正を参照する旧版作業コピーは勝手に置換せず、版ごとの移行を設計する。

実測と未達項目は `../../tools/camera-linear-probe/RESULTS.md` に記録する。現行DCPは両機種とも単一光源。2光源のコード経路は合成プロファイルの単体テストまでで、実写の2光源プロファイル精度は未検証。
