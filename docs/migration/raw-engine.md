# RAW現像の公開移植（#9）

## 出典と範囲

固定baselineは `niho-app` の `b297515ba7b319da402b7814fb406509ba664ba9`、監査候補は `niho-clients` の `6ac52f62d3e5a1bacf9cc422a0e69ccfce9134ee`。履歴を取り込まず、新しいファイルとして移植した。各ファイルのsource SHA-256、出力SHA-256、変更理由をpublication manifestへ記録する。

移植はRust workspace8 crate、所有モデル9件、所有校正値・Look・preset、必要なテスト、校正補助tool、Apple RAW/背景除去toolのソース。非公開署名・配布・API・private絶対path・credentialは含まない。旧DCP8件とspec4件、LibRaw表・constructor・CLI・校正tool初期値・テスト中の写しを除外または独立合成値へ置換した。第三者ColorChecker基準値、外部ICC、不要な色比較写真・HTML、私有の実験buildは移植しない。

## 所有モデルと第三者コード

2026-10-20、オーナーは撮影原本、校正値、自身で調整・抽出した係数と参照出力の所有・公開許可、および実ユーザー提供素材を含まないことを確認した。モデル9件はbaseline/candidateのfile SHAを照合し、元の凍結fit/protocol、入力のhash、変換tool、runtime検証sourceと結び付けて [モデル由来](../legal/model-provenance.json) に記録した。NIHO自身の推定係数とAdobe/Apple内部モデルのファイルそのものを区別し、後者をコピーしない。私有原本が無くても公開build/testは動く。

DNG SDKから転記したACR3表・温度表等は所有係数とは扱わない。元zipと全文のSHAを確認し、全文とnoticeを同梱した。LGPL rawlerの対応source・告知・改変/relink権はNIHOのproprietary条件で制限しない。詳細はworkspace LICENSESとTHIRD_PARTY_NOTICESを参照する。

## 実RW2の公開監査

公開対象は無人の教室・黒板・ストーブの所有写真。目視とローカル人物検出で確認し、自動検出0件だけを公開判断にしない。人物が含まれた先の候補は公開対象から除いた。一般の比較写真もテストに不要なものは同梱しない。

ExifToolの一括削除だけではserialと埋込JPEGが残るため、元のmetadata領域をコピーしないsanitizerを作成した。必要なnumericタグ、Make/Model、圧縮sensor stripからRW2を再構築し、GPS・serial・氏名・EXIF・MakerNotes・camera IFD・埋込thumbnail/JPEG・ICC・撮影日時を含めない。元と再構築後で圧縮strip、sensor寸法/crop/CFA、WB、black/white、原寸camera RGB PNGを一致確認した。監査JSONにはsource/output/strip/原寸と512pxのhashを記録し、私有配置は記録しない。

1ファイル上限はオーナー指示により50MiBへ変更した。RAW受入は実RW2で常時実行し、合成コンテナの単体テストを実RAWの証拠とは扱わない。

## 独立DCPと再現

所有RAWとカメラJPEGの対応を7写真から抽出し、写真ごとに5学習/2検証へ先に分離。カメラ行列の初期値を入れず、白を保存する最小二乗でcamera-WB RGBからlinear sRGBを求め、標準色空間の変換だけでDCPのColorMatrix/ForwardMatrixへ変換した。LibRaw、rawtoaces、既存DCP、メーカーprofileの行列はfit入力にしない。新DCPのEmbedPolicyは2（EmbedNever）とし、proprietary条件と整合させる。

撮影写真の画素画像は検証側に公開せず、匿名の色の対応対と入力SHAを公開する。公開RAWは学習側scene-03であり、heldoutとは呼ばない。Python標準ライブラリだけで測定対→fit→spec/検証reportを再生成し、Rustでspec→DCP bytesを再生成して公開DCPと完全一致させる。source写真の重複を拒否する。

先に固定した色だけの指標（XYZ Yを揃えたΔE76、mean≤8・p95≤18）で、未使用2写真はmean 4.13669/4.19327、p95 13.33875/13.61184。トーン、絶対WB、チャート測色精度、他機種、別光源への一般化は実証していない。既存Apple校正値をRAW ColorMatrixへ流用していない。

## 検証

公開CIでは固定Rust 1.98.1でfmt/clippy/test、必須RW2/golden、測定再生成、sanitizer境界、wasm32 buildと共通hashテストを実行する。未公開の写真、ローカルの参照生成binary、署名credentialをCI入力にしない。

この作業ホストの空き容量が1GiB未満のため、全workspaceの重いcompile/testは公開CIへ任せる。ローカルはpublication/format、対象guard test、DCP再生成、限定した色/profile crateテスト、元とsanitized RAWの実decoder照合を実施する。Swift toolの実機受入とバイナリ配布はこのRust移植CIで完了とは扱わない。
