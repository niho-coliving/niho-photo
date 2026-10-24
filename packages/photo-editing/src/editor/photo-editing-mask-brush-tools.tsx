"use client";

import { useId } from "react";
import { Eraser, Paintbrush } from "lucide-react";

import {
  PHOTO_EDITING_MASK_BRUSH_CLEAR_LABEL,
  PHOTO_EDITING_MASK_BRUSH_ERASE_LABEL,
  PHOTO_EDITING_MASK_BRUSH_FILL_LABEL,
  PHOTO_EDITING_MASK_BRUSH_FLOW_LABEL,
  PHOTO_EDITING_MASK_BRUSH_HINT_TEXT,
  PHOTO_EDITING_MASK_BRUSH_LOADING_TEXT,
  PHOTO_EDITING_MASK_BRUSH_PAINT_LABEL,
  PHOTO_EDITING_MASK_BRUSH_RESUME_LABEL,
  PHOTO_EDITING_MASK_BRUSH_SIZE_LABEL,
  PHOTO_EDITING_MASK_BRUSH_TITLE,
  PHOTO_EDITING_MASK_FEATHER_LABEL,
} from "../photo-editing-copy";
import {
  PHOTO_EDITING_MASK_BRUSH_FEATHER_DEFAULT,
  PHOTO_EDITING_MASK_BRUSH_FLOW_DEFAULT,
  PHOTO_EDITING_MASK_BRUSH_FLOW_MIN,
  PHOTO_EDITING_MASK_BRUSH_SIZE_DEFAULT,
  PHOTO_EDITING_MASK_BRUSH_SIZE_MAX,
  PHOTO_EDITING_MASK_BRUSH_SIZE_MIN,
  PHOTO_EDITING_MASK_BRUSH_SIZE_STEP,
} from "../photo-editing-mask-brush";
import { cn } from "niho-ui/cn";

import { PhotoEditingSlider } from "./photo-editing-slider";
import type { BrowserPhotoMaskBrush } from "./use-browser-photo-mask-brush";

const FOCUS_RING_CLASS_NAME = "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-niho-accent-ink";
const SECTION_TITLE_CLASS_NAME = "text-xs font-bold text-niho-text-muted";
const NOTE_CLASS_NAME = "text-xs leading-relaxed text-niho-text-sub";
/** 描く / 消しゴムの切り替え（2 つで 1 行。押せる高さ 32px） */
const MODE_BUTTON_CLASS_NAME = cn(
  "inline-flex h-8 flex-1 items-center justify-center gap-1.5 rounded-md px-2 text-xs font-bold transition aria-pressed:bg-niho-surface aria-pressed:text-niho-accent-ink aria-pressed:shadow-sm enabled:hover:text-niho-text disabled:cursor-not-allowed disabled:opacity-40",
  FOCUS_RING_CLASS_NAME,
);
const ACTION_BUTTON_CLASS_NAME = cn(
  "inline-flex h-8 flex-1 items-center justify-center rounded-lg border border-niho-border px-2 text-xs font-bold text-niho-text transition enabled:hover:bg-niho-pale/60 disabled:cursor-not-allowed disabled:opacity-40",
  FOCUS_RING_CLASS_NAME,
);

function formatSize(size: number): string {
  return Number.isInteger(size) ? String(size) : size.toFixed(1);
}

/**
 * 右パネルのブラシの道具（選んだブラシのマスク。M4 #68）。描く / 消しゴム（E。⌥ を押している間も消しゴム）、大きさ（見えている短い辺に
 * 対する半径の %。[ ]）・ぼかし・流量、全体を塗る / 全体を消す（それぞれ取り消しの 1 単位）。esc で塗るのをやめた後は「写真に塗る」で
 * 戻る。ブラシの設定は補正ではない（保存・取り消しの外。写真を替えても保つ）。
 */
