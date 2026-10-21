// @vitest-environment jsdom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { neutralDevelopSettings } from "../develop-engine/develop-settings";

import { BrowserPhotoEditingMobileEditor } from "./browser-photo-editing-mobile-editor";
import { measurePhotoSurface, usePhotoEditingZoom } from "./use-photo-editing-zoom";

/**
 * スマホの 1 枚の編集の層の「比較」（niho-photo#41）。写真の面の右上の切り替えで補正前と補正後を上下に並べ、並べている間は
 * 「補正前」（ボタン・長押し）を使わない。拡大は両方の画が同じ値を読み、測るのは指の下の半分の面。
 */

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

type MobileProps = Parameters<typeof BrowserPhotoEditingMobileEditor>[0];

let container: HTMLDivElement;
let root: Root;
const onToggle = vi.fn();
const onCompareOriginalChange = vi.fn<(compare: boolean) => void>();

async function render(extra: Partial<MobileProps> = {}) {
  const props: MobileProps = {
    photoKey: "photo-1",
    photo: <canvas aria-label="photo-1.jpg のプレビュー" />,
    statusLine: null,
    settings: neutralDevelopSettings(),
    canEdit: true,
    canCompare: true,
    controlsDisabled: false,
    canReset: false,
    canUndo: false,
    canRedo: false,
    work: null,
    raw: false,
    busy: false,
    compareOriginal: false,
    canExport: false,
    exportChoices: null,
    exporting: false,
    exportReady: false,
    onBack: () => undefined,
    onUndo: () => undefined,
    onRedo: () => undefined,
    onReset: () => undefined,
    onRetryWork: () => undefined,
    onSettingsChange: () => undefined,
    onCompareOriginalChange,
    onExport: async () => ({ kind: "cancelled" }) as never,
    onSharePending: async () => ({ kind: "cancelled" }) as never,
    onExportSheetClosed: () => undefined,
    ...extra,
  };
  await act(async () => {
    root.render(<BrowserPhotoEditingMobileEditor {...props} />);
  });
}

function toggle(): HTMLButtonElement | null {
  return document.body.querySelector<HTMLButtonElement>('button[aria-label="補正前と補正後を上下に並べる"]');
}

function originalButton(): HTMLButtonElement | null {
  return document.body.querySelector<HTMLButtonElement>('button[aria-label="補正前"]');
}

function photoSurface(): HTMLElement {
  const found = document.body.querySelector<HTMLElement>('[data-testid="photo-editing-mobile-photo"]');
  if (!found) throw new Error("photo surface not found");
  return found;
}

beforeEach(() => {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  onToggle.mockReset();
  onCompareOriginalChange.mockReset();
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("BrowserPhotoEditingMobileEditor の比較", () => {
  it("渡さない間は切り替えを出さない（層は今までどおり）", async () => {
    await render();
    expect(toggle()).toBeNull();
    expect(originalButton()?.disabled).toBe(false);
  });

  it("写真の面の右上に切り替えを置き、押した状態を aria-pressed で読む。押すと切り替える", async () => {
    await render({ compareView: { active: false, onToggle } });
    const button = toggle();
    expect(button).not.toBeNull();
    expect(photoSurface().contains(button)).toBe(true);
    expect(button?.getAttribute("aria-pressed")).toBe("false");
    expect(button?.className).toContain("h-11");
    expect(button?.className).toContain("w-11");
    await act(async () => button?.click());
    expect(onToggle).toHaveBeenCalledOnce();

    await render({ compareView: { active: true, onToggle } });
    expect(toggle()?.getAttribute("aria-pressed")).toBe("true");
  });

  it("並べている間は「補正前」を押せず、写真の面の長押しでも補正前にしない", async () => {
    vi.useFakeTimers();
    await render({ compareView: { active: true, onToggle } });
    expect(originalButton()?.disabled).toBe(true);
    const surface = photoSurface();
    await act(async () => {
      surface.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, pointerId: 1, isPrimary: true, clientX: 50, clientY: 50 }));
      vi.advanceTimersByTime(600);
    });
    expect(onCompareOriginalChange).not.toHaveBeenCalled();
    await act(async () => {
      surface.dispatchEvent(new PointerEvent("pointerup", { bubbles: true, pointerId: 1, clientX: 50, clientY: 50 }));
    });

    // 並べていなければ、長押しは今までどおり補正前
    await render({ compareView: { active: false, onToggle } });
    await act(async () => {
      surface.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, pointerId: 2, isPrimary: true, clientX: 50, clientY: 50 }));
      vi.advanceTimersByTime(600);
    });
    expect(onCompareOriginalChange).toHaveBeenLastCalledWith(true);
  });
});

