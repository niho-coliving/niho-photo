import { describe, expect, it } from "vitest";

import { BrowserPhotoSourceError } from "niho-photo-editing/browser-photo-source";
import { developEngineManifestPath } from "niho-photo-editing/develop-engine/develop-engine-manifest";
import type { DevelopSettings } from "niho-photo-editing/develop-engine/develop-settings";
import type { PhotoLibraryWorkingCopyDownload } from "niho-photo-editing/library/photo-library";

import {
  CameraCommandError,
  createCameraCommands,
  type DevelopSource,
  type Invoke,
  type LibraryEntry,
  type LibraryFolder,
  type SavedDevelopSettings,
} from "./commands";
import { createLocalPhotoEditingHost } from "./local-photo-editing-host";
import {
  LOCAL_CLOSED_CAPABILITIES,
  createLocalPhotoLibrary,
  localThumbnailUrl,
  takeNativeSaveResult,
} from "./local-photo-library";

/**
 * この Mac の `PhotoLibrary`（契約の型への対応）を、偽の native（invoke）で確かめる。native の口の形は commands.test.ts。
 */

type Call = [command: string, request: Record<string, unknown> | undefined];

const PNG_HEADER = new Uint8Array([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52, 0, 0, 0x17, 0x70, 0, 0, 0x0f, 0xa0,
]);
/** SOI + SOF0（高さ 1500・幅 2000）+ SOS の最小の JPEG のヘッダ */
const JPEG_HEADER = new Uint8Array([
  0xff, 0xd8, 0xff, 0xc0, 0x00, 0x11, 0x08, 0x05, 0xdc, 0x07, 0xd0, 0x03, 1, 0x22, 0, 2, 0x11, 1, 3, 0x11, 1, 0xff, 0xda,
  0x00, 0x02,
]);

function entry(entryId: string, fileName: string, modifiedAt: string, extra: Partial<LibraryEntry> = {}): LibraryEntry {
  return { entryId, fileName, kind: /\.(jpe?g|png|heic|tiff?)$/i.test(fileName) ? "raster" : "raw", sizeBytes: 1000, modifiedAt, hasEdits: false, ...extra };
}

const RAW = entry("e-raw", "P1524180.RW2", "2026-10-03T00:00:00.000Z", { sizeBytes: 24_000_000 });
const JPEG = entry("e-jpg", "DSC02072.JPG", "2026-10-02T00:00:00.000Z", { hasEdits: true });
const HEIC = entry("e-heic", "DSC02150.heic", "2026-10-01T00:00:00.000Z");
const PNG = entry("e-png", "scan.png", "2026-09-30T00:00:00.000Z");

const ROOT: LibraryFolder = {
  folderId: "f-root",
  name: "写真",
  truncated: false,
  photos: [HEIC, JPEG],
  children: [{ folderId: "f-sub", name: "RAW", truncated: false, photos: [RAW, PNG], children: [] }],
};

/** 偽の native が返す現像の入力（token は偽の native が出す） */
type SourceWithoutToken = DevelopSource extends infer S ? (S extends DevelopSource ? Omit<S, "token"> : never) : never;

type FakeOptions = {
  status?: Array<{ available: boolean; raster: boolean; fullSizeRaster?: boolean }>;
  cutout?: boolean | CameraCommandError;
  /** entryId → open ごとに返す中身の SHA-256（写真の置き換えのテスト用） */
  hashes?: Record<string, string[]>;
  /** entryId → 現像の入力（kind と meta。token は偽の native が出す） */
  sources?: Record<string, SourceWithoutToken | CameraCommandError>;
  /** token のバイト列（entryId ごと） */
  bytes?: Record<string, Uint8Array>;
  saved?: Record<string, SavedDevelopSettings>;
  rememberedPhotos?: LibraryEntry[];
  addedPhotos?: LibraryEntry[];
  forgetPhotosError?: CameraCommandError;
};

function sha(entryId: string): string {
  return entryId.replace(/[^a-f0-9]/g, "a").padEnd(64, "0").slice(0, 64);
}

