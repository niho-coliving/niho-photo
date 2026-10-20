# #17515 NIHO 3 製品化記録（source PR）

## 対象と現在地

R236 の凍結済み処理を Rust と Swift に移植する。プリセットごとの補正係数、写真名や場面による分岐、合格閾値の変更は追加しない。既存の `niho-1` / `niho-2`、作業コピー p2/e1、ラスタ ci2/p2/e2、旧校正 registry、保存済み編集の既定は維持する。

この差分で入るのは実装・テスト・新版校正・公開準備。Desktop の旧 recipe による0.4/0.5両受入は、版上げが必要なため次の公開PRへ同梱する。公開 Wasm、crate の公開版、Web の公開先、Desktop の版・sidecar lock、新規写真の producer はまだ切り替えない。読取側との統合完了や本番受入の完了を表す PR ではない。

## 原因と処理の変更

夜・室内の誤差は一つの彩度係数では説明できなかった。NR 単独教師、H/S 単独教師、Texture 単独教師、profile 対だけの教師を分けて調べ、以下を修正した。

- 校正後の負値と明部の余裕を保存し、白変更より前の切り捨てを避ける。既存の unsigned 作業コピーから失われた値は復元できないため、新しい符号化と版を持つ。
- signed RGB 上で色ノイズだけを平滑化し、元の明度を保持する CNR を適用する。
- CNR 後の原本全体から固定 750px の解析画像を作り、H/S の係数を求める。切り抜きや表示倍率で解析する写真の内容を変えない。
- 白・露出変更後の Texture は各 RGB 成分の操作として適用する。
- profile の操作を自然な彩度・彩度・HSL の前へ置く。色域外の値には、clipped linear sRGB 上で求めた profile の差分だけを加える。
- FX30 に不足していた白変換の表を、Apple の実描画から計測した 375 節点の表で補う。既存の機種別行列・露出・レンズ補正は保持する。

処理順: signed master → CNR → H/S → WB・baseline/user exposure → RGB Texture → 基礎 tone / Black → profile → Vibrance → Saturation/HSL → 出力。係数と順序は R236 で固定済み。

## 設定・形式・互換

- 新しい RAW 設定は `engine=niho-3` と `look=niho-standard-2` の組。片方だけの指定は拒否する。バンドルが読める最新版と、新規 JPEG/旧作業コピーの編集既定は分離する。
- metadata がない旧 RAW PNG は従来どおり unsigned gamma1.8、上限2として読む。新形式は `encoding:{kind:"signed-gamma18-v1",ceiling}` を必須とする。
- signed PNG16 は `roundEven(32768 + sign(v) * (abs(v)/ceiling)^(1/1.8) * 32767)`。0を正確に保持し、ceiling は max(1,maxabs)を覆う2の冪、最大65536。未知形式、非有限値、範囲外、壊れた寸法・要素数を拒否する。
- 新形式と旧 RAW engine の混用、および unsigned RAW と niho-3 の混用は拒否する。PNG という拡張子だけで読み方を決めない。
- Swift 0.5.0 の `png16-signed-g18` は明示指定のみ。p3/e4、linearPP・as-shot・boost0・NRoff・gamutOFF・既定sharpness・lensON。原寸でデコードとレンズ補正 → f32 ProPhoto → owned Lanczos4縮小 → 機種別行列 → signed PNG16。原寸書出しは縮小だけ省く。
- レンズの `auto` は機種別指定を使う。Sony の embedded 補正を Apple 補正へ上書きしない。
- `apple-signed-registry.json` を別に持ち、旧 registry は変更しない。FX30 apple-v2 は旧行列の gamutON 計測由来と、新しい処理の gamutOFF の両方を出どころに記録する。
- Swift 0.4/0.5 の受入は旧 recipe の描画が変わらないことを確認して行う。tool の版だけで新形式と判断しない。
- CNR の量は niho-3 の近似操作。Detail/Smoothness は保持して XMP に書き戻せるが、描画は50固定で検証されており独立の効きは未対応。XMP の `noiseReduction` 群は新 engine だけに書き、整数の項目は書出し境界で丸める。内部の適用量による小数値は保持する。旧 engine の XMP bytes は変わらない。

