// @vitest-environment jsdom

import { act, useRef, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { PhotoEditingSettings } from "../photo-editing-types";

import type { PhotoEditingSliderPhase } from "./photo-editing-adjustment-controls";
import { PhotoEditingToneCurve, PhotoEditingToneCurveSection } from "./photo-editing-tone-curve";

/**
 * トーンカーブのグラフと「カーブ」の節（niho-photo#37）。空いたところを押すと点が増えてそのままドラッグでき（drag → 離して commit）、
 * 点のドラッグ・ダブルクリック・キー（矢印 / Delete / Enter）で直す。両端の点は消せない。チャンネルは RGB / R / G / B で、直すのは
 * 選んだチャンネルの 1 本だけ。
 *
 * jsdom は要素の大きさを測れないので、グラフの `getBoundingClientRect` を (0,0) から 200 × 200 に差し替える（入力 x は左から、
 * 出力 y は下から: 画面の (100, 60) = 入力 0.5・出力 0.7）。
 */

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const SIZE = 200;

let container: HTMLDivElement;
let root: Root;
let changes: { settings: PhotoEditingSettings; phase: PhotoEditingSliderPhase }[];

type HarnessProps = {
  initial: PhotoEditingSettings;
  disabled?: boolean;
  histogram?: { red: Uint32Array; green: Uint32Array; blue: Uint32Array } | null;
  section?: boolean;
};

/** 変更の通知を受けて設定を持ち替える画面（`update` は呼ばれた時点の最新に当てる）。 */
function Harness(props: HarnessProps) {
  const [settings, setSettings] = useState(props.initial);
  const settingsRef = useRef(props.initial);
  const curveProps = {
    settings,
    histogram: props.histogram ?? null,
    disabled: props.disabled ?? false,
    onSettingsChange: (update: (current: PhotoEditingSettings) => PhotoEditingSettings, phase: PhotoEditingSliderPhase) => {
      const next = update(settingsRef.current);
      settingsRef.current = next;
      changes.push({ settings: next, phase });
      setSettings(next);
    },
  };
  return props.section ? <PhotoEditingToneCurveSection {...curveProps} /> : <PhotoEditingToneCurve {...curveProps} />;
}

async function render(props: HarnessProps) {
  await act(async () => {
    root.render(<Harness {...props} />);
  });
}

function graph(): HTMLElement {
  const found = container.querySelector<HTMLElement>('[data-testid="photo-tone-curve-graph"]');
  if (!found) throw new Error("curve graph not found");
  return found;
}

function points(): HTMLButtonElement[] {
  return Array.from(container.querySelectorAll<HTMLButtonElement>("button[data-curve-point]"));
}

function point(index: number): HTMLButtonElement {
  const found = points()[index];
  if (!found) throw new Error(`curve point not found: ${index}`);
  return found;
}

function channelButton(label: string): HTMLButtonElement {
  const found = container.querySelector<HTMLButtonElement>(`[role="group"][aria-label="曲線のチャンネル"] button[aria-label="${label}"]`);
  if (!found) throw new Error(`channel button not found: ${label}`);
  return found;
}

function valueText(): string {
  return container.querySelector('[data-testid="photo-tone-curve-value"]')?.textContent ?? "";
}

function curvePoints(settings: PhotoEditingSettings, channel: string): unknown {
  const curves = settings.toneCurves;
  if (!Array.isArray(curves)) return undefined;
  return (curves.find((curve) => (curve as { channel?: string }).channel === channel) as { points?: unknown } | undefined)?.points;
}

/** グラフの座標（0〜1）→ 画面の位置 */
function at(x: number, y: number): [number, number] {
  return [x * SIZE, (1 - y) * SIZE];
}

async function pointer(type: string, [clientX, clientY]: [number, number], target: Element = graph()) {
  await act(async () => {
    target.dispatchEvent(
      new PointerEvent(type, { bubbles: true, cancelable: true, clientX, clientY, pointerId: 1, button: 0, pointerType: "mouse" }),
    );
  });
}

async function doubleClick([clientX, clientY]: [number, number]) {
  await act(async () => {
    graph().dispatchEvent(new MouseEvent("dblclick", { bubbles: true, cancelable: true, clientX, clientY }));
  });
}

async function keyDown(target: Element, key: string, init: KeyboardEventInit = {}) {
  const event = new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true, ...init });
  await act(async () => {
    target.dispatchEvent(event);
  });
  return event;
}

