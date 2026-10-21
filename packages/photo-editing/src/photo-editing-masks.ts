import {
  geometryOutputToSource,
  geometrySourceToOutput,
  type DevelopGeometry,
  type DevelopSize,
} from "./develop-engine/develop-geometry";
import {
  MAX_DEVELOP_MASKS,
  MIN_DEVELOP_MASK_LINEAR_DISTANCE,
  type DevelopLinearMask,
  type DevelopMask,
  type DevelopMaskAdjust,
  type DevelopMaskAdjustKey,
  type DevelopMaskKind,
  type DevelopMaskPoint,
  type DevelopRadialMask,
} from "./develop-engine/develop-masks";
import {
  PHOTO_EDITING_ADJUSTMENT_GROUPS,
  PHOTO_EDITING_RELATIVE_WHITE_BALANCE_MAX,
  PHOTO_EDITING_RELATIVE_WHITE_BALANCE_MIN,
  type PhotoEditingAdjustmentGroupId,
} from "./photo-editing-adjustments";

/**
 * 部分補正（マスク。Epic #31 M3 #67）の画面の計算（React に依らない純粋な関数）。契約は `docs/local-adjustments.md`。
 *
 * - マスクの座標は**作業画像**（EXIF の向き反映済み・幾何の前）の 0〜1。画面は見えている出力（切り抜き・回転・反転の後）の上で
 *   操作するので、つまみの位置は作業画像 → 出力（`geometrySourceToOutput`）、動かした位置は出力 → 作業画像
 *   （`geometryOutputToSource`）で行き来する。この写像は画素の空間で相似変換（回転・一様な拡大縮小・鏡映・平行移動）なので、
 *   画面で直角・円に見えるものは作業画像の上でも直角・円のまま
 * - 長さ・角度は契約と同じ空間（作業画像の高さを 1 とした `X = u·A, Y = v`、`A = 幅 / 高さ`）で解く。円形の半軸は `x` が幅・`y` が
 *   高さに対する割合（`a = radius.x·A`、`b = radius.y`）、`angle` は時計回りの度
 * - 出す値は必ず契約の範囲に収める（線形の端 −1〜2・2 点の距離 0.001 以上、円形の中心 0〜1・半軸 0.005〜1.5・角度 −180〜180・
 *   ぼかし 0〜100、`adjust` は全体の同じキーの範囲。0 の項目は持たない）。収められない動き（線形の 2 点が重なる）は null
 */

/** 座標の基準: 今の幾何と作業画像の大きさ（オリジナルは元の寸法、作業コピーはその寸法）。 */
export type PhotoEditingMaskFrame = { geometry: DevelopGeometry; source: DevelopSize };

/** 画面で足せる種類（ブラシは M4）。 */
export const PHOTO_EDITING_MASK_SHAPE_KINDS = ["linear", "radial"] as const;
export type PhotoEditingMaskShapeKind = (typeof PHOTO_EDITING_MASK_SHAPE_KINDS)[number];

/** 線形のつまみ（`zero` = 面が 0 の端、`full` = 面が 1 の端、`center` = 2 点の真ん中。両方を動かす）。 */
export type PhotoEditingLinearMaskHandle = "zero" | "full" | "center";
/** 円形のつまみ（中心、楕円の自分の軸の 4 つの端、回転）。 */
export type PhotoEditingRadialMaskHandle = "center" | "right" | "left" | "bottom" | "top" | "rotate";
export type PhotoEditingMaskHandle = PhotoEditingLinearMaskHandle | PhotoEditingRadialMaskHandle;

/** 出力の上のつまみの位置（0〜1。出力の外もある）。 */
export type PhotoEditingMaskHandlePoint = { handle: PhotoEditingMaskHandle; x: number; y: number };

export type Vec2 = [number, number];

