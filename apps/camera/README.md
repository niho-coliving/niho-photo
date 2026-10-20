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

ログインは不要です。フォルダまたは個別の写真を選び、JPEG/PNG表示、元画像の保存、補正設定とプリセットの管理をこのMac内で行います。個別写真の画面、復元、失敗時の扱いは [この Mac の写真ソース](../../docs/features/local-photo-sources.md) を参照してください。RAW現像・補正描画・背景除去に必要なエンジン/sidecar/modelは #9 で移行します。未導入時は能力判定により利用できない操作を表示します。WASMは公開engine配置入口からハッシュ検証して取り込み、欠落ならローカル機能で起動、壊れた配置はビルドを止めます。

`allow-camera-library` が同梱UIへ許可するライブラリコマンドは次のとおりです。パスを受け取る・返すコマンドはありません。

| コマンド | 用途 |
| --- | --- |
| `camera_library_add_folder` | ネイティブpickerでフォルダを1つ追加 |
| `camera_library_add_photos` | ネイティブpickerで写真を複数追加 |
| `camera_library_remembered` | 現在表示できる保存済みフォルダ・個別写真を取得 |
| `camera_library_list_folder` | 不透明な `folderId` のフォルダを取得 |
| `camera_library_forget_folder` | フォルダ参照だけを外す |
| `camera_library_forget_photos` | 個別写真の参照をすべて外す |

アカウントは公式NIHO app-connect/PKCE共通パッケージを使います。公開Firebase Web API keyをbuild設定に与えた場合は外部ブラウザとniho-camera deep linkで接続し、未設定の公開CI・開発buildはローカル専用です。クラウド共有は有効表示しません。認証状態は編集の利用条件にしません。[安全契約](../../docs/contracts/native-account.md) を参照してください。クラウド共有は #8。自動更新クライアントと公開鍵はコードに含みますが既定で無効です。公式release権限、署名、公証、SBOM、更新有効化は #2 の範囲です。

アプリ名と既存 `camera` パス・端末内データの互換方針は [移植計画](../../docs/migration/mac-client.md) を参照してください。
