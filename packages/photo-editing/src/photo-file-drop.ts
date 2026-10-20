import { formatPhotoCloudGigabytes } from "./photo-library-usage";
import { hasSpotImageDragData, hasTransferFiles } from "niho-ui/drag-transfer";
import type { AppConfirmOptions } from "niho-ui/app-dialog";

import { BROWSER_CLOUD_ORIGINAL_FILE_EXTENSIONS } from "./photo-original-files";

/**
 * Finder などから写真編集の面へ落とした写真を、クラウドの「写真」に足す（移行元設計・owner 決定 2026-09-29）の純粋な部分。
 *
 * - 受けるのは `Files` を運ぶドラッグだけ（記事制作の画像ライブラリのタイルのドラッグ・スライダーなどのページ内のドラッグは受けない）
 * - フォルダは中身ごと（サブフォルダまで）集める。`.` で始まる名前（`.DS_Store` など）は黙って飛ばし、数えない
 * - 形式（拡張子）で先にふるい、写真でないファイルは数えるだけにする（終わりに件数を知らせる）
 * - 足す合計が空きを超えるときだけ、始める前に 1 回確かめる
 */

/** 幕の見出し（受けられるとき） */
export const PHOTO_DROP_HEADLINE = "ドロップしてクラウドの「写真」に追加";
/** 幕の補足（受けられるとき） */
export const PHOTO_DROP_HINT = "JPEG・PNG・HEIC・TIFF・RAW／1 枚 200MB まで";
/** 幕の補足（追加している途中に落とすとき） */
export const PHOTO_DROP_QUEUED_HINT = "いま追加中の写真のあとに続けて追加します";
/** 受けられない理由（書き出している途中） */
export const PHOTO_DROP_EXPORTING_REASON = "書き出しが終わってから追加できます";
/** 受けられない理由（クラウドから消している途中） */
export const PHOTO_DROP_DELETING_REASON = "消し終わってから追加できます";
/** 受けられない理由（一覧で選んだ複数枚に補正を当てている途中。F5a-2 移行元設計） */
export const PHOTO_DROP_BULK_REASON = "補正を当て終わってから追加できます";
/** 受けられない理由（NIHO Desktop の「クラウドに追加」の途中） */
export const PHOTO_DROP_CLOUD_SAVING_REASON = "クラウドへの追加が終わってから追加できます";
/** 受けられない理由（NIHO Desktop で、この Mac の設定の「オリジナルを置く」がオフ） */
export const PHOTO_DROP_THIS_MAC_ORIGINALS_OFF_REASON = "この Mac の設定で、オリジナルをクラウドに置かないようにしています";
/** 落とした中に入れられる写真が 1 枚も無かった（追加している途中でないとき） */
export const PHOTO_DROP_NO_PHOTOS_MESSAGE = "入れられる写真がありませんでした（JPEG・PNG・HEIC・TIFF・RAW）";

/** 写真でないファイル（数えただけで入れなかった）の知らせ。 */
export function describePhotoDropNonPhotoFiles(count: number): string {
  return `写真でないファイル ${count} 件は入れませんでした`;
}

type TransferTypes = { types?: ArrayLike<string> | null };

/** 写真のファイルを運んでいるドラッグか（dragover の間は中身を読めないので、種類だけで決める）。 */
export function isPhotoFileDrag(dataTransfer: TransferTypes | null | undefined): boolean {
  return !!dataTransfer && hasTransferFiles(dataTransfer) && !hasSpotImageDragData(dataTransfer);
}

// ---------------------------------------------------------------------------
// 落としたファイルを集める（フォルダは中身ごと）

/** 落とした 1 項目（`webkitGetAsEntry()`。使うところだけの形にし、テストで偽物を渡せるようにする）。 */
export type PhotoDropEntry = {
  readonly isFile: boolean;
  readonly isDirectory: boolean;
  readonly name: string;
};

type PhotoDropFileEntry = PhotoDropEntry & {
  file: (onFile: (file: File) => void, onError?: (error: unknown) => void) => void;
};

type PhotoDropDirectoryReader = {
  readEntries: (onEntries: (entries: PhotoDropEntry[]) => void, onError?: (error: unknown) => void) => void;
};

type PhotoDropDirectoryEntry = PhotoDropEntry & { createReader: () => PhotoDropDirectoryReader };

type PhotoDropItem = {
  readonly kind: string;
  webkitGetAsEntry?: () => PhotoDropEntry | null;
  getAsFile?: () => File | null;
};

/** 落としたもの（`drop` の `dataTransfer`）のうち、ここで読むところ。 */
export type PhotoDropTransfer = {
  items?: ArrayLike<PhotoDropItem> | null;
  files?: ArrayLike<File> | null;
};

/** `drop` のハンドラの中で取り出した項目（ハンドラを抜けると `dataTransfer` は読めなくなるので、先に取り出しておく）。 */
export type CapturedPhotoDrop = {
  sources: ({ kind: "entry"; entry: PhotoDropEntry } | { kind: "file"; file: File })[];
};

function isFileEntry(entry: PhotoDropEntry): entry is PhotoDropFileEntry {
  return entry.isFile && typeof (entry as Partial<PhotoDropFileEntry>).file === "function";
}

function isDirectoryEntry(entry: PhotoDropEntry): entry is PhotoDropDirectoryEntry {
  return entry.isDirectory && typeof (entry as Partial<PhotoDropDirectoryEntry>).createReader === "function";
}

/** `.` で始まる名前（`.DS_Store`・隠しフォルダなど）。黙って飛ばし、写真でないファイルとしても数えない。 */
function isHiddenName(name: string): boolean {
  return name.startsWith(".");
}

