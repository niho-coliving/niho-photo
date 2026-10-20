import { describe, expect, it, vi } from "vitest";

import type { PhotoLibraryWorkingCopyDownload } from "../library/photo-library";

import {
  DEVELOP_WORK_CACHE_NAME,
  DevelopWorkCopyError,
  clearDevelopWorkCache,
  detectDevelopWorkCopyEncoding,
  developWorkCacheSettled,
  developWorkCachePath,
  loadDevelopWorkCopy,
  type DevelopWorkCacheStorage,
} from "./develop-work-cache";

const ORIGIN = "https://niho.test";
const MiB = 1024 ** 2;

/** Cache の代わり（key は同じ origin の URL として持つ）。 */
class FakeCache {
  readonly entries = new Map<string, Response>();

  private key(input: RequestInfo | URL): string {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    return new URL(url, ORIGIN).href;
  }

  async match(input: RequestInfo | URL): Promise<Response | undefined> {
    return this.entries.get(this.key(input))?.clone();
  }

  async put(input: RequestInfo | URL, response: Response): Promise<void> {
    this.entries.set(this.key(input), response);
  }

  async delete(input: RequestInfo | URL): Promise<boolean> {
    return this.entries.delete(this.key(input));
  }

  async keys(): Promise<Request[]> {
    return [...this.entries.keys()].map((url) => new Request(url));
  }

  paths(): string[] {
    return [...this.entries.keys()].map((url) => new URL(url).pathname).sort();
  }
}

function fakeStorage() {
  const state = { cache: new FakeCache() };
  const storage = {
    open: vi.fn(async (_name: string) => state.cache as unknown as Cache),
    delete: vi.fn(async (_name: string) => {
      state.cache = new FakeCache();
      return true;
    }),
  };
  return { storage: storage as DevelopWorkCacheStorage & typeof storage, state };
}

function workDownload(photoId: string, bytes: number, baseVersion = "raw-apple.d8.p1.e1.cal-none"): PhotoLibraryWorkingCopyDownload {
  return {
    ref: `https://storage.example.test/bucket/${photoId}/work.png`,
    expiresAt: "2026-09-29T00:15:00.000Z",
    work: {
      baseVersion,
      sizeBytes: bytes,
      width: 2560,
      height: 1707,
      meta: { kind: "raw", baselineEV: 0, asShotWhite: { x: 0.3457, y: 0.3585 } },
      renderedAt: "2026-09-29T00:00:00.000Z",
    },
  };
}

const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47];

/** 16bit PNG の作業コピーの代わり（先頭が PNG の目印。5 バイト目に見分け用の値）。 */
function pngBytes(length: number, marker = 7): Uint8Array<ArrayBuffer> {
  const bytes = new Uint8Array(length);
  bytes.set(PNG_SIGNATURE.slice(0, Math.min(4, length)));
  if (length > 4) bytes[4] = marker;
  return bytes;
}

/** ICC 付きの 8bit JPEG の作業コピーの代わり（先頭が `FF D8 FF`。K5 移行元設計）。 */
function jpegBytes(length: number, marker = 7): Uint8Array<ArrayBuffer> {
  const bytes = new Uint8Array(length);
  bytes.set([0xff, 0xd8, 0xff, 0xe0].slice(0, Math.min(4, length)));
  if (length > 4) bytes[4] = marker;
  return bytes;
}

function fetchReturning(bytes: Uint8Array<ArrayBuffer>, headers: Record<string, string> = {}) {
  return vi.fn(async (_url: string, _init?: RequestInit) =>
    new Response(bytes, { headers: { "content-length": String(bytes.byteLength), ...headers } }),
  );
}

