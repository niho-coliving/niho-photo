import type { PhotoEditingHistogram } from "./photo-editing-histogram";
import type { PhotoEditingSettings } from "./photo-editing-types";

/**
 * トーンカーブ（ポイントカーブ・RGB 別。niho-photo#37）の `developSettings` の読み書きと、グラフに描く値づくり（純関数）。
 *
 * 設定の形は crate（`settings.rs` の `toneCurves`）と同じ: `toneCurves: [{ channel: "rgb" | "red" | "green" | "blue", points: [{ x, y }] }]`
 * （x・y は 0〜1。1 チャンネル 1 本）。Lightroom のプリセット（XMP）の曲線も、crate が 0〜1 に直して同じ形で入れる。
 *
 * - 読む: crate の `normalized_points` と同じ規則で整える（有限の値だけ・0〜1 に収める・x の順・x が 1e-6 以内で重なれば後に
 *   書いた方・2 点未満は直線）。旧い形（`master` = RGB 全体、点の `[x, y]`）も読む。同じチャンネルが 2 本あれば先の 1 本（crate の
 *   描き方と同じ）
 * - 書く: 直したチャンネルの 1 本だけを整えた点で置き換え、ほかのチャンネル（取り込んだまま・知らない値も）はそのまま持つ。
 *   直線（(0,0)-(1,1) の 2 点）に戻ったチャンネルは消し、1 本も残らなければ `toneCurves` ごと消す（何も当てていない形にそろえる）。
 *   値が変わらない書き込みは、渡した設定をそのまま返す
 * - 曲線の彩度（`curveRefineSaturation`）とパラメトリックの曲線（`parametric*`）は読み書きしない（値は保つ）
 * - 点を足す・動かすときは、隣の点と x を {@link PHOTO_EDITING_TONE_CURVE_MIN_GAP} 以上離す（crate の重なりの規則と、プリセットに
 *   書くときの 1/255 の格子で 2 点が 1 つにまとまるのを避ける）。両端の点は y だけ動かせ、消せない。座標は小数 3 桁に丸める
 */

export type PhotoEditingToneCurveChannel = "rgb" | "red" | "green" | "blue";

/** グラフの切り替えの並び（RGB 全体 → R → G → B）。 */
export const PHOTO_EDITING_TONE_CURVE_CHANNELS: ReadonlyArray<PhotoEditingToneCurveChannel> = ["rgb", "red", "green", "blue"];

export type PhotoEditingToneCurvePoint = { x: number; y: number };

/** 点を足す・動かすときに、隣の点と空ける x の幅（1%） */
export const PHOTO_EDITING_TONE_CURVE_MIN_GAP = 0.01;
/** 1 本の曲線に足せる点の数（両端を含む。取り込んだ曲線がこれより多くても動かせる） */
export const PHOTO_EDITING_TONE_CURVE_MAX_POINTS = 16;

/** crate の `normalized_points` が x の重なりとみなす幅 */
const DUPLICATE_X = 1e-6;
/** crate の `curves_are_identity` の許容（`is_neutral` と同じ） */
const IDENTITY_TOLERANCE = 1e-9;
/** 幅の比較の丸め誤差（0.03 - 0.02 が 0.01 を下回るのを同じとみなす） */
const GAP_EPSILON = 1e-9;
const COORDINATE_SCALE = 1000;

