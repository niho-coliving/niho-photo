// @vitest-environment jsdom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { computePhotoEditingHistogram } from "../photo-editing-histogram";

import { PhotoEditingHistogram } from "./photo-editing-histogram";

/**
 * 右パネルのヒストグラム（niho-photo#36）。RGB の 3 色を SVG で重ね、左上 = 黒つぶれ・右上 = 白飛びの印のボタン（`aria-pressed`）。
 */

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLDivElement;
let root: Root;

/** 左半分が黒、右半分が白（黒つぶれ 50%・白飛び 50%）の 4x2 の画。 */
function halfBlackHalfWhite() {
  const rgba = new Uint8ClampedArray(4 * 2 * 4);
  for (let pixel = 0; pixel < 8; pixel += 1) {
    const white = pixel % 4 >= 2;
    rgba.set(white ? [255, 255, 255, 255] : [0, 0, 0, 255], pixel * 4);
  }
  return computePhotoEditingHistogram(rgba, 4, 2);
}

type HistogramProps = Parameters<typeof PhotoEditingHistogram>[0];

async function render(extra: Partial<HistogramProps> = {}) {
  const props: HistogramProps = {
    data: halfBlackHalfWhite(),
    clip: { shadows: false, highlights: false },
    onToggleShadows: vi.fn(),
    onToggleHighlights: vi.fn(),
    ...extra,
  };
  await act(async () => {
    root.render(<PhotoEditingHistogram {...props} />);
  });
  return props;
}

function chart(): SVGSVGElement {
  const found = container.querySelector<SVGSVGElement>('svg[role="img"]');
  if (!found) throw new Error("chart not found");
  return found;
}

function clipButton(label: string): HTMLButtonElement {
  const found = container.querySelector<HTMLButtonElement>(`button[aria-label="${label}"]`);
  if (!found) throw new Error(`button not found: ${label}`);
  return found;
}

async function click(element: Element) {
  await act(async () => {
    element.dispatchEvent(new MouseEvent("click", { bubbles: true }));
  });
}

