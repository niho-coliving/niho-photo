// @vitest-environment jsdom

import { act, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  cropBoxFromGeometry,
  setGeometryAspect,
  type CropBox,
  type DevelopGeometry,
  type DevelopSize,
} from "../develop-engine/develop-geometry";

import { PhotoEditingCropOverlay } from "./photo-editing-crop-overlay";

/**
 * 写真の上の切り抜きの枠の部品（F3b 移行元設計）: 枠の移動・つまみの伸縮（比率を守る・枠から出ない）・キーボード・角度を渡したときの
 * 写真の回転・読み上げ。jsdom は要素の大きさを測れないので、表示の領域の大きさは `viewport` で渡す。
 */

const SOURCE: DevelopSize = { width: 3000, height: 2000 };
/** 余白 24px の内側は 800 x 600。3000 x 2000 の写真は 800 x 533.3 に収まる（枠の 1 画素が 800 / 3000 px）。 */
const VIEWPORT: DevelopSize = { width: 848, height: 648 };
const SCALE = 800 / 3000;
const IDENTITY: DevelopGeometry = {
  rotate: 0,
  flipH: false,
  flipV: false,
  angle: 0,
  crop: { left: 0, top: 0, right: 1, bottom: 1 },
};
/** 中央の半分（1500 x 1000）。 */
const HALF: DevelopGeometry = { ...IDENTITY, aspect: "free", crop: { left: 0.25, top: 0.25, right: 0.75, bottom: 0.75 } };

type OverlayOptions = { disabled?: boolean; liveAngle?: number | null; viewport?: DevelopSize | null };

let container: HTMLDivElement;
let root: Root;
let onCommit: ReturnType<typeof vi.fn<(geometry: DevelopGeometry) => void>>;
let setOptions: (options: OverlayOptions) => void = () => undefined;

/** 確定した幾何を持つ親（面の hook の代わり）。 */
function Harness(props: { initial: DevelopGeometry; options: OverlayOptions }) {
  const [geometry, setGeometry] = useState(props.initial);
  const [options, setCurrentOptions] = useState(props.options);
  setOptions = setCurrentOptions;
  return (
    <div style={{ position: "relative" }}>
      <PhotoEditingCropOverlay
        geometry={geometry}
        source={SOURCE}
        liveAngle={options.liveAngle ?? null}
        disabled={options.disabled ?? false}
        viewport={options.viewport === null ? undefined : (options.viewport ?? VIEWPORT)}
        onCommit={(next) => {
          onCommit(next);
          setGeometry(next);
        }}
      >
        <canvas data-testid="canvas" />
      </PhotoEditingCropOverlay>
    </div>
  );
}

async function render(initial: DevelopGeometry = HALF, options: OverlayOptions = {}) {
  await act(async () => {
    root.render(<Harness initial={initial} options={options} />);
  });
}

function frame(): HTMLElement {
  const found = container.querySelector<HTMLElement>('[role="group"][aria-label="切り抜きの枠"]');
  if (!found) throw new Error("crop frame not found");
  return found;
}

function handle(name: string): HTMLButtonElement {
  const found = container.querySelector<HTMLButtonElement>(`button[aria-label="${name}"]`);
  if (!found) throw new Error(`handle not found: ${name}`);
  return found;
}

function photo(): HTMLElement {
  const found = container.querySelector<HTMLElement>('[data-testid="photo-crop-photo"]');
  if (!found) throw new Error("photo not found");
  return found;
}

function px(value: string): number {
  return Number.parseFloat(value);
}

function frameRect(): { left: number; top: number; width: number; height: number } {
  const style = frame().style;
  return { left: px(style.left), top: px(style.top), width: px(style.width), height: px(style.height) };
}

function grid(): Element | null {
  return container.querySelector('[data-testid="photo-crop-grid"]');
}

async function pointer(element: Element, type: string, clientX: number, clientY: number) {
  await act(async () => {
    element.dispatchEvent(new PointerEvent(type, { bubbles: true, cancelable: true, clientX, clientY, pointerId: 1, button: 0 }));
  });
}

/** 押す → 動かす → 離す（画面の px）。 */
async function drag(element: Element, dx: number, dy: number) {
  await pointer(element, "pointerdown", 100, 100);
  await pointer(element, "pointermove", 100 + dx / 2, 100 + dy / 2);
  await pointer(element, "pointermove", 100 + dx, 100 + dy);
  await pointer(element, "pointerup", 100 + dx, 100 + dy);
}

