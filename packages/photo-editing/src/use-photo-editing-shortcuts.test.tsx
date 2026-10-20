// @vitest-environment jsdom

import { act, useRef } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  isPhotoEditingControlTarget,
  isPhotoEditingTypingTarget,
  isWithinPhotoEditingScope,
  resolvePhotoEditingShortcut,
  usePhotoEditingShortcuts,
  type PhotoEditingShortcut,
  type PhotoEditingShortcutKeyEvent,
} from "./use-photo-editing-shortcuts";

function keyEvent(init: Partial<PhotoEditingShortcutKeyEvent> & { key: string }): PhotoEditingShortcutKeyEvent {
  return {
    metaKey: false,
    ctrlKey: false,
    altKey: false,
    shiftKey: false,
    isComposing: false,
    defaultPrevented: false,
    ...init,
  };
}

const ON_PAGE = { typing: false, onControl: false };

describe("resolvePhotoEditingShortcut", () => {
  it("G / E で見せ方、Esc、⌘A（Ctrl+A）、Enter、矢印", () => {
    expect(resolvePhotoEditingShortcut(keyEvent({ key: "g" }), ON_PAGE)).toBe("grid");
    expect(resolvePhotoEditingShortcut(keyEvent({ key: "G", shiftKey: true }), ON_PAGE)).toBe("grid");
    expect(resolvePhotoEditingShortcut(keyEvent({ key: "e" }), ON_PAGE)).toBe("loupe");
    expect(resolvePhotoEditingShortcut(keyEvent({ key: "Escape" }), ON_PAGE)).toBe("escape");
    expect(resolvePhotoEditingShortcut(keyEvent({ key: "a", metaKey: true }), ON_PAGE)).toBe("selectAll");
    expect(resolvePhotoEditingShortcut(keyEvent({ key: "A", ctrlKey: true }), ON_PAGE)).toBe("selectAll");
    expect(resolvePhotoEditingShortcut(keyEvent({ key: "Enter" }), ON_PAGE)).toBe("open");
    for (const key of ["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown"]) {
      expect(resolvePhotoEditingShortcut(keyEvent({ key, shiftKey: true }), ON_PAGE)).toBe("arrow");
    }
    expect(resolvePhotoEditingShortcut(keyEvent({ key: "x" }), ON_PAGE)).toBeNull();
  });

  it("修飾キー付きの G / E・⌘ 付きのほかのキー・Option 付きは扱わない", () => {
    expect(resolvePhotoEditingShortcut(keyEvent({ key: "g", metaKey: true }), ON_PAGE)).toBeNull();
    expect(resolvePhotoEditingShortcut(keyEvent({ key: "e", altKey: true }), ON_PAGE)).toBeNull();
    expect(resolvePhotoEditingShortcut(keyEvent({ key: "a", metaKey: true, shiftKey: true }), ON_PAGE)).toBeNull();
    expect(resolvePhotoEditingShortcut(keyEvent({ key: "ArrowRight", metaKey: true }), ON_PAGE)).toBeNull();
    expect(resolvePhotoEditingShortcut(keyEvent({ key: "Enter", shiftKey: true }), ON_PAGE)).toBeNull();
  });

  it("文字を打っている・IME で変換中・ほかの処理が使ったキーは扱わない", () => {
    expect(resolvePhotoEditingShortcut(keyEvent({ key: "g" }), { typing: true, onControl: false })).toBeNull();
    expect(resolvePhotoEditingShortcut(keyEvent({ key: "a", metaKey: true }), { typing: true, onControl: false })).toBeNull();
    expect(resolvePhotoEditingShortcut(keyEvent({ key: "e", isComposing: true }), ON_PAGE)).toBeNull();
    expect(resolvePhotoEditingShortcut(keyEvent({ key: "Escape", defaultPrevented: true }), ON_PAGE)).toBeNull();
  });

  it("ボタンなどの上では Enter・矢印はその操作のもの（G / E / Esc / ⌘A / ⌫ は扱う）", () => {
    const onControl = { typing: false, onControl: true };
    expect(resolvePhotoEditingShortcut(keyEvent({ key: "Enter" }), onControl)).toBeNull();
    expect(resolvePhotoEditingShortcut(keyEvent({ key: "ArrowDown" }), onControl)).toBeNull();
    expect(resolvePhotoEditingShortcut(keyEvent({ key: "g" }), onControl)).toBe("grid");
    expect(resolvePhotoEditingShortcut(keyEvent({ key: "Escape" }), onControl)).toBe("escape");
    expect(resolvePhotoEditingShortcut(keyEvent({ key: "a", metaKey: true }), onControl)).toBe("selectAll");
    // グリッドのタイル（ボタン）にフォーカスがあっても消せる
    expect(resolvePhotoEditingShortcut(keyEvent({ key: "Backspace" }), onControl)).toBe("delete");
  });

  it("⌫ / Delete は「クラウドから消す」。文字を打っている・IME で変換中・修飾キー付き（⌘⌫ など）は扱わない（#16687）", () => {
    expect(resolvePhotoEditingShortcut(keyEvent({ key: "Backspace" }), ON_PAGE)).toBe("delete");
    expect(resolvePhotoEditingShortcut(keyEvent({ key: "Delete" }), ON_PAGE)).toBe("delete");
    expect(resolvePhotoEditingShortcut(keyEvent({ key: "Backspace" }), { typing: true, onControl: false })).toBeNull();
    expect(resolvePhotoEditingShortcut(keyEvent({ key: "Backspace", isComposing: true }), ON_PAGE)).toBeNull();
    expect(resolvePhotoEditingShortcut(keyEvent({ key: "Backspace", metaKey: true }), ON_PAGE)).toBeNull();
    expect(resolvePhotoEditingShortcut(keyEvent({ key: "Delete", altKey: true }), ON_PAGE)).toBeNull();
  });
});