## 出どころと再現

私有の原本・Lightroom 書出し・画素は NAS で保管する。repo に入るのは NIHO が単独操作の教師から求めた係数、機種別計測値、移植コード、テストだけ。Adobe 内部の DCP/LUT は使用・転記しない。

R236 freeze SHA256: `7be32b33da0a8a240ed14418bfb37d64a19a47b1eaa1e8655d50077597991b2d`。係数は R226 と同一で処理順だけが違うため、`tools/export_niho3_assets.py` は R226 frozen assets の hash を検査して表現を変換する。再学習はしない。H/S は26→24→16→2、tanh/tanh/softplus、H負方向上限8EV・S正方向上限4EV。最適化は1200iteration上限で止まり、収束済みとは扱わない。

証跡の入口（内部）: `OWNER_DATA_ROOT`。私有成果物は `phase2a-swift-all`、`phase2a-swift-full`、`phase2a-swift-legacy`、`phase1-preview-master-quality`、`phase1-preview-master`。画像を公開 Issue に添付しない。

## 画質・互換の確認（2026-10-05）

実 Swift producer → Rust Final → Lightroom の全41原本×4条件=164条件を検証。長辺1500・blur2・位置合わせ後の平坦画素による既定の色指標を使用。全 cohort の preset 平均≤3、中立≤2、各 preset のp99≤8を通過。

| 条件 | 全41の平均ΔE00 | scene p99の最大 |
|---|---:|---:|
| neutral | 1.2921 | 4.9779 |
| bluesky2 | 2.1578 | 7.8371 |
| pastel | 2.0609 | 7.9674 |
| colorful | 2.3887 | 7.3864 |

- 各機種の中立平均: DC-S5 n29=1.3321、ZV-E10M2 n11=1.1329、FX30 n1=1.8809。
- actual Swift signed PNG16 対凍結入力: 全41で最大1code、1code超過0、WB自己検査41/41成功。原寸3機種でも同じ上限、最大RSS約1.39GB。
- 旧 recipe の原本3機種: Swift0.4.3と0.5.0でPNG byte完全一致、encoding metadata追加なし。
- 3機種×4preset、CustomWB/CNR/Texture、crop/rotate/straightenの14条件: 同じ1500pxのInteractive対Finalの非ぼかし全画素平均ΔE00は最大0.7831で≤1。全14×2描画のnative/Wasm RGBA差0。FinalのPNGはproduction CLIとも画素一致。
- 定常操作の性能改善後も、代表FinalのRGBAは改善前とbyte一致。全164条件でSIMD Gaussian前後のJPEG bytesも一致。


Issueで指定された元のround7・20場面も別集計した（現在のlensON統一教師。過去の教師とNR等の条件が異なるため当時の数字と同条件の差とは呼ばない）。blue mean1.83585/p99max4.7911、pastel1.93271/7.9674、colorful2.399905/7.3522、中立mean1.185955。全基準通過。`phase2a-swift-all/original-round7-20-summary.json`。

上の164条件は従来の回帰結果。2026-10-06に追加した夜・室内の独立評価は以下のとおり未達であり、総合的な画質合格を示さない。従来の4 holdoutも回帰として扱う。FX30は全体でも1場面で、チャート・機種間の独立評価は未実施。

### 夜・室内の独立評価（2026-10-06、未達）

R238では、既存の評価・学習素材と別の6撮影日群からDC-S5 5枚とZV-E10M2 1枚（ISO1600〜10000）を選び、候補・入力・基準を凍結してからLightroomの24条件を書き出した。長辺1500・blur2・既定の位置合わせと閾値は維持した。

| 条件 | 6枚の平均ΔE00 | scene p99の最大 |
|---|---:|---:|
| neutral | 1.5579 | 5.5221 |
| bluesky2 | 2.7853 | 11.3835 |
| pastel | 3.1044 | 16.3046 |
| colorful | 3.4364 | 13.3067 |

