## 目的とIssue

<!-- 完了するIssueはFixes #番号、部分的な進捗はRefs #番号 -->

## 変更内容

- 変更点を記載してください。

## 公開前確認

- [ ] 初回移植はmanifestの監査済みパスだけを追加し、非公開Git履歴を取り込んでいない
- [ ] 移行元の完全commit SHAとファイルhashを監査記録に残した（移行PRの場合）
- [ ] API・DB・本番secret・署名・内部URL・実利用データを含まない
- [ ] 所有資産の由来、第三者資産のライセンスと必要なnoticeを確認した
- [ ] 写真・RAW等のfixtureから不要なGPS、serial、氏名、thumbnail、Finder属性、ICC等を確認・除去した
- [ ] 公開クラウドAPIは改変clientを前提とし、認証・認可・quota・MIME・size・ownershipをサーバー側で検証するcontractにした
- [ ] source-visible / all rights reserved と第三者ライセンスの境界を確認した
- [ ] 外部からのコード・資産は、個別の利用許諾の記録をメンテナーと確認した

## 検証

- 実行したコマンドと結果:
- 未実行の検証、理由、代替:
- CIの結果:

検出値、内部URL、実写真・RAW、個人情報、未修正の脆弱性をこのPRやCIログへ貼らないでください。脆弱性は`SECURITY.md`の非公開窓口へ報告してください。
