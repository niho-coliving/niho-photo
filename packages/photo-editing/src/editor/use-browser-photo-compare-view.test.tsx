// @vitest-environment jsdom

import { act, useRef } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  BROWSER_PHOTO_COMPARE_SPLIT_INITIAL,
  clampBrowserPhotoCompareSplit,
  nextBrowserPhotoCompareMode,
  useBrowserPhotoCompareView,
  type BrowserPhotoCompareView,
} from "./use-browser-photo-compare-view";
import { useBrowserPhotoEditingKeys } from "./use-browser-photo-editing-keys";

/**
 * 補正前と補正後を見比べる表示の状態（niho-photo#41）。並べる / 分割 / 戻すの行き来、写真が替わる・切り抜き / 背景除去の道具で
 * 閉じる（開き直さない）、境界の位置の保ち方と、面のキー（Y / Shift+Y・押している間の補正前 `\`）との組み合わせ。
 */

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLDivElement;
let root: Root;
let view: BrowserPhotoCompareView;
let onCompareOriginalChange: ReturnType<typeof vi.fn<(compare: boolean) => void>>;

type HarnessProps = { scopeKey: string | null; available: boolean };

/** 面と同じつなぎ方: 比較の間は `\` を扱わず、使えない間は Y / Shift+Y を扱わない。 */
function Harness(props: HarnessProps) {
  const rootRef = useRef<HTMLDivElement | null>(null);
  view = useBrowserPhotoCompareView(props);
  const mode = view.mode;
  const change = view.change;
  useBrowserPhotoEditingKeys({
    rootRef,
    enabled: true,
    onUndo: () => undefined,
    onRedo: () => undefined,
    onCopy: () => undefined,
    onPaste: () => undefined,
    onCompareOriginalChange,
    compareEnabled: mode === "off",
    onToggleCompareView: props.available ? (key) => change(nextBrowserPhotoCompareMode(mode, key)) : null,
  });
  return (
    <div ref={rootRef}>
      <input aria-label="値" />
      <button type="button">ボタン</button>
    </div>
  );
}

async function render(props: HarnessProps) {
  await act(async () => {
    root.render(<Harness {...props} />);
  });
}

async function key(type: "keydown" | "keyup", init: KeyboardEventInit, target: EventTarget = document.body) {
  const event = new KeyboardEvent(type, { bubbles: true, cancelable: true, ...init });
  await act(async () => {
    target.dispatchEvent(event);
  });
  return event;
}

