import type { PhotoEditingSettings } from "./photo-editing-types";

/**
 * カラーミキサー（HSL。niho-photo#38。Lightroom のカラーミキサーの「HSL」）の `developSettings` の読み書き（純関数）。
 *
 * 設定の形は crate（`settings.rs` の `hsl`）と同じ: 8 色（red / orange / yellow / green / aqua / blue / purple / magenta）ごとに
 * `{ hue, saturation, luminance }`（各 -100〜100、無い色・無い値は 0）。crate は Photo Bench の JSON の形（色の名前と値を交互に並べた
 * 配列 `["blue", { ... }, ...]`）で書き、`{ "blue": { ... } }` の形も読む。Lightroom のプリセット（XMP）の HSL も、crate が同じ形で入れる。
 *
 * - 読む: 交互の配列とオブジェクトのどちらも読む。同じ色が 2 つあれば先の 1 つ（crate は重なった色を拒む）。値は有限の数だけを
 *   -100〜100 に収めて見せ（範囲外・数でない値は表示のために収める・0 にするだけで、書き戻しはしない）、欠けた色・値は 0
 * - 書く: 直した色の 1 つだけを `{ hue, saturation, luminance }` にして置き換え、出力は crate の出力と同じ交互の配列（色の順）にそろえる。
 *   触っていない色の値（範囲外の値・知らないキーも）と知らない色の名前はそのまま持つ。3 つとも 0 になった色は消し（crate の XMP の
 *   読み方と同じ）、どの色にも調整が残らなければ `hsl` ごと消す（何も当てていない形にそろえる）。見せている値が変わらない書き込みは、
 *   渡した設定をそのまま返す
 * - 値の意味はエンジン（`engine` の数式の版）が決める。画面は ±100 の値を書くだけで、色相ずれの改善（Oklch で色相を保つ式）が入っても
 *   同じ値・同じ画面のまま使える
 */

export type PhotoEditingHslBand = "red" | "orange" | "yellow" | "green" | "aqua" | "blue" | "purple" | "magenta";

/** 8 色の並び（crate の `HslBand::ALL`・Lightroom と同じ順）。 */
export const PHOTO_EDITING_HSL_BANDS: ReadonlyArray<PhotoEditingHslBand> = [
  "red",
  "orange",
  "yellow",
  "green",
  "aqua",
  "blue",
  "purple",
  "magenta",
];

export type PhotoEditingHslAxis = "hue" | "saturation" | "luminance";

/** 「調整」の切り替えの並び（色相 → 彩度 → 輝度）。 */
export const PHOTO_EDITING_HSL_AXES: ReadonlyArray<PhotoEditingHslAxis> = ["hue", "saturation", "luminance"];

/** 1 つの値の範囲と刻み（crate の `validate` の範囲。Lightroom と同じ整数の目盛り）。 */
export const PHOTO_EDITING_HSL_MIN = -100;
export const PHOTO_EDITING_HSL_MAX = 100;
export const PHOTO_EDITING_HSL_STEP = 1;

export type PhotoEditingHslAdjustment = Record<PhotoEditingHslAxis, number>;
export type PhotoEditingHslValues = Record<PhotoEditingHslBand, PhotoEditingHslAdjustment>;

const BAND_NAMES: ReadonlySet<string> = new Set(PHOTO_EDITING_HSL_BANDS);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isBand(value: unknown): value is PhotoEditingHslBand {
  return typeof value === "string" && BAND_NAMES.has(value);
}

/** 見せる値: 有限の数を -100〜100 に収める（-0 は 0）。数でなければ 0。 */
function displayValue(value: unknown): number {
  if (typeof value !== "number" || !Number.isFinite(value)) return 0;
  const clamped = Math.min(PHOTO_EDITING_HSL_MAX, Math.max(PHOTO_EDITING_HSL_MIN, value));
  return clamped === 0 ? 0 : clamped;
}

type HslEntry = { name: unknown; value: unknown };

/**
 * `hsl` の中身を、書いた順の (色の名前, 値) の並びにする。交互の配列（余った最後の 1 つは数えない）とオブジェクトを読み、どちらでも
 * なければ空。
 */
function hslEntries(raw: unknown): HslEntry[] {
  if (Array.isArray(raw)) {
    const entries: HslEntry[] = [];
    for (let index = 0; index + 1 < raw.length; index += 2) entries.push({ name: raw[index], value: raw[index + 1] });
    return entries;
  }
  if (isRecord(raw)) return Object.entries(raw).map(([name, value]) => ({ name, value }));
  return [];
}

/** その色の先の 1 つの値（無ければ undefined）。 */
function bandValue(entries: ReadonlyArray<HslEntry>, band: PhotoEditingHslBand): unknown {
  return entries.find((entry) => entry.name === band)?.value;
}

function readAdjustment(value: unknown): PhotoEditingHslAdjustment {
  const record = isRecord(value) ? value : {};
  return {
    hue: displayValue(record.hue),
    saturation: displayValue(record.saturation),
    luminance: displayValue(record.luminance),
  };
}

