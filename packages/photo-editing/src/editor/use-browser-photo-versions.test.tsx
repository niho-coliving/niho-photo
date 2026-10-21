// @vitest-environment jsdom

import { act, useRef } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { neutralDevelopSettings, type DevelopSettings } from "../develop-engine/develop-settings";
import { createDevelopSettingsSaver } from "../develop-engine/develop-settings-autosave";
import type {
  PhotoLibrary,
  PhotoLibraryDevelopVersion,
  PhotoLibraryDevelopVersions,
  PhotoLibraryPhoto,
} from "../library/photo-library";
import { PhotoLibraryProvider, type PhotoEditingHost } from "../library/photo-library-context";

import type { DevelopSession, OpenedSource } from "./browser-photo-editing-model";
import { useBrowserPhotoEditSettings, type BrowserPhotoEditSettings } from "./use-browser-photo-edit-settings";
import { useBrowserPhotoVersions, type BrowserPhotoVersions } from "./use-browser-photo-versions";

/**
 * 「版」（niho-photo#42）の中身を、本物の編集内容（取り消しの履歴）と補正の自動保存につないで確かめる。
 *
 * - 版を 2 つ作って切り替えると、補正（スライダーの値）が切り替わり、写真の補正として自動保存される
 * - 切り替えは取り消し・やり直しの 1 単位
 * - 切り替える前の補正（どの版とも違う）は自動の版として、補正の自動保存より先に保存する
 * - 版の無い写真（今までの写真）は空の一覧で開け、補正の保存は今までどおり
 */

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const NOW = new Date("2026-10-21T01:32:00.000Z");
const AUTOSAVE_DELAY_MS = 20;

const host: PhotoEditingHost = {
  notifyPhotosChanged: () => undefined,
  saveFile: async () => "saved",
  nativeFileSaveAvailable: () => false,
  isNativeViewport: () => false,
  isDesktopApp: () => true,
};

function photoRow(settings: DevelopSettings | null, revision: number): PhotoLibraryPhoto {
  return {
    id: "p1",
    fileName: "IMG_0001.JPG",
    fileExtension: "jpg",
    sizeBytes: 1024,
    contentSha256: "a".repeat(64),
    createdAt: "2026-10-01T00:00:00.000Z",
    uploadedBy: null,
    hasOriginal: true,
    hasPreview: true,
    hasWebImage: false,
    hasDevelopSettings: settings !== null,
    developSettings: settings,
    developSettingsUpdatedAt: null,
    developRevision: revision,
    webRenderedRevision: null,
  };
}

type FakeOptions = { versions?: PhotoLibraryDevelopVersions | null; withoutVersions?: boolean };

function fakeLibrary(options: FakeOptions = {}) {
  const log: string[] = [];
  const stored = { versions: options.versions ?? { versions: [], revision: 0 }, settingsRevision: 0 };
  const developVersions = vi.fn(async () => structuredClone(stored.versions));
  const saveDevelopVersions = vi.fn(
    async (_photoId: string, versions: readonly PhotoLibraryDevelopVersion[], saveOptions: { expectedRevision: number }) => {
      log.push(`versions:${versions.map((version) => version.name).join(",")}`);
      if (saveOptions.expectedRevision !== stored.versions.revision) {
        return { kind: "stale" as const, ...structuredClone(stored.versions) };
      }
      stored.versions = { versions: structuredClone([...versions]), revision: stored.versions.revision + 1 };
      return { kind: "saved" as const, ...structuredClone(stored.versions) };
    },
  );
  const saveDevelopSettings = vi.fn(async (_photoId: string, settings: DevelopSettings) => {
    log.push(`settings:${String(settings.exposure)}`);
    stored.settingsRevision += 1;
    return { kind: "saved" as const, photo: photoRow(settings, stored.settingsRevision) };
  });
  const library = {
    place: "local",
    saveDevelopSettings,
    ...(options.withoutVersions ? {} : { developVersions, saveDevelopVersions }),
  } as unknown as PhotoLibrary;
  return { library, log, stored, developVersions, saveDevelopVersions, saveDevelopSettings };
}

type Api = { edit: BrowserPhotoEditSettings; versions: BrowserPhotoVersions };

let container: HTMLDivElement;
let root: Root;
let api: Api;
let idCounter = 0;

