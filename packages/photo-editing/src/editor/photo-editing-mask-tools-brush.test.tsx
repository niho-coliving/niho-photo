// @vitest-environment jsdom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { DevelopSurfaceMask } from "../develop-engine/develop-masks";
import { PHOTO_EDITING_MASK_BRUSH_DEFAULT } from "../photo-editing-mask-brush";

import { PhotoEditingMaskTools, type PhotoEditingMaskToolsProps } from "./photo-editing-mask-tools";
import type { BrowserPhotoMaskBrush } from "./use-browser-photo-mask-brush";

/**
 * 右パネルのマスクの面のブラシ・面のマスク（M4 #68）: 「ブラシ」を足すボタン、ブラシの道具（描く / 消しゴム・大きさ・ぼかし・流量・
 * 全体を塗る / 消す・塗るのをやめた後に戻る）、被写体・空の行と説明、面を読めない理由と読み直し。
 */

const BRUSH: DevelopSurfaceMask = {
  id: "mask-b",
  kind: "brush",
  enabled: true,
  invert: false,
  surface: { id: "a".repeat(64), width: 1024, height: 683 },
  adjust: {},
};
const SUBJECT: DevelopSurfaceMask = { ...BRUSH, id: "mask-s", kind: "subject", surface: { ...BRUSH.surface, id: "b".repeat(64) } };
const SKY: DevelopSurfaceMask = { ...BRUSH, id: "mask-k", kind: "sky", invert: true, surface: { ...BRUSH.surface, id: "c".repeat(64) } };

let container: HTMLDivElement;
let root: Root;
let props: PhotoEditingMaskToolsProps;

function fakeBrush(overrides: Partial<BrowserPhotoMaskBrush> = {}): BrowserPhotoMaskBrush {
  return {
    available: true,
    mask: BRUSH,
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
    startStroke: vi.fn(() => null),
    discardStroke: vi.fn(),
    clear: vi.fn(),
    fill: vi.fn(),
    retry: vi.fn(),
    ...overrides,
  } as BrowserPhotoMaskBrush;
}

async function render(overrides: Partial<PhotoEditingMaskToolsProps> = {}) {
  props = {
    masks: [BRUSH, SUBJECT, SKY],
    selected: BRUSH,
    select: vi.fn(),
    kinds: ["linear", "radial", "brush"],
    canAdd: true,
    addBlockedReason: null,
    whiteBalanceAbsolute: false,
    overlayVisible: false,
    setOverlayVisible: vi.fn(),
    add: vi.fn(),
    duplicate: vi.fn(),
    remove: vi.fn(),
    toggleEnabled: vi.fn(),
    toggleInvert: vi.fn(),
    changeAdjust: vi.fn(),
    changeFeather: vi.fn(),
    brush: fakeBrush(),
    notice: null,
    canRetrySurfaces: false,
    retrySurfaces: vi.fn(),
    disabled: false,
    ...overrides,
  } as PhotoEditingMaskToolsProps;
  await act(async () => {
    root.render(<PhotoEditingMaskTools {...props} />);
  });
}

function button(label: string): HTMLButtonElement {
  const found =
    container.querySelector<HTMLButtonElement>(`button[aria-label="${label}"]`) ??
    Array.from(container.querySelectorAll<HTMLButtonElement>("button")).find((candidate) => candidate.textContent === label);
  if (!found) throw new Error(`button not found: ${label}`);
  return found;
}

function sliderLabels(): string[] {
  return Array.from(container.querySelectorAll<HTMLInputElement>('input[type="range"]')).map(
    (input) => input.getAttribute("aria-label") ?? "",
  );
}

async function click(element: Element) {
  await act(async () => {
    element.dispatchEvent(new MouseEvent("click", { bubbles: true }));
  });
}

beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

