"use client";

import { useId, useRef, useState } from "react";
import { Trash2 } from "lucide-react";

import { ConfirmDialog } from "niho-ui/components/confirm-dialog";
import { cn } from "niho-ui/cn";
import type { DevelopHealMode } from "../develop-engine/develop-heal";
import {
  DEFAULT_HEAL_FEATHER,
  DEFAULT_HEAL_RADIUS,
  type DevelopHealMarkView,
} from "../develop-engine/develop-heal-editing";
import {
  PHOTO_EDITING_HEAL_BRUSH_TITLE,
  PHOTO_EDITING_HEAL_CLEAR_CONFIRM_LABEL,
  PHOTO_EDITING_HEAL_CLEAR_DESCRIPTION,
  PHOTO_EDITING_HEAL_CLEAR_LABEL,
  PHOTO_EDITING_HEAL_CLEAR_TITLE,
  PHOTO_EDITING_HEAL_EMPTY_TEXT,
  PHOTO_EDITING_HEAL_FEATHER_LABEL,
  PHOTO_EDITING_HEAL_FRAME_NOTE,
  PHOTO_EDITING_HEAL_FULL_TEXT,
  PHOTO_EDITING_HEAL_HINT_TEXT,
  PHOTO_EDITING_HEAL_MARKS_LIST_LABEL,
  PHOTO_EDITING_HEAL_MARKS_TITLE,
  PHOTO_EDITING_HEAL_MODE_CLONE_HINT,
  PHOTO_EDITING_HEAL_MODE_CLONE_LABEL,
  PHOTO_EDITING_HEAL_MODE_REMOVE_HINT,
  PHOTO_EDITING_HEAL_MODE_REMOVE_LABEL,
  PHOTO_EDITING_HEAL_MODE_TITLE,
  PHOTO_EDITING_HEAL_SHOW_MARKS_LABEL,
  PHOTO_EDITING_HEAL_SIZE_LABEL,
  photoEditingHealMarkLabel,
  photoEditingHealMarkRemoveLabel,
  photoEditingHealSelectedNote,
} from "../photo-editing-copy";
import {
  HEAL_RADIUS_DIAL_MAX_PERCENT,
  HEAL_RADIUS_DIAL_MIN_PERCENT,
  HEAL_RADIUS_DIAL_STEPS,
  formatHealPercent,
  healRadiusFromDial,
  healRadiusToDial,
} from "../photo-editing-heal";

import { PHOTO_EDITING_TEXT_BUTTON_CLASS_NAME } from "./photo-editing-button-classes";
import { returnDialogFocus } from "./photo-editing-preset-dialogs";
import { PhotoEditingSlider, type PhotoEditingSliderPhase } from "./photo-editing-slider";

const FOCUS_RING_CLASS_NAME = "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-niho-accent-ink";
const SECTION_TITLE_CLASS_NAME = "text-xs font-bold text-niho-text-muted";
/** 説明・状態の 1 行（読める濃さ） */
const NOTE_CLASS_NAME = "text-xs leading-relaxed text-niho-text-sub";
/** 「消す」/「写す」（押せる高さ 44px。選んでいる側は地の色） */
const MODE_BUTTON_CLASS_NAME = cn(
  "flex min-h-11 flex-1 items-center justify-center rounded-xl border text-sub font-bold transition disabled:cursor-not-allowed disabled:opacity-50",
  FOCUS_RING_CLASS_NAME,
);
const MODE_SELECTED_CLASS_NAME = "border-transparent bg-niho-accent-soft text-niho-accent-ink";
const MODE_IDLE_CLASS_NAME = "border-niho-border text-niho-text enabled:hover:bg-niho-pale/60";
/** 印の行（行全体が選ぶボタン。押せる高さ 44px） */
const ROW_BUTTON_CLASS_NAME = cn(
  "flex min-h-11 min-w-0 flex-1 items-center gap-2 rounded-xl px-2 text-left text-sub transition disabled:cursor-not-allowed disabled:opacity-50",
  FOCUS_RING_CLASS_NAME,
);
const ROW_REMOVE_CLASS_NAME = cn(
  "flex h-11 w-11 shrink-0 items-center justify-center rounded-full text-niho-text-muted transition enabled:hover:bg-niho-pale/60 enabled:hover:text-niho-text-sub disabled:cursor-not-allowed disabled:opacity-50",
  FOCUS_RING_CLASS_NAME,
);
const TOGGLE_CLASS_NAME = cn(
  "inline-flex min-h-11 items-center gap-2 rounded-full px-2 text-xs font-bold text-niho-text-sub transition enabled:hover:bg-niho-pale/60 disabled:cursor-not-allowed disabled:opacity-50",
  FOCUS_RING_CLASS_NAME,
);
const CLEAR_BUTTON_CLASS_NAME = cn(PHOTO_EDITING_TEXT_BUTTON_CLASS_NAME, "-ml-3 disabled:cursor-not-allowed disabled:opacity-50");
const FEATHER_PERCENT_STEP = 1;
const SIZE_ENTRY_STEP = 0.1;