function Harness(props: { library: PhotoLibrary; photoOpen: boolean }) {
  const openedRef = useRef<OpenedSource | null>({
    key: "local:p1",
    fileName: "IMG_0001.JPG",
    decoded: null,
    viewUrl: null,
    lockedReason: null,
    loadedForEditing: true,
    mode: "wasm",
    input: { kind: "original", file: new File([], "IMG_0001.JPG") },
    work: null,
    photo: null,
  });
  const operationRef = useRef(null);
  const leavingRef = useRef(null);
  const developSessionRef = useRef<DevelopSession | null>(null);
  if (developSessionRef.current === null) {
    developSessionRef.current = {
      key: "local:p1",
      photoId: "p1",
      spotId: "local",
      input: { kind: "original", file: new File([], "IMG_0001.JPG") },
      working: null,
      workSize: null,
      photo: photoRow(null, 0),
      settingsSource: "none",
      saver: createDevelopSettingsSaver({
        save: (settings, expectedRevision) => props.library.saveDevelopSettings("p1", settings, { expectedRevision }),
        isPermanentFailure: () => false,
        expectedRevision: 0,
        delayMs: AUTOSAVE_DELAY_MS,
      }),
    } as unknown as DevelopSession;
  }
  const edit = useBrowserPhotoEditSettings({
    canEdit: true,
    openedRef,
    operationRef,
    leavingRef,
    developSessionRef,
    setStatus: () => undefined,
    setCompareOriginal: () => undefined,
  });
  const versions = useBrowserPhotoVersions({
    photo: props.photoOpen ? { id: "p1", contentSha256: "a".repeat(64) } : null,
    settings: edit.settings,
    settingsRef: edit.settingsRef,
    commitEdit: edit.commitEdit,
    disabled: false,
    now: () => NOW,
    createId: () => `v${(idCounter += 1)}`,
  });
  api = { edit, versions };
  return null;
}

async function settle(ms = 0) {
  await act(async () => {
    for (let index = 0; index < 10; index += 1) await Promise.resolve();
    await new Promise((resolve) => setTimeout(resolve, ms));
    for (let index = 0; index < 10; index += 1) await Promise.resolve();
  });
}

async function render(library: PhotoLibrary, photoOpen = true) {
  await act(async () => {
    root.render(
      <PhotoLibraryProvider library={library} host={host}>
        <Harness library={library} photoOpen={photoOpen} />
      </PhotoLibraryProvider>,
    );
  });
  await settle();
}

const START: DevelopSettings = { ...neutralDevelopSettings(), exposure: 0.3 };

async function load(settings: DevelopSettings) {
  await act(async () => api.edit.loadSettings(settings, { history: true }));
}

async function slide(exposure: number) {
  await act(async () => api.edit.changeSettings((current) => ({ ...current, exposure }), "commit"));
}

async function run(action: () => void) {
  await act(async () => action());
  await settle();
}

function exposure(): unknown {
  return api.edit.settings.exposure;
}

function selectedName(): string | null {
  return api.versions.versions.find((version) => version.id === api.versions.selectedId)?.name ?? null;
}

beforeEach(() => {
  idCounter = 0;
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  vi.restoreAllMocks();
});

