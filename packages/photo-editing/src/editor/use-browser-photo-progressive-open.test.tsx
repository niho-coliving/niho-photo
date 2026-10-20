// @vitest-environment jsdom

import { QueryClient } from "@tanstack/react-query";
import { act, useRef, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { DevelopEngine, DevelopFrame } from "../develop-engine/develop-engine-client";
import { neutralDevelopSettings, type DevelopSettings } from "../develop-engine/develop-settings";
import type { BrowserCloudPlace } from "../browser-photo-cloud-source";
import type {
  PhotoLibrary,
  PhotoLibraryCapabilities,
  PhotoLibraryPhoto,
  PhotoLibraryProvisionalDraft,
  PhotoLibraryWorkingCopyResult,
} from "../library/photo-library";
import {
  PhotoLibraryProvider,
  type PhotoEditingHost,
} from "../library/photo-library-context";

import type {
  BrowserItem,
  BrowserPhotoAccess,
  BrowserPhotoOperationKind,
  BrowserViewMode,
} from "./browser-photo-editing-model";
import { useBrowserPhotoDevelop } from "./use-browser-photo-develop";
import { useBrowserPhotoOpen, type BrowserPhotoOpen } from "./use-browser-photo-open";

const engineFactory = vi.hoisted(() => vi.fn());
const paintFrame = vi.hoisted(() => vi.fn());

vi.mock("../develop-engine/develop-engine-client", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../develop-engine/develop-engine-client")>();
  return { ...actual, createDevelopEngine: engineFactory, photoDevelopDiagnosticsEnabled: () => false };
});

vi.mock("../develop-engine/develop-frame", () => ({ paintDevelopFrame: paintFrame }));

type Deferred<T> = {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (reason?: unknown) => void;
};

function deferred<T>(): Deferred<T> {
  let resolve: (value: T) => void = () => undefined;
  let reject: (reason?: unknown) => void = () => undefined;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}

function frame(marker: number): DevelopFrame {
  return { width: 1, height: 1, rgba: new Uint8ClampedArray([marker, 0, 0, 255]) };
}

const CAPABILITIES: PhotoLibraryCapabilities = {
  place: "local",
  rawWorkingCopy: true,
  nativeExport: true,
  nativeExportUpdateRequired: false,
  exportFolder: false,
  nativeExportRaster: true,
  cutout: false,
  favorites: false,
  albums: false,
  articleImages: false,
  multiSelect: false,
  mobile: false,
  editedPreview: false,
  addFiles: false,
  addFromDevice: false,
  addFromDeviceFolder: false,
};

const BASE_VERSION = "raw-apple.d8.p3.e4.cal-sony-ilme-fx30-apple-v4.lens-apple";
const WORK_META = {
  kind: "raw",
  encoding: { kind: "signed-gamma18-v1", ceiling: 2 },
  dcpSha256: "apple-ciraw8/linear-prophoto-d50/cal-sony-ilme-fx30-apple-v4",
};
const HASH = "a".repeat(64);

function photo(id: string): PhotoLibraryPhoto {
  return {
    id,
    fileName: `${id}.rw2`,
    fileExtension: "rw2",
    sizeBytes: 24_000_000,
    contentSha256: HASH,
    createdAt: "2026-10-20T00:00:00.000Z",
    capturedAt: "2026-10-19T00:00:00.000Z",
    uploadedBy: null,
    hasOriginal: true,
    hasPreview: true,
    hasWebImage: false,
    hasDevelopSettings: false,
    developSettings: null,
    developSettingsUpdatedAt: null,
    developRevision: 0,
    webRenderedRevision: null,
    workStatus: "ready",
    workQueuedAt: null,
    favorite: false,
    hasEdits: false,
    editedPreview: null,
  };
}

function item(id: string): BrowserItem {
  return {
    key: `cloud:${id}`,
    photo: { ...photo(id), previewUrl: `https://example.invalid/${id}.jpg` },
    localPreviewUrl: null,
    adding: false,
  };
}

function readyWork(): PhotoLibraryWorkingCopyResult {
  return {
    kind: "ready",
    download: {
      ref: "work-ref",
      expiresAt: "2026-10-21T00:00:00.000Z",
      work: {
        baseVersion: BASE_VERSION,
        sizeBytes: 2_000,
        width: 3000,
        height: 2000,
        meta: WORK_META,
        renderedAt: "2026-10-20T00:00:00.000Z",
      },
    },
  };
}

