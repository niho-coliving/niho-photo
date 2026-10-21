// @vitest-environment jsdom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { PHOTO_EDITING_CLIP_HIGHLIGHT_FLAG, PHOTO_EDITING_CLIP_SHADOW_FLAG } from "../photo-editing-histogram";

import { BrowserPhotoEditingLoupe } from "./browser-photo-editing-loupe";
import type { OpenedSource } from "./browser-photo-editing-model";

/**
 * 1 枚の表示（ループ）で補正前と補正後を見比べる口（niho-photo#41）。並べる（左右 / 上下）は補正前の面を足して補正後の面を半分に
 * し、分割は補正後の canvas に補正前を重ねる。どちらも補正後の canvas は置き直さず、閉じると DOM は元どおり。
 */

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLDivElement;
let root: Root;

const OPENED: OpenedSource = {
  key: "photo-1",
  fileName: "photo-1.jpg",
  decoded: null,
  viewUrl: null,
  lockedReason: null,
  loadedForEditing: true,
  mode: "wasm",
  input: null,
  work: null,
  photo: null,
};

const CLIP = {
  mask: {
    width: 2,
    height: 1,
    flags: Uint8Array.from([PHOTO_EDITING_CLIP_SHADOW_FLAG, PHOTO_EDITING_CLIP_HIGHLIGHT_FLAG]),
  },
  shadows: true,
  highlights: true,
};

type LoupeProps = Parameters<typeof BrowserPhotoEditingLoupe>[0];
type CompareProps = NonNullable<LoupeProps["compare"]>;

const canvasRef: { current: HTMLCanvasElement | null } = { current: null };
let beforeCanvas: HTMLCanvasElement | null = null;
const beforeCanvasRef = (canvas: HTMLCanvasElement | null) => {
  beforeCanvas = canvas;
};
const onSplitChange = vi.fn<(split: number) => void>();

function compare(extra: Partial<CompareProps> = {}): CompareProps {
  return { mode: "side", direction: "row", beforeCanvasRef, split: 50, onSplitChange, ...extra };
}

async function render(extra: Partial<LoupeProps> = {}) {
  const props: LoupeProps = {
    opened: OPENED,
    opening: false,
    openedVisible: true,
    compareOriginal: false,
    presetPreviewName: null,
    canvasRef,
    lockedReason: null,
    sourceError: null,
    onReload: null,
    ...extra,
  };
  await act(async () => {
    root.render(<BrowserPhotoEditingLoupe {...props} />);
  });
}

function section(): HTMLElement {
  const found = container.querySelector<HTMLElement>('section[aria-label="写真プレビュー"]');
  if (!found) throw new Error("section not found");
  return found;
}

function byTestId(id: string): HTMLElement | null {
  return container.querySelector<HTMLElement>(`[data-testid="${id}"]`);
}

beforeEach(() => {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  canvasRef.current = null;
  beforeCanvas = null;
  vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockImplementation((() => null) as unknown as HTMLCanvasElement["getContext"]);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.restoreAllMocks();
});