preset 18条件中5条件でp99上限8を超え、pastel/colorfulは平均上限3も超えた。新規signed RAW producerはOFFを維持し、既存保存版の読取・復元と性能改善だけを先に配備する。

R239/R240の追加52条件で、明るい画面を含む暗い室内はShadows +41だけでp99=14.687、明度差約−0.92EVを再現した。別の暖色室内ではWB 5001K/+10だけでp99=12.0205となる。次は単独操作の応答を使い、シャドウ学習時と実行時の入力・後段処理の整合と、RAW白変換・校正の順序を調べる。プリセット別や写真別の補正を足さない。

証跡は私有NASの `independent-night-20261006`、`round239-night-diagnosis`、`round240-single-response`、`round241-input-domain-audit`。R238は失敗後の診断・開発用へ移し、次の候補の独立評価には使わない。次の5撮影日群はmetadata/hashのみで選定し、候補の凍結と従来回帰の通過まで画素を開かない。

原寸対2560の比較は9条件でblurred flat平均≤1だったが、非ぼかし全画素ではSonyの一部が1を超えた（最大約1.865）。同じ出力サイズのInteractive/Finalゲートとは別の解像度・ノイズ依存課題として保持する。

## 性能とキャッシュ

原本のCNR/750解析結果と、設定だけで決まるtail cubeを分けて保持する。非geometryの縮小InteractiveだけはCNR済みsourceを表示寸法に縮小し、H/S・WB/EV・Textureを適用する。Final、max0、縮小なし、geometryは原寸masterの処理順を保つ。signed thumbnailはimmutable sourceを共有し、解析と表示cacheは独立させる。

改善前の参考測定（2026-10-05）。Mac mini M4、Node/Wasm単一スレッド、ZV-E10M2 bluesky2・表示1280:

| 操作 | 実測 |
|---|---:|
| H/S定常drag | 71.1〜73.8ms |
| Contrast定常drag | 56.5〜57.8ms |
| 操作を離した後のFinal1280 | 742〜764ms |
| 初回Final2560 | 4319ms |
| Wasm linear memory | 260,767,744byte |

定常操作は100ms目安以内だが、初回1秒・200MBの目安は未達。CoreImage/GPUを使うSwift raster testはworker sandboxではblack-pixel失敗が出た。同じbuildを通常環境で実行した20 testsは全成功。画面ロックと混同しない。

初回性能のsource改善では、凍結済み係数・各値の演算順・品質gateを維持する。

- CNR=0の解析cacheはSession所有のimmutable sourceを参照し、52MB級の同一cloneを持たない。検証とCNR切替時のcache無効化は維持する。
- H/Sの750px解析をfull-size master/preview cloneより先に完了させ、同時に必要な画像bufferを減らす。
- 解析用unsigned 16bit量子化は、code別のdecode 65536値を正確に再利用する。encode側も各codeの最初のf32入力を求めて使う。inverse powは検索の開始点だけとし、従来のforward `libm::pow` / `libm::round`で境界を補正する。全65535境界と65536入力binの隣接値を参照式と照合する。100万sample未満の初回sourceではencoder表を初期化しない。
- NIHO 3のoutput effectsなし経路だけ、現行f32 OETF＋8bit量子化式から求めた厳密な境界lookupを使う。effectsありと旧engineは従来経路を維持する。
- 補正量を求めるmodelの各出力について入力の加算順を維持し、独立した出力を連続して計算できるループ配置にする。FMAや近似tanhは導入しない。

改善前後は同じ凍結入力・Final解像度・実行機で、別Nodeプロセスを交互に各3回以上測る。表の初期化をcoldに含め、再描画やInteractiveの時間を混ぜない。Wasm linear memoryはプロセス全体のRSSではなく、再open後のhigh-waterも初回と分けて記録する。画像結果は3機種・4presetとWB/Texture/effects/geometry/縮小/CNR切替の22drawでRGBAと寸法を比較する。

### 初回改善の確認（2026-10-06）

M4 mini、同じDSC07517/bluesky2・CNR=0・Final2560×1707、旧公開0.11.0とこのsource変更を別Nodeで交互に各5回。profiler OFF、表の初期化込み、全回でRGBA SHA-256が一致。

