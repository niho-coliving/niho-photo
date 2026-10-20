# 公開CIの実行契約

このCIは、すべての `pull_request` と `main` の `push` で動きます。stacked PRも対象です。GitHub-hosted Ubuntu/macOSと `contents: read` だけを使い、checkoutの資格情報保持を無効にしています。外部forkの実行に本番secret、環境、private runner、署名・公証・updater・deployは必要ありません。初回投稿者の実行承認はGitHubのfork保護設定に従います。

## 安定した必須チェック

rulesetへ登録する名称は **`Public CI required`** です。常に出る集約jobが全jobの結果とplanの予定を検査し、失敗・取消・想定外のskipを拒否します。文書変更でも公開・secret・依存の検査は行います。変更範囲の実行結果、未導入scopeは `Change scope` のログで確認できます。

| 検査 | 実行条件とコマンド |
| --- | --- |
| Publication guard | 全実行。全追跡ファイルと未追跡の公開候補に `npm run verify:publication`、`npm run format:check`、policyの否定テスト、空白検査 |
| Secret scan | 全実行。checkoutした公開Git履歴の全refをgitleaksで走査。検出値は完全redact。PR側のignore/allow commentは採用しない |
| Dependency review | 全PR。GitHub依存グラフの差分からmoderate以上の脆弱性とAGPLの追加を拒否。runtime/development/unknownを含む。PRコメント権限なし |
| Photo editing | `packages/photo-editing`・`packages/niho-cloud-contract`・`packages/ui` 変更。`npm ci --ignore-scripts` 後、Photo editing / UIのtypecheck / test / lint とDocs固定SHAとのcontract同期確認 |
| Camera | `apps/camera` 導入後。camera、account、写真関連パッケージ変更時。npmのtypecheck / test / lint / `build:unsigned` と宣言されたnative検査 |
| Desktop photo | `packages/desktop-photo` 導入後。desktop-photo、account、photo-editing、ui、develop-engine変更時。Cargoのfmt / clippy / test |
| Desktop account | `packages/desktop-account` 導入後。同パス・UI変更時。`ts`をroot workspaceへ登録し、npmのtypecheck / test / lint とRustのfmt / clippy / test |
| Develop engine | `packages/develop-engine` 導入後。同パス変更時。Cargoのfmt / clippy / test と宣言されたSwift test |

`.github/`・`scripts/`・root package/lock・`docs/security/`・`docs/legal/`・`docs/ci/` の変更では、導入済みの全scopeを実行します。PRはeventのbase SHAとcheckoutしたmerge commitを比較します。pushはbefore SHAを使い、初回pushは全scopeです。削除も差分に含め、branch名・PRタイトルをshellへ展開しません。

現在の公開treeはphoto-editing・UI・camera・desktop-photoです。cameraとdesktop-photoのnative scopeは有効です。desktop-accountは#3で導入し、TS・Rustの両方を検証します。develop-engineの検証契約は#9に従います。scopeのディレクトリが追加されると検査が自動で有効になり、メタデータ不足は失敗になります。アカウントのversioned正本・Rust/TS・Photoのdigest pinは `scripts/ci/account-contract.test.mjs` で検証します。Docs側の採用と双方CIの連動は#8の統合条件です。Docs / Photo共通contractは `packages/niho-cloud-contract` にDocsの完全SHAからコピーし、Publication guardで同一内容を検査します。新しい公開packageが増えたらscopeの依存関係もレビューしてください。

## nativeを移植するとき

cameraはroot workspaceへ登録し、typecheck / test / lint / `build:unsigned` のpackage scriptsを用意します。desktop-accountは `packages/desktop-account/ts` をroot workspaceへ登録します。desktop-photoとdevelop-engineはCargoを直接使い、npm workspace登録は要求しません。camera・desktop-photo・desktop-account・develop-engineは各rootに `LICENSES.md` と次の `public-ci.json` を置きます。これらもpublication manifestへの登録が必要です。

```json
{
  "schemaVersion": 1,
  "syntheticFixtures": true,
  "unsigned": true,
  "cargoManifests": ["Cargo.toml"],
  "swiftPackages": []
}
```

cameraなら `cargoManifests` は例えば `src-tauri/Cargo.toml`、Swift sidecarがあれば `swiftPackages` に実際のPackage.swiftのディレクトリを列挙します。各Cargo manifestと同じディレクトリにCargo.lockを置きます。Cargoは `fmt --all -- --check`、`clippy --locked --all-targets -- -D warnings`、`test --locked` を実行し、Swiftは `swift test --package-path` を実行します。必要な追加toolchain・公開依存・合成fixtureを移植PRで確定してください。private CIのコマンドや実データをコピーして補いません。

## 公開ガードとmanifestの更新

Dependency reviewの脆弱性例外は [限定例外の記録](../security/dependency-exceptions.md) に根拠と見直し条件を記載します。

`publication-manifest.json` のschemaVersion 1と出典baselineを維持します。apps/packagesの全ファイルは、出典hashとoutput hashを持つimported、または独立した生成元を持つgeneratedとして明示します。登録の削除・追加、出典の変更は自動化せずPRでレビューします。既存ファイルの公開後の編集は次で1ファイルずつ更新できます。

