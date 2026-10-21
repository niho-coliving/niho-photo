import { writeDevelopGeometry } from "./develop-engine/develop-geometry";
import {
  MAX_HEAL_MARKS,
  MAX_HEAL_POINTS,
  MAX_HEAL_RADIUS,
  MAX_HEAL_TOTAL_POINTS,
  MIN_HEAL_RADIUS,
  type DevelopHealPoint,
} from "./develop-engine/develop-heal";
import {
  DEFAULT_HEAL_POINT_SPACING,
  clearDevelopHeal,
  developHealMarkIndex,
  developHealUsage,
  type DevelopHealImageSize,
  type DevelopHealMarkView,
} from "./develop-engine/develop-heal-editing";
import { resetDevelopSettingsColors, type DevelopSettings } from "./develop-engine/develop-settings";
import { withoutPhotoEditingLensWarp } from "./photo-editing-lens";

/**
 * 修復の道具の画面（niho-photo#44 後半）の計算（React に依存しない純粋な関数。写真の上のブラシ・右パネル・面の描画が使う）。印の形と
 * 書き換えは `develop-engine/develop-heal-editing.ts`。
 *
 * 座標: 印の点は写真の元の座標系（EXIF の向きを当てた後、90° 回転・反転・遠近・角度・切り抜きの前）の 0〜1。修復の道具の間は面が
 * 幾何を全部外した画（{@link healFrameDevelopSettings}）を描くので、写真の canvas の画面の矩形の中の位置がそのまま印の座標になる。
 * 半径は長辺に対する割合なので、画面の px は `半径 × 画面の矩形の長辺`。
 */

/** 画面の矩形（canvas の `getBoundingClientRect` か、入れ物の中の位置）。 */
export type HealRect = { left: number; top: number; width: number; height: number };

/** ブラシの大きさのダイヤルの範囲（長辺に対する %。対数で動かす）。 */
export const HEAL_RADIUS_DIAL_MIN_PERCENT = 0.2;
export const HEAL_RADIUS_DIAL_MAX_PERCENT = 12;
/** ダイヤルの目盛り（0〜100）と、`[` `]` で動かす目盛りの数。 */
export const HEAL_RADIUS_DIAL_STEPS = 100;
export const HEAL_RADIUS_KEY_STEP = 5;
/** 「写す」の既定の写し元を穴から離す距離（半径に対する倍数）。 */
export const HEAL_SOURCE_DISTANCE = 3;
/** キーボードでブラシの位置を動かす量（写真の幅・高さに対する割合。Shift で 10 倍）。 */
export const HEAL_KEY_MOVE = 0.01;
export const HEAL_KEY_MOVE_LARGE = 0.1;

const DIAL_MIN = HEAL_RADIUS_DIAL_MIN_PERCENT / 100;
const DIAL_MAX = HEAL_RADIUS_DIAL_MAX_PERCENT / 100;

function clamp(value: number, min: number, max: number): number {
  const clamped = Math.min(max, Math.max(min, value));
  return clamped === 0 ? 0 : clamped;
}

/**
 * 修復の道具の間に描く設定: 幾何（90° 回転・反転・遠近・角度・切り抜き・縦横比・Upright の記録）と、画素を動かすレンズ補正（歪み・
 * 色収差の除去。niho-photo#45）を全部外す。色・効果・周辺光量・フリンジ・修復の印はそのまま（ポインタの位置 = 印の座標にする）。
 */
export function healFrameDevelopSettings(settings: DevelopSettings): DevelopSettings {
  return withoutPhotoEditingLensWarp(
    writeDevelopGeometry(settings, {
      rotate: 0,
      flipH: false,
      flipV: false,
      angle: 0,
      crop: { left: 0, top: 0, right: 1, bottom: 1 },
    }),
  );
}

/**
 * 「補正前」の画の設定: 色だけを neutral に戻し（幾何は保つ）、修復の印も外す（元の写真と比べる。crate の `before_settings` と同じ）。
 * 右パネルの「初期化」（`resetDevelopSettingsColors`）は印を保つので、それとは別。
 */
export function compareBeforeDevelopSettings(settings: DevelopSettings | null, base: string | null): DevelopSettings {
  return clearDevelopHeal(resetDevelopSettingsColors(settings, base));
}

/** 写真の大きさの長辺を 1 とした幅・高さ（長辺の単位）。測れなければ正方形。 */
function longUnits(size: DevelopHealImageSize | null | undefined): { sx: number; sy: number } {
  if (!size || !(size.width > 0) || !(size.height > 0)) return { sx: 1, sy: 1 };
  const long = Math.max(size.width, size.height);
  return { sx: size.width / long, sy: size.height / long };
}

