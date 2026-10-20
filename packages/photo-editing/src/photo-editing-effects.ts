import type { PhotoEditingSettings } from "./photo-editing-types";

import {
  PHOTO_EDITING_GRAIN_LABEL,
  PHOTO_EDITING_GRAIN_SIZE_LABEL,
  PHOTO_EDITING_VIGNETTE_LABEL,
} from "./photo-editing-copy";

/**
 * 効果（白黒・周辺光量補正・粒子。NIHO Photo 段 1 E1 移行元設計 / E1b 移行元設計）の `developSettings` の読み書き。
 *
 * 設定の形は crate（`settings.rs`）と同じ: `grayscale: true`（無い・false は色つき）、`vignette: { amount, midpoint, roundness,
 * feather, highlights, style }`、`grain: { amount, size, roughness, seed? }`。項目は既定値と違うときだけ書き、読むときは無い項目を
 * 既定値で補う。画面が直すのは白黒の切り替え・周辺光量補正の量・粒子の量とサイズだけで、ほかの項目（`grayMixer`・`midpoint` など、
 * プリセットが入れた値）はそのまま持つ。
 *
 * - 白黒: オフにするときは `grayscale` のキーを消す（`grayMixer` は保つ）
 * - 周辺光量補正: 0 から動かしたら `amount` だけ書く。0 に戻したら、ほかの項目がすべて既定のとき `vignette` ごと消す（既定と違う
 *   項目が残っていれば `amount: 0` で保つ）
 * - 粒子: 量を 0 に戻したら、`size`・`roughness` が既定のとき `grain` ごと消す。サイズは既定（25）のとき書かない
 * - 値が変わらない書き込みは、渡した設定をそのまま返す（保存を無駄に起こさない）
 */

/** 効果のスライダーの項目（白黒は切り替えなので別）。 */
export type PhotoEditingEffectSliderKey = "vignetteAmount" | "grainAmount" | "grainSize";

/** 右パネルで効果の項目を呼ぶ名前（絞り込み `visibleKeys` に使う）。 */
export type PhotoEditingEffectKey = "grayscale" | PhotoEditingEffectSliderKey;

/** 効果の項目の並び（白黒はカラーの群の先頭、ほかは効果の群の後ろ）。粒子のサイズは PC だけなので別のキー。 */
export const PHOTO_EDITING_EFFECT_KEYS: ReadonlyArray<PhotoEditingEffectKey> = [
  "grayscale",
  "vignetteAmount",
  "grainAmount",
  "grainSize",
];

export type PhotoEditingEffectSliderDefinition = {
  key: PhotoEditingEffectSliderKey;
  label: string;
  min: number;
  max: number;
  step: number;
  /** ダブルクリックで戻す既定値 */
  defaultValue: number;
  /** 値を符号つき（「+20」）で見せるか */
  signed: boolean;
};

/** crate の `VignetteSettings::default()`。 */
const VIGNETTE_DEFAULTS: Readonly<Record<string, number | string>> = {
  amount: 0,
  midpoint: 50,
  roundness: 0,
  feather: 50,
  highlights: 0,
  style: "highlightPriority",
};

/** crate の `GrainSettings::default()`（`seed` は無いのが既定）。 */
const GRAIN_DEFAULT_SIZE = 25;
const GRAIN_DEFAULT_ROUGHNESS = 50;

/** 効果の群の並び: （テクスチャ・明瞭度・かすみの除去の後に）周辺光量補正 → 粒子 → 粒子のサイズ。 */
export const PHOTO_EDITING_EFFECT_SLIDERS: ReadonlyArray<PhotoEditingEffectSliderDefinition> = [
  { key: "vignetteAmount", label: PHOTO_EDITING_VIGNETTE_LABEL, min: -100, max: 100, step: 1, defaultValue: 0, signed: true },
  { key: "grainAmount", label: PHOTO_EDITING_GRAIN_LABEL, min: 0, max: 100, step: 1, defaultValue: 0, signed: false },
  {
    key: "grainSize",
    label: PHOTO_EDITING_GRAIN_SIZE_LABEL,
    min: 0,
    max: 100,
    step: 1,
    defaultValue: GRAIN_DEFAULT_SIZE,
    signed: false,
  },
];

const EFFECT_SLIDERS = new Map<PhotoEditingEffectSliderKey, PhotoEditingEffectSliderDefinition>(
  PHOTO_EDITING_EFFECT_SLIDERS.map((definition) => [definition.key, definition]),
);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function recordOf(value: unknown): Record<string, unknown> | null {
  return isRecord(value) ? value : null;
}

