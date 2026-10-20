// @vitest-environment jsdom

import { act, createRef, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  BrowserPhotoEditingGrid,
  BrowserPhotoListSortControl,
  type BrowserPhotoEditingGridHandle,
  type BrowserPhotoEditingGridItem,
} from "./browser-photo-editing-grid";
import type { PhotoEditingGridMore } from "./photo-editing-grid";

/** 2026-10-01（木）12:00 日本時間 */
const NOW = new Date("2026-10-01T03:00:00.000Z");

function gridItem(key: string, sectionDate: string | null, overrides: Partial<BrowserPhotoEditingGridItem> = {}): BrowserPhotoEditingGridItem {
  return {
    key,
    fileName: `${key}.JPG`,
    thumbnail: { url: `https://example.test/${key}.jpg`, failed: false },
    raw: false,
    favorite: false,
    pending: null,
    sectionDate,
    ...overrides,
  };
}

const ITEMS: BrowserPhotoEditingGridItem[] = [
  gridItem("t1", "2026-10-01T01:00:00.000Z", { raw: true, fileName: "P1.RW2" }),
  gridItem("t2", "2026-09-30T15:30:00.000Z", { favorite: true }),
  gridItem("y1", "2026-09-30T02:00:00.000Z", { pending: "raw", raw: true, fileName: "P2.RW2" }),
  gridItem("s1", "2026-09-28T02:00:00.000Z", { pending: "other", fileName: "H1.HEIC" }),
  gridItem("o1", "2025-08-15T02:00:00.000Z"),
];

/** 下まで見たら続きを読むための IntersectionObserver（テストで交差を起こす） */
class FakeIntersectionObserver {
  static instances: FakeIntersectionObserver[] = [];
  readonly callback: IntersectionObserverCallback;
  readonly options: IntersectionObserverInit | undefined;
  readonly targets: Element[] = [];
  disconnected = false;

  constructor(callback: IntersectionObserverCallback, options?: IntersectionObserverInit) {
    this.callback = callback;
    this.options = options;
    FakeIntersectionObserver.instances.push(this);
  }

  observe(target: Element): void {
    this.targets.push(target);
  }

  unobserve(): void {}

  disconnect(): void {
    this.disconnected = true;
  }

  static latest(): FakeIntersectionObserver | undefined {
    return FakeIntersectionObserver.instances.filter((observer) => !observer.disconnected).at(-1);
  }

  intersect(): void {
    this.callback(
      this.targets.map((target) => ({ target, isIntersecting: true }) as IntersectionObserverEntry),
      this as unknown as IntersectionObserver,
    );
  }
}

/** 大きさの変化を知らせる ResizeObserver（テストで呼ぶ） */
class FakeResizeObserver {
  static instances: FakeResizeObserver[] = [];
  readonly callback: ResizeObserverCallback;

  constructor(callback: ResizeObserverCallback) {
    this.callback = callback;
    FakeResizeObserver.instances.push(this);
  }

  observe(): void {}

  unobserve(): void {}

  disconnect(): void {}
}

let container: HTMLDivElement;
let root: Root;
let onTileClick: ReturnType<typeof vi.fn<(key: string) => void>>;
let onTileOpen: ReturnType<typeof vi.fn<(key: string) => void>>;
let onTileKeyDown: ReturnType<typeof vi.fn<(key: string, event: { key: string }) => void>>;
let originalIntersectionObserver: typeof IntersectionObserver | undefined;

async function renderGrid(
  options: {
    items?: BrowserPhotoEditingGridItem[];
    compact?: boolean;
    selectedKeys?: string[];
    activeKey?: string | null;
    loading?: boolean;
    listKey?: string;
    metaStart?: ReactNode;
    metaWhenEmpty?: boolean;
    meta?: ReactNode;
    placeholder?: ReactNode;
    more?: PhotoEditingGridMore;
    handle?: { current: BrowserPhotoEditingGridHandle | null };
    selecting?: boolean;
    onTileLongPress?: (key: string) => void;
  } = {},
): Promise<void> {
  await act(async () => {
    root.render(
      <BrowserPhotoEditingGrid
        ref={options.handle}
        items={options.items ?? ITEMS}
        listKey={options.listKey ?? "photos:captured"}
        compact={options.compact ?? false}
        selectedKeys={new Set(options.selectedKeys ?? [])}
        selecting={options.selecting}
        activeKey={options.activeKey ?? null}
        loading={options.loading}
        metaStart={options.metaStart}
        metaWhenEmpty={options.metaWhenEmpty}
        meta={options.meta}
        placeholder={options.placeholder}
        more={options.more}
        onTileClick={(key) => onTileClick(key)}
        onTileOpen={onTileOpen}
        onTileKeyDown={(key, event) => onTileKeyDown(key, { key: event.key })}
        onTileLongPress={options.onTileLongPress}
      />,
    );
  });
}

