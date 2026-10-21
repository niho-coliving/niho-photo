import {
  MAX_HEAL_MARKS,
  MAX_HEAL_POINTS,
  MAX_HEAL_RADIUS,
  MAX_HEAL_TOTAL_POINTS,
  MIN_HEAL_RADIUS,
  isDevelopHealId,
  type DevelopHealMode,
  type DevelopHealPoint,
} from "./develop-heal";
import { developSettingsVersion, type DevelopSettings } from "./develop-settings";

/**
 * 修復（niho-photo#44）の印を直す純関数（画面のブラシ・印の一覧が使う口）。形と上限は develop-heal.ts（crate の `heal.rs`）。
 *
 * - 読む（{@link readDevelopHeal}）: 範囲外・数でない値は表示のために範囲へ収める・既定にするだけで、書き戻さない。印として読めない
 *   要素（オブジェクトでない・`id` が無い）は見せない
 * - 書く: 直した印だけを書き換え、ほかの印・印の知らないキー・設定の知らないキーはそのまま持つ。印が 0 個になれば `heal` ごと消す。
 *   形の版 `v` は書いた結果から決め直す（印があれば 8）。見せている値が変わらない・上限を超える書き込みは、渡した設定をそのまま返す
 * - 並べ替えはしない（印は描いた順に当たる。後の印が前の印の結果の上に重なる）
 * - 座標は 5 桁に丸めて書く（8000px の写真でも 0.1px 未満。設定の大きさを抑える）
 */

/** ブラシの既定（長辺の 2%・縁の半分をぼかす）。 */
export const DEFAULT_HEAL_RADIUS = 0.02;
export const DEFAULT_HEAL_FEATHER = 0.5;
/** なぞる点の間隔の既定（半径に対する割合。これより近い点は足さない）。 */
export const DEFAULT_HEAL_POINT_SPACING = 0.25;

/** 見せる印（値は範囲に収めたもの）。 */
export type DevelopHealMarkView = {
  id: string;
  mode: DevelopHealMode;
  radius: number;
  feather: number;
  points: DevelopHealPoint[];
  /** 「写す」の写し元（印からの相対位置）。無ければ null（エンジンが選ぶ） */
  source: DevelopHealPoint | null;
};

/** 新しく足す印（`id` は呼び出し側が作る）。 */
export type DevelopHealMarkInput = {
  id: string;
  mode: DevelopHealMode;
  radius: number;
  feather: number;
  points: readonly DevelopHealPoint[];
  source?: DevelopHealPoint | null;
};

/** 写真の大きさ（なぞる点の間隔を長辺の単位で測る）。 */
export type DevelopHealImageSize = { width: number; height: number };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function clamp(value: number, min: number, max: number): number {
  const clamped = Math.min(max, Math.max(min, value));
  return clamped === 0 ? 0 : clamped;
}