function fakeNative(options: FakeOptions = {}) {
  const calls: Call[] = [];
  const entries = new Map(
    [...ROOT.photos, ...ROOT.children.flatMap((child) => child.photos), ...(options.rememberedPhotos ?? []), ...(options.addedPhotos ?? [])]
      .map((photo) => [photo.entryId, photo]),
  );
  const open = new Map<string, string>();
  const tokens = new Map<string, { photoId: string; entryId: string }>();
  const saved = new Map(Object.entries(options.saved ?? {}));
  const hashes = new Map(Object.entries(options.hashes ?? {}).map(([key, values]) => [key, [...values]]));
  const statuses = [...(options.status ?? [{ available: true, raster: true, fullSizeRaster: true }])];
  let next = 0;
  const fail = (code: string, message: string, currentRevision?: number) => {
    throw { code, message, ...(currentRevision === undefined ? {} : { currentRevision }) };
  };
  const openEntry = (photoId: unknown) => {
    const entryId = open.get(String(photoId));
    if (!entryId) fail("notFound", "写真が見つかりません。写真を開き直してください。");
    return entryId as string;
  };
  const invoke: Invoke = async <T>(command: string, args?: Parameters<Invoke>[1]) => {
    const request = (args as { request?: Record<string, unknown> } | undefined)?.request;
    calls.push([command, request]);
    const answer = ((): unknown => {
      switch (command) {
        case "camera_cutout_status":
          if (options.cutout instanceof CameraCommandError) return fail(options.cutout.code, options.cutout.message);
          return { available: options.cutout ?? true };
        case "camera_develop_status":
          return statuses.length > 1 ? statuses.shift() : statuses[0];
        case "camera_library_remembered":
          return { folders: [ROOT], photos: options.rememberedPhotos ?? [] };
        case "camera_library_selected_photos":
          return { photos: options.rememberedPhotos ?? [] };
        case "camera_library_add_folder":
          return { folder: ROOT.children[0] };
        case "camera_library_add_photos":
          return { photos: options.addedPhotos ?? [] };
        case "camera_library_forget_folder":
          return {};
        case "camera_library_forget_photos":
          if (options.forgetPhotosError) return fail(options.forgetPhotosError.code, options.forgetPhotosError.message);
          return {};
        case "camera_library_list_folder":
          if (request?.folderId === "f-root") return { folder: ROOT };
          if (request?.folderId === "f-sub") return { folder: ROOT.children[0] };
          return fail("notFound", "フォルダが見つかりません。");
        case "camera_photo_open": {
          const photos = [];
          const failed = [];
          for (const entryId of request?.entryIds as string[]) {
            const listed = entries.get(entryId);
            if (!listed) {
              failed.push({ entryId, code: "notFound", message: "写真が見つかりません。" });
              continue;
            }
            next += 1;
            const photoId = `photo-${next}`;
            open.set(photoId, entryId);
            photos.push({
              photoId,
              entryId,
              fileName: listed.fileName,
              format: null,
              sizeBytes: listed.sizeBytes,
              contentSha256: hashes.get(entryId)?.shift() ?? sha(entryId),
              modifiedAt: listed.modifiedAt,
              nativeExport: true,
              saved: saved.get(entryId) ?? null,
            });
          }
          return { photos, failed };
        }
        case "camera_photo_close":
          return {};
        case "camera_photo_save_settings": {
          const entryId = openEntry(request?.photoId);
          const current = saved.get(entryId)?.revision ?? 0;
          if (request?.expectedRevision !== current) return fail("revisionConflict", "別の操作で補正が変わりました。", current);
          saved.set(entryId, {
            developSettings: request?.developSettings as Record<string, unknown>,
            revision: current + 1,
            updatedAtMs: 1_000,
          });
          return { revision: current + 1 };
        }
        case "camera_develop_source": {
          const photoId = String(request?.photoId);
          const entryId = openEntry(photoId);
          const source = options.sources?.[entryId];
          if (source instanceof CameraCommandError) return fail(source.code, source.message);
          if (!source) return fail("unsupportedSource", "対応していない形式です。");
          next += 1;
          const token = `token-${next}`;
          tokens.set(token, { photoId, entryId });
          return { ...source, token };
        }
        case "camera_develop_source_bytes": {
          const token = tokens.get(String(request?.token));
          if (!token || token.photoId !== request?.photoId || !open.has(token.photoId)) {
            return fail("notFound", "現像の準備をやり直してください。");
          }
          tokens.delete(String(request?.token));
          return (options.bytes?.[token.entryId] ?? new Uint8Array([1, 2, 3])).slice().buffer;
        }
        case "camera_export":
          openEntry(request?.photoId);
          return { saved: true, fileName: "P1524180.jpg" };
        case "camera_export_to_folder":
          openEntry(request?.photoId);
          return { fileName: "P1524180-2.jpg" };
        case "camera_choose_export_folder":
          return { exportFolder: { exportFolderId: "export-1", name: "書き出し" } };
        case "camera_export_original":
          openEntry(request?.photoId);
          return { saved: true, fileName: "P1524180 のコピー.RW2" };
        case "camera_presets_list":
          return { presets: [] };
        case "camera_presets_create":
          if (request?.name === "夕方") return fail("presetNameTaken", "同じ名前のプリセットがあります。");
          return { preset: { id: "p1", name: request?.name, xmp: request?.xmp, source: request?.source, createdAt: "x" } };
        case "camera_presets_rename":
          return { preset: { id: request?.id, name: request?.name, xmp: "", source: "xmp", createdAt: "x" } };
        case "camera_presets_delete":
          return {};
        default:
          return fail("internal", `unexpected ${command}`);
      }
    })();
    return answer as T;
  };
  const commands = createCameraCommands(invoke);
  const library = createLocalPhotoLibrary(commands, { now: () => new Date("2026-10-15T00:00:00.000Z"), sleep: async () => undefined });
  return { calls, commands, library, saved, open, tokens };
}

