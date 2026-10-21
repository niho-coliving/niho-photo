// @vitest-environment jsdom

import { act, useRef, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { PhotoEditingCompareSplit } from "./photo-editing-compare-split";

/**
 * 分割の比較（niho-photo#41）。補正後の canvas の実測に合わせて補正前の canvas を重ね、境界から左だけ見せる。境界はつまみの
 * ドラッグとキー（← → / Home / End・Shift で 10%）で動かし、読み上げは slider。
 *
 * jsdom は要素の大きさを測れないので、補正後の canvas と入れ物・分割の部品の `getBoundingClientRect` を差し替える
 * （写真の面 = (0,0)-(800,600)、写真 = (100,100) から 400 × 300）。
 */

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const PHOTO = { left: 100, top: 100, width: 400, height: 300 };

let container: HTMLDivElement;
let root: Root;
let position: number;
let beforeCanvas: HTMLCanvasElement | null;
const onPositionChange = vi.fn<(position: number) => void>();

function Harness(props: { initial: number }) {
  const targetRef = useRef<HTMLCanvasElement | null>(null);
  const [value, setValue] = useState(props.initial);
  position = value;
  return (
    <section data-testid="surface" className="relative">
      <canvas data-testid="after" ref={targetRef} />
      <PhotoEditingCompareSplit
        targetRef={targetRef}
        beforeCanvasRef={(canvas) => {
          beforeCanvas = canvas;
        }}
        beforeLabel="photo.jpg の補正前"
        position={value}
        onPositionChange={(next) => {
          onPositionChange(next);
          setValue(next);
        }}
      />
    </section>
  );
}

function rect(box: { left: number; top: number; width: number; height: number }): DOMRect {
  return {
    ...box,
    x: box.left,
    y: box.top,
    right: box.left + box.width,
    bottom: box.top + box.height,
    toJSON: () => box,
  } as DOMRect;
}

async function render(initial = 50) {
  await act(async () => {
    root.render(<Harness initial={initial} />);
  });
}

function split(): HTMLElement {
  const found = container.querySelector<HTMLElement>('[data-testid="photo-compare-split"]');
  if (!found) throw new Error("split not found");
  return found;
}

function handle(): HTMLElement {
  const found = container.querySelector<HTMLElement>('[role="slider"]');
  if (!found) throw new Error("handle not found");
  return found;
}

async function pointer(type: string, clientX: number, init: PointerEventInit = {}) {
  await act(async () => {
    handle().dispatchEvent(
      new PointerEvent(type, { bubbles: true, cancelable: true, clientX, clientY: 250, pointerId: 1, button: 0, pointerType: "mouse", ...init }),
    );
  });
}

async function keyDown(key: string, init: KeyboardEventInit = {}) {
  const event = new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true, ...init });
  await act(async () => {
    handle().dispatchEvent(event);
  });
  return event;
}

beforeEach(() => {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  beforeCanvas = null;
  onPositionChange.mockReset();
  vi.spyOn(Element.prototype, "getBoundingClientRect").mockImplementation(function (this: Element) {
    if (this.getAttribute("data-testid") === "after" || this.getAttribute("data-testid") === "photo-compare-split") {
      return rect(PHOTO);
    }
    return rect({ left: 0, top: 0, width: 800, height: 600 });
  });
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.restoreAllMocks();
});

