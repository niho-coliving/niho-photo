# niho-quality-probe

ローカルの画質比較専用 CLI です。production の Stage 1 やアプリ経路には接続せず、同じ
decode / white balance / DCP color / resize / orientation / PNG16 encode を使いながら、次だけを
切り替えて測定できます。

- demosaic: NIHO Stage 1 の bilinear、または rawler 0.8 の PPG
- camera RGB の edge-aware chroma denoise: strength `0..1`（`0` は完全な no-op）
- 拡大縮小後のガイド付き色ノイズ処理: `--guided-chroma`（ISOで半径と境界マスクを暫定選択）
- Sony ARW / Panasonic RW2 の埋め込みレンズ歪み補正: `--lens-correction embedded`（Sonyの周辺減光も含む）
- 白バランス後の1超を保持するハイライト試作: `--highlight preserve-wb`（評価で悪化したため既定は `clip`）

```sh
cargo run -p niho-quality-probe --release -- \
  --raw /path/to/input.RAW \
  --dcp /path/to/profile.dcp \
  --out /tmp/probe/output.png \
  --long-edge 2560 \
  --demosaic bilinear \
  --guided-chroma \
  --lens-correction embedded
```

出力は `niho_base_raw::encode::write_png16` による 16-bit PNG です。同じ basename の `.json`
に camera / ISO、設定、入出力 dimensions、処理時間を書きます。入力 RAW、DCP、比較画像は
crate や repository に保存しません。

## Processing order

`decode::decode_file` → `as_shot_multipliers` → `demosaic::prepare_cfa`（`--highlight preserve-wb` のみ実験版）→ bilinear または PPG →
optional chroma denoise → `color::resolve_profile_color` / `pipeline::apply_color` →
`resize::target_size` / `resize::lanczos3_rgb` → `orient::apply` → optional guided chroma → optional embedded lens → PNG16 encode

PPG には crop origin 基準の `raw.cfa_name()` を渡し、その 2×2 phase が `raw.pattern` と一致する
ことを実行時に検査します。対応範囲は rawler / `niho-base-raw` が decode できる 2×2 RGB Bayer
RAW です。

## Chroma denoise

3×3 bilateral filter で、`Y = (R + 2G + B) / 4` を guide にし、`R-G` と `B-G` だけを平滑化
します。luma または chroma の差が大きい neighbor の weight を連続的に小さくするため、明暗
edge と等輝度の強い色 edge の両方を跨ぐ color bleeding を抑えます。filter 結果は正の重みの
局所平均で、さらに元の chroma と strength で凸結合するため、局所 chroma 範囲内に収まり
ます。RGB 復元時は元の Y を保ちます。処理順と走査順は固定で deterministic です。

## 続行後の追加処理

`--guided-chroma` は線形輝度をガイドにした色差フィルタです。ISO2500未満は半径4、以上は半径8を選び、強い色境界の元の色差を残すマスクもISO別に設定します。平坦部のノイズ値だけでは、色の細部や肌の合格を決められません。`--chroma-strength` とは同時指定できません。

`--lens-correction embedded` は RAW の埋め込み係数を直接読みます。Sony は SubIFD の `DistortionCorrParams` / `VignettingCorrParams` を既存の Apple 線形現像と同じ半径規約で適用します。Panasonic は RW2 IFD0 の `0x0119` の係数から7次の半径関係を逆解きします。式の出発点は [RW2 の解析資料](https://syscall.eu/archive.html#pana) で、DC-S5 の実写2レンズで Apple 補正との差を測って確かめました。どちらも RGB の bicubic 補間を使い、レンズ補正は明示時だけ有効です。

`--highlight preserve-wb` は、センサー値を白で切った後、白バランス乗算で1超になった値を残します。独立したハイライト再構成ではありません。窓際の偽色と色差悪化があったため、結果を調べるための切替としてのみ残します。

## Limits

- これは比較測定用の小さな研究 probe で、production の品質契約ではありません。
- 3×3 denoise は固定 kernel / 固定 range scale です。ISO別設定はガイド付き色処理だけで、追加試料に合わせた暫定値です。
- PPG の overshoot や false color を追加補正しません。Panasonic の周辺減光や倍率色収差も対象外です。
- Apple Photos、Core Image、その他 Apple pipeline との parity は主張しません。
