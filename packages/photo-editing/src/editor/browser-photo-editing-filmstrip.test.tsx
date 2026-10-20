// @vitest-environment jsdom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { BrowserPhotoEditingFilmstrip } from "./browser-photo-editing-filmstrip";
import type { BrowserPhotoEditingGridItem } from "./browser-photo-editing-grid";

/**
 * 1 枚の面の下のフィルムストリップ（L5 #54）: 升の並び・開いている写真の印・押して開く・追加中は押せない・Tab で止まる升・
 * 升の上の ← →・開いている写真が替わったら帯の中で見える位置へ送ること（動きを減らす設定では滑らかにしない）。
 */

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

function stripItem(key: string, overrides: Partial<BrowserPhotoEditingGridItem> = {}): BrowserPhotoEditingGridItem {
  return {
    key,
    fileName: `${key}.JPG`,
    thumbnail: { url: `https://example.test/${key}.jpg`, failed: false },
    raw: false,
    favorite: false,
    pending: null,
    sectionDate: null,
    ...overrides,
  };
}

const ITEMS: BrowserPhotoEditingGridItem[] = [stripItem("a"), stripItem("b"), stripItem("c"), stripItem("d", { adding: { fraction: 0.5 } })];

let container: HTMLDivElement;
let root: Root;
let onOpen: ReturnType<typeof vi.fn<(key: string) => void>>;
let onArrowKey: ReturnType<typeof vi.fn<(event: { key: string }) => void>>;

async function render(props: { items?: BrowserPhotoEditingGridItem[]; activeKey: string | null }) {
  await act(async () => {
    root.render(
      <BrowserPhotoEditingFilmstrip
        items={props.items ?? ITEMS}
        activeKey={props.activeKey}
        onOpen={onOpen}
        onArrowKey={(event) => onArrowKey({ key: event.key })}
      />,
    );
  });
}

function strip(): HTMLElement | null {
  return container.querySelector<HTMLElement>('nav[aria-label="この一覧の写真"]');
}

function tile(fileName: string): HTMLButtonElement {
  const found = container.querySelector<HTMLButtonElement>(`button[aria-label="${fileName}"]`);
  if (!found) throw new Error(`tile not found: ${fileName}`);
  return found;
}

/** 帯の幅と升の位置（jsdom は描かないので、横に 100px ずつ並べた値を与える） */
function layOut(stripWidth: number, scrollLeft: number) {
  const nav = strip();
  if (!nav) throw new Error("strip not found");
  Object.defineProperty(nav, "clientWidth", { configurable: true, value: stripWidth });
  nav.scrollLeft = scrollLeft;
  const scrollTo = vi.fn();
  nav.scrollTo = scrollTo as unknown as typeof nav.scrollTo;
  container.querySelectorAll<HTMLButtonElement>("nav button").forEach((button, index) => {
    Object.defineProperty(button, "offsetLeft", { configurable: true, value: 12 + index * 108 });
    Object.defineProperty(button, "offsetWidth", { configurable: true, value: 102 });
  });
  return scrollTo;
}

function mockReducedMotion(reduce: boolean) {
  window.matchMedia = vi.fn((query: string) => ({ matches: reduce && query.includes("reduce"), media: query }) as MediaQueryList);
}

const originalMatchMedia = window.matchMedia;

beforeEach(() => {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  onOpen = vi.fn<(key: string) => void>();
  onArrowKey = vi.fn<(event: { key: string }) => void>();
  mockReducedMotion(false);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  window.matchMedia = originalMatchMedia;
  vi.restoreAllMocks();
});