function section(): HTMLElement {
  const found = container.querySelector<HTMLElement>('section[aria-label="写真の一覧"]');
  if (!found) throw new Error("grid not found");
  return found;
}

function tiles(): HTMLButtonElement[] {
  return Array.from(container.querySelectorAll<HTMLButtonElement>('section[aria-label="写真の一覧"] li > button'));
}

function tile(fileName: string): HTMLButtonElement {
  const found = tiles().find((button) => button.title === fileName);
  if (!found) throw new Error(`tile not found: ${fileName}`);
  return found;
}

function headings(): string[] {
  return Array.from(container.querySelectorAll("h3, h4")).map((heading) => `${heading.tagName}:${heading.textContent}`);
}

beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(NOW);
  onTileClick = vi.fn();
  onTileOpen = vi.fn();
  onTileKeyDown = vi.fn();
  FakeIntersectionObserver.instances = [];
  originalIntersectionObserver = globalThis.IntersectionObserver;
  globalThis.IntersectionObserver = FakeIntersectionObserver as unknown as typeof IntersectionObserver;
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => {
    root.unmount();
  });
  container.remove();
  if (originalIntersectionObserver) globalThis.IntersectionObserver = originalIntersectionObserver;
  else delete (globalThis as { IntersectionObserver?: unknown }).IntersectionObserver;
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("BrowserPhotoEditingGrid", () => {
  it("日本時間の日ごとの見出し（今月でない月は月の見出しも）の下に、並んだ順のままタイルを出す", async () => {
    await renderGrid({ meta: <span>0.04 / 5 GB</span> });

    expect(headings()).toEqual([
      "H4:今日",
      "H4:昨日",
      "H3:9月",
      "H4:9月28日（月）",
      "H3:2025年8月",
      "H4:2025年8月15日（金）",
    ]);
    expect(tiles().map((button) => button.title)).toEqual(["P1.RW2", "t2.JPG", "P2.RW2", "H1.HEIC", "o1.JPG"]);
    // 広い幅は 4:3 のタイルの下にファイル名
    const name = tile("o1.JPG").firstElementChild;
    expect(name?.textContent).toBe("o1.JPG");
    expect(name?.className).toContain("order-last");
    expect(tile("o1.JPG").querySelector("span.aspect-\\[4\\/3\\]")).not.toBeNull();
    // 上に残る行（右に使用量）
    expect(section().className).toContain("scroll-pt-12");
    expect(container.textContent).toContain("0.04 / 5 GB");
  });

  it("狭い幅は 3 列の正方形でファイル名を見せず、読み上げには残す", async () => {
    await renderGrid({ compact: true, selectedKeys: ["t2"] });

    const name = tile("t2.JPG").firstElementChild;
    expect(name?.textContent).toBe("t2.JPG");
    expect(name?.className).toBe("sr-only");
    expect(tile("t2.JPG").querySelector("span.aspect-square")).not.toBeNull();
    expect(tile("t2.JPG").querySelector("span.aspect-\\[4\\/3\\]")).toBeNull();
    // 測れない環境では列を CSS に任せる（3 列）
    expect(tile("t2.JPG").closest("ul")?.className).toContain("grid-cols-3");
    // 選んだ写真は内側の枠と ✓
    expect(tile("t2.JPG").querySelector(".ring-inset")).not.toBeNull();
    expect(tile("t2.JPG").querySelector(".niho-accent-surface")).not.toBeNull();
    expect(section().className).toContain("px-0.5");
  });

  it("印は角に小さく: RAW（読ませない）・♥（「お気に入り」）。作業コピーを待っている写真は薄い幕だけで、回転は出さない", async () => {
    await renderGrid();

    const cell = tile("P1.RW2").querySelector("span.aspect-\\[4\\/3\\]");
    const raw = Array.from(cell?.querySelectorAll("span") ?? []).find((span) => span.textContent === "RAW");
    expect(raw?.getAttribute("aria-hidden")).toBe("true");
    expect(tile("t2.JPG").querySelector(".sr-only")?.textContent).toBe("お気に入り");
    expect(tile("P1.RW2").textContent).not.toContain("お気に入り");

    const rawPending = tile("P2.RW2").querySelector(".bg-white\\/45");
    expect(rawPending?.textContent).toBe("RAW の現像を準備中");
    expect(tile("H1.HEIC").querySelector(".bg-white\\/45")?.textContent).toBe("編集の準備中");
    expect(tile("P2.RW2").querySelector(".animate-spin")).toBeNull();
    expect(tile("o1.JPG").querySelector(".bg-white\\/45")).toBeNull();
    for (const word of ["queued", "rendering"]) expect(container.textContent).not.toContain(word);
  });

  it("追加している途中の写真は押せず、日時が無ければ「今日」に入れる。押す・ダブルクリック・キーは画面へ伝える", async () => {
    await renderGrid({
      items: [gridItem("adding", null, { adding: { fraction: 0.5 } }), ...ITEMS],
    });
    expect(headings()[0]).toBe("H4:今日");
    expect(tiles()[0]?.title).toBe("adding.JPG");
    expect(tile("adding.JPG").disabled).toBe(true);
    expect(tile("adding.JPG").textContent).toContain("追加中");
    expect(tile("adding.JPG").querySelector<HTMLElement>(".bg-niho-accent-ink")?.style.width).toBe("50%");
    // 並びが同じまま中身だけ変わった（送った割合が進んだ）ときも、タイルは新しい値で描く
    await renderGrid({
      items: [gridItem("adding", null, { adding: { fraction: 0.75 } }), ...ITEMS],
    });
    expect(tile("adding.JPG").querySelector<HTMLElement>(".bg-niho-accent-ink")?.style.width).toBe("75%");

    await act(async () => {
      tile("t2.JPG").dispatchEvent(new MouseEvent("click", { bubbles: true }));
      tile("t2.JPG").dispatchEvent(new MouseEvent("dblclick", { bubbles: true }));
      tile("t2.JPG").dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true }));
    });
    expect(onTileClick).toHaveBeenCalledWith("t2");
    expect(onTileOpen).toHaveBeenCalledWith("t2");
    expect(onTileKeyDown).toHaveBeenCalledWith("t2", { key: "ArrowDown" });
  });

  it("矢印キーの移り先は見出しを飛ばし、追加している途中の写真には移らない", async () => {
    const handle = createRef<BrowserPhotoEditingGridHandle>();
    await renderGrid({ handle, items: [gridItem("adding", null, { adding: { fraction: null } }), ...ITEMS] });

    // 測れない環境では日ごとに 1 行（↓ は次の日の同じ列、短ければ最後）
    expect(handle.current?.neighborKey("t2", "ArrowDown")).toBe("y1");
    expect(handle.current?.neighborKey("s1", "ArrowUp")).toBe("y1");
    expect(handle.current?.neighborKey("t2", "ArrowRight")).toBe("y1");
    expect(handle.current?.neighborKey("t1", "ArrowLeft")).toBeNull();
    expect(handle.current?.neighborKey("o1", "ArrowDown")).toBeNull();
  });

  it("写真が無いときは中央に空状態（上の行は出さない）、読み込み中はタイルの形の仮の面", async () => {
    await renderGrid({ items: [], meta: <span>使用量</span>, placeholder: <p>空の一覧</p> });
    expect(tiles()).toHaveLength(0);
    expect(container.textContent).toContain("空の一覧");
    expect(container.textContent).not.toContain("使用量");

    await renderGrid({ items: [], loading: true, compact: true, placeholder: <p>空の一覧</p> });
    expect(section().getAttribute("aria-busy")).toBe("true");
    expect(container.querySelectorAll(".animate-pulse.aspect-square").length).toBeGreaterThan(0);
    expect(container.textContent).not.toContain("空の一覧");
  });

  it("絞り込みの条件のある空の一覧（metaWhenEmpty）は、上の行を残したまま中央に空状態を出す（F5b #17125）", async () => {
    await renderGrid({
      items: [],
      metaStart: <button type="button">絞り込み</button>,
      metaWhenEmpty: true,
      meta: <span>使用量</span>,
      placeholder: <p>条件に合う写真はありません</p>,
    });
    expect(tiles()).toHaveLength(0);
    expect(container.textContent).toContain("条件に合う写真はありません");
    expect(container.textContent).toContain("絞り込み");
    expect(container.textContent).toContain("使用量");
  });

  it("下まで見たら続きを読み、読めなければ理由と「再読み込み」を出す", async () => {
    const onLoad = vi.fn();
    await renderGrid({ more: { hasMore: true, loading: false, failedMessage: null, onLoad } });

    const observer = FakeIntersectionObserver.latest();
    expect(observer?.options?.root).toBe(section());
    expect(observer?.options?.rootMargin).toBe("0px 0px 240px 0px");
    // 見張るのは一覧の一番下（描いていない行の余白の後）
    expect(observer?.targets[0]?.previousElementSibling?.contains(tile("o1.JPG"))).toBe(true);
    await act(async () => {
      observer?.intersect();
    });
    expect(onLoad).toHaveBeenCalledTimes(1);

    await renderGrid({ more: { hasMore: true, loading: false, failedMessage: "続きを読み込めませんでした。", onLoad } });
    const alert = container.querySelector('[role="alert"]');
    expect(alert?.textContent).toContain("続きを読み込めませんでした。");
    await act(async () => {
      alert?.querySelector("button")?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    expect(onLoad).toHaveBeenCalledTimes(2);
  });

  it("出した直後は表示中の写真が見える位置まで送る（後から表示中の写真が変わっても送らない）", async () => {
    const scrollIntoView = vi.fn();
    const original = HTMLElement.prototype.scrollIntoView;
    HTMLElement.prototype.scrollIntoView = scrollIntoView;
    try {
      await renderGrid({ activeKey: "s1" });
      expect(scrollIntoView).toHaveBeenCalledTimes(1);
      expect(scrollIntoView.mock.contexts[0]).toBe(tile("H1.HEIC"));
      await renderGrid({ activeKey: "t1" });
      expect(scrollIntoView).toHaveBeenCalledTimes(1);
    } finally {
      HTMLElement.prototype.scrollIntoView = original;
    }
  });
});

