import type { PhotoEditingSettings } from "./photo-editing-types";

import { SIGNED_RAW_DETAIL_ENGINES } from "./develop-engine/develop-detail-preview";

import {
  PHOTO_EDITING_COLOR_NOISE_DESCRIPTION,
  PHOTO_EDITING_COLOR_NOISE_LABEL,
  PHOTO_EDITING_LUMINANCE_NOISE_DESCRIPTION,
  PHOTO_EDITING_LUMINANCE_NOISE_LABEL,
  PHOTO_EDITING_SHARPEN_DESCRIPTION,
  PHOTO_EDITING_SHARPEN_DETAIL_DESCRIPTION,
  PHOTO_EDITING_SHARPEN_DETAIL_LABEL,
  PHOTO_EDITING_SHARPEN_LABEL,
  PHOTO_EDITING_SHARPEN_MASKING_DESCRIPTION,
  PHOTO_EDITING_SHARPEN_MASKING_LABEL,
  PHOTO_EDITING_SHARPEN_RADIUS_DESCRIPTION,
  PHOTO_EDITING_SHARPEN_RADIUS_LABEL,
} from "./photo-editing-copy";

/**
 * ディテール（シャープ・ノイズ軽減。Issue #32）の `developSettings.detail`（v6）の読み書き。
 *
 * 形は crate（`settings.rs`）と同じ exact object: `{ sharpening: { amount, radius, detail, masking }, luminanceNoiseReduction,
 * colorNoiseReduction? }`。範囲はシャープ 0〜150・半径 0.5〜3.0・ほか 0〜100。`colorNoiseReduction` は省略できる: 省略は
 * signed RAW の数式（niho-3/4/5/7/11）で旧 top-level の `colorNoiseReduction`（R209・50 で頭打ち）をそのまま描き、JPEG / PNG・旧 RAW では
 * 0。書いた値は 0 を含めて旧の値を上書きする。
 *
 * - 書き込みは 1 項目ずつ（範囲に収め、半径は 0.1 刻み、ほかは整数に丸める）。値が変わらなければ渡した設定をそのまま返す
 * - カラーノイズの軽減を旧の値（上の「省略」の値）と同じにしたら、明示の値を消して旧の経路に戻す（画素は同じ）
 * - すべてが既定（シャープ 0・半径 1・ディテール 25・マスク 0・ノイズ軽減 0・カラーの明示なし）に戻ったら `detail` ごと消す
 *   （形の版 `v` は書き込む側が内容から決め直すので、ディテールを使っていない写真は v6 にならない）
 */

export type PhotoEditingDetailKey =
  | "sharpenAmount"
  | "sharpenRadius"
  | "sharpenDetail"
  | "sharpenMasking"
  | "luminanceNoiseReduction"
  | "colorNoiseReduction";

/** ディテールの項目の並び（Lightroom のディテールと同じ: シャープ → 半径 → ディテール → マスク → ノイズ軽減 → カラー）。 */
export const PHOTO_EDITING_DETAIL_KEYS: ReadonlyArray<PhotoEditingDetailKey> = [
  "sharpenAmount",
  "sharpenRadius",
  "sharpenDetail",
  "sharpenMasking",
  "luminanceNoiseReduction",
  "colorNoiseReduction",
];

export type PhotoEditingDetailSliderDefinition = {
  key: PhotoEditingDetailKey;
  label: string;
  min: number;
  max: number;
  step: number;
  /** ダブルクリックで戻す既定値 */
  defaultValue: number;
  /** 群の ⓘ に出す 1 行 */
  description: string;
};

const SHARPENING_DEFAULTS = { amount: 0, radius: 1, detail: 25, masking: 0 } as const;