```bash
node scripts/update-publication-manifest.mjs --path packages/photo-editing/src/example.ts --reason '合成入力に対する露光計算を修正。'
npm run verify:publication
```

更新コマンドは元の出典hashを保持し、output hashと具体的な変更理由だけを更新します。権利・secret検査の代わりにはなりません。新規ファイルのmanifestは手動で登録し、出典・変更理由、または独立した生成方法をレビューしてください。

ガードは禁止path/basename/拡張子、50 MiB上限、symlink/submodule、非公開URL/package参照、非npm registry依存、manifest重複・欠落・hash不一致を拒否します。既存禁止項目と上限はpolicy JSONを消しても緩まりません。全公開候補が対象で、packages外の文書・画像も検査します。検出内容の値をログへ出しません。

画像・font・binary・校正・fixture等はmanifestに加え、資産台帳の「公開可能」とpath・SHA-256・サイズが一致する必要があります。NIHO所有資産は個別の許可申請ではなく由来の宣言と不要metadataの確認を台帳へ記録します。監査済みPNG/ICNSを追加する場合もexact bytesを照合します。要置換・非公開維持の元hashはrenameしても拒否します。独立した合成fixtureのJSON/CSV/TXTはgeneratedに生成方法を記録できます。所有者撮影のRAW・音声fixtureもメタデータ確認後に登録できますが、現在のGit treeでは50 MiB上限を超えるファイルを拒否します。大きなfixtureの経路は[#2](https://github.com/niho-coliving/niho-photo/issues/2)で定義します。旧DCP8件はhashと元の行列で拒否します。独立DCPは所有測定の入力hash、再現可能なfit/spec/検証report、生成DCP bytesの一致を要求します。

private URL検査は既知のprivate repo/host・LAN・内部ドメイン・認証付きURL、package検査はregistry外参照を扱います。任意の新しいprivateサービスの権利や機密性までは自動判定できません。出所、第三者ライセンス、個人情報、ICC/EXIF、入力の実データ混入はCODEOWNERSを含むレビューで確認してください。CI成功で公開許可が新たに与えられることはありません。

## Actionと取得物の固定

2026-10-20、各上流のtagを `git ls-remote` で確認しました。workflowの `uses` は下記の40桁commit SHAだけを許可しています。workflowファイルは外部parserなしで構造検証できるJSON形式のYAMLです。変更は検証可能なJSON形式を保ってください。

| 上流tag | commit |
| --- | --- |
| actions/checkout v4.2.2 | `11bd71901bbe5b1630ceea73d27597364c9af683` |
| actions/setup-node v4.4.0 | `49933ea5288caeca8642d1e84afbd3f7d6820020` |
| actions/dependency-review-action v4.8.2 | `3c4e3dcb1aa7874d2c16be7d79418e9b7efd6261` |
| gitleaks v8.24.3 | `107a41827bb6698dbbff756b2300537774a1d84c`（annotated tagを解決） |

gitleaksはActionを使わず、[上流release](https://github.com/gitleaks/gitleaks/releases/tag/v8.24.3)のLinux x64 tar.gzを `9991e0b2903da4c8f6122b5c3186448b927a5da4deef1fe45271c3793f4ee29c` で照合します。[同commitのdefault config](https://github.com/gitleaks/gitleaks/blob/107a41827bb6698dbbff756b2300537774a1d84c/config/gitleaks.toml)も `8f393899dbdc67e4eae580909e496acab9cf3a75aacfb6fac56b6eb16bb9e051` で照合します。更新時は上流の実バイト列を再検証し、scriptとpin検査・この記録を同じPRで更新します。ネットワーク障害やchecksum不一致は失敗にします。

## ローカル確認とGitHub側の確認

```bash
npm ci --ignore-scripts --no-audit --no-fund
node --test scripts/ci/*.test.mjs
npm run verify
# ローカルのgitleaksでも全履歴と未commit差分をredactして確認
gitleaks git --redact=100 --ignore-gitleaks-allow --no-banner --log-opts='--all' .
gitleaks dir --redact=100 --ignore-gitleaks-allow --no-banner .
```

PRの公開CI実行、dependency graph更新、外部forkでの初回承認から集約checkまでをGitHubで確認してから、[repository-settings.md](../security/repository-settings.md) の順序でrulesetへ登録します。workflowの追加だけではGitHub側のrequired checks設定は変更されません。コードやworkflowを変更できるPR自身の検査だけでは、その検査の悪意ある改変を完全には防げないため、CI定義・公開境界にはCODEOWNERSレビューが必要です。

## 現像workspaceの検査

`develop-engine` scopeは実RW2の監査を宣言したpublic-ci.jsonを持つ。固定Rust 1.98.1でnative fmt/clippy/testを実行し、実RW2のdecoder情報・元画素golden・独立DCP描画を常時検査する。Python標準ライブラリでfit→spec/reportを再生成し、Rustでspec→DCP bytesを再生成する。wasm32 buildとwasm-bindgen 0.2.129のtest runnerでNIHO6/7・camera-linear codecの共通テストも実行する。生のowner原本や私有絶対path、署名は不要。Swift toolの実機動作はこのscopeで実証済みと扱わない。
