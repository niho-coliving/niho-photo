// @vitest-environment jsdom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * 編集面のこの Mac のフォルダの面（写真の出どころに `folders` があるとき。NIHO camera C3 移行元設計）と、置き場が「この Mac」のときに
 * クラウドの文言・道具を出さないこと。偽の写真の出どころ（`place: "local"`）で編集面をそのまま描く（web の偽の口に依らない）。
 *
 * - 左の木は「この Mac」と「＋」の下にフォルダの木。最初は覚えたフォルダ（無ければ最初の根）を選び、一覧は `folderId` で読む
 * - 「＋」でフォルダを足して選ぶ・根の「⋯」の「一覧から外す」で確かめてから外す・フォルダが無いときの空状態
 * - クラウドの写真の出どころ（`folders` が無い）は、今までどおりの木（「クラウド」）
 */

const mocks = vi.hoisted(() => ({
  confirm: vi.fn(),
  createEngine: vi.fn(),
}));

vi.mock("niho-ui/app-dialog", () => ({ appDialog: { confirm: mocks.confirm, alert: vi.fn(async () => undefined) } }));
vi.mock("../develop-engine/develop-engine-client", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../develop-engine/develop-engine-client")>();
  return { ...actual, createDevelopEngine: mocks.createEngine };
});

import type {
  PhotoLibrary,
  PhotoLibraryCapabilities,
  PhotoLibraryFolder,
  PhotoLibraryItem,
  PhotoLibraryListPage,
  PhotoLibraryListQuery,
} from "../library/photo-library";
import { PhotoLibraryProvider, type PhotoEditingHost } from "../library/photo-library-context";
import { getPhotoEditingBreadcrumbSnapshot } from "../photo-editing-breadcrumb-store";

import { BrowserPhotoEditingWorkbench } from "./browser-photo-editing-workbench";
import { browserPhotoLastFolderStorageKey } from "./use-browser-photo-folders";

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const LOCAL_CAPABILITIES: PhotoLibraryCapabilities = {
  place: "local",
  rawWorkingCopy: true,
  nativeExport: true,
  nativeExportUpdateRequired: false,
  exportFolder: true,
  cutout: false,
  favorites: false,
  albums: false,
  articleImages: false,
  multiSelect: true,
  mobile: false,
  editedPreview: false,
  addFiles: false,
  addFromDevice: false,
  addFromDeviceFolder: false,
};

const CLOUD_CAPABILITIES: PhotoLibraryCapabilities = {
  ...LOCAL_CAPABILITIES,
  place: "cloud",
  nativeExport: false,
  exportFolder: false,
  favorites: true,
  albums: true,
  articleImages: true,
  mobile: true,
  editedPreview: true,
  addFiles: true,
};

function folder(folderId: string, name: string, children: PhotoLibraryFolder[] = []): PhotoLibraryFolder {
  return { folderId, name, children, truncated: false };
}

function photo(id: string, fileName: string): PhotoLibraryItem {
  return {
    id,
    fileName,
    fileExtension: "jpg",
    sizeBytes: 1024,
    contentSha256: null,
    createdAt: "2026-10-01T00:00:00.000Z",
    capturedAt: "2026-10-01T00:00:00.000Z",
    uploadedBy: null,
    hasOriginal: true,
    hasPreview: true,
    hasWebImage: false,
    hasDevelopSettings: false,
    developSettings: null,
    developSettingsUpdatedAt: null,
    developRevision: 0,
    webRenderedRevision: null,
    previewUrl: `asset://preview/${id}.jpg`,
  };
}

type FakeLibraryOptions = {
  place?: "local" | "cloud";
  /** 木（呼ぶたびに今の値を返す。足す・外すで書き換える） */
  tree?: PhotoLibraryFolder[];
  /** フォルダの ID ごとの写真（無ければ空） */
  photos?: Record<string, PhotoLibraryItem[]>;
  /** クラウドの一覧（`folders` の無い写真の出どころ） */
  cloudPhotos?: PhotoLibraryItem[];
  added?: PhotoLibraryFolder | null;
};

