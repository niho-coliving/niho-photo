"use client";

import { useCallback, useState } from "react";

import {
  PHOTO_EDITING_ADJUSTMENT_GROUP_IDS,
  type PhotoEditingAdjustmentGroupId,
} from "./photo-editing-adjustments";

/**
 * 右パネルの補正の群（ライト／カラー／効果）の開閉（NIHO Photo 段 1 F1 移行元設計）。端末ごとに覚える（面の開閉
 * `PHOTO_EDITING_PANELS_STORAGE_KEY` と同じ考え方。ブラウザ版と NIHO Desktop で共有）。保存するのは閉じた群の id の配列で、
 * 既定（はじめて・読めないとき）は全部開く。
 */
export const PHOTO_EDITING_ADJUSTMENT_GROUPS_STORAGE_KEY = "niho:host:photoEditing:adjustmentGroups:v1";

const GROUP_IDS: ReadonlySet<string> = new Set(PHOTO_EDITING_ADJUSTMENT_GROUP_IDS);

function isGroupId(value: unknown): value is PhotoEditingAdjustmentGroupId {
  return typeof value === "string" && GROUP_IDS.has(value);
}

/** 保存値（JSON の配列）を読む。無い・壊れている・知らない id は無視する（開く）。 */
export function parseStoredCollapsedAdjustmentGroups(rawValue: string | null): ReadonlySet<PhotoEditingAdjustmentGroupId> {
  if (rawValue === null) return new Set();
  let parsed: unknown;
  try {
    parsed = JSON.parse(rawValue);
  } catch {
    return new Set();
  }
  return Array.isArray(parsed) ? new Set(parsed.filter(isGroupId)) : new Set();
}

export function serializeCollapsedAdjustmentGroups(collapsed: ReadonlySet<PhotoEditingAdjustmentGroupId>): string {
  // 並びは群の定義の順にそろえる（開閉の順で値が変わらない）
  return JSON.stringify(PHOTO_EDITING_ADJUSTMENT_GROUP_IDS.filter((id) => collapsed.has(id)));
}

function readStoredCollapsedAdjustmentGroups(): ReadonlySet<PhotoEditingAdjustmentGroupId> {
  if (typeof window === "undefined") return new Set();
  try {
    return parseStoredCollapsedAdjustmentGroups(window.localStorage.getItem(PHOTO_EDITING_ADJUSTMENT_GROUPS_STORAGE_KEY));
  } catch {
    return new Set();
  }
}

/**
 * 右パネルの「プリセット」の節の開閉（F2b 移行元設計）。群と同じく端末ごとに覚える。保存するのは閉じたときの印だけで、既定
 * （はじめて・読めないとき）は開く。群の保存値（閉じた群の id の配列）は知らない id を捨てるので、別のキーに置く。
 */
export const PHOTO_EDITING_PRESETS_SECTION_STORAGE_KEY = "niho:host:photoEditing:presetsSection:v1";
const PRESETS_SECTION_COLLAPSED_VALUE = "collapsed";

function readStoredPresetsSectionCollapsed(): boolean {
  if (typeof window === "undefined") return false;
  try {
    return window.localStorage.getItem(PHOTO_EDITING_PRESETS_SECTION_STORAGE_KEY) === PRESETS_SECTION_COLLAPSED_VALUE;
  } catch {
    return false;
  }
}

/** 「プリセット」の節が閉じているかと、開閉する関数（localStorage が使えない環境では、この画面の間だけ覚える）。 */
export function usePhotoEditingPresetsSectionCollapsed(): [boolean, () => void] {
  const [collapsed, setCollapsed] = useState(readStoredPresetsSectionCollapsed);
  const toggle = useCallback(() => {
    setCollapsed((current) => {
      const next = !current;
      try {
        if (next) window.localStorage.setItem(PHOTO_EDITING_PRESETS_SECTION_STORAGE_KEY, PRESETS_SECTION_COLLAPSED_VALUE);
        else window.localStorage.removeItem(PHOTO_EDITING_PRESETS_SECTION_STORAGE_KEY);
      } catch {
        // localStorage が使えない環境では、この画面の間だけ覚える
      }
      return next;
    });
  }, []);
  return [collapsed, toggle];
}

/**
 * 閉じている群と、1 つを開閉する関数。右パネルは写真を 1 枚で開いた後にだけ出る（server では描かない）ので、最初の描画から
 * 保存値を使う。localStorage が使えない環境では、この画面の間だけ覚える。
 */
export function usePhotoEditingCollapsedAdjustmentGroups(): [
  ReadonlySet<PhotoEditingAdjustmentGroupId>,
  (id: PhotoEditingAdjustmentGroupId) => void,
] {
  const [collapsed, setCollapsed] = useState<ReadonlySet<PhotoEditingAdjustmentGroupId>>(
    readStoredCollapsedAdjustmentGroups,
  );
  const toggleGroup = useCallback((id: PhotoEditingAdjustmentGroupId) => {
    setCollapsed((current) => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      try {
        window.localStorage.setItem(PHOTO_EDITING_ADJUSTMENT_GROUPS_STORAGE_KEY, serializeCollapsedAdjustmentGroups(next));
      } catch {
        // localStorage が使えない環境では、この画面の間だけ覚える
      }
      return next;
    });
  }, []);
  return [collapsed, toggleGroup];
}
