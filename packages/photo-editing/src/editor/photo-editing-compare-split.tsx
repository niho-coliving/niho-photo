"use client";

import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type KeyboardEvent,
  type PointerEvent,
  type RefObject,
} from "react";
import { ChevronsLeftRight } from "lucide-react";

import { PHOTO_EDITING_COMPARE_SPLIT_HANDLE_LABEL, photoEditingCompareSplitValueText } from "../photo-editing-copy";

import { clampBrowserPhotoCompareSplit } from "./use-browser-photo-compare-view";

type SplitBox = { left: number; top: number; width: number; height: number };

/** 位置の誤差（px）。これ以下の違いでは測り直した値に置き換えない（置き換えると再描画が止まらない） */
const BOX_EPSILON = 0.5;
/** ← → で動かす幅（%）と、Shift・PageUp / PageDown の幅 */
const SPLIT_STEP = 1;
const SPLIT_LARGE_STEP = 10;

function sameBox(a: SplitBox | null, b: SplitBox): boolean {
  return (
    a !== null &&
    Math.abs(a.left - b.left) < BOX_EPSILON &&
    Math.abs(a.top - b.top) < BOX_EPSILON &&
    Math.abs(a.width - b.width) < BOX_EPSILON &&
    Math.abs(a.height - b.height) < BOX_EPSILON
  );
}

/**
 * 分割の比較（niho-photo#41）。補正後の写真の canvas（`targetRef`）と同じ大きさ・同じ位置に補正前の canvas を重ね、境界
 * （`position`。写真の幅に対する左からの %）から左だけを見せる。補正前の画は面の hook が `beforeCanvasRef` の canvas に描く。
 *
 * - 置く位置は補正後の canvas の実測で決め、大きさが変わったら（窓・パネルの幅・描き直した画の大きさ）測り直す。重ねるのは親
 *   （写真の面。`position: absolute` の入れ物）の中で、クリップ領域の印より後ろに置く（補正前の側には印を見せない）
 * - 境界は線のつまみ（押せる幅 44px）をドラッグ（pointer capture）するか、キー（← → / ↑ ↓ = 1%、Shift・PageUp / PageDown =
 *   10%、Home / End = 端）で動かす。読み上げは `role="slider"`。動きは付けない（reduced motion に依らず同じ）
 * - つまみ以外は押せない（下の補正後の canvas の操作〔色ミキサーのスポイト〕を邪魔しない）
 */
