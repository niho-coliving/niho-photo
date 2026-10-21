// @vitest-environment jsdom

import { act, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { DevelopHealMarkView } from "../develop-engine/develop-heal-editing";
import { neutralDevelopSettings } from "../develop-engine/develop-settings";
import { healRadiusFromDial } from "../photo-editing-heal";

import { BrowserPhotoEditingAdjustments } from "./browser-photo-editing-adjustments";
import { PhotoEditingHealTools } from "./photo-editing-heal-tools";

/**
 * 右パネルの修復の面（niho-photo#44 後半）: 「消す」/「写す」、ブラシの大きさ（対数のダイヤル・表示は %・値の直接入力は %）とぼかし
 * （動かしている間 drag、離して commit）、選んでいる印の 1 行、印の一覧（番号つき・選ぶ / 外す・削除）、0 件・上限、印の表示、
 * 「すべての印を消す」（確かめてから）、幾何のある写真の 1 行、右パネルの見出し行とヒストグラムの置き場。
 */

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLDivElement;
let root: Root;

type ToolsProps = Parameters<typeof PhotoEditingHealTools>[0];

function mark(id: string, mode: DevelopHealMarkView["mode"] = "remove"): DevelopHealMarkView {
  return { id, mode, radius: 0.02, feather: 0.5, points: [[0.2, 0.3]], source: mode === "clone" ? [0.1, 0] : null };
}

function toolsProps(extra: Partial<ToolsProps> = {}): ToolsProps {
  return {
    marks: [mark("h1"), mark("h2", "clone"), mark("h3")],
    selectedId: null,
    brush: { mode: "remove", radius: 0.02, feather: 0.5 },
    disabled: false,
    canAdd: true,
    showMarks: true,
    hasGeometry: false,
    onModeChange: vi.fn(),
    onRadiusChange: vi.fn(),
    onFeatherChange: vi.fn(),
    onSelect: vi.fn(),
    onRemove: vi.fn(),
    onClear: vi.fn(),
    onShowMarksChange: vi.fn(),
    ...extra,
  };
}

async function renderTools(extra: Partial<ToolsProps> = {}): Promise<ToolsProps> {
  const props = toolsProps(extra);
  await act(async () => root.render(<PhotoEditingHealTools {...props} />));
  return props;
}

/** 面と同じく、受け取った値をそのまま見せ直す（スライダーは離したときの値を読み直して確定する） */
function StatefulTools(props: ToolsProps) {
  const [brush, setBrush] = useState(props.brush);
  return (
    <PhotoEditingHealTools
      {...props}
      brush={brush}
      onRadiusChange={(radius, phase) => {
        setBrush((current) => ({ ...current, radius }));
        props.onRadiusChange(radius, phase);
      }}
      onFeatherChange={(feather, phase) => {
        setBrush((current) => ({ ...current, feather }));
        props.onFeatherChange(feather, phase);
      }}
    />
  );
}

async function renderStateful(extra: Partial<ToolsProps> = {}): Promise<ToolsProps> {
  const props = toolsProps(extra);
  await act(async () => root.render(<StatefulTools {...props} />));
  return props;
}

async function settle() {
  await act(async () => {
    for (let index = 0; index < 10; index += 1) await Promise.resolve();
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

async function click(element: Element | null | undefined) {
  if (!element) throw new Error("element not found");
  await act(async () => {
    element.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
  });
  await settle();
}

function buttonByText(text: string, scope: ParentNode = container): HTMLButtonElement | undefined {
  return Array.from(scope.querySelectorAll<HTMLButtonElement>("button")).find(
    (button) => button.textContent?.trim() === text,
  );
}

function range(label: string): HTMLInputElement {
  const found = container.querySelector<HTMLInputElement>(`input[type="range"][aria-label="${label}"]`);
  if (!found) throw new Error(`range not found: ${label}`);
  return found;
}

async function slide(input: HTMLInputElement, value: string, finish: boolean) {
  await act(async () => {
    input.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true }));
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set?.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
  if (!finish) return;
  await act(async () => {
    input.dispatchEvent(new Event("change", { bubbles: true }));
  });
}

function rows(): HTMLLIElement[] {
  return Array.from(container.querySelectorAll<HTMLLIElement>('ol[aria-label="印の一覧"] > li'));
}

beforeEach(() => {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  document.body.innerHTML = "";
});

describe("修復のしかた", () => {
  it("「消す」/「写す」の 2 択（aria-pressed・押せる高さ 44px）。押すと替える。説明の 1 行も替わる", async () => {
    const props = await renderTools();
    const group = container.querySelector('[role="group"]');
    const buttons = Array.from(group?.querySelectorAll<HTMLButtonElement>("button") ?? []);
    expect(buttons.map((button) => button.textContent)).toEqual(["消す", "写す"]);
    expect(buttons.map((button) => button.getAttribute("aria-pressed"))).toEqual(["true", "false"]);
    expect(buttons.every((button) => button.className.includes("min-h-11"))).toBe(true);
    expect(container.textContent).toContain("なぞったところを周りから埋めます。");
    await click(buttons[1]);
    expect(props.onModeChange).toHaveBeenCalledWith("clone");

    await renderTools({ brush: { mode: "clone", radius: 0.02, feather: 0.5 } });
    expect(buttonByText("写す")?.getAttribute("aria-pressed")).toBe("true");
    expect(container.textContent).toContain("写し元は写真の上の丸で動かせます。");
  });
});

describe("ブラシの大きさとぼかし", () => {
  it("大きさは対数のダイヤル（0〜100）で、表示は長辺に対する %。動かしている間は drag、離したら commit", async () => {
    const props = await renderStateful();
    const size = range("ブラシの大きさ");
    expect(size.min).toBe("0");
    expect(size.max).toBe("100");
    expect(size.getAttribute("aria-valuetext")).toBe("2%");
    await slide(size, "80", false);
    expect(props.onRadiusChange).toHaveBeenLastCalledWith(healRadiusFromDial(80), "drag");
    await slide(size, "90", true);
    expect(props.onRadiusChange).toHaveBeenLastCalledWith(healRadiusFromDial(90), "commit");
    expect(size.getAttribute("aria-valuetext")).toBe("8%");
  });

  it("大きさの値の直接入力は %（0.2〜12 に収める）。ダブルクリックで既定（2%）へ", async () => {
    const props = await renderTools();
    await click(container.querySelector('button[aria-label^="ブラシの大きさ"]'));
    const input = container.querySelector<HTMLInputElement>('input[type="text"]');
    if (!input) throw new Error("entry not found");
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set?.call(input, "30");
      input.dispatchEvent(new Event("input", { bubbles: true }));
      input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true }));
    });
    expect(props.onRadiusChange).toHaveBeenLastCalledWith(0.12, "commit");
    await act(async () => {
      range("ブラシの大きさ").dispatchEvent(new MouseEvent("dblclick", { bubbles: true }));
    });
    expect(props.onRadiusChange).toHaveBeenLastCalledWith(0.02, "commit");
  });

  it("ぼかしは 0〜100%", async () => {
    const props = await renderStateful({ brush: { mode: "remove", radius: 0.02, feather: 0.25 } });
    const feather = range("ぼかし");
    expect(feather.getAttribute("aria-valuetext")).toBe("25%");
    await slide(feather, "60", true);
    expect(props.onFeatherChange).toHaveBeenLastCalledWith(0.6, "commit");
  });

  it("印を選んでいる間は、その印の値を変えている 1 行を出す", async () => {
    await renderTools({ selectedId: "h2" });
    expect(container.querySelector('[role="status"]')?.textContent).toBe("印 2 の値を変えています（Esc で選択を外す）。");
    await renderTools();
    expect(container.querySelector('[role="status"]')).toBeNull();
  });

  it("押せない間はどれも押せない", async () => {
    await renderTools({ disabled: true });
    expect(range("ブラシの大きさ").disabled).toBe(true);
    expect(range("ぼかし").disabled).toBe(true);
    expect(buttonByText("消す")?.disabled).toBe(true);
    expect(rows()[0].querySelector("button")?.disabled).toBe(true);
    expect(buttonByText("すべての印を消す")?.disabled).toBe(true);
  });
});