function isZeroAdjustment(adjustment: PhotoEditingHslAdjustment): boolean {
  return adjustment.hue === 0 && adjustment.saturation === 0 && adjustment.luminance === 0;
}

/** 8 色 × 3 の値を、右パネルに見せる形（各 -100〜100。無い色・値は 0）で読む。 */
export function readPhotoEditingHsl(settings: PhotoEditingSettings): PhotoEditingHslValues {
  const entries = hslEntries(settings.hsl);
  const values = {} as PhotoEditingHslValues;
  for (const band of PHOTO_EDITING_HSL_BANDS) values[band] = readAdjustment(bandValue(entries, band));
  return values;
}

/** どれかの色のその軸に、0 でない値があるか（「調整」の切り替えの「入っている」の印）。 */
export function hasPhotoEditingHslAxisEdits(values: PhotoEditingHslValues, axis: PhotoEditingHslAxis): boolean {
  return PHOTO_EDITING_HSL_BANDS.some((band) => values[band][axis] !== 0);
}

/** 24 の値のどれかが 0 でないか（カラーミキサーの「初期化」を押せるか）。 */
export function hasPhotoEditingHslEdits(settings: PhotoEditingSettings): boolean {
  const values = readPhotoEditingHsl(settings);
  return PHOTO_EDITING_HSL_AXES.some((axis) => hasPhotoEditingHslAxisEdits(values, axis));
}

function without(settings: PhotoEditingSettings, key: string): PhotoEditingSettings {
  const next = { ...settings };
  delete next[key];
  return next;
}

/** 書く値（-100〜100 に収め、-0 は 0）。有限の数でなければ null。 */
function writableValue(value: number): number | null {
  if (!Number.isFinite(value)) return null;
  const clamped = Math.min(PHOTO_EDITING_HSL_MAX, Math.max(PHOTO_EDITING_HSL_MIN, value));
  return clamped === 0 ? 0 : clamped;
}

/**
 * 1 色の 1 つの軸（色相・彩度・輝度）を書き換えた新しい settings を返す。直した色は見せている値に新しい値を重ねた
 * `{ hue, saturation, luminance }` にし、3 つとも 0 なら消す。ほかの色（2 つ目の同じ色は除く）と知らない色の名前はそのまま持ち、
 * 出力は crate と同じ交互の配列（知っている色は色の順、知らない名前はその後ろに書いた順）。何の調整も残らなければ `hsl` ごと消す。
 * 見せている値が変わらなければ（有限の数でない値も）、渡した settings をそのまま返す。
 */
export function writePhotoEditingHsl(
  settings: PhotoEditingSettings,
  band: PhotoEditingHslBand,
  axis: PhotoEditingHslAxis,
  value: number,
): PhotoEditingSettings {
  const next = writableValue(value);
  if (next === null) return settings;
  const entries = hslEntries(settings.hsl);
  const current = readAdjustment(bandValue(entries, band));
  if (current[axis] === next) return settings;
  const adjustment: PhotoEditingHslAdjustment = { ...current, [axis]: next };

  const known = new Map<PhotoEditingHslBand, unknown>();
  const unknown: HslEntry[] = [];
  for (const entry of entries) {
    if (!isBand(entry.name)) unknown.push(entry);
    else if (!known.has(entry.name)) known.set(entry.name, entry.value);
  }
  if (isZeroAdjustment(adjustment)) known.delete(band);
  else known.set(band, adjustment);

  // 何の調整も残らない（知らない名前が無く、残った色がどれも 0 だけ）なら、何も当てていない形（キーなし）
  if (unknown.length === 0 && [...known.values()].every(isZeroRaw)) return without(settings, "hsl");
  const hsl: unknown[] = [];
  for (const item of PHOTO_EDITING_HSL_BANDS) {
    if (known.has(item)) hsl.push(item, known.get(item));
  }
  for (const entry of unknown) hsl.push(entry.name, entry.value);
  return { ...settings, hsl };
}

/**
 * 色の値が、消しても画を変えない 0 だけか（3 つの軸のキーだけで、どれも 0。欠けた軸は 0）。数でない値・知らないキーを持つ色は、
 * 0 に見えても消さずに残す。
 */
function isZeroRaw(value: unknown): boolean {
  if (!isRecord(value)) return false;
  return Object.entries(value).every(
    ([key, item]) => (key === "hue" || key === "saturation" || key === "luminance") && item === 0,
  );
}

/** カラーミキサーの「初期化」: 24 の値をすべて 0 に戻す（`hsl` ごと消す）。どれも 0 に見えるなら、渡した settings のまま。 */
export function resetPhotoEditingHsl(settings: PhotoEditingSettings): PhotoEditingSettings {
  return hasPhotoEditingHslEdits(settings) ? without(settings, "hsl") : settings;
}
