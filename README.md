# NIHO photo

NIHO photo の公開クライアント開発リポジトリです。Mac アプリ、写真編集、RAW 現像、公開可能なログインクライアントを、監査を通過した範囲から順に移行します。現時点の `main` は移行準備中で、アプリのビルド手順はまだありません。

認証・認可の最終判定、API・DB、クラウド写真、署名・公証・本番配布は非公開の `niho-app` が管理します。ここにあるコードや CI の成功だけで、本番配布やクラウドへのアクセス権は得られません。

## 公開範囲と権利

このリポジトリは **source-visible / all rights reserved** です。オープンソースライセンスは付与していません。[GitHub の利用規約上認められる閲覧・fork](https://docs.github.com/en/repositories/managing-your-repositorys-settings-and-features/customizing-your-repository/licensing-a-repository)を除き、独立した再配布、改変、商用利用を許諾しません。第三者の依存物には、それぞれの権利条件が適用されます。OSS ライセンスの採用は別途判断します。

公開前の判定基準は [publication-gates.md](docs/security/publication-gates.md)、候補資産の状態は [third-party-assets.md](docs/legal/third-party-assets.md) に記録します。監査未了の資産は公開しません。

## 開発と報告

移行後のローカル検証手順は、各 workspace の README と `CONTRIBUTING.md` に掲載します。現時点で実行できる確認は文書リンクと監査台帳の整合確認です。

秘密情報、実利用データ、内部 URL、未修正の脆弱性を公開 Issue・PR・CI ログへ載せないでください。脆弱性は[GitHubの非公開報告窓口](https://github.com/niho-coliving/niho-photo/security/advisories)から報告してください。
