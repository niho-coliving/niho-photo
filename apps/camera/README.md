# NIHO photo Macアプリ

この公開リポジトリを新規checkoutしてMac上で開発できます。macOS 14以降、Xcode Command Line Tools、Node 24、Rust stableが必要です。

```sh
npm ci
npm run dev --workspace apps/camera
npm run build:unsigned --workspace apps/camera
```

unsigned入口はdebugの `.app` をad-hoc署名し、認証キー・Apple署名証明書・更新署名秘密鍵を要求しません。出力は `apps/camera/src-tauri/target/debug/bundle/macos/NIHO photo.app`。通常の `build` はTauriの開発者向け入口で、公式配布工程は #2 で定義します。

```sh
npm run typecheck --workspace apps/camera
npm test --workspace apps/camera
npm run lint --workspace apps/camera
cargo test --locked --manifest-path packages/desktop-photo/Cargo.toml
```

ログインは不要です。フォルダ一覧、JPEG/PNG表示、元画像の保存、補正設定とプリセットの管理はこのMac内で行います。RAW現像・補正描画・背景除去に必要なエンジン/sidecar/modelは #9 で移行します。未導入時は能力判定により利用できない操作を表示します。WASMは公開engine配置入口からハッシュ検証して取り込み、欠落ならローカル機能で起動、壊れた配置はビルドを止めます。

アカウント/OAuthは #3、クラウド共有は #8。自動更新クライアントと公開鍵はコードに含みますが既定で無効です。公式release権限、署名、公証、SBOM、更新有効化は #2 の範囲です。

アプリ名と既存 `camera` パス・端末内データの互換方針は [移植計画](../../docs/migration/mac-client.md) を参照してください。
