// @vitest-environment jsdom

import { act, useRef } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { DevelopFrame } from "../develop-engine/develop-engine-client";

import {
  PHOTO_EDITING_HISTOGRAM_MIN_INTERVAL_MS,
  useBrowserPhotoHistogram,
  type PhotoEditingFrameSink,
} from "./use-browser-photo-histogram";
import { useBrowserPhotoEditingKeys } from "./use-browser-photo-editing-keys";

/**
 * 右パネルのヒストグラムの持ち主（niho-photo#36）。描いた画を口で受け、`enabled` の間だけ、最新の 1 枚を間隔を空けて数える。
 * 写真を替えたら前の写真の分布は出さない。J で黒つぶれ・白飛びの印をまとめて切り替える。
 */

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

type HookResult = ReturnType<typeof useBrowserPhotoHistogram>;

let container: HTMLDivElement;
let root: Root;
let sink: { current: PhotoEditingFrameSink | null };
let result: HookResult;

function Probe(props: { photoKey: string | null; enabled: boolean }) {
  const ref = useRef<PhotoEditingFrameSink | null>(null);
  sink = ref;
  result = useBrowserPhotoHistogram({ sinkRef: ref, photoKey: props.photoKey, enabled: props.enabled });
  return null;
}

async function mount(props: { photoKey: string | null; enabled: boolean }) {
  await act(async () => {
    root.render(<Probe {...props} />);
  });
}

/** 全画素が (r, g, b) の 2x2 の画。 */
function frame(r: number, g: number, b: number): DevelopFrame {
  const rgba = new Uint8ClampedArray(2 * 2 * 4);
  for (let offset = 0; offset < rgba.length; offset += 4) rgba.set([r, g, b, 255], offset);
  return { width: 2, height: 2, rgba };
}

/** 画を口に渡して、タイマーを進める。 */
async function paint(key: string, next: DevelopFrame, advanceMs = PHOTO_EDITING_HISTOGRAM_MIN_INTERVAL_MS) {
  await act(async () => {
    sink.current?.(key, next);
    await vi.advanceTimersByTimeAsync(advanceMs);
  });
}

beforeEach(() => {
  vi.useFakeTimers();
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.useRealTimers();
});

