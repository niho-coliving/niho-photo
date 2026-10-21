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
 *   失ったら戻す。切り抜きの道具の間・補正前と補正後を並べている間（`compareEnabled` が false。niho-photo#41）は効かない
 * - `R` = 「補正」と「切り抜き」の道具を切り替える（F3b 移行元設計。切り替えを出していない間〔`onToggleTool` が無い〕は扱わない）
 * - `J` = 黒つぶれ・白飛びの印を写真に重ねる / 外す（niho-photo#36。Lightroom と同じ。修飾キー〔⇧ を含む〕つきは扱わない。
 *   ヒストグラムを出していない間・切り抜き / 背景除去の道具の間〔`onToggleClipping` が無い〕は扱わない）
 * - `Y` = 補正前と補正後を並べる / 戻す、`Shift+Y` = 分割する / 戻す（niho-photo#41。⌘ ⌃ ⌥ つき・押しっぱなしの繰り返しは扱わない。
 *   比較を使えない間〔`onToggleCompareView` が無い。切り抜き / 背景除去の道具の間〕は扱わない）
 * - 切り抜きの道具の間（`onCropDone` / `onCropCancel` がある間。#52）: Enter =［完了］、Esc =［キャンセル］。ボタンの上の Enter も
 *   ［完了］（自分の Enter を使う部品は `preventDefault` する: 値の直接入力の欄・［キャンセル］）
 *
 * 画面の中か、どこにもフォーカスが無いときだけ扱う。文字を打つ欄（値の直接入力の欄など）・IME の変換中・ほかの処理が既に
 * 使ったキー（`defaultPrevented`。開いているメニューの Esc など）は扱わない。
 */
export type BrowserPhotoEditingKey =
  | "undo"
  | "redo"
  | "compare"
  | "tool"
  | "clip"
  | "compareSide"
  | "compareSplit"
  | "copy"
  | "paste"
  | "cropDone"
  | "cropCancel";

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
  if (event.altKey) return null;
  if (event.key === "Enter") return event.shiftKey ? null : "cropDone";
  if (event.key === "Escape") return "cropCancel";
  if (event.key === "j" || event.key === "J") return event.shiftKey ? null : "clip";
  if (event.key === "y" || event.key === "Y") return event.shiftKey ? "compareSplit" : "compareSide";
  return event.key === "r" || event.key === "R" ? "tool" : null;
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
  /** 補正前のキーを扱うか（省くと true。切り抜きの道具の間・比較の間は false） */
  compareEnabled?: boolean;
  /** `R` で道具を切り替える（切り替えを出していない間は null。省くと扱わない） */
  onToggleTool?: (() => void) | null;
  /** `J` で黒つぶれ・白飛びの印を写真に重ねる / 外す（出していない間は null。省くと扱わない） */
  onToggleClipping?: (() => void) | null;
  /** `Y` / `Shift+Y` で補正前と補正後を並べる / 分割する / 戻す（niho-photo#41。使えない間は null。省くと扱わない） */
  onToggleCompareView?: ((key: "side" | "split") => void) | null;
  /** 切り抜きの道具の間の Enter =［完了］・Esc =［キャンセル］（ほかの間は null。省くと扱わない） */
  onCropDone?: (() => void) | null;
  onCropCancel?: (() => void) | null;
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
      if (key === "clip") {
        const toggleClipping = callbacksRef.current.onToggleClipping;
        if (!toggleClipping) return;
        event.preventDefault();
        if (!event.repeat) toggleClipping();
        return;
      }
      if (key === "compareSide" || key === "compareSplit") {
        const toggleCompareView = callbacksRef.current.onToggleCompareView;
        if (!toggleCompareView) return;
        event.preventDefault();
        if (!event.repeat) toggleCompareView(key === "compareSplit" ? "split" : "side");
        return;
      }
      if (key === "cropDone" || key === "cropCancel") {
        const finish = key === "cropDone" ? callbacksRef.current.onCropDone : callbacksRef.current.onCropCancel;
        if (!finish) return;
        // ボタンの上の Enter も［完了］にする（ボタンを押させない）
        event.preventDefault();
        if (!event.repeat) finish();
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
