// @vitest-environment jsdom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { neutralDevelopSettings } from "../develop-engine/develop-settings";
import type { PhotoLibrary, PhotoLibraryItem, PhotoLibraryPhotoInfo } from "../library/photo-library";
import { PhotoLibraryProvider, type PhotoEditingHost } from "../library/photo-library-context";
import { NBSP, photoEditingInfoGroups } from "../photo-editing-info";

import { BrowserPhotoEditingAdjustments } from "./browser-photo-editing-adjustments";
import { BrowserPhotoEditingInfo, PhotoEditingInfoList } from "./browser-photo-editing-info";

/**
 * 右パネルの「情報」の面（niho-photo#43）。群ごとに見出しとラベル・値の 2 列（`dl`）で、読み上げはラベルと値を続けて読む。写真の
 * 情報は読める置き場（`capabilities.info`）だけ面を開いている間に読み、読めなければ写真の行のファイルの項目だけを出す。情報の面には
 * ↶ ↷ ⋯・「初期化」を出さず、ヒストグラムは一番上に残す。
 */

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLDivElement;
let root: Root;
let client: QueryClient;

const host: PhotoEditingHost = {
  notifyPhotosChanged: () => undefined,
  saveFile: async () => "saved",
  nativeFileSaveAvailable: () => false,
  isNativeViewport: () => false,
  isDesktopApp: () => true,
};

function photo(overrides: Partial<PhotoLibraryItem> = {}): PhotoLibraryItem {
  return {
    id: "e-raw",
    fileName: "DSC02072.ARW",
    fileExtension: "arw",
    sizeBytes: 24.3 * 1024 * 1024,
    contentSha256: null,
    createdAt: "2026-10-01T00:00:00.000Z",
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
    previewUrl: null,
    ...overrides,
  };
}

const INFO: PhotoLibraryPhotoInfo = {
  camera: { make: "SONY", model: "ILCE-7M4" },
  lens: "FE 35mm F1.8",
  iso: 400,
  exposureTimeSeconds: 1 / 250,
  fNumber: 2.8,
  focalLengthMm: 35,
  capturedAt: "2024-05-01T10:30:15",
  width: 7008,
  height: 4672,
  gps: null,
};

function fakeLibrary(info?: PhotoLibrary["info"]): PhotoLibrary {
  return { place: "local", ...(info ? { info } : {}) } as unknown as PhotoLibrary;
}