const LINEAR_POINT_MIN = -1;
const LINEAR_POINT_MAX = 2;
const RADIUS_MIN = 0.005;
const RADIUS_MAX = 1.5;
const FEATHER_MAX = 100;
/** 2 点の距離の下限（正規形で丸めても 0.001 を割らない余裕を持つ） */
const LINEAR_DISTANCE_GUARD = MIN_DEVELOP_MASK_LINEAR_DISTANCE * 1.1;

/** 既定の線形: 見えている高さの 30% が面 1（上の空）、55% が面 0 の水平なグラデーション。 */
export const PHOTO_EDITING_LINEAR_MASK_DEFAULT_FULL_Y = 0.3;
export const PHOTO_EDITING_LINEAR_MASK_DEFAULT_ZERO_Y = 0.55;
/** 既定の円形: 見えている中心に、見えている短い辺の 25% の半径の円・ぼかし 50。 */
export const PHOTO_EDITING_RADIAL_MASK_DEFAULT_RADIUS = 0.25;
export const PHOTO_EDITING_RADIAL_MASK_DEFAULT_FEATHER = 50;
/** 複製を見えている出力でずらす量（右下へ）。 */
const DUPLICATE_OFFSET = 0.03;

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function aspectOf(frame: PhotoEditingMaskFrame): number {
  return frame.source.width / frame.source.height;
}

/** 座標の基準として使えるか（大きさが正で、幾何が描ける切り抜き）。 */
export function isPhotoEditingMaskFrameValid(frame: PhotoEditingMaskFrame | null): frame is PhotoEditingMaskFrame {
  return (
    frame !== null &&
    frame.source.width > 0 &&
    frame.source.height > 0 &&
    geometryOutputToSource(frame.geometry, frame.source, 0.5, 0.5) !== null
  );
}

/** 出力の位置 → 作業画像の位置。 */
export function photoEditingMaskOutputToSource(frame: PhotoEditingMaskFrame, point: Vec2): Vec2 | null {
  return geometryOutputToSource(frame.geometry, frame.source, point[0], point[1]);
}

/** 作業画像の位置 → 出力の位置。 */
export function photoEditingMaskSourceToOutput(frame: PhotoEditingMaskFrame, point: Vec2): Vec2 | null {
  return geometrySourceToOutput(frame.geometry, frame.source, point[0], point[1]);
}

/** 作業画像の位置 → 契約の長さの空間（高さを 1）。 */
function toMetric(frame: PhotoEditingMaskFrame, point: Vec2): Vec2 {
  return [point[0] * aspectOf(frame), point[1]];
}

function pointVec(point: DevelopMaskPoint): Vec2 {
  return [point.x, point.y];
}

function vecPoint(vec: Vec2): DevelopMaskPoint {
  return { x: vec[0], y: vec[1] };
}

function clampLinearPoint(point: Vec2): Vec2 {
  return [clamp(point[0], LINEAR_POINT_MIN, LINEAR_POINT_MAX), clamp(point[1], LINEAR_POINT_MIN, LINEAR_POINT_MAX)];
}

function clampCenter(point: Vec2): Vec2 {
  return [clamp(point[0], 0, 1), clamp(point[1], 0, 1)];
}

/** 契約の 2 点の距離（生の x, y）が下限を保つか。 */
function linearDistanceOk(zero: Vec2, full: Vec2): boolean {
  return Math.hypot(full[0] - zero[0], full[1] - zero[1]) >= LINEAR_DISTANCE_GUARD;
}

/** 角度を −180〜180 に入れる。 */
function normalizeAngle(degrees: number): number {
  let angle = ((((degrees + 180) % 360) + 360) % 360) - 180;
  if (angle === -180 && degrees > 0) angle = 180;
  return angle === 0 ? 0 : angle;
}

/** 円形の自分の軸（契約の空間。`e1` が `radius.x` の向き、`e2` が `radius.y` の向き。y は下向き・時計回り）。 */
function radialAxes(angle: number): { e1: Vec2; e2: Vec2 } {
  const theta = (angle * Math.PI) / 180;
  const cos = Math.cos(theta);
  const sin = Math.sin(theta);
  return { e1: [cos, sin], e2: [-sin, cos] };
}

