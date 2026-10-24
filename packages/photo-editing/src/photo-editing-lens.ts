import { developSettingsVersion } from "./develop-engine/develop-settings";
import { isDefaultDevelopLens, readDevelopLens } from "./develop-engine/develop-lens";
import type { PhotoEditingSettings } from "./photo-editing-types";

/**
 * 右パネルの「レンズ」の節（niho-photo#45）の `developSettings.lens` の読み書き（純関数）と、作業コピーに焼き込まれたプロファイル補正の
 * 状態。形は crate の `lens.rs`（develop-lens.ts）。
 *
 * - 読む: 有限の数だけを範囲に収めて見せる（範囲外・数でない値は表示のために収める・既定にするだけで、書き戻しはしない）
 * - 書く: 直した値の 1 つだけを置き換え（ほかの値・フリンジの色相の範囲はそのまま持つ）、整数に丸めて範囲に収める。全部が既定に
 *   なったら `lens` ごと消す。形の版 `v` は書いた結果から決め直す（画を変えれば 9）。見せている値が変わらない書き込みは、渡した
 *   設定をそのまま返す
 * - プロファイルによる歪み・周辺光量の補正は作らない（Mac の RAW の作業コピーが既に焼き込んでいる。手動の値はその上の微調整）
 */

/** 節のスライダー（フリンジは色ごとの量だけ。色相の範囲は XMP から入ったまま保つ）。 */
export type PhotoEditingLensSliderKey = "distortion" | "vignetting" | "vignettingMidpoint" | "defringePurple" | "defringeGreen";

export type PhotoEditingLensValues = Record<PhotoEditingLensSliderKey, number> & { removeChromaticAberration: boolean };

/** スライダーの範囲・既定（crate の `validate_lens` の範囲。Lightroom と同じ整数の目盛り）。 */
export const PHOTO_EDITING_LENS_RANGES: Readonly<
  Record<PhotoEditingLensSliderKey, { min: number; max: number; defaultValue: number; signed: boolean }>