/**
 * `drop` のハンドラの中で（同期的に）落とした項目を取り出す。entries API（`webkitGetAsEntry`）があれば全項目の entry を
 * 取り出し（フォルダは後で中身を辿る）、無い環境は `dataTransfer.files` に戻す。
 */
export function capturePhotoDrop(dataTransfer: PhotoDropTransfer): CapturedPhotoDrop {
  const items = Array.from(dataTransfer.items ?? []);
  if (!items.some((item) => typeof item.webkitGetAsEntry === "function")) {
    return { sources: Array.from(dataTransfer.files ?? []).map((file) => ({ kind: "file" as const, file })) };
  }
  const sources: CapturedPhotoDrop["sources"] = [];
  for (const item of items) {
    if (item.kind !== "file") continue;
    const entry = item.webkitGetAsEntry?.() ?? null;
    if (entry) {
      sources.push({ kind: "entry", entry });
      continue;
    }
    const file = item.getAsFile?.() ?? null;
    if (file) sources.push({ kind: "file", file });
  }
  return { sources };
}

function readEntryFile(entry: PhotoDropFileEntry): Promise<File | null> {
  return new Promise((resolve) => {
    try {
      entry.file(resolve, () => resolve(null));
    } catch {
      resolve(null);
    }
  });
}

/** フォルダの中身（`readEntries` は一度に全部を返さないので、空が返るまで読み続ける。読めなくなったら読めた分だけ）。 */
async function readDirectoryEntries(directory: PhotoDropDirectoryEntry): Promise<PhotoDropEntry[]> {
  const reader = directory.createReader();
  const entries: PhotoDropEntry[] = [];
  for (;;) {
    let batch: PhotoDropEntry[];
    try {
      batch = await new Promise<PhotoDropEntry[]>((resolve, reject) => reader.readEntries(resolve, reject));
    } catch {
      return entries;
    }
    if (batch.length === 0) return entries;
    entries.push(...batch);
  }
}

function compareEntryNames(a: PhotoDropEntry, b: PhotoDropEntry): number {
  return a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: "base" });
}

async function collectEntryFiles(entry: PhotoDropEntry): Promise<File[]> {
  if (isFileEntry(entry)) {
    const file = await readEntryFile(entry);
    return file ? [file] : [];
  }
  if (!isDirectoryEntry(entry) || isHiddenName(entry.name)) return [];
  // フォルダの中は名前の順（Finder の並びに近い）。サブフォルダも同じく辿る
  const children = (await readDirectoryEntries(entry)).sort(compareEntryNames);
  const nested = await Promise.all(children.map((child) => collectEntryFiles(child)));
  return nested.flat();
}

/** 取り出した項目からファイルを集める（フォルダはサブフォルダまで）。読めなかったファイルは飛ばす。 */
export async function collectPhotoDropFiles(captured: CapturedPhotoDrop): Promise<File[]> {
  const nested = await Promise.all(
    captured.sources.map((source) =>
      source.kind === "file" ? Promise.resolve([source.file]) : collectEntryFiles(source.entry),
    ),
  );
  return nested.flat();
}

// ---------------------------------------------------------------------------
// 形式でふるう

const PHOTO_EXTENSION_SET: ReadonlySet<string> = new Set(BROWSER_CLOUD_ORIGINAL_FILE_EXTENSIONS);

/** 落としたファイルを形式でふるった結果。 */
export type SortedPhotoDrop = {
  /** 入れる写真（形式が写真・RAW のファイル。大きさなどは入れるときに確かめる） */
  photos: File[];
  /** 写真でないファイルの数（隠しファイルは数えない） */
  nonPhotoCount: number;
};

/** 拡張子で先にふるう（`.` で始まる名前は黙って飛ばす）。 */
export function sortPhotoDropFiles(files: readonly File[]): SortedPhotoDrop {
  const photos: File[] = [];
  let nonPhotoCount = 0;
  for (const file of files) {
    const name = file.name.trim();
    if (isHiddenName(name)) continue;
    const dot = name.lastIndexOf(".");
    const extension = dot > 0 ? name.slice(dot + 1).toLowerCase() : "";
    if (PHOTO_EXTENSION_SET.has(extension)) photos.push(file);
    else nonPhotoCount += 1;
  }
  return { photos, nonPhotoCount };
}

// ---------------------------------------------------------------------------
// 空きの事前確認

/** 足すファイルの合計バイト。 */
export function sumPhotoFileBytes(files: readonly Pick<File, "size">[]): number {
  return files.reduce((total, file) => total + (Number.isFinite(file.size) && file.size > 0 ? file.size : 0), 0);
}

/**
 * 今回足すファイルの合計が空きを超えるときの確かめ（`appDialog.confirm` に渡す）。空きは使用量から、待っている・追加中で
 * まだ使用量に入っていない分（`reservedBytes`）を引いた値。超えなければ・使用量が分からなければ null（確かめない）。
 */
export function photoCloudCapacityConfirm(params: {
  addBytes: number;
  usage: { usedBytes: number; quotaBytes: number } | null | undefined;
  reservedBytes: number;
}): AppConfirmOptions | null {
  const { usage } = params;
  if (!usage) return null;
  const freeBytes = usage.quotaBytes - usage.usedBytes - Math.max(0, params.reservedBytes);
  if (params.addBytes <= freeBytes) return null;
  return {
    title: "空き容量を超えます",
    description: `合計 ${formatPhotoCloudGigabytes(params.addBytes)}GB・空き ${formatPhotoCloudGigabytes(freeBytes)}GB。入るところまで追加します。`,
    confirmLabel: "追加する",
    cancelLabel: "やめる",
  };
}
