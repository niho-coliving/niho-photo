import type { PhotoLibraryWorkingCopyDownload } from "../library/photo-library";

/**
 * 作業コピー（段 1 の出力。移行時の設計文書「作業コピー」）をブラウザで読む（移行元設計）。RAW は 16bit PNG、
 * RAW 以外は ICC 付きの 8bit JPEG（K5 移行元設計）で、どちらかは中身の先頭で見分ける（{@link detectDevelopWorkCopyEncoding}）。
 *
 * - `work/download` の署名付き URL（接続口の作業コピーの参照 `download.ref`。クラウドの `loadWorkingCopy` だけが使う）から CORS で
 *   読み、申告の大きさ（`work.sizeBytes`。64MiB まで）を上限に取る。大きさが
 *   違えば捨てる（途中で切れた・別の実体）。PNG でも JPEG でもなければ読めなかったことにする（`unsupported_format`）
 * - Cache Storage（`niho-develop-cache-v1`）に同じ origin の `/develop-cache/<photoId>/<baseVersion>`（作業コピー）と `.../meta`
 *   （メタデータの JSON）で持つ。同じ版があれば GCS から読み直さない（版を知るため `work/download` は毎回呼ぶ。版ごとに key が
 *   違うので、PNG と JPEG の作業コピーは混ざらない）。入れたら同じ写真の古い版を消し、合計が 1GiB を超えたら入れた時刻の古い順に消す。
 *   入れるのは読み終えた後に裏で順に行い、開くのを待たせない（移行元設計）
 * - ログアウト・拠点の切り替えで全部消す（{@link clearDevelopWorkCache}）。Cache Storage を使えない環境（プライベート
 *   ブラウズなど）では毎回読む
 */

export const DEVELOP_WORK_CACHE_NAME = "niho-develop-cache-v1";
/** 持っておく作業コピーの合計の上限。 */
export const DEVELOP_WORK_CACHE_MAX_TOTAL_BYTES = 1024 ** 3;
/** 作業コピー 1 枚の上限（ワーカーが上げられる大きさと同じ 64MiB）。 */
export const DEVELOP_WORK_COPY_MAX_BYTES = 64 * 1024 ** 2;

const CACHE_PATH_PREFIX = "/develop-cache/";
const SIZE_HEADER = "x-niho-develop-size";
const STORED_AT_HEADER = "x-niho-develop-stored-at";

/**
 * 作業コピーの中身（K5 移行元設計）。`png16` は 16bit PNG（linear ProPhoto。段 2 の `openWorkingCopy` で開く）、`jpeg8` は ICC 付きの
 * 8bit JPEG（段 2 が JPEG のオリジナルと同じ入口で開く）。
 */
export type DevelopWorkCopyEncoding = "png16" | "jpeg8";

/** 作業コピーの先頭のバイト列で中身を見分ける（`FF D8 FF` は JPEG、`89 50 4E 47` は PNG。どちらでもなければ null）。 */
export function detectDevelopWorkCopyEncoding(bytes: ArrayBuffer): DevelopWorkCopyEncoding | null {
  const head = new Uint8Array(bytes, 0, Math.min(4, bytes.byteLength));
  if (head.length >= 3 && head[0] === 0xff && head[1] === 0xd8 && head[2] === 0xff) return "jpeg8";
  if (head.length >= 4 && head[0] === 0x89 && head[1] === 0x50 && head[2] === 0x4e && head[3] === 0x47) return "png16";
  return null;
}

export type DevelopWorkCopy = {
  photoId: string;
  baseVersion: string;
  /** 作業コピーのバイト列（Worker へ渡すときはコピーを渡す） */
  bytes: ArrayBuffer;
  /** 中身（先頭のバイト列で見分けた） */
  encoding: DevelopWorkCopyEncoding;
  /** 作業コピーのメタデータ（`work.meta`）の JSON */
  metaJson: string;
  /** Cache Storage から読んだ（GCS から読んでいない） */
  fromCache: boolean;
};

export class DevelopWorkCopyError extends Error {
  constructor(readonly reason: "fetch_failed" | "size_mismatch" | "too_large" | "unsupported_format") {
    super(reason);
    this.name = "DevelopWorkCopyError";
  }
}

/** Cache Storage のうち、ここで使う分だけ（テストで差し替える）。 */
export type DevelopWorkCacheStorage = Pick<CacheStorage, "open" | "delete">;

type FetchLike = (url: string, init?: RequestInit) => Promise<Response>;

