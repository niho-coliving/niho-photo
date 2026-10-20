import type { DevelopFrame } from "./develop-engine-client";

/**
 * 段 2 で描いた画（sRGB 8bit RGBA）を canvas に出す（大きさも画に合わせる）。ブラウザ版と NIHO Desktop（移行元設計 S7b）の
 * プレビューが使う。2D の context が無い環境では何もしない。
 */
export function paintDevelopFrame(canvas: HTMLCanvasElement, frame: DevelopFrame): void {
  const context = canvas.getContext("2d");
  if (!context) return;
  if (canvas.width !== frame.width) canvas.width = frame.width;
  if (canvas.height !== frame.height) canvas.height = frame.height;
  context.putImageData(new ImageData(frame.rgba, frame.width, frame.height), 0, 0);
}
