import { createCloudMockClient } from "./cloud-sharing-contract.js";
import type {
  CloudClient,
  CloudResourceRef,
  CloudResult,
  MutationHeaders,
  ShareCreateResponse,
  ShareListItem,
  ShareRevokeResponse,
} from "./cloud-sharing-contract.js";

type StoredMutation<T> = { readonly fingerprint: string; readonly value: T };

export interface PhotoCloudSharingPreviewClientOptions {
  readonly now?: () => string;
}

const conflict = <T>(): CloudResult<T> => ({
  ok: false,
  error: { code: "idempotency_conflict", requestId: "preview-conflict", retryable: false },
});

function resourceFingerprint(resource: CloudResourceRef): string {
  return [
    resource.resourceType,
    resource.resourceId,
    resource.ownerType,
    resource.ownerId,
    resource.tenantId,
    resource.workspaceId ?? "",
  ].join("\u001f");
}

/**
 * Deterministic, in-memory adapter for tests and explicit previews only.
 * It is never selected by the Camera app and is not an authorization layer.
 */
export function createPhotoCloudSharingPreviewClient(options: PhotoCloudSharingPreviewClientOptions = {}): CloudClient {
  const shares = new Map<string, ShareListItem>();
  const creates = new Map<string, StoredMutation<ShareCreateResponse>>();
  const revokes = new Map<string, StoredMutation<ShareRevokeResponse>>();
  const now = options.now ?? (() => "2026-10-20T00:00:00.000Z");
  let nextShare = 1;

  return createCloudMockClient({
    "share.create": async (request, headers: MutationHeaders) => {
      const key = headers["Idempotency-Key"];
      const fingerprint = `${resourceFingerprint(request.resource)}\u001e${request.permission}\u001e${request.expiresAt}`;
      const stored = creates.get(key);
      if (stored) {
        if (stored.fingerprint !== fingerprint) return conflict();
        return { ok: true, value: { ...stored.value, replayed: true } };
      }
      const sequence = nextShare++;
      const share: ShareListItem = {
        shareId: `preview-share-${sequence}`,
        resource: request.resource,
        permission: request.permission,
        expiresAt: request.expiresAt,
        revokedAt: null,
      };
      const value: ShareCreateResponse = {
        share,
        shareUrl: `https://share.invalid/preview-capability-${sequence}`,
        replayed: false,
      };
      shares.set(share.shareId, share);
      creates.set(key, { fingerprint, value });
      return { ok: true, value };
    },
    "share.list": async (request) => ({
      ok: true,
      value: {
        items: Array.from(shares.values()).filter((share) =>
          share.resource.resourceType === request.resourceType && share.resource.resourceId === request.resourceId),
        nextCursor: null,
      },
    }),
    "share.revoke": async (request, headers: MutationHeaders) => {
      const key = headers["Idempotency-Key"];
      const fingerprint = request.shareId;
      const stored = revokes.get(key);
      if (stored) {
        if (stored.fingerprint !== fingerprint) return conflict();
        return { ok: true, value: { ...stored.value, replayed: true } };
      }
      const share = shares.get(request.shareId);
      if (!share) {
        return { ok: false, error: { code: "not_found", requestId: "preview-not-found", retryable: false } };
      }
      const revokedAt = share.revokedAt ?? now();
      const value: ShareRevokeResponse = { shareId: share.shareId, revokedAt, replayed: share.revokedAt !== null };
      shares.set(share.shareId, { ...share, revokedAt });
      revokes.set(key, { fingerprint, value });
      return { ok: true, value };
    },
  });
}