function fakeLibrary(options: FakeLibraryOptions = {}) {
  const place = options.place ?? "local";
  const state = { tree: options.tree ?? [] };
  const list = vi.fn(async (query: PhotoLibraryListQuery): Promise<PhotoLibraryListPage> => {
    const items =
      place === "cloud" ? (options.cloudPhotos ?? []) : query.folderId ? (options.photos?.[query.folderId] ?? []) : [];
    return { items, next: null, usage: null, counts: null };
  });
  const folders = {
    tree: vi.fn(async () => state.tree),
    add: vi.fn(async () => {
      const added = options.added ?? null;
      if (added) state.tree = [...state.tree, added];
      return added;
    }),
    forget: vi.fn(async (folderId: string) => {
      state.tree = state.tree.filter((candidate) => candidate.folderId !== folderId);
    }),
  };
  const capabilities = place === "cloud" ? CLOUD_CAPABILITIES : LOCAL_CAPABILITIES;
  const deletePhotos = vi.fn(async () => ({ deleted: [], errors: [] }));
  const library = {
    place,
    initialCapabilities: capabilities,
    capabilities: vi.fn(async () => capabilities),
    rollout: vi.fn(async () => ({ crop: false, mobileEditing: false })),
    engineAssets: { manifestUrl: () => null },
    limits: { listPageSize: 60, lookupMaxCount: 100, referencesMaxCount: 100, photosPerRequest: 100 },
    errors: {
      describe: (_error: unknown, fallback: string) => fallback,
      describeStorageError: () => null,
      describeDeleteFailure: () => "",
      isNativeError: () => false,
      describeNative: () => "",
      isPermanentSaveFailure: () => false,
      isNotFound: () => false,
      readQuotaExceeded: () => null,
      describeQuotaExceeded: () => "",
      readDevelopRevisionStale: () => null,
      isExportFolderNotFound: () => false,
    },
    list,
    get: vi.fn(async () => null),
    lookup: vi.fn(async () => []),
    delete: deletePhotos,
    presets: { nameMaxChars: 100, list: vi.fn(async () => []) },
    ...(place === "local" ? { folders } : {}),
  } as unknown as PhotoLibrary;
  return { library, list, folders, state, deletePhotos };
}

const host: PhotoEditingHost = {
  notifyPhotosChanged: () => undefined,
  saveFile: async () => "saved",
  nativeFileSaveAvailable: () => false,
  isNativeViewport: () => false,
  isDesktopApp: () => true,
};

let container: HTMLDivElement;
let root: Root;
let client: QueryClient;
const initialInnerWidth = window.innerWidth;

