import { developSettingsVersion, type DevelopSettings } from "./develop-settings";

/**
 * 部分補正（マスク）の保存形（`developSettings.masks`。Epic #31 の契約は `docs/local-adjustments.md`）。ここは設定の読み書きと
 * 検証だけで、描画・面の計算・混ぜ方はしない（M2 以降）。Rust（`niho-develop` の `local_mask.rs`）と同じ厳密さで読み、
 * 同じ fixture（`develop-engine/crates/niho-develop/tests/fixtures/masks/settings-cases.json`）で突き合わせる。
 *
 * - 各マスクと入れ子の物は、種類ごとのキーだけを持つ（欠落・未知キー・種類に合わないキー・非有限値・範囲外・重複 id・9 枚以上は読まない）。
 * - 読んだ結果（{@link DevelopMask}）は正規化済み: `enabled` / `invert` は常にあり、`adjust.hsl` は 0 でない帯だけを 3 値そろえて持つ。
 * - 書くとき（{@link writeDevelopMasks}）は正規形: キー順は `id` `kind` `enabled`（`false` のときだけ）`invert`（`true` のときだけ）、
 *   種類のキー、`adjust`。`adjust` は 0 の項目を書かず、数値は小数 6 桁に丸める。空の配列は `masks` を外す（無いのと同じ）。
 */

/** 最大のマスクの枚数。 */
export const MAX_DEVELOP_MASKS = 8;
/** マスクが 1 枚でもあるときに要る `developSettings.v`（crate の `MASKS_SETTINGS_VERSION`）。 */
export const DEVELOP_MASKS_SETTINGS_VERSION = 5;
/** 面（ブラシ・被写体・空）の PNG の一辺の最大（画素）。 */
export const MAX_DEVELOP_MASK_SURFACE_SIDE = 4096;
/** 線形の `zero` と `full` の最小の距離。 */
export const MIN_DEVELOP_MASK_LINEAR_DISTANCE = 0.001;

export const DEVELOP_MASK_KINDS = ["linear", "radial", "brush", "subject", "sky"] as const;
export type DevelopMaskKind = (typeof DEVELOP_MASK_KINDS)[number];

export type DevelopMaskPoint = { x: number; y: number };

/** 面の参照（PNG の sha256 と寸法。画素は設定に入れない）。 */
export type DevelopMaskSurface = { id: string; width: number; height: number };

export const DEVELOP_MASK_HSL_BANDS = ["red", "orange", "yellow", "green", "aqua", "blue", "purple", "magenta"] as const;
export type DevelopMaskHslBand = (typeof DEVELOP_MASK_HSL_BANDS)[number];
export type DevelopMaskHslDelta = { hue: number; saturation: number; luminance: number };
/** 帯ごとの HSL の差分（0 の帯は持たない）。 */
export type DevelopMaskHsl = Partial<Record<DevelopMaskHslBand, DevelopMaskHslDelta>>;

/** 局所の補正。値は全体への**差分**（範囲は全体の同じキーと同じ）。無い項目は 0。 */
export type DevelopMaskAdjust = {
  exposure?: number;
  contrast?: number;
  highlights?: number;
  shadows?: number;
  whites?: number;
  blacks?: number;
  texture?: number;
  clarity?: number;
  dehaze?: number;
  vibrance?: number;
  saturation?: number;
  relativeTemperature?: number;
  relativeTint?: number;
  hsl?: DevelopMaskHsl;
};
export type DevelopMaskAdjustKey = Exclude<keyof DevelopMaskAdjust, "hsl">;

type DevelopMaskCommon = { id: string; enabled: boolean; invert: boolean; adjust: DevelopMaskAdjust };
export type DevelopLinearMask = DevelopMaskCommon & { kind: "linear"; zero: DevelopMaskPoint; full: DevelopMaskPoint };
export type DevelopRadialMask = DevelopMaskCommon & {
  kind: "radial";
  center: DevelopMaskPoint;
  /** 楕円の半軸（`x` は幅・`y` は高さに対する割合）。 */
  radius: DevelopMaskPoint;
  /** 度。時計回り。 */
  angle: number;
  feather: number;
};
export type DevelopSurfaceMask = DevelopMaskCommon & { kind: "brush" | "subject" | "sky"; surface: DevelopMaskSurface };
export type DevelopMask = DevelopLinearMask | DevelopRadialMask | DevelopSurfaceMask;

