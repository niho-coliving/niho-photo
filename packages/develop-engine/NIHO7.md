# NIHO 7 の signed RAW ハイライト応答

`niho-7` / `niho-standard-5` は、公開済み `niho-5` の P5 前段と R395 の機種別 RAW 数式を維持した新しい対です。Panasonic DC-S5 と Sony ZV-E10M2 には固定 R23 residual、Sony ILME-FX30 にはR42 の固定係数を学習範囲内で使う rational shoulder を負の Highlights だけで追加します。`niho-standard-5` の palette / tone は `niho-standard-4` と同一です。

ソースPR #18682 は reader capability を `niho-7` まで広げ、公開物や新規既定値を切り替えずに統合しました。公式公開PR #18689 が Wasm/native `0.16.0`、bundle pin、両アプリのsidecar lockを同じソースにそろえます。公開済み `niho-1`〜`niho-6`、既存保存値、R395 assets と旧数式は維持します。

## 有効化と配備順序

公式公開後、対応3機種の登録済み校正を持つsigned RAWの新規既定を `niho-7 / niho-standard-5` とします。保存済み `3/2`・`4/3` と、同じbaseの未保存写真に残る正しい旧draftは旧pairを維持します。generic signed RAWは `3/2`、unsigned RAWは `2/1`、JPEG/rasterは `6/1` のままです。

API/queueのreader対応、native `0.16.0` 以降のworker、Webと両アプリの有効化を順に反映し、runtimeの能力をreadbackします。workerはsigned reader能力とengine 7能力の両方を持つ場合だけ7をclaimし、未対応7はSQLのLIMIT前で除外します。記事レンダラも両能力がなければsource URLを送りません。手順は `ops/runbooks/photo-cloud-work-worker.md` と `gcp/runbooks/article-image-renderer.md` に従います。

signed producerをOFFにするrollbackでも、保存済みsigned写真のreaderは残します。3アプリで新規RAWの保存・再open・Highlights操作・書き出し、旧保存値とdraftの保持を確認してから #18399 の完了を判定します。

## 固定数式

両モデルの入力は、full-resolution の immutable signed CNR source を固定 baseline exposure で露出し、R395 coefficient map と同じ canonical 750 へ Area 縮小して得る4項です。

1. signed `logY`
2. scene `meanLogY`
3. `logY - localLog16`
4. R395 の固定 `H=-100` gain

非FXの正は `crates/niho-develop/src/niho7/raw-highlight-residual-v1.json` です。R23 の affine base を `[-1, 1] EV` に clamp し、`h = -Highlights / 100` の `h^4` と従来の immutable bright × neutral × flat mask を掛けて R395 gain に加え、合計を `[-8, 0] EV` に clamp します。元モデル SHA-256 は `3f8e1bda6bb7199be84eaa07acf53fb5e6e02ce4cf494c1b16039c1aceaa56df`、fit/data protocol SHA-256 は `6cd3645e9eb51221f7ba3e0851e905f7ea1e9ec42284b832321ebb4af1abef60` です。

FX30 の正は `crates/niho-develop/src/niho7/raw-highlight-shoulder-v1.json` です。4特徴を元の R42 training rows の各最小・最大値で clamp してから正規化し、切片＋4 slope の affine `A` / `B` を固定順序の f32 で計算し、stable softplus で非負の `a` / `b` にします。canonical 750 で作った2 map を描画寸法へ bilinear resize し、P5 後の画素 `pre` と従来の R395 出力 `old` を次で合成します。

```text
Ypre  = (0.2880402 R + 0.7118741 G + 0.0000857 B) × 2^baselineEV
k     = h a + h h b
scale = max(1 / (1 + k Ypre), 1 / 256)
out   = old + w (pre × scale - old)
```

`w` は full immutable source の同じ baseline-exposed luminance に対する `smoothstep(0.8, 1.0, Y)` です。source channel に負値または非有限値があれば `w=0`。encoding ceiling、chroma、flatness、画像・日付・型の分岐は使いません。`H=0`、`w=0`、負または非有限の `pre` は `old` と bit 単位で同じです。処理順は P5 pre-H → old H と FX blend → S → WB / user exposure → 従来 downstream です。FX30 に R23 residual は重ねません。

R42 の private coefficient artifact SHA-256 は `00f1bd5804a8447e6f71f707a21171afc9393395b114f6852daa452e8a063033`、凍結 `model.json` SHA-256 は `98373b7581ad03b1712449d1a3c8aae7bde56ebe2c20dee46fb62f697429565b`、fit/data protocol SHA-256 は `10852e544e2c531fec5b748c0eeeb9c9f136bd2570168e544117c15a60794fa4` です。production JSON と runtime 定数は、各値を f32 にした bit pattern の一致を unit test で固定します。