describe("measurePhotoSurface（並べている間の拡大の測り方）", () => {
  function sized<T extends HTMLElement>(
    element: T,
    box: { left: number; top: number; width: number; height: number },
  ): T {
    Object.defineProperty(element, "clientWidth", { configurable: true, value: box.width });
    Object.defineProperty(element, "clientHeight", { configurable: true, value: box.height });
    Object.defineProperty(element, "offsetWidth", { configurable: true, value: box.width });
    Object.defineProperty(element, "offsetHeight", { configurable: true, value: box.height });
    element.getBoundingClientRect = () =>
      ({ ...box, x: box.left, y: box.top, right: box.left + box.width, bottom: box.top + box.height, toJSON: () => box }) as DOMRect;
    return element;
  }

  function photoCanvas(box: { left: number; top: number; width: number; height: number }): HTMLCanvasElement {
    const canvas = sized(document.createElement("canvas"), box);
    canvas.width = 1200;
    canvas.height = 900;
    return canvas;
  }

  it("半分の面が無ければ面そのものを測る（今までどおり）", () => {
    const surface = sized(document.createElement("div"), { left: 0, top: 0, width: 400, height: 600 });
    surface.appendChild(photoCanvas({ left: 0, top: 150, width: 400, height: 300 }));
    expect(measurePhotoSurface(surface, { x: 10, y: 10 })).toMatchObject({ areaWidth: 400, areaHeight: 600, centerX: 200, centerY: 300 });
  });

  it("上下に並べている間は、指の下の半分の面（無ければ上の面）を測る", () => {
    const surface = sized(document.createElement("div"), { left: 0, top: 0, width: 400, height: 600 });
    const top = sized(document.createElement("div"), { left: 0, top: 0, width: 400, height: 300 });
    const bottom = sized(document.createElement("section"), { left: 0, top: 300, width: 400, height: 300 });
    top.setAttribute("data-photo-zoom-pane", "");
    bottom.setAttribute("data-photo-zoom-pane", "");
    top.appendChild(photoCanvas({ left: 0, top: 0, width: 400, height: 300 }));
    bottom.appendChild(photoCanvas({ left: 0, top: 300, width: 400, height: 300 }));
    surface.append(top, bottom);

    expect(measurePhotoSurface(surface, { x: 200, y: 450 })).toMatchObject({
      areaWidth: 400,
      areaHeight: 300,
      contentWidth: 400,
      contentHeight: 300,
      centerX: 200,
      centerY: 450,
    });
    expect(measurePhotoSurface(surface, { x: 200, y: 100 })).toMatchObject({ areaHeight: 300, centerY: 150 });
    expect(measurePhotoSurface(surface)).toMatchObject({ areaHeight: 300, centerY: 150 });
  });
});

