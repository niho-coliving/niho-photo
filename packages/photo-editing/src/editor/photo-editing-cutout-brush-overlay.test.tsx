// @vitest-environment jsdom

import { act, useRef } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { CutoutPoint } from "../photo-cutout";

import { PhotoEditingCutoutBrushOverlay } from "./photo-editing-cutout-brush-overlay";

/**
 * 写真の上の背景除去のブラシ（C4 移行元設計）: 押す → 動かす → 離すで、写真（canvas）の画面の矩形に対する 0〜1 の点（外は -1〜2）を
 * 途中・確定の順に知らせること、中止・取り上げでは確定しないこと、押せない間・道具を開いていない間は何もしないこと、筆の輪。
 * jsdom は要素の大きさを測れないので、canvas と入れ物の `getBoundingClientRect` を差し替える。
 */

/** 写真は画面の (100, 50) から 400 x 200。入れ物は (0, 0) から 600 x 300。 */
const PHOTO_RECT = { left: 100, top: 50, width: 400, height: 200 };
const AREA_RECT = { left: 0, top: 0, width: 600, height: 300 };

type OverlayOptions = { enabled?: boolean; disabled?: boolean; radius?: number };

let container: HTMLDivElement;
let root: Root;
let onLiveStroke: ReturnType<typeof vi.fn<(points: CutoutPoint[] | null) => void>>;
let onCommitStroke: ReturnType<typeof vi.fn<(points: CutoutPoint[]) => void>>;

function domRect(rect: { left: number; top: number; width: number; height: number }): DOMRect {
  return {
    ...rect,
    x: rect.left,
    y: rect.top,
    right: rect.left + rect.width,
    bottom: rect.top + rect.height,
    toJSON: () => rect,
  } as DOMRect;
}

function Harness(props: OverlayOptions) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  return (
    <PhotoEditingCutoutBrushOverlay
      enabled={props.enabled ?? true}
      radius={props.radius ?? 0.05}
      disabled={props.disabled ?? false}
      targetRef={canvasRef}
      onLiveStroke={onLiveStroke}
      onCommitStroke={onCommitStroke}
    >
      <canvas ref={canvasRef} data-testid="canvas" />
    </PhotoEditingCutoutBrushOverlay>
  );
}

async function render(options: OverlayOptions = {}) {
  await act(async () => {
    root.render(<Harness {...options} />);
  });
}

function area(): HTMLElement {
  const found = container.querySelector<HTMLElement>('[data-testid="photo-cutout-brush-area"]');
  if (!found) throw new Error("brush area not found");
  return found;
}

function cursor(): HTMLElement | null {
  return container.querySelector<HTMLElement>('[data-testid="photo-cutout-brush-cursor"]');
}

async function pointer(type: string, clientX: number, clientY: number, init: PointerEventInit = {}) {
  await act(async () => {
    area().dispatchEvent(
      new PointerEvent(type, { bubbles: true, cancelable: true, clientX, clientY, pointerId: 1, button: 0, ...init }),
    );
  });
}

beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  onLiveStroke = vi.fn();
  onCommitStroke = vi.fn();
  vi.spyOn(Element.prototype, "getBoundingClientRect").mockImplementation(function (this: Element) {
    if (this instanceof HTMLCanvasElement) return domRect(PHOTO_RECT);
    if (this.getAttribute("data-testid") === "photo-cutout-brush-area") return domRect(AREA_RECT);
    return domRect({ left: 0, top: 0, width: 0, height: 0 });
  });
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  vi.restoreAllMocks();
});

