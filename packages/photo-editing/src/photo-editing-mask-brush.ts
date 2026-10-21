import { geometryOutputToSource, type DevelopSize } from "./develop-engine/develop-geometry";
import type { PhotoEditingMaskFrame, Vec2 } from "./photo-editing-masks";

/**
 * ブラシのマスク（部分補正。Epic #31 M4 #68）の塗りの計算（React に依らない純粋な関数）。契約は `docs/local-adjustments.md`。
 *
 * - 面は**作業画像**（EXIF の向き反映済み・幾何の前）全体に重ねた `width × height` の 8bit の値（0〜255）。面の画素 `i` の中心は
 *   作業画像の `u = (i + 0.5) / width`（エンジンの標本位置 `u·width − 0.5` と同じ）。画面は見えている出力（切り抜き・回転・反転・
 *   角度補正の後）の上で塗るので、ポインタの位置は出力 → 作業画像（`geometryOutputToSource`）→ 面の画素に直す
 * - ブラシの大きさは見えている出力の短い辺に対する割合（半径。%）。切り抜き・回転・反転・角度補正では相似写像、遠近では局所の
 *   ヤコビアンで画面上の円を面上の楕円へ写す。面の画素が作業画像と少し違っても作業画像上の形を保てるよう、面の画素で計算する
 * - 1 つの dab のかかり具合はぼかし（0〜100）の滑らかな縁（中心から `1 − ぼかし` までが 1、縁で 0。`s²(3 − 2s)`。ぼかし 0 でも縁の
 *   約 1 画素はなじませる）× 流量（1〜100%）。dab は線に沿って半径の 25% ごとに置く
 * - 1 ストロークの間は面の画素ごとに `A ← A + (1 − A)·a`（f32）を重ね、終わりに 1 回だけ丸める: 塗りは `v + (255 − v)·A`（dab ごとに
 *   `v += (255 − v)·a` を重ねたのと同じ）、消しゴムは `v·(1 − A)`（`v −= v·a`）。同じ入力は同じ結果
 */

/** 新しいブラシの面の長辺（画素）。短い辺は作業画像の縦横比（1 以上）。 */
export const PHOTO_EDITING_MASK_SURFACE_LONG_EDGE = 1024;

/** ブラシの大きさ（半径。見えている出力の短い辺に対する %）。 */
export const PHOTO_EDITING_MASK_BRUSH_SIZE_MIN = 0.5;
export const PHOTO_EDITING_MASK_BRUSH_SIZE_MAX = 30;
export const PHOTO_EDITING_MASK_BRUSH_SIZE_STEP = 0.5;
export const PHOTO_EDITING_MASK_BRUSH_SIZE_DEFAULT = 6;
/** ぼかし（0〜100）・流量（1〜100%）の既定。 */
export const PHOTO_EDITING_MASK_BRUSH_FEATHER_DEFAULT = 50;
export const PHOTO_EDITING_MASK_BRUSH_FLOW_MIN = 1;
export const PHOTO_EDITING_MASK_BRUSH_FLOW_DEFAULT = 50;
/** dab の間隔（半径に対する割合）。 */
export const PHOTO_EDITING_MASK_BRUSH_SPACING = 0.25;
/** 面の画素の半径の下限（中心が画素の境目でも 1 画素は塗る）。 */
const MIN_SURFACE_RADIUS = 0.75;

export type PhotoEditingMaskBrush = {
  /** 半径（見えている出力の短い辺に対する %） */
  size: number;
  /** ぼかし（0〜100） */
  feather: number;
  /** 流量（1〜100%） */
  flow: number;
  /** 消しゴム */
  erase: boolean;
};

export const PHOTO_EDITING_MASK_BRUSH_DEFAULT: PhotoEditingMaskBrush = Object.freeze({
  size: PHOTO_EDITING_MASK_BRUSH_SIZE_DEFAULT,
  feather: PHOTO_EDITING_MASK_BRUSH_FEATHER_DEFAULT,
  flow: PHOTO_EDITING_MASK_BRUSH_FLOW_DEFAULT,
  erase: false,
});

/** 面の値（行優先・`width·height` byte）。 */
export type PhotoEditingMaskSurfaceData = { width: number; height: number; data: Uint8Array };

/** 面の画素の 1 つの dab（中心と、縦横の境界半径）。metric があれば逆共分散行列で距離を測る。 */
export type PhotoEditingMaskDab = { x: number; y: number; rx: number; ry: number; metric?: readonly [number, number, number] };

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

