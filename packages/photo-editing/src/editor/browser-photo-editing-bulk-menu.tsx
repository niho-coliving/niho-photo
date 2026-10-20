"use client";

import { ChevronDown } from "lucide-react";

import {
  PHOTO_EDITING_BULK_MENU_LABEL,
  PHOTO_EDITING_BULK_PASTE_NEEDS_COPY_TEXT,
  PHOTO_EDITING_BULK_PRESETS_FAILED_TEXT,
  PHOTO_EDITING_BULK_PRESETS_LOADING_TEXT,
  PHOTO_EDITING_BULK_STOP_LABEL,
  PHOTO_EDITING_BULK_STOPPING_LABEL,
  PHOTO_EDITING_COPY_SETTINGS_LABEL,
  PHOTO_EDITING_PASTE_SETTINGS_LABEL,
  PHOTO_EDITING_PASTE_SETTINGS_SHORTCUT,
  PHOTO_EDITING_PRESETS_TITLE,
  PHOTO_EDITING_SPOT_PRESETS_TITLE,
} from "../photo-editing-copy";
import { cn } from "niho-ui/cn";

import { BROWSER_PHOTO_SELECTION_BAR_BUTTON_CLASS_NAME } from "./browser-photo-editing-selection-bar";
import { PhotoEditingMenu, type PhotoEditingMenuEntry } from "./photo-editing-menu";
import type { PhotoEditingPresetTarget } from "./photo-editing-presets-panel";

/**
 * PC のブラウザ版の選択バー（2 枚以上選んでいる間）の「補正」（F5a-2 移行元設計）。押すと下にメニューを重ねて出す（右パネルは出さず、
 * 一覧の列数を動かさない）: 「補正を貼り付け ⌥⇧⌘V」（何もコピーしていなければ押せず、理由を 1 行）、区切り、見出し「プリセット」と
 * 同梱のプリセット（日本語名）・小見出し「拠点のプリセット」と拠点のプリセット（1 枚の面の右パネルの節と同じデータ源・並び・名前）。
 * 「なし」は出さない（一括で補正を消す入口は作らない）。プリセットの口の無い wasm では、プリセットの群ごと出さない（`presets` が null）。
 * 処理中は同じ場所のボタンを「止める」にする（押すと、走っている写真を終えてから止める）。
 */

/** メニューのプリセットの群（null は出さない＝口の無い wasm・確かめられない）。 */
export type BrowserPhotoBulkMenuPresets =
  | { status: "loading" }
  | {
      status: "ready";
      builtin: PhotoEditingPresetTarget[];
      /** 同梱のプリセットを読めなかった */
      builtinFailed: boolean;
      spot: PhotoEditingPresetTarget[];
      spotStatus: "loading" | "ready" | "failed";
    };

export type BrowserPhotoBulkMenuProps = {
  /** 狭い幅では選択バーの操作を 1 つに畳む（コピー／貼り付けと既存の一括操作）。 */
  compact: boolean;
  /** 一括（元に戻すを含む）が走っている（ボタンは「止める」） */
  running: boolean;
  /** 止めた後、走っている写真を終えるのを待っている */
  stopping: boolean;
  /** ほかの操作の途中（書き出し・お気に入り・別の端末の補正の読み直し）で押せない */
  disabled: boolean;
  /** コピーした補正がある（貼り付けを押せる） */
  canPaste: boolean;
  pasteUnavailableReason?: string;
  /** 選んだ 1 枚から保存済みの補正をコピーできる。狭い幅のメニューだけで使う。 */
  canCopy: boolean;
  copyUnavailableReason?: string;
  presets: BrowserPhotoBulkMenuPresets | null;
  compactActions?: Array<{
    key: string;
    label: string;
    disabled?: boolean;
    opensDialog?: boolean;
    onSelect: () => void;
  }>;
  /** メニューを開いた・閉じた（開いてからプリセットを読み始める） */
  onOpenChange: (open: boolean) => void;
  onCopy: () => void;
  onPaste: () => void;
  onApplyPreset: (preset: PhotoEditingPresetTarget) => void;
  onStop: () => void;
};

