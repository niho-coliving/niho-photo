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
import { createCloudMockClient } from "../cloud-sharing-contract";

import { BrowserPhotoEditingWorkbench, type BrowserPhotoCloudSharingBinding } from "./browser-photo-editing-workbench";
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
  /** 指定したときだけ「選んだ写真」を扱えるローカルライブラリにする。 */
  selected?: PhotoLibraryItem[];
  selectedAdded?: PhotoLibraryItem[];
  /** 指定したときだけ写真の情報を読める（`capabilities.info`。niho-photo#43） */
  info?: NonNullable<PhotoLibrary["info"]>;
  /** 補正の版の口（niho-photo#42）。`capability` を省くと `capabilities.versions` は true */
  versions?: {
    developVersions: NonNullable<PhotoLibrary["developVersions"]>;
    saveDevelopVersions: NonNullable<PhotoLibrary["saveDevelopVersions"]>;
    capability?: boolean;
  };
};

function fakeLibrary(options: FakeLibraryOptions = {}) {
  const place = options.place ?? "local";
  const state = { tree: options.tree ?? [], selected: options.selected ?? [] };
  const list = vi.fn(async (query: PhotoLibraryListQuery): Promise<PhotoLibraryListPage> => {
    const items =
      place === "cloud"
        ? (options.cloudPhotos ?? [])
        : query.localSource === "selected"
          ? state.selected
          : query.folderId
            ? (options.photos?.[query.folderId] ?? [])
            : [];
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
  const capabilities = {
    ...(place === "cloud" ? CLOUD_CAPABILITIES : LOCAL_CAPABILITIES),
    ...(options.info ? { info: true } : {}),
    ...(options.versions ? { versions: options.versions.capability ?? true } : {}),
  };
  const deletePhotos = vi.fn(async () => ({ deleted: [], errors: [] }));
  const selectedPhotos = {
    count: vi.fn(async () => state.selected.length),
    add: vi.fn(async () => {
      const added = options.selectedAdded ?? [];
      if (added.length > 0) state.selected = [...added, ...state.selected.filter((item) => !added.some(({ id }) => id === item.id))];
      return added;
    }),
    forget: vi.fn(async () => {
      state.selected = [];
    }),
  };
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
    ...(options.info ? { info: options.info } : {}),
    ...(options.versions
      ? { developVersions: options.versions.developVersions, saveDevelopVersions: options.versions.saveDevelopVersions }
      : {}),
    ...(place === "local" ? { folders } : {}),
    ...(place === "local" && (options.selected !== undefined || options.selectedAdded !== undefined) ? { selectedPhotos } : {}),
  } as unknown as PhotoLibrary;
  return { library, list, folders, selectedPhotos, state, deletePhotos };
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

type WorkbenchExtraProps = Partial<Parameters<typeof BrowserPhotoEditingWorkbench>[0]>;

type WorkbenchRenderOptions = WorkbenchExtraProps | BrowserPhotoCloudSharingBinding;

async function render(library: PhotoLibrary, options: WorkbenchRenderOptions = {}) {
  const extra: WorkbenchExtraProps = "client" in options ? { cloudSharing: options } : options;
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
            {...extra}
          />
        </PhotoLibraryProvider>
      </QueryClientProvider>,
    );
  });
  await settle();
}