/** 全部消した回数（消している途中に読み終えた作業コピーを入れ直さない）。 */
let cacheGeneration = 0;
/** 読み終えた作業コピーを入れる処理の列（1 本ずつ。{@link developWorkCacheSettled}）。 */
let pendingStore: Promise<void> = Promise.resolve();
/** 同じ写真・土台の fetch/store を共有する（先行loadの表示は保存完了を待たせない）。 */
type PendingWorkCopyStore = { done: Promise<boolean>; resolve: (stored: boolean) => void };
const pendingWorkCopyStores = new Map<string, PendingWorkCopyStore>();

function beginWorkCopyStore(path: string): PendingWorkCopyStore {
  let resolveDone!: (stored: boolean) => void;
  const done = new Promise<boolean>((resolve) => {
    resolveDone = resolve;
  });
  const pending: PendingWorkCopyStore = { done, resolve: resolveDone };
  pendingWorkCopyStores.set(path, pending);
  return pending;
}

function finishWorkCopyStore(path: string, pending: PendingWorkCopyStore, stored: boolean): void {
  if (pendingWorkCopyStores.get(path) === pending) pendingWorkCopyStores.delete(path);
  pending.resolve(stored);
}

function waitForWorkCopyStore(pending: PendingWorkCopyStore, signal: AbortSignal): Promise<boolean> {
  signal.throwIfAborted();
  return new Promise<boolean>((resolve, reject) => {
    let settled = false;
    const cleanup = () => {
      if (settled) return;
      settled = true;
      signal.removeEventListener("abort", onAbort);
    };
    const onAbort = () => {
      cleanup();
      reject(signal.reason ?? new DOMException("Aborted", "AbortError"));
    };
    signal.addEventListener("abort", onAbort, { once: true });
    if (signal.aborted) {
      onAbort();
      return;
    }
    pending.done.then((stored) => {
      if (settled) return;
      cleanup();
      resolve(stored);
    });
  });
}

function defaultCacheStorage(): DevelopWorkCacheStorage | null {
  try {
    return typeof caches === "undefined" ? null : caches;
  } catch {
    return null;
  }
}

/** 作業コピーの Cache Storage の key（同じ origin の path）。 */
export function developWorkCachePath(photoId: string, baseVersion: string): string {
  return `${CACHE_PATH_PREFIX}${encodeURIComponent(photoId)}/${encodeURIComponent(baseVersion)}`;
}

function metaPath(path: string): string {
  return `${path}/meta`;
}

/** key の path を `[photoId, baseVersion]`（作業コピー）か `[photoId, baseVersion, "meta"]` に分ける。ほかの key は null。 */
function readCachePathSegments(url: string): string[] | null {
  let pathname: string;
  try {
    pathname = new URL(url, "https://develop-cache.invalid").pathname;
  } catch {
    return null;
  }
  if (!pathname.startsWith(CACHE_PATH_PREFIX)) return null;
  return pathname.slice(CACHE_PATH_PREFIX.length).split("/");
}

async function openCache(storage: DevelopWorkCacheStorage | null): Promise<Cache | null> {
  if (!storage) return null;
  try {
    return await storage.open(DEVELOP_WORK_CACHE_NAME);
  } catch {
    // プライベートブラウズなどで使えない
    return null;
  }
}

function readHeaderNumber(response: Response, name: string): number {
  const value = Number(response.headers.get(name));
  return Number.isFinite(value) ? value : 0;
}

/** 持っている作業コピー（大きさが申告と違う・PNG でも JPEG でもなければ消して null）。 */
async function readCached(
  cache: Cache,
  path: string,
  expectedSize: number,
): Promise<{ bytes: ArrayBuffer; encoding: DevelopWorkCopyEncoding; metaJson: string | null } | null> {
  try {
    const response = await cache.match(path);
    if (!response) return null;
    const bytes = readHeaderNumber(response, SIZE_HEADER) === expectedSize ? await response.arrayBuffer() : null;
    const encoding = bytes && bytes.byteLength === expectedSize ? detectDevelopWorkCopyEncoding(bytes) : null;
    if (!bytes || !encoding) {
      await cache.delete(path);
      await cache.delete(metaPath(path));
      return null;
    }
    const meta = await cache.match(metaPath(path));
    return { bytes, encoding, metaJson: meta ? await meta.text() : null };
  } catch {
    return null;
  }
}

