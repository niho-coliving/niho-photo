"use client";

import { useId, type ReactNode } from "react";

import type { PhotoEditingPhoto, PhotoEditingSettings } from "../photo-editing-types";
import { PHOTO_EDITING_BASIC_ADJUSTMENTS_TITLE, PHOTO_EDITING_RESET_LABEL } from "../photo-editing-copy";
import { cn } from "niho-ui/cn";

import {
  PhotoEditingAdjustmentGroups,
  type PhotoEditingSettingsUpdate,
  type PhotoEditingSliderPhase,
} from "./photo-editing-adjustment-controls";

// スライダーと設定の書き換えの型は共通の部品にある（NIHO Desktop の面はここから読む）
export type { PhotoEditingSettingsUpdate, PhotoEditingSliderPhase } from "./photo-editing-adjustment-controls";

/**
 * 右の面の「基本補正」。写真を選んでいないときは操作できない。スライダーは 1 枚（編集）の表示中の写真にだけ効くので、
 * グリッドの間（`inactive`）は薄くして押せなくする（移行元設計）。群とスライダーはブラウザ版と共通の部品で描く（移行元設計）。
 */
export function PhotoEditingAdjustmentsPanel(props: {
  photo: PhotoEditingPhoto | null;
  settings: PhotoEditingSettings | null;
  /** 開いたときから変えたか（初期化を出すかどうか） */
  edited: boolean;
  /** グリッドの間（薄くして押せない） */
  inactive?: boolean;
  /**
   * 見出しの下に出す 1 行（段 2 の作業コピーを待っている間の「RAW の現像を準備中」／「編集の準備中」と「再試行」。移行元設計 S7b）。
   * その間は `settings` を渡さず、スライダーを薄くする
   */
  notice?: ReactNode;
  onSettingsChange: (update: PhotoEditingSettingsUpdate, phase: PhotoEditingSliderPhase) => void;
  onReset: () => void;
}) {
  const idPrefix = useId();
  const disabled = !props.photo || !props.settings || props.inactive === true;

  return (
    <section
      aria-labelledby={`${idPrefix}-heading`}
      className={cn(
        "px-4 pb-6 pt-4 motion-safe:transition-opacity",
        props.inactive ? "pointer-events-none opacity-40" : null,
      )}
    >
      <div className="flex min-h-9 items-center justify-between gap-2">
        <h3 id={`${idPrefix}-heading`} className="text-sub font-bold text-niho-text">
          {PHOTO_EDITING_BASIC_ADJUSTMENTS_TITLE}
        </h3>
        {props.edited && !disabled ? (
          <button
            type="button"
            onClick={props.onReset}
            className="min-h-9 rounded-full px-3 text-xs font-bold text-niho-text-sub transition hover:bg-niho-pale/60 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-niho-accent-ink"
          >
            {PHOTO_EDITING_RESET_LABEL}
          </button>
        ) : null}
      </div>
      {props.notice ?? null}
      <PhotoEditingAdjustmentGroups
        idPrefix={idPrefix}
        settings={props.settings}
        photo={props.photo}
        disabled={disabled}
        onSettingsChange={props.onSettingsChange}
      />
    </section>
  );
}