function dot(a: Vec2, b: Vec2): number {
  return a[0] * b[0] + a[1] * b[1];
}

// ---------------------------------------------------------------------------
// 作る・並べ替える

/** 配列の中で一意な id（`mask-` と 6 文字の英数字。契約の `[A-Za-z0-9_-]{1,64}`）。 */
export function createPhotoEditingMaskId(masks: readonly DevelopMask[], random: () => number = Math.random): string {
  const taken = new Set(masks.map((mask) => mask.id));
  for (let attempt = 0; attempt < 32; attempt += 1) {
    const id = `mask-${Math.floor(random() * 36 ** 6)
      .toString(36)
      .padStart(6, "0")
      .slice(-6)}`;
    if (!taken.has(id)) return id;
  }
  let index = masks.length + 1;
  while (taken.has(`mask-${index}`)) index += 1;
  return `mask-${index}`;
}

/**
 * 見えている出力に置いた既定のマスク（作業画像の座標に直す）。線形は見えている高さの 30%（面 1）→ 55%（面 0）の水平な
 * グラデーション、円形は見えている中心の、見えている短い辺の 25% の半径の円（ぼかし 50）。`adjust` は空（足しただけでは画を
 * 変えない）。幾何が描けない切り抜きなら null。
 */
export function createPhotoEditingMask(
  kind: PhotoEditingMaskShapeKind,
  frame: PhotoEditingMaskFrame,
  id: string,
): DevelopLinearMask | DevelopRadialMask | null {
  if (!isPhotoEditingMaskFrameValid(frame)) return null;
  const common = { id, enabled: true, invert: false, adjust: {} };
  if (kind === "linear") {
    const full = photoEditingMaskOutputToSource(frame, [0.5, PHOTO_EDITING_LINEAR_MASK_DEFAULT_FULL_Y]);
    const zero = photoEditingMaskOutputToSource(frame, [0.5, PHOTO_EDITING_LINEAR_MASK_DEFAULT_ZERO_Y]);
    if (!full || !zero) return null;
    const clampedZero = clampLinearPoint(zero);
    const clampedFull = clampLinearPoint(full);
    if (!linearDistanceOk(clampedZero, clampedFull)) return null;
    return { ...common, kind: "linear", zero: vecPoint(clampedZero), full: vecPoint(clampedFull) };
  }
  const center = photoEditingMaskOutputToSource(frame, [0.5, 0.5]);
  const right = photoEditingMaskOutputToSource(frame, [1, 0.5]);
  const bottom = photoEditingMaskOutputToSource(frame, [0.5, 1]);
  if (!center || !right || !bottom) return null;
  const c = toMetric(frame, center);
  const halfWidth = Math.hypot(...subtract(toMetric(frame, right), c));
  const halfHeight = Math.hypot(...subtract(toMetric(frame, bottom), c));
  // 見えている短い辺 × 25% を、契約の空間の円の半径にする（画面でも円に見える）
  const radius = 2 * Math.min(halfWidth, halfHeight) * PHOTO_EDITING_RADIAL_MASK_DEFAULT_RADIUS;
  return {
    ...common,
    kind: "radial",
    center: vecPoint(clampCenter(center)),
    radius: {
      x: clamp(radius / aspectOf(frame), RADIUS_MIN, RADIUS_MAX),
      y: clamp(radius, RADIUS_MIN, RADIUS_MAX),
    },
    angle: 0,
    feather: PHOTO_EDITING_RADIAL_MASK_DEFAULT_FEATHER,
  };
}

function subtract(a: Vec2, b: Vec2): Vec2 {
  return [a[0] - b[0], a[1] - b[1]];
}

function add(a: Vec2, b: Vec2): Vec2 {
  return [a[0] + b[0], a[1] + b[1]];
}

