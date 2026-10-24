// @vitest-environment jsdom

import { act, useRef, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { PhotoEditingSettings } from "../photo-editing-types";
import { neutralDevelopSettings } from "../develop-engine/develop-settings";
import { PHOTO_EDITING_BASE_CONTROL_KEYS, type PhotoEditingControlKey } from "../photo-editing-adjustments";
import { PHOTO_EDITING_DETAIL_KEYS } from "../photo-editing-detail";
import { PHOTO_EDITING_EFFECT_KEYS } from "../photo-editing-effects";

import { browserAdjustmentKeys, detailControlsAvailable } from "./browser-photo-editing-model";
import { PhotoEditingAdjustmentGroups, type PhotoEditingSliderPhase } from "./photo-editing-adjustment-controls";

/**
 * 共通の補正パネルのディテール（シャープ・ノイズ軽減。Issue #32）。v6 を読める wasm の写真の面だけが `visibleKeys` に入れて出す、
 * 効果の後ろの群。
 */

const DETAIL_KEYS: PhotoEditingControlKey[] = [...PHOTO_EDITING_BASE_CONTROL_KEYS, ...PHOTO_EDITING_DETAIL_KEYS];
const NEUTRAL = neutralDevelopSettings();

let container: HTMLDivElement;
let root: Root;
let changes: { settings: PhotoEditingSettings; phase: PhotoEditingSliderPhase }[];

function Harness(props: { initial: PhotoEditingSettings; visibleKeys?: ReadonlyArray<PhotoEditingControlKey> }) {
  const [settings, setSettings] = useState<PhotoEditingSettings>(props.initial);
  const settingsRef = useRef<PhotoEditingSettings>(props.initial);
  return (
    <PhotoEditingAdjustmentGroups
      settings={settings}
      photo={{ asShotWhiteBalance: null }}
      disabled={false}
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

function groupTitles(): string[] {
  return Array.from(container.querySelectorAll<HTMLButtonElement>("h4 > button")).map((button) => button.textContent ?? "");
}

function groupToggle(title: string): HTMLButtonElement {
  const toggle = Array.from(container.querySelectorAll<HTMLButtonElement>("h4 > button")).find(
    (candidate) => candidate.textContent === title,
  );
  if (!toggle) throw new Error(`group not found: ${title}`);
  return toggle;
}

function groupSliders(title: string): HTMLInputElement[] {
  const body = document.getElementById(groupToggle(title).getAttribute("aria-controls") ?? "");
  if (!body) throw new Error(`group body not found: ${title}`);
  return Array.from(body.querySelectorAll<HTMLInputElement>('input[type="range"]'));
}

function slider(title: string, label: string): HTMLInputElement {
  const input = groupSliders(title).find((candidate) => candidate.getAttribute("aria-label") === label);
  if (!input) throw new Error(`slider not found: ${label}`);
  return input;
}

async function click(element: Element) {
  await act(async () => {
    element.dispatchEvent(new MouseEvent("click", { bubbles: true }));
  });
}

async function moveSlider(input: HTMLInputElement, value: string) {
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set?.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
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

describe("ディテールの群は opt-in", () => {
  it("ディテールのキーを渡さない面（v6 を読めない wasm・NIHO Desktop・S1 の canvas）には出ない", async () => {
    await render({ initial: NEUTRAL });
    expect(groupTitles()).toEqual(["ライト", "カラー", "効果"]);
    await render({ initial: NEUTRAL, visibleKeys: [...PHOTO_EDITING_BASE_CONTROL_KEYS, ...PHOTO_EDITING_EFFECT_KEYS] });
    expect(groupTitles()).toEqual(["ライト", "カラー", "効果"]);
  });

  it("キーを渡すと効果の後ろに出る。よく使う 3 つが先、シャープの応用の 3 つが後ろ（内部の名前は見せない）", async () => {
    await render({ initial: NEUTRAL, visibleKeys: DETAIL_KEYS });
    expect(groupTitles()).toEqual(["ライト", "カラー", "効果", "ディテール"]);
    expect(groupSliders("ディテール").map((input) => input.getAttribute("aria-label"))).toEqual([
      "シャープ",
      "ノイズ軽減",
      "カラーノイズの軽減",
      "シャープの半径",
      "シャープの細部",
      "シャープのマスク",
    ]);
    expect(container.textContent).not.toMatch(/sharpen|luminanceNoise|colorNoise|detail/);
    // 見出しは押せる高さ 44px の開閉ボタン
    expect(groupToggle("ディテール").className).toContain("min-h-11");
  });

  it("PC の右パネルのキー: 効果とディテールはそれぞれ確かめた wasm だけに足す", () => {
    expect(browserAdjustmentKeys({ effects: false, detail: false })).toBeUndefined();
    expect(browserAdjustmentKeys({ effects: true, detail: false })).not.toContain("sharpenAmount");
    expect(browserAdjustmentKeys({ effects: true, detail: true })).toEqual(
      expect.arrayContaining(["grayscale", "sharpenAmount", "colorNoiseReduction"]),
    );
    const detailOnly = browserAdjustmentKeys({ effects: false, detail: true });
    expect(detailOnly).not.toContain("grayscale");
    expect(detailOnly).toEqual(expect.arrayContaining([...PHOTO_EDITING_DETAIL_KEYS]));
  });

  it("RAW を含む wasm で開いた写真（オリジナル・作業コピー・RAW を開いている途中の仮の画）のどれにも出す（owner 判断 2026-10-21）", () => {
    const file = new File([], "a.jpg");
    const workingCopy = { kind: "workingCopy" as const, bytes: new ArrayBuffer(0), metaJson: "{}", baseVersion: "raw-apple.1" };
    expect(detailControlsAvailable({ kind: "original", file })).toBe(true);
    expect(detailControlsAvailable({ ...workingCopy, encoding: "jpeg8" })).toBe(true);
    expect(detailControlsAvailable({ ...workingCopy, encoding: "png16" })).toBe(true);
    expect(detailControlsAvailable({ kind: "provisional", file, contentSha256: "0", width: 1, height: 1 })).toBe(true);
    expect(detailControlsAvailable(null)).toBe(false);
  });

  it("signed RAW の写真でも群が出て、カラーノイズの軽減は描いている旧の値（50 で頭打ち）を見せる", async () => {
    const raw = { ...NEUTRAL, engine: "niho-11", look: "niho-standard-5", colorNoiseReduction: 25 };
    await render({ initial: raw, visibleKeys: browserAdjustmentKeys({ effects: true, detail: true }) });
    expect(groupTitles()).toContain("ディテール");
    expect(slider("ディテール", "カラーノイズの軽減").value).toBe("25");
    // 旧の値と同じに戻すと明示を消す（R209 と同じ画素・detail ごと消えて v6 にしない）
    await moveSlider(slider("ディテール", "カラーノイズの軽減"), "10");
    expect(changes.at(-1)?.settings.detail).toMatchObject({ colorNoiseReduction: 10 });
    await moveSlider(slider("ディテール", "カラーノイズの軽減"), "25");
    expect(changes.at(-1)?.settings).not.toHaveProperty("detail");
  });
});

describe("ディテールのスライダー", () => {
  it("シャープが 0 の間はシャープの半径・細部・マスクを押せず、動かすと v6 の detail を書いて押せるようになる", async () => {
    await render({ initial: NEUTRAL, visibleKeys: DETAIL_KEYS });
    expect(["シャープの半径", "シャープの細部", "シャープのマスク"].map((label) => slider("ディテール", label).disabled)).toEqual([true, true, true]);
    expect(slider("ディテール", "ノイズ軽減").disabled).toBe(false);
    expect(slider("ディテール", "シャープの半径").value).toBe("1");

    await moveSlider(slider("ディテール", "シャープ"), "60");
    expect(changes.at(-1)?.phase).toBe("commit");
    expect(changes.at(-1)?.settings.detail).toEqual({
      sharpening: { amount: 60, radius: 1, detail: 25, masking: 0 },
      luminanceNoiseReduction: 0,
    });
    expect(slider("ディテール", "シャープの半径").disabled).toBe(false);
    // 半径は 0.1 刻み
    expect(slider("ディテール", "シャープの半径").step).toBe("0.1");
    await moveSlider(slider("ディテール", "シャープの半径"), "1.7");
    expect(changes.at(-1)?.settings.detail).toMatchObject({ sharpening: { radius: 1.7 } });
    expect(container.textContent).toContain("1.7");
  });

  it("ノイズ軽減・カラーノイズの軽減を 0 に戻すと detail を消す（ディテールを使わない写真は v6 にしない）", async () => {
    await render({ initial: NEUTRAL, visibleKeys: DETAIL_KEYS });
    await moveSlider(slider("ディテール", "カラーノイズの軽減"), "40");
    expect(changes.at(-1)?.settings.detail).toMatchObject({ colorNoiseReduction: 40 });
    await moveSlider(slider("ディテール", "カラーノイズの軽減"), "0");
    expect(changes.at(-1)?.settings).not.toHaveProperty("detail");
  });

  it("ⓘ に項目ごとの説明を 1 行ずつ出す（シャープは指を離すと反映）", async () => {
    await render({ initial: NEUTRAL, visibleKeys: DETAIL_KEYS });
    const info = container.querySelector<HTMLButtonElement>('button[aria-label="ディテールの説明"]');
    if (!info) throw new Error("detail info not found");
    expect(info.className).toContain("h-11");
    await click(info);
    const list = document.getElementById(info.getAttribute("aria-controls") ?? "");
    const lines = Array.from(list?.querySelectorAll("li") ?? []).map((item) => item.textContent);
    expect(lines).toHaveLength(6);
    expect(lines[0]).toBe("シャープ輪郭をくっきりさせます。指を離すと反映します");
    // RAW などの作業コピーは NR も drag 中に反映しない（JPEG と違う所だけ書く）
    expect(lines[1]).toBe("ノイズ軽減明るさのざらつきを滑らかにします。RAW などは指を離すと反映します");
  });
});
