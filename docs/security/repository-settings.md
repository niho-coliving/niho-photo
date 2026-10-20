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
| CODEOWNERS | `niho3`と`takuyatakahama3`を担当者として記録。承認の必須条件には使わない |
| 必須レビュー | 0件。CODEOWNERS承認を含む承認レビューをマージ条件にしない。未解決review threadの解決は必須 |
| 必須CI | `Public CI required` をGitHub Actions app ID 15368に固定して登録。最新mainでの成功を要求。外部fork PR #18で成功を確認済み |

## rulesetを再設定する手順

1. CODEOWNERSと公開CIのworkflowを既定ブランチに反映する。
2. 外部forkのPRを作り、secretやprivate runnerなしで `Public CI required` が成功することを確認する。
3. mainのrulesetに `Public CI required` をGitHub Actions app ID 15368で登録し、最新mainでの成功を要求する。承認レビューは0件、CODEOWNERS承認は不要、未解決review threadの解決は必須とする。
4. squashのみ、mainの削除・force push禁止、Private vulnerability reporting、secret scanning、push protectionを確認する。
5. 設定値と外部forkの検証結果をこの文書に記録する。

2026-10-20にはworkflowを既定ブランチへ反映した後、外部fork PR #18の成功を確認して必須CIを登録した。workflowの検査job名や集約条件を変えるPRでは、rulesetと検査の双方が成立することを確認する。