describe("キーを押した場所", () => {
  it("文字を打つ欄（テキストの input・textarea・select・contenteditable）だけを文字入力とみなす", () => {
    const text = document.createElement("input");
    const range = document.createElement("input");
    range.type = "range";
    const checkbox = document.createElement("input");
    checkbox.type = "checkbox";
    const editable = document.createElement("div");
    editable.setAttribute("contenteditable", "true");
    expect(isPhotoEditingTypingTarget(text)).toBe(true);
    expect(isPhotoEditingTypingTarget(document.createElement("textarea"))).toBe(true);
    expect(isPhotoEditingTypingTarget(document.createElement("select"))).toBe(true);
    expect(isPhotoEditingTypingTarget(editable)).toBe(true);
    expect(isPhotoEditingTypingTarget(range)).toBe(false);
    expect(isPhotoEditingTypingTarget(checkbox)).toBe(false);
    expect(isPhotoEditingTypingTarget(document.createElement("button"))).toBe(false);
    expect(isPhotoEditingTypingTarget(null)).toBe(false);
  });

  it("ボタン・リンク・入力・メニューの項目（とその中）を操作とみなす", () => {
    const button = document.createElement("button");
    const icon = document.createElement("span");
    button.appendChild(icon);
    expect(isPhotoEditingControlTarget(button)).toBe(true);
    expect(isPhotoEditingControlTarget(icon)).toBe(true);
    expect(isPhotoEditingControlTarget(document.createElement("input"))).toBe(true);
    expect(isPhotoEditingControlTarget(document.createElement("div"))).toBe(false);
    expect(isPhotoEditingControlTarget(document.body)).toBe(false);
  });

  it("画面の中・どこにもフォーカスが無い（body）・画面を包む枠だけを扱い、ほかの場所（別のダイアログなど）は扱わない", () => {
    const frame = document.createElement("div");
    const root = document.createElement("div");
    const inside = document.createElement("button");
    const outside = document.createElement("button");
    root.appendChild(inside);
    frame.appendChild(root);
    document.body.append(frame, outside);
    try {
      expect(isWithinPhotoEditingScope(root, inside)).toBe(true);
      expect(isWithinPhotoEditingScope(root, root)).toBe(true);
      expect(isWithinPhotoEditingScope(root, frame)).toBe(true);
      expect(isWithinPhotoEditingScope(root, document.body)).toBe(true);
      expect(isWithinPhotoEditingScope(root, document)).toBe(true);
      expect(isWithinPhotoEditingScope(root, outside)).toBe(false);
      expect(isWithinPhotoEditingScope(root, null)).toBe(false);
    } finally {
      frame.remove();
      outside.remove();
    }
  });
});

