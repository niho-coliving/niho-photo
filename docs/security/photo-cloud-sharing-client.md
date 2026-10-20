# Photo のクラウド共有クライアント境界

Docs / Photo 共通の通信・権限・安全条件は [cloud contract v1](cloud-contract-v1.md) が正本です。この文書は Photo 編集面の公開 UI と接続条件を定めます。

## 接続と有効化

Photo 編集面は `cloudSharing` が明示的に渡されたクラウド写真にだけ共有操作を表示します。接続口は `CloudClient`、利用状態、信頼済み host が選んだ `CloudResourceRef` selector から成ります。selector の `ownerId` や `tenantId` は認可証明ではなく、private server が毎 request で認証 context と resource record を照合します。Camera はこの接続口を渡さず、公開 client 単体で本番共有を有効化しません。

## 状態と再試行

`PhotoCloudShareController` は作成・一覧・失効を状態機械として扱います。mutation の再試行と再開では同じ idempotency key と payload を使い、取消・通信切替・応答競合の後は一覧で照合します。結果が不確かな間は別 key の操作を開始しません。UI は対象写真と期限を確認させ、共有 URL を作成成功時だけ表示します。URL は画面を閉じるか対象が変わると破棄し、一覧 response、永続 storage、log、analytics に残しません。

`createPhotoCloudSharingPreviewClient` は合成 URL を返すメモリ内 mock で、unit/component test と明示的な preview 専用です。private adapter の実装、実 API E2E、本番有効化は private integration の固定 SHA 取り込みとサーバー側の受入検証を経て行います。