describe("useBrowserPhotoHistogram", () => {
  it("口で受けた画を数えて、今の写真の分布として返す", async () => {
    await mount({ photoKey: "a", enabled: true });
    expect(result.histogram).toBeNull();
    await paint("a", frame(0, 128, 255));
    expect(result.histogram?.pixelCount).toBe(4);
    expect(result.histogram?.red[0]).toBe(4);
    expect(result.histogram?.shadowRate).toBe(1);
    expect(result.histogram?.highlightRate).toBe(1);
    // 印を重ねていない間は、印を数えない
    expect(result.histogram?.clipMask).toBeNull();
  });

  it("使わない間（enabled=false。スマホ・S1 の canvas）は数えない。使い始めたら覚えていた最新の画を数える", async () => {
    await mount({ photoKey: "a", enabled: false });
    await paint("a", frame(10, 10, 10), 500);
    expect(result.histogram).toBeNull();
    await mount({ photoKey: "a", enabled: true });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(PHOTO_EDITING_HISTOGRAM_MIN_INTERVAL_MS);
    });
    expect(result.histogram?.red[10]).toBe(4);
  });

  it("つまみを動かして画が次々に来ても、間隔を空けて最新の 1 枚だけ数える（途中の画は数えない）", async () => {
    await mount({ photoKey: "a", enabled: true });
    // 数え終えた直後（間隔はまだ空いていない）
    await paint("a", frame(20, 20, 20), 0);
    expect(result.histogram?.red[20]).toBe(4);

    // 次の画が間隔の内に 3 枚続けて来る → 間隔が空くまで数えず、空いたら最後の 1 枚だけ
    await act(async () => {
      sink.current?.("a", frame(30, 30, 30));
      sink.current?.("a", frame(40, 40, 40));
      sink.current?.("a", frame(50, 50, 50));
      await vi.advanceTimersByTimeAsync(10);
    });
    expect(result.histogram?.red[20]).toBe(4);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(PHOTO_EDITING_HISTOGRAM_MIN_INTERVAL_MS);
    });
    expect(result.histogram?.red[50]).toBe(4);
    expect(result.histogram?.red[30]).toBe(0);
    expect(result.histogram?.red[40]).toBe(0);
  });

  it("200ms 以内に更新される（画を受けてから）", async () => {
    await mount({ photoKey: "a", enabled: true });
    await paint("a", frame(1, 1, 1));
    await act(async () => {
      sink.current?.("a", frame(99, 99, 99));
      await vi.advanceTimersByTimeAsync(200);
    });
    expect(result.histogram?.red[99]).toBe(4);
  });

  it("同じ画を続けて渡しても数え直さない", async () => {
    await mount({ photoKey: "a", enabled: true });
    const same = frame(5, 5, 5);
    await paint("a", same);
    const first = result.histogram;
    await paint("a", same, 200);
    expect(result.histogram).toBe(first);
  });

  it("写真を替えたら前の写真の分布は出さず、前の写真の画も数えない", async () => {
    await mount({ photoKey: "a", enabled: true });
    await paint("a", frame(60, 60, 60));
    expect(result.histogram?.red[60]).toBe(4);
    await mount({ photoKey: "b", enabled: true });
    expect(result.histogram).toBeNull();
    // 前の写真の画が遅れて届いても出さない
    await paint("a", frame(70, 70, 70), 200);
    expect(result.histogram).toBeNull();
    await paint("b", frame(80, 80, 80));
    expect(result.histogram?.red[80]).toBe(4);
    // 閉じたら捨てる
    await mount({ photoKey: null, enabled: false });
    expect(result.histogram).toBeNull();
  });

  it("写真の key が追いつく前に届いた画は、key が追いついたら数える", async () => {
    await mount({ photoKey: "a", enabled: true });
    await paint("b", frame(90, 90, 90), 200);
    expect(result.histogram).toBeNull();
    await mount({ photoKey: "b", enabled: true });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(PHOTO_EDITING_HISTOGRAM_MIN_INTERVAL_MS);
    });
    expect(result.histogram?.red[90]).toBe(4);
  });

  it("印を重ね始めたら、覚えている画から印も数える。外したら印は捨てる", async () => {
    await mount({ photoKey: "a", enabled: true });
    await paint("a", frame(0, 100, 100));
    expect(result.histogram?.clipMask).toBeNull();
    await act(async () => result.toggleShadows());
    await act(async () => {
      await vi.advanceTimersByTimeAsync(PHOTO_EDITING_HISTOGRAM_MIN_INTERVAL_MS);
    });
    expect(result.clip).toEqual({ shadows: true, highlights: false });
    expect(result.histogram?.clipMask?.flags).toHaveLength(4);
    await act(async () => result.toggleShadows());
    await act(async () => {
      await vi.advanceTimersByTimeAsync(PHOTO_EDITING_HISTOGRAM_MIN_INTERVAL_MS);
    });
    expect(result.clip).toEqual({ shadows: false, highlights: false });
    expect(result.histogram?.clipMask).toBeNull();
  });

  it("J（toggleBoth）: 両方 OFF なら両方 ON、どちらかが ON なら両方 OFF。写真を替えても保つ", async () => {
    await mount({ photoKey: "a", enabled: true });
    await act(async () => result.toggleBoth());
    expect(result.clip).toEqual({ shadows: true, highlights: true });
    await act(async () => result.toggleBoth());
    expect(result.clip).toEqual({ shadows: false, highlights: false });
    await act(async () => result.toggleHighlights());
    expect(result.clip).toEqual({ shadows: false, highlights: true });
    await act(async () => result.toggleBoth());
    expect(result.clip).toEqual({ shadows: false, highlights: false });
    await act(async () => result.toggleShadows());
    await mount({ photoKey: "b", enabled: true });
    expect(result.clip).toEqual({ shadows: true, highlights: false });
  });

  it("画面を離れたら口を外し、待っているタイマーも止める", async () => {
    await mount({ photoKey: "a", enabled: true });
    const attached = sink;
    expect(attached.current).not.toBeNull();
    await act(async () => {
      attached.current?.("a", frame(3, 3, 3));
      root.unmount();
    });
    expect(attached.current).toBeNull();
    expect(vi.getTimerCount()).toBe(0);
    root = createRoot(container);
  });
});

