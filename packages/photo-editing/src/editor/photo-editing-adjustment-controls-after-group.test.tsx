// @vitest-environment jsdom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { neutralDevelopSettings } from "../develop-engine/develop-settings";
import type { PhotoEditingControlKey } from "../photo-editing-adjustments";

import { BrowserPhotoEditingAdjustments } from "./browser-photo-editing-adjustments";
import { BROWSER_EFFECTS_ADJUSTMENT_KEYS } from "./browser-photo-editing-model";
import { PhotoEditingAdjustmentGroups } from "./photo-editing-adjustment-controls";

/**
 * 群の間に差し込む口（`afterGroup`。niho-photo#37 の「カーブ」の節など）。渡した群の直後・次の群の前に置き、省いたときの DOM は
 * 今までと同じ。ブラウザ版の右パネル（`BrowserPhotoEditingAdjustments`）もそのまま通す。
 */

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLDivElement;
let root: Root;

async function renderGroups(props: Partial<Parameters<typeof PhotoEditingAdjustmentGroups>[0]> = {}) {
  await act(async () => {
    root.render(
      <PhotoEditingAdjustmentGroups
        settings={null}
        photo={null}
        disabled={false}
        idPrefix="groups"
        onSettingsChange={() => {}}
        {...props}
      />,
    );
  });
}

/** 一番上の並び（群の div と差し込んだ要素）を、群は見出し・差し込みは data-testid で表す。 */
function topLevel(): string[] {
  return Array.from(container.children).map(
    (element) => element.getAttribute("data-testid") ?? element.querySelector("h4")?.textContent ?? element.tagName,
  );
}

beforeEach(() => {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

describe("PhotoEditingAdjustmentGroups の afterGroup", () => {
  it("省いたとき・空のときの DOM は今までと同じ（ライト → カラー → 効果の群だけ）", async () => {
    await renderGroups();
    const before = container.innerHTML;
    expect(topLevel()).toEqual(["ライト", "カラー", "効果"]);
    await renderGroups({ afterGroup: {} });
    expect(container.innerHTML).toBe(before);
    await renderGroups({ afterGroup: { light: null, color: undefined } });
    expect(container.innerHTML).toBe(before);
  });

  it("渡した群の直後（次の群の前）に置く。群の開閉の DOM は変えない", async () => {
    await renderGroups();
    const groupsOnly = Array.from(container.children).map((element) => element.outerHTML);
    await renderGroups({
      afterGroup: {
        light: <section data-testid="after-light" />,
        effects: <section data-testid="after-effects" />,
      },
    });
    expect(topLevel()).toEqual(["ライト", "after-light", "カラー", "効果", "after-effects"]);
    const groups = Array.from(container.children)
      .filter((element) => !element.hasAttribute("data-testid"))
      .map((element) => element.outerHTML);
    expect(groups).toEqual(groupsOnly);
  });

  it("群を出さない（見せる項目が無い）ときは、差し込みも出さない", async () => {
    const colorOnly: PhotoEditingControlKey[] = ["saturation"];
    await renderGroups({
      visibleKeys: colorOnly,
      afterGroup: { light: <section data-testid="after-light" />, color: <section data-testid="after-color" /> },
    });
    expect(topLevel()).toEqual(["カラー", "after-color"]);
  });
});

describe("BrowserPhotoEditingAdjustments の afterGroup", () => {
  it("補正の面で、ライトの群の直後に節を置く（ほかの面には出さない）", async () => {
    const props = {
      canEdit: true,
      canReset: false,
      resetDone: false,
      canUndo: false,
      canRedo: false,
      controlsDisabled: false,
      busy: false,
      work: null,
      raw: false,
      settings: neutralDevelopSettings(),
      visibleKeys: BROWSER_EFFECTS_ADJUSTMENT_KEYS,
      afterGroup: { light: <section data-testid="curve-section" /> },
      onReset: vi.fn(),
      onUndo: vi.fn(),
      onRedo: vi.fn(),
      onRetryWork: vi.fn(),
      onSettingsChange: vi.fn(),
    };
    await act(async () => {
      root.render(<BrowserPhotoEditingAdjustments {...props} />);
    });
    const section = container.querySelector('[data-testid="curve-section"]');
    expect(section).not.toBeNull();
    expect(section?.previousElementSibling?.querySelector("h4")?.textContent).toBe("ライト");
    expect(section?.nextElementSibling?.querySelector("h4")?.textContent).toBe("カラー");
    await act(async () => {
      root.render(<BrowserPhotoEditingAdjustments {...props} tool="crop" cropTools={<p>切り抜きの道具</p>} />);
    });
    expect(container.querySelector('[data-testid="curve-section"]')).toBeNull();
  });
});
