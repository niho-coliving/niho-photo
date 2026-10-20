"use client";

import {
  forwardRef,
  useCallback,
  useEffect,
  useImperativeHandle,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
  type MouseEvent as ReactMouseEvent,
  type PointerEvent as ReactPointerEvent,
  type ReactNode,
} from "react";
import { Check, Heart } from "lucide-react";

import { Skeleton } from "niho-ui/components/skeleton";
import { Spinner } from "niho-ui/components/spinner";
import { workPreparingText } from "../develop-engine/develop-work-wait";
import {
  buildPhotoLibrarySections,
  msUntilNextTokyoMidnight,
  photoLibraryNeighborKey,
  photoLibraryRowOffsets,
  photoLibraryRows,
  photoLibraryVisibleRange,
  tokyoDayKey,
  type PhotoLibraryRow,
  type PhotoLibrarySort,
} from "../photo-library-sections";
import type { PhotoEditingThumbnail } from "../photo-editing-thumbnail";
import { cn } from "niho-ui/cn";

import { PhotoEditingTileImage, type PhotoEditingGridMore } from "./photo-editing-grid";

/** 一覧のタイル 1 枚（クラウドの写真。追加している途中の写真を含む）。 */
export type BrowserPhotoEditingGridItem = {
  key: string;
  fileName: string;
  /** サムネイル（補正後のプレビューか補正前のプレビュー。追加している途中は手元のプレビュー） */
  thumbnail: PhotoEditingThumbnail;
  raw: boolean;
  /** サムネイルに CSS で当てる幾何（補正前のプレビューのときだけ。移行元設計） */
  geometry?: Record<string, unknown> | null;
  /** 追加している途中（薄い幕と回転、送った割合が分かれば下端に細い帯。上げ終わるまで押せない） */
  adding?: { fraction: number | null };
  /** お気に入り（左上に ♥） */
  favorite: boolean;
  /** 作業コピーを待っている写真（RAW か、ほか）。薄い幕だけにし、状態の語や回転は出さない（待ちの件数は状態欄） */
  pending: "raw" | "other" | null;
  /** 見出しの日時（ISO。撮影日の並びは撮影日か追加日、最近追加は追加日）。null は今（このタブで足した写真） */
  sectionDate: string | null;
};

/** 画面から呼ぶ操作（矢印キーの移り先と、描いていないタイルを見える位置まで送ってフォーカスする） */
export type BrowserPhotoEditingGridHandle = {
  neighborKey: (fromKey: string, arrowKey: string) => string | null;
  revealKey: (key: string, options?: { focus?: boolean }) => void;
};

/** 広い幅のタイルの最小の幅・列の間・行の間（px） */
const WIDE_TILE_MIN_PX = 144;
const WIDE_GAP_X_PX = 12;
const WIDE_GAP_Y_PX = 14;
/** タイルの下のファイル名（間 5px ＋ 行 15px） */
const WIDE_NAME_PX = 20;
/** 狭い幅は 3 列の正方形（間 2px） */
const COMPACT_COLUMNS = 3;
const COMPACT_GAP_PX = 2;
/** 見出しの行の高さ（px） */
const DAY_HEADING_PX = 36;
const MONTH_HEADING_PX = 52;
/** 上に残る右上の行の分（`scroll-pt-12` と同じ） */
const META_PX = 48;
/** 読み込み中に並べるタイルの数 */
const SKELETON_TILE_COUNT = 8;
const COMPACT_SKELETON_TILE_COUNT = 12;
/** 続きを読み始める、一番下からの距離（px） */
const LOAD_MORE_MARGIN_PX = 240;
/** 長押し（スマホの選択モードに入る）: 動かさずに押し続ける長さ（ms）と、これ以上動いたら長押しにしない距離（px） */
const LONG_PRESS_MS = 500;
const LONG_PRESS_MOVE_TOLERANCE_PX = 10;

/** 長押しになるのを待っている指（押し始めてから、長押しになる・離す・動かすまでの間だけ持つ） */
type PendingLongPress = { pointerId: number; startX: number; startY: number; timer: number };

/**
 * 一覧の寸法。`pending` はまだ測っていない（行を描かない）、`none` は測れない環境（テストの jsdom・出す前から隠している間）で
 * 行を全部描き、列は CSS に任せる。`anchor` は描く範囲を決める位置（{@link scrollAnchor}）。
 */
type GridLayout =
  | { kind: "pending" }
  | { kind: "none" }
  | { kind: "measured"; width: number; height: number; listTop: number; anchor: number };

