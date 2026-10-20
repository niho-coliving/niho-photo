// @vitest-environment jsdom

import { act, useRef, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { PhotoEditingSettings } from "../photo-editing-types";
import { neutralDevelopSettings, type DevelopSettings } from "../develop-engine/develop-settings";
import {
  PHOTO_EDITING_BASE_CONTROL_KEYS,
  type PhotoEditingControlKey,
} from "../photo-editing-adjustments";
import { PHOTO_EDITING_EFFECT_KEYS } from "../photo-editing-effects";

import { PhotoEditingAdjustmentGroups, type PhotoEditingSliderPhase } from "./photo-editing-adjustment-controls";

/**
 * 共通の補正パネルの効果の項目（白黒・周辺光量補正・粒子・粒子のサイズ。NIHO Photo 段 1 E1b 移行元設計）。`visibleKeys` に入れた面に
 * だけ出る（省いた面＝NIHO Desktop には出ない）。
 */

const EFFECT_KEYS: PhotoEditingControlKey[] = [...PHOTO_EDITING_BASE_CONTROL_KEYS, ...PHOTO_EDITING_EFFECT_KEYS];
const NEUTRAL: DevelopSettings = neutralDevelopSettings();

let container: HTMLDivElement;
let root: Root;
let changes: { settings: PhotoEditingSettings; phase: PhotoEditingSliderPhase }[];

function Harness(props: { initial: PhotoEditingSettings | null; visibleKeys?: PhotoEditingControlKey[]; disabled?: boolean }) {
  const [settings, setSettings] = useState<PhotoEditingSettings | null>(props.initial);
  const settingsRef = useRef<PhotoEditingSettings>(props.initial ?? {});
  return (
    <PhotoEditingAdjustmentGroups
      settings={settings}
      photo={{ asShotWhiteBalance: null }}
      disabled={props.disabled ?? false}
      visibleKeys={props.visibleKeys}
      onSettingsChange={(update, phase) => {
        const next = update(settingsRef.current);
        settingsRef.current = next;
        changes.push({ settings: next, phase });
        setSettings(next);
      }}
    />
  );
}

async function render(props: Parameters<typeof Harness>[0]) {
  await act(async () => {
    root.render(<Harness {...props} />);
  });
}

function sliderLabels(): string[] {
  return Array.from(container.querySelectorAll<HTMLInputElement>('input[type="range"]')).map(
    (input) => input.getAttribute("aria-label") ?? "",
  );
}

function slider(label: string): HTMLInputElement {
  const input = container.querySelector<HTMLInputElement>(`input[type="range"][aria-label="${label}"]`);
  if (!input) throw new Error(`slider not found: ${label}`);
  return input;
}

function valueButton(label: string): HTMLButtonElement {
  const button = container.querySelector<HTMLButtonElement>(`button[aria-label^="${label}の値 "]`);
  if (!button) throw new Error(`value button not found: ${label}`);
  return button;
}

function grayscaleSwitch(): HTMLButtonElement | null {
  return container.querySelector<HTMLButtonElement>('button[role="switch"]');
}

/** カラーの群の本体に並ぶ項目（切り替えはその文字、スライダーは読み上げ名）。 */
function groupBodyItems(title: string): string[] {
  const toggle = Array.from(container.querySelectorAll<HTMLButtonElement>("h4 > button")).find(
    (candidate) => candidate.textContent === title,
  );
  const body = document.getElementById(toggle?.getAttribute("aria-controls") ?? "");
  if (!body) throw new Error(`group not found: ${title}`);
  return Array.from(body.querySelectorAll<HTMLElement>('button[role="switch"], input[type="range"]')).map(
    (element) => (element.getAttribute("role") === "switch" ? element.textContent : element.getAttribute("aria-label")) ?? "",
  );
}

async function click(element: Element) {
  await act(async () => {
    element.dispatchEvent(new MouseEvent("click", { bubbles: true }));
  });
}

function setRangeValue(input: HTMLInputElement, value: string) {
  Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set?.call(input, value);
  input.dispatchEvent(new Event("input", { bubbles: true }));
}

/** キーボードで動かして確定する（input → commit）。 */
async function moveSlider(label: string, value: string) {
  const input = slider(label);
  await act(async () => {
    setRangeValue(input, value);
    input.dispatchEvent(new Event("change", { bubbles: true }));
  });
}

beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  window.localStorage.clear();
  changes = [];
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  window.localStorage.clear();
});