type EngineOptions = {
  marker: number;
  ready?: boolean;
  render?: (settings: DevelopSettings, call: number) => Promise<DevelopFrame | null>;
};

function createEngine(options: EngineOptions): DevelopEngine {
  let renderCall = 0;
  const render = vi.fn((settings: DevelopSettings) => {
    renderCall += 1;
    return options.render?.(settings, renderCall) ?? Promise.resolve(frame(options.marker));
  });
  return {
    ready: vi.fn(async () => options.ready ?? true),
    open: vi.fn(async () => ({ width: 1600, height: 1067 })),
    render,
    exportJpeg: vi.fn(async () => new Uint8Array([1, 2, 3])),
    openWorkingCopy: vi.fn(async () => ({ width: 3000, height: 2000 })),
    exportWorkingCopyJpeg: vi.fn(async () => new Uint8Array([1, 2, 3])),
    convertEditSettings: vi.fn(async () => ({ ok: false, error: "unsupported" })),
    presetSettings: vi.fn(async (_xmp: string, base: object | null) => ({
      converted: true,
      name: "明るい",
      unsupported: [],
      settings: { ...(base ?? neutralDevelopSettings()), contrast: 40 },
    })),
    builtinPresets: vi.fn(async () => []),
    applyPreset: vi.fn(async (_xmp: string, base: object, amount: number) => ({
      converted: true,
      name: "明るい",
      unsupported: [],
      settings: { ...(base as DevelopSettings), contrast: Math.round(amount * 100) },
    })),
    settingsToXmp: vi.fn(async () => ({ name: "test", xmp: "<xmp />" })),
    renderPresetThumbnail: vi.fn(async () => frame(options.marker)),
    supportsPresetAmount: vi.fn(async () => true),
    supportsSettingsToXmp: vi.fn(async () => true),
    supportsPresetThumbnails: vi.fn(async () => true),
    supportsPresetFromMeta: vi.fn(async () => true),
    autoSettings: vi.fn(async (settings: object) => settings as DevelopSettings),
    supportsAuto: vi.fn(async () => true),
    supportsGeometry: vi.fn(async () => true),
    supportsEffects: vi.fn(async () => true),
    imageSize: vi.fn(async () => ({ width: 3000, height: 2000 })),
    rasterDecodeSize: vi.fn(async () => 1280),
    geometryOutputSize: vi.fn(async () => ({ width: 1280, height: 853 })),
    withCaptureExif: vi.fn(async (bytes: Uint8Array<ArrayBuffer>) => bytes),
    close: vi.fn(async () => undefined),
    dispose: vi.fn(),
  } as unknown as DevelopEngine;
}

type LibraryFixture = {
  library: PhotoLibrary;
  ensureWorkingCopy: ReturnType<typeof vi.fn>;
  saveDevelopSettings: ReturnType<typeof vi.fn>;
  saveProvisionalDraft: ReturnType<typeof vi.fn>;
  signals: AbortSignal[];
};

