/**
 * ヒストグラム（niho-photo#36）の計算と描画用の値づくり。画面に出ている 1 枚の画（develop-engine が返す sRGB 8bit の RGBA。
 * 長辺 1280px 前後）から、256 階調 × RGB の度数・黒つぶれ / 白飛びの割合・写真に重ねるクリップ領域の印を数える純関数。
 * エンジン（Rust / wasm）には触れず、補正値（`developSettings`）にも関わらない（表示だけの値）。
 */

/** 階調の数（8bit） */
export const PHOTO_EDITING_HISTOGRAM_LEVELS = 256;

/** クリップ領域の印の bit: いずれかのチャンネルが 0 の画素（黒つぶれ） */
export const PHOTO_EDITING_CLIP_SHADOW_FLAG = 1;
/** クリップ領域の印の bit: いずれかのチャンネルが 255 の画素（白飛び） */
export const PHOTO_EDITING_CLIP_HIGHLIGHT_FLAG = 2;

/**
 * 写真の上に重ねる色（Lightroom の J と同じ: 黒つぶれ = 青、白飛び = 赤）。写真のどんな色の上でも見分けがつくよう、画面の
 * token（落ち着いた色）ではなく、純色に近い固定の RGB を使う（canvas の画素に書くので CSS 変数は読めない）。
 */
export const PHOTO_EDITING_CLIP_SHADOW_RGB: readonly [number, number, number] = [0, 90, 255];
export const PHOTO_EDITING_CLIP_HIGHLIGHT_RGB: readonly [number, number, number] = [255, 30, 30];

/** 画素ごとのクリップの印（`PHOTO_EDITING_CLIP_*_FLAG` の組み合わせ。画の左上から行ごとに 1 画素 1 バイト） */
export type PhotoEditingClipMask = {
  width: number;
  height: number;
  flags: Uint8Array;
};

export type PhotoEditingHistogram = {
  /** 数えた画の大きさ */
  width: number;
  height: number;
  /** 数えた画素の数 */
  pixelCount: number;
  /** 階調（0〜255）ごとの度数 */
  red: Uint32Array;
  green: Uint32Array;
  blue: Uint32Array;
  /** いずれかのチャンネルが 0 / 255 の画素の数 */
  shadowClipped: number;
  highlightClipped: number;
  /** 上の数を画素の数で割った割合（0〜1。画素が無ければ 0） */
  shadowRate: number;
  highlightRate: number;
  /** クリップ領域の印（`mask: true` で数えたときだけ。それ以外は null） */
  clipMask: PhotoEditingClipMask | null;
};

function normalizedSize(value: number): number {
  return Number.isFinite(value) && value > 0 ? Math.floor(value) : 0;
}

/**
 * RGBA の画から 256 階調 × RGB の度数と、黒つぶれ（いずれかのチャンネルが 0）/ 白飛び（いずれかが 255）の割合を数える。
 * アルファは見ない。`rgba` が `width * height` 画素より短ければ、ある分だけ数える。`mask: true` のときは重ね表示用の印も作る
 * （全画素の 1 回の走査の中で作るので、印が要らないときは渡さない）。
 */
export function computePhotoEditingHistogram(
  rgba: Uint8ClampedArray,
  width: number,
  height: number,
  options: { mask?: boolean } = {},
): PhotoEditingHistogram {
  const frameWidth = normalizedSize(width);
  const frameHeight = normalizedSize(height);
  const red = new Uint32Array(PHOTO_EDITING_HISTOGRAM_LEVELS);
  const green = new Uint32Array(PHOTO_EDITING_HISTOGRAM_LEVELS);
  const blue = new Uint32Array(PHOTO_EDITING_HISTOGRAM_LEVELS);
  const framePixels = frameWidth * frameHeight;
  const pixelCount = Math.min(framePixels, Math.floor(rgba.length / 4));
  const flags = options.mask === true && framePixels > 0 ? new Uint8Array(framePixels) : null;
  let shadowClipped = 0;
  let highlightClipped = 0;
  if (flags) {
    for (let pixel = 0, offset = 0; pixel < pixelCount; pixel += 1, offset += 4) {
      const r = rgba[offset];
      const g = rgba[offset + 1];
      const b = rgba[offset + 2];
      red[r] += 1;
      green[g] += 1;
      blue[b] += 1;
      let flag = 0;
      if (r === 0 || g === 0 || b === 0) {
        shadowClipped += 1;
        flag = PHOTO_EDITING_CLIP_SHADOW_FLAG;
      }
      if (r === 255 || g === 255 || b === 255) {
        highlightClipped += 1;
        flag |= PHOTO_EDITING_CLIP_HIGHLIGHT_FLAG;
      }
      flags[pixel] = flag;
    }
  } else {
    for (let pixel = 0, offset = 0; pixel < pixelCount; pixel += 1, offset += 4) {
      const r = rgba[offset];
      const g = rgba[offset + 1];
      const b = rgba[offset + 2];
      red[r] += 1;
      green[g] += 1;
      blue[b] += 1;
      if (r === 0 || g === 0 || b === 0) shadowClipped += 1;
      if (r === 255 || g === 255 || b === 255) highlightClipped += 1;
    }
  }
  return {
    width: frameWidth,
    height: frameHeight,
    pixelCount,
    red,
    green,
    blue,
    shadowClipped,
    highlightClipped,
    shadowRate: pixelCount > 0 ? shadowClipped / pixelCount : 0,
    highlightRate: pixelCount > 0 ? highlightClipped / pixelCount : 0,
    clipMask: flags ? { width: frameWidth, height: frameHeight, flags } : null,
  };
}

