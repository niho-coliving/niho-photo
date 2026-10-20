# RAW decoderの対応と証拠

| 入力・経路 | 実装 | 公開CIの証拠 | 制約 |
| --- | --- | --- | --- |
| Panasonic DC-S5 RW2 / Bayer / 14 bit | rawler 0.8.0 → normalize/WB → demosaic → 独立DCP | 所有実RW2を毎回decode。sensor/crop/WB/black/white、元のcamera RGBとの512px golden、DCP描画を検証 | 公開fixtureは一つの撮影条件。全RW2・全機種の品質は保証しない |
| DC-S5 RW2 metadata除去 | numericタグallowlistと圧縮stripから再構築 | 元とのstrip hash・原寸camera RGB hash・decoder情報の一致を監査記録に固定。公開ファイルをguardで再検査 | sanitizerはPanasonic v5–v7のoffset独立形式だけ。未知形式は拒否 |
| DNG/ARW/NEF/CR2/CR3/RAF/ORF/PEF等 | rawlerの各decoder → 共通Bayer境界 | `decode`の形・境界をunit test。ライブラリが扱う形式と製品で実証した機種は区別する | この移植の実写真CIで検証済みとは表示しない。非Bayer、特殊RAW等はdecoder/境界で明示エラーになる |
| JPEG/PNG | Rust画像decode → 段2現像 | 所有写真・合成画像とPhoto Benchの数値fixture、幾何・WB・飽和色等の既存テスト | 外部ICCファイルは同梱しない。数学的ICCのテスト値はメモリ内で生成 |
| WASM段2 | niho-develop-wasm、decoder依存なし | wasm32 buildとNIHO6/7・camera-linear codecのnative/WASM共通hashテスト | ブラウザRAW decodeやSwift producerの受入を意味しない |
| Apple RAW / macOS framework | tools/apple-raw-linear | ソース・所有校正値を公開。Rust CIの受入対象とは分けている | Appleのモデル・ICCは同梱しない。OS/機種別の実機検証は別の受入が必要 |

DCPはDC-S5の所有写真とカメラJPEGから独立推定した1件だけを含む。旧DCP8件やLibRaw表をfallbackとして使わない。今回の色差指標は輝度を揃えたΔE76で、従来のLightroom相当のトーン指標やチャート測色とは異なる。fixture欠落やdecode失敗をskipで成功扱いにしない。
