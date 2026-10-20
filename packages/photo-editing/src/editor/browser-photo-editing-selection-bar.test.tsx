// @vitest-environment jsdom

import { act, createRef, type ComponentProps } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  PHOTO_EDITING_SELECT_ALL_LABEL,
  PHOTO_EDITING_SELECT_CANCEL_LABEL,
  PHOTO_EDITING_SELECT_LABEL,
  photoEditingSelectionCountText,
} from "../photo-editing-copy";

import {
  BrowserPhotoEditingSelectionBar,
  BrowserPhotoEditingSelectModeButton,
  browserPhotoBatchFavoriteLabel,
} from "./browser-photo-editing-selection-bar";

/**
 * ブラウザ版の一覧の選択バーと、スマホの「選択」アイコンボタン（F5a-2 移行元設計）。広い幅は左から「N 枚を選択」・［すべて］・
 * ［キャンセル］、狭い幅は 左［キャンセル］・中央「N 枚を選択」・右［すべて］。
 */

let container: HTMLDivElement;
let root: Root;
let onSelectAll: ReturnType<typeof vi.fn<() => void>>;
let onCancel: ReturnType<typeof vi.fn<() => void>>;

async function renderBar(props: Partial<ComponentProps<typeof BrowserPhotoEditingSelectionBar>> = {}) {
  await act(async () => {
    root.render(
      <BrowserPhotoEditingSelectionBar
        count={3}
        compact={false}
        allSelected={false}
        onSelectAll={onSelectAll}
        onCancel={onCancel}
        {...props}
      />,
    );
  });
}

async function click(element: Element | null | undefined) {
  if (!element) throw new Error("element not found");
  await act(async () => {
    element.dispatchEvent(new MouseEvent("click", { bubbles: true }));
  });
}

function bar(): HTMLElement {
  const found = container.firstElementChild;
  if (!(found instanceof HTMLElement)) throw new Error("bar not found");
  return found;
}

function status(): HTMLElement {
  const found = container.querySelector<HTMLElement>('[role="status"]');
  if (!found) throw new Error("status not found");
  return found;
}

function barButton(label: string): HTMLButtonElement {
  const found = Array.from(container.querySelectorAll<HTMLButtonElement>("button")).find((button) => button.textContent === label);
  if (!found) throw new Error(`button not found: ${label}`);
  return found;
}

/** バーの中身の並び（左から）。 */
function order(): string[] {
  return Array.from(bar().children).map((child) => child.textContent ?? "");
}

beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  onSelectAll = vi.fn();
  onCancel = vi.fn();
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => {
    root.unmount();
  });
  container.remove();
});

describe("文言", () => {
  it("枚数は「N 枚を選択」（数字と「枚」の間は半角スペース 1 つ）。0 枚のときも出す", () => {
    expect(photoEditingSelectionCountText(3)).toBe("3 枚を選択");
    expect(photoEditingSelectionCountText(0)).toBe("0 枚を選択");
    expect(PHOTO_EDITING_SELECT_LABEL).toBe("選択");
    expect(PHOTO_EDITING_SELECT_ALL_LABEL).toBe("すべて");
    expect(PHOTO_EDITING_SELECT_CANCEL_LABEL).toBe("キャンセル");
  });

  it("お気に入りが混在するときは全枚を追加、全枚入っているときだけ外す", () => {
    expect(browserPhotoBatchFavoriteLabel([true, false, true])).toBe("お気に入りに追加");
    expect(browserPhotoBatchFavoriteLabel([false, false])).toBe("お気に入りに追加");
    expect(browserPhotoBatchFavoriteLabel([true, true])).toBe("お気に入りから外す");
  });
});

