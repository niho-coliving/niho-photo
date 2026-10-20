"use client";

import type { LucideIcon } from "lucide-react";

import { PHOTO_EDITING_TOOL_RAIL_LABEL } from "../photo-editing-copy";
import { cn } from "niho-ui/cn";

/** 道具の帯の 1 つ（`label` は読み上げ名と `title` に出す日本語の名前）。 */
export type BrowserPhotoEditingToolRailItem = {
  key: string;
  label: string;
  icon: LucideIcon;
  pressed: boolean;
  disabled: boolean;
  onSelect: () => void;
};

const TOOL_RAIL_BUTTON_CLASS_NAME =
  "flex h-[34px] w-[34px] shrink-0 items-center justify-center rounded-lg transition focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-niho-accent-ink disabled:cursor-not-allowed disabled:opacity-40 disabled:hover:bg-transparent";

/**
 * ブラウザ版の右端の道具の帯（niho-photo#51。Lightroom のデスクトップ版と同じ）。PC の幅だけ右パネルの右に縦に並べ、押した道具で
 * 右パネルを丸ごと入れ替える。並べる道具と押せるかは呼ぶ側が決める（その写真で使える道具だけ）。押している道具をもう一度押しても
 * 何もしない（今の面のまま）。
 */
export function BrowserPhotoEditingToolRail(props: { items: ReadonlyArray<BrowserPhotoEditingToolRailItem> }) {
  return (
    <nav
      aria-label={PHOTO_EDITING_TOOL_RAIL_LABEL}
      className="hidden min-h-0 flex-col items-center gap-1 border-l border-niho-border bg-[var(--photo-editing-surface,white)] py-2 lg:flex"
    >
      {props.items.map((item) => {
        const Icon = item.icon;
        return (
          <button
            key={item.key}
            type="button"
            aria-label={item.label}
            title={item.label}
            aria-pressed={item.pressed}
            disabled={item.disabled}
            onClick={() => {
              if (!item.pressed) item.onSelect();
            }}
            className={cn(
              TOOL_RAIL_BUTTON_CLASS_NAME,
              item.pressed ? "bg-niho-accent-soft text-niho-accent-ink" : "text-niho-text-sub hover:bg-niho-pale/60",
            )}
          >
            <Icon className="h-[18px] w-[18px]" aria-hidden />
          </button>
        );
      })}
    </nav>
  );
}