/** 末尾に足す（8 枚・同じ id があれば足さない）。 */
export function addPhotoEditingMask(masks: readonly DevelopMask[], mask: DevelopMask): DevelopMask[] {
  if (masks.length >= MAX_DEVELOP_MASKS || masks.some((current) => current.id === mask.id)) return [...masks];
  return [...masks, mask];
}

/** 1 枚を消す。 */
export function removePhotoEditingMask(masks: readonly DevelopMask[], id: string): DevelopMask[] {
  return masks.filter((mask) => mask.id !== id);
}

/** 1 枚を置き換える（`update` が null なら変えない）。 */
export function updatePhotoEditingMask(
  masks: readonly DevelopMask[],
  id: string,
  update: (mask: DevelopMask) => DevelopMask | null,
): DevelopMask[] {
  return masks.map((mask) => (mask.id === id ? (update(mask) ?? mask) : mask));
}

/** 作業画像の上の平行移動（出力の `from` → `to` の動き。写像は affine なので、どこで測っても同じ）。 */
function sourceDelta(frame: PhotoEditingMaskFrame, from: Vec2, to: Vec2): Vec2 | null {
  const a = photoEditingMaskOutputToSource(frame, from);
  const b = photoEditingMaskOutputToSource(frame, to);
  return a && b ? subtract(b, a) : null;
}

/** 線形の 2 点を同じだけずらす（どちらも −1〜2 に収まるようにずらす量を縮める）。 */
function translateLinear(mask: DevelopLinearMask, delta: Vec2): DevelopLinearMask {
  const shifted: Vec2 = [0, 0];
  for (const axis of [0, 1] as const) {
    const zero = pointVec(mask.zero)[axis];
    const full = pointVec(mask.full)[axis];
    const min = Math.max(LINEAR_POINT_MIN - zero, LINEAR_POINT_MIN - full);
    const max = Math.min(LINEAR_POINT_MAX - zero, LINEAR_POINT_MAX - full);
    shifted[axis] = clamp(delta[axis], Math.min(min, 0), Math.max(max, 0));
  }
  return {
    ...mask,
    zero: vecPoint(clampLinearPoint(add(pointVec(mask.zero), shifted))),
    full: vecPoint(clampLinearPoint(add(pointVec(mask.full), shifted))),
  };
}

function translateRadial(mask: DevelopRadialMask, delta: Vec2): DevelopRadialMask {
  return { ...mask, center: vecPoint(clampCenter(add(pointVec(mask.center), delta))) };
}

/**
 * 複製（新しい id で、見えている出力で少し右下へずらして元の直後に入れる）。8 枚・無い id・面の種類（ずらす形が無い）は
 * そのままずらさずに複製し、8 枚なら足さない。
 */
export function duplicatePhotoEditingMask(
  masks: readonly DevelopMask[],
  id: string,
  frame: PhotoEditingMaskFrame | null,
  newId: string,
): DevelopMask[] {
  const index = masks.findIndex((mask) => mask.id === id);
  if (index < 0 || masks.length >= MAX_DEVELOP_MASKS || masks.some((mask) => mask.id === newId)) return [...masks];
  const original = masks[index]!;
  const delta: Vec2 =
    (isPhotoEditingMaskFrameValid(frame) ? sourceDelta(frame, [0.5, 0.5], [0.5 + DUPLICATE_OFFSET, 0.5 + DUPLICATE_OFFSET]) : null) ??
    [DUPLICATE_OFFSET, DUPLICATE_OFFSET];
  const copy: DevelopMask =
    original.kind === "linear"
      ? translateLinear({ ...original, id: newId }, delta)
      : original.kind === "radial"
        ? translateRadial({ ...original, id: newId }, delta)
        : { ...original, id: newId };
  const adjusted = { ...copy, adjust: cloneAdjust(original.adjust) } as DevelopMask;
  return [...masks.slice(0, index + 1), adjusted, ...masks.slice(index + 1)];
}