describe("BrowserPhotoEditingSelectionBar（広い幅）", () => {
  it("左から「N 枚を選択」・［すべて］・［キャンセル］を 1 行に並べる", async () => {
    await renderBar({ count: 3 });

    expect(order()).toEqual(["3 枚を選択", "すべて", "キャンセル"]);
    expect(bar().className).toContain("flex");
    expect(bar().className).toContain("min-w-0");
    expect(bar().className).toContain("items-center");
    expect(bar().className).toContain("gap-3");
    // 行いっぱいには広げない（右には使用量が残る）
    expect(bar().className).not.toContain("flex-1");
    expect(bar().className).not.toContain("justify-between");

    expect(status().textContent).toBe("3 枚を選択");
    expect(status().className).toContain("text-sub");
    expect(status().className).toContain("font-bold");
    expect(status().className).toContain("text-niho-text");
    expect(status().className).toContain("tabular-nums");
    expect(barButton("すべて").className).toContain("text-niho-accent-ink");
    expect(barButton("キャンセル").className).toContain("text-niho-text-muted");
    expect(barButton("キャンセル").className).toContain("hover:text-niho-text");
  });

  it("［すべて］と［キャンセル］を押すとそれぞれ伝える", async () => {
    await renderBar();

    await click(barButton("すべて"));
    expect(onSelectAll).toHaveBeenCalledTimes(1);
    expect(onCancel).not.toHaveBeenCalled();

    await click(barButton("キャンセル"));
    expect(onCancel).toHaveBeenCalledTimes(1);
    expect(onSelectAll).toHaveBeenCalledTimes(1);
  });

  it("複数書き出しは 44px の［書き出す］を出し、実行中は同じ場所で［止める］になる", async () => {
    const onExport = vi.fn();
    const onStop = vi.fn();
    const buttonRef = createRef<HTMLButtonElement>();
    await renderBar({
      exportAction: { buttonRef, exporting: false, stopping: false, onExport, onStop },
    });
    expect(order()).toEqual(["3 枚を選択", "すべて", "書き出す", "キャンセル"]);
    expect(buttonRef.current).toBe(barButton("書き出す"));
    expect(barButton("書き出す").className).toContain("after:-inset-y-1.5");
    await click(barButton("書き出す"));
    expect(onExport).toHaveBeenCalledOnce();
    expect(onStop).not.toHaveBeenCalled();

    await renderBar({
      exportAction: { buttonRef, exporting: true, stopping: false, onExport, onStop },
    });
    expect(barButton("すべて").disabled).toBe(true);
    expect(barButton("キャンセル").disabled).toBe(true);
    await click(barButton("止める"));
    expect(onStop).toHaveBeenCalledOnce();

    await renderBar({
      exportAction: { buttonRef, exporting: true, stopping: true, onExport, onStop },
    });
    expect(barButton("停止中…").disabled).toBe(true);

    await renderBar({
      exportAction: { buttonRef, exporting: true, stopping: false, finalizing: true, onExport, onStop },
    });
    expect(barButton("まとめ中…").disabled).toBe(true);
  });

  it("ZIP 保存に対応しない環境では実行ボタンを置かず、ブラウザ利用の案内だけを出す", async () => {
    await renderBar({ exportUnavailableMessage: "ZIP は NIHO Desktop では保存できません。ブラウザで開いてください。" });

    expect(order()).toEqual(["3 枚を選択", "すべて", "ZIP はブラウザで保存できます", "キャンセル"]);
    expect(Array.from(container.querySelectorAll("button")).some((button) => button.textContent === "書き出す")).toBe(false);
    expect(container.querySelector("span[title]")?.getAttribute("title")).toBe(
      "ZIP は NIHO Desktop では保存できません。ブラウザで開いてください。",
    );
  });

  it("すべて選んでいるときは［すべて］を押せない（［キャンセル］は押せる）", async () => {
    await renderBar({ count: 40, allSelected: true });
    expect(barButton("すべて").disabled).toBe(true);
    expect(barButton("キャンセル").disabled).toBe(false);

    await click(barButton("すべて"));
    expect(onSelectAll).not.toHaveBeenCalled();
    await click(barButton("キャンセル"));
    expect(onCancel).toHaveBeenCalledTimes(1);

    await renderBar({ count: 2, allSelected: false });
    expect(barButton("すべて").disabled).toBe(false);
  });

  it("一括操作中は選択を変えられない", async () => {
    await renderBar({ count: 3, selectionDisabled: true });
    expect(barButton("すべて").disabled).toBe(true);
    expect(barButton("キャンセル").disabled).toBe(true);

    await click(barButton("すべて"));
    await click(barButton("キャンセル"));
    expect(onSelectAll).not.toHaveBeenCalled();
    expect(onCancel).not.toHaveBeenCalled();
  });

  it("枚数は role=status（変わると読み上げられる）。ボタンは囲みなしで、見た目 32px・押せる範囲 44px・focus の輪がある", async () => {
    await renderBar({ count: 2 });
    expect(status().getAttribute("role")).toBe("status");
    expect(status().textContent).toBe("2 枚を選択");
    await renderBar({ count: 12 });
    expect(status().textContent).toBe("12 枚を選択");

    for (const label of ["すべて", "キャンセル"]) {
      const className = barButton(label).className;
      expect(className).toContain("h-8");
      expect(className).toContain("relative");
      expect(className).toContain("after:absolute");
      expect(className).toContain("after:inset-x-0");
      expect(className).toContain("after:-inset-y-1.5");
      expect(className).toContain("after:content-['']");
      expect(className).toContain("focus-visible:ring-2");
      expect(className).toContain("focus-visible:ring-niho-accent-ink");
      expect(className).not.toMatch(/\bborder\b|\bbg-/);
      expect(barButton(label).type).toBe("button");
    }
  });
});