const commandsOf = (calls: Call[]) => calls.map(([command]) => command);
const signal = () => new AbortController().signal;

describe("capabilities", () => {
  it("starts closed and opens the native tools when the bundled sidecars are ready", async () => {
    const { library } = fakeNative();
    expect(library.place).toBe("local");
    expect(library.initialCapabilities).toEqual(LOCAL_CLOSED_CAPABILITIES);
    await expect(library.capabilities()).resolves.toEqual({
      ...LOCAL_CLOSED_CAPABILITIES,
      rawWorkingCopy: true,
      nativeExport: true,
      nativeExportRaster: true,
      exportFolder: true,
      cutout: true,
      multiSelect: true,
    });
    await expect(library.rollout()).resolves.toEqual({ crop: true, mobileEditing: false });
  });

  it("waits a little while the startup check runs and stays closed when the sidecars are unavailable", async () => {
    const checking = fakeNative({ status: [{ available: false, raster: false }, { available: true, raster: true }] });
    // HEIC / TIFF の原寸は、native が原寸の raster を持つと言ったときだけ
    await expect(checking.library.capabilities()).resolves.toMatchObject({ nativeExport: true, nativeExportRaster: false });
    const unavailable = fakeNative({ status: [{ available: false, raster: false }], cutout: false });
    await expect(unavailable.library.capabilities()).resolves.toMatchObject({
      rawWorkingCopy: false,
      nativeExport: false,
      nativeExportRaster: false,
      exportFolder: false,
      favorites: false,
      cutout: false,
    });
    expect(commandsOf(unavailable.calls).filter((command) => command === "camera_develop_status")).toHaveLength(3);
  });

  it("enables cutout only after its camera-only sidecar probe succeeds", async () => {
    await expect(fakeNative({ cutout: false }).library.capabilities()).resolves.toMatchObject({ cutout: false });
    await expect(
      fakeNative({ cutout: new CameraCommandError("engine_failed", "使えません") }).library.capabilities(),
    ).resolves.toMatchObject({ cutout: false });
    await expect(fakeNative({ cutout: true }).library.capabilities()).resolves.toMatchObject({ cutout: true });
  });

  it("serves the bundled wasm manifest from this page's origin", () => {
    const { library } = fakeNative();
    expect(library.engineAssets.manifestUrl()).toBe(new URL(developEngineManifestPath(), window.location.origin).href);
    expect(library.limits).toEqual({ listPageSize: 500, lookupMaxCount: 100, referencesMaxCount: 0, photosPerRequest: 50 });
  });
});