describe("J キー（useBrowserPhotoEditingKeys の onToggleClipping）", () => {
  function KeyProbe(props: {
    onToggleClipping: (() => void) | null;
    onToggleTool?: (() => void) | null;
    enabled?: boolean;
    clippingEnabled?: boolean;
  }) {
    const rootRef = useRef<HTMLElement | null>(null);
    useBrowserPhotoEditingKeys({
      rootRef,
      enabled: props.enabled ?? true,
      clippingEnabled: props.clippingEnabled,
      onUndo: vi.fn(),
      onRedo: vi.fn(),
      onCopy: vi.fn(),
      onPaste: vi.fn(),
      onCompareOriginalChange: vi.fn(),
      onToggleTool: props.onToggleTool,
      onToggleClipping: props.onToggleClipping,
    });
    return <main ref={rootRef}><input aria-label="値" /><button type="button">ボタン</button></main>;
  }

  function press(target: Element | null, init: KeyboardEventInit & { key: string }): KeyboardEvent {
    const event = new KeyboardEvent("keydown", { bubbles: true, cancelable: true, ...init });
    (target ?? document.body).dispatchEvent(event);
    return event;
  }

  async function renderKeys(props: {
    onToggleClipping: (() => void) | null;
    onToggleTool?: (() => void) | null;
    enabled?: boolean;
    clippingEnabled?: boolean;
  }) {
    await act(async () => {
      root.render(<KeyProbe {...props} />);
    });
  }

  it("J で呼ぶ。押しっぱなしの繰り返し・修飾キーつき・入力欄の中では呼ばない", async () => {
    const toggle = vi.fn();
    await renderKeys({ onToggleClipping: toggle });
    const button = container.querySelector("button");
    const input = container.querySelector("input");

    const handled = press(button, { key: "j" });
    expect(toggle).toHaveBeenCalledTimes(1);
    expect(handled.defaultPrevented).toBe(true);

    press(button, { key: "j", repeat: true });
    press(button, { key: "j", shiftKey: true });
    press(button, { key: "j", altKey: true });
    press(button, { key: "j", metaKey: true });
    press(button, { key: "j", ctrlKey: true });
    press(input, { key: "j" });
    expect(toggle).toHaveBeenCalledTimes(1);

    press(button, { key: "J" });
    expect(toggle).toHaveBeenCalledTimes(2);
  });

  it("口が無い間（ヒストグラムを出していない・切り抜きの間）は何もせず、キーを横取りしない", async () => {
    await renderKeys({ onToggleClipping: null });
    const event = press(container.querySelector("button"), { key: "j" });
    expect(event.defaultPrevented).toBe(false);
  });

  it("補正のキー全体が無効（enabled=false）の間は呼ばない", async () => {
    const toggle = vi.fn();
    await renderKeys({ onToggleClipping: toggle, enabled: false });
    press(container.querySelector("button"), { key: "j" });
    expect(toggle).not.toHaveBeenCalled();
  });

  it("閲覧専用でも、表示切替の J だけを有効にできる", async () => {
    const toggle = vi.fn();
    const toggleTool = vi.fn();
    await renderKeys({ onToggleClipping: toggle, onToggleTool: toggleTool, enabled: false, clippingEnabled: true });
    const button = container.querySelector("button");

    const clipping = press(button, { key: "j" });
    expect(clipping.defaultPrevented).toBe(true);
    expect(toggle).toHaveBeenCalledTimes(1);

    const editing = press(button, { key: "r" });
    expect(editing.defaultPrevented).toBe(false);
    expect(toggleTool).not.toHaveBeenCalled();
  });
});