async function remount(library: PhotoLibrary, extra: WorkbenchExtraProps = {}) {
  await act(async () => root.unmount());
  client.clear();
  client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  root = createRoot(container);
  await render(library, extra);
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

  it("写真選択に対応したときだけ追加メニューと「選んだ写真」を出し、cancel は場所を変えない", async () => {
    const picked = photo("picked", "PICKED.JPG");
    const fake = fakeLibrary({ tree: [FAMILY], selected: [], selectedAdded: [] });
    await render(fake.library);

    expect(byLabel("フォルダを追加", tree())).toBeNull();
    await click(byLabel("フォルダや写真を追加", tree()));
    expect(Array.from(document.body.querySelectorAll('[role="menuitem"]')).map((item) => item.textContent)).toEqual([
      "フォルダを追加",
      "写真を選ぶ",
    ]);
    await click(Array.from(document.body.querySelectorAll('[role="menuitem"]')).find((item) => item.textContent === "写真を選ぶ"));
    expect(fake.selectedPhotos.add).toHaveBeenCalledTimes(1);
    expect(lastListQuery(fake.list)?.folderId).toBe("f2");
    expect(tree().textContent).not.toContain("選んだ写真");

    const withPhoto = fakeLibrary({ tree: [FAMILY], selected: [], selectedAdded: [picked] });
    await remount(withPhoto.library);
    await click(byLabel("フォルダや写真を追加", tree()));
    await click(Array.from(document.body.querySelectorAll('[role="menuitem"]')).find((item) => item.textContent === "写真を選ぶ"));
    expect(lastListQuery(withPhoto.list)).toMatchObject({ localSource: "selected" });
    expect(lastListQuery(withPhoto.list)).not.toHaveProperty("folderId");
    expect(tile("PICKED.JPG")).toBeDefined();
    expect(tree().textContent).toContain("選んだ写真1");
    expect(getPhotoEditingBreadcrumbSnapshot()?.map((item) => item.label)).toEqual(["この Mac", "選んだ写真"]);
    expect(window.localStorage.getItem(browserPhotoLastFolderStorageKey("local"))).toBe("source:selected");

    await remount(withPhoto.library);
    expect(lastListQuery(withPhoto.list)).toMatchObject({ localSource: "selected" });
    withPhoto.state.selected = [];
    await remount(withPhoto.library);
    expect(lastListQuery(withPhoto.list)?.folderId).toBe("f2");
    expect(tree().textContent).not.toContain("選んだ写真");
  });

  it("folder-only adapter では従来の単独ボタンと空状態を保つ", async () => {
    const fake = fakeLibrary({ tree: [] });
    await render(fake.library);
    expect(byLabel("フォルダを追加", tree())).not.toBeNull();
    expect(byLabel("フォルダや写真を追加", tree())).toBeNull();
    expect(container.textContent).not.toContain("写真を選ぶ");
    expect(container.querySelector('section[aria-label="写真の一覧"]')?.querySelector("h3")?.textContent).toBe("フォルダを追加");
  });

  it("選んだ写真の読み込みに失敗しても、再読み込みで場所と写真を復元できる", async () => {
    const fake = fakeLibrary({ tree: [], selected: [photo("picked", "PICKED.JPG")] });
    fake.selectedPhotos.count.mockRejectedValueOnce(new Error("unavailable"));
    window.localStorage.setItem(browserPhotoLastFolderStorageKey("local"), "source:selected");
    await render(fake.library);
    expect(fake.list).not.toHaveBeenCalled();

    const center = container.querySelector('section[aria-label="写真の一覧"]') ?? container;
    await click(Array.from(center.querySelectorAll("button")).find((button) => button.textContent === "もう一度読み込む"));
    expect(lastListQuery(fake.list)).toMatchObject({ localSource: "selected" });
    expect(tile("PICKED.JPG")).toBeDefined();
  });

  it("写真選択に対応した初期状態はフォルダと写真の両方を選べる", async () => {
    const fake = fakeLibrary({ tree: [], selected: [], selectedAdded: [] });
    await render(fake.library);
    const center = container.querySelector('section[aria-label="写真の一覧"]') ?? container;
    expect(center.textContent).toContain("フォルダや写真を追加すると、ここで編集できます。");
    await click(Array.from(center.querySelectorAll("button")).find((button) => button.textContent === "フォルダや写真を追加"));
    expect(Array.from(document.body.querySelectorAll('[role="menuitem"]')).map((item) => item.textContent)).toEqual([
      "フォルダを追加",
      "写真を選ぶ",
    ]);
  });

  it("「選んだ写真」は確認後に参照だけを外してフォルダへ戻る", async () => {
    const fake = fakeLibrary({ tree: [FAMILY], selected: [photo("picked", "PICKED.JPG")] });
    window.localStorage.setItem(browserPhotoLastFolderStorageKey("local"), "source:selected");
    await render(fake.library);
    expect(lastListQuery(fake.list)).toMatchObject({ localSource: "selected" });

    mocks.confirm.mockResolvedValueOnce(false);
    await click(byLabel("選んだ写真のメニュー", tree()));
    await click(Array.from(document.body.querySelectorAll('[role="menuitem"]')).find((item) => item.textContent === "一覧から外す"));
    expect(mocks.confirm).toHaveBeenCalledWith({
      title: "選んだ写真を一覧から外しますか？",
      description: "選んだ写真を一覧から外します。元の写真、フォルダ、保存した補正は消えません。",
      confirmLabel: "一覧から外す",
    });
    expect(fake.selectedPhotos.forget).not.toHaveBeenCalled();

    await click(byLabel("選んだ写真のメニュー", tree()));
    await click(Array.from(document.body.querySelectorAll('[role="menuitem"]')).find((item) => item.textContent === "一覧から外す"));
    expect(fake.selectedPhotos.forget).toHaveBeenCalledTimes(1);
    expect(lastListQuery(fake.list)?.folderId).toBe("f2");
    expect(tree().textContent).not.toContain("選んだ写真");
  });

  it("参照を外せなかった場合は選んだ写真を残してエラーを表示する", async () => {
    const fake = fakeLibrary({ tree: [FAMILY], selected: [photo("picked", "PICKED.JPG")] });
    fake.selectedPhotos.forget.mockRejectedValueOnce(new Error("unavailable"));
    window.localStorage.setItem(browserPhotoLastFolderStorageKey("local"), "source:selected");
    await render(fake.library);
    await click(byLabel("選んだ写真のメニュー", tree()));
    await click(Array.from(document.body.querySelectorAll('[role="menuitem"]')).find((item) => item.textContent === "一覧から外す"));
    expect(fake.state.selected).toHaveLength(1);
    expect(tree().textContent).toContain("選んだ写真1");
    expect(container.textContent).toContain("選んだ写真を一覧から外せませんでした");
  });
});

