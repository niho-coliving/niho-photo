"use client";

import { useEffect, useRef } from "react";

import { snapPhotoEditingSliderValue, type PhotoEditingSliderPhase } from "./photo-editing-slider";

/**
 * スマホ（1024px 未満）の補正の目盛り（NIHO Photo 段 1 F6c 移行元設計・モック `idea/mock/photo-editing-mobile-v1.html` の段 B）。
 * PC の `PhotoEditingSlider` と同じ受け口（`onChange(value, phase)`・`onReset`）なので、補正の部品はそのまま差し替えられる。
 *
 * - 位置ではなく**動かした量**で値を変える（押した場所に飛ばない）。左へ送ると値が増える（目盛りの帯を指で送る向き）。
 * - 範囲全体がおよそ `RANGE_WIDTH_PX` の指の移動にあたる（露光量 ±5 も ±100 の項目も同じ手ざわり）。
 * - ダブルタップで既定値へ戻す（PC のダブルクリックと同じ）。←→ で 1 目盛り・⇧ を押しながらで 10 目盛り。
 * - 帯のスクロール（段 A）と取り合わないよう、目盛りは帯の外の段に置き、`touch-action: none` で横の動きを受ける。
 */

/** 範囲全体にあたる指の移動（px）。 */
export const PHOTO_EDITING_RULER_RANGE_WIDTH_PX = 600;
/** 目盛りの 1 本の間隔（px）。値の見た目の刻みではなく、動いていることが分かるための模様。 */
const TICK_SPACING_PX = 8;
const MAJOR_TICK_EVERY = 5;
const DOUBLE_TAP_MS = 300;
const SHIFT_STEP_COUNT = 10;

function arrowDirection(key: string): -1 | 0 | 1 {
  if (key === "ArrowRight" || key === "ArrowUp") return 1;
  if (key === "ArrowLeft" || key === "ArrowDown") return -1;
  return 0;
}

/** 値 → 目盛りの帯をずらす量（px。既定値 0 のとき帯の 0 の印が中央）。 */
export function photoEditingRulerOffsetPx(value: number, min: number, max: number): number {
  const range = max - min;
  if (!(range > 0)) return 0;
  return (value / range) * PHOTO_EDITING_RULER_RANGE_WIDTH_PX;
}

/** 指を `dx` px 動かしたときの値（左へ送ると増える）。範囲と刻みに丸める。 */
export function photoEditingRulerValueAfterDrag(params: {
  startValue: number;
  dx: number;
  min: number;
  max: number;
  step: number;
}): number {
  const range = params.max - params.min;
  const next = params.startValue - (params.dx / PHOTO_EDITING_RULER_RANGE_WIDTH_PX) * range;
  return snapPhotoEditingSliderValue(next, params.min, params.max, params.step);
}

