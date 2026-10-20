import {
  applyCutoutStrokes,
  composeCutoutRgba,
  cutoutBackgroundForFormat,
  decodeCutoutMaskPng,
  downscaleCutoutMask,
  selectedCutoutSubject,
  type CutoutMask,
  type CutoutRecipe,
  type CutoutSubject,
} from "./photo-cutout";
import { photoEditingCutoutFailureText } from "./photo-editing-copy";

import { BrowserPhotoSourceError } from "./browser-photo-source";

/**
 * 背景除去を当てた書き出し（NIHO camera だけ。C4 移行元設計・移行時の設計文書）。1 枚で開いている写真を、今の JPEG の
 * 書き出しと同じ入力・補正・大きさで段 2 の wasm で描き（背景除去を当てる前なので最高の画質・EXIF 無し）、RGBA に読んで、原寸のマスクを
 * その大きさに縮めてブラシを塗り、背景を当てて PNG / JPEG にする。原寸は camera の native（口の `exportFullSize`）が描く。
 *
 * - 画素の計算（{@link composeBrowserPhotoCutoutRgba}）は DOM を使わない（テストで照合する）。RGBA への読み込みと PNG / JPEG への
 *   書き出しは canvas の薄い部品（{@link decodeBrowserPhotoJpegRgba}・{@link encodeBrowserPhotoRgba}）
 * - マスクの縦横比が描いた画と 1% を超えて違えば当てない（`mask_mismatch`。プレビューと同じ許し）。マスクは拡大しない
 */

export type BrowserPhotoCutoutExportFormat = "png" | "jpeg";

/** 背景除去を当てる前の画の JPEG の画質（合成の前に画質を落とさない）。 */
export const BROWSER_PHOTO_CUTOUT_RENDER_JPEG_QUALITY = 100;

/** 描いた画とマスクの縦横比の許し（プレビューの `applyToCanvas` と同じ）。 */
const ASPECT_TOLERANCE = 0.01;

/**
 * 書き出しに背景除去を当てる写真（`useBrowserPhotoCutout` の `exportable`。写真に重ねている間だけ持つ）。口は写真の key を
 * 閉じ込めて渡す。
 */
export type BrowserPhotoCutoutExport = {
  photoKey: string;
  recipe: CutoutRecipe;
  subject: CutoutSubject;
  /** 選んだ被写体の原寸のマスクの PNG（口の `readMask`） */
  readMask: () => Promise<Uint8Array>;
  /** 原寸の書き出し（口の `exportFullSize`。camera が渡したときだけ） */
  exportFullSize?: (request: {
    recipe: CutoutRecipe;
    settings: object;
    format: BrowserPhotoCutoutExportFormat;
  }) => Promise<{ saved: boolean; fileName: string }>;
};

/** 背景除去を当てられなかった（`code` は sidecar の error と同じ名前。状態欄の 1 行は `photoEditingCutoutFailureText`）。 */
export class BrowserPhotoCutoutExportError extends Error {
  constructor(readonly code: string) {
    super(photoEditingCutoutFailureText(code));
    this.name = "BrowserPhotoCutoutExportError";
  }
}

/**
 * 描いた RGBA（`width` x `height`。ストレートの alpha）に、レシピの背景除去を当てた RGBA を返す（`rgba` は書き換えない）:
 * 選んだ被写体の原寸のマスク（`maskPng`）を数のまま読み → 描いた大きさへ面積平均で縮め → 確定したブラシをその大きさで塗り →
 * 形式の背景（JPEG は透明を白に）で合成する。プレビューと同じ順・同じ計算。
 *
 * マスクを読めなければ `corrupt_mask`、寸法が detect の答えと違う・縦横比が描いた画と 1% を超えて違う・描いた画より小さい（拡大は
 * しない）なら `mask_mismatch` の {@link BrowserPhotoCutoutExportError}。
 */
export async function composeBrowserPhotoCutoutRgba(params: {
  rgba: Uint8ClampedArray;
  width: number;
  height: number;
  maskPng: Uint8Array;
  recipe: CutoutRecipe;
  format: BrowserPhotoCutoutExportFormat;
}): Promise<Uint8ClampedArray<ArrayBuffer>> {
  const { rgba, width, height, recipe } = params;
  if (width <= 0 || height <= 0 || rgba.length !== width * height * 4) throw new BrowserPhotoSourceError("encode_failed");
  const subject = selectedCutoutSubject(recipe);
  let mask: CutoutMask;
  try {
    mask = await decodeCutoutMaskPng(params.maskPng);
  } catch {
    throw new BrowserPhotoCutoutExportError("corrupt_mask");
  }
  if (mask.width !== subject.maskWidth || mask.height !== subject.maskHeight) throw new BrowserPhotoCutoutExportError("mask_mismatch");
  if (Math.abs(width / height / (mask.width / mask.height) - 1) > ASPECT_TOLERANCE) {
    throw new BrowserPhotoCutoutExportError("mask_mismatch");
  }
  const scaled = downscaleCutoutMask(mask, width, height);
  if (scaled.width !== width || scaled.height !== height) throw new BrowserPhotoCutoutExportError("mask_mismatch");
  const pixels = applyCutoutStrokes(scaled.pixels, width, height, recipe.strokes);
  return composeCutoutRgba(rgba, { width, height, pixels }, cutoutBackgroundForFormat(recipe.background, params.format));
}

/** 段 2 が描いた JPEG（sRGB・ICC なし）を、色の変換を掛けずに RGBA に読む。読めなければ `encode_failed`。 */
export async function decodeBrowserPhotoJpegRgba(
  bytes: Uint8Array<ArrayBuffer>,
): Promise<{ rgba: Uint8ClampedArray; width: number; height: number }> {
  let bitmap: ImageBitmap;
  try {
    bitmap = await createImageBitmap(new Blob([bytes], { type: "image/jpeg" }), { colorSpaceConversion: "none" });
  } catch {
    throw new BrowserPhotoSourceError("encode_failed");
  }
  const canvas = document.createElement("canvas");
  try {
    canvas.width = bitmap.width;
    canvas.height = bitmap.height;
    const context = canvas.getContext("2d", { willReadFrequently: true });
    if (!context) throw new BrowserPhotoSourceError("encode_failed");
    context.drawImage(bitmap, 0, 0);
    const image = context.getImageData(0, 0, bitmap.width, bitmap.height);
    return { rgba: image.data, width: image.width, height: image.height };
  } finally {
    bitmap.close();
    canvas.width = 1;
    canvas.height = 1;
  }
}

/** RGBA を PNG（alpha のまま）か JPEG（`quality` は 1〜100）にする。書き出せなければ `encode_failed`。 */
export async function encodeBrowserPhotoRgba(
  rgba: Uint8ClampedArray<ArrayBuffer>,
  width: number,
  height: number,
  encoding: { type: "image/png" } | { type: "image/jpeg"; quality: number },
): Promise<Blob> {
  const canvas = document.createElement("canvas");
  try {
    canvas.width = width;
    canvas.height = height;
    const context = canvas.getContext("2d");
    if (!context) throw new BrowserPhotoSourceError("encode_failed");
    context.putImageData(new ImageData(rgba, width, height), 0, 0);
    const quality = encoding.type === "image/jpeg" ? encoding.quality / 100 : undefined;
    const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, encoding.type, quality));
    if (!blob) throw new BrowserPhotoSourceError("encode_failed");
    return blob;
  } finally {
    canvas.width = 1;
    canvas.height = 1;
  }
}
