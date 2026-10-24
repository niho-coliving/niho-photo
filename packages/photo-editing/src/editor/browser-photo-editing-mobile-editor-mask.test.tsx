// @vitest-environment jsdom

import { act, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { neutralDevelopSettings } from "../develop-engine/develop-settings";

import { BrowserPhotoEditingMobileEditor } from "./browser-photo-editing-mobile-editor";
import { usePhotoEditingZoom } from "./use-photo-editing-zoom";

/**
 * スマホの全体の編集の層の「マスク」（部分補正。niho-photo#93）。道具の帯のポイントカラーの後ろ・切り抜きの前に置き、押すとマスクの
 * hook に入って段にマスクの道具を出す。ほかの道具に移ると出る。hook がひとりでに出た（写真を替えた・使えなくなった）ら、今の道具を
 * 既定に戻す。マスクの間もピンチの拡大は使え、長押しの補正前は使わない。
 */

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

type MobileProps = Parameters<typeof BrowserPhotoEditingMobileEditor>[0];

let container: HTMLDivElement;
let root: Root;
let enter: ReturnType<typeof vi.fn<() => void>>;
let leave: ReturnType<typeof vi.fn<() => void>>;
let onCompareOriginalChange: ReturnType<typeof vi.fn<(compare: boolean) => void>>;
let leaveFromOutside: (() => void) | null;

function Harness(props: { photoKey?: string; mask?: boolean; edited?: boolean; extra?: Partial<MobileProps> }) {
  const [active, setActive] = useState(false);
  leaveFromOutside = () => setActive(false);
  const mobileProps: MobileProps = {
    photoKey: props.photoKey ?? "photo-1",
    photo: <canvas aria-label="photo-1.jpg のプレビュー" />,
    statusLine: null,
    settings: neutralDevelopSettings(null),
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
    hslMixer: <section data-testid="hsl">HSL</section>,
    colorMixer: <section data-testid="point-color">ポイントカラー</section>,
    crop: {
      active: false,
      disabled: false,
      geometry: {} as never,
      source: null,
      liveAngle: null,
      exportLongEdge: null,
      enter: vi.fn(),
      leave: vi.fn(),
      commit: vi.fn(),
      reset: vi.fn(),
      setLiveAngle: vi.fn(),
    },
    mask:
      props.mask === false
        ? undefined
        : {
            active,
            edited: props.edited ?? false,
            disabled: false,
            enter: () => {
              enter();
              setActive(true);
            },
            leave: () => {
              leave();
              setActive(false);
            },
            band: <div data-testid="mask-band-content">マスクの段</div>,
          },
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
    ...props.extra,
  };
  return <BrowserPhotoEditingMobileEditor {...mobileProps} />;
}

async function render(props: Parameters<typeof Harness>[0] = {}) {
  await act(async () => {
    root.render(<Harness {...props} />);
  });
}

function toolStrip(): HTMLElement {
  const found = document.body.querySelector<HTMLElement>('nav[aria-label="道具"]');
  if (!found) throw new Error("tool strip not found");
  return found;
}

function toolNames(): string[] {
  return Array.from(toolStrip().querySelectorAll("button")).map((button) => button.textContent ?? "");
}

function tool(name: string): HTMLButtonElement {
  const found = Array.from(toolStrip().querySelectorAll<HTMLButtonElement>("button")).find((button) =>
    button.textContent?.startsWith(name),
  );
  if (!found) throw new Error(`tool not found: ${name}`);
  return found;
}

function band(): HTMLElement | null {
  return document.body.querySelector<HTMLElement>('[data-testid="photo-editing-mobile-mask"]');
}

async function click(element: Element) {
  await act(async () => {
    element.dispatchEvent(new MouseEvent("click", { bubbles: true }));
  });
}

beforeEach(() => {
  enter = vi.fn<() => void>();
  leave = vi.fn<() => void>();
  onCompareOriginalChange = vi.fn<(compare: boolean) => void>();
  leaveFromOutside = null;
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  vi.useRealTimers();
  act(() => root.unmount());
  container.remove();
});

describe("BrowserPhotoEditingMobileEditor のマスク", () => {
  it("渡さない間は道具を出さない。渡すとポイントカラーの後ろ・切り抜きの前に「マスク」を置く", async () => {
    await render({ mask: false });
    expect(toolNames()).not.toContain("マスク");
    await render();
    expect(toolNames()).toEqual(["ライト", "カラー", "効果", "カラーミキサー", "ポイントカラー", "マスク", "切り抜き"]);
    // マスクがある写真は、道具に点を添える
    expect(tool("マスク").querySelector("span.rounded-full")).toBeNull();
    await render({ edited: true });
    expect(tool("マスク").querySelector("span.rounded-full")).not.toBeNull();
  });

  it("押すと hook に入って段にマスクの道具を出し（現在地は aria-current）、ほかの道具に移ると出る", async () => {
    await render();
    expect(band()).toBeNull();
    await click(tool("マスク"));
    expect(enter).toHaveBeenCalledTimes(1);
    expect(tool("マスク").getAttribute("aria-current")).toBe("true");
    expect(band()?.querySelector('[data-testid="mask-band-content"]')).not.toBeNull();
    expect(band()?.className).toContain("max-h-[17rem]");
    expect(band()?.className).toContain("overflow-y-auto");
    await click(tool("カラー"));
    expect(leave).toHaveBeenCalledTimes(1);
    expect(band()).toBeNull();
    expect(tool("カラー").getAttribute("aria-current")).toBe("true");
    // マスクに入っていない間に道具を替えても、出る口は呼ばない
    await click(tool("ライト"));
    expect(leave).toHaveBeenCalledTimes(1);
  });

  it("hook がひとりでに出たら（写真を替えた・使えなくなった）、今の道具を既定に戻す", async () => {
    await render();
    await click(tool("マスク"));
    expect(band()).not.toBeNull();
    await act(async () => leaveFromOutside?.());
    expect(band()).toBeNull();
    expect(tool("マスク").getAttribute("aria-current")).toBeNull();
    expect(tool("ライト").getAttribute("aria-current")).toBe("true");
  });

  it("層を開いたときにマスクの道具に入っていれば（PC の幅から狭めた）、マスクの道具から始める", async () => {
    function Opened() {
      return (
        <BrowserPhotoEditingMobileEditor
          {...({
            photoKey: "photo-1",
            photo: <canvas />,
            statusLine: null,
            settings: neutralDevelopSettings(null),
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
            mask: { active: true, edited: true, disabled: false, enter, leave, band: <div data-testid="mask-band-content" /> },
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
          } satisfies MobileProps)}
        />
      );
    }
    await act(async () => {
      root.render(<Opened />);
    });
    expect(tool("マスク").getAttribute("aria-current")).toBe("true");
    expect(band()?.querySelector('[data-testid="mask-band-content"]')).not.toBeNull();
    expect(enter).not.toHaveBeenCalled();
  });

  it("写真を替えたら既定の道具に戻す。Esc はマスクの道具を出る（一覧へは戻らない）", async () => {
    const onBack = vi.fn();
    await render({ extra: { onBack } });
    await click(tool("マスク"));
    await render({ photoKey: "photo-2", extra: { onBack } });
    expect(tool("ライト").getAttribute("aria-current")).toBe("true");

    await click(tool("マスク"));
    const layer = document.body.querySelector<HTMLElement>('[role="region"]')!;
    await act(async () => {
      layer.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }));
    });
    expect(leave).toHaveBeenCalled();
    expect(onBack).not.toHaveBeenCalled();
    expect(band()).toBeNull();
  });

  it("マスクの間は写真の面の長押しで補正前にしない（指はつまみ・ブラシに使う）。ほかの道具では今までどおり", async () => {
    vi.useFakeTimers();
    await render();
    const surface = document.body.querySelector<HTMLElement>('[data-testid="photo-editing-mobile-photo"]')!;
    expect(surface.hasAttribute("data-photo-zoom-surface")).toBe(true);
    await click(tool("マスク"));
    await act(async () => {
      surface.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, pointerId: 1, isPrimary: true, clientX: 50, clientY: 50 }));
      vi.advanceTimersByTime(600);
    });
    expect(onCompareOriginalChange).not.toHaveBeenCalled();
    await act(async () => {
      surface.dispatchEvent(new PointerEvent("pointerup", { bubbles: true, pointerId: 1, clientX: 50, clientY: 50 }));
    });
    await click(tool("ライト"));
    await act(async () => {
      surface.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, pointerId: 2, isPrimary: true, clientX: 50, clientY: 50 }));
      vi.advanceTimersByTime(600);
    });
    expect(onCompareOriginalChange).toHaveBeenLastCalledWith(true);
  });
});

