"use client";

import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
  type PointerEvent as ReactPointerEvent,
  type RefObject,
} from "react";

import type { DevelopMaskPlane } from "../develop-engine/develop-engine-client";
import type { DevelopMask } from "../develop-engine/develop-masks";
import {
  PHOTO_EDITING_MASK_HANDLE_LABELS,
  PHOTO_EDITING_MASK_OVERLAY_AREA_LABEL,
  photoEditingMaskLabel,
  photoEditingMaskSelectLabel,
} from "../photo-editing-copy";
import {
  dragPhotoEditingMaskHandle,
  photoEditingMaskHandles,
  type PhotoEditingMaskFrame,
  type PhotoEditingMaskHandle,
  type Vec2,
} from "../photo-editing-masks";
import { isPhotoEditingTypingTarget } from "../use-photo-editing-shortcuts";
import { cn } from "niho-ui/cn";

import { fillPhotoEditingMaskOverlay, useBrowserPhotoMaskPlane, type BrowserPhotoMaskTool } from "./use-browser-photo-masks";

type OverlayBox = { left: number; top: number; width: number; height: number };

/** 位置の誤差（px）。これ以下の違いでは測り直した値に置き換えない（置き換えると再描画が止まらない） */
const BOX_EPSILON = 0.5;
/** 回転のつまみを、上の端から画面で離す距離（px） */
const ROTATE_HANDLE_OFFSET = 28;
/** 矢印キーの 1 回の動き（見えている短い辺に対する割合。⇧ で大きく） */
const KEY_STEP = 0.01;
const KEY_STEP_LARGE = 0.05;

const ARROW_DIRECTIONS: Readonly<Record<string, Vec2>> = {
  ArrowLeft: [-1, 0],
  ArrowRight: [1, 0],
  ArrowUp: [0, -1],
  ArrowDown: [0, 1],
};

/** つまみ（押せる範囲 28px の中心が形の点。見た目は小さな丸。NIHO photo の密な画面の最小 24px を満たす）。 */
const HANDLE_CLASS_NAME =
  "absolute flex h-7 w-7 -translate-x-1/2 -translate-y-1/2 touch-none items-center justify-center rounded-full focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-niho-accent-ink enabled:cursor-grab enabled:active:cursor-grabbing disabled:cursor-default";
const HANDLE_MARK_CLASS_NAME =
  "pointer-events-none block rounded-full border border-niho-text/60 bg-niho-surface shadow-[0_0_0_1px_rgba(0,0,0,0.25)]";
/** 選んでいないマスクの印（押すと選ぶ。押せる範囲 24px） */
const PIN_CLASS_NAME =
  "absolute flex h-6 w-6 -translate-x-1/2 -translate-y-1/2 touch-none items-center justify-center rounded-full focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-niho-accent-ink";

function sameBox(a: OverlayBox | null, b: OverlayBox): boolean {
  return (
    a !== null &&
    Math.abs(a.left - b.left) < BOX_EPSILON &&
    Math.abs(a.top - b.top) < BOX_EPSILON &&
    Math.abs(a.width - b.width) < BOX_EPSILON &&
    Math.abs(a.height - b.height) < BOX_EPSILON
  );
}

/** 写真の canvas の、重ねる入れ物（親）の中での位置と大きさ（クリップ領域の印と同じ測り方）。 */
function useTargetBox(targetRef: RefObject<HTMLCanvasElement | null>, elementRef: RefObject<HTMLElement | null>) {
  const [box, setBox] = useState<OverlayBox | null>(null);
  const measure = useCallback(() => {
    const element = elementRef.current;
    const target = targetRef.current;
    const parent = element?.parentElement;
    if (!element || !target || !parent) return;
    const measured = target.getBoundingClientRect();
    const origin = parent.getBoundingClientRect();
    const next: OverlayBox = {
      left: measured.left - origin.left - parent.clientLeft,
      top: measured.top - origin.top - parent.clientTop,
      width: measured.width,
      height: measured.height,
    };
    setBox((current) => (sameBox(current, next) ? current : next));
  }, [elementRef, targetRef]);
  useLayoutEffect(() => {
    measure();
  });
  useEffect(() => {
    window.addEventListener("resize", measure);
    const observer = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(measure);
    const target = targetRef.current;
    const parent = elementRef.current?.parentElement;
    if (observer && target) observer.observe(target);
    if (observer && parent) observer.observe(parent);
    return () => {
      observer?.disconnect();
      window.removeEventListener("resize", measure);
    };
  }, [elementRef, measure, targetRef]);
  return box;
}

