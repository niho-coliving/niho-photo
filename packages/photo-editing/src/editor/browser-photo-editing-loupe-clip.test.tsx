// @vitest-environment jsdom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { PHOTO_EDITING_CLIP_HIGHLIGHT_FLAG, PHOTO_EDITING_CLIP_SHADOW_FLAG } from "../photo-editing-histogram";

import { BrowserPhotoEditingLoupe } from "./browser-photo-editing-loupe";
import type { OpenedSource } from "./browser-photo-editing-model";

/**
 * 1 枚の表示（ループ）にクリップ領域の印を重ねる口（niho-photo#36）。渡した間だけ、写真の canvas の隣に透明な canvas を重ねる。
 * 渡さない・null・切り抜きの道具の間・仮のプレビューの間は、従来と同じ DOM。
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

async function render(extra: Partial<LoupeProps> = {}) {
  const props: LoupeProps = {
    opened: OPENED,
    opening: false,
    openedVisible: true,
    compareOriginal: false,
    presetPreviewName: null,
    canvasRef: { current: null },
    lockedReason: null,
    sourceError: null,
    onReload: null,
    ...extra,
  };
  await act(async () => {
    root.render(<BrowserPhotoEditingLoupe {...props} />);
  });
}

function overlay(): HTMLCanvasElement | null {
  return container.querySelector<HTMLCanvasElement>('[data-testid="photo-clip-overlay"]');
}

beforeEach(() => {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockImplementation((() => null) as unknown as HTMLCanvasElement["getContext"]);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.restoreAllMocks();
});

describe("BrowserPhotoEditingLoupe のクリップ領域の印", () => {
  it("渡さない・null の間は何も重ねない（従来と同じ DOM）", async () => {
    await render();
    expect(overlay()).toBeNull();
    await render({ clipOverlay: null });
    expect(overlay()).toBeNull();
    expect(container.querySelectorAll("canvas")).toHaveLength(1);
  });

  it("渡した間は、写真の canvas の後ろに 1 枚だけ重ね、押せず読み上げない", async () => {
    const canvasRef = { current: null as HTMLCanvasElement | null };
    await render({ clipOverlay: CLIP, canvasRef });
    const canvases = container.querySelectorAll("canvas");
    expect(canvases).toHaveLength(2);
    expect(canvases[0]).toBe(canvasRef.current);
    expect(canvases[1]).toBe(overlay());
    expect(overlay()?.getAttribute("aria-hidden")).toBe("true");
    expect(overlay()?.className).toContain("pointer-events-none");
    // 写真の canvas の名前（読み上げ）は変えない
    expect(canvases[0]?.getAttribute("aria-label")).toBe("photo-1.jpg のプレビュー");
  });

  it("切り抜きの道具の間・仮のプレビューを見せている間は重ねない", async () => {
    await render({
      clipOverlay: CLIP,
      crop: {
        geometry: { rotate: 0, flipH: false, flipV: false, angle: 0, crop: { left: 0, top: 0, right: 1, bottom: 1 } },
        source: { width: 100, height: 100 },
        liveAngle: null,
        disabled: false,
        onCommit: vi.fn(),
      },
    });
    expect(overlay()).toBeNull();

    await render({ clipOverlay: CLIP, opened: { ...OPENED, previewPending: true, viewUrl: "blob:preview" } });
    expect(overlay()).toBeNull();
  });
});