async function click(element: Element) {
  await act(async () => {
    element.dispatchEvent(new MouseEvent("click", { bubbles: true }));
  });
}

async function focus(element: HTMLElement) {
  await act(async () => {
    element.focus();
  });
}

function lifted() {
  return [
    { x: 0, y: 0 },
    { x: 0.5, y: 0.6 },
    { x: 1, y: 1 },
  ];
}

beforeEach(() => {
  changes = [];
  window.localStorage.clear();
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  vi.spyOn(Element.prototype, "getBoundingClientRect").mockImplementation(function (this: Element) {
    const box = this.getAttribute("data-testid") === "photo-tone-curve-graph" ? SIZE : 0;
    return { left: 0, top: 0, x: 0, y: 0, width: box, height: box, right: box, bottom: box, toJSON: () => ({}) } as DOMRect;
  });
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.restoreAllMocks();
  window.localStorage.clear();
});

describe("PhotoEditingToneCurve", () => {
  it("RGB / R / G / B の切り替え（押した状態は aria-pressed）。選んだチャンネルの曲線を太く描き、点の読み上げにチャンネルを含める", async () => {
    await render({ initial: {} });
    const buttons = Array.from(container.querySelectorAll('[aria-label="曲線のチャンネル"] button'));
    expect(buttons.map((button) => button.textContent)).toEqual(["RGB", "R", "G", "B"]);
    expect(buttons.map((button) => button.getAttribute("aria-label"))).toEqual(["RGB 曲線", "赤の曲線", "緑の曲線", "青の曲線"]);
    expect(channelButton("RGB 曲線").getAttribute("aria-pressed")).toBe("true");
    expect(points().map((button) => button.getAttribute("aria-label"))).toEqual([
      "RGB 曲線の点 1 / 入力 0 出力 0",
      "RGB 曲線の点 2 / 入力 100 出力 100",
    ]);
    await click(channelButton("赤の曲線"));
    expect(channelButton("赤の曲線").getAttribute("aria-pressed")).toBe("true");
    expect(channelButton("RGB 曲線").getAttribute("aria-pressed")).toBe("false");
    expect(container.querySelector('path[data-active="true"]')?.getAttribute("data-channel")).toBe("red");
    expect(point(0).getAttribute("aria-label")).toBe("赤の曲線の点 1 / 入力 0 出力 0");
    // 切り替えは見るだけ（設定は変えない）
    expect(changes).toEqual([]);
  });

  it("空いたところを押すと点が増え（drag）、そのままドラッグして離すと commit。足した点に focus し、入力と出力を出す", async () => {
    await render({ initial: { exposure: 0.2 } });
    expect(valueText()).toContain("グラフを押して点を足し");
    await pointer("pointerdown", at(0.5, 0.7));
    expect(changes).toHaveLength(1);
    expect(changes[0].phase).toBe("drag");
    expect(changes[0].settings).toEqual({
      exposure: 0.2,
      toneCurves: [
        {
          channel: "rgb",
          points: [
            { x: 0, y: 0 },
            { x: 0.5, y: 0.7 },
            { x: 1, y: 1 },
          ],
        },
      ],
    });
    expect(points()).toHaveLength(3);
    expect(document.activeElement).toBe(point(1));
    await pointer("pointermove", at(0.5, 0.8));
    await pointer("pointerup", at(0.5, 0.8));
    expect(changes.map((change) => change.phase)).toEqual(["drag", "drag", "commit"]);
    expect(curvePoints(changes[2].settings, "rgb")).toEqual([
      { x: 0, y: 0 },
      { x: 0.5, y: 0.8 },
      { x: 1, y: 1 },
    ]);
    expect(valueText()).toBe("入力 50 / 出力 80");
  });

  it("ドラッグ中にカーブを閉じても変更を commit する", async () => {
    await render({ initial: { toneCurves: [{ channel: "rgb", points: lifted() }] } });
    await pointer("pointerdown", at(0.5, 0.6));
    await pointer("pointermove", at(0.6, 0.8));
    await act(async () => root.render(null));

    expect(changes.map((change) => change.phase)).toEqual(["drag", "commit"]);
    expect(curvePoints(changes[changes.length - 1].settings, "rgb")).toEqual([
      { x: 0, y: 0 },
      { x: 0.6, y: 0.8 },
      { x: 1, y: 1 },
    ]);
  });

  it("点は選んだチャンネルの 1 本にだけ足す（ほかのチャンネルの曲線はそのまま）", async () => {
    const rgb = { channel: "rgb", points: lifted() };
    await render({ initial: { toneCurves: [rgb] } });
    await click(channelButton("青の曲線"));
    await pointer("pointerdown", at(0.25, 0.4));
    await pointer("pointerup", at(0.25, 0.4));
    const curves = changes[changes.length - 1].settings.toneCurves as unknown[];
    expect(curves[0]).toBe(rgb);
    expect(curves[1]).toEqual({
      channel: "blue",
      points: [
        { x: 0, y: 0 },
        { x: 0.25, y: 0.4 },
        { x: 1, y: 1 },
      ],
    });
    // ほかのチャンネルの直した曲線は薄く描く
    expect(container.querySelector('path[data-channel="rgb"]')?.getAttribute("stroke-opacity")).toBe("0.5");
    expect(container.querySelector('path[data-channel="red"]')).toBeNull();
  });

  it("点をドラッグして動かす（押しただけ・3px 以内の揺れでは変えない）。両端の点は上下だけ", async () => {
    await render({ initial: { toneCurves: [{ channel: "rgb", points: lifted() }] } });
    const [x, y] = at(0.5, 0.6);
    await pointer("pointerdown", [x + 1, y + 1]);
    expect(document.activeElement).toBe(point(1));
    await pointer("pointermove", [x + 2, y + 2]);
    await pointer("pointerup", [x + 2, y + 2]);
    expect(changes).toEqual([]);
    expect(valueText()).toBe("入力 50 / 出力 60");

    await pointer("pointerdown", [x, y]);
    await pointer("pointermove", at(0.6, 0.8));
    await pointer("pointerup", at(0.6, 0.8));
    expect(changes.map((change) => change.phase)).toEqual(["drag", "commit"]);
    expect(curvePoints(changes[1].settings, "rgb")).toEqual([
      { x: 0, y: 0 },
      { x: 0.6, y: 0.8 },
      { x: 1, y: 1 },
    ]);

    changes = [];
    await pointer("pointerdown", at(0, 0));
    await pointer("pointermove", at(0.25, 0.25));
    await pointer("pointerup", at(0.25, 0.25));
    expect(curvePoints(changes[changes.length - 1].settings, "rgb")).toEqual([
      { x: 0, y: 0.25 },
      { x: 0.6, y: 0.8 },
      { x: 1, y: 1 },
    ]);
  });

  it("点のダブルクリックで消す（両端の点は消せない。直線に戻ったら toneCurves ごと消す）", async () => {
    await render({ initial: { exposure: 0.1, toneCurves: [{ channel: "rgb", points: lifted() }] } });
    await doubleClick(at(0, 0));
    expect(changes).toEqual([]);
    await doubleClick(at(0.5, 0.6));
    expect(changes).toHaveLength(1);
    expect(changes[0].phase).toBe("commit");
    expect(changes[0].settings).toEqual({ exposure: 0.1 });
    expect(points()).toHaveLength(2);
  });

  it("取り込んだプリセットの曲線（4 チャンネル）を出して動かせる。動かしたチャンネルだけを書き直す", async () => {
    const red = { channel: "red", points: [{ x: 0, y: 0 }, { x: 70 / 255, y: 80 / 255 }, { x: 1, y: 1 }] };
    const rgb = { channel: "rgb", points: [{ x: 0, y: 20 / 255 }, { x: 1, y: 1 }] };
    const blue = { channel: "blue", points: [{ x: 0, y: 0 }, { x: 63 / 255, y: 56 / 255 }, { x: 1, y: 1 }] };
    await render({ initial: { toneCurves: [blue, red, rgb] } });
    expect(point(0).getAttribute("aria-label")).toBe("RGB 曲線の点 1 / 入力 0 出力 8");
    await click(channelButton("青の曲線"));
    expect(point(1).getAttribute("aria-label")).toBe("青の曲線の点 2 / 入力 25 出力 22");
    await pointer("pointerdown", at(63 / 255, 56 / 255));
    await pointer("pointermove", at(0.3, 0.3));
    await pointer("pointerup", at(0.3, 0.3));
    const curves = changes[changes.length - 1].settings.toneCurves as unknown[];
    expect(curves).toHaveLength(3);
    expect(curves[0]).toEqual({ channel: "blue", points: [{ x: 0, y: 0 }, { x: 0.3, y: 0.3 }, { x: 1, y: 1 }] });
    expect(curves[1]).toBe(red);
    expect(curves[2]).toBe(rgb);
  });

  it("キー: 矢印で 1%（Shift で 10%）、Delete で消す、Enter で隣の点との間に足す。写真の送り・写真を消すキーには渡さない", async () => {
    const documentKeys = vi.fn();
    document.addEventListener("keydown", documentKeys);
    try {
      await render({ initial: { toneCurves: [{ channel: "rgb", points: lifted() }] } });
      await focus(point(1));
      const up = await keyDown(point(1), "ArrowUp");
      expect(up.defaultPrevented).toBe(true);
      expect(changes[0].phase).toBe("commit");
      expect(curvePoints(changes[0].settings, "rgb")).toEqual([{ x: 0, y: 0 }, { x: 0.5, y: 0.61 }, { x: 1, y: 1 }]);
      await keyDown(point(1), "ArrowRight", { shiftKey: true });
      expect(curvePoints(changes[1].settings, "rgb")).toEqual([{ x: 0, y: 0 }, { x: 0.6, y: 0.61 }, { x: 1, y: 1 }]);
      expect(point(1).getAttribute("aria-label")).toBe("RGB 曲線の点 2 / 入力 60 出力 61");

      // 両端の点は左右に動かず、消せない（キーは使う）
      const before = changes[changes.length - 1].settings;
      await keyDown(point(0), "ArrowLeft");
      const endDelete = await keyDown(point(0), "Delete");
      expect(endDelete.defaultPrevented).toBe(true);
      expect(changes[changes.length - 1].settings).toBe(before);
      expect(points()).toHaveLength(3);

      await focus(point(1));
      const remove = await keyDown(point(1), "Backspace");
      expect(remove.defaultPrevented).toBe(true);
      expect(changes[changes.length - 1].settings).toEqual({});
      expect(document.activeElement).toBe(point(0));

      const add = await keyDown(point(0), "Enter");
      expect(add.defaultPrevented).toBe(true);
      expect(curvePoints(changes[changes.length - 1].settings, "rgb")).toEqual([{ x: 0, y: 0 }, { x: 0.5, y: 0.5 }, { x: 1, y: 1 }]);
      expect(document.activeElement).toBe(point(1));
      expect(documentKeys).not.toHaveBeenCalled();

      // ⌘Z などの修飾キーつきは扱わない（取り消し・やり直しのキーに渡す）
      const count = changes.length;
      const undo = await keyDown(point(1), "z", { metaKey: true });
      expect(undo.defaultPrevented).toBe(false);
      expect(changes).toHaveLength(count);
      expect(documentKeys).toHaveBeenCalledTimes(1);
    } finally {
      document.removeEventListener("keydown", documentKeys);
    }
  });

  it("押せない間（閲覧のみ・操作の途中）は点を足せず、点も押せない（チャンネルは見られる）", async () => {
    await render({ initial: { toneCurves: [{ channel: "rgb", points: lifted() }] }, disabled: true });
    await pointer("pointerdown", at(0.25, 0.5));
    await pointer("pointerup", at(0.25, 0.5));
    await doubleClick(at(0.5, 0.6));
    expect(changes).toEqual([]);
    expect(points().every((button) => button.disabled)).toBe(true);
    expect(valueText()).toBe("");
    expect(graph().className).toContain("cursor-not-allowed");
    expect(channelButton("緑の曲線").disabled).toBe(false);
  });

  it("ドラッグの途中で押せなくなったら、そこまでを確定してやめる", async () => {
    await render({ initial: {} });
    await pointer("pointerdown", at(0.5, 0.7));
    await render({ initial: {}, disabled: true });
    expect(changes.map((change) => change.phase)).toEqual(["drag", "commit"]);
    await pointer("pointermove", at(0.5, 0.9));
    await pointer("pointerup", at(0.5, 0.9));
    expect(changes).toHaveLength(2);
  });

  it("背後にヒストグラムの度数から作った輝度を薄く敷く（無ければ敷かない）", async () => {
    await render({ initial: {} });
    expect(container.querySelector('[data-testid="photo-tone-curve-histogram"]')).toBeNull();
    act(() => root.unmount());
    root = createRoot(container);
    const red = new Uint32Array(256).fill(10);
    const green = new Uint32Array(256).fill(20);
    const blue = new Uint32Array(256).fill(30);
    await render({ initial: {}, histogram: { red, green, blue } });
    const layer = container.querySelector('[data-testid="photo-tone-curve-histogram"]');
    expect(layer?.getAttribute("transform")).toBe("scale(0.00390625 0.01)");
    expect(layer?.querySelector("path")?.getAttribute("d")?.startsWith("M0 100L0.5 0")).toBe(true);
  });
});

