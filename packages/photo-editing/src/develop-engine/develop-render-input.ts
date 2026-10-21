import type { DevelopEngine, DevelopExportOptions } from "./develop-engine-client";
import {
  hasSavedDevelopSettings,
  isNeutralDevelopSettings,
  readDevelopSettings,
  type DevelopSettings,
} from "./develop-settings";
import type { DevelopWorkCopyEncoding } from "./develop-work-cache";
import type {
  PhotoLibrary,
  PhotoLibraryOriginalSource,
  PhotoLibraryWorkingCopy,
} from "../library/photo-library";

import {
  BrowserPhotoSourceError,
  browserCloudOriginalMaxBytes,
  isBrowserPhotoDecodableSize,
  readBrowserPhotoPixelSize,
} from "../browser-photo-source";
import {
  canOpenDevelopWorkInstead,
  isDevelopOriginalJpeg,
  isDevelopWorkTarget,
  rememberDevelopOriginalTooLarge,
  type DevelopWorkTargetPhoto,
} from "./develop-work-target";

/*
 * 段 2 で描く入力（NIHO camera C1 移行元設計 で web の develop-web-image・develop-render-input から移した）: 入力の形と、作業コピーの
 * 開き方・JPEG の描き方、写真の出どころから入力を読む関数。記事用の画像を付けるのは web（`develop-web-image.ts`）。
 */

/** 記事用の画像の JPEG の品質（1〜100）。 */
export const DEVELOP_WEB_IMAGE_JPEG_QUALITY = 90;

/**
 * 作業コピーの入力（移行元設計）。中身（`encoding`）は RAW が 16bit PNG、RAW 以外が ICC 付きの 8bit JPEG（K5 移行元設計）で、どちらも
 * 補正の `base` は土台の版（`baseVersion`。決まりごと 4）。
 */
export type DevelopWorkingCopyInput = {
  kind: "workingCopy";
  encoding: DevelopWorkCopyEncoding;
  bytes: ArrayBuffer;
  /** 作業コピーのメタデータ（`work.meta`）の JSON（PNG の作業コピーを開くときに使う） */
  metaJson: string;
  baseVersion: string;
};

/**
 * 段 2 で描く入力。JPEG・小さな PNG は不変のオリジナル、RAW・HEIC / HEIF・TIFF・大きな PNG と作業コピーで直す JPEG（K5-a 移行元設計）
 * は作業コピー（{@link DevelopWorkingCopyInput}）。bytes は Worker へ渡して手放すので、呼び出し側がコピーを渡す。
 */
export type DevelopRenderInput = { kind: "original"; bytes: ArrayBuffer } | DevelopWorkingCopyInput;

/**
 * JPEG の作業コピーを段 2 に開くときに縮める長辺（0 = 縮めない）。作業コピーは長辺 2560px で作ってあり、16bit PNG の作業コピー
 * （`openWorkingCopy`）と同じく原寸のまま持つ（描く大きさは `render` で決める。K5 移行元設計）。
 */
export const DEVELOP_JPEG_WORK_COPY_WORKING_MAX_DIMENSION = 0;

/** 読んだ作業コピーを段 2 の入力にする。 */
export function developWorkingCopyInputOf(
  copy: Pick<PhotoLibraryWorkingCopy, "encoding" | "bytes" | "metaJson" | "baseVersion">,
): DevelopWorkingCopyInput {
  return {
    kind: "workingCopy",
    encoding: copy.encoding,
    bytes: copy.bytes,
    metaJson: copy.metaJson,
    baseVersion: copy.baseVersion,
  };
}

/** 作業コピーの入力を、Worker へ渡すコピーにする（Worker は受け取った bytes を手放す）。 */
export function copyDevelopWorkingCopyInput(input: DevelopWorkingCopyInput): DevelopWorkingCopyInput {
  return { ...input, bytes: input.bytes.slice(0) };
}

/**
 * 作業コピーを段 2 に開いて持たせる（`bytes` は Worker へ渡して手放すので、呼び出し側がコピーを渡す）。16bit PNG は
 * `openWorkingCopy(png, metaJson)`、ICC 付きの 8bit JPEG は JPEG のオリジナルと同じ入口（`open`）で原寸のまま開く
 * （{@link DEVELOP_JPEG_WORK_COPY_WORKING_MAX_DIMENSION}。K5 移行元設計）。どちらも補正の `base` は作業コピーの版のまま。
 */
export function openDevelopWorkingCopy(
  engine: Pick<DevelopEngine, "open" | "openWorkingCopy">,
  input: DevelopWorkingCopyInput,
): Promise<{ width: number; height: number }> {
  return input.encoding === "jpeg8"
    ? engine.open(input.bytes, DEVELOP_JPEG_WORK_COPY_WORKING_MAX_DIMENSION)
    : engine.openWorkingCopy(input.bytes, input.metaJson);
}