/**
 * 修復の道具（niho-photo#44 後半）: 右パネルの「修復」の間、プリセットの節と群の代わりに出す。押すたびに確定する（取り消しの 1 単位。
 * 保存と履歴は呼ぶ側。スライダーは動かしている間 `drag`、離したら `commit`）。
 *
 * - 修復のしかた: 「消す」/「写す」（`aria-pressed`）
 * - ブラシ: 大きさ（長辺に対する %。ダイヤルは対数で 0.2%〜12%）・ぼかし（0〜100%）。印を選んでいる間はその印の値（上に 1 行）
 * - 印: 描いた順の番号つきの一覧（押すと選ぶ / もう一度押すと外す。行の右に削除〔確かめない。↶ で戻せる〕）。0 件なら案内の 1 行、
 *   上限に達したら控えめな 1 行。一覧の下に「印を表示」の切り替えと「すべての印を消す」（確かめてから）
 * - 使い方の短い説明
 */
export function PhotoEditingHealTools(props: {
  marks: readonly DevelopHealMarkView[];
  selectedId: string | null;
  /** 見せる値（選んでいる印があればその値） */
  brush: { mode: DevelopHealMode; radius: number; feather: number };
  disabled: boolean;
  /** もう 1 つ印を足せる */
  canAdd: boolean;
  showMarks: boolean;
  /** 幾何（切り抜き・回転・遠近）のある写真（道具の間は幾何の前の写真全体を見せる、の 1 行を出す） */
  hasGeometry: boolean;
  onModeChange: (mode: DevelopHealMode) => void;
  onRadiusChange: (radius: number, phase: PhotoEditingSliderPhase) => void;
  onFeatherChange: (feather: number, phase: PhotoEditingSliderPhase) => void;
  onSelect: (id: string | null) => void;
  onRemove: (id: string) => void;
  onClear: () => void;
  onShowMarksChange: (show: boolean) => void;
}) {
  const modeTitleId = useId();
  const sizeId = useId();
  const featherId = useId();
  const [clearOpen, setClearOpen] = useState(false);
  const clearButtonRef = useRef<HTMLButtonElement | null>(null);
  const { brush, marks } = props;
  const selectedOrder = props.selectedId === null ? -1 : marks.findIndex((mark) => mark.id === props.selectedId);
  const radiusPercent = brush.radius * 100;
  const featherPercent = Math.round(brush.feather * 100);

  return (
    <div className="space-y-4 pb-2 pt-1">
      {props.hasGeometry ? <p className={NOTE_CLASS_NAME}>{PHOTO_EDITING_HEAL_FRAME_NOTE}</p> : null}
      <section>
        <h4 id={modeTitleId} className={cn(SECTION_TITLE_CLASS_NAME, "mb-1.5")}>
          {PHOTO_EDITING_HEAL_MODE_TITLE}
        </h4>
        <div role="group" aria-labelledby={modeTitleId} className="flex gap-1.5">
          {(
            [
              ["remove", PHOTO_EDITING_HEAL_MODE_REMOVE_LABEL],
              ["clone", PHOTO_EDITING_HEAL_MODE_CLONE_LABEL],
            ] as const
          ).map(([mode, label]) => (
            <button
              key={mode}
              type="button"
              aria-pressed={brush.mode === mode}
              disabled={props.disabled}
              onClick={() => props.onModeChange(mode)}
              className={cn(MODE_BUTTON_CLASS_NAME, brush.mode === mode ? MODE_SELECTED_CLASS_NAME : MODE_IDLE_CLASS_NAME)}
            >
              {label}
            </button>
          ))}
        </div>
        <p className={cn(NOTE_CLASS_NAME, "mt-1.5")}>
          {brush.mode === "clone" ? PHOTO_EDITING_HEAL_MODE_CLONE_HINT : PHOTO_EDITING_HEAL_MODE_REMOVE_HINT}
        </p>
      </section>
      <section>
        <h4 className={cn(SECTION_TITLE_CLASS_NAME, "mb-1.5")}>{PHOTO_EDITING_HEAL_BRUSH_TITLE}</h4>
        {selectedOrder >= 0 ? (
          <p role="status" className={cn(NOTE_CLASS_NAME, "mb-1.5 font-bold text-niho-accent-ink")}>
            {photoEditingHealSelectedNote(selectedOrder + 1)}
          </p>
        ) : null}
        <div className="space-y-3">
          <PhotoEditingSlider
            id={sizeId}
            label={PHOTO_EDITING_HEAL_SIZE_LABEL}
            min={0}
            max={HEAL_RADIUS_DIAL_STEPS}
            step={1}
            value={healRadiusToDial(brush.radius)}
            valueText={formatHealPercent(radiusPercent)}
            disabled={props.disabled}
            onChange={(dial, phase) => props.onRadiusChange(healRadiusFromDial(dial), phase)}
            onReset={() => props.onRadiusChange(DEFAULT_HEAL_RADIUS, "commit")}
            // 値の直接入力は表示と同じ %（長辺に対する割合）で受ける
            entry={{
              min: HEAL_RADIUS_DIAL_MIN_PERCENT,
              max: HEAL_RADIUS_DIAL_MAX_PERCENT,
              step: SIZE_ENTRY_STEP,
              commit: (percent) => props.onRadiusChange(percent / 100, "commit"),
            }}
          />
          <PhotoEditingSlider
            id={featherId}
            label={PHOTO_EDITING_HEAL_FEATHER_LABEL}
            min={0}
            max={100}
            step={FEATHER_PERCENT_STEP}
            value={featherPercent}
            valueText={`${featherPercent}%`}
            disabled={props.disabled}
            onChange={(percent, phase) => props.onFeatherChange(percent / 100, phase)}
            onReset={() => props.onFeatherChange(DEFAULT_HEAL_FEATHER, "commit")}
          />
        </div>
      </section>
      <section>
        <h4 className={cn(SECTION_TITLE_CLASS_NAME, "mb-1.5")}>{PHOTO_EDITING_HEAL_MARKS_TITLE}</h4>
        {marks.length === 0 ? (
          <p className={NOTE_CLASS_NAME}>{PHOTO_EDITING_HEAL_EMPTY_TEXT}</p>
        ) : (
          <ol aria-label={PHOTO_EDITING_HEAL_MARKS_LIST_LABEL} className="space-y-0.5">
            {marks.map((mark, index) => {
              const selected = mark.id === props.selectedId;
              return (
                <li key={mark.id} className="flex items-center gap-1">
                  <button
                    type="button"
                    aria-pressed={selected}
                    aria-current={selected ? "true" : undefined}
                    disabled={props.disabled}
                    onClick={() => props.onSelect(selected ? null : mark.id)}
                    className={cn(
                      ROW_BUTTON_CLASS_NAME,
                      selected ? "bg-niho-accent-soft font-bold text-niho-accent-ink" : "text-niho-text enabled:hover:bg-niho-pale/60",
                    )}
                  >
                    <span
                      aria-hidden
                      className={cn(
                        "block h-2.5 w-2.5 shrink-0 rounded-full bg-niho-danger",
                        selected ? "opacity-100" : "opacity-50",
                      )}
                    />
                    <span className="min-w-0 truncate tabular-nums">{photoEditingHealMarkLabel(index + 1, mark.mode)}</span>
                  </button>
                  <button
                    type="button"
                    aria-label={photoEditingHealMarkRemoveLabel(index + 1)}
                    title={photoEditingHealMarkRemoveLabel(index + 1)}
                    disabled={props.disabled}
                    onClick={() => props.onRemove(mark.id)}
                    className={ROW_REMOVE_CLASS_NAME}
                  >
                    <Trash2 className="h-4 w-4" aria-hidden />
                  </button>
                </li>
              );
            })}
          </ol>
        )}
        {!props.canAdd ? <p className={cn(NOTE_CLASS_NAME, "mt-1.5")}>{PHOTO_EDITING_HEAL_FULL_TEXT}</p> : null}
        <div className="mt-2 flex flex-wrap items-center justify-between gap-1">
          <button
            type="button"
            aria-pressed={props.showMarks}
            onClick={() => props.onShowMarksChange(!props.showMarks)}
            className={TOGGLE_CLASS_NAME}
          >
            <span
              aria-hidden
              className={cn(
                "flex h-4 w-4 items-center justify-center rounded border",
                props.showMarks ? "border-transparent bg-niho-accent-ink" : "border-niho-border bg-white",
              )}
            >
              {props.showMarks ? <span className="block h-1.5 w-1.5 rounded-full bg-white" /> : null}
            </span>
            {PHOTO_EDITING_HEAL_SHOW_MARKS_LABEL}
          </button>
          {marks.length > 0 ? (
            <button
              ref={clearButtonRef}
              type="button"
              disabled={props.disabled}
              onClick={() => setClearOpen(true)}
              className={CLEAR_BUTTON_CLASS_NAME}
            >
              {PHOTO_EDITING_HEAL_CLEAR_LABEL}
            </button>
          ) : null}
        </div>
      </section>
      <p className={NOTE_CLASS_NAME}>{PHOTO_EDITING_HEAL_HINT_TEXT}</p>
      <ConfirmDialog
        open={clearOpen}
        onOpenChange={setClearOpen}
        title={PHOTO_EDITING_HEAL_CLEAR_TITLE}
        description={PHOTO_EDITING_HEAL_CLEAR_DESCRIPTION}
        confirmLabel={PHOTO_EDITING_HEAL_CLEAR_CONFIRM_LABEL}
        variant="danger"
        onConfirm={() => {
          props.onClear();
          setClearOpen(false);
        }}
        onCloseAutoFocus={(event) => returnDialogFocus(event, clearButtonRef)}
      />
    </div>
  );
}
