# fixtures/color — 土台の色の計測結果（数値と小さな見本だけ）

`packages/develop-engine/tools/colorcheck/` で測った結果を `<track>/<camera>/` に固定する（Epic #16939 S9 #16972）。RAW と参照画像はオーナーの私物なのでリポジトリには置かず、hihirohub の `exports/lr-measure`（参照）と `niho-color-work`（中間物）にある。手順は `ops/runbooks/photo-color-calibration.md`。

| 置くもの | 形 |
|---|---|
| `<track>/<camera>/<version>.json` | `colorcheck fixture write` の出力（数値だけ。gate の判定込み）。`fixture check` で回帰にする |
| `<track>/<camera>/report.html` | `colorcheck report` の見比べページ（owner が要所を見る用。`samples/` を相対パスで参照） |
| `<track>/<camera>/samples/*.jpg` | 位置合わせ後の参照・NIHO の見本（長辺 480px 以下） |
| `apple/supported-cameras-macos<version>-<build>.txt` | `apple-raw-linear cameras` の出力（Apple の対応機種。先頭行は件数） |

track: `apple` = 土台 A（Apple の RAW 現像・S9a #16975）/ `niho-dcp` = 土台 B（自前デコード ＋ NIHO 製 DCP・S9b #16976）。camera は `<make>-<model>` を小文字で。

`look/<look>/`（S8 #16947）: NIHO 標準ルックの版ごとのプリセットの近さ（`v1.json` = `colorcheck fixture write`、`summary-v1.md` = 暫定・標準・段 2 の下限の表とトーンの置き場所の比較、`samples/` = 人の写っていない場面だけの見本）。
