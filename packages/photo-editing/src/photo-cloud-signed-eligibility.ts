/**
 * API の `isPhotoCloudWorkSignedRecipeEligible` と同じ「一度も補正を保存していない」判定。
 * 古い応答などで項目が欠けている場合は signed current へ自動移行しない。
 */
export function isPhotoCloudSignedRecipeEligible(photo: {
  developSettings?: unknown;
  developSettingsUpdatedAt?: unknown;
  developRevision?: unknown;
  hasEdits?: unknown;
}): boolean {
  return (
    photo.developSettings === null &&
    photo.developSettingsUpdatedAt === null &&
    photo.developRevision === 0 &&
    photo.hasEdits === false
  );
}