describe("印の一覧", () => {
  it("描いた順の番号と種類の行。押すと選び、選んでいる行をもう一度押すと外す", async () => {
    const props = await renderTools({ selectedId: "h2" });
    expect(rows().map((row) => row.querySelector("button")?.textContent)).toEqual(["1 消す", "2 写す", "3 消す"]);
    const second = rows()[1].querySelector("button");
    expect(second?.getAttribute("aria-pressed")).toBe("true");
    expect(second?.getAttribute("aria-current")).toBe("true");
    expect(rows()[0].querySelector("button")?.getAttribute("aria-pressed")).toBe("false");
    await click(rows()[0].querySelector("button"));
    expect(props.onSelect).toHaveBeenLastCalledWith("h1");
    await click(second);
    expect(props.onSelect).toHaveBeenLastCalledWith(null);
  });

  it("行の削除は確かめずにすぐ消す（押せる大きさ 44px・読み上げ名に番号）", async () => {
    const props = await renderTools();
    const remove = container.querySelector<HTMLButtonElement>('button[aria-label="印 3 を削除"]');
    expect(remove?.className).toContain("h-11");
    expect(remove?.className).toContain("w-11");
    await click(remove);
    expect(props.onRemove).toHaveBeenCalledWith("h3");
    expect(document.body.querySelector('[role="dialog"]')).toBeNull();
  });

  it("「すべての印を消す」は確かめてから消す", async () => {
    const props = await renderTools();
    await click(buttonByText("すべての印を消す"));
    const dialog = document.body.querySelector('[role="dialog"]');
    expect(dialog?.textContent).toContain("すべての印を消しますか？");
    expect(dialog?.textContent).toContain("↶ で元に戻せます。");
    expect(props.onClear).not.toHaveBeenCalled();
    await click(buttonByText("消す", dialog ?? document.body));
    expect(props.onClear).toHaveBeenCalledTimes(1);
  });

  it("0 件は案内の 1 行（一覧と「すべての印を消す」は出さない）。上限に達したら控えめな 1 行", async () => {
    await renderTools({ marks: [] });
    expect(container.querySelector('ol[aria-label="印の一覧"]')).toBeNull();
    expect(container.textContent).toContain("写真の上をなぞると赤い印が付き、離すと周りから埋まります。");
    expect(buttonByText("すべての印を消す")).toBeUndefined();
    expect(container.textContent).not.toContain("これ以上は描けません");
    await renderTools({ canAdd: false });
    expect(container.textContent).toContain("これ以上は描けません（印は 64 個・なぞった点は合計 2048 個まで）。");
  });

  it("「印を表示」の切り替え（aria-pressed）", async () => {
    const props = await renderTools();
    const toggle = buttonByText("印を表示");
    expect(toggle?.getAttribute("aria-pressed")).toBe("true");
    await click(toggle);
    expect(props.onShowMarksChange).toHaveBeenCalledWith(false);
    await renderTools({ showMarks: false });
    expect(buttonByText("印を表示")?.getAttribute("aria-pressed")).toBe("false");
  });

  it("使い方の説明と、幾何のある写真の 1 行", async () => {
    await renderTools();
    expect(container.textContent).toContain("Shift+クリックで印を選び、[ ] で大きさ、Delete で選んだ印を削除、O で印の表示");
    expect(container.textContent).not.toContain("切り抜き・回転の前の写真全体");
    await renderTools({ hasGeometry: true });
    expect(container.textContent).toContain("修復の間は、切り抜き・回転の前の写真全体を表示します。");
  });
});

