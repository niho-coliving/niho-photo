// @vitest-environment jsdom

import { act, useRef, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  developFrameSize,
  flipGeometryHorizontal,
  flipGeometryVertical,
  maxCropBox,
  cropFromBox,
  rotateGeometryClockwise,
  rotateGeometryCounterClockwise,
  setGeometryAngle,
  setGeometryAspect,
  type DevelopGeometry,
  type DevelopSize,
} from "../develop-engine/develop-geometry";

import { PhotoEditingCropTools } from "./photo-editing-crop-tools";
import { useBrowserPhotoEditingKeys } from "./use-browser-photo-editing-keys";

/**
 * 切り抜きの道具の部品（F3b 移行元設計）。PC は Lightroom の並び（#52）: 縦横比のメニューと右端の「縦横の入れ替え」・角度補正の
 * 手元の値と確定・「反転と回転」の 4 つの icon・書き出しの 1 行・［完了］［キャンセル］と、面のキー（Enter / Esc）との組み合わせ。
 */

const SOURCE: DevelopSize = { width: 3000, height: 2000 };
const IDENTITY: DevelopGeometry = {
  rotate: 0,
  flipH: false,
  flipV: false,
  angle: 0,
  crop: { left: 0, top: 0, right: 1, bottom: 1 },
};

let container: HTMLDivElement;
let root: Root;
let onCommit: ReturnType<typeof vi.fn<(geometry: DevelopGeometry) => void>>;
let onLiveAngleChange: ReturnType<typeof vi.fn<(angle: number | null) => void>>;
let onDone: ReturnType<typeof vi.fn<() => void>>;
let onCancel: ReturnType<typeof vi.fn<() => void>>;

type RenderOptions = {
  disabled?: boolean;
  exportLongEdge?: number | null;
  mobile?: boolean;
  /** ［完了］［キャンセル］を渡す（PC の面と同じ） */
  finish?: boolean;
  /** 面のキー（`useBrowserPhotoEditingKeys`）も聞く */
  keys?: boolean;
};

/** 確定した幾何と手元の角度を持つ親（面の hook の代わり）。`keys` なら面と同じく Enter / Esc を［完了］［キャンセル］にする。 */
function Harness(props: { initial: DevelopGeometry } & RenderOptions) {
  const [geometry, setGeometry] = useState(props.initial);
  const [liveAngle, setLiveAngle] = useState<number | null>(null);
  const rootRef = useRef<HTMLDivElement | null>(null);
  useBrowserPhotoEditingKeys({
    rootRef,
    enabled: props.keys === true,
    onUndo: () => undefined,
    onRedo: () => undefined,
    onCopy: () => undefined,
    onPaste: () => undefined,
    onCompareOriginalChange: () => undefined,
    onCropDone: () => onDone(),
    onCropCancel: () => onCancel(),
  });
  return (
    <div ref={rootRef}>
      <PhotoEditingCropTools
        geometry={geometry}
        source={SOURCE}
        disabled={props.disabled ?? false}
        liveAngle={liveAngle}
        exportLongEdge={props.exportLongEdge ?? null}
        mobile={props.mobile}
        onLiveAngleChange={(angle) => {
          onLiveAngleChange(angle);
          setLiveAngle(angle);
        }}
        onCommit={(next) => {
          onCommit(next);
          setGeometry(next);
        }}
        onDone={props.finish ? () => onDone() : undefined}
        onCancel={props.finish ? () => onCancel() : undefined}
      />
    </div>
  );
}

async function render(initial: DevelopGeometry = IDENTITY, options: RenderOptions = {}) {
  await act(async () => {
    root.render(<Harness initial={initial} {...options} />);
  });
}

function button(name: string): HTMLButtonElement {
  const found = Array.from(container.querySelectorAll<HTMLButtonElement>("button")).find(
    (candidate) => candidate.getAttribute("aria-label") === name || candidate.textContent?.trim() === name,
  );
  if (!found) throw new Error(`button not found: ${name}`);
  return found;
}

/** 読み上げない印（⏎・esc）を除いたボタンの字。 */
function visibleLabel(element: Element): string {
  return Array.from(element.childNodes)
    .filter((node) => !(node instanceof Element && node.getAttribute("aria-hidden") === "true"))
    .map((node) => node.textContent ?? "")
    .join("")
    .trim();
}

function finishButton(label: string): HTMLButtonElement {
  const found = Array.from(container.querySelectorAll<HTMLButtonElement>("button")).find(
    (candidate) => visibleLabel(candidate) === label,
  );
  if (!found) throw new Error(`button not found: ${label}`);
  return found;
}

