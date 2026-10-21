// @vitest-environment jsdom

import { act, useEffect, useRef } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { PhotoLibraryFlag } from "../library/photo-library";

import { resolveBrowserPhotoFlagKey, useBrowserPhotoFlagKeys } from "./use-browser-photo-flag-keys";

/**
 * 選別のキー（niho-photo#47）: P = 採用・X = 却下・U = 外す。修飾キーつき・文字を打つ欄・IME の変換中・ほかが使ったキー・画面の外・
 * 押しっぱなしの繰り返しは扱わない。写真の上のキーを使う道具が先に扱ったキー（`defaultPrevented`）は道具に譲る。
 */

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

function keyEvent(
  key: string,
  init: { metaKey?: boolean; ctrlKey?: boolean; shiftKey?: boolean; altKey?: boolean; defaultPrevented?: boolean; isComposing?: boolean } = {},
) {
  return {
    key,
    metaKey: init.metaKey ?? false,
    ctrlKey: init.ctrlKey ?? false,
    shiftKey: init.shiftKey ?? false,
    altKey: init.altKey ?? false,
    defaultPrevented: init.defaultPrevented ?? false,
    isComposing: init.isComposing ?? false,
  };
}

describe("resolveBrowserPhotoFlagKey", () => {
  it("P / X / U（大文字・Shift でも）が採用・却下・外す。ほかのキーは扱わない", () => {
    expect(resolveBrowserPhotoFlagKey(keyEvent("p"), { typing: false })).toBe("pick");
    expect(resolveBrowserPhotoFlagKey(keyEvent("P", { shiftKey: true }), { typing: false })).toBe("pick");
    expect(resolveBrowserPhotoFlagKey(keyEvent("x"), { typing: false })).toBe("reject");
    expect(resolveBrowserPhotoFlagKey(keyEvent("X"), { typing: false })).toBe("reject");
    expect(resolveBrowserPhotoFlagKey(keyEvent("u"), { typing: false })).toBe("clear");
    expect(resolveBrowserPhotoFlagKey(keyEvent("U"), { typing: false })).toBe("clear");
    for (const key of ["g", "e", "r", "j", "y", "o", "[", "Enter", "Delete"]) {
      expect(resolveBrowserPhotoFlagKey(keyEvent(key), { typing: false })).toBeNull();
    }
  });

  it("⌘ ⌃ ⌥ つき・文字を打つ欄・IME の変換中・ほかが使ったキーは扱わない（⌘X・⌘P は今までどおり）", () => {
    expect(resolveBrowserPhotoFlagKey(keyEvent("x", { metaKey: true }), { typing: false })).toBeNull();
    expect(resolveBrowserPhotoFlagKey(keyEvent("p", { metaKey: true }), { typing: false })).toBeNull();
    expect(resolveBrowserPhotoFlagKey(keyEvent("u", { ctrlKey: true }), { typing: false })).toBeNull();
    expect(resolveBrowserPhotoFlagKey(keyEvent("x", { altKey: true }), { typing: false })).toBeNull();
    expect(resolveBrowserPhotoFlagKey(keyEvent("p"), { typing: true })).toBeNull();
    expect(resolveBrowserPhotoFlagKey(keyEvent("p", { isComposing: true }), { typing: false })).toBeNull();
    expect(resolveBrowserPhotoFlagKey(keyEvent("x", { defaultPrevented: true }), { typing: false })).toBeNull();
  });
});

describe("useBrowserPhotoFlagKeys", () => {
  let container: HTMLDivElement;
  let root: Root;
  let screen: HTMLElement;
  let outside: HTMLElement;

  beforeEach(() => {
    container = document.createElement("div");
    screen = document.createElement("section");
    outside = document.createElement("div");
    document.body.append(container, screen, outside);
    root = createRoot(container);
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    container.remove();
    screen.remove();
    outside.remove();
  });

  function press(target: EventTarget, key: string, init: KeyboardEventInit = {}) {
    const event = new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true, ...init });
    target.dispatchEvent(event);
    return event;
  }

  function Keys(props: { enabled: boolean; onFlag: (flag: PhotoLibraryFlag | null) => void; toolKey?: string }) {
    const rootRef = useRef<HTMLElement | null>(screen);
    const { toolKey } = props;
    // 写真の上のキーを使う道具（先に足した listener）が自分のキーを使う
    useEffect(() => {
      if (!toolKey) return;
      const handle = (event: KeyboardEvent) => {
        if (event.key === toolKey) event.preventDefault();
      };
      document.addEventListener("keydown", handle);
      return () => document.removeEventListener("keydown", handle);
    }, [toolKey]);
    useBrowserPhotoFlagKeys({ rootRef, enabled: props.enabled, onFlag: props.onFlag });
    return null;
  }

  it("聞いている間だけ、画面の中・どこにもフォーカスが無いときに付け外しし、既定の動きを止める。繰り返し・画面の外は扱わない", async () => {
    const onFlag = vi.fn<(flag: PhotoLibraryFlag | null) => void>();
    await act(async () => root.render(<Keys enabled={false} onFlag={onFlag} />));
    press(screen, "p");
    expect(onFlag).not.toHaveBeenCalled();

    await act(async () => root.render(<Keys enabled onFlag={onFlag} />));
    const event = press(screen, "p");
    expect(onFlag).toHaveBeenLastCalledWith("pick");
    expect(event.defaultPrevented).toBe(true);
    press(document.body, "x");
    expect(onFlag).toHaveBeenLastCalledWith("reject");
    // タイル・帯の升（ボタン）の上でも効く
    const tile = document.createElement("button");
    screen.append(tile);
    press(tile, "U");
    expect(onFlag).toHaveBeenLastCalledWith(null);
    expect(onFlag).toHaveBeenCalledTimes(3);

    // 押しっぱなしの繰り返しは既定の動きだけ止める
    const repeated = press(screen, "p", { repeat: true });
    expect(repeated.defaultPrevented).toBe(true);
    // 画面の外・文字を打つ欄・修飾キーつき・IME の変換中
    press(outside, "p");
    const input = document.createElement("input");
    input.type = "text";
    screen.append(input);
    press(input, "x");
    press(screen, "x", { metaKey: true });
    press(screen, "x", { isComposing: true });
    expect(onFlag).toHaveBeenCalledTimes(3);
  });

  it("写真の上のキーを使う道具が先に使ったキーは道具に譲る", async () => {
    const onFlag = vi.fn<(flag: PhotoLibraryFlag | null) => void>();
    await act(async () => root.render(<Keys enabled onFlag={onFlag} toolKey="x" />));
    press(screen, "x");
    expect(onFlag).not.toHaveBeenCalled();
    press(screen, "p");
    expect(onFlag).toHaveBeenLastCalledWith("pick");
  });
});