/** 動かしている途中（どのマスクのどのつまみを、どの形から）。 */
type Gesture = {
  kind: "pointer" | "keyboard";
  pointerId: number;
  maskId: string;
  handle: PhotoEditingMaskHandle;
  start: DevelopMask;
  /** 動かし始めのつまみの出力の上の位置 */
  from: Vec2;
  /** ポインタの動かし始め（client px）か、矢印キーで足した出力の上の動き */
  startClient: Vec2;
  offset: Vec2;
};

type HandleView = { handle: PhotoEditingMaskHandle; left: number; top: number };

/** 画面の px でのつまみの位置（回転のつまみは上の端の外に足す）。 */
function handleViews(mask: DevelopMask, frame: PhotoEditingMaskFrame | null, box: OverlayBox): HandleView[] | null {
  const points = photoEditingMaskHandles(mask, frame);
  if (!points) return null;
  const views = points.map((point) => ({ handle: point.handle, left: point.x * box.width, top: point.y * box.height }));
  if (mask.kind === "radial") {
    const center = views.find((view) => view.handle === "center");
    const top = views.find((view) => view.handle === "top");
    if (center && top) {
      const dx = top.left - center.left;
      const dy = top.top - center.top;
      const length = Math.hypot(dx, dy);
      if (length > 1e-6) {
        views.push({ handle: "rotate", left: top.left + (dx / length) * ROTATE_HANDLE_OFFSET, top: top.top + (dy / length) * ROTATE_HANDLE_OFFSET });
      }
    }
  }
  return views;
}

function viewOf(views: HandleView[], handle: PhotoEditingMaskHandle): HandleView | undefined {
  return views.find((view) => view.handle === handle);
}