function createLibrary(
  ensure: (photoId: string, signal: AbortSignal | undefined) => Promise<PhotoLibraryWorkingCopyResult>,
  options: { draftGateAt?: number; draftGate?: Deferred<PhotoLibraryProvisionalDraft> } = {},
): LibraryFixture {
  let draftGeneration = 0;
  const signals: AbortSignal[] = [];
  const ensureWorkingCopy = vi.fn((photoId: string, options?: { signal?: AbortSignal }) => {
    if (options?.signal) signals.push(options.signal);
    return ensure(photoId, options?.signal);
  });
  const saveDevelopSettings = vi.fn(async (photoId: string, settings: DevelopSettings) => ({
    kind: "saved" as const,
    photo: { ...photo(photoId), hasDevelopSettings: true, developSettings: settings, developRevision: 1 },
  }));
  const saveProvisionalDraft = vi.fn(async (_photoId: string, contentSha256: string, settings: DevelopSettings) => {
    const draft = {
      contentSha256,
      settings,
      generation: ++draftGeneration,
      updatedAt: "2026-10-20T00:00:00.000Z",
    };
    if (draft.generation === options.draftGateAt && options.draftGate) return options.draftGate.promise;
    return draft;
  });
  const library = {
    place: "local",
    initialCapabilities: CAPABILITIES,
    capabilities: vi.fn(async () => CAPABILITIES),
    rollout: vi.fn(async () => ({ crop: true, mobileEditing: true })),
    engineAssets: { manifestUrl: () => "/engine/manifest.json" },
    limits: { listPageSize: 100, lookupMaxCount: 100, referencesMaxCount: 100, photosPerRequest: 100 },
    errors: {
      describe: (_error: unknown, fallback: string) => fallback,
      describeStorageError: () => null,
      describeDeleteFailure: () => "delete failed",
      isNativeError: () => false,
      describeNative: () => "native failed",
      isPermanentSaveFailure: () => false,
      isNotFound: () => false,
      readQuotaExceeded: () => null,
      describeQuotaExceeded: () => "quota",
      readDevelopRevisionStale: () => null,
      isExportFolderNotFound: () => false,
    },
    list: vi.fn(async () => ({ items: [], next: null, usage: null, counts: null })),
    get: vi.fn(async (photoId: string) => ({ ...photo(photoId), previewUrl: null })),
    lookup: vi.fn(async () => []),
    openOriginal: vi.fn(async (photoId: string) => ({
      source: { ref: "original-ref", expiresAt: null },
      photo: photo(photoId),
    })),
    loadOriginal: vi.fn(async () => new File([new Uint8Array([1])], "raw.rw2")),
    ensureWorkingCopy,
    loadWorkingCopy: vi.fn(async (photoId: string) => ({
      photoId,
      baseVersion: BASE_VERSION,
      bytes: new ArrayBuffer(8),
      encoding: "png16" as const,
      metaJson: JSON.stringify(WORK_META),
    })),
    loadInteractivePreview: vi.fn(async (photoId: string) => ({
      photo: photo(photoId),
      file: new File([new Uint8Array([1, 2, 3])], "interactive.jpg", { type: "image/jpeg" }),
      width: 1600,
      height: 1067,
    })),
    loadProvisionalDraft: vi.fn(async () => null),
    saveProvisionalDraft,
    removeProvisionalDraft: vi.fn(async () => true),
    retryWorkingCopy: vi.fn(async () => ({ kind: "notFailed" as const, workStatus: "ready" as const })),
    saveDevelopSettings,
    downloadOriginal: vi.fn(async (target: PhotoLibraryPhoto) => ({
      blob: new Blob([new Uint8Array([1])]),
      fileName: target.fileName,
    })),
    delete: vi.fn(async () => ({ deleted: [], errors: [] })),
    presets: {
      list: vi.fn(async () => []),
      create: vi.fn(),
      rename: vi.fn(),
      delete: vi.fn(),
      nameMaxChars: 80,
      xmpMaxBytes: 1_000_000,
      describeError: (_error: unknown, fallback: string) => fallback,
      isNameTaken: () => false,
    },
  } as unknown as PhotoLibrary;
  return { library, ensureWorkingCopy, saveDevelopSettings, saveProvisionalDraft, signals };
}

const host: PhotoEditingHost = {
  notifyPhotosChanged: vi.fn(),
  saveFile: vi.fn(async () => "saved" as const),
  nativeFileSaveAvailable: () => false,
  isNativeViewport: () => false,
  isDesktopApp: () => true,
};

let container: HTMLDivElement;
let root: Root;
let current: BrowserPhotoOpen;
let currentViewMode: BrowserViewMode;

