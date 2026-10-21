"use client";

import { useEffect, useId, useMemo, useRef, useState, type KeyboardEvent, type MouseEvent, type PointerEvent } from "react";
import { cn } from "niho-ui/cn";

import {
  PHOTO_EDITING_CURVE_CHANNEL_LABELS,
  PHOTO_EDITING_CURVE_CHANNELS_LABEL,
  PHOTO_EDITING_CURVE_GRAPH_LABEL,
  PHOTO_EDITING_CURVE_HINT,
  PHOTO_EDITING_CURVE_KEYS_HELP,
  PHOTO_EDITING_CURVE_RESET_LABEL,
  PHOTO_EDITING_CURVE_TITLE,
  PHOTO_EDITING_RESET_LABEL,
  photoEditingCurvePointLabel,
  photoEditingCurvePointValueText,
} from "../photo-editing-copy";
import {
  PHOTO_EDITING_HISTOGRAM_LEVELS,
  photoEditingHistogramAreaPath,
  photoEditingHistogramPeak,
  type PhotoEditingHistogram,
} from "../photo-editing-histogram";
import {
  PHOTO_EDITING_TONE_CURVE_CHANNELS,
  addPhotoEditingToneCurvePoint,
  hasPhotoEditingToneCurveEdits,
  insertPhotoEditingToneCurvePointBeside,
  isLinearPhotoEditingToneCurve,
  movePhotoEditingToneCurvePoint,
  photoEditingLuminanceCounts,
  photoEditingToneCurvePath,
  readPhotoEditingToneCurve,
  readPhotoEditingToneCurves,
  removePhotoEditingToneCurvePoint,
  resetPhotoEditingToneCurves,
  writePhotoEditingToneCurve,
  type PhotoEditingToneCurveChannel,
  type PhotoEditingToneCurvePoint,
} from "../photo-editing-tone-curve";
import type { PhotoEditingSettings } from "../photo-editing-types";

import {
  GROUP_ACCESSORY_BUTTON_CLASS_NAME,
  type PhotoEditingSettingsUpdate,
  type PhotoEditingSliderPhase,
} from "./photo-editing-adjustment-controls";
import { PhotoEditingAdvancedSection } from "./photo-editing-advanced-section";

/** 押した位置から点をつかめる距離（画面の px） */
const HIT_RADIUS_PX = 10;
/** 既存の点は、この距離（px）を超えて動かしてから動かす（押しただけで値を変えない） */
const DRAG_THRESHOLD_PX = 3;
/** キーで動かす幅（1%）と、Shift を押しながらの幅（10%） */
const KEY_STEP = 0.01;
const KEY_LARGE_STEP = 0.1;
/** 輝度のヒストグラムを描く高さ（幅は 256 階調。グラフの 0〜1 に縮めて敷く） */
const HISTOGRAM_HEIGHT = 100;
const HISTOGRAM_TRANSFORM = `scale(${1 / PHOTO_EDITING_HISTOGRAM_LEVELS} ${1 / HISTOGRAM_HEIGHT})`;
/** 1/4 ごとの格子 */
const GRID_PATH = "M0.25 0V1M0.5 0V1M0.75 0V1M0 0.25H1M0 0.5H1M0 0.75H1";
const GRID_STYLE = { stroke: "var(--niho-border)" } as const;
const HISTOGRAM_STYLE = { fill: "var(--niho-text-muted)" } as const;

/** 曲線の色。R / G / B はヒストグラム（`photo-editing-histogram.tsx`）の線と同じ token、RGB 全体は文字の色 */
const CHANNEL_COLORS: Readonly<Record<PhotoEditingToneCurveChannel, string>> = {
  rgb: "var(--niho-text)",
  red: "var(--niho-danger)",
  green: "var(--niho-accent-ink)",
  blue: "var(--niho-info)",
};

const CHANNEL_BUTTON_CLASS_NAME =
  "inline-flex h-7 min-w-9 items-center justify-center gap-1 rounded-lg border border-niho-border px-2 text-xs font-bold text-niho-text-sub transition hover:bg-niho-pale/60 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-niho-accent-ink aria-pressed:border-transparent aria-pressed:bg-niho-accent-soft aria-pressed:text-niho-accent-ink";
const POINT_CLASS_NAME =
  "absolute h-3 w-3 -translate-x-1/2 -translate-y-1/2 rounded-full border-2 bg-white focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-niho-accent-ink focus-visible:ring-offset-1 disabled:cursor-not-allowed";
