import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import {
  CLOUD_CONTRACT_VERSION as PHOTO_CLOUD_CONTRACT_VERSION,
  CLOUD_OPERATION_TRANSPORTS as PHOTO_CLOUD_OPERATION_TRANSPORTS,
  createCloudMockClient as createPhotoCloudMockClient,
  type CloudClient as PhotoCloudClient,
} from "./cloud-sharing-contract.js";
import { CLOUD_CONTRACT_VERSION, CLOUD_ERROR_CODES, CLOUD_OPERATION_TRANSPORTS, type CloudOperationMap } from "../../niho-cloud-contract/src/v1.js";
import { createCloudMockClient } from "../../niho-cloud-contract/src/mock.js";
import { authorizeOwnedResource, checkIdempotency, validateCapability, validateUploadContent } from "../../niho-cloud-contract/test-support/reference-model.js";

const securityCases = JSON.parse(readFileSync(
  fileURLToPath(new URL("../../niho-cloud-contract/v1/security-cases.json", import.meta.url)),
  "utf8",
)) as { contractVersion: string; cases: readonly { id: string; expected: string }[] };

const requiredOperations = [
  "upload.start",
  "upload.complete",
  "download.start",
  "share.create",
  "share.revoke",
  "share.list",
] satisfies readonly (keyof CloudOperationMap)[];

const requiredErrorCodes = [
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

describe("Docs / Photo cloud contract v1", () => {
  it("publishes the expected versioned operations and security errors", () => {
    expect(CLOUD_CONTRACT_VERSION).toBe("1");
    expect(requiredOperations).toEqual([
      "upload.start",
      "upload.complete",
      "download.start",
      "share.create",
      "share.revoke",
      "share.list",
    ]);
    expect(CLOUD_ERROR_CODES).toEqual(requiredErrorCodes);
    expect(CLOUD_OPERATION_TRANSPORTS["share.list"]).toEqual({ method: "GET", path: "/shares", requestLocation: "query" });
    const query = { resourceType: "photo", resourceId: "photo-test" } satisfies CloudOperationMap["share.list"]["request"];
    expect(query).not.toHaveProperty("resource");
  });

  it("keeps an adversarial case for each public authorization and replay boundary", () => {
    expect(securityCases.contractVersion).toBe(CLOUD_CONTRACT_VERSION);

    const actual = new Map(securityCases.cases.map((testCase) => [testCase.id, testCase.expected]));
    const expected = new Map([
      ["cross-owner-object", "not_found"],
      ["forged-owner-context", "not_found"],
      ["expired-upload-capability", "capability_expired"],
      ["revoked-upload-capability", "capability_revoked"],
      ["replayed-upload-capability", "capability_replayed"],
      ["revoked-share", "capability_revoked"],
      ["idempotent-retry", "same-result"],
      ["idempotency-key-conflict", "idempotency_conflict"],
      ["mime-spoof", "content_rejected"],
      ["checksum-mismatch", "content_rejected"],
      ["size-over-limit", "content_rejected"],
    ]);

    for (const [id, result] of expected) expect(actual.get(id)).toBe(result);
  });

  it("runs negative cases against the test-only contract reference model", () => {
    const principal = { subjectId: "user-a", tenantId: "tenant-a", workspaceId: "workspace-a" };
    const ownedResource = { ownerType: "user" as const, ownerId: "user-a", tenantId: "tenant-a", workspaceId: "workspace-a", authorized: true };
    const otherTenantResource = { ownerType: "user" as const, ownerId: "user-b", tenantId: "tenant-b", workspaceId: "workspace-b", authorized: true };

    expect(authorizeOwnedResource(principal, otherTenantResource)).toBe("not_found");
    expect(authorizeOwnedResource(principal, undefined)).toBe("not_found");
    expect(authorizeOwnedResource(principal, ownedResource)).toBeNull();

    expect(validateCapability({ expiresAt: 100, revoked: false, reuse: "until-expiry", consumed: false }, 100)).toBe("capability_expired");
    expect(validateCapability({ expiresAt: 200, revoked: true, reuse: "single-use", consumed: false }, 100)).toBe("capability_revoked");
    expect(validateCapability({ expiresAt: 200, revoked: false, reuse: "single-use", consumed: true }, 100)).toBe("capability_replayed");

    expect(checkIdempotency("payload-a", "payload-a")).toBe("same-result");
    expect(checkIdempotency("payload-a", "payload-b")).toBe("idempotency_conflict");
    expect(validateUploadContent({
      declaredContentType: "image/jpeg",
      detectedContentType: "image/png",
      declaredSha256: "sha256-a",
      actualSha256: "sha256-a",
      sizeBytes: 100,
      maximumSizeBytes: 100,
    })).toBe("content_rejected");
    expect(validateUploadContent({
      declaredContentType: "image/jpeg",
      detectedContentType: "image/jpeg",
      declaredSha256: "sha256-a",
      actualSha256: "sha256-b",
      sizeBytes: 100,
      maximumSizeBytes: 100,
    })).toBe("content_rejected");
    expect(validateUploadContent({
      declaredContentType: "image/jpeg",
      detectedContentType: "image/jpeg",
      declaredSha256: "sha256-a",
      actualSha256: "sha256-a",
      sizeBytes: 101,
      maximumSizeBytes: 100,
    })).toBe("content_rejected");
  });

  it("provides the same deterministic mock adapter shape for client tests", async () => {
    const client = createCloudMockClient();
    await expect(client["share.list"]({
      resourceType: "photo",
      resourceId: "photo-test",
    })).resolves.toEqual({
      ok: false,
      error: {
        code: "temporarily_unavailable",
        requestId: "mock-unconfigured",
        retryable: false,
      },
    });
  });

  it("exports the Docs contract and mock from the Photo editing package", async () => {
    expect(PHOTO_CLOUD_CONTRACT_VERSION).toBe(CLOUD_CONTRACT_VERSION);
    expect(PHOTO_CLOUD_OPERATION_TRANSPORTS).toEqual(CLOUD_OPERATION_TRANSPORTS);
    const client: PhotoCloudClient = createPhotoCloudMockClient();
    await expect(client["share.list"]({ resourceType: "photo", resourceId: "photo-test" }))
      .resolves.toMatchObject({ ok: false, error: { code: "temporarily_unavailable" } });
  });
});
