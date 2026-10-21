// @vitest-environment jsdom

import { act, useRef, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { neutralDevelopSettings } from "../develop-engine/develop-settings";
import type { PhotoEditingSettings } from "../photo-editing-types";

import { browserAdjustmentKeys, browserMobileAdjustmentKeys } from "./browser-photo-editing-model";
import { BrowserPhotoEditingMobileEditor } from "./browser-photo-editing-mobile-editor";
import type { PhotoEditingSliderPhase } from "./photo-editing-adjustment-controls";

/**
 * スマホの 1 枚の編集の層の「ディテール」（シャープ・ノイズ軽減。niho-photo#86）。応用の道具なので、道具の帯の末尾（カラーミキサー・
 * ポイントカラー・切り抜きの後ろ）に置く。項目はよく使う 3 つ（シャープ → ノイズ軽減 → カラーノイズの軽減）が先、シャープの応用の
 * 3 つ（半径 → 細部 → マスク）が後ろ。PC の右パネルと同じく、v6 を読めると確かめた wasm の写真にだけ出す。
 */

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

type MobileProps = Parameters<typeof BrowserPhotoEditingMobileEditor>[0];

let container: HTMLDivElement;
let root: Root;
let changes: { settings: PhotoEditingSettings; phase: PhotoEditingSliderPhase }[];

function Harness(props: { initial: PhotoEditingSettings; detail?: boolean; pointColor?: boolean }) {
  const [settings, setSettings] = useState(props.initial);
  const settingsRef = useRef(props.initial);
  const onSettingsChange = (update: (current: PhotoEditingSettings) => PhotoEditingSettings, phase: PhotoEditingSliderPhase) => {
    const next = update(settingsRef.current);
    settingsRef.current = next;
    changes.push({ settings: next, phase });
    setSettings(next);
  };
  const mobileProps: MobileProps = {
    photoKey: "photo-1",
    photo: <canvas aria-label="photo-1.jpg のプレビュー" />,
    statusLine: null,
    settings,
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
    colorMixer: props.pointColor ? <section data-testid="point-color">ポイントカラーの中身</section> : undefined,
    visibleKeys: browserMobileAdjustmentKeys({ detail: props.detail ?? false }),
    onBack: () => undefined,
    onUndo: () => undefined,
    onRedo: () => undefined,
    onReset: () => undefined,
    onRetryWork: () => undefined,
    onSettingsChange,
    onCompareOriginalChange: () => undefined,
    onExport: async () => ({ kind: "cancelled" }) as never,
    onSharePending: async () => ({ kind: "cancelled" }) as never,
    onExportSheetClosed: () => undefined,
  };
  return <BrowserPhotoEditingMobileEditor {...mobileProps} />;
}

async function render(props: Parameters<typeof Harness>[0]) {
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

function items(): HTMLButtonElement[] {
  const strip = document.body.querySelector<HTMLElement>('[role="toolbar"][aria-label="ディテールの項目"]');
  if (!strip) throw new Error("detail items not found");
  return Array.from(strip.querySelectorAll<HTMLButtonElement>("button"));
}

function ruler(): HTMLElement {
  const found = document.body.querySelector<HTMLElement>('[role="slider"]');
  if (!found) throw new Error("ruler not found");
  return found;
}

async function click(element: Element) {
  await act(async () => {
    element.dispatchEvent(new MouseEvent("click", { bubbles: true }));
  });
}

async function press(element: Element, key: string) {
  await act(async () => {
    element.dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true }));
  });
}

beforeEach(() => {
  changes = [];
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

describe("BrowserPhotoEditingMobileEditor のディテール", () => {
  it("v6 を読めると確かめていない写真には出さない（帯は今までどおり）", async () => {
    await render({ initial: neutralDevelopSettings(null) });
    expect(toolNames()).toEqual(["ライト", "カラー", "効果"]);
  });

  it("帯の末尾（ポイントカラーの後ろ）に出し、項目はよく使う 3 つが先・シャープの応用の 3 つが後ろ", async () => {
    await render({ initial: neutralDevelopSettings(null), detail: true, pointColor: true });
    expect(toolNames()).toEqual(["ライト", "カラー", "効果", "ポイントカラー", "ディテール"]);
    expect(tool("ディテール").querySelector("svg")).not.toBeNull();

    await click(tool("ディテール"));
    expect(tool("ディテール").getAttribute("aria-current")).toBe("true");
    expect(items().map((button) => button.textContent)).toEqual([
      "シャープ",
      "ノイズ軽減",
      "カラーノイズの軽減",
      "シャープの半径",
      "シャープの細部",
      "シャープのマスク",
    ]);
    // 内部の名前は見せない
    expect(document.body.textContent).not.toMatch(/sharpen|luminanceNoise|colorNoise/);
  });

  it("シャープを動かすと detail を書き、シャープが 0 の間は応用の 3 つを動かせない", async () => {
    await render({ initial: neutralDevelopSettings(null), detail: true });
    await click(tool("ディテール"));
    // 既定はシャープ
    expect(items()[0]?.getAttribute("aria-pressed")).toBe("true");

    // シャープが 0 の間は半径を選んでも目盛りは押せない
    await click(items()[3] as HTMLButtonElement);
    expect(ruler().getAttribute("aria-disabled")).toBe("true");

    await click(items()[0] as HTMLButtonElement);
    await press(ruler(), "ArrowRight");
    expect(changes.at(-1)?.phase).toBe("commit");
    expect(changes.at(-1)?.settings.detail).toEqual({
      sharpening: { amount: 1, radius: 1, detail: 25, masking: 0 },
      luminanceNoiseReduction: 0,
    });

    // シャープが 0 でなくなると半径を動かせる
    await click(items()[3] as HTMLButtonElement);
    expect(ruler().getAttribute("aria-disabled")).not.toBe("true");
  });

  it("スマホのキーはディテールだけを足す（効果はスライダー以外の部品が要るので PC だけ）", () => {
    expect(browserMobileAdjustmentKeys({ detail: false })).toBeUndefined();
    const keys = browserMobileAdjustmentKeys({ detail: true }) ?? [];
    expect(keys).toEqual(expect.arrayContaining(["sharpenAmount", "luminanceNoiseReduction", "colorNoiseReduction"]));
    expect(keys).not.toContain("grayscale");
    expect(keys).not.toContain("vignetteAmount");
    // PC は効果とディテールの両方
    expect(browserAdjustmentKeys({ effects: true, detail: true })).toEqual(
      expect.arrayContaining(["grayscale", "sharpenAmount"]),
    );
  });
});