function finite(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

/** 5 桁に丸める（-0 は 0）。 */
function round5(value: number): number {
  const rounded = Math.round(value * 1e5) / 1e5;
  return rounded === 0 ? 0 : rounded;
}

function displayPoint(value: unknown, min: number, max: number): DevelopHealPoint | null {
  if (!Array.isArray(value) || value.length !== 2 || !finite(value[0]) || !finite(value[1])) return null;
  return [clamp(value[0], min, max), clamp(value[1], min, max)];
}

function writablePoint(point: DevelopHealPoint, min: number, max: number): DevelopHealPoint | null {
  if (!finite(point[0]) || !finite(point[1])) return null;
  return [round5(clamp(point[0], min, max)), round5(clamp(point[1], min, max))];
}

function rawMarks(settings: DevelopSettings): unknown[] {
  return Array.isArray(settings.heal) ? settings.heal : [];
}

function readMark(value: unknown): DevelopHealMarkView | null {
  if (!isRecord(value) || typeof value.id !== "string") return null;
  const points = Array.isArray(value.points)
    ? value.points.map((point) => displayPoint(point, 0, 1)).filter((point): point is DevelopHealPoint => point !== null)
    : [];
  return {
    id: value.id,
    mode: value.mode === "clone" ? "clone" : "remove",
    radius: finite(value.radius) ? clamp(value.radius, MIN_HEAL_RADIUS, MAX_HEAL_RADIUS) : DEFAULT_HEAL_RADIUS,
    feather: finite(value.feather) ? clamp(value.feather, 0, 1) : DEFAULT_HEAL_FEATHER,
    points,
    source: displayPoint(value.source, -1, 1),
  };
}

/** 印を描いた順に、見せる形で読む（{@link DevelopHealMarkView}）。 */
export function readDevelopHeal(settings: DevelopSettings): DevelopHealMarkView[] {
  return rawMarks(settings)
    .map(readMark)
    .filter((mark): mark is DevelopHealMarkView => mark !== null);
}

/** 印がいくつあり、点を合わせていくつ使っているか（上限の検査）。 */
export function developHealUsage(settings: DevelopSettings): { marks: number; points: number } {
  const marks = rawMarks(settings);
  const points = marks.reduce<number>(
    (sum, mark) => sum + (isRecord(mark) && Array.isArray(mark.points) ? mark.points.length : 0),
    0,
  );
  return { marks: marks.length, points };
}

/** 印をもう 1 つ足せるか（印の数・点の合計の上限）。 */
export function canAddDevelopHealMark(settings: DevelopSettings): boolean {
  const usage = developHealUsage(settings);
  return usage.marks < MAX_HEAL_MARKS && usage.points < MAX_HEAL_TOTAL_POINTS;
}

/** 印の位置（無ければ -1）。 */
export function developHealMarkIndex(settings: DevelopSettings, id: string): number {
  return rawMarks(settings).findIndex((mark) => isRecord(mark) && mark.id === id);
}

/** `heal` を `marks` にした設定（空ならキーごと消す）。形の版を決め直す。 */
function withMarks(settings: DevelopSettings, marks: unknown[]): DevelopSettings {
  const next: Record<string, unknown> = { ...settings };
  if (marks.length === 0) delete next.heal;
  else next.heal = marks;
  return { ...next, v: developSettingsVersion(next), engine: settings.engine };
}

/**
 * 印を末尾に足す（後から描いた印として当たる）。`id` が使えない・既にある、点が無い、上限（印 64・1 つの印 512 点・合計 2048 点）を
 * 超えるなら、渡した設定のまま。半径・ぼかし・座標は範囲に収め、座標は 5 桁に丸める。
 */
export function addDevelopHealMark(settings: DevelopSettings, input: DevelopHealMarkInput): DevelopSettings {
  if (!isDevelopHealId(input.id) || developHealMarkIndex(settings, input.id) >= 0) return settings;
  if (!finite(input.radius) || !finite(input.feather)) return settings;
  const points = input.points
    .map((point) => writablePoint(point, 0, 1))
    .filter((point): point is DevelopHealPoint => point !== null);
  if (points.length === 0 || points.length > MAX_HEAL_POINTS) return settings;
  const usage = developHealUsage(settings);
  if (usage.marks >= MAX_HEAL_MARKS || usage.points + points.length > MAX_HEAL_TOTAL_POINTS) return settings;
  const mark: Record<string, unknown> = {
    id: input.id,
    mode: input.mode,
    radius: clamp(input.radius, MIN_HEAL_RADIUS, MAX_HEAL_RADIUS),
    feather: clamp(input.feather, 0, 1),
    points,
  };
  const source = input.source ? writablePoint(input.source, -1, 1) : null;
  if (source) mark.source = source;
  return withMarks(settings, [...rawMarks(settings), mark]);
}

/** 印の点の間隔（長辺の単位）。`size` が無ければ正方形とみなす。 */
function spacing(a: DevelopHealPoint, b: DevelopHealPoint, size?: DevelopHealImageSize): number {
  const long = size ? Math.max(size.width, size.height) : 1;
  const sx = size ? size.width / long : 1;
  const sy = size ? size.height / long : 1;
  return Math.hypot((a[0] - b[0]) * sx, (a[1] - b[1]) * sy);
}

/**
 * なぞっている印に点を 1 つ足す。前の点から `半径 × minSpacing`（既定 {@link DEFAULT_HEAL_POINT_SPACING}）より近い点・数でない点は
 * 足さず、印が無い・点の上限（1 つの印 512・合計 2048）なら、渡した設定のまま。
 */
export function appendDevelopHealPoint(
  settings: DevelopSettings,
  id: string,
  point: DevelopHealPoint,
  options: { size?: DevelopHealImageSize; minSpacing?: number } = {},
): DevelopSettings {
  const index = developHealMarkIndex(settings, id);
  if (index < 0) return settings;
  const marks = rawMarks(settings);
  const raw = marks[index] as Record<string, unknown>;
  const view = readMark(raw);
  const next = writablePoint(point, 0, 1);
  if (!view || !next || !Array.isArray(raw.points)) return settings;
  if (raw.points.length >= MAX_HEAL_POINTS || developHealUsage(settings).points >= MAX_HEAL_TOTAL_POINTS) return settings;
  const last = view.points[view.points.length - 1];
  const minimum = view.radius * (options.minSpacing ?? DEFAULT_HEAL_POINT_SPACING);
  if (last && spacing(last, next, options.size) < minimum) return settings;
  const updated = [...marks];
  updated[index] = { ...raw, points: [...raw.points, next] };
  return withMarks(settings, updated);
}

/** 印の直せる値（モード・半径・ぼかし・写し元。写し元の null は「エンジンが選ぶ」に戻す）。 */
export type DevelopHealMarkPatch = Partial<{
  mode: DevelopHealMode;
  radius: number;
  feather: number;
  source: DevelopHealPoint | null;
}>;

/**
 * 印の値を書き換える（ほかの値・印の知らないキーはそのまま）。印が無い、見せている値が変わらない（数でない値も）なら、渡した設定のまま。
 */
export function updateDevelopHealMark(settings: DevelopSettings, id: string, patch: DevelopHealMarkPatch): DevelopSettings {
  const index = developHealMarkIndex(settings, id);
  if (index < 0) return settings;
  const marks = rawMarks(settings);
  const raw = marks[index] as Record<string, unknown>;
  const view = readMark(raw);
  if (!view) return settings;
  const next: Record<string, unknown> = { ...raw };
  let changed = false;
  if (patch.mode !== undefined && patch.mode !== view.mode) {
    next.mode = patch.mode;
    changed = true;
  }
  if (patch.radius !== undefined && finite(patch.radius)) {
    const radius = clamp(patch.radius, MIN_HEAL_RADIUS, MAX_HEAL_RADIUS);
    if (radius !== view.radius) {
      next.radius = radius;
      changed = true;
    }
  }
  if (patch.feather !== undefined && finite(patch.feather)) {
    const feather = clamp(patch.feather, 0, 1);
    if (feather !== view.feather) {
      next.feather = feather;
      changed = true;
    }
  }
  if (patch.source !== undefined) {
    const source = patch.source === null ? null : writablePoint(patch.source, -1, 1);
    const same =
      source === null ? view.source === null : view.source !== null && source[0] === view.source[0] && source[1] === view.source[1];
    if (!same && (patch.source === null || source !== null)) {
      if (source === null) delete next.source;
      else next.source = source;
      changed = true;
    }
  }
  if (!changed) return settings;
  const updated = [...marks];
  updated[index] = next;
  return withMarks(settings, updated);
}

/** 印を消す（残りは描いた順のまま）。印が無ければ渡した設定のまま。 */
export function removeDevelopHealMark(settings: DevelopSettings, id: string): DevelopSettings {
  const index = developHealMarkIndex(settings, id);
  if (index < 0) return settings;
  return withMarks(
    settings,
    rawMarks(settings).filter((_, i) => i !== index),
  );
}

/** 印を全部消す（`heal` ごと）。印が無ければ渡した設定のまま。 */
export function clearDevelopHeal(settings: DevelopSettings): DevelopSettings {
  return settings.heal === undefined ? settings : withMarks(settings, []);
}