/**
 * 入力を JPEG に描く（持っている写真は変えない）。Worker への要求は最初の await より前に出す（呼び出し側が、この後すぐに写真や
 * Worker を手放しても描き終える）。16bit PNG の作業コピーは `exportWorkingCopyJpeg`、オリジナルと JPEG の作業コピー（K5 移行元設計）は
 * `exportJpeg` で描く（補正の `base` は呼び出し側が作業コピーの版にしてある）。描かれる面のマスク（M4 #68）があれば、engine は面を
 * `options.maskSurfaces`（省略 = engine が覚えた面と開いている写真の読み口）から読んでから出す（書き出しとしては先に数える）。
 */
export function exportDevelopJpeg(
  engine: DevelopEngine,
  input: DevelopRenderInput,
  settings: DevelopSettings,
  options: DevelopExportOptions,
): Promise<Uint8Array<ArrayBuffer>> {
  return input.kind === "workingCopy" && input.encoding === "png16"
    ? engine.exportWorkingCopyJpeg(input.bytes, input.metaJson, settings, options)
    : engine.exportJpeg(input.bytes, settings, options);
}

/** 写真の出どころのうち、段 2 で描く入力を読むのに使う口。 */
export type PhotoLibraryRenderInputSource = Pick<PhotoLibrary, "loadOriginal" | "ensureWorkingCopy" | "loadWorkingCopy">;

/**
 * 段 2 で描く入力を、写真の出どころ（接続口 `PhotoLibrary`）から読む（写真編集の一覧から書き出す JPEG の描画 F7b 移行元設計 と、
 * 記事制作の「描いてから使う」移行元設計 が使う）。作業コピーから描く写真（RAW・HEIC / HEIF・TIFF・大きな PNG・作業コピーで直す JPEG。
 * 移行元設計）は作業コピー（クラウドは Cache Storage にあればそれ、無ければ GCS。中身は 16bit PNG か ICC 付きの 8bit JPEG。K5 移行元設計）を、
 * ほかは不変のオリジナル（`original`。`openOriginal` の参照）を読む。オリジナルを読んで大きすぎた JPEG（4,000 万画素・64MiB を超える。
 * K5-a 移行元設計）は覚えて作業コピーから描く。作業コピーがまだできていない・作らない写真は `notReady`（失敗ではない）。止めたら
 * （`signal`）AbortError などをそのまま投げる。
 */
export async function loadPhotoLibraryRenderInput(
  library: PhotoLibraryRenderInputSource,
  params: {
    photo: DevelopWorkTargetPhoto;
    /** 開いたオリジナル（{@link PhotoLibrary.openOriginal} の `source`） */
    original: PhotoLibraryOriginalSource;
    /** オリジナルを読むときのファイル名 */
    fileName: string;
    signal: AbortSignal;
  },
): Promise<DevelopRenderInput | { kind: "notReady" } | { kind: "unavailable"; message: string }> {
  const { photo, signal } = params;
  if (!isDevelopWorkTarget(photo)) {
    const original = await readOriginal(library, params);
    if (original) return original;
    // 大きすぎた JPEG。このタブの間は作業コピーから描く（まだなら作業コピーを求める）
    rememberDevelopOriginalTooLarge(photo.id);
  }
  const settings = readDevelopSettings(photo.developSettings);
  const base = typeof settings === "object" && settings !== null && "base" in settings ? settings.base : null;
  const work = await library.ensureWorkingCopy(photo.id, {
    signal,
    sourceContext: {
      hasSavedDevelopSettings: hasSavedDevelopSettings(photo),
      hasDevelopEdits: settings !== null && !isNeutralDevelopSettings(settings),
      baseVersion: typeof base === "string" ? base : null,
    },
  });
  if (work.kind === "incompatible" || work.kind === "baseUnavailable") {
    return { kind: "unavailable", message: work.message };
  }
  if (work.kind !== "ready") return { kind: "notReady" };
  const copy = await library.loadWorkingCopy(photo.id, work.download, { signal });
  return developWorkingCopyInputOf(copy);
}

/** オリジナルを読む。JPEG が大きすぎた（段 2 が読まない 4,000 万画素超・64MiB 超）ときは null。 */
async function readOriginal(
  library: Pick<PhotoLibrary, "loadOriginal">,
  params: { photo: DevelopWorkTargetPhoto; original: PhotoLibraryOriginalSource; fileName: string; signal: AbortSignal },
): Promise<DevelopRenderInput | null> {
  const { photo } = params;
  try {
    const file = await library.loadOriginal(photo.id, params.original, {
      signal: params.signal,
      fileName: params.fileName,
      maxBytes: browserCloudOriginalMaxBytes(photo.fileExtension),
    });
    if (isDevelopOriginalJpeg(photo)) {
      // 段 2 はヘッダで 4,000 万画素を超える画像を読まないので、描く前に同じ上限で確かめる（読めないヘッダは段 2 に任せる）
      const size = await readBrowserPhotoPixelSize(file, file.size);
      if (size && !isBrowserPhotoDecodableSize(size)) throw new BrowserPhotoSourceError("too_large");
    }
    return { kind: "original", bytes: await file.arrayBuffer() };
  } catch (error) {
    if (!params.signal.aborted && canOpenDevelopWorkInstead(photo, error)) return null;
    throw error;
  }
}