describe("usePhotoEditingZoom（比較pane変更時の再clamp）", () => {
  function setBox(element: HTMLElement, box: { left: number; top: number; width: number; height: number }) {
    Object.defineProperty(element, "clientWidth", { configurable: true, value: box.width });
    Object.defineProperty(element, "clientHeight", { configurable: true, value: box.height });
    Object.defineProperty(element, "offsetWidth", { configurable: true, value: box.width });
    Object.defineProperty(element, "offsetHeight", { configurable: true, value: box.height });
    element.getBoundingClientRect = () =>
      ({
        ...box,
        x: box.left,
        y: box.top,
        right: box.left + box.width,
        bottom: box.top + box.height,
        toJSON: () => box,
      }) as DOMRect;
  }

  function ZoomHarness(props: { compare: boolean }) {
    const zoom = usePhotoEditingZoom({ photoKey: "portrait", holdEnabled: false, onHoldChange: () => undefined });
    const surfaceRef = (surface: HTMLDivElement | null) => {
      zoom.surfaceRef.current = surface;
      if (surface) setBox(surface, { left: 0, top: 0, width: 400, height: 600 });
    };
    const canvasRef = (height: number) => (canvas: HTMLCanvasElement | null) => {
      if (!canvas) return;
      canvas.width = 900;
      canvas.height = 1200;
      setBox(canvas, { left: 0, top: 0, width: 400, height });
    };
    const paneRef = (top: number) => (pane: HTMLDivElement | null) => {
      if (pane) setBox(pane, { left: 0, top, width: 400, height: 300 });
    };
    const handlers = {
      onPointerDown: zoom.onPointerDown,
      onPointerMove: zoom.onPointerMove,
      onPointerUp: zoom.onPointerUp,
      onPointerCancel: zoom.onPointerCancel,
    };
    return (
      <div ref={surfaceRef} data-testid="zoom-surface" {...handlers}>
        {props.compare ? (
          <>
            <div ref={paneRef(0)} data-photo-zoom-pane=""><canvas ref={canvasRef(300)} /></div>
            <div ref={paneRef(300)} data-photo-zoom-pane=""><canvas ref={canvasRef(300)} /></div>
          </>
        ) : (
          <canvas ref={canvasRef(600)} />
        )}
      </div>
    );
  }

  async function renderZoom(compare: boolean) {
    await act(async () => root.render(<ZoomHarness compare={compare} />));
  }

  async function pointer(type: string, x: number, y: number) {
    const surface = zoomSurface();
    await act(async () => {
      surface.dispatchEvent(
        new PointerEvent(type, { bubbles: true, cancelable: true, pointerId: 1, isPrimary: true, clientX: x, clientY: y }),
      );
    });
  }

  function zoomSurface(): HTMLElement {
    const surface = container.querySelector<HTMLElement>('[data-testid="zoom-surface"]');
    if (!surface) throw new Error("zoom surface not found");
    return surface;
  }

  async function flushPaneObserver() {
    await act(async () => new Promise<void>((resolve) => window.setTimeout(resolve, 0)));
  }

  it("上下paneの追加・削除後に、写真の拡大位置をその面へ収め直す", async () => {
    await renderZoom(false);
    await pointer("pointerdown", 200, 300);
    await pointer("pointerup", 200, 300);
    await pointer("pointerdown", 200, 300);
    await pointer("pointerup", 200, 300);
    await pointer("pointerdown", 200, 200);
    await pointer("pointermove", 220, 220);
    await pointer("pointermove", 220, 1020);
    await pointer("pointerup", 220, 1020);
    expect(zoomSurface().style.getPropertyValue("--photo-editing-zoom")).toContain("300px");

    await renderZoom(true);
    await flushPaneObserver();
    expect(zoomSurface().style.getPropertyValue("--photo-editing-zoom")).toContain("187.5px");

    await renderZoom(false);
    await flushPaneObserver();
    expect(zoomSurface().querySelectorAll("[data-photo-zoom-pane]")).toHaveLength(0);
    expect(measurePhotoSurface(zoomSurface())?.areaHeight).toBe(600);
    expect(zoomSurface().style.getPropertyValue("--photo-editing-zoom")).toContain("187.5px");
  });
});