/** 新しいブラシの面の大きさ（作業画像の縦横比・長辺 1024・短い辺は 1 以上）。 */
export function photoEditingMaskSurfaceSize(source: DevelopSize): { width: number; height: number } {
  const long = PHOTO_EDITING_MASK_SURFACE_LONG_EDGE;
  if (!(source.width > 0) || !(source.height > 0)) return { width: long, height: long };
  if (source.width >= source.height) {
    return { width: long, height: clamp(Math.round((long * source.height) / source.width), 1, long) };
  }
  return { width: clamp(Math.round((long * source.width) / source.height), 1, long), height: long };
}

/** 大きさを刻みに丸めて範囲に収める。 */
export function clampPhotoEditingMaskBrushSize(size: number): number {
  if (!Number.isFinite(size)) return PHOTO_EDITING_MASK_BRUSH_SIZE_DEFAULT;
  const step = PHOTO_EDITING_MASK_BRUSH_SIZE_STEP;
  return clamp(Math.round(size / step) * step, PHOTO_EDITING_MASK_BRUSH_SIZE_MIN, PHOTO_EDITING_MASK_BRUSH_SIZE_MAX);
}

/** `]`（大きく）・`[`（小さく）で 1 段変えた大きさ（約 1.25 倍。少なくとも 1 刻みは変える）。 */
export function stepPhotoEditingMaskBrushSize(size: number, direction: 1 | -1): number {
  const current = clampPhotoEditingMaskBrushSize(size);
  const scaled = clampPhotoEditingMaskBrushSize(direction > 0 ? current * 1.25 : current / 1.25);
  if (scaled !== current) return scaled;
  return clampPhotoEditingMaskBrushSize(current + direction * PHOTO_EDITING_MASK_BRUSH_SIZE_STEP);
}

/** 作業画像の 0〜1 の位置 → 作業画像の画素。 */
function toSourcePixels(frame: PhotoEditingMaskFrame, output: Vec2): Vec2 | null {
  const source = geometryOutputToSource(frame.geometry, frame.source, output[0], output[1]);
  return source ? [source[0] * frame.source.width, source[1] * frame.source.height] : null;
}

/**
 * 見えている出力の幅・高さを、作業画像の画素で測った長さ（写像は相似なので、どこで測っても同じ）。描けない幾何は null。
 */
export function photoEditingMaskOutputExtent(frame: PhotoEditingMaskFrame): { width: number; height: number } | null {
  const origin = toSourcePixels(frame, [0, 0]);
  const right = toSourcePixels(frame, [1, 0]);
  const down = toSourcePixels(frame, [0, 1]);
  if (!origin || !right || !down) return null;
  const width = Math.hypot(right[0] - origin[0], right[1] - origin[1]);
  const height = Math.hypot(down[0] - origin[0], down[1] - origin[1]);
  return width > 0 && height > 0 ? { width, height } : null;
}

/**
 * 出力の位置（0〜1）に置く dab を面の画素で返す。半径は見えている出力の短い辺 × `size`%（作業画像の画素）を、面の縦横の画素の
 * 大きさで割ったもの。描けない幾何は null。
 */
