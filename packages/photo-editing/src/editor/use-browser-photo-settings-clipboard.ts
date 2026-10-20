"use client";

import type { MutableRefObject } from "react";

import {
  copyDevelopSettings,
  pasteDevelopSettings,
  type DevelopSettings,
} from "../develop-engine/develop-settings";
import { PHOTO_EDITING_COPY_SETTINGS_DONE_TEXT } from "../photo-editing-copy";
import {
  usePhotoEditingSettingsClipboard,
  writePhotoEditingSettingsClipboard,
} from "../photo-editing-settings-clipboard";

import type { FooterStatus } from "./browser-photo-editing-model";

/**
 * 1 枚の面の「補正をコピー」「補正を貼り付け」（F5a-2 移行元設計。右パネルの ⋯ メニューと ⇧⌘C / ⇧⌘V）。
 *
 * - コピー: 今の編集内容から、幾何（切り抜き・回転）と RAW の絶対のホワイトバランスを除いた色の補正を写す
 *   （`copyDevelopSettings`）。wasm で開いて 1 枚で見ている間なら、閲覧のみでも写せる。状態欄に「補正をコピーしました」
 * - 貼り付け: 写した補正を今の編集内容に当て（`pasteDevelopSettings`）、取り消しの 1 単位として確定する（自動保存へ）。直せる
 *   ときだけ。一覧で選んだ複数枚への貼り付けは、同じ置き場から一括で当てる（`use-browser-photo-bulk.ts`）
 */
export function useBrowserPhotoSettingsClipboard(params: {
  /** wasm で開いて 1 枚で見ている写真の key（ほかは null。写せない・当てられない） */
  photoKey: string | null;
  /** 当てられない（閲覧のみ・書き出し / 消している途中・離れる処理の途中） */
  disabled: boolean;
  settingsRef: MutableRefObject<DevelopSettings>;
  /** 取り消しの 1 単位として編集内容を確定する（直せなければ false） */
  commitEdit: (next: DevelopSettings) => boolean;
  setStatus: (status: FooterStatus | null) => void;
}) {
  const { photoKey, disabled, settingsRef, commitEdit, setStatus } = params;
  const stored = usePhotoEditingSettingsClipboard();
  const canCopy = photoKey !== null;
  const canPaste = photoKey !== null && !disabled && stored !== null;

  const copy = () => {
    if (!canCopy) return;
    writePhotoEditingSettingsClipboard(copyDevelopSettings(settingsRef.current));
    setStatus({ kind: "notice", text: PHOTO_EDITING_COPY_SETTINGS_DONE_TEXT });
  };

  const paste = () => {
    if (!canPaste || !stored) return;
    commitEdit(pasteDevelopSettings(settingsRef.current, stored.settings));
  };

  return { canCopy, canPaste, copy, paste };
}

export type BrowserPhotoSettingsClipboard = ReturnType<typeof useBrowserPhotoSettingsClipboard>;
