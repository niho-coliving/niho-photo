// @vitest-environment jsdom

import { act, useRef } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const paintFrame = vi.hoisted(() => vi.fn());
vi.mock("../develop-engine/develop-frame", () => ({ paintDevelopFrame: paintFrame }));

import type { DevelopEngine, DevelopFrame } from "../develop-engine/develop-engine-client";
import { neutralDevelopSettings, type DevelopSettings } from "../develop-engine/develop-settings";
import type { PhotoLibraryDevelopVersion } from "../library/photo-library";

import { BrowserPhotoEditingAdjustments } from "./browser-photo-editing-adjustments";
import { BrowserPhotoEditingVersions } from "./browser-photo-editing-versions";
import {
  BROWSER_VERSION_THUMBNAIL_MAX_DIMENSION,
  developVersionOnCurrent,
  developVersionThumbnailFoundation,
  developVersionThumbnailSettings,
} from "./browser-photo-editing-versions-model";
import { useBrowserPresetThumbnails } from "./use-browser-preset-thumbnails";
import type { BrowserPhotoVersionNameResult } from "./use-browser-photo-versions";

/**
 * 右パネルの「版」の面（niho-photo#42）。一覧（新しい順・選択中の印・自動の印・日時）、0 件・読み込み中・読めない・保存の失敗、
 * 作る（既定の名前・Enter・Esc）・名前を変える（その場の入力）・削除（確かめてから）・切り替え、押せない間、小さな見た目。
 */

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLDivElement;
let root: Root;

const BASE = "raster.v2.abc";

function settings(exposure: number): DevelopSettings {
  return { ...neutralDevelopSettings(BASE), exposure };
}

function version(id: string, name: string, kind: PhotoLibraryDevelopVersion["kind"], exposure: number): PhotoLibraryDevelopVersion {
  return { id, name, createdAt: "2026-10-21T01:32:00.000Z", kind, developSettings: settings(exposure) };
}

const BRIGHT = version("bright", "明るめ", "named", 0.8);
const FILM = version("film", "フィルム調", "named", -0.2);
const AUTO = version("auto", "自動の版 10:40", "auto", 0.1);

type PanelProps = Parameters<typeof BrowserPhotoEditingVersions>[0];

function panelProps(extra: Partial<PanelProps> = {}): PanelProps {
  return {
    status: "ready",
    versions: [BRIGHT, FILM, AUTO],
    selectedId: "film",
    defaultName: "版 3",
    full: false,
    disabled: false,
    manageDisabled: false,
    saveFailed: false,
    onCreate: vi.fn((): BrowserPhotoVersionNameResult => ({ ok: true })),
    onRename: vi.fn((): BrowserPhotoVersionNameResult => ({ ok: true })),
    onDelete: vi.fn(),
    onSwitch: vi.fn(),
    onRetrySave: vi.fn(),
    onReload: vi.fn(),
    ...extra,
  };
}

async function renderPanel(extra: Partial<PanelProps> = {}): Promise<PanelProps> {
  const props = panelProps(extra);
  await act(async () => root.render(<BrowserPhotoEditingVersions {...props} />));
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

async function typeInto(input: HTMLInputElement, value: string) {
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set?.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

async function press(target: Element, key: string) {
  await act(async () => {
    target.dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true }));
  });
}

function buttonByText(text: string, scope: ParentNode = container): HTMLButtonElement | undefined {
  return Array.from(scope.querySelectorAll<HTMLButtonElement>("button")).find(
    (button) => button.textContent?.trim() === text,
  );
}

function rows(): HTMLLIElement[] {
  return Array.from(container.querySelectorAll<HTMLLIElement>('ul[aria-label="版の一覧"] > li'));
}

function rowButton(name: string): HTMLButtonElement {
  const found = rows()
    .map((row) => row.querySelector<HTMLButtonElement>("button:not([aria-haspopup])"))
    .find((button) => button?.textContent?.includes(name));
  if (!found) throw new Error(`row not found: ${name}`);
  return found;
}

function nameInput(): HTMLInputElement | null {
  return container.querySelector<HTMLInputElement>('input[type="text"]');
}

