"use client";

import { useId } from "react";
import { CircleDot, Copy, Eye, EyeOff, FlipVertical2, Rows3, Trash2, type LucideIcon } from "lucide-react";

import type { DevelopMask, DevelopMaskAdjustKey } from "../develop-engine/develop-masks";
import { formatAdjustmentValue, formatSignedInteger } from "../photo-editing-adjustments";
import {
  PHOTO_EDITING_MASK_ADD_LINEAR_LABEL,
  PHOTO_EDITING_MASK_ADD_RADIAL_LABEL,
  PHOTO_EDITING_MASK_ADD_TITLE,
  PHOTO_EDITING_MASK_FEATHER_LABEL,
  PHOTO_EDITING_MASK_HINT_TEXT,
  PHOTO_EDITING_MASK_LIST_EMPTY_TEXT,
  PHOTO_EDITING_MASK_LIST_TITLE,
  PHOTO_EDITING_MASK_OVERLAY_KEY_HINT,
  PHOTO_EDITING_MASK_OVERLAY_LABEL,
  PHOTO_EDITING_MASK_SHAPE_TITLE,
  PHOTO_EDITING_MASK_SURFACE_TEXT,
  photoEditingMaskAdjustTitle,
  photoEditingMaskDeleteLabel,
  photoEditingMaskDuplicateLabel,
  photoEditingMaskEnabledLabel,
  photoEditingMaskInvertLabel,
  photoEditingMaskLabel,
  photoEditingMaskSelectLabel,
} from "../photo-editing-copy";
import {
  PHOTO_EDITING_MASK_ADJUST_GROUPS,
  PHOTO_EDITING_RADIAL_MASK_DEFAULT_FEATHER,
  readPhotoEditingMaskAdjust,
  type PhotoEditingMaskShapeKind,
} from "../photo-editing-masks";
import { cn } from "niho-ui/cn";

import { WHITE_BALANCE_TRACK_CLASS_NAMES, type PhotoEditingSliderPhase } from "./photo-editing-adjustment-controls";
import { PhotoEditingSlider } from "./photo-editing-slider";
import type { BrowserPhotoMaskTool } from "./use-browser-photo-masks";

const FOCUS_RING_CLASS_NAME = "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-niho-accent-ink";
const SECTION_TITLE_CLASS_NAME = "text-xs font-bold text-niho-text-muted";
const NOTE_CLASS_NAME = "text-xs leading-relaxed text-niho-text-sub";
/** 足すボタン（右パネルの幅いっぱい・高さ 32px） */
const ADD_BUTTON_CLASS_NAME = cn(
  "inline-flex h-8 w-full items-center gap-2 rounded-lg border border-niho-border px-2.5 text-xs font-bold text-niho-text transition enabled:hover:bg-niho-pale/60 disabled:cursor-not-allowed disabled:opacity-40",
  FOCUS_RING_CLASS_NAME,
);
/** 一覧の行の小さな操作（押せる範囲 24px。NIHO photo の密な画面の最小） */
const ROW_ICON_BUTTON_CLASS_NAME = cn(
  "flex h-6 w-6 shrink-0 items-center justify-center rounded-md text-niho-text-sub transition enabled:hover:bg-niho-pale/60 aria-pressed:text-niho-accent-ink disabled:cursor-not-allowed disabled:opacity-40",
  FOCUS_RING_CLASS_NAME,
);

const KIND_ICONS: Readonly<Record<string, LucideIcon>> = { linear: Rows3, radial: CircleDot };
const ADD_LABELS: Readonly<Record<PhotoEditingMaskShapeKind, string>> = {
  linear: PHOTO_EDITING_MASK_ADD_LINEAR_LABEL,
  radial: PHOTO_EDITING_MASK_ADD_RADIAL_LABEL,
};

/** 右パネルのマスクの面の値（{@link BrowserPhotoMaskTool} から必要な分だけ。テストで直接渡せる形）。 */
export type PhotoEditingMaskToolsProps = Pick<
  BrowserPhotoMaskTool,
  | "masks"
  | "selected"
  | "select"
  | "kinds"
  | "canAdd"
  | "addBlockedReason"
  | "whiteBalanceAbsolute"
  | "overlayVisible"
  | "setOverlayVisible"
  | "add"
  | "duplicate"
  | "remove"
  | "toggleEnabled"
  | "toggleInvert"
  | "changeAdjust"
  | "changeFeather"
> & { disabled: boolean };

function formatMaskAdjust(key: DevelopMaskAdjustKey, value: number): string {
  return key === "exposure" ? formatAdjustmentValue("exposure", value) : formatSignedInteger(value);
}

/**
 * 右パネルのマスクの面（部分補正。M3 #67。見出し行・↶ ↷・「初期化」は右パネルが持つ）。上から「マスクを追加」（wasm が描ける
 * 種類だけ。8 枚・原寸の書き出しが描けないときは押せず、理由を出す）、マスクの一覧（種類の印・名前・目〔当てる / 外す〕・反転・
 * 複製・削除）、範囲の重ね表示の切り替え（O）、選んだマスクの局所の補正（全体と同じ ライト／カラー／効果。値は全体への差分で
 * 0 が既定。相対の白は全体の白が `absolute` の間は出さない）と、円形のぼかし。
 */