/** 選んでいるマスクの形の線（SVG。画面の px）。線形は始点・中央・終点の 3 本（向きに直角）、円形は縁の楕円と、ぼかしの内側の楕円。 */
function MaskShape(props: { mask: DevelopMask; views: HandleView[]; box: OverlayBox }) {
  const { mask, views, box } = props;
  if (mask.kind === "linear") {
    const zero = viewOf(views, "zero");
    const full = viewOf(views, "full");
    const center = viewOf(views, "center");
    if (!zero || !full || !center) return null;
    const dx = full.left - zero.left;
    const dy = full.top - zero.top;
    const length = Math.hypot(dx, dy);
    if (length < 1e-6) return null;
    const span = box.width + box.height;
    const nx = (-dy / length) * span;
    const ny = (dx / length) * span;
    const line = (at: HandleView, dashed: boolean, key: string) => (
      <g key={key}>
        <line x1={at.left - nx} y1={at.top - ny} x2={at.left + nx} y2={at.top + ny} stroke="rgba(0,0,0,0.35)" strokeWidth={3} />
        <line
          x1={at.left - nx}
          y1={at.top - ny}
          x2={at.left + nx}
          y2={at.top + ny}
          stroke="white"
          strokeWidth={1.5}
          strokeDasharray={dashed ? "6 5" : undefined}
        />
      </g>
    );
    return (
      <g data-mask-shape="linear">
        {line(full, false, "full")}
        {line(center, true, "center")}
        {line(zero, false, "zero")}
      </g>
    );
  }
  if (mask.kind !== "radial") return null;
  const center = viewOf(views, "center");
  const right = viewOf(views, "right");
  const bottom = viewOf(views, "bottom");
  if (!center || !right || !bottom) return null;
  const rx = Math.hypot(right.left - center.left, right.top - center.top);
  const ry = Math.hypot(bottom.left - center.left, bottom.top - center.top);
  const rotation = (Math.atan2(right.top - center.top, right.left - center.left) * 180) / Math.PI;
  const transform = `rotate(${rotation} ${center.left} ${center.top})`;
  const inner = 1 - mask.feather / 100;
  const rotate = viewOf(views, "rotate");
  const top = viewOf(views, "top");
  return (
    <g data-mask-shape="radial">
      <ellipse cx={center.left} cy={center.top} rx={rx} ry={ry} transform={transform} fill="none" stroke="rgba(0,0,0,0.35)" strokeWidth={3} />
      <ellipse
        cx={center.left}
        cy={center.top}
        rx={rx}
        ry={ry}
        transform={transform}
        fill="none"
        stroke="white"
        strokeWidth={1.5}
      />
      {inner > 0.02 && inner < 0.999 ? (
        <ellipse
          cx={center.left}
          cy={center.top}
          rx={rx * inner}
          ry={ry * inner}
          transform={transform}
          fill="none"
          stroke="white"
          strokeOpacity={0.7}
          strokeWidth={1}
          strokeDasharray="4 4"
        />
      ) : null}
      {rotate && top ? (
        <line x1={top.left} y1={top.top} x2={rotate.left} y2={rotate.top} stroke="white" strokeOpacity={0.8} strokeWidth={1} />
      ) : null}
    </g>
  );
}

/** 選んでいるマスクの範囲の赤い重ね（面の画素をそのまま canvas に描き、写真の大きさに引き伸ばす）。 */
function MaskPlaneCanvas(props: { plane: DevelopMaskPlane }) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const { plane } = props;
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const context = canvas.getContext("2d");
    if (!context) return;
    if (canvas.width !== plane.width) canvas.width = plane.width;
    if (canvas.height !== plane.height) canvas.height = plane.height;
    const image = context.createImageData(plane.width, plane.height);
    fillPhotoEditingMaskOverlay(image.data, plane.data);
    context.putImageData(image, 0, 0);
  }, [plane]);
  return (
    <canvas
      ref={canvasRef}
      aria-hidden
      data-testid="photo-mask-plane"
      className="pointer-events-none absolute inset-0 h-full w-full"
    />
  );
}

/**
 * 写真の上のマスクの操作（部分補正。M3 #67）。写真の canvas（`targetRef`）と同じ位置・大きさに重ね、canvas は動かさない
 * （クリップ領域の印と同じ測り方）。
 *
 * - 選んでいるマスク: 線形は始点（効果 100%）・中央（全体を動かす）・終点（効果 0%）の 3 本の線とつまみ、円形は縁の楕円・
 *   ぼかしの内側の楕円と、中心・軸の 4 つの端・回転のつまみ。つまみは本物のボタン（読み上げ名・Tab・focus の環）
 * - 選んでいないマスク: 押すと選ぶ小さな印だけ（形の線は選んだマスクだけに引く）
 * - 動かす: pointer capture・`touch-action: none`。動かしている間は手元の形を `onShapeChange(形, "drag")` で渡し（画は速い描き方）、
 *   離したら 1 回 `"commit"`（取り消しの 1 単位）。止められたら動かし始めの形に戻す
 * - キーボード: つまみの上の矢印で見えている短い辺の 1%（⇧ で 5%）動かし、キーを離す・フォーカスが外れると確定。O で範囲の
 *   重ね表示を切り替える（文字の入力欄の上では効かない）。⌫ / Delete・Esc は写真の編集のキーとして面が扱う
 * - 写真の何も無い所を押すと選択を外す。描けない幾何の間は何も出さない
 */