describe("効果の項目は opt-in", () => {
  it("visibleKeys を省くと出ない（13 本のまま。白黒の設定があっても彩度は押せる・ⓘ も 3 行）", async () => {
    const saved: DevelopSettings = { ...NEUTRAL, grayscale: true, vignette: { amount: -20 }, grain: { amount: 30 } };
    await render({ initial: saved });
    expect(grayscaleSwitch()).toBeNull();
    expect(sliderLabels()).toHaveLength(13);
    expect(sliderLabels()).not.toContain("周辺光量補正");
    expect(sliderLabels()).not.toContain("粒子");
    expect(slider("自然な彩度").disabled).toBe(false);
    expect(slider("彩度").disabled).toBe(false);

    const info = container.querySelector<HTMLButtonElement>('button[aria-label="効果の説明"]');
    if (!info) throw new Error("effects info not found");
    await click(info);
    const list = document.getElementById(info.getAttribute("aria-controls") ?? "");
    expect(Array.from(list?.querySelectorAll("li") ?? []).map((item) => item.textContent)).toEqual([
      "テクスチャ細かな質感を強めたり、和らげたりします",
      "明瞭度中間の明暗の差を強めて、くっきり見せます",
      "かすみの除去かすみを取り除いたり、足したりします",
    ]);
  });

  it("基本のキーだけを渡した面・S1 の canvas の 5 本にも出ない", async () => {
    await render({ initial: NEUTRAL, visibleKeys: [...PHOTO_EDITING_BASE_CONTROL_KEYS] });
    expect(grayscaleSwitch()).toBeNull();
    expect(sliderLabels()).toHaveLength(13);

    await render({
      initial: NEUTRAL,
      visibleKeys: ["exposure", "contrast", "saturation", "relativeTemperature", "relativeTint"],
    });
    expect(grayscaleSwitch()).toBeNull();
    expect(sliderLabels()).toEqual(["露光量", "コントラスト", "色温度", "色かぶり補正", "彩度"]);
  });

  it("効果のキーを渡すと、白黒はカラーの先頭・効果は 5 本＋粒子のサイズ", async () => {
    await render({ initial: NEUTRAL, visibleKeys: EFFECT_KEYS });
    expect(groupBodyItems("カラー")).toEqual(["白黒", "色温度", "色かぶり補正", "自然な彩度", "彩度"]);
    expect(groupBodyItems("効果")).toEqual(["テクスチャ", "明瞭度", "かすみの除去", "周辺光量補正", "粒子", "粒子のサイズ"]);
    expect(sliderLabels()).toHaveLength(16);
  });

  it("粒子のサイズのキーだけ外せる（スマホの面）", async () => {
    await render({ initial: NEUTRAL, visibleKeys: EFFECT_KEYS.filter((key) => key !== "grainSize") });
    expect(groupBodyItems("効果")).toEqual(["テクスチャ", "明瞭度", "かすみの除去", "周辺光量補正", "粒子"]);
  });

  it("効果の ⓘ に、周辺光量補正と粒子の説明を 1 行ずつ足す", async () => {
    await render({ initial: NEUTRAL, visibleKeys: EFFECT_KEYS });
    const info = container.querySelector<HTMLButtonElement>('button[aria-label="効果の説明"]');
    if (!info) throw new Error("effects info not found");
    await click(info);
    const list = document.getElementById(info.getAttribute("aria-controls") ?? "");
    expect(Array.from(list?.querySelectorAll("li") ?? []).map((item) => item.textContent)).toEqual([
      "テクスチャ細かな質感を強めたり、和らげたりします",
      "明瞭度中間の明暗の差を強めて、くっきり見せます",
      "かすみの除去かすみを取り除いたり、足したりします",
      "周辺光量補正写真の四隅を暗くしたり、明るくしたりします",
      "粒子フィルムのような粒を足します",
    ]);
  });
});

