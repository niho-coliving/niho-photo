// @vitest-environment jsdom

import { act, useRef, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { neutralDevelopSettings } from "../develop-engine/develop-settings";
import { PHOTO_EDITING_ADVANCED_SECTIONS_STORAGE_KEY } from "../photo-editing-advanced-sections-state";
import type { PhotoEditingSettings } from "../photo-editing-types";

import { BrowserPhotoEditingAdjustments } from "./browser-photo-editing-adjustments";
import { BROWSER_EFFECTS_ADJUSTMENT_KEYS } from "./browser-photo-editing-model";
import type { PhotoEditingSliderPhase } from "./photo-editing-adjustment-controls";
import { PhotoEditingHslMixer, PhotoEditingHslMixerSection } from "./photo-editing-hsl-mixer";

/**
 * カラーミキサー（HSL。niho-photo#38）の中身と節。「調整」の切り替え（色相 / 彩度 / 輝度）で、8 色のスライダーに見せる軸を替える。
 * スライダーはドラッグの間 `drag`・離して `commit`、ダブルクリックで 0。節は既定で閉じ、見出しの横の「初期化」は 24 の値だけを戻す。
 * PC の右パネルでは、カラーの群の直後（効果の群の前）に節を置き、写真から色を拾う「ポイントカラー」をその下に並べる。
 */

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const BAND_LABELS = ["赤", "橙", "黄", "緑", "水色", "青", "紫", "マゼンタ"];

let container: HTMLDivElement;
let root: Root;
let changes: { settings: PhotoEditingSettings; phase: PhotoEditingSliderPhase }[];

type HarnessProps = { initial: PhotoEditingSettings; disabled?: boolean; section?: boolean; reset?: boolean };

/** 変更の通知を受けて設定を持ち替える画面（`update` は呼ばれた時点の最新に当てる）。 */
function Harness(props: HarnessProps) {
  const [settings, setSettings] = useState(props.initial);
  const settingsRef = useRef(props.initial);
  const mixerProps = {
    settings,
    disabled: props.disabled ?? false,
    onSettingsChange: (update: (current: PhotoEditingSettings) => PhotoEditingSettings, phase: PhotoEditingSliderPhase) => {
      const next = update(settingsRef.current);
      settingsRef.current = next;
      changes.push({ settings: next, phase });
      setSettings(next);
    },
  };
  return props.section ? (
    <PhotoEditingHslMixerSection {...mixerProps} />
  ) : (
    <PhotoEditingHslMixer {...mixerProps} reset={props.reset} />
  );
}

async function render(props: HarnessProps) {
  await act(async () => {
    root.render(<Harness {...props} />);
  });
}

function axisButton(label: string): HTMLButtonElement {
  const found = Array.from(
    container.querySelectorAll<HTMLButtonElement>('[role="group"][aria-label="調整"] button'),
  ).find((button) => button.textContent?.startsWith(label));
  if (!found) throw new Error(`axis button not found: ${label}`);
  return found;
}

function sliders(): HTMLInputElement[] {
  return Array.from(container.querySelectorAll<HTMLInputElement>('input[type="range"]'));
}

function slider(label: string): HTMLInputElement {
  const found = container.querySelector<HTMLInputElement>(`input[type="range"][aria-label="${label}"]`);
  if (!found) throw new Error(`slider not found: ${label}`);
  return found;
}

function resetButton(): HTMLButtonElement {
  const found = container.querySelector<HTMLButtonElement>('button[aria-label="カラーミキサーを初期化"]');
  if (!found) throw new Error("reset button not found");
  return found;
}

async function click(element: Element) {
  await act(async () => {
    element.dispatchEvent(new MouseEvent("click", { bubbles: true }));
  });
}

/** つまみをドラッグして `value` まで動かす（離すまでは drag）。 */
async function drag(input: HTMLInputElement, values: number[]) {
  await act(async () => {
    input.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, pointerId: 1 }));
  });
  for (const value of values) {
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set?.call(input, String(value));
      input.dispatchEvent(new Event("input", { bubbles: true }));
    });
  }
  await act(async () => {
    window.dispatchEvent(new PointerEvent("pointerup", { bubbles: true, pointerId: 1 }));
  });
}

beforeEach(() => {
  window.localStorage.clear();
  changes = [];
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.restoreAllMocks();
  window.localStorage.clear();
});

