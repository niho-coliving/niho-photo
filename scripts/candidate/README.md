# NIHO photo Mac candidate 契約

このdirectoryのhelperは、完全な未公証・ad-hoc署名済みMac candidateを信頼buildで生成し、
後続のprivate signerへ固定hashを持つdataとして渡します。build・data検証helperはnetworkを使わず、
公開済みSDKの取得は `prepare-published-sdk.mjs`、candidateのpublishは後述のworkflowが担当します。
実際のSwift/Rust/Tauri buildはApple Silicon CIで実行します。

## 入力

- clean Gitのcurrent HEADであるapp sourceのfull SHA。working tree、ancestor指定、短縮SHAは使いません。
- 既に外部から取得済みのSDK directory。通常の公式candidateは `published` とし、release manifestの
  輸送SHA-256を必須にします。PR検証だけは `local-validation` を使えますが、SDK source SHAとapp source SHAが
  同一でなければ失敗します。2 modeはcandidate manifestでも区別されます。
- release version、公開Firebase build config JSON、run ID、attempt。config JSONは
  `NIHO_PHOTO_PUBLIC_FIREBASE_WEB_API_KEY` だけを持ち、未設定や形式不正なら公式candidateを作りません。
  値はmanifestやログへ書かずSHA-256だけを記録します。
- overlay前にCIが用意したroot `node_modules` directory。その親にあるroot/workspace manifestとroot lockがapp sourceに一致することを検査し、workspace固有のnested `node_modules`も一時buildへcopyします。npm workspace/.binの相対linkを保ち、build先のsourceへ解決します。helper自身は `npm install` やdownloadをしません。

```sh
npm run candidate:build -- \
  --sdk-directory /input/photo-sdk-0.1.1 \
  --sdk-mode published \
  --sdk-manifest-sha256 <64hex> \
  --app-source <40hex> \
  --version 1.2.3 \
  --public-firebase-config /input/public-build-config.json \
  --node-modules /prepared/node_modules \
  --output /new/output-directory \
  --run-id 123456 --run-attempt 1
```

SDK全6 tarball、manifest、package hash、source ownershipを先に検証します。app sourceがSDK sourceと別SHAでも、
`sourceOwnership` の全path/digest/file countが一致すればapp-only変更として受け付けます。その後だけGit treeから
一時workspaceを作り、SDK runtimeとnative source closureを配置します。version overlayは次の4 fileだけです。

- `apps/camera/package.json`
- `apps/camera/src-tauri/tauri.conf.json`
- `apps/camera/src-tauri/Cargo.toml`
- `apps/camera/src-tauri/Cargo.lock` の `niho_camera` package

root npm lockはversion合わせのために変更しません。Tauriはrelease、`--locked`、`--bundles app`、
`official-updates` feature、ad-hoc署名でbuildします。固定bundle ID `life.niho.camera`、product `NIHO photo`、
deep link `niho-camera`、updater feedとpublic key、`camera_app_info` が使うnative crate versionをoverlay結果で固定します。

## 生成後の検査

builderは配る `.app` そのものについて、Info.plist identity/version/deep link、3 native toolの版、
system dylibだけの依存、calibration全hashとregistry、SDK wasm manifest/file hashと埋込みURL、updater key/feed、
`codesign --verify --deep --strict` を検査します。secret scannerは指定した公開Firebase値との完全一致だけを例外にし、
別の `AIza...`、token、private key、private path、source mapの検出は維持します。

rootの4 notice、engineのLICENSESとAdobe DNG SDK license、Nunito OFLは
`Contents/Resources/third-party-notices/` に元のbytesで同梱します。7 fileのhashを実bundleで照合し、
candidate manifestとapp file inventoryの両方で欠落・変更を拒否します。

出力は安全な同じstemを持つ次の4 fileだけです。

- `*.dmg`
- Tauri-compatible app-root `*.app.tar.gz`（rootは `NIHO photo.app`）
- CycloneDX `*.cdx.json`
- `*.candidate.json`

