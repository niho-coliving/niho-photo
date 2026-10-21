// @vitest-environment jsdom

import { act, useRef, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { IDENTITY_DEVELOP_GEOMETRY } from "../develop-engine/develop-geometry";
import type { DevelopLinearMask, DevelopMask, DevelopRadialMask } from "../develop-engine/develop-masks";
import type { PhotoEditingMaskFrame } from "../photo-editing-masks";

import { PhotoEditingMaskOverlay } from "./photo-editing-mask-overlay";

/**
 * 写真の上のマスクの操作（M3 #67）。jsdom は要素を測れないので、写真の canvas と入れ物の位置を `getBoundingClientRect` で与える
 * （canvas は入れ物の (100, 50) に 600 x 400 で置かれている。作業画像 3000 x 2000 を幾何なしで見せる）。
 */

const FRAME: PhotoEditingMaskFrame = {
  source: { width: 3000, height: 2000 },
  geometry: { ...IDENTITY_DEVELOP_GEOMETRY, crop: { ...IDENTITY_DEVELOP_GEOMETRY.crop } },
};
const LINEAR: DevelopLinearMask = {
  id: "mask-a",
  kind: "linear",
  enabled: true,
  invert: false,
  zero: { x: 0.5, y: 0.55 },
  full: { x: 0.5, y: 0.3 },
  adjust: { exposure: -0.5 },
};
const RADIAL: DevelopRadialMask = {
  id: "mask-b",
  kind: "radial",
  enabled: true,
  invert: false,
  center: { x: 0.5, y: 0.5 },
  radius: { x: 0.2, y: 0.25 },
  angle: 0,
  feather: 50,
  adjust: {},
};

let container: HTMLDivElement;
let root: Root;
let changes: Array<{ mask: DevelopMask; phase: "drag" | "commit" }>;
let dragging: boolean[];
let onSelect: ReturnType<typeof vi.fn<(id: string | null) => void>>;
let onToggleOverlay: ReturnType<typeof vi.fn<() => void>>;

function rect(left: number, top: number, width: number, height: number): DOMRect {
  return { left, top, width, height, right: left + width, bottom: top + height, x: left, y: top, toJSON: () => ({}) } as DOMRect;
}

function Harness(props: { masks: DevelopMask[]; selectedId: string | null; frame?: PhotoEditingMaskFrame | null; disabled?: boolean }) {
  const targetRef = useRef<HTMLCanvasElement | null>(null);
  const [masks, setMasks] = useState(props.masks);
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
      <PhotoEditingMaskOverlay
        targetRef={targetRef}
        masks={masks}
        selectedId={props.selectedId}
        frame={props.frame === undefined ? FRAME : props.frame}
        disabled={props.disabled ?? false}
        plane={null}
        onSelect={onSelect}
        onShapeChange={(mask, phase) => {
          changes.push({ mask, phase });
          setMasks((current) => current.map((item) => (item.id === mask.id ? mask : item)));
        }}
        onDraggingChange={(value) => dragging.push(value)}
        onToggleOverlay={onToggleOverlay}
      />
    </section>
  );
}

async function render(props: Parameters<typeof Harness>[0]) {
  await act(async () => {
    root.render(<Harness {...props} />);
  });
  // 測った位置で描き直す
  await act(async () => undefined);
}

function handle(name: string): HTMLButtonElement {
  const found = container.querySelector<HTMLButtonElement>(`button[aria-label="${name}"]`);
  if (!found) throw new Error(`handle not found: ${name}`);
  return found;
}

function position(element: HTMLElement): [number, number] {
  return [Number.parseFloat(element.style.left), Number.parseFloat(element.style.top)];
}

function expectAt(element: HTMLElement, expected: [number, number]) {
  const [left, top] = position(element);
  expect(left).toBeCloseTo(expected[0], 6);
  expect(top).toBeCloseTo(expected[1], 6);
}

async function pointer(element: Element, type: string, clientX: number, clientY: number, pointerId = 1) {
  await act(async () => {
    element.dispatchEvent(new PointerEvent(type, { bubbles: true, cancelable: true, clientX, clientY, pointerId, button: 0 }));
  });
}

async function key(element: Element, type: "keydown" | "keyup", name: string, init: KeyboardEventInit = {}) {
  const event = new KeyboardEvent(type, { key: name, bubbles: true, cancelable: true, ...init });
  await act(async () => {
    element.dispatchEvent(event);
  });
  return event;
}

beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  changes = [];
  dragging = [];
  onSelect = vi.fn();
  onToggleOverlay = vi.fn();
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