function aspectTrigger(): HTMLButtonElement {
  const found = container.querySelector<HTMLButtonElement>('button[aria-haspopup="menu"]');
  if (!found) throw new Error("aspect menu not found");
  return found;
}

/** `aria-labelledby` から組んだ読み上げ名。 */
function labelledName(element: Element): string {
  return (element.getAttribute("aria-labelledby") ?? "")
    .split(" ")
    .map((id) => document.getElementById(id)?.textContent?.trim() ?? "")
    .join(" ");
}

function aspectItems(): HTMLButtonElement[] {
  return Array.from(document.body.querySelectorAll<HTMLButtonElement>('[role="menuitemradio"]'));
}

async function openAspectMenu() {
  await click(aspectTrigger());
  expect(aspectItems().length).toBeGreaterThan(0);
}

function checkedAspects(): string[] {
  return aspectItems()
    .filter((item) => item.getAttribute("aria-checked") === "true")
    .map((item) => item.textContent?.trim() ?? "");
}

async function chooseAspect(label: string) {
  await openAspectMenu();
  const item = aspectItems().find((candidate) => candidate.textContent?.trim() === label);
  if (!item) throw new Error(`aspect not found: ${label}`);
  await click(item);
}

async function click(element: Element) {
  await act(async () => {
    element.dispatchEvent(new MouseEvent("click", { bubbles: true }));
  });
}

async function keyDown(target: EventTarget, key: string): Promise<KeyboardEvent> {
  const event = new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true });
  await act(async () => {
    target.dispatchEvent(event);
  });
  return event;
}

function angleSlider(): HTMLInputElement {
  const input = container.querySelector<HTMLInputElement>('input[type="range"][aria-label="角度補正"]');
  if (!input) throw new Error("angle slider not found");
  return input;
}

function setSliderValue(input: HTMLInputElement, value: string) {
  Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set?.call(input, value);
}

async function openAngleEntry(): Promise<HTMLInputElement> {
  await click(button("角度補正の値 0° を入力"));
  const entry = container.querySelector<HTMLInputElement>('input[aria-label="角度補正の値"]');
  if (!entry) throw new Error("entry not found");
  return entry;
}

function lastCommit(): DevelopGeometry {
  const last = onCommit.mock.calls.at(-1)?.[0];
  if (!last) throw new Error("nothing was committed");
  return last;
}

beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  onCommit = vi.fn<(geometry: DevelopGeometry) => void>();
  onLiveAngleChange = vi.fn<(angle: number | null) => void>();
  onDone = vi.fn<() => void>();
  onCancel = vi.fn<() => void>();
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
});

describe("縦横比（PC）", () => {
  it("「縦横比」の行に今の比率の名前 ▾ のメニューを置き（チップは並べない）、項目は今のチップと同じ", async () => {
    await render();
    expect(container.querySelector('[role="group"] button[aria-pressed]')).toBeNull();
    expect(labelledName(aspectTrigger())).toBe("縦横比 元の比率");

    await openAspectMenu();
    expect(aspectItems().map((item) => item.textContent?.trim())).toEqual([
      "元の比率",
      "自由",
      "1:1",
      "4:5",
      "3:4",
      "2:3",
      "9:16",
    ]);
    expect(checkedAspects()).toEqual(["元の比率"]);
  });

  it("選ぶと、その比率で内接する最大の箱を確定する", async () => {
    await render();
    await chooseAspect("1:1");

    expect(onCommit).toHaveBeenCalledOnce();
    expect(lastCommit()).toEqual(setGeometryAspect(IDENTITY, "1:1", SOURCE));
    // 3000 x 2000 の中央の 2000 x 2000
    expect(lastCommit().crop.left).toBeCloseTo(1 / 6, 9);
    expect(lastCommit().crop.right).toBeCloseTo(5 / 6, 9);
    expect(labelledName(aspectTrigger())).toBe("縦横比 1:1");

    await chooseAspect("自由");
    expect(lastCommit().aspect).toBe("free");
    // 「自由」は箱を変えない
    expect(lastCommit().crop).toEqual(setGeometryAspect(IDENTITY, "1:1", SOURCE).crop);
    await openAspectMenu();
    expect(checkedAspects()).toEqual(["自由"]);
  });

  it("右端の「縦横の入れ替え」は比率の縦横を入れ替え、ボタンは今の向き・メニューは元の比率に印", async () => {
    await render(setGeometryAspect(IDENTITY, "4:5", SOURCE));
    const swap = button("縦横の入れ替え");
    expect(swap.getAttribute("title")).toBe("縦横の入れ替え");

    await click(swap);
    expect(lastCommit().aspect).toBe("5:4");
    expect(lastCommit()).toEqual(setGeometryAspect(setGeometryAspect(IDENTITY, "4:5", SOURCE), "5:4", SOURCE));
    expect(labelledName(aspectTrigger())).toBe("縦横比 5:4");
    await openAspectMenu();
    expect(checkedAspects()).toEqual(["4:5"]);

    // 印のある比率を選んでも、入れ替えた向きのまま
    onCommit.mockClear();
    await click(aspectItems().find((item) => item.textContent?.trim() === "4:5")!);
    expect(lastCommit().aspect).toBe("5:4");

    await click(button("縦横の入れ替え"));
    expect(lastCommit().aspect).toBe("4:5");
  });

  it("「元の比率」の入れ替えは originalSwapped（名前は「元の比率」のまま）", async () => {
    await render();
    await click(button("縦横の入れ替え"));
    expect(lastCommit().aspect).toBe("originalSwapped");
    expect(labelledName(aspectTrigger())).toBe("縦横比 元の比率");
  });

  it("「自由」と「1:1」のときは入れ替えを押せない", async () => {
    await render(setGeometryAspect(IDENTITY, "free", SOURCE));
    expect(button("縦横の入れ替え").disabled).toBe(true);
    await chooseAspect("1:1");
    expect(button("縦横の入れ替え").disabled).toBe(true);
    await chooseAspect("2:3");
    expect(button("縦横の入れ替え").disabled).toBe(false);
  });
});

