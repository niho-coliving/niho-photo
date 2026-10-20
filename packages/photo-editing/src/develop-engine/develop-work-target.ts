import type { PhotoLibraryItem } from "../library/photo-library";

import { BROWSER_CLOUD_ORIGINAL_FILE_EXTENSIONS } from "../photo-original-files";
import { BROWSER_PHOTO_MAX_JPEG_ORIGINAL_BYTES, BrowserPhotoSourceError } from "../browser-photo-source";

/**
 * 作業コピー（段 1 の出力。移行時の設計文書「作業コピー」）を入力にして直す写真か（移行元設計）。写真置き場の
 * 拡張子のうち、RAW・HEIC / HEIF・TIFF は常に、PNG は 10MiB を超えるときだけ（サーバーの `isPhotoCloudWorkApplicable` と同じ）。
 * JPEG は大きさによらず段 2 が不変のオリジナルから直接描く（`base: null`。K5-a 移行元設計）。ただし次の JPEG は作業コピーで直す:
 *
 * - 作業コピーの上で直した補正のある JPEG（`developSettings.base` が文字列。決まりごと 4: 補正が指す作業コピーを黙って変えない）
 * - ブラウザが読めないほど大きい JPEG（64MiB を超える。4,000 万画素を超えると開いて分かった写真は、このタブの間だけ覚える）
 *
 * 写真置き場の一覧に無い拡張子（記事から取り込んだ WebP など）とオリジナルの無い行は作業コピーを作らない。
 */

const JPEG_EXTENSIONS: ReadonlySet<string> = new Set(["jpg", "jpeg"]);
const PNG_EXTENSIONS: ReadonlySet<string> = new Set(["png"]);
const WORK_EXTENSIONS: ReadonlySet<string> = new Set(BROWSER_CLOUD_ORIGINAL_FILE_EXTENSIONS);

/** PNG をオリジナルから直接描く上限（サーバーの `PHOTO_CLOUD_WORK_DIRECT_PNG_MAX_BYTES` と同じ 10MiB）。 */
export const DEVELOP_WORK_DIRECT_PNG_MAX_BYTES = 10 * 1024 ** 2;

export type DevelopWorkTargetPhoto = Pick<
  PhotoLibraryItem,
  "id" | "hasOriginal" | "fileExtension" | "sizeBytes" | "developSettings"
>;

/**
 * オリジナルで開こうとして大きすぎた（4,000 万画素・64MiB を超える）JPEG の写真の ID。このタブの間だけ覚え、以後は作業コピーで
 * 開く（同じ写真で毎回オリジナルを落とし直さない）。
 */
const originalTooLargePhotoIds = new Set<string>();

/** 作業コピーの上で直した補正か（`developSettings.base` が作業コピーの土台の版）。 */
function isDevelopSettingsOnWorkingCopy(developSettings: unknown): boolean {
  return (
    typeof developSettings === "object" &&
    developSettings !== null &&
    "base" in developSettings &&
    typeof developSettings.base === "string"
  );
}

function normalizedExtension(photo: Pick<PhotoLibraryItem, "fileExtension">): string {
  return photo.fileExtension.trim().toLowerCase();
}

export function isDevelopWorkTarget(photo: DevelopWorkTargetPhoto): boolean {
  if (!photo.hasOriginal) return false;
  const extension = normalizedExtension(photo);
  if (!WORK_EXTENSIONS.has(extension)) return false;
  if (JPEG_EXTENSIONS.has(extension)) {
    return (
      isDevelopSettingsOnWorkingCopy(photo.developSettings) ||
      photo.sizeBytes > BROWSER_PHOTO_MAX_JPEG_ORIGINAL_BYTES ||
      originalTooLargePhotoIds.has(photo.id)
    );
  }
  if (PNG_EXTENSIONS.has(extension)) return photo.sizeBytes > DEVELOP_WORK_DIRECT_PNG_MAX_BYTES;
  return true;
}

