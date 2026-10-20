// @vitest-environment jsdom

import { act, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  BROWSER_CLOUD_NO_LIST_FILTER,
  countBrowserCloudListFilter,
  type BrowserCloudListFilter,
} from "../browser-photo-cloud-source";

import { BrowserPhotoListFilterControl } from "./browser-photo-editing-filter";

/**
 * 一覧の絞り込みのボタンとパネル（F5b 移行元設計 の画面 2 本目）。条件は手元の state に持ち、変えた・外した記録を残す。パネルは
 * Radix の Popover なので document.body に出る。
 */

let container: HTMLDivElement;
let root: Root;
let changes: Partial<BrowserCloudListFilter>[];
let clears: number;

function Harness(props: { initial: BrowserCloudListFilter }) {
  const [filter, setFilter] = useState(props.initial);
  return (
    <div>
      <button type="button">外の写真</button>
      <BrowserPhotoListFilterControl
        filter={filter}
        count={countBrowserCloudListFilter(filter)}
        onChange={(patch) => {
          changes.push(patch);
          setFilter((current) => ({ ...current, ...patch }));
        }}
        onClear={() => {
          clears += 1;
          setFilter(BROWSER_CLOUD_NO_LIST_FILTER);
        }}
      />
    </div>
  );
}

async function render(initial: BrowserCloudListFilter = BROWSER_CLOUD_NO_LIST_FILTER) {
  await act(async () => {
    root.render(<Harness initial={initial} />);
  });
}

/** Radix の後片付け（閉じたらボタンへフォーカスを戻す・開いたら外の押下を聞き始める）は setTimeout で走るので、1 回待つ。 */
async function tick() {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

async function click(element: Element | null | undefined) {
  if (!element) throw new Error("element not found");
  await act(async () => {
    element.dispatchEvent(new MouseEvent("click", { bubbles: true }));
  });
}

async function press(target: Element | null, key: string) {
  if (!target) throw new Error("target not found");
  await act(async () => {
    target.dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true }));
  });
}

function trigger(): HTMLButtonElement {
  const found = container.querySelector<HTMLButtonElement>('button[aria-label="絞り込み"]');
  if (!found) throw new Error("filter button not found");
  return found;
}

function panel(): HTMLElement | null {
  return document.body.querySelector<HTMLElement>('[role="dialog"][aria-label="絞り込み"]');
}

function radios(group: string): HTMLButtonElement[] {
  return Array.from(
    document.body.querySelectorAll<HTMLButtonElement>(`[role="radiogroup"][aria-label="${group}"] [role="radio"]`),
  );
}

function radio(group: string, label: string): HTMLButtonElement {
  const found = radios(group).find((candidate) => candidate.textContent === label);
  if (!found) throw new Error(`radio not found: ${group} ${label}`);
  return found;
}

function states(group: string): [string | null, string | null][] {
  return radios(group).map((candidate) => [candidate.textContent, candidate.getAttribute("aria-checked")]);
}

function clearButton(): HTMLButtonElement | undefined {
  return Array.from(panel()?.querySelectorAll<HTMLButtonElement>("button") ?? []).find(
    (candidate) => candidate.textContent === "解除",
  );
}

beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  changes = [];
  clears = 0;
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
});

