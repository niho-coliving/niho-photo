import type { CloudClient, CloudError, CloudResult } from "./v1.js";

export type CloudMockHandlers = Partial<CloudClient>;

const unconfigured = <T>(): Promise<CloudResult<T>> => Promise.resolve({
  ok: false,
  error: {
    code: "temporarily_unavailable",
    requestId: "mock-unconfigured",
    retryable: false,
  } satisfies CloudError,
});

/**
 * Deterministic mock transport for client UX and tests. This is not an
 * authorization implementation and must never be used to authorize requests.
 */
export function createCloudMockClient(handlers: CloudMockHandlers = {}): CloudClient {
  return {
    "upload.start": (request, headers) => handlers["upload.start"]?.(request, headers) ?? unconfigured(),
    "upload.complete": (request, headers) => handlers["upload.complete"]?.(request, headers) ?? unconfigured(),
    "download.start": (request) => handlers["download.start"]?.(request) ?? unconfigured(),
    "share.create": (request, headers) => handlers["share.create"]?.(request, headers) ?? unconfigured(),
    "share.revoke": (request, headers) => handlers["share.revoke"]?.(request, headers) ?? unconfigured(),
    "share.list": (request) => handlers["share.list"]?.(request) ?? unconfigured(),
  };
}