async function key(element: Element, type: "keydown" | "keyup", name: string, init: KeyboardEventInit = {}): Promise<KeyboardEvent> {
  const event = new KeyboardEvent(type, { key: name, bubbles: true, cancelable: true, ...init });
  await act(async () => {
    element.dispatchEvent(event);
  });
  return event;
}

function lastCommit(): DevelopGeometry {
  const last = onCommit.mock.calls.at(-1)?.[0];
  if (!last) throw new Error("nothing was committed");
  return last;
}

function committedBox(): CropBox {
  const box = cropBoxFromGeometry(lastCommit(), SOURCE);
  if (!box) throw new Error("committed crop is not a rectangle");
  return box;
}

beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  onCommit = vi.fn<(geometry: DevelopGeometry) => void>();
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
});

describe("置き方", () => {
  it("写真を余白の内側に収め、切り抜きの枠をその上にまっすぐ置く", async () => {
    await render();
    expect(photo().style.transform).toBe("rotate(0deg)");
    expect(px(photo().style.left)).toBeCloseTo(24, 6);
    expect(px(photo().style.width)).toBeCloseTo(800, 6);
    expect(px(photo().style.height)).toBeCloseTo(3200 / 6, 6);
    // canvas は写真の場所の中
    expect(photo().querySelector("canvas")).not.toBeNull();
    const rect = frameRect();
    expect(rect.left).toBeCloseTo(24 + 750 * SCALE, 6);
    expect(rect.width).toBeCloseTo(1500 * SCALE, 6);
    expect(rect.height).toBeCloseTo(1000 * SCALE, 6);
    // 動かしていない間はグリッドを出さない
    expect(grid()).toBeNull();
  });

  it("枠はフォーカスでき、つまみは角 4・辺 4 のボタン（押せる大きさ 44px）", async () => {
    await render();
    expect(frame().tabIndex).toBe(0);
    const labels = Array.from(frame().querySelectorAll("button")).map((button) => button.getAttribute("aria-label"));
    expect(labels).toEqual(["左上の角", "上の辺", "右上の角", "右の辺", "右下の角", "下の辺", "左下の角", "左の辺"]);
    for (const button of Array.from(frame().querySelectorAll("button"))) {
      expect(button.className).toContain("h-11 w-11");
      expect(button.className).toContain("touch-none");
    }
    expect(frame().className).toContain("touch-none");
  });

  it("角度のある幾何は、写真を逆向きに回して見せる。角度補正を動かしている間は手元の角度で回し、グリッドを出す", async () => {
    await render({ ...IDENTITY, angle: 5, crop: { left: 0.2, top: 0.2, right: 0.8, bottom: 0.8 } });
    expect(photo().style.transform).toBe("rotate(-5deg)");
    expect(grid()).toBeNull();

    await act(async () => setOptions({ liveAngle: 10 }));
    expect(photo().style.transform).toBe("rotate(-10deg)");
    expect(grid()).not.toBeNull();
    // 手元の角度の間は確定しない
    expect(onCommit).not.toHaveBeenCalled();

    await act(async () => setOptions({ liveAngle: -12.5 }));
    expect(photo().style.transform).toBe("rotate(12.5deg)");

    await act(async () => setOptions({ liveAngle: null }));
    expect(photo().style.transform).toBe("rotate(-5deg)");
    expect(grid()).toBeNull();
  });

  it("表示の領域を測れない間も canvas は置いたまま、枠は出さない", async () => {
    await render(HALF, { viewport: null });
    expect(container.querySelector('[data-testid="canvas"]')).not.toBeNull();
    expect(container.querySelector('[role="group"]')).toBeNull();
  });
});