async function openMenu(name: string) {
  await click(container.querySelector(`button[aria-label="${name} のメニュー"]`));
}

function menuItem(label: string): HTMLButtonElement | undefined {
  return Array.from(document.body.querySelectorAll<HTMLButtonElement>('[role="menuitem"]')).find(
    (item) => item.textContent?.trim() === label,
  );
}

beforeEach(() => {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  paintFrame.mockReset();
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  document.body.innerHTML = "";
});

describe("版の一覧", () => {
  it("新しい順に並べ、今の補正と同じ版に「選択中」（aria-current）、自動の版に「自動」の印と日時", async () => {
    await renderPanel();
    expect(rows().map((row) => row.querySelector("button")?.textContent)).toEqual([
      "自動の版 10:4010月21日 10:32自動",
      "フィルム調10月21日 10:32選択中",
      "明るめ10月21日 10:32",
    ]);
    expect(rowButton("フィルム調").getAttribute("aria-current")).toBe("true");
    expect(rowButton("明るめ").getAttribute("aria-current")).toBeNull();
    // 行全体が切り替えのボタン（押せる範囲 56px）
    expect(rowButton("明るめ").className).toContain("min-h-14");
    expect(container.textContent).not.toContain("いまの補正");
  });

  it("どの版とも違う今の補正は、一覧の先頭に「いまの補正（版にしていません）」", async () => {
    await renderPanel({ selectedId: null });
    const [first] = rows();
    expect(first?.textContent).toBe("いまの補正（版にしていません）");
    expect(first?.getAttribute("aria-current")).toBe("true");
    expect(first?.querySelector("button")).toBeNull();
  });

  it("0 件は短い案内、読み込み中は aria-busy、読めなければ控えめな 1 行と「再読み込み」", async () => {
    await renderPanel({ versions: [], selectedId: null });
    expect(container.textContent).toContain("版はまだありません。");
    expect(container.querySelector('ul[aria-label="版の一覧"]')).toBeNull();
    expect(buttonByText("今の補正を版にする")?.disabled).toBe(false);

    await renderPanel({ status: "loading", versions: [] });
    expect(container.querySelector('[aria-busy="true"]')).not.toBeNull();
    expect(buttonByText("今の補正を版にする")?.disabled).toBe(true);

    const props = await renderPanel({ status: "failed", versions: [] });
    expect(container.querySelector('[role="status"]')?.textContent).toBe("版を読み込めませんでした。");
    expect(container.querySelector('[role="alert"]')).toBeNull();
    await click(buttonByText("再読み込み"));
    expect(props.onReload).toHaveBeenCalledTimes(1);
  });

  it("行を押すと切り替える。押せない間は切り替え・作成を押せない（選んでいる版の印は薄くしない）", async () => {
    const props = await renderPanel();
    await click(rowButton("明るめ"));
    expect(props.onSwitch).toHaveBeenCalledWith("bright");

    await renderPanel({ disabled: true });
    expect(rowButton("明るめ").disabled).toBe(true);
    expect(rowButton("フィルム調").className).toContain("disabled:cursor-default");
    expect(buttonByText("今の補正を版にする")?.disabled).toBe(true);
  });

  it("保存の失敗は控えめな 1 行と「再試行」（一覧はそのまま）。名前つきの版が上限なら作れない", async () => {
    const props = await renderPanel({ saveFailed: true, full: true });
    expect(container.textContent).toContain("版を保存できませんでした。");
    await click(buttonByText("再試行"));
    expect(props.onRetrySave).toHaveBeenCalledTimes(1);
    expect(rows()).toHaveLength(3);
    expect(container.textContent).toContain("名前を付けた版は 30 個までです。");
    expect(buttonByText("今の補正を版にする")?.disabled).toBe(true);
  });
});

