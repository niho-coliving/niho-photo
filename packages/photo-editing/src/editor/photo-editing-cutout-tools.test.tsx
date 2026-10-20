// @vitest-environment jsdom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  CUTOUT_BRUSH_RADIUS_DEFAULT,
  createCutoutRecipe,
  setCutoutBackground,
  type CutoutBrushMode,
  type CutoutDetection,
  type CutoutRecipe,
} from "../photo-cutout";

import { PhotoEditingCutoutTools } from "./photo-editing-cutout-tools";

/**
 * 背景除去の道具（C4 移行元設計）: 状態ごとの出し分け（切り抜き・回転のある写真・まだ除去していない・失敗・推論の途中・除去した後）・
 * 札の `aria-pressed`・色は決まったときに 1 回確定すること・被写体が 1 つなら選ばせないこと・推論の途中は押せないこと。
 */

const sha = (char: string) => char.repeat(64);

function subject(selection: "all" | `instance-${number}`, char: string) {
  return { selection, pixelCount: 10, mask: `${sha(char)}.png`, maskSHA256: sha(char), maskWidth: 600, maskHeight: 400 };
}

function detection(subjects = [subject("instance-1", "1"), subject("instance-2", "2"), subject("all", "3")]): CutoutDetection {
  return {
    schemaVersion: 1,
    engine: "VNGenerateForegroundInstanceMaskRequest",
    engineRevision: 1,
    width: 600,
    height: 400,
    inputSHA256: sha("a"),
    sourceOrientation: 1,
    largest: "instance-2",
    subjects,
  };
}

type Handlers = {
  onRun: ReturnType<typeof vi.fn<() => void>>;
  onCancel: ReturnType<typeof vi.fn<() => void>>;
  onSelectSubject: ReturnType<typeof vi.fn<(selection: string) => void>>;
  onBackgroundChange: ReturnType<typeof vi.fn<(background: CutoutRecipe["background"]) => void>>;
  onBrushModeChange: ReturnType<typeof vi.fn<(mode: CutoutBrushMode) => void>>;
  onBrushRadiusChange: ReturnType<typeof vi.fn<(radius: number) => void>>;
  onRemove: ReturnType<typeof vi.fn<() => void>>;
};

type ToolsOptions = {
  recipe?: CutoutRecipe | null;
  running?: boolean;
  failureText?: string | null;
  maskFailed?: boolean;
  blockedByGeometry?: boolean;
  disabled?: boolean;
  brushMode?: CutoutBrushMode;
};

let container: HTMLDivElement;
let root: Root;
let handlers: Handlers;

async function render(options: ToolsOptions = {}) {
  await act(async () => {
    root.render(
      <PhotoEditingCutoutTools
        recipe={options.recipe ?? null}
        running={options.running ?? false}
        failureText={options.failureText ?? null}
        maskFailed={options.maskFailed ?? false}
        blockedByGeometry={options.blockedByGeometry ?? false}
        disabled={options.disabled ?? false}
        brush={{ mode: options.brushMode ?? "erase", radius: CUTOUT_BRUSH_RADIUS_DEFAULT }}
        {...handlers}
      />,
    );
  });
}

function button(name: string): HTMLButtonElement | undefined {
  return Array.from(container.querySelectorAll<HTMLButtonElement>("button")).find(
    (candidate) => candidate.textContent?.trim() === name || candidate.getAttribute("aria-label") === name,
  );
}

function requireButton(name: string): HTMLButtonElement {
  const found = button(name);
  if (!found) throw new Error(`button not found: ${name}`);
  return found;
}

/** 見出しの付いた札の並びの、押された札の名前。 */
function pressedIn(title: string): string[] {
  const group = container.querySelector(`[role="group"][aria-labelledby="${headingId(title)}"]`);
  return Array.from(group?.querySelectorAll('button[aria-pressed="true"]') ?? []).map((element) => element.textContent?.trim() ?? "");
}

function pillsIn(title: string): string[] {
  const group = container.querySelector(`[role="group"][aria-labelledby="${headingId(title)}"]`);
  return Array.from(group?.querySelectorAll("button") ?? []).map((element) => element.textContent?.trim() ?? "");
}

