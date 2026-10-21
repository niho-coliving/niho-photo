// @vitest-environment jsdom

import { act, useRef } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { DevelopHealPoint } from "../develop-engine/develop-heal";
import type { DevelopHealImageSize, DevelopHealMarkView } from "../develop-engine/develop-heal-editing";
import { healMarkFingerprint } from "../photo-editing-heal";

import { PhotoEditingHealOverlay } from "./photo-editing-heal-overlay";

/**
 * 写真の上の修復のブラシ（niho-photo#44 後半）: 押す → 動かす → 離すで印を 1 回だけ確定すること（なぞっている間は画面の中の赤い線
 * だけ）、クリックで点 1 つ、点の間引きと上限での打ち切り、Shift+クリックで印を選ぶ、写真の外で押しても始めない、印の重ね（埋まる
 * 前は濃い・埋まった後は薄い・表示の切り替え）、ブラシの輪の大きさ、キーボード、「写す」の写し元のつまみ。
 * jsdom は要素の大きさを測れないので、canvas と入れ物の `getBoundingClientRect` を差し替える。
 */

/** 写真は画面の (100, 50) から 400 x 200（長辺 400px）。入れ物は (0, 0) から 600 x 300。 */
const PHOTO_RECT = { left: 100, top: 50, width: 400, height: 200 };
const AREA_RECT = { left: 0, top: 0, width: 600, height: 300 };
const SIZE: DevelopHealImageSize = { width: 400, height: 200 };

type OverlayOptions = {
  disabled?: boolean;
  marks?: DevelopHealMarkView[];
  painted?: string[];
  selectedId?: string | null;
  showMarks?: boolean;
  radius?: number;
  feather?: number;
  pointLimit?: number;
};

let container: HTMLDivElement;
let root: Root;
let onCommitStroke: ReturnType<typeof vi.fn<(points: readonly DevelopHealPoint[], size: DevelopHealImageSize) => void>>;
let onSelect: ReturnType<typeof vi.fn<(id: string | null) => void>>;
let onSourceChange: ReturnType<typeof vi.fn<(id: string, source: DevelopHealPoint, phase: "drag" | "commit") => void>>;

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

function mark(id: string, points: [number, number][], extra: Partial<DevelopHealMarkView> = {}): DevelopHealMarkView {
  return { id, mode: "remove", radius: 0.02, feather: 0.5, points, source: null, ...extra };
}

function Harness(props: OverlayOptions) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  return (
    <PhotoEditingHealOverlay
      targetRef={canvasRef}
      disabled={props.disabled ?? false}
      marks={props.marks ?? []}
      paintedMarks={new Set(props.painted ?? [])}
      selectedId={props.selectedId ?? null}
      showMarks={props.showMarks ?? true}
      brush={{ radius: props.radius ?? 0.02, feather: props.feather ?? 0.5 }}
      pointLimit={props.pointLimit ?? 512}
      onCommitStroke={onCommitStroke}
      onSelect={onSelect}
      onSourceChange={onSourceChange}
    >
      <canvas ref={canvasRef} data-testid="canvas" />
    </PhotoEditingHealOverlay>
  );
}

async function render(options: OverlayOptions = {}) {
  await act(async () => {
    root.render(<Harness {...options} />);
  });
}

function area(): HTMLElement {
  const found = container.querySelector<HTMLElement>('[data-testid="photo-heal-brush-area"]');
  if (!found) throw new Error("brush area not found");
  return found;
}

function byTestId(id: string): Element | null {
  return container.querySelector(`[data-testid="${id}"]`);
}

async function pointer(target: Element, type: string, clientX: number, clientY: number, init: PointerEventInit = {}) {
  await act(async () => {
    target.dispatchEvent(
      new PointerEvent(type, { bubbles: true, cancelable: true, clientX, clientY, pointerId: 1, button: 0, ...init }),
    );
  });
}

async function key(target: Element, keyName: string, init: KeyboardEventInit = {}) {
  let event: KeyboardEvent | null = null;
  await act(async () => {
    event = new KeyboardEvent("keydown", { key: keyName, bubbles: true, cancelable: true, ...init });
    target.dispatchEvent(event);
  });
  return event as unknown as KeyboardEvent;
}

beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  onCommitStroke = vi.fn();
  onSelect = vi.fn();
  onSourceChange = vi.fn();
  vi.spyOn(Element.prototype, "getBoundingClientRect").mockImplementation(function (this: Element) {
    if (this instanceof HTMLCanvasElement) return domRect(PHOTO_RECT);
    if (this.getAttribute("data-testid") === "photo-heal-brush-area") return domRect(AREA_RECT);
    return domRect({ left: 0, top: 0, width: 0, height: 0 });
  });
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  vi.restoreAllMocks();
});

describe("なぞる", () => {
  it("押す → 動かす → 離すで、写真の左上を原点に 0〜1 の点の印を 1 回だけ確定する（なぞっている間は画面の中の赤い線だけ）", async () => {
    await render();
    expect(area().getAttribute("role")).toBe("application");
    expect(area().getAttribute("aria-label")).toBe("修復のブラシ");
    expect(area().tabIndex).toBe(0);

    await pointer(area(), "pointerdown", 100, 50);
    expect(byTestId("photo-heal-live")).not.toBeNull();
    await pointer(area(), "pointermove", 300, 150);
    // 写真の外へ出た点は端に収める
    await pointer(area(), "pointermove", 900, 400);
    expect(onCommitStroke).not.toHaveBeenCalled();
    expect(byTestId("photo-heal-live")?.querySelector("polyline")?.getAttribute("stroke-width")).toBe("16");

    await pointer(area(), "pointerup", 900, 400);
    expect(onCommitStroke).toHaveBeenCalledTimes(1);
    expect(onCommitStroke).toHaveBeenCalledWith(
      [
        [0, 0],
        [0.5, 0.5],
        [1, 1],
      ],
      SIZE,
    );
    expect(byTestId("photo-heal-live")).toBeNull();
  });

  it("動かさずに離したら点 1 つの印（ほこり取り）", async () => {
    await render();
    await pointer(area(), "pointerdown", 300, 150);
    await pointer(area(), "pointerup", 300, 150);
    expect(onCommitStroke).toHaveBeenCalledWith([[0.5, 0.5]], SIZE);
  });

  it("前の点から半径の 1/4（ここでは 2px）より近い点は足さず、上限の点の数で打ち切る", async () => {
    await render({ pointLimit: 3 });
    await pointer(area(), "pointerdown", 200, 100);
    await pointer(area(), "pointermove", 201, 100);
    await pointer(area(), "pointermove", 204, 100);
    await pointer(area(), "pointermove", 210, 100);
    await pointer(area(), "pointermove", 220, 100);
    await pointer(area(), "pointerup", 220, 100);
    expect(onCommitStroke).toHaveBeenCalledWith(
      [
        [0.25, 0.25],
        [0.26, 0.25],
        [0.275, 0.25],
      ],
      SIZE,
    );
  });

  it("写真の外で押しても始めない。中止・取り上げでは確定しない。左ボタン以外は描かない", async () => {
    await render();
    await pointer(area(), "pointerdown", 50, 20);
    await pointer(area(), "pointerup", 50, 20);
    await pointer(area(), "pointerdown", 300, 150, { button: 2 });
    await pointer(area(), "pointerup", 300, 150, { button: 2 });
    await pointer(area(), "pointerdown", 300, 150);
    await pointer(area(), "pointermove", 320, 150);
    await pointer(area(), "pointercancel", 320, 150);
    expect(byTestId("photo-heal-live")).toBeNull();
    expect(onCommitStroke).not.toHaveBeenCalled();
  });

  it("押せない間・新しい印を描けない間は描かない（なぞる途中で押せなくなったら、その線は捨てる）", async () => {
    await render({ disabled: true });
    expect(area().getAttribute("aria-disabled")).toBe("true");
    await pointer(area(), "pointerdown", 300, 150);
    await pointer(area(), "pointerup", 300, 150);
    await render({ pointLimit: 0 });
    await pointer(area(), "pointerdown", 300, 150);
    await pointer(area(), "pointerup", 300, 150);
    expect(onCommitStroke).not.toHaveBeenCalled();

    await render();
    await pointer(area(), "pointerdown", 300, 150);
    expect(byTestId("photo-heal-live")).not.toBeNull();
    await render({ disabled: true });
    expect(byTestId("photo-heal-live")).toBeNull();
    await render();
    await pointer(area(), "pointerup", 300, 150);
    expect(onCommitStroke).not.toHaveBeenCalled();
  });
});