describe("BrowserPhotoEditingSelectionBar（狭い幅）", () => {
  it("行いっぱいに、左［キャンセル］・中央「N 枚を選択」・右［すべて］", async () => {
    await renderBar({ compact: true, count: 4 });

    expect(order()).toEqual(["キャンセル", "4 枚を選択", "すべて"]);
    expect(bar().className).toContain("flex min-w-0 flex-1 items-center justify-between gap-2");
    expect(status().className).toContain("truncate");
    expect(status().className).toContain("text-center");
    expect(status().className).toContain("flex-1");
    expect(status().className).toContain("min-w-0");
    expect(status().className).toContain("tabular-nums");
    expect(status().getAttribute("role")).toBe("status");
  });

  it("0 枚でも「0 枚を選択」を出す。［すべて］は全部選んでいるときだけ押せない。押すと伝える", async () => {
    await renderBar({ compact: true, count: 0 });
    expect(status().textContent).toBe("0 枚を選択");
    expect(barButton("すべて").disabled).toBe(false);

    await click(barButton("すべて"));
    expect(onSelectAll).toHaveBeenCalledTimes(1);
    await click(barButton("キャンセル"));
    expect(onCancel).toHaveBeenCalledTimes(1);

    await renderBar({ compact: true, count: 9, allSelected: true });
    expect(barButton("すべて").disabled).toBe(true);
    expect(barButton("キャンセル").disabled).toBe(false);
  });

  it("ボタンの見た目は広い幅と同じ（字だけ。32px・押せる範囲 44px）", async () => {
    await renderBar({ compact: true });
    expect(barButton("すべて").className).toContain("text-niho-accent-ink");
    expect(barButton("キャンセル").className).toContain("text-niho-text-muted");
    for (const label of ["すべて", "キャンセル"]) {
      expect(barButton(label).className).toContain("h-8");
      expect(barButton(label).className).toContain("after:-inset-y-1.5");
      // 中央の文言が縮んでもボタンは縮めない
      expect(barButton(label).className).toContain("shrink-0");
    }
  });

  it("日本語の文言だけを出す（内部の状態名や英語の識別子を見せない）", async () => {
    await renderBar({ compact: true, count: 2 });
    expect(container.textContent).toBe("キャンセル2 枚を選択すべて");
    await renderBar({ compact: false, count: 2 });
    expect(container.textContent).toBe("2 枚を選択すべてキャンセル");
  });

  it("一括操作はアイコンに畳み、読み上げ名を保って1行に収める", async () => {
    const onFavorite = vi.fn();
    const onAlbum = vi.fn();
    await renderBar({
      compact: true,
      favoriteLabel: "お気に入りに追加",
      albumLabel: "アルバムに追加",
      onFavorite,
      onAlbum,
    });
    const favorite = container.querySelector<HTMLButtonElement>('button[aria-label="お気に入りに追加"]');
    const album = container.querySelector<HTMLButtonElement>('button[aria-label="アルバムに追加"]');
    expect(favorite?.textContent).toBe("");
    expect(album?.textContent).toBe("");
    expect(favorite?.className).toContain("w-8");
    expect(album?.className).toContain("w-8");
    expect(bar().className).not.toContain("flex-wrap");
    await click(favorite);
    await click(album);
    expect(onFavorite).toHaveBeenCalledTimes(1);
    expect(onAlbum).toHaveBeenCalledTimes(1);

    await renderBar({ compact: true, albumLabel: "アルバムから外す", onAlbum });
    expect(container.querySelector('button[aria-label="アルバムから外す"] svg')).not.toBeNull();
  });
});

describe("BrowserPhotoEditingSelectModeButton（スマホの上段の「選択」。「＋」の左）", () => {
  it("アイコンだけのボタン。読み上げと title は「選択」。押すと伝える", async () => {
    const onClick = vi.fn();
    await act(async () => {
      root.render(<BrowserPhotoEditingSelectModeButton onClick={onClick} />);
    });

    const button = container.querySelector("button");
    expect(button?.getAttribute("aria-label")).toBe("選択");
    expect(button?.getAttribute("title")).toBe("選択");
    expect(button?.type).toBe("button");
    // 文字は出さず、アイコン（読み上げさせない）だけ
    expect(button?.textContent).toBe("");
    const icon = button?.querySelector("svg");
    expect(icon).not.toBeNull();
    expect(icon?.getAttribute("aria-hidden")).toBe("true");

    await click(button);
    expect(onClick).toHaveBeenCalledTimes(1);
  });

  it("「＋」（写真を追加）と同じ 44px の丸（縮めない）", async () => {
    await act(async () => {
      root.render(<BrowserPhotoEditingSelectModeButton onClick={() => {}} />);
    });
    const className = container.querySelector("button")?.className ?? "";
    for (const token of [
      "h-11",
      "w-11",
      "rounded-full",
      "shrink-0",
      "text-niho-accent-ink",
      "hover:bg-niho-pale/60",
      "focus-visible:ring-2",
      "focus-visible:ring-niho-accent-ink",
    ]) {
      expect(className).toContain(token);
    }
  });
});
