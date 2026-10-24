// @vitest-environment jsdom

import { act, useRef } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { DevelopSurfaceMask } from "../develop-engine/develop-masks";
import { PHOTO_EDITING_MASK_BRUSH_DEFAULT } from "../photo-editing-mask-brush";

import { PhotoEditingMaskBrushOverlay } from "./photo-editing-mask-brush-overlay";
import type { BrowserPhotoMaskBrush, PhotoEditingMaskStrokeHandle } from "./use-browser-photo-mask-brush";

/**
 * 写真の上のブラシの面（M4 #68）。jsdom は要素を測れないので、写真の canvas を入れ物の (100, 50) に 600 x 400 で置く。押してから
 * 離すまでが 1 ストローク（dab は出力の 0〜1・半径の 25% ごと）、止められたら捨てる、⌥ で消しゴム、[ ] で大きさ、塗れない間は塗らない。
 */

const MASK: DevelopSurfaceMask = {
  id: "mask-b",
  kind: "brush",
  enabled: true,
  invert: false,
  surface: { id: "a".repeat(64), width: 1024, height: 683 },
  adjust: {},
};

let container: HTMLDivElement;
let root: Root;
let dabs: Array<[number, number]>;
let finishes: boolean[];
let brush: BrowserPhotoMaskBrush;

function rect(left: number, top: number, width: number, height: number): DOMRect {
  return { left, top, width, height, right: left + width, bottom: top + height, x: left, y: top, toJSON: () => ({}) } as DOMRect;
}

function fakeBrush(overrides: Partial<BrowserPhotoMaskBrush> = {}): BrowserPhotoMaskBrush {
  return {
    available: true,
    mask: MASK,
    brush: { ...PHOTO_EDITING_MASK_BRUSH_DEFAULT },
    setSize: vi.fn(),
    stepSize: vi.fn(),
    setFeather: vi.fn(),
    setFlow: vi.fn(),
    setErase: vi.fn(),
    toggleErase: vi.fn(),
    paintMode: true,
    leavePaint: vi.fn(),
    resumePaint: vi.fn(),
    layerVisible: true,
    canPaint: true,
    status: "ready",
    saving: false,
    notice: null,
    frame: null,
    startStroke: vi.fn(
      (erase: boolean): PhotoEditingMaskStrokeHandle => ({
        erase,
        dab: (output) => dabs.push(output),
        finish: (commit) => {
          finishes.push(commit);
          return commit;
        },
      }),
    ),
    discardStroke: vi.fn(),
    clear: vi.fn(),
    fill: vi.fn(),
    retry: vi.fn(),
    ...overrides,
  } as BrowserPhotoMaskBrush;
}

function Harness(props: { brush: BrowserPhotoMaskBrush }) {
  const targetRef = useRef<HTMLCanvasElement | null>(null);
  return (
    <section
      ref={(element) => {
        if (element) element.getBoundingClientRect = () => rect(0, 0, 1000, 800);
      }}
    >
      <canvas
        ref={(element) => {
          targetRef.current = element;
          if (element) element.getBoundingClientRect = () => rect(100, 50, 600, 400);
        }}
      />
      <PhotoEditingMaskBrushOverlay targetRef={targetRef} brush={props.brush} plane={null} overlayVisible={false} />
    </section>
  );
}

async function render(overrides: Partial<BrowserPhotoMaskBrush> = {}) {
  brush = fakeBrush(overrides);
  await act(async () => {
    root.render(<Harness brush={brush} />);
  });
}

function area(): HTMLElement {
  const found = container.querySelector<HTMLElement>('[data-testid="photo-mask-brush-area"]');
  if (!found) throw new Error("brush area not found");
  return found;
}

async function pointer(type: string, clientX: number, clientY: number, init: PointerEventInit = {}) {
  await act(async () => {
    area().dispatchEvent(new PointerEvent(type, { bubbles: true, cancelable: true, clientX, clientY, pointerId: 1, button: 0, ...init }));
  });
}

beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  dabs = [];
  finishes = [];
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

