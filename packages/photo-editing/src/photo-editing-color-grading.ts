import type { PhotoEditingSettings } from "./photo-editing-types";

/**
 * カラーグレーディング（niho-photo#39。Lightroom のカラーの群の「カラーグレーディング」）の `developSettings` の読み書き（純関数）と、
 * 色相環に塗る色。
 *
 * 設定の形は crate（`settings.rs` の `colorGrading`）と同じで、Lightroom のプリセット（XMP）のカラーグレーディングも crate がこの形に
 * 入れる: `{ shadow | midtone | highlight | global: { hue 0〜359, saturation 0〜100, luminance -100〜100 }, blending 0〜100,
 * balance -100〜100 }`。無いゾーン・無い値は 0、無い `blending` は 100（crate の既定）、無い `balance` は 0。
 *
 * - 読む: 有限の数だけを範囲に収めて見せる（色相は 0〜359 に回して収める。範囲外・数でない値は表示のために収める・既定にする
 *   だけで、書き戻しはしない）
 * - 書く: 直したゾーンの 1 つだけを `{ hue, saturation, luminance }` にして置き換え（ほかのゾーン・知らないキーはそのまま持つ）、
 *   色相は整数の 0〜359 に回して書く。全部が既定（4 ゾーンの 3 つの値が 0・`blending` 100・`balance` 0）になったら
 *   `colorGrading` ごと消す（何も当てていない形にそろえる。色相も 0 でなければ残す: 彩度 0 のまま色相だけ選んだ途中の値を消さない）。
 *   見せている値が変わらない書き込みは、渡した設定をそのまま返す
 * - 中間調・全体の輝度は、エンジン（0.19.0〜）の近似式で描く（Lightroom の実測による校正は未実施。crate の `color_ops.rs`）
 */

export type PhotoEditingColorGradingZone = "shadow" | "midtone" | "highlight" | "global";

/** 4 択の並び（シャドウ → 中間調 → ハイライト → 全体）。 */
export const PHOTO_EDITING_COLOR_GRADING_ZONES: ReadonlyArray<PhotoEditingColorGradingZone> = [
  "shadow",
  "midtone",
  "highlight",
  "global",
];

export type PhotoEditingColorGradingAxis = "hue" | "saturation" | "luminance";
export type PhotoEditingColorGradingBand = Record<PhotoEditingColorGradingAxis, number>;
export type PhotoEditingColorGradingScalar = "blending" | "balance";

export type PhotoEditingColorGradingValues = Record<PhotoEditingColorGradingZone, PhotoEditingColorGradingBand> & {
  blending: number;
  balance: number;
};

/** 値の範囲（crate の `validate` の範囲。Lightroom と同じ整数の目盛り）。 */
export const PHOTO_EDITING_COLOR_GRADING_RANGES: Readonly<
  Record<PhotoEditingColorGradingAxis | PhotoEditingColorGradingScalar, { min: number; max: number }>
> = {
  hue: { min: 0, max: 359 },
  saturation: { min: 0, max: 100 },
  luminance: { min: -100, max: 100 },
  blending: { min: 0, max: 100 },
  balance: { min: -100, max: 100 },
};

/** `blending` の既定（crate の `ColorGradingSettings::default`。無いのと 100 は同じ）。 */
export const PHOTO_EDITING_COLOR_GRADING_DEFAULT_BLENDING = 100;