export function PhotoEditingMaskBrushTools(props: { brush: BrowserPhotoMaskBrush; disabled: boolean }) {
  const idPrefix = useId();
  const { brush, disabled } = props;
  const settings = brush.brush;
  const surfaceReady = brush.status === "ready" && !disabled;
  return (
    <div role="group" aria-labelledby={`${idPrefix}-brush`} className="space-y-1.5 pt-1" data-testid="photo-mask-brush-tools">
      <h4 id={`${idPrefix}-brush`} className={cn(SECTION_TITLE_CLASS_NAME, "py-1")}>
        {PHOTO_EDITING_MASK_BRUSH_TITLE}
      </h4>
      <div className="flex gap-0.5 rounded-lg bg-niho-pale/60 p-0.5">
        <button
          type="button"
          aria-pressed={!settings.erase}
          disabled={disabled}
          onClick={() => brush.setErase(false)}
          className={MODE_BUTTON_CLASS_NAME}
        >
          <Paintbrush className="h-3.5 w-3.5" aria-hidden />
          {PHOTO_EDITING_MASK_BRUSH_PAINT_LABEL}
        </button>
        <button
          type="button"
          aria-pressed={settings.erase}
          aria-keyshortcuts="E"
          disabled={disabled}
          onClick={() => brush.setErase(true)}
          className={MODE_BUTTON_CLASS_NAME}
        >
          <Eraser className="h-3.5 w-3.5" aria-hidden />
          {PHOTO_EDITING_MASK_BRUSH_ERASE_LABEL}
        </button>
      </div>
      {!brush.paintMode ? (
        <button
          type="button"
          disabled={disabled}
          onClick={brush.resumePaint}
          className={cn(ACTION_BUTTON_CLASS_NAME, "w-full")}
        >
          {PHOTO_EDITING_MASK_BRUSH_RESUME_LABEL}
        </button>
      ) : null}
      <PhotoEditingSlider
        id={`${idPrefix}-size`}
        label={PHOTO_EDITING_MASK_BRUSH_SIZE_LABEL}
        min={PHOTO_EDITING_MASK_BRUSH_SIZE_MIN}
        max={PHOTO_EDITING_MASK_BRUSH_SIZE_MAX}
        step={PHOTO_EDITING_MASK_BRUSH_SIZE_STEP}
        value={settings.size}
        valueText={formatSize(settings.size)}
        disabled={disabled}
        onChange={(next) => brush.setSize(next)}
        onReset={() => brush.setSize(PHOTO_EDITING_MASK_BRUSH_SIZE_DEFAULT)}
        changed={settings.size !== PHOTO_EDITING_MASK_BRUSH_SIZE_DEFAULT}
      />
      <PhotoEditingSlider
        id={`${idPrefix}-feather`}
        label={PHOTO_EDITING_MASK_FEATHER_LABEL}
        min={0}
        max={100}
        step={1}
        value={settings.feather}
        valueText={String(settings.feather)}
        disabled={disabled}
        onChange={(next) => brush.setFeather(next)}
        onReset={() => brush.setFeather(PHOTO_EDITING_MASK_BRUSH_FEATHER_DEFAULT)}
        changed={settings.feather !== PHOTO_EDITING_MASK_BRUSH_FEATHER_DEFAULT}
      />
      <PhotoEditingSlider
        id={`${idPrefix}-flow`}
        label={PHOTO_EDITING_MASK_BRUSH_FLOW_LABEL}
        min={PHOTO_EDITING_MASK_BRUSH_FLOW_MIN}
        max={100}
        step={1}
        value={settings.flow}
        valueText={String(settings.flow)}
        disabled={disabled}
        onChange={(next) => brush.setFlow(next)}
        onReset={() => brush.setFlow(PHOTO_EDITING_MASK_BRUSH_FLOW_DEFAULT)}
        changed={settings.flow !== PHOTO_EDITING_MASK_BRUSH_FLOW_DEFAULT}
      />
      <div className="flex gap-1.5">
        <button type="button" disabled={!surfaceReady} onClick={brush.fill} className={ACTION_BUTTON_CLASS_NAME}>
          {PHOTO_EDITING_MASK_BRUSH_FILL_LABEL}
        </button>
        <button type="button" disabled={!surfaceReady} onClick={brush.clear} className={ACTION_BUTTON_CLASS_NAME}>
          {PHOTO_EDITING_MASK_BRUSH_CLEAR_LABEL}
        </button>
      </div>
      {brush.status === "loading" ? (
        <p role="status" className={NOTE_CLASS_NAME}>
          {PHOTO_EDITING_MASK_BRUSH_LOADING_TEXT}
        </p>
      ) : null}
      <p className={NOTE_CLASS_NAME}>{PHOTO_EDITING_MASK_BRUSH_HINT_TEXT}</p>
    </div>
  );
}