export const PHOTO_EDITING_DETAIL_SLIDERS: ReadonlyArray<PhotoEditingDetailSliderDefinition> = [
  {
    key: "sharpenAmount",
    label: PHOTO_EDITING_SHARPEN_LABEL,
    min: 0,
    max: 150,
    step: 1,
    defaultValue: SHARPENING_DEFAULTS.amount,
    description: PHOTO_EDITING_SHARPEN_DESCRIPTION,
  },
  {
    key: "sharpenRadius",
    label: PHOTO_EDITING_SHARPEN_RADIUS_LABEL,
    min: 0.5,
    max: 3,
    step: 0.1,
    defaultValue: SHARPENING_DEFAULTS.radius,
    description: PHOTO_EDITING_SHARPEN_RADIUS_DESCRIPTION,
  },
  {
    key: "sharpenDetail",
    label: PHOTO_EDITING_SHARPEN_DETAIL_LABEL,
    min: 0,
    max: 100,
    step: 1,
    defaultValue: SHARPENING_DEFAULTS.detail,
    description: PHOTO_EDITING_SHARPEN_DETAIL_DESCRIPTION,
  },
  {
    key: "sharpenMasking",
    label: PHOTO_EDITING_SHARPEN_MASKING_LABEL,
    min: 0,
    max: 100,
    step: 1,
    defaultValue: SHARPENING_DEFAULTS.masking,
    description: PHOTO_EDITING_SHARPEN_MASKING_DESCRIPTION,
  },
  {
    key: "luminanceNoiseReduction",
    label: PHOTO_EDITING_LUMINANCE_NOISE_LABEL,
    min: 0,
    max: 100,
    step: 1,
    defaultValue: 0,
    description: PHOTO_EDITING_LUMINANCE_NOISE_DESCRIPTION,
  },
  {
    key: "colorNoiseReduction",
    label: PHOTO_EDITING_COLOR_NOISE_LABEL,
    min: 0,
    max: 100,
    step: 1,
    defaultValue: 0,
    description: PHOTO_EDITING_COLOR_NOISE_DESCRIPTION,
  },
];

const DETAIL_SLIDERS = new Map<PhotoEditingDetailKey, PhotoEditingDetailSliderDefinition>(
  PHOTO_EDITING_DETAIL_SLIDERS.map((definition) => [definition.key, definition]),
);

/** シャープの量が 0 の間は効かない項目（行は出したまま押せなくする）。 */
const SHARPENING_COMPANION_KEYS: ReadonlySet<PhotoEditingDetailKey> = new Set<PhotoEditingDetailKey>([
  "sharpenRadius",
  "sharpenDetail",
  "sharpenMasking",
]);

/** 旧の値は R209 の経路で 50 まで効く。 */
const LEGACY_RAW_COLOR_NOISE_MAX = 50;