beforeEach(() => {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

describe("PhotoEditingHistogram", () => {
  it("読み上げ名に黒つぶれ・白飛びの割合を入れる（role=img）", async () => {
    await render();
    expect(chart().getAttribute("aria-label")).toBe("ヒストグラム。黒つぶれ 50%、白飛び 50%");
  });

  it("割合は整数の %、0 より大きく 1% に満たなければ「1%未満」", async () => {
    const pixels = 200;
    const rgba = new Uint8ClampedArray(pixels * 4).fill(128);
    // 1 画素だけ黒（0.5%）、3 画素を白（1.5% → 2%）
    rgba.set([0, 0, 0, 255], 0);
    for (const pixel of [1, 2, 3]) rgba.set([255, 255, 255, 255], pixel * 4);
    for (let offset = 3; offset < rgba.length; offset += 4) rgba[offset] = 255;
    await render({ data: computePhotoEditingHistogram(rgba, pixels, 1) });
    expect(chart().getAttribute("aria-label")).toBe("ヒストグラム。黒つぶれ 1%未満、白飛び 2%");
  });

  it("R / G / B の 3 色を、塗りと上辺の線（256 階調ぶんの点）として重ねる", async () => {
    await render();
    const channels = Array.from(chart().querySelectorAll<SVGGElement>("g[data-channel]"));
    expect(channels.map((group) => group.dataset.channel)).toEqual(["blue", "green", "red"]);
    for (const group of channels) {
      const [area, line] = Array.from(group.querySelectorAll("path"));
      expect(area?.getAttribute("d")?.match(/L/g)).toHaveLength(257);
      expect(area?.getAttribute("d")?.endsWith("Z")).toBe(true);
      // 線は上辺だけ（左右・下の辺を塗らない）
      expect(line?.getAttribute("d")?.startsWith("M0.5 ")).toBe(true);
      expect(line?.getAttribute("d")?.match(/L/g)).toHaveLength(255);
      expect(line?.getAttribute("d")).not.toContain("Z");
      expect(line?.getAttribute("fill")).toBe("none");
      // 色は画面の token（直書きの色値にしない）
      expect((area as SVGPathElement).style.fill).toMatch(/^var\(--niho-/);
      expect((line as SVGPathElement).style.stroke).toMatch(/^var\(--niho-/);
    }
    // 画の左端（黒）・右端（白）の階調は一番上まで届く
    const red = channels.find((group) => group.dataset.channel === "red")?.querySelector("path")?.getAttribute("d") ?? "";
    expect(red).toContain("L0.5 0");
    expect(red).toContain("L255.5 0");
  });

  it("パネルの幅に合わせて伸びる（viewBox + preserveAspectRatio=none）。動きは付けない", async () => {
    await render();
    expect(chart().getAttribute("viewBox")).toBe("0 0 256 100");
    expect(chart().getAttribute("preserveAspectRatio")).toBe("none");
    const frame = container.querySelector<HTMLElement>('[data-testid="photo-histogram"]');
    expect(frame?.className).toContain("border");
    // 点滅・アニメーション・transition は一切使わない（prefers-reduced-motion に頼らない）
    expect(container.innerHTML).not.toMatch(/animate|transition|<animate|<set /);
  });

  it("左上が黒つぶれ・右上が白飛びの印。aria-pressed と日本語の読み上げ名、押すと切り替えの通知", async () => {
    const props = await render({ clip: { shadows: true, highlights: false } });
    const shadows = clipButton("黒つぶれを写真に表示");
    const highlights = clipButton("白飛びを写真に表示");
    expect(shadows.getAttribute("aria-pressed")).toBe("true");
    expect(highlights.getAttribute("aria-pressed")).toBe("false");
    expect(shadows.className).toContain("left-0");
    expect(highlights.className).toContain("right-0");
    expect(shadows.title).toBe("黒つぶれを写真に表示（J）");
    expect(highlights.title).toBe("白飛びを写真に表示（J）");
    // ボタンの中の絵は読み上げない
    expect(shadows.querySelector("svg")?.getAttribute("aria-hidden")).toBe("true");

    await click(shadows);
    expect(props.onToggleShadows).toHaveBeenCalledTimes(1);
    expect(props.onToggleHighlights).not.toHaveBeenCalled();
    await click(highlights);
    expect(props.onToggleHighlights).toHaveBeenCalledTimes(1);
  });

  it("押した側だけ三角を色で塗る（黒つぶれ = 青 / 白飛び = 赤）。押していない側は線だけ", async () => {
    await render({ clip: { shadows: false, highlights: true } });
    const shadowsTriangle = clipButton("黒つぶれを写真に表示").querySelector<SVGPathElement>("path");
    const highlightsTriangle = clipButton("白飛びを写真に表示").querySelector<SVGPathElement>("path");
    expect(shadowsTriangle?.style.fill).toBe("none");
    // 赤（白飛び）。jsdom は `rgb(255, 30, 30)` に整えて返し、ブラウザは空白区切りでも受ける
    expect(highlightsTriangle?.style.fill).toMatch(/^rgb\(255,? 30,? 30\)$/);
  });

  it("画をまだ数えていない間は、同じ高さの空の枠を見せ、印は押せない（読み上げは「準備中」）", async () => {
    const props = await render({ data: null });
    expect(chart().getAttribute("aria-label")).toBe("ヒストグラム。準備中");
    expect(chart().querySelector("g[data-channel]")).toBeNull();
    expect(clipButton("黒つぶれを写真に表示").disabled).toBe(true);
    expect(clipButton("白飛びを写真に表示").disabled).toBe(true);
    await click(clipButton("黒つぶれを写真に表示"));
    expect(props.onToggleShadows).not.toHaveBeenCalled();
  });

  it("切り抜き・背景除去の道具の間（clipDisabled）は、分布は出して印だけ押せなくする", async () => {
    const props = await render({ clipDisabled: true });
    expect(chart().querySelectorAll("g[data-channel]")).toHaveLength(3);
    expect(clipButton("黒つぶれを写真に表示").disabled).toBe(true);
    expect(clipButton("白飛びを写真に表示").disabled).toBe(true);
    await click(clipButton("白飛びを写真に表示"));
    expect(props.onToggleHighlights).not.toHaveBeenCalled();
  });
});
