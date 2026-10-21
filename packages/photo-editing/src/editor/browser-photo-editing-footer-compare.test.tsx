// @vitest-environment jsdom

import { act, useRef, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { BrowserPhotoEditingFooter } from "./browser-photo-editing-footer";
import type { BrowserPhotoCompareMode } from "./use-browser-photo-compare-view";

/**
 * 下段の「比較」（niho-photo#41）。「補正前」の右に置き、押すと 1 つを選ぶメニュー（並べる（左右）/ 分割 / 比較しない）。読み上げ名で
 * 今の見せ方が分かる。渡さない間は出さない（下段は今までどおり）。
 */

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLDivElement;
let root: Root;
const onChange = vi.fn<(mode: BrowserPhotoCompareMode) => void>();

function Harness(props: { compareView: boolean; disabled?: boolean; compareDisabled?: boolean }) {
  const exportButtonRef = useRef<HTMLButtonElement | null>(null);
  const [mode, setMode] = useState<BrowserPhotoCompareMode>("off");
  return (
    <BrowserPhotoEditingFooter
      viewMode="loupe"
      canOpenLoupe
      onShowGrid={() => undefined}
      onShowLoupe={() => undefined}
      statusLine={null}
      showCompare
      compareDisabled={props.compareDisabled ?? false}
      compareOriginal={false}
      onCompareOriginalChange={() => undefined}
      compareView={
        props.compareView
          ? {
              mode,
              disabled: props.disabled ?? false,
              onChange: (next) => {
                onChange(next);
                setMode(next);
              },
            }
          : undefined
      }
      exportButtonRef={exportButtonRef}
      exportSheetOpen={false}
      canExport
      exportChoices={null}
      onToggleExportSheet={() => undefined}
      onExport={() => undefined}
      onCloseExportSheet={() => undefined}
    />
  );
}

async function render(props: { compareView: boolean; disabled?: boolean; compareDisabled?: boolean }) {
  await act(async () => {
    root.render(<Harness {...props} />);
  });
}

function trigger(): HTMLButtonElement | null {
  return container.querySelector<HTMLButtonElement>('button[aria-haspopup="menu"]');
}

function menuItems(): HTMLButtonElement[] {
  return Array.from(document.body.querySelectorAll<HTMLButtonElement>('[role="menuitemradio"]'));
}

async function click(element: Element | null | undefined) {
  if (!element) throw new Error("element not found");
  await act(async () => {
    element.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
  });
}

beforeEach(() => {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  onChange.mockReset();
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

describe("BrowserPhotoEditingFooter の「比較」", () => {
  it("渡さない間は出さない（下段の並びは今までどおり）", async () => {
    await render({ compareView: false });
    expect(trigger()).toBeNull();
    expect(container.textContent).not.toContain("比較");
  });

  it("「補正前」の右に PC だけ置き、title でキー（Y / ⇧Y）を案内する", async () => {
    await render({ compareView: true });
    const button = trigger();
    const original = Array.from(container.querySelectorAll("button")).find((candidate) => candidate.textContent === "補正前");
    expect(button?.textContent).toBe("比較");
    expect(button?.getAttribute("aria-label")).toBe("比較");
    expect(button?.title).toBe("比較（Y：並べる / ⇧Y：分割）");
    expect(button?.className).toContain("hidden");
    expect(button?.className).toContain("lg:inline-flex");
    expect(original && button && original.compareDocumentPosition(button) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it("メニューで 並べる（左右）/ 分割 / 比較しない を選べ、選んでいる見せ方に印。読み上げ名が今の見せ方になる", async () => {
    await render({ compareView: true });
    await click(trigger());
    expect(menuItems().map((item) => item.textContent)).toEqual(["並べる（左右）", "分割", "比較しない"]);
    expect(menuItems().map((item) => item.getAttribute("aria-checked"))).toEqual(["false", "false", "true"]);

    await click(menuItems()[0]);
    expect(onChange).toHaveBeenLastCalledWith("side");
    expect(trigger()?.getAttribute("aria-label")).toBe("比較：並べる（左右）");
    expect(trigger()?.className).toContain("bg-niho-accent-soft");

    await click(trigger());
    expect(menuItems().map((item) => item.getAttribute("aria-checked"))).toEqual(["true", "false", "false"]);
    await click(menuItems()[1]);
    expect(onChange).toHaveBeenLastCalledWith("split");
    expect(trigger()?.getAttribute("aria-label")).toBe("比較：分割");

    await click(trigger());
    await click(menuItems()[2]);
    expect(onChange).toHaveBeenLastCalledWith("off");
    expect(trigger()?.getAttribute("aria-label")).toBe("比較");
    expect(trigger()?.className).not.toContain("bg-niho-accent-soft");
  });

  it("使えない間（切り抜き / 背景除去の道具・操作中）は押せない", async () => {
    await render({ compareView: true, disabled: true });
    expect(trigger()?.disabled).toBe(true);
    await click(trigger());
    expect(menuItems()).toHaveLength(0);
  });
});
