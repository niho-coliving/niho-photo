import type {
  PhotoEditingPhoto,
  PhotoEditingSettings,
  PhotoEditingWhiteBalanceValue,
} from "./photo-editing-types";

import {
  PHOTO_EDITING_CLARITY_DESCRIPTION,
  PHOTO_EDITING_COLOR_GROUP_TITLE,
  PHOTO_EDITING_DEHAZE_DESCRIPTION,
  PHOTO_EDITING_EFFECTS_GROUP_TITLE,
  PHOTO_EDITING_EFFECTS_INFO_LABEL,
  PHOTO_EDITING_GRAIN_DESCRIPTION,
  PHOTO_EDITING_GRAYSCALE_LABEL,
  PHOTO_EDITING_LIGHT_GROUP_TITLE,
  PHOTO_EDITING_TEXTURE_DESCRIPTION,
  PHOTO_EDITING_VIGNETTE_DESCRIPTION,
} from "./photo-editing-copy";
import {
  PHOTO_EDITING_EFFECT_SLIDERS,
  type PhotoEditingEffectKey,
  type PhotoEditingEffectSliderDefinition,
  type PhotoEditingEffectSliderKey,
} from "./photo-editing-effects";

/**
 * 写真編集タブの基本補正（移行時の設計文書「Business rules」の調整項目と、
 * photo-edit-app の docs/ENGINE_PROTOCOL.md「編集設定（settings）」のキー）。
 *
 * settings は Photo Bench の `EditSettings` の JSON で、ページはここに書いたキーだけを書き換え、
 * 他のキー（トーンカーブ・HSL・カラーグレーディングなど、プリセットが入れた値）はそのまま返す。
 *
 * NIHO Desktop がクラウドの写真を段 2 の wasm で描くとき（移行元設計 S7b）は、settings は `developSettings`（v1 / v2 / v3 / v4）になる。項目名・
 * 単位は同じで、違うのはホワイトバランスだけ（Photo Bench の `whiteBalance.mode: "custom"` ⇔ developSettings の `"absolute"`、
 * 相対の色温度 / 色かぶり補正は developSettings では `whiteBalance.mode: "relative"` を伴う）。読み書きはここで両方の形を扱い、
 * 呼び出し側（スライダー）は形で分けない。
 */

/**
 * 段 2 の `developSettings` の形か（形の版 `v` が 1〜4 で、数式の版 `engine` を持つ。v2 は幾何、v3 は効果、v4 は色ポイント。移行元設計）。ほかは
 * Photo Bench の `EditSettings`。
 */
export function isDevelopSettingsForm(settings: PhotoEditingSettings): boolean {
  return (settings.v === 1 || settings.v === 2) && typeof settings.engine === "string";
}

export type PhotoEditingAdjustmentKey =
  | "exposure"
  | "contrast"
  | "highlights"
  | "shadows"
  | "whites"
  | "blacks"
  | "texture"
  | "clarity"
  | "dehaze"
  | "vibrance"
  | "saturation";

export type PhotoEditingAdjustmentDefinition = {
  key: PhotoEditingAdjustmentKey;
  label: string;
  min: number;
  max: number;
  step: number;
};

function balanced(key: PhotoEditingAdjustmentKey, label: string): PhotoEditingAdjustmentDefinition {
  return { key, label, min: -100, max: 100, step: 1 };
}

/** ライト（Lightroom のクラウド版・モバイルの「ライト」と同じ並び）。 */
export const PHOTO_EDITING_LIGHT_ADJUSTMENTS: ReadonlyArray<PhotoEditingAdjustmentDefinition> = [
  { key: "exposure", label: "露光量", min: -5, max: 5, step: 0.01 },
  balanced("contrast", "コントラスト"),
  balanced("highlights", "ハイライト"),
  balanced("shadows", "シャドウ"),
  balanced("whites", "白レベル"),
  balanced("blacks", "黒レベル"),
];

/** カラーのうち、色温度・色かぶり補正（白。絶対 / 相対は描く側）の後に並ぶ項目。 */
export const PHOTO_EDITING_COLOR_ADJUSTMENTS: ReadonlyArray<PhotoEditingAdjustmentDefinition> = [
  balanced("vibrance", "自然な彩度"),
  balanced("saturation", "彩度"),
];

