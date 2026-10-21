// @vitest-environment jsdom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  PHOTO_EDITING_ADVANCED_SECTIONS_STORAGE_KEY,
  parseStoredOpenAdvancedSections,
  serializeOpenAdvancedSection,
} from "../photo-editing-advanced-sections-state";

import { PhotoEditingAdvancedSection } from "./photo-editing-advanced-section";

/**
 * 右パネルの「既定で閉じた節」（niho-photo#37。カーブなど）。見た目は群と同じ見出しの開閉で、開いた節の id だけを端末に覚える
 * （はじめて・壊れた保存値・知らない id は閉じる。localStorage が使えなくても、この画面の間は覚える）。中身は開いている間だけ描く。
 */

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLDivElement;
let root: Root;

async function render() {
  await act(async () => {
    root.render(
      <PhotoEditingAdvancedSection
        id="curve"
        title="カーブ"
        accessory={
          <button type="button" data-testid="accessory">
            初期化
          </button>
        }
      >
        <div data-testid="body">曲線</div>
      </PhotoEditingAdvancedSection>,
    );
  });
}

/** 節を描き直す（保存値を読み直す）。 */
async function remount() {
  act(() => root.unmount());
  root = createRoot(container);
  await render();
}

function toggle(): HTMLButtonElement {
  const found = container.querySelector<HTMLButtonElement>("h4 button");
  if (!found) throw new Error("section toggle not found");
  return found;
}

async function click(element: Element) {
  await act(async () => {
    element.dispatchEvent(new MouseEvent("click", { bubbles: true }));
  });
}

beforeEach(() => {
  window.localStorage.clear();
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.restoreAllMocks();
  window.localStorage.clear();
});

describe("保存値の読み書き", () => {
  it("開いた節の id の配列を読む（無い・壊れている・配列でない・知らない id は閉じる）", () => {
    expect([...parseStoredOpenAdvancedSections(null)]).toEqual([]);
    expect([...parseStoredOpenAdvancedSections("{")]).toEqual([]);
    expect([...parseStoredOpenAdvancedSections('{"curve":true}')]).toEqual([]);
    expect([...parseStoredOpenAdvancedSections('["future", 3, "curve"]')]).toEqual(["curve"]);
    expect([...parseStoredOpenAdvancedSections('["lens", "curve"]')]).toEqual(["lens", "curve"]);
  });

  it("1 つの節だけを書き換え、ほかの id（知らないものも）は残す", () => {
    expect(serializeOpenAdvancedSection(null, "curve", true)).toBe('["curve"]');
    expect(serializeOpenAdvancedSection('["lens"]', "curve", true)).toBe('["lens","curve"]');
    expect(serializeOpenAdvancedSection('["curve","lens","curve"]', "curve", false)).toBe('["lens"]');
    expect(serializeOpenAdvancedSection("broken", "curve", false)).toBe("[]");
  });
});

describe("PhotoEditingAdvancedSection", () => {
  it("はじめては閉じている（見出しの横の要素は出し、中身は描かない）", async () => {
    await render();
    expect(toggle().textContent).toBe("カーブ");
    expect(toggle().getAttribute("aria-expanded")).toBe("false");
    const body = document.getElementById(toggle().getAttribute("aria-controls") ?? "");
    expect(body?.hasAttribute("hidden")).toBe(true);
    expect(container.querySelector('[data-testid="body"]')).toBeNull();
    expect(container.querySelector('[data-testid="accessory"]')).not.toBeNull();
  });

  it("開くと中身を描き、開いたことを端末に覚える（描き直しても開いたまま。閉じると消す）", async () => {
    window.localStorage.setItem(PHOTO_EDITING_ADVANCED_SECTIONS_STORAGE_KEY, '["lens"]');
    await render();
    await click(toggle());
    expect(toggle().getAttribute("aria-expanded")).toBe("true");
    expect(container.querySelector('[data-testid="body"]')?.textContent).toBe("曲線");
    expect(window.localStorage.getItem(PHOTO_EDITING_ADVANCED_SECTIONS_STORAGE_KEY)).toBe('["lens","curve"]');
    await remount();
    expect(toggle().getAttribute("aria-expanded")).toBe("true");
    await click(toggle());
    expect(container.querySelector('[data-testid="body"]')).toBeNull();
    expect(window.localStorage.getItem(PHOTO_EDITING_ADVANCED_SECTIONS_STORAGE_KEY)).toBe('["lens"]');
  });

  it("壊れた保存値なら閉じたまま", async () => {
    window.localStorage.setItem(PHOTO_EDITING_ADVANCED_SECTIONS_STORAGE_KEY, "curve");
    await render();
    expect(toggle().getAttribute("aria-expanded")).toBe("false");
  });

  it("localStorage が使えなくても閉じた状態から始め、この画面の間は開閉を覚える", async () => {
    vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => {
      throw new Error("blocked");
    });
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new Error("blocked");
    });
    await render();
    expect(toggle().getAttribute("aria-expanded")).toBe("false");
    await click(toggle());
    expect(toggle().getAttribute("aria-expanded")).toBe("true");
    expect(container.querySelector('[data-testid="body"]')).not.toBeNull();
  });
});