describe("右パネルの修復の面（BrowserPhotoEditingAdjustments）", () => {
  it("見出し行は「修復」と ↶ ↷（初期化・⋯・プリセット・補正の群は出さない）、ヒストグラムは一番上", async () => {
    const onUndo = vi.fn();
    await act(async () =>
      root.render(
        <BrowserPhotoEditingAdjustments
          canEdit
          canReset={false}
          resetDone={false}
          canUndo
          canRedo={false}
          controlsDisabled={false}
          busy={false}
          work={null}
          raw={false}
          settings={neutralDevelopSettings()}
          histogram={<div data-testid="histogram" />}
          presets={() => <div data-testid="presets" />}
          tool="heal"
          panel="presets"
          healTools={<PhotoEditingHealTools {...toolsProps()} />}
          onReset={vi.fn()}
          onUndo={onUndo}
          onRedo={vi.fn()}
          onRetryWork={vi.fn()}
          onSettingsChange={vi.fn()}
        />,
      ),
    );
    const aside = container.querySelector<HTMLElement>('aside[aria-label="補正"]');
    if (!aside) throw new Error("panel not found");
    expect(aside.firstElementChild?.querySelector('[data-testid="histogram"]')).not.toBeNull();
    expect(aside.querySelector("h2")?.textContent).toBe("修復");
    const undo = aside.querySelector<HTMLButtonElement>('button[aria-label="取り消す"]');
    expect(undo?.disabled).toBe(false);
    expect(aside.querySelector<HTMLButtonElement>('button[aria-label="やり直す"]')?.disabled).toBe(true);
    await click(undo);
    expect(onUndo).toHaveBeenCalledTimes(1);
    expect(buttonByText("初期化", aside)).toBeUndefined();
    expect(aside.querySelector('[data-testid="presets"]')).toBeNull();
    expect(aside.querySelector('input[type="range"][aria-label="露光量"]')).toBeNull();
    expect(aside.querySelector('ol[aria-label="印の一覧"]')).not.toBeNull();
  });
});
