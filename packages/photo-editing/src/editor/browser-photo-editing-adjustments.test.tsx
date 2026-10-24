// @vitest-environment jsdom

import { act } from "react";
import { createPortal } from "react-dom";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { PhotoEditingSettings } from "../photo-editing-types";
import { neutralDevelopSettings } from "../develop-engine/develop-settings";

import { BrowserPhotoEditingAdjustments } from "./browser-photo-editing-adjustments";
import { BROWSER_CANVAS_ADJUSTMENT_KEYS, BROWSER_EFFECTS_ADJUSTMENT_KEYS } from "./browser-photo-editing-model";
import type { PhotoEditingSettingsUpdate, PhotoEditingSliderPhase } from "./photo-editing-adjustment-controls";

/**
 * ブラウザ版の右パネル（niho-photo#51）。道具の切り替えのピルは置かず（右端の帯が受け持つ）、一番上は見出し行（今の面の名前と
 * ↶ ↷ ⋯ 初期化）。補正の面は 見出し行 → 自動 / 白黒のチップ → プリセットの行 → ライト / カラー / 効果、プリセットの面は 見出し行 →
 * プリセットの一覧。
 */

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const NEUTRAL = neutralDevelopSettings();

type AdjustmentsProps = Parameters<typeof BrowserPhotoEditingAdjustments>[0];

let container: HTMLDivElement;
let root: Root;
let changes: { update: PhotoEditingSettingsUpdate; phase: PhotoEditingSliderPhase }[];

/** プリセットの部品の代わり（描かれた形を data 属性に出し、ボタンで一覧を開く）。 */
function fakePresets(): NonNullable<AdjustmentsProps["presets"]> {
  return (view) => (
    <div data-testid="presets" data-variant={view.variant}>
      {view.onOpenPanel ? (
        <button type="button" onClick={view.onOpenPanel}>
          プリセットの行
        </button>
      ) : null}
    </div>
  );
}

async function render(extra: Partial<AdjustmentsProps> = {}) {
  const props: AdjustmentsProps = {
    canEdit: true,
    canReset: false,
    resetDone: false,
    canUndo: false,
    canRedo: false,
    controlsDisabled: false,
    busy: false,
    work: null,
    raw: false,
    settings: NEUTRAL,
    visibleKeys: BROWSER_EFFECTS_ADJUSTMENT_KEYS,
    onReset: vi.fn(),
    onUndo: vi.fn(),
    onRedo: vi.fn(),
    onRetryWork: vi.fn(),
    onSettingsChange: (update, phase) => {
      changes.push({ update, phase });
    },
    ...extra,
  };
  await act(async () => {
    root.render(<BrowserPhotoEditingAdjustments {...props} />);
  });
}

function aside(): HTMLElement {
  const found = container.querySelector<HTMLElement>('aside[aria-label="補正"]');
  if (!found) throw new Error("adjustments panel not found");
  return found;
}

function heading(): string | null {
  return aside().querySelector("h2")?.textContent ?? null;
}

function quickRow(): HTMLElement | null {
  return container.querySelector<HTMLElement>('[role="group"][aria-label="自動と白黒"]');
}

function chip(label: string): HTMLButtonElement | undefined {
  return Array.from(quickRow()?.querySelectorAll<HTMLButtonElement>("button") ?? []).find(
    (candidate) => candidate.textContent === label,
  );
}

function presets(): HTMLElement | null {
  return container.querySelector<HTMLElement>('[data-testid="presets"]');
}

function groupTitles(): string[] {
  return Array.from(container.querySelectorAll<HTMLButtonElement>("h4 > button")).map((button) => button.textContent ?? "");
}

