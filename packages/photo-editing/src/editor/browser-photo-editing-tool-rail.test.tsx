// @vitest-environment jsdom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { Contrast, Crop, Scissors, SlidersHorizontal } from "lucide-react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { BrowserPhotoEditingToolRail, type BrowserPhotoEditingToolRailItem } from "./browser-photo-editing-tool-rail";

/**
 * ブラウザ版の右端の道具の帯（niho-photo#51）。プリセット・補正・切り抜き・背景除去を縦に並べ、押している道具を `aria-pressed` で
 * 示し、押すと `onSelect`（押している道具・押せない道具は呼ばない）。
 */

let container: HTMLDivElement;
let root: Root;

function items(overrides: Partial<Record<string, Partial<BrowserPhotoEditingToolRailItem>>> = {}): BrowserPhotoEditingToolRailItem[] {
  const base: BrowserPhotoEditingToolRailItem[] = [
    { key: "presets", label: "プリセット", icon: Contrast, pressed: false, disabled: false, onSelect: vi.fn() },
    { key: "adjust", label: "補正", icon: SlidersHorizontal, pressed: true, disabled: false, onSelect: vi.fn() },
    { key: "crop", label: "切り抜き", icon: Crop, pressed: false, disabled: false, onSelect: vi.fn() },
    { key: "cutout", label: "背景除去", icon: Scissors, pressed: false, disabled: false, onSelect: vi.fn() },
  ];
  return base.map((item) => ({ ...item, ...overrides[item.key] }));
}

async function render(railItems: BrowserPhotoEditingToolRailItem[]) {
  await act(async () => {
    root.render(<BrowserPhotoEditingToolRail items={railItems} />);
  });
}

function rail(): HTMLElement {
  const found = container.querySelector<HTMLElement>('nav[aria-label="道具"]');
  if (!found) throw new Error("tool rail not found");
  return found;
}

function button(label: string): HTMLButtonElement {
  const found = rail().querySelector<HTMLButtonElement>(`button[aria-label="${label}"]`);
  if (!found) throw new Error(`button not found: ${label}`);
  return found;
}

async function click(element: Element) {
  await act(async () => {
    element.dispatchEvent(new MouseEvent("click", { bubbles: true }));
  });
}

beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

describe("BrowserPhotoEditingToolRail", () => {
  it("4 つの道具を並べ順に、日本語の読み上げ名と title で出す（PC の幅だけ見せる）", async () => {
    await render(items());
    expect(rail().className).toContain("hidden");
    expect(rail().className).toContain("lg:flex");
    const buttons = Array.from(rail().querySelectorAll<HTMLButtonElement>("button"));
    expect(buttons.map((candidate) => candidate.getAttribute("aria-label"))).toEqual(["プリセット", "補正", "切り抜き", "背景除去"]);
    expect(buttons.map((candidate) => candidate.title)).toEqual(["プリセット", "補正", "切り抜き", "背景除去"]);
    // 文字は出さず、絵だけ
    expect(rail().textContent).toBe("");
    expect(buttons.every((candidate) => candidate.querySelector("svg") !== null)).toBe(true);
  });

  it("押している道具だけ aria-pressed=true で地の色を変える", async () => {
    await render(items());
    expect(button("補正").getAttribute("aria-pressed")).toBe("true");
    expect(button("補正").className).toContain("bg-niho-accent-soft");
    for (const label of ["プリセット", "切り抜き", "背景除去"]) {
      expect(button(label).getAttribute("aria-pressed")).toBe("false");
      expect(button(label).className).not.toContain("bg-niho-accent-soft");
    }
  });

  it("押すと onSelect を呼ぶ。押している道具をもう一度押しても呼ばない", async () => {
    const railItems = items();
    await render(railItems);
    await click(button("切り抜き"));
    expect(railItems[2]?.onSelect).toHaveBeenCalledTimes(1);
    await click(button("補正"));
    expect(railItems[1]?.onSelect).not.toHaveBeenCalled();
  });

  it("押せない道具は disabled で薄くし、押しても onSelect を呼ばない", async () => {
    const railItems = items({ crop: { disabled: true }, cutout: { disabled: true } });
    await render(railItems);
    expect(button("切り抜き").disabled).toBe(true);
    expect(button("切り抜き").className).toContain("disabled:opacity-40");
    expect(button("プリセット").disabled).toBe(false);
    await click(button("切り抜き"));
    await click(button("背景除去"));
    expect(railItems[2]?.onSelect).not.toHaveBeenCalled();
    expect(railItems[3]?.onSelect).not.toHaveBeenCalled();
  });
});
