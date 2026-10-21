// @vitest-environment jsdom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { PhotoEditingBuiltinPreset } from "../photo-editing-types";
import type { PhotoLibrary, PhotoLibraryPreset } from "../library/photo-library";
import { PhotoLibraryProvider, type PhotoEditingHost } from "../library/photo-library-context";

import { PhotoEditingPresetsPanel, builtinPhotoPresetKey, spotPhotoPresetKey } from "./photo-editing-presets-panel";

/**
 * プリセットパネルの描き方（niho-photo#51）。`row` は補正の面の 1 行（「プリセット」・今のプリセット名・一覧のボタンだけ）、`panel` は
 * プリセットの面いっぱいの一覧（折りたたみの見出しを出さない）。既定の `section`（NIHO Desktop・スマホ）は今のまま。
 */

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const BUILTINS: PhotoEditingBuiltinPreset[] = [
  { id: "niho-bluesky2", name: "bluesky2", xmp: "<x:xmpmeta />" },
  { id: "niho-pastel", name: "pastel", xmp: "<x:xmpmeta />" },
];
const SPOT_PRESETS: PhotoLibraryPreset[] = [
  { id: "sp1", name: "夕暮れ", xmp: "<x:xmpmeta />", source: "user", createdAt: "2026-10-01T00:00:00.000Z" },
];

const host: PhotoEditingHost = {
  notifyPhotosChanged: () => undefined,
  saveFile: async () => "saved",
  nativeFileSaveAvailable: () => false,
  isNativeViewport: () => false,
  isDesktopApp: () => false,
};

function fakeLibrary(): PhotoLibrary {
  return {
    presets: {
      nameMaxChars: 100,
      xmpMaxBytes: 1024 * 1024,
      list: vi.fn(async () => SPOT_PRESETS),
      create: vi.fn(),
      delete: vi.fn(),
      rename: vi.fn(),
      isNameTaken: () => false,
      describeError: (_error: unknown, fallback: string) => fallback,
    },
    errors: { describeNative: () => "" },
  } as unknown as PhotoLibrary;
}

type PanelProps = Parameters<typeof PhotoEditingPresetsPanel>[0];

let container: HTMLDivElement;
let root: Root;
let client: QueryClient;

