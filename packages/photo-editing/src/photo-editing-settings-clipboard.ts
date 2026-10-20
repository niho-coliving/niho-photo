"use client";

import { useSyncExternalStore } from "react";

import type { CopiedDevelopSettings } from "./develop-engine/develop-settings";

/**
 * 「補正をコピー」で写した補正の置き場（F5a-2 移行元設計）。ページ（タブ）を開いている間だけ持つメモリ上の 1 つで、写真を替えても
 * 一覧に戻っても残る（Lightroom のコピーと同じ）。ページを読み直すと空になる。OS のクリップボードには書かない（ほかのアプリに
 * 補正の JSON を貼り付けさせず、貼り付けで OS のクリップボードも読まない）。同じページの複数の読み手（右パネルのメニュー・
 * キー・一覧の選択への貼り付け）が同じ値を見るよう `useSyncExternalStore` の小さな store にする。
 */
export type PhotoEditingSettingsClipboard = { settings: CopiedDevelopSettings; copiedAt: number };

let clipboard: PhotoEditingSettingsClipboard | null = null;
const listeners = new Set<() => void>();

function notify(): void {
  for (const listener of listeners) listener();
}

export function readPhotoEditingSettingsClipboard(): PhotoEditingSettingsClipboard | null {
  return clipboard;
}

/** 写した補正を置く（前に写した分は捨てる）。 */
export function writePhotoEditingSettingsClipboard(settings: CopiedDevelopSettings, now: number = Date.now()): void {
  clipboard = { settings, copiedAt: now };
  notify();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** server で描くときの値（まだ何も写していない）。 */
function getServerSnapshot(): PhotoEditingSettingsClipboard | null {
  return null;
}

/** 写した補正（無ければ null）。写すと同じページの読み手すべてに反映する。 */
export function usePhotoEditingSettingsClipboard(): PhotoEditingSettingsClipboard | null {
  return useSyncExternalStore(subscribe, readPhotoEditingSettingsClipboard, getServerSnapshot);
}

/** テスト用: 写した補正を捨てる。 */
export function resetPhotoEditingSettingsClipboardForTest(): void {
  clipboard = null;
  notify();
}