describe("一覧の絞り込み（F5b #17125）", () => {
  it("条件が無いときはアイコンだけ（数も地の色も出さない）。押すとパネルを出し、選んでいる選択肢へフォーカスする", async () => {
    await render();
    expect(trigger().title).toBe("絞り込み");
    expect(trigger().getAttribute("aria-haspopup")).toBe("dialog");
    expect(trigger().getAttribute("aria-expanded")).toBe("false");
    expect(trigger().textContent).toBe("");
    expect(trigger().className).toContain("text-niho-text-muted");
    expect(trigger().className).not.toContain("bg-niho-accent-soft");
    // 見た目は 32px、押せる範囲は 44px
    expect(trigger().className).toContain("h-8");
    expect(trigger().className).toContain("after:-inset-y-1.5");
    expect(panel()).toBeNull();

    await click(trigger());
    expect(panel()).not.toBeNull();
    expect(trigger().getAttribute("aria-expanded")).toBe("true");
    // 白い面・枠・影と角丸は書き出しのシートと同じ。幅は内容に合わせ、画面の左右に 8px 残す
    expect(panel()?.className).toContain("bg-white");
    expect(panel()?.className).not.toContain("bg-white/92");
    expect(panel()?.className).toContain("border-niho-border");
    expect(panel()?.className).toContain("shadow-lg");
    expect(panel()?.className).toContain("rounded-2xl");
    expect(panel()?.className).toContain("w-max");
    expect(panel()?.className).not.toContain("w-72");
    expect(panel()?.className).toContain("max-w-[calc(100vw-1rem)]");
    expect(states("種類")).toEqual([
      ["すべて", "true"],
      ["RAW", "false"],
      ["JPEG", "false"],
      ["HEIC", "false"],
    ]);
    expect(states("補正")).toEqual([
      ["すべて", "true"],
      ["補正済み", "false"],
      ["未補正", "false"],
    ]);
    expect(document.activeElement).toBe(radio("種類", "すべて"));
    // 説明文・件数・「適用」は置かず、条件が無ければ「解除」も出さない
    expect(clearButton()).toBeUndefined();
    expect(Array.from(panel()?.querySelectorAll("button") ?? []).map((button) => button.textContent)).toEqual([
      "すべて",
      "RAW",
      "JPEG",
      "HEIC",
      "すべて",
      "補正済み",
      "未補正",
    ]);
  });

  it("選ぶとすぐ掛かり、パネルは開いたまま。ボタンに条件の数を添え、「解除」で全部外す", async () => {
    await render();
    await click(trigger());

    await click(radio("種類", "RAW"));
    expect(changes).toEqual([{ kind: "raw" }]);
    expect(panel()).not.toBeNull();
    expect(radio("種類", "RAW").getAttribute("aria-checked")).toBe("true");
    expect(radio("種類", "RAW").className).toContain("bg-niho-accent-soft");
    expect(trigger().textContent).toBe("1");
    expect(trigger().className).toContain("bg-niho-accent-soft");
    expect(trigger().className).toContain("text-niho-accent-ink");
    expect(clearButton()).toBeDefined();

    // 選んでいる選択肢をもう一度押しても何もしない
    await click(radio("種類", "RAW"));
    expect(changes).toHaveLength(1);

    await click(radio("補正", "補正済み"));
    expect(changes).toEqual([{ kind: "raw" }, { edited: true }]);
    expect(trigger().textContent).toBe("2");

    await click(clearButton());
    expect(clears).toBe(1);
    expect(panel()).not.toBeNull();
    expect(trigger().textContent).toBe("");
    expect(trigger().className).not.toContain("bg-niho-accent-soft");
    expect(clearButton()).toBeUndefined();
    expect(states("種類")[0]).toEqual(["すべて", "true"]);
    expect(states("補正")[0]).toEqual(["すべて", "true"]);
    // 押した「解除」は消えるので、フォーカスは最初の群の「すべて」へ
    expect(document.activeElement).toBe(radio("種類", "すべて"));
  });

  it("←→ でも選び直す（radio と同じ。端から反対の端へ回る）", async () => {
    await render();
    await click(trigger());

    await press(radio("種類", "すべて"), "ArrowRight");
    expect(changes).toEqual([{ kind: "raw" }]);
    expect(document.activeElement).toBe(radio("種類", "RAW"));
    expect(radio("種類", "RAW").tabIndex).toBe(0);
    expect(radio("種類", "すべて").tabIndex).toBe(-1);

    await press(radio("種類", "RAW"), "ArrowLeft");
    await press(radio("種類", "すべて"), "ArrowLeft");
    expect(changes).toEqual([{ kind: "raw" }, { kind: null }, { kind: "heic" }]);
    expect(document.activeElement).toBe(radio("種類", "HEIC"));

    await press(radio("補正", "すべて"), "ArrowRight");
    expect(changes.at(-1)).toEqual({ edited: true });
    expect(document.activeElement).toBe(radio("補正", "補正済み"));
  });

  it("条件のある状態で開くと、選んでいる選択肢へフォーカスする", async () => {
    await render({ kind: "jpeg", edited: false });
    expect(trigger().textContent).toBe("2");

    await click(trigger());
    expect(states("補正")).toEqual([
      ["すべて", "false"],
      ["補正済み", "false"],
      ["未補正", "true"],
    ]);
    expect(document.activeElement).toBe(radio("種類", "JPEG"));
  });

  it("Esc で閉じてボタンへフォーカスを戻す。パネルの外を押しても閉じる", async () => {
    await render();
    await click(trigger());
    await press(document.activeElement, "Escape");
    expect(panel()).toBeNull();
    expect(trigger().getAttribute("aria-expanded")).toBe("false");
    await tick();
    expect(document.activeElement).toBe(trigger());

    await click(trigger());
    expect(panel()).not.toBeNull();
    await tick();
    // パネルの中を押しても閉じない
    await act(async () => {
      radio("補正", "未補正").dispatchEvent(new Event("pointerdown", { bubbles: true }));
    });
    expect(panel()).not.toBeNull();
    // jsdom の PointerEvent は Radix の外側の判定に届かないので、ほかのテストと同じく Event で送る
    await act(async () => {
      container.querySelector("button")?.dispatchEvent(new Event("pointerdown", { bubbles: true }));
    });
    expect(panel()).toBeNull();
    expect(trigger().getAttribute("aria-expanded")).toBe("false");
  });
});
