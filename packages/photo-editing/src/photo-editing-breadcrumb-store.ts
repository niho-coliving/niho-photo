"use client";

import { useSyncExternalStore } from "react";

/**
 * 写真編集タブのパンくず（ヘッダーのページ名「写真編集」の横、移行元設計 → 移行元設計）。写真編集の画面が場所と表示中の写真を
 * 置き、shell のヘッダー（`AdminPhotoEditingHeaderBreadcrumb`）が読む。画面とヘッダーは別の木なので、小さな store で渡す。
 *
 * 1 段目（S12 まで）は表示中の写真名の 1 段だけ。左の木がある Desktop（クラウド v11〜・フォルダの一覧 v14〜）は、前に
 * 場所の段（「クラウド」/ フォルダの段 / 「追加した写真」。押すとその場所へ = `onSelect`）を足し、先頭の段の前に場所の
 * 印（`icon`）を出す。グリッドでは場所だけ、1 枚では写真名も出す。フォルダの段が 4 つ以上なら「根 › … › 直近」に畳み、
 * 「…」の段を押すと全部出す。
 */
export type PhotoEditingBreadcrumbItem = {
  key: string;
  label: string;
  /** 先頭の段の前に出す場所の印（クラウド・「追加した写真」・フォルダ） */
  icon?: "cloud" | "photos" | "folder";
  /** クラウドの写真（この Mac の写真のうち中身の同じクラウドの写真があるもの。名前の横に雲の印を付ける） */
  cloud?: boolean;
  /** 最後以外の段を押したとき（2 段目のフォルダの段）。無ければ押せない文字として出す */
  onSelect?: () => void;
  /** 押せる段の読み上げ（`label` だけでは伝わらない段。畳んだ「…」の「途中のフォルダを表示」） */
  ariaLabel?: string;
};

export type PhotoEditingBreadcrumb = readonly PhotoEditingBreadcrumbItem[] | null;

let snapshot: PhotoEditingBreadcrumb = null;
const listeners = new Set<() => void>();

/** パンくずを置き換える。null で消す（写真編集の画面を離れたとき・写真が無いとき）。 */
export function setPhotoEditingBreadcrumb(items: PhotoEditingBreadcrumb): void {
  if (items === snapshot) return;
  snapshot = items;
  for (const listener of listeners) listener();
}

export function subscribePhotoEditingBreadcrumb(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function getPhotoEditingBreadcrumbSnapshot(): PhotoEditingBreadcrumb {
  return snapshot;
}

function getServerSnapshot(): PhotoEditingBreadcrumb {
  return null;
}

export function usePhotoEditingBreadcrumb(): PhotoEditingBreadcrumb {
  return useSyncExternalStore(subscribePhotoEditingBreadcrumb, getPhotoEditingBreadcrumbSnapshot, getServerSnapshot);
}