describe("usePhotoEditingZoom のピンチだけに数える面（ブラシ。niho-photo#93）", () => {
  function setBox(element: HTMLElement, box: { left: number; top: number; width: number; height: number }) {
    Object.defineProperty(element, "clientWidth", { configurable: true, value: box.width });
    Object.defineProperty(element, "clientHeight", { configurable: true, value: box.height });
    Object.defineProperty(element, "offsetWidth", { configurable: true, value: box.width });
    Object.defineProperty(element, "offsetHeight", { configurable: true, value: box.height });
    element.getBoundingClientRect = () =>
      ({ ...box, x: box.left, y: box.top, right: box.left + box.width, bottom: box.top + box.height, toJSON: () => box }) as DOMRect;
  }

  let onHold: ReturnType<typeof vi.fn<(holding: boolean) => void>>;

  function ZoomHarness() {
    const zoom = usePhotoEditingZoom({ photoKey: "photo", holdEnabled: true, onHoldChange: (holding) => onHold(holding) });
    return (
      <div
        ref={(surface) => {
          zoom.surfaceRef.current = surface;
          if (surface) setBox(surface, { left: 0, top: 0, width: 400, height: 600 });
        }}
        data-testid="zoom-surface"
        onPointerDown={zoom.onPointerDown}
        onPointerMove={zoom.onPointerMove}
        onPointerUp={zoom.onPointerUp}
        onPointerCancel={zoom.onPointerCancel}
      >
        <canvas
          ref={(canvas) => {
            if (!canvas) return;
            canvas.width = 900;
            canvas.height = 1200;
            setBox(canvas, { left: 0, top: 0, width: 400, height: 600 });
          }}
        />
        <div data-photo-zoom-pinch-only="" data-testid="brush" />
      </div>
    );
  }

  async function pointer(target: Element, type: string, pointerId: number, x: number, y: number, isPrimary = false) {
    await act(async () => {
      target.dispatchEvent(new PointerEvent(type, { bubbles: true, cancelable: true, pointerId, isPrimary, clientX: x, clientY: y }));
    });
  }

  it("その面の上の指 1 本は長押し・ダブルタップ・送りに使わず、2 本目の指でピンチの拡大に使う", async () => {
    vi.useFakeTimers();
    onHold = vi.fn<(holding: boolean) => void>();
    await act(async () => root.render(<ZoomHarness />));
    const surface = container.querySelector<HTMLElement>('[data-testid="zoom-surface"]')!;
    const brush = container.querySelector<HTMLElement>('[data-testid="brush"]')!;
    // 長押し
    await pointer(brush, "pointerdown", 1, 200, 300, true);
    await act(async () => {
      vi.advanceTimersByTime(600);
    });
    expect(onHold).not.toHaveBeenCalled();
    await pointer(brush, "pointerup", 1, 200, 300);
    // ダブルタップ
    await pointer(brush, "pointerdown", 2, 200, 300, true);
    await pointer(brush, "pointerup", 2, 200, 300);
    await pointer(brush, "pointerdown", 3, 200, 300, true);
    await pointer(brush, "pointerup", 3, 200, 300);
    expect(surface.style.getPropertyValue("--photo-editing-zoom")).toBe("");
    // ピンチ（1 本目はブラシの上、2 本目もブラシの上）で拡大する
    await pointer(brush, "pointerdown", 4, 150, 300, true);
    await pointer(brush, "pointerdown", 5, 250, 300);
    await pointer(brush, "pointermove", 5, 350, 300);
    expect(surface.style.getPropertyValue("--photo-editing-zoom")).toContain("scale(");
  });
});
