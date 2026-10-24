"use client";

import { useEffect, useLayoutEffect, useRef, useState, type PointerEvent as ReactPointerEvent, type RefObject } from "react";

import type { DevelopMaskPlane } from "../develop-engine/develop-engine-client";
import { isActiveDevelopMask } from "../develop-engine/develop-masks";
import { PHOTO_EDITING_MASK_BRUSH_AREA_LABEL } from "../photo-editing-copy";
import {
  clampPhotoEditingMaskBrushSize,
  photoEditingMaskBrushFalloff,
  photoEditingMaskBrushPath,
  photoEditingMaskBrushSpacing,
} from "../photo-editing-mask-brush";
import type { Vec2 } from "../photo-editing-masks";
import { isPhotoEditingTypingTarget } from "../use-photo-editing-shortcuts";
import { cn } from "niho-ui/cn";

import type { BrowserPhotoMaskBrush, PhotoEditingMaskStrokeHandle } from "./use-browser-photo-mask-brush";
import { fillPhotoEditingMaskOverlay } from "./use-browser-photo-masks";
import { usePhotoEditingCoarsePointer } from "./use-photo-editing-coarse-pointer";
import { usePhotoEditingTargetBox } from "./use-photo-editing-target-box";

/** 塗っている途中の dab の赤（重ね表示と同じ色。重ね表示は値 255 で不透明度 0.5） */
const LIVE_RED = "255, 48, 48";
const LIVE_RED_MAX_ALPHA = 0.5;
/** 塗った後、赤い面を新しい面に替えるまで出し続ける最長の時間（ms。面が替わらなかったとき） */
const HOLD_AFTER_SAVE_MS = 4000;
/** dab の縁の段数（滑らかな縁を放射グラデーションで近づける） */
const GRADIENT_STOPS = 8;
/** 指で大きさを変えたとき、写真の中央に筆の輪の見本を出す時間（ms。指の下の輪は指に隠れるので出さない） */
const SIZE_PREVIEW_MS = 900;

type Gesture = {
  pointerId: number;
  /** 指で始めたストローク（別の指が触れたら捨てる） */
  touch: boolean;
  stroke: PhotoEditingMaskStrokeHandle;
  /** 前の dab の位置（写真の canvas の画面の px） */
  last: Vec2;
  carry: number;
  size: number;
  feather: number;
  flow: number;
};

type Cursor = { left: number; top: number };

/** 赤い面（重ね表示の面）を canvas に描く（面が無ければ空にする）。 */
function paintPlane(canvas: HTMLCanvasElement, plane: DevelopMaskPlane | null, fallback: { width: number; height: number }) {
  const context = canvas.getContext("2d");
  if (!context) return;
  const width = plane?.width ?? Math.max(1, Math.round(fallback.width));
  const height = plane?.height ?? Math.max(1, Math.round(fallback.height));
  if (canvas.width !== width) canvas.width = width;
  if (canvas.height !== height) canvas.height = height;
  context.globalCompositeOperation = "source-over";
  context.clearRect(0, 0, width, height);
  if (!plane) return;
  const image = context.createImageData(plane.width, plane.height);
  fillPhotoEditingMaskOverlay(image.data, plane.data);
  context.putImageData(image, 0, 0);
}

/**
 * 塗っている途中の dab を canvas に描く（出力の位置 0〜1・半径は canvas の短い辺 × 大きさ%）。塗りは赤を重ね、消しゴムは
 * `destination-out` で赤を減らす（どちらも流量 × 滑らかな縁）。描くのは見た目だけで、面の値は手元の値（面の画素）に重ねる。
 */
