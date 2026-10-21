import type { DevelopGeometry, DevelopPerspective } from "./develop-geometry";
import { DEVELOP_PERSPECTIVE_FIELDS, IDENTITY_DEVELOP_PERSPECTIVE } from "./develop-perspective";

/**
 * Upright（niho-photo#46 後半。Lightroom の 自動 / 水平 / 垂直 / フル）の結果の読み方と、幾何への当て方（React に依存しない純粋な
 * 関数）。推定は crate の `upright.rs`（`Developer.estimateUpright`。`docs/geometry-perspective.md`「Upright」）が、写真の直線から
 * 遠近の 回転・垂直方向・水平方向 を決める。
 *
 * - 当てるときは遠近を推定の値に置き換える（縦横比・拡大・縮小・X / Y は既定に戻す。Lightroom の Upright も変形のスライダーを
 *   上書きする）。`upright` に押したボタン、「余白を埋める」を on にする。これを 1 回の確定（取り消しの 1 単位）で書く
 * - 押しているボタンをもう一度押すと Upright を切る（遠近を恒等に戻し `upright` を外す。「余白を埋める」は on のまま残す）
 * - 線が見つからなかった結果（`reason` がある・確からしさが 0）は当てない
 */

/** Upright のボタン（`geometry.upright` の値）: 1 自動・2 水平・3 垂直・4 フル。 */
export type DevelopUprightMode = 1 | 2 | 3 | 4;

/** crate の `estimateUpright` の結果。 */
export type DevelopUprightEstimate = {
  /** 補正（回転・垂直方向・水平方向。ほかは既定）。線が見つからなければ恒等 */
  perspective: DevelopPerspective;
  /** 当てたモデル（自動が選んだもの・線の足りない向きを外したもの） */
  mode: DevelopUprightMode;
  /** 確からしさ（0〜1。見つからなければ 0） */
  confidence: number;
  /** 縦・横の線として読んだ線分の数 */
  lines: { vertical: number; horizontal: number };
  /** 見つからなかった理由（`noLines`）。見つかれば null */
  reason: string | null;
};

export function isDevelopUprightMode(value: unknown): value is DevelopUprightMode {
  return value === 1 || value === 2 || value === 3 || value === 4;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isCount(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= 0;
}

/** crate の結果の JSON を読む（形が違えば null）。 */
export function readDevelopUprightEstimate(json: string): DevelopUprightEstimate | null {
  let value: unknown;
  try {
    value = JSON.parse(json);
  } catch {
    return null;
  }
  if (!isRecord(value) || !isRecord(value.perspective) || !isRecord(value.lines)) return null;
  const perspective: DevelopPerspective = { ...IDENTITY_DEVELOP_PERSPECTIVE };
  for (const { key } of DEVELOP_PERSPECTIVE_FIELDS) {
    const item = value.perspective[key];
    if (typeof item !== "number" || !Number.isFinite(item)) return null;
    perspective[key] = item;
  }
  const { mode, confidence, reason } = value;
  const { vertical, horizontal } = value.lines;
  if (!isDevelopUprightMode(mode)) return null;
  if (typeof confidence !== "number" || !(confidence >= 0 && confidence <= 1)) return null;
  if (!isCount(vertical) || !isCount(horizontal)) return null;
  if (reason !== undefined && typeof reason !== "string") return null;
  return { perspective, mode, confidence, lines: { vertical, horizontal }, reason: reason ?? null };
}

/** 補正できる結果か（線が見つかった）。 */
export function isDevelopUprightFound(estimate: DevelopUprightEstimate): boolean {
  return estimate.reason === null && estimate.confidence > 0;
}

/** 今押されている Upright のボタン（無い・1〜4 以外〔5 ガイド付きなど〕は 0）。 */
export function developGeometryUpright(geometry: DevelopGeometry): DevelopUprightMode | 0 {
  return isDevelopUprightMode(geometry.upright) ? geometry.upright : 0;
}

/**
 * ボタン `mode` の推定結果を幾何に当てる: 遠近は推定の回転・垂直方向・水平方向（ほかの 4 本は既定）、`upright` は `mode`、
 * 「余白を埋める」は on。角度補正・切り抜き・90° 回転・反転は触らない。
 */
export function applyDevelopUpright(
  geometry: DevelopGeometry,
  estimate: DevelopUprightEstimate,
  mode: DevelopUprightMode,
): DevelopGeometry {
  const { rotate, vertical, horizontal } = estimate.perspective;
  return {
    ...geometry,
    perspective: { ...IDENTITY_DEVELOP_PERSPECTIVE, rotate, vertical, horizontal },
    upright: mode,
    constrain: true,
  };
}

/** Upright を切る: 遠近を恒等に戻し `upright` を外す（「余白を埋める」はそのまま）。 */
export function clearDevelopUpright(geometry: DevelopGeometry): DevelopGeometry {
  const { perspective: _perspective, upright: _upright, ...rest } = geometry;
  return rest;
}

/** 推定した枠（90° 回転・反転・角度）と同じ枠か（推定の間に回したら、その結果は当てない）。 */
export function sameDevelopUprightFrame(a: DevelopGeometry, b: DevelopGeometry): boolean {
  return a.rotate === b.rotate && a.flipH === b.flipH && a.flipV === b.flipV && a.angle === b.angle;
}
