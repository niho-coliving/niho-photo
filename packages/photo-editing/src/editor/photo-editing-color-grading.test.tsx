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
import { PhotoEditingColorGrading, PhotoEditingColorGradingSection } from "./photo-editing-color-grading";

/**
 * カラーグレーディング（niho-photo#39）の中身と節。帯の 4 択（シャドウ / 中間調 / ハイライト / 全体）で、色相環と色相・彩度・輝度の
 * スライダーに見せる帯を替える。最下段のブレンド・バランスは 4 つの帯に共通。色相環はドラッグの間 `drag`・離して `commit`、キーは
 * 1 回ずつ `commit`。節は既定で閉じ、見出しの横の「初期化」は colorGrading だけを戻す。
 */

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLDivElement;
let root: Root;
let changes: { settings: PhotoEditingSettings; phase: PhotoEditingSliderPhase }[];

type HarnessProps = { initial: PhotoEditingSettings; disabled?: boolean; section?: boolean; reset?: boolean };

/** 変更の通知を受けて設定を持ち替える画面（`update` は呼ばれた時点の最新に当てる）。 */
function Harness(props: HarnessProps) {
  const [settings, setSettings] = useState(props.initial);
  const settingsRef = useRef(props.initial);
  const gradingProps = {
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
    <PhotoEditingColorGradingSection {...gradingProps} />
  ) : (
    <PhotoEditingColorGrading {...gradingProps} reset={props.reset} />
  );
}

async function render(props: HarnessProps) {
  await act(async () => {
    root.render(<Harness {...props} />);
  });
}

function zoneButton(label: string): HTMLButtonElement {
  const found = Array.from(
    container.querySelectorAll<HTMLButtonElement>('[role="group"][aria-label="明るさの帯"] button'),
  ).find((button) => button.textContent?.startsWith(label));
  if (!found) throw new Error(`zone button not found: ${label}`);
  return found;
}

function slider(label: string): HTMLInputElement {
  const found = container.querySelector<HTMLInputElement>(`input[type="range"][aria-label="${label}"]`);
  if (!found) throw new Error(`slider not found: ${label}`);
  return found;
}

function wheel(): HTMLElement {
  const found = container.querySelector<HTMLElement>('[data-testid="photo-color-wheel"]');
  if (!found) throw new Error("wheel not found");
  return found;
}

function thumb(): HTMLElement {
  const found = container.querySelector<HTMLElement>('[role="slider"][aria-roledescription="色相環"]');
  if (!found) throw new Error("wheel thumb not found");
  return found;
}

function resetButton(): HTMLButtonElement {
  const found = container.querySelector<HTMLButtonElement>('button[aria-label="カラーグレーディングを初期化"]');
  if (!found) throw new Error("reset button not found");
  return found;
}

async function click(element: Element) {
  await act(async () => {
    element.dispatchEvent(new MouseEvent("click", { bubbles: true }));
  });
}

async function key(element: Element, keyName: string, init: KeyboardEventInit = {}) {
  await act(async () => {
    element.dispatchEvent(new KeyboardEvent("keydown", { key: keyName, bubbles: true, cancelable: true, ...init }));
  });
}

/** 環を 200 × 200（中心 100, 100）の位置に置いたことにする。 */
function placeWheel() {
  vi.spyOn(wheel(), "getBoundingClientRect").mockReturnValue({
    left: 0,
    top: 0,
    width: 200,
    height: 200,
    right: 200,
    bottom: 200,
    x: 0,
    y: 0,
    toJSON: () => ({}),
  } as DOMRect);
}