describe("BrowserPhotoEditingGrid（仮想スクロール）", () => {
  const scrollTops = new WeakMap<Element, number>();
  const descriptors = new Map<string, PropertyDescriptor | undefined>();

  /** 幅 600px（3 列）・高さ 400px の一覧。タイルの行は (600 - 24) / 3 × 3/4 + 20 + 14 = 178px */
  function stubLayout() {
    for (const property of ["clientWidth", "clientHeight", "scrollTop"]) {
      descriptors.set(property, Object.getOwnPropertyDescriptor(HTMLElement.prototype, property));
    }
    Object.defineProperty(HTMLElement.prototype, "clientWidth", { configurable: true, get: () => 600 });
    Object.defineProperty(HTMLElement.prototype, "clientHeight", { configurable: true, get: () => 400 });
    Object.defineProperty(HTMLElement.prototype, "scrollTop", {
      configurable: true,
      get(this: HTMLElement) {
        return scrollTops.get(this) ?? 0;
      },
      set(this: HTMLElement, value: number) {
        scrollTops.set(this, value);
      },
    });
    FakeResizeObserver.instances = [];
    vi.stubGlobal("ResizeObserver", FakeResizeObserver);
    vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => {
      callback(0);
      return 1;
    });
  }

  afterEach(() => {
    for (const [property, descriptor] of descriptors) {
      if (descriptor) Object.defineProperty(HTMLElement.prototype, property, descriptor);
      else Reflect.deleteProperty(HTMLElement.prototype, property);
    }
    descriptors.clear();
  });

  /** 今日に 300 枚（100 行） */
  const MANY = Array.from({ length: 300 }, (_, index) => gridItem(`p${index}`, "2026-10-01T01:00:00.000Z"));

  async function scrollTo(top: number) {
    await act(async () => {
      section().scrollTop = top;
      section().dispatchEvent(new Event("scroll"));
    });
  }

  it("見えている行と上下 1 画面分だけを描き、上下の余白で全体の高さを保つ。送ると描く行が替わる", async () => {
    stubLayout();
    await renderGrid({ items: MANY, meta: <span>使用量</span> });

    const drawn = tiles().map((button) => button.title);
    expect(drawn.length).toBeGreaterThan(0);
    expect(drawn.length).toBeLessThan(40);
    expect(drawn[0]).toBe("p0.JPG");
    const row = tile("p0.JPG").closest("ul");
    expect(row?.style.height).toBe("178px");
    expect(row?.style.gridTemplateColumns).toBe("repeat(3, minmax(0, 1fr))");
    const list = row?.parentElement;
    // 見出し 36px + 100 行 × 178px
    const spacers = Array.from(list?.children ?? []).filter((child) => child.tagName === "DIV") as HTMLElement[];
    const drawnRows = list?.querySelectorAll("ul").length ?? 0;
    expect(spacers.map((spacer) => spacer.style.height)).toEqual([`${(100 - drawnRows) * 178}px`]);

    await scrollTo(178 * 50);
    const moved = tiles().map((button) => button.title);
    expect(moved).not.toContain("p0.JPG");
    expect(moved).toContain("p150.JPG");
    expect(moved.length).toBeLessThan(40);
    expect(container.querySelector("h4")).toBeNull();
  });

  it("描いていないタイルも revealKey で見える位置まで送ってフォーカスする", async () => {
    stubLayout();
    const handle = createRef<BrowserPhotoEditingGridHandle>();
    await renderGrid({ items: MANY, meta: <span>使用量</span>, handle });
    expect(tiles().some((button) => button.title === "p299.JPG")).toBe(false);

    await act(async () => {
      handle.current?.revealKey("p299", { focus: true });
    });
    // 最後の行（上端 36 + 99 × 178）の下端が画面の下に来る位置
    expect(section().scrollTop).toBe(36 + 100 * 178 - 400);
    expect(document.activeElement).toBe(tile("p299.JPG"));

    // 上へ戻るときは、上に残る行（48px）の下に来る位置
    await act(async () => {
      handle.current?.revealKey("p3", { focus: true });
    });
    expect(section().scrollTop).toBe(36 + 178 - 48);
    expect(document.activeElement).toBe(tile("p3.JPG"));
    expect(handle.current?.neighborKey("p3", "ArrowDown")).toBe("p6");
    expect(handle.current?.neighborKey("p3", "ArrowUp")).toBe("p0");
  });

  it("一覧の中身（並び）が変わったら先頭へ戻す", async () => {
    stubLayout();
    await renderGrid({ items: MANY });
    await scrollTo(178 * 50);
    expect(section().scrollTop).toBe(178 * 50);

    await renderGrid({ items: MANY, listKey: "photos:added" });
    expect(section().scrollTop).toBe(0);
    expect(tiles()[0]?.title).toBe("p0.JPG");
  });
});