const CHANNEL_NAMES: Readonly<Record<string, PhotoEditingToneCurveChannel>> = {
  rgb: "rgb",
  // Photo Bench の旧い形（RGB 全体）
  master: "rgb",
  red: "red",
  green: "green",
  blue: "blue",
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function curveChannel(value: unknown): PhotoEditingToneCurveChannel | null {
  return typeof value === "string" && Object.hasOwn(CHANNEL_NAMES, value) ? CHANNEL_NAMES[value] : null;
}

function clamp01(value: number): number {
  return Math.min(1, Math.max(0, value));
}

/** 小数 3 桁に丸める（-0 は 0）。 */
function roundCoordinate(value: number): number {
  const rounded = Math.round(value * COORDINATE_SCALE) / COORDINATE_SCALE;
  return rounded === 0 ? 0 : rounded;
}

function linearPoints(): PhotoEditingToneCurvePoint[] {
  return [
    { x: 0, y: 0 },
    { x: 1, y: 1 },
  ];
}

/** 点の値（`{ x, y }` か旧い形の `[x, y]`）。数でなければ null。 */
function rawPoint(value: unknown): { x: number; y: number } | null {
  if (Array.isArray(value) && value.length === 2 && typeof value[0] === "number" && typeof value[1] === "number") {
    return { x: value[0], y: value[1] };
  }
  if (isRecord(value) && typeof value.x === "number" && typeof value.y === "number") return { x: value.x, y: value.y };
  return null;
}

/**
 * 1 本の曲線の点を、crate の `normalized_points` と同じ規則で整える: 有限の値だけを 0〜1 に収め、x の順に並べ、x が 1e-6 以内で
 * 重なる点は後に書いた方を残す。2 点に満たなければ（crate は何もしない＝恒等）直線の 2 点。
 */
export function normalizePhotoEditingToneCurvePoints(raw: unknown): PhotoEditingToneCurvePoint[] {
  if (!Array.isArray(raw)) return linearPoints();
  const finite: { order: number; point: PhotoEditingToneCurvePoint }[] = [];
  raw.forEach((item, order) => {
    const point = rawPoint(item);
    if (!point || !Number.isFinite(point.x) || !Number.isFinite(point.y)) return;
    finite.push({ order, point: { x: clamp01(point.x), y: clamp01(point.y) } });
  });
  // 安定な並べ替え（同じ x は書いた順のまま。crate の sort_by と同じ）
  finite.sort((a, b) => a.point.x - b.point.x);
  const result: { order: number; point: PhotoEditingToneCurvePoint }[] = [];
  for (const candidate of finite) {
    const last = result[result.length - 1];
    if (last && Math.abs(last.point.x - candidate.point.x) < DUPLICATE_X) {
      if (candidate.order > last.order) result[result.length - 1] = candidate;
      continue;
    }
    result.push(candidate);
  }
  return result.length >= 2 ? result.map((item) => item.point) : linearPoints();
}

/** `toneCurves` の中の、そのチャンネルの先の 1 本（無ければ undefined）。 */
function curveEntry(settings: PhotoEditingSettings, channel: PhotoEditingToneCurveChannel): Record<string, unknown> | undefined {
  const curves = settings.toneCurves;
  if (!Array.isArray(curves)) return undefined;
  return curves.find((item): item is Record<string, unknown> => isRecord(item) && curveChannel(item.channel) === channel);
}

/** 1 チャンネルの曲線を、グラフに出して直せる形（整えた点。無ければ直線の 2 点）で読む。 */
export function readPhotoEditingToneCurve(
  settings: PhotoEditingSettings,
  channel: PhotoEditingToneCurveChannel,
): PhotoEditingToneCurvePoint[] {
  return normalizePhotoEditingToneCurvePoints(curveEntry(settings, channel)?.points);
}

/** 4 チャンネルの曲線をまとめて読む（{@link readPhotoEditingToneCurve}）。 */
export function readPhotoEditingToneCurves(
  settings: PhotoEditingSettings,
): Record<PhotoEditingToneCurveChannel, PhotoEditingToneCurvePoint[]> {
  return {
    rgb: readPhotoEditingToneCurve(settings, "rgb"),
    red: readPhotoEditingToneCurve(settings, "red"),
    green: readPhotoEditingToneCurve(settings, "green"),
    blue: readPhotoEditingToneCurve(settings, "blue"),
  };
}

/** 直線の 2 点（(0,0)-(1,1)）だけか（グラフに何も足していない形）。 */
export function isLinearPhotoEditingToneCurve(points: ReadonlyArray<PhotoEditingToneCurvePoint>): boolean {
  return points.length === 2 && points[0].x === 0 && points[0].y === 0 && points[1].x === 1 && points[1].y === 1;
}

/** 画を変えない曲線か（どの点も入力と出力が同じ。crate の `curves_are_identity` と同じ許容）。 */
export function isIdentityPhotoEditingToneCurve(points: ReadonlyArray<PhotoEditingToneCurvePoint>): boolean {
  return points.every((point) => Math.abs(point.x - point.y) <= IDENTITY_TOLERANCE);
}

/**
 * グラフに直線の 2 点でない曲線が 1 本でもあるか（カーブの「初期化」を押せるか）。対角線の上に点だけ残した曲線も、点を消せる
 * ように数える。
 */
export function hasPhotoEditingToneCurveEdits(settings: PhotoEditingSettings): boolean {
  return PHOTO_EDITING_TONE_CURVE_CHANNELS.some((channel) => !isLinearPhotoEditingToneCurve(readPhotoEditingToneCurve(settings, channel)));
}

function samePoints(a: ReadonlyArray<PhotoEditingToneCurvePoint>, b: ReadonlyArray<PhotoEditingToneCurvePoint>): boolean {
  return a.length === b.length && a.every((point, index) => point.x === b[index].x && point.y === b[index].y);
}

function without(settings: PhotoEditingSettings, key: string): PhotoEditingSettings {
  const next = { ...settings };
  delete next[key];
  return next;
}

/**
 * 1 チャンネルの曲線を書き換えた新しい settings を返す。そのチャンネルの曲線（`master` の別名・重なった 2 本目も）を整えた点の
 * 1 本に置き換え（元の位置に置く）、ほかのチャンネルと知らない値はそのまま持つ。直線の 2 点ならそのチャンネルを消し、1 本も残らな
 * ければ `toneCurves` ごと消す。読んだ形が変わらなければ、渡した settings をそのまま返す。
 */
export function writePhotoEditingToneCurve(
  settings: PhotoEditingSettings,
  channel: PhotoEditingToneCurveChannel,
  points: ReadonlyArray<PhotoEditingToneCurvePoint>,
): PhotoEditingSettings {
  const next = normalizePhotoEditingToneCurvePoints(points);
  if (samePoints(readPhotoEditingToneCurve(settings, channel), next)) return settings;
  const entry = isLinearPhotoEditingToneCurve(next)
    ? null
    : { channel, points: next.map((point) => ({ x: point.x, y: point.y })) };
  const source: ReadonlyArray<unknown> = Array.isArray(settings.toneCurves) ? settings.toneCurves : [];
  const curves: unknown[] = [];
  let replaced = false;
  for (const item of source) {
    if (isRecord(item) && curveChannel(item.channel) === channel) {
      if (!replaced && entry) curves.push(entry);
      replaced = true;
      continue;
    }
    curves.push(item);
  }
  if (!replaced && entry) curves.push(entry);
  return curves.length === 0 ? without(settings, "toneCurves") : { ...settings, toneCurves: curves };
}

/** カーブの「初期化」: 曲線（4 チャンネルとも）を直線に戻す（`toneCurves` ごと消す）。直線のままなら、渡した settings のまま。 */
export function resetPhotoEditingToneCurves(settings: PhotoEditingSettings): PhotoEditingSettings {
  return hasPhotoEditingToneCurveEdits(settings) ? without(settings, "toneCurves") : settings;
}

// ---------------------------------------------------------------------------
// 点の操作（整えた点の並びに当てる。並びは x の順のまま変わらない）

/**
 * 点を 1 つ足す（座標は 0〜1 に収めて小数 3 桁に丸める）。両端の点の外・隣の点に近すぎる（{@link PHOTO_EDITING_TONE_CURVE_MIN_GAP}
 * 未満）・点が多すぎるときは足さない（null）。足した点の位置（index）を返す。
 */
export function addPhotoEditingToneCurvePoint(
  points: ReadonlyArray<PhotoEditingToneCurvePoint>,
  target: PhotoEditingToneCurvePoint,
): { points: PhotoEditingToneCurvePoint[]; index: number } | null {
  if (points.length >= PHOTO_EDITING_TONE_CURVE_MAX_POINTS || !Number.isFinite(target.x) || !Number.isFinite(target.y)) return null;
  const x = roundCoordinate(clamp01(target.x));
  const y = roundCoordinate(clamp01(target.y));
  const index = points.findIndex((point) => point.x > x);
  if (index <= 0) return null;
  const gapBefore = x - points[index - 1].x;
  const gapAfter = points[index].x - x;
  if (gapBefore < PHOTO_EDITING_TONE_CURVE_MIN_GAP - GAP_EPSILON || gapAfter < PHOTO_EDITING_TONE_CURVE_MIN_GAP - GAP_EPSILON) {
    return null;
  }
  return { points: [...points.slice(0, index), { x, y }, ...points.slice(index)], index };
}

/**
 * 点を動かす。y は 0〜1、x は隣の点の間（{@link PHOTO_EDITING_TONE_CURVE_MIN_GAP} 空ける。取り込んだ曲線ですでに近い点は、今より
 * 近づけない）に収め、小数 3 桁に丸める。両端の点は y だけ動かす。変わらなければ渡した並びのまま。
 */
export function movePhotoEditingToneCurvePoint(
  points: ReadonlyArray<PhotoEditingToneCurvePoint>,
  index: number,
  target: PhotoEditingToneCurvePoint,
): ReadonlyArray<PhotoEditingToneCurvePoint> {
  const current = points[index];
  if (!current) return points;
  const y = Number.isFinite(target.y) ? roundCoordinate(clamp01(target.y)) : current.y;
  let x = current.x;
  if (index > 0 && index < points.length - 1 && Number.isFinite(target.x)) {
    const previous = points[index - 1].x;
    const next = points[index + 1].x;
    const low = Math.min(current.x, previous + PHOTO_EDITING_TONE_CURVE_MIN_GAP);
    const high = Math.max(current.x, next - PHOTO_EDITING_TONE_CURVE_MIN_GAP);
    const clamped = Math.min(high, Math.max(low, target.x));
    if (clamped !== current.x) {
      const rounded = roundCoordinate(clamped);
      // 丸めで動ける幅の外に出る（取り込んだ曲線の近い点）ときは丸めない
      x = rounded >= low - GAP_EPSILON && rounded <= high + GAP_EPSILON ? rounded : clamped;
    }
  }
  if (x === current.x && y === current.y) return points;
  return points.map((point, position) => (position === index ? { x, y } : point));
}

/** 点を消す（両端の点は消せない。そのときは渡した並びのまま）。 */
export function removePhotoEditingToneCurvePoint(
  points: ReadonlyArray<PhotoEditingToneCurvePoint>,
  index: number,
): ReadonlyArray<PhotoEditingToneCurvePoint> {
  if (index <= 0 || index >= points.length - 1) return points;
  return points.filter((_, position) => position !== index);
}

/**
 * キーボードで点を足す: `index` の点と次の点（最後の点なら前の点）の間の真ん中に、今の曲線の上の高さで足す（足しても画は変わら
 * ない）。足せなければ null（{@link addPhotoEditingToneCurvePoint}）。
 */
export function insertPhotoEditingToneCurvePointBeside(
  points: ReadonlyArray<PhotoEditingToneCurvePoint>,
  index: number,
): { points: PhotoEditingToneCurvePoint[]; index: number } | null {
  const left = index >= points.length - 1 ? points.length - 2 : index;
  const a = points[left];
  const b = points[left + 1];
  if (!a || !b) return null;
  const x = roundCoordinate((a.x + b.x) / 2);
  return addPhotoEditingToneCurvePoint(points, { x, y: evaluatePhotoEditingToneCurve(points, x) });
}

// ---------------------------------------------------------------------------
// 曲線の値（crate の `DngSpline`〔DNG SDK の dng_spline_solver〕と同じ式。両端の外は端の高さのまま、値は 0〜1 に収める）

type ToneCurveSpline = { x: number[]; y: number[]; s: number[] };

function solveSlopes(x: number[], y: number[]): number[] {
  const count = x.length;
  const s = new Array<number>(count).fill(0);
  let a = x[1] - x[0];
  let b = (y[1] - y[0]) / a;
  s[0] = b;
  for (let j = 2; j < count; j += 1) {
    const c = x[j] - x[j - 1];
    const d = (y[j] - y[j - 1]) / c;
    s[j - 1] = (b * c + d * a) / (a + c);
    a = c;
    b = d;
  }
  s[count - 1] = 2 * b - s[count - 2];
  s[0] = 2 * s[0] - s[1];
  if (count <= 2) return s;
  const e = new Array<number>(count).fill(0);
  const f = new Array<number>(count).fill(0);
  const g = new Array<number>(count).fill(0);
  f[0] = 0.5;
  e[count - 1] = 0.5;
  g[0] = 0.75 * (s[0] + s[1]);
  g[count - 1] = 0.75 * (s[count - 2] + s[count - 1]);
  for (let j = 1; j < count - 1; j += 1) {
    const aj = (x[j + 1] - x[j - 1]) * 2;
    e[j] = (x[j + 1] - x[j]) / aj;
    f[j] = (x[j] - x[j - 1]) / aj;
    g[j] = 1.5 * s[j];
  }
  for (let j = 1; j < count; j += 1) {
    const aj = 1 - f[j - 1] * e[j];
    if (j !== count - 1) f[j] /= aj;
    g[j] = (g[j] - g[j - 1] * e[j]) / aj;
  }
  for (let j = count - 2; j >= 0; j -= 1) g[j] -= f[j] * g[j + 1];
  return g;
}

/** 整えた点（x が増えていく 2 点以上）の曲線。そうでなければ null（crate も描かない）。 */
function prepareSpline(points: ReadonlyArray<PhotoEditingToneCurvePoint>): ToneCurveSpline | null {
  if (points.length < 2) return null;
  const x = points.map((point) => point.x);
  const y = points.map((point) => point.y);
  for (let k = 1; k < x.length; k += 1) if (!(x[k] > x[k - 1])) return null;
  return { x, y, s: solveSlopes(x, y) };
}

function evaluateSpline(spline: ToneCurveSpline, value: number): number {
  const { x, y, s } = spline;
  const count = x.length;
  if (value <= x[0]) return y[0];
  if (value >= x[count - 1]) return y[count - 1];
  let lower = 1;
  let upper = count - 1;
  while (upper > lower) {
    const mid = (lower + upper) >> 1;
    if (value === x[mid]) return y[mid];
    if (value > x[mid]) lower = mid + 1;
    else upper = mid;
  }
  const j = lower;
  const a = x[j] - x[j - 1];
  const b = (value - x[j - 1]) / a;
  const c = (x[j] - value) / a;
  return (y[j - 1] * (2 - c + b) + s[j - 1] * a * b) * (c * c) + (y[j] * (2 - b + c) - s[j] * a * c) * (b * b);
}

/** 曲線の入力 `x`（0〜1）に対する出力（0〜1）。描けない点の並びなら恒等。 */
export function evaluatePhotoEditingToneCurve(points: ReadonlyArray<PhotoEditingToneCurvePoint>, x: number): number {
  const spline = prepareSpline(points);
  return clamp01(spline ? evaluateSpline(spline, x) : x);
}

const roundPath = (value: number) => Math.round(value * 10000) / 10000;

/**
 * 曲線を、幅・高さ 1 の SVG 座標（左上が原点。出力 1 が上）の線の path にする。0〜1 を `samples` 等分した入力と点の入力で
 * 値をとる（点の上を必ず通る）。
 */
export function photoEditingToneCurvePath(points: ReadonlyArray<PhotoEditingToneCurvePoint>, samples = 128): string {
  const spline = prepareSpline(points);
  const inputs = new Set<number>();
  for (let step = 0; step <= samples; step += 1) inputs.add(step / samples);
  for (const point of points) inputs.add(point.x);
  return [...inputs]
    .sort((a, b) => a - b)
    .map((input, index) => {
      const output = clamp01(spline ? evaluateSpline(spline, input) : input);
      return `${index === 0 ? "M" : "L"}${roundPath(input)} ${roundPath(1 - output)}`;
    })
    .join("");
}

// ---------------------------------------------------------------------------
// グラフの背後の輝度のヒストグラム

/** 輝度の重み（Rec.709 / sRGB の Y） */
export const PHOTO_EDITING_LUMINANCE_WEIGHTS = { red: 0.2126, green: 0.7152, blue: 0.0722 } as const;

/**
 * グラフの背後に敷く輝度の度数（256 階調）。右パネルのヒストグラムが数えた R / G / B の度数を、階調ごとに Rec.709 の重みで混ぜて
 * 整数に丸める（画素ごとの輝度ではなく、3 色の分布の重みつきの平均で近似する。度数の合計はほぼ画素の数のまま。画を数え直さない）。
 */
export function photoEditingLuminanceCounts(histogram: Pick<PhotoEditingHistogram, "red" | "green" | "blue">): Uint32Array {
  const { red, green, blue } = histogram;
  const length = Math.min(red.length, green.length, blue.length);
  const counts = new Uint32Array(length);
  const weights = PHOTO_EDITING_LUMINANCE_WEIGHTS;
  for (let level = 0; level < length; level += 1) {
    counts[level] = Math.round(weights.red * red[level] + weights.green * green[level] + weights.blue * blue[level]);
  }
  return counts;
}
