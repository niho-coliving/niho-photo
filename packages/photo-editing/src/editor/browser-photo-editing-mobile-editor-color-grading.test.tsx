// @vitest-environment jsdom

import { act, useRef, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { neutralDevelopSettings } from "../develop-engine/develop-settings";
import type { PhotoEditingSettings } from "../photo-editing-types";

import { BrowserPhotoEditingMobileEditor } from "./browser-photo-editing-mobile-editor";
import type { PhotoEditingSliderPhase } from "./photo-editing-adjustment-controls";
import { PhotoEditingColorGrading } from "./photo-editing-color-grading";

/**
 * スマホの 1 枚の編集の層の「カラーグレーディング」（niho-photo#39）。道具の帯の「カラーミキサー」の後ろ・「ポイントカラー」の前に出し、
 * 段には PC と同じ帯の 4 択・色相環（少し小さく）・スライダーを縦に並べる（段の高さを超える分は段の中で送る）。
 */

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

type MobileProps = Parameters<typeof BrowserPhotoEditingMobileEditor>[0];

let container: HTMLDivElement;
let root: Root;
let changes: { settings: PhotoEditingSettings; phase: PhotoEditingSliderPhase }[];

function Harness(props: { initial: PhotoEditingSettings; grading?: boolean }) {
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
    hslMixer: <section data-testid="hsl-mixer">カラーミキサーの中身</section>,
    colorMixer: <section data-testid="point-color">ポイントカラーの中身</section>,
    colorGrading: props.grading ? (
      <PhotoEditingColorGrading reset compact settings={settings} disabled={false} onSettingsChange={onSettingsChange} />
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

/** 道具の点（現在地の下線ではない丸）。 */
function toolDot(name: string): Element | null {
  return tool(name).querySelector("span.rounded-full.bg-niho-text:not(.bottom-1)");
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

describe("BrowserPhotoEditingMobileEditor のカラーグレーディング", () => {
  it("渡さない間は道具を出さない", async () => {
    await render({ initial: neutralDevelopSettings(null) });
    expect(toolNames()).toEqual(["ライト", "カラー", "効果", "カラーミキサー", "ポイントカラー"]);
  });

  it("「カラーミキサー」→「カラーグレーディング」→「ポイントカラー」の順に出す（帯は横に送れる）", async () => {
    await render({ initial: neutralDevelopSettings(null), grading: true });
    expect(toolNames()).toEqual(["ライト", "カラー", "効果", "カラーミキサー", "カラーグレーディング", "ポイントカラー"]);
    expect(toolStrip().className).toContain("overflow-x-auto");
    expect(tool("カラーグレーディング").querySelector("svg")).not.toBeNull();
    expect(toolDot("カラーグレーディング")).toBeNull();
  });

  it("選ぶと段に 4 択・色相環・スライダーを出し、値を直せる。調整が入ると道具に点", async () => {
    await render({ initial: neutralDevelopSettings(null), grading: true });
    expect(document.body.querySelector('[data-testid="photo-color-grading"]')).toBeNull();
    await click(tool("カラーグレーディング"));
    expect(tool("カラーグレーディング").getAttribute("aria-current")).toBe("true");
    const band = document.body.querySelector<HTMLElement>('[data-testid="photo-editing-mobile-color-grading"]');
    expect(band).not.toBeNull();
    expect(band?.className).toContain("max-h-[17rem]");
    expect(band?.className).toContain("overflow-y-auto");
    expect(band?.querySelector('[data-testid="photo-color-wheel"]')).not.toBeNull();
    // 段の中では環を少し小さくする
    expect(band?.querySelector('[data-testid="photo-color-wheel"]')?.parentElement?.className).toContain("max-w-[9.5rem]");
    expect(band?.querySelector('button[aria-label="カラーグレーディングを初期化"]')).not.toBeNull();
    // ほかの道具の中身は出さない
    expect(document.body.querySelector('[data-testid="hsl-mixer"]')).toBeNull();
    expect(document.body.querySelector('[data-testid="point-color"]')).toBeNull();

    const zone = Array.from(band?.querySelectorAll<HTMLButtonElement>('[aria-label="明るさの帯"] button') ?? []).find((button) =>
      button.textContent?.startsWith("全体"),
    );
    if (!zone) throw new Error("global zone not found");
    await click(zone);
    const luminance = band?.querySelector<HTMLInputElement>('input[type="range"][aria-label="輝度"]');
    if (!luminance) throw new Error("luminance slider not found");
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set?.call(luminance, "-30");
      luminance.dispatchEvent(new Event("input", { bubbles: true }));
      luminance.dispatchEvent(new Event("change", { bubbles: true }));
    });
    expect(changes.map((change) => change.phase)).toEqual(["input", "commit"]);
    expect(changes.at(-1)?.settings.colorGrading).toEqual({ global: { hue: 0, saturation: 0, luminance: -30 } });
    expect(toolDot("カラーグレーディング")).not.toBeNull();

    // ポイントカラーへ切り替えると、その中身を出す
    await click(tool("ポイントカラー"));
    expect(document.body.querySelector('[data-testid="photo-editing-mobile-color-grading"]')).toBeNull();
    expect(document.body.querySelector('[data-testid="point-color"]')).not.toBeNull();
  });
});