/** 描く範囲を決める位置を半画面ごとに丸める（送るたびに描き直さない。上下 1 画面分の余分で見える範囲を覆う） */
function anchorStep(height: number): number {
  return Math.max(1, Math.floor(height / 2));
}

function scrollAnchor(scrollTop: number, height: number): number {
  const step = anchorStep(height);
  return Math.floor(Math.max(0, scrollTop) / step) * step;
}

/** 見出しと行に効くもの（並びと日時）が同じか。タイルの中身（追加の進み具合・印）だけが変わったときは作り直さない */
function sameSectionInputs(
  previous: readonly BrowserPhotoEditingGridItem[],
  next: readonly BrowserPhotoEditingGridItem[],
): boolean {
  if (previous.length !== next.length) return false;
  for (let index = 0; index < next.length; index += 1) {
    if (previous[index].key !== next[index].key || previous[index].sectionDate !== next[index].sectionDate) return false;
  }
  return true;
}

/** 列の数とタイルの行の高さ（下の間を含む）。広い幅は 144px 以上の 4:3 ＋ファイル名、狭い幅は 3 列の正方形 */
function gridMetrics(width: number, compact: boolean): { columns: number; tileRowPx: number } {
  if (compact) {
    const tile = (width - COMPACT_GAP_PX * (COMPACT_COLUMNS - 1)) / COMPACT_COLUMNS;
    return { columns: COMPACT_COLUMNS, tileRowPx: tile + COMPACT_GAP_PX };
  }
  const columns = Math.max(1, Math.floor((width + WIDE_GAP_X_PX) / (WIDE_TILE_MIN_PX + WIDE_GAP_X_PX)));
  const tile = (width - WIDE_GAP_X_PX * (columns - 1)) / columns;
  return { columns, tileRowPx: (tile * 3) / 4 + WIDE_NAME_PX + WIDE_GAP_Y_PX };
}

/** ピルの選択の 1 つ（値と見せる名前）。 */
export type BrowserPhotoPillOption<T> = { value: T; label: string };

/** ピルの選択の矢印キー（→↓ は次、←↑ は前。端から反対の端へ回る） */
const PILL_ARROW_STEPS: Readonly<Record<string, number>> = { ArrowRight: 1, ArrowDown: 1, ArrowLeft: -1, ArrowUp: -1 };

/**
 * ピルを並べた選択（radio と同じく 1 つだけ選ぶ。▾ のメニューにしない）。選んでいる方は薄い緑の地と緑の字。見た目は 32px のまま、
 * 押せる範囲だけ 44px にする。矢印キーでも選び直す（radio と同じ）。一覧の並びの切り替えと絞り込みの選択肢（F5b 移行元設計）が使う。
 */
export function BrowserPhotoPillRadioGroup<T>(props: {
  /** 読み上げの名前 */
  label: string;
  options: readonly BrowserPhotoPillOption<T>[];
  value: T;
  onChange: (next: T) => void;
  className?: string;
}) {
  const buttonsRef = useRef<(HTMLButtonElement | null)[]>([]);
  const checkedIndex = props.options.findIndex((option) => Object.is(option.value, props.value));
  return (
    <div role="radiogroup" aria-label={props.label} className={cn("flex items-center gap-0.5", props.className)}>
      {props.options.map((option, index) => {
        const checked = index === checkedIndex;
        return (
          <button
            key={String(option.value)}
            ref={(element) => {
              buttonsRef.current[index] = element;
            }}
            type="button"
            role="radio"
            aria-checked={checked}
            tabIndex={checked || (checkedIndex < 0 && index === 0) ? 0 : -1}
            onClick={() => {
              if (!checked) props.onChange(option.value);
            }}
            onKeyDown={(event) => {
              const step = PILL_ARROW_STEPS[event.key];
              if (step === undefined) return;
              event.preventDefault();
              const nextIndex = (index + step + props.options.length) % props.options.length;
              const next = props.options[nextIndex];
              if (!next) return;
              if (nextIndex !== checkedIndex) props.onChange(next.value);
              buttonsRef.current[nextIndex]?.focus();
            }}
            className={cn(
              "relative inline-flex h-8 shrink-0 items-center rounded-full px-3 text-sub font-bold transition focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-niho-accent-ink",
              "after:absolute after:inset-x-0 after:-inset-y-1.5 after:content-['']",
              checked ? "bg-niho-accent-soft text-niho-accent-ink" : "text-niho-text-muted hover:text-niho-text",
            )}
          >
            {option.label}
          </button>
        );
      })}
    </div>
  );
}

const SORT_OPTIONS: readonly BrowserPhotoPillOption<PhotoLibrarySort>[] = [
  { value: "captured", label: "撮影日" },
  { value: "added", label: "最近追加" },
];

