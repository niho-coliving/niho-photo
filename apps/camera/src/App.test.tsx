import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { App, PHOTO_BENCH_NOTICE_DISMISSED_KEY, PHOTO_BENCH_NOTICE_TEXT, PHOTO_TREE_HIDDEN_KEY } from "./App";
import { createCameraCommands, type Invoke } from "./local-library/commands";

// React 18 の act を jsdom で使う
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLDivElement;
let root: Root;
const initialInnerWidth = window.innerWidth;

beforeEach(() => {
  window.localStorage.clear();
  // 窓の最小幅は 1024px（PC の面）
  Object.defineProperty(window, "innerWidth", { configurable: true, value: 1280 });
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  window.localStorage.clear();
  Object.defineProperty(window, "innerWidth", { configurable: true, value: initialInnerWidth });
});

function fakeCommands(options: { photoBenchEdits: boolean; rememberedFolder?: boolean }) {
  const calls: string[] = [];
  const folder = { folderId: "test-folder", name: "検証用", children: [], photos: [], truncated: false };
  let folders = options.rememberedFolder ? [folder] : [];
  const invoke: Invoke = async <T,>(command: string) => {
    calls.push(command);
    if (command === "camera_library_forget_folder") {
      folders = [];
      return {} as T;
    }
    const answers: Record<string, unknown> = {
      camera_library_remembered: { folders, photos: [] },
      camera_library_selected_photos: { photos: [] },
      camera_library_list_folder: { folder },
      camera_develop_status: { available: true, raster: true },
      camera_cutout_status: { available: true },
      camera_photo_bench_edits: { found: options.photoBenchEdits },
      camera_presets_list: { presets: [] },
    };
    if (!(command in answers)) throw { code: "internal", message: `unexpected ${command}` };
    return answers[command] as T;
  };
  return { calls, commands: createCameraCommands(invoke) };
}