function cloneAdjust(adjust: DevelopMaskAdjust): DevelopMaskAdjust {
  const { hsl, ...rest } = adjust;
  if (!hsl) return { ...rest };
  return {
    ...rest,
    hsl: Object.fromEntries(Object.entries(hsl).map(([band, delta]) => [band, { ...delta }])),
  };
}

/**
 * `previous` の形（線形の 2 点、円形の中心・半軸・角度）だけを `shaped` のものにする（補正・目・反転・ぼかしは `previous` のまま）。
 * 種類が違えば null。写真の上で動かした形を、最新の設定のマスクに当てるときに使う。
 */
export function withPhotoEditingMaskShape(previous: DevelopMask, shaped: DevelopMask): DevelopMask | null {
  if (previous.kind === "linear" && shaped.kind === "linear") return { ...previous, zero: shaped.zero, full: shaped.full };
  if (previous.kind === "radial" && shaped.kind === "radial") {
    return { ...previous, center: shaped.center, radius: shaped.radius, angle: shaped.angle };
  }
  return null;
}

export function togglePhotoEditingMaskEnabled(mask: DevelopMask): DevelopMask {
  return { ...mask, enabled: !mask.enabled };
}

export function togglePhotoEditingMaskInvert(mask: DevelopMask): DevelopMask {
  return { ...mask, invert: !mask.invert };
}

// ---------------------------------------------------------------------------
// 局所の補正（差分）

/** 局所のスライダー 1 本（全体と同じ名前・範囲・刻み。値は全体への差分で、既定は 0）。 */
export type PhotoEditingMaskAdjustDefinition = {
  key: DevelopMaskAdjustKey;
  label: string;
  min: number;
  max: number;
  step: number;
  /** 相対の色温度・色かぶり補正（全体の白が `absolute` の間は出さない） */
  whiteBalance: boolean;
};

export type PhotoEditingMaskAdjustGroup = {
  id: PhotoEditingAdjustmentGroupId;
  title: string;
  adjustments: readonly PhotoEditingMaskAdjustDefinition[];
};

/**
 * 局所のスライダーの群（全体の右パネルの ライト／カラー／効果 と同じ並び・名前）。HSL は全体の UI（#79）の後。
 */
export const PHOTO_EDITING_MASK_ADJUST_GROUPS: readonly PhotoEditingMaskAdjustGroup[] = PHOTO_EDITING_ADJUSTMENT_GROUPS.map(
  (group): PhotoEditingMaskAdjustGroup => ({
    id: group.id,
    title: group.title,
    adjustments: group.controls.flatMap((control): PhotoEditingMaskAdjustDefinition[] => {
      if (control.kind === "adjustment") {
        const { key, label, min, max, step } = control.definition;
        return [{ key, label, min, max, step, whiteBalance: false }];
      }
      if (control.kind === "whiteBalance") {
        return [
          {
            key: control.key,
            label: control.label,
            min: PHOTO_EDITING_RELATIVE_WHITE_BALANCE_MIN,
            max: PHOTO_EDITING_RELATIVE_WHITE_BALANCE_MAX,
            step: 1,
            whiteBalance: true,
          },
        ];
      }
      return [];
    }),
  }),
);

const ADJUST_DEFINITIONS = new Map<DevelopMaskAdjustKey, PhotoEditingMaskAdjustDefinition>(
  PHOTO_EDITING_MASK_ADJUST_GROUPS.flatMap((group) => group.adjustments.map((definition) => [definition.key, definition] as const)),
);

function roundToStep(value: number, step: number): number {
  const decimals = step >= 1 ? 0 : Math.max(0, Math.ceil(-Math.log10(step) - 1e-9));
  const rounded = Number((Math.round(value / step) * step).toFixed(decimals));
  return rounded === 0 ? 0 : rounded;
}

/** 局所の差分の値（無ければ 0）。 */
export function readPhotoEditingMaskAdjust(mask: DevelopMask, key: DevelopMaskAdjustKey): number {
  return mask.adjust[key] ?? 0;
}

