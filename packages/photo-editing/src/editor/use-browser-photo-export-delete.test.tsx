// @vitest-environment jsdom

import { act, useRef } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { DevelopEngine } from "../develop-engine/develop-engine-client";
import { neutralDevelopSettings } from "../develop-engine/develop-settings";
import type { PhotoLibrary, PhotoLibraryCapabilities, PhotoLibraryPhoto } from "../library/photo-library";
import {
  PhotoLibraryProvider,
  type PhotoEditingHost,
} from "../library/photo-library-context";

import type { BrowserItem, DevelopSession, OpenedSource } from "./browser-photo-editing-model";
import {
  useBrowserPhotoExportAndDelete,
  type BrowserPhotoExportResult,
} from "./use-browser-photo-export-delete";

const CAPABILITIES: PhotoLibraryCapabilities = {
  place: "local",
  rawWorkingCopy: true,
  nativeExport: false,
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

function photo(): PhotoLibraryPhoto {
  return {
    id: "raw",
    fileName: "raw.rw2",
    fileExtension: "rw2",
    sizeBytes: 1_000,
    contentSha256: "b".repeat(64),
    createdAt: "2026-10-20T00:00:00.000Z",
    capturedAt: null,
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

const target: BrowserItem = {
  key: "cloud:raw",
  photo: { ...photo(), previewUrl: "https://example.invalid/raw.jpg" },
  localPreviewUrl: null,
  adding: false,
};

function provisionalOpened(): OpenedSource {
  return {
    key: target.key,
    fileName: target.photo.fileName,
    decoded: null,
    viewUrl: target.photo.previewUrl,
    previewPending: false,
    previewCurrent: false,
    lockedReason: null,
    loadedForEditing: true,
    mode: "wasm",
    input: {
      kind: "provisional",
      file: new File([new Uint8Array([1])], "preview.jpg", { type: "image/jpeg" }),
      contentSha256: photo().contentSha256,
      width: 1600,
      height: 1067,
    },
    canonicalPending: true,
    work: { phase: "opening" },
    photo: photo(),
  };
}

function canonicalOpened(): OpenedSource {
  return {
    ...provisionalOpened(),
    input: {
      kind: "workingCopy",
      encoding: "png16",
      bytes: new ArrayBuffer(8),
      metaJson: "{}",
      baseVersion: "raw-apple.d1.p1.e1",
    },
    canonicalPending: false,
    work: null,
  };
}

let container: HTMLDivElement;
let root: Root;
let runExport: (
  format: "jpeg" | "png" | "original",
  options: { size: "long2048" | "width1080" | "full"; jpegRoute: "engine" | "canvas" | "webImage" | "native" | null },
) => Promise<BrowserPhotoExportResult>;
let openedRefForTest: { current: OpenedSource | null };
let operationRefForTest: { current: "export" | "delete" | "bulk" | null };
let pendingEdits: { hasPending: () => boolean; waitForPending: ReturnType<typeof vi.fn<() => Promise<void>>> };
let engine: DevelopEngine;
let downloadOriginal: ReturnType<typeof vi.fn>;
let saveFile = vi.fn<PhotoEditingHost["saveFile"]>();

function Harness() {
  const mountedRef = useRef(true);
  const latestAccessRef = useRef({ canEdit: true, cloudOriginalsAllowed: true, spotId: "spot" });
  const operationRef = useRef<"export" | "delete" | "bulk" | null>(null);
  operationRefForTest = operationRef;
  const saveGenerationRef = useRef(0);
  const viewModeRef = useRef<"grid" | "loupe">("loupe");
  const engineRef = useRef(engine);
  const developSessionRef = useRef<DevelopSession | null>(null);
  const openedRef = useRef<OpenedSource | null>(provisionalOpened());
  openedRefForTest = openedRef;
  const settingsRef = useRef(neutralDevelopSettings("raw-apple.d1.p1.e1"));
  const openingKeyRef = useRef<string | null>(null);
  const controller = useBrowserPhotoExportAndDelete({
    spotId: "spot",
    canEdit: true,
    mountedRef,
    latestAccessRef,
    selectedItem: target,
    pendingEdits,
    operationRef,
    setOperation: vi.fn(),
    saveGenerationRef,
    viewModeRef,
    setViewMode: vi.fn(),
    setExportSheetOpen: vi.fn(),
    setStatus: vi.fn(),
    removeCloudPhotos: vi.fn(),
    develop: {
      engineRef,
      developSessionRef,
      releaseDevelopSession: vi.fn(),
      readyDevelopEngine: vi.fn(async () => engine),
    },
    open: {
      openedRef,
      openingKeyRef,
      settingsRef,
      setSavedSettingsKey: vi.fn(),
      setSourceError: vi.fn(),
      abortOpening: vi.fn(),
      clearOpened: vi.fn(),
    },
    items: {
      deepLinkedPhoto: null,
      setDeepLinkedPhoto: vi.fn(),
      setSelectedKey: vi.fn(),
      removeAddedPhoto: vi.fn(),
    },
    capabilities: CAPABILITIES,
  });
  runExport = controller.runExport;
  return null;
}

beforeEach(async () => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  vi.useFakeTimers();
  pendingEdits = { hasPending: () => false, waitForPending: vi.fn(async () => undefined) };
  engine = {
    exportWorkingCopyJpeg: vi.fn(async () => new Uint8Array([1, 2, 3])),
    exportJpeg: vi.fn(async () => new Uint8Array([1, 2, 3])),
    imageSize: vi.fn(async () => ({ width: 3000, height: 2000 })),
    geometryOutputSize: vi.fn(async () => ({ width: 2048, height: 1365 })),
    withCaptureExif: vi.fn(async (bytes: Uint8Array<ArrayBuffer>) => bytes),
  } as unknown as DevelopEngine;
  downloadOriginal = vi.fn(async () => ({ blob: new Blob([new Uint8Array([7])]), fileName: "raw.rw2" }));
  const library = {
    downloadOriginal,
    errors: {
      describe: (_error: unknown, fallback: string) => fallback,
      describeStorageError: () => null,
      isNativeError: () => false,
    },
  } as unknown as PhotoLibrary;
  saveFile = vi.fn(async () => "saved" as const);
  const host: PhotoEditingHost = {
    notifyPhotosChanged: vi.fn(),
    saveFile,
    nativeFileSaveAvailable: () => false,
    isNativeViewport: () => false,
    isDesktopApp: () => true,
  };
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  await act(async () => {
    root.render(
      <PhotoLibraryProvider library={library} host={host}>
        <Harness />
      </PhotoLibraryProvider>,
    );
  });
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  vi.useRealTimers();
});

describe("useBrowserPhotoExportAndDelete canonical guard integration", () => {
  it("受け付けたプリセットを確定してから編集をロックし、同時の重複exportを抑える", async () => {
    let finish!: () => void;
    pendingEdits.hasPending = () => true;
    pendingEdits.waitForPending.mockImplementation(() => new Promise<void>((resolve) => { finish = resolve; }));
    openedRefForTest.current = canonicalOpened();
    const first = runExport("jpeg", { size: "long2048", jpegRoute: "engine" });
    const completeFirst = finish;
    const second = runExport("jpeg", { size: "long2048", jpegRoute: "engine" });
    expect(operationRefForTest.current).toBeNull();
    expect(engine.exportWorkingCopyJpeg).not.toHaveBeenCalled();
    await act(async () => {
      completeFirst();
      finish();
      expect(await first).toBe("done");
      expect(await second).toBe("skipped");
    });
    expect(engine.exportWorkingCopyJpeg).toHaveBeenCalledTimes(1);
  });

  it("補正を焼くfull-quality exportはcanonical handoffまでengineを呼ばない", async () => {
    let result: BrowserPhotoExportResult | undefined;
    const pending = runExport("jpeg", { size: "long2048", jpegRoute: "engine" }).then((value) => {
      result = value;
    });
    await act(async () => Promise.resolve());
    expect(engine.exportWorkingCopyJpeg).not.toHaveBeenCalled();
    expect(saveFile).not.toHaveBeenCalled();

    openedRefForTest.current = canonicalOpened();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(50);
      await pending;
    });
    expect(engine.exportWorkingCopyJpeg).toHaveBeenCalledTimes(1);
    expect(saveFile).toHaveBeenCalledTimes(1);
    expect(result).toBe("done");
  });

  it("RAW original copyはprovisional中でもcanonicalを待たない", async () => {
    pendingEdits.hasPending = () => true;
    pendingEdits.waitForPending.mockImplementation(() => new Promise<void>(() => undefined));
    let result: BrowserPhotoExportResult | undefined;
    await act(async () => {
      result = await runExport("original", { size: "long2048", jpegRoute: null });
    });
    expect(downloadOriginal).toHaveBeenCalledTimes(1);
    expect(pendingEdits.waitForPending).not.toHaveBeenCalled();
    expect(engine.exportWorkingCopyJpeg).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
    expect(result).toBe("done");
  });
});
