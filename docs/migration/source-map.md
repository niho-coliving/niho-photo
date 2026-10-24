# 非公開候補から公開Issueへの追跡

非公開 `niho-clients` は移行用の参考資料であり、Git履歴を `niho-photo` へ取り込まない。下表のPR番号・commitは権限のあるメンテナーが照合するための識別子で、非公開URLや本文を公開Issueへ転載しない。

| 非公開Draft PR | 候補head commit | 公開側のIssue | 対象 |
| --- | --- | --- | --- |
| #5 | `93e8d7c5275a06b81f2ec30345c6b45fdde29389` | [#11](https://github.com/niho-life/niho-photo/issues/11), [#7](https://github.com/niho-life/niho-photo/issues/7) | 共通写真編集面 |
| #6 | `fac3d0e69cc3a8d810bd6e8caf1ab88ae6159db7` | [#11](https://github.com/niho-life/niho-photo/issues/11), [#7](https://github.com/niho-life/niho-photo/issues/7), [#9](https://github.com/niho-life/niho-photo/issues/9) | MacアプリとRAW現像 |
| #7 | `123564486a0c9486875b2fab846d166d7b091ac0` | [#3](https://github.com/niho-life/niho-photo/issues/3) | 公式Photoのログインゲート |
| #9 | `6ac52f62d3e5a1bacf9cc422a0e69ccfce9134ee` | [#10](https://github.com/niho-life/niho-photo/issues/10) | 変更範囲別CIの参考 |

公開PRを作成するたび、ここに公開PR番号、移行元commit、採用したファイル群、除外した資産、公開側commitを追記する。最新の非公開 `niho-app` との差分も移行直前に読み取りで確認する。

## 非公開 `niho-clients` をarchiveする前の確認

- [ ] [#11](https://github.com/niho-life/niho-photo/issues/11) のallowlist移植と権利・secret監査が完了している
- [ ] [#7](https://github.com/niho-life/niho-photo/issues/7)、[#9](https://github.com/niho-life/niho-photo/issues/9)、[#3](https://github.com/niho-life/niho-photo/issues/3) の公開コードがビルド・テスト可能である
- [ ] [#8](https://github.com/niho-life/niho-photo/issues/8) と [Docs #15](https://github.com/niho-coliving/niho-docs/issues/15) の共通auth/cloud契約のSSOT・版・相互参照が決まっている
- [ ] [#2](https://github.com/niho-life/niho-photo/issues/2) の公開成果物・SBOM・固定SHA取り込み契約が定義されている
- [ ] 公開CIとSecurity Advisories、CODEOWNERS、branch rulesetが有効である
- [ ] 既存DCPを除外し所有RAWから独立推定したDCPで置換する記録と、実データ・署名鍵等の非公開の所有先を確認した
- [ ] `niho-app` 側が公開成果物の固定SHAを取り込み、同じproduction sourceを二重編集していない
- [ ] オーナーが最終統合とarchive時期を確認した

archive操作自体は本Issueの対象外とする。
