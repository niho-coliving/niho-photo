# niho-camera-color

native Rust・wasm・Windows で共用する、カメラプロファイルの純粋な色計算 crate。行列、白色点、
Bradford、CCT、HSV、HueSatMap の計算を保持する。`ProfileInput` は色計算に必要な値だけを借用し、
呼び出し側が RAW decoder を介さず解析済みの値を渡せる。

`niho-camera-profile` が DCP バイナリ入出力と `DcpSpec` を保持する。`niho-base-raw` は
LibRaw 由来の表と段 1 処理を保持し、既存の `color` と `matrix` の公開パスを本 crate に
委譲する。本 crate は `niho-base-raw`、rawler、カメラプロファイル、校正ファイルに依存しない。

`niho-develop::camera_linear::to_linear_prophoto` は `ProfileInput` と選択した neutral、
カメラ RGB の `LinearImage` を受け、WB → 行列 → 負値 0 → HueSatMap の順で linear ProPhoto
を返す。1.0 を超える明部は保持する。現在は純粋関数のみで、Session・Web・API・Desktop の
既存入口には接続していない。DCP bytes から使うときは `to_linear_prophoto_from_dcp_bytes`
が SHA-256・機種名・spec を検証してからこの変換を呼ぶ。`niho-develop` から
`niho-base-raw` / rawler への依存はない。
