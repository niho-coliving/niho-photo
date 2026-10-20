"use client";

import {
  useEffect,
  useRef,
  useState,
  type MutableRefObject,
  type PointerEvent as ReactPointerEvent,
  type ReactNode,
} from "react";

import type { CutoutPoint } from "../photo-cutout";
import { PHOTO_EDITING_CUTOUT_BRUSH_AREA_LABEL } from "../photo-editing-copy";
import { cn } from "niho-ui/cn";

/** sidecar の `compose` が受け付ける点の範囲（写真の外へ出た点もこの範囲で残す）。 */
const POINT_MIN = -1;
const POINT_MAX = 2;

type Gesture = { pointerId: number; points: CutoutPoint[] };
type Cursor = { left: number; top: number; diameter: number };

function clampPoint(value: number): number {
  return Math.min(POINT_MAX, Math.max(POINT_MIN, value));
}

/**
 * 写真の上の背景除去のブラシ（NIHO camera だけ。C4 移行元設計）。`children` は写真の canvas（`targetRef`）で、面の 1 枚の表示の
 * 領域いっぱいに置いた入れ物の中で今までどおり中央に収める。道具を開いている間（`enabled`）だけ、なぞった点を写真の左上を原点に
 * 0〜1（写真の外は -1〜2 まで）で知らせる。
 *
 * - 押してから離すまでが 1 ストローク: 動かしている間は `onLiveStroke`（面が途中の画を描く）、離したら `onCommitStroke`（取り消しの
 *   1 単位）。ポインタを取り上げられた・中止されたら確定せず `onLiveStroke(null)`。マウスでもペンでも同じ（pointer capture・
 *   `touch-action: none`）
 * - 筆の大きさの輪（直径 = 2 × 半径 × 写真の短い辺。線だけ・読み上げない）をポインタの位置に出し、領域から出たら消す
 * - `disabled` の間は塗らない（途中で押せなくなったら、そのストロークは捨てる）
 *
 * 入れ物は道具を開いていない間も置いたまま（canvas を置き直すと、面が描き直すまで画が消えるため）。
 */
export function PhotoEditingCutoutBrushOverlay(props: {
  /** なぞれる（背景除去の道具を開いていて、レシピとマスクがある） */
  enabled: boolean;
  /** 筆の半径（写真の短い辺に対する割合） */
  radius: number;
  disabled: boolean;
  /** 写真の canvas（点はこの要素の画面の矩形で 0〜1 に直す） */
  targetRef: MutableRefObject<HTMLCanvasElement | null>;
  onLiveStroke: (points: CutoutPoint[] | null) => void;
  onCommitStroke: (points: CutoutPoint[]) => void;
  children: ReactNode;
}) {
  const rootRef = useRef<HTMLDivElement | null>(null);
  const gestureRef = useRef<Gesture | null>(null);
  const [cursor, setCursor] = useState<Cursor | null>(null);
  const interactive = props.enabled && !props.disabled;
  const callbacksRef = useRef(props);
  callbacksRef.current = props;

  // なぞっている途中に押せなくなった・道具を閉じたら、そのストロークは確定せずに捨てる
  useEffect(() => {
    if (interactive) return;
    setCursor(null);
    if (!gestureRef.current) return;
    gestureRef.current = null;
    callbacksRef.current.onLiveStroke(null);
  }, [interactive]);

  /** 画面の点を写真の 0〜1 に直す（写真の大きさを測れなければ null）。 */
  const toPoint = (clientX: number, clientY: number): CutoutPoint | null => {
    const rect = props.targetRef.current?.getBoundingClientRect();
    if (!rect || rect.width <= 0 || rect.height <= 0) return null;
    return { x: clampPoint((clientX - rect.left) / rect.width), y: clampPoint((clientY - rect.top) / rect.height) };
  };

  const moveCursor = (clientX: number, clientY: number) => {
    const root = rootRef.current?.getBoundingClientRect();
    const rect = props.targetRef.current?.getBoundingClientRect();
    if (!root || !rect || rect.width <= 0 || rect.height <= 0) {
      setCursor(null);
      return;
    }
    setCursor({
      left: clientX - root.left,
      top: clientY - root.top,
      diameter: 2 * props.radius * Math.min(rect.width, rect.height),
    });
  };

  const start = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (!interactive || gestureRef.current || event.button !== 0) return;
    const point = toPoint(event.clientX, event.clientY);
    if (!point) return;
    event.preventDefault();
    event.currentTarget.setPointerCapture?.(event.pointerId);
    gestureRef.current = { pointerId: event.pointerId, points: [point] };
    moveCursor(event.clientX, event.clientY);
    props.onLiveStroke([point]);
  };

  const move = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (!interactive) return;
    moveCursor(event.clientX, event.clientY);
    const gesture = gestureRef.current;
    if (!gesture || gesture.pointerId !== event.pointerId) return;
    const point = toPoint(event.clientX, event.clientY);
    if (!point) return;
    gesture.points = [...gesture.points, point];
    props.onLiveStroke(gesture.points);
  };

  const end = (event: ReactPointerEvent<HTMLDivElement>, commit: boolean) => {
    const gesture = gestureRef.current;
    if (!gesture || gesture.pointerId !== event.pointerId) return;
    gestureRef.current = null;
    if (commit) props.onCommitStroke(gesture.points);
    else props.onLiveStroke(null);
  };

  return (
    <div
      ref={rootRef}
      role={props.enabled ? "group" : undefined}
      aria-label={props.enabled ? PHOTO_EDITING_CUTOUT_BRUSH_AREA_LABEL : undefined}
      aria-disabled={props.enabled && props.disabled ? true : undefined}
      data-testid="photo-cutout-brush-area"
      className={cn(
        "absolute inset-0 flex select-none items-center justify-center",
        props.enabled ? "touch-none" : null,
        interactive ? "cursor-none" : null,
      )}
      onPointerDown={start}
      onPointerMove={move}
      onPointerUp={(event) => end(event, true)}
      onPointerCancel={(event) => end(event, false)}
      onLostPointerCapture={(event) => end(event, false)}
      onPointerLeave={() => {
        if (!gestureRef.current) setCursor(null);
      }}
    >
      {props.children}
      {interactive && cursor ? (
        <span
          aria-hidden
          data-testid="photo-cutout-brush-cursor"
          className="pointer-events-none absolute -translate-x-1/2 -translate-y-1/2 rounded-full border border-niho-surface outline outline-1 outline-niho-text/40"
          style={{ left: cursor.left, top: cursor.top, width: cursor.diameter, height: cursor.diameter }}
        />
      ) : null}
    </div>
  );
}
