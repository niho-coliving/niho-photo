// @vitest-environment jsdom

import { act, useRef, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { neutralDevelopSettings } from "../develop-engine/develop-settings";
import type { PhotoEditingSettings } from "../photo-editing-types";

import { BrowserPhotoEditingMobileEditor } from "./browser-photo-editing-mobile-editor";
import type { PhotoEditingSliderPhase } from "./photo-editing-adjustment-controls";
import { PhotoEditingHslMixer } from "./photo-editing-hsl-mixer";

/**
 * スマホの 1 枚の編集の層の「カラーミキサー」（HSL。niho-photo#38）。道具の帯の補正の群の後ろに「カラーミキサー」→「ポイントカラー」
 * （写真から色を拾う Oklch の補正）の順で出し、カラーミキサーの段には PC と同じ「調整」の切り替えと 8 本のスライダーを縦に並べる
 * （段の高さを超える分は段の中で送る）。道具が多くて帯に収まらない幅は、帯を横に送る。
 */

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

type MobileProps = Parameters<typeof BrowserPhotoEditingMobileEditor>[0];

let container: HTMLDivElement;
let root: Root;
let changes: { settings: PhotoEditingSettings; phase: PhotoEditingSliderPhase }[];

function Harness(props: { initial: PhotoEditingSettings; hsl?: boolean; pointColor?: boolean; extra?: Partial<MobileProps> }) {
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
    hslMixer: props.hsl ? (
      <PhotoEditingHslMixer reset settings={settings} disabled={false} onSettingsChange={onSettingsChange} />
    ) : undefined,
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
    ...props.extra,
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

async function click(element: Element) {
  await act(async () => {
    element.dispatchEvent(new MouseEvent("click", { bubbles: true }));
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

describe("BrowserPhotoEditingMobileEditor のカラーミキサー", () => {
  it("渡さない間は道具を出さない（帯は今までどおり）", async () => {
    await render({ initial: neutralDevelopSettings(null) });
    expect(toolNames()).toEqual(["ライト", "カラー", "効果"]);
  });

  it("補正の群の後ろに「カラーミキサー」→「ポイントカラー」の順で出す。帯は収まらない幅で横に送れる", async () => {
    await render({ initial: neutralDevelopSettings(null), hsl: true, pointColor: true });
    expect(toolNames()).toEqual(["ライト", "カラー", "効果", "カラーミキサー", "ポイントカラー"]);
    expect(toolStrip().className).toContain("overflow-x-auto");
    expect(tool("カラーミキサー").className).toContain("shrink-0");
    expect(tool("カラーミキサー").querySelector("svg")).not.toBeNull();
  });

  it("カラーミキサーを選ぶと、段に「調整」の切り替えと 8 本のスライダーを縦に出し、値を直せる", async () => {
    await render({ initial: neutralDevelopSettings(null), hsl: true, pointColor: true });
    expect(document.body.querySelector('[data-testid="photo-hsl-mixer"]')).toBeNull();
    await click(tool("カラーミキサー"));
    expect(tool("カラーミキサー").getAttribute("aria-current")).toBe("true");
    const band = document.body.querySelector<HTMLElement>('[data-testid="photo-editing-mobile-hsl"]');
    expect(band).not.toBeNull();
    // 段の高さに収まらない分は段の中で送る
    expect(band?.className).toContain("max-h-[17rem]");
    expect(band?.className).toContain("overflow-y-auto");
    const inputs = Array.from(band?.querySelectorAll<HTMLInputElement>('input[type="range"]') ?? []);
    expect(inputs.map((input) => input.getAttribute("aria-label"))).toEqual(["赤", "橙", "黄", "緑", "水色", "青", "紫", "マゼンタ"]);
    // ポイントカラーの中身は出さない（道具ごとに 1 つ）
    expect(document.body.querySelector('[data-testid="point-color"]')).toBeNull();

    const saturation = Array.from(band?.querySelectorAll<HTMLButtonElement>('[aria-label="調整"] button') ?? []).find((button) =>
      button.textContent?.startsWith("彩度"),
    );
    if (!saturation) throw new Error("saturation switch not found");
    await click(saturation);
    const blue = band?.querySelector<HTMLInputElement>('input[type="range"][aria-label="青"]');
    if (!blue) throw new Error("blue slider not found");
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set?.call(blue, "-100");
      blue.dispatchEvent(new Event("input", { bubbles: true }));
      blue.dispatchEvent(new Event("change", { bubbles: true }));
    });
    expect(changes.map((change) => change.phase)).toEqual(["input", "commit"]);
    expect(changes.at(-1)?.settings.hsl).toEqual(["blue", { hue: 0, saturation: -100, luminance: 0 }]);
    // 調整が入ったカラーミキサーの道具には点を添える（プリセット・自動と同じ）
    expect(tool("カラーミキサー").querySelector("span.rounded-full.bg-niho-text:not(.bottom-1)")).not.toBeNull();

    // ポイントカラーへ切り替えると、その中身を出す
    await click(tool("ポイントカラー"));
    expect(document.body.querySelector('[data-testid="photo-editing-mobile-hsl"]')).toBeNull();
    expect(document.body.querySelector('[data-testid="point-color"]')).not.toBeNull();
  });
});