/** 読み込み（react-query・木を読んでから選ぶフォルダ）が落ち着くまで待つ（macrotask も挟む）。 */
async function settle() {
  for (let round = 0; round < 4; round += 1) {
    await act(async () => {
      for (let index = 0; index < 12; index += 1) await Promise.resolve();
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
  }
}

async function render(library: PhotoLibrary) {
  await act(async () => {
    root.render(
      <QueryClientProvider client={client}>
        <PhotoLibraryProvider library={library} host={host}>
          <BrowserPhotoEditingWorkbench
            spotId="local"
            canEdit
            cloudOriginalsAllowed
            active
            openCloudPhotoId={null}
            onOpenCloudPhotoHandled={() => undefined}
          />
        </PhotoLibraryProvider>
      </QueryClientProvider>,
    );
  });
  await settle();
}

async function remount(library: PhotoLibrary) {
  await act(async () => root.unmount());
  client.clear();
  client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  root = createRoot(container);
  await render(library);
}

async function click(element: Element | null | undefined) {
  if (!element) throw new Error("element not found");
  await act(async () => {
    element.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
  });
  await settle();
}

function tree(): HTMLElement {
  const found = container.querySelector<HTMLElement>('aside[aria-label="写真の場所"]');
  if (!found) throw new Error("tree not found");
  return found;
}

function folderRow(name: string): HTMLButtonElement | undefined {
  return Array.from(tree().querySelectorAll<HTMLButtonElement>("li button")).find(
    (candidate) => candidate.title === name && candidate.textContent === name,
  );
}

function byLabel(label: string, scope: ParentNode = container): HTMLButtonElement | null {
  return scope.querySelector<HTMLButtonElement>(`button[aria-label="${label}"]`);
}

function tile(fileName: string): HTMLButtonElement | undefined {
  return Array.from(container.querySelectorAll<HTMLButtonElement>('section[aria-label="写真の一覧"] li > button')).find(
    (candidate) => candidate.title === fileName,
  );
}

function lastListQuery(list: ReturnType<typeof fakeLibrary>["list"]): PhotoLibraryListQuery | undefined {
  return list.mock.calls.at(-1)?.[0];
}

/** 画面に出ている文字と、読み上げ名・title（クラウドの文言が無いことを見る） */
function visibleTextAndLabels(): string {
  const labels = Array.from(container.querySelectorAll("[aria-label],[title]")).map(
    (element) => `${element.getAttribute("aria-label") ?? ""} ${element.getAttribute("title") ?? ""}`,
  );
  return `${container.textContent ?? ""} ${labels.join(" ")}`;
}

const TRAVEL = folder("f1", "旅行", [folder("f1a", "京都")]);
const FAMILY = folder("f2", "家族");

beforeEach(() => {
  window.localStorage.clear();
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  Object.defineProperty(window, "innerWidth", { configurable: true, value: 1280 });
  mocks.confirm.mockReset();
  mocks.confirm.mockResolvedValue(true);
  mocks.createEngine.mockReset();
  mocks.createEngine.mockImplementation(() => ({
    ready: vi.fn(async () => false),
    dispose: vi.fn(),
    close: vi.fn(async () => undefined),
  }));
});

afterEach(async () => {
  await act(async () => root.unmount());
  client.clear();
  container.remove();
  Object.defineProperty(window, "innerWidth", { configurable: true, value: initialInnerWidth });
  window.localStorage.clear();
  vi.restoreAllMocks();
});

describe("この Mac のフォルダの面", () => {
  it("左の木は「この Mac」と「＋」の下にフォルダの木。最初の根を選び、一覧は folderId だけで読む", async () => {
    const fake = fakeLibrary({ tree: [TRAVEL, FAMILY], photos: { f1: [photo("p1", "IMG_0001.JPG")] } });
    await render(fake.library);

    expect(tree().querySelector("h3")?.textContent).toBe("この Mac");
    expect(byLabel("フォルダを追加", tree())).not.toBeNull();
    expect(folderRow("旅行")?.getAttribute("aria-current")).toBe("true");
    expect(folderRow("家族")?.getAttribute("aria-current")).toBeNull();
    // 子のあるフォルダは閉じて始まる（選んだフォルダの上の段だけ開く）
    expect(folderRow("京都")).toBeUndefined();
    expect(byLabel("旅行 を開く", tree())?.getAttribute("aria-expanded")).toBe("false");

    const query = lastListQuery(fake.list);
    expect(query?.folderId).toBe("f1");
    expect(query).not.toHaveProperty("hasOriginal");
    expect(query).not.toHaveProperty("favorite");
    expect(query).not.toHaveProperty("albumId");
    expect(tile("IMG_0001.JPG")).toBeDefined();
    // 狭い幅の上段（クラウドの場所の切り替え）は出さない
    expect(container.textContent).not.toContain("お気に入り");
    expect(container.textContent).not.toContain("記事の画像");
    // パンくずは「この Mac › <フォルダ名>」
    expect(getPhotoEditingBreadcrumbSnapshot()?.map((item) => item.label)).toEqual(["この Mac", "旅行"]);
  });

  it("行を押すとそのフォルダを選んで一覧を読み、選んだフォルダをこの端末に覚えて次はそこから始める", async () => {
    const fake = fakeLibrary({
      tree: [TRAVEL, FAMILY],
      photos: { f2: [photo("p2", "FAMILY.JPG")], f1a: [photo("p3", "KYOTO.JPG")] },
    });
    await render(fake.library);

    await click(folderRow("家族"));
    expect(lastListQuery(fake.list)?.folderId).toBe("f2");
    expect(folderRow("家族")?.getAttribute("aria-current")).toBe("true");
    expect(tile("FAMILY.JPG")).toBeDefined();

    await click(byLabel("旅行 を開く", tree()));
    expect(byLabel("旅行 を閉じる", tree())?.getAttribute("aria-expanded")).toBe("true");
    await click(folderRow("京都"));
    expect(lastListQuery(fake.list)?.folderId).toBe("f1a");
    expect(window.localStorage.getItem(browserPhotoLastFolderStorageKey("local"))).toBe("f1a");

    await remount(fake.library);
    expect(fake.list.mock.calls.every(([query]) => query.folderId !== undefined)).toBe(true);
    expect(lastListQuery(fake.list)?.folderId).toBe("f1a");
    // 覚えたフォルダが入れ子でも、上の段を開いて選んだ行を見せる
    expect(folderRow("京都")?.getAttribute("aria-current")).toBe("true");
    expect(tile("KYOTO.JPG")).toBeDefined();
  });

  it("並び（撮影日 / 最近追加）と絞り込みはフォルダでも使え、条件は一覧の問い合わせで渡す", async () => {
    const fake = fakeLibrary({ tree: [FAMILY], photos: { f2: [photo("p2", "FAMILY.JPG")] } });
    await render(fake.library);

    const added = Array.from(container.querySelectorAll<HTMLButtonElement>('[role="radiogroup"][aria-label="並び"] [role="radio"]')).find(
      (candidate) => candidate.textContent === "最近追加",
    );
    await click(added);
    expect(lastListQuery(fake.list)).toMatchObject({ folderId: "f2", sort: "added" });
    expect(byLabel("絞り込み")).not.toBeNull();
  });

  it("「＋」でフォルダを足すと、そのフォルダを選ぶ（ダイアログを閉じたら何もしない）", async () => {
    const fake = fakeLibrary({ tree: [FAMILY], added: null });
    await render(fake.library);

    await click(byLabel("フォルダを追加", tree()));
    expect(fake.folders.add).toHaveBeenCalledTimes(1);
    expect(folderRow("家族")?.getAttribute("aria-current")).toBe("true");

    const withAdded = fakeLibrary({ tree: [FAMILY], added: folder("f3", "新しいフォルダ") });
    await remount(withAdded.library);
    await click(byLabel("フォルダを追加", tree()));
    expect(withAdded.folders.add).toHaveBeenCalledTimes(1);
    expect(folderRow("新しいフォルダ")?.getAttribute("aria-current")).toBe("true");
    expect(lastListQuery(withAdded.list)?.folderId).toBe("f3");
    expect(withAdded.folders.tree.mock.calls.length).toBeGreaterThanOrEqual(2);
  });

  it("根の「⋯」の「一覧から外す」は確かめてから外し、選んでいたら最初のフォルダへ移る", async () => {
    const fake = fakeLibrary({ tree: [TRAVEL, FAMILY] });
    await render(fake.library);
    // 入れ子のフォルダには「⋯」を出さない
    await click(byLabel("旅行 を開く", tree()));
    expect(byLabel("京都 のメニュー", tree())).toBeNull();

    mocks.confirm.mockResolvedValueOnce(false);
    await click(byLabel("旅行 のメニュー", tree()));
    await click(Array.from(document.body.querySelectorAll('[role="menuitem"]')).find((item) => item.textContent === "一覧から外す"));
    expect(mocks.confirm).toHaveBeenCalledWith({
      title: "フォルダを一覧から外しますか？",
      description: "「旅行」を一覧から外します。フォルダと写真は消えません。",
      confirmLabel: "外す",
    });
    expect(fake.folders.forget).not.toHaveBeenCalled();

    await click(byLabel("旅行 のメニュー", tree()));
    await click(Array.from(document.body.querySelectorAll('[role="menuitem"]')).find((item) => item.textContent === "一覧から外す"));
    expect(fake.folders.forget).toHaveBeenCalledWith("f1");
    expect(folderRow("旅行")).toBeUndefined();
    expect(folderRow("家族")?.getAttribute("aria-current")).toBe("true");
    expect(lastListQuery(fake.list)?.folderId).toBe("f2");
  });

  it("外した後の木の読み直しに失敗しても、外したフォルダを古い木で残さず、次のフォルダを選んだままにする", async () => {
    const fake = fakeLibrary({ tree: [TRAVEL, FAMILY] });
    await render(fake.library);
    expect(folderRow("旅行")?.getAttribute("aria-current")).toBe("true");
    fake.folders.tree.mockRejectedValue(new Error("offline"));

    await click(byLabel("旅行 のメニュー", tree()));
    await click(Array.from(document.body.querySelectorAll('[role="menuitem"]')).find((item) => item.textContent === "一覧から外す"));

    expect(fake.folders.forget).toHaveBeenCalledWith("f1");
    expect(folderRow("旅行")).toBeUndefined();
    expect(folderRow("家族")?.getAttribute("aria-current")).toBe("true");
    expect(lastListQuery(fake.list)?.folderId).toBe("f2");
  });

  it("フォルダが 1 つも無いときは、中央に「フォルダを追加」の空状態を出し、一覧は読まない", async () => {
    const fake = fakeLibrary({ tree: [], added: folder("f9", "写真") });
    await render(fake.library);

    const center = container.querySelector('section[aria-label="写真の一覧"]') ?? container;
    expect(center.querySelector("h3")?.textContent).toBe("フォルダを追加");
    expect(center.textContent).toContain(
      "写真のあるフォルダを選ぶと、ここに並びます。元のファイルは動かさず、書き換えません。",
    );
    expect(fake.list).not.toHaveBeenCalled();
    expect(getPhotoEditingBreadcrumbSnapshot()?.map((item) => item.label)).toEqual(["この Mac"]);

    const primary = Array.from(center.querySelectorAll<HTMLButtonElement>("button")).find(
      (candidate) => candidate.textContent === "フォルダを追加",
    );
    await click(primary);
    expect(fake.folders.add).toHaveBeenCalledTimes(1);
    expect(lastListQuery(fake.list)?.folderId).toBe("f9");
  });

  it("写真の無いフォルダは 1 行だけ（クラウドの「写真を追加」の導線を出さない）", async () => {
    const fake = fakeLibrary({ tree: [FAMILY] });
    await render(fake.library);

    expect(container.textContent).toContain("このフォルダに写真はありません");
    expect(byLabel("写真を追加")).toBeNull();
    expect(Array.from(container.querySelectorAll("button")).some((button) => button.textContent === "写真を追加")).toBe(false);
  });
});

describe("置き場が「この Mac」のときのクラウドの文言と道具", () => {
  it("クラウドの文言・クラウドから消す・写真を足す・お気に入り・クラウドの印を出さず、消すキーも効かない", async () => {
    const fake = fakeLibrary({ tree: [FAMILY], photos: { f2: [photo("p2", "FAMILY.JPG"), photo("p4", "SEA.JPG")] } });
    await render(fake.library);
    await click(tile("FAMILY.JPG"));
    expect(tile("FAMILY.JPG")?.getAttribute("aria-pressed") ?? tile("FAMILY.JPG")?.getAttribute("aria-selected")).toBe("true");

    expect(visibleTextAndLabels()).not.toContain("クラウド");
    expect(byLabel("写真を追加")).toBeNull();
    expect(byLabel("お気に入り")).toBeNull();
    expect(container.querySelector('[aria-label="クラウドの写真"]')).toBeNull();

    await act(async () => {
      document.body.dispatchEvent(new KeyboardEvent("keydown", { key: "Delete", bubbles: true, cancelable: true }));
    });
    await settle();
    expect(mocks.confirm).not.toHaveBeenCalled();
    expect(fake.deletePhotos).not.toHaveBeenCalled();
  });

  it("Finder などから落としても受けない（幕を出さない）", async () => {
    const fake = fakeLibrary({ tree: [FAMILY], photos: { f2: [photo("p2", "FAMILY.JPG")] } });
    await render(fake.library);
    const section = container.querySelector("section");
    const dragEnter = new Event("dragenter", { bubbles: true, cancelable: true });
    Object.defineProperty(dragEnter, "dataTransfer", {
      value: { types: ["Files"], items: [], files: [], dropEffect: "none" },
    });
    await act(async () => {
      section?.dispatchEvent(dragEnter);
    });
    await settle();
    expect(container.textContent).not.toContain("ドロップして");
    expect(dragEnter.defaultPrevented).toBe(false);
  });
});

describe("クラウドの写真の出どころ", () => {
  it("フォルダの面を出さず、木は今までどおり「クラウド」の下に「写真」", async () => {
    const fake = fakeLibrary({ place: "cloud", cloudPhotos: [photo("c1", "CLOUD.JPG")] });
    await render(fake.library);

    expect(tree().textContent).toContain("クラウド");
    expect(tree().textContent).not.toContain("この Mac");
    expect(byLabel("フォルダを追加")).toBeNull();
    expect(byLabel("写真を追加", tree())).not.toBeNull();
    const query = lastListQuery(fake.list);
    expect(query).toMatchObject({ hasOriginal: true });
    expect(query).not.toHaveProperty("folderId");
    expect(getPhotoEditingBreadcrumbSnapshot()?.map((item) => item.label)).toEqual(["クラウド", "写真"]);
  });
});