/**
 * クリップ領域の印を、写真に重ねる RGBA にする（`target` は `flags.length * 4` 以上。全画素を書くので使い回せる）。
 * 見せる側（黒つぶれ = 青 / 白飛び = 赤）だけ不透明に塗り、ほかは透明。両方の印がある画素は白飛び（赤）を優先する。
 */
export function fillPhotoEditingClipOverlay(
  target: Uint8ClampedArray,
  mask: PhotoEditingClipMask,
  show: { shadows: boolean; highlights: boolean },
): void {
  const { flags } = mask;
  const count = Math.min(flags.length, Math.floor(target.length / 4));
  const [shadowR, shadowG, shadowB] = PHOTO_EDITING_CLIP_SHADOW_RGB;
  const [highlightR, highlightG, highlightB] = PHOTO_EDITING_CLIP_HIGHLIGHT_RGB;
  for (let pixel = 0, offset = 0; pixel < count; pixel += 1, offset += 4) {
    const flag = flags[pixel];
    if (show.highlights && (flag & PHOTO_EDITING_CLIP_HIGHLIGHT_FLAG) !== 0) {
      target[offset] = highlightR;
      target[offset + 1] = highlightG;
      target[offset + 2] = highlightB;
      target[offset + 3] = 255;
    } else if (show.shadows && (flag & PHOTO_EDITING_CLIP_SHADOW_FLAG) !== 0) {
      target[offset] = shadowR;
      target[offset + 1] = shadowG;
      target[offset + 2] = shadowB;
      target[offset + 3] = 255;
    } else {
      target[offset] = 0;
      target[offset + 1] = 0;
      target[offset + 2] = 0;
      target[offset + 3] = 0;
    }
  }
}

/**
 * 縦軸の最大の度数。両端の階調（0 と 255）はクリップした画素が積み重なって突き抜けやすいので、中間（1〜254）の最大で決め、
 * 両端はグラフの高さで頭打ちにする。中間がすべて空（真っ黒・真っ白だけの画）なら全階調の最大。度数が無ければ 1。
 */
export function photoEditingHistogramPeak(histogram: Pick<PhotoEditingHistogram, "red" | "green" | "blue">): number {
  const channels = [histogram.red, histogram.green, histogram.blue];
  let interior = 0;
  let edge = 0;
  for (const counts of channels) {
    const last = counts.length - 1;
    for (let level = 0; level <= last; level += 1) {
      const count = counts[level];
      if (level === 0 || level === last) edge = Math.max(edge, count);
      else interior = Math.max(interior, count);
    }
  }
  return interior > 0 ? interior : edge > 0 ? edge : 1;
}

const roundPath = (value: number) => Math.round(value * 100) / 100;

/** 階調 i を x = i + 0.5 に置いた点列（度数が `peak` 以上なら y = 0、度数 0 なら y = `height`）。 */
function histogramPoints(counts: Uint32Array, peak: number, height: number): string[] {
  const scale = peak > 0 ? peak : 1;
  const points: string[] = [];
  for (let level = 0; level < counts.length; level += 1) {
    const ratio = Math.min(1, counts[level] / scale);
    points.push(`${level + 0.5} ${roundPath(height * (1 - ratio))}`);
  }
  return points;
}

/**
 * 1 チャンネルの度数を、幅 256 × 高さ `height` の SVG 座標（左上が原点）の塗りの path にする。左下から始まり、階調 i を
 * x = i + 0.5 に置いた点を通って右下で閉じる。度数が `peak` 以上なら一番上（y = 0）、度数 0 なら一番下（y = `height`）。
 */
export function photoEditingHistogramAreaPath(counts: Uint32Array, peak: number, height: number): string {
  const base = roundPath(height);
  return `M0 ${base}${histogramPoints(counts, peak, height).map((point) => `L${point}`).join("")}L${counts.length} ${base}Z`;
}

/** 上の塗りの上辺だけの線（左右・下の辺は含めない）。 */
export function photoEditingHistogramLinePath(counts: Uint32Array, peak: number, height: number): string {
  return histogramPoints(counts, peak, height)
    .map((point, index) => `${index === 0 ? "M" : "L"}${point}`)
    .join("");
}