describe("白黒の切り替え", () => {
  it("role=switch で、押すたびに commit で通知する（オンで grayscale: true、オフでキーを消す）", async () => {
    await render({ initial: NEUTRAL, visibleKeys: EFFECT_KEYS });
    const toggle = grayscaleSwitch();
    if (!toggle) throw new Error("grayscale switch not found");
    expect(toggle.textContent).toBe("白黒");
    expect(toggle.getAttribute("aria-checked")).toBe("false");
    // 押せる高さは 44px
    expect(toggle.className).toContain("min-h-11");

    await click(toggle);
    expect(changes).toEqual([{ settings: { ...NEUTRAL, grayscale: true }, phase: "commit" }]);
    expect(grayscaleSwitch()?.getAttribute("aria-checked")).toBe("true");

    await click(toggle);
    expect(changes.at(-1)?.phase).toBe("commit");
    expect(changes.at(-1)?.settings).toEqual(NEUTRAL);
    expect(Object.hasOwn(changes.at(-1)?.settings ?? {}, "grayscale")).toBe(false);
    expect(grayscaleSwitch()?.getAttribute("aria-checked")).toBe("false");
  });

  it("オンの間、自然な彩度・彩度は押せない（値は保ち、オフに戻すと押せる）。ほかの項目は押せる", async () => {
    const saved: DevelopSettings = { ...NEUTRAL, vibrance: 20, saturation: -10, grayscale: true };
    await render({ initial: saved, visibleKeys: EFFECT_KEYS });
    expect(grayscaleSwitch()?.getAttribute("aria-checked")).toBe("true");
    for (const label of ["自然な彩度", "彩度"]) {
      expect(slider(label).disabled).toBe(true);
      expect(valueButton(label).disabled).toBe(true);
    }
    expect(slider("自然な彩度").value).toBe("20");
    expect(slider("彩度").value).toBe("-10");
    expect(slider("色温度").disabled).toBe(false);
    expect(slider("露光量").disabled).toBe(false);
    expect(slider("周辺光量補正").disabled).toBe(false);

    const toggle = grayscaleSwitch();
    if (!toggle) throw new Error("grayscale switch not found");
    await click(toggle);
    expect(changes.at(-1)?.settings).toMatchObject({ vibrance: 20, saturation: -10 });
    expect(slider("自然な彩度").disabled).toBe(false);
    expect(slider("彩度").disabled).toBe(false);
    expect(slider("彩度").value).toBe("-10");
  });

  it("押せない面（閲覧のみなど）では切り替えも押せない", async () => {
    await render({ initial: NEUTRAL, visibleKeys: EFFECT_KEYS, disabled: true });
    const toggle = grayscaleSwitch();
    expect(toggle?.disabled).toBe(true);
    if (toggle) await click(toggle);
    expect(changes).toEqual([]);
  });
});

