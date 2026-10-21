"use client";

import { useEffect, useRef, type RefObject } from "react";

import type { PhotoLibraryFlag } from "../library/photo-library";
import {
  isPhotoEditingTypingTarget,
  isWithinPhotoEditingScope,
  type PhotoEditingShortcutKeyEvent,
} from "../use-photo-editing-shortcuts";

/**
 * 選別のキー（niho-photo#47。Lightroom と同じ）: `P` = 採用、`X` = 却下、`U` = 外す。一覧（グリッド）でも 1 枚（フィルムストリップの
 * ある編集中）でも同じ。押すたびに入れ替えはしない（P は採用を付けるだけで、採用の写真に押しても何も変わらない。外すのは U）。
 *
 * - Shift・CapsLock の大文字も同じキー。⌘ ⌃ ⌥ つきは扱わない（⌘X・⌘P などは今までどおり）
 * - 画面の中か、どこにもフォーカスが無いときだけ扱う。文字を打つ欄・IME の変換中・ほかの処理が既に使ったキー（`defaultPrevented`。
 *   写真の上のキーを使う道具が自分のキーを先に扱ったもの）は扱わない。押しっぱなしの繰り返しは扱わない（既定の動きだけ止める）
 * - タイル・帯の升（ボタン）にフォーカスがあっても扱う（ボタンには P / X / U の働きが無い）
 */
export type BrowserPhotoFlagKey = PhotoLibraryFlag | "clear";

/** 押されたキーが選別のどのキーか（扱わなければ null）。 */
export function resolveBrowserPhotoFlagKey(
  event: PhotoEditingShortcutKeyEvent,
  target: { typing: boolean },
): BrowserPhotoFlagKey | null {
  if (event.defaultPrevented || event.isComposing || target.typing) return null;
  if (event.metaKey || event.ctrlKey || event.altKey) return null;
  switch (event.key) {
    case "p":
    case "P":
      return "pick";
    case "x":
    case "X":
      return "reject";
    case "u":
    case "U":
      return "clear";
    default:
      return null;
  }
}

/**
 * 選別のキーを聞く（document の keydown）。`enabled` が false の間は listener を外す（選別を持たない写真の出どころ・閲覧のみ・
 * 操作中・書き出しのシートの間・スマホ）。`onFlag` は付けるフラグ（外すのは null）を受け取る。
 */
export function useBrowserPhotoFlagKeys(options: {
  rootRef: RefObject<HTMLElement | null>;
  enabled: boolean;
  onFlag: (flag: PhotoLibraryFlag | null) => void;
}): void {
  const { rootRef, enabled } = options;
  const onFlagRef = useRef(options.onFlag);
  onFlagRef.current = options.onFlag;
  useEffect(() => {
    if (!enabled) return;
    const handleKeyDown = (event: KeyboardEvent) => {
      const root = rootRef.current;
      if (!root || !isWithinPhotoEditingScope(root, event.target)) return;
      const key = resolveBrowserPhotoFlagKey(event, { typing: isPhotoEditingTypingTarget(event.target) });
      if (key === null) return;
      event.preventDefault();
      if (event.repeat) return;
      onFlagRef.current(key === "clear" ? null : key);
    };
    document.addEventListener("keydown", handleKeyDown);
    return () => document.removeEventListener("keydown", handleKeyDown);
  }, [enabled, rootRef]);
}