export function PhotoEditingCompareSplit(props: {
  targetRef: RefObject<HTMLCanvasElement | null>;
  beforeCanvasRef: (canvas: HTMLCanvasElement | null) => void;
  /** 補正前の canvas の読み上げ名 */
  beforeLabel: string;
  position: number;
  onPositionChange: (position: number) => void;
}) {
  const { targetRef, onPositionChange } = props;
  const position = clampBrowserPhotoCompareSplit(props.position);
  const rootRef = useRef<HTMLDivElement | null>(null);
  const [box, setBox] = useState<SplitBox | null>(null);
  /** ドラッグしている指（つまみを掴んだ位置と線のずれを保つ。掴んだだけでは動かさない） */
  const dragRef = useRef<{ pointerId: number; offsetX: number } | null>(null);

  // 補正後の canvas の実測に合わせる（変わっていなければ state を替えない）
  const measure = useCallback(() => {
    const root = rootRef.current;
    const target = targetRef.current;
    const parent = root?.parentElement;
    if (!root || !target || !parent) return;
    const measured = target.getBoundingClientRect();
    const origin = parent.getBoundingClientRect();
    const next: SplitBox = {
      left: measured.left - origin.left - parent.clientLeft,
      top: measured.top - origin.top - parent.clientTop,
      width: measured.width,
      height: measured.height,
    };
    setBox((current) => (sameBox(current, next) ? current : next));
  }, [targetRef]);

  // 描画のたびに測る（描き直した画の大きさの変化はここで拾う）
  useLayoutEffect(() => {
    measure();
  });

  // 描画を伴わない大きさの変化（窓・パネルの幅）も拾う
  useEffect(() => {
    window.addEventListener("resize", measure);
    const observer = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(measure);
    const target = targetRef.current;
    const parent = rootRef.current?.parentElement;
    if (observer && target) observer.observe(target);
    if (observer && parent) observer.observe(parent);
    return () => {
      observer?.disconnect();
      window.removeEventListener("resize", measure);
    };
  }, [measure, targetRef]);

  /** 画面の x から境界の位置（%）。写真の幅が測れなければ null */
  const positionAt = (clientX: number): number | null => {
    const rect = rootRef.current?.getBoundingClientRect();
    if (!rect || !(rect.width > 0)) return null;
    return clampBrowserPhotoCompareSplit(((clientX - rect.left) / rect.width) * 100);
  };

  const onPointerDown = (event: PointerEvent<HTMLDivElement>) => {
    if (event.pointerType === "mouse" && event.button !== 0) return;
    const rect = rootRef.current?.getBoundingClientRect();
    if (!rect || !(rect.width > 0)) return;
    // 写真の面の指の操作（拡大・背景除去のブラシ）には渡さない
    event.stopPropagation();
    event.currentTarget.setPointerCapture?.(event.pointerId);
    dragRef.current = { pointerId: event.pointerId, offsetX: event.clientX - (rect.left + (rect.width * position) / 100) };
  };
  const onPointerMove = (event: PointerEvent<HTMLDivElement>) => {
    const drag = dragRef.current;
    if (!drag || drag.pointerId !== event.pointerId) return;
    event.stopPropagation();
    const next = positionAt(event.clientX - drag.offsetX);
    if (next !== null) onPositionChange(next);
  };
  const endDrag = (event: PointerEvent<HTMLDivElement>) => {
    const drag = dragRef.current;
    if (!drag || drag.pointerId !== event.pointerId) return;
    dragRef.current = null;
    if (event.currentTarget.hasPointerCapture?.(event.pointerId)) event.currentTarget.releasePointerCapture?.(event.pointerId);
  };
  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.metaKey || event.ctrlKey || event.altKey) return;
    const step = event.shiftKey ? SPLIT_LARGE_STEP : SPLIT_STEP;
    const current = Math.round(position);
    const next =
      event.key === "ArrowLeft" || event.key === "ArrowDown"
        ? current - step
        : event.key === "ArrowRight" || event.key === "ArrowUp"
          ? current + step
          : event.key === "PageDown"
            ? current - SPLIT_LARGE_STEP
            : event.key === "PageUp"
              ? current + SPLIT_LARGE_STEP
              : event.key === "Home"
                ? 0
                : event.key === "End"
                  ? 100
                  : null;
    if (next === null) return;
    // 写真の前後の移動（← →）に使わせない
    event.preventDefault();
    event.stopPropagation();
    onPositionChange(clampBrowserPhotoCompareSplit(next));
  };

  return (
    <div
      ref={rootRef}
      data-testid="photo-compare-split"
      className="pointer-events-none absolute"
      style={
        box
          ? { left: box.left, top: box.top, width: box.width, height: box.height }
          : { left: 0, top: 0, width: 0, height: 0, visibility: "hidden" }
      }
    >
      <canvas
        ref={props.beforeCanvasRef}
        aria-label={props.beforeLabel}
        className="absolute inset-0 block h-full w-full"
        style={{ clipPath: `inset(0 ${100 - position}% 0 0)` }}
      />
      <div
        role="slider"
        tabIndex={0}
        aria-label={PHOTO_EDITING_COMPARE_SPLIT_HANDLE_LABEL}
        aria-orientation="horizontal"
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={Math.round(position)}
        aria-valuetext={photoEditingCompareSplitValueText(position)}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={endDrag}
        onPointerCancel={endDrag}
        onLostPointerCapture={() => {
          dragRef.current = null;
        }}
        onKeyDown={onKeyDown}
        className="group pointer-events-auto absolute inset-y-0 w-11 -translate-x-1/2 cursor-ew-resize touch-none select-none outline-none"
        style={{ left: `${position}%` }}
      >
        <span aria-hidden className="absolute inset-y-0 left-1/2 w-0.5 -translate-x-1/2 bg-white shadow-[0_0_2px_rgba(0,0,0,0.45)]" />
        <span
          aria-hidden
          className="absolute left-1/2 top-1/2 flex h-8 w-8 -translate-x-1/2 -translate-y-1/2 items-center justify-center rounded-full bg-white text-niho-text shadow-md group-focus-visible:ring-2 group-focus-visible:ring-niho-accent-ink"
        >
          <ChevronsLeftRight className="h-4 w-4" strokeWidth={2.25} />
        </span>
      </div>
    </div>
  );
}