describe("1 枚の下のフィルムストリップ（L5 #54）", () => {
  const STRIP_PHOTOS = [photo("p1", "ONE.JPG"), photo("p2", "TWO.JPG"), photo("p3", "THREE.JPG")];

  function filmstrip(): HTMLElement | null {
    return container.querySelector<HTMLElement>('nav[aria-label="この一覧の写真"]');
  }

  function stripTile(fileName: string): HTMLButtonElement | undefined {
    return filmstrip()?.querySelector<HTMLButtonElement>(`button[aria-label="${fileName}"]`) ?? undefined;
  }

  /** 帯で開いている写真（印の付いた升の写真名） */
  function openedInStrip(): string | null {
    return filmstrip()?.querySelector('button[aria-current="true"]')?.getAttribute("aria-label") ?? null;
  }

  function gridOrder(): string[] {
    return Array.from(container.querySelectorAll<HTMLButtonElement>('section[aria-label="写真の一覧"] li > button')).map(
      (button) => button.title,
    );
  }

  async function openFromGrid(fileName: string) {
    const target = tile(fileName);
    if (!target) throw new Error(`tile not found: ${fileName}`);
    await act(async () => {
      target.dispatchEvent(new MouseEvent("dblclick", { bubbles: true, cancelable: true }));
    });
    await settle();
  }

  async function keyDown(target: EventTarget, init: KeyboardEventInit) {
    await act(async () => {
      target.dispatchEvent(new KeyboardEvent("keydown", { bubbles: true, cancelable: true, ...init }));
    });
    await settle();
  }

  it("一覧では出さず、1 枚で開くと面の下に一覧と同じ並びで出る。升を押すとその写真に替わり、一覧に戻ると消える", async () => {
    const fake = fakeLibrary({ tree: [FAMILY], photos: { f2: STRIP_PHOTOS } });
    await render(fake.library);
    const order = gridOrder();
    expect(order).toHaveLength(3);
    expect(filmstrip()).toBeNull();

    await openFromGrid(order[0]);
    expect(container.querySelector('section[aria-label="写真の一覧"]')).toBeNull();
    expect(Array.from(filmstrip()?.querySelectorAll("button") ?? []).map((button) => button.getAttribute("aria-label"))).toEqual(order);
    expect(openedInStrip()).toBe(order[0]);
    // 面と帯は中央の列の縦の並び（面が伸び、帯はその下）
    expect(filmstrip()?.previousElementSibling?.className).toContain("flex-1");

    await click(stripTile(order[2]));
    expect(openedInStrip()).toBe(order[2]);
    expect(filmstrip()).not.toBeNull();

    await keyDown(document.body, { key: "g" });
    expect(filmstrip()).toBeNull();
    expect(gridOrder()).toEqual(order);
  });

  it("← → で前後の写真へ移る（帯の升の上でも同じ）。文字を打つ欄・変換中は扱わない", async () => {
    const fake = fakeLibrary({ tree: [FAMILY], photos: { f2: STRIP_PHOTOS } });
    await render(fake.library);
    const order = gridOrder();
    await openFromGrid(order[0]);

    await keyDown(document.body, { key: "ArrowRight" });
    expect(openedInStrip()).toBe(order[1]);
    await keyDown(document.body, { key: "ArrowLeft" });
    expect(openedInStrip()).toBe(order[0]);

    const current = stripTile(order[0]);
    if (!current) throw new Error("strip tile not found");
    await keyDown(current, { key: "ArrowRight" });
    expect(openedInStrip()).toBe(order[1]);

    await keyDown(document.body, { key: "ArrowRight", isComposing: true });
    expect(openedInStrip()).toBe(order[1]);

    const text = document.createElement("input");
    text.type = "text";
    container.querySelector('section[aria-label="ブラウザ写真編集"]')?.appendChild(text);
    await keyDown(text, { key: "ArrowRight" });
    expect(openedInStrip()).toBe(order[1]);
    text.remove();
  });

  it("狭い幅では 1 枚で開いても出さない", async () => {
    Object.defineProperty(window, "innerWidth", { configurable: true, value: 800 });
    const fake = fakeLibrary({ tree: [FAMILY], photos: { f2: STRIP_PHOTOS } });
    await render(fake.library);
    await click(tile(gridOrder()[0]));
    expect(container.querySelector('section[aria-label="写真の一覧"]')).toBeNull();
    expect(filmstrip()).toBeNull();
  });
});

