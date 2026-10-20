# 共通写真編集基盤のallowlist移植

Issue #11 の初回移植では、写真編集のTypeScript/React共通部品と、必要な共有UIを取り込む。

- 現行ソースの基準: `niho-app` / `b297515ba7b319da402b7814fb406509ba664ba9`
- 監査済み候補との照合点: `niho-clients` / `6ac52f62d3e5a1bacf9cc422a0e69ccfce9134ee`
- 非公開リポジトリのremote・Git履歴は公開側へ取り込まない。ファイルの出典と内容ハッシュは [publication-manifest.json](../security/publication-manifest.json) で固定する。

## 採用範囲

`packages/photo-editing` の追跡ソース・設定を採用する。元のpackage-lockは取り込まず、公開側の2 workspaceを対象にルートlockを新規生成する。

現行と監査候補の全対象パスをblob単位で比較した。写真編集は197ファイルすべて一致する。UIの差分3ファイルのうち、今回必要な `local-storage-safe.ts` とそのテストは現行を採用し、対象外の `tailwind-theme.cjs` は含めない。留保する4範囲ではcameraの3ファイル、desktop-photoの1ファイル、desktop-accountの2ファイルに差分があり、develop-engineは一致する。

`packages/ui` は写真編集がimportする14モジュールと相対依存を採用する。`app-dialog` の待ち行列は表示ホストがなければrejectするため、実行に必要な `components/app-dialog-host.tsx` を追加し、合計15モジュールとした。対応する既存テスト10ファイルとlint・型検証に必要な設定4ファイルも含める。写真編集を組み込むホストは `AppDialogHost` をルートに1つmountする。

共有UIのフォント・画像・アカウントUI・テーマCSS・Tailwind設定は含めない。画面を組み込むアプリはCSS、`PhotoLibraryProvider` とホスト実装、`QueryClientProvider` を用意する。今回の成果物は共通パッケージであり、起動可能なMacアプリや単独Web画面の配布物は後続Issueで作る。

公開側への調整はpackageの説明とexports、npm workspaceでの依存解決、TypeScriptの固定node_modules参照、非公開のパス・設計文書・Issueを指すコメント、予約済み `.test` ドメインのテストURLに限定する。個別の変更はmanifestの `modifications` に記録する。

## fixtureの置換

資産台帳の `packages/photo-editing/src/fixtures/cutout-brush-parity.json` は「要置換」である。元のJSON・PNG/base64・数値はコピーしていない。公開版には新規に作った5×5整数ランプと、中央行のerase・中央1画素のrestoreを手計算した期待値だけを置く。PNGの読み込みはテスト内の合成生成器で確認する。写真・RAW・DCP・モデル・音声・フォント・その他バイナリは今回取り込まない。

元のSwift実装とTypeScriptのcross-runtime parity検証は、この置換では成立しない。sidecarを公開する #9 で、出所を明示した共通fixtureと双方の実行結果を改めて検証する。

## 調査済み・後続Issueへ留保する範囲

下記4範囲は上記2つのexact commitでファイル一覧とpackage/Cargo設定、依存境界を確認した。現行ソースの追跡ファイル数を示す。コードは今回取り込まない。

| 範囲 | ファイル数 | 後続Issue | 留保する理由 |
| --- | ---: | --- | --- |
| `apps/camera` | 74 | #7 | Tauriホスト、署名・更新・配布経路を切り分け、公開用の起動経路を整える必要がある |
| `packages/desktop-photo` | 22 | #7 | 端末ファイル、sidecar、保存済み補正と作業コピーの接続をMacアプリと一緒に検証する |
| `packages/develop-engine` | 652 | #9 | RAW現像・WASM・sidecarと、要置換または非公開の資産を分離する必要がある |
| `packages/desktop-account` | 46 | #3 | ログイン、端末内token保管、外部APIと公式配布アプリの権限境界を確認する必要がある |

認証・API・DB・クラウド接続の実装、release/updater/署名、公証用の設定は今回のallowlistに含まれない。写真編集に残るengine clientと接続口の型は、ホストが提供する能力を読む共通コードであり、RAWエンジン本体やモデルは同梱していない。

## 検証

ルートの `npm ci` 後に `npm run verify` でallowlist、型、両workspaceのテスト、lintを検証する。`npm run verify:publication` は出典と出力のハッシュ・変更理由・禁止パス・上限サイズ・UTF-8・未記録のpackageファイル・lock内の公開registry参照を確認する。元バイト列の出典ハッシュは移植時にexact commitから計算済みで、公開checkoutで非公開リポジトリへアクセスする必要はない。

ソースを編集したときはmanifestの出力ハッシュと変更理由も更新する。新規ファイルは公開範囲を確認してallowlistに記録する。追加の境界検査は `git diff --check` と `gitleaks dir --redact --no-banner .` で行う。
