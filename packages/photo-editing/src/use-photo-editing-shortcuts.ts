"use client";

import { useEffect, useRef, type RefObject } from "react";

/**
 * 写真編集の画面のキー（移行元設計。Lightroom と同じ）。
 *
 * - G = グリッド（一覧）、E = 1 枚（編集）、Esc = 1 枚ならグリッドへ・グリッドなら選択を解く
 * - ⌘A（Ctrl+A）= その場所の写真をすべて選ぶ、Enter = グリッドで表示中の写真を 1 枚で出す、←→↑↓ = 一覧を移る
 * - ⌫ / Delete = クラウドの中で、選んだ写真（1 枚では表示中の写真）を確かめてからクラウドから消す（移行元設計）
 *
 * 画面の中か、どこにもフォーカスが無い（body）・画面を包む枠（ダイアログの外枠）にフォーカスがあるときだけ扱う。
 * 文字を打つ欄（テキストの input・textarea・select・contenteditable）にいるとき、IME で変換中、ほかの処理が既に使った
 * キー（`defaultPrevented`。一覧のセル・タイルが自分で扱った矢印、開いているメニュー・ダイアログの Esc）は扱わない。
 * Enter と矢印は、ボタンなどの操作の上では扱わない（押す・動かすはその操作のもの）。⌫ / Delete はグリッドのタイル
 * （ボタン）の上でも扱う（ボタンには ⌫ / Delete の働きが無い）。
 */
export type PhotoEditingShortcut = "grid" | "loupe" | "escape" | "selectAll" | "open" | "arrow" | "delete";

export type PhotoEditingShortcutKeyEvent = Pick<
  KeyboardEvent,
  "key" | "metaKey" | "ctrlKey" | "altKey" | "shiftKey" | "isComposing" | "defaultPrevented"
>;

const ARROW_KEYS = new Set(["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown"]);

/** 押されたキーが写真編集のどのキーか（扱わなければ null）。`onControl` はボタンなどの操作の上で押されたか。 */
export function resolvePhotoEditingShortcut(
  event: PhotoEditingShortcutKeyEvent,
  target: { typing: boolean; onControl: boolean },
): PhotoEditingShortcut | null {
  if (event.defaultPrevented || event.isComposing || target.typing) return null;
  if (event.metaKey || event.ctrlKey) {
    return !event.altKey && !event.shiftKey && event.key.toLowerCase() === "a" ? "selectAll" : null;
  }
  if (event.altKey) return null;
  const key = event.key;
  if (key === "g" || key === "G") return "grid";
  if (key === "e" || key === "E") return "loupe";
  if (key === "Escape") return "escape";
  if (key === "Backspace" || key === "Delete") return "delete";
  if (target.onControl) return null;
  if (key === "Enter") return event.shiftKey ? null : "open";
  if (ARROW_KEYS.has(key)) return "arrow";
  return null;
}

/** 文字を打つ入力に使うもの（ここではキーを横取りしない）。 */
const NON_TEXT_INPUT_TYPES = new Set([
  "button",
  "checkbox",
  "color",
  "file",
  "hidden",
  "image",
  "radio",
  "range",
  "reset",
  "submit",
]);

export function isPhotoEditingTypingTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  if (target.isContentEditable || target.getAttribute("contenteditable") === "true") return true;
  if (target instanceof HTMLTextAreaElement || target instanceof HTMLSelectElement) return true;
  if (target instanceof HTMLInputElement) return !NON_TEXT_INPUT_TYPES.has(target.type);
  return false;
}

/** Enter・矢印を自分で使う操作（ボタン・リンク・入力・メニューの項目）。 */
const CONTROL_SELECTOR = 'button, a[href], input, select, textarea, [role="menuitem"], [role="slider"]';

export function isPhotoEditingControlTarget(target: EventTarget | null): boolean {
  return target instanceof Element && target.closest(CONTROL_SELECTOR) !== null;
}

/** 画面の中、どこにもフォーカスが無い（body・document）、画面を包む枠にフォーカスがあるときだけ扱う。 */
export function isWithinPhotoEditingScope(root: Element, target: EventTarget | null): boolean {
  if (typeof document !== "undefined" && (target === document || target === document.body)) return true;
  if (!(target instanceof Node)) return false;
  return root.contains(target) || target.contains(root);
}

/**
 * 写真編集の画面のキーを聞く（document の keydown）。`handleEscape` が false の間は Esc を扱わない（記事制作の
 * 「画像を追加」のダイアログでは Esc はダイアログを閉じる）。`enabled` が false の間はどのキーも扱わない（設定サブタブなど、
 * 画面を外さずに隠している間。移行元設計）。true に戻せば再び効く。省くと true。
 */
export function usePhotoEditingShortcuts(options: {
  rootRef: RefObject<HTMLElement | null>;
  /** ポータルなど、画面の root の外に描画される操作面を同じショートカット範囲に含める。 */
  additionalRootRef?: RefObject<HTMLElement | null>;
  handleEscape: boolean;
  enabled?: boolean;
  onShortcut: (shortcut: PhotoEditingShortcut, event: KeyboardEvent) => void;
}): void {
  const { rootRef, additionalRootRef } = options;
  const enabled = options.enabled ?? true;
  const onShortcutRef = useRef(options.onShortcut);
  onShortcutRef.current = options.onShortcut;
  const handleEscapeRef = useRef(options.handleEscape);
  handleEscapeRef.current = options.handleEscape;

  useEffect(() => {
    if (!enabled) return;
    const handleKeyDown = (event: KeyboardEvent) => {
      const roots = [rootRef.current, additionalRootRef?.current].filter((root): root is HTMLElement => root != null);
      if (!roots.some((root) => isWithinPhotoEditingScope(root, event.target))) return;
      const shortcut = resolvePhotoEditingShortcut(event, {
        typing: isPhotoEditingTypingTarget(event.target),
        onControl: isPhotoEditingControlTarget(event.target),
      });
      if (shortcut === null || (shortcut === "escape" && !handleEscapeRef.current)) return;
      onShortcutRef.current(shortcut, event);
    };
    document.addEventListener("keydown", handleKeyDown);
    return () => document.removeEventListener("keydown", handleKeyDown);
  }, [additionalRootRef, enabled, rootRef]);
}
