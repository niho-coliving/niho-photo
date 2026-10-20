// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from "vitest";

import {
  BROWSER_PHOTO_MAX_JPEG_ORIGINAL_BYTES,
  BROWSER_PHOTO_MAX_SOURCE_BYTES,
  BrowserPhotoSourceError,
  browserCloudOriginalMaxBytes,
  decodeBrowserPhoto,
  fetchBrowserPhotoFile,
  inspectBrowserPhotoFile,
} from "./browser-photo-source";

function png(width: number, height: number): File {
  const bytes = new Uint8Array(24);
  bytes.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], 0);
  bytes.set([0x49, 0x48, 0x44, 0x52], 12);
  const view = new DataView(bytes.buffer);
  view.setUint32(16, width);
  view.setUint32(20, height);
  return new File([bytes], "photo.png", { type: "image/png" });
}

function jpeg(width: number, height: number): File {
  const bytes = new Uint8Array(23);
  bytes.set([0xff, 0xd8, 0xff, 0xc0, 0x00, 0x11, 0x08], 0);
  const view = new DataView(bytes.buffer);
  view.setUint16(7, height);
  view.setUint16(9, width);
  bytes.set([0xff, 0xd9], 21);
  return new File([bytes], "photo.jpg", { type: "image/jpeg" });
}

