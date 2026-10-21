/**
 * 修復（niho-photo#44）の `developSettings.heal` の形と、その読み取り（crate の `heal.rs` と同じ規則）。
 *
 * `heal` は描いた順の印の配列: `{ id, mode: "remove" | "clone", radius, feather, points: [[x, y], ...], source?: [dx, dy] }`。
 * 座標は 0〜1（幾何〔90° 回転・反転・遠近・角度・切り抜き〕の前の写真の幅・高さに対する割合）、`radius` は長辺に対する割合
 * （0.002〜0.25）、`feather` は 0〜1（ブラシの縁の外側半分までをぼかす割合）、`source` は「写す」の写し元（印からの相対位置。
 * 各 -1〜1。無ければエンジンが周りの最も似た場所を選ぶ。「消す」では読まない）。印があれば形の版 `v` は 8。印が無ければキーごと
 * 書かない。この画面の版を上げずに足した項目は crate が `unknownKey` で拒むので、知らないキーを持つ印は形の壊れた印とする。
 *
 * このファイルは develop-settings.ts からも読むので、develop-settings.ts を import しない（編集の純関数は develop-heal-editing.ts）。
 */

/** 印のある編集内容の形の版（crate の `HEAL_SETTINGS_VERSION`）。 */
export const HEAL_SETTINGS_VERSION = 8;
/** 1 枚の写真の印の上限（crate の `MAX_HEAL_MARKS`）。 */
export const MAX_HEAL_MARKS = 64;
/** 1 つの印の点の上限（crate の `MAX_HEAL_POINTS`）。 */
export const MAX_HEAL_POINTS = 512;
/** 1 枚の写真の点の合計の上限（crate の `MAX_HEAL_TOTAL_POINTS`。設定の 64KiB に十分収まる）。 */
export const MAX_HEAL_TOTAL_POINTS = 2048;
/** ブラシの半径の範囲（長辺に対する割合）。 */
export const MIN_HEAL_RADIUS = 0.002;
export const MAX_HEAL_RADIUS = 0.25;
/** 印の `id` の長さの上限（ASCII のバイト数）。 */
export const MAX_HEAL_ID_LENGTH = 64;

export type DevelopHealMode = "remove" | "clone";
export type DevelopHealPoint = readonly [number, number];

export type DevelopHealMark = {
  id: string;
  mode: DevelopHealMode;
  radius: number;
  feather: number;
  points: DevelopHealPoint[];
  source?: DevelopHealPoint;
};

const MARK_KEYS: ReadonlySet<string> = new Set(["id", "mode", "radius", "feather", "points", "source"]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function finiteIn(value: unknown, min: number, max: number): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= min && value <= max;
}

function isPair(value: unknown, min: number, max: number): value is DevelopHealPoint {
  return Array.isArray(value) && value.length === 2 && finiteIn(value[0], min, max) && finiteIn(value[1], min, max);
}

/** 印の `id` として使えるか（1〜64 文字の ASCII）。 */
export function isDevelopHealId(value: unknown): value is string {
  return typeof value === "string" && value.length >= 1 && value.length <= MAX_HEAL_ID_LENGTH && /^[\x00-\x7f]+$/u.test(value);
}

/** 1 つの印として描ける形か（crate の `parse_heal` と `validate_heal` を両方通る）。 */
export function isDevelopHealMark(value: unknown): value is DevelopHealMark {
  if (!isRecord(value) || Object.keys(value).some((key) => !MARK_KEYS.has(key))) return false;
  if (!isDevelopHealId(value.id)) return false;
  if (value.mode !== "remove" && value.mode !== "clone") return false;
  if (!finiteIn(value.radius, MIN_HEAL_RADIUS, MAX_HEAL_RADIUS) || !finiteIn(value.feather, 0, 1)) return false;
  if (!Array.isArray(value.points) || value.points.length < 1 || value.points.length > MAX_HEAL_POINTS) return false;
  if (!value.points.every((point) => isPair(point, 0, 1))) return false;
  return value.source === undefined || value.source === null || isPair(value.source, -1, 1);
}

/**
 * `heal` の値を印の配列として読む（crate が描ける形だけ。無い〔undefined・null〕なら空）。配列でない・壊れた印・上限超え・`id`
 * の重複があれば null（描けない設定として扱う）。
 */
export function readDevelopHealMarks(value: unknown): DevelopHealMark[] | null {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value) || value.length > MAX_HEAL_MARKS) return null;
  const ids = new Set<string>();
  let total = 0;
  for (const mark of value) {
    if (!isDevelopHealMark(mark) || ids.has(mark.id)) return null;
    ids.add(mark.id);
    total += mark.points.length;
  }
  if (total > MAX_HEAL_TOTAL_POINTS) return null;
  return value as DevelopHealMark[];
}

/** 編集内容の `heal` が描ける形か（無いのも可）。 */
export function hasValidDevelopHeal(settings: Record<string, unknown>): boolean {
  return readDevelopHealMarks(settings.heal) !== null;
}

/**
 * 修復の印が 1 つ以上あるか（形の版 8 が要る。crate の `required_version`）。形の壊れた `heal`（配列でない・壊れた印）も、
 * 恒等とみなさず true（描けない設定として扱う）。空の配列・無い・null は false。
 */
export function hasDevelopHeal(value: unknown): boolean {
  if (!isRecord(value)) return false;
  const heal = value.heal;
  if (heal === undefined || heal === null) return false;
  return !Array.isArray(heal) || heal.length > 0;
}
