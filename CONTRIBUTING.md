# NIHO photo への貢献

このリポジトリは source-visible / all rights reserved です。Issueでの提案や不具合報告を歓迎します。外部からのコード・画像等のPRは、権利条件をメンテナーと個別に確認してから取り込みます。PRの投稿だけで著作権が移転したり、NIHOに再配布許諾が自動で与えられたりするものとは扱いません。

## Issueを開く前に

- 既存Issueを検索し、bug、feature、decoder/camera support のフォームを使ってください。
- token、秘密鍵、内部URL、個人情報、実写真・RAW・音声、未修正の脆弱性を公開フォームへ貼らないでください。
- 脆弱性は [SECURITY.md](SECURITY.md) の非公開報告経路を使ってください。
- 再現データは、生成方法を添えた合成fixtureか公開許可を確認できる最小例にしてください。実データの提出が必要な場合は、公開Issueへ添付せずメンテナーと非公開で調整してください。

## PRの進め方

1. Issueで対象範囲を確認し、変更を小さく分けます。既存のprivateソースのcommit履歴は公開リポジトリへ持ち込まないでください。
2. 変更した資産の出所、著作権者、公開許可、第三者ライセンス、必要なnoticeを確認します。[公開ゲート](docs/security/publication-gates.md) と [資産台帳](docs/legal/asset-inventory.csv) に従います。
3. PRテンプレートに検証結果、公開境界、Issue参照、資産の差分を記入します。検出値やprivate URLを本文・ログへ書かないでください。
4. メンテナーのレビューと公開CIを通してからsquashで統合します。外部からのコード・資産は、別途合意した利用許諾を記録するまでマージしません。

## ローカル確認

現在の`main`は公開移行前で、アプリのworkspaceはまだありません。文書だけを変更した場合は次を実行します。

```bash
python3 -m json.tool docs/security/publication-policy.json >/dev/null
git diff --check
gitleaks dir --redact --no-banner .
```

アプリ移行後は、対象パッケージのREADMEにinstall、format、targeted test、unsigned Mac buildのコマンドを追記します。公開CIはfork PRでもsecretを渡さず実行する設計です。

## 責務境界

本リポジトリはMacクライアント、写真編集、RAW現像の公開可能部分、PKCEログインクライアントを扱います。API、DB、クラウド写真、認証・認可の最終判定、Apple署名・公証、本番配布は非公開側の責務です。公開PRでこれらの権限やsecretを追加しないでください。
