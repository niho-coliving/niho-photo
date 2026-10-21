"use client";

import { cn } from "niho-ui/cn";

import {
  PHOTO_EDITING_CLIP_HIGHLIGHTS_LABEL,
  PHOTO_EDITING_CLIP_HIGHLIGHTS_TITLE,
  PHOTO_EDITING_CLIP_SHADOWS_LABEL,
  PHOTO_EDITING_CLIP_SHADOWS_TITLE,
  PHOTO_EDITING_HISTOGRAM_PENDING_LABEL,
  photoEditingHistogramLabel,
} from "../photo-editing-copy";
import {
  PHOTO_EDITING_CLIP_HIGHLIGHT_RGB,
  PHOTO_EDITING_CLIP_SHADOW_RGB,
  photoEditingHistogramAreaPath,
  photoEditingHistogramLinePath,
  photoEditingHistogramPeak,
  type PhotoEditingHistogram,
} from "../photo-editing-histogram";

/** 描く座標の高さ（幅は 256 階調。`preserveAspectRatio="none"` でパネルの幅と高さに伸ばす） */
const CHART_HEIGHT = 100;

/** 印のボタン（パネルの左上 = 黒つぶれ / 右上 = 白飛び）。押せる範囲は 24px、三角は 12px */
const CLIP_BUTTON_CLASS_NAME =
  "absolute top-0 flex h-6 w-6 p-1 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-niho-accent-ink disabled:cursor-not-allowed disabled:opacity-40";

/** R / G / B の描く順と色。画面の token のうち色相が近いもの（SVG の fill / stroke に CSS 変数をそのまま渡す） */
const CHANNELS = [
  { name: "blue", color: "var(--niho-info)" },
  { name: "green", color: "var(--niho-accent-ink)" },
  { name: "red", color: "var(--niho-danger)" },
] as const;
const GRID_STYLE = { stroke: "var(--niho-border)" } as const;
const IDLE_TRIANGLE_STYLE = { fill: "none", stroke: "var(--niho-text-muted)" } as const;

function rgb(color: readonly [number, number, number]): string {
  return `rgb(${color[0]} ${color[1]} ${color[2]})`;
}

/**
 * 右パネルの一番上のヒストグラム（niho-photo#36。RGB の 3 色を重ねる）。描くのは SVG（パネルの幅に合わせて伸びる）。R / G / B の線は、
 * 画面の token のうち色相が近いもの（赤 = danger・緑 = accent-ink・青 = info）を使う。左上の三角 = 黒つぶれ、右上の三角 = 白飛び
 * の印で、押すと写真の上にその領域を青 / 赤で重ねる（`aria-pressed`。Lightroom の J）。点滅・動きは付けない。
 *
 * `data` が無い間（開いた直後でまだ画を数えていない）は、同じ高さの空の枠だけ見せて印を押せなくする（数え終わっても位置が跳ねない）。
 * `clipDisabled` の間（切り抜き・背景除去の道具は写真の上に重ねない）も印を押せなくする。
 */
export function PhotoEditingHistogram(props: {
  data: PhotoEditingHistogram | null;
  clip: { shadows: boolean; highlights: boolean };
  clipDisabled?: boolean;
  onToggleShadows: () => void;
  onToggleHighlights: () => void;
}) {
  const { data } = props;
  const peak = data ? photoEditingHistogramPeak(data) : 1;
  const label = data ? photoEditingHistogramLabel(data.shadowRate, data.highlightRate) : PHOTO_EDITING_HISTOGRAM_PENDING_LABEL;
  const buttonsDisabled = data === null || props.clipDisabled === true;
  return (
    <div
      data-testid="photo-histogram"
      className="relative h-24 overflow-hidden rounded-lg border border-niho-border bg-[var(--photo-editing-surface,white)]"
    >
      <svg
        role="img"
        aria-label={label}
        viewBox={`0 0 256 ${CHART_HEIGHT}`}
        preserveAspectRatio="none"
        focusable="false"
        className="absolute inset-0 h-full w-full"
      >
        <path
          d={`M64 0V${CHART_HEIGHT}M128 0V${CHART_HEIGHT}M192 0V${CHART_HEIGHT}`}
          fill="none"
          strokeWidth={1}
          vectorEffect="non-scaling-stroke"
          style={GRID_STYLE}
        />
        {data ? (
          <>
            {CHANNELS.map((channel) => (
              <g key={channel.name} data-channel={channel.name}>
                {/* 塗り（3 色が重なったところは混ざる）と、上辺だけの線 */}
                <path d={photoEditingHistogramAreaPath(data[channel.name], peak, CHART_HEIGHT)} fillOpacity={0.3} stroke="none" style={{ fill: channel.color }} />
                <path
                  d={photoEditingHistogramLinePath(data[channel.name], peak, CHART_HEIGHT)}
                  fill="none"
                  strokeOpacity={0.9}
                  strokeWidth={1}
                  strokeLinejoin="round"
                  vectorEffect="non-scaling-stroke"
                  style={{ stroke: channel.color }}
                />
              </g>
            ))}
          </>
        ) : null}
      </svg>
      <button
        type="button"
        aria-pressed={props.clip.shadows}
        aria-label={PHOTO_EDITING_CLIP_SHADOWS_LABEL}
        title={PHOTO_EDITING_CLIP_SHADOWS_TITLE}
        disabled={buttonsDisabled}
        onClick={props.onToggleShadows}
        className={cn(CLIP_BUTTON_CLASS_NAME, "left-0")}
      >
        <svg viewBox="0 0 12 12" aria-hidden className="h-3 w-3" focusable="false">
          <path
            d="M0.75 0.75H11.25L0.75 11.25Z"
            strokeWidth={1.5}
            strokeLinejoin="round"
            style={props.clip.shadows ? { fill: rgb(PHOTO_EDITING_CLIP_SHADOW_RGB), stroke: rgb(PHOTO_EDITING_CLIP_SHADOW_RGB) } : IDLE_TRIANGLE_STYLE}
          />
        </svg>
      </button>
      <button
        type="button"
        aria-pressed={props.clip.highlights}
        aria-label={PHOTO_EDITING_CLIP_HIGHLIGHTS_LABEL}
        title={PHOTO_EDITING_CLIP_HIGHLIGHTS_TITLE}
        disabled={buttonsDisabled}
        onClick={props.onToggleHighlights}
        className={cn(CLIP_BUTTON_CLASS_NAME, "right-0")}
      >
        <svg viewBox="0 0 12 12" aria-hidden className="h-3 w-3" focusable="false">
          <path
            d="M11.25 0.75H0.75L11.25 11.25Z"
            strokeWidth={1.5}
            strokeLinejoin="round"
            style={props.clip.highlights ? { fill: rgb(PHOTO_EDITING_CLIP_HIGHLIGHT_RGB), stroke: rgb(PHOTO_EDITING_CLIP_HIGHLIGHT_RGB) } : IDLE_TRIANGLE_STYLE}
          />
        </svg>
      </button>
    </div>
  );
}
