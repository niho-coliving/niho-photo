# desktop-photo

NIHO photoのローカルフォルダ・画像メタデータ・補正設定・作業コピーを扱うTauri非依存Rust crateです。

```sh
cargo test --locked --manifest-path packages/desktop-photo/Cargo.toml
```

合成画像と一時ディレクトリを使用します。外部の非公開APIソースはテスト入力にしません。承認済みの校正値は `calibration/` 内に固定し、元のパスとSHAはルートのpublication-manifestに記録します。RAW engine/sidecarは #9 に留保し、未同梱では利用不可を返します。保存する端末内データは本人のこのMacに属します。