describe("BrowserPhotoEditingFilmstrip", () => {
  it("帯は「この一覧の写真」の nav で、升は写真名の button。開いている写真に印、追加中の写真は薄くして押せない", async () => {
    await render({ activeKey: "b" });
    expect(strip()).not.toBeNull();
    expect(Array.from(container.querySelectorAll("nav li > button")).map((button) => button.getAttribute("aria-label"))).toEqual([
      "a.JPG",
      "b.JPG",
      "c.JPG",
      "d.JPG",
    ]);
    expect(tile("b.JPG").getAttribute("aria-current")).toBe("true");
    expect(tile("b.JPG").className).toContain("ring-niho-accent-ink");
    expect(tile("a.JPG").hasAttribute("aria-current")).toBe(false);
    expect(tile("a.JPG").className).not.toContain("ring-niho-accent-ink");
    expect(tile("a.JPG").querySelector("img")?.getAttribute("src")).toBe("https://example.test/a.jpg");
    expect(tile("d.JPG").disabled).toBe(true);
    expect(tile("d.JPG").className).toContain("opacity-40");
  });

  it("升を押すとその写真を開く（追加中の写真は押しても何もしない）", async () => {
    await render({ activeKey: "a" });
    await act(async () => {
      tile("c.JPG").click();
      tile("d.JPG").click();
    });
    expect(onOpen.mock.calls).toEqual([["c"]]);
  });

  it("Tab で止まるのは開いている写真の升だけ（帯に無ければ押せる最初の升）", async () => {
    await render({ activeKey: "c" });
    expect(Array.from(container.querySelectorAll<HTMLButtonElement>("nav button")).map((button) => button.tabIndex)).toEqual([
      -1, -1, 0, -1,
    ]);
    await render({ activeKey: "missing" });
    expect(tile("a.JPG").tabIndex).toBe(0);
    expect(tile("c.JPG").tabIndex).toBe(-1);
  });

  it("升の上の ← → だけを画面へ渡す（ほかのキーは渡さない）", async () => {
    await render({ activeKey: "b" });
    await act(async () => {
      for (const key of ["ArrowRight", "ArrowLeft", "ArrowUp", "Enter", "a"]) {
        tile("b.JPG").dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true }));
      }
    });
    expect(onArrowKey.mock.calls).toEqual([[{ key: "ArrowRight" }], [{ key: "ArrowLeft" }]]);
  });

  it("開いている写真が替わったら、その升を帯の中で見える位置へ送る（見えていれば送らない）", async () => {
    await render({ activeKey: "a" });
    // 帯の幅 250px・左端から見ている: a（12〜114）と b（120〜222）が見え、c（228〜330）ははみ出す
    let scrollTo = layOut(250, 0);
    await render({ activeKey: "b" });
    expect(scrollTo).not.toHaveBeenCalled();

    scrollTo = layOut(250, 0);
    await render({ activeKey: "c" });
    expect(scrollTo).toHaveBeenCalledWith({ left: 330 + 12 - 250, behavior: "smooth" });

    // 右へ送った後に左へ戻る
    scrollTo = layOut(250, 200);
    await render({ activeKey: "a" });
    expect(scrollTo).toHaveBeenCalledWith({ left: 0, behavior: "smooth" });
  });

  it("動きを減らす設定では滑らかに送らない", async () => {
    mockReducedMotion(true);
    await render({ activeKey: "a" });
    const scrollTo = layOut(250, 0);
    await render({ activeKey: "c" });
    expect(scrollTo).toHaveBeenCalledWith({ left: 92, behavior: "auto" });
  });

  it("帯の中で操作していたら、フォーカスも開いた写真の升へ移す（帯の外にあれば動かさない）", async () => {
    await render({ activeKey: "a" });
    tile("a.JPG").focus();
    await render({ activeKey: "b" });
    expect(document.activeElement).toBe(tile("b.JPG"));

    const outside = document.createElement("button");
    document.body.appendChild(outside);
    outside.focus();
    await render({ activeKey: "c" });
    expect(document.activeElement).toBe(outside);
    outside.remove();
  });

  it("写真が無ければ帯を出さない", async () => {
    await render({ items: [], activeKey: null });
    expect(strip()).toBeNull();
  });
});
