"use client";

import { useEffect, useId, useRef, type KeyboardEvent, type MouseEvent as ReactMouseEvent, type PointerEvent } from "react";
import { cn } from "niho-ui/cn";

import {
  PHOTO_EDITING_COLOR_GRADING_WHEEL_HELP,
  PHOTO_EDITING_COLOR_GRADING_WHEEL_ROLE,
  photoEditingColorGradingWheelLabel,
  photoEditingColorGradingWheelValueText,
} from "../photo-editing-copy";
import { photoEditingColorGradingHueColor, photoEditingColorGradingSwatchColor } from "../photo-editing-color-grading";

import type { PhotoEditingSliderPhase } from "./photo-editing-adjustment-controls";

/** 色相環の値（色相 0〜359・彩度 0〜100 の整数）。 */
export type PhotoEditingColorWheelValue = { hue: number; saturation: number };

/** キーで動かす幅（1）と、Shift を押しながらの幅（10）。色相は度、彩度は 0〜100 の目盛り */
const KEY_STEP = 1;
const KEY_LARGE_STEP = 10;
/** 環の色の区切り（10° ごと。エンジンの色の向きは色相に対して直線でないので、細かめに置く） */
const WHEEL_STOP_STEP = 10;

/**
 * 環の背景: 中心の白から縁へ透ける放射（彩度）を、色相の環（`conic-gradient`）の上に重ねる。色相は Lightroom と同じく右（3 時）が 0 で、
 * 反時計回りに増える（CSS の `conic-gradient` は時計回りなので、角度 θ に色相 360 − θ の色を置く）。色はエンジンが乗せる色の向き
 * （{@link photoEditingColorGradingHueColor}）。
 */
const WHEEL_BACKGROUND = (() => {
  const stops: string[] = [];
  for (let angle = 0; angle <= 360; angle += WHEEL_STOP_STEP) {
    stops.push(`${photoEditingColorGradingHueColor((360 - angle) % 360)} ${angle}deg`);
  }
  return `radial-gradient(circle closest-side, white, rgb(255 255 255 / 0) 100%), conic-gradient(from 90deg, ${stops.join(", ")})`;
})();

function wrapHue(value: number): number {
  const wrapped = ((Math.round(value) % 360) + 360) % 360;
  return wrapped === 0 ? 0 : wrapped;
}

function clampSaturation(value: number): number {
  return Math.min(100, Math.max(0, Math.round(value)));
}

/**
 * カラーグレーディングの色相環（niho-photo#39。Lightroom のカラーグレーディングの丸）。つまみの角度が色相（右が 0、反時計回り）、
 * 中心からの距離が彩度（中心 0・縁 100）。
 *
 * - 環を押した位置へつまみを移し、そのままドラッグで動かす（pointer capture）。ドラッグの間は `drag`、離したら `commit`
 * - ダブルクリックで彩度 0（色相は残す。Lightroom と同じ）
 * - つまみに focus（Tab）。←→ で色相 ±1°・↑↓ で彩度 ±1（Shift で 10）、Home / End / Delete / ⌫ で彩度 0。どれも 1 回ずつ `commit`。
 *   写真の送り・写真を消すキーには渡さない。読み上げは「シャドウの色（色相 210°、彩度 40）」。数値の入力と読み上げの正は、下に並べる
 *   色相・彩度のスライダー（色だけで伝えない）
 * - `compact` はスマホの段の中（少し小さくする）
 */
