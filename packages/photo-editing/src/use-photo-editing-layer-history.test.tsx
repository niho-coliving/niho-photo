// @vitest-environment jsdom

import { StrictMode, act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { hasPhotoEditingLayerHistoryEntry, usePhotoEditingLayerHistory } from "./use-photo-editing-layer-history";

/**
 * スマホの 1 枚の編集の層を、端末の「戻る」で閉じる（F6c 移行元設計）。層が出ている間だけ履歴に 1 つ積み、「戻る」で外れたら
 * 積み直してから `onBack`、層が閉じたら外す。jsdom の `history.back()` は非同期なので、popstate を待って確かめる。
 */

let container: HTMLDivElement;
let root: Root;
let backs: string[];

function Layer(props: { name: string }) {
  usePhotoEditingLayerHistory(() => backs.push(props.name));
  return null;
}

function nextPopState(): Promise<void> {
  return new Promise((resolve) => {
    window.addEventListener("popstate", () => resolve(), { once: true });
  });
}

/** 端末の「戻る」。 */
async function goBack() {
  await act(async () => {
    const popped = nextPopState();
    window.history.back();
    await popped;
  });
}

async function flushMicrotasks() {
  await act(async () => {
    for (let index = 0; index < 8; index += 1) await Promise.resolve();
  });
}

async function mount(name = "a") {
  await act(async () => {
    root.render(<Layer name={name} />);
  });
}

/** 層を閉じる（外すのは次の microtask）。 */
async function unmount() {
  await act(async () => {
    root.render(null);
  });
  await flushMicrotasks();
}

function state(): Record<string, unknown> {
  return (window.history.state ?? {}) as Record<string, unknown>;
}

beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  backs = [];
  window.history.replaceState({ kept: 1 }, "");
});

afterEach(async () => {
  vi.restoreAllMocks();
  await act(async () => root.unmount());
  await flushMicrotasks();
  // 層が積んだ分を外し終えるまで待つ（次のテストへ popstate を持ち越さない）
  if (hasPhotoEditingLayerHistoryEntry()) await nextPopState();
  container.remove();
});

describe("usePhotoEditingLayerHistory", () => {
  it("層が出たら履歴に 1 つ積む（URL は変えず、state の中身は残す）", async () => {
    const push = vi.spyOn(window.history, "pushState");
    const href = window.location.href;
    expect(hasPhotoEditingLayerHistoryEntry()).toBe(false);

    await mount();
    expect(push).toHaveBeenCalledTimes(1);
    expect(window.location.href).toBe(href);
    expect(state().kept).toBe(1);
    expect(hasPhotoEditingLayerHistoryEntry()).toBe(true);

    // 描き直しでは積み増さない
    await mount();
    expect(push).toHaveBeenCalledTimes(1);
  });

  it("「戻る」で onBack を 1 回呼び、層の分を積み直す（層が残っても「戻る」が効き続ける）", async () => {
    await mount();
    const length = window.history.length;

    await goBack();
    expect(backs).toEqual(["a"]);
    expect(hasPhotoEditingLayerHistoryEntry()).toBe(true);
    expect(state().kept).toBe(1);
    // 外れた分を積み直しただけで、履歴は伸びない
    expect(window.history.length).toBe(length);

    await goBack();
    expect(backs).toEqual(["a", "a"]);
    expect(hasPhotoEditingLayerHistoryEntry()).toBe(true);
  });

  it("onBack は最新のものを呼ぶ", async () => {
    await mount("a");
    await mount("b");
    await goBack();
    expect(backs).toEqual(["b"]);
  });

  it("層が閉じたら、積んだ分を外す（onBack は呼ばない）", async () => {
    await mount();
    const popped = nextPopState();
    await unmount();
    await popped;
    expect(hasPhotoEditingLayerHistoryEntry()).toBe(false);
    expect(state()).toEqual({ kept: 1 });
    expect(backs).toEqual([]);

    // 外した後の「進む」「戻る」は、層が無ければ何もしない
    const forwarded = nextPopState();
    window.history.forward();
    await forwarded;
    expect(hasPhotoEditingLayerHistoryEntry()).toBe(true);
    const returned = nextPopState();
    window.history.back();
    await returned;
    expect(hasPhotoEditingLayerHistoryEntry()).toBe(false);
    expect(backs).toEqual([]);
  });

  it("別の履歴へ移った後に閉じても、戻らない", async () => {
    await mount();
    window.history.pushState({ other: true }, "");
    const back = vi.spyOn(window.history, "back");

    await unmount();
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(back).not.toHaveBeenCalled();
    expect(state()).toEqual({ other: true });
  });

  it("同じ tick で開き直したら外さない（StrictMode の effect の二重実行で層が閉じない）", async () => {
    const push = vi.spyOn(window.history, "pushState");
    const back = vi.spyOn(window.history, "back");
    await act(async () => {
      root.render(
        <StrictMode>
          <Layer name="a" />
        </StrictMode>,
      );
    });
    await flushMicrotasks();
    await new Promise((resolve) => setTimeout(resolve, 20));

    expect(back).not.toHaveBeenCalled();
    expect(backs).toEqual([]);
    expect(push).toHaveBeenCalledTimes(1);
    expect(hasPhotoEditingLayerHistoryEntry()).toBe(true);
  });

  it("外している途中に次の層が開いたら、その popstate は「戻る」にせず、次の層の分を積み直す", async () => {
    await mount("a");
    const popped = nextPopState();
    await unmount();
    // まだ外し終えていない（history.back() は非同期）
    expect(hasPhotoEditingLayerHistoryEntry()).toBe(true);
    await mount("b");
    await act(async () => {
      await popped;
    });

    expect(backs).toEqual([]);
    expect(hasPhotoEditingLayerHistoryEntry()).toBe(true);

    await goBack();
    expect(backs).toEqual(["b"]);
  });

  it("読み込み直す前の印（別の文書の印）は自分の分にしない", async () => {
    window.history.replaceState({ kept: 1, nihoPhotoEditingLayer: "before-reload" }, "");
    const push = vi.spyOn(window.history, "pushState");
    expect(hasPhotoEditingLayerHistoryEntry()).toBe(false);

    await mount();
    expect(push).toHaveBeenCalledTimes(1);
    expect(hasPhotoEditingLayerHistoryEntry()).toBe(true);

    // 「戻る」の先は読み込み直す前の印の履歴（この文書の印ではない）なので、層の「戻る」になる
    await goBack();
    expect(backs).toEqual(["a"]);
    expect(push).toHaveBeenCalledTimes(2);
  });
});
