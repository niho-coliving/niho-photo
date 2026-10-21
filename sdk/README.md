# NIHO photo SDK release set

`sdk/release-set.json` は、NIHOapp が同じ版として固定する写真編集 SDK の構成です。次の 5 package を 1 個の release manifest に束ねます。

- `niho-photo-editing`: PhotoLibrary 境界、editor、develop-engine client と Web Worker の TypeScript source
- `niho-photo-ui`: SDK 専用名にした editor の UI dependency。React / React DOM は peer dependency のままで、consumer と同じ実体を使う
- `niho-photo-cloud-contract`: 既存の cloud sharing export が参照する純粋 TypeScript contract
- `niho-photo-develop-engine-source`: 同一 commit の Rust workspace source と、wasm build に必要な埋め込みデータ
- `niho-photo-develop-engine-runtime`: `manifest-<crate version>.json` が SHA-256 で固定する wasm-bindgen glue、wasm、型定義

workspace 内の package 名と import は変更しません。pack 用の一時領域でだけ `niho-ui` を `niho-photo-ui` に置き換えます。editor の `appDialog` と host が別 package instance にならないよう、consumer は `niho-photo-editing/sdk-dialog-host` の `PhotoEditingDialogHost` を描画します。この export は editor と同じ `niho-photo-ui` から host を再 export します。既存 app の `niho-ui/components/app-dialog-host` を代用してはいけません。`packages/photo-editing` は引き続き PhotoLibrary だけを host 境界にし、Next/API/Tauri や account client を SDK に含めません。

recipe contract はこの slice では `niho-photo-editing/develop-engine/develop-settings` の TypeScript source export です。release manifest は実 source から `DevelopSettingsVersion` の v1〜v9 と対応 engine identifier を抽出して固定します。plain Node.js API が直接読み込める生成済み JavaScript validator / `.d.ts` package はまだありません。API の保存契約を SDK へ移す完了条件にはせず、後続 slice で React と browser API に依存しない contract package を追加します。

## 生成

公開用 pack は clean な Git commit からだけ作ります。source は working tree からコピーせず `git ls-tree` / `git show` で読みます。

```sh
npm run sdk:pack -- --output sdk-dist/0.1.0
```

既定の runtime asset 入力は `packages/develop-engine/public/develop-engine/niho-13/` です。`manifest-0.25.0.json`、その manifest に列挙された `.js`、`.wasm`、`.d.ts` が揃い、bytes と SHA-256 が一致しない限り pack は失敗します。manifest の `source.commit` / `source.tree` は pack 対象の Git object と一致し、固定 Rust `1.98.1`、`wasm-bindgen 0.2.129`、release profile の provenance を持つ必要があります。同じ engine/version 名の任意ファイルを渡すだけでは release-ready になりません。source package だけを release-ready として扱う経路もありません。

runtime は固定 toolchain と `wasm-bindgen` が用意された CI で次の helper を実行して作ります。helper 自体は toolchain の install や network access を行いません。

```sh
npm run sdk:build-engine-runtime -- --output packages/develop-engine/public/develop-engine/niho-13
```

出力先は既存なら拒否します。生成された `niho-photo-sdk-<version>-<full SHA>.json` に package 名、tarball の SHA-256/SRI、engine/recipe contract と build input の SHA-256、runtime file の SHA-256/SRI を記録します。GitHub Release へは manifest と全 tarball を同じ immutable version の asset として載せます。

repo 外 consumer の確認は次で行います。

```sh
npm run sdk:smoke -- --manifest sdk-dist/0.1.0/niho-photo-sdk-0.1.0-<full SHA>.json
```

smoke は tarball を一時ディレクトリへ offline install し、代表 editor export、PhotoLibrary、develop-engine client、Web Worker、UI CSS を TypeScript と Vite で bundle します。