describe("PhotoEditingToneCurveSection", () => {
  it("「カーブ」の節は既定で閉じ、開くとグラフを出す。「初期化」は直線のままなら押せない", async () => {
    await render({ initial: {}, section: true });
    const toggle = container.querySelector<HTMLButtonElement>("h4 button");
    expect(toggle?.textContent).toBe("カーブ");
    expect(toggle?.getAttribute("aria-expanded")).toBe("false");
    expect(container.querySelector('[data-testid="photo-tone-curve-graph"]')).toBeNull();
    const reset = container.querySelector<HTMLButtonElement>('button[aria-label="カーブを初期化"]');
    expect(reset?.textContent).toBe("初期化");
    expect(reset?.disabled).toBe(true);
    await click(toggle as HTMLButtonElement);
    expect(container.querySelector('[data-testid="photo-tone-curve-graph"]')).not.toBeNull();
  });

  it("「初期化」は曲線だけを直線に戻して commit する（ほかの補正・パラメトリックは保つ）。押せない間は押せない", async () => {
    const initial = {
      exposure: 0.4,
      parametricShadows: 12,
      toneCurves: [
        { channel: "rgb", points: lifted() },
        { channel: "red", points: [{ x: 0, y: 0.1 }, { x: 1, y: 1 }] },
      ],
    };
    await render({ initial, section: true, disabled: true });
    expect(container.querySelector<HTMLButtonElement>('button[aria-label="カーブを初期化"]')?.disabled).toBe(true);
    act(() => root.unmount());
    root = createRoot(container);
    await render({ initial, section: true });
    const reset = container.querySelector<HTMLButtonElement>('button[aria-label="カーブを初期化"]');
    expect(reset?.disabled).toBe(false);
    await click(reset as HTMLButtonElement);
    expect(changes).toEqual([{ settings: { exposure: 0.4, parametricShadows: 12 }, phase: "commit" }]);
    expect(reset?.disabled).toBe(true);
  });
});
