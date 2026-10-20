# Macクライアントの公開移植（#7）

公開SSOTは niho-photo とする。移植元は publication-manifest.json の exact commit、履歴はコピーしない。

## 名前と保存の互換

利用者のアプリ名は NIHO photo。今回 `apps/camera`、`@niho/camera`、Rust crate名、コマンド名、`life.niho.camera`、端末の保存キーを維持する。フォルダ名変更は後続でビルド・CI・既存インストール更新を一緒に移行する。旧 Photo Bench の補正は移さず既存の案内を残す。

フォルダ選択、補正、プリセット、キャッシュは本人のこのMac内のデータ。拠点・ログイン・クラウドには所属させない。元の写真の保存先を変更しない。端末内データの保存互換を保つ。

## 公開する範囲

camera のローカル写真UIとRustホスト、desktop-photo、必要な共有テーマをallowlist移植する。アイコン5件と校正JSONは資産台帳のSHA・サイズ・由来・公開許可を照合する。desktop-photo/calibrationへ移す校正JSON 8件はJSON内の参照先、署名関連情報、認証情報を監査し、内部パス・署名payload・認証情報がないことを確認した。カメラ生成の画像ファイル名とSHA-256は検証記録として残る。残り6件は確認待ちとして移植しない。未移行のdevelop-engine scopeを作らない。NunitoはOFL本文と同梱し第三者ライセンスを明示する。

ログイン/OAuthは #3、クラウド共有は #8、RAW/WASM/背景除去sidecar・モデルは #9。既存DCP8件はコピーせず、#9で所有RAWから独立推定したDCPへ置換する。JPEG/PNGの端末内閲覧・元画像保存・プリセット管理はオフラインで動く。エンジンが必要な補正描画・RAW・背景除去は未導入を既存能力判定で示す。

## ビルドと配布

公開checkoutで `npm ci`、`npm run build:unsigned --workspace apps/camera`。認証キー・署名秘密鍵・公証情報・本番release権限は不要。app bundleはad-hoc署名。自動更新クライアントと公開鍵は公開するが、既定では無効。公式release用有効化・署名・SBOM・公証・配布権限は #2 の公開release契約完成後に扱う。

元のreleaseスクリプトは非公開Web/docs/desktopの道具を参照するため移植しない。公開版のunsigned入口だけを独立して新規作成する。WASMの配置入口は `packages/develop-engine/public/develop-engine/<engine>` とし、未導入なら出力の古いWASMを除いて続行する。配置があるのにmanifest/ハッシュが壊れていたら必ず失敗する。

## 今回の対象検証（2026-10-20）

- Node 24の公開root workspaceから依存install成功。
- camera: typecheck、7ファイル60テスト、lint、Web build成功。エンジン未導入の縮退入口もWeb buildで確認。
- desktop-photo: Cargo test 85成功・実sidecar受入1件は既存ignore、clippy all-targets -D warnings成功。fmtを2スペース/120桁で統一。
- 公開CI契約のnode testは30件成功。publication/format/diff検査も成功。
- Macのcargo check初回は不要になったprotocol-asset featureとの不一致を検出し除去。その後のunsignedビルドは依存コンパイル中にディスク容量不足で停止したため、Tauri native check/test/unsigned app完成は未検証。今回生成したcameraとdesktop-photoのtargetをcleanして空きを回復。CIのmacOS jobでnative検証を完了させる必要がある。
