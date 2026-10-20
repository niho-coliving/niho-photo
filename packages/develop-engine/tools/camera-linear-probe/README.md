# V3 カメラ線形作業コピーの計測

実験用 `niho-camera-linear-probe` の `make` で1場面1枚のカメラ線形PNGを生成する。比較用に同じRAWとDCPを `niho-base-raw render` でも出す（`<scene>-old.png`）。`render` で `<scene>-as-shot.png` と `<scene>-wb-{4000,5500,7500}.png` を生成する。`render_round6.py` がこの手順をまとめる。ファイルとLightroom `p6_<scene>_wb_<K>.jpg` はすべて私的な出力先に置く。RAWのレンズ補正はOFF、長辺2560、DC-S5 v4 / ZV-E10M2 v2のNIHO製DCPを使う。

```bash
python3 packages/develop-engine/tools/camera-linear-probe/render_round6.py \
  --raw-dir /tmp/round6/raw --out /tmp/v3/renders \
  --scenes 'P1012822,P1013207,...' \
  --dc-dcp packages/develop-engine/crates/niho-base-raw/profiles/panasonic-dc-s5/niho-dc-s5-v4.dcp \
  --sony-dcp packages/develop-engine/crates/niho-base-raw/profiles/sony-zv-e10m2/niho-zv-e10m2-v2.dcp \
  --probe-bin packages/develop-engine/target/release/niho-camera-linear-probe \
  --base-bin packages/develop-engine/target/release/niho-base-raw
python3 packages/develop-engine/tools/camera-linear-probe/measure.py \
  --candidate-dir /tmp/v3/renders \
  --reference-dir /tmp/lr-measure/round6/lr-export \
  --scenes 'P1012822,P1013207,...' \
  --out /tmp/v3/report.json
```

`measure.py` は現行土台Bと撮影時の白の比較（750px、線形ProPhoto→Lab、非クリップ画素）およびLightroom白変種の比較（1000px、登録・同じcamera clip mask・per-image RGB tone curve）を行う。P1581387 / P1570923の小さな肌ROIも報告する。ROIは顔・腕の目視選択で、全画像の肌を代表しない。実測の入力には20場面（DC-S5 14、Sony 6）を使い、同じround6のFX30 2場面は対象機種外として除いた。

native/wasmの一致は `cargo build --target wasm32-unknown-unknown --release -p niho-camera-linear-probe --features wasm --lib` → `wasm-bindgen ... --target nodejs` とし、1280pxで同じcamera PNG・メタ・DCPを `render_codes_wasm` とnative `render`へ渡し、PNG16のRGBコード値を比較する。`render_codes_wasm` は私的な写真の画素配列とDCPバイト列だけを受け、写真をリポジトリに含めない。
