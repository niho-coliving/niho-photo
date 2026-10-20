/**
 * 編集面の状態欄・確かめの文言のうち、写真の出どころに依らないもの（NIHO camera C1 移行元設計 で web の photo-editing-messages から
 * 移した。NIHO Desktop・API の失敗の文は写真の出どころの `errors` が持つ）。
 */

/** 複数枚の書き出しの進み具合（i / N 枚）。 */
export function describePhotoEditingBatchExportProgress(progress: { index: number; total: number }): string {
  return `書き出し中 ${progress.index} / ${progress.total} 枚`;
}

/** 複数枚の書き出しが終わった・止めたとき。全部書き出せたときだけ枚数 1 つにする。 */
export function describePhotoEditingBatchExportSummary(result: { total: number; savedCount: number }): string {
  if (result.savedCount === result.total) return `${result.total} 枚を書き出しました`;
  return `${result.total} 枚中 ${result.savedCount} 枚を書き出しました`;
}

/**
 * プリセット（XMP）を当てられない・読めない（段 2 で扱えない項目が残る）ときの 1 行。NIHO Desktop の `presetInvalid` の文も同じ定数。
 */
export const PHOTO_EDITING_PRESET_INVALID_TEXT =
  "プリセット（XMP）を読み込めませんでした。Lightroom で書き出した XMP か確かめてください。";

/** プリセット（XMP）を当てられない失敗（`message` は {@link PHOTO_EDITING_PRESET_INVALID_TEXT}）。 */
export class PhotoEditingPresetInvalidError extends Error {
  constructor() {
    super(PHOTO_EDITING_PRESET_INVALID_TEXT);
    this.name = "PhotoEditingPresetInvalidError";
  }
}

/** プリセット（XMP）を当てられない失敗。 */
export function photoEditingPresetInvalidError(): Error {
  return new PhotoEditingPresetInvalidError();
}

/** プリセット（XMP）を当てられないときの 1 行。 */
export function photoEditingPresetInvalidText(): string {
  return PHOTO_EDITING_PRESET_INVALID_TEXT;
}

/**
 * プリセット（XMP）を読む・取り込むときの失敗の 1 行。当てられない XMP は {@link PHOTO_EDITING_PRESET_INVALID_TEXT}、ほか（ファイルを
 * 読めない・段 2 の失敗など）は `describeOther`（写真の出どころの `errors.describeNative`）。
 */
export function describePhotoEditingPresetReadError(error: unknown, describeOther: (error: unknown) => string): string {
  return error instanceof PhotoEditingPresetInvalidError ? PHOTO_EDITING_PRESET_INVALID_TEXT : describeOther(error);
}

/** RAW と同じ写真なので入れなかった JPEG の知らせ（移行元設計）。 */
export function describePhotoCloudAddRawPairedJpegs(count: number): string {
  return `RAW と同じ写真の JPEG ${count} 枚は入れませんでした`;
}

/**
 * 「クラウドから消す」の確かめに添える、記事・資料で使っている数（移行元設計・移行元設計）。
 * 1 枚なら件数、2 枚以上なら使っていることだけを出す（同じ参照元を写真ごとに数え重ねないため）。どの写真も使っていなければ null。
 * 消しても本文の画像は残る（記事用の画像はサーバーが残す）。
 */
export function describePhotoCloudDeleteArticleUsage(articleCounts: readonly number[]): string | null {
  const usedCounts = articleCounts.filter((count) => count > 0);
  if (usedCounts.length === 0) return null;
  if (articleCounts.length === 1) return `${usedCounts[0]} 件の記事・資料で使っています。本文の画像は残ります。`;
  return "記事・資料で使っています。本文の画像は残ります。";
}

/** 「クラウドから消す」で消し終えたとき（状態欄）。 */
export function describePhotoCloudDeleteSummary(deletedCount: number): string {
  return deletedCount === 1 ? "クラウドから消しました" : `${deletedCount} 枚をクラウドから消しました`;
}

/** 「クラウドから消す」で消している間（状態欄）。 */
export const PHOTO_CLOUD_DELETING_NOTICE = "クラウドから消しています";
