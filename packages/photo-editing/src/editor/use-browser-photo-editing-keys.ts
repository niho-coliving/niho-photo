"use client";

import { useEffect, useRef, type RefObject } from "react";

import {
  isPhotoEditingTypingTarget,
  isWithinPhotoEditingScope,
  type PhotoEditingShortcutKeyEvent,
} from "../use-photo-editing-shortcuts";

/**
 * ブラウザ版の 1 枚の編集のキー（NIHO Photo 段 1 F1 移行元設計。写真編集の画面のキー `usePhotoEditingShortcuts` とは別に聞く）。
 *
 * - ⌘Z / ⇧⌘Z（Windows などは Ctrl+Z / Ctrl+Shift+Z）= 取り消す / やり直す
 * - ⌥⇧⌘C / ⌥⇧⌘V（Ctrl+Alt+Shift+C / Ctrl+Alt+Shift+V）= 補正をコピー / 貼り付け（F5a-2 移行元設計）。Chrome の DevTools と
 *   重ならない組み合わせにする。Shift の無い ⌘C / ⌘V はブラウザの
 *   コピー・貼り付けのまま（横取りしない）
 * - `\`（JIS 配列では `¥` で来る）を押している間だけ補正前を見せる。押しっぱなしの繰り返しは無視し、離したら・窓がフォーカスを
 *   失ったら戻す。切り抜きの道具の間（`compareEnabled` が false）は効かない
 * - `R` = 「補正」と「切り抜き」の道具を切り替える（F3b 移行元設計。切り替えを出していない間〔`onToggleTool` が無い〕は扱わない）
 *
 * 画面の中か、どこにもフォーカスが無いときだけ扱う。文字を打つ欄（値の直接入力の欄など）・IME の変換中・ほかの処理が既に
 * 使ったキー（`defaultPrevented`）は扱わない。
 */
export type BrowserPhotoEditingKey = "undo" | "redo" | "compare" | "tool" | "copy" | "paste";

const COMPARE_KEYS: ReadonlySet<string> = new Set(["\\", "¥"]);

/** 押されたキーがどれか（扱わなければ null）。 */
export function resolveBrowserPhotoEditingKey(
  event: PhotoEditingShortcutKeyEvent,
  target: { typing: boolean },
): BrowserPhotoEditingKey | null {
  if (event.defaultPrevented || event.isComposing || target.typing) return null;
  if (event.metaKey || event.ctrlKey) {
    const key = event.key.toLowerCase();
    if (key === "z") return event.altKey ? null : event.shiftKey ? "redo" : "undo";
    if (!event.shiftKey || !event.altKey) return null;
    if (key === "c") return "copy";
    if (key === "v") return "paste";
    return null;
  }
  if (COMPARE_KEYS.has(event.key)) return "compare";
  return !event.altKey && (event.key === "r" || event.key === "R") ? "tool" : null;
}

/**
 * `enabled` は補正操作全般、`clipboardEnabled` はコピー / 貼り付け用キーを聞く条件（閲覧のみのコピーを含む）。どちらも無効なら
 * listener を外す。補正操作をやめたとき、補正前を見せていれば戻す。
 */
export function useBrowserPhotoEditingKeys(options: {
  rootRef: RefObject<HTMLElement | null>;
  enabled: boolean;
  /** コピー / 貼り付け用キーは閲覧のみでもコピーできるため編集操作とは別に有効化する */
  clipboardEnabled?: boolean;
  onUndo: () => void;
  onRedo: () => void;
  /** 補正をコピー / 貼り付け（F5a-2 移行元設計。写せない・当てられないときは呼ばれた側が何もしない） */
  onCopy: () => void;
  onPaste: () => void;
  onCompareOriginalChange: (compare: boolean) => void;
  /** 補正前のキーを扱うか（省くと true。切り抜きの道具の間は false） */
  compareEnabled?: boolean;
  /** `R` で道具を切り替える（切り替えを出していない間は null。省くと扱わない） */
  onToggleTool?: (() => void) | null;
}): void {
  const { rootRef, enabled, clipboardEnabled = false } = options;
  const callbacksRef = useRef(options);
  useEffect(() => {
    callbacksRef.current = options;
  });

  useEffect(() => {
    if (!enabled && !clipboardEnabled) return;
    let comparing = false;
    const release = () => {
      if (!comparing) return;
      comparing = false;
      callbacksRef.current.onCompareOriginalChange(false);
    };
    const handleKeyDown = (event: KeyboardEvent) => {
      const root = rootRef.current;
      if (!root || !isWithinPhotoEditingScope(root, event.target)) return;
      const key = resolveBrowserPhotoEditingKey(event, { typing: isPhotoEditingTypingTarget(event.target) });
      if (key === null) return;
      if (key === "copy" || key === "paste") {
        if (!callbacksRef.current.clipboardEnabled) return;
        event.preventDefault();
        if (event.repeat) return;
        if (key === "copy") callbacksRef.current.onCopy();
        else callbacksRef.current.onPaste();
        return;
      }
      if (!callbacksRef.current.enabled) return;
      if (key === "tool") {
        const toggleTool = callbacksRef.current.onToggleTool;
        if (!toggleTool) return;
        event.preventDefault();
        if (!event.repeat) toggleTool();
        return;
      }
      if (key === "compare" && callbacksRef.current.compareEnabled === false) return;
      event.preventDefault();
      if (key === "compare") {
        if (event.repeat || comparing) return;
        comparing = true;
        callbacksRef.current.onCompareOriginalChange(true);
        return;
      }
      if (key === "undo") callbacksRef.current.onUndo();
      else callbacksRef.current.onRedo();
    };
    const handleKeyUp = (event: KeyboardEvent) => {
      if (COMPARE_KEYS.has(event.key)) release();
    };
    document.addEventListener("keydown", handleKeyDown);
    document.addEventListener("keyup", handleKeyUp);
    window.addEventListener("blur", release);
    return () => {
      document.removeEventListener("keydown", handleKeyDown);
      document.removeEventListener("keyup", handleKeyUp);
      window.removeEventListener("blur", release);
      release();
    };
  }, [enabled, clipboardEnabled, rootRef]);
}