/**
 * 局所の差分を 1 つ変える（範囲に収め刻みに丸める。0 はキーを外す）。全体の白が `absolute` の間は相対の色温度・色かぶり補正を
 * 変えない（契約の `localWhiteBalance`）。
 */
export function setPhotoEditingMaskAdjust(
  mask: DevelopMask,
  key: DevelopMaskAdjustKey,
  value: number,
  options: { whiteBalanceAbsolute: boolean },
): DevelopMask {
  const definition = ADJUST_DEFINITIONS.get(key);
  if (!definition || !Number.isFinite(value)) return mask;
  if (definition.whiteBalance && options.whiteBalanceAbsolute) return mask;
  const next = roundToStep(clamp(value, definition.min, definition.max), definition.step);
  const adjust: DevelopMaskAdjust = { ...mask.adjust };
  if (next === 0) delete adjust[key];
  else adjust[key] = next;
  return { ...mask, adjust };
}

/** 円形のぼかし（0〜100。円形のほかは変えない）。 */
export function setPhotoEditingMaskFeather(mask: DevelopMask, value: number): DevelopMask {
  if (mask.kind !== "radial" || !Number.isFinite(value)) return mask;
  return { ...mask, feather: Math.round(clamp(value, 0, FEATHER_MAX)) };
}

/** 全体の白が `absolute` か（このときマスクの相対の白は出さない）。 */
export function isPhotoEditingWhiteBalanceAbsolute(settings: unknown): boolean {
  if (typeof settings !== "object" || settings === null) return false;
  const whiteBalance = (settings as Record<string, unknown>).whiteBalance;
  return typeof whiteBalance === "object" && whiteBalance !== null && (whiteBalance as Record<string, unknown>).mode === "absolute";
}

// ---------------------------------------------------------------------------
// 写真の上のつまみ

/**
 * 出力の上のつまみの位置。線形は `zero` `full` と真ん中の `center`、円形は `center` と自分の軸の 4 つの端（`right` = `+radius.x`、
 * `left`、`bottom` = `+radius.y`、`top`）。回転のつまみは画面の側で `top` の外に置く（画面の px で離すため）。面の種類・描けない
 * 幾何は null。
 */
export function photoEditingMaskHandles(mask: DevelopMask, frame: PhotoEditingMaskFrame | null): PhotoEditingMaskHandlePoint[] | null {
  if (!isPhotoEditingMaskFrameValid(frame)) return null;
  const toOutput = (point: Vec2, handle: PhotoEditingMaskHandle): PhotoEditingMaskHandlePoint | null => {
    const output = photoEditingMaskSourceToOutput(frame, point);
    return output ? { handle, x: output[0], y: output[1] } : null;
  };
  const points: Array<PhotoEditingMaskHandlePoint | null> = [];
  if (mask.kind === "linear") {
    const zero = pointVec(mask.zero);
    const full = pointVec(mask.full);
    points.push(toOutput(zero, "zero"), toOutput(full, "full"), toOutput([(zero[0] + full[0]) / 2, (zero[1] + full[1]) / 2], "center"));
  } else if (mask.kind === "radial") {
    const A = aspectOf(frame);
    const center = pointVec(mask.center);
    const { e1, e2 } = radialAxes(mask.angle);
    const a = mask.radius.x * A;
    const b = mask.radius.y;
    // 契約の空間の端を作業画像の座標に戻す（x は A で割る）
    const fromMetric = (offset: Vec2): Vec2 => [center[0] + offset[0] / A, center[1] + offset[1]];
    points.push(
      toOutput(center, "center"),
      toOutput(fromMetric([a * e1[0], a * e1[1]]), "right"),
      toOutput(fromMetric([-a * e1[0], -a * e1[1]]), "left"),
      toOutput(fromMetric([b * e2[0], b * e2[1]]), "bottom"),
      toOutput(fromMetric([-b * e2[0], -b * e2[1]]), "top"),
    );
  } else {
    return null;
  }
  return points.every((point): point is PhotoEditingMaskHandlePoint => point !== null) ? points : null;
}

