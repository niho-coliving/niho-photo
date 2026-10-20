/**
 * 写真の面の拡大（ピンチ・ダブルタップ・拡大中のドラッグ）の計算（NIHO Photo 段 1 F6c 移行元設計）。React に依らない純関数。
 *
 * 状態は `transform: translate(x px, y px) scale(scale)`（transform-origin は中央）の 3 つの数。x / y は面の中央からのずれで、
 * 画は面の中央に置かれている前提（全体表示は `PHOTO_ZOOM_FIT`）。点（`focal`）も面の中央を原点にして渡す。
 */

export type PhotoZoomState = { scale: number; x: number; y: number };

export type PhotoZoomPoint = { x: number; y: number };

export type PhotoZoomBounds = {
  /** 画を切り抜く面の大きさ（CSS px） */
  areaWidth: number;
  areaHeight: number;
  /** 全体表示のときに見えている画の大きさ（CSS px。transform を当てる前） */
  contentWidth: number;
  contentHeight: number;
  maxScale: number;
};

/** 全体表示（拡大していない）。 */
export const PHOTO_ZOOM_FIT: PhotoZoomState = { scale: 1, x: 0, y: 0 };

/** 小さい画でも、ここまでは寄れる。 */
export const PHOTO_ZOOM_MIN_MAX_SCALE = 2;

export function isPhotoZoomed(state: PhotoZoomState): boolean {
  return state.scale > 1;
}

/** `focal` の下の画が動かないように、倍率を `nextScale` に変える（`t1 = p - (p - t0) * (s1 / s0)`）。 */
export function zoomAround(state: PhotoZoomState, focal: PhotoZoomPoint, nextScale: number): PhotoZoomState {
  if (!(state.scale > 0) || !(nextScale > 0)) return state;
  const ratio = nextScale / state.scale;
  return {
    scale: nextScale,
    x: focal.x - (focal.x - state.x) * ratio,
    y: focal.y - (focal.y - state.y) * ratio,
  };
}

/** ずれを ±limit に収める（画が面より小さい向きは 0。-0 と NaN も 0 にする）。 */
function withinLimit(value: number, limit: number): number {
  if (!(limit > 0)) return 0;
  return Math.min(Math.max(value, -limit), limit) || 0;
}

/**
 * 倍率を 1〜maxScale に、ずれを「拡大した画が面からはみ出した分の半分」までに収める（画の端が面の内側へ入らない）。
 * 倍率が 1 に戻ったら全体表示（ずれは 0）。
 */
export function clampZoom(state: PhotoZoomState, bounds: PhotoZoomBounds): PhotoZoomState {
  const scale = Math.min(Math.max(state.scale, 1), Math.max(1, bounds.maxScale));
  if (!(scale > 1)) return PHOTO_ZOOM_FIT;
  return {
    scale,
    x: withinLimit(state.x, (bounds.contentWidth * scale - bounds.areaWidth) / 2),
    y: withinLimit(state.y, (bounds.contentHeight * scale - bounds.areaHeight) / 2),
  };
}

/**
 * どこまで寄れるか。作業画像の 100%（画の 1px が CSS の 1px）まで。小さい画でも `PHOTO_ZOOM_MIN_MAX_SCALE` 倍までは寄れる。
 * `contentWidth` は全体表示で見えている画の幅、`intrinsicWidth` は画そのものの幅（canvas の `width`・img の `naturalWidth`）。
 */
export function resolveMaxZoomScale(input: { contentWidth: number; intrinsicWidth: number }): number {
  if (!(input.contentWidth > 0) || !(input.intrinsicWidth > 0)) return PHOTO_ZOOM_MIN_MAX_SCALE;
  return Math.max(PHOTO_ZOOM_MIN_MAX_SCALE, input.intrinsicWidth / input.contentWidth);
}

/** ダブルタップ: 全体表示なら `focal` を中心に 100%（= maxScale）へ、拡大中なら全体表示へ。収めるのは呼び出し側（`clampZoom`）。 */
export function toggleZoomAt(state: PhotoZoomState, focal: PhotoZoomPoint, maxScale: number): PhotoZoomState {
  if (isPhotoZoomed(state)) return PHOTO_ZOOM_FIT;
  return zoomAround(state, focal, maxScale);
}

/**
 * 要素の箱（`offsetWidth` / `offsetHeight`）の中で、実際に見えている画の大きさ（`object-fit: contain`）。
 * 箱が画の縦横比どおりならそのまま。画の大きさが分からなければ箱の大きさ。
 */
export function fitPhotoZoomContent(input: {
  boxWidth: number;
  boxHeight: number;
  intrinsicWidth: number;
  intrinsicHeight: number;
}): { width: number; height: number } {
  const { boxWidth, boxHeight, intrinsicWidth, intrinsicHeight } = input;
  if (!(boxWidth > 0) || !(boxHeight > 0)) return { width: 0, height: 0 };
  if (!(intrinsicWidth > 0) || !(intrinsicHeight > 0)) return { width: boxWidth, height: boxHeight };
  const ratio = Math.min(boxWidth / intrinsicWidth, boxHeight / intrinsicHeight);
  return { width: intrinsicWidth * ratio, height: intrinsicHeight * ratio };
}