describe("loadDevelopWorkCopy", () => {
  it("無ければ署名付き URL から CORS で読み、PNG とメタデータを /develop-cache/<photoId>/<baseVersion> に入れる", async () => {
    const { storage, state } = fakeStorage();
    const fetchImpl = fetchReturning(pngBytes(16));
    const controller = new AbortController();
    const download = workDownload("p1", 16);

    const copy = await loadDevelopWorkCopy({
      photoId: "p1",
      download,
      signal: controller.signal,
      cacheStorage: storage,
      fetchImpl,
      now: () => 1_000,
    });

    expect(fetchImpl).toHaveBeenCalledWith(download.ref, { mode: "cors", credentials: "omit", signal: controller.signal });
    expect(storage.open).toHaveBeenCalledWith(DEVELOP_WORK_CACHE_NAME);
    expect(copy).toMatchObject({ photoId: "p1", baseVersion: "raw-apple.d8.p1.e1.cal-none", encoding: "png16", fromCache: false });
    expect(new Uint8Array(copy.bytes)[4]).toBe(7);
    expect(copy.bytes.byteLength).toBe(16);
    expect(JSON.parse(copy.metaJson)).toEqual(download.work.meta);
    await developWorkCacheSettled();
    expect(state.cache.paths()).toEqual([
      "/develop-cache/p1/raw-apple.d8.p1.e1.cal-none",
      "/develop-cache/p1/raw-apple.d8.p1.e1.cal-none/meta",
    ]);
    const stored = await state.cache.match(developWorkCachePath("p1", "raw-apple.d8.p1.e1.cal-none"));
    expect(stored?.headers.get("x-niho-develop-size")).toBe("16");
    expect(stored?.headers.get("x-niho-develop-stored-at")).toBe("1000");
    expect(stored?.headers.get("content-type")).toBe("image/png");
  });

  it("K5 #17153: JPEG の作業コピーは中身で jpeg8 と見分け、image/jpeg で入れる。同じ版は持っている方を jpeg8 で返す", async () => {
    const { storage, state } = fakeStorage();
    const jpegVersion = `raster.ci2.p2.e2.icc-${"c".repeat(64)}`;
    const download = workDownload("p1", 16, jpegVersion);

    const copy = await loadDevelopWorkCopy({
      photoId: "p1",
      download,
      signal: new AbortController().signal,
      cacheStorage: storage,
      fetchImpl: fetchReturning(jpegBytes(16, 6)),
    });

    expect(copy).toMatchObject({ baseVersion: jpegVersion, encoding: "jpeg8", fromCache: false });
    expect(new Uint8Array(copy.bytes)[4]).toBe(6);
    await developWorkCacheSettled();
    const stored = await state.cache.match(developWorkCachePath("p1", jpegVersion));
    expect(stored?.headers.get("content-type")).toBe("image/jpeg");

    const refetch = fetchReturning(jpegBytes(16, 8));
    const cached = await loadDevelopWorkCopy({
      photoId: "p1",
      download,
      signal: new AbortController().signal,
      cacheStorage: storage,
      fetchImpl: refetch,
    });
    expect(refetch).not.toHaveBeenCalled();
    expect(cached).toMatchObject({ encoding: "jpeg8", fromCache: true });
    expect(new Uint8Array(cached.bytes)[4]).toBe(6);
  });

  it("PNG でも JPEG でもない作業コピーは unsupported_format で読めなかったことにし、入れない。持っていた版が形違いなら消して読み直す", async () => {
    const { storage, state } = fakeStorage();
    const signal = new AbortController().signal;
    await expect(
      loadDevelopWorkCopy({ photoId: "p1", download: workDownload("p1", 16), signal, cacheStorage: storage, fetchImpl: fetchReturning(new Uint8Array(16)) }),
    ).rejects.toEqual(new DevelopWorkCopyError("unsupported_format"));
    expect(state.cache.paths()).toEqual([]);

    const path = developWorkCachePath("p1", "raw-apple.d8.p1.e1.cal-none");
    await state.cache.put(path, new Response(new Uint8Array(16), { headers: { "x-niho-develop-size": "16" } }));
    const refetch = fetchReturning(pngBytes(16, 2));
    const copy = await loadDevelopWorkCopy({ photoId: "p1", download: workDownload("p1", 16), signal, cacheStorage: storage, fetchImpl: refetch });
    expect(refetch).toHaveBeenCalledOnce();
    expect(copy).toMatchObject({ encoding: "png16", fromCache: false });
    expect(new Uint8Array(copy.bytes)[4]).toBe(2);
  });

  it("同じ版があれば GCS から読み直さない（メタデータも持っている方）", async () => {
    const { storage } = fakeStorage();
    const first = fetchReturning(pngBytes(16, 3));
    const download = workDownload("p1", 16);
    await loadDevelopWorkCopy({ photoId: "p1", download, signal: new AbortController().signal, cacheStorage: storage, fetchImpl: first });
    await developWorkCacheSettled();

    const second = fetchReturning(pngBytes(16, 9));
    const copy = await loadDevelopWorkCopy({
      photoId: "p1",
      download,
      signal: new AbortController().signal,
      cacheStorage: storage,
      fetchImpl: second,
    });

    expect(second).not.toHaveBeenCalled();
    expect(copy.fromCache).toBe(true);
    expect(new Uint8Array(copy.bytes)[4]).toBe(3);
    expect(JSON.parse(copy.metaJson)).toEqual(download.work.meta);
  });

  it("読んだ大きさが申告と違えば size_mismatch で捨てる（Content-Length・本文のどちらでも）。持っていた版の大きさが違えば読み直す", async () => {
    const { storage, state } = fakeStorage();
    const signal = new AbortController().signal;
    await expect(
      loadDevelopWorkCopy({ photoId: "p1", download: workDownload("p1", 16), signal, cacheStorage: storage, fetchImpl: fetchReturning(pngBytes(12)) }),
    ).rejects.toMatchObject({ reason: "size_mismatch" });
    await expect(
      loadDevelopWorkCopy({
        photoId: "p1",
        download: workDownload("p1", 16),
        signal,
        cacheStorage: storage,
        // Content-Length が無く、本文が申告より長い
        fetchImpl: vi.fn(async () => new Response(new Blob([pngBytes(20)]).stream())),
      }),
    ).rejects.toBeInstanceOf(DevelopWorkCopyError);
    expect(state.cache.paths()).toEqual([]);

    // 持っていた版の大きさが申告と違う（途中で入れ替わった）→ 消して読み直す
    await loadDevelopWorkCopy({ photoId: "p1", download: workDownload("p1", 8), signal, cacheStorage: storage, fetchImpl: fetchReturning(pngBytes(8)) });
    await developWorkCacheSettled();
    const refetch = fetchReturning(pngBytes(16, 5));
    const copy = await loadDevelopWorkCopy({ photoId: "p1", download: workDownload("p1", 16), signal, cacheStorage: storage, fetchImpl: refetch });
    expect(refetch).toHaveBeenCalledOnce();
    expect(copy).toMatchObject({ fromCache: false });
    expect(new Uint8Array(copy.bytes)[4]).toBe(5);
  });

  it("64MiB を超える申告は読まずに too_large。読めなければ fetch_failed", async () => {
    const fetchImpl = fetchReturning(pngBytes(4));
    await expect(
      loadDevelopWorkCopy({
        photoId: "p1",
        download: workDownload("p1", 64 * MiB + 1),
        signal: new AbortController().signal,
        cacheStorage: null,
        fetchImpl,
      }),
    ).rejects.toMatchObject({ reason: "too_large" });
    expect(fetchImpl).not.toHaveBeenCalled();

    await expect(
      loadDevelopWorkCopy({
        photoId: "p1",
        download: workDownload("p1", 4),
        signal: new AbortController().signal,
        cacheStorage: null,
        fetchImpl: vi.fn(async () => new Response("denied", { status: 403 })),
      }),
    ).rejects.toMatchObject({ reason: "fetch_failed" });
  });

  it("入れたら同じ写真の古い版を消し、合計が 1GiB を超えたら入れた時刻の古い順に消す", async () => {
    const { storage, state } = fakeStorage();
    // 大きさのヘッダだけ大きい、先に入れた作業コピー（400MiB × 3）
    for (const [photoId, storedAt] of [["old", 1], ["mid", 2], ["new", 3]] as const) {
      const headers = { "x-niho-develop-size": String(400 * MiB), "x-niho-develop-stored-at": String(storedAt) };
      await state.cache.put(developWorkCachePath(photoId, "v1"), new Response(pngBytes(4), { headers }));
      await state.cache.put(`${developWorkCachePath(photoId, "v1")}/meta`, new Response("{}", { headers }));
    }
    await state.cache.put(developWorkCachePath("p1", "v0"), new Response(pngBytes(4), { headers: { "x-niho-develop-size": "4" } }));

    await loadDevelopWorkCopy({
      photoId: "p1",
      download: workDownload("p1", 16, "v1"),
      signal: new AbortController().signal,
      cacheStorage: storage,
      fetchImpl: fetchReturning(pngBytes(16)),
      now: () => 4,
    });
    await developWorkCacheSettled();

    expect(state.cache.paths()).toEqual([
      "/develop-cache/mid/v1",
      "/develop-cache/mid/v1/meta",
      "/develop-cache/new/v1",
      "/develop-cache/new/v1/meta",
      "/develop-cache/p1/v1",
      "/develop-cache/p1/v1/meta",
    ]);
  });

  it("#17945: 入れ終わり（古い版の掃除を含む）を待たずに返し、入れるのは読んだ順に 1 本ずつ", async () => {
    const { storage, state } = fakeStorage();
    const puts: string[] = [];
    let release!: () => void;
    const blocked = new Promise<void>((resolve) => {
      release = resolve;
    });
    const put = state.cache.put.bind(state.cache);
    state.cache.put = async (input, response) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      puts.push(new URL(url, ORIGIN).pathname);
      await blocked;
      return put(input, response);
    };
    const load = (photoId: string, marker: number) =>
      loadDevelopWorkCopy({
        photoId,
        download: workDownload(photoId, 16),
        signal: new AbortController().signal,
        cacheStorage: storage,
        fetchImpl: fetchReturning(pngBytes(16, marker)),
      });

    const first = await load("p1", 3);
    const second = await load("p2", 4);
    expect([new Uint8Array(first.bytes)[4], new Uint8Array(second.bytes)[4]]).toEqual([3, 4]);
    expect(puts).toEqual(["/develop-cache/p1/raw-apple.d8.p1.e1.cal-none"]);

    release();
    await developWorkCacheSettled();
    expect(puts).toEqual([
      "/develop-cache/p1/raw-apple.d8.p1.e1.cal-none",
      "/develop-cache/p1/raw-apple.d8.p1.e1.cal-none/meta",
      "/develop-cache/p2/raw-apple.d8.p1.e1.cal-none",
      "/develop-cache/p2/raw-apple.d8.p1.e1.cal-none/meta",
    ]);
    const stored = await state.cache.match(developWorkCachePath("p2", "raw-apple.d8.p1.e1.cal-none"));
    expect(new Uint8Array(await stored!.arrayBuffer())[4]).toBe(4);
  });

  it("#17945: 同じ写真・土台の後続loadは保存中の先行loadへ合流し、GCSから重ねて読まない", async () => {
    const { storage, state } = fakeStorage();
    let puts = 0;
    let release!: () => void;
    const blocked = new Promise<void>((resolve) => {
      release = resolve;
    });
    const put = state.cache.put.bind(state.cache);
    state.cache.put = async (input, response) => {
      puts += 1;
      await blocked;
      return put(input, response);
    };
    const download = workDownload("p1", 16);
    const firstFetch = fetchReturning(pngBytes(16, 3));
    const first = await loadDevelopWorkCopy({
      photoId: "p1",
      download,
      signal: new AbortController().signal,
      cacheStorage: storage,
      fetchImpl: firstFetch,
    });
    expect(new Uint8Array(first.bytes)[4]).toBe(3);
    // 先行loadはputを待たず返る一方、同じpathの保存処理はここで停止している。
    await vi.waitFor(() => expect(puts).toBe(1));

    const secondFetch = fetchReturning(pngBytes(16, 9));
    let secondSettled = false;
    const secondPromise = loadDevelopWorkCopy({
      photoId: "p1",
      download,
      signal: new AbortController().signal,
      cacheStorage: storage,
      fetchImpl: secondFetch,
    }).then((copy) => {
      secondSettled = true;
      return copy;
    });
    await Promise.resolve();
    await Promise.resolve();
    expect(secondSettled).toBe(false);
    expect(secondFetch).not.toHaveBeenCalled();

    release();
    const second = await secondPromise;
    await developWorkCacheSettled();
    expect(second).toMatchObject({ fromCache: true, encoding: "png16" });
    expect(new Uint8Array(second.bytes)[4]).toBe(3);
    expect(firstFetch).toHaveBeenCalledOnce();
  });

  it("Cache Storage が無い・開けない環境では毎回読む", async () => {
    const download = workDownload("p1", 4);
    const fetchImpl = fetchReturning(pngBytes(4));
    await loadDevelopWorkCopy({ photoId: "p1", download, signal: new AbortController().signal, cacheStorage: null, fetchImpl });
    await loadDevelopWorkCopy({ photoId: "p1", download, signal: new AbortController().signal, cacheStorage: null, fetchImpl });
    expect(fetchImpl).toHaveBeenCalledTimes(2);

    const refused: DevelopWorkCacheStorage = {
      open: vi.fn(async () => {
        throw new DOMException("denied", "SecurityError");
      }),
      delete: vi.fn(async () => false),
    };
    const copy = await loadDevelopWorkCopy({ photoId: "p1", download, signal: new AbortController().signal, cacheStorage: refused, fetchImpl });
    expect(copy.fromCache).toBe(false);
    expect(fetchImpl).toHaveBeenCalledTimes(3);
  });

  it("止めたら AbortError をそのまま投げる", async () => {
    const controller = new AbortController();
    const fetchImpl = vi.fn(async (_url: string, init?: RequestInit) => {
      controller.abort();
      throw init?.signal?.reason ?? new DOMException("aborted", "AbortError");
    });
    await expect(
      loadDevelopWorkCopy({ photoId: "p1", download: workDownload("p1", 4), signal: controller.signal, cacheStorage: null, fetchImpl }),
    ).rejects.toMatchObject({ name: "AbortError" });
  });
});