describe("folders and list", () => {
  it("maps the remembered folders to the tree without photos and adds / forgets folders", async () => {
    const { library, calls } = fakeNative();
    await expect(library.folders.tree()).resolves.toEqual([
      { folderId: "f-root", name: "写真", truncated: false, children: [{ folderId: "f-sub", name: "RAW", truncated: false, children: [] }] },
    ]);
    await expect(library.folders.add()).resolves.toEqual({ folderId: "f-sub", name: "RAW", truncated: false, children: [] });
    await library.folders.forget("f-root");
    expect(calls.at(-1)).toEqual(["camera_library_forget_folder", { folderId: "f-root" }]);
  });

  it("lists the folder and its subfolders newest first with local rows and thumbnail URLs", async () => {
    const { library } = fakeNative();
    const page = await library.list({ folderId: "f-root" });
    expect(page.items.map((item) => item.fileName)).toEqual(["P1524180.RW2", "DSC02072.JPG", "DSC02150.heic", "scan.png"]);
    expect(page.next).toBeNull();
    expect(page.usage).toBeNull();
    expect(page.counts).toEqual({ photos: 4, articleImages: 0, favorites: 0, matching: 4 });
    expect(page.items[1]).toEqual({
      id: "e-jpg",
      fileName: "DSC02072.JPG",
      fileExtension: "jpg",
      sizeBytes: 1000,
      contentSha256: null,
      createdAt: "2026-10-02T00:00:00.000Z",
      capturedAt: null,
      uploadedBy: null,
      hasOriginal: true,
      hasPreview: true,
      hasWebImage: false,
      hasDevelopSettings: true,
      hasEdits: true,
      developSettings: null,
      developSettingsUpdatedAt: null,
      developRevision: 0,
      webRenderedRevision: null,
      favorite: false,
      previewUrl: "niho-thumb://localhost/e-jpg?size=256",
    });
  });

  it("filters by kind and edited, and returns nothing for the cloud-only places", async () => {
    const { library, calls } = fakeNative();
    const names = async (query: Parameters<typeof library.list>[0]) =>
      (await library.list(query)).items.map((item) => item.fileName);
    await expect(names({ folderId: "f-root", kind: "raw" })).resolves.toEqual(["P1524180.RW2"]);
    await expect(names({ folderId: "f-root", kind: "jpeg" })).resolves.toEqual(["DSC02072.JPG"]);
    await expect(names({ folderId: "f-root", kind: "heic" })).resolves.toEqual(["DSC02150.heic"]);
    await expect(names({ folderId: "f-root", edited: true })).resolves.toEqual(["DSC02072.JPG"]);
    await expect(names({ folderId: "f-root", edited: false, sort: "captured" })).resolves.toEqual([
      "P1524180.RW2",
      "DSC02150.heic",
      "scan.png",
    ]);
    const before = calls.length;
    await expect(names({ folderId: "f-root", hasOriginal: false })).resolves.toEqual([]);
    await expect(names({ folderId: "f-root", favorite: true })).resolves.toEqual([]);
    await expect(names({ folderId: "f-root", albumId: "a1" })).resolves.toEqual([]);
    await expect(library.list({})).resolves.toEqual({ items: [], next: null, usage: null, counts: null });
    expect(calls.length).toBe(before);
    const filtered = await library.list({ folderId: "f-root", kind: "raw" });
    expect(filtered.counts).toEqual({ photos: 4, articleImages: 0, favorites: 0, matching: 1 });
  });

  it("pages with the limit and a numeric cursor, and counts only on the first page", async () => {
    const { library } = fakeNative();
    const first = await library.list({ folderId: "f-root", limit: 3 });
    expect(first.items.map((item) => item.id)).toEqual(["e-raw", "e-jpg", "e-heic"]);
    expect(first.next).toBe("3");
    const second = await library.list({ folderId: "f-root", limit: 3, cursor: first.next });
    expect(second.items.map((item) => item.id)).toEqual(["e-png"]);
    expect(second.next).toBeNull();
    expect(second.counts).toBeNull();
  });

  it("fails the list with the native message when the folder is gone", async () => {
    const { library } = fakeNative();
    await expect(library.list({ folderId: "f-gone" })).rejects.toMatchObject({ code: "notFound" });
    expect(localThumbnailUrl("entry 1/2", 128)).toBe("niho-thumb://localhost/entry%201%2F2?size=128");
  });

  it("lists selected photos in picker order even with an inherited captured sort and rejects an ambiguous source", async () => {
    const first = entry("picked-first", "first.jpg", "2026-01-01T00:00:00.000Z");
    const second = entry("picked-second", "second.jpg", "2026-10-01T00:00:00.000Z");
    const { library, calls } = fakeNative({ rememberedPhotos: [first, second] });

    await expect(library.list({ localSource: "selected", sort: "captured" })).resolves.toMatchObject({
      items: [{ id: "picked-first" }, { id: "picked-second" }],
      counts: { photos: 2, matching: 2 },
    });
    const before = calls.length;
    await expect(library.list({ folderId: "f-root", localSource: "selected" })).rejects.toMatchObject({
      code: "invalidRequest",
    });
    expect(calls).toHaveLength(before);
  });

  it("adds, counts and forgets selected-photo references, while cancel leaves an empty result", async () => {
    const picked = entry("picked", "picked.jpg", "2026-10-01T00:00:00.000Z");
    const selected = fakeNative({ rememberedPhotos: [picked], addedPhotos: [picked] });
    await expect(selected.library.selectedPhotos.count()).resolves.toBe(1);
    await expect(selected.library.selectedPhotos.add()).resolves.toMatchObject([{ id: "picked", fileName: "picked.jpg" }]);
    await selected.library.selectedPhotos.forget();
    expect(commandsOf(selected.calls).slice(-3)).toEqual([
      "camera_library_selected_photos",
      "camera_library_add_photos",
      "camera_library_forget_photos",
    ]);

    await expect(fakeNative({ addedPhotos: [] }).library.selectedPhotos.add()).resolves.toEqual([]);
    const failure = fakeNative({
      rememberedPhotos: [picked],
      forgetPhotosError: new CameraCommandError("io", "一覧から外せませんでした。"),
    });
    await expect(failure.library.selectedPhotos.forget()).rejects.toMatchObject({ code: "io" });
    await expect(failure.library.selectedPhotos.count()).resolves.toBe(1);
  });
});