function paintLiveDab(
  canvas: HTMLCanvasElement,
  output: Vec2,
  brush: { size: number; feather: number; flow: number; erase: boolean; invert: boolean },
) {
  const context = canvas.getContext("2d");
  if (!context) return;
  // 反転したマスクの赤は「1 − 面の値」: 塗る（面の値が増える）と赤が減り、消す（面の値が減る）と赤が増える
  const removesRed = brush.erase !== brush.invert;
  const radius = (clampPhotoEditingMaskBrushSize(brush.size) / 100) * Math.min(canvas.width, canvas.height);
  if (!(radius > 0)) return;
  const x = output[0] * canvas.width;
  const y = output[1] * canvas.height;
  const flow = Math.min(1, Math.max(0, brush.flow / 100));
  const gradient = context.createRadialGradient(x, y, 0, x, y, radius);
  for (let index = 0; index <= GRADIENT_STOPS; index += 1) {
    const t = index / GRADIENT_STOPS;
    const a = flow * photoEditingMaskBrushFalloff(t, brush.feather, radius);
    gradient.addColorStop(t, removesRed ? `rgba(0, 0, 0, ${a})` : `rgba(${LIVE_RED}, ${a * LIVE_RED_MAX_ALPHA})`);
  }
  context.globalCompositeOperation = removesRed ? "destination-out" : "source-over";
  context.fillStyle = gradient;
  context.beginPath();
  context.arc(x, y, radius, 0, Math.PI * 2);
  context.fill();
  context.globalCompositeOperation = "source-over";
}

/**
 * 写真の上のブラシの面（部分補正のブラシ。M4 #68。PC の面とスマホの編集の層〔niho-photo#93〕）。写真の canvas（`targetRef`）と同じ位置・大きさに重ねる。
 *
 * - 押してから離すまでが 1 ストローク（pointer capture・`touch-action: none`）。ポインタの道に沿って、半径の 25% ごとに dab を置く
 *   （面の値はフックが面の画素に重ね、見た目はこの canvas に赤で描く。エンジンでは描かない）。離したら確定に回す（取り消しの
 *   1 単位）。止められた・取り上げられたら捨てる
 * - 消しゴムは右パネルの切り替え・E、または ⌥ を押しながら塗る。`[` `]` で大きさを変える（文字の入力欄の上・修飾キーでは効かない）
 * - 筆の大きさの輪（直径 = 2 × 見えている短い辺 × 大きさ%）がポインタに付いてくる（消しゴムは破線）
 * - 赤い面は、O で重ねている・マスクの補正がまだ何も無い・塗っている途中と、塗った後に新しい面が届くまで出す
 * - 指（niho-photo#93）: 指 1 本で塗る。2 本目の指が写真のどこかに触れたら、塗っている途中のストロークを確定せずに捨て、2 本目の
 *   指では塗らない（写真の面の指の操作がピンチで拡大・送る。この面はピンチにだけ数える印を持ち、指の押下を止めない）。指の下の
 *   輪は指に隠れるので出さず、塗っている途中の赤で見せる。指で大きさを変えたら、写真の中央に輪の見本を少しの間出す。マウス・ペンは
 *   今までどおり（押下を写真の面へ渡さない）
 */
