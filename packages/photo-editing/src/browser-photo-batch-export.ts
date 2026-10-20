import type { PhotoEditingBatchExportTarget } from "./photo-editing-batch-export";
import { browserPhotoExportJpegFileName } from "./browser-photo-export";

/** ブラウザから一度にまとめて書き出せる写真の枚数（F7b 移行元設計）。 */
export const BROWSER_PHOTO_BATCH_EXPORT_MAX_COUNT = 50;
/** ブラウザから一度にまとめて書き出せる、選んだオリジナルの合計（500MB）。 */
export const BROWSER_PHOTO_BATCH_EXPORT_MAX_BYTES = 500_000_000;

export type BrowserPhotoBatchExportTarget = PhotoEditingBatchExportTarget & { sizeBytes: number };

export type BrowserPhotoBatchExportLimit =
  | { allowed: true; batchCount: 1 }
  | { allowed: false; batchCount: number; message: string };

/**
 * 選択順のまま 50 枚・500MB に収まる単位へ区切ったときの回数。上限を超えた選択では、利用者へ何回に分けるかを伝える。
 */
export function resolveBrowserPhotoBatchExportLimit(
  targets: readonly Pick<BrowserPhotoBatchExportTarget, "sizeBytes">[],
): BrowserPhotoBatchExportLimit {
  if (targets.length === 0) return { allowed: true, batchCount: 1 };
  if (targets.some(({ sizeBytes }) => !Number.isSafeInteger(sizeBytes) || sizeBytes <= 0)) {
    return {
      allowed: false,
      batchCount: 2,
      message: "写真の大きさを確認できませんでした。ページを読み込み直してください。",
    };
  }
  if (targets.some(({ sizeBytes }) => sizeBytes > BROWSER_PHOTO_BATCH_EXPORT_MAX_BYTES)) {
    return {
      allowed: false,
      batchCount: 2,
      message: "1 枚の写真が 500MB を超えるため、ZIP にまとめられません。",
    };
  }
  let batchCount = 1;
  let currentCount = 0;
  let currentBytes = 0;
  for (const target of targets) {
    const sizeBytes = target.sizeBytes;
    if (
      currentCount > 0 &&
      (currentCount >= BROWSER_PHOTO_BATCH_EXPORT_MAX_COUNT || currentBytes + sizeBytes > BROWSER_PHOTO_BATCH_EXPORT_MAX_BYTES)
    ) {
      batchCount += 1;
      currentCount = 0;
      currentBytes = 0;
    }
    currentCount += 1;
    currentBytes += sizeBytes;
  }
  if (batchCount === 1) return { allowed: true, batchCount: 1 };
  return {
    allowed: false,
    batchCount,
    message: `一度に書き出せるのは 50 枚・合計 500MB までです。選択を ${batchCount} 回以上に分けてください。`,
  };
}

function uniqueArchiveName(candidate: string, used: Set<string>): string {
  const safe = candidate.replace(/[\\/\u0000-\u001f\u007f]/g, "_") || "photo";
  const dot = safe.lastIndexOf(".");
  const stem = dot > 0 ? safe.slice(0, dot) : safe;
  const extension = dot > 0 ? safe.slice(dot) : "";
  let name = safe;
  let suffix = 2;
  while (used.has(name.toLocaleLowerCase())) {
    name = `${stem} (${suffix})${extension}`;
    suffix += 1;
  }
  used.add(name.toLocaleLowerCase());
  return name;
}

/** ZIP 内で同名を上書きしない、選択順のファイル名。 */
export function browserPhotoBatchArchiveNames(
  targets: readonly Pick<BrowserPhotoBatchExportTarget, "fileName">[],
  format: "jpeg" | "original",
): string[] {
  const used = new Set<string>();
  return targets.map((target) =>
    uniqueArchiveName(format === "jpeg" ? browserPhotoExportJpegFileName(target.fileName) : target.fileName, used),
  );
}

/** PC へ保存する ZIP の名前。 */
export function browserPhotoBatchArchiveFileName(now = new Date()): string {
  const pad = (value: number) => String(value).padStart(2, "0");
  return `NIHO写真_${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}_${pad(now.getHours())}${pad(now.getMinutes())}.zip`;
}

/** 個別失敗を、全ファイル名が見える通知ダイアログ用にまとめる。 */
export function browserPhotoBatchFailureNames(failures: readonly Pick<PhotoEditingBatchExportTarget, "fileName">[]): string {
  return failures.map((failure) => failure.fileName).join("・");
}