describe("open, save and stale", () => {
  it("opens with the saved settings and content SHA-256, saves the next revision and fills the list row", async () => {
    const savedSettings = { engine: "niho-4", v: 3, exposure: 0.3 };
    const { library, calls } = fakeNative({
      saved: { "e-jpg": { developSettings: savedSettings, revision: 2, updatedAtMs: Date.UTC(2026, 9, 1) } },
    });
    const opened = await library.openOriginal("e-jpg");
    expect(opened.source).toEqual({ ref: "photo-1", expiresAt: null });
    expect(opened.photo).toMatchObject({
      id: "e-jpg",
      contentSha256: sha("e-jpg"),
      developSettings: savedSettings,
      developRevision: 2,
      developSettingsUpdatedAt: "2026-10-01T00:00:00.000Z",
      hasDevelopSettings: true,
      hasEdits: true,
      createdAt: "2026-10-02T00:00:00.000Z",
    });

    const next = { engine: "niho-4", v: 3, exposure: 0.5 } as unknown as DevelopSettings;
    const result = await library.saveDevelopSettings("e-jpg", next, { expectedRevision: 2 });
    expect(result).toMatchObject({ kind: "saved", photo: { id: "e-jpg", developRevision: 3, developSettings: next } });
    expect(calls.at(-1)).toEqual([
      "camera_photo_save_settings",
      { photoId: "photo-1", developSettings: next, expectedRevision: 2 },
    ]);

    const listed = (await library.list({ folderId: "f-root" })).items.find((item) => item.id === "e-jpg");
    expect(listed).toMatchObject({ contentSha256: sha("e-jpg"), developRevision: 3, developSettings: next });
    await expect(library.lookup([sha("e-jpg"), sha("e-raw")])).resolves.toEqual([
      { contentSha256: sha("e-jpg"), photo: expect.objectContaining({ id: "e-jpg", developRevision: 3 }) },
    ]);
  });

  it("returns stale with the current row when another save moved the revision", async () => {
    const fake = fakeNative();
    await fake.library.openOriginal("e-raw");
    // ほかの操作が先に保存した
    fake.saved.set("e-raw", { developSettings: { exposure: 1 }, revision: 4, updatedAtMs: 0 });
    const result = await fake.library.saveDevelopSettings("e-raw", { exposure: 0.2 } as unknown as DevelopSettings, {
      expectedRevision: 0,
    });
    expect(result).toMatchObject({ kind: "stale", photo: { id: "e-raw", developRevision: 4, developSettings: { exposure: 1 } } });
    expect(commandsOf(fake.calls).slice(-2)).toEqual(["camera_photo_save_settings", "camera_photo_open"]);
  });

  it("reopens once when native has let the photo go, and get() returns null for an unknown photo", async () => {
    const fake = fakeNative();
    await fake.library.openOriginal("e-raw");
    fake.open.clear();
    const result = await fake.library.saveDevelopSettings("e-raw", { exposure: 0.2 } as unknown as DevelopSettings);
    expect(result.kind).toBe("saved");
    expect(commandsOf(fake.calls).slice(-3)).toEqual([
      "camera_photo_save_settings",
      "camera_photo_open",
      "camera_photo_save_settings",
    ]);
    await expect(fake.library.get("e-missing")).resolves.toBeNull();
    await expect(fake.library.get("e-heic")).resolves.toMatchObject({ id: "e-heic", contentSha256: sha("e-heic") });
  });

  it("resolves a cutout photo key to a stable native photoId and retries only the released handle", async () => {
    const fake = fakeNative();
    await fake.library.openOriginal("e-jpg");
    const seen: string[] = [];
    await expect(
      fake.library.withStablePhoto("e-jpg", async (photoId) => {
        seen.push(photoId);
        if (photoId === "photo-1") throw new CameraCommandError("notFound", "開き直してください。");
        return "done";
      }),
    ).resolves.toBe("done");
    expect(seen).toEqual(["photo-1", "photo-2"]);
    expect(commandsOf(fake.calls).slice(-1)).toEqual(["camera_photo_open"]);
  });

  it("does not cache a replacement photo after rejecting a stale cutout operation", async () => {
    const first = "a".repeat(64);
    const second = "b".repeat(64);
    const fake = fakeNative({ hashes: { "e-jpg": [first, second, second] } });
    await fake.library.openOriginal("e-jpg");
    const seen: string[] = [];
    const released = new CameraCommandError("notFound", "開き直してください。");
    for (let attempt = 0; attempt < 2; attempt += 1) {
      await expect(
        fake.library.withStablePhoto("e-jpg", async (photoId) => {
          seen.push(photoId);
          throw released;
        }),
      ).rejects.toBe(released);
    }
    expect(seen).toEqual(["photo-1", "photo-1"]);
    expect(commandsOf(fake.calls).filter((command) => command === "camera_photo_open")).toHaveLength(3);
  });

  it("reads a JPEG original as a File and maps native failures to the browser source errors", async () => {
    const bytes = new Uint8Array([0xff, 0xd8, 0xff, 0xe0]);
    const fake = fakeNative({
      sources: { "e-jpg": { kind: "raster", byteLength: 4 }, "e-png": new CameraCommandError("decodeFailed", "読めません。") },
      bytes: { "e-jpg": bytes },
    });
    const { source } = await fake.library.openOriginal("e-jpg");
    const file = await fake.library.loadOriginal("e-jpg", source, { signal: signal(), fileName: "DSC02072.JPG", maxBytes: 64 });
    expect(file.name).toBe("DSC02072.JPG");
    expect(file.type).toBe("image/jpeg");
    expect(new Uint8Array(await file.arrayBuffer())).toEqual(bytes);
    await expect(
      fake.library.loadOriginal("e-jpg", source, { signal: signal(), fileName: "DSC02072.JPG", maxBytes: 2 }),
    ).rejects.toEqual(new BrowserPhotoSourceError("too_large"));
    await expect(
      fake.library.loadOriginal("e-png", source, { signal: signal(), fileName: "scan.png", maxBytes: 64 }),
    ).rejects.toEqual(new BrowserPhotoSourceError("fetch_failed"));
  });
});