## cache と互換性

`AnalysisCache` / weak seed は `Arc<OnceLock<Result<...>>>` に `Residual(Vec<f32>)` または `FxShoulder { a, b }` を保持します。`niho-7` かつ `Highlights < 0` のときだけ、full prepared master を確保する前に初期化します。H / S / texture / WB / user exposure の drag と thumbnail / auto は同じ full-source canonical map を共有し、CNR、source、camera、fixed baseline、source dimensions が変わると無効化します。`niho-4` / `niho-5` は追加 map を計算も適用もしません。

preview は feature map を full source から作り、mask だけを preview 寸法へ resize します。R395 の unsigned gamma-1.8 / clamp 2 analysis と coefficient maps は従来のままです。対応入力は3機種の登録済み calibration を持つ signed RAW working copy だけで、JPEG / PNG、raster working copy、camera-linear、unsigned RAW、unknown calibration は拒否します。

## データの役割と既知の証跡

非FX R23 は 40 sources / 25 dates を使用し、測定可能なのは 28 scenes / 18 dates でした。CV aggregate は改善しましたが、改善日は 5 / 18 だけなので CV pass とはしません。

FX R42 の development pool は6 sources、実際に作用する4 scenes / 4 datesです。DSC00156 は実 headroom が低く、DSC00604 は empty inactive。DSC01843 は R39 の validation failure 後に development へ移したため independent ではありません。この場面の旧4 preset を含め、old164 に対する新モデルの source overlap は 124 から 128 / 164 へ増えています。night24、旧 independent20、R391 は fit に使っていません。DSC00625 は既知の regression ですが fit に使っていません。新3日付の入力分離 guard は通過しています。

R42 date-CV は 3 / 4 dates で loss が改善しましたが、held warm date は `0.0514 → 4.5251`、worst p99 L は `18.852` に悪化しました。したがって CV pass とはしません。固定候補内の既知評価は FX の負H 12条件 pass / 2 empty と whole-frame QA、H0 は7場面すべて旧式と byte exact、影響を受ける old FX 4条件と他機種9条件は PNG exact pass です。

source 移植後、parent が凍結 R42 を新3日付へ順次評価した結果、DSC00322 は H60 / H100 とも合格しましたが、DSC00566 の H100 は p99 ΔE00 = 18.2379 で失敗しました。事前に定めた停止規則で評価を止め、当時は DSC00644 の候補誤差を未開封のまま保ちました。DSC00566 の追加診断は H0 p99 = 0.3510（旧式と byte exact）、H60 = 12.5268 で、負Hの過度な暗化が残っています。この R42 数式は未採用の development 候補であり、公開・既定値切替の条件を満たしません。R391 は private 候補で6 pass / 4 empty。production 208、native / Wasm、3 apps runtime は数式修正後に必要です。

R48の固定576画素の診断では、P5実処理を学習pre-H proxyへ置き換えた差は平均−0.1598 L*、p99絶対差0.2440でした。暗化21.55 L*の主因をこの近似差とはしません。00566のlogYとscene meanLogYは元の学習範囲から全画素で外れ、固定affineが過度に暗化する係数を外挿していました。

R49は係数を再fitせず、**元の学習データだけ**から定まる特徴範囲へ入力をclampします。新たに開いた教師の値や合格閾値で境界を選びません。実画素のY、適用mask、P5、旧式、測定ゲートは不変です。既知FXの負Hは16 pass / 2 empty、H0は9/9 byte exact、00566はH60=3.9104/H100=5.3204。これらは開発回帰であり、独立受入ではありません。R50 で旧FX4条件も合格し、その後に残る未使用 DSC00644 を R51 で初めて評価しました。H60=0.9294 / H100=5.6403、H0も旧式と byte exact で合格です。独立受入はこの1場面であり、00322/00566を含む「新3日付の受入合格」とはしません。production 実装は3機種6場面×H0/60/100の18出力が受入private版とbyte exactで、native/Wasm共通の3機種×負H2設定の6 hashも一致しています。production208は208/208合格しました。全JPEGを製品nativeで再生成し、205はR24合格画像とbyte exactで測定値をreadback、変更した3を再測定しています。全条件p99≤8、全cohort平均neutral≤2 / preset≤3です。実写真は750pxへ縮小・signed再符号化した3機種4場面×H0/60/100の12条件とH0再描画4回がnative/Wasmで0 LSB差（基準≤1 LSB）。これはbackend parityであり、1500px Lightroomゲートとは区別します。公開・既定値有効化・3アプリの配備後受入は後続作業です。R42のCV結果を改善したとは主張しません。