function presetEntries(presets: BrowserPhotoBulkMenuPresets, onApply: (preset: PhotoEditingPresetTarget) => void): PhotoEditingMenuEntry[] {
  const entries: PhotoEditingMenuEntry[] = [
    { kind: "separator", key: "presets-separator" },
    { kind: "heading", key: "presets-heading", label: PHOTO_EDITING_PRESETS_TITLE },
  ];
  if (presets.status === "loading") {
    entries.push({ kind: "note", key: "presets-loading", text: PHOTO_EDITING_BULK_PRESETS_LOADING_TEXT });
    return entries;
  }
  for (const preset of presets.builtin) {
    entries.push({ key: preset.key, label: preset.name, onSelect: () => onApply(preset) });
  }
  if (presets.spot.length > 0) {
    entries.push({ kind: "heading", key: "spot-presets-heading", label: PHOTO_EDITING_SPOT_PRESETS_TITLE });
    for (const preset of presets.spot) {
      entries.push({ key: preset.key, label: preset.name, onSelect: () => onApply(preset) });
    }
  }
  if (presets.spotStatus === "loading") {
    entries.push({ kind: "note", key: "spot-presets-loading", text: PHOTO_EDITING_BULK_PRESETS_LOADING_TEXT });
  } else if (presets.spotStatus === "failed" || (presets.builtinFailed && presets.builtin.length === 0)) {
    entries.push({ kind: "note", key: "presets-failed", text: PHOTO_EDITING_BULK_PRESETS_FAILED_TEXT, tone: "danger" });
  }
  return entries;
}

export function BrowserPhotoEditingBulkMenu(props: BrowserPhotoBulkMenuProps) {
  const items: PhotoEditingMenuEntry[] = [
    ...(props.compact
      ? [
          {
            key: "copy",
            label: PHOTO_EDITING_COPY_SETTINGS_LABEL,
            disabled: !props.canCopy,
            reason: props.canCopy ? undefined : props.copyUnavailableReason,
            onSelect: props.onCopy,
          } satisfies PhotoEditingMenuEntry,
        ]
      : []),
    {
      key: "paste",
      label: PHOTO_EDITING_PASTE_SETTINGS_LABEL,
      shortcut: props.compact ? undefined : PHOTO_EDITING_PASTE_SETTINGS_SHORTCUT,
      disabled: !props.canPaste,
      reason: props.canPaste ? undefined : (props.pasteUnavailableReason ?? PHOTO_EDITING_BULK_PASTE_NEEDS_COPY_TEXT),
      onSelect: props.onPaste,
    },
    ...(props.compactActions && props.compactActions.length > 0
      ? [
          { kind: "separator", key: "compact-actions-separator" } satisfies PhotoEditingMenuEntry,
          ...props.compactActions,
        ]
      : []),
    ...(props.presets ? presetEntries(props.presets, props.onApplyPreset) : []),
  ];
  const label = props.stopping
    ? PHOTO_EDITING_BULK_STOPPING_LABEL
    : props.running
      ? PHOTO_EDITING_BULK_STOP_LABEL
      : props.compact
        ? "操作"
        : PHOTO_EDITING_BULK_MENU_LABEL;
  return (
    <PhotoEditingMenu items={items} variant="browser" onOpenChange={props.onOpenChange}>
      <button
        type="button"
        // 処理中は「止める」（メニューは開かない）。開く前の読み上げは「補正」＋メニューがある
        aria-haspopup={props.running ? undefined : "menu"}
        disabled={props.stopping || (!props.running && props.disabled)}
        onClick={(event) => {
          if (!props.running) return;
          // メニューを開かせずに止める（Radix の開閉は `defaultPrevented` を見て動かない）
          event.preventDefault();
          props.onStop();
        }}
        className={cn(BROWSER_PHOTO_SELECTION_BAR_BUTTON_CLASS_NAME, "gap-0.5 text-niho-accent-ink")}
      >
        {label}
        {props.running ? null : <ChevronDown className="h-3.5 w-3.5" aria-hidden />}
      </button>
    </PhotoEditingMenu>
  );
}
