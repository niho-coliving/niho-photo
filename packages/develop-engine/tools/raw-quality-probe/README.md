# RAW quality probe（V2 #17160）

本番とは独立した、Apple 現像とのローカル画質比較用の道具です。私物の RAW、TIFF、PNG、JPEG は repository や Issue / PR に追加しません。

## 環境と手順

`niho-quality-probe` crate で同じ RAW を `bilinear` と `ppg`、3×3 色ノイズ処理の強さ `0..1`、または `--guided-chroma` で描画します。Apple 側は `apple-raw-linear render --long-edge 2560 --space linear-prophoto --encoding tiff32f --lens-correction off --nr default` で描画します。Apple の校正 registry と、対応する NIHO DCP を指定します。両者の露出オフセットはピクセルに適用しません。

`--guided-chroma` は Rust の線形輝度をガイドにする色差フィルタで、拡大縮小後に適用します。ISO 2500 未満は半径4・色境界マスクの Gaussian σ2、ISO 2500 以上は半径8・σ4を選びます。境界マスクの閾値も ISO に応じて切り替えます。これは追加12場面を使った検証用の暫定値で、一般化や細部の合格を意味しません。`--guided-radius` で半径だけ上書きできます。`guided_chroma.py` は最初の区切りの Python / OpenCV 試作を再現するため残しています。

```sh
python3 -m venv /tmp/niho-quality-venv
/tmp/niho-quality-venv/bin/pip install -r packages/develop-engine/tools/raw-quality-probe/requirements.txt

/tmp/niho-quality-venv/bin/python packages/develop-engine/tools/raw-quality-probe/guided_chroma.py \
  --input /tmp/probe/base.png --out /tmp/probe/guided.png --radius 3 --eps 0.001

/tmp/niho-quality-venv/bin/python packages/develop-engine/tools/raw-quality-probe/measure_noise.py \
  --apple /tmp/probe/apple.tiff \
  --candidates /tmp/probe/base.png /tmp/probe/guided.png \
  --out /tmp/probe/noise.json
```

Rust の比較例:

```sh
cargo run --release -p niho-quality-probe -- \
  --raw /tmp/raw.RW2 --dcp /tmp/niho-camera.dcp \
  --out /tmp/guided.png --guided-chroma
```

`measure_noise.py` は Apple の線形 ProPhoto TIFF から、長辺2560の中央領域で輝度 0.025〜0.6、非飽和、相対勾配の小さい48×48pxのタイルを最大150選びます。同じ座標で各画像の log 輝度・log(R/G)・log(B/G) を2px Gaussian で high-pass にし、各タイルの MAD×1.4826 の中央値を取ります。色ノイズは後二者の二乗和の平方根です。Apple 標準NRを1とした比を出します。共通タイルなので候補による「都合のよい平坦部」の選び直しはしません。

この指標は高周波ノイズの近似で、輪郭の色ずれ、偽色、細部、全体の色は測りません。#17116 の 4.3倍／8.1倍とは**計算方法が違うため直接比較できません**。レンズ補正なし、同じ解像度・向きの画像を入力してください。1〜2px 平行移動させた確認では、試作の DC-S5 色ノイズ比は 1.18〜1.19 と安定していました。

`preview.py` は線形 ProPhoto → sRGB を両者同じ式で行う表示用 JPEG の作成道具です。トーンカーブはかけず、写真の共有先は hihirohub 内の私的な領域に限定します。

結果と未確認事項は [RESULTS.md](RESULTS.md) に記録します。