function Harness(props: { library: PhotoLibrary; items: BrowserItem[] }) {
  const mountedRef = useRef(true);
  const latestAccessRef = useRef<BrowserPhotoAccess>({ canEdit: true, cloudOriginalsAllowed: true, spotId: "spot" });
  const operationRef = useRef<BrowserPhotoOperationKind | null>(null);
  const saveGenerationRef = useRef(0);
  const allItemsRef = useRef(props.items);
  allItemsRef.current = props.items;
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const [viewMode, setViewMode] = useState<BrowserViewMode>("grid");
  const [place, setPlace] = useState<BrowserCloudPlace>("photos");
  currentViewMode = viewMode;
  const queryClientRef = useRef(new QueryClient());
  const develop = useBrowserPhotoDevelop({
    spotId: "spot",
    actorId: null,
    queryClient: queryClientRef.current,
    mountedRef,
    latestAccessRef,
    setStatus: vi.fn(),
    replaceCloudPhoto: vi.fn(),
    markEditedPreviewPending: vi.fn(),
  });
  current = useBrowserPhotoOpen({
    spotId: "spot",
    canEdit: true,
    openCloudPhotoId: null,
    onOpenCloudPhotoHandled: vi.fn(),
    mountedRef,
    latestAccessRef,
    develop,
    items: {
      allItemsRef,
      place,
      setPlace,
      setSelectedKey: vi.fn(),
      setDeepLinkedPhoto: vi.fn(),
      clearFilter: vi.fn(),
    },
    refetchCloudPhotos: vi.fn(),
    replaceCloudPhoto: vi.fn(),
    viewMode,
    setViewMode,
    cropRollout: true,
    editingAllowed: true,
    canvasSurface: "page",
    setExportSheetOpen: vi.fn(),
    canvasRef,
    operationRef,
    busy: false,
    saveGenerationRef,
    setStatus: vi.fn(),
  });
  return <canvas ref={canvasRef} />;
}

async function mount(library: PhotoLibrary, items: BrowserItem[]) {
  await act(async () => {
    root.render(
      <PhotoLibraryProvider library={library} host={host}>
        <Harness library={library} items={items} />
      </PhotoLibraryProvider>,
    );
  });
}

async function settleUntil(predicate: () => boolean, message: string) {
  for (let index = 0; index < 40; index += 1) {
    await act(async () => {
      await Promise.resolve();
    });
    if (predicate()) return;
  }
  throw new Error(`settle timeout: ${message}`);
}

async function run(action: () => void | Promise<void>) {
  await act(async () => {
    await action();
  });
}

beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  engineFactory.mockReset();
  paintFrame.mockReset();
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
});