describe("ストローク", () => {
  it("押す → 動かす → 離すで、写真の左上を原点に 0〜1 の点を途中・確定の順に知らせる", async () => {
    await render();
    const brush = container.querySelector('[role="group"][aria-label="背景除去のブラシ"]');
    expect(brush).toBe(area());

    await pointer("pointerdown", 100, 50);
    expect(onLiveStroke).toHaveBeenLastCalledWith([{ x: 0, y: 0 }]);
    await pointer("pointermove", 300, 150);
    expect(onLiveStroke).toHaveBeenLastCalledWith([
      { x: 0, y: 0 },
      { x: 0.5, y: 0.5 },
    ]);
    // 写真の外へ出た点も残す（-1〜2 に収める）
    await pointer("pointermove", 1500, -500);
    expect(onLiveStroke).toHaveBeenLastCalledWith([
      { x: 0, y: 0 },
      { x: 0.5, y: 0.5 },
      { x: 2, y: -1 },
    ]);
    expect(onCommitStroke).not.toHaveBeenCalled();
    await pointer("pointerup", 1500, -500);
    expect(onCommitStroke).toHaveBeenCalledTimes(1);
    expect(onCommitStroke).toHaveBeenLastCalledWith([
      { x: 0, y: 0 },
      { x: 0.5, y: 0.5 },
      { x: 2, y: -1 },
    ]);
    // 離した後の取り上げ（lostpointercapture）では何もしない
    onLiveStroke.mockClear();
    await pointer("lostpointercapture", 1500, -500);
    expect(onLiveStroke).not.toHaveBeenCalled();
    expect(onCommitStroke).toHaveBeenCalledTimes(1);
  });

  it("押しただけで離しても 1 点のストローク", async () => {
    await render();
    await pointer("pointerdown", 200, 100);
    await pointer("pointerup", 200, 100);
    expect(onCommitStroke).toHaveBeenLastCalledWith([{ x: 0.25, y: 0.25 }]);
  });

  it("中止・取り上げでは確定せず、途中の画を捨てる", async () => {
    await render();
    await pointer("pointerdown", 100, 50);
    await pointer("pointermove", 200, 100);
    await pointer("pointercancel", 200, 100);
    expect(onLiveStroke).toHaveBeenLastCalledWith(null);
    await pointer("pointerdown", 100, 50);
    await pointer("lostpointercapture", 100, 50);
    expect(onLiveStroke).toHaveBeenLastCalledWith(null);
    await pointer("pointerup", 100, 50);
    expect(onCommitStroke).not.toHaveBeenCalled();
  });

  it("左ボタン以外・別のポインタは扱わない", async () => {
    await render();
    await pointer("pointerdown", 100, 50, { button: 2 });
    expect(onLiveStroke).not.toHaveBeenCalled();
    await pointer("pointerdown", 100, 50);
    await pointer("pointermove", 300, 150, { pointerId: 2 });
    await pointer("pointerup", 300, 150, { pointerId: 2 });
    expect(onCommitStroke).not.toHaveBeenCalled();
    expect(onLiveStroke).toHaveBeenCalledTimes(1);
  });

  it("押せない間・道具を開いていない間は何もしない（入れ物は置いたまま）", async () => {
    await render({ disabled: true });
    await pointer("pointerdown", 100, 50);
    await pointer("pointermove", 300, 150);
    await pointer("pointerup", 300, 150);
    expect(onLiveStroke).not.toHaveBeenCalled();
    expect(onCommitStroke).not.toHaveBeenCalled();
    expect(cursor()).toBeNull();

    await render({ enabled: false });
    expect(area().getAttribute("role")).toBeNull();
    expect(area().getAttribute("aria-label")).toBeNull();
    expect(container.querySelector('[data-testid="canvas"]')).not.toBeNull();
    await pointer("pointerdown", 100, 50);
    await pointer("pointerup", 100, 50);
    expect(onLiveStroke).not.toHaveBeenCalled();
    expect(onCommitStroke).not.toHaveBeenCalled();
  });

  it("なぞっている途中に押せなくなったら、確定せずに途中の画を捨てる", async () => {
    await render();
    await pointer("pointerdown", 100, 50);
    await render({ disabled: true });
    expect(onLiveStroke).toHaveBeenLastCalledWith(null);
    await pointer("pointerup", 100, 50);
    expect(onCommitStroke).not.toHaveBeenCalled();
  });
});

describe("筆の輪", () => {
  it("ポインタの位置に直径 = 2 × 半径 × 写真の短い辺の輪を出し、領域から出たら消す", async () => {
    await render({ radius: 0.05 });
    expect(cursor()).toBeNull();
    await pointer("pointermove", 250, 120);
    const ring = cursor();
    expect(ring?.getAttribute("aria-hidden")).toBe("true");
    expect(ring?.style.left).toBe("250px");
    expect(ring?.style.top).toBe("120px");
    // 2 × 0.05 × 200（短い辺）
    expect(ring?.style.width).toBe("20px");
    expect(ring?.style.height).toBe("20px");
    // React の onPointerLeave は pointerout（行き先が領域の外）で来る
    await pointer("pointerout", 700, 400, { relatedTarget: document.body });
    expect(cursor()).toBeNull();
  });
});