describe("PhotoEditingCompareSplit", () => {
  it("補正後の canvas と同じ位置・大きさに補正前の canvas を重ね、境界から左だけ見せる（押せるのはつまみだけ）", async () => {
    await render(50);
    const wrapper = split();
    expect(wrapper.style.left).toBe("100px");
    expect(wrapper.style.top).toBe("100px");
    expect(wrapper.style.width).toBe("400px");
    expect(wrapper.style.height).toBe("300px");
    expect(wrapper.className).toContain("pointer-events-none");
    expect(beforeCanvas).toBe(wrapper.querySelector("canvas"));
    expect(beforeCanvas?.getAttribute("aria-label")).toBe("photo.jpg の補正前");
    expect(beforeCanvas?.style.clipPath).toBe("inset(0 50% 0 0)");
    expect(handle().className).toContain("pointer-events-auto");
    expect(handle().style.left).toBe("50%");
    // 動きは付けない
    expect(wrapper.innerHTML).not.toMatch(/transition|animate/);
  });

  it("つまみは slider として読み上げ、位置を % と「左が補正前」で伝え、押せる幅は 44px", async () => {
    await render(50);
    const slider = handle();
    expect(slider.getAttribute("aria-label")).toBe("補正前と補正後の境界");
    expect(slider.getAttribute("aria-valuemin")).toBe("0");
    expect(slider.getAttribute("aria-valuemax")).toBe("100");
    expect(slider.getAttribute("aria-valuenow")).toBe("50");
    expect(slider.getAttribute("aria-valuetext")).toBe("左から50%（左が補正前）");
    expect(slider.getAttribute("tabindex")).toBe("0");
    expect(slider.className).toContain("w-11");
  });

  it("つまみをドラッグすると、掴んだ位置のずれを保ったまま境界が指に付いて動く（写真の外は端で止まる）", async () => {
    await render(50);
    const capture = vi.fn();
    handle().setPointerCapture = capture;
    // 線（x = 300）より 10px 右を掴む: 掴んだだけでは動かさない
    await pointer("pointerdown", 310);
    expect(capture).toHaveBeenCalledWith(1);
    expect(onPositionChange).not.toHaveBeenCalled();
    await pointer("pointermove", 210);
    expect(position).toBe(25);
    await pointer("pointermove", 900);
    expect(position).toBe(100);
    await pointer("pointermove", -50);
    expect(position).toBe(0);
    await pointer("pointerup", -50);
    onPositionChange.mockClear();
    // 離した後の動きは追わない
    await pointer("pointermove", 400);
    expect(onPositionChange).not.toHaveBeenCalled();
    expect(beforeCanvas?.style.clipPath).toBe("inset(0 100% 0 0)");
  });

  it("右ボタン・別の指の動きでは動かさない", async () => {
    await render(50);
    await pointer("pointerdown", 300, { button: 2 });
    await pointer("pointermove", 200);
    expect(onPositionChange).not.toHaveBeenCalled();
    await pointer("pointerdown", 300);
    await pointer("pointermove", 200, { pointerId: 2 });
    expect(onPositionChange).not.toHaveBeenCalled();
  });

  it("← → は 1%、Shift で 10%、Home / End で端。キーは写真の前後の移動に渡さない", async () => {
    await render(50);
    const outer = vi.fn();
    document.addEventListener("keydown", outer);
    try {
      const right = await keyDown("ArrowRight");
      expect(right.defaultPrevented).toBe(true);
      expect(position).toBe(51);
      await keyDown("ArrowLeft", { shiftKey: true });
      expect(position).toBe(41);
      await keyDown("ArrowUp");
      expect(position).toBe(42);
      await keyDown("PageDown");
      expect(position).toBe(32);
      await keyDown("Home");
      expect(position).toBe(0);
      await keyDown("ArrowLeft");
      expect(position).toBe(0);
      await keyDown("End");
      expect(position).toBe(100);
      expect(handle().getAttribute("aria-valuenow")).toBe("100");
      expect(outer).not.toHaveBeenCalled();
      // ほかのキー・修飾キーつきは扱わない
      const other = await keyDown("y");
      expect(other.defaultPrevented).toBe(false);
      const withMeta = await keyDown("ArrowLeft", { metaKey: true });
      expect(withMeta.defaultPrevented).toBe(false);
      expect(position).toBe(100);
    } finally {
      document.removeEventListener("keydown", outer);
    }
  });
});
