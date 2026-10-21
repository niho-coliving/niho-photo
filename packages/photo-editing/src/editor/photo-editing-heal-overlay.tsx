"use client";

import {
  useCallback,
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
  type MutableRefObject,
  type PointerEvent as ReactPointerEvent,
  type ReactNode,
} from "react";

import type { DevelopHealPoint } from "../develop-engine/develop-heal";
import type { DevelopHealImageSize, DevelopHealMarkView } from "../develop-engine/develop-heal-editing";
import {
  PHOTO_EDITING_HEAL_BRUSH_AREA_DESCRIPTION,
  PHOTO_EDITING_HEAL_BRUSH_AREA_LABEL,
  PHOTO_EDITING_HEAL_SOURCE_LABEL,
} from "../photo-editing-copy";
import {
  appendHealStrokePoint,
  clampHealSource,
  healCoreRadius,
  healKeyDelta,
  healMarkAt,
  healMarkBounds,
  healMarkFingerprint,
  healPointFromClient,
  healRadiusPixels,
  moveHealKeyCursor,
  type HealRect,
} from "../photo-editing-heal";
import { cn } from "niho-ui/cn";

/** 位置の誤差（px）。これ以下の違いでは測り直した値に置き換えない（置き換えると再描画が止まらない） */
const BOX_EPSILON = 0.5;
/** Shift+クリックで印を選ぶときの、半径の外の余裕（画面の px） */
const SELECT_TOLERANCE_PX = 6;
/** 選んでいる印の輪の太さ（画面の px） */
const SELECTED_RING_PX = 2;
/** 印の赤（まだ埋まっていない印・なぞっている線は濃く、埋まった印は薄く） */
const MARK_COLOR = "var(--niho-danger)";
const PENDING_OPACITY = 0.55;
const PAINTED_OPACITY = 0.22;

type Stroke = { pointerId: number; points: readonly DevelopHealPoint[]; size: DevelopHealImageSize };
type SourceDrag = { pointerId: number; id: string; grab: DevelopHealPoint; source: DevelopHealPoint; moved: boolean };

/** ポインタを取り上げる（もう離れたポインタなど、取り上げられなくても描くのは続ける）。 */
function capturePointer(element: Element, pointerId: number) {
  try {
    element.setPointerCapture?.(pointerId);
  } catch {
    // 取り上げられないポインタ（合成の操作・既に離れた）は、領域の中の動きだけで描く
  }
}

function sameBox(a: HealRect | null, b: HealRect): boolean {
  return (
    a !== null &&
    Math.abs(a.left - b.left) < BOX_EPSILON &&
    Math.abs(a.top - b.top) < BOX_EPSILON &&
    Math.abs(a.width - b.width) < BOX_EPSILON &&
    Math.abs(a.height - b.height) < BOX_EPSILON
  );
}

/** 印の形（点 1 つは円、2 つ以上は半径の太さの丸い線）。座標は写真の画面の矩形の中の px。 */
function HealShape(props: {
  points: readonly DevelopHealPoint[];
  box: HealRect;
  radius: number;
  color: string;
  opacity?: number;
  offset?: readonly [number, number];
}) {
  const [ox, oy] = props.offset ?? [0, 0];
  const coords = props.points.map(([x, y]) => [x * props.box.width + ox, y * props.box.height + oy] as const);
  if (coords.length === 0) return null;
  if (coords.length === 1) {
    return (
      <circle
        cx={coords[0][0]}
        cy={coords[0][1]}
        r={Math.max(0, props.radius)}
        style={{ fill: props.color, fillOpacity: props.opacity ?? 1 }}
      />
    );
  }
  return (
    <polyline
      points={coords.map(([x, y]) => `${x},${y}`).join(" ")}
      strokeWidth={Math.max(0, 2 * props.radius)}
      strokeLinecap="round"
      strokeLinejoin="round"
      style={{ fill: "none", stroke: props.color, strokeOpacity: props.opacity ?? 1 }}
    />
  );
}