async function pointer(type: "pointerdown" | "pointermove" | "pointerup", target: Element, x: number, y: number) {
  await act(async () => {
    target.dispatchEvent(
      new PointerEvent(type, { bubbles: true, cancelable: true, pointerId: 1, pointerType: "mouse", button: 0, clientX: x, clientY: y }),
    );
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

describe("PhotoEditingColorGrading", () => {
  it("帯の 4 択（既定はシャドウ）、色相環、色相・彩度・輝度、ブレンド・バランスを縦に並べる", async () => {
    await render({ initial: neutralDevelopSettings(null) });
    expect(
      Array.from(container.querySelectorAll('[role="group"][aria-label="明るさの帯"] button')).map((b) => b.textContent),
    ).toEqual(["シャドウ", "中間調", "ハイライト", "全体"]);
    expect(zoneButton("シャドウ").getAttribute("aria-pressed")).toBe("true");
    // 押せる高さは 44px（見た目 32px に上下 6px を足す）
    expect(zoneButton("シャドウ").className).toContain("after:-inset-y-1.5");
    expect(Array.from(container.querySelectorAll('input[type="range"]')).map((input) => input.getAttribute("aria-label"))).toEqual([
      "色相",
      "彩度",
      "輝度",
      "ブレンド",
      "バランス",
    ]);
    expect(slider("色相").max).toBe("359");
    expect(slider("彩度").max).toBe("100");
    expect(slider("輝度").min).toBe("-100");
    expect(slider("ブレンド").value).toBe("100");
    expect(slider("バランス").value).toBe("0");
    expect(container.querySelector('[role="group"][aria-label="シャドウの色と輝度"]')).not.toBeNull();
    // 色相環: 読み上げは帯の名前と値。説明を添える。環の色はエンジンの色の向き（conic-gradient）
    expect(thumb().getAttribute("aria-label")).toBe("シャドウの色（色相 0°、彩度 0）");
    expect(thumb().getAttribute("tabindex")).toBe("0");
    expect(document.getElementById(thumb().getAttribute("aria-describedby") ?? "")?.textContent).toContain("ドラッグ");
    expect(wheel().style.backgroundImage).toContain("conic-gradient");
    expect(wheel().style.backgroundImage).toContain("radial-gradient");
    // 色相の線は環の色の帯
    expect(slider("色相").closest<HTMLElement>("[data-color-grading-slider]")?.style.getPropertyValue("--photo-editing-grading-track")).toContain(
      "linear-gradient",
    );
  });

  it("4 択を替えると、その帯の値を出す。既定でない値がある帯には「調整あり」の印", async () => {
    await render({
      initial: {
        ...neutralDevelopSettings(null),
        colorGrading: {
          shadow: { hue: 220, saturation: 40, luminance: -10 },
          highlight: { hue: 35, saturation: 45, luminance: 0 },
          blending: 60,
          balance: -20,
        },
      },
    });
    expect(slider("色相").value).toBe("220");
    expect(slider("彩度").value).toBe("40");
    expect(slider("輝度").value).toBe("-10");
    expect(container.querySelector('button[aria-label="色相の値 220° を入力"]')).not.toBeNull();
    expect(thumb().getAttribute("aria-label")).toBe("シャドウの色（色相 220°、彩度 40）");
    await click(zoneButton("ハイライト"));
    expect(zoneButton("ハイライト").getAttribute("aria-pressed")).toBe("true");
    expect(slider("色相").value).toBe("35");
    expect(slider("彩度").value).toBe("45");
    expect(thumb().getAttribute("aria-label")).toBe("ハイライトの色（色相 35°、彩度 45）");
    // ブレンド・バランスは帯を替えても同じ
    expect(slider("ブレンド").value).toBe("60");
    expect(slider("バランス").value).toBe("-20");
    expect(container.querySelectorAll('[data-testid="photo-color-grading-zone-edited"]')).toHaveLength(2);
    expect(zoneButton("シャドウ").textContent).toContain("調整あり");
    expect(zoneButton("中間調").textContent).not.toContain("調整あり");
    // 切り替えは値を変えない
    expect(changes).toEqual([]);
  });

  it("色相環: 押した位置へ動かしてドラッグの間は drag、離したら commit。右が 0°・上が 90°、中心からの距離が彩度", async () => {
    await render({ initial: neutralDevelopSettings(null) });
    placeWheel();
    // 右へ 50px（半径 100 の半分）: 色相 0°・彩度 50
    await pointer("pointerdown", wheel(), 150, 100);
    // 真上の縁の外: 色相 90°・彩度 100
    await pointer("pointermove", wheel(), 100, -20);
    await pointer("pointerup", wheel(), 100, -20);
    expect(changes.map((change) => change.phase)).toEqual(["drag", "drag", "commit"]);
    expect(changes[0]?.settings.colorGrading).toEqual({ shadow: { hue: 0, saturation: 50, luminance: 0 } });
    expect(changes.at(-1)?.settings.colorGrading).toEqual({ shadow: { hue: 90, saturation: 100, luminance: 0 } });
    expect(slider("色相").value).toBe("90");
    expect(slider("彩度").value).toBe("100");
    // 左下（225°）
    await pointer("pointerdown", wheel(), 100 - 30, 100 + 30);
    await pointer("pointerup", wheel(), 100 - 30, 100 + 30);
    expect(changes.at(-1)?.settings.colorGrading).toEqual({ shadow: { hue: 225, saturation: 42, luminance: 0 } });
    expect(document.activeElement).toBe(thumb());
  });

  it("色相環のキー: ←→ で色相、↑↓ で彩度（Shift で 10）、Delete で彩度 0。1 回ずつ commit し、写真の送りに渡さない", async () => {
    await render({ initial: { ...neutralDevelopSettings(null), colorGrading: { midtone: { hue: 5, saturation: 20 } } } });
    await click(zoneButton("中間調"));
    // ページ側のキー（写真の送りなど）には届かない
    const outer = vi.fn();
    window.addEventListener("keydown", outer);
    await key(thumb(), "ArrowLeft", { shiftKey: true });
    expect(changes.at(-1)?.settings.colorGrading).toEqual({ midtone: { hue: 355, saturation: 20, luminance: 0 } });
    await key(thumb(), "ArrowRight");
    await key(thumb(), "ArrowUp", { shiftKey: true });
    await key(thumb(), "ArrowDown");
    expect(changes.at(-1)?.settings.colorGrading).toEqual({ midtone: { hue: 356, saturation: 29, luminance: 0 } });
    await key(thumb(), "Delete");
    expect(changes.at(-1)?.settings.colorGrading).toEqual({ midtone: { hue: 356, saturation: 0, luminance: 0 } });
    expect(changes.every((change) => change.phase === "commit")).toBe(true);
    expect(changes).toHaveLength(5);
    window.removeEventListener("keydown", outer);
    expect(outer).not.toHaveBeenCalled();
    expect(thumb().getAttribute("aria-valuetext")).toBe("色相 356°、彩度 0");
  });

  it("つまみのダブルクリックだけで彩度 0（色相は残す）。スライダーのダブルクリックは既定値（ブレンドは 100）", async () => {
    await render({
      initial: { ...neutralDevelopSettings(null), colorGrading: { shadow: { hue: 210, saturation: 40 }, blending: 30 } },
    });
    await act(async () => {
      wheel().dispatchEvent(new MouseEvent("dblclick", { bubbles: true }));
    });
    expect(changes).toHaveLength(0);
    await act(async () => {
      thumb().dispatchEvent(new MouseEvent("dblclick", { bubbles: true }));
    });
    expect(changes.at(-1)).toEqual({
      phase: "commit",
      settings: expect.objectContaining({ colorGrading: { shadow: { hue: 210, saturation: 0, luminance: 0 }, blending: 30 } }),
    });
    await act(async () => {
      slider("ブレンド").dispatchEvent(new MouseEvent("dblclick", { bubbles: true }));
    });
    expect(changes.at(-1)?.settings.colorGrading).toEqual({ shadow: { hue: 210, saturation: 0, luminance: 0 }, blending: 100 });
    expect(slider("ブレンド").value).toBe("100");
  });

  it("環のつまみ以外をダブルクリックしても、先行した位置変更以外の commit を足さない", async () => {
    await render({ initial: { ...neutralDevelopSettings(null), colorGrading: { shadow: { hue: 210, saturation: 40 } } } });
    placeWheel();
    await pointer("pointerdown", wheel(), 180, 100);
    await pointer("pointerup", wheel(), 180, 100);
    const changesAfterClick = changes.length;
    await act(async () => {
      wheel().dispatchEvent(new MouseEvent("dblclick", { bubbles: true }));
    });
    expect(changes).toHaveLength(changesAfterClick);
    expect(changes.at(-1)?.settings.colorGrading).toEqual({ shadow: { hue: 0, saturation: 80, luminance: 0 } });
  });

  it("輝度のスライダーで中間調の輝度を書く（エンジン 0.19.0 から描く）", async () => {
    await render({ initial: neutralDevelopSettings(null) });
    await click(zoneButton("中間調"));
    const input = slider("輝度");
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set?.call(input, "25");
      input.dispatchEvent(new Event("input", { bubbles: true }));
      input.dispatchEvent(new Event("change", { bubbles: true }));
    });
    expect(changes.map((change) => change.phase)).toEqual(["input", "commit"]);
    expect(changes.at(-1)?.settings.colorGrading).toEqual({ midtone: { hue: 0, saturation: 0, luminance: 25 } });
    expect(container.querySelector('button[aria-label="輝度の値 +25 を入力"]')).not.toBeNull();
  });

  it("押せない間は色相環・スライダー・「初期化」を押せない（4 択は見るだけなので押せる）", async () => {
    await render({
      initial: { ...neutralDevelopSettings(null), colorGrading: { highlight: { hue: 35, saturation: 40 } } },
      disabled: true,
      reset: true,
    });
    placeWheel();
    expect(Array.from(container.querySelectorAll<HTMLInputElement>('input[type="range"]')).every((input) => input.disabled)).toBe(true);
    expect(resetButton().disabled).toBe(true);
    expect(thumb().getAttribute("tabindex")).toBe("-1");
    expect(thumb().getAttribute("aria-disabled")).toBe("true");
    await pointer("pointerdown", wheel(), 150, 100);
    await pointer("pointerup", wheel(), 150, 100);
    await key(thumb(), "ArrowRight");
    await click(zoneButton("ハイライト"));
    expect(slider("色相").value).toBe("35");
    expect(changes).toEqual([]);
  });

  it("`reset` を渡した面（スマホの道具）は、色相環の右上に「初期化」。押すと colorGrading ごと消して commit", async () => {
    await render({ initial: neutralDevelopSettings(null), reset: true });
    expect(resetButton().disabled).toBe(true);
    placeWheel();
    await pointer("pointerdown", wheel(), 150, 100);
    await pointer("pointerup", wheel(), 150, 100);
    expect(resetButton().disabled).toBe(false);
    await click(resetButton());
    expect(changes.at(-1)?.phase).toBe("commit");
    expect("colorGrading" in (changes.at(-1)?.settings ?? {})).toBe(false);
    expect(resetButton().disabled).toBe(true);
  });
});

describe("PhotoEditingColorGradingSection（カラーミキサーの下の節）", () => {
  function toggle(): HTMLButtonElement {
    const found = container.querySelector<HTMLButtonElement>("h4 button");
    if (!found) throw new Error("section toggle not found");
    return found;
  }

  it("既定は閉じる（中身を描かない）。見出しの横の「初期化」は閉じていても出す", async () => {
    await render({ initial: { ...neutralDevelopSettings(null), colorGrading: { global: { luminance: 20 } } }, section: true });
    expect(toggle().textContent).toBe("カラーグレーディング");
    expect(toggle().getAttribute("aria-expanded")).toBe("false");
    expect(container.querySelector('[data-testid="photo-color-grading"]')).toBeNull();
    expect(resetButton().disabled).toBe(false);
    expect(resetButton().textContent).toBe("初期化");
  });

  it("開くと中身を描き、開いたことを端末に覚える", async () => {
    await render({ initial: neutralDevelopSettings(null), section: true });
    await click(toggle());
    expect(container.querySelector('[data-testid="photo-color-grading"]')).not.toBeNull();
    expect(window.localStorage.getItem(PHOTO_EDITING_ADVANCED_SECTIONS_STORAGE_KEY)).toBe('["colorGrading"]');
    act(() => root.unmount());
    root = createRoot(container);
    await render({ initial: neutralDevelopSettings(null), section: true });
    expect(toggle().getAttribute("aria-expanded")).toBe("true");
  });

  it("「初期化」は colorGrading だけを戻して commit する（ほかの補正は残す）。全部既定なら押せない", async () => {
    await render({
      initial: {
        ...neutralDevelopSettings(null),
        exposure: 0.5,
        hsl: ["blue", { hue: 0, saturation: -20, luminance: 0 }],
        colorGrading: { shadow: { hue: 220, saturation: 40 }, balance: 10 },
      },
      section: true,
    });
    await click(resetButton());
    expect(changes).toHaveLength(1);
    expect(changes[0]?.phase).toBe("commit");
    expect("colorGrading" in (changes[0]?.settings ?? {})).toBe(false);
    expect(changes[0]?.settings.exposure).toBe(0.5);
    expect(changes[0]?.settings.hsl).toEqual(["blue", { hue: 0, saturation: -20, luminance: 0 }]);
    expect(resetButton().disabled).toBe(true);
  });
});

describe("BrowserPhotoEditingAdjustments のカラーの下（PC の並び）", () => {
  it("カラー → カラーミキサー → カラーグレーディング → ポイントカラー → 効果", async () => {
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
      // ワークベンチと同じく、カラーミキサーの節の後ろにカラーグレーディングの節を並べて渡す
      afterGroup: {
        color: (
          <>
            <section data-testid="hsl-section" />
            <PhotoEditingColorGradingSection settings={neutralDevelopSettings()} disabled={false} onSettingsChange={vi.fn()} />
          </>
        ),
      },
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
    const grading = hsl?.nextElementSibling;
    expect(grading?.querySelector("h4")?.textContent).toBe("カラーグレーディング");
    expect(grading?.nextElementSibling?.getAttribute("data-testid")).toBe("point-color");
    expect(grading?.nextElementSibling?.nextElementSibling?.querySelector("h4")?.textContent).toBe("効果");
  });
});