export function PhotoEditingMaskBrushOverlay(props: {
  targetRef: RefObject<HTMLCanvasElement | null>;
  brush: BrowserPhotoMaskBrush;
  plane: DevelopMaskPlane | null;
  /** O の重ね表示 */
  overlayVisible: boolean;
}) {
  const { brush, plane } = props;
  const rootRef = useRef<HTMLDivElement | null>(null);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const box = usePhotoEditingTargetBox(props.targetRef, rootRef);
  const gestureRef = useRef<Gesture | null>(null);
  const [stroking, setStroking] = useState(false);
  const [hold, setHold] = useState(false);
  const [cursor, setCursor] = useState<Cursor | null>(null);
  const [altHeld, setAltHeld] = useState(false);
  /** 今どこかに触れている指（2 本目の指は塗らない） */
  const touchesRef = useRef(new Set<number>());
  const coarse = usePhotoEditingCoarsePointer();
  const [sizePreview, setSizePreview] = useState(false);
  const brushRef = useRef(brush);
  brushRef.current = brush;
  const savingRef = useRef(brush.saving);
  savingRef.current = brush.saving;
  const interactive = brush.canPaint;
  const erasing = brush.brush.erase || altHeld;

  const boxWidth = box?.width ?? 0;
  const boxHeight = box?.height ?? 0;
  /** 赤い面を描き直す（塗っている途中・確定を待っている間は、塗った見た目を残す） */
  const repaint = () => {
    const canvas = canvasRef.current;
    if (!canvas || gestureRef.current || savingRef.current) return;
    paintPlane(canvas, plane, { width: boxWidth, height: boxHeight });
  };
  const repaintRef = useRef(repaint);
  repaintRef.current = repaint;

  // 新しい面が届いた・大きさが変わった: 描き直す（確定し終えた後なら、塗った後の赤を新しい面に替える）
  useLayoutEffect(() => {
    if (!savingRef.current) setHold(false);
    repaintRef.current();
  }, [plane, boxWidth, boxHeight]);
  // 確定し終えたのに面が替わらない（捨てた・失敗した）: しばらくしたら今の面に戻す
  useEffect(() => {
    if (brush.saving || !hold) return;
    const timer = setTimeout(() => {
      setHold(false);
      repaintRef.current();
    }, HOLD_AFTER_SAVE_MS);
    return () => clearTimeout(timer);
  }, [brush.saving, hold]);

  // 塗れなくなった（読み直し・押せない・道具を離れた）: 塗っている途中のストロークを捨てて描き直す
  useEffect(() => {
    if (interactive) return;
    const gesture = gestureRef.current;
    if (!gesture) return;
    gestureRef.current = null;
    gesture.stroke.finish(false);
    setStroking(false);
    repaintRef.current();
  }, [interactive]);

  /** 塗っている途中のストロークを確定せずに捨てる（2 本目の指・止められた）。 */
  const cancelStroke = () => {
    const gesture = gestureRef.current;
    if (!gesture) return;
    gestureRef.current = null;
    setStroking(false);
    gesture.stroke.finish(false);
    setHold(false);
    repaintRef.current();
  };
  const cancelStrokeRef = useRef(cancelStroke);
  cancelStrokeRef.current = cancelStroke;

  // 指: 触れている指を数え（写真の外も）、指で塗っている途中に別の指が触れたらストロークを捨てる（この面の押下より先に聞く）
  useEffect(() => {
    const handleDown = (event: globalThis.PointerEvent) => {
      if (event.pointerType !== "touch") return;
      const touches = touchesRef.current;
      // 最初の指が降りたのに前の指が残っているのは、離した通知が届かなかったとき。持ち越さない
      if (event.isPrimary) touches.clear();
      touches.add(event.pointerId);
      const gesture = gestureRef.current;
      if (gesture?.touch && gesture.pointerId !== event.pointerId) cancelStrokeRef.current();
    };
    const handleUp = (event: globalThis.PointerEvent) => {
      if (event.pointerType === "touch") touchesRef.current.delete(event.pointerId);
    };
    document.addEventListener("pointerdown", handleDown, true);
    document.addEventListener("pointerup", handleUp, true);
    document.addEventListener("pointercancel", handleUp, true);
    return () => {
      document.removeEventListener("pointerdown", handleDown, true);
      document.removeEventListener("pointerup", handleUp, true);
      document.removeEventListener("pointercancel", handleUp, true);
    };
  }, []);

  // 指で大きさを変えたら、写真の中央に輪の見本を少しの間出す（指の下の輪は見えないので。マウスはポインタの輪で見える）
  const size = brush.brush.size;
  const sizeRef = useRef(size);
  const previewTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => {
    if (sizeRef.current === size) return;
    sizeRef.current = size;
    if (!coarse) return;
    setSizePreview(true);
    if (previewTimerRef.current !== null) clearTimeout(previewTimerRef.current);
    previewTimerRef.current = setTimeout(() => {
      previewTimerRef.current = null;
      setSizePreview(false);
    }, SIZE_PREVIEW_MS);
  }, [coarse, size]);
  useEffect(
    () => () => {
      if (previewTimerRef.current !== null) clearTimeout(previewTimerRef.current);
    },
    [],
  );

  // [ ] で大きさ、⌥ を押している間は消しゴム（文字の入力・ほかが使ったキーは扱わない）
  useEffect(() => {
    const handleKeyDown = (event: globalThis.KeyboardEvent) => {
      if (event.key === "Alt") {
        setAltHeld(true);
        return;
      }
      if (event.defaultPrevented || event.isComposing || event.metaKey || event.ctrlKey || event.altKey) return;
      if (event.key !== "[" && event.key !== "]") return;
      if (isPhotoEditingTypingTarget(event.target)) return;
      if (event.target instanceof Element && event.target.closest('[role="dialog"], [role="menu"]')) return;
      event.preventDefault();
      brushRef.current.stepSize(event.key === "]" ? 1 : -1);
    };
    const handleKeyUp = (event: globalThis.KeyboardEvent) => {
      if (event.key === "Alt") setAltHeld(false);
    };
    const handleBlur = () => setAltHeld(false);
    document.addEventListener("keydown", handleKeyDown);
    document.addEventListener("keyup", handleKeyUp);
    window.addEventListener("blur", handleBlur);
    return () => {
      document.removeEventListener("keydown", handleKeyDown);
      document.removeEventListener("keyup", handleKeyUp);
      window.removeEventListener("blur", handleBlur);
    };
  }, []);

  /** 画面の点 → 写真の canvas の px（測れなければ null）。 */
  const localPoint = (clientX: number, clientY: number): { point: Vec2; width: number; height: number } | null => {
    const rect = props.targetRef.current?.getBoundingClientRect();
    if (!rect || rect.width <= 0 || rect.height <= 0) return null;
    return { point: [clientX - rect.left, clientY - rect.top], width: rect.width, height: rect.height };
  };

  const placeDab = (gesture: Gesture, point: Vec2, width: number, height: number) => {
    const output: Vec2 = [point[0] / width, point[1] / height];
    gesture.stroke.dab(output, { width, height });
    const canvas = canvasRef.current;
    if (canvas) {
      paintLiveDab(canvas, output, {
        size: gesture.size,
        feather: gesture.feather,
        flow: gesture.flow,
        erase: gesture.stroke.erase,
        invert: brushRef.current.mask?.invert === true,
      });
    }
  };

  const moveCursor = (clientX: number, clientY: number) => {
    const root = rootRef.current?.getBoundingClientRect();
    if (!root) return;
    setCursor({ left: clientX - root.left, top: clientY - root.top });
  };

  const start = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (event.button !== 0) return;
    const touch = event.pointerType === "touch";
    // 塗る面の上の押下は、写真の選択を外す・マスクを選ぶには使わない。指は写真の面の指の操作（ピンチ）へ渡す（ピンチにだけ数える印）
    if (!touch) event.stopPropagation();
    if (!interactive || gestureRef.current) return;
    // 2 本目の指では塗らない（1 本目のストロークは、文書の押下を聞く係が捨てている）
    if (touch && touchesRef.current.size > 1) return;
    const local = localPoint(event.clientX, event.clientY);
    if (!local) return;
    const stroke = brush.startStroke(brush.brush.erase || event.altKey);
    if (!stroke) return;
    event.preventDefault();
    try {
      event.currentTarget.setPointerCapture?.(event.pointerId);
    } catch {
      // 取り込めないポインタ（合成のイベントなど）でも、この面の上で塗る分は続ける
    }
    const gesture: Gesture = {
      pointerId: event.pointerId,
      touch,
      stroke,
      last: local.point,
      carry: 0,
      size: brush.brush.size,
      feather: brush.brush.feather,
      flow: brush.brush.flow,
    };
    gestureRef.current = gesture;
    // canvas はいつも今の赤い面（と確定を待っている塗り）を描いてある。その上に塗る
    setStroking(true);
    setHold(true);
    setSizePreview(false);
    // 指の下の輪は指に隠れるので出さない（塗っている途中の赤で見せる）
    if (touch) setCursor(null);
    else moveCursor(event.clientX, event.clientY);
    placeDab(gesture, local.point, local.width, local.height);
  };

  const move = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (event.pointerType !== "touch") moveCursor(event.clientX, event.clientY);
    const gesture = gestureRef.current;
    if (!gesture || gesture.pointerId !== event.pointerId) return;
    const coalesced = event.nativeEvent.getCoalescedEvents?.() ?? [];
    const samples = coalesced.length > 0 ? coalesced : [event.nativeEvent];
    for (const sample of samples) {
      const local = localPoint(sample.clientX, sample.clientY);
      if (!local) continue;
      const spacing = photoEditingMaskBrushSpacing(gesture.size, local);
      const path = photoEditingMaskBrushPath(gesture.last, local.point, spacing, gesture.carry);
      for (const point of path.points) placeDab(gesture, point, local.width, local.height);
      gesture.carry = path.carry;
      gesture.last = local.point;
    }
  };

  const end = (event: ReactPointerEvent<HTMLDivElement>, commit: boolean) => {
    const gesture = gestureRef.current;
    if (!gesture || gesture.pointerId !== event.pointerId) return;
    gestureRef.current = null;
    setStroking(false);
    const queued = gesture.stroke.finish(commit);
    // 確定に回さなかった（止めた・何も変わらなかった）塗りの見た目は消す
    if (!queued) {
      setHold(false);
      repaintRef.current();
    }
  };

  const mask = brush.mask;
  const showRed = props.overlayVisible || stroking || hold || (mask !== null && !isActiveDevelopMask(mask));
  const diameter = box ? 2 * (clampPhotoEditingMaskBrushSize(brush.brush.size) / 100) * Math.min(box.width, box.height) : 0;
  const ready = box !== null && box.width > 0 && box.height > 0;
  const ringClassName = cn(
    "pointer-events-none absolute -translate-x-1/2 -translate-y-1/2 rounded-full border border-niho-surface outline outline-1 outline-niho-text/40",
    erasing ? "border-dashed" : null,
  );
  return (
    <div
      ref={rootRef}
      role="group"
      aria-label={PHOTO_EDITING_MASK_BRUSH_AREA_LABEL}
      aria-disabled={interactive ? undefined : true}
      data-testid="photo-mask-brush-area"
      data-erasing={erasing ? "true" : undefined}
      // 指は塗る。写真の面の指の操作は、この面の上の指をピンチにだけ数える（送り・長押し・ダブルタップにしない。
      // `PHOTO_EDITING_ZOOM_PINCH_ONLY_ATTRIBUTE`）
      data-photo-zoom-pinch-only=""
      className={cn("absolute touch-none select-none", interactive ? "cursor-none" : "cursor-not-allowed")}
      style={
        ready
          ? { left: box.left, top: box.top, width: box.width, height: box.height }
          : { left: 0, top: 0, width: 0, height: 0, visibility: "hidden" }
      }
      onPointerDown={start}
      onPointerMove={move}
      onPointerUp={(event) => {
        end(event, true);
        if (event.pointerType === "touch") setCursor(null);
      }}
      onPointerCancel={(event) => end(event, false)}
      onLostPointerCapture={(event) => end(event, false)}
      onPointerLeave={() => {
        if (!gestureRef.current) setCursor(null);
      }}
    >
      <canvas
        ref={canvasRef}
        aria-hidden
        data-testid="photo-mask-brush-plane"
        className={cn("pointer-events-none absolute inset-0 h-full w-full", showRed ? null : "invisible")}
      />
      {interactive && cursor && diameter > 0 ? (
        <span
          aria-hidden
          data-testid="photo-mask-brush-cursor"
          className={ringClassName}
          style={{ left: cursor.left, top: cursor.top, width: diameter, height: diameter }}
        />
      ) : null}
      {interactive && sizePreview && !cursor && !stroking && ready && diameter > 0 ? (
        // 指で大きさを変えた: 写真の中央に輪の見本
        <span
          aria-hidden
          data-testid="photo-mask-brush-size-preview"
          className={ringClassName}
          style={{ left: box.width / 2, top: box.height / 2, width: diameter, height: diameter }}
        />
      ) : null}
    </div>
  );
}