describe("縦横比（スマホの帯は今のまま）", () => {
  it("チップを並べ、メニューは出さない", async () => {
    await render(IDENTITY, { mobile: true });
    expect(container.querySelector('button[aria-haspopup="menu"]')).toBeNull();
    const chips = Array.from(container.querySelectorAll<HTMLButtonElement>('[role="toolbar"] button[aria-pressed]')).map(
      (chip) => chip.textContent?.trim(),
    );
    expect(chips).toEqual(["元の比率", "自由", "1:1", "4:5", "3:4", "2:3", "9:16"]);
    expect(button("90° 回転")).toBeTruthy();
    expect(container.textContent).not.toContain("反転と回転");
  });
});

describe("角度補正", () => {
  it("−45〜45・刻み 0.1 で、値は「+1.5°」「0°」の形", async () => {
    await render({ ...IDENTITY, angle: 1.5 });
    const input = angleSlider();
    expect(input.min).toBe("-45");
    expect(input.max).toBe("45");
    expect(input.step).toBe("0.1");
    expect(input.value).toBe("1.5");
    expect(input.getAttribute("aria-valuetext")).toBe("+1.5°");

    await act(async () => root.unmount());
    root = createRoot(container);
    await render();
    expect(angleSlider().getAttribute("aria-valuetext")).toBe("0°");
  });

  it("つまみを動かしている間は手元の角度だけを知らせ、離したら確定する（1 回）", async () => {
    await render();
    const input = angleSlider();
    await act(async () => {
      input.dispatchEvent(new Event("pointerdown", { bubbles: true }));
      setSliderValue(input, "2");
      input.dispatchEvent(new Event("input", { bubbles: true }));
    });
    expect(onLiveAngleChange).toHaveBeenLastCalledWith(2);
    expect(onCommit).not.toHaveBeenCalled();
    expect(input.getAttribute("aria-valuetext")).toBe("+2°");

    await act(async () => {
      setSliderValue(input, "3.5");
      input.dispatchEvent(new Event("input", { bubbles: true }));
    });
    expect(onLiveAngleChange).toHaveBeenLastCalledWith(3.5);
    expect(onCommit).not.toHaveBeenCalled();

    await act(async () => {
      window.dispatchEvent(new Event("pointerup"));
    });
    expect(onCommit).toHaveBeenCalledOnce();
    expect(lastCommit()).toEqual(setGeometryAngle(IDENTITY, 3.5, SOURCE));
    expect(lastCommit().angle).toBe(3.5);
    expect(onLiveAngleChange).toHaveBeenLastCalledWith(null);
    expect(angleSlider().value).toBe("3.5");
  });

  it("ダブルクリックで 0 に戻す。0 のままなら確定しない", async () => {
    await render(setGeometryAngle(IDENTITY, 5, SOURCE));
    await act(async () => {
      angleSlider().dispatchEvent(new MouseEvent("dblclick", { bubbles: true }));
    });
    expect(onCommit).toHaveBeenCalledOnce();
    expect(lastCommit().angle).toBe(0);
    // 自分で動かしていない箱は、角度を戻すと枠全体に戻る
    expect(lastCommit().crop).toEqual(cropFromBox(maxCropBox(SOURCE, 0, null), 0, SOURCE));

    await act(async () => {
      angleSlider().dispatchEvent(new MouseEvent("dblclick", { bubbles: true }));
    });
    expect(onCommit).toHaveBeenCalledOnce();
  });

  it("値を直接入力できる（「°」が付いていても読む）", async () => {
    await render();
    const entry = await openAngleEntry();
    await act(async () => {
      setSliderValue(entry, "-7.34°");
      entry.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await keyDown(entry, "Enter");
    expect(onCommit).toHaveBeenCalledOnce();
    // 刻み 0.1 に丸める
    expect(lastCommit().angle).toBeCloseTo(-7.3, 9);
  });
});

describe("スマホの書き出し上限", () => {
  it("切り抜き後の書き出し長辺を案内する", async () => {
    await render(IDENTITY, { mobile: true, exportLongEdge: 1700 });
    expect(container.textContent).toContain("書き出しは長辺 1,700px まで");
  });
});

describe("反転と回転（PC）", () => {
  it("小見出しの下に 4 つの icon（aria-label と title）を並べ、押すたびに確定する", async () => {
    const start = setGeometryAspect(IDENTITY, "4:5", SOURCE);
    await render(start);
    const group = Array.from(container.querySelectorAll('[role="group"]')).find(
      (candidate) => labelledName(candidate) === "反転と回転",
    );
    if (!group) throw new Error("transform group not found");
    const icons = Array.from(group.querySelectorAll<HTMLButtonElement>("button"));
    expect(icons.map((icon) => icon.getAttribute("aria-label"))).toEqual([
      "左に 90° 回転",
      "右に 90° 回転",
      "左右の反転",
      "上下の反転",
    ]);
    expect(icons.map((icon) => icon.getAttribute("title"))).toEqual(icons.map((icon) => icon.getAttribute("aria-label")));

    let expected = start;
    await click(button("右に 90° 回転"));
    expected = rotateGeometryClockwise(expected, SOURCE);
    expect(lastCommit()).toEqual(expected);
    expect(lastCommit().rotate).toBe(90);

    await click(button("左に 90° 回転"));
    expected = rotateGeometryCounterClockwise(expected, SOURCE);
    expect(lastCommit()).toEqual(expected);
    expect(lastCommit().rotate).toBe(0);

    await click(button("左右の反転"));
    expected = flipGeometryHorizontal(expected, SOURCE);
    expect(lastCommit()).toEqual(expected);
    expect(lastCommit().flipH).toBe(true);

    await click(button("上下の反転"));
    expected = flipGeometryVertical(expected, SOURCE);
    expect(lastCommit()).toEqual(expected);
    expect(lastCommit().flipV).toBe(true);
    expect(onCommit).toHaveBeenCalledTimes(4);
  });

  it("回した後の比率は、回した枠（縦長）の比率で置く", async () => {
    await render(rotateGeometryClockwise(IDENTITY, SOURCE));
    await chooseAspect("1:1");
    const frame = developFrameSize(SOURCE, 90);
    expect(frame).toEqual({ width: 2000, height: 3000 });
    expect(lastCommit()).toEqual(setGeometryAspect(rotateGeometryClockwise(IDENTITY, SOURCE), "1:1", frame));
    expect(lastCommit().crop.top).toBeCloseTo(1 / 6, 9);
  });
});

describe("書き出しの大きさの 1 行", () => {
  it("届かなくなるときだけ出す", async () => {
    await render(IDENTITY, { exportLongEdge: 1536 });
    expect(container.textContent).toContain("書き出しは長辺 1,536px まで");

    await act(async () => root.unmount());
    root = createRoot(container);
    await render(IDENTITY, { exportLongEdge: null });
    expect(container.textContent).not.toContain("書き出しは長辺");
  });
});

describe("［完了］［キャンセル］", () => {
  it("渡したときだけ一番下に出す。キーの印（⏎・esc）は薄く添え、読み上げは aria-keyshortcuts", async () => {
    await render();
    expect(Array.from(container.querySelectorAll("button")).some((candidate) => visibleLabel(candidate) === "完了")).toBe(false);

    await act(async () => root.unmount());
    root = createRoot(container);
    await render(IDENTITY, { finish: true, exportLongEdge: 1536 });
    const done = finishButton("完了");
    const cancel = finishButton("キャンセル");
    expect(done.getAttribute("aria-keyshortcuts")).toBe("Enter");
    expect(cancel.getAttribute("aria-keyshortcuts")).toBe("Escape");
    expect(done.querySelector('[aria-hidden="true"]')?.textContent).toBe("⏎");
    expect(cancel.querySelector('[aria-hidden="true"]')?.textContent).toBe("esc");
    // 一番下に［完了］→［キャンセル］の順（書き出しの 1 行の後）
    const buttons = Array.from(container.querySelectorAll("button"));
    expect(buttons.slice(-2)).toEqual([done, cancel]);
    const exportLine = Array.from(container.querySelectorAll("p")).find((line) => line.textContent?.includes("書き出しは長辺"));
    expect(exportLine!.compareDocumentPosition(done) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();

    await click(done);
    expect(onDone).toHaveBeenCalledOnce();
    await click(cancel);
    expect(onCancel).toHaveBeenCalledOnce();
    expect(onCommit).not.toHaveBeenCalled();
  });

  it("［キャンセル］の上の Enter は［キャンセル］を押す（面の Enter =［完了］に渡さない）", async () => {
    await render(IDENTITY, { finish: true, keys: true });
    const cancel = finishButton("キャンセル");
    cancel.focus();
    const event = await keyDown(cancel, "Enter");
    expect(event.defaultPrevented).toBe(true);
    expect(onCancel).toHaveBeenCalledOnce();
    expect(onDone).not.toHaveBeenCalled();
  });
});

describe("Enter / Esc（面のキー）", () => {
  it("Enter =［完了］、Esc =［キャンセル］。ボタンの上の Enter も［完了］で、ボタンは押さない", async () => {
    await render(IDENTITY, { finish: true, keys: true });
    await keyDown(document.body, "Enter");
    expect(onDone).toHaveBeenCalledOnce();
    await keyDown(document.body, "Escape");
    expect(onCancel).toHaveBeenCalledOnce();

    const rotate = button("右に 90° 回転");
    rotate.focus();
    const event = await keyDown(rotate, "Enter");
    expect(event.defaultPrevented).toBe(true);
    expect(onDone).toHaveBeenCalledTimes(2);
  });

  it("角度の入力欄の Enter は欄の確定だけで道具を閉じない。Esc も欄の取り消しだけ", async () => {
    await render(IDENTITY, { finish: true, keys: true });
    let entry = await openAngleEntry();
    await act(async () => {
      setSliderValue(entry, "4");
      entry.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await keyDown(entry, "Enter");
    expect(onCommit).toHaveBeenCalledOnce();
    expect(lastCommit().angle).toBe(4);
    expect(onDone).not.toHaveBeenCalled();

    await click(button("角度補正の値 +4° を入力"));
    entry = container.querySelector<HTMLInputElement>('input[aria-label="角度補正の値"]')!;
    await keyDown(entry, "Escape");
    expect(container.querySelector('input[aria-label="角度補正の値"]')).toBeNull();
    expect(onCancel).not.toHaveBeenCalled();
    expect(onCommit).toHaveBeenCalledOnce();
  });

  it("開いている縦横比のメニューの Esc はメニューを閉じるだけ", async () => {
    await render(IDENTITY, { finish: true, keys: true });
    await openAspectMenu();
    await keyDown(aspectItems()[0]!, "Escape");
    expect(aspectItems()).toEqual([]);
    expect(onCancel).not.toHaveBeenCalled();
  });
});

describe("押せない間", () => {
  it("メニュー・入れ替え・スライダー・回転・反転・［完了］［キャンセル］を押せなくする", async () => {
    await render(IDENTITY, { disabled: true, finish: true });
    const buttons = Array.from(container.querySelectorAll<HTMLButtonElement>("button"));
    expect(buttons.length).toBeGreaterThan(0);
    expect(buttons.every((candidate) => candidate.disabled)).toBe(true);
    expect(angleSlider().disabled).toBe(true);
    // 押せる範囲は 24px 以上（PC の部品は見た目の大きさ。owner 2026-10-15）
    expect(aspectTrigger().className).toContain("h-7");
    expect(button("縦横の入れ替え").className).toContain("h-8");
    expect(button("右に 90° 回転").className).toContain("h-9");
    expect(finishButton("完了").className).toContain("h-9");
  });
});