describe("working copies", () => {
  const rawMeta = { encoding: "png16", _source: { outputSize: { width: 6000, height: 4000 } } };

  it("forwards a draft base and lets the opened saved record override caller state", async () => {
    const base = "raw-apple.d8.p2.e1.cal-panasonic-dc-s5-apple-v2.lens-apple";
    const draft = fakeNative({
      sources: { "e-raw": { kind: "workingCopy", byteLength: 24, baseVersion: base, meta: rawMeta } },
    });
    await draft.library.ensureWorkingCopy("e-raw", {
      sourceContext: { hasSavedDevelopSettings: false, hasDevelopEdits: true, baseVersion: base },
    });
    expect(draft.calls.find(([command]) => command === "camera_develop_source")?.[1]).toEqual({
      photoId: "photo-1",
      sourceContext: { hasSavedDevelopSettings: false, hasDevelopEdits: true, baseVersion: base },
    });

    const savedBase = "raw-apple.d8.p3.e4.cal-panasonic-dc-s5-apple-v4.lens-apple";
    const savedSettings = { v: 1, engine: "niho-4", look: "niho-standard-3", base: savedBase };
    const saved = fakeNative({
      saved: { "e-raw": { developSettings: savedSettings, revision: 2, updatedAtMs: 1 } },
      sources: { "e-raw": { kind: "workingCopy", byteLength: 24, baseVersion: savedBase, meta: rawMeta } },
    });
    await saved.library.ensureWorkingCopy("e-raw", {
      sourceContext: { hasSavedDevelopSettings: false, hasDevelopEdits: false, baseVersion: null },
    });
    expect(saved.calls.find(([command]) => command === "camera_develop_source")?.[1]).toEqual({
      photoId: "photo-1",
      sourceContext: { hasSavedDevelopSettings: true, hasDevelopEdits: false, baseVersion: savedBase },
    });
  });

  it("prepares a RAW working copy with its size and reads it once by the token", async () => {
    const fake = fakeNative({
      sources: { "e-raw": { kind: "workingCopy", byteLength: 24, baseVersion: "raw-apple.d8", meta: rawMeta } },
      bytes: { "e-raw": PNG_HEADER },
    });
    const result = await fake.library.ensureWorkingCopy("e-raw");
    expect(result).toEqual({
      kind: "ready",
      download: {
        ref: "token-2",
        expiresAt: "9999-12-31T23:59:59.000Z",
        work: {
          baseVersion: "raw-apple.d8",
          sizeBytes: 24,
          width: 6000,
          height: 4000,
          meta: rawMeta,
          renderedAt: "2026-10-15T00:00:00.000Z",
        },
      },
    });
    expect(fake.calls.find(([command]) => command === "camera_develop_source")?.[1]).toEqual({
      photoId: "photo-1",
      sourceContext: { hasSavedDevelopSettings: false, hasDevelopEdits: false, baseVersion: null },
    });
    const download = (result as { download: PhotoLibraryWorkingCopyDownload }).download;
    const copy = await fake.library.loadWorkingCopy("e-raw", download, { signal: signal() });
    expect(copy).toMatchObject({ photoId: "e-raw", baseVersion: "raw-apple.d8", encoding: "png16", metaJson: JSON.stringify(rawMeta) });
    expect(new Uint8Array(copy.bytes)).toEqual(PNG_HEADER);

    // 使い終えた token は、現像の入力を求め直してから読む
    const again = await fake.library.loadWorkingCopy("e-raw", download, { signal: signal() });
    expect(new Uint8Array(again.bytes)).toEqual(PNG_HEADER);
    expect(commandsOf(fake.calls).slice(-4)).toEqual([
      "camera_develop_source_bytes",
      "camera_photo_open",
      "camera_develop_source",
      "camera_develop_source_bytes",
    ]);
  });

  it("reads a raster working copy's size from its JPEG and forces a working copy for JPEG / PNG", async () => {
    const meta = { kind: "raster", encoding: "jpeg8" };
    const fake = fakeNative({
      sources: {
        "e-heic": { kind: "workingCopy", byteLength: JPEG_HEADER.length, baseVersion: "raster.ci2", meta },
        "e-jpg": { kind: "workingCopy", byteLength: JPEG_HEADER.length, baseVersion: "raster.ci2", meta },
      },
      bytes: { "e-heic": JPEG_HEADER, "e-jpg": JPEG_HEADER },
    });
    const heic = await fake.library.ensureWorkingCopy("e-heic");
    expect(heic).toMatchObject({ kind: "ready", download: { work: { width: 2000, height: 1500 } } });
    const before = fake.calls.length;
    const copy = await fake.library.loadWorkingCopy("e-heic", (heic as { download: PhotoLibraryWorkingCopyDownload }).download, {
      signal: signal(),
    });
    expect(copy.encoding).toBe("jpeg8");
    expect(new Uint8Array(copy.bytes)).toEqual(JPEG_HEADER);
    expect(fake.calls.length).toBe(before);

    await fake.library.ensureWorkingCopy("e-jpg");
    const sourceCalls = fake.calls.filter(([command]) => command === "camera_develop_source").map(([, request]) => request);
    expect(sourceCalls).toEqual([
      {
        photoId: "photo-1",
        sourceContext: { hasSavedDevelopSettings: false, hasDevelopEdits: false, baseVersion: null },
      },
      {
        photoId: "photo-3",
        forceWorkingCopy: true,
        sourceContext: { hasSavedDevelopSettings: false, hasDevelopEdits: false, baseVersion: null },
      },
    ]);
  });

  it("maps native develop failures to the working copy states", async () => {
    const fake = fakeNative({
      sources: {
        "e-raw": new CameraCommandError("engineUnavailable", "この NIHO photo では現像を使えません。"),
        "e-heic": new CameraCommandError("unsupportedCamera", "この RAW は macOS の RAW 現像に対応していません。"),
        "e-jpg": new CameraCommandError("internal", "現像で予期しないエラーが起きました。"),
        "e-png": { kind: "raster", byteLength: 3 },
      },
    });
    await expect(fake.library.ensureWorkingCopy("e-raw")).resolves.toEqual({
      kind: "baseUnavailable",
      message: "この NIHO photo では現像を使えません。",
    });
    await expect(fake.library.ensureWorkingCopy("e-heic")).resolves.toEqual({
      kind: "incompatible",
      message: "この RAW は macOS の RAW 現像に対応していません。",
    });
    await expect(fake.library.ensureWorkingCopy("e-jpg")).resolves.toEqual({
      kind: "notReady",
      workStatus: "failed",
      workQueuedAt: null,
      lastErrorCode: "internal",
    });
    await expect(fake.library.ensureWorkingCopy("e-png")).resolves.toEqual({ kind: "notApplicable" });
    await expect(fake.library.retryWorkingCopy("e-jpg")).resolves.toEqual({ kind: "notApplicable" });
  });

  it("keeps native capability guidance through the real working-copy adapter", async () => {
    const failures = [
      ["e-raw", "formatMismatch", "写真の拡張子と中身の形式が一致しません。正しい写真を選び直してください。"],
      ["e-heic", "downloadRequired", "写真がこのMacにありません。Finderでダウンロードしてから、もう一度開いてください。"],
      ["e-jpg", "unsupportedFormat", "この写真形式には対応していません。対応形式の写真を選んでください。"],
    ] as const;
    const fake = fakeNative({
      sources: Object.fromEntries(failures.map(([entryId, code, message]) => [entryId, new CameraCommandError(code, message)])),
    });

    for (const [entryId, , message] of failures) {
      await expect(fake.library.ensureWorkingCopy(entryId)).resolves.toEqual({ kind: "incompatible", message });
    }
  });
});

