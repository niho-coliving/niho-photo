// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { inertAttribute } from "./inert-attribute";

describe("inertAttribute", () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    vi.restoreAllMocks();
  });

  function renderTarget(inert: boolean | undefined) {
    act(() => {
      root.render(<div data-testid="target" inert={inert} />);
    });
    return container.querySelector('[data-testid="target"]');
  }

  it("有効時は空の inert 属性を描画し、警告を出さない", () => {
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
    // jsdom は `inert` IDL プロパティを実装していないため、反映先の属性で確認する。
    expect(renderTarget(inertAttribute(true))?.getAttribute("inert")).toBe("");
    expect(consoleError).not.toHaveBeenCalled();
  });

  it("無効時は inert 属性を省略する", () => {
    expect(renderTarget(inertAttribute(true))?.getAttribute("inert")).toBe("");
    expect(renderTarget(inertAttribute(false))?.getAttribute("inert")).toBeNull();
  });

  it("react-dom 18 では true をそのまま渡すと属性が描画されない（この helper が必要な理由）", () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    expect(renderTarget(true)?.getAttribute("inert")).toBeNull();
  });
});