/** `adjust` の数値のキーと範囲（正規形の並び）。 */
export const DEVELOP_MASK_ADJUST_KEYS: readonly { key: DevelopMaskAdjustKey; min: number; max: number }[] = [
  { key: "exposure", min: -5, max: 5 },
  { key: "contrast", min: -100, max: 100 },
  { key: "highlights", min: -100, max: 100 },
  { key: "shadows", min: -100, max: 100 },
  { key: "whites", min: -100, max: 100 },
  { key: "blacks", min: -100, max: 100 },
  { key: "texture", min: -100, max: 100 },
  { key: "clarity", min: -100, max: 100 },
  { key: "dehaze", min: -100, max: 100 },
  { key: "vibrance", min: -100, max: 100 },
  { key: "saturation", min: -100, max: 100 },
  { key: "relativeTemperature", min: -100, max: 100 },
  { key: "relativeTint", min: -100, max: 100 },
];

const HSL_KEYS = ["hue", "saturation", "luminance"] as const;
const COMMON_KEYS: readonly string[] = ["id", "kind", "enabled", "invert", "adjust"];
const SHAPE_KEYS: Record<DevelopMaskKind, readonly string[]> = {
  linear: ["zero", "full"],
  radial: ["center", "radius", "angle", "feather"],
  brush: ["surface"],
  subject: ["surface"],
  sky: ["surface"],
};
const ID_PATTERN = /^[A-Za-z0-9_-]{1,64}$/u;
const SURFACE_ID_PATTERN = /^[0-9a-f]{64}$/u;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasKey(value: Record<string, unknown>, key: string): boolean {
  return Object.hasOwn(value, key);
}

function onlyKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  return Object.keys(value).every((key) => keys.includes(key));
}

function exactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  return Object.keys(value).length === keys.length && keys.every((key) => hasKey(value, key));
}

function finiteIn(value: unknown, min: number, max: number): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= min && value <= max;
}

function parsePoint(value: unknown, min: number, max: number): DevelopMaskPoint | null {
  if (!isRecord(value) || !exactKeys(value, ["x", "y"])) return null;
  return finiteIn(value.x, min, max) && finiteIn(value.y, min, max) ? { x: value.x, y: value.y } : null;
}

function parseHsl(value: unknown): DevelopMaskHsl | null {
  let entries: [unknown, unknown][];
  if (Array.isArray(value)) {
    if (value.length % 2 !== 0) return null;
    entries = [];
    for (let index = 0; index < value.length; index += 2) entries.push([value[index], value[index + 1]]);
  } else if (isRecord(value)) {
    entries = Object.entries(value);
  } else {
    return null;
  }
  const result: DevelopMaskHsl = {};
  const seen = new Set<string>();
  for (const [name, delta] of entries) {
    if (typeof name !== "string" || !DEVELOP_MASK_HSL_BANDS.includes(name as DevelopMaskHslBand) || seen.has(name)) return null;
    seen.add(name);
    if (!isRecord(delta) || !onlyKeys(delta, HSL_KEYS)) return null;
    const parsed: DevelopMaskHslDelta = { hue: 0, saturation: 0, luminance: 0 };
    for (const key of HSL_KEYS) {
      if (!hasKey(delta, key)) continue;
      const item = delta[key];
      if (!finiteIn(item, -100, 100)) return null;
      parsed[key] = item;
    }
    // 何も動かさない帯は無いのと同じ
    if (parsed.hue !== 0 || parsed.saturation !== 0 || parsed.luminance !== 0) result[name as DevelopMaskHslBand] = parsed;
  }
  return result;
}

function parseAdjust(value: unknown): DevelopMaskAdjust | null {
  if (!isRecord(value)) return null;
  const adjust: DevelopMaskAdjust = {};
  for (const [key, item] of Object.entries(value)) {
    if (key === "hsl") {
      const hsl = parseHsl(item);
      if (!hsl) return null;
      if (Object.keys(hsl).length > 0) adjust.hsl = hsl;
      continue;
    }
    const definition = DEVELOP_MASK_ADJUST_KEYS.find((candidate) => candidate.key === key);
    if (!definition || !finiteIn(item, definition.min, definition.max)) return null;
    if (item !== 0) adjust[definition.key] = item;
  }
  return adjust;
}

