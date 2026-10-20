/**
 * Docs / Photo shared cloud contract, pinned at this repository commit.
 * Client types are selectors and wire shapes; they do not confer authority.
 */

export const CLOUD_CONTRACT_VERSION = "1" as const;

export type ResourceType = "document" | "photo";
export type ResourceOwnerType = "user" | "workspace";
export type SharePermission = "read";
export type CapabilityReuse = "single-use" | "until-expiry";

/** Selector only. The server must look up and authorize every field. */
export interface CloudResourceRef {
  readonly resourceType: ResourceType;
  readonly resourceId: string;
  readonly ownerType: ResourceOwnerType;
  readonly ownerId: string;
  readonly tenantId: string;
  readonly workspaceId: string | null;
}

/** Mutations require the same key on every retry of the same payload. */
export interface MutationHeaders {
  readonly "Idempotency-Key": string;
}

/** Constructed by the server from a verified token and membership records. */
export interface VerifiedAuthContext {
  readonly issuer: string;
  readonly audience: string;
  readonly subjectId: string;
  readonly tenantId: string;
  readonly workspaceId: string | null;
  readonly expiresAt: string;
}

export interface UploadStartRequest {
  readonly resource: CloudResourceRef;
  readonly contentType: string;
  readonly sizeBytes: number;
  readonly sha256: string;
}

export interface ScopedCapability {
  /** Bearer material. Do not log, persist, or send to analytics. */
  readonly url: string;
  readonly method: "PUT" | "GET";
  readonly resource: CloudResourceRef;
  readonly expiresAt: string;
  readonly reuse: CapabilityReuse;
  readonly contentType: string | null;
  readonly sizeBytes: number | null;
  readonly sha256: string | null;
}

export interface UploadStartResponse {
  readonly uploadId: string;
  readonly capability: ScopedCapability & { readonly method: "PUT"; readonly reuse: "single-use" };
}

export interface UploadCompleteRequest {
  readonly uploadId: string;
  readonly sha256: string;
}

export interface UploadCompleteResponse {
  readonly resource: CloudResourceRef;
  readonly revisionId: string;
  readonly replayed: boolean;
}

export interface DownloadRequest {
  readonly resource: CloudResourceRef;
}

export interface DownloadResponse {
  readonly capability: ScopedCapability & { readonly method: "GET" };
}

export interface ShareCreateRequest {
  readonly resource: CloudResourceRef;
  readonly permission: SharePermission;
  readonly expiresAt: string;
}

export interface ShareRecord {
  readonly shareId: string;
  readonly resource: CloudResourceRef;
  readonly permission: SharePermission;
  readonly expiresAt: string;
  readonly revokedAt: string | null;
}

export interface ShareCreateResponse {
  readonly share: ShareRecord;
  /** Bearer material. Return only on creation; never log or persist. */
  readonly shareUrl: string;
  readonly replayed: boolean;
}

/** Share listing omits bearer URLs. */
export type ShareListItem = ShareRecord;

export interface ShareRevokeRequest {
  readonly shareId: string;
}

export interface ShareRevokeResponse {
  readonly shareId: string;
  readonly revokedAt: string;
  readonly replayed: boolean;
}

export interface ShareListRequest {
  /** Selector only; ownership is always derived from the verified server context. */
  readonly resourceType: ResourceType;
  readonly resourceId: string;
  readonly cursor?: string;
  readonly limit?: number;
}

export interface ShareListResponse {
  readonly items: readonly ShareListItem[];
  readonly nextCursor: string | null;
}

export const CLOUD_ERROR_CODES = [
  "invalid_request",
  "unauthenticated",
  "not_found",
  "capability_expired",
  "capability_revoked",
  "capability_replayed",
  "idempotency_conflict",
  "quota_exceeded",
  "content_rejected",
  "rate_limited",
  "temporarily_unavailable",
] as const;

export type CloudErrorCode = (typeof CLOUD_ERROR_CODES)[number];

export interface CloudError {
  readonly code: CloudErrorCode;
  readonly requestId: string;
  readonly retryable: boolean;
  readonly retryAfterSeconds?: number;
}

export interface CloudOperationMap {
  readonly "upload.start": { readonly headers: MutationHeaders; readonly request: UploadStartRequest; readonly response: UploadStartResponse };
  readonly "upload.complete": { readonly headers: MutationHeaders; readonly request: UploadCompleteRequest; readonly response: UploadCompleteResponse };
  readonly "download.start": { readonly request: DownloadRequest; readonly response: DownloadResponse };
  readonly "share.create": { readonly headers: MutationHeaders; readonly request: ShareCreateRequest; readonly response: ShareCreateResponse };
  readonly "share.revoke": { readonly headers: MutationHeaders; readonly request: ShareRevokeRequest; readonly response: ShareRevokeResponse };
  readonly "share.list": { readonly request: ShareListRequest; readonly response: ShareListResponse };
}

export type CloudRequestLocation = "json" | "path" | "path-and-json" | "query";

export interface CloudOperationTransport {
  readonly method: "DELETE" | "GET" | "POST";
  readonly path: string;
  readonly requestLocation: CloudRequestLocation;
}

/** HTTP binding for every operation; GET requests use query fields and never carry a body. */
export const CLOUD_OPERATION_TRANSPORTS = {
  "upload.start": { method: "POST", path: "/uploads", requestLocation: "json" },
  "upload.complete": { method: "POST", path: "/uploads/{uploadId}/complete", requestLocation: "path-and-json" },
  "download.start": { method: "POST", path: "/downloads", requestLocation: "json" },
  "share.create": { method: "POST", path: "/shares", requestLocation: "json" },
  "share.revoke": { method: "DELETE", path: "/shares/{shareId}", requestLocation: "path" },
  "share.list": { method: "GET", path: "/shares", requestLocation: "query" },
} as const satisfies { readonly [K in keyof CloudOperationMap]: CloudOperationTransport };

export type CloudResult<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly error: CloudError };

/** Shared adapter shape for production clients and UI/test mocks. */
export type CloudClient = {
  readonly [K in keyof CloudOperationMap]: CloudOperationMap[K] extends { readonly headers: MutationHeaders }
    ? (
        request: CloudOperationMap[K]["request"],
        headers: MutationHeaders,
      ) => Promise<CloudResult<CloudOperationMap[K]["response"]>>
    : (
        request: CloudOperationMap[K]["request"],
      ) => Promise<CloudResult<CloudOperationMap[K]["response"]>>;
};
