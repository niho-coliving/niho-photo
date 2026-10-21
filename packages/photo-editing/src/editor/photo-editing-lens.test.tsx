// @vitest-environment jsdom

import { act, useRef, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { neutralDevelopSettings } from "../develop-engine/develop-settings";
import { PHOTO_EDITING_ADVANCED_SECTIONS_STORAGE_KEY } from "../photo-editing-advanced-sections-state";
import type { PhotoEditingLensProfileState } from "../photo-editing-lens";
import type { PhotoEditingSettings } from "../photo-editing-types";

import { BrowserPhotoEditingAdjustments } from "./browser-photo-editing-adjustments";
import { BROWSER_EFFECTS_ADJUSTMENT_KEYS } from "./browser-photo-editing-model";
import type { PhotoEditingSliderPhase } from "./photo-editing-adjustment-controls";
import { PhotoEditingLens, PhotoEditingLensSection } from "./photo-editing-lens";

/**
 * 「レンズ」の節（niho-photo#45）。上から作業コピーに焼き込まれたプロファイル補正の状態（読み取り専用。あれば）、歪み・周辺光量・中点、
 * 「色収差を除去」のスイッチ、「フリンジ」の下に紫・緑。スライダーはドラッグの間 `drag`・離して `commit`、ダブルクリックで既定。
 * 節は既定で閉じ、見出しの横の「初期化」はレンズ補正の全部を外す。PC の右パネルでは効果の群の直後に置く。
 */

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLDivElement;
let root: Root;
let changes: { settings: PhotoEditingSettings; phase: PhotoEditingSliderPhase }[];

type HarnessProps = {
  initial: PhotoEditingSettings;
  disabled?: boolean;
  section?: boolean;
  profile?: PhotoEditingLensProfileState | null;
};

function Harness(props: HarnessProps) {
  const [settings, setSettings] = useState(props.initial);
  const settingsRef = useRef(props.initial);
  const lensProps = {
    settings,
    disabled: props.disabled ?? false,
    profile: props.profile ?? null,
    onSettingsChange: (update: (current: PhotoEditingSettings) => PhotoEditingSettings, phase: PhotoEditingSliderPhase) => {
      const next = update(settingsRef.current);
      settingsRef.current = next;
      changes.push({ settings: next, phase });
      setSettings(next);
    },
  };
  return props.section ? <PhotoEditingLensSection {...lensProps} /> : <PhotoEditingLens {...lensProps} />;
}

async function render(props: HarnessProps) {
  await act(async () => {
    root.render(<Harness {...props} />);
  });
}

function sliders(): HTMLInputElement[] {
  return Array.from(container.querySelectorAll<HTMLInputElement>('input[type="range"]'));
}

function slider(label: string): HTMLInputElement {
  const found = container.querySelector<HTMLInputElement>(`input[type="range"][aria-label="${label}"]`);
  if (!found) throw new Error(`slider not found: ${label}`);
  return found;
}

function chromaticSwitch(): HTMLButtonElement {
  const found = container.querySelector<HTMLButtonElement>('button[role="switch"]');
  if (!found) throw new Error("switch not found");
  return found;
}

function resetButton(): HTMLButtonElement {
  const found = container.querySelector<HTMLButtonElement>('button[aria-label="レンズ補正を初期化"]');
  if (!found) throw new Error("reset button not found");
  return found;
}

async function click(element: Element) {
  await act(async () => {
    element.dispatchEvent(new MouseEvent("click", { bubbles: true }));
  });
}

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

describe("PhotoEditingLens", () => {
  it("歪み・周辺光量・中点・色収差を除去・フリンジ（紫・緑）を並べる（既定の値・範囲）", async () => {
    await render({ initial: neutralDevelopSettings(null) });
    expect(sliders().map((input) => input.getAttribute("aria-label"))).toEqual(["歪み", "周辺光量", "中点", "紫", "緑"]);
    expect([slider("歪み").min, slider("歪み").max, slider("歪み").value]).toEqual(["-100", "100", "0"]);
    expect([slider("中点").min, slider("中点").max, slider("中点").value]).toEqual(["0", "100", "50"]);
    expect([slider("紫").min, slider("紫").max]).toEqual(["0", "100"]);
    // 中点は周辺光量が 0 の間は効かないので押せない
    expect(slider("中点").disabled).toBe(true);
    expect(chromaticSwitch().textContent).toContain("色収差を除去");
    expect(chromaticSwitch().getAttribute("aria-checked")).toBe("false");
    const group = container.querySelector('[role="group"]');
    const heading = group?.getAttribute("aria-labelledby");
    expect(heading && document.getElementById(heading)?.textContent).toBe("フリンジ");
    // 状態の行は、作業コピーの状態が分からない写真には出さない
    expect(container.querySelector('[data-testid="photo-lens-profile"]')).toBeNull();
  });

  it("作業コピーに焼き込まれたプロファイル補正の状態を読み取りで出す", async () => {
    await render({ initial: neutralDevelopSettings(null), profile: "apple" });
    expect(container.querySelector('[data-testid="photo-lens-profile"]')?.textContent).toBe(
      "歪み補正: 撮影データのプロファイルで適用済み（Apple）。手動の値はその上の微調整です",
    );
    await render({ initial: neutralDevelopSettings(null), profile: "embedded" });
    expect(container.querySelector('[data-testid="photo-lens-profile"]')?.textContent).toContain("埋め込み");
    await render({ initial: neutralDevelopSettings(null), profile: "none" });
    expect(container.querySelector('[data-testid="photo-lens-profile"]')?.textContent).toContain("歪み補正: なし");
  });

  it("ドラッグの間は drag、離したら commit。書いた値は developSettings.lens に入り、形の版は 9", async () => {
    await render({ initial: neutralDevelopSettings(null) });
    await drag(slider("歪み"), [10, 25]);
    expect(changes.map((change) => change.phase)).toEqual(["drag", "drag", "commit"]);
    const last = changes.at(-1)?.settings;
    expect(last?.lens).toEqual({ distortion: 25 });
    expect(last?.v).toBe(9);
    await drag(slider("周辺光量"), [-30]);
    expect(slider("中点").disabled).toBe(false);
    await drag(slider("紫"), [40]);
    expect(changes.at(-1)?.settings.lens).toEqual({ distortion: 25, vignetting: -30, defringe: { purple: { amount: 40 } } });
  });

  it("ダブルクリックで既定へ戻す（中点は 50）。全部既定なら lens ごと消す", async () => {
    await render({ initial: { ...neutralDevelopSettings(null), v: 9, lens: { vignetting: 20, vignettingMidpoint: 30 } } });
    await act(async () => {
      slider("中点").dispatchEvent(new MouseEvent("dblclick", { bubbles: true }));
    });
    expect(changes.at(-1)?.phase).toBe("commit");
    expect(changes.at(-1)?.settings.lens).toEqual({ vignetting: 20, vignettingMidpoint: 50 });
    await act(async () => {
      slider("周辺光量").dispatchEvent(new MouseEvent("dblclick", { bubbles: true }));
    });
    expect("lens" in (changes.at(-1)?.settings ?? {})).toBe(false);
    expect(changes.at(-1)?.settings.v).toBe(1);
  });

  it("「色収差を除去」を押すと切り替えて commit する", async () => {
    await render({ initial: neutralDevelopSettings(null) });
    await click(chromaticSwitch());
    expect(changes).toHaveLength(1);
    expect(changes[0]?.phase).toBe("commit");
    expect(changes[0]?.settings.lens).toEqual({ removeChromaticAberration: true });
    expect(chromaticSwitch().getAttribute("aria-checked")).toBe("true");
    await click(chromaticSwitch());
    expect("lens" in (changes.at(-1)?.settings ?? {})).toBe(false);
  });

  it("押せない間はスライダー・スイッチを押せない", async () => {
    await render({ initial: { ...neutralDevelopSettings(null), v: 9, lens: { distortion: 5 } }, disabled: true });
    expect(sliders().every((input) => input.disabled)).toBe(true);
    expect(chromaticSwitch().disabled).toBe(true);
    await click(chromaticSwitch());
    expect(changes).toEqual([]);
  });
});

describe("PhotoEditingLensSection（効果の群の下の節）", () => {
  function toggle(): HTMLButtonElement {
    const found = container.querySelector<HTMLButtonElement>("h4 button");
    if (!found) throw new Error("section toggle not found");
    return found;
  }

  it("既定は閉じる。開くと中身を描き、開いたことを端末に覚える", async () => {
    await render({ initial: neutralDevelopSettings(null), section: true });
    expect(toggle().textContent).toBe("レンズ");
    expect(toggle().getAttribute("aria-expanded")).toBe("false");
    expect(container.querySelector('[data-testid="photo-lens"]')).toBeNull();
    expect(resetButton().disabled).toBe(true);
    await click(toggle());
    expect(container.querySelector('[data-testid="photo-lens"]')).not.toBeNull();
    expect(window.localStorage.getItem(PHOTO_EDITING_ADVANCED_SECTIONS_STORAGE_KEY)).toBe('["lens"]');
  });

  it("「初期化」はレンズ補正の全部（中点・色相の範囲も）を外して commit する（ほかの補正は残す）", async () => {
    await render({
      initial: {
        ...neutralDevelopSettings(null),
        v: 9,
        exposure: 0.5,
        lens: { distortion: 5, vignettingMidpoint: 20, defringe: { green: { amount: 10, hueLo: 35, hueHi: 65 } } },
      },
      section: true,
    });
    expect(resetButton().disabled).toBe(false);
    await click(resetButton());
    expect(changes).toHaveLength(1);
    expect(changes[0]?.phase).toBe("commit");
    expect("lens" in (changes[0]?.settings ?? {})).toBe(false);
    expect(changes[0]?.settings.exposure).toBe(0.5);
    expect(changes[0]?.settings.v).toBe(1);
    expect(resetButton().disabled).toBe(true);
  });
});

describe("BrowserPhotoEditingAdjustments の効果の下", () => {
  it("効果の群の直後に「レンズ」の節を置く", async () => {
    await act(async () => {
      root.render(
        <BrowserPhotoEditingAdjustments
          canEdit
          canReset={false}
          resetDone={false}
          canUndo={false}
          canRedo={false}
          controlsDisabled={false}
          busy={false}
          work={null}
          raw={false}
          settings={neutralDevelopSettings()}
          visibleKeys={BROWSER_EFFECTS_ADJUSTMENT_KEYS}
          afterGroup={{ effects: <section data-testid="lens-section" /> }}
          onReset={vi.fn()}
          onUndo={vi.fn()}
          onRedo={vi.fn()}
          onRetryWork={vi.fn()}
          onSettingsChange={vi.fn()}
        />,
      );
    });
    const lens = container.querySelector('[data-testid="lens-section"]');
    expect(lens?.previousElementSibling?.querySelector("h4")?.textContent).toBe("効果");
  });
});