candidate manifestはapp/source tree、run/attempt、SDK mode/version/source/全asset hash、ownership、version overlayの
before/after hash、公開account config hash、toolchain、native/calibration/wasm/app file hash、SBOM proof、最終assetの
SHA-256/sizeを記録します。公開Firebaseのraw値、signing key、credentialは記録しません。

## private signerへのdata-only handoff

public publisherはbuilder outputのmanifest SHA-256、source SHA、run/attemptを指定して次のzero-dependency verifierを実行します。
private signer側はprivateのtrusted mainに置いた検証処理を使い、public candidateからscriptやverifierを受け取って実行しません。

```sh
npm run candidate:verify -- \
  --directory /input/candidate \
  --expected-manifest-sha256 <64hex> \
  --expected-source <40hex> \
  --expected-version 1.2.3 \
  --expected-sdk-mode published \
  --expected-sdk-version 0.1.1 \
  --expected-sdk-manifest-sha256 <64hex> \
  --run-id 123456 --run-attempt 1
```

verifierはasset名とexact集合、manifest/version/identity/updater契約、全hash/size、SBOM source pin、app tarのentryを
dataとして検査します。tarは `NIHO photo.app/` 外、絶対path、`..`、特殊file、symlink（外向きか否かを問わず）を拒否します。
不足、extra、改ざん、不正version、別bundle ID/updater設定も拒否します。DMGやapp tarを展開・実行せず、署名後工程が
candidate内容を変更した場合は別成果物として新しいmanifestを作る必要があります。

各candidate assetとSDK packageは既存のdesktop/proxy上限に合わせて250 MiB以下に固定し、candidate manifestを含む
全入力は通常fileだけを受け付けます。publisherでは `sdk-proof/` のSDK manifest、SDK release receipt、release metadataも
指定し、source ownership、SDK version/source/hash、GitHub run/attempt、Actions artifact ID/digestを再照合して
`photo-candidate-artifact-receipt.json` と `photo-candidate-provenance.json` を作ります。

## CIとprerelease

`Public CI` の `Photo Mac candidate proof` はcandidate関連変更だけでmacOS 26 ARM64を使い、current full SHAから
実WASM、local-validation SDK、native sidecar、Tauri appを順にbuildします。公開用の形式を持つ固定dummy Firebase Web
configを使う検証であり、本番loginの認証成功、公式release、署名・公証の証明ではありません。PR proofのbytesは保存・公開しません。

公式candidateはmain上の `Photo Mac candidate release` を手動実行し、次を入力します。

- `app_source_sha`: origin/mainの祖先である40桁SHA
- `sdk_version`: 既存のimmutable `photo-sdk-v<strict semver>`
- `app_version`: prerelease/build metadataを持たない新しい `x.y.z`
- `sdk_manifest_sha256`: 公開済みSDK manifest bytesの64桁SHA-256

read-only macOS builderは公開SDK releaseのtag/target、全6 tarball、manifest、元のartifact receiptを検証してcandidateと
SDK proofを同runの専用artifactへ保存します。Ubuntu publisherはdispatch時mainのverifierだけを実行し、artifact内codeや
appを起動せず、`photo-candidate-v<app version>-<app SHA先頭12桁>` の新規tagと `--latest=false` prereleaseを作ります。
これはcandidate経路だけで、private `camera-v` release、署名成果物、updater feedを変更しません。

tagはCASで先に確保し、release作成途中で失敗しても削除・再利用しません。その版は消費済みとして、rollbackまたは再実行は
**より高い新しいapp version**を指定します。前のsourceへ戻す場合も、保存済みの前source SHAと承認済みSDK hashを入力し、
高い新versionで新しいcandidateを作ります。既存tag/assetsの上書きやclobberは行いません。

公式publisherは検証済みcandidate manifestを `actions/attest` でattestします。SDK manifestにもSDK専用workflowのattestationがあり、後段は両方の実digest・公式workflow・main ref・tooling SHA・certificate内run/attemptを暗号学的に照合します。公開のSigstore署名用短命identityを使い、private updater秘密鍵や新しいPATは不要です。