/** 読み込み（react-query・木）が落ち着くまで待つ。 */
async function settle() {
  for (let round = 0; round < 4; round += 1) {
    await act(async () => {
      for (let index = 0; index < 12; index += 1) await Promise.resolve();
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
  }
}

async function render(
  commands: ReturnType<typeof fakeCommands>["commands"],
  appVersion: string | null = "0.1.4",
) {
  await act(async () => {
    root.render(
      <App
        commands={commands}
        loadAppInfo={async () => (appVersion ? { appVersion } : null)}
        watchUpdate={async () => () => undefined}
      />,
    );
  });
  await settle();
}

async function remount(commands: ReturnType<typeof fakeCommands>["commands"]) {
  await act(async () => root.unmount());
  root = createRoot(container);
  await render(commands);
}

function notice(): HTMLElement | null {
  return Array.from(container.querySelectorAll<HTMLElement>('[role="status"]')).find((element) =>
    element.textContent?.includes(PHOTO_BENCH_NOTICE_TEXT),
  ) ?? null;
}

describe("App", () => {
  it("forgets a folder only after the shared confirmation is accepted", async () => {
    const { commands, calls } = fakeCommands({ photoBenchEdits: false, rememberedFolder: true });
    await render(commands);

    const openMenu = async () => {
      await act(async () => {
        container.querySelector<HTMLButtonElement>('button[aria-label="検証用 のメニュー"]')?.click();
      });
      await act(async () => {
        Array.from(document.body.querySelectorAll<HTMLButtonElement>('[role="menuitem"]'))
          .find((item) => item.textContent === "一覧から外す")?.click();
      });
    };

    await openMenu();
    expect(document.body.textContent).toContain("「検証用」を一覧から外します。フォルダと写真は消えません。");
    await act(async () => {
      Array.from(document.body.querySelectorAll("button")).find((button) => button.textContent === "キャンセル")?.click();
    });
    expect(calls).not.toContain("camera_library_forget_folder");

    await openMenu();
    await act(async () => {
      Array.from(document.body.querySelectorAll("button")).find((button) => button.textContent === "外す")?.click();
    });
    await settle();
    expect(calls).toContain("camera_library_forget_folder");
    expect(container.querySelector('button[aria-label="検証用 のメニュー"]')).toBeNull();
  });

  it("draws the shared editing surface with one app name in the titlebar, the place and the version", async () => {
    const { commands, calls } = fakeCommands({ photoBenchEdits: false });
    await render(commands);

    expect(container.querySelector(".photo-titlebar")?.textContent).toBe("NIHO photo");
    expect(container.querySelector(".photo-titlebar")?.hasAttribute("data-tauri-drag-region")).toBe(true);
    expect(container.querySelector("header")?.textContent).not.toContain("NIHO photo");
    expect(container.querySelector("header")?.hasAttribute("data-tauri-drag-region")).toBe(true);
    expect(container.querySelector('button[aria-label="アカウント"]')).toBeNull();
    // 編集面（空の「この Mac」ではフォルダと写真を追加するメニューを出す）
    expect(container.querySelector('section[aria-label="ブラウザ写真編集"]')).not.toBeNull();
    expect(container.querySelector('aside[aria-label="写真の場所"] h3')?.textContent).toBe("この Mac");
    expect(
      Array.from(container.querySelectorAll('button[aria-haspopup="menu"]')).some((button) =>
        button.textContent?.includes("フォルダや写真を追加"),
      ),
    ).toBe(true);
    // 窓の上の帯に表示中の場所
    expect(container.querySelector('nav[aria-label="表示中の場所"]')?.textContent).toBe("この Mac");
    // 版は左の木の底（下段の帯は無い）
    expect(container.querySelector(":scope > div > footer")).toBeNull();
    expect(container.querySelector('aside[aria-label="写真の場所"]')?.textContent).toContain("版 0.1.4");
    // 編集面は窓いっぱい（web の角丸の枠と固定の高さを使わない）
    const surface = container.querySelector('section[aria-label="ブラウザ写真編集"]');
    expect(surface?.className).toContain("flex-1");
    expect(surface?.className).not.toContain("rounded-2xl");
    expect(notice()).toBeNull();
    expect(calls).toContain("camera_library_remembered");
    expect(calls).toContain("camera_develop_status");
  });

  it("leaves out the version line when the app info is unavailable", async () => {
    const { commands } = fakeCommands({ photoBenchEdits: false });
    await render(commands, null);
    expect(container.querySelector('aside[aria-label="写真の場所"]')?.textContent).not.toContain("版");
  });

  it("hides and shows the left panel from the header and remembers it on this Mac", async () => {
    const { commands } = fakeCommands({ photoBenchEdits: false });
    await render(commands);
    const toggle = () => container.querySelector<HTMLButtonElement>('button[aria-label="左のパネル"]');
    expect(toggle()?.getAttribute("aria-pressed")).toBe("true");
    expect(container.querySelector('aside[aria-label="写真の場所"]')).not.toBeNull();

    await act(async () => toggle()?.click());
    expect(toggle()?.getAttribute("aria-pressed")).toBe("false");
    expect(container.querySelector('aside[aria-label="写真の場所"]')).toBeNull();
    expect(window.localStorage.getItem(PHOTO_TREE_HIDDEN_KEY)).toBe("1");

    await act(async () => toggle()?.click());
    expect(container.querySelector('aside[aria-label="写真の場所"]')).not.toBeNull();
    expect(window.localStorage.getItem(PHOTO_TREE_HIDDEN_KEY)).toBeNull();
  });

  it("shows the Photo Bench notice once and never again after it is closed on this Mac", async () => {
    const first = fakeCommands({ photoBenchEdits: true });
    await render(first.commands);
    const shown = notice();
    expect(shown).not.toBeNull();
    // 編集面の上に出す
    const surface = container.querySelector('section[aria-label="ブラウザ写真編集"]');
    expect(shown && surface ? shown.compareDocumentPosition(surface) & Node.DOCUMENT_POSITION_FOLLOWING : 0).toBeTruthy();

    await act(async () => {
      shown?.querySelector<HTMLButtonElement>('button[aria-label="案内を閉じる"]')?.click();
    });
    expect(notice()).toBeNull();
    expect(window.localStorage.getItem(PHOTO_BENCH_NOTICE_DISMISSED_KEY)).not.toBeNull();

    const second = fakeCommands({ photoBenchEdits: true });
    await remount(second.commands);
    expect(notice()).toBeNull();
    expect(second.calls).not.toContain("camera_photo_bench_edits");
  });

});
