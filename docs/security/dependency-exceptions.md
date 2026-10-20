# 依存レビューの限定例外

## GHSA-wrw7-89jp-8q8g — glib 0.18.5

2026-10-20、#7のMac専用クライアント移植で `apps/camera/src-tauri/Cargo.lock` にLinux向けの `glib` 0.18.5が入り、公開Dependency reviewが失敗した。GitHub Advisoryは `glib` 0.15.0以上0.20.0未満を対象とし、修正版は0.20.0とする。

`cargo tree --locked --manifest-path apps/camera/src-tauri/Cargo.toml --target aarch64-apple-darwin -i glib@0.18.5` は該当なし。`--target x86_64-unknown-linux-gnu` ではTauriのGTK/WebKit依存として表示される。現在の成果物とnative CIはMac専用で、該当crateをビルド・同梱しない。Cargo.lockは複数targetの依存を記録するため、この1件だけ `allow-ghsas` に登録する。他のmoderate以上の脆弱性は従来どおり拒否する。

Linux対応を追加する前、またはTauri/GTKスタックが `glib` 0.20以降へ更新できる時点で、この例外を削除する。公開workflowの契約テストは例外IDの追加と検査閾値の緩和を拒否する。

- [GitHub Advisory GHSA-wrw7-89jp-8q8g](https://github.com/advisories/GHSA-wrw7-89jp-8q8g)
- [Dependency review action の `allow-ghsas` 設定](https://github.com/actions/dependency-review-action/blob/main/README.md#configuration-options)