describe("useBrowserPhotoOpen progressive RAW integration", () => {
  it("同じ内容hashの端末draftを再表示し、canonical base確定後に既存saverへ保存する", async () => {
    const work = deferred<PhotoLibraryWorkingCopyResult>();
    engineFactory.mockImplementationOnce(() => createEngine({ marker: 1 })).mockImplementationOnce(() => createEngine({ marker: 9 }));
    const fixture = createLibrary(async () => work.promise);
    const settings = { ...neutralDevelopSettings(), exposure: 0.9, contrast: 23 };
    vi.mocked(fixture.library.loadProvisionalDraft!).mockResolvedValue({
      contentSha256: HASH, settings, generation: 12, updatedAt: "2026-10-20T00:00:00.000Z",
    });
    const target = item("restored-draft");
    await mount(fixture.library, [target]);
    let opening!: Promise<void>;
    await run(() => { opening = current.openItem(target); });
    await settleUntil(() => current.opened?.input?.kind === "provisional", "restored provisional");
    expect(fixture.library.loadProvisionalDraft).toHaveBeenCalledWith(target.photo.id, HASH);
    expect(current.settings).toMatchObject({ base: null, exposure: 0.9, contrast: 23 });
    expect(fixture.saveDevelopSettings).not.toHaveBeenCalled();
    await run(() => work.resolve(readyWork()));
    await run(async () => { await opening; });
    expect(current.settings).toMatchObject({ base: BASE_VERSION, exposure: 0.9, contrast: 23 });
    await run(() => current.returnToGrid());
    expect(fixture.saveDevelopSettings).toHaveBeenCalledWith(target.photo.id,
      expect.objectContaining({ base: BASE_VERSION, exposure: 0.9, contrast: 23 }), expect.anything());
  });

  it("保留中の露光・preset・amountをdraftだけへ保存し、最新値と選択/historyをcanonicalへ渡して旧engineの遅延frameを捨てる", async () => {
    const firstCanonical = deferred<DevelopFrame | null>();
    const lateProvisional = deferred<DevelopFrame | null>();
    const draftGate = deferred<PhotoLibraryProvisionalDraft>();
    let delayProvisional = false;
    const provisional = createEngine({
      marker: 1,
      render: async (settings) => {
        if (delayProvisional && Number(settings.exposure ?? 0) !== 0) return lateProvisional.promise;
        return frame(1);
      },
    });
    const canonical = createEngine({
      marker: 9,
      render: async (_settings, call) => call === 1 ? firstCanonical.promise : frame(9),
    });
    engineFactory.mockImplementationOnce(() => provisional).mockImplementationOnce(() => canonical);
    const fixture = createLibrary(async () => readyWork(), { draftGateAt: 2, draftGate });
    const target = item("one");
    await mount(fixture.library, [target]);

    let opening: Promise<void> | undefined;
    await run(() => {
      opening = current.openItem(target);
    });
    await settleUntil(() => current.opened?.input?.kind === "provisional", "provisional open");
    await settleUntil(() => vi.mocked(canonical.render).mock.calls.length === 1, "canonical render pending");
    expect(fixture.saveDevelopSettings).not.toHaveBeenCalled();

    delayProvisional = true;
    await run(() => current.changeSettings((settings) => ({ ...settings, exposure: 0.4 }), "commit"));
    await run(() => current.presets.apply({ key: "builtin:bright", name: "明るい", xmp: "<xmp />" }));
    await run(() => current.presets.changeAmount(65, "drag"));
    await settleUntil(() => fixture.saveProvisionalDraft.mock.calls.length >= 2, "draft flush");
    await settleUntil(
      () => vi.mocked(provisional.render).mock.calls.some(([settings]) => Number((settings as DevelopSettings).exposure ?? 0) !== 0),
      "late provisional render",
    );
    expect(fixture.saveDevelopSettings).not.toHaveBeenCalled();

    await run(() => firstCanonical.resolve(frame(8)));
    await act(async () => Promise.resolve());
    expect(current.opened?.input?.kind).toBe("provisional");
    const pendingDraftSettings = fixture.saveProvisionalDraft.mock.calls[1]?.[2] as DevelopSettings;
    await run(() => draftGate.resolve({
      contentSha256: HASH,
      settings: pendingDraftSettings,
      generation: 2,
      updatedAt: "2026-10-20T00:00:00.000Z",
    }));
    await settleUntil(() => current.opened?.input?.kind === "workingCopy", "canonical handoff");
    await run(async () => {
      await opening;
    });

    const canonicalSettings = vi.mocked(canonical.render).mock.calls.at(-1)?.[0] as DevelopSettings;
    expect(canonicalSettings).toMatchObject({ base: BASE_VERSION, exposure: 0.4, contrast: 65 });
    expect(current.settings).toMatchObject({ base: BASE_VERSION, exposure: 0.4, contrast: 40 });
    expect(current.presets).toMatchObject({ appliedPresetKey: "builtin:bright", amount: 65 });
    expect(current.canUndo).toBe(true);
    expect(paintFrame).toHaveBeenCalledWith(expect.any(HTMLCanvasElement), expect.objectContaining({ rgba: frame(9).rgba }));

    const paintsAfterSwap = paintFrame.mock.calls.length;
    await run(() => lateProvisional.resolve(frame(2)));
    expect(paintFrame.mock.calls.slice(paintsAfterSwap).some(([, painted]) => (painted as DevelopFrame).rgba[0] === 2)).toBe(false);

    await run(() => current.presets.changeAmount(65, "commit"));
    await settleUntil(() => current.presets.amount === 65 && current.presets.amountActive === false, "amount commit");
    await run(() => current.undo());
    expect(current.settings.base).toBe(BASE_VERSION);
  });

  it("未解決のpreset適用は旧engineで確定してからcanonicalへ引き継ぐ", async () => {
    const canonicalFrame = deferred<DevelopFrame | null>();
    const presetResult = deferred<void>();
    const provisional = createEngine({ marker: 1 });
    vi.mocked(provisional.presetSettings).mockImplementation(async (_xmp, base) => {
      await presetResult.promise;
      return { converted: true, name: "明るい", unsupported: [], settings: { ...neutralDevelopSettings(), ...base, contrast: 40 } };
    });
    const canonical = createEngine({ marker: 9, render: async (_settings, call) => call === 1 ? canonicalFrame.promise : frame(9) });
    engineFactory.mockImplementationOnce(() => provisional).mockImplementationOnce(() => canonical);
    const fixture = createLibrary(async () => readyWork());
    const target = item("pending-preset");
    await mount(fixture.library, [target]);
    await run(() => { void current.openItem(target); });
    await settleUntil(() => vi.mocked(canonical.render).mock.calls.length === 1, "canonical frame");
    let applying: Promise<void> | undefined;
    await run(() => { applying = current.presets.apply({ key: "builtin:bright", name: "明るい", xmp: "<xmp />" }); });
    await run(() => canonicalFrame.resolve(frame(8)));
    expect(current.opened?.input?.kind).toBe("provisional");
    expect(provisional.dispose).not.toHaveBeenCalled();
    await run(() => presetResult.resolve(undefined));
    await run(async () => { await applying; });
    await settleUntil(() => current.opened?.input?.kind === "workingCopy", "pending preset handoff");
    expect(current.settings).toMatchObject({ base: BASE_VERSION, engine: "niho-7", contrast: 40 });
    expect(current.presets.appliedPresetKey).toBe("builtin:bright");
    expect(current.canUndo).toBe(true);
  });

  it.each(["drag", "commit"] as const)("未解決の適用量 %s もcanonical切替で捨てない", async (phase) => {
    const canonicalFrame = deferred<DevelopFrame | null>();
    const amountResult = deferred<void>();
    const provisional = createEngine({ marker: 1 });
    vi.mocked(provisional.applyPreset).mockImplementation(async (_xmp, base, amount) => {
      await amountResult.promise;
      return { converted: true, name: "明るい", unsupported: [], settings: { ...(base as DevelopSettings), contrast: Math.round(amount * 100) } };
    });
    const canonical = createEngine({ marker: 9, render: async (_settings, call) => call === 1 ? canonicalFrame.promise : frame(9) });
    engineFactory.mockImplementationOnce(() => provisional).mockImplementationOnce(() => canonical);
    const fixture = createLibrary(async () => readyWork());
    const target = item(`pending-amount-${phase}`);
    await mount(fixture.library, [target]);
    await run(() => { void current.openItem(target); });
    await settleUntil(() => vi.mocked(canonical.render).mock.calls.length === 1, "canonical frame");
    await run(() => current.presets.apply({ key: "builtin:bright", name: "明るい", xmp: "<xmp />" }));
    await run(() => current.presets.changeAmount(65, phase));
    await run(() => canonicalFrame.resolve(frame(8)));
    expect(current.opened?.input?.kind).toBe("provisional");
    await run(() => amountResult.resolve(undefined));
    await settleUntil(() => current.opened?.input?.kind === "workingCopy", "pending amount handoff");
    const shown = vi.mocked(canonical.render).mock.calls.at(-1)?.[0] as DevelopSettings;
    expect(shown).toMatchObject({ base: BASE_VERSION, contrast: 65 });
    expect(current.presets).toMatchObject({ amount: 65, amountActive: phase === "drag", appliedPresetKey: "builtin:bright" });
    if (phase === "drag") await run(() => current.presets.changeAmount(65, "commit"));
    await settleUntil(() => current.presets.amountActive === false, "amount commit");
    expect(current.settings).toMatchObject({ base: BASE_VERSION, contrast: 65 });
    await run(() => current.undo());
    expect(current.settings).toMatchObject({ base: BASE_VERSION, contrast: 40 });
  });

  it("暫定previewを取得できないRAWも正規入力で開き、補正と通常保存を続ける", async () => {
    const canonical = createEngine({ marker: 9 });
    engineFactory.mockReturnValue(canonical);
    const fixture = createLibrary(async () => readyWork());
    vi.mocked(fixture.library.loadInteractivePreview!).mockRejectedValue(new Error("preview unavailable"));
    const target = item("fallback");
    await mount(fixture.library, [target]);
    await run(() => current.openItem(target));
    expect(current.opened?.input?.kind).toBe("workingCopy");
    expect(current.settings).toMatchObject({ engine: "niho-7", base: BASE_VERSION });
    await run(() => current.changeSettings((settings) => ({ ...settings, exposure: 0.4 }), "commit"));
    expect(current.settings.exposure).toBe(0.4);
    expect(fixture.saveProvisionalDraft).not.toHaveBeenCalled();
    await run(async () => { expect(await current.returnToGrid()).toBe(true); });
    expect(fixture.saveDevelopSettings).toHaveBeenCalledWith(
      target.photo.id, expect.objectContaining({ exposure: 0.4, base: BASE_VERSION }), expect.any(Object),
    );
  });

  it("canonical待ちのcrop操作とundoを実hookで処理し、crop表示をcanonical engineで描いてactive/historyを保つ", async () => {
    const canonicalFrame = deferred<DevelopFrame | null>();
    const provisional = createEngine({ marker: 1 });
    const canonical = createEngine({
      marker: 9,
      render: async (_settings, call) => call === 1 ? canonicalFrame.promise : frame(9),
    });
    engineFactory.mockImplementationOnce(() => provisional).mockImplementationOnce(() => canonical);
    const fixture = createLibrary(async () => readyWork());
    const target = item("crop");
    await mount(fixture.library, [target]);

    await run(() => {
      void current.openItem(target);
    });
    await settleUntil(() => current.opened?.input?.kind === "provisional" && current.crop.available, "crop available");
    await settleUntil(() => vi.mocked(canonical.render).mock.calls.length === 1, "canonical render pending");
    await run(() => current.crop.enter());
    await settleUntil(() => current.crop.active, "crop active");
    const geometry = {
      rotate: 0 as const,
      flipH: false,
      flipV: false,
      angle: 0,
      crop: { left: 0.1, top: 0.1, right: 0.9, bottom: 0.9 },
      aspect: "free",
    };
    await run(() => current.crop.commit(geometry));
    await run(() => current.undo());
    await run(() => current.crop.commit(geometry));
    expect(current.settings.geometry).toBeDefined();

    await run(() => canonicalFrame.resolve(frame(8)));
    await settleUntil(() => current.opened?.input?.kind === "workingCopy", "crop handoff");
    const rendered = vi.mocked(canonical.render).mock.calls.at(-1)?.[0] as DevelopSettings;
    expect(rendered.base).toBe(BASE_VERSION);
    expect(rendered.geometry).toBeUndefined();
    expect(current.settings).toMatchObject({ base: BASE_VERSION, geometry });
    expect(current.crop.active).toBe(true);
    expect(current.canUndo).toBe(true);
  });

  it("canonical失敗から同じprovisional編集を保って再試行できる", async () => {
    const provisional = createEngine({ marker: 1 });
    const failedCanonical = createEngine({ marker: 7, ready: false });
    const retryCanonical = createEngine({ marker: 9 });
    engineFactory
      .mockImplementationOnce(() => provisional)
      .mockImplementationOnce(() => failedCanonical)
      .mockImplementationOnce(() => retryCanonical);
    const fixture = createLibrary(async () => readyWork());
    const target = item("retry");
    await mount(fixture.library, [target]);

    await run(() => current.openItem(target));
    await settleUntil(
      () => current.opened?.input?.kind === "provisional" && current.opened?.canonicalPending === false,
      "canonical fail",
    );
    await run(() => current.changeSettings((settings) => ({ ...settings, exposure: 0.7 }), "commit"));
    expect(current.settings.exposure).toBe(0.7);
    await run(() => current.retryCanonical());
    await settleUntil(() => current.opened?.input?.kind === "workingCopy", "canonical retry");
    expect(current.settings).toMatchObject({ base: BASE_VERSION, exposure: 0.7 });
    expect(current.canUndo).toBe(true);
  });

  it("写真切替で前のpreview/canonical生成をabortし、遅れて返った結果を開かない", async () => {
    const firstWork = deferred<PhotoLibraryWorkingCopyResult>();
    const provisional = createEngine({ marker: 1 });
    const staleCanonical = createEngine({ marker: 8 });
    const secondCanonical = createEngine({ marker: 9 });
    engineFactory
      .mockImplementationOnce(() => provisional)
      .mockImplementationOnce(() => staleCanonical)
      .mockImplementationOnce(() => secondCanonical);
    const fixture = createLibrary(async (photoId) => photoId === "first" ? firstWork.promise : readyWork());
    const first = item("first");
    const second = item("second");
    await mount(fixture.library, [first, second]);

    await run(() => {
      void current.openItem(first);
    });
    await settleUntil(
      () => current.opened?.key === first.key && current.opened?.input?.kind === "provisional",
      "first provisional",
    );
    await run(() => {
      void current.openItem(second);
    });
    await settleUntil(() => current.opened?.key === second.key, "second selected");
    expect(fixture.signals.some((signal) => signal.aborted)).toBe(true);
    await run(() => firstWork.resolve(readyWork()));
    await settleUntil(() => currentViewMode === "loupe", "second remains open");
    expect(current.opened?.key).toBe(second.key);
  });
});
