/** 最後の拡張子を除いた名前（`P1524180.RW2` → `P1524180`）。 */
export function photoEditingFileStem(fileName: string): string {
  const trimmed = fileName.trim();
  const dotIndex = trimmed.lastIndexOf(".");
  return dotIndex > 0 ? trimmed.slice(0, dotIndex) : trimmed;
}

/**
 * 拡張子（小文字・ドットなし、`P1524180.RW2` → `rw2`）。無ければ空文字。クラウドの写真置き場の準備に渡す
 * （使える拡張子かは API が確かめる）。
 */
export function photoEditingFileExtension(fileName: string): string {
  const trimmed = fileName.trim();
  const dotIndex = trimmed.lastIndexOf(".");
  return dotIndex > 0 ? trimmed.slice(dotIndex + 1).toLowerCase() : "";
}

/** RAW でない写真の拡張子（Desktop の `kind` と同じ決め方。ほかは RAW）。 */
const PHOTO_EDITING_RASTER_EXTENSIONS = new Set(["jpg", "jpeg", "png", "tif", "tiff", "heic", "heif"]);

/**
 * RAW の写真の拡張子か（クラウドの写真のタイルの「RAW」の印。小文字・ドットなし、大文字・小文字は問わない）。
 * 拡張子が無ければ RAW とみなさない。
 */
export function isPhotoEditingRawExtension(fileExtension: string): boolean {
  const extension = fileExtension.trim().replace(/^\./, "").toLowerCase();
  return extension !== "" && !PHOTO_EDITING_RASTER_EXTENSIONS.has(extension);
}

/** 書き出しの既定名 `<元の名前>-edited.jpg`。 */
export function buildPhotoEditingExportFileName(fileName: string): string {
  const stem = photoEditingFileStem(fileName) || "photo";
  return `${stem}-edited.jpg`;
}

/**
 * 取り込むプリセットの名前。XMP の `crs:Name` があればそれ、無ければファイル名。`maxChars`（写真の出どころのプリセットの名前の上限。
 * クラウドは 100 文字）で切る。
 */
export function resolveImportedPhotoPresetName(xmpName: string, fileName: string, maxChars: number): string {
  const name = xmpName.trim() || photoEditingFileStem(fileName) || "プリセット";
  return Array.from(name).slice(0, maxChars).join("").trim();
}