/**
 * 一覧の並びの切り替え（上に残る行の左。「撮影日」「最近追加」を並べた選択で、▾ のメニューにしない）。選んでいる方は薄い緑の地と
 * 緑の字。行の高さ（32px）は変えず、押せる範囲だけ 44px にする。←→ でも切り替える（radio と同じ）。
 */
export function BrowserPhotoListSortControl(props: { value: PhotoLibrarySort; onChange: (next: PhotoLibrarySort) => void }) {
  return (
    <BrowserPhotoPillRadioGroup
      label="並び"
      options={SORT_OPTIONS}
      value={props.value}
      onChange={props.onChange}
      className="h-8 shrink-0"
    />
  );
}

type BrowserPhotoEditingGridProps = {
  items: readonly BrowserPhotoEditingGridItem[];
  /** 一覧の中身（場所・並び・絞り込み）。変わったら先頭へ戻す */
  listKey: string;
  /** 狭い幅（1024px 未満）。3 列の正方形のタイルで、ファイル名は読み上げだけ */
  compact: boolean;
  selectedKeys: ReadonlySet<string>;
  /** 表示中の写真（出した直後・一覧の中身が変わった後に見える位置へ送る） */
  activeKey: string | null;
  /** 最初のページを読んでいる（タイルの形の仮の面を並べる） */
  loading?: boolean;
  /** 上に残る行の左（並びの切り替えと絞り込み） */
  metaStart?: ReactNode;
  /** 写真が無いときも上に残る行を出す（絞り込みの条件があるとき。条件を選び直せるよう、絞り込みのボタンを残す） */
  metaWhenEmpty?: boolean;
  /** 上に残る行の右（写真を選んでいるときの「クラウドから消す」と使用量） */
  meta?: ReactNode;
  /** 写真が無いときに中央に出すもの（空状態・読めなかったとき） */
  placeholder?: ReactNode;
  more?: PhotoEditingGridMore;
  /** スマホの選択モード（タイルを押すと足す・外す）。true の間、選んでいないタイルの右上に空の丸を出して、選べることを示す */
  selecting?: boolean;
  onTileClick: (key: string, event: ReactMouseEvent<HTMLButtonElement>) => void;
  /** ダブルクリック（1 枚で出す） */
  onTileOpen: (key: string) => void;
  onTileKeyDown: (key: string, event: ReactKeyboardEvent<HTMLButtonElement>) => void;
  /**
   * タイルの長押し（狭い幅の touch だけ。500ms 動かさずに押し続ける。10px 以上動かしたら取り消す）。渡さなければ長押しは扱わない。
   * 長押しのあとに続いて来る click は捨てる。長押し中の OS のメニュー（contextmenu・iOS の画像メニュー）は出さない
   */
  onTileLongPress?: (key: string) => void;
};

/**
 * 日本時間の今日の日付の数字。次の午前 0 時に更新し、タブを隠している間に日が変わっていたら、戻ったときに更新する
 * （タイマーは隠れている間に止まりうる）。
 */
function useTokyoDayKey(): number {
  const [key, setKey] = useState(() => tokyoDayKey(Date.now()));
  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | null = null;
    function schedule() {
      // 0 時ちょうどの直後に起こす（ずれて前の日のまま再計算しないよう 1 秒足す）
      timer = setTimeout(refresh, msUntilNextTokyoMidnight(Date.now()) + 1_000);
    }
    function refresh() {
      setKey(tokyoDayKey(Date.now()));
      if (timer) clearTimeout(timer);
      schedule();
    }
    schedule();
    const onVisible = () => {
      if (document.visibilityState === "visible") refresh();
    };
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      if (timer) clearTimeout(timer);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, []);
  return key;
}

/**
 * ブラウザ版の一覧（F5a-2 移行元設計）。サーバーが並べた順のまま日本時間の日ごとの見出し（今月でない月は月の見出しも）で分け、
 * 見えている行と上下 1 画面分だけを描く（3,000〜30,000 枚でも DOM を増やさない）。行の高さは測った幅から決め、上と下の
 * 余白で全体の高さを保つ。広い幅は 4:3 のタイルとファイル名、狭い幅は 3 列の正方形（間 2px）でファイル名は読み上げだけ。
 * タイルの印は角に小さく（RAW 左下・♥ 左上・選んでいる ✓ 右上）、作業コピーを待っている写真は薄い幕だけ。見た目と押し方は
 * NIHO Desktop と共通の `PhotoEditingGrid` に揃える（選び方は画面が決め、ここは押されたことを伝えるだけ）。狭い幅は touch の
 * 長押し（500ms）も伝える（スマホの選択モードに入る）。選択モードの間は、選んでいないタイルの右上に空の丸を出す。
 */