describe("BrowserPhotoListSortControl", () => {
  it("「撮影日」「最近追加」の 2 つの radio。押すか ←→ で切り替える", async () => {
    const onChange = vi.fn();
    await act(async () => {
      root.render(<BrowserPhotoListSortControl value="captured" onChange={onChange} />);
    });
    const group = container.querySelector('[role="radiogroup"]');
    expect(group?.getAttribute("aria-label")).toBe("並び");
    const radios = Array.from(container.querySelectorAll<HTMLButtonElement>('[role="radio"]'));
    expect(radios.map((radio) => [radio.textContent, radio.getAttribute("aria-checked"), radio.tabIndex])).toEqual([
      ["撮影日", "true", 0],
      ["最近追加", "false", -1],
    ]);
    expect(radios[0]?.className).toContain("bg-niho-accent-soft");
    expect(radios[0]?.className).toContain("h-8");
    expect(radios[0]?.className).toContain("after:-inset-y-1.5");

    await act(async () => {
      radios[0]?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    expect(onChange).not.toHaveBeenCalled();
    await act(async () => {
      radios[1]?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    expect(onChange).toHaveBeenLastCalledWith("added");
    await act(async () => {
      radios[0]?.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowRight", bubbles: true }));
    });
    expect(onChange).toHaveBeenCalledTimes(2);
    expect(document.activeElement).toBe(radios[1]);
  });
});

describe("BrowserPhotoEditingGrid（スマホの選択モードの空の丸・上の行）", () => {
  const EMPTY_CIRCLE = "span.rounded-full.border-2.border-white";

  it("選択モードの間、選んでいないタイルの右上に空の丸を出す。選んでいるタイルは今の ✓ のまま、追加している途中のタイルには出さない", async () => {
    await renderGrid({
      compact: true,
      selecting: true,
      selectedKeys: ["t2"],
      items: [gridItem("adding", null, { adding: { fraction: null } }), ...ITEMS],
    });

    for (const name of ["P1.RW2", "P2.RW2", "H1.HEIC", "o1.JPG"]) {
      const circles = tile(name).querySelectorAll(EMPTY_CIRCLE);
      expect(circles).toHaveLength(1);
      expect(circles[0]?.getAttribute("aria-hidden")).toBe("true");
      expect(circles[0]?.className).toBe("absolute right-1.5 top-1.5 h-[22px] w-[22px] rounded-full border-2 border-white bg-black/20");
      expect(circles[0]?.textContent).toBe("");
      expect(tile(name).getAttribute("aria-pressed")).toBe("false");
    }
    // 選んでいるタイルは ✓ と内側の枠（今のまま）。空の丸は重ねない
    expect(tile("t2.JPG").querySelectorAll(EMPTY_CIRCLE)).toHaveLength(0);
    expect(tile("t2.JPG").querySelector(".niho-accent-surface")).not.toBeNull();
    expect(tile("t2.JPG").querySelector(".ring-inset")).not.toBeNull();
    expect(tile("t2.JPG").getAttribute("aria-pressed")).toBe("true");
    // 追加している途中の写真は選べないので、丸も出さない
    expect(tile("adding.JPG").querySelectorAll(EMPTY_CIRCLE)).toHaveLength(0);
  });

  it("選択モードでなければ（省略・false）空の丸は出さない。広い幅でも選択モードなら出す", async () => {
    await renderGrid({ compact: true });
    expect(container.querySelectorAll(EMPTY_CIRCLE)).toHaveLength(0);
    await renderGrid({ compact: true, selecting: false });
    expect(container.querySelectorAll(EMPTY_CIRCLE)).toHaveLength(0);

    await renderGrid({ compact: false, selecting: true, selectedKeys: ["t1", "t2"] });
    expect(container.querySelectorAll(EMPTY_CIRCLE)).toHaveLength(3);
    expect(tile("P1.RW2").querySelectorAll(EMPTY_CIRCLE)).toHaveLength(0);
  });

  it("上に残る行の右（meta）が空のときは、右の入れ物（と行の間）を残さない。あれば今までどおり右に寄せる", async () => {
    await renderGrid({ metaStart: <span>左のバー</span> });
    const row = container.querySelector<HTMLElement>("section > div.sticky");
    expect(row?.children).toHaveLength(1);
    expect(row?.textContent).toBe("左のバー");

    await renderGrid({ metaStart: <span>左のバー</span>, meta: <span>0.04 / 5 GB</span> });
    const rightRow = container.querySelector<HTMLElement>("section > div.sticky");
    expect(rightRow?.children).toHaveLength(2);
    expect(rightRow?.lastElementChild?.className).toContain("ml-auto");
    expect(rightRow?.lastElementChild?.textContent).toBe("0.04 / 5 GB");
  });
});

describe("BrowserPhotoEditingGrid（スマホの長押し）", () => {
  let onLongPress: ReturnType<typeof vi.fn<(key: string) => void>>;

  beforeEach(() => {
    // 長押しは setTimeout で測る（日付だけの偽物から、タイマーも偽物にし直す）
    vi.useRealTimers();
    vi.useFakeTimers({ toFake: ["Date", "setTimeout", "clearTimeout"] });
    vi.setSystemTime(NOW);
    onLongPress = vi.fn();
  });

  function pointer(
    type: string,
    element: Element,
    options: { pointerType?: string; pointerId?: number; x?: number; y?: number } = {},
  ) {
    element.dispatchEvent(
      new PointerEvent(type, {
        bubbles: true,
        cancelable: true,
        pointerType: options.pointerType ?? "touch",
        pointerId: options.pointerId ?? 1,
        clientX: options.x ?? 100,
        clientY: options.y ?? 100,
      }),
    );
  }

  async function press(element: Element, options?: { pointerType?: string; pointerId?: number; x?: number; y?: number }) {
    await act(async () => {
      pointer("pointerdown", element, options);
    });
  }

  function advance(ms: number) {
    act(() => {
      vi.advanceTimersByTime(ms);
    });
  }

  /** 押して離した（タップ）。click まで続けて来る */
  async function tap(element: Element) {
    await act(async () => {
      pointer("pointerdown", element);
      pointer("pointerup", element);
      element.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
    });
  }

  it("500ms 動かさずに押し続けると 1 回だけ伝える。そのあとに続く click は捨て、次の押しはふつうに伝える", async () => {
    await renderGrid({ compact: true, onTileLongPress: onLongPress });
    const target = tile("t2.JPG");

    await press(target);
    advance(499);
    expect(onLongPress).not.toHaveBeenCalled();
    advance(1);
    expect(onLongPress).toHaveBeenCalledTimes(1);
    expect(onLongPress).toHaveBeenCalledWith("t2");
    // 押し続けても、もう呼ばない
    advance(5000);
    expect(onLongPress).toHaveBeenCalledTimes(1);

    // 指を離すと続けて click が来る: 捨てる（入った 1 枚をすぐ選び直して外さない）
    await act(async () => {
      pointer("pointerup", target);
    });
    const click = new MouseEvent("click", { bubbles: true, cancelable: true });
    await act(async () => {
      target.dispatchEvent(click);
    });
    expect(onTileClick).not.toHaveBeenCalled();
    expect(click.defaultPrevented).toBe(true);

    // 次の押し（タップ）はふつうに伝える
    await tap(target);
    expect(onTileClick).toHaveBeenCalledTimes(1);
    expect(onTileClick).toHaveBeenCalledWith("t2");
    expect(onLongPress).toHaveBeenCalledTimes(1);
  });

  it("長押しのあとの click が来なかったときも、次の押しは飲まない。別のタイルへの click も捨てない", async () => {
    await renderGrid({ compact: true, onTileLongPress: onLongPress });

    await press(tile("t2.JPG"));
    advance(500);
    expect(onLongPress).toHaveBeenCalledWith("t2");
    await act(async () => {
      pointer("pointerup", tile("t2.JPG"));
    });
    // click は来ないまま、次のタップ
    await tap(tile("t2.JPG"));
    expect(onTileClick).toHaveBeenCalledTimes(1);
    expect(onTileClick).toHaveBeenLastCalledWith("t2");

    // 長押ししたタイルと別のタイルの click は、捨てずに伝える
    await press(tile("P1.RW2"));
    advance(500);
    expect(onLongPress).toHaveBeenLastCalledWith("t1");
    await act(async () => {
      pointer("pointerup", tile("P1.RW2"));
      tile("o1.JPG").dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
    });
    expect(onTileClick).toHaveBeenLastCalledWith("o1");
    expect(onTileClick).toHaveBeenCalledTimes(2);
  });

  it("500ms に届かないうちに離すと伝えない（ふつうのタップ）", async () => {
    await renderGrid({ compact: true, onTileLongPress: onLongPress });
    const target = tile("t2.JPG");

    await press(target);
    advance(499);
    await act(async () => {
      pointer("pointerup", target);
      target.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
    });
    advance(5000);
    expect(onLongPress).not.toHaveBeenCalled();
    expect(onTileClick).toHaveBeenCalledTimes(1);
    expect(onTileClick).toHaveBeenCalledWith("t2");
  });

  it("10px 以上動かすと伝えない（9px までの揺れは長押しのまま）", async () => {
    await renderGrid({ compact: true, onTileLongPress: onLongPress });
    const target = tile("t2.JPG");

    // (6, 8) = 10px
    await press(target, { x: 100, y: 100 });
    await act(async () => {
      pointer("pointermove", target, { x: 106, y: 108 });
    });
    advance(5000);
    expect(onLongPress).not.toHaveBeenCalled();

    // (5, 7) ≒ 8.6px。別の指（pointerId）の動きは数えない
    await press(target, { x: 100, y: 100 });
    await act(async () => {
      pointer("pointermove", target, { x: 105, y: 107 });
      pointer("pointermove", target, { x: 300, y: 300, pointerId: 2 });
    });
    advance(500);
    expect(onLongPress).toHaveBeenCalledTimes(1);
    expect(onLongPress).toHaveBeenCalledWith("t2");
  });

  it("スクロールが始まった（pointercancel）・指が外れた（pointerleave）ときも取り消す", async () => {
    await renderGrid({ compact: true, onTileLongPress: onLongPress });
    const target = tile("t2.JPG");

    await press(target);
    await act(async () => {
      pointer("pointercancel", target);
    });
    advance(5000);
    expect(onLongPress).not.toHaveBeenCalled();

    await press(target);
    await act(async () => {
      // 窓の外へ出た（relatedTarget なしの pointerout が pointerleave になる）
      pointer("pointerout", target);
    });
    advance(5000);
    expect(onLongPress).not.toHaveBeenCalled();

    // どちらのあとも、次の長押しは効く
    await press(target);
    advance(500);
    expect(onLongPress).toHaveBeenCalledTimes(1);
  });

  it("touch 以外（マウス・ペン）の押し続けは長押しにしない", async () => {
    await renderGrid({ compact: true, onTileLongPress: onLongPress });
    const target = tile("t2.JPG");

    await press(target, { pointerType: "mouse" });
    advance(5000);
    await act(async () => {
      pointer("pointerup", target, { pointerType: "mouse" });
    });
    await press(target, { pointerType: "pen" });
    advance(5000);
    expect(onLongPress).not.toHaveBeenCalled();

    // マウスの click はふつうに伝える（捨てない）
    await act(async () => {
      pointer("pointerdown", target, { pointerType: "mouse" });
      pointer("pointerup", target, { pointerType: "mouse" });
      target.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
    });
    expect(onTileClick).toHaveBeenCalledTimes(1);
    expect(onTileClick).toHaveBeenCalledWith("t2");
  });

  it("2 本目の指（ピンチ・誤って触れた）が来たら長押しにしない", async () => {
    await renderGrid({ compact: true, onTileLongPress: onLongPress });

    await press(tile("t2.JPG"), { pointerId: 1 });
    advance(200);
    await press(tile("P2.RW2"), { pointerId: 2, x: 200, y: 200 });
    advance(5000);
    expect(onLongPress).not.toHaveBeenCalled();
  });

  it("広い幅・渡されていないときは長押しを扱わない（contextmenu も止めない）", async () => {
    await renderGrid({ compact: false, onTileLongPress: onLongPress });
    await press(tile("t2.JPG"));
    advance(5000);
    expect(onLongPress).not.toHaveBeenCalled();
    const wideMenu = new MouseEvent("contextmenu", { bubbles: true, cancelable: true });
    await act(async () => {
      tile("t2.JPG").dispatchEvent(wideMenu);
    });
    expect(wideMenu.defaultPrevented).toBe(false);
    expect(tile("t2.JPG").className).not.toContain("touch-callout");

    await renderGrid({ compact: true });
    await press(tile("t2.JPG"));
    advance(5000);
    expect(onLongPress).not.toHaveBeenCalled();
    const menu = new MouseEvent("contextmenu", { bubbles: true, cancelable: true });
    await act(async () => {
      tile("t2.JPG").dispatchEvent(menu);
    });
    expect(menu.defaultPrevented).toBe(false);
    expect(tile("t2.JPG").className).not.toContain("touch-callout");
  });

  it("長押し中の OS のメニュー（contextmenu・iOS の画像メニュー）を出さない", async () => {
    await renderGrid({ compact: true, onTileLongPress: onLongPress });

    const menu = new MouseEvent("contextmenu", { bubbles: true, cancelable: true });
    await act(async () => {
      tile("t2.JPG").dispatchEvent(menu);
    });
    expect(menu.defaultPrevented).toBe(true);
    expect(tile("t2.JPG").className).toContain("[-webkit-touch-callout:none]");
  });

  it("追加している途中のタイルは、長押しも contextmenu の抑止も扱わない", async () => {
    await renderGrid({
      compact: true,
      onTileLongPress: onLongPress,
      items: [gridItem("adding", null, { adding: { fraction: null } }), ...ITEMS],
    });
    const adding = tile("adding.JPG");

    await press(adding);
    advance(5000);
    expect(onLongPress).not.toHaveBeenCalled();
    expect(adding.className).not.toContain("touch-callout");
    const menu = new MouseEvent("contextmenu", { bubbles: true, cancelable: true });
    await act(async () => {
      adding.dispatchEvent(menu);
    });
    expect(menu.defaultPrevented).toBe(false);
  });

  it("押している途中に長押しが効かなくなる（広い幅へ・渡されなくなる）・画面を閉じるときは、待っているタイマーを残さない", async () => {
    await renderGrid({ compact: true, onTileLongPress: onLongPress });
    await press(tile("t2.JPG"));
    advance(200);
    // 窓が広がって一覧が広い幅になった
    await renderGrid({ compact: false, onTileLongPress: onLongPress });
    advance(5000);
    expect(onLongPress).not.toHaveBeenCalled();

    await renderGrid({ compact: true, onTileLongPress: onLongPress });
    await press(tile("t2.JPG"));
    advance(200);
    await renderGrid({ compact: true });
    advance(5000);
    expect(onLongPress).not.toHaveBeenCalled();

    await renderGrid({ compact: true, onTileLongPress: onLongPress });
    await press(tile("t2.JPG"));
    advance(200);
    await act(async () => {
      root.unmount();
    });
    advance(5000);
    expect(onLongPress).not.toHaveBeenCalled();
  });

  it("タイマーが鳴る前に渡された最新の onTileLongPress を呼ぶ", async () => {
    const latest = vi.fn();
    await renderGrid({ compact: true, onTileLongPress: onLongPress });
    await press(tile("t2.JPG"));
    advance(200);
    await renderGrid({ compact: true, onTileLongPress: latest });
    advance(300);
    expect(onLongPress).not.toHaveBeenCalled();
    expect(latest).toHaveBeenCalledTimes(1);
    expect(latest).toHaveBeenCalledWith("t2");
  });
});