function headingId(title: string): string {
  const heading = Array.from(container.querySelectorAll("h4")).find((element) => element.textContent?.trim() === title);
  return heading?.id ?? "__missing__";
}

async function click(element: Element) {
  await act(async () => {
    element.dispatchEvent(new MouseEvent("click", { bubbles: true }));
  });
}

beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  handlers = {
    onRun: vi.fn(),
    onCancel: vi.fn(),
    onSelectSubject: vi.fn(),
    onBackgroundChange: vi.fn(),
    onBrushModeChange: vi.fn(),
    onBrushRadiusChange: vi.fn(),
    onRemove: vi.fn(),
  };
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
});

describe("出し分け", () => {
  it("切り抜き・回転のある写真は理由の 1 行だけ", async () => {
    await render({ blockedByGeometry: true, recipe: createCutoutRecipe(detection()) });
    expect(container.textContent).toBe("切り抜き・回転をした写真では背景を除去できません。切り抜きを初期化すると使えます。");
    expect(container.querySelectorAll("button")).toHaveLength(0);
  });

  it("まだ除去していなければ説明と「背景を除去」。押すと推論を始める", async () => {
    await render();
    expect(container.textContent).toContain("写真の中の人や物を見つけて、背景を透明にします。");
    expect(container.querySelector('[role="alert"]')).toBeNull();
    await click(requireButton("背景を除去"));
    expect(handlers.onRun).toHaveBeenCalledTimes(1);
  });

  it("失敗したら上に 1 行を出し、同じボタンでやり直す", async () => {
    await render({ failureText: "切り抜ける人や物が見つかりませんでした。" });
    const alert = container.querySelector('[role="alert"]');
    expect(alert?.textContent).toBe("切り抜ける人や物が見つかりませんでした。");
    // 1 行はボタンより上
    const run = requireButton("背景を除去");
    expect(alert && alert.compareDocumentPosition(run) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    await click(run);
    expect(handlers.onRun).toHaveBeenCalledTimes(1);
  });

  it("保存していたマスクを読めなければ、やり直しのボタンと「背景除去を外す」", async () => {
    await render({
      recipe: createCutoutRecipe(detection()),
      maskFailed: true,
      failureText: "保存していた背景除去を読めませんでした。もう一度「背景を除去」を押してください。",
    });
    expect(container.querySelector('[role="alert"]')?.textContent).toContain("保存していた背景除去を読めませんでした");
    expect(button("背景を除去")).toBeDefined();
    expect(button("背景除去を外す")).toBeDefined();
    // 被写体・背景・ブラシは出さない
    expect(container.querySelectorAll("h4")).toHaveLength(0);
  });

  it("推論の途中は「人や物を探しています…」と「やめる」だけ", async () => {
    await render({ running: true });
    expect(container.querySelector('[role="status"]')?.textContent).toBe("人や物を探しています…");
    expect(button("背景を除去")).toBeUndefined();
    await click(requireButton("やめる"));
    expect(handlers.onCancel).toHaveBeenCalledTimes(1);
  });
});

describe("除去した後", () => {
  it("被写体（最大 → 番号順 → すべて）・背景・ブラシ・外す。押された札は aria-pressed", async () => {
    await render({ recipe: createCutoutRecipe(detection()) });
    expect(Array.from(container.querySelectorAll("h4")).map((element) => element.textContent)).toEqual(["被写体", "背景", "ブラシ"]);
    expect(pillsIn("被写体")).toEqual(["被写体 1", "被写体 2", "すべて"]);
    expect(pressedIn("被写体")).toEqual(["被写体 1"]);
    expect(pillsIn("背景")).toEqual(["透明", "白", "色"]);
    expect(pressedIn("背景")).toEqual(["透明"]);
    expect(pillsIn("ブラシ")).toEqual(["消す", "戻す"]);
    expect(pressedIn("ブラシ")).toEqual(["消す"]);
    expect(container.querySelector('input[type="range"][aria-label="ブラシの大きさ"]')).not.toBeNull();
    expect(container.textContent).toContain("写真をなぞると、残ったところを消したり、消えたところを戻したりできます。");
    // 札は押せる高さ 32px（見た目のまま）でフォーカスの輪が見える
    const pill = requireButton("白");
    expect(pill.className).toContain("min-h-8");
    expect(pill.className).toContain("focus-visible:ring-2");

    await click(requireButton("被写体 2"));
    expect(handlers.onSelectSubject).toHaveBeenCalledWith("instance-1");
    await click(requireButton("白"));
    expect(handlers.onBackgroundChange).toHaveBeenLastCalledWith({ kind: "white" });
    await click(requireButton("戻す"));
    expect(handlers.onBrushModeChange).toHaveBeenCalledWith("restore");
    await click(requireButton("背景除去を外す"));
    expect(handlers.onRemove).toHaveBeenCalledTimes(1);
  });

  it("被写体が 1 つなら被写体の節を出さない", async () => {
    const single = { ...detection([subject("instance-1", "1"), subject("all", "1")]), largest: "instance-1" as const };
    await render({ recipe: createCutoutRecipe(single) });
    expect(Array.from(container.querySelectorAll("h4")).map((element) => element.textContent)).toEqual(["背景", "ブラシ"]);
    expect(button("被写体 1")).toBeUndefined();
  });

  it("「色」は色の欄を出し、選んでいる間は確定せず、決まったときに 1 回確定する", async () => {
    const recipe = createCutoutRecipe(detection());
    await render({ recipe });
    expect(container.querySelector('input[type="color"]')).toBeNull();
    await click(requireButton("色"));
    expect(handlers.onBackgroundChange).toHaveBeenLastCalledWith({ kind: "color", color: "#000000" });

    await render({ recipe: setCutoutBackground(recipe, { kind: "color", color: "#336699" }) });
    expect(pressedIn("背景")).toEqual(["色"]);
    const picker = container.querySelector<HTMLInputElement>('input[type="color"][aria-label="背景の色"]');
    if (!picker) throw new Error("color picker not found");
    expect(picker.value).toBe("#336699");
    handlers.onBackgroundChange.mockClear();
    const setValue = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
    await act(async () => {
      setValue?.call(picker, "#aabbcc");
      picker.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await act(async () => {
      setValue?.call(picker, "#AABBDD");
      picker.dispatchEvent(new Event("input", { bubbles: true }));
    });
    expect(handlers.onBackgroundChange).not.toHaveBeenCalled();
    await act(async () => {
      picker.dispatchEvent(new Event("change", { bubbles: true }));
    });
    expect(handlers.onBackgroundChange).toHaveBeenCalledTimes(1);
    expect(handlers.onBackgroundChange).toHaveBeenLastCalledWith({ kind: "color", color: "#aabbdd" });
  });

  it("ブラシの大きさは % で見せ、動かすと半径（割合）で知らせる", async () => {
    await render({ recipe: createCutoutRecipe(detection()) });
    const range = container.querySelector<HTMLInputElement>('input[type="range"][aria-label="ブラシの大きさ"]');
    if (!range) throw new Error("brush size not found");
    expect(range.min).toBe("0.5");
    expect(range.max).toBe("25");
    expect(range.getAttribute("aria-valuetext")).toBe("4%");
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set?.call(range, "10");
      range.dispatchEvent(new Event("input", { bubbles: true }));
    });
    expect(handlers.onBrushRadiusChange).toHaveBeenLastCalledWith(0.1);
  });

  it("押せない間は札・ブラシ・外すをすべて押せない", async () => {
    await render({ recipe: createCutoutRecipe(detection()), disabled: true });
    const buttons = Array.from(container.querySelectorAll<HTMLButtonElement>("button"));
    // 値の直接入力のボタンも含めて全部
    expect(buttons.length).toBeGreaterThan(0);
    expect(buttons.every((candidate) => candidate.disabled)).toBe(true);
    expect(container.querySelector<HTMLInputElement>('input[type="range"]')?.disabled).toBe(true);
  });

  it("まだ除去していない写真で押せない間は「背景を除去」も押せない", async () => {
    await render({ disabled: true });
    expect(requireButton("背景を除去").disabled).toBe(true);
  });
});
