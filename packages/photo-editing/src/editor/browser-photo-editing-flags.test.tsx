// @vitest-environment jsdom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { PhotoLibraryFlag } from "../library/photo-library";

import { BrowserPhotoFlagButtons, BrowserPhotoFlagMark, type BrowserPhotoFlagControl } from "./browser-photo-editing-flags";

/**
 * 下段の選別のボタン（niho-photo#47）: 採用・却下は押すと付き、付いている方を押すと外れる（aria-pressed）。「外す」は付いているとき
 * だけ。対象が無い・閲覧のみ・送っている間は押せない。印（タイル・帯の升）は形と読み上げ名で見分ける。
 */

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
});

function control(overrides: Partial<BrowserPhotoFlagControl> = {}): BrowserPhotoFlagControl {
  return { flag: null, available: true, busy: false, disabled: false, onSet: vi.fn(), ...overrides };
}

async function render(props: BrowserPhotoFlagControl) {
  await act(async () => root.render(<BrowserPhotoFlagButtons {...props} />));
}

function button(label: string): HTMLButtonElement {
  const found = container.querySelector<HTMLButtonElement>(`button[aria-label="${label}"]`);
  if (!found) throw new Error(`button not found: ${label}`);
  return found;
}

async function click(element: HTMLElement) {
  await act(async () => {
    element.dispatchEvent(new MouseEvent("click", { bubbles: true }));
  });
}

describe("BrowserPhotoFlagButtons", () => {
  it("採用・却下・外すの 3 つを「選別」の群で出し、キーを title で案内する（44px の押せる範囲）", async () => {
    await render(control());
    const group = container.querySelector('[role="group"]');
    expect(group?.getAttribute("aria-label")).toBe("選別");
    expect(Array.from(group?.querySelectorAll("button") ?? []).map((element) => element.getAttribute("aria-label"))).toEqual([
      "採用",
      "却下",
      "採用・却下を外す",
    ]);
    expect(button("採用").title).toBe("採用（P）");
    expect(button("却下").title).toBe("却下（X）");
    expect(button("採用・却下を外す").title).toBe("外す（U）");
    for (const element of group?.querySelectorAll("button") ?? []) {
      expect(element.className).toContain("h-11");
      expect(element.className).toContain("w-11");
    }
  });

  it("付いていない写真: 採用・却下は押していない状態で、押すとそのフラグ。外すは押せない", async () => {
    const onSet = vi.fn<(flag: PhotoLibraryFlag | null) => void>();
    await render(control({ onSet }));
    expect(button("採用").getAttribute("aria-pressed")).toBe("false");
    expect(button("却下").getAttribute("aria-pressed")).toBe("false");
    expect(button("採用・却下を外す").disabled).toBe(true);
    await click(button("採用"));
    expect(onSet).toHaveBeenLastCalledWith("pick");
    await click(button("却下"));
    expect(onSet).toHaveBeenLastCalledWith("reject");
  });

  it("採用の写真: 採用を押した状態で出し、もう一度押すと外れる。却下を押すと付け替える。外すで外れる", async () => {
    const onSet = vi.fn<(flag: PhotoLibraryFlag | null) => void>();
    await render(control({ flag: "pick", onSet }));
    expect(button("採用").getAttribute("aria-pressed")).toBe("true");
    expect(button("却下").getAttribute("aria-pressed")).toBe("false");
    await click(button("採用"));
    expect(onSet).toHaveBeenLastCalledWith(null);
    await click(button("却下"));
    expect(onSet).toHaveBeenLastCalledWith("reject");
    await click(button("採用・却下を外す"));
    expect(onSet).toHaveBeenLastCalledWith(null);
    expect(onSet).toHaveBeenCalledTimes(3);
  });

  it("複数枚でフラグが混ざっているときはどちらも押していない状態で、外すは押せる", async () => {
    await render(control({ flag: "mixed" }));
    expect(button("採用").getAttribute("aria-pressed")).toBe("false");
    expect(button("却下").getAttribute("aria-pressed")).toBe("false");
    expect(button("採用・却下を外す").disabled).toBe(false);
  });

  it("対象が無い・閲覧のみ・送っている間は押せない（対象が無い・閲覧のみは薄く出す）", async () => {
    await render(control({ available: false, flag: null }));
    expect(Array.from(container.querySelectorAll("button")).every((element) => element.disabled)).toBe(true);
    expect(container.querySelector('[role="group"]')?.className).toContain("opacity-40");
    await render(control({ disabled: true, flag: "reject" }));
    expect(Array.from(container.querySelectorAll("button")).every((element) => element.disabled)).toBe(true);
    await render(control({ busy: true, flag: "reject" }));
    expect(Array.from(container.querySelectorAll("button")).every((element) => element.disabled)).toBe(true);
    expect(container.querySelector('[role="group"]')?.getAttribute("aria-busy")).toBe("true");
    expect(container.querySelector('[role="group"]')?.className).not.toContain("opacity-40");
    // 押せないときは押した状態も出さない（対象が無い）
    await render(control({ available: false, flag: "pick" }));
    expect(button("採用").getAttribute("aria-pressed")).toBe("false");
  });
});

describe("BrowserPhotoFlagMark", () => {
  it("採用と却下は形と読み上げ名で見分ける（色だけに頼らない）", async () => {
    await act(async () =>
      root.render(
        <>
          <BrowserPhotoFlagMark flag="pick" className="bottom-1 right-1" />
          <BrowserPhotoFlagMark flag="reject" small />
        </>,
      ),
    );
    const [pick, reject] = Array.from(container.children) as HTMLElement[];
    expect(pick.textContent).toBe("採用");
    expect(reject.textContent).toBe("却下");
    expect(pick.className).toContain("bottom-1");
    const pickIcon = pick.querySelector("svg");
    const rejectIcon = reject.querySelector("svg");
    expect(pickIcon?.getAttribute("aria-hidden")).toBe("true");
    // 採用は塗った旗、却下は丸に ×（別の形）
    expect(pickIcon?.getAttribute("fill")).toBe("currentColor");
    expect(rejectIcon?.getAttribute("fill")).toBe("none");
    expect(pickIcon?.getAttribute("class")).not.toBe(rejectIcon?.getAttribute("class"));
  });
});
