import type { CloudErrorCode, VerifiedAuthContext } from "../src/v1.js";

interface ServerResourceRecord {
  readonly ownerType: "user" | "workspace";
  readonly ownerId: string;
  readonly tenantId: string;
  readonly workspaceId: string | null;
  readonly authorized: boolean;
}

interface CapabilityState {
  readonly expiresAt: number;
  readonly revoked: boolean;
  readonly reuse: "single-use" | "until-expiry";
  readonly consumed: boolean;
}

/** Test-only contract model. Production authorization must run in the private API. */
export function authorizeOwnedResource(
  auth: Pick<VerifiedAuthContext, "subjectId" | "tenantId" | "workspaceId">,
  record: ServerResourceRecord | undefined,
): CloudErrorCode | null {
  if (!record) return "not_found";
  if (
    auth.tenantId !== record.tenantId
    || auth.workspaceId !== record.workspaceId
    || !record.authorized
    || (record.ownerType === "user" && auth.subjectId !== record.ownerId)
    || (record.ownerType === "workspace" && auth.workspaceId !== record.ownerId)
  ) return "not_found";
  return null;
}

export function validateCapability(state: CapabilityState, now: number): CloudErrorCode | null {
  if (state.revoked) return "capability_revoked";
  if (state.expiresAt <= now) return "capability_expired";
  if (state.reuse === "single-use" && state.consumed) return "capability_replayed";
  return null;
}

export function checkIdempotency(previousPayload: string | null, nextPayload: string): "new" | "same-result" | "idempotency_conflict" {
  if (previousPayload === null) return "new";
  return previousPayload === nextPayload ? "same-result" : "idempotency_conflict";
}

export function validateUploadContent(input: {
  readonly declaredContentType: string;
  readonly detectedContentType: string;
  readonly declaredSha256: string;
  readonly actualSha256: string;
  readonly sizeBytes: number;
  readonly maximumSizeBytes: number;
}): CloudErrorCode | null {
  if (
    input.declaredContentType !== input.detectedContentType
    || input.declaredSha256 !== input.actualSha256
    || input.sizeBytes > input.maximumSizeBytes
  ) return "content_rejected";
  return null;
}