/**
 * JPEG / PNG をオリジナルから直接描く写真か（作業コピーで直す写真でない。`base: null` の新規編集を niho-6 で描ける写真。移行元設計）。
 * 作業コピーで直す写真・写真置き場に無い拡張子・オリジナルの無い行は false。
 */
export function isDevelopDirectRasterOriginal(photo: DevelopWorkTargetPhoto): boolean {
  if (!photo.hasOriginal || isDevelopWorkTarget(photo)) return false;
  const extension = normalizedExtension(photo);
  return JPEG_EXTENSIONS.has(extension) || PNG_EXTENSIONS.has(extension);
}

/** RAW でない作業コピーの対象の拡張子のうち、大きさによらず端末が作業コピーを上げるもの（HEIC / HEIF・TIFF）。 */
const CLIENT_WORK_RASTER_EXTENSIONS: ReadonlySet<string> = new Set(["heic", "heif", "tif", "tiff"]);

/**
 * NIHO Desktop が手元で作った作業コピーを、クラウドに追加した写真と一緒に上げる写真か（入れ終わりに `workCopyByClient: true` を付け、
 * 続けて `work/client-upload` へ上げる。W2b-2 / W2c-2 移行元設計）。サーバーの `isPhotoCloudWorkClientUploadSupported` と同じ区分を
 * 拡張子と大きさで決める: RAW、HEIC / HEIF・TIFF、10MiB を超える PNG。JPEG（大きさによらない。求められたときだけワーカーが作る）・
 * 10MiB 以下の PNG・写真置き場に無い拡張子は上げない。`raster: false`（ラスタの作業コピーを作れない v21 の Desktop。capabilities の
 * `cloudWorkRaster`）なら RAW だけ。プレビューは呼び出し側が置く（NIHO Desktop は元の写真と一緒に必ず上げる）。
 */
export function isClientWorkCopyTarget(
  photo: Pick<PhotoLibraryItem, "fileExtension" | "sizeBytes">,
  options: { raster: boolean },
): boolean {
  const extension = normalizedExtension(photo).replace(/^\./, "");
  if (!WORK_EXTENSIONS.has(extension) || JPEG_EXTENSIONS.has(extension)) return false;
  if (PNG_EXTENSIONS.has(extension)) return options.raster && photo.sizeBytes > DEVELOP_WORK_DIRECT_PNG_MAX_BYTES;
  if (CLIENT_WORK_RASTER_EXTENSIONS.has(extension)) return options.raster;
  return true;
}

/** オリジナルのある JPEG か（大きすぎたら作業コピーで開き直せる写真）。 */
export function isDevelopOriginalJpeg(photo: Pick<PhotoLibraryItem, "hasOriginal" | "fileExtension">): boolean {
  return photo.hasOriginal && JPEG_EXTENSIONS.has(normalizedExtension(photo));
}

/**
 * オリジナルで開こうとして読めなかった理由が「大きすぎる」（`too_large`。4,000 万画素・64MiB を超える）で、作業コピーで開き直せる
 * 写真か（オリジナルのある JPEG だけ。PNG などはサーバーが作業コピーを作らないので、今までどおり読めなかった理由を出す）。
 */
export function canOpenDevelopWorkInstead(
  photo: Pick<PhotoLibraryItem, "hasOriginal" | "fileExtension">,
  error: unknown,
): boolean {
  return error instanceof BrowserPhotoSourceError && error.reason === "too_large" && isDevelopOriginalJpeg(photo);
}

/** オリジナルが大きすぎた写真を覚える（このタブの間。以後 {@link isDevelopWorkTarget} が作業コピーで直す写真にする）。 */
export function rememberDevelopOriginalTooLarge(photoId: string): void {
  originalTooLargePhotoIds.add(photoId);
}

/** テスト用: 覚えた写真を忘れる。 */
export function resetDevelopOriginalTooLargeForTest(): void {
  originalTooLargePhotoIds.clear();
}