describe("枠を動かす", () => {
  it("押して動かしている間は手元だけを変え、離したら 1 回確定する", async () => {
    await render();
    const before = frameRect();

    await pointer(frame(), "pointerdown", 100, 100);
    expect(grid()).not.toBeNull();
    await pointer(frame(), "pointermove", 180, 140);
    const moving = frameRect();
    expect(moving.left - before.left).toBeCloseTo(80, 6);
    expect(moving.top - before.top).toBeCloseTo(40, 6);
    expect(moving.width).toBeCloseTo(before.width, 6);
    expect(onCommit).not.toHaveBeenCalled();

    await pointer(frame(), "pointerup", 180, 140);
    expect(onCommit).toHaveBeenCalledOnce();
    expect(grid()).toBeNull();
    // 画面の 80 x 40 px は枠の 300 x 150 画素
    const box = committedBox();
    expect(box.cx).toBeCloseTo(1800, 6);
    expect(box.cy).toBeCloseTo(1150, 6);
    expect(box.width).toBeCloseTo(1500, 6);
    expect(box.height).toBeCloseTo(1000, 6);
    expect(lastCommit().aspect).toBe("free");
    // 確定した位置のまま見せる
    expect(frameRect().left).toBeCloseTo(moving.left, 6);
  });

  it("写真（枠）から出ない", async () => {
    await render();
    await drag(frame(), 2000, -2000);
    const box = committedBox();
    expect(box.cx).toBeCloseTo(2250, 6);
    expect(box.cy).toBeCloseTo(500, 6);
    expect(lastCommit().crop.right).toBeCloseTo(1, 9);
    expect(lastCommit().crop.top).toBeCloseTo(0, 9);
  });

  it("押して離しただけでは確定しない。中断（pointercancel）は元に戻す", async () => {
    await render();
    const before = frameRect();
    await pointer(frame(), "pointerdown", 100, 100);
    await pointer(frame(), "pointerup", 100, 100);
    expect(onCommit).not.toHaveBeenCalled();

    await pointer(frame(), "pointerdown", 100, 100);
    await pointer(frame(), "pointermove", 160, 100);
    expect(frameRect().left - before.left).toBeCloseTo(60, 6);
    await pointer(frame(), "pointercancel", 160, 100);
    expect(onCommit).not.toHaveBeenCalled();
    expect(frameRect().left).toBeCloseTo(before.left, 6);
    expect(grid()).toBeNull();
  });

  it("回した写真の上では、画面の動きを枠の軸に直して動かす", async () => {
    // 角度 90 は無いので、45 度で確かめる: 画面の右は、枠では右下
    const tilted: DevelopGeometry = { ...IDENTITY, aspect: "free", angle: 45, crop: { left: 0.45, top: 0.4, right: 0.55, bottom: 0.6 } };
    await render(tilted);
    const start = cropBoxFromGeometry(tilted, SOURCE);
    if (!start) throw new Error("start box");
    const scale = px(photo().style.width) / 3000;
    await drag(frame(), 30, 0);
    const moved = cropBoxFromGeometry(lastCommit(), SOURCE);
    if (!moved) throw new Error("moved box");
    const distance = 30 / scale;
    expect(moved.cx - start.cx).toBeCloseTo(distance * Math.SQRT1_2, 5);
    expect(moved.cy - start.cy).toBeCloseTo(distance * Math.SQRT1_2, 5);
    expect(moved.width).toBeCloseTo(start.width, 5);
  });
});

describe("つまみで大きさを変える", () => {
  it("「自由」は押したつまみの辺だけが動く", async () => {
    await render();
    await drag(handle("右の辺"), -80, 50);
    expect(onCommit).toHaveBeenCalledOnce();
    const crop = lastCommit().crop;
    expect(crop.left).toBeCloseTo(0.25, 9);
    expect(crop.top).toBeCloseTo(0.25, 9);
    expect(crop.bottom).toBeCloseTo(0.75, 9);
    // 画面の −80px は枠の −300 画素（幅の 0.1）
    expect(crop.right).toBeCloseTo(0.65, 9);
  });

  it("比率を守る縦横比では、角のつまみで比率を保つ（反対の角は動かない）", async () => {
    const square = setGeometryAspect(IDENTITY, "1:1", SOURCE);
    await render(square);
    await drag(handle("右下の角"), -150, -30);
    expect(onCommit).toHaveBeenCalledOnce();
    const box = committedBox();
    expect(box.width).toBeCloseTo(box.height, 6);
    expect(box.width).toBeLessThan(2000);
    // 左上の角はそのまま
    expect(lastCommit().crop.left).toBeCloseTo(square.crop.left, 9);
    expect(lastCommit().crop.top).toBeCloseTo(square.crop.top, 9);
    expect(lastCommit().aspect).toBe("1:1");
  });

  it("つまみでも写真（枠）から出ない", async () => {
    await render();
    await drag(handle("左上の角"), -3000, -3000);
    const crop = lastCommit().crop;
    expect(crop.left).toBeCloseTo(0, 9);
    expect(crop.top).toBeCloseTo(0, 9);
    expect(crop.right).toBeCloseTo(0.75, 9);
    expect(crop.bottom).toBeCloseTo(0.75, 9);
  });
});