describe("PhotoEditingHslMixer", () => {
  it("「調整」の 3 択と、赤 → マゼンタの 8 本のスライダーを縦に並べる（既定は色相・値は 0）", async () => {
    await render({ initial: neutralDevelopSettings(null) });
    expect(axisButton("色相").getAttribute("aria-pressed")).toBe("true");
    expect(axisButton("彩度").getAttribute("aria-pressed")).toBe("false");
    expect(axisButton("輝度").getAttribute("aria-pressed")).toBe("false");
    // 押せる高さは 44px（見た目 32px に上下 6px を足す）
    expect(axisButton("色相").className).toContain("h-8");
    expect(axisButton("色相").className).toContain("after:-inset-y-1.5");
    expect(sliders().map((input) => input.getAttribute("aria-label"))).toEqual(BAND_LABELS);
    expect(sliders().every((input) => input.value === "0" && input.min === "-100" && input.max === "100")).toBe(true);
    expect(container.querySelector('[role="group"][aria-label="色相（8 色）"]')).not.toBeNull();
    // 色の名前は文字でも出す（色の丸は飾り）
    const label = container.querySelector(`label[for="${slider("青").id}"]`);
    expect(label?.textContent).toBe("青");
    expect(label?.querySelector("span[aria-hidden]")).not.toBeNull();
    // 線の色の帯（軸ごとの色）
    const band = slider("青").closest<HTMLElement>("[data-hsl-band]");
    expect(band?.style.getPropertyValue("--photo-editing-hsl-track")).toContain("linear-gradient");
    expect(slider("青").className).toContain("bg-[image:var(--photo-editing-hsl-track)]");
  });

  it("3 択を替えると、8 本のスライダーにその軸の値を出す。0 でない軸には「調整あり」の印", async () => {
    await render({
      initial: {
        ...neutralDevelopSettings(null),
        hsl: ["orange", { hue: 6, saturation: -12, luminance: 8 }, "blue", { hue: -10, saturation: -100, luminance: 0 }],
      },
    });
    expect(slider("橙").value).toBe("6");
    expect(slider("青").value).toBe("-10");
    const hueTrack = slider("青").closest<HTMLElement>("[data-hsl-band]")?.style.getPropertyValue("--photo-editing-hsl-track");
    await click(axisButton("彩度"));
    expect(axisButton("彩度").getAttribute("aria-pressed")).toBe("true");
    expect(axisButton("色相").getAttribute("aria-pressed")).toBe("false");
    expect(slider("橙").value).toBe("-12");
    expect(slider("青").value).toBe("-100");
    expect(slider("赤").value).toBe("0");
    expect(container.querySelector('[role="group"][aria-label="彩度（8 色）"]')).not.toBeNull();
    expect(slider("青").closest<HTMLElement>("[data-hsl-band]")?.style.getPropertyValue("--photo-editing-hsl-track")).not.toBe(
      hueTrack,
    );
    await click(axisButton("輝度"));
    expect(slider("橙").value).toBe("8");
    expect(slider("青").value).toBe("0");
    // 色相・彩度・輝度とも 0 でない色があるので、3 つとも印。値を出す文字は符号つき
    expect(container.querySelectorAll('[data-testid="photo-hsl-axis-edited"]')).toHaveLength(3);
    expect(axisButton("輝度").textContent).toContain("調整あり");
    expect(container.querySelector('button[aria-label="橙の値 +8 を入力"]')).not.toBeNull();
    expect(container.querySelector('button[aria-label="青の値 0 を入力"]')).not.toBeNull();
    // 切り替えは値を変えない
    expect(changes).toEqual([]);
  });

  it("ドラッグの間は drag、離したら commit。書いた値は developSettings.hsl に入る", async () => {
    await render({ initial: neutralDevelopSettings(null) });
    await click(axisButton("彩度"));
    await drag(slider("青"), [-40, -100]);
    expect(changes.map((change) => change.phase)).toEqual(["drag", "drag", "commit"]);
    const last = changes.at(-1)?.settings;
    expect(last?.hsl).toEqual(["blue", { hue: 0, saturation: -100, luminance: 0 }]);
    expect(slider("青").value).toBe("-100");
    // 変更ありの目印（値の太字）と、軸の印
    expect(container.querySelectorAll('[data-testid="photo-hsl-axis-edited"]')).toHaveLength(1);
    expect(axisButton("彩度").querySelector('[data-testid="photo-hsl-axis-edited"]')).not.toBeNull();
  });

  it("ダブルクリックでその色のその軸だけを 0 に戻す（commit）。全部 0 なら hsl ごと消す", async () => {
    await render({
      initial: { ...neutralDevelopSettings(null), hsl: ["blue", { hue: 12, saturation: -50, luminance: 0 }] },
    });
    await act(async () => {
      slider("青").dispatchEvent(new MouseEvent("dblclick", { bubbles: true }));
    });
    expect(changes.map((change) => change.phase)).toEqual(["commit"]);
    expect(changes[0]?.settings.hsl).toEqual(["blue", { hue: 0, saturation: -50, luminance: 0 }]);
    await click(axisButton("彩度"));
    await act(async () => {
      slider("青").dispatchEvent(new MouseEvent("dblclick", { bubbles: true }));
    });
    expect("hsl" in (changes.at(-1)?.settings ?? {})).toBe(false);
  });

  it("押せない間はスライダーと「初期化」を押せない（「調整」の切り替えは見るだけなので押せる）", async () => {
    await render({
      initial: { ...neutralDevelopSettings(null), hsl: ["blue", { saturation: -50 }] },
      disabled: true,
      reset: true,
    });
    expect(sliders().every((input) => input.disabled)).toBe(true);
    expect(resetButton().disabled).toBe(true);
    expect(axisButton("彩度").disabled).toBe(false);
    await click(axisButton("彩度"));
    expect(slider("青").value).toBe("-50");
    expect(changes).toEqual([]);
  });

  it("`reset` を渡した面（スマホの道具）は、切り替えの右に「初期化」を置く。全部 0 なら押せない", async () => {
    await render({ initial: neutralDevelopSettings(null), reset: true });
    expect(resetButton().disabled).toBe(true);
    await drag(slider("赤"), [30]);
    expect(resetButton().disabled).toBe(false);
    await click(resetButton());
    expect(changes.at(-1)?.phase).toBe("commit");
    expect("hsl" in (changes.at(-1)?.settings ?? {})).toBe(false);
    expect(resetButton().disabled).toBe(true);
  });
});