describe("作る・名前を変える・削除", () => {
  it("「今の補正を版にする」は既定の名前の入った入力を開き、Enter で作る。失敗は入力の下、Esc・「やめる」で閉じる", async () => {
    const onCreate = vi
      .fn<(name: string) => BrowserPhotoVersionNameResult>()
      .mockReturnValueOnce({ ok: false, message: "名前を入れてください。" })
      .mockReturnValue({ ok: true });
    await renderPanel({ onCreate });
    await click(buttonByText("今の補正を版にする"));
    const input = nameInput();
    if (!input) throw new Error("input not found");
    expect(input.value).toBe("版 3");
    expect(document.activeElement).toBe(input);
    expect(container.querySelector(`label[for="${input.id}"]`)?.textContent).toBe("版の名前");

    await typeInto(input, " ");
    await press(input, "Enter");
    expect(onCreate).toHaveBeenLastCalledWith(" ");
    expect(container.querySelector('[role="alert"]')?.textContent).toBe("名前を入れてください。");
    expect(input.getAttribute("aria-invalid")).toBe("true");

    await typeInto(input, "夕方");
    await press(input, "Enter");
    expect(onCreate).toHaveBeenLastCalledWith("夕方");
    expect(nameInput()).toBeNull();
    // 閉じたらフォーカスはボタンへ戻る
    expect(document.activeElement).toBe(buttonByText("今の補正を版にする"));

    await click(buttonByText("今の補正を版にする"));
    await press(nameInput()!, "Escape");
    expect(nameInput()).toBeNull();
    await click(buttonByText("今の補正を版にする"));
    await click(buttonByText("やめる"));
    expect(nameInput()).toBeNull();
    expect(onCreate).toHaveBeenCalledTimes(2);
  });

  it("⋯ の「名前を変える」はその場の入力（Enter で確定・Esc で取り消し・空は拒否）", async () => {
    const onRename = vi
      .fn<(id: string, name: string) => BrowserPhotoVersionNameResult>()
      .mockReturnValueOnce({ ok: false, message: "名前を入れてください。" })
      .mockReturnValue({ ok: true });
    await renderPanel({ onRename });
    await openMenu("明るめ");
    await click(menuItem("名前を変える"));
    const input = nameInput();
    if (!input) throw new Error("input not found");
    expect(input.value).toBe("明るめ");
    expect(document.activeElement).toBe(input);

    await typeInto(input, "");
    await press(input, "Enter");
    expect(onRename).toHaveBeenLastCalledWith("bright", "");
    expect(container.querySelector('[role="alert"]')?.textContent).toBe("名前を入れてください。");
    expect(nameInput()).not.toBeNull();

    await typeInto(input, "明るめ（屋外）");
    await press(input, "Enter");
    expect(onRename).toHaveBeenLastCalledWith("bright", "明るめ（屋外）");
    expect(nameInput()).toBeNull();
    expect(document.activeElement?.getAttribute("aria-label")).toBe("明るめ のメニュー");

    // Esc は名前を変えない
    await openMenu("明るめ");
    await click(menuItem("名前を変える"));
    await typeInto(nameInput()!, "取り消す名前");
    await press(nameInput()!, "Escape");
    expect(nameInput()).toBeNull();
    expect(onRename).toHaveBeenCalledTimes(2);
  });

  it("⋯ の「削除」は確かめてから消す。閲覧のみは名前の変更・削除を押せない", async () => {
    const props = await renderPanel();
    await openMenu("フィルム調");
    await click(menuItem("削除"));
    const dialog = document.body.querySelector('[role="dialog"]');
    expect(dialog?.textContent).toContain("「フィルム調」を削除しますか？");
    expect(dialog?.textContent).toContain("写真の今の補正は変わりません。");
    expect(props.onDelete).not.toHaveBeenCalled();
    await click(buttonByText("削除する", document.body));
    expect(props.onDelete).toHaveBeenCalledWith("film");

    await renderPanel({ manageDisabled: true });
    await openMenu("明るめ");
    expect(menuItem("名前を変える")?.disabled).toBe(true);
    expect(menuItem("削除")?.disabled).toBe(true);
  });
});

