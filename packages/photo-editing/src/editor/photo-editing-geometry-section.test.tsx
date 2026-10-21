// @vitest-environment jsdom

import { act, useRef, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { DevelopGeometry, DevelopSize } from "../develop-engine/develop-geometry";
import { PHOTO_EDITING_ADVANCED_SECTIONS_STORAGE_KEY } from "../photo-editing-advanced-sections-state";

import { PhotoEditingCropTools } from "./photo-editing-crop-tools";
import { formatGeometryValue } from "./photo-editing-geometry-section";
import type { PhotoEditingSliderPhase } from "./photo-editing-slider";

/**
 * 切り抜きの道具の「ジオメトリ」の節（niho-photo#46）。「反転と回転」の下に既定で閉じた節を置き、遠近の 7 本のスライダー（ドラッグの
 * 間 `drag`・離して `commit`・ダブルクリックで既定値）と「余白を埋める」のスイッチを並べる。見出しの横の「初期化」は遠近と
 * 「余白を埋める」だけを戻す。wasm が遠近を描けない（`perspective` が無い）ときは節を出さない。
 */

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const SOURCE: DevelopSize = { width: 3000, height: 2000 };
const IDENTITY: DevelopGeometry = {
  rotate: 0,
  flipH: false,
  flipV: false,
  angle: 0,
  crop: { left: 0, top: 0, right: 1, bottom: 1 },
};
const LABELS = ["垂直方向", "水平方向", "回転", "縦横比", "拡大・縮小", "X オフセット", "Y オフセット"];

let container: HTMLDivElement;
let root: Root;
let changes: { geometry: DevelopGeometry; phase: PhotoEditingSliderPhase }[];

type HarnessProps = { initial: DevelopGeometry; perspective?: boolean; disabled?: boolean };

/** 変更の通知を受けて幾何を持ち替える面（`update` は呼ばれた時点の最新に当てる）。 */
function Harness(props: HarnessProps) {
  const [geometry, setGeometry] = useState(props.initial);
  const ref = useRef(props.initial);
  return (
    <PhotoEditingCropTools
      geometry={geometry}
      source={SOURCE}
      disabled={props.disabled ?? false}
      liveAngle={null}
      exportLongEdge={null}
      onLiveAngleChange={() => undefined}
      onCommit={() => undefined}
      onDone={() => undefined}
      onCancel={() => undefined}
      perspective={props.perspective ?? true}
      onGeometryChange={(update, phase) => {
        const next = update(ref.current);
        ref.current = next;
        changes.push({ geometry: next, phase });
        setGeometry(next);
      }}
    />
  );
}

async function render(props: HarnessProps) {
  await act(async () => {
    root.render(<Harness {...props} />);
  });
}

function toggle(): HTMLButtonElement {
  const found = Array.from(container.querySelectorAll<HTMLButtonElement>("h4 button")).find(
    (button) => button.textContent === "ジオメトリ",
  );
  if (!found) throw new Error("section toggle not found");
  return found;
}

function slider(label: string): HTMLInputElement {
  const found = container.querySelector<HTMLInputElement>(`input[type="range"][aria-label="${label}"]`);
  if (!found) throw new Error(`slider not found: ${label}`);
  return found;
}

function resetButton(): HTMLButtonElement {
  const found = container.querySelector<HTMLButtonElement>('button[aria-label="ジオメトリを初期化"]');
  if (!found) throw new Error("reset button not found");
  return found;
}

function constrainSwitch(): HTMLButtonElement {
  const found = container.querySelector<HTMLButtonElement>('button[role="switch"]');
  if (!found) throw new Error("switch not found");
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

describe("切り抜きの道具の「ジオメトリ」の節", () => {
  it("「反転と回転」の下に既定で閉じた節を置く（見出しの横の「初期化」は閉じていても出す）", async () => {
    await render({ initial: IDENTITY });
    const heading = Array.from(container.querySelectorAll("h4")).map((node) => node.textContent);
    expect(heading.indexOf("反転と回転")).toBeLessThan(heading.indexOf("ジオメトリ"));
    expect(toggle().getAttribute("aria-expanded")).toBe("false");
    expect(container.querySelector('[data-testid="photo-geometry-section"]')).toBeNull();
    expect(resetButton().textContent).toBe("初期化");
    // 戻すものが無い間は押せない
    expect(resetButton().disabled).toBe(true);
  });

  it("wasm が遠近を描けないときは節を出さない", async () => {
    await render({ initial: IDENTITY, perspective: false });
    expect(Array.from(container.querySelectorAll("h4")).map((node) => node.textContent)).not.toContain("ジオメトリ");
  });

  it("開くと 7 本のスライダー（範囲・単位は XMP の Perspective* どおり）と「余白を埋める」を出し、開いたことを端末に覚える", async () => {
    await render({ initial: IDENTITY });
    await click(toggle());
    expect(window.localStorage.getItem(PHOTO_EDITING_ADVANCED_SECTIONS_STORAGE_KEY)).toBe('["geometry"]');
    const section = container.querySelector('[data-testid="photo-geometry-section"]');
    const labels = Array.from(section?.querySelectorAll<HTMLInputElement>('input[type="range"]') ?? []).map((input) =>
      input.getAttribute("aria-label"),
    );
    expect(labels).toEqual(LABELS);
    expect([slider("垂直方向").min, slider("垂直方向").max, slider("垂直方向").step]).toEqual(["-100", "100", "1"]);
    expect([slider("回転").min, slider("回転").max, slider("回転").step]).toEqual(["-10", "10", "0.1"]);
    expect([slider("拡大・縮小").min, slider("拡大・縮小").max, slider("拡大・縮小").value]).toEqual(["50", "150", "100"]);
    expect(slider("X オフセット").step).toBe("0.1");
    expect(slider("拡大・縮小").getAttribute("aria-valuetext")).toBe("100%");
    expect(constrainSwitch().textContent).toContain("余白を埋める");
    expect(constrainSwitch().getAttribute("aria-checked")).toBe("false");
  });

  it("ドラッグの間は drag、離して commit（ほかの幾何は保つ）。ダブルクリックで既定値に戻す", async () => {
    window.localStorage.setItem(PHOTO_EDITING_ADVANCED_SECTIONS_STORAGE_KEY, '["geometry"]');
    const tilted: DevelopGeometry = { ...IDENTITY, rotate: 90, angle: 2, crop: { left: 0.1, top: 0, right: 0.9, bottom: 1 } };
    await render({ initial: tilted });
    await drag(slider("垂直方向"), [-10, -25]);
    expect(changes.map((change) => change.phase)).toEqual(["drag", "drag", "commit"]);
    const last = changes.at(-1)!.geometry;
    expect(last.perspective).toEqual({ vertical: -25, horizontal: 0, rotate: 0, aspect: 0, scale: 100, x: 0, y: 0 });
    expect([last.rotate, last.angle, last.crop]).toEqual([90, 2, tilted.crop]);
    expect(slider("垂直方向").getAttribute("aria-valuetext")).toBe("-25");
    // 値が既定でなければ「初期化」を押せる
    expect(resetButton().disabled).toBe(false);
    changes = [];
    await act(async () => {
      slider("垂直方向").dispatchEvent(new MouseEvent("dblclick", { bubbles: true }));
    });
    expect(changes).toHaveLength(1);
    expect(changes[0]?.phase).toBe("commit");
    expect(changes[0]?.geometry.perspective?.vertical).toBe(0);
  });

  it("「余白を埋める」は commit で切り替え、「初期化」は遠近と「余白を埋める」だけを戻す", async () => {
    window.localStorage.setItem(PHOTO_EDITING_ADVANCED_SECTIONS_STORAGE_KEY, '["geometry"]');
    await render({
      initial: {
        ...IDENTITY,
        angle: -3,
        crop: { left: 0.2, top: 0.1, right: 0.8, bottom: 0.9 },
        perspective: { vertical: -30, horizontal: 5, rotate: 1.5, aspect: 0, scale: 110, x: 0, y: -2.5 },
      },
    });
    expect(slider("回転").getAttribute("aria-valuetext")).toBe("+1.5°");
    expect(slider("Y オフセット").getAttribute("aria-valuetext")).toBe("-2.5");
    await click(constrainSwitch());
    expect(changes.at(-1)).toMatchObject({ phase: "commit", geometry: { constrain: true } });
    expect(constrainSwitch().getAttribute("aria-checked")).toBe("true");
    await click(resetButton());
    const reset = changes.at(-1)!;
    expect(reset.phase).toBe("commit");
    expect(reset.geometry.perspective).toBeUndefined();
    expect(reset.geometry.constrain).toBeUndefined();
    expect([reset.geometry.angle, reset.geometry.crop]).toEqual([-3, { left: 0.2, top: 0.1, right: 0.8, bottom: 0.9 }]);
    expect(resetButton().disabled).toBe(true);
  });

  it("範囲外の保存値は表示のために範囲に収めて見せる（保存値は書き換えない）", async () => {
    window.localStorage.setItem(PHOTO_EDITING_ADVANCED_SECTIONS_STORAGE_KEY, '["geometry"]');
    await render({
      initial: { ...IDENTITY, perspective: { vertical: -140, horizontal: 0, rotate: 12, aspect: 0, scale: 20, x: 0, y: 0 } },
    });
    expect(slider("垂直方向").value).toBe("-100");
    expect(slider("回転").getAttribute("aria-valuetext")).toBe("+10.0°");
    expect(slider("拡大・縮小").getAttribute("aria-valuetext")).toBe("50%");
    expect(changes).toHaveLength(0);
  });

  it("押せない間はスライダーもスイッチも押せない", async () => {
    window.localStorage.setItem(PHOTO_EDITING_ADVANCED_SECTIONS_STORAGE_KEY, '["geometry"]');
    await render({ initial: IDENTITY, disabled: true });
    expect(slider("水平方向").disabled).toBe(true);
    expect(constrainSwitch().disabled).toBe(true);
  });
});

describe("formatGeometryValue", () => {
  it("整数の項目は符号付き、回転は 0.1° 刻み、X・Y は 0.1 刻み、拡大・縮小は %", () => {
    expect(formatGeometryValue("vertical", -12)).toBe("-12");
    expect(formatGeometryValue("horizontal", 7)).toBe("+7");
    expect(formatGeometryValue("aspect", 0)).toBe("0");
    expect(formatGeometryValue("rotate", -0.04)).toBe("0.0°");
    expect(formatGeometryValue("rotate", 2.25)).toBe("+2.3°");
    expect(formatGeometryValue("x", -0.5)).toBe("-0.5");
    expect(formatGeometryValue("scale", 125)).toBe("125%");
  });
});