const RESET_BUTTON_CLASS_NAME = cn(
  GROUP_ACCESSORY_BUTTON_CLASS_NAME,
  "disabled:cursor-not-allowed disabled:opacity-40 disabled:hover:bg-transparent",
);

/** 0〜1 の値の見せ方（0〜100 の整数） */
function percent(value: number): number {
  return Math.round(value * 100);
}

type CurveDrag = {
  pointerId: number;
  index: number;
  channel: PhotoEditingToneCurveChannel;
  startX: number;
  startY: number;
  /** 値を変えた（離したときに確定する） */
  changed: boolean;
  /** 動かし始めた（既存の点は {@link DRAG_THRESHOLD_PX} を超えてから） */
  moving: boolean;
};

type ToneCurveProps = {
  /** 編集中の `developSettings`（曲線は `toneCurves`） */
  settings: PhotoEditingSettings;
  /** 右パネルのヒストグラムの度数（グラフの背後に輝度として薄く敷く。無ければ敷かない） */
  histogram: Pick<PhotoEditingHistogram, "red" | "green" | "blue"> | null;
  /** 点を動かせない（閲覧のみ・操作の途中など。チャンネルの切り替えは見るだけなので押せる） */
  disabled: boolean;
  onSettingsChange: (update: PhotoEditingSettingsUpdate, phase: PhotoEditingSliderPhase) => void;
};

/** 1 チャンネルの点の並びを、呼ばれた時点の最新の設定に当てる書き換え（`edit` が null を返せば変えない）。 */
function curveUpdate(
  channel: PhotoEditingToneCurveChannel,
  edit: (points: ReadonlyArray<PhotoEditingToneCurvePoint>) => ReadonlyArray<PhotoEditingToneCurvePoint> | null,
): PhotoEditingSettingsUpdate {
  return (current) => {
    const next = edit(readPhotoEditingToneCurve(current, channel));
    return next ? writePhotoEditingToneCurve(current, channel, next) : current;
  };
}

const keepSettings: PhotoEditingSettingsUpdate = (current) => current;

/**
 * トーンカーブのグラフ（niho-photo#37。ポイントカーブ・RGB 全体 / R / G / B）。正方形の SVG（座標は 0〜1）に、1/4 の格子と対角線、
 * 背後に輝度のヒストグラム、選んだチャンネルの曲線（太い）とほかの直したチャンネル（薄い）を描く。曲線は crate と同じ式
 * （`DngSpline`）で、点の上を通り 0〜1 に収める。
 *
 * - 点を足す: グラフの空いたところを押す（そのままドラッグで動かせる）。隣の点に近すぎる・点が多すぎるときは足さない
 * - 動かす: 点をドラッグ（pointer capture。隣の点を追い越さない。両端の点は上下だけ）。ドラッグの間は `drag`、離したら `commit`
 * - 消す: 点をダブルクリック・点を選んで Delete / ⌫（両端の点は消せない）
 * - キー: 点に focus（Tab で次の点）。矢印で 1%（Shift で 10%）、Delete / ⌫ で消す、Enter / Space で隣の点との間に点を足す。どれも
 *   1 回ずつ `commit`。写真の送り・写真を消すキーには渡さない
 * - 選んだ点の入力と出力（0〜100）をグラフの下に出す
 */