describe("版の小さな見た目", () => {
  function Harness(props: { engine: DevelopEngine; current: DevelopSettings; versions: PhotoLibraryDevelopVersion[] }) {
    const mountedRef = useRef(true);
    const engineRef = useRef<DevelopEngine | null>(props.engine);
    const thumbnails = useBrowserPresetThumbnails({
      mountedRef,
      engineRef,
      supported: true,
      photoKey: "local:p1",
      base: developVersionThumbnailFoundation(props.current),
      paused: false,
      maxDimension: BROWSER_VERSION_THUMBNAIL_MAX_DIMENSION,
      settingsOf: developVersionThumbnailSettings,
    });
    return <BrowserPhotoEditingVersions {...panelProps({ versions: props.versions, selectedId: null })} thumbnails={thumbnails} />;
  }

  it("見えている版を今の土台に載せて 112px で 1 枚ずつ描き、名前を変えても・スライダーを動かしても描き直さない", async () => {
    const frame: DevelopFrame = { width: 3, height: 2, rgba: new Uint8ClampedArray(24) };
    const renderPresetThumbnail = vi.fn(async () => frame);
    const engine = { renderPresetThumbnail } as unknown as DevelopEngine;
    const older = { ...BRIGHT, developSettings: { ...BRIGHT.developSettings, base: "raster.v1.old" } };
    await act(async () => root.render(<Harness engine={engine} current={settings(0)} versions={[older, FILM]} />));
    await settle();
    expect(renderPresetThumbnail).toHaveBeenCalledTimes(2);
    const drawn = renderPresetThumbnail.mock.calls.map((call) => call as unknown[]);
    expect(drawn.every((call) => call[1] === BROWSER_VERSION_THUMBNAIL_MAX_DIMENSION)).toBe(true);
    expect(drawn.map((call) => call[0])).toEqual(
      expect.arrayContaining([developVersionOnCurrent(older.developSettings, settings(0))]),
    );
    expect(container.querySelectorAll('[data-testid="photo-preset-thumbnail"][data-state="ready"]')).toHaveLength(2);
    expect(container.querySelector('[data-testid="photo-preset-thumbnail"]')?.className).toContain("w-14");

    await act(async () =>
      root.render(
        <Harness engine={engine} current={settings(0.7)} versions={[{ ...older, name: "名前を変えた" }, FILM]} />,
      ),
    );
    await settle();
    expect(renderPresetThumbnail).toHaveBeenCalledTimes(2);
  });

  it("見本を描けない wasm は薄い面だけ", async () => {
    await renderPanel();
    expect(container.querySelector('[data-testid="photo-preset-thumbnail"]')).toBeNull();
    expect(rowButton("明るめ").querySelector("span.bg-niho-pale")).not.toBeNull();
  });
});

describe("右パネルの版の面（BrowserPhotoEditingAdjustments）", () => {
  it("見出し行は「版」だけ（↶ ↷ ⋯・初期化は出さない）、ヒストグラムは一番上", async () => {
    await act(async () =>
      root.render(
        <BrowserPhotoEditingAdjustments
          canEdit
          canReset
          resetDone={false}
          canUndo
          canRedo
          controlsDisabled={false}
          busy={false}
          work={null}
          raw={false}
          settings={neutralDevelopSettings()}
          clipboard={{ canCopy: true, canPaste: true, onCopy: vi.fn(), onPaste: vi.fn() }}
          histogram={<div data-testid="histogram" />}
          panel="versions"
          versions={<BrowserPhotoEditingVersions {...panelProps()} />}
          info={<p>情報の中身</p>}
          onReset={vi.fn()}
          onUndo={vi.fn()}
          onRedo={vi.fn()}
          onRetryWork={vi.fn()}
          onSettingsChange={vi.fn()}
        />,
      ),
    );
    const aside = container.querySelector<HTMLElement>('aside[aria-label="版"]');
    if (!aside) throw new Error("versions face not found");
    expect(aside.firstElementChild?.querySelector('[data-testid="histogram"]')).not.toBeNull();
    expect(aside.querySelector("h2")?.textContent).toBe("版");
    expect(aside.querySelector('button[aria-label="取り消す"]')).toBeNull();
    expect(buttonByText("初期化", aside)).toBeUndefined();
    expect(aside.querySelector('input[type="range"]')).toBeNull();
    expect(aside.textContent).not.toContain("情報の中身");
    expect(rows()).toHaveLength(3);
  });
});