export const BrowserPhotoEditingGrid = forwardRef<BrowserPhotoEditingGridHandle, BrowserPhotoEditingGridProps>(
  function BrowserPhotoEditingGrid(props, ref) {
    const { compact } = props;
    const scrollRef = useRef<HTMLElement | null>(null);
    const listRef = useRef<HTMLDivElement | null>(null);
    const sentinelRef = useRef<HTMLDivElement | null>(null);
    const tilesRef = useRef(new Map<string, HTMLButtonElement>());
    const [layout, setLayout] = useState<GridLayout>({ kind: "pending" });

    // 見出しと行は並び（キーと日時）が変わったときだけ作り直す（数万枚でも、追加の進み具合のたびに作り直さない）
    const [sectionSource, setSectionSource] = useState(props.items);
    let source = sectionSource;
    if (sectionSource !== props.items && !sameSectionInputs(sectionSource, props.items)) {
      setSectionSource(props.items);
      source = props.items;
    }
    const indexByKey = useMemo(() => new Map(source.map((item, index) => [item.key, index])), [source]);
    // 「今日」「昨日」は、並びが変わったときか、日本時間の日付が変わったときの時刻で決める（開いたままで日をまたいでも、前日の写真が
    // 「今日」のまま残らない）
    const todayKey = useTokyoDayKey();
    // eslint-disable-next-line react-hooks/exhaustive-deps -- 並びと日付が変わったときだけ「今」を取り直す（Date.now は依存に書けない）
    const builtAt = useMemo(() => Date.now(), [source, todayKey]);
    const sections = useMemo(() => buildPhotoLibrarySections(source, builtAt), [source, builtAt]);
    const measured = layout.kind === "measured" ? layout : null;
    const metrics = measured ? gridMetrics(measured.width, compact) : null;
    const columns = metrics?.columns ?? Number.POSITIVE_INFINITY;
    const tileRowPx = metrics?.tileRowPx ?? 0;
    const rows = useMemo(() => photoLibraryRows(sections, columns), [sections, columns]);
    const geometry = useMemo(
      () => photoLibraryRowOffsets(rows, { month: MONTH_HEADING_PX, day: DAY_HEADING_PX, tiles: tileRowPx }),
      [rows, tileRowPx],
    );
    const rowIndexByKey = useMemo(() => {
      const map = new Map<string, number>();
      rows.forEach((row, index) => {
        if (row.kind === "tiles") for (const key of row.keys) map.set(key, index);
      });
      return map;
    }, [rows]);
    const range = measured
      ? photoLibraryVisibleRange(
          geometry.offsets,
          geometry.total,
          measured.anchor - measured.listTop,
          measured.height + anchorStep(measured.height),
          measured.height,
        )
      : { start: 0, end: layout.kind === "none" ? rows.length : 0 };

    const empty = !props.loading && props.items.length === 0;
    const showMeta = Boolean(props.meta || props.metaStart) && (!empty || props.metaWhenEmpty === true);
    const hasList = !props.loading && !empty;

    // 幅と高さを測る。隠している間（設定のサブタブ）は前に測った値のまま。一度も測れなければ（jsdom）行を全部描く
    const measure = useCallback(() => {
      const section = scrollRef.current;
      const list = listRef.current;
      if (!section || !list) return;
      const width = list.clientWidth;
      const height = section.clientHeight;
      if (width <= 0 || height <= 0) {
        setLayout((previous) => (previous.kind === "pending" ? { kind: "none" } : previous));
        return;
      }
      const listTop = list.getBoundingClientRect().top - section.getBoundingClientRect().top + section.scrollTop;
      const anchor = scrollAnchor(section.scrollTop, height);
      setLayout((previous) =>
        previous.kind === "measured" &&
        previous.width === width &&
        previous.height === height &&
        previous.listTop === listTop &&
        previous.anchor === anchor
          ? previous
          : { kind: "measured", width, height, listTop, anchor },
      );
    }, []);
    const syncScroll = useCallback(() => {
      const section = scrollRef.current;
      if (!section) return;
      const scrollTop = section.scrollTop;
      setLayout((previous) => {
        if (previous.kind !== "measured") return previous;
        const anchor = scrollAnchor(scrollTop, previous.height);
        return anchor === previous.anchor ? previous : { ...previous, anchor };
      });
    }, []);

    useLayoutEffect(() => {
      measure();
    }, [measure, hasList, compact]);
    // 窓の幅・高さが変わった、縦のスクロールバーが出た（一覧の幅が変わる）ときに測り直す
    useEffect(() => {
      const section = scrollRef.current;
      if (!section || typeof ResizeObserver === "undefined") return;
      const observer = new ResizeObserver(() => measure());
      observer.observe(section);
      if (listRef.current) observer.observe(listRef.current);
      return () => observer.disconnect();
    }, [measure, hasList]);
    // 送っている間は 1 フレームに 1 回だけ、描く範囲が変わったときだけ描き直す
    useEffect(() => {
      const section = scrollRef.current;
      if (!section) return;
      let frame: number | null = null;
      const onScroll = () => {
        if (frame !== null) return;
        frame = requestAnimationFrame(() => {
          frame = null;
          syncScroll();
        });
      };
      section.addEventListener("scroll", onScroll, { passive: true });
      return () => {
        section.removeEventListener("scroll", onScroll);
        if (frame !== null) cancelAnimationFrame(frame);
      };
    }, [syncScroll]);

    // 送る先（出した直後は表示中の写真。矢印キーで移った写真）。描いていなければ、行の位置まで送って描いてからフォーカスする
    const pendingRevealRef = useRef<{ key: string; focus: boolean } | null>(
      props.activeKey === null ? null : { key: props.activeKey, focus: false },
    );
    const itemOf = (key: string): BrowserPhotoEditingGridItem | undefined => {
      const index = indexByKey.get(key);
      return index === undefined ? undefined : props.items[index];
    };
    const latestRef = useRef({ layout, geometry, rowIndexByKey, rows, itemOf, tileRowPx, showMeta, loading: false });
    useLayoutEffect(() => {
      latestRef.current = {
        layout,
        geometry,
        rowIndexByKey,
        rows,
        itemOf,
        tileRowPx,
        showMeta,
        loading: props.loading === true,
      };
    });
    const applyReveal = useCallback(() => {
      const pending = pendingRevealRef.current;
      const section = scrollRef.current;
      const latest = latestRef.current;
      if (!pending || !section || latest.layout.kind === "pending") return;
      const rowIndex = latest.rowIndexByKey.get(pending.key);
      if (rowIndex === undefined) {
        // 読み込み中なら、読み終えてから送る
        if (!latest.loading) pendingRevealRef.current = null;
        return;
      }
      if (latest.layout.kind === "measured") {
        const metaPx = latest.showMeta ? META_PX : 0;
        const top = latest.layout.listTop + latest.geometry.offsets[rowIndex];
        const bottom = top + latest.tileRowPx;
        const scrollTop = section.scrollTop;
        const next =
          top < scrollTop + metaPx
            ? top - metaPx
            : bottom > scrollTop + latest.layout.height
              ? bottom - latest.layout.height
              : scrollTop;
        if (next !== scrollTop) {
          section.scrollTop = Math.max(0, next);
          syncScroll();
        }
      }
      const tile = tilesRef.current.get(pending.key);
      if (!tile) return;
      pendingRevealRef.current = null;
      if (latest.layout.kind === "none" && typeof tile.scrollIntoView === "function") tile.scrollIntoView({ block: "nearest" });
      if (pending.focus) tile.focus({ preventScroll: latest.layout.kind === "measured" });
    }, [syncScroll]);

    // 一覧の中身（場所・並び・絞り込み）が変わったら先頭へ戻し、表示中の写真があればそこまで送る
    const listKeyRef = useRef(props.listKey);
    useLayoutEffect(() => {
      if (listKeyRef.current === props.listKey) return;
      listKeyRef.current = props.listKey;
      const section = scrollRef.current;
      if (section) section.scrollTop = 0;
      syncScroll();
      pendingRevealRef.current = props.activeKey === null ? null : { key: props.activeKey, focus: false };
    }, [props.activeKey, props.listKey, syncScroll]);
    useLayoutEffect(() => {
      applyReveal();
    });

    useImperativeHandle(
      ref,
      () => ({
        neighborKey: (fromKey, arrowKey) => {
          const latest = latestRef.current;
          return photoLibraryNeighborKey(latest.rows, fromKey, arrowKey, (key) => !latest.itemOf(key)?.adding);
        },
        revealKey: (key, options) => {
          pendingRevealRef.current = { key, focus: options?.focus === true };
          applyReveal();
        },
      }),
      [applyReveal],
    );

    // 下まで見たら続きを読む。読み足しても一番下が見えたままなら、続けて読む（見張り直すと 1 回呼ばれる）
    const hasMore = props.more?.hasMore === true;
    const loadingMore = props.more?.loading === true;
    const loadMoreFailedMessage = props.more?.failedMessage ?? null;
    const loadMoreFailed = loadMoreFailedMessage !== null;
    const onLoadMoreRef = useRef(props.more?.onLoad);
    onLoadMoreRef.current = props.more?.onLoad;
    const itemCount = props.items.length;
    useEffect(() => {
      const root = scrollRef.current;
      const target = sentinelRef.current;
      if (!root || !target || !hasMore || loadingMore || loadMoreFailed) return;
      if (typeof IntersectionObserver === "undefined") return;
      const observer = new IntersectionObserver(
        (entries) => {
          if (entries.some((entry) => entry.isIntersecting)) onLoadMoreRef.current?.();
        },
        { root, rootMargin: `0px 0px ${LOAD_MORE_MARGIN_PX}px 0px` },
      );
      observer.observe(target);
      return () => observer.disconnect();
    }, [hasMore, itemCount, loadMoreFailed, loadingMore]);

    // 長押し（狭い幅の touch だけ）。待っている指と、長押しになった写真の key（そのあとに続く click を捨てる印）を持つ
    const longPressEnabled = compact && props.onTileLongPress !== undefined;
    const onTileLongPressRef = useRef(props.onTileLongPress);
    onTileLongPressRef.current = props.onTileLongPress;
    const pendingPressRef = useRef<PendingLongPress | null>(null);
    const longPressedKeyRef = useRef<string | null>(null);
    const cancelLongPress = useCallback(() => {
      const pending = pendingPressRef.current;
      if (pending === null) return;
      pendingPressRef.current = null;
      window.clearTimeout(pending.timer);
    }, []);
    // 長押しが効かなくなる（広い幅に戻った・渡されなくなった）とき、一覧を閉じるときに、待っているタイマーを残さない
    useEffect(() => cancelLongPress, [cancelLongPress, longPressEnabled]);
    const startLongPress = (key: string, event: ReactPointerEvent<HTMLButtonElement>) => {
      // 前の長押しのあとの click が来なかったときも、次の押しを飲まないよう、押し始めで印を外す
      longPressedKeyRef.current = null;
      if (event.pointerType !== "touch") return;
      if (pendingPressRef.current !== null) {
        // 2 本目の指（ピンチ・誤って触れた）は長押しにしない
        cancelLongPress();
        return;
      }
      const pending: PendingLongPress = {
        pointerId: event.pointerId,
        startX: event.clientX,
        startY: event.clientY,
        timer: window.setTimeout(() => {
          if (pendingPressRef.current !== pending) return;
          pendingPressRef.current = null;
          longPressedKeyRef.current = key;
          onTileLongPressRef.current?.(key);
        }, LONG_PRESS_MS),
      };
      pendingPressRef.current = pending;
    };
    const moveLongPress = (event: ReactPointerEvent<HTMLButtonElement>) => {
      const pending = pendingPressRef.current;
      if (pending === null || pending.pointerId !== event.pointerId) return;
      if (Math.hypot(event.clientX - pending.startX, event.clientY - pending.startY) >= LONG_PRESS_MOVE_TOLERANCE_PX) {
        cancelLongPress();
      }
    };
    const endLongPress = (event: ReactPointerEvent<HTMLButtonElement>) => {
      const pending = pendingPressRef.current;
      if (pending !== null && pending.pointerId === event.pointerId) cancelLongPress();
    };

    const renderTile = (item: BrowserPhotoEditingGridItem) => {
      const selected = props.selectedKeys.has(item.key);
      const { thumbnail } = item;
      // 追加している途中の写真は押せないので、長押しも扱わない
      const pressable = longPressEnabled && item.adding === undefined;
      return (
        <button
          ref={(element) => {
            if (element) tilesRef.current.set(item.key, element);
            else tilesRef.current.delete(item.key);
          }}
          type="button"
          aria-pressed={selected}
          disabled={item.adding !== undefined}
          title={item.fileName}
          onClick={(event) => {
            // 長押しで選択モードに入ったあとに続く click は捨てる（入った 1 枚を、すぐ選び直して外さない）
            const longPressedKey = longPressedKeyRef.current;
            longPressedKeyRef.current = null;
            if (longPressedKey === item.key) {
              event.preventDefault();
              return;
            }
            props.onTileClick(item.key, event);
          }}
          onDoubleClick={() => props.onTileOpen(item.key)}
          onKeyDown={(event) => props.onTileKeyDown(item.key, event)}
          onPointerDown={pressable ? (event) => startLongPress(item.key, event) : undefined}
          onPointerMove={pressable ? moveLongPress : undefined}
          onPointerUp={pressable ? endLongPress : undefined}
          onPointerCancel={pressable ? endLongPress : undefined}
          onPointerLeave={pressable ? endLongPress : undefined}
          // 長押し中の OS のメニュー（Android の contextmenu・iOS の画像メニュー）は出さない
          onContextMenu={pressable ? (event) => event.preventDefault() : undefined}
          className={cn(
            "group flex w-full min-w-0 flex-col text-left focus-visible:outline-none",
            !compact && "gap-[5px] rounded-[10px]",
            pressable && "[-webkit-touch-callout:none]",
          )}
        >
          {/* 読み上げは写真名が先。広い幅は見た目ではタイルの下に置き、狭い幅は読み上げだけ */}
          <span
            className={
              compact
                ? "sr-only"
                : cn(
                    "order-last block truncate px-0.5 text-xs font-bold leading-[15px] tabular-nums",
                    selected ? "text-niho-accent-ink" : "text-niho-text-muted",
                  )
            }
          >
            {item.fileName}
          </span>
          <span
            className={cn(
              "relative block w-full overflow-hidden bg-[#F1EEE6] outline outline-2 outline-transparent motion-safe:transition-[box-shadow,outline-color]",
              compact ? "aspect-square -outline-offset-2" : "aspect-[4/3] rounded-[10px] outline-offset-2",
              selected
                ? !compact && "ring-2 ring-niho-accent-ink ring-offset-2"
                : "group-hover:shadow-[0_0_0_1px_#DDD8CC]",
              "group-focus-visible:outline-niho-text-sub",
            )}
          >
            {thumbnail.url ? (
              <PhotoEditingTileImage
                key={thumbnail.url}
                url={thumbnail.url}
                geometry={item.geometry ?? null}
                cellAspect={compact ? 1 : undefined}
              />
            ) : thumbnail.failed ? (
              <span
                aria-hidden
                className="flex h-full w-full items-center justify-center text-xl font-bold text-niho-text-muted"
              >
                {Array.from(item.fileName)[0] ?? ""}
              </span>
            ) : null}
            {item.pending ? (
              // 作業コピーを待っている間は薄い幕だけ（状態の語・回転は出さない）
              <span className="absolute inset-0 bg-white/45">
                <span className="sr-only">{workPreparingText(item.pending === "raw")}</span>
              </span>
            ) : null}
            {item.favorite ? (
              <span className="absolute left-[5px] top-[5px] flex h-[18px] w-[18px] items-center justify-center rounded-md bg-black/60 text-white">
                <Heart className="h-3 w-3" fill="currentColor" strokeWidth={0} aria-hidden />
                <span className="sr-only">お気に入り</span>
              </span>
            ) : null}
            {item.raw ? (
              // 読み上げはファイル名（拡張子）と重なるので読ませない
              <span
                aria-hidden
                className="absolute bottom-[5px] left-[5px] rounded bg-black/60 px-1 text-[9px] font-bold leading-[14px] tracking-[0.05em] text-white"
              >
                RAW
              </span>
            ) : null}
            {selected ? (
              <>
                {compact ? (
                  // 狭い幅は間が 2px なので、枠はタイルの内側に描く
                  <span aria-hidden className="absolute inset-0 ring-[3px] ring-inset ring-niho-accent-ink" />
                ) : null}
                <span
                  aria-hidden
                  className="niho-accent-surface absolute right-1.5 top-1.5 flex h-[22px] w-[22px] items-center justify-center rounded-full shadow-sm"
                >
                  <Check className="h-3.5 w-3.5" strokeWidth={3} />
                </span>
              </>
            ) : props.selecting && item.adding === undefined ? (
              // スマホの選択モード: 選んでいないタイルの右上に空の丸（選べることを示す）
              <span
                aria-hidden
                className="absolute right-1.5 top-1.5 h-[22px] w-[22px] rounded-full border-2 border-white bg-black/20"
              />
            ) : null}
            {item.adding ? (
              <span className="absolute inset-0 flex items-center justify-center bg-white/55">
                <Spinner size="md" />
                <span className="sr-only">追加中</span>
                {item.adding.fraction !== null ? (
                  <span aria-hidden className="absolute inset-x-0 bottom-0 h-1 bg-niho-accent-soft">
                    <span
                      className="block h-full bg-niho-accent-ink motion-safe:transition-[width]"
                      style={{ width: `${Math.round(Math.min(1, Math.max(0, item.adding.fraction)) * 100)}%` }}
                    />
                  </span>
                ) : null}
              </span>
            ) : null}
          </span>
        </button>
      );
    };

    const headingPadding = compact ? "px-3.5" : "px-0.5";
    const renderRow = (row: PhotoLibraryRow) => {
      if (row.kind === "month") {
        return (
          <h3 key={row.key} className={cn("flex h-[52px] items-end pb-2 text-lg font-bold leading-6 text-niho-text", headingPadding)}>
            {row.label}
          </h3>
        );
      }
      if (row.kind === "day") {
        return (
          <h4 key={row.key} className={cn("flex h-9 items-end pb-2 text-sub font-bold text-niho-text-sub", headingPadding)}>
            {row.label}
          </h4>
        );
      }
      return (
        <ul
          key={row.key}
          className={cn(
            "grid",
            compact ? "gap-x-0.5 pb-0.5" : "gap-x-3 pb-3.5",
            // 測れないときは列を CSS に任せる（日ごとに 1 つの list）
            !measured &&
              (compact ? "grid-cols-3 gap-y-0.5" : "grid-cols-[repeat(auto-fill,minmax(144px,1fr))] gap-y-3.5"),
          )}
          style={measured ? { height: tileRowPx, gridTemplateColumns: `repeat(${columns}, minmax(0, 1fr))` } : undefined}
        >
          {row.keys.map((key) => {
            const item = itemOf(key);
            return item ? (
              <li key={key} className="min-w-0">
                {renderTile(item)}
              </li>
            ) : null;
          })}
        </ul>
      );
    };

    const topSpacer = measured ? (geometry.offsets[range.start] ?? geometry.total) : 0;
    const bottomSpacer = measured ? geometry.total - (geometry.offsets[range.end] ?? geometry.total) : 0;

    return (
      <section
        ref={scrollRef}
        aria-label="写真の一覧"
        aria-busy={props.loading || loadingMore ? true : undefined}
        className={cn(
          "flex h-full min-h-0 flex-col overflow-y-auto pb-[18px] pt-2.5 [scrollbar-width:thin]",
          compact ? "px-0.5" : "px-[18px]",
          // 上に残る行の下にタイルが来るように送る（キーボードで移ったときのフォーカス）
          showMeta && "scroll-pt-12",
        )}
      >
        {showMeta ? (
          // 一覧を下へ送っても上に残す（移行元設計）。上の余白（pt-2.5）の分も白で覆い、高さはボタン（32px）に合わせて固定する
          <div
            className={cn(
              "sticky -top-2.5 z-10 -mt-2.5 mb-1.5 box-content flex h-8 shrink-0 items-center gap-3 bg-[var(--photo-editing-surface,white)] pt-2.5 text-xs font-bold tabular-nums text-niho-text-muted",
              compact && "px-3.5",
            )}
          >
            {props.metaStart}
            {/* 右が空のとき（スマホの選択バー）は、行の間（gap）も残さず、左の要素が行いっぱいに広がれるようにする */}
            {props.meta ? <div className="ml-auto flex min-w-0 items-center gap-3">{props.meta}</div> : null}
          </div>
        ) : null}
        {props.loading ? (
          <ul
            aria-hidden
            className={cn(
              "grid shrink-0",
              compact ? "grid-cols-3 gap-0.5" : "grid-cols-[repeat(auto-fill,minmax(144px,1fr))] gap-x-3 gap-y-3.5",
            )}
          >
            {Array.from({ length: compact ? COMPACT_SKELETON_TILE_COUNT : SKELETON_TILE_COUNT }, (_, index) => (
              <li key={index}>
                {compact ? (
                  <Skeleton className="aspect-square rounded-none" />
                ) : (
                  <>
                    <Skeleton className="aspect-[4/3] rounded-[10px]" />
                    <Skeleton className="mt-[5px] h-3 w-3/4" />
                  </>
                )}
              </li>
            ))}
          </ul>
        ) : empty ? (
          <div className="m-auto flex items-center justify-center p-6">{props.placeholder}</div>
        ) : (
          <div ref={listRef} className="shrink-0 select-none">
            {topSpacer > 0 ? <div aria-hidden style={{ height: topSpacer }} /> : null}
            {rows.slice(range.start, range.end).map(renderRow)}
            {bottomSpacer > 0 ? <div aria-hidden style={{ height: bottomSpacer }} /> : null}
          </div>
        )}
        <div ref={sentinelRef} aria-hidden className="h-px shrink-0" />
        {loadingMore ? (
          <div className="flex shrink-0 justify-center py-4">
            <Spinner size="md" label="続きを読み込み中" />
          </div>
        ) : null}
        {loadMoreFailed ? (
          <div role="alert" className="shrink-0 py-3 text-center text-xs leading-relaxed text-[#8C3425]">
            {loadMoreFailedMessage}
            <button
              type="button"
              onClick={() => onLoadMoreRef.current?.()}
              className="ml-2 font-bold text-niho-text-sub underline"
            >
              再読み込み
            </button>
          </div>
        ) : null}
      </section>
    );
  },
);