/** ブラシの輪（外 = 半径、内 = ぼかしても全部埋まる半径。白の線と薄い黒の縁）。 */
function BrushCursor(props: { x: number; y: number; radius: number; core: number; testId: string }) {
  return (
    <g data-testid={props.testId} data-radius={props.radius.toFixed(2)}>
      <circle cx={props.x} cy={props.y} r={props.radius} style={{ fill: "none", stroke: "black", strokeOpacity: 0.45, strokeWidth: 3 }} />
      <circle cx={props.x} cy={props.y} r={props.radius} style={{ fill: "none", stroke: "white", strokeWidth: 1 }} />
      {props.core < props.radius - 1 ? (
        <circle
          cx={props.x}
          cy={props.y}
          r={props.core}
          strokeDasharray="3 3"
          style={{ fill: "none", stroke: "white", strokeOpacity: 0.8, strokeWidth: 1 }}
        />
      ) : null}
    </g>
  );
}

/**
 * 写真の上の修復のブラシ（niho-photo#44 後半）。`children` は写真の canvas（`targetRef`）で、面の 1 枚の表示の領域いっぱいに置いた
 * 入れ物の中で今までどおり中央に収める。修復の道具の間は面が幾何を全部外した画を描くので、canvas の画面の矩形の中の位置 = 印の座標
 * （0〜1）。半径の画面の px は `半径 × 矩形の長辺`。
 *
 * - 押してから離すまでが 1 つの印: なぞっている間は画面の中だけの赤い線（半径の太さ。履歴にもエンジンにも渡さない）。前の点から
 *   半径の 1/4 より近い点は足さず、`pointLimit` 個で打ち切る。離したら `onCommitStroke` を 1 回（動かさずに離したら点 1 つの印）。
 *   取り上げられた・中止されたら確定しない。写真の外で押しても始めない（なぞる途中で外へ出た点は端に収める）
 * - Shift+クリック: その位置に重なる印を選ぶ（無ければ選択を外す。新しい印は作らない）
 * - 印は道具の間だけ重ねる: 面がまだ描いていない印（埋まるのを待っている）は濃い赤、描いた画に入っている印は薄い赤（`showMarks` が
 *   false なら出さない）。選んでいる印は濃い輪郭
 * - 選んでいる「写す」の印には、写し元の形（点線）とつまみ。つまみをドラッグする・矢印キーで写し元を動かす（写真の外へは出さない）
 * - キーボード: この面にフォーカスして矢印でブラシを 1%（Shift で 10%）動かし、Enter / スペースでそこに点 1 つの印
 * - `disabled` の間は描かない（途中で押せなくなったら、その線は捨てる）
 */