describe("PhotoEditingHslMixerSection（カラーの群の下の節）", () => {
  function toggle(): HTMLButtonElement {
    const found = container.querySelector<HTMLButtonElement>("h4 button");
    if (!found) throw new Error("section toggle not found");
    return found;
  }

  it("既定は閉じる（中身を描かない）。見出しの横の「初期化」は閉じていても出す", async () => {
    await render({ initial: { ...neutralDevelopSettings(null), hsl: ["blue", { saturation: -50 }] }, section: true });
    expect(toggle().textContent).toBe("カラーミキサー");
    expect(toggle().getAttribute("aria-expanded")).toBe("false");
    expect(container.querySelector('[data-testid="photo-hsl-mixer"]')).toBeNull();
    expect(resetButton().disabled).toBe(false);
    expect(resetButton().textContent).toBe("初期化");
  });

  it("開くと中身を描き、開いたことを端末に覚える（描き直しても開いたまま）", async () => {
    await render({ initial: neutralDevelopSettings(null), section: true });
    await click(toggle());
    expect(container.querySelector('[data-testid="photo-hsl-mixer"]')).not.toBeNull();
    expect(window.localStorage.getItem(PHOTO_EDITING_ADVANCED_SECTIONS_STORAGE_KEY)).toBe('["colorMixer"]');
    act(() => root.unmount());
    root = createRoot(container);
    await render({ initial: neutralDevelopSettings(null), section: true });
    expect(toggle().getAttribute("aria-expanded")).toBe("true");
    expect(sliders()).toHaveLength(8);
  });

  it("「初期化」は 24 の値だけを 0 に戻して commit する（ほかの補正は残す）。全部 0 なら押せない", async () => {
    await render({
      initial: {
        ...neutralDevelopSettings(null),
        exposure: 0.5,
        hsl: ["red", { hue: 10 }, "blue", { saturation: -100 }],
      },
      section: true,
    });
    await click(resetButton());
    expect(changes).toHaveLength(1);
    expect(changes[0]?.phase).toBe("commit");
    expect("hsl" in (changes[0]?.settings ?? {})).toBe(false);
    expect(changes[0]?.settings.exposure).toBe(0.5);
    expect(resetButton().disabled).toBe(true);
  });
});

describe("BrowserPhotoEditingAdjustments のカラーの下", () => {
  it("カラーの群の直後にカラーミキサーの節、その下にポイントカラー、その後に効果の群", async () => {
    const props = {
      canEdit: true,
      canReset: false,
      resetDone: false,
      canUndo: false,
      canRedo: false,
      controlsDisabled: false,
      busy: false,
      work: null,
      raw: false,
      settings: neutralDevelopSettings(),
      visibleKeys: BROWSER_EFFECTS_ADJUSTMENT_KEYS,
      afterGroup: { color: <section data-testid="hsl-section" /> },
      colorMixer: <section data-testid="point-color" />,
      onReset: vi.fn(),
      onUndo: vi.fn(),
      onRedo: vi.fn(),
      onRetryWork: vi.fn(),
      onSettingsChange: vi.fn(),
    };
    await act(async () => {
      root.render(<BrowserPhotoEditingAdjustments {...props} />);
    });
    const hsl = container.querySelector('[data-testid="hsl-section"]');
    expect(hsl?.previousElementSibling?.querySelector("h4")?.textContent).toBe("カラー");
    expect(hsl?.nextElementSibling?.getAttribute("data-testid")).toBe("point-color");
    expect(hsl?.nextElementSibling?.nextElementSibling?.querySelector("h4")?.textContent).toBe("効果");
    // 群の後ろ（パネルの末尾）には、もう置かない
    expect(container.querySelectorAll('[data-testid="point-color"]')).toHaveLength(1);

    // カラーミキサーの節を渡さない面（狭い幅など）でも、ポイントカラーはカラーの群の直後
    await act(async () => {
      root.render(<BrowserPhotoEditingAdjustments {...props} afterGroup={undefined} />);
    });
    const point = container.querySelector('[data-testid="point-color"]');
    expect(point?.previousElementSibling?.querySelector("h4")?.textContent).toBe("カラー");
    expect(point?.nextElementSibling?.querySelector("h4")?.textContent).toBe("効果");
  });
});