function webp(kind: "VP8X" | "VP8L" | "VP8 ", width: number, height: number): File {
  const payloadSize = kind === "VP8X" ? 10 : kind === "VP8L" ? 5 : 10;
  const bytes = new Uint8Array(20 + payloadSize);
  bytes.set(new TextEncoder().encode("RIFF"), 0);
  bytes.set(new TextEncoder().encode("WEBP"), 8);
  bytes.set(new TextEncoder().encode(kind), 12);
  const view = new DataView(bytes.buffer);
  view.setUint32(16, payloadSize, true);
  if (kind === "VP8X") {
    const widthMinusOne = width - 1;
    const heightMinusOne = height - 1;
    bytes.set([widthMinusOne & 0xff, (widthMinusOne >>> 8) & 0xff, (widthMinusOne >>> 16) & 0xff], 24);
    bytes.set([heightMinusOne & 0xff, (heightMinusOne >>> 8) & 0xff, (heightMinusOne >>> 16) & 0xff], 27);
  } else if (kind === "VP8L") {
    bytes[20] = 0x2f;
    view.setUint32(21, (width - 1) | ((height - 1) << 14), true);
  } else {
    bytes.set([0x9d, 0x01, 0x2a], 23);
    view.setUint16(26, width, true);
    view.setUint16(28, height, true);
  }
  return new File([bytes], "photo.webp", { type: "image/webp" });
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("browser photo source header inspection", () => {
  it.each([
    ["JPEG", () => jpeg(10_000, 5_000)],
    ["PNG", () => png(10_000, 5_000)],
    ["WebP", () => webp("VP8X", 10_000, 5_000)],
  ])("%s の過大画素をヘッダで止め、デコーダを呼ばない", async (_label, makeFile) => {
    const createImageBitmap = vi.fn();
    vi.stubGlobal("createImageBitmap", createImageBitmap);
    await expect(decodeBrowserPhoto(makeFile())).rejects.toEqual(new BrowserPhotoSourceError("too_large"));
    expect(createImageBitmap).not.toHaveBeenCalled();
  });

  it.each([
    ["VP8X", () => webp("VP8X", 640, 480)],
    ["VP8L", () => webp("VP8L", 640, 480)],
    ["VP8", () => webp("VP8 ", 640, 480)],
  ])("WebP %s の寸法を事前検査できる", async (_label, makeFile) => {
    await expect(inspectBrowserPhotoFile(makeFile())).resolves.toBeUndefined();
  });

  it("WebP の未知chunkと奇数paddingを飛ばして画像chunkを検査する", async () => {
    const image = new Uint8Array(await webp("VP8X", 640, 480).arrayBuffer());
    const bytes = new Uint8Array(image.length + 10);
    bytes.set(image.slice(0, 12), 0);
    bytes.set(new TextEncoder().encode("JUNK"), 12);
    new DataView(bytes.buffer).setUint32(16, 1, true);
    bytes[20] = 0xaa;
    bytes[21] = 0;
    bytes.set(image.slice(12), 22);
    await expect(inspectBrowserPhotoFile(new File([bytes], "chunked.webp", { type: "image/webp" }))).resolves.toBeUndefined();
  });

  it("WebP VP8 の0px寸法は有効なヘッダとみなさない", async () => {
    await expect(inspectBrowserPhotoFile(webp("VP8 ", 0, 480))).rejects.toEqual(
      new BrowserPhotoSourceError("decode_failed"),
    );
  });

  it("対応拡張子でも有効な寸法ヘッダが無ければ fail-closed にする", async () => {
    const createImageBitmap = vi.fn();
    vi.stubGlobal("createImageBitmap", createImageBitmap);
    const file = new File([new Uint8Array([1, 2, 3])], "broken.webp", { type: "image/webp" });
    await expect(decodeBrowserPhoto(file)).rejects.toEqual(new BrowserPhotoSourceError("decode_failed"));
    expect(createImageBitmap).not.toHaveBeenCalled();
  });

  it.each(["VP8L", "VP8 "] as const)("先頭1MiBより大きいWebP %s も寸法ヘッダで検査できる", async (kind) => {
    const bytes = new Uint8Array(2 * 1024 * 1024);
    bytes.set(new Uint8Array(await webp(kind, 640, 480).arrayBuffer()));
    const view = new DataView(bytes.buffer);
    view.setUint32(4, bytes.length - 8, true);
    view.setUint32(16, bytes.length - 20, true);
    await expect(inspectBrowserPhotoFile(new File([bytes], "large.webp", { type: "image/webp" }))).resolves.toBeUndefined();
  });

  it("デコーダがヘッダと異なる過大寸法を返しても bitmap を解放する", async () => {
    const close = vi.fn();
    vi.stubGlobal("createImageBitmap", vi.fn(async () => ({ width: 10_000, height: 5_000, close })));
    await expect(decodeBrowserPhoto(png(1, 1))).rejects.toEqual(new BrowserPhotoSourceError("too_large"));
    expect(close).toHaveBeenCalledOnce();
  });
});

describe("クラウドの JPEG のオリジナルを読む上限（K5-a #17153）", () => {
  it("JPEG は 64MiB、PNG / WebP / ほかは今までどおり 10MB", () => {
    expect(BROWSER_PHOTO_MAX_JPEG_ORIGINAL_BYTES).toBe(64 * 1024 * 1024);
    expect(browserCloudOriginalMaxBytes("jpg")).toBe(BROWSER_PHOTO_MAX_JPEG_ORIGINAL_BYTES);
    expect(browserCloudOriginalMaxBytes(" JPEG ")).toBe(BROWSER_PHOTO_MAX_JPEG_ORIGINAL_BYTES);
    expect(browserCloudOriginalMaxBytes("png")).toBe(BROWSER_PHOTO_MAX_SOURCE_BYTES);
    expect(browserCloudOriginalMaxBytes("webp")).toBe(BROWSER_PHOTO_MAX_SOURCE_BYTES);
  });

  it("上限を渡せば 10MB を超える JPEG もヘッダで確かめる（渡さなければ今までどおり too_large）。画素数の上限は変えない", async () => {
    const large = (width: number, height: number) =>
      new File([jpeg(width, height), new Uint8Array(12 * 1024 * 1024)], "large.jpg", { type: "image/jpeg" });
    await expect(inspectBrowserPhotoFile(large(6000, 4000))).rejects.toEqual(new BrowserPhotoSourceError("too_large"));
    await expect(
      inspectBrowserPhotoFile(large(6000, 4000), { maxBytes: BROWSER_PHOTO_MAX_JPEG_ORIGINAL_BYTES }),
    ).resolves.toBeUndefined();
    await expect(
      inspectBrowserPhotoFile(large(8064, 6048), { maxBytes: BROWSER_PHOTO_MAX_JPEG_ORIGINAL_BYTES }),
    ).rejects.toEqual(new BrowserPhotoSourceError("too_large"));
  });

  it("fetchBrowserPhotoFile は渡した上限まで読み、超えたら too_large", async () => {
    const chunk = new Uint8Array(8 * 1024 * 1024);
    const stream = (chunks: number) => {
      let left = chunks;
      return {
        getReader: () => ({
          read: vi.fn(async () => (left-- > 0 ? { done: false, value: chunk } : { done: true, value: undefined })),
          cancel: vi.fn(async () => undefined),
          releaseLock: vi.fn(),
        }),
      };
    };
    vi.stubGlobal("fetch", vi.fn(async () => ({ ok: true, headers: new Headers({ "content-type": "image/jpeg" }), body: stream(2) })));
    const file = await fetchBrowserPhotoFile("https://storage.test/a.jpg", "a.jpg", new AbortController().signal, {
      maxBytes: BROWSER_PHOTO_MAX_JPEG_ORIGINAL_BYTES,
    });
    expect(file.size).toBe(16 * 1024 * 1024);

    vi.stubGlobal("fetch", vi.fn(async () => ({
      ok: true,
      headers: new Headers({ "content-length": String(BROWSER_PHOTO_MAX_JPEG_ORIGINAL_BYTES + 1) }),
      body: stream(9),
    })));
    await expect(
      fetchBrowserPhotoFile("https://storage.test/a.jpg", "a.jpg", new AbortController().signal, {
        maxBytes: BROWSER_PHOTO_MAX_JPEG_ORIGINAL_BYTES,
      }),
    ).rejects.toEqual(new BrowserPhotoSourceError("too_large"));
  });
});

describe("fetchBrowserPhotoFile", () => {
  it("署名URLの content-length が10MBを超えたら body を読まない", async () => {
    const blob = vi.fn();
    vi.stubGlobal("fetch", vi.fn(async () => ({
      ok: true,
      headers: new Headers({ "content-length": String(BROWSER_PHOTO_MAX_SOURCE_BYTES + 1) }),
      blob,
    })));
    await expect(fetchBrowserPhotoFile("https://storage.test/a.jpg", "a.jpg", new AbortController().signal)).rejects.toEqual(
      new BrowserPhotoSourceError("too_large"),
    );
    expect(blob).not.toHaveBeenCalled();
  });

  it.each([undefined, "invalid"])("content-length=%s でも stream 上限で止めて reader を cancel する", async (length) => {
    const cancel = vi.fn(async () => undefined);
    const read = vi.fn(async () => ({ done: false, value: new Uint8Array(BROWSER_PHOTO_MAX_SOURCE_BYTES + 1) }));
    vi.stubGlobal("fetch", vi.fn(async () => ({
      ok: true,
      headers: new Headers(length === undefined ? {} : { "content-length": length }),
      body: { getReader: () => ({ read, cancel, releaseLock: vi.fn() }) },
    })));

    await expect(fetchBrowserPhotoFile("https://storage.test/a.jpg", "a.jpg", new AbortController().signal)).rejects.toEqual(
      new BrowserPhotoSourceError("too_large"),
    );
    expect(cancel).toHaveBeenCalledOnce();
  });

  it("stream の読み取り失敗を説明可能な fetch_failed にする", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => ({
      ok: true,
      headers: new Headers(),
      body: {
        getReader: () => ({
          read: vi.fn(async () => { throw new Error("stream failed"); }),
          cancel: vi.fn(),
          releaseLock: vi.fn(),
        }),
      },
    })));
    await expect(fetchBrowserPhotoFile("https://storage.test/a.jpg", "a.jpg", new AbortController().signal)).rejects.toEqual(
      new BrowserPhotoSourceError("fetch_failed"),
    );
  });
});
