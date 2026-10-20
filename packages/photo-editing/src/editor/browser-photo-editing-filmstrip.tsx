"use client";

import { useEffect, useRef, type KeyboardEvent as ReactKeyboardEvent } from "react";
import { cn } from "niho-ui/cn";

import { BROWSER_PHOTO_EDITING_FILMSTRIP_LABEL } from "../photo-editing-copy";

import type { BrowserPhotoEditingGridItem } from "./browser-photo-editing-grid";
import { PhotoEditingTileImage } from "./photo-editing-grid";

/** 升の縦横比（幅 / 高さ。3:2） */
const FILMSTRIP_TILE_ASPECT = 3 / 2;
/** 開いている写真の升を見える位置へ送るとき、帯の端から空ける幅（px。左右の余白と同じ） */
const FILMSTRIP_SCROLL_MARGIN_PX = 12;

function prefersReducedMotion(): boolean {
  return typeof window.matchMedia === "function" && window.matchMedia("(prefers-reduced-motion: reduce)").matches;
}

/**
 * 升が帯の中で見える位置へ横に送る（`scrollIntoView({ inline: "nearest" })` と同じ送り方を帯の中だけで。ページや面を縦に動かさない）。
 * 見えていれば何もしない。
 */
function revealTile(strip: HTMLElement, tile: HTMLElement) {
  const start = tile.offsetLeft - FILMSTRIP_SCROLL_MARGIN_PX;
  const end = tile.offsetLeft + tile.offsetWidth + FILMSTRIP_SCROLL_MARGIN_PX;
  const left =
    start < strip.scrollLeft ? start : end > strip.scrollLeft + strip.clientWidth ? end - strip.clientWidth : null;
  if (left === null) return;
  const behavior: ScrollBehavior = prefersReducedMotion() ? "auto" : "smooth";
  if (typeof strip.scrollTo === "function") strip.scrollTo({ left, behavior });
  else strip.scrollLeft = left;
}

/**
 * 1 枚の面の下のフィルムストリップ（Lightroom と同じ。L5 #54）。今の一覧のサムネイルを横に並べ、押すとその写真を 1 枚で開く。
 * PC の広い幅の 1 枚の表示だけに出す（一覧・狭い幅には出さない。出し分けは画面）。
 *
 * - 開いている写真の升は accent-ink の輪。開いている写真が替わったら、その升を帯の中で見える位置まで送る（動きを減らす設定では
 *   滑らかにしない）。帯の中で操作していたら、フォーカスもその升へ移す
 * - 追加している途中の写真は薄くして押せない
 * - Tab で止まるのは開いている写真の升だけ。升の上の ← → は `onArrowKey`（画面の ← → と同じ移り方で前後の写真を開く）
 */
export function BrowserPhotoEditingFilmstrip(props: {
  items: ReadonlyArray<BrowserPhotoEditingGridItem>;
  /** 開いている写真 */
  activeKey: string | null;
  onOpen: (key: string) => void;
  onArrowKey: (event: ReactKeyboardEvent<HTMLButtonElement>) => void;
}) {
  const stripRef = useRef<HTMLElement | null>(null);
  const activeTileRef = useRef<HTMLButtonElement | null>(null);
  const { activeKey } = props;
  // Tab で止まる升（開いている写真。帯に無ければ押せる最初の升）
  const tabStopKey = props.items.some((item) => item.key === activeKey && !item.adding)
    ? activeKey
    : (props.items.find((item) => !item.adding)?.key ?? null);

  useEffect(() => {
    const strip = stripRef.current;
    const tile = activeTileRef.current;
    if (!strip || !tile) return;
    revealTile(strip, tile);
    const focused = document.activeElement;
    if (focused !== tile && focused instanceof HTMLElement && strip.contains(focused)) tile.focus({ preventScroll: true });
  }, [activeKey]);

  if (props.items.length === 0) return null;

  return (
    <nav
      ref={stripRef}
      aria-label={BROWSER_PHOTO_EDITING_FILMSTRIP_LABEL}
      className="relative h-[5.5rem] shrink-0 overflow-x-auto overflow-y-hidden border-t border-niho-border [scrollbar-width:thin]"
    >
      <ul className="flex h-full w-max items-center gap-1.5 px-3">
        {props.items.map((item) => {
          const active = item.key === activeKey;
          const adding = item.adding !== undefined;
          const thumbnail = item.thumbnail;
          return (
            <li key={item.key} className="shrink-0">
              <button
                ref={active ? activeTileRef : undefined}
                type="button"
                aria-label={item.fileName}
                aria-current={active ? "true" : undefined}
                title={item.fileName}
                disabled={adding}
                tabIndex={item.key === tabStopKey ? 0 : -1}
                onClick={() => props.onOpen(item.key)}
                onKeyDown={(event) => {
                  if (event.key === "ArrowLeft" || event.key === "ArrowRight") props.onArrowKey(event);
                }}
                className={cn(
                  "relative block aspect-[3/2] h-[68px] overflow-hidden rounded-md bg-[#F1EEE6] outline outline-2 outline-offset-2 outline-transparent focus-visible:outline-niho-text-sub motion-safe:transition-opacity",
                  active
                    ? "ring-2 ring-niho-accent-ink"
                    : adding
                      ? "cursor-not-allowed opacity-40"
                      : "opacity-[0.82] hover:opacity-100",
                )}
              >
                {thumbnail.url ? (
                  <PhotoEditingTileImage
                    key={thumbnail.url}
                    url={thumbnail.url}
                    geometry={item.geometry ?? null}
                    cellAspect={FILMSTRIP_TILE_ASPECT}
                  />
                ) : thumbnail.failed ? (
                  <span
                    aria-hidden
                    className="flex h-full w-full items-center justify-center text-base font-bold text-niho-text-muted"
                  >
                    {Array.from(item.fileName)[0] ?? ""}
                  </span>
                ) : null}
              </button>
            </li>
          );
        })}
      </ul>
    </nav>
  );
}