describe("キーボード", () => {
  it("枠に矢印で移動し、キーを離したら確定する（押し続けている間は 1 単位）", async () => {
    await render();
    const first = await key(frame(), "keydown", "ArrowRight");
    // 面のキー（写真の切り替え）に渡さない
    expect(first.defaultPrevented).toBe(true);
    await key(frame(), "keydown", "ArrowRight", { repeat: true });
    await key(frame(), "keydown", "ArrowRight", { repeat: true });
    expect(onCommit).not.toHaveBeenCalled();
    expect(grid()).not.toBeNull();

    await key(frame(), "keyup", "ArrowRight");
    expect(onCommit).toHaveBeenCalledOnce();
    // 1 回で写真の短辺（2000）の 1%
    expect(committedBox().cx).toBeCloseTo(1500 + 20 * 3, 6);
    expect(committedBox().cy).toBeCloseTo(1000, 6);
    expect(grid()).toBeNull();

    await key(frame(), "keydown", "ArrowUp", { shiftKey: true });
    await key(frame(), "keyup", "ArrowUp", { shiftKey: true });
    expect(onCommit).toHaveBeenCalledTimes(2);
    // ⇧ で 5%
    expect(committedBox().cy).toBeCloseTo(1000 - 100, 6);
  });

  it("つまみに矢印で伸縮する", async () => {
    await render();
    await key(handle("右の辺"), "keydown", "ArrowLeft");
    await key(handle("右の辺"), "keyup", "ArrowLeft");
    expect(onCommit).toHaveBeenCalledOnce();
    expect(committedBox().width).toBeCloseTo(1500 - 20, 6);
    expect(lastCommit().crop.left).toBeCloseTo(0.25, 9);

    await key(handle("左上の角"), "keydown", "ArrowUp", { shiftKey: true });
    await key(handle("左上の角"), "keyup", "ArrowUp", { shiftKey: true });
    expect(onCommit).toHaveBeenCalledTimes(2);
    expect(committedBox().height).toBeCloseTo(1000 + 100, 6);
    expect(lastCommit().crop.bottom).toBeCloseTo(0.75, 9);
  });

  it("フォーカスが外れたら、動かしている途中の箱を確定する。矢印でないキーは扱わない", async () => {
    await render();
    const other = await key(frame(), "keydown", "g");
    expect(other.defaultPrevented).toBe(false);
    await key(frame(), "keydown", "ArrowDown");
    expect(onCommit).not.toHaveBeenCalled();
    await act(async () => {
      frame().dispatchEvent(new FocusEvent("focusout", { bubbles: true }));
    });
    expect(onCommit).toHaveBeenCalledOnce();
    expect(committedBox().cy).toBeCloseTo(1020, 6);
  });
});

describe("読み上げ", () => {
  it("確定のたびに、今の切り抜きの大きさを読み上げ用の領域に出す", async () => {
    await render();
    const live = container.querySelector('[aria-live="polite"]');
    expect(live?.textContent).toBe("切り抜き 1,500 × 1,000");

    await drag(handle("右の辺"), -80, 0);
    expect(live?.textContent).toBe("切り抜き 1,200 × 1,000");
  });
});

describe("押せない間", () => {
  it("枠もつまみも動かない", async () => {
    await render(HALF, { disabled: true });
    expect(frame().tabIndex).toBe(-1);
    expect(handle("右の辺").disabled).toBe(true);
    const before = frameRect();
    await drag(frame(), 80, 40);
    await key(frame(), "keydown", "ArrowRight");
    await key(frame(), "keyup", "ArrowRight");
    expect(onCommit).not.toHaveBeenCalled();
    expect(frameRect()).toEqual(before);
  });

  it("角度補正を動かしている間は枠を動かさない", async () => {
    await render(HALF, { liveAngle: 3 });
    await drag(frame(), 80, 40);
    expect(onCommit).not.toHaveBeenCalled();
  });
});
