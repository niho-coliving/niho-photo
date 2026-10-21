import type { DevelopFrame } from "./develop-engine-client";

/** 縦横比が同じとみなす差（640px と 1280px の丸めの違いを許す。幾何が変わったら同じにならない） */
const SAME_ASPECT_TOLERANCE = 0.01;

/**
 * 操作中の小さな画（色ポイント・マスクの drag は 640px。`developInteractiveMaxDimension`）を、今の canvas の大きさのまま引き伸ばして
 * 描くか。canvas の画素の大きさが画面の大きさを決める（`max-w-full` の canvas は画素より大きく見せない）ので、canvas を画に合わせて
 * 縮めると drag の間だけ写真が小さく見え、上に重ねたつまみも動いてしまう。画が canvas より小さく、縦横比が同じ（同じ幾何）ときだけ。
 */
export function keepsDevelopCanvasSize(canvas: { width: number; height: number }, frame: { width: number; height: number }): boolean {
  if (!(frame.width > 0 && frame.height > 0 && canvas.width > 0 && canvas.height > 0)) return false;
  if (frame.width >= canvas.width || frame.height >= canvas.height) return false;
  return Math.abs(frame.width / frame.height - canvas.width / canvas.height) < SAME_ASPECT_TOLERANCE;
}

let scratchCanvas: HTMLCanvasElement | null = null;

/**
 * 段 2 で描いた画（sRGB 8bit RGBA）を canvas に出す（大きさも画に合わせる）。ブラウザ版と NIHO Desktop（移行元設計 S7b）の
 * プレビューが使う。2D の context が無い環境では何もしない。`keepSize` のとき、操作中の小さな画は canvas の大きさのまま引き伸ばして
 * 描く（{@link keepsDevelopCanvasSize}。離した後の丁寧な画で元の画素に戻る）。
 */
export function paintDevelopFrame(canvas: HTMLCanvasElement, frame: DevelopFrame, options: { keepSize?: boolean } = {}): void {
  const context = canvas.getContext("2d");
  if (!context) return;
  if (options.keepSize && keepsDevelopCanvasSize(canvas, frame) && typeof document !== "undefined") {
    scratchCanvas ??= document.createElement("canvas");
    const scratch = scratchCanvas;
    if (scratch.width !== frame.width) scratch.width = frame.width;
    if (scratch.height !== frame.height) scratch.height = frame.height;
    const scratchContext = scratch.getContext("2d");
    if (scratchContext) {
      scratchContext.putImageData(new ImageData(frame.rgba, frame.width, frame.height), 0, 0);
      context.imageSmoothingEnabled = true;
      context.clearRect(0, 0, canvas.width, canvas.height);
      context.drawImage(scratch, 0, 0, canvas.width, canvas.height);
      return;
    }
  }
  if (canvas.width !== frame.width) canvas.width = frame.width;
  if (canvas.height !== frame.height) canvas.height = frame.height;
  context.putImageData(new ImageData(frame.rgba, frame.width, frame.height), 0, 0);
}
