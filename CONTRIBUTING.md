# NIHO photo への貢献

このリポジトリは source-visible / all rights reserved で、オープンソースではありません。Issueでの提案や不具合報告を歓迎します。外部からのコード・画像等のPRは、著作権者と利用・改変・配布に必要な権利条件をメンテナーが個別に確認してから取り込みます。CLAは未整備です。PRの投稿だけで著作権の譲渡や、NIHOへの追加の利用許諾に合意したとは扱いません。合意できないPRはマージしません。

## Issueを開く前に

- 既存Issueを検索し、bug、feature、decoder/camera support のフォームを使ってください。
- token、秘密鍵、内部URL、個人情報、実写真・RAW・音声、未修正の脆弱性を公開フォームへ貼らないでください。
- 脆弱性は [SECURITY.md](SECURITY.md) の非公開報告経路を使ってください。
- 再現データは、生成方法を添えた合成fixtureか公開許可を確認できる最小例にしてください。実データの提出が必要な場合は、公開Issueへ添付せずメンテナーと非公開で調整してください。

## PRの進め方

1. Issueで対象範囲を確認し、変更を小さく分けます。既存のprivateソースのcommit履歴は公開リポジトリへ持ち込まないでください。
2. 変更した資産の出所、著作権者、第三者ライセンス、必要なnotice、不要metadataを確認します。NIHO所有資産は公開既定で、一件ずつ許可申請しません。[公開ゲート](docs/security/publication-gates.md) と [資産台帳](docs/legal/asset-inventory.csv) に従います。
3. PRテンプレートに検証結果、公開境界、Issue参照、資産の差分を記入します。検出値やprivate URLを本文・ログへ書かないでください。
4. 公開CIを通し、変更内容と公開境界を確認してからsquashで統合します。`Public CI required` の成功と未解決レビュー会話の解消がGitHub上の必須マージ条件です。CODEOWNERSは担当者の案内に使い、承認レビューは必須にしません。外部からのコード・資産は、別途合意した利用許諾を記録するまでマージしません。

## ローカル確認

公開済みのphoto-editing・共有UIはNode.js 24とnpmで検証します。

```bash
npm ci --ignore-scripts --no-audit --no-fund
npm run verify
git diff --check
gitleaks dir --redact=100 --ignore-gitleaks-allow --no-banner .
```

import済みファイルを編集した場合は、出典hashを保持したまま変更理由付きでmanifestを更新してください。画像等の追加は公開可能の資産台帳とexact hashの一致が必要です。合成fixture、未移行nativeのコマンド、公開CIの範囲と制約は [公開CIの実行契約](docs/ci/public-ci.md) を参照してください。外部fork PRにも本番secretやprivate runnerを渡しません。

## 責務境界

本リポジトリはMacクライアント、写真編集、RAW現像、PKCEログイン、クラウド共有のUI・公開API contract・mock、updaterクライアントを扱います。API、DB、object storage、認証・認可の最終判定、Apple署名・公証、本番配布は非公開側の責務です。公開PRでこれらの権限やsecretを追加しないでください。