| 指標 | 旧公開版 | 改善後 |
|---|---:|---:|
| 初回Final中央値 | 4594.48ms | 3232.20ms（29.65%短縮） |
| 5回の範囲 | 4590.47〜4747.05ms | 3125.84〜3290.34ms |
| 初回Wasm linear memory | 260,767,744bytes | 173,277,184bytes（33.55%削減） |
| 同一instanceの再open後high-water | 313,262,080bytes | 225,771,520bytes |

22drawで旧公開版とRGBA・寸法が完全一致。native/Wasmは3機種、geometry、output effects、CNR25の6caseすべて差0。固定Rust 1.98.1の追加unit5件、Clippy（lib/tests）、既存cache回帰、Wasm smokeも成功。計測途中の3回セットには大きなばらつきがあったため、採否の数値は上の5回セットに揃えた。

代表例の初回200MBは達成、初回1秒は未達。再openやCNRを含む連続操作は200MBを超えることがある。残る時間は色域変換と補正量の解析が大きく、さらに短縮する場合は段階別profileに基づいて計算の事前生成・並列処理を検討する。既存baseの結果や画質gateを変える変更は、この性能改善には含めない。

### CNR の境界計算・一時領域（2026-10-06）

色ノイズ除去が有効なときの17×17 box filterは、横方向の加算結果を最大17行の循環cacheに保持する。画像内側は連続した17画素を読み、反射処理は端の画素と縦方向の行選択だけで行う。各画素のtap順・f64加算・正規化・f32への変換を維持し、差分による移動和や近似値は使わない。CNR量の混合も同じ式で既存の出力bufferへ書く。

2560×1707の横方向一時領域は約35MBから0.35MBになる。これは一時領域単体の値であり、Wasm linear memoryの最大値を表さない。1画素幅・1行・windowより小さい画像・循環cacheの折返し・符号付きの広い値域を、旧全画像版とf32 bit単位で比較する。

公開準備済み0.11.1（#17829）との比較は、DSC01843/colorful・CNR25・Final2560×1707、M4 mini、profiler OFF、別Nodeを交互に各5回。全回RGBAは完全一致。

| 指標 | 0.11.1 | CNR改善後 |
|---|---:|---:|
| 初回Final中央値 | 4278.94ms | 2543.24ms（40.56%短縮） |
| 5回の範囲 | 4263.35〜4285.28ms | 2534.19〜2620.22ms |
| 初回Wasm linear memory | 278,528,000bytes | 278,528,000bytes |

3機種×4presetとWB/Texture/effects/geometry/縮小/CNR切替の22drawは旧版とRGBA・寸法が完全一致。native/Wasmも3機種のCNR25、CNR12.5のInteractive、CNR50、CNR25＋geometryの6条件で差0。一時領域削減は実装したが、工程全体のWasm最大memoryは改善していない。初回1秒・200MBの目安は引き続き未達。旧保存base・係数・処理順・producer flagは変えず、公開は#17829を入れ切った後に次の公開PRで行う。

初回表示の計測では、クラウドの閲覧用プレビュー表示と、編集できる確定画の完成を分ける。RAWは既に準備中から閲覧用プレビューを表示する。現行UIと同じ1280pxのinit＋decode＋描画は、上記写真で別Node交互各3回の中央値3755.02→2023.86ms、全回RGBA一致（ローカル入力で通信・DOM描画は含まない）。上の2560px描画時間をそのままUIの表示時間とは呼ばない。新しい段階表示を足す前に、入力取得を含む利用者の待ち時間を計測する。

### CNR の箱フィルタのSIMDとループの検査（2026-10-08、#17945）

17×17の箱フィルタは、隣り合う8出力の窓の和を2本のf64を1組にしたSIMD（wasm simd128・aarch64 NEON）でまとめて足す。各出力は自分のtapを従来と同じ順にf64で足し、並べ替え・FMAは使わないので、各出力のbitは1画素ずつ足した値と同じ（自動ベクトル化は効いていなかった）。それ以外のCPUは同じ順のスカラー。guided filterの各ループは、値ごとの有限値の検査（途中で抜ける）をループの後にまとめ、最初に失敗した段・画素は従来と同じものを返す。