describe("NIHO photo の窓いっぱいの見た目（appearance・treeHidden・treeFooter。niho-photo#50）", () => {
  it("既定（card）は web の角丸の枠と固定の高さのまま、左の木の底には何も出さない", async () => {
    const fake = fakeLibrary({ tree: [TRAVEL], photos: { f1: [photo("p1", "IMG_0001.JPG")] } });
    await render(fake.library);
    const surface = container.querySelector('section[aria-label="ブラウザ写真編集"]');
    expect(surface?.className).toContain("rounded-2xl");
    expect(surface?.className).not.toContain("flex-1");
    expect(surface?.querySelector(".grid")?.className).toContain("lg:h-[calc(100dvh-12rem)]");
    expect(tree().textContent).not.toContain("版");
  });

  it("fill は枠と固定の高さを付けず親の高さに合わせ、木の底に 1 行、treeHidden で木を出さない", async () => {
    const fake = fakeLibrary({ tree: [TRAVEL], photos: { f1: [photo("p1", "IMG_0001.JPG")] } });
    await render(fake.library, { appearance: "fill", treeFooter: <span>版 1.2.3</span> });
    const surface = container.querySelector('section[aria-label="ブラウザ写真編集"]');
    expect(surface?.className).toContain("flex-1");
    expect(surface?.className).not.toContain("rounded-2xl");
    const grid = surface?.querySelector(".grid");
    expect(grid?.className).not.toContain("lg:h-[calc(100dvh-12rem)]");
    expect(grid?.className).toContain("flex-1");
    expect(grid?.className).toContain("lg:grid-cols-[14rem_minmax(0,1fr)]");
    expect(tree().textContent).toContain("版 1.2.3");

    await remount(fake.library, { appearance: "fill", treeHidden: true });
    expect(container.querySelector('aside[aria-label="写真の場所"]')).toBeNull();
    expect(container.querySelector('section[aria-label="ブラウザ写真編集"] .grid')?.className).toContain("lg:grid-cols-[minmax(0,1fr)]");
    // 一覧はそのまま読めている
    expect(tile("IMG_0001.JPG")).toBeDefined();
  });

  it("PC の幅では下段を中央の列の下だけに置き、左の木は 2 段を貫いて窓の底まで伸ばす（Lightroom の並び。niho-photo#49）", async () => {
    const fake = fakeLibrary({ tree: [TRAVEL], photos: { f1: [photo("p1", "IMG_0001.JPG")] } });
    await render(fake.library, { appearance: "fill", treeFooter: <span>版 1.2.3</span> });
    const footer = () => container.querySelector("footer");
    // 狭い幅は全幅のまま
    expect(footer()?.className).toContain("col-span-full");
    expect(footer()?.className).toContain("lg:col-span-1");
    expect(footer()?.className).toContain("lg:col-start-2");
    expect(footer()?.className).toContain("lg:max-xl:flex-wrap");
    expect(container.querySelector('section[aria-label="ブラウザ写真編集"] .grid')?.className).toContain(
      "grid-rows-[minmax(0,1fr)_auto]",
    );
    expect(tree().className).toContain("lg:row-span-2");

    await remount(fake.library, { appearance: "fill", treeHidden: true });
    expect(footer()?.className).toContain("lg:col-start-1");
  });
});