export function PhotoEditingColorWheel(props: {
  /** 帯の名前（読み上げ名に使う。例「シャドウ」） */
  zoneLabel: string;
  hue: number;
  saturation: number;
  disabled: boolean;
  compact?: boolean;
  onChange: (value: PhotoEditingColorWheelValue, phase: PhotoEditingSliderPhase) => void;
}) {
  const { hue, saturation, disabled, onChange } = props;
  const wheelRef = useRef<HTMLDivElement | null>(null);
  const thumbRef = useRef<HTMLDivElement | null>(null);
  const dragRef = useRef<{
    pointerId: number;
    /** つまみをつかんだ位置とつまみの中心のずれ（つまみをつかんだときに跳ばさない。環の空いたところは 0） */
    offsetX: number;
    offsetY: number;
    changed: boolean;
    last: PhotoEditingColorWheelValue;
  } | null>(null);
  const helpId = useId();

  // ドラッグの途中で押せなくなったら、そこまでを確定してやめる
  useEffect(() => {
    const drag = dragRef.current;
    if (!disabled || !drag) return;
    dragRef.current = null;
    if (drag.changed) onChange(drag.last, "commit");
  }, [disabled, onChange]);

  /** 画面の位置 → 色相と彩度（縁の外は彩度 100）。環の大きさが測れなければ null */
  const valueAt = (clientX: number, clientY: number): PhotoEditingColorWheelValue | null => {
    const rect = wheelRef.current?.getBoundingClientRect();
    if (!rect || !(rect.width > 0) || !(rect.height > 0)) return null;
    const radius = Math.min(rect.width, rect.height) / 2;
    const dx = clientX - (rect.left + rect.width / 2);
    const dy = rect.top + rect.height / 2 - clientY;
    const distance = Math.hypot(dx, dy);
    const nextSaturation = clampSaturation((Math.min(radius, distance) / radius) * 100);
    // 中心（彩度 0）では角度が決まらないので、今の色相のまま
    const nextHue = nextSaturation === 0 ? hue : wrapHue((Math.atan2(dy, dx) * 180) / Math.PI);
    return { hue: nextHue, saturation: nextSaturation };
  };

  const moveTo = (next: PhotoEditingColorWheelValue) => {
    const drag = dragRef.current;
    if (!drag) return;
    if (next.hue === drag.last.hue && next.saturation === drag.last.saturation) return;
    drag.changed = true;
    drag.last = next;
    onChange(next, "drag");
  };

  const onPointerDown = (event: PointerEvent<HTMLDivElement>) => {
    if (disabled || dragRef.current) return;
    if (event.pointerType === "mouse" && event.button !== 0) return;
    // つまみ（押せる範囲は周りに広い）をつかんだら、つかんだ位置とのずれを保って動かす。環の空いたところはその位置へ移す
    const thumb = thumbRef.current;
    const thumbRect = thumb && event.target instanceof Node && thumb.contains(event.target) ? thumb.getBoundingClientRect() : null;
    const offsetX = thumbRect ? event.clientX - (thumbRect.left + thumbRect.width / 2) : 0;
    const offsetY = thumbRect ? event.clientY - (thumbRect.top + thumbRect.height / 2) : 0;
    const next = valueAt(event.clientX - offsetX, event.clientY - offsetY);
    if (!next) return;
    // 文字の選択を始めない（つまみへ focus を移す）
    event.preventDefault();
    thumb?.focus({ preventScroll: true });
    event.currentTarget.setPointerCapture?.(event.pointerId);
    dragRef.current = { pointerId: event.pointerId, offsetX, offsetY, changed: false, last: { hue, saturation } };
    if (!thumbRect) moveTo(next);
  };

  const onPointerMove = (event: PointerEvent<HTMLDivElement>) => {
    const drag = dragRef.current;
    if (!drag || drag.pointerId !== event.pointerId) return;
    const next = valueAt(event.clientX - drag.offsetX, event.clientY - drag.offsetY);
    if (next) moveTo(next);
  };

  const finishDrag = (event: PointerEvent<HTMLDivElement>) => {
    const drag = dragRef.current;
    if (!drag || drag.pointerId !== event.pointerId) return;
    dragRef.current = null;
    if (event.currentTarget.hasPointerCapture?.(event.pointerId)) event.currentTarget.releasePointerCapture?.(event.pointerId);
    // ドラッグで当てた値をそのまま確定する（取り消しの 1 単位）
    if (drag.changed) onChange(drag.last, "commit");
  };

  const onDoubleClick = (event: ReactMouseEvent<HTMLDivElement>) => {
    const thumb = thumbRef.current;
    if (disabled || saturation === 0 || !thumb || !(event.target instanceof Node) || !thumb.contains(event.target)) return;
    onChange({ hue, saturation: 0 }, "commit");
  };

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (disabled || event.metaKey || event.ctrlKey || event.altKey || event.nativeEvent.isComposing) return;
    const step = event.shiftKey ? KEY_LARGE_STEP : KEY_STEP;
    let next: PhotoEditingColorWheelValue;
    switch (event.key) {
      case "ArrowLeft":
        next = { hue: wrapHue(hue - step), saturation };
        break;
      case "ArrowRight":
        next = { hue: wrapHue(hue + step), saturation };
        break;
      case "ArrowUp":
        next = { hue, saturation: clampSaturation(saturation + step) };
        break;
      case "ArrowDown":
        next = { hue, saturation: clampSaturation(saturation - step) };
        break;
      case "Home":
      case "End":
      case "Delete":
      case "Backspace":
        next = { hue, saturation: 0 };
        break;
      default:
        return;
    }
    // 写真の送り（← →）・写真を消す（⌫ / Delete）・ページの送りに渡さない
    event.preventDefault();
    event.stopPropagation();
    if (next.hue !== hue || next.saturation !== saturation) onChange(next, "commit");
  };

  const radians = (hue * Math.PI) / 180;
  const reach = Math.min(100, Math.max(0, saturation)) / 2;
  const valueText = photoEditingColorGradingWheelValueText(hue, saturation);

  return (
    <div className={cn("mx-auto w-full", props.compact ? "max-w-[9.5rem]" : "max-w-[11rem]")}>
      <div
        ref={wheelRef}
        data-testid="photo-color-wheel"
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={finishDrag}
        onPointerCancel={finishDrag}
        onLostPointerCapture={finishDrag}
        onDoubleClick={onDoubleClick}
        className={cn(
          "relative aspect-square w-full touch-none select-none rounded-full border border-niho-border",
          disabled ? "cursor-not-allowed opacity-60" : "cursor-crosshair",
        )}
        style={{ backgroundImage: WHEEL_BACKGROUND }}
      >
        {/* 中心の印（彩度 0 の位置） */}
        <span aria-hidden className="absolute left-1/2 top-1/2 h-1 w-1 -translate-x-1/2 -translate-y-1/2 rounded-full bg-niho-text-muted" />
        <div
          ref={thumbRef}
          role="slider"
          tabIndex={disabled ? -1 : 0}
          aria-roledescription={PHOTO_EDITING_COLOR_GRADING_WHEEL_ROLE}
          aria-label={photoEditingColorGradingWheelLabel(props.zoneLabel, hue, saturation)}
          aria-describedby={helpId}
          aria-valuemin={0}
          aria-valuemax={100}
          aria-valuenow={saturation}
          aria-valuetext={valueText}
          aria-disabled={disabled || undefined}
          data-testid="photo-color-wheel-thumb"
          onKeyDown={onKeyDown}
          className="absolute h-4 w-4 -translate-x-1/2 -translate-y-1/2 rounded-full border-2 border-white shadow-[0_0_0_1px_rgb(0_0_0/0.45),0_1px_3px_rgb(0_0_0/0.35)] after:absolute after:-inset-3.5 after:content-[''] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-niho-accent-ink focus-visible:ring-offset-1"
          style={{
            left: `${50 + reach * Math.cos(radians)}%`,
            top: `${50 - reach * Math.sin(radians)}%`,
            background: photoEditingColorGradingSwatchColor(hue, saturation),
          }}
        />
      </div>
      <p id={helpId} className="sr-only">
        {PHOTO_EDITING_COLOR_GRADING_WHEEL_HELP}
      </p>
    </div>
  );
}
