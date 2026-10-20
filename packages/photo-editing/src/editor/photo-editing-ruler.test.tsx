// @vitest-environment jsdom

import { act, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  PHOTO_EDITING_RULER_RANGE_WIDTH_PX,
  PhotoEditingRuler,
  photoEditingRulerOffsetPx,
  photoEditingRulerValueAfterDrag,
} from "./photo-editing-ruler";
import type { PhotoEditingSliderPhase } from "./photo-editing-slider";

/** スマホの補正の目盛り（F6c 移行元設計・モックの段 B）。位置ではなく動かした量で値を変える。 */

let container: HTMLDivElement;
let root: Root;
let changes: Array<{ value: number; phase: PhotoEditingSliderPhase }>;
let resets: number;

function Harness(props: { initial: number; min: number; max: number; step: number; disabled?: boolean }) {
  const [value, setValue] = useState(props.initial);
  return (
    <PhotoEditingRuler
      id="ruler"
      label="シャドウ"
      min={props.min}
      max={props.max}
      step={props.step}
      value={value}
      valueText={String(value)}
      disabled={props.disabled ?? false}
      onChange={(next, phase) => {
        changes.push({ value: next, phase });
        setValue(next);
      }}
      onReset={() => {
        resets += 1;
        setValue(0);
      }}
    />
  );
}

async function render(props: Parameters<typeof Harness>[0]) {
  await act(async () => {
    root.render(<Harness {...props} />);
  });
  return container.querySelector<HTMLElement>('[role="slider"]')!;
}

function pointer(target: HTMLElement, type: "pointerdown" | "pointermove" | "pointerup", clientX: number) {
  const event = new MouseEvent(type, { bubbles: true, cancelable: true, clientX });
  Object.defineProperty(event, "pointerId", { value: 1 });
  act(() => {
    target.dispatchEvent(event);
  });
}

beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  changes = [];
  resets = 0;
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
});

describe("photoEditingRulerValueAfterDrag", () => {
  it("左へ送ると増え、範囲全体が同じ指の移動にあたる（露光量も ±100 の項目も）", () => {
    const half = PHOTO_EDITING_RULER_RANGE_WIDTH_PX / 2;
    expect(photoEditingRulerValueAfterDrag({ startValue: 0, dx: -half, min: -100, max: 100, step: 1 })).toBe(100);
    expect(photoEditingRulerValueAfterDrag({ startValue: 0, dx: half / 2, min: -100, max: 100, step: 1 })).toBe(-50);
    expect(photoEditingRulerValueAfterDrag({ startValue: 0, dx: -half / 5, min: -5, max: 5, step: 0.01 })).toBe(1);
  });

  it("範囲の外へは出ず、刻みに丸める", () => {
    expect(photoEditingRulerValueAfterDrag({ startValue: 90, dx: -1000, min: -100, max: 100, step: 1 })).toBe(100);
    expect(photoEditingRulerValueAfterDrag({ startValue: 0, dx: -1, min: -5, max: 5, step: 0.01 })).toBe(0.02);
  });

  it("帯をずらす量は値に比例し、0 で中央", () => {
    expect(photoEditingRulerOffsetPx(0, -100, 100)).toBe(0);
    expect(photoEditingRulerOffsetPx(100, -100, 100)).toBe(PHOTO_EDITING_RULER_RANGE_WIDTH_PX / 2);
  });
});

describe("PhotoEditingRuler", () => {
  it("押した場所に飛ばず、動かした量だけ drag で動き、離したら 1 回 commit", async () => {
    const ruler = await render({ initial: 20, min: -100, max: 100, step: 1 });
    pointer(ruler, "pointerdown", 300);
    expect(changes).toEqual([]);
    pointer(ruler, "pointermove", 270);
    pointer(ruler, "pointermove", 240);
    pointer(ruler, "pointerup", 240);
    expect(changes).toEqual([
      { value: 30, phase: "drag" },
      { value: 40, phase: "drag" },
      { value: 40, phase: "commit" },
    ]);
    expect(ruler.getAttribute("aria-valuenow")).toBe("40");
  });

  it("動かさずに離したら何も送らない。ダブルタップで既定値へ戻す", async () => {
    const ruler = await render({ initial: 20, min: -100, max: 100, step: 1 });
    pointer(ruler, "pointerdown", 100);
    pointer(ruler, "pointerup", 100);
    expect(changes).toEqual([]);
    pointer(ruler, "pointerdown", 100);
    expect(resets).toBe(1);
    expect(ruler.getAttribute("aria-valuenow")).toBe("0");
  });

  it("←→ で 1 目盛り・⇧ で 10 目盛り（commit）。押せないときは動かない", async () => {
    const ruler = await render({ initial: 0, min: -100, max: 100, step: 1 });
    act(() => {
      ruler.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowRight", bubbles: true }));
    });
    act(() => {
      ruler.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowLeft", shiftKey: true, bubbles: true }));
    });
    expect(changes).toEqual([
      { value: 1, phase: "commit" },
      { value: -9, phase: "commit" },
    ]);

    changes = [];
    const disabled = await render({ initial: 0, min: -100, max: 100, step: 1, disabled: true });
    expect(disabled.getAttribute("aria-disabled")).toBe("true");
    expect(disabled.tabIndex).toBe(-1);
    pointer(disabled, "pointerdown", 100);
    pointer(disabled, "pointermove", 0);
    act(() => {
      disabled.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowRight", bubbles: true }));
    });
    expect(changes).toEqual([]);
  });

  it("読み上げ: 項目名で名付けた slider で、値の文字を持つ", async () => {
    const ruler = await render({ initial: 25, min: -100, max: 100, step: 1 });
    const labelId = ruler.getAttribute("aria-labelledby");
    expect(labelId && container.querySelector(`#${labelId}`)?.textContent).toBe("シャドウ");
    expect(ruler.getAttribute("aria-valuetext")).toBe("25");
    expect(ruler.getAttribute("aria-valuemin")).toBe("-100");
    expect(ruler.getAttribute("aria-valuemax")).toBe("100");
  });
});
