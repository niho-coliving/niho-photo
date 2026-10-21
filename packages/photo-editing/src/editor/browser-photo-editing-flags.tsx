"use client";

import { CircleX, Flag, FlagOff, type LucideIcon } from "lucide-react";
import { cn } from "niho-ui/cn";

import type { PhotoLibraryFlag } from "../library/photo-library";
import {
  PHOTO_EDITING_FLAG_CLEAR_LABEL,
  PHOTO_EDITING_FLAG_GROUP_LABEL,
  PHOTO_EDITING_FLAG_PICK_LABEL,
  PHOTO_EDITING_FLAG_REJECT_LABEL,
  PHOTO_EDITING_FLAG_TITLES,
} from "../photo-editing-copy";

/** 選別の操作に渡すもの（面が選んでいる写真・開いている 1 枚から決める。キー P / X / U と同じ写真が対象）。 */
export type BrowserPhotoFlagControl = {
  /** 対象の写真のフラグ（全部同じならその値、混ざっていれば `mixed`。対象が無ければ null） */
  flag: PhotoLibraryFlag | null | "mixed";
  /** 対象の写真がある（何も選んでいない・追加中・記事の画像だけなら false） */
  available: boolean;
  /** 送っている間（2 回目を受けない） */
  busy: boolean;
  /** 閲覧のみ・書き出し・一括の操作の途中 */
  disabled: boolean;
  /** フラグを付ける（null は外す） */
  onSet: (flag: PhotoLibraryFlag | null) => void;
};

/** 選別の印（タイル・帯の升の右下と、下段のボタン）。形で見分ける（採用は旗、却下は丸に ×）。色だけに頼らない */
export const BROWSER_PHOTO_FLAG_ICONS: Readonly<Record<PhotoLibraryFlag, LucideIcon>> = { pick: Flag, reject: CircleX };

/** 印の読み上げ名（タイル・帯の升） */
export const BROWSER_PHOTO_FLAG_LABELS: Readonly<Record<PhotoLibraryFlag, string>> = {
  pick: PHOTO_EDITING_FLAG_PICK_LABEL,
  reject: PHOTO_EDITING_FLAG_REJECT_LABEL,
};

/**
 * タイル・帯の升の選別の印（niho-photo#47。黒の地に白の形。採用は塗った旗、却下は丸に ×）。置く位置は `className`（`absolute` の
 * 位置）で決める。読み上げは「採用」「却下」。
 */
export function BrowserPhotoFlagMark(props: { flag: PhotoLibraryFlag; small?: boolean; className?: string }) {
  const Icon = BROWSER_PHOTO_FLAG_ICONS[props.flag];
  return (
    <span
      className={cn(
        "absolute flex items-center justify-center rounded-md bg-black/60 text-white",
        props.small ? "h-4 w-4" : "h-[18px] w-[18px]",
        props.className,
      )}
    >
      <Icon
        className={props.small ? "h-2.5 w-2.5" : "h-3 w-3"}
        fill={props.flag === "pick" ? "currentColor" : "none"}
        strokeWidth={2.5}
        aria-hidden
      />
      <span className="sr-only">{BROWSER_PHOTO_FLAG_LABELS[props.flag]}</span>
    </span>
  );
}

const BUTTON_CLASS_NAME =
  "relative flex h-11 w-11 shrink-0 items-center justify-center rounded-full transition focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-niho-accent-ink disabled:cursor-not-allowed";
const IDLE_CLASS_NAME = "text-niho-text-muted enabled:hover:bg-niho-pale/60 enabled:hover:text-niho-text-sub";

/**
 * 下段の選別の小さなボタン（niho-photo#47。PC の下段の ♥ の隣）。採用・却下は押すと付き、付いている方をもう一度押すと外れる
 * （aria-pressed）。「外す」は付いているときだけ押せる。キーは P / X / U（title で案内。キーは押し直しても入れ替えない）。複数枚を
 * 選んでいるときは、全部に付いている方を押した状態で出す。
 */
export function BrowserPhotoFlagButtons(props: BrowserPhotoFlagControl & { className?: string }) {
  const unavailable = !props.available || props.disabled;
  const inactive = unavailable || props.busy;
  const toggle = (flag: PhotoLibraryFlag) => props.onSet(props.flag === flag ? null : flag);
  const button = (kind: PhotoLibraryFlag) => {
    const Icon = BROWSER_PHOTO_FLAG_ICONS[kind];
    const pressed = props.available && props.flag === kind;
    return (
      <button
        type="button"
        aria-label={BROWSER_PHOTO_FLAG_LABELS[kind]}
        title={PHOTO_EDITING_FLAG_TITLES[kind]}
        aria-pressed={pressed}
        disabled={inactive}
        onClick={() => toggle(kind)}
        className={cn(BUTTON_CLASS_NAME, pressed ? "bg-niho-accent-soft text-niho-accent-ink" : IDLE_CLASS_NAME)}
      >
        <Icon className="h-[18px] w-[18px]" fill={pressed && kind === "pick" ? "currentColor" : "none"} aria-hidden />
      </button>
    );
  };
  return (
    <div
      role="group"
      aria-label={PHOTO_EDITING_FLAG_GROUP_LABEL}
      aria-busy={props.busy || undefined}
      className={cn("flex shrink-0 items-center", unavailable && "opacity-40", props.className)}
    >
      {button("pick")}
      {button("reject")}
      <button
        type="button"
        aria-label={PHOTO_EDITING_FLAG_CLEAR_LABEL}
        title={PHOTO_EDITING_FLAG_TITLES.clear}
        disabled={inactive || props.flag === null}
        onClick={() => props.onSet(null)}
        className={cn(BUTTON_CLASS_NAME, IDLE_CLASS_NAME)}
      >
        <FlagOff className="h-[18px] w-[18px]" aria-hidden />
      </button>
    </div>
  );
}
