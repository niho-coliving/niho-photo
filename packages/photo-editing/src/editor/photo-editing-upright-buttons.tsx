"use client";

import { useId } from "react";

import type { DevelopUprightMode } from "../develop-engine/develop-upright";
import {
  PHOTO_EDITING_UPRIGHT_BUTTONS,
  PHOTO_EDITING_UPRIGHT_FAILED_TEXT,
  PHOTO_EDITING_UPRIGHT_NOT_FOUND_TEXT,
  PHOTO_EDITING_UPRIGHT_TITLE,
  photoEditingUprightAppliedText,
} from "../photo-editing-copy";
import { cn } from "niho-ui/cn";

const FOCUS_RING_CLASS_NAME = "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-niho-accent-ink";

/** Upright の結果の知らせ（見つからなかった・失敗した・ボタン `mode` で当てた）。 */
export type PhotoEditingUprightStatus =
  | { kind: "notFound" }
  | { kind: "failed" }
  | { kind: "applied"; mode: DevelopUprightMode };

/** Upright のボタンの状態と操作（`useBrowserPhotoCrop` の `upright`）。 */
export type PhotoEditingUprightControl = {
  /** 押しているボタン（`geometry.upright`。無ければ 0） */
  pressed: DevelopUprightMode | 0;
  /** 推定している間（4 つとも押せない） */
  busy: boolean;
  status: PhotoEditingUprightStatus | null;
  run: (mode: DevelopUprightMode) => void;
};

/**
 * 切り抜きの道具の「ジオメトリ」の節の先頭の Upright（niho-photo#46 後半。Lightroom の 自動 / 水平 / 垂直 / フル）。
 *
 * - 4 つのボタンを 1 行に並べる（高さ 44px）。押しているボタンは `aria-pressed`。読み上げ名は「名前（何を直すか）」
 * - 推定している間は 4 つとも押せない（`aria-busy`）。線が見つからない・失敗したときは下に控えめな 1 行（`role="status"`）
 * - 当てたときは画面の変化で分かるので文言は出さず、読み上げだけ（`aria-live="polite"`）
 */
export function PhotoEditingUprightButtons(props: { control: PhotoEditingUprightControl; disabled: boolean }) {
  const { control } = props;
  const titleId = useId();
  const status = control.status;
  const notice =
    status?.kind === "notFound"
      ? PHOTO_EDITING_UPRIGHT_NOT_FOUND_TEXT
      : status?.kind === "failed"
        ? PHOTO_EDITING_UPRIGHT_FAILED_TEXT
        : null;
  return (
    <div className="pb-2" data-testid="photo-upright">
      <p id={titleId} className="pb-1 text-xs font-bold text-niho-text-muted">
        {PHOTO_EDITING_UPRIGHT_TITLE}
      </p>
      <div role="group" aria-labelledby={titleId} aria-busy={control.busy} className="flex gap-1.5">
        {PHOTO_EDITING_UPRIGHT_BUTTONS.map(({ mode, label, description }) => {
          const pressed = control.pressed === mode;
          return (
            <button
              key={mode}
              type="button"
              aria-pressed={pressed}
              aria-label={`${label}（${description}）`}
              title={description}
              disabled={props.disabled || control.busy}
              onClick={() => control.run(mode)}
              className={cn(
                "flex h-11 min-w-0 flex-1 items-center justify-center rounded-lg border text-xs font-bold transition disabled:cursor-not-allowed disabled:opacity-50",
                FOCUS_RING_CLASS_NAME,
                pressed
                  ? "border-niho-accent-ink bg-niho-accent-soft text-niho-accent-ink"
                  : "border-niho-border bg-white text-niho-text-sub enabled:hover:bg-niho-pale/60 enabled:hover:text-niho-text",
              )}
            >
              {label}
            </button>
          );
        })}
      </div>
      {notice ? (
        <p role="status" className="pt-1.5 text-xs leading-relaxed text-niho-text-sub">
          {notice}
        </p>
      ) : null}
      <p aria-live="polite" className="sr-only">
        {status?.kind === "applied" ? photoEditingUprightAppliedText(status.mode) : ""}
      </p>
    </div>
  );
}