export function PhotoEditingMaskOverlay(props: {
  targetRef: RefObject<HTMLCanvasElement | null>;
  masks: readonly DevelopMask[];
  selectedId: string | null;
  frame: PhotoEditingMaskFrame | null;
  disabled: boolean;
  /** 選んでいるマスクの面（赤く重ねる。重ねないときは null） */
  plane: DevelopMaskPlane | null;
  onSelect: (id: string | null) => void;
  onShapeChange: (mask: DevelopMask, phase: "drag" | "commit") => void;
  onDraggingChange: (dragging: boolean) => void;
  onToggleOverlay: () => void;
}) {
  const { masks, frame, disabled } = props;
  const rootRef = useRef<HTMLDivElement | null>(null);
  const box = useTargetBox(props.targetRef, rootRef);
  const gestureRef = useRef<Gesture | null>(null);
  const [draft, setDraft] = useState<DevelopMask | null>(null);
  const draftRef = useRef<DevelopMask | null>(null);
  const callbacksRef = useRef(props);
  callbacksRef.current = props;

  const setDraftMask = (next: DevelopMask | null) => {
    draftRef.current = next;
    setDraft(next);
  };

  // O: 範囲の重ね表示（つまみ・写真の上・何も選んでいないときに。文字の入力・修飾キー・ほかが使ったキーは扱わない）
  useEffect(() => {
    const handleKeyDown = (event: globalThis.KeyboardEvent) => {
      if (event.defaultPrevented || event.isComposing || event.metaKey || event.ctrlKey || event.altKey) return;
      if (event.key !== "o" && event.key !== "O") return;
      if (isPhotoEditingTypingTarget(event.target)) return;
      if (event.target instanceof Element && event.target.closest('[role="dialog"], [role="menu"]')) return;
      event.preventDefault();
      callbacksRef.current.onToggleOverlay();
    };
    document.addEventListener("keydown", handleKeyDown);
    return () => document.removeEventListener("keydown", handleKeyDown);
  }, []);

  const selectedMask = masks.find((mask) => mask.id === props.selectedId) ?? null;
  /** 動かしている間は手元の形（設定の書き換えを待たずにつまみが指に付いてくる） */
  const shown = (mask: DevelopMask): DevelopMask => (draft && draft.id === mask.id ? draft : mask);

  const finish = (commit: boolean) => {
    const gesture = gestureRef.current;
    if (!gesture) return;
    gestureRef.current = null;
    const current = draftRef.current;
    setDraftMask(null);
    callbacksRef.current.onDraggingChange(false);
    // 止められたら動かし始めの形に戻す（同じ形の確定は履歴を積まない）
    callbacksRef.current.onShapeChange(commit && current ? current : gesture.start, "commit");
  };

  // 動かしている途中にマスクが無くなった（取り消し・別の端末の補正）ら、途中の形を捨てる
  useEffect(() => {
    const gesture = gestureRef.current;
    if (gesture && !masks.some((mask) => mask.id === gesture.maskId)) {
      gestureRef.current = null;
      setDraftMask(null);
      callbacksRef.current.onDraggingChange(false);
    }
  }, [masks]);

  const moveTo = (gesture: Gesture, offset: Vec2) => {
    gesture.offset = offset;
    const to: Vec2 = [gesture.from[0] + offset[0], gesture.from[1] + offset[1]];
    const next = dragPhotoEditingMaskHandle(gesture.start, gesture.handle, frame, gesture.from, to);
    if (!next) return;
    setDraftMask(next);
    callbacksRef.current.onShapeChange(next, "drag");
  };

  const startPointer = (event: ReactPointerEvent<HTMLButtonElement>, mask: DevelopMask, view: HandleView) => {
    if (disabled || !box || gestureRef.current || event.button !== 0) return;
    event.stopPropagation();
    event.currentTarget.setPointerCapture?.(event.pointerId);
    gestureRef.current = {
      kind: "pointer",
      pointerId: event.pointerId,
      maskId: mask.id,
      handle: view.handle,
      start: mask,
      from: [view.left / box.width, view.top / box.height],
      startClient: [event.clientX, event.clientY],
      offset: [0, 0],
    };
    setDraftMask(mask);
    callbacksRef.current.onDraggingChange(true);
  };

  const movePointer = (event: ReactPointerEvent<HTMLButtonElement>) => {
    const gesture = gestureRef.current;
    if (!gesture || gesture.kind !== "pointer" || gesture.pointerId !== event.pointerId || !box) return;
    moveTo(gesture, [(event.clientX - gesture.startClient[0]) / box.width, (event.clientY - gesture.startClient[1]) / box.height]);
  };

  const endPointer = (event: ReactPointerEvent<HTMLButtonElement>, commit: boolean) => {
    const gesture = gestureRef.current;
    if (!gesture || gesture.kind !== "pointer" || gesture.pointerId !== event.pointerId) return;
    finish(commit);
  };

  const nudge = (event: ReactKeyboardEvent<HTMLButtonElement>, mask: DevelopMask, view: HandleView) => {
    if (event.altKey || event.metaKey || event.ctrlKey) return;
    const direction = ARROW_DIRECTIONS[event.key];
    if (!direction) return;
    // 矢印はつまみのもの（写真の切り替えなど、面のキーに渡さない）
    event.preventDefault();
    event.stopPropagation();
    if (disabled || !box) return;
    let gesture = gestureRef.current;
    if (gesture && (gesture.kind !== "keyboard" || gesture.maskId !== mask.id || gesture.handle !== view.handle)) return;
    if (!gesture) {
      gesture = {
        kind: "keyboard",
        pointerId: -1,
        maskId: mask.id,
        handle: view.handle,
        start: mask,
        from: [view.left / box.width, view.top / box.height],
        startClient: [0, 0],
        offset: [0, 0],
      };
      gestureRef.current = gesture;
      setDraftMask(mask);
      callbacksRef.current.onDraggingChange(true);
    }
    const step = (event.shiftKey ? KEY_STEP_LARGE : KEY_STEP) * Math.min(box.width, box.height);
    moveTo(gesture, [gesture.offset[0] + (direction[0] * step) / box.width, gesture.offset[1] + (direction[1] * step) / box.height]);
  };

  const finishKeyboard = () => {
    if (gestureRef.current?.kind === "keyboard") finish(true);
  };

  const ready = box !== null && box.width > 0 && box.height > 0 && frame !== null;
  return (
    <div
      ref={rootRef}
      role="group"
      aria-label={PHOTO_EDITING_MASK_OVERLAY_AREA_LABEL}
      data-testid="photo-mask-overlay"
      className="absolute touch-none select-none"
      style={
        ready
          ? { left: box.left, top: box.top, width: box.width, height: box.height }
          : { left: 0, top: 0, width: 0, height: 0, visibility: "hidden" }
      }
    >
      {props.plane ? <MaskPlaneCanvas plane={props.plane} /> : null}
      {/* 写真の何も無い所: 押すと選択を外す */}
      <div
        aria-hidden
        data-testid="photo-mask-backdrop"
        className="absolute inset-0"
        onPointerDown={(event) => {
          if (event.button !== 0) return;
          props.onSelect(null);
        }}
      />
      {ready ? (
        <>
          <svg
            aria-hidden
            className="pointer-events-none absolute inset-0 overflow-hidden"
            width={box.width}
            height={box.height}
            viewBox={`0 0 ${box.width} ${box.height}`}
          >
            {selectedMask
              ? (() => {
                  const current = shown(selectedMask);
                  const views = handleViews(current, frame, box);
                  return views ? <MaskShape mask={current} views={views} box={box} /> : null;
                })()
              : null}
          </svg>
          {masks.map((mask, index) => {
            if (mask.id === props.selectedId) return null;
            const views = handleViews(mask, frame, box);
            const center = views ? viewOf(views, "center") : undefined;
            if (!center) return null;
            const name = photoEditingMaskLabel(mask.kind, index);
            return (
              <button
                key={mask.id}
                type="button"
                aria-label={photoEditingMaskSelectLabel(name)}
                data-mask-pin={mask.id}
                className={PIN_CLASS_NAME}
                style={{ left: center.left, top: center.top }}
                onPointerDown={(event) => event.stopPropagation()}
                onClick={() => props.onSelect(mask.id)}
              >
                <span
                  aria-hidden
                  className={cn(HANDLE_MARK_CLASS_NAME, "h-2.5 w-2.5", mask.enabled ? "bg-niho-surface" : "bg-niho-text-muted")}
                />
              </button>
            );
          })}
          {selectedMask
            ? (() => {
                const current = shown(selectedMask);
                const views = handleViews(current, frame, box);
                if (!views) return null;
                const labels =
                  current.kind === "linear" ? PHOTO_EDITING_MASK_HANDLE_LABELS.linear : PHOTO_EDITING_MASK_HANDLE_LABELS.radial;
                // Tab の順: 中心（全体を動かす）→ 形の端 → 回転
                const ordered = [...views].sort((a, b) => (a.handle === "center" ? -1 : b.handle === "center" ? 1 : 0));
                return ordered.map((view) => (
                  <button
                    key={`${selectedMask.id}-${view.handle}`}
                    type="button"
                    aria-label={(labels as Record<string, string>)[view.handle] ?? view.handle}
                    disabled={disabled}
                    data-mask-handle={view.handle}
                    className={HANDLE_CLASS_NAME}
                    style={{ left: view.left, top: view.top }}
                    onPointerDown={(event) => startPointer(event, selectedMask, view)}
                    onPointerMove={movePointer}
                    onPointerUp={(event) => endPointer(event, true)}
                    onPointerCancel={(event) => endPointer(event, false)}
                    onLostPointerCapture={(event) => endPointer(event, false)}
                    onKeyDown={(event) => nudge(event, selectedMask, view)}
                    onKeyUp={(event) => {
                      if (ARROW_DIRECTIONS[event.key]) finishKeyboard();
                    }}
                    onBlur={finishKeyboard}
                  >
                    <span
                      aria-hidden
                      className={cn(
                        HANDLE_MARK_CLASS_NAME,
                        view.handle === "center" ? "h-3.5 w-3.5 bg-niho-accent-ink" : view.handle === "rotate" ? "h-2.5 w-2.5" : "h-3 w-3",
                      )}
                    />
                  </button>
                ));
              })()
            : null}
        </>
      ) : null}
    </div>
  );
}

/**
 * 写真の面に置くマスクの操作（`BrowserPhotoMaskTool` の値をつなぎ、選んでいるマスクの面を取りに行く）。範囲の重ね表示は O・右パネルの
 * 切り替えで出し、つまみを動かしている間も出す。
 */
export function BrowserPhotoEditingMaskLayer(props: { tool: BrowserPhotoMaskTool; targetRef: RefObject<HTMLCanvasElement | null> }) {
  const { tool } = props;
  const plane = useBrowserPhotoMaskPlane({
    engineRef: tool.engineRef,
    photoKey: tool.photoKey,
    settings: tool.settings,
    mask: tool.selected,
    enabled: tool.overlayVisible || tool.shapeDragging,
    dragging: tool.shapeDragging,
  });
  return (
    <PhotoEditingMaskOverlay
      targetRef={props.targetRef}
      masks={tool.masks}
      selectedId={tool.selected?.id ?? null}
      frame={tool.frame}
      disabled={tool.disabled}
      plane={plane}
      onSelect={tool.select}
      onShapeChange={tool.changeShape}
      onDraggingChange={tool.setShapeDragging}
      onToggleOverlay={() => tool.setOverlayVisible((visible) => !visible)}
    />
  );
}
