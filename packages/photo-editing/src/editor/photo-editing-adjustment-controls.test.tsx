// @vitest-environment jsdom

import { act, useRef, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { PhotoEditingPhoto, PhotoEditingSettings } from "../photo-editing-types";
import type { PhotoEditingControlKey } from "../photo-editing-adjustments";

import { PhotoEditingAdjustmentGroups, type PhotoEditingSliderPhase } from "./photo-editing-adjustment-controls";

const BROWSER_KEYS: PhotoEditingControlKey[] = ["exposure", "contrast", "saturation", "relativeTemperature", "relativeTint"];

let container: HTMLDivElement;
let root: Root;
let changes: { settings: PhotoEditingSettings; phase: PhotoEditingSliderPhase }[];

/** 共通の群を、変更の通知を受けて設定を持ち替える画面に置く（`update` は呼ばれた時点の最新に当てる）。 */
function Harness(props: {
  initial: PhotoEditingSettings | null;
  photo: Pick<PhotoEditingPhoto, "asShotWhiteBalance"> | null;
  visibleKeys?: PhotoEditingControlKey[];
  disabled?: boolean;
}) {
  const [settings, setSettings] = useState<PhotoEditingSettings | null>(props.initial);
  const settingsRef = useRef<PhotoEditingSettings>(props.initial ?? {});
  return (
    <PhotoEditingAdjustmentGroups
      settings={settings}
      photo={props.photo}
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

/** 設定を持ち直す（`initial` から始め直す）。 */
async function renderFresh(props: Parameters<typeof Harness>[0]) {
  act(() => root.unmount());
  root = createRoot(container);
  await render(props);
}

function headings(): string[] {
  return Array.from(container.querySelectorAll("h4")).map((heading) => heading.textContent ?? "");
}

function sliderLabels(): string[] {
  return Array.from(container.querySelectorAll<HTMLInputElement>('input[type="range"]')).map(
    (input) => input.getAttribute("aria-label") ?? "",
  );
}

function slider(label: string): HTMLInputElement {
  const input = container.querySelector<HTMLInputElement>(`input[aria-label="${label}"]`);
  if (!input) throw new Error(`slider not found: ${label}`);
  return input;
}

/** スライダーの右の値（押すと直接入力の欄に替わるボタン）の文字。 */
function outputOf(label: string): string {
  return container.querySelector(`button[aria-label^="${label}の値 "]`)?.textContent ?? "";
}

function findButton(label: string): HTMLButtonElement | null {
  return Array.from(container.querySelectorAll("button")).find((button) => button.textContent === label) ?? null;
}

function setRangeValue(input: HTMLInputElement, value: string) {
  Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set?.call(input, value);
  input.dispatchEvent(new Event("input", { bubbles: true }));
}

beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  changes = [];
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

describe("PhotoEditingAdjustmentGroups", () => {
  it("見せる項目を絞ると、その項目だけを群の見出しの下に並べる（ブラウザの 5 本）", async () => {
    await render({
      initial: {
        v: 1,
        engine: "niho-1",
        exposure: 0.5,
        contrast: 10,
        saturation: -5,
        relativeTemperature: 12,
        relativeTint: -3,
        highlights: -20,
        whiteBalance: { mode: "relative" },
      },
      photo: { asShotWhiteBalance: null },
      visibleKeys: BROWSER_KEYS,
    });

    expect(headings()).toEqual(["ライト", "カラー"]);
    // 並びは群の定義のまま（絞り込みの並びではない）
    expect(sliderLabels()).toEqual(["露光量", "コントラスト", "色温度", "色かぶり補正", "彩度"]);
    expect(slider("露光量").value).toBe("0.5");
    expect(slider("色温度").value).toBe("12");
    expect(outputOf("露光量")).toBe("+0.50");
    expect(outputOf("色かぶり補正")).toBe("-3");
    // 見せない項目（ハイライト）は出さない
    expect(container.querySelector('input[aria-label="ハイライト"]')).toBeNull();
    // label の htmlFor でも引ける（NIHO Desktop のテストの探し方）
    const label = Array.from(container.querySelectorAll("label")).find((item) => item.textContent === "彩度");
    expect(label && document.getElementById(label.htmlFor)).toBe(slider("彩度"));
  });

  it("項目が 1 つも無い群は見出しごと出さない。省略時は全部の項目を出す", async () => {
    await render({ initial: {}, photo: null, visibleKeys: ["exposure", "contrast"] });
    expect(headings()).toEqual(["ライト"]);
    expect(sliderLabels()).toEqual(["露光量", "コントラスト"]);

    await render({ initial: {}, photo: null });
    expect(headings()).toEqual(["ライト", "カラー", "効果"]);
    expect(sliderLabels()).toHaveLength(13);
  });

  it("ドラッグは drag → 離して commit、キーボードは input → commit を通知する（離したときの change で二重に commit しない）", async () => {
    await render({ initial: {}, photo: null, visibleKeys: BROWSER_KEYS });
    const exposure = slider("露光量");

    await act(async () => {
      exposure.dispatchEvent(new Event("pointerdown", { bubbles: true }));
      setRangeValue(exposure, "0.5");
      setRangeValue(exposure, "1");
    });
    await act(async () => {
      window.dispatchEvent(new Event("pointerup"));
      exposure.dispatchEvent(new Event("change", { bubbles: true }));
    });
    expect(changes.map((change) => change.phase)).toEqual(["drag", "drag", "commit"]);
    expect(changes.at(-1)?.settings).toMatchObject({ exposure: 1 });

    changes = [];
    const contrast = slider("コントラスト");
    await act(async () => {
      setRangeValue(contrast, "10");
      contrast.dispatchEvent(new Event("change", { bubbles: true }));
    });
    expect(changes.map((change) => change.phase)).toEqual(["input", "commit"]);
    // 別の項目を動かしても、先に動かした値は残す（呼ばれた時点の最新に当てる）
    expect(changes.at(-1)?.settings).toMatchObject({ exposure: 1, contrast: 10 });
  });

  it("ダブルクリックで既定値（0）に戻し、commit で通知する", async () => {
    await render({ initial: { exposure: 1.5, saturation: 20 }, photo: null, visibleKeys: BROWSER_KEYS });
    await act(async () => {
      slider("露光量").dispatchEvent(new MouseEvent("dblclick", { bubbles: true, detail: 2 }));
    });
    expect(changes).toEqual([{ settings: { exposure: 0, saturation: 20 }, phase: "commit" }]);
    expect(slider("露光量").value).toBe("0");
  });

  it("相対の白は developSettings では whiteBalance.mode を relative にし、両方 0 に戻したら撮影時（asShot）にする", async () => {
    await render({
      initial: { v: 1, engine: "niho-1", exposure: 0, whiteBalance: { mode: "asShot" } },
      photo: { asShotWhiteBalance: null },
      visibleKeys: BROWSER_KEYS,
    });
    const temperature = slider("色温度");
    await act(async () => {
      setRangeValue(temperature, "10");
    });
    expect(changes.at(-1)?.settings).toMatchObject({ relativeTemperature: 10, whiteBalance: { mode: "relative" } });

    await act(async () => {
      setRangeValue(slider("色温度"), "0");
    });
    expect(changes.at(-1)?.settings).toMatchObject({ relativeTemperature: 0, whiteBalance: { mode: "asShot" } });
  });

  it("撮影時の白がある写真は絶対の色温度で見せ、「撮影時に戻す」で撮影時に戻す（押せないときは出さない）", async () => {
    const photo = { asShotWhiteBalance: { temperature: 5200, tint: 4 } };
    await render({ initial: { whiteBalance: { mode: "custom", temperature: 6000, tint: 10 } }, photo });
    expect(outputOf("色温度")).toBe("6000");
    expect(outputOf("色かぶり補正")).toBe("+10");

    const reset = findButton("撮影時に戻す");
    expect(reset).not.toBeNull();
    await act(async () => {
      reset?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    expect(changes).toEqual([{ settings: { whiteBalance: { mode: "asShot" } }, phase: "commit" }]);
    expect(outputOf("色温度")).toBe("5200");
    expect(findButton("撮影時に戻す")).toBeNull();

    await renderFresh({ initial: { whiteBalance: { mode: "custom", temperature: 6000, tint: 10 } }, photo, disabled: true });
    expect(outputOf("色温度")).toBe("6000");
    expect(findButton("撮影時に戻す")).toBeNull();
    expect(slider("色温度").disabled).toBe(true);
    expect(slider("露光量").disabled).toBe(true);
  });
});