/**
 * 画面の点を写真の 0〜1 に直す。写真の外の点は、`clampToPhoto` なら端に収め、でなければ null。矩形を測れなければ null。
 */
export function healPointFromClient(
  rect: HealRect | null | undefined,
  clientX: number,
  clientY: number,
  options: { clampToPhoto: boolean },
): DevelopHealPoint | null {
  if (!rect || !(rect.width > 0) || !(rect.height > 0)) return null;
  const x = (clientX - rect.left) / rect.width;
  const y = (clientY - rect.top) / rect.height;
  if (!Number.isFinite(x) || !Number.isFinite(y)) return null;
  if (!options.clampToPhoto && (x < 0 || x > 1 || y < 0 || y > 1)) return null;
  return [clamp(x, 0, 1), clamp(y, 0, 1)];
}

/** ブラシの半径（長辺に対する割合）の画面の px（写真の画面の矩形の長辺から）。 */
export function healRadiusPixels(radius: number, rect: Pick<HealRect, "width" | "height"> | null | undefined): number {
  if (!rect || !(rect.width > 0) || !(rect.height > 0) || !Number.isFinite(radius)) return 0;
  return Math.max(0, radius) * Math.max(rect.width, rect.height);
}

/** ぼかしても必ず全部埋まる内側の半径（縁から `ぼかし × 半径 / 2` だけ内側。`docs/heal.md`）。 */
export function healCoreRadius(radius: number, feather: number): number {
  return radius * (1 - clamp(feather, 0, 1) / 2);
}

/** 2 点の間の長さ（長辺の単位）。 */
export function healPointDistance(a: DevelopHealPoint, b: DevelopHealPoint, size?: DevelopHealImageSize | null): number {
  const { sx, sy } = longUnits(size);
  return Math.hypot((a[0] - b[0]) * sx, (a[1] - b[1]) * sy);
}

/**
 * なぞっている線に点を足す（`appendDevelopHealPoint` と同じ間引き: 前の点から `半径 × 間隔` より近い点は足さない）。`limit` 個に
 * 達したら足さない（最後の点で打ち切る）。足さなければ渡した配列のまま。
 */
export function appendHealStrokePoint(
  points: readonly DevelopHealPoint[],
  point: DevelopHealPoint,
  options: { radius: number; size?: DevelopHealImageSize | null; limit: number; minSpacing?: number },
): readonly DevelopHealPoint[] {
  if (!Number.isFinite(point[0]) || !Number.isFinite(point[1])) return points;
  if (points.length >= options.limit) return points;
  const last = points[points.length - 1];
  const minimum = options.radius * (options.minSpacing ?? DEFAULT_HEAL_POINT_SPACING);
  if (last && healPointDistance(last, point, options.size) < minimum) return points;
  return [...points, point];
}

/**
 * 新しく描く印に使える点の数（1 つの印 512 点・合計 2048 点の残り）。印をもう足せなければ 0。
 */
export function healStrokePointLimit(settings: DevelopSettings): number {
  const usage = developHealUsage(settings);
  if (usage.marks >= MAX_HEAL_MARKS) return 0;
  return Math.max(0, Math.min(MAX_HEAL_POINTS, MAX_HEAL_TOTAL_POINTS - usage.points));
}

/** ダイヤルの位置（0〜100）から半径（長辺に対する割合。対数で 0.2%〜12%）。 */
export function healRadiusFromDial(dial: number): number {
  const position = clamp(Number.isFinite(dial) ? dial : 0, 0, HEAL_RADIUS_DIAL_STEPS) / HEAL_RADIUS_DIAL_STEPS;
  const radius = DIAL_MIN * (DIAL_MAX / DIAL_MIN) ** position;
  return Number(clamp(radius, MIN_HEAL_RADIUS, MAX_HEAL_RADIUS).toPrecision(4));
}

/** 半径のダイヤルの位置（0〜100。ダイヤルの外の半径は端）。 */
export function healRadiusToDial(radius: number): number {
  if (!Number.isFinite(radius) || radius <= DIAL_MIN) return 0;
  if (radius >= DIAL_MAX) return HEAL_RADIUS_DIAL_STEPS;
  const position = Math.log(radius / DIAL_MIN) / Math.log(DIAL_MAX / DIAL_MIN);
  return Math.round(position * HEAL_RADIUS_DIAL_STEPS * 10) / 10;
}

/** `[`（-1）・`]`（+1）でブラシを 1 段小さく / 大きくした半径（ダイヤルの {@link HEAL_RADIUS_KEY_STEP} 目盛り）。 */
export function stepHealRadius(radius: number, direction: -1 | 1): number {
  const dial = Math.round(healRadiusToDial(radius));
  return healRadiusFromDial(dial + direction * HEAL_RADIUS_KEY_STEP);
}