async function settle() {
  for (let round = 0; round < 3; round += 1) {
    await act(async () => {
      for (let index = 0; index < 8; index += 1) await Promise.resolve();
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
  }
}

async function render(extra: Partial<PanelProps> = {}) {
  const props: PanelProps = {
    spotId: "spot-1",
    canEdit: true,
    builtinPresets: { queryKey: ["test", "builtin-presets"], load: async () => BUILTINS },
    canApply: true,
    appliedPresetKey: null,
    applyingPresetKey: null,
    applyError: null,
    onApply: vi.fn(),
    none: { canClear: false, onClear: vi.fn() },
    readPreset: vi.fn(async () => ({ name: "", unsupported: [] })),
    ...extra,
  };
  await act(async () => {
    root.render(
      <QueryClientProvider client={client}>
        <PhotoLibraryProvider library={fakeLibrary()} host={host}>
          <PhotoEditingPresetsPanel {...props} />
        </PhotoLibraryProvider>
      </QueryClientProvider>,
    );
  });
  await settle();
}

function buttons(): HTMLButtonElement[] {
  return Array.from(container.querySelectorAll<HTMLButtonElement>("button"));
}

function byLabel(label: string): HTMLButtonElement | null {
  return container.querySelector<HTMLButtonElement>(`button[aria-label="${label}"]`);
}

async function click(element: Element | null) {
  if (!element) throw new Error("element not found");
  await act(async () => {
    element.dispatchEvent(new MouseEvent("click", { bubbles: true }));
  });
}

beforeEach(() => {
  window.localStorage.clear();
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
});

afterEach(async () => {
  await act(async () => root.unmount());
  client.clear();
  container.remove();
  window.localStorage.clear();
});

describe("variant: row（補正の面の 1 行）", () => {
  it("「プリセット」・今のプリセット名・一覧のボタンだけを描き、どちらのボタンも onOpenPanel を呼ぶ", async () => {
    const onOpenPanel = vi.fn();
    await render({ variant: "row", onOpenPanel });
    expect(container.textContent).toBe("プリセットなし");
    expect(buttons().map((candidate) => candidate.getAttribute("aria-label"))).toEqual(["プリセット: なし", "プリセットの一覧"]);
    // 一覧・取り込みの「⋯」・ファイルの入力は描かない
    expect(container.querySelector("ul")).toBeNull();
    expect(byLabel("プリセットの操作")).toBeNull();
    expect(container.querySelector('[data-testid="photo-editing-preset-file-input"]')).toBeNull();
    expect(container.querySelector("h4")).toBeNull();

    await click(byLabel("プリセット: なし"));
    await click(byLabel("プリセットの一覧"));
    expect(onOpenPanel).toHaveBeenCalledTimes(2);
  });

  it("当てている同梱のプリセットは日本語の名前、拠点のプリセットはその名前を出す", async () => {
    await render({ variant: "row", appliedPresetKey: builtinPhotoPresetKey("niho-bluesky2") });
    expect(byLabel("プリセット: 青空")?.textContent).toBe("青空");

    await render({ variant: "row", appliedPresetKey: spotPhotoPresetKey("sp1") });
    expect(byLabel("プリセット: 夕暮れ")?.textContent).toBe("夕暮れ");
  });
});

describe("variant: panel（プリセットの面）", () => {
  it("折りたたみの見出しのボタンを出さず常に開き、右上の「⋯」と一覧を出す（見出しは読み上げの名前だけ）", async () => {
    await render({ variant: "panel" });
    expect(container.querySelector("h4 button")).toBeNull();
    const heading = container.querySelector("h4");
    expect(heading?.className).toContain("sr-only");
    expect(heading?.textContent).toBe("プリセット");
    const group = container.querySelector('[role="group"]');
    expect(group?.getAttribute("aria-labelledby")).toBe(heading?.id);
    expect(byLabel("プリセットの操作")).not.toBeNull();
    const rowNames = Array.from(container.querySelectorAll("li > button:first-child")).map((row) => row.textContent);
    expect(rowNames).toEqual(["なし", "青空", "パステル", "夕暮れ"]);
  });

  it("actionsSlot（右パネルの見出し行）を渡すと「⋯」をそこへ描き、一覧の上に「⋯」だけの行を作らない（niho-photo#49）", async () => {
    // 受け口は container の外（右パネルの見出し行の代わり）
    const slot = document.createElement("div");
    document.body.appendChild(slot);
    await render({ variant: "panel", actionsSlot: slot });
    expect(slot.querySelector('button[aria-label="プリセットの操作"]')).not.toBeNull();
    expect(byLabel("プリセットの操作")).toBeNull();
    // 一覧はそのまま
    expect(Array.from(container.querySelectorAll("li > button:first-child")).map((row) => row.textContent)).toEqual([
      "なし",
      "青空",
      "パステル",
      "夕暮れ",
    ]);
    slot.remove();
  });

  it("節を閉じた覚えがあっても、面いっぱいの一覧は開いたまま", async () => {
    await render({});
    const toggle = container.querySelector<HTMLButtonElement>("h4 > button[aria-expanded]");
    expect(toggle?.getAttribute("aria-expanded")).toBe("true");
    await click(toggle);
    expect(toggle?.getAttribute("aria-expanded")).toBe("false");
    expect(container.querySelectorAll("li > button:first-child")).toHaveLength(0);

    await render({ variant: "panel" });
    expect(Array.from(container.querySelectorAll("li > button:first-child")).map((row) => row.textContent)).toEqual([
      "なし",
      "青空",
      "パステル",
      "夕暮れ",
    ]);
  });
});
