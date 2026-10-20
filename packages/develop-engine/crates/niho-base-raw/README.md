# NIHO base RAW

`rawler`でRAWをdecodeし、明示した独立DCPを通してlinear ProPhotoの作業コピーを作る段1。機種別LibRaw行列表・表からDCPを作る入口は持たない。DCPなしのcamera dumpは色温度を推定せず、不明値を0として出力する。

```sh
cargo run --locked -p niho-base-raw -- dcp make --spec profiles/panasonic-dc-s5/niho-dc-s5-independent-v1.spec.json --out /tmp/niho-independent.dcp
cargo run --locked -p niho-base-raw -- render --raw ../../fixtures/public-raw/dc-s5-owner.rw2 --dcp profiles/panasonic-dc-s5/niho-dc-s5-independent-v1.dcp --out /tmp/niho-working.png
```

実RW2受入・元画素goldenは `tests/fixture_pipeline.rs` で常時検証する。対応範囲と制約はworkspace READMEとルートのdecoder capability文書を参照する。LGPLの例外はworkspace LICENSESを参照する。
