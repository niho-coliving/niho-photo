# ライセンスと依存

NIHOがIssue #3のため新規作成した実装と合成テストは、ルート LICENSE.md に従う。旧クライアントのdeep-link、Firebase custom-token、private API実装を含まない。

Rust依存はCargo.lockに固定する。base64、getrandom、serde、serde_json、sha2、subtle、url、zeroize、rustlsはMIT/Apache-2.0、reqwestはMIT/Apache-2.0、security-frameworkはMIT/Apache-2.0。libcはMIT/Apache-2.0。mockは合成app-connect responseだけを使用する。OSの標準ブラウザとmacOS Security.frameworkの公開APIを利用する。TLSはrustls + ringを使用し、rootのOS trustに従う。ringの独自・第三者通知も固定依存のlicenseに従う。

TypeScriptはroot workspaceのTypeScript/Vitest/ESLintを使用する。署名鍵・実token・アカウント情報・第三者画像を同梱しない。完全な配布SBOMと通知の同梱工程はIssue #2で確定する。