公開0.11.2と同じbytesのbuildとの比較（`scripts/bench-session.mjs`、別Node交互に各5回、M4 mini）。全段のRGBAが一致。DSC01843 colorful（CNR25）の初回の画（Final1280）2032→1934ms、原寸Final 2643→2548ms、見本3枚3243→3159ms。CNRを使わない写真は変わらない。

### CNR の入力バッファ再利用（2026-10-06、#17830後続）

上記の17行cacheを使い、box filterは入力の所有権を受け取って同じbufferに結果を返す。書き換える行の横方向の和は先にcacheへ入り、その行を必要とする最後のwindowまで残るため、後の読取りや反射境界は元の値を参照できる。二乗・チャンネル値・積・係数a/bの使い終わった配列をそのまま次の出力にする。演算順、f64/f32への変換、CNR量の混合式を変更しない。

#17830とのDSC01843/colorful・CNR25・Final2560×1707の比較（別Node交互各3回、profiler OFF、RGBA完全一致）:

| 指標 | #17830 | 入力buffer再利用後 |
|---|---:|---:|
| 初回Wasm linear memory | 278,528,000bytes | 261,029,888bytes（6.28%削減） |
| 初回Final中央値 | 2531.06ms | 2535.64ms |
| 22draw連続操作の最大linear memory | 330,760,192bytes | 313,262,080bytes |

22drawのRGBA・寸法はすべて一致し、native/Wasmも3機種・CNR12.5/25/50・Interactive・geometryの6条件で差0。凍結した旧全画像box filterとの比較を幅/高さ1〜40の全組合せへ拡大し、単独軸・反射・cache折返しのbit一致も確認した。私有native allocator診断ではCNR単体の実保持量が約17.48MB減ったが、これはWasmの値と別の計測である。初回1秒・200MB、原寸での使用量・利用者の通信込み待ち時間は引き続き課題。公開artifactは別の公開PRで更新する。

### 離した後の原寸マスターの再利用（2026-10-08、#17945）

縮小した非geometryのInteractiveは表示寸法のmasterで描くため、従来はドラッグの1コマ目で原寸masterを捨て、離したFinalで原寸の準備（H/S・WB/EV・Texture）と縮小をやり直していた。`Session`はこの原寸masterとその縮小を退避し、離したFinalの準備keyが同じ（Contrastなどtailの項目だけを動かした）ときに戻す。準備keyが変わるドラッグ（WB/EV・H/S・Texture・CNR）では退避分をその場で捨てるので、原寸masterは常に最大1つ。準備keyは従来からmaster再利用の判定に使っているもので、戻した画は作り直した画と同じ画素になる。

計測は `scripts/bench-session.mjs`（別Nodeを交互に各5回、M4 mini、profiler OFF）。変更前は公開0.11.2と同じbytesに作り直したbuild。Contrastを離した設定をHighlightsのドラッグへ引き継ぎ、開き直しにも両方の変更を渡す。全コマのRGBAが一致。

2026-10-08に固定済みのR236 signed作業コピー4件を同条件で再計測（baseline `c958a6fb…`、候補 `6b80bf4b…`）。

| 写真（ui・1280） | 離した後（Contrast） | 離した後（Highlights） | 初回Final | 再オープンFinal | Wasm memory最高値 |
|---|---:|---:|---:|---:|---:|
| DSC07517 bluesky2 | 703→472ms | 602→600ms | 1886→1899ms | 1634→1641ms | 208→204MB |
| DSC01843 colorful（CNR25） | 393→306ms | 287→289ms | 1895→1892ms | 1601→1593ms | 261→261MB |
| P1581483 bluesky2 | 676→447ms | 570→573ms | 1830→1849ms | 1590→1590ms | 207→203MB |
| DSC07517 neutral | 302→271ms | 326→324ms | 458→472ms | 1212→1210ms | 213→221MB |