> = {
  distortion: { min: -100, max: 100, defaultValue: 0, signed: true },
  vignetting: { min: -100, max: 100, defaultValue: 0, signed: true },
  vignettingMidpoint: { min: 0, max: 100, defaultValue: 50, signed: false },
  defringePurple: { min: 0, max: 100, defaultValue: 0, signed: false },
  defringeGreen: { min: 0, max: 100, defaultValue: 0, signed: false },
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function clamp(value: number, min: number, max: number): number {
  const clamped = Math.min(max, Math.max(min, value));
  return clamped === 0 ? 0 : clamped;
}

function rawLens(settings: PhotoEditingSettings): Record<string, unknown> {
  return isRecord(settings.lens) ? settings.lens : {};
}

function rawBand(lens: Record<string, unknown>, color: "purple" | "green"): Record<string, unknown> {
  const defringe = isRecord(lens.defringe) ? lens.defringe : {};
  return isRecord(defringe[color]) ? defringe[color] : {};
}

function displayValue(value: unknown, key: PhotoEditingLensSliderKey): number {
  const range = PHOTO_EDITING_LENS_RANGES[key];
  if (typeof value !== "number" || !Number.isFinite(value)) return range.defaultValue;
  return clamp(value, range.min, range.max);
}

/** 節に見せる値（範囲に収め、無い値・数でない値は既定）。 */
export function readPhotoEditingLens(settings: PhotoEditingSettings): PhotoEditingLensValues {
  const lens = rawLens(settings);
  return {
    distortion: displayValue(lens.distortion, "distortion"),
    vignetting: displayValue(lens.vignetting, "vignetting"),
    vignettingMidpoint: displayValue(lens.vignettingMidpoint, "vignettingMidpoint"),
    defringePurple: displayValue(rawBand(lens, "purple").amount, "defringePurple"),
    defringeGreen: displayValue(rawBand(lens, "green").amount, "defringeGreen"),
    removeChromaticAberration: lens.removeChromaticAberration === true,
  };
}

/** `lens` を置いた（既定なら消した）設定。形の版は書いた結果から決め直す。 */
function withLens(settings: PhotoEditingSettings, lens: Record<string, unknown>): PhotoEditingSettings {
  const next: Record<string, unknown> = { ...settings };
  const read = readDevelopLens(lens);
  if (read !== null && isDefaultDevelopLens(read)) delete next.lens;
  else next.lens = lens;
  return { ...next, v: developSettingsVersion(next) } as PhotoEditingSettings;
}

/**
 * 1 つのスライダーの値を書き換えた新しい settings を返す（整数に丸めて範囲に収める。ほかの値・知らないキーはそのまま）。全部が既定に
 * なれば `lens` ごと消す。見せている値が変わらなければ（有限の数でない値も）、渡した settings をそのまま返す。
 */
export function writePhotoEditingLens(
  settings: PhotoEditingSettings,
  key: PhotoEditingLensSliderKey,
  value: number,
): PhotoEditingSettings {
  if (!Number.isFinite(value)) return settings;
  const range = PHOTO_EDITING_LENS_RANGES[key];
  const next = clamp(Math.round(value), range.min, range.max);
  if (readPhotoEditingLens(settings)[key] === next) return settings;
  const lens = { ...rawLens(settings) };
  if (key === "defringePurple" || key === "defringeGreen") {
    const color = key === "defringePurple" ? "purple" : "green";
    const defringe = isRecord(lens.defringe) ? { ...lens.defringe } : {};
    defringe[color] = { ...rawBand(lens, color), amount: next };
    lens.defringe = defringe;
  } else {
    lens[key] = next;
  }
  return withLens(settings, lens);
}

/** 「色収差を除去」を切り替えた新しい settings を返す（同じなら渡した settings のまま）。 */
export function writePhotoEditingLensChromaticAberration(settings: PhotoEditingSettings, on: boolean): PhotoEditingSettings {
  if (readPhotoEditingLens(settings).removeChromaticAberration === on) return settings;
  return withLens(settings, { ...rawLens(settings), removeChromaticAberration: on });
}

/** 既定でない値（中点・フリンジの色相の範囲を含む）があるか（節の「初期化」を押せるか）。 */
export function hasPhotoEditingLensEdits(settings: PhotoEditingSettings): boolean {
  if (settings.lens === undefined || settings.lens === null) return false;
  const lens = readDevelopLens(settings.lens);
  return lens === null || !isDefaultDevelopLens(lens);
}

/** レンズ補正を全部既定へ戻した settings（`lens` ごと消す。無ければ渡した settings のまま）。 */
export function resetPhotoEditingLens(settings: PhotoEditingSettings): PhotoEditingSettings {
  if (settings.lens === undefined) return settings;
  const next: Record<string, unknown> = { ...settings };
  delete next.lens;
  return { ...next, v: developSettingsVersion(next) } as PhotoEditingSettings;
}

/**
 * 画素を動かすレンズ補正（歪み・色収差の除去）を外した settings（修復の道具の「幾何なし」の画用。ポインタの位置 = 写真の座標に
 * する）。周辺光量とフリンジは色の補正として残す。外すものが無ければ渡した settings のまま。
 */
export function withoutPhotoEditingLensWarp<T extends PhotoEditingSettings>(settings: T): T {
  const values = readPhotoEditingLens(settings);
  if (values.distortion === 0 && !values.removeChromaticAberration) return settings;
  return withLens(settings, { ...rawLens(settings), distortion: 0, removeChromaticAberration: false }) as T;
}

/**
 * 作業コピーに焼き込まれたプロファイル補正（Mac の sidecar `apple-raw-linear` の `_source.lensCorrection.mode`）。`apple` は Core Image
 * の歪み補正、`embedded` はカメラの埋め込み値の歪み・周辺光量補正、`none` は補正なし（未登録の機種など）。
 */
export type PhotoEditingLensProfileState = "apple" | "embedded" | "none";

/**
 * 作業コピーの meta（`work.meta` の JSON）から、焼き込まれたプロファイル補正を読む。作業コピーでない（JPEG / PNG のオリジナル）・
 * meta を読めない・`lensCorrection` が無い・知らない値なら null（節に状態を出さない）。
 */
export function readWorkingCopyLensProfile(metaJson: string | null | undefined): PhotoEditingLensProfileState | null {
  if (typeof metaJson !== "string" || metaJson === "") return null;
  let meta: unknown;
  try {
    meta = JSON.parse(metaJson);
  } catch {
    return null;
  }
  if (!isRecord(meta) || !isRecord(meta._source) || !isRecord(meta._source.lensCorrection)) return null;
  const mode = meta._source.lensCorrection.mode;
  return mode === "apple" || mode === "embedded" || mode === "none" ? mode : null;
}
