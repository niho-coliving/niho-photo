"use client";

import { useCallback, useState } from "react";

/**
 * 写真編集の面の開閉（左 = フォルダ、下 = フィルムストリップ、右 = 補正）。端末ごとに覚える（ナビの折りたたみ
 * `HOST_NAV_COLLAPSED_STORAGE_KEY` と同じ考え方。写真編集タブと記事制作の「画像を追加」のダイアログで共有する）。
 */
export type PhotoEditingPanels = {
  left: boolean;
  strip: boolean;
  right: boolean;
};

export type PhotoEditingPanelKey = keyof PhotoEditingPanels;

export const PHOTO_EDITING_PANELS_STORAGE_KEY = "niho:host:photoEditing:panels:v1";

/** 既定は全部開く（はじめての人・保存値が読めないとき） */
export const DEFAULT_PHOTO_EDITING_PANELS: PhotoEditingPanels = { left: true, strip: true, right: true };

const PANEL_KEYS: readonly PhotoEditingPanelKey[] = ["left", "strip", "right"];

/** 保存値（JSON）を読む。無い・壊れている・真偽値でない項目は既定（開く）にする。 */
export function parseStoredPhotoEditingPanels(rawValue: string | null): PhotoEditingPanels {
  if (rawValue === null) return DEFAULT_PHOTO_EDITING_PANELS;
  let parsed: unknown;
  try {
    parsed = JSON.parse(rawValue);
  } catch {
    return DEFAULT_PHOTO_EDITING_PANELS;
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return DEFAULT_PHOTO_EDITING_PANELS;
  const record = parsed as Record<string, unknown>;
  const panels = { ...DEFAULT_PHOTO_EDITING_PANELS };
  for (const key of PANEL_KEYS) {
    const value = record[key];
    if (typeof value === "boolean") panels[key] = value;
  }
  return panels;
}

export function serializePhotoEditingPanels(panels: PhotoEditingPanels): string {
  return JSON.stringify({ left: panels.left, strip: panels.strip, right: panels.right });
}

function readStoredPhotoEditingPanels(): PhotoEditingPanels {
  if (typeof window === "undefined") return DEFAULT_PHOTO_EDITING_PANELS;
  try {
    return parseStoredPhotoEditingPanels(window.localStorage.getItem(PHOTO_EDITING_PANELS_STORAGE_KEY));
  } catch {
    return DEFAULT_PHOTO_EDITING_PANELS;
  }
}

/**
 * 面の開閉と、1 つを切り替える関数。写真編集の画面は NIHO Desktop の handshake を確かめた後にだけ出る
 * （server では描かない）ので、最初の描画から保存値を使う。
 */
export function usePhotoEditingPanels(): [PhotoEditingPanels, (key: PhotoEditingPanelKey) => void] {
  const [panels, setPanels] = useState<PhotoEditingPanels>(readStoredPhotoEditingPanels);
  const togglePanel = useCallback((key: PhotoEditingPanelKey) => {
    setPanels((current) => {
      const next = { ...current, [key]: !current[key] };
      try {
        window.localStorage.setItem(PHOTO_EDITING_PANELS_STORAGE_KEY, serializePhotoEditingPanels(next));
      } catch {
        // localStorage が使えない環境では、この画面の間だけ覚える
      }
      return next;
    });
  }, []);
  return [panels, togglePanel];
}