/** 効果（Lightroom のクラウド版・モバイルの「効果」のうち、段 2 で描ける項目）。 */
export const PHOTO_EDITING_EFFECTS_ADJUSTMENTS: ReadonlyArray<PhotoEditingAdjustmentDefinition> = [
  balanced("texture", "テクスチャ"),
  balanced("clarity", "明瞭度"),
  balanced("dehaze", "かすみの除去"),
];

const ADJUSTMENT_DEFINITIONS = new Map<PhotoEditingAdjustmentKey, PhotoEditingAdjustmentDefinition>(
  [...PHOTO_EDITING_LIGHT_ADJUSTMENTS, ...PHOTO_EDITING_COLOR_ADJUSTMENTS, ...PHOTO_EDITING_EFFECTS_ADJUSTMENTS].map(
    (definition) => [definition.key, definition],
  ),
);

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function roundToStep(value: number, step: number): number {
  if (step >= 1) return Math.round(value);
  const decimals = Math.max(0, Math.ceil(-Math.log10(step)));
  const factor = 10 ** decimals;
  const rounded = Math.round(value * factor) / factor;
  // -0 を 0 にそろえる（表示が "-0.00" にならないように）
  return rounded === 0 ? 0 : rounded;
}

function readFinite(settings: PhotoEditingSettings, key: string): number {
  const value = settings[key];
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

export function readAdjustment(settings: PhotoEditingSettings, key: PhotoEditingAdjustmentKey): number {
  return readFinite(settings, key);
}

/** 1 項目だけを書き換えた新しい settings を返す（範囲と刻みにそろえる。他のキーは変えない）。 */
export function writeAdjustment(
  settings: PhotoEditingSettings,
  key: PhotoEditingAdjustmentKey,
  value: number,
): PhotoEditingSettings {
  const definition = ADJUSTMENT_DEFINITIONS.get(key);
  if (!definition || !Number.isFinite(value)) return settings;
  return { ...settings, [key]: roundToStep(clamp(value, definition.min, definition.max), definition.step) };
}

// ---------------------------------------------------------------------------
// 色温度・色かぶり補正

/**
 * `absolute`: Adobe のカメラプロファイルで開いた RAW（`asShotWhiteBalance` がある）。
 * `whiteBalance` の絶対値（2000〜50000K / −150〜+150）を書き、撮影時の値に戻せる。
 * `relative`: それ以外（JPEG など、プロファイルの無い Mac で開いた RAW）。
 * `relativeTemperature` / `relativeTint`（−100〜+100）を書く。
 *
 * developSettings の RAW（作業コピーの撮影時の白がある）でも、相対の補正が残っている（`whiteBalance.mode: "relative"` で
 * 相対の値が 0 でない。ブラウザ版は RAW も相対で直す）写真は、今の画と表示を合わせるため相対で見せる。相対を両方 0 に戻すと
 * 撮影時（`asShot`）になり、以後は絶対で直す（移行元設計 S7b）。
 */
export type PhotoEditingWhiteBalanceMode = "absolute" | "relative";

export function resolveWhiteBalanceMode(
  photo: Pick<PhotoEditingPhoto, "asShotWhiteBalance">,
  settings?: PhotoEditingSettings | null,
): PhotoEditingWhiteBalanceMode {
  if (!photo.asShotWhiteBalance) return "relative";
  if (settings && isDevelopSettingsForm(settings) && hasDevelopRelativeWhiteBalance(settings)) return "relative";
  return "absolute";
}

/** developSettings に相対の色温度・色かぶり補正が残っているか（`whiteBalance.mode: "relative"` で、どちらかが 0 でない）。 */
function hasDevelopRelativeWhiteBalance(settings: PhotoEditingSettings): boolean {
  return (
    readWhiteBalanceRecord(settings)?.mode === "relative" &&
    (readFinite(settings, "relativeTemperature") !== 0 || readFinite(settings, "relativeTint") !== 0)
  );
}

/**
 * developSettings では、相対の補正は `whiteBalance.mode: "relative"` のときだけ持てる（段 2 の検証 `modeMismatch`）。絶対値・
 * 撮影時へ切り替えるときは相対の値を 0 にする。Photo Bench の形は変えない。
 */
function clearDevelopRelativeWhiteBalance(settings: PhotoEditingSettings): PhotoEditingSettings {
  return isDevelopSettingsForm(settings) ? { ...settings, relativeTemperature: 0, relativeTint: 0 } : settings;
}

export const PHOTO_EDITING_TEMPERATURE_MIN_KELVIN = 2000;
export const PHOTO_EDITING_TEMPERATURE_MAX_KELVIN = 50000;
export const PHOTO_EDITING_ABSOLUTE_TINT_MIN = -150;
export const PHOTO_EDITING_ABSOLUTE_TINT_MAX = 150;
export const PHOTO_EDITING_RELATIVE_WHITE_BALANCE_MIN = -100;
export const PHOTO_EDITING_RELATIVE_WHITE_BALANCE_MAX = 100;

export type PhotoEditingAbsoluteWhiteBalanceView = PhotoEditingWhiteBalanceValue & {
  /** 撮影時の値のままか（戻す操作を出すかどうかに使う） */
  asShot: boolean;
};

function readWhiteBalanceRecord(settings: PhotoEditingSettings): Record<string, unknown> | null {
  const value = settings.whiteBalance;
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

/** 画面に出す色温度・色かぶり（撮影時のままなら撮影時の値）。Photo Bench の `custom` と developSettings の `absolute` を読む。 */
export function readAbsoluteWhiteBalance(
  settings: PhotoEditingSettings,
  asShot: PhotoEditingWhiteBalanceValue,
): PhotoEditingAbsoluteWhiteBalanceView {
  const whiteBalance = readWhiteBalanceRecord(settings);
  const temperature = whiteBalance?.temperature;
  const tint = whiteBalance?.tint;
  if (
    (whiteBalance?.mode === "custom" || whiteBalance?.mode === "absolute") &&
    typeof temperature === "number" &&
    Number.isFinite(temperature) &&
    typeof tint === "number" &&
    Number.isFinite(tint)
  ) {
    return { temperature, tint, asShot: false };
  }
  return { temperature: asShot.temperature, tint: asShot.tint, asShot: true };
}

/**
 * 絶対の色温度・色かぶりを書く（Photo Bench は `custom`、developSettings は `absolute` にして相対の値を 0 にする）。
 */
export function writeAbsoluteWhiteBalance(
  settings: PhotoEditingSettings,
  value: PhotoEditingWhiteBalanceValue,
): PhotoEditingSettings {
  return {
    ...clearDevelopRelativeWhiteBalance(settings),
    whiteBalance: {
      mode: isDevelopSettingsForm(settings) ? "absolute" : "custom",
      temperature: Math.round(
        clamp(value.temperature, PHOTO_EDITING_TEMPERATURE_MIN_KELVIN, PHOTO_EDITING_TEMPERATURE_MAX_KELVIN),
      ),
      tint: Math.round(clamp(value.tint, PHOTO_EDITING_ABSOLUTE_TINT_MIN, PHOTO_EDITING_ABSOLUTE_TINT_MAX)),
    },
  };
}

/** 撮影時に戻す（developSettings は相対の値も 0 にする）。 */
export function resetAbsoluteWhiteBalance(settings: PhotoEditingSettings): PhotoEditingSettings {
  return { ...clearDevelopRelativeWhiteBalance(settings), whiteBalance: { mode: "asShot" } };
}

export type PhotoEditingRelativeWhiteBalanceKey = "relativeTemperature" | "relativeTint";

export function readRelativeWhiteBalance(
  settings: PhotoEditingSettings,
  key: PhotoEditingRelativeWhiteBalanceKey,
): number {
  return readFinite(settings, key);
}

/**
 * 相対の色温度・色かぶり補正を書く。developSettings では、どちらかが 0 でなければ `whiteBalance.mode` を `relative` にし（段 2 は
 * それを求める）、両方 0 に戻したら撮影時（`asShot`）に戻す（ブラウザ版の `applyBrowserAdjustmentsToDevelopSettings` と同じ）。
 * Photo Bench の形では `whiteBalance` を変えない。
 */
export function writeRelativeWhiteBalance(
  settings: PhotoEditingSettings,
  key: PhotoEditingRelativeWhiteBalanceKey,
  value: number,
): PhotoEditingSettings {
  if (!Number.isFinite(value)) return settings;
  const next: PhotoEditingSettings = {
    ...settings,
    [key]: Math.round(
      clamp(value, PHOTO_EDITING_RELATIVE_WHITE_BALANCE_MIN, PHOTO_EDITING_RELATIVE_WHITE_BALANCE_MAX),
    ),
  };
  if (!isDevelopSettingsForm(settings)) return next;
  const whiteBalance = readWhiteBalanceRecord(settings);
  if (readFinite(next, "relativeTemperature") !== 0 || readFinite(next, "relativeTint") !== 0) {
    next.whiteBalance = { ...(whiteBalance ?? {}), mode: "relative" };
  } else if (whiteBalance?.mode === "relative") {
    next.whiteBalance = { ...whiteBalance, mode: "asShot" };
  } else if (!whiteBalance) {
    next.whiteBalance = { mode: "asShot" };
  }
  return next;
}

// ---------------------------------------------------------------------------
// 群（右パネルの見出しと並び）

/**
 * 右パネルで項目を呼ぶ名前（絞り込み `visibleKeys` に使う）。白の 2 項目は相対のキーで呼ぶ。効果の項目（白黒・周辺光量補正・
 * 粒子・粒子のサイズ。E1b 移行元設計）は、`visibleKeys` に入れた面にだけ出す（{@link visiblePhotoEditingAdjustmentGroups}）。
 */
export type PhotoEditingControlKey =
  | PhotoEditingAdjustmentKey
  | PhotoEditingRelativeWhiteBalanceKey
  | PhotoEditingEffectKey;

/**
 * 右パネルの 1 項目。`whiteBalance` は写真と設定で絶対 / 相対を決め（{@link resolveWhiteBalanceMode}）、絶対なら同じ項目を
 * `whiteBalance` の色温度（`channel: "temperature"`）・色かぶり補正（`"tint"`）として、相対なら `key` の値として描く。`toggle` は
 * 切り替え（白黒）、`effect` は効果のスライダー（周辺光量補正・粒子・粒子のサイズ。読み書きは `photo-editing-effects.ts`）。
 */
export type PhotoEditingAdjustmentControl =
  | { kind: "adjustment"; key: PhotoEditingAdjustmentKey; definition: PhotoEditingAdjustmentDefinition }
  | {
      kind: "whiteBalance";
      key: PhotoEditingRelativeWhiteBalanceKey;
      channel: "temperature" | "tint";
      label: string;
    }
  | { kind: "toggle"; key: "grayscale"; label: string }
  | { kind: "effect"; key: PhotoEditingEffectSliderKey; definition: PhotoEditingEffectSliderDefinition };

export type PhotoEditingAdjustmentGroupId = "light" | "color" | "effects";

export const PHOTO_EDITING_ADJUSTMENT_GROUP_IDS: ReadonlyArray<PhotoEditingAdjustmentGroupId> = ["light", "color", "effects"];

/** 群名の横の ⓘ で、群の先頭に出す項目ごとの 1 行の説明。 */
export type PhotoEditingAdjustmentGroupInfo = {
  /** ⓘ の読み上げ名 */
  label: string;
  descriptions: Partial<Record<PhotoEditingControlKey, string>>;
};

export type PhotoEditingAdjustmentGroup = {
  id: PhotoEditingAdjustmentGroupId;
  title: string;
  controls: ReadonlyArray<PhotoEditingAdjustmentControl>;
  /** 群名の横の ⓘ（無ければ出さない） */
  info?: PhotoEditingAdjustmentGroupInfo;
};

function adjustmentControls(
  definitions: ReadonlyArray<PhotoEditingAdjustmentDefinition>,
): PhotoEditingAdjustmentControl[] {
  return definitions.map(
    (definition): PhotoEditingAdjustmentControl => ({ kind: "adjustment", key: definition.key, definition }),
  );
}

/**
 * 右パネルの群（見出しと並び。ブラウザと NIHO Desktop で同じ。Lightroom のクラウド版・モバイルと同じ「ライト／カラー／効果」。
 * NIHO Photo 段 1 F1 移行元設計）。カラーの白（色温度・色かぶり補正）の絶対 / 相対の切り替えと「撮影時に戻す」は描く側。群の名前や
 * 並びを変えるときは、ここと `photo-editing-copy.ts` の見出しだけを変える。
 */
export const PHOTO_EDITING_ADJUSTMENT_GROUPS: ReadonlyArray<PhotoEditingAdjustmentGroup> = [
  { id: "light", title: PHOTO_EDITING_LIGHT_GROUP_TITLE, controls: adjustmentControls(PHOTO_EDITING_LIGHT_ADJUSTMENTS) },
  {
    id: "color",
    title: PHOTO_EDITING_COLOR_GROUP_TITLE,
    controls: [
      { kind: "whiteBalance", key: "relativeTemperature", channel: "temperature", label: "色温度" },
      { kind: "whiteBalance", key: "relativeTint", channel: "tint", label: "色かぶり補正" },
      ...adjustmentControls(PHOTO_EDITING_COLOR_ADJUSTMENTS),
    ],
  },
  {
    id: "effects",
    title: PHOTO_EDITING_EFFECTS_GROUP_TITLE,
    controls: adjustmentControls(PHOTO_EDITING_EFFECTS_ADJUSTMENTS),
    info: {
      label: PHOTO_EDITING_EFFECTS_INFO_LABEL,
      descriptions: {
        texture: PHOTO_EDITING_TEXTURE_DESCRIPTION,
        clarity: PHOTO_EDITING_CLARITY_DESCRIPTION,
        dehaze: PHOTO_EDITING_DEHAZE_DESCRIPTION,
      },
    },
  },
];

/** 基本の 13 項目のキー（{@link PHOTO_EDITING_ADJUSTMENT_GROUPS} の並び）。 */
export const PHOTO_EDITING_BASE_CONTROL_KEYS: ReadonlyArray<PhotoEditingControlKey> = PHOTO_EDITING_ADJUSTMENT_GROUPS.flatMap(
  (group) => group.controls.map((control) => control.key),
);

/**
 * 効果の項目も入れた群（NIHO Photo 段 1 E1b 移行元設計）。基本の群に、カラーの**先頭**の「白黒」の切り替えと、効果の後ろの
 * 周辺光量補正 → 粒子 → 粒子のサイズを足す（効果の ⓘ に 1 行ずつ）。効果のある設定（v: 3）を読める wasm で開いた写真にだけ
 * 見せるので、`visibleKeys` に効果のキーを入れた面だけがここから絞る（省いた面＝NIHO Desktop には出さない）。
 */
export const PHOTO_EDITING_ADJUSTMENT_GROUPS_WITH_EFFECTS: ReadonlyArray<PhotoEditingAdjustmentGroup> =
  PHOTO_EDITING_ADJUSTMENT_GROUPS.map((group): PhotoEditingAdjustmentGroup => {
    if (group.id === "color") {
      return {
        ...group,
        controls: [{ kind: "toggle", key: "grayscale", label: PHOTO_EDITING_GRAYSCALE_LABEL }, ...group.controls],
      };
    }
    if (group.id === "effects") {
      return {
        ...group,
        controls: [
          ...group.controls,
          ...PHOTO_EDITING_EFFECT_SLIDERS.map(
            (definition): PhotoEditingAdjustmentControl => ({ kind: "effect", key: definition.key, definition }),
          ),
        ],
        info: {
          label: group.info?.label ?? PHOTO_EDITING_EFFECTS_INFO_LABEL,
          descriptions: {
            ...group.info?.descriptions,
            vignetteAmount: PHOTO_EDITING_VIGNETTE_DESCRIPTION,
            grainAmount: PHOTO_EDITING_GRAIN_DESCRIPTION,
          },
        },
      };
    }
    return group;
  });

/**
 * 見せる項目だけに絞った群。並びは群の定義のまま、項目が 1 つも残らない群は外す。
 *
 * `visibleKeys` を省くと基本の 13 項目（{@link PHOTO_EDITING_ADJUSTMENT_GROUPS}）で、効果の項目（白黒・周辺光量補正・粒子）は
 * 出さない。効果の項目は、`visibleKeys` に入れたときだけ出る（opt-in。{@link PHOTO_EDITING_ADJUSTMENT_GROUPS_WITH_EFFECTS} から
 * 絞る）。
 */
export function visiblePhotoEditingAdjustmentGroups(
  visibleKeys?: ReadonlyArray<PhotoEditingControlKey>,
  groups?: ReadonlyArray<PhotoEditingAdjustmentGroup>,
): PhotoEditingAdjustmentGroup[] {
  if (!visibleKeys) return [...(groups ?? PHOTO_EDITING_ADJUSTMENT_GROUPS)];
  const visible = new Set<PhotoEditingControlKey>(visibleKeys);
  return (groups ?? PHOTO_EDITING_ADJUSTMENT_GROUPS_WITH_EFFECTS).flatMap((group): PhotoEditingAdjustmentGroup[] => {
    const controls = group.controls.filter((control) => visible.has(control.key));
    return controls.length > 0 ? [{ ...group, controls }] : [];
  });
}

// 色温度のスライダーは mired（1,000,000 / K）で等間隔にする。2000〜50000K を K のまま等分すると、
// よく使う 2500〜10000K がつまみの左 2 割に詰まり、細かく合わせられない（Lightroom も低い側ほど細かい）。
export const PHOTO_EDITING_TEMPERATURE_SLIDER_STEPS = 1000;
const MIRED_AT_MIN_KELVIN = 1_000_000 / PHOTO_EDITING_TEMPERATURE_MIN_KELVIN;
const MIRED_AT_MAX_KELVIN = 1_000_000 / PHOTO_EDITING_TEMPERATURE_MAX_KELVIN;

export function temperatureToSliderPosition(kelvin: number): number {
  const clamped = clamp(
    Number.isFinite(kelvin) ? kelvin : PHOTO_EDITING_TEMPERATURE_MIN_KELVIN,
    PHOTO_EDITING_TEMPERATURE_MIN_KELVIN,
    PHOTO_EDITING_TEMPERATURE_MAX_KELVIN,
  );
  const mired = 1_000_000 / clamped;
  const ratio = (MIRED_AT_MIN_KELVIN - mired) / (MIRED_AT_MIN_KELVIN - MIRED_AT_MAX_KELVIN);
  return Math.round(ratio * PHOTO_EDITING_TEMPERATURE_SLIDER_STEPS);
}

export function sliderPositionToTemperature(position: number): number {
  const ratio = clamp(Number.isFinite(position) ? position : 0, 0, PHOTO_EDITING_TEMPERATURE_SLIDER_STEPS) /
    PHOTO_EDITING_TEMPERATURE_SLIDER_STEPS;
  const mired = MIRED_AT_MIN_KELVIN - ratio * (MIRED_AT_MIN_KELVIN - MIRED_AT_MAX_KELVIN);
  return Math.round(1_000_000 / mired);
}

// ---------------------------------------------------------------------------
// 表示

function formatSigned(value: number, decimals: number): string {
  const rounded = Number(value.toFixed(decimals));
  if (rounded === 0) return (0).toFixed(decimals);
  const text = Math.abs(rounded).toFixed(decimals);
  return rounded > 0 ? `+${text}` : `-${text}`;
}

export function formatAdjustmentValue(key: PhotoEditingAdjustmentKey, value: number): string {
  return key === "exposure" ? formatSigned(value, 2) : formatSigned(value, 0);
}

export function formatSignedInteger(value: number): string {
  return formatSigned(value, 0);
}

export function formatTemperature(kelvin: number): string {
  return String(Math.round(kelvin));
}
