// @vitest-environment jsdom

import { act, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  developFrameSize,
  flipGeometryHorizontal,
  maxCropBox,
  cropFromBox,
  rotateGeometryClockwise,
  setGeometryAngle,
  setGeometryAspect,
  type DevelopGeometry,
  type DevelopSize,
} from "../develop-engine/develop-geometry";

import { PhotoEditingCropTools } from "./photo-editing-crop-tools";

/**
 * 切り抜きの道具の部品（F3b 移行元設計）: 縦横比のチップの選ばれた表示・縦横の入れ替え・角度補正の手元の値と確定・90° 回転と
 * 左右の反転・書き出しの 1 行の出し分け。
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

/** 確定した幾何と手元の角度を持つ親（面の hook の代わり）。 */
function Harness(props: { initial: DevelopGeometry; disabled?: boolean; exportLongEdge?: number | null; mobile?: boolean }) {
  const [geometry, setGeometry] = useState(props.initial);
  const [liveAngle, setLiveAngle] = useState<number | null>(null);
  return (
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
    />
  );
}

async function render(
  initial: DevelopGeometry = IDENTITY,
  options: { disabled?: boolean; exportLongEdge?: number | null; mobile?: boolean } = {},
) {
  await act(async () => {
    root.render(
      <Harness
        initial={initial}
        disabled={options.disabled}
        exportLongEdge={options.exportLongEdge}
        mobile={options.mobile}
      />,
    );
  });
}

function button(name: string): HTMLButtonElement {
  const found = Array.from(container.querySelectorAll<HTMLButtonElement>("button")).find(
    (candidate) => candidate.getAttribute("aria-label") === name || candidate.textContent?.trim() === name,
  );
  if (!found) throw new Error(`button not found: ${name}`);
  return found;
}

function pressedChips(): string[] {
  return Array.from(container.querySelectorAll<HTMLButtonElement>('[role="group"] button[aria-pressed="true"]')).map(
    (chip) => chip.textContent?.trim() ?? "",
  );
}

async function click(element: Element) {
  await act(async () => {
    element.dispatchEvent(new MouseEvent("click", { bubbles: true }));
  });
}

function angleSlider(): HTMLInputElement {
  const input = container.querySelector<HTMLInputElement>('input[type="range"][aria-label="角度補正"]');
  if (!input) throw new Error("angle slider not found");
  return input;
}

function setSliderValue(input: HTMLInputElement, value: string) {
  Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set?.call(input, value);
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
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
});

describe("縦横比", () => {
  it("チップを並べ、今の比率（無ければ「元の比率」）を選ばれた表示にする", async () => {
    await render();
    const chips = Array.from(container.querySelectorAll<HTMLButtonElement>('[role="group"] button')).map(
      (chip) => chip.textContent?.trim(),
    );
    expect(chips).toEqual(["元の比率", "自由", "1:1", "4:5", "3:4", "2:3", "9:16"]);
    expect(container.querySelector('[role="group"]')?.getAttribute("aria-labelledby")).toBe(
      Array.from(container.querySelectorAll("h4")).find((heading) => heading.textContent === "縦横比")?.id,
    );
    expect(pressedChips()).toEqual(["元の比率"]);
  });

  it("チップを押すと、その比率で内接する最大の箱を確定する", async () => {
    await render();
    await click(button("1:1"));

    expect(onCommit).toHaveBeenCalledOnce();
    expect(lastCommit()).toEqual(setGeometryAspect(IDENTITY, "1:1", SOURCE));
    expect(lastCommit().aspect).toBe("1:1");
    // 3000 x 2000 の中央の 2000 x 2000
    expect(lastCommit().crop.left).toBeCloseTo(1 / 6, 9);
    expect(lastCommit().crop.right).toBeCloseTo(5 / 6, 9);
    expect(pressedChips()).toEqual(["1:1"]);

    await click(button("自由"));
    expect(lastCommit().aspect).toBe("free");
    // 「自由」は箱を変えない
    expect(lastCommit().crop).toEqual(setGeometryAspect(IDENTITY, "1:1", SOURCE).crop);
    expect(pressedChips()).toEqual(["自由"]);
  });

  it("「縦横の入れ替え」は比率の縦横を入れ替え、元のチップを選ばれた表示のままにする", async () => {
    await render(setGeometryAspect(IDENTITY, "4:5", SOURCE));
    expect(pressedChips()).toEqual(["4:5"]);

    await click(button("縦横の入れ替え"));
    expect(lastCommit().aspect).toBe("5:4");
    expect(lastCommit()).toEqual(setGeometryAspect(setGeometryAspect(IDENTITY, "4:5", SOURCE), "5:4", SOURCE));
    expect(pressedChips()).toEqual(["4:5"]);

    // 選ばれているチップを押しても、入れ替えた向きのまま
    onCommit.mockClear();
    await click(button("4:5"));
    expect(lastCommit().aspect).toBe("5:4");

    await click(button("縦横の入れ替え"));
    expect(lastCommit().aspect).toBe("4:5");
  });

  it("「元の比率」の入れ替えは originalSwapped", async () => {
    await render();
    await click(button("縦横の入れ替え"));
    expect(lastCommit().aspect).toBe("originalSwapped");
    expect(pressedChips()).toEqual(["元の比率"]);
  });

  it("「自由」と「1:1」のときは入れ替えを押せない", async () => {
    await render(setGeometryAspect(IDENTITY, "free", SOURCE));
    expect(button("縦横の入れ替え").disabled).toBe(true);
    await click(button("1:1"));
    expect(button("縦横の入れ替え").disabled).toBe(true);
    await click(button("2:3"));
    expect(button("縦横の入れ替え").disabled).toBe(false);
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
    await click(button("角度補正の値 0° を入力"));
    const entry = container.querySelector<HTMLInputElement>('input[aria-label="角度補正の値"]');
    if (!entry) throw new Error("entry not found");
    await act(async () => {
      setSliderValue(entry, "-7.34°");
      entry.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await act(async () => {
      entry.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true }));
    });
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

describe("回転と反転", () => {
  it("「90° 回転」は時計回りに回し、「左右の反転」は鏡映する（押すたびに確定）", async () => {
    const start = setGeometryAspect(IDENTITY, "4:5", SOURCE);
    await render(start);

    await click(button("90° 回転"));
    expect(onCommit).toHaveBeenCalledOnce();
    const rotated = rotateGeometryClockwise(start, SOURCE);
    expect(lastCommit()).toEqual(rotated);
    expect(lastCommit().rotate).toBe(90);

    await click(button("左右の反転"));
    expect(onCommit).toHaveBeenCalledTimes(2);
    expect(lastCommit()).toEqual(flipGeometryHorizontal(rotated, SOURCE));
    expect(lastCommit().flipH).toBe(true);
  });

  it("回した後の比率のチップは、回した枠（縦長）の比率で置く", async () => {
    await render(rotateGeometryClockwise(IDENTITY, SOURCE));
    await click(button("1:1"));
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

describe("押せない間", () => {
  it("チップ・入れ替え・スライダー・回転・反転を押せなくする", async () => {
    await render(IDENTITY, { disabled: true });
    const buttons = Array.from(container.querySelectorAll<HTMLButtonElement>("button"));
    expect(buttons.length).toBeGreaterThan(0);
    expect(buttons.every((candidate) => candidate.disabled)).toBe(true);
    expect(angleSlider().disabled).toBe(true);
    // 押せる大きさは 44px
    expect(button("1:1").className).toContain("min-h-11");
    expect(button("90° 回転").className).toContain("min-h-11");
    expect(button("縦横の入れ替え").className).toContain("h-11");
  });
});