初回の画（約2秒）・メモリ200MBの目安は引き続き未達。初回の内訳は、補正量の解析（約1/3）、原寸masterの準備と縮小（約1/3）、cube（約1/8）、画素ごとのtail（約1/5）。

### プリセットの見本・自動と解析の共有（2026-10-08、#17945）

編集画面は写真を開いた直後に、プリセットの見本（同梱3本・96px、`thumbnail(256)`のSessionでFinal）と「自動」の下準備（`autoSettings`）を同じWorkerで描く。どちらも別のSessionで、本体と同じ原寸sourceのCNRと補正量の解析をやり直していたため、ワーカーで合計4.2〜4.4秒、Wasm memoryは最大366〜471MBになっていた。

本体の`AnalysisCache`（CNR済みsource・補正量の係数）を`Arc`で持ち、見本と自動のSessionは本体の解析への弱参照を受け取る。準備のCNR量が同じなら、本体がその解析を持っている間だけ再計算せずに使う（自分の解析と2つから選ぶ）。本体がCNRを変えて手放した解析は見本側も持ち続けない。解析は原寸sourceとCNR量だけで決まり、`prepare`の再利用判定（`AnalysisCache::serves`）も従来と同じなので、見本・自動の結果は再計算と同じになる。見本の描き方（Finalで原寸masterを作って縮小）は変えない。表示寸法で準備するInteractiveの見本は、今の見本と平均ΔE00 1〜5・p99約11違うため採らない。

`scripts/bench-session.mjs`の場面`editor`（開く→初回の画→見本3枚→自動→ドラッグ→離す→開き直し、別Node交互に各5回）で、開いた直後のワーカーの処理（見本3枚＋自動）はDSC07517 bluesky2 4.14→2.63秒、DSC01843 colorful（CNR25）4.31→2.18秒、P1581483 bluesky2 4.07→2.60秒、DSC07517 neutral 4.19→3.45秒。Wasm memoryの最高値は366→335MB、471→314MB、365→330MB、383→331MB。全段のRGBAと自動の結果が一致。見本1枚あたり約0.5秒（原寸masterとcube）は残る。

## 残作業と配備順序

1. source PRをレビュー・統合し、別PRでWasm/sidecarを同じsourceから公開する。公開helperは現在source digest/versionに一意に一致する公開物からWebのengine/crate両方を指定する。
2. API/Web/Desktopのreaderを先に対応させる。APIは`work/download`の明示capabilityを確認してからsigned作業コピーのURLを発行する。非対応は409の再読み込み案内。処理待ちと混同してpoll/retryを続けない。
3. 保存済み`developSettings.base`が参照するartifactを優先する。別の新しいbaseで勝手に上書きしない。欠落時は復元が必要と明示し、プレビュー・記事用レンダラー・原寸書出しでも同じ規則を守る。
4. 新recipeのmetadata/baseVersion・校正snapshot・upload/complete世代照合・Desktop cacheに対応し、新規signedだけniho-3/standard-2で開始する。旧保存値は維持する。
5. readerの配備・互換ゲートと夜・室内を含む独立画質ゲートを通過した後、新規RAW producerを段階有効化する。R238未達の間はOFFを維持する。既存編集済み写真は自動移行しない。WebのXMP保存groupにもCNRを配線する。
6. Chrome本番とDesktopで、プリセット→保存→再読込→記事用/原寸書出し、旧設定・旧タブ・欠落baseの操作を確認し、Issueに受入証跡を追記する。

## 公開物の準備（2026-10-05）

source PR #17793 の実装を公式 `release-engine.mjs release` で公開用にまとめた。Wasm/native crateは0.11.0、bundle engineはniho-3、Swiftは0.5.0、Desktopは0.5.14。Webはniho-3の公開manifestを読むが、新規編集既定はniho-2/std1、旧保存値とproducer recipeは維持する。Desktopは旧recipeのままSwift0.4/0.5両系列を受け付ける。

公開helperのnative/Wasm通常・geometry smokeはいずれもRGBA差0。公開source・Web pin・sidecar lockは一致し、旧registryとsigned registryの計6校正ファイルを同梱する。reader/producer統合と本番受入は未完了。