describe("BrowserPhotoEditingLoupe の比較", () => {
  it("比較しない間は今までどおり（面 1 つ・canvas 1 枚・札なし）。開いて閉じても同じ DOM・同じ補正後の canvas", async () => {
    await render();
    const initial = container.innerHTML;
    const after = canvasRef.current;
    expect(container.children).toHaveLength(1);
    expect(container.querySelectorAll("canvas")).toHaveLength(1);
    expect(section().className).toBe("absolute inset-0 flex items-center justify-center bg-[var(--photo-editing-surface,white)] overflow-hidden");
    expect(section().hasAttribute("data-photo-zoom-pane")).toBe(false);
    await render({ compare: null });
    expect(container.innerHTML).toBe(initial);

    await render({ compare: compare() });
    expect(canvasRef.current).toBe(after);
    await render({ compare: compare({ mode: "split" }) });
    expect(canvasRef.current).toBe(after);
    await render({ compare: null });
    expect(container.innerHTML).toBe(initial);
    expect(canvasRef.current).toBe(after);
    expect(beforeCanvas).toBeNull();
  });

  it("並べる（左右）: 左の半分に補正前の面を足し、補正後の面は右の半分。札は「補正前」「補正後」", async () => {
    await render({ compare: compare() });
    const pane = byTestId("photo-compare-before");
    expect(pane).not.toBeNull();
    expect(pane?.className).toContain("left-0");
    expect(pane?.className).toContain("w-1/2");
    expect(pane?.className).toContain("overflow-hidden");
    expect(section().className).toContain("left-1/2");
    expect(section().className).toContain("overflow-hidden");
    // 補正前の面は補正後の面の前（同じ入れ物の中で並ぶ）
    expect(container.children[0]).toBe(pane);
    expect(container.children[1]).toBe(section());

    const canvases = container.querySelectorAll("canvas");
    expect(canvases).toHaveLength(2);
    expect(beforeCanvas).toBe(pane?.querySelector("canvas"));
    expect(beforeCanvas?.getAttribute("aria-label")).toBe("photo-1.jpg の補正前");
    expect(canvasRef.current?.getAttribute("aria-label")).toBe("photo-1.jpg の補正後");
    expect(section().contains(canvasRef.current)).toBe(true);
    // 同じ大きさ・同じ中央寄せ・同じ拡大の値を読む
    expect(beforeCanvas?.className).toBe(canvasRef.current?.className);
    expect(byTestId("photo-compare-before-badge")?.textContent).toBe("補正前");
    expect(pane?.contains(byTestId("photo-compare-before-badge"))).toBe(true);
    expect(byTestId("photo-compare-after-badge")?.textContent).toBe("補正後");
    expect(section().contains(byTestId("photo-compare-after-badge"))).toBe(true);
    // スマホの層の拡大が両方の面を測れる
    expect(pane?.hasAttribute("data-photo-zoom-pane")).toBe(true);
    expect(section().hasAttribute("data-photo-zoom-pane")).toBe(true);
  });

  it("並べる（上下）: 上の半分が補正前・下の半分が補正後。拡大した画をはみ出させない（スマホの層の unclipped でも切る）", async () => {
    await render({ compare: compare({ direction: "column" }), unclipped: true });
    const pane = byTestId("photo-compare-before");
    expect(pane?.className).toContain("top-0");
    expect(pane?.className).toContain("h-1/2");
    expect(section().className).toContain("top-1/2");
    expect(section().className).toContain("overflow-hidden");
    expect(beforeCanvas?.className).toContain("[transform:var(--photo-editing-zoom,none)]");
  });

  it("並べている間のプリセットの仮の表示は、補正後の側の札がプリセットの札に代わる", async () => {
    await render({ compare: compare(), presetPreviewName: "明るい" });
    expect(byTestId("photo-compare-after-badge")).toBeNull();
    expect(byTestId("photo-preset-preview-badge")?.textContent).toBe("明るい のプレビュー");
    expect(section().contains(byTestId("photo-preset-preview-badge"))).toBe(true);
  });

  it("分割: 補正後の面は全体のまま、補正後の canvas とクリップの印の後ろに補正前を重ね、札は左上 = 補正前・右上 = 補正後", async () => {
    await render({ compare: compare({ mode: "split", split: 30 }), clipOverlay: CLIP });
    expect(byTestId("photo-compare-before")).toBeNull();
    expect(section().className).toBe("absolute inset-0 flex items-center justify-center bg-[var(--photo-editing-surface,white)] overflow-hidden");
    const split = byTestId("photo-compare-split");
    const clip = byTestId("photo-clip-overlay");
    expect(split).not.toBeNull();
    expect(clip).not.toBeNull();
    // クリップの印は補正後の側にだけ（補正前の canvas が印の上に来る）
    expect(clip!.compareDocumentPosition(split!) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(beforeCanvas).toBe(split?.querySelector("canvas"));
    expect(beforeCanvas?.style.clipPath).toBe("inset(0 70% 0 0)");
    expect(container.querySelector('[role="slider"]')?.getAttribute("aria-valuenow")).toBe("30");
    expect(byTestId("photo-compare-before-badge")?.className).toContain("left-3");
    expect(byTestId("photo-compare-after-badge")?.className).toContain("right-3");
    expect(byTestId("photo-compare-after-badge")?.textContent).toBe("補正後");

    await render({ compare: compare({ mode: "split" }), presetPreviewName: "明るい" });
    expect(byTestId("photo-preset-preview-badge")).toBeNull();
    expect(byTestId("photo-compare-after-badge")?.textContent).toBe("明るい のプレビュー");
  });

  it("並べる間のクリップの印は補正後の面の中だけ", async () => {
    await render({ compare: compare(), clipOverlay: CLIP });
    const clip = byTestId("photo-clip-overlay");
    expect(section().contains(clip)).toBe(true);
    expect(byTestId("photo-compare-before")?.contains(clip)).toBe(false);
  });

  it("切り抜きの道具の間・仮のプレビューの間（分割）は重ねない", async () => {
    await render({
      compare: compare({ mode: "split" }),
      crop: {
        geometry: { rotate: 0, flipH: false, flipV: false, angle: 0, crop: { left: 0, top: 0, right: 1, bottom: 1 } },
        source: { width: 100, height: 100 },
        liveAngle: null,
        disabled: false,
        onCommit: vi.fn(),
      },
    });
    expect(byTestId("photo-compare-split")).toBeNull();
    expect(byTestId("photo-compare-before")).toBeNull();
    await render({
      compare: compare(),
      crop: {
        geometry: { rotate: 0, flipH: false, flipV: false, angle: 0, crop: { left: 0, top: 0, right: 1, bottom: 1 } },
        source: { width: 100, height: 100 },
        liveAngle: null,
        disabled: false,
        onCommit: vi.fn(),
      },
    });
    expect(byTestId("photo-compare-before")).toBeNull();
    expect(beforeCanvas).toBeNull();

    await render({ compare: compare({ mode: "split" }), opened: { ...OPENED, previewPending: true, viewUrl: "blob:preview" } });
    expect(byTestId("photo-compare-split")).toBeNull();
  });
});
