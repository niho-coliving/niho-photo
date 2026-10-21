// @vitest-environment jsdom

import { act, useRef, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { BrowserPhotoEditingLoupe } from "./browser-photo-editing-loupe";
import {
  developSettingsVersion,
  readDevelopColorPoints,
  readDevelopSettings,
  type DevelopSettings,
} from "../develop-engine/develop-settings";
import { photoEditingPresetNotWrittenError } from "../photo-editing-copy";
import type { PhotoEditingSettings } from "../photo-editing-types";

import {
  appendDevelopColorPoint,
  canvasNormalizedPoint,
  colorPickIsCurrent,
  commitColorPickIfCurrent,
  PhotoEditingColorMixer,
} from "./photo-editing-color-mixer";
import type { PhotoEditingSliderPhase } from "./photo-editing-slider";

const target = { lightness: 0.72, chroma: 0.08, hue: 50 };
const base: DevelopSettings = { v: 1, engine: "niho-10", look: "niho-standard-1" };

describe("color point schema and picker", () => {
  it("canvas の CSS 表示座標を zoom や buffer サイズに依らない正規化座標へ換算する", () => {
    const canvas = {
      getBoundingClientRect: () => ({ left: 10, top: 20, width: 200, height: 100 }) as DOMRect,
    };
    expect(canvasNormalizedPoint(canvas, 110, 70)).toEqual({ x: 0.5, y: 0.5 });
    expect(canvasNormalizedPoint(canvas, 9, 70)).toBeNull();
  });

  it("点を足すと v4、8点で止まり、空・壊れた形・v不足・未知版を fail-closed にする", () => {
    const one = appendDevelopColorPoint(base, target, "skin");
    expect(one.v).toBe(4);
    expect(readDevelopSettings(one)).toEqual(one);
    expect(developSettingsVersion({ ...one, colorPoints: [] })).toBe(1);
    expect(readDevelopSettings({ ...one, v: 3 })).toBeNull();
    expect(readDevelopSettings({ ...one, v: 5 })).toBeNull();
    expect(readDevelopSettings({ ...one, colorPoints: [{ ...(one.colorPoints as object[])[0], unknown: true }] })).toBeNull();
    expect(readDevelopSettings({ ...one, colorPoints: [{ ...(one.colorPoints as object[])[0], target: { ...target, hue: Number.NaN } }] })).toBeNull();
    let eight = base;
    for (let index = 0; index < 8; index += 1) eight = appendDevelopColorPoint(eight, target, `p${index}`);
    expect(readDevelopColorPoints(eight.colorPoints)).toHaveLength(8);
    expect(appendDevelopColorPoint(eight, target, "ninth")).toBe(eight);
    expect(appendDevelopColorPoint(base, { ...target, lightness: -0.1 }, "hdr")).toBe(base);
    expect(appendDevelopColorPoint(base, { ...target, chroma: 5.1 }, "wide")).toBe(base);
    expect(photoEditingPresetNotWrittenError(["colorPoints"])).toContain("ポイントカラー");
  });

  it("非同期採取中に写真・設定・compare状態が変わった結果は確定しない", () => {
    const snapshot = { generation: 4, photoKey: "photo-a", settingsJson: '{"v":4}' };
    expect(colorPickIsCurrent(snapshot, { ...snapshot, blocked: false })).toBe(true);
    expect(colorPickIsCurrent(snapshot, { ...snapshot, photoKey: "photo-b", blocked: false })).toBe(false);
    expect(colorPickIsCurrent(snapshot, { ...snapshot, settingsJson: '{"v":4,"exposure":1}', blocked: false })).toBe(false);
    expect(colorPickIsCurrent(snapshot, { ...snapshot, blocked: true })).toBe(false);
  });

  it("deferred sample の完了時は呼出時closureでなく最新の写真contextを読む", async () => {
    let resolveSample: ((value: typeof target) => void) | undefined;
    const sample = new Promise<typeof target>((resolve) => { resolveSample = resolve; });
    const snapshot = { generation: 4, photoKey: "photo-a", settingsJson: '{"v":4}' };
    let current = { ...snapshot, blocked: false };
    const commit = vi.fn();
    const pending = commitColorPickIfCurrent({ sample, snapshot, current: () => current, commit });
    current = { ...current, generation: 5, photoKey: "photo-b" };
    resolveSample?.(target);
    await expect(pending).resolves.toBe(false);
    expect(commit).not.toHaveBeenCalled();
  });
});

describe("PhotoEditingColorMixer desktop/mobile common UI", () => {
  let container: HTMLDivElement;
  let root: Root;
  let changes: { before: PhotoEditingSettings; after: PhotoEditingSettings; phase: PhotoEditingSliderPhase }[];

  function Harness({ initial }: { initial: DevelopSettings }) {
    const [settings, setSettings] = useState<PhotoEditingSettings>(initial);
    const ref = useRef(settings);
    return (
      <PhotoEditingColorMixer
        compact
        settings={settings as DevelopSettings}
        disabled={false}
        picking={false}
        pickError={null}
        onPickStart={() => undefined}
        onPickCancel={() => undefined}
        onSettingsChange={(update, phase) => {
          const before = ref.current;
          const after = update(before);
          changes.push({ before, after, phase });
          ref.current = after;
          setSettings(after);
        }}
      />
    );
  }

  beforeEach(() => {
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    changes = [];
    container = document.createElement("div");
    container.style.width = "320px";
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
  });

  it("320px の共通 UI に見出し・カード・6本・削除/初期化を出し、更新を履歴用 phase で返す", () => {
    const initial = appendDevelopColorPoint(base, target, "skin");
    act(() => root.render(<Harness initial={initial} />));
    expect(container.textContent).toContain("ポイントカラー");
    expect(container.querySelectorAll('input[type="range"]')).toHaveLength(6);
    expect(container.querySelector('button[aria-label="色 1 を初期化"]')?.className).toContain("h-6");
    expect(container.querySelector('button[aria-label="色 1 を削除"]')?.className).toContain("h-6");
    const hue = container.querySelector<HTMLInputElement>('input[aria-label="色相"]');
    expect(hue).not.toBeNull();
    act(() => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set?.call(hue, "20");
      hue?.dispatchEvent(new Event("input", { bubbles: true }));
      hue?.dispatchEvent(new Event("change", { bubbles: true }));
    });
    expect(changes.map((change) => change.phase)).toEqual(["input", "commit"]);
    expect(changes[0]?.before).toBe(initial);
    expect(changes[0]?.after).not.toBe(initial);
  });

  it("8点では色を拾う操作を無効にする", () => {
    let settings = base;
    for (let index = 0; index < 8; index += 1) settings = appendDevelopColorPoint(settings, target, `p${index}`);
    act(() => root.render(<Harness initial={settings} />));
    const pick = Array.from(container.querySelectorAll("button")).find((button) => button.textContent?.includes("色を拾う"));
    expect(pick?.disabled).toBe(true);
  });

  it("picker はキーボードで中央を確定し、Esc で取消できる", () => {
    let picked = 0;
    let cancelled = 0;
    let moved = { x: 0.5, y: 0.5 };
    function PickerHarness() {
      const canvasRef = useRef<HTMLCanvasElement | null>(null);
      return (
        <BrowserPhotoEditingLoupe
          opened={{
            key: "photo-1",
            fileName: "photo.jpg",
            decoded: null,
            viewUrl: null,
            lockedReason: null,
            loadedForEditing: true,
            mode: "wasm",
            input: null,
            work: null,
            photo: null,
          }}
          opening={false}
          openedVisible
          compareOriginal={false}
          presetPreviewName={null}
          canvasRef={canvasRef}
          colorPicker={{
            active: true,
            position: moved,
            onMove: (position) => { moved = position; },
            onPick: () => { picked += 1; },
            onCancel: () => { cancelled += 1; },
          }}
          lockedReason={null}
          sourceError={null}
          onReload={null}
        />
      );
    }
    act(() => root.render(<PickerHarness />));
    const canvas = container.querySelector("canvas");
    if (!canvas) throw new Error("picker canvas missing");
    canvas.width = 1000;
    canvas.height = 500;
    act(() => canvas?.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowRight", bubbles: true })));
    expect(moved.x).toBeCloseTo(0.501);
    act(() => root.render(<PickerHarness />));
    act(() => canvas.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowDown", shiftKey: true, bubbles: true })));
    expect(moved.y).toBeCloseTo(0.52);
    act(() => canvas?.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true })));
    act(() => canvas?.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })));
    expect(picked).toBe(1);
    expect(cancelled).toBe(1);
    expect(moved.x).toBeCloseTo(0.501);
  });
});