describe("clearDevelopWorkCache", () => {
  it("全部消す。消している途中に読み終えた作業コピーは入れ直さない", async () => {
    const { storage, state } = fakeStorage();
    let finishFetch!: () => void;
    const fetchImpl = vi.fn(
      () =>
        new Promise<Response>((resolve) => {
          finishFetch = () => resolve(new Response(pngBytes(4), { headers: { "content-length": "4" } }));
        }),
    );
    const loading = loadDevelopWorkCopy({
      photoId: "p1",
      download: workDownload("p1", 4),
      signal: new AbortController().signal,
      cacheStorage: storage,
      fetchImpl,
    });
    await vi.waitFor(() => expect(fetchImpl).toHaveBeenCalled());
    const cacheInUse = state.cache;

    await clearDevelopWorkCache(storage);
    finishFetch();
    const copy = await loading;
    await developWorkCacheSettled();

    expect(storage.delete).toHaveBeenCalledWith(DEVELOP_WORK_CACHE_NAME);
    expect(copy.bytes.byteLength).toBe(4);
    expect(cacheInUse.paths()).toEqual([]);
  });

  it("Cache Storage が無ければ何もしない（失敗しない）", async () => {
    await expect(clearDevelopWorkCache(null)).resolves.toBeUndefined();
    const failing: DevelopWorkCacheStorage = {
      open: vi.fn(),
      delete: vi.fn(async () => {
        throw new Error("denied");
      }),
    };
    await expect(clearDevelopWorkCache(failing)).resolves.toBeUndefined();
  });
});

describe("detectDevelopWorkCopyEncoding（K5 #17153）", () => {
  it("先頭が FF D8 FF なら jpeg8、89 50 4E 47 なら png16、どちらでもなければ null", () => {
    expect(detectDevelopWorkCopyEncoding(jpegBytes(8).buffer)).toBe("jpeg8");
    expect(detectDevelopWorkCopyEncoding(new Uint8Array([0xff, 0xd8, 0xff]).buffer)).toBe("jpeg8");
    expect(detectDevelopWorkCopyEncoding(pngBytes(8).buffer)).toBe("png16");
    for (const bytes of [
      new Uint8Array(0),
      new Uint8Array([0xff, 0xd8]),
      new Uint8Array([0x89, 0x50, 0x4e]),
      new Uint8Array([0xff, 0xd8, 0xfe, 0x00]),
      new Uint8Array([0x47, 0x49, 0x46, 0x38]),
      new Uint8Array([0x52, 0x49, 0x46, 0x46]),
    ]) {
      expect(detectDevelopWorkCopyEncoding(bytes.buffer), Array.from(bytes).join(",")).toBeNull();
    }
  });
});