/** 長辺に対する %（10 未満は小数 1 桁、ほかは整数。末尾の 0 は書かない）。 */
export function formatHealPercent(percent: number): string {
  const value = Number.isFinite(percent) ? percent : 0;
  return `${Number(value.toFixed(value < 10 ? 1 : 0))}%`;
}

/** 印の点の外接矩形（0〜1）と中心。 */
export function healMarkBounds(points: readonly DevelopHealPoint[]): {
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
  center: DevelopHealPoint;
} {
  let minX = 1;
  let minY = 1;
  let maxX = 0;
  let maxY = 0;
  for (const [x, y] of points) {
    minX = Math.min(minX, x);
    minY = Math.min(minY, y);
    maxX = Math.max(maxX, x);
    maxY = Math.max(maxY, y);
  }
  if (points.length === 0) return { minX: 0.5, minY: 0.5, maxX: 0.5, maxY: 0.5, center: [0.5, 0.5] };
  return { minX, minY, maxX, maxY, center: [(minX + maxX) / 2, (minY + maxY) / 2] };
}

/** 印を `offset`（0〜1）だけずらした外接矩形（半径の分を含む）が写真の外へ出る量（長辺の単位の合計。収まれば 0）。 */
function overflow(
  bounds: ReturnType<typeof healMarkBounds>,
  offset: DevelopHealPoint,
  radius: number,
  size: DevelopHealImageSize | null | undefined,
): number {
  const { sx, sy } = longUnits(size);
  const rx = radius / sx;
  const ry = radius / sy;
  const left = Math.max(0, rx - (bounds.minX + offset[0]));
  const right = Math.max(0, bounds.maxX + offset[0] + rx - 1);
  const top = Math.max(0, ry - (bounds.minY + offset[1]));
  const bottom = Math.max(0, bounds.maxY + offset[1] + ry - 1);
  return (left + right) * sx + (top + bottom) * sy;
}

/**
 * 「写す」の印を作るときの既定の写し元（穴からの相対位置。各 -1〜1）。なぞった向き（最初の点 → 最後の点）に直交する側へ、線の
 * 太さの分 + 半径の {@link HEAL_SOURCE_DISTANCE} 倍だけ離す（点 1 つなら中心から半径の 3 倍）。直交の 2 方向、線に沿った 2 方向の順に
 * 試し、写す範囲が写真の内側に収まる最初の側を選ぶ（どれも収まらなければ、はみ出しの最も小さい側）。同じ入力には同じ値を返す。
 */
export function defaultHealSource(
  points: readonly DevelopHealPoint[],
  radius: number,
  size: DevelopHealImageSize | null | undefined,
): DevelopHealPoint {
  const { sx, sy } = longUnits(size);
  const bounds = healMarkBounds(points);
  const first = points[0] ?? bounds.center;
  const last = points[points.length - 1] ?? bounds.center;
  // なぞった向き（長辺の単位）。点 1 つ・閉じた線は横向き
  let ux = (last[0] - first[0]) * sx;
  let uy = (last[1] - first[1]) * sy;
  const length = Math.hypot(ux, uy);
  if (length < 1e-9) {
    ux = 1;
    uy = 0;
  } else {
    ux /= length;
    uy /= length;
  }
  // 直交する向き（右か下を正にそろえる）
  let nx = -uy;
  let ny = ux;
  if (nx < 0 || (nx === 0 && ny < 0)) {
    nx = -nx;
    ny = -ny;
  }
  const spread = (dx: number, dy: number) => {
    let min = Infinity;
    let max = -Infinity;
    for (const [x, y] of points) {
      const projected = (x - bounds.center[0]) * sx * dx + (y - bounds.center[1]) * sy * dy;
      min = Math.min(min, projected);
      max = Math.max(max, projected);
    }
    return points.length === 0 ? 0 : max - min;
  };
  const across = spread(nx, ny) + HEAL_SOURCE_DISTANCE * radius;
  const along = spread(ux, uy) + HEAL_SOURCE_DISTANCE * radius;
  const candidates: DevelopHealPoint[] = [
    [nx * across, ny * across],
    [-nx * across, -ny * across],
    [ux * along, uy * along],
    [-ux * along, -uy * along],
  ].map(([x, y]) => [clamp(x / sx, -1, 1), clamp(y / sy, -1, 1)] as DevelopHealPoint);
  let best = candidates[0];
  let bestOverflow = Infinity;
  for (const candidate of candidates) {
    const amount = overflow(bounds, candidate, radius, size);
    if (amount <= 1e-9) return round5(candidate);
    if (amount < bestOverflow) {
      bestOverflow = amount;
      best = candidate;
    }
  }
  return round5(best);
}