export function PhotoEditingRuler(props: {
  id: string;
  label: string;
  min: number;
  max: number;
  step: number;
  value: number;
  valueText: string;
  disabled: boolean;
  onChange: (value: number, phase: PhotoEditingSliderPhase) => void;
  /** ダブルタップで既定値へ戻す */
  onReset: () => void;
}) {
  const dragRef = useRef<{ pointerId: number; startX: number; startValue: number; last: number } | null>(null);
  const lastTapRef = useRef(0);
  const onChangeRef = useRef(props.onChange);
  useEffect(() => {
    onChangeRef.current = props.onChange;
  }, [props.onChange]);

  const offset = photoEditingRulerOffsetPx(props.value, props.min, props.max);
  // 0（既定値）の印が範囲の中にあるときだけ出す
  const showZero = props.min <= 0 && props.max >= 0;

  const endDrag = (pointerId: number) => {
    const drag = dragRef.current;
    if (!drag || drag.pointerId !== pointerId) return;
    dragRef.current = null;
    if (drag.last !== drag.startValue) onChangeRef.current(drag.last, "commit");
  };

  return (
    <div className="px-2.5 pb-1.5 pt-1">
      <div className="flex h-5 items-baseline justify-center gap-1.5 tabular-nums">
        <span id={`${props.id}-label`} className="text-xs font-bold text-niho-text-sub">
          {props.label}
        </span>
        <span className="text-sm font-bold text-niho-text">{props.valueText}</span>
      </div>
      <div
        id={props.id}
        role="slider"
        tabIndex={props.disabled ? -1 : 0}
        aria-labelledby={`${props.id}-label`}
        aria-valuemin={props.min}
        aria-valuemax={props.max}
        aria-valuenow={props.value}
        aria-valuetext={props.valueText}
        aria-disabled={props.disabled}
        data-testid="photo-editing-ruler"
        onPointerDown={(event) => {
          if (props.disabled || dragRef.current) return;
          const now = event.timeStamp;
          if (now - lastTapRef.current < DOUBLE_TAP_MS) {
            lastTapRef.current = 0;
            props.onReset();
            return;
          }
          lastTapRef.current = now;
          event.currentTarget.setPointerCapture?.(event.pointerId);
          dragRef.current = { pointerId: event.pointerId, startX: event.clientX, startValue: props.value, last: props.value };
        }}
        onPointerMove={(event) => {
          const drag = dragRef.current;
          if (!drag || drag.pointerId !== event.pointerId) return;
          const next = photoEditingRulerValueAfterDrag({
            startValue: drag.startValue,
            dx: event.clientX - drag.startX,
            min: props.min,
            max: props.max,
            step: props.step,
          });
          if (next === drag.last) return;
          drag.last = next;
          // 指が動いたらダブルタップにしない
          lastTapRef.current = 0;
          onChangeRef.current(next, "drag");
        }}
        onPointerUp={(event) => endDrag(event.pointerId)}
        onPointerCancel={(event) => endDrag(event.pointerId)}
        onKeyDown={(event) => {
          if (props.disabled || event.altKey || event.metaKey || event.ctrlKey) return;
          const direction = arrowDirection(event.key);
          if (direction === 0) return;
          event.preventDefault();
          const next = snapPhotoEditingSliderValue(
            props.value + direction * props.step * (event.shiftKey ? SHIFT_STEP_COUNT : 1),
            props.min,
            props.max,
            props.step,
          );
          if (next !== props.value) onChangeRef.current(next, "commit");
        }}
        // 押せる高さは 44px
        className="relative mt-0.5 h-11 cursor-ew-resize touch-none select-none overflow-hidden rounded-md focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-niho-accent-ink aria-disabled:cursor-not-allowed aria-disabled:opacity-40"
      >
        <div
          aria-hidden="true"
          className="absolute inset-x-0 bottom-2 h-5"
          style={{
            backgroundImage: `repeating-linear-gradient(90deg, currentColor 0 1.5px, transparent 1.5px ${TICK_SPACING_PX * MAJOR_TICK_EVERY}px), repeating-linear-gradient(90deg, currentColor 0 1px, transparent 1px ${TICK_SPACING_PX}px)`,
            backgroundSize: `${TICK_SPACING_PX * MAJOR_TICK_EVERY}px 20px, ${TICK_SPACING_PX}px 10px`,
            backgroundRepeat: "repeat-x",
            backgroundPositionX: `calc(50% - ${offset}px), calc(50% - ${offset}px)`,
            backgroundPositionY: "0, 10px",
            color: "var(--niho-text-muted)",
            opacity: 0.55,
          }}
        />
        {showZero ? (
          <div
            aria-hidden="true"
            className="absolute bottom-1 h-1.5 w-0.5 -translate-x-1/2 rounded-full bg-niho-text-sub"
            style={{ left: `calc(50% - ${offset}px)` }}
          />
        ) : null}
        <div aria-hidden="true" className="absolute bottom-1 left-1/2 h-7 w-0.5 -translate-x-1/2 rounded-full bg-niho-accent-ink" />
        <div
          aria-hidden="true"
          // 両端は置いた面の色（`--photo-editing-panel`。無ければページの地）へ薄れる
          className="pointer-events-none absolute inset-0 bg-[linear-gradient(90deg,var(--photo-editing-panel,var(--niho-surface))_0,transparent_22%,transparent_78%,var(--photo-editing-panel,var(--niho-surface))_100%)]"
        />
      </div>
    </div>
  );
}