describe("useBrowserPhotoVersions", () => {
  it("版を 2 つ作って切り替えると補正が切り替わり、切り替えは取り消し・やり直しの 1 単位", async () => {
    const fake = fakeLibrary();
    await render(fake.library);
    expect(api.versions.status).toBe("ready");
    expect(fake.developVersions).toHaveBeenCalledWith("p1", expect.objectContaining({ signal: expect.any(AbortSignal) }));
    await load(START);

    expect(api.versions.defaultName).toBe("版 1");
    await run(() => expect(api.versions.create("明るめ")).toEqual({ ok: true }));
    await slide(-0.5);
    await run(() => expect(api.versions.create(" フィルム調 ")).toEqual({ ok: true }));
    expect(api.versions.versions.map((version) => [version.name, version.developSettings.exposure])).toEqual([
      ["明るめ", 0.3],
      ["フィルム調", -0.5],
    ]);
    expect(selectedName()).toBe("フィルム調");
    // 名前の失敗は保存しない
    await run(() => expect(api.versions.create("   ")).toEqual({ ok: false, message: "名前を入れてください。" }));
    expect(fake.saveDevelopVersions).toHaveBeenCalledTimes(2);

    // 「明るめ」へ切り替える（今の補正は「フィルム調」と同じなので自動の版は残さない）
    const bright = api.versions.versions[0]!.id;
    await run(() => api.versions.switchTo(bright));
    expect(exposure()).toBe(0.3);
    expect(selectedName()).toBe("明るめ");
    expect(api.versions.versions).toHaveLength(2);
    expect(fake.saveDevelopVersions).toHaveBeenCalledTimes(2);
    // 写真の補正として自動保存される
    await settle(AUTOSAVE_DELAY_MS * 3);
    expect(fake.saveDevelopSettings).toHaveBeenLastCalledWith("p1", expect.objectContaining({ exposure: 0.3 }), expect.anything());

    // ↶ は切り替える前（フィルム調）へ 1 回で戻り、↷ でまた「明るめ」
    await act(async () => api.edit.undo());
    expect(exposure()).toBe(-0.5);
    expect(selectedName()).toBe("フィルム調");
    await act(async () => api.edit.redo());
    expect(exposure()).toBe(0.3);
    expect(api.edit.canRedo).toBe(false);
    // 同じ版を押しても何もしない（履歴も増やさない）
    await run(() => api.versions.switchTo(bright));
    await act(async () => api.edit.undo());
    expect(exposure()).toBe(-0.5);
  });

  it("どの版とも違う今の補正は自動の版として残し、その保存は補正の自動保存より先", async () => {
    const fake = fakeLibrary();
    await render(fake.library);
    await load(START);
    await run(() => api.versions.create("明るめ"));
    await slide(0.9);
    await settle(AUTOSAVE_DELAY_MS * 3);
    fake.log.length = 0;

    await run(() => api.versions.switchTo(api.versions.versions[0]!.id));
    expect(exposure()).toBe(0.3);
    expect(api.versions.versions.map((version) => [version.kind, version.name, version.developSettings.exposure])).toEqual([
      ["named", "明るめ", 0.3],
      ["auto", "自動の版 10:32", 0.9],
    ]);
    await settle(AUTOSAVE_DELAY_MS * 3);
    expect(fake.log).toEqual(["versions:明るめ,自動の版 10:32", "settings:0.3"]);
    expect(fake.stored.versions.revision).toBe(2);

    // 自動の版へ戻る（今の補正は「明るめ」と同じなので、もう自動の版を増やさない）。↶ は 1 回で「明るめ」
    await run(() => api.versions.switchTo(api.versions.versions[1]!.id));
    expect(exposure()).toBe(0.9);
    expect(api.versions.versions).toHaveLength(2);
    expect(selectedName()).toBe("自動の版 10:32");
    await act(async () => api.edit.undo());
    expect(exposure()).toBe(0.3);
  });

  it("名前を変える・消す（選んでいる版を消しても補正は変えない）。面を閉じて開き直しても読み直さない", async () => {
    const fake = fakeLibrary();
    await render(fake.library);
    await load(START);
    await run(() => api.versions.create("明るめ"));
    const id = api.versions.versions[0]!.id;
    await run(() => expect(api.versions.rename(id, "  明るめ（屋外）  ")).toEqual({ ok: true }));
    expect(api.versions.versions[0]?.name).toBe("明るめ（屋外）");
    expect(api.versions.rename(id, "")).toEqual({ ok: false, message: "名前を入れてください。" });
    expect(api.versions.rename(id, "あ".repeat(41))).toEqual({ ok: false, message: "名前は 40 文字までにしてください。" });
    await run(() => api.versions.remove(id));
    expect(api.versions.versions).toEqual([]);
    expect(exposure()).toBe(0.3);
    expect(fake.stored.versions).toEqual({ versions: [], revision: 3 });

    await render(fake.library, false);
    await render(fake.library, true);
    expect(api.versions.status).toBe("ready");
    expect(fake.developVersions).toHaveBeenCalledTimes(1);
  });

  it("版の無い写真（今までの写真）は空の一覧で開け、版を持たない置き場は版を読まずに補正を今までどおり保存する", async () => {
    const empty = fakeLibrary({ versions: { versions: [], revision: 0 } });
    await render(empty.library);
    expect(api.versions).toMatchObject({ status: "ready", versions: [], selectedId: null, defaultName: "版 1" });

    const legacy = fakeLibrary({ withoutVersions: true });
    await act(async () => root.unmount());
    root = createRoot(container);
    await render(legacy.library);
    expect(api.versions.status).toBe("loading");
    await load(START);
    await slide(0.6);
    await settle(AUTOSAVE_DELAY_MS * 3);
    expect(legacy.saveDevelopSettings).toHaveBeenLastCalledWith("p1", expect.objectContaining({ exposure: 0.6 }), expect.anything());
    // 版の操作は何もしない
    await run(() => api.versions.switchTo("missing"));
    expect(api.versions.create("明るめ")).toEqual({ ok: false, message: "" });
  });

  it("読めない版は失敗の 1 行にし、「再読み込み」で読み直す。保存の失敗は画面の版を残して「再試行」で送り直す", async () => {
    const fake = fakeLibrary();
    fake.developVersions.mockRejectedValueOnce(new Error("offline"));
    await render(fake.library);
    expect(api.versions.status).toBe("failed");
    await run(() => api.versions.reload());
    expect(api.versions.status).toBe("ready");

    await load(START);
    fake.saveDevelopVersions.mockRejectedValueOnce(new Error("disk full"));
    await run(() => api.versions.create("明るめ"));
    expect(api.versions.saveFailed).toBe(true);
    expect(api.versions.versions.map((version) => version.name)).toEqual(["明るめ"]);
    await run(() => api.versions.retrySave());
    expect(api.versions.saveFailed).toBe(false);
    expect(fake.stored.versions.versions.map((version) => version.name)).toEqual(["明るめ"]);
  });
});