async function click(element: Element | null | undefined) {
  if (!element) throw new Error("element not found");
  await act(async () => {
    element.dispatchEvent(new MouseEvent("click", { bubbles: true }));
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
  window.localStorage.clear();
});

describe("補正の面", () => {
  it("見出し行（「補正」と ↶ ↷）→ 自動 / 白黒 → プリセットの行 → ライト / カラー / 効果。道具のピルは置かない", async () => {
    await render({
      auto: { pressed: false, disabled: false, onToggle: vi.fn() },
      presets: fakePresets(),
    });
    expect(aside().className).toContain("px-3");
    expect(heading()).toBe("補正");
    expect(container.querySelector('button[aria-label="取り消す"]')).not.toBeNull();
    expect(container.querySelector('[aria-label="編集の道具"]')).toBeNull();
    const buttonTexts = Array.from(container.querySelectorAll("button")).map((button) => button.textContent);
    expect(buttonTexts).not.toContain("切り抜き");
    expect(buttonTexts).not.toContain("背景除去");

    expect(Array.from(quickRow()?.querySelectorAll("button") ?? []).map((button) => button.textContent)).toEqual(["自動", "白黒"]);
    expect(presets()?.dataset.variant).toBe("row");
    expect(groupTitles()).toEqual(["ライト", "カラー", "効果"]);
    // 白黒は群の中に描かない（チップだけ）
    expect(container.querySelector('button[role="switch"]')).toBeNull();

    // 並び: 見出し → チップ → プリセットの行 → 群
    const order = [aside().querySelector("h2"), quickRow(), presets(), container.querySelector("h4")];
    for (let index = 1; index < order.length; index += 1) {
      const previous = order[index - 1];
      const current = order[index];
      if (!previous || !current) throw new Error("element not found");
      expect(previous.compareDocumentPosition(current) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    }
  });

  it("白黒のチップは aria-pressed で今の白黒を示し、押すと commit で切り替える", async () => {
    await render({ settings: NEUTRAL });
    const grayscale = chip("白黒");
    expect(grayscale?.getAttribute("aria-pressed")).toBe("false");
    await click(grayscale);
    expect(changes).toHaveLength(1);
    expect(changes[0]?.phase).toBe("commit");
    expect(changes[0]?.update(NEUTRAL)).toEqual({ ...NEUTRAL, grayscale: true });

    const gray: PhotoEditingSettings = { ...NEUTRAL, grayscale: true, saturation: -10 };
    await render({ settings: gray });
    expect(chip("白黒")?.getAttribute("aria-pressed")).toBe("true");
    // 白黒の間は彩度を押せない（値は保つ）
    expect(container.querySelector<HTMLInputElement>('input[type="range"][aria-label="彩度"]')?.disabled).toBe(true);
    await click(chip("白黒"));
    const turnedOff = changes.at(-1)?.update(gray);
    expect(changes.at(-1)?.phase).toBe("commit");
    expect(turnedOff).toMatchObject({ saturation: -10 });
    expect(Object.hasOwn(turnedOff ?? {}, "grayscale")).toBe(false);
  });

  it("押せない間（閲覧のみなど）は白黒のチップも押せない", async () => {
    await render({ controlsDisabled: true });
    expect(chip("白黒")?.disabled).toBe(true);
    await click(chip("白黒"));
    expect(changes).toEqual([]);
  });

  it("白黒を描けない写真（効果の項目が無い）は自動だけ。自動も無い S1 の canvas はチップの行もプリセットの行も出さない", async () => {
    await render({ visibleKeys: undefined, auto: { pressed: true, disabled: false, onToggle: vi.fn() }, presets: fakePresets() });
    expect(Array.from(quickRow()?.querySelectorAll("button") ?? []).map((button) => button.textContent)).toEqual(["自動"]);
    expect(chip("自動")?.getAttribute("aria-pressed")).toBe("true");

    await render({ visibleKeys: BROWSER_CANVAS_ADJUSTMENT_KEYS, auto: undefined, presets: undefined });
    expect(quickRow()).toBeNull();
    expect(presets()).toBeNull();
    expect(heading()).toBe("補正");
  });

  it("自動のチップを押すと onToggle を呼ぶ", async () => {
    const onToggle = vi.fn();
    await render({ auto: { pressed: false, disabled: false, onToggle } });
    await click(chip("自動"));
    expect(onToggle).toHaveBeenCalledTimes(1);
  });

  it("プリセットの行から onOpenPresets を呼ぶ", async () => {
    const onOpenPresets = vi.fn();
    await render({ presets: fakePresets(), onOpenPresets });
    await click(presets()?.querySelector("button"));
    expect(onOpenPresets).toHaveBeenCalledTimes(1);
  });
});

describe("プリセットの面", () => {
  it("見出しは「プリセット」で、一覧（panel）だけを描く（チップ・群は描かない）", async () => {
    await render({ panel: "presets", presets: fakePresets(), auto: { pressed: false, disabled: false, onToggle: vi.fn() } });
    expect(heading()).toBe("プリセット");
    expect(container.querySelectorAll('[data-testid="presets"]')).toHaveLength(1);
    expect(presets()?.dataset.variant).toBe("panel");
    expect(quickRow()).toBeNull();
    expect(groupTitles()).toEqual([]);
    expect(container.querySelector('input[type="range"]')).toBeNull();
    // ↶ ↷ は見出し行に残す
    expect(container.querySelector('button[aria-label="取り消す"]')).not.toBeNull();
  });

  it("見出し行の ⋯ はプリセットのメニューだけ（補正のメニューの ⋯ と 2 つ並べない。niho-photo#49）", async () => {
    const clipboard = { canCopy: true, canPaste: true, onCopy: vi.fn(), onPaste: vi.fn() };
    // 一覧の部品は、受け口（actionsSlot）があれば ⋯ をそこへ描く
    const presetsWithMenu: NonNullable<AdjustmentsProps["presets"]> = (view) => (
      <div data-testid="presets" data-variant={view.variant}>
        {view.actionsSlot
          ? createPortal(
              <button type="button" aria-label="プリセットの操作" aria-haspopup="menu">
                ⋯
              </button>,
              view.actionsSlot,
            )
          : null}
      </div>
    );
    const menus = () =>
      Array.from(aside().querySelectorAll('button[aria-haspopup="menu"]')).map((button) => button.getAttribute("aria-label"));
    const headerRow = () => aside().querySelector("h2")?.parentElement ?? null;

    await render({ panel: "presets", presets: presetsWithMenu, clipboard });
    expect(menus()).toEqual(["プリセットの操作"]);
    expect(headerRow()?.querySelector('button[aria-label="プリセットの操作"]')).not.toBeNull();
    expect(presets()?.querySelector('button[aria-label="プリセットの操作"]')).toBeNull();

    // 補正の面の見出し行は補正のメニュー（コピー / 貼り付け）のまま
    await render({ panel: "adjust", presets: presetsWithMenu, clipboard });
    expect(menus()).toEqual(["補正のメニュー"]);
  });

  it("プリセットの部品が無い写真は、プリセットの面を選んでいても補正の面", async () => {
    await render({ panel: "presets", presets: undefined });
    expect(heading()).toBe("補正");
    expect(groupTitles()).toEqual(["ライト", "カラー", "効果"]);
  });
});

describe("切り抜き・背景除去の面", () => {
  it("切り抜きの間は見出しが「切り抜き」で、切り抜きの道具だけを出す", async () => {
    await render({ tool: "crop", panel: "presets", presets: fakePresets(), cropTools: <p>切り抜きの道具</p> });
    expect(heading()).toBe("切り抜き");
    expect(aside().textContent).toContain("切り抜きの道具");
    expect(presets()).toBeNull();
    expect(quickRow()).toBeNull();
    expect(groupTitles()).toEqual([]);
  });

  it("背景除去の間は見出しが「背景除去」で、背景除去の道具だけを出す", async () => {
    await render({ tool: "cutout", presets: fakePresets(), cutoutTools: <p>背景除去の道具</p> });
    expect(heading()).toBe("背景除去");
    expect(aside().textContent).toContain("背景除去の道具");
    expect(presets()).toBeNull();
    expect(groupTitles()).toEqual([]);
  });
});

describe("ヒストグラム（niho-photo#36）", () => {
  const histogram = <div data-testid="histogram">ヒストグラム</div>;

  function histogramBox(): HTMLElement | null {
    return container.querySelector<HTMLElement>('[data-testid="histogram"]');
  }

  it("渡さなければ何も増えない（従来と同じ DOM）", async () => {
    await render();
    expect(histogramBox()).toBeNull();
    expect(aside().querySelector(".sticky")).toBeNull();
    expect(aside().className).toContain("py-2");
    expect(aside().firstElementChild?.querySelector("h2")).not.toBeNull();
  });

  it("補正の面では、パネルの一番上（見出し行より上）に置き、パネルを送っても上端に残す", async () => {
    await render({ histogram, auto: { pressed: false, disabled: false, onToggle: vi.fn() }, presets: fakePresets() });
    const box = histogramBox();
    expect(box).not.toBeNull();
    expect(aside().firstElementChild).toBe(box?.parentElement);
    expect(box?.parentElement?.className).toContain("sticky");
    expect(box?.parentElement?.className).toContain("top-0");
    // 上の余白は枠（sticky）の中に持たせる（パネル側の py-2 は下だけ）
    expect(aside().className).toContain("pb-2");
    expect(aside().className).not.toContain("py-2");
    // 並び: ヒストグラム → 見出し → チップ → プリセットの行 → 群
    const order = [box, aside().querySelector("h2"), quickRow(), presets(), container.querySelector("h4")];
    for (let index = 1; index < order.length; index += 1) {
      const previous = order[index - 1];
      const current = order[index];
      if (!previous || !current) throw new Error("element not found");
      expect(previous.compareDocumentPosition(current) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    }
  });

  it("どの道具・面のときも同じ場所に出す（プリセット / 切り抜き / 背景除去）", async () => {
    await render({ histogram, panel: "presets", presets: fakePresets() });
    expect(heading()).toBe("プリセット");
    expect(aside().firstElementChild).toBe(histogramBox()?.parentElement);

    await render({ histogram, tool: "crop", cropTools: <p>切り抜きの道具</p> });
    expect(heading()).toBe("切り抜き");
    expect(aside().firstElementChild).toBe(histogramBox()?.parentElement);

    await render({ histogram, tool: "cutout", cutoutTools: <p>背景除去の道具</p> });
    expect(heading()).toBe("背景除去");
    expect(aside().firstElementChild).toBe(histogramBox()?.parentElement);
    expect(container.querySelectorAll('[data-testid="histogram"]')).toHaveLength(1);
  });

  it("狭い幅（スマホ）では右パネルごと出ない（hidden lg:block の中に置く）", async () => {
    await render({ histogram });
    expect(aside().className).toContain("hidden");
    expect(aside().className).toContain("lg:block");
    expect(aside().contains(histogramBox())).toBe(true);
  });
});

describe("版の面の ↶ ↷", () => {
  it("版の面には ↶ ↷ を出し（切り替えが 1 回の取り消し単位）、押すと取り消し / やり直しを呼ぶ", async () => {
    const onUndo = vi.fn();
    const onRedo = vi.fn();
    await render({ panel: "versions", versions: <p>版の中身</p>, canUndo: true, canRedo: true, onUndo, onRedo });
    const versionsAside = container.querySelector<HTMLElement>('aside[aria-label="版"]');
    if (!versionsAside) throw new Error("versions panel not found");
    const undo = versionsAside.querySelector<HTMLButtonElement>('button[aria-label="取り消す"]');
    const redo = versionsAside.querySelector<HTMLButtonElement>('button[aria-label="やり直す"]');
    expect(undo?.disabled).toBe(false);
    expect(redo?.disabled).toBe(false);
    await act(async () => undo?.click());
    await act(async () => redo?.click());
    expect(onUndo).toHaveBeenCalledTimes(1);
    expect(onRedo).toHaveBeenCalledTimes(1);
    // 初期化・⋯ のメニューは版の面には出さない
    expect(versionsAside.textContent).not.toContain("初期化");
  });

  it("取り消せるものが無い間は押せず、閲覧のみ・操作中も押せない。情報の面には出さない", async () => {
    await render({ panel: "versions", versions: <p>版の中身</p>, canUndo: false, canRedo: false });
    let versionsAside = container.querySelector<HTMLElement>('aside[aria-label="版"]');
    expect(versionsAside?.querySelector<HTMLButtonElement>('button[aria-label="取り消す"]')?.disabled).toBe(true);
    expect(versionsAside?.querySelector<HTMLButtonElement>('button[aria-label="やり直す"]')?.disabled).toBe(true);
    await render({ panel: "versions", versions: <p>版の中身</p>, canUndo: true, canRedo: true, controlsDisabled: true });
    versionsAside = container.querySelector<HTMLElement>('aside[aria-label="版"]');
    expect(versionsAside?.querySelector<HTMLButtonElement>('button[aria-label="取り消す"]')?.disabled).toBe(true);
    await render({ panel: "info", info: <p>情報の中身</p>, canUndo: true, canRedo: true });
    expect(container.querySelector('aside[aria-label="情報"]')?.querySelectorAll("button")).toHaveLength(0);
  });
});