function finiteOr(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

function without(settings: PhotoEditingSettings, key: string): PhotoEditingSettings {
  const next = { ...settings };
  delete next[key];
  return next;
}

// ---------------------------------------------------------------------------
// 白黒

/** 白黒か（`grayscale: true` のときだけ。無い・false は色つき）。 */
export function readGrayscale(settings: PhotoEditingSettings): boolean {
  return settings.grayscale === true;
}

/** 白黒を切り替える。オフにするときは `grayscale` のキーを消す（`grayMixer`・彩度・HSL の値は保つ）。 */
export function writeGrayscale(settings: PhotoEditingSettings, grayscale: boolean): PhotoEditingSettings {
  if (readGrayscale(settings) === grayscale) return settings;
  return grayscale ? { ...settings, grayscale: true } : without(settings, "grayscale");
}

// ---------------------------------------------------------------------------
// 周辺光量補正・粒子

export function readEffectValue(settings: PhotoEditingSettings, key: PhotoEditingEffectSliderKey): number {
  if (key === "vignetteAmount") return finiteOr(recordOf(settings.vignette)?.amount, 0);
  const grain = recordOf(settings.grain);
  return key === "grainAmount" ? finiteOr(grain?.amount, 0) : finiteOr(grain?.size, GRAIN_DEFAULT_SIZE);
}

/** 周辺光量補正の `amount` 以外が、すべて既定（無い項目は既定）か。知らない項目があれば既定とみなさない。 */
function isVignetteShapeDefault(vignette: Record<string, unknown>): boolean {
  return Object.entries(vignette).every(
    ([key, value]) =>
      key === "amount" || value === undefined || (Object.hasOwn(VIGNETTE_DEFAULTS, key) && value === VIGNETTE_DEFAULTS[key]),
  );
}

function writeVignetteAmount(settings: PhotoEditingSettings, amount: number): PhotoEditingSettings {
  const next: Record<string, unknown> = { ...recordOf(settings.vignette), amount };
  return amount === 0 && isVignetteShapeDefault(next) ? without(settings, "vignette") : { ...settings, vignette: next };
}

function writeGrain(settings: PhotoEditingSettings, change: { amount?: number; size?: number }): PhotoEditingSettings {
  const next: Record<string, unknown> = { ...recordOf(settings.grain) };
  if (change.amount !== undefined) next.amount = change.amount;
  if (change.size !== undefined) {
    if (change.size === GRAIN_DEFAULT_SIZE) delete next.size;
    else next.size = change.size;
  }
  const amount = finiteOr(next.amount, 0);
  const hasUnknownValue = Object.keys(next).some((key) => !["amount", "size", "roughness"].includes(key));
  if (
    amount === 0 &&
    finiteOr(next.size, GRAIN_DEFAULT_SIZE) === GRAIN_DEFAULT_SIZE &&
    finiteOr(next.roughness, GRAIN_DEFAULT_ROUGHNESS) === GRAIN_DEFAULT_ROUGHNESS &&
    !hasUnknownValue
  ) {
    return without(settings, "grain");
  }
  // サイズ・粗さが既定と違う間は、量が 0 でも `amount: 0` を書いて持つ
  return { ...settings, grain: { ...next, amount } };
}

/**
 * 効果のスライダーの 1 項目だけを書き換えた新しい settings を返す（範囲に収めて整数に丸める。ほかのキーは変えない）。値が
 * 変わらなければ、渡した settings をそのまま返す。
 */
export function writeEffectValue(
  settings: PhotoEditingSettings,
  key: PhotoEditingEffectSliderKey,
  value: number,
): PhotoEditingSettings {
  const definition = EFFECT_SLIDERS.get(key);
  if (!definition || !Number.isFinite(value)) return settings;
  const rounded = Math.round(Math.min(definition.max, Math.max(definition.min, value)));
  // -0 を 0 にそろえる
  const next = rounded === 0 ? 0 : rounded;
  if (readEffectValue(settings, key) === next) return settings;
  if (key === "vignetteAmount") return writeVignetteAmount(settings, next);
  return writeGrain(settings, key === "grainAmount" ? { amount: next } : { size: next });
}

/** 符号なしの整数（粒子・粒子のサイズ）。 */
export function formatEffectUnsignedValue(value: number): string {
  return String(Math.round(value));
}

// ---------------------------------------------------------------------------
// 何も当てていないか

/**
 * `developSettings` の効果の項目が、画に効いていないか（crate の `DevelopSettings::is_neutral` と同じ規則）。効果の項目でなければ
 * null。白黒は false、周辺光量補正と粒子は量が 0（無ければ 0）なら効かない。`grayMixer` は白黒の間だけ使うので、それだけでは
 * 効かない。形の壊れた値は効いているものとして扱う（安全側）。
 */
export function isInactiveDevelopEffect(key: string, value: unknown): boolean | null {
  switch (key) {
    case "grayscale":
      return value === undefined || value === false;
    case "grayMixer":
      return (
        value === undefined ||
        (isRecord(value) && Object.values(value).every((item) => typeof item === "number" && Number.isFinite(item)))
      );
    case "vignette":
    case "grain":
      return value === undefined || (isRecord(value) && (value.amount === undefined || value.amount === 0));
    default:
      return null;
  }
}

/** `developSettings` に、古い読み口が補正を落とすと画が変わる有効な効果があるか。 */
export function hasActiveDevelopEffects(settings: Record<string, unknown>): boolean {
  return ["grayscale", "grayMixer", "vignette", "grain"].some(
    (key) => isInactiveDevelopEffect(key, settings[key]) === false,
  );
}