export function PhotoEditingHealOverlay(props: {
  /** 写真の canvas（点はこの要素の画面の矩形で 0〜1 に直す） */
  targetRef: MutableRefObject<HTMLCanvasElement | null>;
  disabled: boolean;
  marks: readonly DevelopHealMarkView[];
  /** 面が最後に描いた画に入っている印の指紋 */
  paintedMarks: ReadonlySet<string>;
  selectedId: string | null;
  showMarks: boolean;
  /** 次に描く印の半径・ぼかし（ブラシの輪となぞる線の太さ） */
  brush: { radius: number; feather: number };
  /** 新しく描く印に使える点の数（0 なら新しい印は描けない。Shift+クリックの選択はできる） */
  pointLimit: number;
  onCommitStroke: (points: readonly DevelopHealPoint[], size: DevelopHealImageSize) => void;
  onSelect: (id: string | null) => void;
  onSourceChange: (id: string, source: DevelopHealPoint, phase: "drag" | "commit") => void;
  children: ReactNode;
}) {
  const rootRef = useRef<HTMLDivElement | null>(null);
  const strokeRef = useRef<Stroke | null>(null);
  const sourceDragRef = useRef<SourceDrag | null>(null);
  const [live, setLive] = useState<readonly DevelopHealPoint[] | null>(null);
  const [box, setBox] = useState<HealRect | null>(null);
  /** ポインタの位置（入れ物の中の px。外へ出たら null） */
  const [hover, setHover] = useState<{ x: number; y: number } | null>(null);
  /** キーボードのブラシの位置（0〜1）と、キーボードで動かしている間か */
  const [keyPoint, setKeyPoint] = useState<DevelopHealPoint>([0.5, 0.5]);
  const [keyboard, setKeyboard] = useState(false);
  const descriptionId = useId();
  const maskId = `heal-ring-${useId().replace(/[^a-zA-Z0-9_-]/g, "")}`;
  const interactive = !props.disabled;

  // なぞっている途中に押せなくなったら、その線は確定せずに捨てる
  useEffect(() => {
    if (interactive) return;
    setHover(null);
    strokeRef.current = null;
    sourceDragRef.current = null;
    setLive(null);
  }, [interactive]);

  // 写真の canvas の実測に合わせる（変わっていなければ state を替えない）
  const measure = useCallback(() => {
    const root = rootRef.current;
    const target = props.targetRef.current;
    if (!root || !target) return;
    const measured = target.getBoundingClientRect();
    const origin = root.getBoundingClientRect();
    const next: HealRect = {
      left: measured.left - origin.left - root.clientLeft,
      top: measured.top - origin.top - root.clientTop,
      width: measured.width,
      height: measured.height,
    };
    setBox((current) => (sameBox(current, next) ? current : next));
  }, [props.targetRef]);
  useLayoutEffect(() => {
    measure();
  });
  useEffect(() => {
    window.addEventListener("resize", measure);
    const observer = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(measure);
    const target = props.targetRef.current;
    if (observer && target) observer.observe(target);
    if (observer && rootRef.current) observer.observe(rootRef.current);
    return () => {
      observer?.disconnect();
      window.removeEventListener("resize", measure);
    };
  }, [measure, props.targetRef]);

  const photoRect = (): HealRect | null => {
    const rect = props.targetRef.current?.getBoundingClientRect();
    return rect && rect.width > 0 && rect.height > 0 ? rect : null;
  };
  const sizeOf = (rect: HealRect): DevelopHealImageSize => ({ width: rect.width, height: rect.height });

  const moveHover = (clientX: number, clientY: number) => {
    const origin = rootRef.current?.getBoundingClientRect();
    if (!origin) return;
    setHover({ x: clientX - origin.left, y: clientY - origin.top });
  };

  const start = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (!interactive || strokeRef.current || event.button !== 0) return;
    const rect = photoRect();
    const point = healPointFromClient(rect, event.clientX, event.clientY, { clampToPhoto: false });
    if (!rect || !point) return;
    event.preventDefault();
    setKeyboard(false);
    moveHover(event.clientX, event.clientY);
    if (event.shiftKey) {
      const tolerance = SELECT_TOLERANCE_PX / Math.max(rect.width, rect.height);
      props.onSelect(healMarkAt(props.marks, point, sizeOf(rect), tolerance));
      return;
    }
    if (props.pointLimit <= 0) return;
    capturePointer(event.currentTarget, event.pointerId);
    strokeRef.current = { pointerId: event.pointerId, points: [point], size: sizeOf(rect) };
    setLive([point]);
  };

  const move = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (!interactive) return;
    if (event.pointerType !== "touch") moveHover(event.clientX, event.clientY);
    setKeyboard(false);
    const stroke = strokeRef.current;
    if (!stroke || stroke.pointerId !== event.pointerId) return;
    const point = healPointFromClient(photoRect(), event.clientX, event.clientY, { clampToPhoto: true });
    if (!point) return;
    const next = appendHealStrokePoint(stroke.points, point, {
      radius: props.brush.radius,
      size: stroke.size,
      limit: props.pointLimit,
    });
    if (next === stroke.points) return;
    stroke.points = next;
    setLive(next);
  };

  const end = (event: ReactPointerEvent<HTMLDivElement>, commit: boolean) => {
    const stroke = strokeRef.current;
    if (!stroke || stroke.pointerId !== event.pointerId) return;
    strokeRef.current = null;
    setLive(null);
    if (commit) props.onCommitStroke(stroke.points, stroke.size);
  };

  const keyDown = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    // つまみの上のキーはつまみが扱う。⌘Z などの修飾キーつきは通す
    if (event.target !== event.currentTarget || !interactive) return;
    if (event.metaKey || event.ctrlKey || event.altKey) return;
    const moved = moveHealKeyCursor(keyPoint, event.key, event.shiftKey);
    if (moved) {
      event.preventDefault();
      setKeyPoint(moved);
      setKeyboard(true);
      return;
    }
    if (event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      setKeyboard(true);
      const rect = photoRect();
      if (rect && props.pointLimit > 0) props.onCommitStroke([keyPoint], sizeOf(rect));
    }
  };

  const selected = props.marks.find((mark) => mark.id === props.selectedId) ?? null;
  const radiusPx = box ? healRadiusPixels(props.brush.radius, box) : 0;
  const corePx = box ? healRadiusPixels(healCoreRadius(props.brush.radius, props.brush.feather), box) : 0;

  // 選んでいる「写す」の印の写し元（印の外接矩形の中心 + 写し元のずれ）
  const sourceMark =
    selected && selected.mode === "clone" && selected.source !== null && (props.showMarks || !props.paintedMarks.has(healMarkFingerprint(selected)))
      ? selected
      : null;
  const anchor = sourceMark ? healMarkBounds(sourceMark.points).center : null;
  const knob: DevelopHealPoint | null =
    sourceMark && anchor && sourceMark.source ? [anchor[0] + sourceMark.source[0], anchor[1] + sourceMark.source[1]] : null;

  const startSourceDrag = (event: ReactPointerEvent<HTMLButtonElement>) => {
    event.stopPropagation();
    if (!interactive || !sourceMark || !sourceMark.source || !knob || event.button !== 0) return;
    const point = healPointFromClient(photoRect(), event.clientX, event.clientY, { clampToPhoto: false });
    event.preventDefault();
    capturePointer(event.currentTarget, event.pointerId);
    sourceDragRef.current = {
      pointerId: event.pointerId,
      id: sourceMark.id,
      grab: point ? [point[0] - knob[0], point[1] - knob[1]] : [0, 0],
      source: sourceMark.source,
      moved: false,
    };
  };
  const moveSourceDrag = (event: ReactPointerEvent<HTMLButtonElement>) => {
    event.stopPropagation();
    const drag = sourceDragRef.current;
    if (!drag || drag.pointerId !== event.pointerId || !sourceMark || !anchor) return;
    const rect = photoRect();
    const point = healPointFromClient(rect, event.clientX, event.clientY, { clampToPhoto: true });
    if (!rect || !point) return;
    const next = clampHealSource(
      sourceMark.points,
      sourceMark.radius,
      [point[0] - drag.grab[0] - anchor[0], point[1] - drag.grab[1] - anchor[1]],
      sizeOf(rect),
    );
    if (next[0] === drag.source[0] && next[1] === drag.source[1]) return;
    drag.source = next;
    drag.moved = true;
    props.onSourceChange(drag.id, next, "drag");
  };
  const endSourceDrag = (event: ReactPointerEvent<HTMLButtonElement>) => {
    event.stopPropagation();
    const drag = sourceDragRef.current;
    if (!drag || drag.pointerId !== event.pointerId) return;
    sourceDragRef.current = null;
    // 動かしていれば、最後の位置で 1 単位に確定する（中止でも、描き直した位置のまま確定して画と履歴をそろえる）
    if (drag.moved) props.onSourceChange(drag.id, drag.source, "commit");
  };
  const sourceKeyDown = (event: ReactKeyboardEvent<HTMLButtonElement>) => {
    if (!interactive || !sourceMark || !sourceMark.source || event.metaKey || event.ctrlKey || event.altKey) return;
    const rect = photoRect();
    const delta = healKeyDelta(event.key, event.shiftKey);
    if (!delta || !rect) return;
    event.preventDefault();
    event.stopPropagation();
    const next = clampHealSource(
      sourceMark.points,
      sourceMark.radius,
      [sourceMark.source[0] + delta[0], sourceMark.source[1] + delta[1]],
      sizeOf(rect),
    );
    props.onSourceChange(sourceMark.id, next, "commit");
  };

  const cursor =
    interactive && box
      ? keyboard
        ? { x: keyPoint[0] * box.width, y: keyPoint[1] * box.height, testId: "photo-heal-key-cursor" }
        : hover
          ? { x: hover.x - box.left, y: hover.y - box.top, testId: "photo-heal-cursor" }
          : null
      : null;

  return (
    <div
      ref={rootRef}
      role="application"
      aria-label={PHOTO_EDITING_HEAL_BRUSH_AREA_LABEL}
      aria-describedby={descriptionId}
      aria-disabled={props.disabled ? true : undefined}
      tabIndex={0}
      data-testid="photo-heal-brush-area"
      className={cn(
        "absolute inset-0 flex touch-none select-none items-center justify-center focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-niho-accent-ink",
        interactive ? "cursor-none" : null,
      )}
      onPointerDown={start}
      onPointerMove={move}
      onPointerUp={(event) => end(event, true)}
      onPointerCancel={(event) => end(event, false)}
      onLostPointerCapture={(event) => end(event, false)}
      onPointerLeave={() => {
        if (!strokeRef.current) setHover(null);
      }}
      onKeyDown={keyDown}
      onBlur={() => setKeyboard(false)}
    >
      {props.children}
      <span id={descriptionId} className="sr-only">
        {PHOTO_EDITING_HEAL_BRUSH_AREA_DESCRIPTION}
      </span>
      {box ? (
        <svg
          aria-hidden
          data-testid="photo-heal-marks"
          className="pointer-events-none absolute overflow-visible"
          style={{ left: box.left, top: box.top, width: box.width, height: box.height }}
          width={box.width}
          height={box.height}
          viewBox={`0 0 ${box.width} ${box.height}`}
        >
          {props.marks.map((mark, index) => {
            const painted = props.paintedMarks.has(healMarkFingerprint(mark));
            if (painted && !props.showMarks) return null;
            const markRadius = healRadiusPixels(mark.radius, box);
            const isSelected = mark.id === props.selectedId;
            return (
              <g
                key={mark.id}
                data-heal-mark={mark.id}
                data-heal-state={painted ? "painted" : "pending"}
                data-selected={isSelected ? "true" : undefined}
              >
                <HealShape
                  points={mark.points}
                  box={box}
                  radius={markRadius}
                  color={MARK_COLOR}
                  opacity={painted ? PAINTED_OPACITY : PENDING_OPACITY}
                />
                {isSelected ? (
                  <>
                    <mask
                      // 印の id は外から来る文字列なので、url(#…) には番号を使う
                      id={`${maskId}-${index}`}
                      maskUnits="userSpaceOnUse"
                      x={-box.width}
                      y={-box.height}
                      width={box.width * 3}
                      height={box.height * 3}
                    >
                      <HealShape points={mark.points} box={box} radius={markRadius + SELECTED_RING_PX} color="white" />
                      <HealShape points={mark.points} box={box} radius={markRadius} color="black" />
                    </mask>
                    <rect
                      x={-box.width}
                      y={-box.height}
                      width={box.width * 3}
                      height={box.height * 3}
                      mask={`url(#${maskId}-${index})`}
                      style={{ fill: MARK_COLOR }}
                    />
                  </>
                ) : null}
              </g>
            );
          })}
          {sourceMark && anchor && knob ? (
            <g data-testid="photo-heal-source">
              <line
                x1={anchor[0] * box.width}
                y1={anchor[1] * box.height}
                x2={knob[0] * box.width}
                y2={knob[1] * box.height}
                strokeDasharray="4 3"
                style={{ stroke: "white", strokeOpacity: 0.9, strokeWidth: 1 }}
              />
              <HealShape
                points={sourceMark.points}
                box={box}
                radius={healRadiusPixels(sourceMark.radius, box)}
                color="white"
                opacity={0.25}
                offset={[(knob[0] - anchor[0]) * box.width, (knob[1] - anchor[1]) * box.height]}
              />
            </g>
          ) : null}
          {live ? (
            <g data-testid="photo-heal-live">
              <HealShape points={live} box={box} radius={radiusPx} color={MARK_COLOR} opacity={PENDING_OPACITY} />
            </g>
          ) : null}
          {cursor ? <BrushCursor x={cursor.x} y={cursor.y} radius={radiusPx} core={corePx} testId={cursor.testId} /> : null}
        </svg>
      ) : null}
      {box && knob ? (
        <button
          type="button"
          aria-label={PHOTO_EDITING_HEAL_SOURCE_LABEL}
          disabled={props.disabled}
          data-testid="photo-heal-source-handle"
          className="absolute flex h-11 w-11 -translate-x-1/2 -translate-y-1/2 cursor-move touch-none items-center justify-center rounded-full focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-niho-accent-ink"
          style={{ left: box.left + knob[0] * box.width, top: box.top + knob[1] * box.height }}
          onPointerDown={startSourceDrag}
          onPointerMove={moveSourceDrag}
          onPointerUp={endSourceDrag}
          onPointerCancel={endSourceDrag}
          onLostPointerCapture={endSourceDrag}
          onKeyDown={sourceKeyDown}
        >
          <span aria-hidden className="block h-3.5 w-3.5 rounded-full border-2 border-white bg-niho-text/60 shadow-[0_0_0_1px_rgba(0,0,0,0.45)]" />
        </button>
      ) : null}
    </div>
  );
}