type DetailValue = {
  sharpening: { amount: number; radius: number; detail: number; masking: number };
  luminanceNoiseReduction: number;
  colorNoiseReduction?: number;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function finiteOr(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

function readDetail(settings: PhotoEditingSettings): DetailValue {
  const detail = isRecord(settings.detail) ? settings.detail : {};
  const sharpening = isRecord(detail.sharpening) ? detail.sharpening : {};
  const value: DetailValue = {
    sharpening: {
      amount: finiteOr(sharpening.amount, SHARPENING_DEFAULTS.amount),
      radius: finiteOr(sharpening.radius, SHARPENING_DEFAULTS.radius),
      detail: finiteOr(sharpening.detail, SHARPENING_DEFAULTS.detail),
      masking: finiteOr(sharpening.masking, SHARPENING_DEFAULTS.masking),
    },
    luminanceNoiseReduction: finiteOr(detail.luminanceNoiseReduction, 0),
  };
  if (typeof detail.colorNoiseReduction === "number" && Number.isFinite(detail.colorNoiseReduction)) {
    value.colorNoiseReduction = detail.colorNoiseReduction;
  }
  return value;
}

/** `detail` に明示の値が無いときに描くカラーノイズの軽減（signed RAW は旧の値・50 で頭打ち、ほかは 0）。 */
function inheritedColorNoiseReduction(settings: PhotoEditingSettings): number {
  if (typeof settings.engine !== "string" || !SIGNED_RAW_DETAIL_ENGINES.has(settings.engine)) return 0;
  return Math.min(Math.max(finiteOr(settings.colorNoiseReduction, 0), 0), LEGACY_RAW_COLOR_NOISE_MAX);
}

export function readDetailValue(settings: PhotoEditingSettings, key: PhotoEditingDetailKey): number {
  const detail = readDetail(settings);
  switch (key) {
    case "sharpenAmount":
      return detail.sharpening.amount;
    case "sharpenRadius":
      return detail.sharpening.radius;
    case "sharpenDetail":
      return detail.sharpening.detail;
    case "sharpenMasking":
      return detail.sharpening.masking;
    case "luminanceNoiseReduction":
      return detail.luminanceNoiseReduction;
    case "colorNoiseReduction":
      return detail.colorNoiseReduction ?? inheritedColorNoiseReduction(settings);
  }
}

/** 今の値では効かない項目か（シャープが 0 の間の半径・ディテール・マスク）。 */
export function isInertDetailControl(settings: PhotoEditingSettings, key: PhotoEditingDetailKey): boolean {
  return SHARPENING_COMPANION_KEYS.has(key) && readDetailValue(settings, "sharpenAmount") === 0;
}

function roundToDefinition(definition: PhotoEditingDetailSliderDefinition, value: number): number {
  const clamped = Math.min(definition.max, Math.max(definition.min, value));
  const rounded = definition.step < 1 ? Math.round(clamped * 10) / 10 : Math.round(clamped);
  // -0 を 0 にそろえる
  return rounded === 0 ? 0 : rounded;
}

function isDefaultDetail(detail: DetailValue): boolean {
  const { sharpening } = detail;
  return (
    sharpening.amount === SHARPENING_DEFAULTS.amount &&
    sharpening.radius === SHARPENING_DEFAULTS.radius &&
    sharpening.detail === SHARPENING_DEFAULTS.detail &&
    sharpening.masking === SHARPENING_DEFAULTS.masking &&
    detail.luminanceNoiseReduction === 0 &&
    detail.colorNoiseReduction === undefined
  );
}

/**
 * ディテールの 1 項目だけを書き換えた新しい settings を返す（ほかのキーは変えない）。値が変わらなければ、渡した settings をそのまま
 * 返す。
 */
export function writeDetailValue(
  settings: PhotoEditingSettings,
  key: PhotoEditingDetailKey,
  value: number,
): PhotoEditingSettings {
  const definition = DETAIL_SLIDERS.get(key);
  if (!definition || !Number.isFinite(value)) return settings;
  const next = roundToDefinition(definition, value);
  if (readDetailValue(settings, key) === next) return settings;
  const current = readDetail(settings);
  const detail: DetailValue = { ...current, sharpening: { ...current.sharpening } };
  switch (key) {
    case "sharpenAmount":
      detail.sharpening.amount = next;
      break;
    case "sharpenRadius":
      detail.sharpening.radius = next;
      break;
    case "sharpenDetail":
      detail.sharpening.detail = next;
      break;
    case "sharpenMasking":
      detail.sharpening.masking = next;
      break;
    case "luminanceNoiseReduction":
      detail.luminanceNoiseReduction = next;
      break;
    case "colorNoiseReduction":
      // 旧の値と同じなら明示を消して旧の経路で描く（signed RAW の R209 と同じ画素）
      if (next === inheritedColorNoiseReduction(settings)) delete detail.colorNoiseReduction;
      else detail.colorNoiseReduction = next;
      break;
  }
  if (isDefaultDetail(detail)) {
    const without = { ...settings };
    delete without.detail;
    return without;
  }
  return { ...settings, detail };
}

/** 値の表示（半径は小数 1 桁、ほかは整数）。 */
export function formatDetailValue(key: PhotoEditingDetailKey, value: number): string {
  return key === "sharpenRadius" ? value.toFixed(1) : String(Math.round(value));
}

/** ディテールのスライダーの定義（無ければ undefined）。 */
export function detailSliderDefinition(key: PhotoEditingDetailKey): PhotoEditingDetailSliderDefinition | undefined {
  return DETAIL_SLIDERS.get(key);
}
