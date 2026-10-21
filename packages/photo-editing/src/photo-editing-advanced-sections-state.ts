"use client";

import { useCallback, useState } from "react";

/**
 * 右パネルの「既定で閉じた節」（カーブなど。niho-photo#37。後続のカラーミキサー・カラーグレーディング・レンズ・ジオメトリも使う）の
 * 開閉。端末ごとに覚える（群の開閉 `PHOTO_EDITING_ADJUSTMENT_GROUPS_STORAGE_KEY` と同じ考え方）が、群と違って既定は閉じる。保存する
 * のは開いた節の id の配列で、はじめて・読めない・壊れている・知らない id は閉じたまま。
 *
 * 節を足すときは {@link PHOTO_EDITING_ADVANCED_SECTION_IDS} に id を足す（群の id〔`PhotoEditingAdjustmentGroupId`〕はスマホの道具の
 * アイコンにも効くので増やさない）。保存値の知らない id（新しい版で開いた節）は、書き戻すときも残す。
 */
export const PHOTO_EDITING_ADVANCED_SECTION_IDS = ["curve"] as const;

export type PhotoEditingAdvancedSectionId = (typeof PHOTO_EDITING_ADVANCED_SECTION_IDS)[number];

export const PHOTO_EDITING_ADVANCED_SECTIONS_STORAGE_KEY = "niho:host:photoEditing:advancedSections:v1";

const SECTION_IDS: ReadonlySet<string> = new Set(PHOTO_EDITING_ADVANCED_SECTION_IDS);

function isSectionId(value: string): value is PhotoEditingAdvancedSectionId {
  return SECTION_IDS.has(value);
}

/** 保存値（JSON の文字列の配列）の id。無い・壊れていれば空。 */
function storedIds(rawValue: string | null): string[] {
  if (rawValue === null) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(rawValue);
  } catch {
    return [];
  }
  if (!Array.isArray(parsed)) return [];
  return [...new Set(parsed.filter((item): item is string => typeof item === "string"))];
}

/** 保存値から、開いている節を読む（無い・壊れている・知らない id は閉じる）。 */
export function parseStoredOpenAdvancedSections(rawValue: string | null): ReadonlySet<PhotoEditingAdvancedSectionId> {
  return new Set(storedIds(rawValue).filter(isSectionId));
}

/** 1 つの節を開いた / 閉じた後の保存値（ほかの id は知らないものも並びも保つ）。 */
export function serializeOpenAdvancedSection(
  rawValue: string | null,
  id: PhotoEditingAdvancedSectionId,
  open: boolean,
): string {
  const others = storedIds(rawValue).filter((item) => item !== id);
  return JSON.stringify(open ? [...others, id] : others);
}

function readStoredSectionOpen(id: PhotoEditingAdvancedSectionId): boolean {
  if (typeof window === "undefined") return false;
  try {
    return parseStoredOpenAdvancedSections(window.localStorage.getItem(PHOTO_EDITING_ADVANCED_SECTIONS_STORAGE_KEY)).has(id);
  } catch {
    return false;
  }
}

/**
 * 節 `id` が開いているかと、開閉する関数。右パネルは写真を 1 枚で開いた後にだけ出る（server では描かない）ので、最初の描画から
 * 保存値を使う。書くときは保存値を読み直してその節だけを替える（同時に出ているほかの節の開閉を消さない）。localStorage が
 * 使えない環境では、この画面の間だけ覚える。
 */
export function usePhotoEditingAdvancedSectionOpen(id: PhotoEditingAdvancedSectionId): [boolean, () => void] {
  const [open, setOpen] = useState(() => readStoredSectionOpen(id));
  const toggle = useCallback(() => {
    setOpen((current) => {
      const next = !current;
      try {
        const stored = window.localStorage.getItem(PHOTO_EDITING_ADVANCED_SECTIONS_STORAGE_KEY);
        window.localStorage.setItem(PHOTO_EDITING_ADVANCED_SECTIONS_STORAGE_KEY, serializeOpenAdvancedSection(stored, id, next));
      } catch {
        // localStorage が使えない環境では、この画面の間だけ覚える
      }
      return next;
    });
  }, [id]);
  return [open, toggle];
}
