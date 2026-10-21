# niho-14 H/S 応答の解析を軽くする（#89）

`niho-14` は Issue #89 の engine で、[`niho-13`](NIHO13.md) の数式（raster の相対 WB を処理の先頭で当てる）のまま、`niho-6` の Highlights / Shadows 応答の**解析**（特徴量と網）を軽くしたもの。応答の係数・750px の解析画像・gain・それ以外の数式はすべて `niho-13` と同じ。保存済みの `niho-1`〜`niho-13` の補正はその engine のまま描き、`niho-14` へ昇格させない。

状態: 評価中。採否は下の「採否の規則」で決める（計測の前に固定）。

## 数式と入力境界

`niho-13` との違いは `niho-6` の解析の 2 か所だけ（`crates/niho-develop/src/niho14_analysis.rs`）。

1. 特徴量: 26 個の特徴量のうち、局所の 4 段（σ = 4・16・64・128 解析画素）の大きい 2 段（σ = 64・128）の局所平均を、`ln`（log2 輝度）と `y`（輝度）の plane を 4 分の 1 の格子へ面積平均で縮めてから求める。縮めた格子の間隔（軸ごと）で σ と半径 4σ を取り、`niho-13` と同じ反射の境界でぼかし、各解析画素の中心で双線形に読み戻す。σ = 4・16 と、それ以外の特徴量（ln・比・分位点・順位）は `niho-13` と同じ計算。
2. 網: 同じ係数を `f32` にし、4 画素を 1 本の SIMD（wasm simd128 / NEON の f32x4）で回す。各出力は bias に入力を順に足す（`niho-13` と同じ順、FMA なし）。`tanh x = ±(1 − t)/(1 + t)`（`t = e^{−2|x|}`、`|x|` は 9 で止める）、softplus は `max(v, 0) + ln(1 + e^{−|v|})`（対数は atanh の級数）。`e^x` は Cephes `expf`（ln 2 での Cody–Waite 縮約・5 次の多項式・指数部の bit）。`f32` の数 ulp の誤差。

演算は IEEE の加減乗除・比較・選択・最近接偶数への丸め・指数部の bit だけで、順序は固定。native（NEON）・wasm（simd128）・SIMD の無い移植版の lane が同じ bit を出す（`tests/niho6_cross_target.rs` が native と wasm で maps と画素の hash を固定、`tests/niho14.rs` が移植版と一致を検査）。

- H/S 応答を使わない設定（raster で Highlights < 0・Shadows > 0 が無い）と、旧（unsigned）RAW 作業コピーは `niho-13` と同じ byte 列（`tests/niho14.rs`）。
- signed `signed-gamma18-v1` と camera-linear: 拒否（`niho-13` と同じ）。
- XMP の読み書き・プリセット・相対 WB は `niho-13` と同じ。
- Session の cache（`niho-6` の特徴量・解析・master・gain）は解析の種類（`niho-6`〜`niho-13` の凍結した解析 / `niho-14` の軽い解析）を key に含み、同じ写真で両方を描いても混ざらない。

保存済み `niho-14` の画素は以後変えない。

## 画素を変えない高速化（全 engine）

`niho-6` を使う全 engine（`niho-6`・`niho-8`・`niho-10`・`niho-12`・`niho-13`）と NIHO 3 の RAW 応答に効く、画素を変えない変更も入れた。

- 網（`niho6_response.rs`）: 層の出力を横に並べ、各入力をすべての出力に足してから次の入力へ進む（各出力の加算の順は同じ）。8 出力が独立に並び、compiler が SIMD の lane に置ける。凍結した参照の計算と 4096 標本 × 2 網で bit 一致（unit test）。
- ぼかし（`raw_response/simd.rs`）: 1 回に 32 画素（f32x4 × 8 本の累積）を進める。各出力の tap の順は同じ（参照のぼかしと bit 一致の unit test に 32・16・端数の幅を追加）。
- 分位点（`raw_response.rs`）: 全体を並べ替えず、読む順位の値だけを選ぶ（`select_nth_unstable`。`f32::total_cmp` の順位の値は並べ替えと同じ）。

`f64` の `tanh` を 2 lane の SIMD で同じ算法（musl の分岐を lane の選択に）にする案は、1 億組で `libm::tanh` と bit 一致したが、wasm でも native でも速くならなかった（分岐の無い全経路の計算が lane の利得を打ち消す）ので入れていない。

旧 engine の不変は、合成入力で `crates/niho-develop/examples/engine_digests.rs`（`niho-1`〜`niho-13` × raster 2 場面・raster 作業コピー・旧 RAW・signed RAW × 13 設定 × Interactive・Final・縮小 Interactive・WB の drag 3 コマと確定・戻し・色取得・自動・one-shot）の 8,112 行（描けない組のエラー 3,614 行を含む）を base（`f4b878b`）と比べ、すべて一致した。

## 採否の規則（計測の前に固定、2026-10-22）

次をすべて満たせば `niho-14` を JPEG / PNG・raster 作業コピー・unsigned RAW 作業コピーの新規編集の既定にする。1 つでも満たさなければ `niho-14` は既定にせず、画素を変えない高速化だけを残す。

1. 性能: wasm（Studio の Node、SIMD）1280×960 の合成写真で、H/S を使う設定の WB を drag して離した後の確定（Final）が 1 秒以内（6 process の中央値）。
2. Lightroom との差（開発用教師 57 場面 × 中立・プリセット 3 本 = 228 組。gate と同じ 2048px 描画 → 長辺 1500・blur 2・平坦画素・位置合わせの CIEDE2000）:
   - 中立・各プリセットの mean の平均と p99 の平均が、`niho-13` から +0.02 以内。
   - 各組の mean の増加が 0.5 未満。
   - p99 > 8 の組の数が `niho-13` より増えない。
3. `niho-13` との画素差（開発用教師 57 場面 × プリセット 3 本 × 相対 WB 5 通り = 855 組。`tools/color-review-build-diff.py` と同じ手順）: 各組で mean ≤ 0.3 かつ p99 ≤ 1.5（#27 で「解析は WB 前」の代案に当てたのと同じ規則）。

sealed の独立 cohort は開かない。