export function photoEditingMaskBrushDab(
  frame: PhotoEditingMaskFrame,
  surface: { width: number; height: number },
  output: Vec2,
  size: number,
  viewport?: { width: number; height: number },
): PhotoEditingMaskDab | null {
  const source = geometryOutputToSource(frame.geometry, frame.source, output[0], output[1]);
  if (!source) return null;
  const center: Vec2 = [source[0] * surface.width, source[1] * surface.height];

  if (viewport && viewport.width > 0 && viewport.height > 0) {
    const map = (point: Vec2): Vec2 | null => {
      const mapped = geometryOutputToSource(frame.geometry, frame.source, point[0], point[1]);
      return mapped ? [mapped[0] * surface.width, mapped[1] * surface.height] : null;
    };
    const derivative = (axis: 0 | 1): Vec2 | null => {
      const dimension = axis === 0 ? viewport.width : viewport.height;
      const coordinate = output[axis];
      const before = Math.max(0, coordinate - 1 / dimension);
      const after = Math.min(1, coordinate + 1 / dimension);
      if (!(after > before)) return null;
      const a: Vec2 = axis === 0 ? [before, output[1]] : [output[0], before];
      const b: Vec2 = axis === 0 ? [after, output[1]] : [output[0], after];
      const pa = map(a);
      const pb = map(b);
      if (!pa || !pb) return null;
      const screenPixels = (after - before) * dimension;
      return [(pb[0] - pa[0]) / screenPixels, (pb[1] - pa[1]) / screenPixels];
    };
    const dx = derivative(0);
    const dy = derivative(1);
    if (!dx || !dy) return null;

    const radius = (clampPhotoEditingMaskBrushSize(size) / 100) * Math.min(viewport.width, viewport.height);
    const cxx = radius * radius * (dx[0] * dx[0] + dy[0] * dy[0]);
    const cxy = radius * radius * (dx[0] * dx[1] + dy[0] * dy[1]);
    const cyy = radius * radius * (dx[1] * dx[1] + dy[1] * dy[1]);
    const determinant = cxx * cyy - cxy * cxy;
    if (!(determinant > 0) || !Number.isFinite(determinant)) return null;

    let rx = Math.sqrt(cxx);
    let ry = Math.sqrt(cyy);
    let metric: [number, number, number] = [cyy / determinant, -cxy / determinant, cxx / determinant];
    const trace = cxx + cyy;
    const smallestEigenvalue = (trace - Math.sqrt((cxx - cyy) ** 2 + 4 * cxy * cxy)) / 2;
    const smallestRadius = Math.sqrt(Math.max(0, smallestEigenvalue));
    if (smallestRadius < MIN_SURFACE_RADIUS) {
      const scale = MIN_SURFACE_RADIUS / Math.max(smallestRadius, Number.EPSILON);
      rx *= scale;
      ry *= scale;
      metric = metric.map((value) => value / (scale * scale)) as [number, number, number];
    }
    return { x: center[0], y: center[1], rx, ry, metric };
  }

  const extent = photoEditingMaskOutputExtent(frame);
  if (!extent) return null;
  const radius = (clampPhotoEditingMaskBrushSize(size) / 100) * Math.min(extent.width, extent.height);
  return {
    x: center[0],
    y: center[1],
    rx: Math.max(MIN_SURFACE_RADIUS, (radius * surface.width) / frame.source.width),
    ry: Math.max(MIN_SURFACE_RADIUS, (radius * surface.height) / frame.source.height),
  };
}

/**
 * 1 つの dab のかかり具合（0〜1）。`distance` は中心からの距離 ÷ 半径、`radius` は画素の半径（ぼかし 0 の縁を約 1 画素なじませる）。
 */
export function photoEditingMaskBrushFalloff(distance: number, feather: number, radius: number): number {
  if (!(distance < 1)) return 0;
  const soft = Math.max(clamp(feather, 0, 100) / 100, Math.min(1, 1 / Math.max(radius, 1)));
  const s = clamp((1 - Math.max(distance, 0)) / soft, 0, 1);
  return s * s * (3 - 2 * s);
}

/**
 * 線分 `from` → `to`（画面の px）の上に `spacing` ごとに置く dab の位置。`carry` は前の dab から `from` までに進んだ長さ（最初の
 * dab を押した点に置いたら 0）。返す `carry` は最後の dab から `to` までの長さ。
 */
export function photoEditingMaskBrushPath(
  from: Vec2,
  to: Vec2,
  spacing: number,
  carry: number,
): { points: Vec2[]; carry: number } {
  const step = Math.max(spacing, 0.5);
  const length = Math.hypot(to[0] - from[0], to[1] - from[1]);
  const points: Vec2[] = [];
  let at = step - Math.max(0, carry);
  if (at < 0) at = 0;
  while (at <= length && length > 0) {
    const t = at / length;
    points.push([from[0] + (to[0] - from[0]) * t, from[1] + (to[1] - from[1]) * t]);
    at += step;
  }
  if (points.length === 0) return { points, carry: Math.max(0, carry) + length };
  return { points, carry: length - (at - step) };
}

/** 画面の px の dab の間隔（半径 × 25%）。半径は見えている短い辺 × `size`%。 */
export function photoEditingMaskBrushSpacing(size: number, box: { width: number; height: number }): number {
  return (clampPhotoEditingMaskBrushSize(size) / 100) * Math.min(box.width, box.height) * PHOTO_EDITING_MASK_BRUSH_SPACING;
}

type DirtyRect = { x0: number; y0: number; x1: number; y1: number };

