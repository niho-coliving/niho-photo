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
| CODEOWNERS | `niho3`と`takuyatakahama3`。CODEOWNERSレビューを必須に設定 |
| 必須レビュー | 1件。PR作成者自身の承認は数えず、CODEOWNERSの承認を要求 |
| 必須CI | `Public CI required` をGitHub Actions app ID 15368に固定して登録。最新mainでの成功を要求。外部fork PR #18で成功を確認済み |

## 設定変更の確認

1. CODEOWNERSと公開CIの定義を既定ブランチに反映済み。
2. 外部fork PR #18でsecretやprivate runnerなしに `Public CI required` の成功を確認済み。
3. `Public CI required` をrulesetのrequired status checksへ登録済み。required reviewと合わせ、PR作成からsquash mergeまでの動作を継続確認する。
4. ruleset、Private vulnerability reporting、secret scanning、push protectionが有効であることを再確認済み。

必須CIはworkflowの既定ブランチ反映と外部fork実測の後に登録した。workflowの検査job名や集約条件を変えるPRでは、rulesetと検査の双方が成立することを確認する。