export function PhotoEditingMaskTools(props: PhotoEditingMaskToolsProps) {
  const idPrefix = useId();
  const { masks, selected, disabled } = props;
  const selectedIndex = selected ? masks.findIndex((mask) => mask.id === selected.id) : -1;
  const selectedName = selected ? photoEditingMaskLabel(selected.kind, selectedIndex) : null;
  const overlayId = `${idPrefix}-overlay`;
  const reasonId = `${idPrefix}-add-reason`;

  const renderSlider = (
    mask: DevelopMask,
    definition: { key: DevelopMaskAdjustKey; label: string; min: number; max: number; step: number; whiteBalance: boolean },
    channel: "temperature" | "tint" | null,
  ) => {
    const value = readPhotoEditingMaskAdjust(mask, definition.key);
    return (
      <PhotoEditingSlider
        key={definition.key}
        id={`${idPrefix}-${mask.id}-${definition.key}`}
        label={definition.label}
        min={definition.min}
        max={definition.max}
        step={definition.step}
        value={value}
        valueText={formatMaskAdjust(definition.key, value)}
        disabled={disabled}
        onChange={(next: number, phase: PhotoEditingSliderPhase) => props.changeAdjust(mask.id, definition.key, next, phase)}
        onReset={() => props.changeAdjust(mask.id, definition.key, 0, "commit")}
        changed={value !== 0}
        trackClassName={channel ? WHITE_BALANCE_TRACK_CLASS_NAMES[channel] : undefined}
      />
    );
  };

  return (
    <div data-testid="photo-mask-tools" className="space-y-3 pb-2">
      <section aria-labelledby={`${idPrefix}-add`} className="space-y-1.5">
        <h3 id={`${idPrefix}-add`} className={SECTION_TITLE_CLASS_NAME}>
          {PHOTO_EDITING_MASK_ADD_TITLE}
        </h3>
        <div className="grid grid-cols-1 gap-1.5">
          {props.kinds.map((kind) => {
            const Icon = KIND_ICONS[kind] ?? CircleDot;
            return (
              <button
                key={kind}
                type="button"
                disabled={disabled || !props.canAdd}
                aria-describedby={props.addBlockedReason ? reasonId : undefined}
                onClick={() => props.add(kind)}
                className={ADD_BUTTON_CLASS_NAME}
              >
                <Icon className="h-4 w-4 shrink-0 text-niho-text-sub" aria-hidden />
                {ADD_LABELS[kind]}
              </button>
            );
          })}
        </div>
        {props.addBlockedReason ? (
          <p id={reasonId} className={NOTE_CLASS_NAME}>
            {props.addBlockedReason}
          </p>
        ) : null}
      </section>

      <section aria-labelledby={`${idPrefix}-list`} className="space-y-1">
        <h3 id={`${idPrefix}-list`} className={SECTION_TITLE_CLASS_NAME}>
          {PHOTO_EDITING_MASK_LIST_TITLE}
        </h3>
        {masks.length === 0 ? (
          <p className={NOTE_CLASS_NAME}>{PHOTO_EDITING_MASK_LIST_EMPTY_TEXT}</p>
        ) : (
          <ul className="space-y-0.5">
            {masks.map((mask, index) => {
              const name = photoEditingMaskLabel(mask.kind, index);
              const Icon = KIND_ICONS[mask.kind] ?? CircleDot;
              const isSelected = selected?.id === mask.id;
              return (
                <li
                  key={mask.id}
                  data-mask-row={mask.id}
                  className={cn(
                    "flex h-9 items-center gap-0.5 rounded-lg pr-1",
                    isSelected ? "bg-niho-accent-soft" : "hover:bg-niho-pale/60",
                  )}
                >
                  <button
                    type="button"
                    aria-pressed={isSelected}
                    aria-label={photoEditingMaskSelectLabel(name)}
                    onClick={() => props.select(isSelected ? null : mask.id)}
                    className={cn(
                      "flex h-9 min-w-0 flex-1 items-center gap-2 rounded-lg pl-2 text-left text-xs font-bold",
                      isSelected ? "text-niho-accent-ink" : "text-niho-text",
                      !mask.enabled && "opacity-50",
                      FOCUS_RING_CLASS_NAME,
                    )}
                  >
                    <Icon className="h-4 w-4 shrink-0" aria-hidden />
                    <span className="truncate">{name}</span>
                  </button>
                  <button
                    type="button"
                    aria-pressed={mask.enabled}
                    aria-label={photoEditingMaskEnabledLabel(name)}
                    title={photoEditingMaskEnabledLabel(name)}
                    disabled={disabled}
                    onClick={() => props.toggleEnabled(mask.id)}
                    className={ROW_ICON_BUTTON_CLASS_NAME}
                  >
                    {mask.enabled ? <Eye className="h-3.5 w-3.5" aria-hidden /> : <EyeOff className="h-3.5 w-3.5" aria-hidden />}
                  </button>
                  <button
                    type="button"
                    aria-pressed={mask.invert}
                    aria-label={photoEditingMaskInvertLabel(name)}
                    title={photoEditingMaskInvertLabel(name)}
                    disabled={disabled}
                    onClick={() => props.toggleInvert(mask.id)}
                    className={ROW_ICON_BUTTON_CLASS_NAME}
                  >
                    <FlipVertical2 className="h-3.5 w-3.5" aria-hidden />
                  </button>
                  <button
                    type="button"
                    aria-label={photoEditingMaskDuplicateLabel(name)}
                    title={photoEditingMaskDuplicateLabel(name)}
                    disabled={disabled || props.addBlockedReason !== null}
                    onClick={() => props.duplicate(mask.id)}
                    className={ROW_ICON_BUTTON_CLASS_NAME}
                  >
                    <Copy className="h-3.5 w-3.5" aria-hidden />
                  </button>
                  <button
                    type="button"
                    aria-label={photoEditingMaskDeleteLabel(name)}
                    title={photoEditingMaskDeleteLabel(name)}
                    disabled={disabled}
                    onClick={() => props.remove(mask.id)}
                    className={ROW_ICON_BUTTON_CLASS_NAME}
                  >
                    <Trash2 className="h-3.5 w-3.5" aria-hidden />
                  </button>
                </li>
              );
            })}
          </ul>
        )}
      </section>

      <button
        id={overlayId}
        type="button"
        role="switch"
        aria-checked={props.overlayVisible}
        aria-keyshortcuts="O"
        onClick={() => props.setOverlayVisible(!props.overlayVisible)}
        className={cn("flex min-h-8 w-full items-center justify-between gap-2 rounded text-left", FOCUS_RING_CLASS_NAME)}
      >
        <span className="text-xs font-bold text-niho-text-sub">
          {PHOTO_EDITING_MASK_OVERLAY_LABEL}
          <span aria-hidden className="ml-1.5 font-normal text-niho-text-muted">
            {PHOTO_EDITING_MASK_OVERLAY_KEY_HINT}
          </span>
        </span>
        <span
          aria-hidden
          className={cn(
            "relative h-5 w-9 shrink-0 rounded-full motion-safe:transition-colors",
            props.overlayVisible ? "bg-niho-accent-ink" : "bg-niho-text-muted/50",
          )}
        >
          <span
            className={cn(
              "absolute left-0.5 top-0.5 h-4 w-4 rounded-full bg-white shadow-sm motion-safe:transition-transform",
              props.overlayVisible ? "translate-x-4" : "translate-x-0",
            )}
          />
        </span>
      </button>

      {selected && selectedName ? (
        <section aria-labelledby={`${idPrefix}-selected`} className="space-y-1" data-testid="photo-mask-adjust">
          <h3 id={`${idPrefix}-selected`} className="text-sm font-bold text-niho-text">
            {photoEditingMaskAdjustTitle(selectedName)}
          </h3>
          {selected.kind !== "linear" && selected.kind !== "radial" ? (
            <p className={NOTE_CLASS_NAME}>{PHOTO_EDITING_MASK_SURFACE_TEXT}</p>
          ) : (
            <p className={NOTE_CLASS_NAME}>{PHOTO_EDITING_MASK_HINT_TEXT}</p>
          )}
          {PHOTO_EDITING_MASK_ADJUST_GROUPS.map((group) => {
            const adjustments = group.adjustments.filter((definition) => !(definition.whiteBalance && props.whiteBalanceAbsolute));
            if (adjustments.length === 0) return null;
            return (
              <div key={group.id} role="group" aria-labelledby={`${idPrefix}-group-${group.id}`} className="pt-1">
                <h4 id={`${idPrefix}-group-${group.id}`} className={cn(SECTION_TITLE_CLASS_NAME, "py-1")}>
                  {group.title}
                </h4>
                {adjustments.map((definition) =>
                  renderSlider(
                    selected,
                    definition,
                    definition.key === "relativeTemperature" ? "temperature" : definition.key === "relativeTint" ? "tint" : null,
                  ),
                )}
              </div>
            );
          })}
          {selected.kind === "radial" ? (
            <div role="group" aria-labelledby={`${idPrefix}-shape`} className="pt-1">
              <h4 id={`${idPrefix}-shape`} className={cn(SECTION_TITLE_CLASS_NAME, "py-1")}>
                {PHOTO_EDITING_MASK_SHAPE_TITLE}
              </h4>
              <PhotoEditingSlider
                id={`${idPrefix}-${selected.id}-feather`}
                label={PHOTO_EDITING_MASK_FEATHER_LABEL}
                min={0}
                max={100}
                step={1}
                value={selected.feather}
                valueText={String(Math.round(selected.feather))}
                disabled={disabled}
                onChange={(next, phase) => props.changeFeather(selected.id, next, phase)}
                onReset={() => props.changeFeather(selected.id, PHOTO_EDITING_RADIAL_MASK_DEFAULT_FEATHER, "commit")}
                changed={selected.feather !== PHOTO_EDITING_RADIAL_MASK_DEFAULT_FEATHER}
              />
            </div>
          ) : null}
        </section>
      ) : null}
    </div>
  );
}
