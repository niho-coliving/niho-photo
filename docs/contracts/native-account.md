# Photo / Docs nativeアカウント安全契約 v2

正本は [共有packageのversioned JSON](../../packages/desktop-account/contract/native-account-v2.json)。公式NIHO app-connect v1に適合する公開クライアント境界を定義する。

公開client ID、接続先、wire形式、ソースや改変方法を攻撃者が知ることを前提とする。Photoのclient IDは `niho-camera`。`https://niho.life/connect/niho-camera` から `niho-camera://auth?code&state` に戻り、PKCEと一回限りのコードを `POST /api/auth/app-connect/exchange` で交換する。custom tokenは固定HTTPSのFirebase Identity Toolkitへ送り、得た短期ID tokenを `GET /api/auth/me` で確認する。更新はNIHO接続refresh tokenのrotationを使う。Firebase refresh tokenを使用・保存しない。

- 接続試行ごとにverifier/stateの独立した32byte乱数を生成する。S256のみ。callbackのscheme/authority/path/queryは曖昧さを拒否し、stateを照合する。pendingは10分、codeは交換前に消費済みを永続化して再送を防ぐ。
- code以外の実tokenはURLへ入れない。custom token・NIHO接続tokenはPOST JSON body、短期ID tokenはBearer headerに限る。response、OS error、URL、個人情報をlog/Debug/telemetryへ出さない。
- ID tokenのJWT claimをclientが権限証明にしない。固定HTTPS交換の成功とNIHO serverの`/me`受理が必要。requestごとの認証・tenant/user/resource認可、role/quota/ownership、署名検証と失効の最終判断はサーバーが強制する。
- Developer ID署名前はversioned app data内のFileSecretStoreを使い、0700 directory、0600 file、所有者、親symlink/書込権限、file symlink/hardlinkを検証する。原子的な書き換えでも一時ファイルから0600を守る。Keychainは差し替え可能adapterとして保持する。
- refreshの取り替えたNIHO接続tokenをFirebase交換より先に保存する。保存失敗・旧token失効を成功扱いにしない。停止スイッチ/network障害は資格を保持し、失効/利用不可は消す。
- 取消・logout・再起動はcode消費と処理世代を守る。初回の取消後に新規資格を復活させない。既存接続のrefresh取消は保存済み資格を保持して自動再試行を止める。取得済みID tokenで初回接続のDELETE後始末を試み、できない場合のserver残存を隠さない。
- UI snapshotはversion、phase、利用可否、固定error分類だけ。token、profile、ローカルpath、raw responseを含めない。すべての認証状態でローカル編集を利用できる。

Firebase Web API keyは公開build設定でありsecretでも権限付与でもない。公式keyを `NIHO_PHOTO_PUBLIC_FIREBASE_WEB_API_KEY` に与えたbuildだけprod接続を有効化する。未設定buildはlocal-only。接続先は固定し、任意endpointやclient secretを入力する口を追加しない。

Photoの消費pinは `apps/camera/account-contract.json`。Rust/TSとの一致とexact digestをCIで確認する。Docs側のv2採用と双方CIの連動、実API・署名済みアプリの受入完了はここでは主張しない。保存、取消、後始末の詳細は [package README](../../packages/desktop-account/README.md) に記す。