describe("export, presets and errors", () => {
  const settings = { engine: "niho-4", v: 3, exposure: 0.4 } as unknown as DevelopSettings;
  const request = {
    photoId: "e-raw",
    developSettings: settings,
    hasSavedDevelopSettings: true,
    hasDevelopEdits: true,
    suggestedFileName: "P1524180.jpg",
  };

  it("exports through the save dialog without a folder and into the chosen folder with one", async () => {
    const fake = fakeNative();
    await expect(fake.library.exportNative(request)).resolves.toEqual({ saved: true, fileName: "P1524180.jpg" });
    await expect(fake.library.chooseExportFolder()).resolves.toBe("export-1");
    await expect(fake.library.exportNative({ ...request, folderId: "export-1" })).resolves.toEqual({
      saved: true,
      fileName: "P1524180-2.jpg",
    });
    const exports = fake.calls.filter(([command]) => command.startsWith("camera_export"));
    expect(exports).toEqual([
      [
        "camera_export",
        {
          photoId: "photo-1",
          developSettings: settings,
          hasSavedDevelopSettings: true,
          hasDevelopEdits: true,
          suggestedFileName: "P1524180.jpg",
        },
      ],
      [
        "camera_export_to_folder",
        {
          exportFolderId: "export-1",
          photoId: "photo-1",
          developSettings: settings,
          hasSavedDevelopSettings: true,
          hasDevelopEdits: true,
          suggestedFileName: "P1524180.jpg",
        },
      ],
    ]);
  });

  it("copies the original natively and the host reports it saved without a second dialog", async () => {
    const fake = fakeNative();
    const host = createLocalPhotoEditingHost(fake.commands);
    const original = await fake.library.downloadOriginal({ id: "e-raw", fileName: "P1524180.RW2", sizeBytes: 1, hasOriginal: true });
    expect(original.fileName).toBe("P1524180 のコピー.RW2");
    expect(fake.calls.at(-1)).toEqual(["camera_export_original", { photoId: "photo-1", suggestedFileName: "P1524180.RW2" }]);
    const before = fake.calls.length;
    await expect(host.saveFile(original)).resolves.toBe("saved");
    expect(fake.calls.length).toBe(before);
    expect(takeNativeSaveResult(original.blob)).toBeNull();
    expect(host.isDesktopApp()).toBe(true);
    expect(host.nativeFileSaveAvailable()).toBe(false);
    expect(host.isNativeViewport()).toBe(false);
  });

  it("never deletes photos on this Mac", async () => {
    const fake = fakeNative();
    await expect(fake.library.delete(["e-raw"])).resolves.toEqual({ deleted: [], errors: [] });
    expect(fake.calls).toEqual([]);
  });

  it("keeps presets on this Mac and tells a taken name apart", async () => {
    const fake = fakeNative();
    await expect(fake.library.presets.create({ name: "朝", xmp: "<x/>" })).resolves.toMatchObject({ source: "xmp" });
    await fake.library.presets.create({ name: "今の補正", xmp: "<x/>", source: "user" });
    const taken = await fake.library.presets.create({ name: "夕方", xmp: "<x/>" }).catch((error: unknown) => error);
    expect(fake.library.presets.isNameTaken(taken)).toBe(true);
    expect(fake.library.presets.describeError(taken, "fallback")).toBe("同じ名前のプリセットがあります。");
    expect(fake.library.presets.describeError(new Error("x"), "fallback")).toBe("fallback");
    await fake.library.presets.rename("p1", "夜");
    await fake.library.presets.delete("p1");
    expect(fake.calls.map(([command, request]) => [command, request?.source])).toEqual([
      ["camera_presets_create", "xmp"],
      ["camera_presets_create", "user"],
      ["camera_presets_create", "xmp"],
      ["camera_presets_rename", undefined],
      ["camera_presets_delete", undefined],
    ]);
    expect(fake.library.presets.nameMaxChars).toBe(100);
    expect(fake.library.presets.xmpMaxBytes).toBe(512 * 1024);
  });

  it("reads native failures for the editor's messages", () => {
    const { library } = fakeNative();
    const notFound = new CameraCommandError("notFound", "写真が見つかりません。");
    const folderGone = new CameraCommandError("folderNotFound", "書き出し先のフォルダが見つかりません。");
    expect(library.errors.describe(notFound, "fallback")).toBe("写真が見つかりません。");
    expect(library.errors.describe(new Error("raw"), "fallback")).toBe("fallback");
    expect(library.errors.isNativeError(folderGone)).toBe(true);
    expect(library.errors.isNativeError(new Error("x"))).toBe(false);
    expect(library.errors.describeNative(new Error("x"))).toBe("うまくいきませんでした。もう一度お試しください。");
    expect(library.errors.isNotFound(notFound)).toBe(true);
    expect(library.errors.isPermanentSaveFailure(notFound)).toBe(true);
    expect(library.errors.isPermanentSaveFailure(new CameraCommandError("invalidRequest", "x"))).toBe(true);
    expect(library.errors.isPermanentSaveFailure(new CameraCommandError("internal", "x"))).toBe(false);
    expect(library.errors.isExportFolderNotFound(folderGone)).toBe(true);
    expect(library.errors.readDevelopRevisionStale(new CameraCommandError("revisionConflict", "x"))).toBeNull();
    expect(library.errors.readQuotaExceeded(notFound)).toBeNull();
    expect(library.errors.describeStorageError(new Error("x"), "fallback")).toBeNull();
  });
});