describe("印を選ぶ", () => {
  const marks = [
    mark("a", [
      [0.1, 0.5],
      [0.4, 0.5],
    ]),
    mark("b", [[0.8, 0.5]]),
  ];

  it("Shift+クリックで、その位置に重なる印を選ぶ（新しい印は作らない）。重なる印が無ければ選択を外す", async () => {
    await render({ marks, pointLimit: 0 });
    // (0.8, 0.5) = 画面の (420, 150)
    await pointer(area(), "pointerdown", 420, 152, { shiftKey: true });
    await pointer(area(), "pointerup", 420, 152, { shiftKey: true });
    expect(onSelect).toHaveBeenLastCalledWith("b");
    await pointer(area(), "pointerdown", 200, 150, { shiftKey: true });
    expect(onSelect).toHaveBeenLastCalledWith("a");
    await pointer(area(), "pointerdown", 300, 60, { shiftKey: true });
    expect(onSelect).toHaveBeenLastCalledWith(null);
    expect(onCommitStroke).not.toHaveBeenCalled();
  });
});

describe("印の重ね", () => {
  it("面がまだ描いていない印は濃く、描いた画に入っている印は薄く。選んでいる印は輪郭。印の表示を切ると埋まった印は出さない", async () => {
    const a = mark("a", [[0.2, 0.2]]);
    const b = mark("b", [
      [0.5, 0.5],
      [0.7, 0.5],
    ]);
    await render({ marks: [a, b], painted: [healMarkFingerprint(a)], selectedId: "a" });
    const markA = container.querySelector('[data-heal-mark="a"]');
    const markB = container.querySelector('[data-heal-mark="b"]');
    expect(markA?.getAttribute("data-heal-state")).toBe("painted");
    expect(markA?.getAttribute("data-selected")).toBe("true");
    expect(markA?.querySelector("mask")).not.toBeNull();
    expect(markB?.getAttribute("data-heal-state")).toBe("pending");
    expect(markB?.getAttribute("data-selected")).toBeNull();
    // 半径は長辺の px（0.02 × 400 = 8px）。点 1 つは円、2 つ以上は半径の太さの線
    expect(markA?.querySelector("circle")?.getAttribute("r")).toBe("8");
    expect(markB?.querySelector("polyline")?.getAttribute("points")).toBe("200,100 280,100");

    await render({ marks: [a, b], painted: [healMarkFingerprint(a)], selectedId: "a", showMarks: false });
    expect(container.querySelector('[data-heal-mark="a"]')).toBeNull();
    expect(container.querySelector('[data-heal-mark="b"]')).not.toBeNull();
  });

  it("重ねる絵は写真の canvas の実測に合わせて置き、押せない・読み上げない", async () => {
    await render();
    const svg = byTestId("photo-heal-marks") as SVGElement | null;
    expect(svg?.getAttribute("aria-hidden")).toBe("true");
    expect(svg?.getAttribute("class")).toContain("pointer-events-none");
    expect(svg?.style.left).toBe("100px");
    expect(svg?.style.top).toBe("50px");
    expect(svg?.style.width).toBe("400px");
    expect(svg?.style.height).toBe("200px");
  });
});

describe("ブラシの輪", () => {
  it("ポインタの位置に、半径の画面の px の輪（とぼかしても埋まる内側）を出し、領域から出たら消す", async () => {
    await render({ radius: 0.05, feather: 1 });
    await pointer(area(), "pointermove", 300, 150);
    const cursor = byTestId("photo-heal-cursor");
    expect(cursor?.getAttribute("data-radius")).toBe("20.00");
    const circles = Array.from(cursor?.querySelectorAll("circle") ?? []);
    expect(circles[0]?.getAttribute("cx")).toBe("200");
    expect(circles[0]?.getAttribute("cy")).toBe("100");
    expect(circles.map((circle) => circle.getAttribute("r"))).toEqual(["20", "20", "10"]);
    // React の onPointerLeave は pointerout（行き先が領域の外）で来る
    await pointer(area(), "pointerout", 700, 150, { relatedTarget: document.body });
    expect(byTestId("photo-heal-cursor")).toBeNull();
  });
});

