import { describe, expect, it, vi } from "vitest";

import { createCloudMockClient, type CloudErrorCode, type CloudResourceRef } from "./cloud-sharing-contract";
import { PhotoCloudShareController, photoCloudShareErrorMessage, type PhotoCloudSharePhase } from "./cloud-sharing-controller";
import { createPhotoCloudSharingPreviewClient } from "./cloud-sharing-preview-mock";

const TARGET_A: CloudResourceRef = {
  resourceType: "photo",
  resourceId: "photo-a",
  ownerType: "user",
  ownerId: "owner-a",
  tenantId: "tenant-a",
  workspaceId: null,
};

const TARGET_B: CloudResourceRef = { ...TARGET_A, resourceId: "photo-b" };
const EXPIRES_AT = "2026-10-27T00:00:00.000Z";

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((next) => { resolve = next; });
  return { promise, resolve };
}

async function settle() {
  await Promise.resolve();
  await Promise.resolve();
}

function controller(client: ReturnType<typeof createCloudMockClient>, keys = vi.fn(() => "mutation-key")) {
  return new PhotoCloudShareController({
    client,
    access: "available",
    target: TARGET_A,
    createIdempotencyKey: keys,
    now: () => Date.parse("2026-10-20T00:00:00.000Z"),
  });
}

