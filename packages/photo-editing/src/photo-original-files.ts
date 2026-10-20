import type { PhotoLibraryQuotaExceeded } from "./library/photo-library";

/**
 * 写真編集に足せるオリジナルのファイル（選べる拡張子・大きさの上限）と、「写真を追加」「書き出す」の失敗の型（移行元設計。NIHO camera C1
 * 移行元設計 で web の browser-photo-cloud-originals から移した。クラウドの実装は web がこの型で投げる）。画面の文言は「原本」「元の写真」
 * ではなく「オリジナル」。
 */
export const BROWSER_CLOUD_ORIGINAL_MAX_BYTES = 200 * 1024 ** 2;
/**
 * 選べる拡張子（JPEG / PNG / TIFF / HEIC / HEIF と Desktop 対応の RAW。クラウドの写真置き場の API・NIHO Desktop の
 * 「写真を開く」と同じ一覧）。WebP は API が 400 `photo_cloud_file_type_unsupported` で断るので選べない。
 */
export const BROWSER_CLOUD_ORIGINAL_FILE_EXTENSIONS = [
  "jpg", "jpeg", "png", "tif", "tiff", "heic", "heif", "dng", "rw2", "cr2", "cr3", "crw",
  "nef", "nrw", "arw", "srf", "sr2", "raf", "orf", "pef", "srw", "rwl", "3fr", "fff", "iiq",
  "erf", "mef", "mos", "mrw", "x3f", "raw", "kdc", "dcr", "gpr",
] as const;

const ORIGINAL_EXTENSION_SET: ReadonlySet<string> = new Set(BROWSER_CLOUD_ORIGINAL_FILE_EXTENSIONS);
const FILE_NAME_MAX_CHARS = 255;

/** 拠点がオリジナルのクラウド保存を許可していない（「＋」の title と、途中で切り替わったときの状態欄）。 */
export const BROWSER_CLOUD_ORIGINALS_DISABLED_MESSAGE = "この拠点では写真をクラウドに置けません";
/**
 * 「写真を追加」「書き出す」の失敗。`reason` は、残りを止める失敗（`quota` 容量超え・`originals_disabled` 拠点が許可して
 * いない）と、選び直しが要る失敗（`invalid`）と、そのほか（`failed`。もう一度試せる）を分ける。
 */
export class BrowserCloudOriginalError extends Error {
  constructor(
    message: string,
    readonly reason: "invalid" | "quota" | "originals_disabled" | "failed" = "failed",
    readonly quota: PhotoLibraryQuotaExceeded | null = null,
  ) {
    super(message);
    this.name = "BrowserCloudOriginalError";
  }
}

export type BrowserCloudOriginalValidation =
  | { ok: true; fileExtension: string }
  | { ok: false; message: string };

export function validateBrowserCloudOriginalFile(file: Pick<File, "name" | "size">): BrowserCloudOriginalValidation {
  const fileName = file.name.trim();
  const dot = fileName.lastIndexOf(".");
  const fileExtension = dot > 0 ? fileName.slice(dot + 1).toLowerCase() : "";
  if (!fileName || fileName.length > FILE_NAME_MAX_CHARS || !ORIGINAL_EXTENSION_SET.has(fileExtension)) {
    return { ok: false, message: "対応していない形式です。写真または RAW ファイルを選んでください。" };
  }
  if (!Number.isSafeInteger(file.size) || file.size < 1) {
    return { ok: false, message: "空のファイルは追加できません。" };
  }
  if (file.size > BROWSER_CLOUD_ORIGINAL_MAX_BYTES) {
    return { ok: false, message: "写真は 1 枚 200MB までです。" };
  }
  return { ok: true, fileExtension };
}