/** 作業コピーを入れる（`copy.bytes` は入れる分の写し。入れられなくても読んだ作業コピーは使う）。 */
async function storeCached(
  cache: Cache,
  path: string,
  copy: { bytes: ArrayBuffer; encoding: DevelopWorkCopyEncoding },
  metaJson: string,
  storedAt: number,
): Promise<void> {
  const headers = {
    [SIZE_HEADER]: String(copy.bytes.byteLength),
    [STORED_AT_HEADER]: String(storedAt),
  };
  const contentType = copy.encoding === "jpeg8" ? "image/jpeg" : "image/png";
  await cache.put(path, new Response(copy.bytes, { headers: { ...headers, "content-type": contentType } }));
  await cache.put(metaPath(path), new Response(metaJson, { headers: { ...headers, "content-type": "application/json" } }));
}

/** 同じ写真の古い版を消し、合計が上限を超えたら入れた時刻の古い順に消す（入れたばかりの `keepPath` は残す）。 */
async function evictCached(cache: Cache, keepPath: string, photoId: string): Promise<void> {
  const entries: { request: Request; path: string; size: number; storedAt: number }[] = [];
  let total = 0;
  for (const request of await cache.keys()) {
    const segments = readCachePathSegments(request.url);
    if (!segments || segments.length !== 2) continue;
    const response = await cache.match(request);
    if (!response) continue;
    const path = `${CACHE_PATH_PREFIX}${segments.join("/")}`;
    const size = readHeaderNumber(response, SIZE_HEADER);
    if (path !== keepPath && segments[0] === encodeURIComponent(photoId)) {
      // 同じ写真の古い版（土台の版が変わった）はもう使わない
      await cache.delete(request);
      await cache.delete(metaPath(path));
      continue;
    }
    entries.push({ request, path, size, storedAt: readHeaderNumber(response, STORED_AT_HEADER) });
    total += size;
  }
  entries.sort((a, b) => a.storedAt - b.storedAt);
  for (const entry of entries) {
    if (total <= DEVELOP_WORK_CACHE_MAX_TOTAL_BYTES) break;
    if (entry.path === keepPath) continue;
    await cache.delete(entry.request);
    await cache.delete(metaPath(entry.path));
    total -= entry.size;
  }
}

/** 署名付き URL から作業コピーを読む（申告の大きさを上限に取り、違えば `size_mismatch`）。 */
async function fetchWorkCopy(
  url: string,
  expectedSize: number,
  signal: AbortSignal,
  fetchImpl: FetchLike,
): Promise<ArrayBuffer> {
  if (!Number.isInteger(expectedSize) || expectedSize < 1) throw new DevelopWorkCopyError("size_mismatch");
  if (expectedSize > DEVELOP_WORK_COPY_MAX_BYTES) throw new DevelopWorkCopyError("too_large");
  let response: Response;
  try {
    response = await fetchImpl(url, { mode: "cors", credentials: "omit", signal });
  } catch (error) {
    if (signal.aborted) throw error;
    throw new DevelopWorkCopyError("fetch_failed");
  }
  if (!response.ok) throw new DevelopWorkCopyError("fetch_failed");
  const contentLength = response.headers.get("content-length");
  if (contentLength !== null && Number(contentLength) !== expectedSize) throw new DevelopWorkCopyError("size_mismatch");
  if (!response.body) {
    let buffer: ArrayBuffer;
    try {
      buffer = await response.arrayBuffer();
    } catch (error) {
      if (signal.aborted) throw error;
      throw new DevelopWorkCopyError("fetch_failed");
    }
    if (buffer.byteLength !== expectedSize) throw new DevelopWorkCopyError("size_mismatch");
    return buffer;
  }
  const bytes = new Uint8Array(expectedSize);
  let total = 0;
  const reader = response.body.getReader();
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (total + value.byteLength > expectedSize) {
        try {
          await reader.cancel();
        } catch {
          // 上限超えを正として扱う
        }
        throw new DevelopWorkCopyError("size_mismatch");
      }
      bytes.set(value, total);
      total += value.byteLength;
    }
  } catch (error) {
    if (signal.aborted || error instanceof DevelopWorkCopyError) throw error;
    throw new DevelopWorkCopyError("fetch_failed");
  } finally {
    try {
      reader.releaseLock();
    } catch {
      // read / cancel の結果を優先する
    }
  }
  if (total !== expectedSize) throw new DevelopWorkCopyError("size_mismatch");
  return bytes.buffer;
}

/**
 * 作業コピーを読む（Cache Storage にあればそれ、無ければ GCS から読んで入れる）。中身は先頭のバイト列で見分け、PNG でも JPEG
 * でもなければ `unsupported_format`（入れない）。止めたら（`signal`）AbortError をそのまま投げる。
 */