function parseMask(item: unknown): DevelopMask | null {
  if (!isRecord(item)) return null;
  const kind = item.kind;
  if (typeof kind !== "string" || !(DEVELOP_MASK_KINDS as readonly string[]).includes(kind)) return null;
  const shapeKeys = SHAPE_KEYS[kind as DevelopMaskKind];
  if (!onlyKeys(item, [...COMMON_KEYS, ...shapeKeys])) return null;
  if (!hasKey(item, "id") || !hasKey(item, "adjust") || !shapeKeys.every((key) => hasKey(item, key))) return null;
  if (typeof item.id !== "string" || !ID_PATTERN.test(item.id)) return null;
  if (hasKey(item, "enabled") && typeof item.enabled !== "boolean") return null;
  if (hasKey(item, "invert") && typeof item.invert !== "boolean") return null;
  const adjust = parseAdjust(item.adjust);
  if (!adjust) return null;
  const common = {
    id: item.id,
    enabled: hasKey(item, "enabled") ? (item.enabled as boolean) : true,
    invert: hasKey(item, "invert") ? (item.invert as boolean) : false,
    adjust,
  };
  if (kind === "linear") {
    const zero = parsePoint(item.zero, -1, 2);
    const full = parsePoint(item.full, -1, 2);
    if (!zero || !full) return null;
    // ユークリッド距離（生の x, y。Rust と同じ IEEE の演算だけ）
    if (Math.sqrt((full.x - zero.x) * (full.x - zero.x) + (full.y - zero.y) * (full.y - zero.y)) < MIN_DEVELOP_MASK_LINEAR_DISTANCE) {
      return null;
    }
    return { ...common, kind, zero, full };
  }
  if (kind === "radial") {
    const center = parsePoint(item.center, 0, 1);
    const radius = parsePoint(item.radius, 0.005, 1.5);
    if (!center || !radius || !finiteIn(item.angle, -180, 180) || !finiteIn(item.feather, 0, 100)) return null;
    return { ...common, kind, center, radius, angle: item.angle, feather: item.feather };
  }
  const surface = item.surface;
  if (!isRecord(surface) || !exactKeys(surface, ["id", "width", "height"])) return null;
  if (typeof surface.id !== "string" || !SURFACE_ID_PATTERN.test(surface.id)) return null;
  const { width, height } = surface;
  if (
    !finiteIn(width, 1, MAX_DEVELOP_MASK_SURFACE_SIDE) ||
    !Number.isInteger(width) ||
    !finiteIn(height, 1, MAX_DEVELOP_MASK_SURFACE_SIDE) ||
    !Number.isInteger(height)
  ) {
    return null;
  }
  return { ...common, kind: kind as "brush" | "subject" | "sky", surface: { id: surface.id, width, height } };
}

/**
 * `masks` の値を厳密に読む（違反が 1 つでもあれば null）。`whiteBalanceMode` が `absolute` のとき、相対の色温度 / 色かぶりの差分が
 * 0 でないマスクは読まない（crate の `localWhiteBalance`。マスクが無効でも同じ）。
 */
export function parseDevelopMasks(value: unknown, options: { whiteBalanceMode?: unknown } = {}): DevelopMask[] | null {
  if (!Array.isArray(value) || value.length > MAX_DEVELOP_MASKS) return null;
  const ids = new Set<string>();
  const masks: DevelopMask[] = [];
  for (const item of value) {
    const mask = parseMask(item);
    if (!mask || ids.has(mask.id)) return null;
    if (options.whiteBalanceMode === "absolute" && (mask.adjust.relativeTemperature !== undefined || mask.adjust.relativeTint !== undefined)) {
      return null;
    }
    ids.add(mask.id);
    masks.push(mask);
  }
  return masks;
}

function whiteBalanceModeOf(settings: Record<string, unknown>): unknown {
  return isRecord(settings.whiteBalance) ? settings.whiteBalance.mode : undefined;
}

/** `masks` が無い（`undefined`）か、厳密に読めるか。形の壊れたマスクがある設定は編集も描画もしない。 */
export function hasValidDevelopMasks(settings: unknown): boolean {
  if (!isRecord(settings) || settings.masks === undefined) return true;
  return parseDevelopMasks(settings.masks, { whiteBalanceMode: whiteBalanceModeOf(settings) }) !== null;
}