/** 1 つのつまみの出力の上の位置（無ければ null）。 */
export function photoEditingMaskHandlePoint(
  mask: DevelopMask,
  frame: PhotoEditingMaskFrame | null,
  handle: PhotoEditingMaskHandle,
): Vec2 | null {
  const found = photoEditingMaskHandles(mask, frame)?.find((point) => point.handle === handle);
  return found ? [found.x, found.y] : null;
}

/**
 * つまみを動かした結果（動かし始めの形 `start` から。続けて動かしても誤差を積まない）。`from` は動かし始めのつまみの出力の上の
 * 位置、`to` はそこからポインタ（矢印キー）の分だけ動かした位置。`center` は形ごと平行移動、線形の `zero` / `full` はその端を
 * `to` へ、円形の軸の端はその軸の半径を（中心から `to` までをその軸へ射影した長さに。反対側も同じだけ）、`rotate` は中心から
 * `to` への向きが `top` の向きになる角度にする。範囲に収め、線形の 2 点が近すぎる・描けない幾何・形の無い種類は null（今の形の
 * まま）。
 */
export function dragPhotoEditingMaskHandle(
  start: DevelopMask,
  handle: PhotoEditingMaskHandle,
  frame: PhotoEditingMaskFrame | null,
  from: Vec2,
  to: Vec2,
): DevelopMask | null {
  if (!isPhotoEditingMaskFrameValid(frame)) return null;
  if (start.kind !== "linear" && start.kind !== "radial") return null;
  if (handle === "center") {
    const delta = sourceDelta(frame, from, to);
    if (!delta) return null;
    return start.kind === "linear" ? translateLinear(start, delta) : translateRadial(start, delta);
  }
  const target = photoEditingMaskOutputToSource(frame, to);
  if (!target) return null;
  if (start.kind === "linear") {
    if (handle !== "zero" && handle !== "full") return null;
    const moved = clampLinearPoint(target);
    const other = pointVec(handle === "zero" ? start.full : start.zero);
    if (!linearDistanceOk(moved, other)) return null;
    return handle === "zero" ? { ...start, zero: vecPoint(moved) } : { ...start, full: vecPoint(moved) };
  }
  const A = aspectOf(frame);
  const offset = subtract(toMetric(frame, target), toMetric(frame, pointVec(start.center)));
  const { e1, e2 } = radialAxes(start.angle);
  if (handle === "right" || handle === "left") {
    return { ...start, radius: { ...start.radius, x: clamp(Math.abs(dot(offset, e1)) / A, RADIUS_MIN, RADIUS_MAX) } };
  }
  if (handle === "top" || handle === "bottom") {
    return { ...start, radius: { ...start.radius, y: clamp(Math.abs(dot(offset, e2)), RADIUS_MIN, RADIUS_MAX) } };
  }
  if (handle === "rotate") {
    if (Math.hypot(offset[0], offset[1]) < 1e-9) return null;
    // `top` の向き −e2 = (sin θ, −cos θ) が中心 → to の向きになる θ
    const angle = (Math.atan2(offset[0], -offset[1]) * 180) / Math.PI;
    return { ...start, angle: normalizeAngle(angle) };
  }
  return null;
}

/** 種類の並び（ラベルの番号に使う。配列の位置 + 1）。 */
export function photoEditingMaskIndex(masks: readonly DevelopMask[], id: string): number {
  return masks.findIndex((mask) => mask.id === id);
}

/** 画面で形を動かせる種類か。 */
export function isPhotoEditingMaskShapeKind(kind: DevelopMaskKind): kind is PhotoEditingMaskShapeKind {
  return (PHOTO_EDITING_MASK_SHAPE_KINDS as readonly string[]).includes(kind);
}