describe("usePhotoEditingShortcuts", () => {
  let container: HTMLDivElement;
  let root: Root;
  let onShortcut: ReturnType<typeof vi.fn<(shortcut: PhotoEditingShortcut, event: KeyboardEvent) => void>>;

  function Harness(props: { handleEscape: boolean; enabled?: boolean }) {
    const rootRef = useRef<HTMLDivElement | null>(null);
    const portalRef = useRef<HTMLDivElement | null>(null);
    usePhotoEditingShortcuts({
      rootRef,
      additionalRootRef: portalRef,
      handleEscape: props.handleEscape,
      enabled: props.enabled,
      onShortcut,
    });
    return (
      <>
        <div ref={rootRef}>
          <button type="button">書き出す</button>
          <input aria-label="名前" />
        </div>
        <div ref={portalRef} data-testid="photo-editing-portal" />
      </>
    );
  }

  async function renderHarness(handleEscape = true, enabled?: boolean): Promise<void> {
    await act(async () => {
      root.render(<Harness handleEscape={handleEscape} enabled={enabled} />);
    });
  }

  function press(target: EventTarget, init: KeyboardEventInit): KeyboardEvent {
    const event = new KeyboardEvent("keydown", { bubbles: true, cancelable: true, ...init });
    target.dispatchEvent(event);
    return event;
  }

  beforeEach(() => {
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    onShortcut = vi.fn();
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(async () => {
    await act(async () => {
      root.unmount();
    });
    container.remove();
  });

  it("画面の中と body のキーを渡し、文字を打つ欄・画面の外・ほかの処理が使ったキーは渡さない", async () => {
    await renderHarness();
    const button = container.querySelector("button") as HTMLButtonElement;
    const input = container.querySelector("input") as HTMLInputElement;

    press(document.body, { key: "g" });
    press(button, { key: "e" });
    expect(onShortcut.mock.calls.map(([shortcut]) => shortcut)).toEqual(["grid", "loupe"]);

    press(input, { key: "g" });
    const outside = document.createElement("button");
    document.body.appendChild(outside);
    press(outside, { key: "g" });
    outside.remove();
    const used = new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true });
    used.preventDefault();
    document.body.dispatchEvent(used);
    // ボタンの上の Enter はボタンのもの
    press(button, { key: "Enter" });
    expect(onShortcut).toHaveBeenCalledTimes(2);
  });

  it("ポータルで描画した編集層も同じショートカット範囲に含める", async () => {
    await renderHarness();
    const portal = container.querySelector('[data-testid="photo-editing-portal"]') as HTMLElement;
    press(portal, { key: "g" });
    expect(onShortcut.mock.calls.map(([shortcut]) => shortcut)).toEqual(["grid"]);
  });

  it("enabled が false の間はどのキーも渡さず（設定サブタブで画面を隠している間）、true に戻すと再び効く。省くと効く", async () => {
    await renderHarness(true, false);
    const button = container.querySelector("button") as HTMLButtonElement;
    for (const init of [
      { key: "g" },
      { key: "e" },
      { key: "Escape" },
      { key: "a", metaKey: true },
      { key: "Enter" },
      { key: "ArrowRight" },
    ]) {
      press(document.body, init);
      press(button, init);
    }
    expect(onShortcut).not.toHaveBeenCalled();

    await renderHarness(true, true);
    press(document.body, { key: "g" });
    expect(onShortcut.mock.calls.map(([shortcut]) => shortcut)).toEqual(["grid"]);

    // また隠したら聞くのをやめ、戻したら聞き直す（listener を二重に付けない）
    await renderHarness(true, false);
    press(document.body, { key: "e" });
    expect(onShortcut).toHaveBeenCalledTimes(1);
    await renderHarness(true, true);
    press(document.body, { key: "e" });
    expect(onShortcut.mock.calls.map(([shortcut]) => shortcut)).toEqual(["grid", "loupe"]);

    // 省いたら（既定）効く
    await renderHarness(true);
    press(document.body, { key: "g" });
    expect(onShortcut.mock.calls.map(([shortcut]) => shortcut)).toEqual(["grid", "loupe", "grid"]);
  });

  it("Esc を扱わない（ダイアログの中）ときは Esc だけ渡さない。外したら聞かない", async () => {
    await renderHarness(false);
    press(document.body, { key: "Escape" });
    press(document.body, { key: "g" });
    expect(onShortcut.mock.calls.map(([shortcut]) => shortcut)).toEqual(["grid"]);

    await act(async () => {
      root.unmount();
    });
    press(document.body, { key: "e" });
    expect(onShortcut).toHaveBeenCalledTimes(1);
    root = createRoot(container);
  });
});