/** 設定のマスク（無い・読めないときは空）。 */
export function readDevelopMasks(settings: unknown): DevelopMask[] {
  if (!isRecord(settings) || settings.masks === undefined) return [];
  return parseDevelopMasks(settings.masks, { whiteBalanceMode: whiteBalanceModeOf(settings) }) ?? [];
}

/** マスクが 1 枚でもあるか（無効なマスクも数える。`v` を要求する）。 */
export function hasDevelopMasks(settings: unknown): boolean {
  return readDevelopMasks(settings).length > 0;
}

/** `adjust` が何も動かさないか（空、0 だけ、0 の帯だけ）。 */
export function isZeroDevelopMaskAdjust(adjust: DevelopMaskAdjust): boolean {
  if (DEVELOP_MASK_ADJUST_KEYS.some(({ key }) => (adjust[key] ?? 0) !== 0)) return false;
  return !Object.values(adjust.hsl ?? {}).some((delta) => delta !== undefined && HSL_KEYS.some((key) => delta[key] !== 0));
}

/** 画を変えるマスクか（有効で、`adjust` が何か動かす）。 */
export function isActiveDevelopMask(mask: DevelopMask): boolean {
  return mask.enabled && !isZeroDevelopMaskAdjust(mask.adjust);
}

/** 画を変えるマスクが 1 枚でもあるか（crate の `has_active_masks`）。 */
export function hasActiveDevelopMasks(settings: unknown): boolean {
  return readDevelopMasks(settings).some(isActiveDevelopMask);
}

function round6(value: number): number {
  const rounded = Math.round(value * 1e6) / 1e6;
  return rounded === 0 ? 0 : rounded;
}

function canonicalPoint(point: DevelopMaskPoint): DevelopMaskPoint {
  return { x: round6(point.x), y: round6(point.y) };
}

function canonicalAdjust(adjust: DevelopMaskAdjust): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  for (const { key } of DEVELOP_MASK_ADJUST_KEYS) {
    const value = adjust[key];
    if (value === undefined) continue;
    const rounded = round6(value);
    if (rounded !== 0) result[key] = rounded;
  }
  // 全体の `hsl` と同じ形（帯と値が交互の配列）。0 の帯・値は書かない
  const hsl: unknown[] = [];
  for (const band of DEVELOP_MASK_HSL_BANDS) {
    const delta = adjust.hsl?.[band];
    if (!delta) continue;
    const values: Record<string, number> = {};
    for (const key of HSL_KEYS) {
      const rounded = round6(delta[key]);
      if (rounded !== 0) values[key] = rounded;
    }
    if (Object.keys(values).length > 0) hsl.push(band, values);
  }
  if (hsl.length > 0) result.hsl = hsl;
  return result;
}

/** 1 枚の正規形（キー順は契約どおり）。 */
export function canonicalDevelopMask(mask: DevelopMask): Record<string, unknown> {
  const result: Record<string, unknown> = { id: mask.id, kind: mask.kind };
  if (!mask.enabled) result.enabled = false;
  if (mask.invert) result.invert = true;
  if (mask.kind === "linear") {
    result.zero = canonicalPoint(mask.zero);
    result.full = canonicalPoint(mask.full);
  } else if (mask.kind === "radial") {
    result.center = canonicalPoint(mask.center);
    result.radius = canonicalPoint(mask.radius);
    result.angle = round6(mask.angle);
    result.feather = round6(mask.feather);
  } else {
    result.surface = { id: mask.surface.id, width: mask.surface.width, height: mask.surface.height };
  }
  result.adjust = canonicalAdjust(mask.adjust);
  return result;
}

/**
 * 設定のマスクを置き換える（正規形で書く）。空の配列は `masks` を外す。形の版 `v` は {@link developSettingsVersion} で決め直す
 * （マスクが 1 枚でもあれば 5）。
 */
export function writeDevelopMasks(settings: DevelopSettings, masks: readonly DevelopMask[]): DevelopSettings {
  const { masks: _previous, ...rest } = settings;
  const next: Record<string, unknown> = masks.length > 0 ? { ...rest, masks: masks.map(canonicalDevelopMask) } : rest;
  return { ...next, v: developSettingsVersion(next), engine: settings.engine };
}