export function PhotoEditingToneCurve(props: ToneCurveProps) {
  const { settings, disabled, onSettingsChange } = props;
  const histogram = props.histogram;
  const [channel, setChannel] = useState<PhotoEditingToneCurveChannel>("rgb");
  const [selected, setSelected] = useState<number | null>(null);
  const graphRef = useRef<HTMLDivElement | null>(null);
  const pointRefs = useRef<Array<HTMLButtonElement | null>>([]);
  const dragRef = useRef<CurveDrag | null>(null);
  const onSettingsChangeRef = useRef(onSettingsChange);
  const pendingFocusRef = useRef<number | null>(null);
  const helpId = useId();

  useEffect(() => {
    onSettingsChangeRef.current = onSettingsChange;
  }, [onSettingsChange]);

  // 層を閉じたとき、ドラッグでまだ確定していない変更を履歴へ commit する。
  useEffect(
    () => () => {
      const drag = dragRef.current;
      dragRef.current = null;
      if (drag?.changed) onSettingsChangeRef.current(keepSettings, "commit");
    },
    [],
  );

  const curves = useMemo(() => readPhotoEditingToneCurves(settings), [settings]);
  const points = curves[channel];
  const luminancePath = useMemo(() => {
    if (!histogram) return null;
    const counts = photoEditingLuminanceCounts(histogram);
    return photoEditingHistogramAreaPath(
      counts,
      photoEditingHistogramPeak({ red: counts, green: counts, blue: counts }),
      HISTOGRAM_HEIGHT,
    );
  }, [histogram]);
  const selectedIndex = selected !== null && selected < points.length ? selected : null;
  const selectedPoint = selectedIndex !== null ? points[selectedIndex] : null;
  const curveName = PHOTO_EDITING_CURVE_CHANNEL_LABELS[channel].name;

  // 点を足した・消した後は、描き直した点に focus を移す
  useEffect(() => {
    const index = pendingFocusRef.current;
    if (index === null) return;
    pendingFocusRef.current = null;
    pointRefs.current[index]?.focus();
  });

  // ドラッグの途中で押せなくなったら、そこまでを確定してやめる
  useEffect(() => {
    const drag = dragRef.current;
    if (!disabled || !drag) return;
    dragRef.current = null;
    if (drag.changed) onSettingsChange(keepSettings, "commit");
  }, [disabled, onSettingsChange]);

  /** 画面の位置 → グラフの座標（0〜1 に収める。出力 1 が上）。グラフの大きさが測れなければ null */
  const graphPointAt = (clientX: number, clientY: number): PhotoEditingToneCurvePoint | null => {
    const rect = graphRef.current?.getBoundingClientRect();
    if (!rect || !(rect.width > 0) || !(rect.height > 0)) return null;
    return {
      x: Math.min(1, Math.max(0, (clientX - rect.left) / rect.width)),
      y: Math.min(1, Math.max(0, 1 - (clientY - rect.top) / rect.height)),
    };
  };

  /** 押した位置から {@link HIT_RADIUS_PX} 以内で一番近い点（無ければ null） */
  const pointIndexAt = (clientX: number, clientY: number): number | null => {
    const rect = graphRef.current?.getBoundingClientRect();
    if (!rect || !(rect.width > 0) || !(rect.height > 0)) return null;
    let found: number | null = null;
    let nearest = HIT_RADIUS_PX;
    for (let index = 0; index < points.length; index += 1) {
      const point = points[index];
      const distance = Math.hypot(
        rect.left + point.x * rect.width - clientX,
        rect.top + (1 - point.y) * rect.height - clientY,
      );
      if (distance <= nearest) {
        nearest = distance;
        found = index;
      }
    }
    return found;
  };

  const onPointerDown = (event: PointerEvent<HTMLDivElement>) => {
    if (disabled || dragRef.current) return;
    if (event.pointerType === "mouse" && event.button !== 0) return;
    const target = graphPointAt(event.clientX, event.clientY);
    if (!target) return;
    // 文字の選択を始めない（点への focus は下で移す）
    event.preventDefault();
    let index = pointIndexAt(event.clientX, event.clientY);
    const adding = index === null;
    if (index === null) {
      const added = addPhotoEditingToneCurvePoint(points, target);
      if (!added) return;
      index = added.index;
      onSettingsChange(
        curveUpdate(channel, (current) => addPhotoEditingToneCurvePoint(current, target)?.points ?? null),
        "drag",
      );
      pendingFocusRef.current = index;
    } else {
      pointRefs.current[index]?.focus();
    }
    event.currentTarget.setPointerCapture?.(event.pointerId);
    dragRef.current = {
      pointerId: event.pointerId,
      index,
      channel,
      startX: event.clientX,
      startY: event.clientY,
      changed: adding,
      moving: adding,
    };
    setSelected(index);
  };

  const onPointerMove = (event: PointerEvent<HTMLDivElement>) => {
    const drag = dragRef.current;
    if (!drag || drag.pointerId !== event.pointerId) return;
    if (!drag.moving && Math.hypot(event.clientX - drag.startX, event.clientY - drag.startY) <= DRAG_THRESHOLD_PX) return;
    const target = graphPointAt(event.clientX, event.clientY);
    if (!target) return;
    drag.moving = true;
    drag.changed = true;
    const { index } = drag;
    onSettingsChange(curveUpdate(drag.channel, (current) => movePhotoEditingToneCurvePoint(current, index, target)), "drag");
  };

  const finishDrag = (event: PointerEvent<HTMLDivElement>) => {
    const drag = dragRef.current;
    if (!drag || drag.pointerId !== event.pointerId) return;
    dragRef.current = null;
    if (event.currentTarget.hasPointerCapture?.(event.pointerId)) event.currentTarget.releasePointerCapture?.(event.pointerId);
    // ドラッグで当てた値をそのまま確定する（取り消しの 1 単位）
    if (drag.changed) onSettingsChange(keepSettings, "commit");
  };

  const onLostPointerCapture = (event: PointerEvent<HTMLDivElement>) => {
    const drag = dragRef.current;
    if (!drag || drag.pointerId !== event.pointerId) return;
    dragRef.current = null;
    if (drag.changed) onSettingsChange(keepSettings, "commit");
  };

  const onDoubleClick = (event: MouseEvent<HTMLDivElement>) => {
    if (disabled) return;
    const index = pointIndexAt(event.clientX, event.clientY);
    if (index === null || index === 0 || index === points.length - 1) return;
    event.preventDefault();
    onSettingsChange(curveUpdate(channel, (current) => removePhotoEditingToneCurvePoint(current, index)), "commit");
    setSelected(null);
  };

  const onPointKeyDown = (event: KeyboardEvent<HTMLButtonElement>, index: number) => {
    if (disabled || event.metaKey || event.ctrlKey || event.altKey || event.nativeEvent.isComposing) return;
    const step = event.shiftKey ? KEY_LARGE_STEP : KEY_STEP;
    const nudge = (dx: number, dy: number) =>
      onSettingsChange(
        curveUpdate(channel, (current) => {
          const point = current[index];
          return point ? movePhotoEditingToneCurvePoint(current, index, { x: point.x + dx, y: point.y + dy }) : null;
        }),
        "commit",
      );
    switch (event.key) {
      case "ArrowLeft":
        nudge(-step, 0);
        break;
      case "ArrowRight":
        nudge(step, 0);
        break;
      case "ArrowUp":
        nudge(0, step);
        break;
      case "ArrowDown":
        nudge(0, -step);
        break;
      case "Delete":
      case "Backspace":
        if (index > 0 && index < points.length - 1) {
          onSettingsChange(curveUpdate(channel, (current) => removePhotoEditingToneCurvePoint(current, index)), "commit");
          setSelected(index - 1);
          pendingFocusRef.current = index - 1;
        }
        break;
      case "Enter":
      case " ": {
        const inserted = insertPhotoEditingToneCurvePointBeside(points, index);
        if (inserted) {
          onSettingsChange(
            curveUpdate(channel, (current) => insertPhotoEditingToneCurvePointBeside(current, index)?.points ?? null),
            "commit",
          );
          setSelected(inserted.index);
          pendingFocusRef.current = inserted.index;
        }
        break;
      }
      default:
        return;
    }
    // 写真の送り（← →）・写真を消す（⌫ / Delete）・ボタンの押下に渡さない
    event.preventDefault();
    event.stopPropagation();
  };

  const otherChannels = PHOTO_EDITING_TONE_CURVE_CHANNELS.filter(
    (item) => item !== channel && !isLinearPhotoEditingToneCurve(curves[item]),
  );

  return (
    <div data-testid="photo-tone-curve">
      <div role="group" aria-label={PHOTO_EDITING_CURVE_CHANNELS_LABEL} className="mb-2 flex gap-1">
        {PHOTO_EDITING_TONE_CURVE_CHANNELS.map((item) => (
          <button
            key={item}
            type="button"
            aria-pressed={item === channel}
            aria-label={PHOTO_EDITING_CURVE_CHANNEL_LABELS[item].name}
            onClick={() => {
              setChannel(item);
              setSelected(null);
            }}
            className={CHANNEL_BUTTON_CLASS_NAME}
          >
            {item === "rgb" ? null : (
              <span aria-hidden className="h-1.5 w-1.5 rounded-full" style={{ background: CHANNEL_COLORS[item] }} />
            )}
            {PHOTO_EDITING_CURVE_CHANNEL_LABELS[item].short}
          </button>
        ))}
      </div>
      <div
        ref={graphRef}
        role="group"
        aria-label={PHOTO_EDITING_CURVE_GRAPH_LABEL}
        data-testid="photo-tone-curve-graph"
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={finishDrag}
        onPointerCancel={finishDrag}
        onLostPointerCapture={onLostPointerCapture}
        onDoubleClick={onDoubleClick}
        className={cn(
          "relative aspect-square w-full touch-none select-none rounded-md border border-niho-border bg-[var(--photo-editing-surface,white)]",
          disabled ? "cursor-not-allowed" : "cursor-crosshair",
        )}
      >
        <svg
          aria-hidden
          focusable="false"
          viewBox="0 0 1 1"
          preserveAspectRatio="none"
          className={cn("absolute inset-0 h-full w-full overflow-visible", disabled ? "opacity-60" : null)}
        >
          {luminancePath ? (
            <g data-testid="photo-tone-curve-histogram" transform={HISTOGRAM_TRANSFORM}>
              <path d={luminancePath} stroke="none" fillOpacity={0.18} style={HISTOGRAM_STYLE} />
            </g>
          ) : null}
          <path d={GRID_PATH} fill="none" strokeWidth={1} vectorEffect="non-scaling-stroke" style={GRID_STYLE} />
          <path d="M0 1L1 0" fill="none" strokeWidth={1} vectorEffect="non-scaling-stroke" style={GRID_STYLE} />
          {otherChannels.map((item) => (
            <path
              key={item}
              data-channel={item}
              d={photoEditingToneCurvePath(curves[item])}
              fill="none"
              strokeOpacity={0.5}
              strokeWidth={1}
              vectorEffect="non-scaling-stroke"
              style={{ stroke: CHANNEL_COLORS[item] }}
            />
          ))}
          <path
            data-channel={channel}
            data-active="true"
            d={photoEditingToneCurvePath(points)}
            fill="none"
            strokeWidth={2}
            strokeLinejoin="round"
            vectorEffect="non-scaling-stroke"
            style={{ stroke: CHANNEL_COLORS[channel] }}
          />
        </svg>
        {points.map((point, index) => (
          <button
            // 点は x の順のまま増減するので、位置を key にする（focus を同じ位置の点に残す）
            key={index}
            ref={(element) => {
              pointRefs.current[index] = element;
            }}
            type="button"
            disabled={disabled}
            data-curve-point={index}
            aria-label={photoEditingCurvePointLabel(curveName, index + 1, percent(point.x), percent(point.y))}
            aria-describedby={helpId}
            onFocus={() => setSelected(index)}
            onKeyDown={(event) => onPointKeyDown(event, index)}
            className={cn(POINT_CLASS_NAME, disabled ? "opacity-60" : null)}
            style={{
              left: `${point.x * 100}%`,
              top: `${(1 - point.y) * 100}%`,
              borderColor: CHANNEL_COLORS[channel],
              background: index === selectedIndex ? CHANNEL_COLORS[channel] : undefined,
            }}
          />
        ))}
      </div>
      <p id={helpId} className="sr-only">
        {PHOTO_EDITING_CURVE_KEYS_HELP}
      </p>
      <p data-testid="photo-tone-curve-value" className="mt-1 min-h-5 text-xs tabular-nums text-niho-text-sub">
        {selectedPoint
          ? photoEditingCurvePointValueText(percent(selectedPoint.x), percent(selectedPoint.y))
          : disabled
            ? null
            : PHOTO_EDITING_CURVE_HINT}
      </p>
    </div>
  );
}

/**
 * ライトの群の下の「カーブ」の節（niho-photo#37。既定は閉じる。開閉は端末に覚える）。見出しの横の「初期化」は曲線（4 チャンネル）
 * だけを直線に戻して `commit` する（取り消しの 1 単位。直線のまま・押せない間は押せない表示）。
 */
export function PhotoEditingToneCurveSection(props: ToneCurveProps) {
  const canReset = !props.disabled && hasPhotoEditingToneCurveEdits(props.settings);
  const onSettingsChange = props.onSettingsChange;
  return (
    <PhotoEditingAdvancedSection
      id="curve"
      title={PHOTO_EDITING_CURVE_TITLE}
      accessory={
        <button
          type="button"
          aria-label={PHOTO_EDITING_CURVE_RESET_LABEL}
          disabled={!canReset}
          onClick={() => onSettingsChange(resetPhotoEditingToneCurves, "commit")}
          className={RESET_BUTTON_CLASS_NAME}
        >
          {PHOTO_EDITING_RESET_LABEL}
        </button>
      }
    >
      <PhotoEditingToneCurve {...props} />
    </PhotoEditingAdvancedSection>
  );
}
