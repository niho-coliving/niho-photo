// @vitest-environment jsdom

import { act, useRef, useState, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { PhotoEditingPhoto, PhotoEditingSettings } from "../photo-editing-types";
import type { PhotoEditingControlKey } from "../photo-editing-adjustments";
import {
  PHOTO_EDITING_ADJUSTMENT_GROUPS_STORAGE_KEY,
  parseStoredCollapsedAdjustmentGroups,
} from "../photo-editing-adjustment-groups-state";

import { PhotoEditingAdjustmentGroups, type PhotoEditingSliderPhase } from "./photo-editing-adjustment-controls";
import { parsePhotoEditingValueText, snapPhotoEditingSliderValue } from "./photo-editing-slider";

/**
 * 共通の補正パネルの F1（移行元設計）: ライト／カラー／効果の群・開閉と端末への記憶・効果の ⓘ・値の直接入力・⇧＋矢印。ライトの群の
 * 見出しの横の任意の要素（ブラウザ版の「自動」。F4b 移行元設計）も。
 */

let container: HTMLDivElement;
let root: Root;
let changes: { settings: PhotoEditingSettings; phase: PhotoEditingSliderPhase }[];

function Harness(props: {
  initial: PhotoEditingSettings | null;
  photo?: Pick<PhotoEditingPhoto, "asShotWhiteBalance"> | null;
  visibleKeys?: PhotoEditingControlKey[];
  disabled?: boolean;
  lightAccessory?: ReactNode;
}) {
  const [settings, setSettings] = useState<PhotoEditingSettings | null>(props.initial);
  const settingsRef = useRef<PhotoEditingSettings>(props.initial ?? {});
  return (
    <PhotoEditingAdjustmentGroups
      settings={settings}
      photo={props.photo ?? null}
      disabled={props.disabled ?? false}
      visibleKeys={props.visibleKeys}
      lightAccessory={props.lightAccessory}
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

async function remount(props: Parameters<typeof Harness>[0]) {
  act(() => root.unmount());
  root = createRoot(container);
  await render(props);
}

function headings(): string[] {
  return Array.from(container.querySelectorAll("h4")).map((heading) => heading.textContent ?? "");
}

function groupToggle(title: string): HTMLButtonElement {
  const button = Array.from(container.querySelectorAll<HTMLButtonElement>("h4 > button")).find(
    (candidate) => candidate.textContent === title,
  );
  if (!button) throw new Error(`group toggle not found: ${title}`);
  return button;
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

function valueInput(label: string): HTMLInputElement | null {
  return container.querySelector<HTMLInputElement>(`input[aria-label="${label}の値"]`);
}

function buttonNamed(name: string): HTMLButtonElement | null {
  return (
    Array.from(container.querySelectorAll<HTMLButtonElement>("button")).find(
      (button) => button.getAttribute("aria-label") === name || button.textContent === name,
    ) ?? null
  );
}

async function click(element: Element) {
  await act(async () => {
    element.dispatchEvent(new MouseEvent("click", { bubbles: true }));
  });
}

async function keyDown(element: Element, init: KeyboardEventInit) {
  const event = new KeyboardEvent("keydown", { bubbles: true, cancelable: true, ...init });
  await act(async () => {
    element.dispatchEvent(event);
  });
  return event;
}

function setText(input: HTMLInputElement, value: string) {
  Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set?.call(input, value);
  input.dispatchEvent(new Event("input", { bubbles: true }));
}

/** 値を押して直接入力の欄を開き、文字を入れる。 */
async function typeValue(label: string, text: string): Promise<HTMLInputElement> {
  await click(valueButton(label));
  const input = valueInput(label);
  if (!input) throw new Error(`value input not found: ${label}`);
  await act(async () => {
    setText(input, text);
  });
  return input;
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
  vi.restoreAllMocks();
  window.localStorage.clear();
});

describe("群（ライト／カラー／効果）", () => {
  it("ライト → カラー → 効果 の順に 13 本を並べる（カラーは色温度・色かぶり補正・自然な彩度・彩度）", async () => {
    await render({ initial: {} });
    expect(headings()).toEqual(["ライト", "カラー", "効果"]);
    expect(sliderLabels()).toEqual([
      "露光量",
      "コントラスト",
      "ハイライト",
      "シャドウ",
      "白レベル",
      "黒レベル",
      "色温度",
      "色かぶり補正",
      "自然な彩度",
      "彩度",
      "テクスチャ",
      "明瞭度",
      "かすみの除去",
    ]);
  });

  it("見出しで開閉し（既定は全部開く）、閉じた群を端末に覚える。次に描いたときも閉じたまま", async () => {
    await render({ initial: {} });
    const light = groupToggle("ライト");
    expect(light.getAttribute("aria-expanded")).toBe("true");
    const body = document.getElementById(light.getAttribute("aria-controls") ?? "");
    expect(body?.hidden).toBe(false);

    await click(light);
    expect(groupToggle("ライト").getAttribute("aria-expanded")).toBe("false");
    expect(body?.hidden).toBe(true);
    expect(container.querySelector('input[aria-label="露光量"]')).toBeNull();
    expect(container.querySelector('input[aria-label="彩度"]')).not.toBeNull();
    expect(window.localStorage.getItem(PHOTO_EDITING_ADJUSTMENT_GROUPS_STORAGE_KEY)).toBe('["light"]');

    await click(groupToggle("効果"));
    expect(window.localStorage.getItem(PHOTO_EDITING_ADJUSTMENT_GROUPS_STORAGE_KEY)).toBe('["light","effects"]');

    await remount({ initial: {} });
    expect(groupToggle("ライト").getAttribute("aria-expanded")).toBe("false");
    expect(groupToggle("カラー").getAttribute("aria-expanded")).toBe("true");
    expect(groupToggle("効果").getAttribute("aria-expanded")).toBe("false");

    await click(groupToggle("ライト"));
    expect(window.localStorage.getItem(PHOTO_EDITING_ADJUSTMENT_GROUPS_STORAGE_KEY)).toBe('["effects"]');
    expect(container.querySelector('input[aria-label="露光量"]')).not.toBeNull();
  });

  it("保存値が壊れている・localStorage を読めない / 書けないときも全部開いて描き、開閉はその画面の間だけ効く", async () => {
    expect(Array.from(parseStoredCollapsedAdjustmentGroups("{broken"))).toEqual([]);
    expect(Array.from(parseStoredCollapsedAdjustmentGroups('["tone","effects",3]'))).toEqual(["effects"]);

    window.localStorage.setItem(PHOTO_EDITING_ADJUSTMENT_GROUPS_STORAGE_KEY, "{broken");
    await render({ initial: {} });
    expect(sliderLabels()).toHaveLength(13);

    vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => {
      throw new Error("blocked");
    });
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new Error("blocked");
    });
    await remount({ initial: {} });
    expect(sliderLabels()).toHaveLength(13);
    await click(groupToggle("カラー"));
    expect(groupToggle("カラー").getAttribute("aria-expanded")).toBe("false");
    expect(container.querySelector('input[aria-label="色温度"]')).toBeNull();
  });

  it("効果の ⓘ を押すと群の先頭に項目ごとの説明を出し、もう一度押すと閉じる（開閉のボタンの中に入れない）", async () => {
    await render({ initial: {} });
    const info = buttonNamed("効果の説明");
    if (!info) throw new Error("info button not found");
    expect(info.closest("h4")).toBeNull();
    expect(info.getAttribute("aria-expanded")).toBe("false");
    expect(container.textContent).not.toContain("細かな質感を強めたり、和らげたりします");

    await click(info);
    expect(info.getAttribute("aria-expanded")).toBe("true");
    const list = document.getElementById(info.getAttribute("aria-controls") ?? "");
    expect(Array.from(list?.querySelectorAll("li") ?? []).map((item) => item.textContent)).toEqual([
      "テクスチャ細かな質感を強めたり、和らげたりします",
      "明瞭度中間の明暗の差を強めて、くっきり見せます",
      "かすみの除去かすみを取り除いたり、足したりします",
    ]);
    // 群の先頭（スライダーより前）
    const firstSlider = slider("テクスチャ");
    expect(list && list.compareDocumentPosition(firstSlider) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();

    await click(info);
    expect(info.getAttribute("aria-expanded")).toBe("false");
    expect(container.textContent).not.toContain("細かな質感を強めたり、和らげたりします");
    // ほかの群には ⓘ を出さない
    expect(container.querySelectorAll('button[aria-label$="の説明"]')).toHaveLength(1);
  });

  it("「撮影時に戻す」はカラーの群の見出しの横（開閉のボタンの兄弟）に出す", async () => {
    await render({
      initial: { whiteBalance: { mode: "custom", temperature: 6000, tint: 10 } },
      photo: { asShotWhiteBalance: { temperature: 5200, tint: 4 } },
    });
    const reset = buttonNamed("撮影時に戻す");
    expect(reset?.closest("h4")).toBeNull();
    const headerRow = groupToggle("カラー").closest("h4")?.parentElement;
    expect(headerRow?.contains(reset ?? null)).toBe(true);
  });

  it("lightAccessory を渡すとライトの群の見出しの横（開閉のボタンの兄弟）に出し、群を閉じても出したまま（F4b #17139）", async () => {
    await render({ initial: {}, lightAccessory: <button type="button">自動</button> });
    const accessory = buttonNamed("自動");
    expect(accessory).not.toBeNull();
    expect(accessory?.closest("h4")).toBeNull();
    expect(groupToggle("ライト").closest("h4")?.parentElement?.contains(accessory ?? null)).toBe(true);
    // ほかの群の見出しには出さない（1 つだけ）
    expect(groupToggle("カラー").closest("h4")?.parentElement?.contains(accessory ?? null)).toBe(false);
    expect(Array.from(container.querySelectorAll("button")).filter((button) => button.textContent === "自動")).toHaveLength(1);

    await click(groupToggle("ライト"));
    expect(groupToggle("ライト").getAttribute("aria-expanded")).toBe("false");
    expect(container.querySelector('input[aria-label="露光量"]')).toBeNull();
    expect(buttonNamed("自動")).not.toBeNull();
    expect(groupToggle("ライト").closest("h4")?.parentElement?.contains(buttonNamed("自動"))).toBe(true);
  });

  it("lightAccessory を省くと、ライトの群の見出しの横には何も置かない（NIHO Desktop の面は今のまま）", async () => {
    await render({ initial: {} });
    expect(buttonNamed("自動")).toBeNull();
    const lightHeaderRow = groupToggle("ライト").closest("h4")?.parentElement;
    expect(Array.from(lightHeaderRow?.children ?? []).map((child) => child.tagName)).toEqual(["H4"]);
  });
});

describe("スライダーの操作", () => {
  it("値を押すとその場で入力欄に替わり（全選択で始まる）、Enter で範囲と刻みに丸めて commit で通知する", async () => {
    await render({ initial: { exposure: 0.3 } });
    expect(valueButton("露光量").textContent).toBe("+0.30");
    await click(valueButton("露光量"));
    const input = valueInput("露光量");
    expect(input).not.toBeNull();
    expect(input?.getAttribute("inputmode")).toBe("decimal");
    expect(input?.value).toBe("+0.30");
    expect(document.activeElement).toBe(input);
    expect(input?.selectionStart).toBe(0);
    expect(input?.selectionEnd).toBe("+0.30".length);

    await act(async () => {
      if (input) setText(input, "1.234");
    });
    await keyDown(input as HTMLInputElement, { key: "Enter" });
    expect(changes).toEqual([{ settings: { exposure: 1.23 }, phase: "commit" }]);
    expect(valueInput("露光量")).toBeNull();
    expect(valueButton("露光量").textContent).toBe("+1.23");
    expect(document.activeElement).toBe(valueButton("露光量"));
  });

  it("欄を離れても確定する。範囲の外は範囲で止め、全角の数字も受ける", async () => {
    await render({ initial: {} });
    const input = await typeValue("コントラスト", "250");
    await act(async () => {
      input.dispatchEvent(new FocusEvent("blur"));
      input.dispatchEvent(new FocusEvent("focusout", { bubbles: true }));
    });
    expect(changes.at(-1)).toEqual({ settings: { contrast: 100 }, phase: "commit" });
    expect(valueInput("コントラスト")).toBeNull();

    const second = await typeValue("ハイライト", "－３０");
    await keyDown(second, { key: "Enter" });
    expect(changes.at(-1)).toEqual({ settings: { contrast: 100, highlights: -30 }, phase: "commit" });

    const third = await typeValue("露光量", "-9");
    await keyDown(third, { key: "Enter" });
    expect(changes.at(-1)?.settings).toMatchObject({ exposure: -5 });
  });

  it("Esc で取り消し、数値でなければ元の値のまま（どちらも通知しない）", async () => {
    await render({ initial: { saturation: 12 } });
    const input = await typeValue("彩度", "40");
    const escape = await keyDown(input, { key: "Escape" });
    expect(escape.defaultPrevented).toBe(true);
    expect(valueInput("彩度")).toBeNull();
    expect(valueButton("彩度").textContent).toBe("+12");

    const invalid = await typeValue("彩度", "abc");
    await keyDown(invalid, { key: "Enter" });
    const empty = await typeValue("彩度", "");
    await keyDown(empty, { key: "Enter" });
    expect(changes).toEqual([]);
    expect(valueButton("彩度").textContent).toBe("+12");
  });

  it("IME の変換を確定する Enter では終えない。押せないときは値を押せない", async () => {
    await render({ initial: {} });
    const input = await typeValue("明瞭度", "10");
    await keyDown(input, { key: "Enter", isComposing: true });
    expect(valueInput("明瞭度")).not.toBeNull();
    expect(changes).toEqual([]);

    await remount({ initial: {}, disabled: true });
    expect(valueButton("明瞭度").disabled).toBe(true);
    await click(valueButton("明瞭度"));
    expect(valueInput("明瞭度")).toBeNull();
  });

  it("絶対の色温度は K で受ける（つまみの位置に丸めない）", async () => {
    await render({
      initial: { whiteBalance: { mode: "custom", temperature: 6000, tint: 10 } },
      photo: { asShotWhiteBalance: { temperature: 5200, tint: 4 } },
    });
    const input = await typeValue("色温度", "5555");
    await keyDown(input, { key: "Enter" });
    expect(changes.at(-1)).toEqual({
      settings: { whiteBalance: { mode: "custom", temperature: 5555, tint: 10 } },
      phase: "commit",
    });
    expect(valueButton("色温度").textContent).toBe("5555");
  });

  it("⇧ を押しながらの矢印は 10 目盛り（範囲で止め、commit で通知）。⇧ なしは今のまま", async () => {
    await render({ initial: { exposure: 4.95, contrast: 95 } });
    const exposure = slider("露光量");
    const up = await keyDown(exposure, { key: "ArrowRight", shiftKey: true });
    expect(up.defaultPrevented).toBe(true);
    expect(changes.at(-1)).toEqual({ settings: { exposure: 5, contrast: 95 }, phase: "commit" });

    const down = await keyDown(slider("露光量"), { key: "ArrowDown", shiftKey: true });
    expect(down.defaultPrevented).toBe(true);
    expect(changes.at(-1)?.settings).toMatchObject({ exposure: 4.9 });

    await keyDown(slider("コントラスト"), { key: "ArrowLeft", shiftKey: true });
    expect(changes.at(-1)?.settings).toMatchObject({ contrast: 85 });

    const count = changes.length;
    const plain = await keyDown(slider("コントラスト"), { key: "ArrowLeft" });
    expect(plain.defaultPrevented).toBe(false);
    expect(changes).toHaveLength(count);
    // 読み上げの値は今のまま値だけ
    expect(slider("コントラスト").getAttribute("aria-valuetext")).toBe("+85");
  });

  it("つまみの押せる高さは 44px（h-11）", async () => {
    await render({ initial: {} });
    expect(slider("露光量").className).toContain("h-11");
  });
});

describe("見た目（Lightroom の細い線と白い丸。L6 #55）", () => {
  it("線とつまみは疑似要素で描き、既定値から動かした値だけ accent-ink の太字、色温度・色かぶり補正だけ線に色の帯", async () => {
    await render({
      initial: { exposure: 0.3, whiteBalance: { mode: "custom", temperature: 6000, tint: 4 } },
      photo: { asShotWhiteBalance: { temperature: 5200, tint: 4 } },
    });
    const exposure = slider("露光量");
    expect(exposure.className).toContain("appearance-none");
    expect(exposure.className).toContain("[&::-webkit-slider-runnable-track]:h-0.5");
    expect(exposure.className).toContain("[&::-moz-range-track]:h-0.5");
    expect(exposure.className).toContain("[&::-webkit-slider-thumb]:size-3");
    expect(exposure.className).toContain("[&::-moz-range-thumb]:size-3");
    expect(exposure.className).not.toContain("accent-niho-accent-ink");

    // 既定値から動かした値（露光量・撮影時と違う色温度）は値を太字にし、つまみの線も accent-ink
    for (const label of ["露光量", "色温度"]) {
      expect(valueButton(label).className).toContain("font-bold");
      expect(valueButton(label).className).toContain("text-niho-accent-ink");
      expect(slider(label).className).toContain("[&::-webkit-slider-thumb]:border-niho-accent-ink");
    }
    // 既定値のまま（コントラスト・撮影時と同じ色かぶり補正）は印を出さない
    for (const label of ["コントラスト", "色かぶり補正"]) {
      expect(valueButton(label).className).not.toContain("font-bold");
      expect(valueButton(label).className).toContain("text-niho-text");
      expect(slider(label).className).toContain("[&::-webkit-slider-thumb]:border-niho-text-sub");
    }

    expect(slider("色温度").className).toContain("[&::-webkit-slider-runnable-track]:bg-[linear-gradient(90deg,#9CBBF0");
    expect(slider("色かぶり補正").className).toContain("[&::-webkit-slider-runnable-track]:bg-[linear-gradient(90deg,#A9D59A");
    expect(exposure.className).not.toContain("linear-gradient");
  });
});

describe("値の読み方と丸め", () => {
  it("全角・「−」を受け、数値でなければ null", () => {
    expect(parsePhotoEditingValueText(" +0.5 ")).toBe(0.5);
    expect(parsePhotoEditingValueText("−12")).toBe(-12);
    expect(parsePhotoEditingValueText("１２．５")).toBe(12.5);
    expect(parsePhotoEditingValueText(".5")).toBe(0.5);
    expect(parsePhotoEditingValueText("")).toBeNull();
    expect(parsePhotoEditingValueText("1e3")).toBeNull();
    expect(parsePhotoEditingValueText("1,000")).toBeNull();
    expect(parsePhotoEditingValueText("abc")).toBeNull();
  });

  it("範囲に収めて刻みに丸める（-0 は 0）", () => {
    expect(snapPhotoEditingSliderValue(1.234, -5, 5, 0.01)).toBe(1.23);
    expect(snapPhotoEditingSliderValue(0.1 + 0.2, -5, 5, 0.01)).toBe(0.3);
    expect(snapPhotoEditingSliderValue(-0.001, -5, 5, 0.01)).toBe(0);
    expect(Object.is(snapPhotoEditingSliderValue(-0.001, -5, 5, 0.01), -0)).toBe(false);
    expect(snapPhotoEditingSliderValue(12.6, -100, 100, 1)).toBe(13);
    expect(snapPhotoEditingSliderValue(-120, -100, 100, 1)).toBe(-100);
  });
});
