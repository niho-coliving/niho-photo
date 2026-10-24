import { hasActiveDevelopLens } from "./develop-engine/develop-lens";
import { hasDevelopPerspective } from "./develop-engine/develop-settings";
import { hasPhotoEditingColorGradingNativeExportUnsupportedLuminance } from "./photo-editing-color-grading";
import {
  PHOTO_EDITING_EXPORT_FULL_SIZE_COLOR_GRADING_UNSUPPORTED_FAILED_TEXT,
  PHOTO_EDITING_EXPORT_FULL_SIZE_COLOR_GRADING_UNSUPPORTED_TEXT,
  PHOTO_EDITING_EXPORT_FULL_SIZE_NATIVE_BLOCKER_LABELS,
} from "./photo-editing-copy";
import type { PhotoEditingSettings } from "./photo-editing-types";

/**
 * 原寸の native renderer（Mac の sidecar `niho-develop-render`。同梱の版は wasm より古い）がまだ描けない補正。画面の wasm は描けるので、
 * 書き出しの経路だけを塞ぐ（sidecar を上げるまで。上げたら対応する項目をここから外す）。
 *
 * - `colorGradingLuminance`: 中間調・全体の輝度（#39）。古い renderer は黙って無視して別の画を書く
 * - `perspective`: 遠近（設定 v7。#46）。古い renderer は `unsupported_settings` で断る
 * - `heal`: 修復の印（設定 v8。#44）。同上
 * - `lens`: 画を変えるレンズ補正（設定 v9。#45）。同上
 */
export type PhotoEditingNativeExportBlocker = "colorGradingLuminance" | "perspective" | "heal" | "lens";

/** 修復の印が 1 つでもあるか（形の壊れた `heal` も、描けない設定として true）。 */
function hasHealMarks(settings: PhotoEditingSettings): boolean {
  const heal = settings.heal;
  if (heal === undefined || heal === null) return false;
  return !Array.isArray(heal) || heal.length > 0;
}

/** この設定を原寸の native renderer へ渡せない理由（固定の順。無ければ空）。 */
export function photoEditingNativeExportBlockers(settings: PhotoEditingSettings): PhotoEditingNativeExportBlocker[] {
  const blockers: PhotoEditingNativeExportBlocker[] = [];
  if (hasPhotoEditingColorGradingNativeExportUnsupportedLuminance(settings)) blockers.push("colorGradingLuminance");
  if (hasDevelopPerspective(settings)) blockers.push("perspective");
  if (hasHealMarks(settings)) blockers.push("heal");
  if (hasActiveDevelopLens(settings)) blockers.push("lens");
  return blockers;
}

/** 原寸の native renderer が描けない補正が 1 つでもあるか。 */
export function hasPhotoEditingNativeExportUnsupportedSettings(settings: PhotoEditingSettings): boolean {
  return photoEditingNativeExportBlockers(settings).length > 0;
}

function blockerLabels(blockers: readonly PhotoEditingNativeExportBlocker[]): string {
  return blockers.map((blocker) => PHOTO_EDITING_EXPORT_FULL_SIZE_NATIVE_BLOCKER_LABELS[blocker]).join("、");
}

/**
 * 原寸のカードを押せない理由の 1 行（「原寸は〇〇に未対応です」）。理由が無い・中間調 / 全体の輝度だけのときは、従来の文
 * （中間調・全体の輝度）のまま。
 */
export function photoEditingNativeExportUnsupportedText(blockers: readonly PhotoEditingNativeExportBlocker[]): string {
  if (blockers.length === 0 || (blockers.length === 1 && blockers[0] === "colorGradingLuminance")) {
    return PHOTO_EDITING_EXPORT_FULL_SIZE_COLOR_GRADING_UNSUPPORTED_TEXT;
  }
  return `原寸は${blockerLabels(blockers)}に未対応です`;
}

/** 実行時に原寸の書き出しを断るとき（1 枚、複数枚の中で飛ばす写真）の失敗の 1 行。理由が無い・輝度だけのときは従来の文のまま。 */
export function photoEditingNativeExportUnsupportedFailedText(
  blockers: readonly PhotoEditingNativeExportBlocker[],
): string {
  if (blockers.length === 0 || (blockers.length === 1 && blockers[0] === "colorGradingLuminance")) {
    return PHOTO_EDITING_EXPORT_FULL_SIZE_COLOR_GRADING_UNSUPPORTED_FAILED_TEXT;
  }
  return `${blockerLabels(blockers)}を使っている写真は、原寸で書き出せません。`;
}
