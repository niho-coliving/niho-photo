// @vitest-environment jsdom

import { act, createRef } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  PHOTO_EDITING_CLIP_HIGHLIGHT_FLAG,
  PHOTO_EDITING_CLIP_HIGHLIGHT_RGB,
  PHOTO_EDITING_CLIP_SHADOW_FLAG,
  PHOTO_EDITING_CLIP_SHADOW_RGB,
  type PhotoEditingClipMask,
} from "../photo-editing-histogram";

import { PhotoEditingClipOverlay } from "./photo-editing-clip-overlay";

/**
 * 写真の上に重ねるクリップ領域の印（niho-photo#36）。写真の canvas と同じ大きさ・位置の透明な canvas で、押せない・読み上げない。
 * jsdom には canvas の 2D も layout も無いので、描いた画素と実測の矩形は差し替えて確かめる。
 */

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLDivElement;
let root: Root;
let putImageData: ReturnType<typeof vi.fn>;
let drawn: Uint8ClampedArray[];

const MASK: PhotoEditingClipMask = {
  width: 2,
  height: 2,
  flags: Uint8Array.from([
    PHOTO_EDITING_CLIP_SHADOW_FLAG,
    PHOTO_EDITING_CLIP_HIGHLIGHT_FLAG,
    0,
    PHOTO_EDITING_CLIP_SHADOW_FLAG | PHOTO_EDITING_CLIP_HIGHLIGHT_FLAG,
  ]),
};

function rect(left: number, top: number, width: number, height: number): DOMRect {
  return { left, top, width, height, right: left + width, bottom: top + height, x: left, y: top, toJSON: () => ({}) } as DOMRect;
}

beforeEach(() => {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  drawn = [];
  putImageData = vi.fn((image: { data: Uint8ClampedArray }) => {
    drawn.push(Uint8ClampedArray.from(image.data));
  });
  vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockImplementation(((kind: string) =>
    kind === "2d"
      ? {
          createImageData: (width: number, height: number) => ({ width, height, data: new Uint8ClampedArray(width * height * 4) }),
          putImageData,
        }
      : null) as unknown as HTMLCanvasElement["getContext"]);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.restoreAllMocks();
});

/** 写真の面（親）の中に、写真の canvas と重ねる canvas を置く。親は (10,20) から、写真の canvas は親の中央寄せ（実測を差し替える） */
async function render(options: { shadows: boolean; highlights: boolean; mask?: PhotoEditingClipMask; target?: DOMRect }) {
  const targetRef = createRef<HTMLCanvasElement>();
  const target = options.target ?? rect(110, 70, 400, 300);
  vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(function (this: HTMLElement) {
    if (this.dataset.role === "target") return target;
    if (this.dataset.role === "parent") return rect(10, 20, 600, 400);
    return rect(0, 0, 0, 0);
  });
  await act(async () => {
    root.render(
      <section data-role="parent">
        <canvas ref={targetRef} data-role="target" />
        <PhotoEditingClipOverlay
          targetRef={targetRef}
          mask={options.mask ?? MASK}
          shadows={options.shadows}
          highlights={options.highlights}
        />
      </section>,
    );
  });
}

function overlay(): HTMLCanvasElement {
  const found = container.querySelector<HTMLCanvasElement>('[data-testid="photo-clip-overlay"]');
  if (!found) throw new Error("overlay not found");
  return found;
}

describe("PhotoEditingClipOverlay", () => {
  it("押せず・読み上げない canvas を、印の大きさの canvas として置く", async () => {
    await render({ shadows: true, highlights: true });
    expect(overlay().getAttribute("aria-hidden")).toBe("true");
    expect(overlay().className).toContain("pointer-events-none");
    expect(overlay().className).toContain("absolute");
    expect(overlay().width).toBe(2);
    expect(overlay().height).toBe(2);
  });

  it("写真の canvas の実測に合わせて、親の中の同じ位置・同じ大きさに置く", async () => {
    await render({ shadows: true, highlights: false });
    // 写真の canvas は (110,70) 400x300、親は (10,20) → 親の中の (100,50)
    expect(overlay().style.left).toBe("100px");
    expect(overlay().style.top).toBe("50px");
    expect(overlay().style.width).toBe("400px");
    expect(overlay().style.height).toBe("300px");
  });

  it("黒つぶれは青・白飛びは赤、両方の印がある画素は赤で塗る", async () => {
    await render({ shadows: true, highlights: true });
    const [shadowR, shadowG, shadowB] = PHOTO_EDITING_CLIP_SHADOW_RGB;
    const [highlightR, highlightG, highlightB] = PHOTO_EDITING_CLIP_HIGHLIGHT_RGB;
    expect(drawn.at(-1)).toEqual(
      Uint8ClampedArray.from([
        shadowR, shadowG, shadowB, 255,
        highlightR, highlightG, highlightB, 255,
        0, 0, 0, 0,
        highlightR, highlightG, highlightB, 255,
      ]),
    );
  });

  it("見せる側を替えると描き直す（黒つぶれだけなら白飛びは塗らない）", async () => {
    await render({ shadows: true, highlights: true });
    const before = putImageData.mock.calls.length;
    await render({ shadows: true, highlights: false });
    expect(putImageData.mock.calls.length).toBeGreaterThan(before);
    const [shadowR, shadowG, shadowB] = PHOTO_EDITING_CLIP_SHADOW_RGB;
    expect(drawn.at(-1)).toEqual(
      Uint8ClampedArray.from([
        shadowR, shadowG, shadowB, 255,
        0, 0, 0, 0,
        0, 0, 0, 0,
        shadowR, shadowG, shadowB, 255,
      ]),
    );
  });

  it("2D の context が無い環境でも落ちない（何も描かない）", async () => {
    vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockImplementation((() => null) as unknown as HTMLCanvasElement["getContext"]);
    await render({ shadows: true, highlights: true });
    expect(overlay()).not.toBeNull();
    expect(putImageData).not.toHaveBeenCalled();
  });
});