describe("PhotoEditingMaskOverlay", () => {
  it("写真の canvas と同じ位置・大きさに重ね、選んだ線形の始点・中央・終点のつまみを形の上に置く（読み上げ名つきのボタン）", async () => {
    await render({ masks: [LINEAR], selectedId: "mask-a" });
    const overlay = container.querySelector<HTMLElement>('[data-testid="photo-mask-overlay"]')!;
    expect(overlay.getAttribute("aria-label")).toBe("マスクの操作");
    expect([overlay.style.left, overlay.style.top, overlay.style.width, overlay.style.height]).toEqual(["100px", "50px", "600px", "400px"]);
    expectAt(handle("線形グラデーションの始点（効果 100%）"), [300, 120]);
    expectAt(handle("線形グラデーションの終点（効果 0%）"), [300, 220]);
    expectAt(handle("線形グラデーションの中央（全体を動かす）"), [300, 170]);
    // 押せる範囲 28px（24px 以上）・指でも同じ・focus の環
    const className = handle("線形グラデーションの中央（全体を動かす）").className;
    expect(className).toContain("h-7");
    expect(className).toContain("touch-none");
    expect(className).toContain("focus-visible:ring-2");
    expect(container.querySelectorAll('[data-mask-shape="linear"] line').length).toBeGreaterThan(0);
  });

  it("つまみを動かすと途中の形を drag で渡し、離したら 1 回だけ commit（取り消しの 1 単位）", async () => {
    await render({ masks: [LINEAR], selectedId: "mask-a" });
    const full = handle("線形グラデーションの始点（効果 100%）");
    await pointer(full, "pointerdown", 400, 170);
    await pointer(full, "pointermove", 430, 170);
    await pointer(full, "pointermove", 460, 150);
    await pointer(full, "pointerup", 460, 150);
    expect(changes.map((change) => change.phase)).toEqual(["drag", "drag", "commit"]);
    expect(dragging).toEqual([true, false]);
    const committed = changes.at(-1)!.mask as DevelopLinearMask;
    // 600px が作業画像の幅 1 なので、60px 右・20px 上 = (0.1, -0.05)
    expect(committed.full.x).toBeCloseTo(0.6, 9);
    expect(committed.full.y).toBeCloseTo(0.25, 9);
    expect(committed.zero).toEqual(LINEAR.zero);
    expect(committed.adjust).toEqual(LINEAR.adjust);
    // つまみは動かした先
    expectAt(handle("線形グラデーションの始点（効果 100%）"), [360, 100]);
  });

  it("止められた（pointercancel）ら、動かし始めの形に戻して確定する", async () => {
    await render({ masks: [RADIAL], selectedId: "mask-b" });
    const center = handle("円形グラデーションの中心（全体を動かす）");
    await pointer(center, "pointerdown", 400, 250);
    await pointer(center, "pointermove", 450, 250);
    await pointer(center, "pointercancel", 450, 250);
    expect(changes.map((change) => change.phase)).toEqual(["drag", "commit"]);
    expect((changes.at(-1)!.mask as DevelopRadialMask).center).toEqual(RADIAL.center);
  });

  it("ポインター操作中に overlay が外れたら、最後の形を確定して dragging を戻す", async () => {
    await render({ masks: [LINEAR], selectedId: "mask-a" });
    const start = handle("線形グラデーションの始点（効果 100%）");
    await pointer(start, "pointerdown", 400, 170);
    await pointer(start, "pointermove", 460, 150);

    await act(async () => root.unmount());
    root = createRoot(container);

    expect(changes.map((change) => change.phase)).toEqual(["drag", "commit"]);
    expect(dragging).toEqual([true, false]);
    const committed = changes.at(-1)!.mask as DevelopLinearMask;
    expect(committed.full.x).toBeCloseTo(0.6, 9);
    expect(committed.full.y).toBeCloseTo(0.25, 9);
  });

  it("矢印キー操作中に overlay が外れたら、最後の形を確定して dragging を戻す", async () => {
    await render({ masks: [RADIAL], selectedId: "mask-b" });
    const center = handle("円形グラデーションの中心（全体を動かす）");
    center.focus();
    await key(center, "keydown", "ArrowRight");

    await act(async () => root.unmount());
    root = createRoot(container);

    expect(changes.map((change) => change.phase)).toEqual(["drag", "commit"]);
    expect(dragging).toEqual([true, false]);
    const committed = changes.at(-1)!.mask as DevelopRadialMask;
    expect(committed.center.x).toBeCloseTo(0.5 + 4 / 600, 9);
  });

  it("矢印キーは見えている短い辺の 1%（⇧ で 5%）ずつ動かし、キーを離したら 1 回 commit。ほかの面のキーには渡さない", async () => {
    await render({ masks: [RADIAL], selectedId: "mask-b" });
    const center = handle("円形グラデーションの中心（全体を動かす）");
    center.focus();
    const first = await key(center, "keydown", "ArrowRight");
    expect(first.defaultPrevented).toBe(true);
    await key(center, "keydown", "ArrowRight");
    await key(center, "keydown", "ArrowDown", { shiftKey: true });
    await key(center, "keyup", "ArrowDown");
    expect(changes.map((change) => change.phase)).toEqual(["drag", "drag", "drag", "commit"]);
    const moved = changes.at(-1)!.mask as DevelopRadialMask;
    // 短い辺 400px の 1% = 4px。2 回で 8px（作業画像の幅 600px に対して）、⇧ の下は 20px（高さ 400px に対して）
    expect(moved.center.x).toBeCloseTo(0.5 + 8 / 600, 9);
    expect(moved.center.y).toBeCloseTo(0.5 + 20 / 400, 9);
    expect(dragging).toEqual([true, false]);
  });

  it("フォーカスが外れたら、矢印で動かしていた形を確定する", async () => {
    await render({ masks: [RADIAL], selectedId: "mask-b" });
    const right = handle("円形グラデーションの幅（右）");
    right.focus();
    await key(right, "keydown", "ArrowRight");
    await act(async () => {
      right.blur();
    });
    expect(changes.map((change) => change.phase)).toEqual(["drag", "commit"]);
    expect((changes.at(-1)!.mask as DevelopRadialMask).radius.x).toBeCloseTo(0.2 + 4 / 600, 9);
  });

  it("円形は中心・軸の 4 つの端・回転のつまみ。回転のつまみは上の端の外", async () => {
    await render({ masks: [RADIAL], selectedId: "mask-b" });
    expect(Array.from(container.querySelectorAll<HTMLButtonElement>("[data-mask-handle]")).map((button) => button.dataset.maskHandle)).toEqual([
      "center",
      "right",
      "left",
      "bottom",
      "top",
      "rotate",
    ]);
    expectAt(handle("円形グラデーションの高さ（上）"), [300, 100]);
    const rotate = position(handle("円形グラデーションの回転"));
    expect(rotate[0]).toBeCloseTo(300, 6);
    expect(rotate[1]).toBeCloseTo(100 - 28, 9);
    expect(container.querySelectorAll('[data-mask-shape="radial"] ellipse').length).toBeGreaterThanOrEqual(2);
  });

  it("選んでいないマスクは印を押して選び、写真の何も無い所を押すと選択を外す", async () => {
    await render({ masks: [LINEAR, RADIAL], selectedId: "mask-a" });
    await act(async () => {
      handle("円形 2 を選ぶ").click();
    });
    expect(onSelect).toHaveBeenLastCalledWith("mask-b");
    await pointer(container.querySelector('[data-testid="photo-mask-backdrop"]')!, "pointerdown", 150, 60);
    expect(onSelect).toHaveBeenLastCalledWith(null);
  });

  it("O で範囲の重ね表示を切り替える（文字の入力欄・修飾キーのときは扱わない）", async () => {
    await render({ masks: [LINEAR], selectedId: "mask-a" });
    await key(document.body, "keydown", "o");
    expect(onToggleOverlay).toHaveBeenCalledTimes(1);
    const input = document.createElement("input");
    document.body.appendChild(input);
    await key(input, "keydown", "o");
    await key(document.body, "keydown", "o", { metaKey: true });
    expect(onToggleOverlay).toHaveBeenCalledTimes(1);
    input.remove();
  });

  it("押せない間はつまみを押せない。描けない幾何（座標の基準が無い）ではつまみを出さない", async () => {
    await render({ masks: [LINEAR], selectedId: "mask-a", disabled: true });
    const center = handle("線形グラデーションの中央（全体を動かす）");
    expect(center.disabled).toBe(true);
    await pointer(center, "pointerdown", 400, 170);
    await pointer(center, "pointermove", 450, 170);
    expect(changes).toEqual([]);
    act(() => root.unmount());
    root = createRoot(container);
    await render({ masks: [LINEAR], selectedId: "mask-a", frame: null });
    expect(container.querySelectorAll("[data-mask-handle]")).toHaveLength(0);
  });
});