beforeEach(() => {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  onCompareOriginalChange = vi.fn();
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

describe("nextBrowserPhotoCompareMode", () => {
  it("Y は 戻す ⇄ 並べる（分割からも戻す）、Shift+Y は 戻す / 並べる → 分割、分割 → 戻す", () => {
    expect(nextBrowserPhotoCompareMode("off", "side")).toBe("side");
    expect(nextBrowserPhotoCompareMode("side", "side")).toBe("off");
    expect(nextBrowserPhotoCompareMode("split", "side")).toBe("off");
    expect(nextBrowserPhotoCompareMode("off", "split")).toBe("split");
    expect(nextBrowserPhotoCompareMode("side", "split")).toBe("split");
    expect(nextBrowserPhotoCompareMode("split", "split")).toBe("off");
  });

  it("境界の位置は 0〜100 に収め、数でなければ初めの位置", () => {
    expect(clampBrowserPhotoCompareSplit(-5)).toBe(0);
    expect(clampBrowserPhotoCompareSplit(140)).toBe(100);
    expect(clampBrowserPhotoCompareSplit(37.5)).toBe(37.5);
    expect(clampBrowserPhotoCompareSplit(Number.NaN)).toBe(BROWSER_PHOTO_COMPARE_SPLIT_INITIAL);
  });
});

describe("useBrowserPhotoCompareView", () => {
  it("並べる → 分割 → 戻すを切り替え、境界の位置は閉じるまで保つ（初めは 50%）", async () => {
    await render({ scopeKey: "page:a", available: true });
    expect(view.mode).toBe("off");
    expect(view.split).toBe(50);

    await act(async () => view.change("split"));
    expect(view.mode).toBe("split");
    await act(async () => view.setSplit(30));
    expect(view.split).toBe(30);
    await act(async () => view.change("side"));
    expect(view.mode).toBe("side");
    await act(async () => view.change("split"));
    expect(view.split).toBe(30);

    await act(async () => view.change("off"));
    expect(view.mode).toBe("off");
    await act(async () => view.change("split"));
    expect(view.split).toBe(50);
  });

  it("写真（面）が替わったら閉じる。同じ写真に戻っても開き直さない", async () => {
    await render({ scopeKey: "page:a", available: true });
    await act(async () => view.change("side"));
    await render({ scopeKey: "page:b", available: true });
    expect(view.mode).toBe("off");
    await render({ scopeKey: "page:a", available: true });
    expect(view.mode).toBe("off");
    // 写真が無い間（一覧）も閉じる
    await act(async () => view.change("side"));
    await render({ scopeKey: null, available: true });
    expect(view.mode).toBe("off");
  });

  it("使えなくなった（切り抜き・背景除去の道具）ら閉じ、使えるように戻っても開き直さない。使えない間は開かない", async () => {
    await render({ scopeKey: "page:a", available: true });
    await act(async () => view.change("split"));
    await act(async () => view.setSplit(80));
    await render({ scopeKey: "page:a", available: false });
    expect(view.mode).toBe("off");
    await act(async () => view.change("side"));
    expect(view.mode).toBe("off");
    await render({ scopeKey: "page:a", available: true });
    expect(view.mode).toBe("off");
    await act(async () => view.change("split"));
    expect(view.split).toBe(50);
  });

  it("閉じている間は境界を動かさない", async () => {
    await render({ scopeKey: "page:a", available: true });
    await act(async () => view.setSplit(10));
    await act(async () => view.change("split"));
    expect(view.split).toBe(50);
  });
});

describe("Y / Shift+Y と押している間の補正前（\\）", () => {
  it("Y で並べる ⇄ 戻す、Shift+Y で分割 ⇄ 戻す。キーの既定の働きは止める", async () => {
    await render({ scopeKey: "page:a", available: true });
    const first = await key("keydown", { key: "y" });
    expect(first.defaultPrevented).toBe(true);
    expect(view.mode).toBe("side");
    await key("keydown", { key: "Y", shiftKey: true });
    expect(view.mode).toBe("split");
    await key("keydown", { key: "y" });
    expect(view.mode).toBe("off");
    await key("keydown", { key: "Y", shiftKey: true });
    expect(view.mode).toBe("split");
    await key("keydown", { key: "Y", shiftKey: true });
    expect(view.mode).toBe("off");
  });

  it("押しっぱなしの繰り返し・⌘ ⌃ ⌥ つき・文字を打つ欄・IME の変換中は扱わない", async () => {
    await render({ scopeKey: "page:a", available: true });
    await key("keydown", { key: "y", repeat: true });
    expect(view.mode).toBe("off");
    for (const modifier of [{ metaKey: true }, { ctrlKey: true }, { altKey: true }]) {
      const event = await key("keydown", { key: "y", ...modifier });
      expect(event.defaultPrevented).toBe(false);
      expect(view.mode).toBe("off");
    }
    const input = container.querySelector("input");
    await key("keydown", { key: "y" }, input!);
    expect(view.mode).toBe("off");
    await key("keydown", { key: "y", isComposing: true });
    expect(view.mode).toBe("off");
    // ボタンの上では扱う（ボタンに Y の働きは無い）
    await key("keydown", { key: "y" }, container.querySelector("button")!);
    expect(view.mode).toBe("side");
  });

  it("切り抜き / 背景除去の道具の間（使えない間）は Y を扱わない", async () => {
    await render({ scopeKey: "page:a", available: false });
    const event = await key("keydown", { key: "y" });
    expect(event.defaultPrevented).toBe(false);
    expect(view.mode).toBe("off");
  });

  it("比較の間は \\ を扱わない（補正前を重ねない）。比較していない間は今までどおり押している間だけ", async () => {
    await render({ scopeKey: "page:a", available: true });
    await key("keydown", { key: "\\" });
    expect(onCompareOriginalChange).toHaveBeenLastCalledWith(true);
    await key("keyup", { key: "\\" });
    expect(onCompareOriginalChange).toHaveBeenLastCalledWith(false);
    onCompareOriginalChange.mockClear();

    await key("keydown", { key: "y" });
    expect(view.mode).toBe("side");
    const press = await key("keydown", { key: "\\" });
    expect(press.defaultPrevented).toBe(false);
    await key("keydown", { key: "¥" });
    await key("keyup", { key: "\\" });
    expect(onCompareOriginalChange).not.toHaveBeenCalled();
    expect(view.mode).toBe("side");
  });
});