describe("PhotoEditingMaskTools（ブラシ・面のマスク）", () => {
  it("「ブラシ」を線形・円形と並べて足せる（足している途中・8 枚では押せない）", async () => {
    await render();
    await click(button("ブラシ"));
    expect(props.add).toHaveBeenCalledWith("brush");
    await render({ canAdd: false, addBlockedReason: "マスクは 8 枚までです。使わないマスクを削除すると追加できます。" });
    expect(button("ブラシ").disabled).toBe(true);
    await render({ kinds: ["linear", "radial"] });
    expect(() => button("ブラシ")).toThrow();
  });

  it("一覧はブラシ・被写体・空の名前（種類と番号）で、被写体・空も補正・反転・目・削除ができる", async () => {
    await render();
    expect(button("ブラシ 1 を選ぶ")).toBeTruthy();
    expect(button("被写体 2 を選ぶ")).toBeTruthy();
    expect(button("空 3 を選ぶ").getAttribute("aria-pressed")).toBe("false");
    expect(button("空 3 を反転").getAttribute("aria-pressed")).toBe("true");
    await click(button("被写体 2 を削除"));
    expect(props.remove).toHaveBeenCalledWith("mask-s");
    await click(button("空 3 を当てる"));
    expect(props.toggleEnabled).toHaveBeenCalledWith("mask-k");
  });

  it("選んだブラシのマスク: 描く / 消しゴム・大きさ・ぼかし・流量・全体を塗る / 消すと、局所の補正", async () => {
    await render();
    expect(container.textContent).toContain("ブラシ 1 の補正");
    expect(button("描く").getAttribute("aria-pressed")).toBe("true");
    expect(button("消しゴム").getAttribute("aria-pressed")).toBe("false");
    await click(button("消しゴム"));
    expect(props.brush!.setErase).toHaveBeenCalledWith(true);
    expect(sliderLabels().slice(0, 3)).toEqual(["大きさ", "ぼかし", "流量"]);
    expect(sliderLabels()).toContain("露光量");
    await click(button("全体を塗る"));
    await click(button("全体を消す"));
    expect(props.brush!.fill).toHaveBeenCalledOnce();
    expect(props.brush!.clear).toHaveBeenCalledOnce();
    expect(container.textContent).toContain("写真をなぞって範囲を塗ります");
    // 塗るのをやめた後は「写真に塗る」で戻る
    expect(() => button("写真に塗る")).toThrow();
    await render({ brush: fakeBrush({ paintMode: false }) });
    await click(button("写真に塗る"));
    expect(props.brush!.resumePaint).toHaveBeenCalledOnce();
  });

  it("面を読んでいる間は全体を塗る / 消すを押せない。読み込み中の 1 行を出す", async () => {
    await render({ brush: fakeBrush({ status: "loading", canPaint: false }) });
    expect(button("全体を塗る").disabled).toBe(true);
    expect(container.textContent).toContain("マスクの面を読み込んでいます");
  });

  it("被写体・空は塗らない（説明だけ）。面を保存できない出どころのブラシは、範囲を動かせない説明", async () => {
    await render({ selected: SUBJECT, brush: fakeBrush({ mask: null }) });
    expect(container.textContent).toContain("この範囲は写真から選んだものです");
    expect(container.querySelector('[data-testid="photo-mask-brush-tools"]')).toBeNull();
    await render({ selected: BRUSH, brush: fakeBrush({ available: false }) });
    expect(container.querySelector('[data-testid="photo-mask-brush-tools"]')).toBeNull();
    expect(container.textContent).toContain("このマスクの範囲は、この画面ではまだ動かせません");
  });

  it("面を読めない理由の 1 行と「もう一度読み込む」", async () => {
    const notice = "マスクの面を読めません（ブラシ 1）。もう一度読み込むか、このマスクを削除してください。";
    await render({ notice, canRetrySurfaces: true });
    expect(container.querySelector('[data-testid="photo-mask-notice"]')?.textContent).toContain(notice);
    await click(button("もう一度読み込む"));
    expect(props.retrySurfaces).toHaveBeenCalledOnce();
    await render({ notice: "ブラシのマスクを追加できませんでした。もう一度お試しください。", canRetrySurfaces: false });
    expect(() => button("もう一度読み込む")).toThrow();
  });
});