describe("PhotoEditingMaskBrushOverlay", () => {
  it("写真の canvas に重ね、押してから離すまでを 1 ストロークにする（dab は出力の 0〜1・半径の 25% ごと）", async () => {
    await render();
    expect(area().style.left).toBe("100px");
    expect(area().style.width).toBe("600px");
    expect(area().getAttribute("aria-label")).toBe("ブラシで塗る");
    await pointer("pointerdown", 160, 90);
    expect(brush.startStroke).toHaveBeenCalledWith(false);
    expect(dabs).toEqual([[0.1, 0.1]]);
    // 半径 = 短い辺 400 × 6% = 24px、間隔 6px: 60px 右へ動かすと 10 個
    await pointer("pointermove", 220, 90);
    expect(dabs).toHaveLength(11);
    expect(dabs.at(-1)![0]).toBeCloseTo(0.2, 9);
    // 筆の輪がポインタに付いてくる（直径 48px）
    const cursor = container.querySelector<HTMLElement>('[data-testid="photo-mask-brush-cursor"]')!;
    expect(cursor.style.width).toBe("48px");
    await pointer("pointerup", 220, 90);
    expect(finishes).toEqual([true]);
    // 離した後に動かしても塗らない
    await pointer("pointermove", 300, 200);
    expect(dabs).toHaveLength(11);
  });

  it("赤い面の見た目の dab: 塗る = 赤を足す・消しゴム = 赤を減らす。反転したマスクは逆（赤は 1 − 面の値）", async () => {
    // jsdom は canvas を描けないので、dab を描いた瞬間の合成の種類だけを記録する偽の 2D context を返す
    const operations: string[] = [];
    const context = {
      globalCompositeOperation: "source-over",
      fillStyle: "",
      createRadialGradient: () => ({ addColorStop: () => undefined }),
      beginPath: () => undefined,
      arc: () => undefined,
      fill() {
        operations.push(this.globalCompositeOperation);
      },
      clearRect: () => undefined,
      createImageData: () => ({ data: new Uint8ClampedArray(4) }),
      putImageData: () => undefined,
    };
    const spy = vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue(context as unknown as CanvasRenderingContext2D);
    try {
      const dabWith = async (mask: DevelopSurfaceMask, erase: boolean) => {
        operations.length = 0;
        await render({ mask, brush: { ...PHOTO_EDITING_MASK_BRUSH_DEFAULT, erase } });
        await pointer("pointerdown", 160, 90);
        await pointer("pointerup", 160, 90);
        return operations[0];
      };
      expect(await dabWith(MASK, false)).toBe("source-over");
      expect(await dabWith(MASK, true)).toBe("destination-out");
      expect(await dabWith({ ...MASK, invert: true }, false)).toBe("destination-out");
      expect(await dabWith({ ...MASK, invert: true }, true)).toBe("source-over");
    } finally {
      spy.mockRestore();
    }
  });

  it("止められた（pointercancel）ストロークは確定しない", async () => {
    await render();
    await pointer("pointerdown", 160, 90);
    await pointer("pointercancel", 160, 90);
    expect(finishes).toEqual([false]);
  });

  it("⌥ を押しながら塗ると消しゴム。[ ] で大きさを変える（文字の入力欄の上では変えない）", async () => {
    await render();
    await pointer("pointerdown", 160, 90, { altKey: true });
    expect(brush.startStroke).toHaveBeenCalledWith(true);
    await pointer("pointerup", 160, 90);
    await act(async () => {
      document.body.dispatchEvent(new KeyboardEvent("keydown", { key: "]", bubbles: true, cancelable: true }));
      document.body.dispatchEvent(new KeyboardEvent("keydown", { key: "[", bubbles: true, cancelable: true }));
    });
    expect(brush.stepSize).toHaveBeenNthCalledWith(1, 1);
    expect(brush.stepSize).toHaveBeenNthCalledWith(2, -1);
    const input = document.createElement("input");
    document.body.appendChild(input);
    await act(async () => {
      input.dispatchEvent(new KeyboardEvent("keydown", { key: "]", bubbles: true, cancelable: true }));
    });
    expect(brush.stepSize).toHaveBeenCalledTimes(2);
    input.remove();
  });

  it("塗れない間（面を読んでいる・読めない・押せない）は塗らない", async () => {
    await render({ canPaint: false, status: "loading" });
    await pointer("pointerdown", 160, 90);
    expect(brush.startStroke).not.toHaveBeenCalled();
    expect(area().getAttribute("aria-disabled")).toBe("true");
    expect(container.querySelector('[data-testid="photo-mask-brush-cursor"]')).toBeNull();
  });

  it("塗っている途中に塗れなくなったら、そのストロークを捨てる", async () => {
    await render();
    await pointer("pointerdown", 160, 90);
    const current = brush;
    await act(async () => {
      root.render(<Harness brush={{ ...current, canPaint: false }} />);
    });
    expect(finishes).toEqual([false]);
  });
});