describe("右端の道具の帯（niho-photo#51）", () => {
  it("1 枚で見ると右パネルの右に帯を置き、「プリセット」「補正」で右パネルを丸ごと入れ替える（写真を開いている途中でも）", async () => {
    // wasm の用意が終わらない（開いている途中のまま）。段 2 を使えないとは分からないので、プリセットを出せる
    mocks.createEngine.mockImplementation(() => ({
      ready: vi.fn(() => new Promise<boolean>(() => undefined)),
      dispose: vi.fn(),
      close: vi.fn(async () => undefined),
    }));
    const fake = fakeLibrary({ tree: [TRAVEL], photos: { f1: [photo("p1", "IMG_0001.JPG")] } });
    await render(fake.library);
    expect(container.querySelector('nav[aria-label="道具"]')).toBeNull();
    const target = tile("IMG_0001.JPG");
    if (!target) throw new Error("tile not found");
    await act(async () => {
      target.dispatchEvent(new MouseEvent("dblclick", { bubbles: true, cancelable: true }));
    });
    await settle();

    const grid = container.querySelector('section[aria-label="ブラウザ写真編集"] .grid');
    expect(grid?.className).toContain("lg:grid-cols-[14rem_minmax(0,1fr)_15.5rem_2.75rem]");
    const rail = container.querySelector<HTMLElement>('nav[aria-label="道具"]');
    if (!rail) throw new Error("tool rail not found");
    // 右パネルの直後の兄弟（grid の 4 列目）
    expect(rail.previousElementSibling?.matches('aside[aria-label="補正"]')).toBe(true);
    // 右パネルと帯は 2 段（面と下段）を貫いて窓の底まで、下段は中央の列の下だけ（niho-photo#49）
    expect(rail.className).toContain("lg:row-span-2");
    expect(rail.previousElementSibling?.className).toContain("lg:row-span-2");
    expect(container.querySelector("footer")?.className).toContain("lg:col-start-2");
    // 切り抜き・背景除去を使えない写真は、プリセット・補正・情報を表示する（niho-photo#43）
    expect(Array.from(rail.querySelectorAll("button")).map((button) => button.getAttribute("aria-label"))).toEqual([
      "プリセット",
      "補正",
      "情報",
    ]);
    const panelHeading = () => container.querySelector('aside[aria-label="補正"] h2')?.textContent;
    expect(panelHeading()).toBe("補正");
    expect(byLabel("補正", rail)?.getAttribute("aria-pressed")).toBe("true");
    expect(byLabel("プリセットの一覧")).not.toBeNull();
    // 道具の切り替えのピルは無い
    expect(container.querySelector('[aria-label="編集の道具"]')).toBeNull();

    await click(byLabel("プリセット", rail));
    expect(panelHeading()).toBe("プリセット");
    expect(byLabel("プリセット", rail)?.getAttribute("aria-pressed")).toBe("true");
    expect(byLabel("補正", rail)?.getAttribute("aria-pressed")).toBe("false");
    expect(byLabel("プリセットの一覧")).toBeNull();
    expect(container.querySelector('aside[aria-label="補正"] input[type="range"]')).toBeNull();

    await click(byLabel("補正", rail));
    expect(panelHeading()).toBe("補正");
    expect(container.querySelector('aside[aria-label="補正"] input[type="range"]')).not.toBeNull();

    // プリセットの行の一覧のボタンからも、プリセットの面を開く
    await click(byLabel("プリセットの一覧"));
    expect(panelHeading()).toBe("プリセット");
  });

  it("「情報」は帯の下端。押すと右パネルが情報の面になり、もう一度押すと補正の面へ戻る（niho-photo#43）", async () => {
    mocks.createEngine.mockImplementation(() => ({
      ready: vi.fn(() => new Promise<boolean>(() => undefined)),
      dispose: vi.fn(),
      close: vi.fn(async () => undefined),
    }));
    const info = vi.fn(async () => ({
      camera: { make: "SONY", model: "ILCE-7M4" },
      iso: 400,
      exposureTimeSeconds: 1 / 250,
      width: 6000,
      height: 4000,
    }));
    const fake = fakeLibrary({ tree: [TRAVEL], photos: { f1: [photo("p1", "IMG_0001.JPG")] }, info });
    await render(fake.library);
    // 1 枚も開いていない（一覧の）間は、帯も「情報」も出さない
    expect(byLabel("情報")).toBeNull();
    const target = tile("IMG_0001.JPG");
    if (!target) throw new Error("tile not found");
    await act(async () => {
      target.dispatchEvent(new MouseEvent("dblclick", { bubbles: true, cancelable: true }));
    });
    await settle();

    const rail = container.querySelector<HTMLElement>('nav[aria-label="道具"]');
    if (!rail) throw new Error("tool rail not found");
    const infoButton = byLabel("情報", rail);
    expect(infoButton?.className).toContain("mt-auto");
    expect(infoButton?.getAttribute("aria-pressed")).toBe("false");
    // 面を開くまでは読まない
    expect(info).not.toHaveBeenCalled();

    await click(infoButton);
    const infoPanel = container.querySelector<HTMLElement>('aside[aria-label="情報"]');
    if (!infoPanel) throw new Error("info panel not found");
    expect(infoPanel.querySelector("h2")?.textContent).toBe("情報");
    expect(byLabel("情報", rail)?.getAttribute("aria-pressed")).toBe("true");
    expect(byLabel("補正", rail)?.getAttribute("aria-pressed")).toBe("false");
    expect(info).toHaveBeenCalledWith("p1", expect.objectContaining({ signal: expect.any(AbortSignal) }));
    const rows = Array.from(infoPanel.querySelectorAll("dl > div")).map(
      (row) => `${row.querySelector("dt")?.textContent} ${row.querySelector("dd")?.textContent?.replaceAll("\u00a0", " ")}`,
    );
    expect(rows).toEqual([
      "ISO 400",
      "シャッター速度 1/250 秒",
      "カメラ SONY ILCE-7M4",
      "ファイル名 IMG_0001.JPG",
      "形式 JPEG",
      "大きさ 6000 × 4000（24 MP）",
      "ファイルの大きさ 1 KB",
      "撮影日時 2026年10月1日 9:00:00",
    ]);
    // 情報の面には ↶ ↷ を出さず、補正の群も出さない
    expect(byLabel("取り消す", infoPanel)).toBeNull();
    expect(infoPanel.querySelector('input[type="range"]')).toBeNull();

    // もう一度押すと補正の面へ戻る
    await click(byLabel("情報", rail));
    expect(container.querySelector('aside[aria-label="情報"]')).toBeNull();
    expect(container.querySelector('aside[aria-label="補正"] h2')?.textContent).toBe("補正");
    expect(byLabel("補正", rail)?.getAttribute("aria-pressed")).toBe("true");
    expect(byLabel("情報", rail)?.getAttribute("aria-pressed")).toBe("false");
  });

  it("「版」は版を残せる置き場だけ上の道具の末尾に置き、押すと右パネルが版の面になり、もう一度押すと補正の面へ戻る（niho-photo#42）", async () => {
    mocks.createEngine.mockImplementation(() => ({
      ready: vi.fn(() => new Promise<boolean>(() => undefined)),
      dispose: vi.fn(),
      close: vi.fn(async () => undefined),
    }));
    const developVersions = vi.fn(async () => ({
      versions: [
        {
          id: "v1",
          name: "明るめ",
          createdAt: "2026-10-21T01:32:00.000Z",
          kind: "named" as const,
          developSettings: { v: 1 as const, engine: "niho-10", base: null, exposure: 0.8 },
        },
      ],
      revision: 1,
    }));
    const saveDevelopVersions = vi.fn(async () => ({ kind: "saved" as const, versions: [], revision: 2 }));
    const openFirstPhoto = async () => {
      const target = tile("IMG_0001.JPG");
      if (!target) throw new Error("tile not found");
      await act(async () => {
        target.dispatchEvent(new MouseEvent("dblclick", { bubbles: true, cancelable: true }));
      });
      await settle();
      const found = container.querySelector<HTMLElement>('nav[aria-label="道具"]');
      if (!found) throw new Error("tool rail not found");
      return found;
    };

    // 口があっても `capabilities.versions` が false の置き場には出さない（fail closed）
    const closed = fakeLibrary({
      tree: [TRAVEL],
      photos: { f1: [photo("p1", "IMG_0001.JPG")] },
      versions: { developVersions, saveDevelopVersions, capability: false },
    });
    await render(closed.library);
    expect(byLabel("版", await openFirstPhoto())).toBeNull();

    const fake = fakeLibrary({
      tree: [TRAVEL],
      photos: { f1: [photo("p1", "IMG_0001.JPG")] },
      versions: { developVersions, saveDevelopVersions },
    });
    await remount(fake.library);
    // 1 枚も開いていない（一覧の）間は出さない
    expect(byLabel("版")).toBeNull();
    const rail = await openFirstPhoto();
    expect(Array.from(rail.querySelectorAll("button")).map((button) => button.getAttribute("aria-label"))).toEqual([
      "プリセット",
      "補正",
      "版",
      "情報",
    ]);
    const versionsButton = byLabel("版", rail);
    expect(versionsButton?.className).not.toContain("mt-auto");
    expect(versionsButton?.getAttribute("aria-pressed")).toBe("false");
    // 面を開くまでは読まない
    expect(developVersions).not.toHaveBeenCalled();

    await click(versionsButton);
    const face = container.querySelector<HTMLElement>('aside[aria-label="版"]');
    if (!face) throw new Error("versions face not found");
    expect(face.querySelector("h2")?.textContent).toBe("版");
    expect(byLabel("版", rail)?.getAttribute("aria-pressed")).toBe("true");
    expect(byLabel("補正", rail)?.getAttribute("aria-pressed")).toBe("false");
    expect(developVersions).toHaveBeenCalledWith("p1", expect.objectContaining({ signal: expect.any(AbortSignal) }));
    expect(face.querySelector('ul[aria-label="版の一覧"]')?.textContent).toContain("明るめ");
    // 写真を開いている途中（直せない間）は、切り替え・作成を押せない。版の面には ↶ ↷ を出す（押せない）が、補正の群は出さない
    const createButton = Array.from(face.querySelectorAll("button")).find(
      (button) => button.textContent?.trim() === "今の補正を版にする",
    );
    expect(createButton?.disabled).toBe(true);
    expect(byLabel("取り消す", face)?.disabled).toBe(true);
    expect(byLabel("やり直す", face)?.disabled).toBe(true);
    expect(face.querySelector('input[type="range"]')).toBeNull();
    expect(saveDevelopVersions).not.toHaveBeenCalled();

    // もう一度押すと補正の面へ戻る
    await click(byLabel("版", rail));
    expect(container.querySelector('aside[aria-label="版"]')).toBeNull();
    expect(container.querySelector('aside[aria-label="補正"] h2')?.textContent).toBe("補正");
    expect(byLabel("補正", rail)?.getAttribute("aria-pressed")).toBe("true");
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
    // Optional trusted host binding が無い production boundary では共有能力を見せない。
    expect(Array.from(container.querySelectorAll("button")).some((button) => button.textContent === "共有")).toBe(false);
  });

  it("trusted host binding を明示したときだけ、選んだクラウド写真に共有操作を出す", async () => {
    const fake = fakeLibrary({ place: "cloud", cloudPhotos: [photo("c1", "CLOUD.JPG")] });
    const cloudSharing: BrowserPhotoCloudSharingBinding = {
      client: createCloudMockClient(),
      access: "unavailable",
      selectResource: () => ({
        resourceType: "photo",
        resourceId: "server-photo-c1",
        ownerType: "user",
        ownerId: "server-owner",
        tenantId: "server-tenant",
        workspaceId: null,
      }),
    };
    await render(fake.library, cloudSharing);
    await click(tile("CLOUD.JPG"));
    const shareButton = Array.from(container.querySelectorAll<HTMLButtonElement>("button")).find(
      (candidate) => candidate.textContent === "共有",
    );
    expect(shareButton?.disabled).toBe(true);

    await render(fake.library, { ...cloudSharing, access: "available" });
    const enabledShareButton = Array.from(container.querySelectorAll<HTMLButtonElement>("button")).find(
      (candidate) => candidate.textContent === "共有",
    );
    expect(enabledShareButton?.disabled).toBe(false);
  });
});