function inverseMetricMinRadius(metric: readonly [number, number, number]): number {
  const trace = metric[0] + metric[2];
  const largestEigenvalue = (trace + Math.sqrt((metric[0] - metric[2]) ** 2 + 4 * metric[1] * metric[1])) / 2;
  return largestEigenvalue > 0 ? Math.sqrt(1 / largestEigenvalue) : MIN_SURFACE_RADIUS;
}

/**
 * 1 ストロークの塗り（`base` の上に dab を重ね、終わりに 1 回だけ丸める）。`base` は変えない。
 */
export function createPhotoEditingMaskStroke(
  base: PhotoEditingMaskSurfaceData,
  brush: Pick<PhotoEditingMaskBrush, "feather" | "flow" | "erase">,
) {
  const { width, height } = base;
  const alpha = new Float32Array(width * height);
  const flow = clamp(brush.flow, PHOTO_EDITING_MASK_BRUSH_FLOW_MIN, 100) / 100;
  let dirty: DirtyRect | null = null;
  let dabs = 0;

  return {
    /** dab を 1 つ重ねる（面の外の部分は捨てる）。 */
    addDab(dab: PhotoEditingMaskDab) {
      if (![dab.x, dab.y, dab.rx, dab.ry].every(Number.isFinite) || dab.rx <= 0 || dab.ry <= 0) return;
      // 画素 i の中心 i + 0.5 が半径の内側に入る範囲
      const x0 = Math.max(0, Math.ceil(dab.x - dab.rx - 0.5));
      const x1 = Math.min(width - 1, Math.floor(dab.x + dab.rx - 0.5));
      const y0 = Math.max(0, Math.ceil(dab.y - dab.ry - 0.5));
      const y1 = Math.min(height - 1, Math.floor(dab.y + dab.ry - 0.5));
      if (x0 > x1 || y0 > y1) return;
      dabs += 1;
      const radius = dab.metric ? inverseMetricMinRadius(dab.metric) : Math.min(dab.rx, dab.ry);
      for (let j = y0; j <= y1; j += 1) {
        const dy = j + 0.5 - dab.y;
        const row = j * width;
        for (let i = x0; i <= x1; i += 1) {
          const dx = i + 0.5 - dab.x;
          const distance = dab.metric
            ? Math.sqrt(Math.max(0, dab.metric[0] * dx * dx + 2 * dab.metric[1] * dx * dy + dab.metric[2] * dy * dy))
            : Math.hypot(dx / dab.rx, dy / dab.ry);
          if (distance >= 1) continue;
          const a = flow * photoEditingMaskBrushFalloff(distance, brush.feather, radius);
          if (a <= 0) continue;
          const index = row + i;
          const current = alpha[index]!;
          alpha[index] = current + (1 - current) * a;
        }
      }
      dirty = dirty
        ? { x0: Math.min(dirty.x0, x0), y0: Math.min(dirty.y0, y0), x1: Math.max(dirty.x1, x1), y1: Math.max(dirty.y1, y1) }
        : { x0, y0, x1, y1 };
    },
    /** 重ねた dab の数（面に掛かったものだけ）。 */
    get dabCount(): number {
      return dabs;
    },
    /** 塗った範囲（面の画素。無ければ null）。 */
    get dirty(): DirtyRect | null {
      return dirty;
    },
    /** 結果の面（新しい配列。どの画素も変わらなければ null）。 */
    result(): Uint8Array | null {
      if (!dirty) return null;
      const out = new Uint8Array(base.data);
      let changed = false;
      for (let j = dirty.y0; j <= dirty.y1; j += 1) {
        const row = j * width;
        for (let i = dirty.x0; i <= dirty.x1; i += 1) {
          const index = row + i;
          const a = alpha[index]!;
          if (a <= 0) continue;
          const v = base.data[index]!;
          const next = Math.round(clamp(brush.erase ? v * (1 - a) : v + (255 - v) * a, 0, 255));
          if (next !== v) {
            out[index] = next;
            changed = true;
          }
        }
      }
      return changed ? out : null;
    },
  };
}

export type PhotoEditingMaskStroke = ReturnType<typeof createPhotoEditingMaskStroke>;

/** 全部 `value` の面（「全体を消す」は 0、「全体を塗る」は 255）。 */
export function filledPhotoEditingMaskSurface(width: number, height: number, value: number): Uint8Array {
  return new Uint8Array(width * height).fill(clamp(Math.round(value), 0, 255));
}