describe("キーボード", () => {
  it("矢印でブラシを 1%（Shift で 10%）動かし、Enter・スペースでその場所に点 1 つの印。修飾キーつきは通す", async () => {
    await render();
    await key(area(), "ArrowRight");
    expect(byTestId("photo-heal-key-cursor")).not.toBeNull();
    await key(area(), "ArrowDown", { shiftKey: true });
    const enter = await key(area(), "Enter");
    expect(enter.defaultPrevented).toBe(true);
    expect(onCommitStroke).toHaveBeenLastCalledWith([[0.51, 0.6]], SIZE);
    await key(area(), "ArrowLeft");
    await key(area(), " ");
    expect(onCommitStroke).toHaveBeenLastCalledWith([[0.5, 0.6]], SIZE);
    const undo = await key(area(), "z", { metaKey: true });
    expect(undo.defaultPrevented).toBe(false);
    const arrowWithMeta = await key(area(), "ArrowRight", { metaKey: true });
    expect(arrowWithMeta.defaultPrevented).toBe(false);
    // Delete・Esc・[ ] は画面のキー（document）に任せる
    expect((await key(area(), "Delete")).defaultPrevented).toBe(false);
    expect((await key(area(), "Escape")).defaultPrevented).toBe(false);
    expect((await key(area(), "]")).defaultPrevented).toBe(false);
    expect(onCommitStroke).toHaveBeenCalledTimes(2);
  });

  it("新しい印を描けない間の Enter は印を作らない", async () => {
    await render({ pointLimit: 0 });
    await key(area(), "Enter");
    expect(onCommitStroke).not.toHaveBeenCalled();
  });
});

describe("「写す」の写し元のつまみ", () => {
  const clone = mark("c", [[0.5, 0.5]], { mode: "clone", source: [0.1, 0] });

  it("選んでいる「写す」の印だけにつまみを出す（写し元 = 印の中心 + ずれ）", async () => {
    await render({ marks: [clone] });
    expect(byTestId("photo-heal-source-handle")).toBeNull();
    await render({ marks: [mark("r", [[0.5, 0.5]])], selectedId: "r" });
    expect(byTestId("photo-heal-source-handle")).toBeNull();
    await render({ marks: [clone], selectedId: "c" });
    const handle = byTestId("photo-heal-source-handle") as HTMLButtonElement | null;
    expect(handle?.getAttribute("aria-label")).toBe("写し元の位置");
    // (0.6, 0.5) = 入れ物の (100 + 240, 50 + 100)
    expect(handle?.style.left).toBe("340px");
    expect(handle?.style.top).toBe("150px");
    expect(byTestId("photo-heal-source")).not.toBeNull();
    // 印の表示を切ると、埋まった印のつまみも出さない
    await render({ marks: [clone], selectedId: "c", showMarks: false, painted: [healMarkFingerprint(clone)] });
    expect(byTestId("photo-heal-source-handle")).toBeNull();
  });

  it("つまみをドラッグすると写し元を動かし（drag）、離すと 1 単位で確定する。ブラシは描かない。写真の外へは出さない", async () => {
    await render({ marks: [clone], selectedId: "c" });
    const handle = byTestId("photo-heal-source-handle");
    if (!handle) throw new Error("handle not found");
    await pointer(handle, "pointerdown", 340, 150);
    await pointer(handle, "pointermove", 380, 170);
    expect(onSourceChange).toHaveBeenLastCalledWith("c", [0.2, 0.1], "drag");
    // 写真の右下の外へ: 半径（横 0.02・縦 0.04）の分だけ内側で止める
    await pointer(handle, "pointermove", 900, 600);
    expect(onSourceChange).toHaveBeenLastCalledWith("c", [0.48, 0.46], "drag");
    await pointer(handle, "pointerup", 900, 600);
    expect(onSourceChange).toHaveBeenLastCalledWith("c", [0.48, 0.46], "commit");
    expect(onCommitStroke).not.toHaveBeenCalled();
    expect(byTestId("photo-heal-live")).toBeNull();
  });

  it("押して動かさずに離したら何も確定しない。矢印キーで 1%（Shift で 10%）ずつ動かして確定する", async () => {
    await render({ marks: [clone], selectedId: "c" });
    const handle = byTestId("photo-heal-source-handle");
    if (!handle) throw new Error("handle not found");
    await pointer(handle, "pointerdown", 340, 150);
    await pointer(handle, "pointerup", 340, 150);
    expect(onSourceChange).not.toHaveBeenCalled();
    const event = await key(handle, "ArrowUp");
    expect(event.defaultPrevented).toBe(true);
    expect(onSourceChange).toHaveBeenLastCalledWith("c", [0.1, -0.01], "commit");
    await key(handle, "ArrowLeft", { shiftKey: true });
    expect(onSourceChange).toHaveBeenLastCalledWith("c", [0, 0], "commit");
    expect(onCommitStroke).not.toHaveBeenCalled();
  });
});