describe("PhotoCloudShareController", () => {
  it("retries create with the exact same key and payload and prevents duplicate submission", async () => {
    const requests: unknown[] = [];
    const headers: unknown[] = [];
    const create = vi.fn(async (request, mutationHeaders) => {
      requests.push(request);
      headers.push(mutationHeaders);
      if (requests.length === 1) {
        return { ok: false as const, error: { code: "temporarily_unavailable" as const, requestId: "hidden", retryable: true } };
      }
      return {
        ok: true as const,
        value: {
          share: { shareId: "share-a", resource: TARGET_A, permission: "read" as const, expiresAt: EXPIRES_AT, revokedAt: null },
          shareUrl: "https://share.invalid/synthetic",
          replayed: true,
        },
      };
    });
    const keys = vi.fn(() => "same-key");
    const flow = controller(createCloudMockClient({ "share.create": create }), keys);

    flow.create(EXPIRES_AT);
    flow.create("2026-11-20T00:00:00.000Z");
    await settle();
    expect(create).toHaveBeenCalledTimes(1);
    expect(keys).toHaveBeenCalledTimes(1);
    expect(flow.getSnapshot().phase).toBe("retryable-failure");

    flow.retry();
    flow.retry();
    await settle();
    expect(create).toHaveBeenCalledTimes(2);
    expect(requests[1]).toBe(requests[0]);
    expect(headers[1]).toBe(headers[0]);
    expect(flow.getSnapshot().phase).toBe("created");
  });

  it("ignores a cancelled response and reconciles a remotely-created share by listing", async () => {
    const pending = deferred<Awaited<ReturnType<ReturnType<typeof createCloudMockClient>["share.create"]>>>();
    const share = { shareId: "share-a", resource: TARGET_A, permission: "read" as const, expiresAt: EXPIRES_AT, revokedAt: null };
    const client = createCloudMockClient({
      "share.create": () => pending.promise,
      "share.list": async () => ({ ok: true, value: { items: [share], nextCursor: null } }),
    });
    const flow = controller(client);

    flow.create(EXPIRES_AT);
    flow.cancel();
    expect(flow.getSnapshot()).toMatchObject({ phase: "cancelled", shareUrl: null, reconciliationNeeded: true });
    pending.resolve({ ok: true, value: { share, shareUrl: "https://share.invalid/stale", replayed: false } });
    await settle();
    expect(flow.getSnapshot()).toMatchObject({ phase: "cancelled", shareUrl: null, mutationInFlight: false });

    flow.refresh();
    await settle();
    expect(flow.getSnapshot().phase).toBe("ready");
    expect(flow.getSnapshot().items.map((item) => item.shareId)).toEqual(["share-a"]);
    expect(flow.getSnapshot().shareUrl).toBeNull();
  });

  it("does not race a cancelled mutation with listing while its response is unresolved", async () => {
    const pending = deferred<Awaited<ReturnType<ReturnType<typeof createCloudMockClient>["share.create"]>>>();
    const list = vi.fn(async () => ({ ok: true as const, value: { items: [], nextCursor: null } }));
    const flow = controller(createCloudMockClient({
      "share.create": () => pending.promise,
      "share.list": list,
    }));

    flow.create(EXPIRES_AT);
    flow.cancel();
    flow.refresh();
    expect(list).not.toHaveBeenCalled();
    expect(flow.getSnapshot()).toMatchObject({ phase: "cancelled", mutationInFlight: true });

    pending.resolve({
      ok: false,
      error: { code: "temporarily_unavailable", requestId: "hidden", retryable: true },
    });
    await settle();
    flow.refresh();
    await settle();
    expect(list).toHaveBeenCalledTimes(1);
    expect(flow.getSnapshot()).toMatchObject({ phase: "ready", reconciliationNeeded: true });
  });

  it("keeps the original idempotency key after an uncertain create and a list refresh", async () => {
    const create = vi.fn()
      .mockResolvedValueOnce({ ok: false, error: { code: "temporarily_unavailable", requestId: "hidden", retryable: true } })
      .mockResolvedValueOnce({
        ok: true,
        value: {
          share: { shareId: "share-a", resource: TARGET_A, permission: "read", expiresAt: EXPIRES_AT, revokedAt: null },
          shareUrl: "https://share.invalid/resumed",
          replayed: true,
        },
      });
    const keys = vi.fn().mockReturnValueOnce("first-key").mockReturnValueOnce("second-key");
    const flow = controller(createCloudMockClient({
      "share.create": create,
      "share.list": async () => ({ ok: true, value: { items: [], nextCursor: null } }),
    }), keys);

    flow.create(EXPIRES_AT);
    await settle();
    expect(flow.getSnapshot()).toMatchObject({ phase: "retryable-failure", reconciliationNeeded: true });
    flow.refresh();
    await settle();
    flow.create("2026-11-20T00:00:00.000Z");
    expect(keys).toHaveBeenCalledTimes(1);
    expect(flow.getSnapshot()).toMatchObject({ phase: "ready", reconciliationNeeded: true });

    flow.resumeMutation();
    await settle();
    expect(create).toHaveBeenCalledTimes(2);
    expect(create.mock.calls[1]?.[0]).toBe(create.mock.calls[0]?.[0]);
    expect(create.mock.calls[1]?.[1]).toBe(create.mock.calls[0]?.[1]);
    expect(flow.getSnapshot().phase).toBe("created");
  });

  it("preserves the logical mutation across offline and signed-in access transitions", async () => {
    const pending = deferred<Awaited<ReturnType<ReturnType<typeof createCloudMockClient>["share.create"]>>>();
    const requests: unknown[] = [];
    const headers: unknown[] = [];
    const create = vi.fn((request, mutationHeaders) => {
      requests.push(request);
      headers.push(mutationHeaders);
      if (requests.length === 1) return pending.promise;
      return Promise.resolve({
        ok: true as const,
        value: {
          share: { shareId: "share-a", resource: TARGET_A, permission: "read" as const, expiresAt: EXPIRES_AT, revokedAt: null },
          shareUrl: "https://share.invalid/resumed",
          replayed: true,
        },
      });
    });
    const keys = vi.fn(() => "access-transition-key");
    const flow = controller(createCloudMockClient({ "share.create": create }), keys);
    flow.create(EXPIRES_AT);
    flow.setAccess("offline");
    expect(flow.getSnapshot()).toMatchObject({ phase: "offline", resumableMutation: "create", mutationInFlight: true });
    pending.resolve({
      ok: false,
      error: { code: "temporarily_unavailable", requestId: "hidden", retryable: true },
    });
    await settle();
    flow.setAccess("available");
    expect(flow.getSnapshot()).toMatchObject({ phase: "cancelled", resumableMutation: "create", mutationInFlight: false });
    flow.resumeMutation();
    await settle();
    expect(requests[1]).toBe(requests[0]);
    expect(headers[1]).toBe(headers[0]);
    expect(keys).toHaveBeenCalledTimes(1);
    expect(flow.getSnapshot().phase).toBe("created");
  });

  it("clears volatile state and ignores stale responses when the trusted target changes", async () => {
    const first = deferred<Awaited<ReturnType<ReturnType<typeof createCloudMockClient>["share.create"]>>>();
    const create = vi.fn((request: { resource: CloudResourceRef; expiresAt: string; permission: "read" }) => {
      if (request.resource.resourceId === TARGET_A.resourceId) return first.promise;
      return Promise.resolve({
        ok: true as const,
        value: {
          share: { shareId: "share-b", resource: TARGET_B, permission: "read" as const, expiresAt: request.expiresAt, revokedAt: null },
          shareUrl: "https://share.invalid/target-b",
          replayed: false,
        },
      });
    });
    const flow = controller(createCloudMockClient({ "share.create": create }));
    flow.create(EXPIRES_AT);
    flow.setTarget(TARGET_B);
    first.resolve({
      ok: true,
      value: {
        share: { shareId: "share-a", resource: TARGET_A, permission: "read", expiresAt: EXPIRES_AT, revokedAt: null },
        shareUrl: "https://share.invalid/stale-a",
        replayed: false,
      },
    });
    await settle();
    expect(flow.getSnapshot()).toMatchObject({ phase: "target-confirmation", shareUrl: null, items: [] });

    flow.create(EXPIRES_AT);
    await settle();
    expect(create.mock.calls[1]?.[0].resource).toBe(TARGET_B);
    expect(flow.getSnapshot().phase).toBe("created");
  });

  it("lists and revokes shares through the deterministic preview-only adapter", async () => {
    const preview = createPhotoCloudSharingPreviewClient();
    const created = await preview["share.create"](
      { resource: TARGET_A, permission: "read", expiresAt: EXPIRES_AT },
      { "Idempotency-Key": "create-one" },
    );
    if (!created.ok) throw new Error("preview create failed");
    const flow = controller(preview, vi.fn()
      .mockReturnValueOnce("revoke-one")
      .mockReturnValueOnce("unused"));

    flow.refresh();
    await settle();
    expect(flow.getSnapshot().items).toHaveLength(1);
    flow.revoke(created.value.share.shareId);
    await settle();
    expect(flow.getSnapshot().items[0]?.revokedAt).not.toBeNull();
    expect(flow.getSnapshot().shareUrl).toBeNull();
  });

  it("retries revoke with the same key and payload", async () => {
    const share = { shareId: "share-a", resource: TARGET_A, permission: "read" as const, expiresAt: EXPIRES_AT, revokedAt: null };
    const requests: unknown[] = [];
    const headers: unknown[] = [];
    const revoke = vi.fn(async (request, mutationHeaders) => {
      requests.push(request);
      headers.push(mutationHeaders);
      if (requests.length === 1) {
        return { ok: false as const, error: { code: "temporarily_unavailable" as const, requestId: "hidden", retryable: true } };
      }
      return { ok: true as const, value: { shareId: share.shareId, revokedAt: "2026-10-20T00:00:00.000Z", replayed: true } };
    });
    const keys = vi.fn(() => "same-revoke-key");
    const flow = controller(createCloudMockClient({
      "share.list": async () => ({ ok: true, value: { items: [share], nextCursor: null } }),
      "share.revoke": revoke,
    }), keys);
    flow.refresh();
    await settle();
    flow.revoke(share.shareId);
    await settle();
    expect(flow.getSnapshot().phase).toBe("retryable-failure");
    flow.retry();
    await settle();
    expect(revoke).toHaveBeenCalledTimes(2);
    expect(requests[1]).toBe(requests[0]);
    expect(headers[1]).toBe(headers[0]);
    expect(keys).toHaveBeenCalledTimes(1);
    expect(flow.getSnapshot().items[0]?.revokedAt).not.toBeNull();
  });

  it("makes preview mutation retries idempotent and rejects key conflicts", async () => {
    const preview = createPhotoCloudSharingPreviewClient();
    const request = { resource: TARGET_A, permission: "read" as const, expiresAt: EXPIRES_AT };
    const first = await preview["share.create"](request, { "Idempotency-Key": "stable-key" });
    const replay = await preview["share.create"](request, { "Idempotency-Key": "stable-key" });
    const conflict = await preview["share.create"](
      { ...request, expiresAt: "2026-11-20T00:00:00.000Z" },
      { "Idempotency-Key": "stable-key" },
    );
    expect(first.ok && replay.ok ? replay.value.share.shareId : null).toBe(first.ok ? first.value.share.shareId : null);
    expect(replay.ok && replay.value.replayed).toBe(true);
    expect(conflict).toMatchObject({ ok: false, error: { code: "idempotency_conflict" } });
  });

  it.each<readonly [CloudErrorCode, boolean, PhotoCloudSharePhase]>([
    ["unauthenticated", false, "signed-out"],
    ["not_found", false, "not-found-permission"],
    ["quota_exceeded", false, "quota"],
    ["capability_expired", false, "expired"],
    ["capability_revoked", false, "expired"],
    ["capability_replayed", false, "expired"],
    ["invalid_request", false, "nonretryable-failure"],
    ["idempotency_conflict", false, "nonretryable-failure"],
    ["content_rejected", false, "nonretryable-failure"],
    ["rate_limited", true, "retryable-failure"],
    ["temporarily_unavailable", true, "retryable-failure"],
  ])("maps public error %s without exposing transport details", async (code, retryable, phase) => {
    const flow = controller(createCloudMockClient({
      "share.create": async () => ({ ok: false, error: { code, requestId: "must-stay-hidden", retryable } }),
    }));
    flow.create(EXPIRES_AT);
    await settle();
    expect(flow.getSnapshot()).toMatchObject({ phase, errorCode: code, message: photoCloudShareErrorMessage(code), shareUrl: null });
    expect(flow.getSnapshot().message).not.toContain("must-stay-hidden");
  });

  it("does not use logs or browser persistence for the bearer URL", async () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
    const storage = { setItem: vi.fn() };
    vi.stubGlobal("localStorage", storage);
    const preview = createPhotoCloudSharingPreviewClient();
    const flow = controller(preview);
    flow.create(EXPIRES_AT);
    await settle();
    flow.close();
    expect(flow.getSnapshot().shareUrl).toBeNull();
    expect(log).not.toHaveBeenCalled();
    expect(storage.setItem).not.toHaveBeenCalled();
    log.mockRestore();
    vi.unstubAllGlobals();
  });
});