const ZONE_NAMES: ReadonlySet<string> = new Set(PHOTO_EDITING_COLOR_GRADING_ZONES);
const BAND_KEYS: ReadonlySet<string> = new Set(["hue", "saturation", "luminance"]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function clamp(value: number, min: number, max: number): number {
  const clamped = Math.min(max, Math.max(min, value));
  return clamped === 0 ? 0 : clamped;
}

/** 色相を 0 以上 360 未満に回す（-0 は 0）。 */
function wrapHue(value: number): number {
  const wrapped = ((value % 360) + 360) % 360;
  return wrapped === 0 ? 0 : wrapped;
}

/** 見せる値: 有限の数を範囲に収める（色相は 0〜359 に回して収める）。数でなければ `fallback`。 */
function displayValue(value: unknown, key: PhotoEditingColorGradingAxis | PhotoEditingColorGradingScalar, fallback = 0): number {
  if (typeof value !== "number" || !Number.isFinite(value)) return fallback;
  const range = PHOTO_EDITING_COLOR_GRADING_RANGES[key];
  return clamp(key === "hue" ? wrapHue(value) : value, range.min, range.max);
}

/** 書く値（範囲に収め、色相は整数に丸めて 0〜359 に回す）。有限の数でなければ null。 */
function writableValue(value: number, key: PhotoEditingColorGradingAxis | PhotoEditingColorGradingScalar): number | null {
  if (!Number.isFinite(value)) return null;
  if (key === "hue") return wrapHue(Math.round(value));
  const range = PHOTO_EDITING_COLOR_GRADING_RANGES[key];
  return clamp(value, range.min, range.max);
}

function rawColorGrading(settings: PhotoEditingSettings): Record<string, unknown> {
  return isRecord(settings.colorGrading) ? settings.colorGrading : {};
}

function readBand(value: unknown): PhotoEditingColorGradingBand {
  const record = isRecord(value) ? value : {};
  return {
    hue: displayValue(record.hue, "hue"),
    saturation: displayValue(record.saturation, "saturation"),
    luminance: displayValue(record.luminance, "luminance"),
  };
}

/** 4 ゾーン × 3 の値とブレンド・バランスを、右パネルに見せる形（範囲に収め、無い値は既定）で読む。 */
export function readPhotoEditingColorGrading(settings: PhotoEditingSettings): PhotoEditingColorGradingValues {
  const raw = rawColorGrading(settings);
  return {
    shadow: readBand(raw.shadow),
    midtone: readBand(raw.midtone),
    highlight: readBand(raw.highlight),
    global: readBand(raw.global),
    blending: displayValue(raw.blending, "blending", PHOTO_EDITING_COLOR_GRADING_DEFAULT_BLENDING),
    balance: displayValue(raw.balance, "balance"),
  };
}

/** そのゾーンに既定でない値（色相・彩度・輝度のどれかが 0 でない）があるか（4 択の「調整あり」の印）。 */
export function hasPhotoEditingColorGradingZoneEdits(
  values: PhotoEditingColorGradingValues,
  zone: PhotoEditingColorGradingZone,
): boolean {
  const band = values[zone];
  return band.hue !== 0 || band.saturation !== 0 || band.luminance !== 0;
}

/** どれかの値が既定でないか（カラーグレーディングの「初期化」を押せるか・スマホの道具の点）。 */
export function hasPhotoEditingColorGradingEdits(settings: PhotoEditingSettings): boolean {
  const values = readPhotoEditingColorGrading(settings);
  return (
    PHOTO_EDITING_COLOR_GRADING_ZONES.some((zone) => hasPhotoEditingColorGradingZoneEdits(values, zone)) ||
    values.blending !== PHOTO_EDITING_COLOR_GRADING_DEFAULT_BLENDING ||
    values.balance !== 0
  );
}

function without(settings: PhotoEditingSettings, key: string): PhotoEditingSettings {
  const next = { ...settings };
  delete next[key];
  return next;
}

/**
 * `colorGrading` の中身が、消しても画を変えない既定だけか（知っているキーだけで、ゾーンは 3 つの値がどれも 0〔欠けた値は 0〕、
 * `blending` は 100、`balance` は 0）。数でない値・知らないキーがあれば、既定に見えても消さずに残す。
 */
function isDefaultRaw(raw: Record<string, unknown>): boolean {
  return Object.entries(raw).every(([key, value]) => {
    if (ZONE_NAMES.has(key)) {
      return isRecord(value) && Object.entries(value).every(([axis, item]) => BAND_KEYS.has(axis) && item === 0);
    }
    if (key === "blending") return value === PHOTO_EDITING_COLOR_GRADING_DEFAULT_BLENDING;
    if (key === "balance") return value === 0;
    return false;
  });
}

function withColorGrading(settings: PhotoEditingSettings, raw: Record<string, unknown>): PhotoEditingSettings {
  return isDefaultRaw(raw) ? without(settings, "colorGrading") : { ...settings, colorGrading: raw };
}

/**
 * 1 つのゾーンの値（色相・彩度・輝度のうち `patch` に渡したもの。色相環は色相と彩度を一度に）を書き換えた新しい settings を返す。
 * 直したゾーンは見せている値に新しい値を重ねた `{ hue, saturation, luminance }` にし、ほかのゾーン・ブレンド・バランス・知らない
 * キーはそのまま持つ。全部が既定になれば `colorGrading` ごと消す。見せている値が変わらなければ（有限の数でない値も）、渡した
 * settings をそのまま返す。
 */
export function writePhotoEditingColorGradingZone(
  settings: PhotoEditingSettings,
  zone: PhotoEditingColorGradingZone,
  patch: Partial<PhotoEditingColorGradingBand>,
): PhotoEditingSettings {
  const raw = rawColorGrading(settings);
  const current = readBand(raw[zone]);
  const next: PhotoEditingColorGradingBand = { ...current };
  for (const axis of ["hue", "saturation", "luminance"] as const) {
    const value = patch[axis];
    if (value === undefined) continue;
    const writable = writableValue(value, axis);
    if (writable !== null) next[axis] = writable;
  }
  if (next.hue === current.hue && next.saturation === current.saturation && next.luminance === current.luminance) {
    return settings;
  }
  return withColorGrading(settings, { ...raw, [zone]: next });
}

/** ブレンド・バランスを書き換えた新しい settings を返す（規則は {@link writePhotoEditingColorGradingZone} と同じ）。 */
export function writePhotoEditingColorGradingScalar(
  settings: PhotoEditingSettings,
  key: PhotoEditingColorGradingScalar,
  value: number,
): PhotoEditingSettings {
  const next = writableValue(value, key);
  if (next === null) return settings;
  const raw = rawColorGrading(settings);
  if (readPhotoEditingColorGrading(settings)[key] === next) return settings;
  return withColorGrading(settings, { ...raw, [key]: next });
}

/** カラーグレーディングの「初期化」: 全部を既定に戻す（`colorGrading` ごと消す）。どれも既定に見えるなら、渡した settings のまま。 */
export function resetPhotoEditingColorGrading(settings: PhotoEditingSettings): PhotoEditingSettings {
  return hasPhotoEditingColorGradingEdits(settings) ? without(settings, "colorGrading") : settings;
}

// MARK: - 色相環の色

/**
 * エンジンが色相 `hue` で乗せる色の向き（crate `color_ops.rs` の `grade_direction` の移植）: 色相を ProPhoto の原色で HSV の
 * 色にし、輝度（`color.rs` の `PP_LUMA`）を引いて長さ 1 にした、linear ProPhoto の向き。
 */
const PP_LUMA = [0.2880402, 0.7118741, 0.0000857] as const;

function gradeDirection(hue: number): [number, number, number] {
  const h = wrapHue(hue) / 60;
  const sector = Math.floor(h);
  const f = h - sector;
  const c: [number, number, number] =
    sector === 0
      ? [1, f, 0]
      : sector === 1
        ? [1 - f, 1, 0]
        : sector === 2
          ? [0, 1, f]
          : sector === 3
            ? [0, 1 - f, 1]
            : sector === 4
              ? [f, 0, 1]
              : [1, 0, 1 - f];
  const y = PP_LUMA[0] * c[0] + PP_LUMA[1] * c[1] + PP_LUMA[2] * c[2];
  const d = [c[0] - y, c[1] - y, c[2] - y];
  const n = Math.hypot(d[0], d[1], d[2]);
  return [d[0] / n, d[1] / n, d[2] / n];
}

/**
 * linear ProPhoto → linear sRGB（crate `color.rs` の `PROPHOTO_TO_SRGB` = `XYZ_D50_TO_SRGB × PROPHOTO_TO_XYZ_D50` を倍精度で
 * 計算した値。白は白へ写る）。
 */
const PROPHOTO_TO_SRGB = [
  [2.034030207314434, -0.727352088023402, -0.30689333106725136],
  [-0.22884378779137693, 1.2317303061295068, -0.0027953558869515463],
  [-0.00847540692778033, -0.15332701120522316, 1.1615141385778711],
] as const;

function srgbEncode(linear: number): number {
  const v = Math.min(1, Math.max(0, linear));
  return v <= 0.0031308 ? 12.92 * v : 1.055 * v ** (1 / 2.4) - 0.055;
}

/**
 * 色相 `hue` の環の色（sRGB の 0〜255）。エンジンが灰色に乗せる色の向き（{@link gradeDirection}）を linear sRGB に写し、その向きの
 * いちばん鮮やかな色（どれかのチャンネルが 0、どれかが 1。HSV の彩度・明度 1 と同じ）にする。色相の角度は Lightroom と同じ
 * （0 赤・60 黄・120 緑・180 シアン・240 青・300 マゼンタ。ただし ProPhoto の原色なので sRGB の HSL の同じ角度の色とはずれる）。
 */
export function photoEditingColorGradingHueRgb(hue: number): [number, number, number] {
  const d = gradeDirection(hue);
  const e = PROPHOTO_TO_SRGB.map((row) => row[0] * d[0] + row[1] * d[1] + row[2] * d[2]);
  const low = Math.min(...e);
  const high = Math.max(...e);
  const span = high - low;
  return e.map((value) => Math.round(srgbEncode(span > 0 ? (value - low) / span : 1) * 255)) as [number, number, number];
}

/** {@link photoEditingColorGradingHueRgb} の CSS の色。 */
export function photoEditingColorGradingHueColor(hue: number): string {
  const [r, g, b] = photoEditingColorGradingHueRgb(hue);
  return `rgb(${r} ${g} ${b})`;
}

/**
 * 色相 `hue`・彩度 `saturation`（0〜100）の色（つまみの塗り。環の中心の白から縁の {@link photoEditingColorGradingHueRgb} へ、環と
 * 同じく sRGB の値で混ぜる）。
 */
export function photoEditingColorGradingSwatchColor(hue: number, saturation: number): string {
  const t = Math.min(1, Math.max(0, saturation / 100));
  const [r, g, b] = photoEditingColorGradingHueRgb(hue).map((value) => Math.round(255 + (value - 255) * t));
  return `rgb(${r} ${g} ${b})`;
}