function round5(point: DevelopHealPoint): DevelopHealPoint {
  const round = (value: number) => {
    const rounded = Math.round(value * 1e5) / 1e5;
    return rounded === 0 ? 0 : rounded;
  };
  return [round(point[0]), round(point[1])];
}

/**
 * 写し元を写真の内側へ押し戻す（写す範囲〔印の外接矩形 + 半径〕が写真の外へ出ない位置。印が写真より大きければ真ん中）。各 -1〜1。
 */
export function clampHealSource(
  points: readonly DevelopHealPoint[],
  radius: number,
  source: DevelopHealPoint,
  size: DevelopHealImageSize | null | undefined,
): DevelopHealPoint {
  const { sx, sy } = longUnits(size);
  const bounds = healMarkBounds(points);
  const rx = radius / sx;
  const ry = radius / sy;
  const axis = (value: number, min: number, max: number, margin: number) => {
    const low = margin - min;
    const high = 1 - margin - max;
    const fitted = low <= high ? clamp(value, low, high) : (low + high) / 2;
    return clamp(Number.isFinite(fitted) ? fitted : 0, -1, 1);
  };
  return round5([axis(source[0], bounds.minX, bounds.maxX, rx), axis(source[1], bounds.minY, bounds.maxY, ry)]);
}

/** 点から線分への長さ（長辺の単位）。 */
function distanceToSegment(
  point: DevelopHealPoint,
  a: DevelopHealPoint,
  b: DevelopHealPoint,
  sx: number,
  sy: number,
): number {
  const px = point[0] * sx;
  const py = point[1] * sy;
  const ax = a[0] * sx;
  const ay = a[1] * sy;
  const dx = b[0] * sx - ax;
  const dy = b[1] * sy - ay;
  const lengthSquared = dx * dx + dy * dy;
  const t = lengthSquared > 0 ? clamp(((px - ax) * dx + (py - ay) * dy) / lengthSquared, 0, 1) : 0;
  return Math.hypot(px - (ax + t * dx), py - (ay + t * dy));
}

/**
 * その位置に重なる印（上に重なる = 後から描いた印を優先）。点から印の線までの長さが半径 + `tolerance`（長辺の単位）以内なら重なる。
 * 無ければ null。
 */
export function healMarkAt(
  marks: readonly DevelopHealMarkView[],
  point: DevelopHealPoint,
  size: DevelopHealImageSize | null | undefined,
  tolerance = 0,
): string | null {
  const { sx, sy } = longUnits(size);
  for (let index = marks.length - 1; index >= 0; index -= 1) {
    const mark = marks[index];
    const points = mark.points;
    if (points.length === 0) continue;
    let nearest = Infinity;
    if (points.length === 1) nearest = distanceToSegment(point, points[0], points[0], sx, sy);
    for (let i = 1; i < points.length; i += 1) {
      nearest = Math.min(nearest, distanceToSegment(point, points[i - 1], points[i], sx, sy));
    }
    if (nearest <= mark.radius + Math.max(0, tolerance)) return mark.id;
  }
  return null;
}

/** 新しい印の `id`（`h1`・`h2`…の、まだ使っていない最小の番号）。 */
export function nextHealMarkId(settings: DevelopSettings): string {
  let order = 1;
  while (developHealMarkIndex(settings, `h${order}`) >= 0) order += 1;
  return `h${order}`;
}

/** 印の見た目の指紋（描いた画に入っている印か・値が変わったかの照合に使う）。 */
export function healMarkFingerprint(mark: DevelopHealMarkView): string {
  return JSON.stringify([mark.id, mark.mode, mark.radius, mark.feather, mark.points, mark.source]);
}

/** 矢印キーで動かす量（写真の幅・高さに対する割合。Shift で大きく）。矢印でなければ null。 */
export function healKeyDelta(key: string, large: boolean): DevelopHealPoint | null {
  const step = large ? HEAL_KEY_MOVE_LARGE : HEAL_KEY_MOVE;
  switch (key) {
    case "ArrowLeft":
      return [-step, 0];
    case "ArrowRight":
      return [step, 0];
    case "ArrowUp":
      return [0, -step];
    case "ArrowDown":
      return [0, step];
    default:
      return null;
  }
}

/** キーボードでブラシの位置を動かす（矢印。Shift で大きく。写真の外へは出さない）。矢印でなければ null。 */
export function moveHealKeyCursor(point: DevelopHealPoint, key: string, large: boolean): DevelopHealPoint | null {
  const delta = healKeyDelta(key, large);
  if (!delta) return null;
  return round5([clamp(point[0] + delta[0], 0, 1), clamp(point[1] + delta[1], 0, 1)]);
}