export async function loadDevelopWorkCopy(params: {
  photoId: string;
  download: PhotoLibraryWorkingCopyDownload;
  signal: AbortSignal;
  cacheStorage?: DevelopWorkCacheStorage | null;
  fetchImpl?: FetchLike;
  now?: () => number;
}): Promise<DevelopWorkCopy> {
  const { photoId, download, signal } = params;
  const { baseVersion, sizeBytes } = download.work;
  const path = developWorkCachePath(photoId, baseVersion);
  const generation = cacheGeneration;
  const cache = await openCache(params.cacheStorage === undefined ? defaultCacheStorage() : params.cacheStorage);
  signal.throwIfAborted();
  if (cache) {
    const cached = await readCached(cache, path, sizeBytes);
    signal.throwIfAborted();
    if (cached) {
      return {
        photoId,
        baseVersion,
        bytes: cached.bytes,
        encoding: cached.encoding,
        metaJson: cached.metaJson ?? JSON.stringify(download.work.meta),
        fromCache: true,
      };
    }
    const pending = pendingWorkCopyStores.get(path);
    if (pending) {
      // 別の表示が同じ版を読んで保存中なら、その完了後にCache Storageを再確認する。
      // 先行loadは待たず、後続loadだけが同じ64MiBの再fetchを避けて合流する。
      await waitForWorkCopyStore(pending, signal);
      signal.throwIfAborted();
      const stored = await readCached(cache, path, sizeBytes);
      signal.throwIfAborted();
      if (stored) {
        return {
          photoId,
          baseVersion,
          bytes: stored.bytes,
          encoding: stored.encoding,
          metaJson: stored.metaJson ?? JSON.stringify(download.work.meta),
          fromCache: true,
        };
      }
    }
  }
  const fetchImpl = params.fetchImpl ?? ((url: string, init?: RequestInit) => fetch(url, init));
  const pendingStoreForPath = cache && generation === cacheGeneration ? beginWorkCopyStore(path) : null;
  let bytes: ArrayBuffer;
  try {
    bytes = await fetchWorkCopy(download.ref, sizeBytes, signal, fetchImpl);
  } catch (error) {
    if (pendingStoreForPath) finishWorkCopyStore(path, pendingStoreForPath, false);
    throw error;
  }
  const encoding = detectDevelopWorkCopyEncoding(bytes);
  if (!encoding) {
    if (pendingStoreForPath) finishWorkCopyStore(path, pendingStoreForPath, false);
    throw new DevelopWorkCopyError("unsupported_format");
  }
  const metaJson = JSON.stringify(download.work.meta);
  if (cache && pendingStoreForPath) {
    // 入れ終わり（古い版の掃除を含む）を待たずに開く（移行元設計。20MB 級の書き込みと全 key の読み直しで初回の表示を遅らせない）。
    // 入れる分はここで写し、前に読んだ分を入れ終えてから順に入れる。同じpathの次のloadは保存完了を待ってCacheから読む。
    const stored = { bytes: bytes.slice(0), encoding };
    const storedAt = (params.now ?? Date.now)();
    const store = pendingStore
      .then(async () => {
        // 待っている間に全部消したら入れない
        if (generation !== cacheGeneration) return false;
        await storeCached(cache, path, stored, metaJson, storedAt);
        await evictCached(cache, path, photoId);
        return true;
      })
      .catch(() => false);
    pendingStore = store.then(() => undefined);
    void store.then((didStore) => finishWorkCopyStore(path, pendingStoreForPath, didStore));
    // 入れられなくても（容量・プライベートブラウズなど）読んだ作業コピーは使う
  }
  return { photoId, baseVersion, bytes, encoding, metaJson, fromCache: false };
}

/** 読んだ作業コピーを入れ終えるのを待つ（テスト・入れた結果を確かめるとき。失敗しない）。 */
export function developWorkCacheSettled(): Promise<void> {
  return pendingStore;
}

/** 持っている作業コピーを全部消す（ログアウト・拠点の切り替え。待たせない・失敗しない）。 */
export function clearDevelopWorkCache(
  storage: DevelopWorkCacheStorage | null = defaultCacheStorage(),
): Promise<void> {
  cacheGeneration += 1;
  if (!storage) return Promise.resolve();
  try {
    return storage.delete(DEVELOP_WORK_CACHE_NAME).then(
      () => undefined,
      () => undefined,
    );
  } catch {
    return Promise.resolve();
  }
}
