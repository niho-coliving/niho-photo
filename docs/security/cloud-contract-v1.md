# Docs / Photo クラウド contract v1

この仕様の機械可読な型と負例 test vector は [`packages/niho-cloud-contract`](../../packages/niho-cloud-contract/) が正本です。ここでは v1 の外部 observable behavior を定めます。API の実装、DB、storage、内部 endpoint はこの公開 contract に含めません。

## 認証 context と resource

API request は TLS 上で NIHO access token を送ります。private server は毎 request で署名・issuer・audience・有効期限を検証し、認証 context を作ります。

| Field | Source | 用途 |
| --- | --- | --- |
| `subjectId` | 検証済み token | user の識別 |
| `tenantId` | 検証済み token と server-side membership | 拠点 / tenant 境界 |
| `workspaceId` | 検証済み membership または resource owner | workspace 境界 |
| `resourceId` / `resourceType` | request の selector | 対象 resource の指定。所有権の証明には使わない |
| `ownerType` / `ownerId` | server-side resource record | user / workspace owner 判定。request の値を信用しない |

`subjectId`、`tenantId`、`workspaceId`、`ownerId` は client が自己申告する権限情報ではありません。request に含まれる場合も selector として検証し、認可の根拠にしません。存在しない resource と利用権のない resource は、列挙を防ぐため同じ `not_found` error にします。

## Operations

各 endpoint は `/api/cloud/v1` を prefix とします。mutation は `Idempotency-Key` header を含め、retry では同じ key と同一 payload を再利用します。`packages/niho-cloud-contract/src/v1.ts` の `CloudOperationMap` は request shape と mutation header を分け、HTTPでの配置は `CLOUD_OPERATION_TRANSPORTS` で明示します。

| Operation | Method / path | 要点 |
| --- | --- | --- |
| Upload capability 発行 | `POST /uploads` | `resource`, `contentType`, `sizeBytes`, `sha256` を検証し、対象 object と `PUT` のみに拘束した短命 capability を返す |
| Upload 確定 | `POST /uploads/{uploadId}/complete` | capability の期限・scope・一回性を検証し、実 byte 数・magic bytes・checksum・quota を server-side で確認する |
| Download capability 発行 | `POST /downloads` | resource ownership を再検証し、対象 object と `GET` のみに拘束した短命 capability を返す |
| Share 作成 | `POST /shares` | owner 権限を検証し、許可された read-only scope と有効期限を持つ share を作る |
| Share 失効 | `DELETE /shares/{shareId}` | caller の revoke 権限を検証し、繰り返し実行しても同じ最終状態にする |
| Share 一覧 | `GET /shares?resourceType=…&resourceId=…&cursor=…&limit=…` | request fields はURL queryだけで渡し、GET bodyを送らない。serverが認可contextとresource recordからownerを検証し、callerが管理できるresourceだけを返す。cursorはopaqueとする |

`CLOUD_OPERATION_TRANSPORTS` は6 operationすべてのmethod・path・request配置を機械可読に定義します。upload start / download start / share create はJSON、upload completeはpathとJSON、share revokeはpath、share listはqueryを使います。`ShareListRequest` は `resourceType` と `resourceId` をselectorとして受け取り、`cursor` と `limit` を任意queryにします。owner、tenant、workspaceはqueryから受け付けず、serverの認証済みcontextとresource recordから判断します。Request / responseのfieldとHTTP配置を変えるときは同ファイル、仕様、test vectorを一緒に更新します。

## Capability と idempotency

- Upload capability は指定 resource / `PUT` / content type / byte length / checksum に拘束し、一度だけ確定できます。期限切れ・取消済み・再利用は拒否します。
- Download capability は指定 resource / `GET` に拘束し、短い有効期限を持ちます。期限内の再利用可否を response の `reuse` field で明示します。
- Share URL は bearer secret です。作成時だけ返し、一覧では URL を返しません。share は指定 resource / read-only permission / expiry に拘束し、revoke 後は即時利用できません。
- 同じ idempotency key と同一 payload の retry は最初の確定結果を返します。key を別 payload に再利用した場合は `idempotency_conflict` とします。
- client は capability URL、share URL、access token、refresh token を保存 log・analytics・crash report に含めません。server は capability を actor・resource・method・content・expiry に拘束し、永続 storage credential を返しません。

## Error envelope

失敗 response は `code`、opaque な `requestId`、`retryable` を返します。内部 endpoint、storage location、別 tenant の存在、token、署名 URL、stack trace は含めません。

v1 の code は `invalid_request`、`unauthenticated`、`not_found`、`capability_expired`、`capability_revoked`、`capability_replayed`、`idempotency_conflict`、`quota_exceeded`、`content_rejected`、`rate_limited`、`temporarily_unavailable` です。正確な rate limit / abuse 閾値は公開しません。

## Contract security cases

`packages/niho-cloud-contract/v1/security-cases.json` は合成入力と期待結果を列挙します。v1 は少なくとも次を検証対象にします。

- 他 owner / tenant の object ID を指定しても `not_found` になる。
- 期限切れ・失効済み・再利用済み capability は拒否される。
- 既に revoke した share は再利用できない。
- 同一 idempotency request は安全に retry でき、異なる payload の key 再利用は拒否される。
- 偽装 MIME、checksum 不一致、上限超過は拒否される。
- client 由来の owner / role / quota が認可判断に使われない。

これらは public contract の試験項目です。production API の安全性は private integration 側で同じ固定 SHA を使う契約検査・受入でも確認します。