describe("周辺光量補正・粒子", () => {
  it("保存済みの値を見せる（周辺光量補正は符号つき、粒子とサイズは符号なし）", async () => {
    const saved: DevelopSettings = { ...NEUTRAL, vignette: { amount: -15 }, grain: { amount: 30, size: 60 } };
    await render({ initial: saved, visibleKeys: EFFECT_KEYS });
    expect(slider("周辺光量補正").value).toBe("-15");
    expect(valueButton("周辺光量補正").textContent).toBe("-15");
    expect(slider("粒子").value).toBe("30");
    expect(valueButton("粒子").textContent).toBe("30");
    expect(slider("粒子のサイズ").value).toBe("60");
    expect(valueButton("粒子のサイズ").textContent).toBe("60");
    expect([slider("周辺光量補正").min, slider("周辺光量補正").max]).toEqual(["-100", "100"]);
    expect([slider("粒子").min, slider("粒子").max]).toEqual(["0", "100"]);
  });

  it("無ければ 周辺光量補正 0・粒子 0・粒子のサイズ 25。動かすと amount だけ書き、確定は commit", async () => {
    await render({ initial: NEUTRAL, visibleKeys: EFFECT_KEYS });
    expect(valueButton("周辺光量補正").textContent).toBe("0");
    expect(valueButton("粒子").textContent).toBe("0");
    expect(valueButton("粒子のサイズ").textContent).toBe("25");

    await moveSlider("周辺光量補正", "20");
    expect(changes.map((change) => change.phase)).toEqual(["input", "commit"]);
    expect(changes.at(-1)?.settings).toEqual({ ...NEUTRAL, vignette: { amount: 20 } });
    expect(valueButton("周辺光量補正").textContent).toBe("+20");

    await moveSlider("粒子", "35");
    expect(changes.at(-1)?.settings).toEqual({ ...NEUTRAL, vignette: { amount: 20 }, grain: { amount: 35 } });
  });

  it("粒子が 0 の間、粒子のサイズは押せない（行は出したまま）。粒子を動かすと押せる", async () => {
    await render({ initial: NEUTRAL, visibleKeys: EFFECT_KEYS });
    expect(slider("粒子のサイズ").disabled).toBe(true);
    expect(valueButton("粒子のサイズ").disabled).toBe(true);
    expect(slider("粒子").disabled).toBe(false);

    await moveSlider("粒子", "30");
    expect(slider("粒子のサイズ").disabled).toBe(false);
    await moveSlider("粒子のサイズ", "60");
    expect(changes.at(-1)?.settings).toEqual({ ...NEUTRAL, grain: { amount: 30, size: 60 } });

    // 粒子を 0 に戻すと、サイズは保ったまま押せなくなる（行は消えない）
    await moveSlider("粒子", "0");
    expect(changes.at(-1)?.settings).toEqual({ ...NEUTRAL, grain: { amount: 0, size: 60 } });
    expect(slider("粒子のサイズ").disabled).toBe(true);
    expect(slider("粒子のサイズ").value).toBe("60");
  });

  it("ダブルクリックで既定値（周辺光量補正 0・粒子 0・粒子のサイズ 25）に戻し、既定だけになった群はキーごと消える", async () => {
    const saved: DevelopSettings = { ...NEUTRAL, vignette: { amount: -15 }, grain: { amount: 30, size: 60 } };
    await render({ initial: saved, visibleKeys: EFFECT_KEYS });
    const doubleClick = async (label: string) => {
      await act(async () => {
        slider(label).dispatchEvent(new MouseEvent("dblclick", { bubbles: true, detail: 2 }));
      });
    };

    await doubleClick("周辺光量補正");
    expect(changes.at(-1)).toEqual({ settings: { ...NEUTRAL, grain: { amount: 30, size: 60 } }, phase: "commit" });

    await doubleClick("粒子のサイズ");
    expect(changes.at(-1)).toEqual({ settings: { ...NEUTRAL, grain: { amount: 30 } }, phase: "commit" });
    expect(valueButton("粒子のサイズ").textContent).toBe("25");

    await doubleClick("粒子");
    expect(changes.at(-1)).toEqual({ settings: NEUTRAL, phase: "commit" });
    expect(JSON.stringify(changes.at(-1)?.settings)).toBe(JSON.stringify(NEUTRAL));
  });

  it("⇧＋矢印は 10 目盛り・値の直接入力は範囲に丸めて commit（今のスライダーのまま）", async () => {
    await render({ initial: NEUTRAL, visibleKeys: EFFECT_KEYS });
    await act(async () => {
      slider("周辺光量補正").dispatchEvent(
        new KeyboardEvent("keydown", { key: "ArrowLeft", shiftKey: true, bubbles: true, cancelable: true }),
      );
    });
    expect(changes).toEqual([{ settings: { ...NEUTRAL, vignette: { amount: -10 } }, phase: "commit" }]);

    await click(valueButton("粒子"));
    const entry = container.querySelector<HTMLInputElement>('input[aria-label="粒子の値"]');
    if (!entry) throw new Error("value input not found");
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set?.call(entry, "250");
      entry.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await act(async () => {
      entry.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true }));
    });
    expect(changes.at(-1)).toEqual({
      settings: { ...NEUTRAL, vignette: { amount: -10 }, grain: { amount: 100 } },
      phase: "commit",
    });
  });
});
