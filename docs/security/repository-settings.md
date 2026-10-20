# GitHub公開運用設定

この文書はリポジトリ内の設定ファイルだけでは再現できないGitHub側の設定を記録する。変更後は実際の設定を読み取り、日付と結果を更新する。

## 2026-10-20時点

| 設定 | 状態 |
| --- | --- |
| リポジトリ | public、既定ブランチ`main` |
| マージ方法 | squashのみ |
| Secret scanning / push protection | 有効 |
| Private vulnerability reporting | 有効。窓口は[SECURITY.md](../../SECURITY.md) |
| main ruleset | `main pull requests`、ID `25466080`、有効。削除とforce pushを禁止し、PR・squash・レビュー会話の解決を要求 |
| CODEOWNERS | `niho3`と`takuyatakahama3`。`.github/CODEOWNERS`が既定ブランチに入った時点で適用 |
| 必須レビュー | 1件、CODEOWNERSレビュー必須、push後の古い承認を破棄 |
| 必須CI | [#10](https://github.com/niho-coliving/niho-photo/issues/10)でfork-safeなチェック名と実行を確認後、rulesetに登録 |

## 設定変更の順序

1. CODEOWNERSと公開CIの定義を既定ブランチに反映する。
2. 外部forkのPRで必要なチェックがsecretやprivate runnerなしで動くことを確認する。
3. 成功したチェック名をrulesetのrequired status checksへ登録し、PR作成からmerge queueまでの動作を確認する。
4. ruleset、Private vulnerability reporting、secret scanning、push protectionが有効なことを再確認する。

必須CIを先に登録すると既存の文書PRにチェックが発生せず統合できなくなるため、チェックの実在と実行を確認してから登録する。