async function settle() {
  await act(async () => {
    for (let index = 0; index < 10; index += 1) await Promise.resolve();
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

async function renderInfo(library: PhotoLibrary, props: { photo?: PhotoLibraryItem; infoAvailable: boolean }) {
  await act(async () => {
    root.render(
      <QueryClientProvider client={client}>
        <PhotoLibraryProvider library={library} host={host}>
          <BrowserPhotoEditingInfo photo={props.photo ?? photo()} infoAvailable={props.infoAvailable} />
        </PhotoLibraryProvider>
      </QueryClientProvider>,
    );
  });
  await settle();
}

/** 群の見出しと、各行の dt・dd（読み上げの順） */
function groups(): Array<[string, string[]]> {
  return Array.from(container.querySelectorAll("section")).map((section) => [
    section.querySelector("h3")?.textContent ?? "",
    Array.from(section.querySelectorAll("dl > div")).map(
      // 数と単位の間の改行しない空白は、ふつうの空白として比べる
      (row) => `${row.querySelector("dt")?.textContent ?? ""} ${(row.querySelector("dd")?.textContent ?? "").replaceAll(NBSP, " ")}`,
    ),
  ]);
}

beforeEach(() => {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
});

afterEach(async () => {
  await act(async () => root.unmount());
  client.clear();
  container.remove();
});

describe("PhotoEditingInfoList", () => {
  it("群ごとに見出し（h3）で名前を付けた section と、ラベル（dt）と値（dd）の 2 列の dl", async () => {
    await act(async () => {
      root.render(<PhotoEditingInfoList groups={photoEditingInfoGroups(photo(), INFO)} />);
    });
    const sections = Array.from(container.querySelectorAll("section"));
    expect(sections).toHaveLength(3);
    for (const section of sections) {
      const heading = section.querySelector("h3");
      expect(heading?.id).toBeTruthy();
      expect(section.getAttribute("aria-labelledby")).toBe(heading?.id);
      const list = section.querySelector("dl");
      expect(list).not.toBeNull();
      // dl の行は div の中に dt と dd を 1 つずつ（読み上げは「ISO 400」のようにラベルと値を続けて読む）
      for (const row of Array.from(list?.children ?? [])) {
        expect(row.tagName).toBe("DIV");
        expect(Array.from(row.children).map((child) => child.tagName)).toEqual(["DT", "DD"]);
      }
    }
    expect(groups()[0]).toEqual(["撮影条件", ["ISO 400", "シャッター速度 1/250 秒", "絞り f/2.8", "焦点距離 35 mm"]]);
    // 長い値（レンズ・ファイル名）は折り返す
    expect(container.querySelector("dd")?.className).toContain("[overflow-wrap:anywhere]");
    expect(container.querySelector("dd")?.className).toContain("min-w-0");
  });

  it("群が無ければ見出しも dl も出さない", async () => {
    await act(async () => {
      root.render(<PhotoEditingInfoList groups={[]} />);
    });
    expect(container.querySelector("h3")).toBeNull();
    expect(container.querySelector("dl")).toBeNull();
  });
});

describe("BrowserPhotoEditingInfo", () => {
  it("写真の情報を読める置き場は、面を開いたときに 1 回読み、撮影条件・カメラ・レンズ・ファイルを出す", async () => {
    const info = vi.fn(async () => INFO);
    await renderInfo(fakeLibrary(info), { infoAvailable: true });
    expect(info).toHaveBeenCalledTimes(1);
    expect(info).toHaveBeenCalledWith("e-raw", expect.objectContaining({ signal: expect.any(AbortSignal) }));
    expect(groups()).toEqual([
      ["撮影条件", ["ISO 400", "シャッター速度 1/250 秒", "絞り f/2.8", "焦点距離 35 mm"]],
      ["カメラ・レンズ", ["カメラ SONY ILCE-7M4", "レンズ FE 35mm F1.8"]],
      [
        "ファイル",
        [
          "ファイル名 DSC02072.ARW",
          "形式 ARW",
          "大きさ 7008 × 4672（33 MP）",
          "ファイルの大きさ 24.3 MB",
          "撮影日時 2024年5月1日 10:30:15",
        ],
      ],
    ]);
  });

  it("読んでいる間は群を出さない（読めた群が上に足されて行が動かないように）", async () => {
    let resolve: (value: PhotoLibraryPhotoInfo) => void = () => undefined;
    const info = vi.fn(() => new Promise<PhotoLibraryPhotoInfo>((settleInfo) => (resolve = settleInfo)));
    await renderInfo(fakeLibrary(info), { infoAvailable: true });
    expect(container.querySelector('[aria-busy="true"]')).not.toBeNull();
    expect(container.querySelector("section")).toBeNull();
    await act(async () => resolve(INFO));
    await settle();
    expect(container.querySelector('[aria-busy="true"]')).toBeNull();
    expect(groups().map(([title]) => title)).toEqual(["撮影条件", "カメラ・レンズ", "ファイル"]);
  });

  it("読めない置き場（capabilities.info が false）は読まず、写真の行のファイルの項目だけ", async () => {
    const info = vi.fn(async () => INFO);
    await renderInfo(fakeLibrary(info), {
      infoAvailable: false,
      photo: photo({ fileName: "IMG_0001.JPG", fileExtension: "jpg", sizeBytes: 3 * 1024 * 1024, capturedAt: "2024-05-01T01:30:15.000Z" }),
    });
    expect(info).not.toHaveBeenCalled();
    expect(groups()).toEqual([
      ["ファイル", ["ファイル名 IMG_0001.JPG", "形式 JPEG", "ファイルの大きさ 3.0 MB", "撮影日時 2024年5月1日 10:30:15"]],
    ]);
    // 口の無い置き場も同じ
    await renderInfo(fakeLibrary(), { infoAvailable: true });
    expect(groups().map(([title]) => title)).toEqual(["ファイル"]);
  });

  it("読めない間は、同じ写真の前に読んだ値が残っていても出さない", async () => {
    const library = fakeLibrary(vi.fn(async () => INFO));
    await renderInfo(library, { infoAvailable: true });
    expect(groups().map(([title]) => title)).toEqual(["撮影条件", "カメラ・レンズ", "ファイル"]);
    await renderInfo(library, { infoAvailable: false });
    expect(groups().map(([title]) => title)).toEqual(["ファイル"]);
  });

  it("読めなかった（失敗・null）ときは失敗の 1 行を出さず、写真の行のファイルの項目だけ", async () => {
    await renderInfo(fakeLibrary(vi.fn(async () => Promise.reject(new Error("ImageIO failed")))), { infoAvailable: true });
    expect(groups()).toEqual([["ファイル", ["ファイル名 DSC02072.ARW", "形式 ARW", "ファイルの大きさ 24.3 MB"]]]);
    expect(container.textContent).not.toContain("ImageIO");
    await act(async () => root.unmount());
    root = createRoot(container);
    client.clear();
    await renderInfo(fakeLibrary(vi.fn(async () => null)), { infoAvailable: true });
    expect(groups()).toEqual([["ファイル", ["ファイル名 DSC02072.ARW", "形式 ARW", "ファイルの大きさ 24.3 MB"]]]);
  });

  it("写真を替えたら、その写真の情報を読み直す", async () => {
    const info = vi.fn(async (photoId: string) => (photoId === "e-raw" ? INFO : { ...INFO, iso: 100 }));
    const library = fakeLibrary(info);
    await renderInfo(library, { infoAvailable: true });
    await renderInfo(library, { infoAvailable: true, photo: photo({ id: "e-jpg", fileName: "DSC02073.JPG", fileExtension: "jpg" }) });
    expect(info.mock.calls.map(([photoId]) => photoId)).toEqual(["e-raw", "e-jpg"]);
    expect(groups()[0]?.[1][0]).toBe("ISO 100");
  });
});

describe("右パネルの情報の面（BrowserPhotoEditingAdjustments）", () => {
  type AdjustmentsProps = Parameters<typeof BrowserPhotoEditingAdjustments>[0];

  async function renderPanel(extra: Partial<AdjustmentsProps> = {}) {
    const props: AdjustmentsProps = {
      canEdit: false,
      canReset: true,
      resetDone: false,
      canUndo: true,
      canRedo: true,
      controlsDisabled: false,
      busy: false,
      work: { phase: "preparing", slow: false, checkedAt: 0 },
      raw: true,
      settings: neutralDevelopSettings(),
      clipboard: { canCopy: true, canPaste: true, onCopy: vi.fn(), onPaste: vi.fn() },
      panel: "info",
      info: <PhotoEditingInfoList groups={photoEditingInfoGroups(photo(), INFO)} />,
      onReset: vi.fn(),
      onUndo: vi.fn(),
      onRedo: vi.fn(),
      onRetryWork: vi.fn(),
      onSettingsChange: vi.fn(),
      ...extra,
    };
    await act(async () => {
      root.render(<BrowserPhotoEditingAdjustments {...props} />);
    });
  }

  it("見出し行は「情報」だけ。↶ ↷ ⋯・「初期化」・作業コピーの状態・閲覧のみの 1 行・補正の群は出さない", async () => {
    await renderPanel();
    const aside = container.querySelector<HTMLElement>('aside[aria-label="情報"]');
    if (!aside) throw new Error("info panel not found");
    expect(aside.className).toContain("hidden");
    expect(aside.className).toContain("lg:block");
    expect(aside.querySelector("h2")?.textContent).toBe("情報");
    expect(aside.querySelectorAll("button")).toHaveLength(0);
    expect(aside.querySelector('[role="status"]')).toBeNull();
    expect(aside.querySelector('input[type="range"]')).toBeNull();
    expect(aside.textContent).not.toContain("初期化");
    expect(groups().map(([title]) => title)).toEqual(["撮影条件", "カメラ・レンズ", "ファイル"]);
  });

  it("ヒストグラムは情報の面でも一番上（見出し行より上）に残す", async () => {
    await renderPanel({ histogram: <div data-testid="histogram" /> });
    const aside = container.querySelector<HTMLElement>('aside[aria-label="情報"]');
    const histogram = aside?.querySelector('[data-testid="histogram"]');
    expect(histogram).not.toBeNull();
    expect(histogram?.parentElement?.className).toContain("sticky");
    expect(aside?.firstElementChild).toBe(histogram?.parentElement);
    expect(histogram?.parentElement?.nextElementSibling?.querySelector("h2")?.textContent).toBe("情報");
  });

  it("切り抜きの道具の間・情報の中身を渡さないときは、情報の面にしない", async () => {
    await renderPanel({ tool: "crop", cropTools: <div data-testid="crop-tools" /> });
    expect(container.querySelector('aside[aria-label="情報"]')).toBeNull();
    expect(container.querySelector('[data-testid="crop-tools"]')).not.toBeNull();
    await renderPanel({ info: undefined });
    expect(container.querySelector('aside[aria-label="情報"]')).toBeNull();
    expect(container.querySelector('aside[aria-label="補正"] h2')?.textContent).toBe("補正");
  });
});
