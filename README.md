# NIHO photo

NIHO photo の**原則公開（default-public）**なクライアント開発SSOTです。現在はMacアプリ、写真編集のTypeScript/React共通パッケージと共有UIを含みます。RAW現像、OAuth/PKCEログイン、クラウド共有、公式build/release手順は後続Issueで移行します。公開ソース・API contract・アプリバイナリは誰でも解析・改変できる前提です。

認証・認可の最終判定、API・DB・object storage、実ユーザーデータ、署名秘密鍵・公証資格情報・本番配布権限は非公開の `niho-app` と実行環境が管理します。公開クライアントの自己申告や画面上の制限をサーバーの認可に使いません。ここにあるコードやCIの成功だけで本番配布やクラウドへのアクセス権は得られません。

## 公開範囲と権利

このリポジトリは **source-visible / all rights reserved、not open source** です。NIHO所有コード・資産には [LICENSE.md](LICENSE.md) と [ASSET_LICENSE.md](ASSET_LICENSE.md)、名称・ロゴには [TRADEMARKS.md](TRADEMARKS.md) を適用します。[GitHubの利用規約上認められる閲覧・fork](https://docs.github.com/en/site-policy/github-terms/github-terms-of-service)を除き、独立した再配布・改変・商用利用を許諾しません。第三者の依存物には、それぞれの権利条件が優先します。

Photoクライアントの所有コード・校正値・写真・RAW fixture等は公開既定です。初回移植は出典とhashを固定し、第三者資産、秘密情報、個人情報、不要な画像metadataを監査します。既存DCP 8件は第三者由来部分があるため除外し、独立計測で置換します。判定基準は [publication-gates.md](docs/security/publication-gates.md)、候補資産の状態は [third-party-assets.md](docs/legal/third-party-assets.md) に記録します。

## 開発と報告

Node.js 24 と npm を使い、リポジトリのルートで実行します。

```bash
npm ci
npm run verify
```

個別に実行する場合は `npm run typecheck`、`npm test`、`npm run lint`、`npm run format:check`、`npm run verify:publication` を使います。各workspaceは `npm -C packages/photo-editing test` などでも検証できます。`npm run lint` でHooksと文字サイズの規約を、`npm run format:check` で移植ファイルの改行と行末空白を、`git diff --check` で変更箇所の空白を確認します。

`niho-photo-editing` は編集ロジックとReact部品、`niho-ui` は必要最小限のUIを提供します。ホストがCSS・写真の読み書き・保存・実行環境を提供する構成です。Macアプリは `apps/camera` にあります。Macの前提環境と実行方法は [camera README](apps/camera/README.md)、命名・端末データ互換は [Mac移植計画](docs/migration/mac-client.md) を参照してください。

```sh
npm run dev --workspace apps/camera
npm run build:unsigned --workspace apps/camera
```

組み込み条件、fixtureの置換、後続Issueへの移行範囲は [allowlist-base.md](docs/migration/allowlist-base.md) を参照してください。

公開CIは全PRとmain pushで動きます。安定した必須チェック名は `Public CI required` です。変更範囲、未移行のnative scope、資産・ライセンス検査、manifest更新手順は [公開CIの実行契約](docs/ci/public-ci.md) を参照してください。

公開前の追加確認:

```bash
python3 -m json.tool docs/security/publication-policy.json >/dev/null
git diff --check
gitleaks dir --redact --no-banner .
```

秘密情報、実利用データ、内部 URL、未修正の脆弱性を公開 Issue・PR・CI ログへ載せないでください。脆弱性は [SECURITY.md](SECURITY.md) の非公開窓口（[GitHubの非公開報告窓口](https://github.com/niho-coliving/niho-photo/security/advisories)）から報告してください。非公開移行元と公開Issueの対応は [source-map.md](docs/migration/source-map.md) に記録します。

Docs/Photo共通の認証・クラウド安全契約は [Photo #8](https://github.com/niho-coliving/niho-photo/issues/8) と [Docs #15](https://github.com/niho-coliving/niho-docs/issues/15) に追跡します。両クライアントは同じ版の公開contract・mock・security testを使い、片方だけの境界変更を避けます。
