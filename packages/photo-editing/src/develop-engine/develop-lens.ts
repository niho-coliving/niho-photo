/**
 * レンズ補正（niho-photo#45）の `developSettings.lens` の形と、その読み取り（crate の `lens.rs` と同じ規則）。
 *
 * `lens` は `{ distortion, vignetting, vignettingMidpoint, removeChromaticAberration, defringe: { purple: { amount, hueLo, hueHi },
 * green: { amount, hueLo, hueHi } } }`。欠けた項目は既定（歪み・周辺光量 0、中点 50、色収差の除去 off、フリンジの量 0、色相の範囲は
 * 紫 30〜70・緑 40〜60〔Lightroom の色相の目盛り 0〜100〕）。`distortion`・`vignetting` は -100〜100、ほかの数は 0〜100、色相は
 * `hueLo <= hueHi`。知らないキーは crate が `unknownKey` で拒むので、形の壊れた設定とする。画を変える値（歪み・周辺光量・色収差の
 * 除去・フリンジの量のどれか）があれば形の版 `v` は 9。全部が既定ならキーごと書かない。
 *
 * このファイルは develop-settings.ts からも読むので、develop-settings.ts を import しない（編集の純関数は photo-editing-lens.ts）。
 */

/** レンズ補正が画を変える編集内容の形の版（crate の `LENS_SETTINGS_VERSION`）。 */
export const LENS_SETTINGS_VERSION = 9;

export type DevelopLensFringeBand = { amount: number; hueLo: number; hueHi: number };

/** `lens` を既定で埋めた形。 */
export type DevelopLens = {
  distortion: number;
  vignetting: number;
  vignettingMidpoint: number;
  removeChromaticAberration: boolean;
  defringe: { purple: DevelopLensFringeBand; green: DevelopLensFringeBand };
};

/** 既定（crate の `Lens::default`）。 */
export const DEVELOP_LENS_DEFAULT: Readonly<DevelopLens> = Object.freeze({
  distortion: 0,
  vignetting: 0,
  vignettingMidpoint: 50,
  removeChromaticAberration: false,
  defringe: Object.freeze({
    purple: Object.freeze({ amount: 0, hueLo: 30, hueHi: 70 }),
    green: Object.freeze({ amount: 0, hueLo: 40, hueHi: 60 }),
  }),
}) as Readonly<DevelopLens>;

const LENS_KEYS: ReadonlySet<string> = new Set([
  "distortion",
  "vignetting",
  "vignettingMidpoint",
  "removeChromaticAberration",
  "defringe",
]);
const DEFRINGE_KEYS: ReadonlySet<string> = new Set(["purple", "green"]);
const BAND_KEYS: ReadonlySet<string> = new Set(["amount", "hueLo", "hueHi"]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function inRange(value: unknown, min: number, max: number, fallback: number): number | null {
  if (value === undefined) return fallback;
  return typeof value === "number" && Number.isFinite(value) && value >= min && value <= max ? value : null;
}

function readBand(value: unknown, fallback: DevelopLensFringeBand): DevelopLensFringeBand | null {
  if (value === undefined) return { ...fallback };
  if (!isRecord(value) || Object.keys(value).some((key) => !BAND_KEYS.has(key))) return null;
  const amount = inRange(value.amount, 0, 100, fallback.amount);
  const hueLo = inRange(value.hueLo, 0, 100, fallback.hueLo);
  const hueHi = inRange(value.hueHi, 0, 100, fallback.hueHi);
  if (amount === null || hueLo === null || hueHi === null || hueLo > hueHi) return null;
  return { amount, hueLo, hueHi };
}

/**
 * `lens` の値を既定で埋めた形で読む（crate の `parse_lens` と `validate_lens` を両方通るときだけ。無い〔undefined・null〕なら既定）。
 * 知らないキー・数でない値・範囲外・色相の逆転があれば null（描けない設定として扱う）。
 */
export function readDevelopLens(value: unknown): DevelopLens | null {
  const fallback = DEVELOP_LENS_DEFAULT;
  if (value === undefined || value === null) {
    return { ...fallback, defringe: { purple: { ...fallback.defringe.purple }, green: { ...fallback.defringe.green } } };
  }
  if (!isRecord(value) || Object.keys(value).some((key) => !LENS_KEYS.has(key))) return null;
  const distortion = inRange(value.distortion, -100, 100, fallback.distortion);
  const vignetting = inRange(value.vignetting, -100, 100, fallback.vignetting);
  const vignettingMidpoint = inRange(value.vignettingMidpoint, 0, 100, fallback.vignettingMidpoint);
  const removeChromaticAberration = value.removeChromaticAberration === undefined ? false : value.removeChromaticAberration;
  if (distortion === null || vignetting === null || vignettingMidpoint === null) return null;
  if (typeof removeChromaticAberration !== "boolean") return null;
  const defringe = value.defringe;
  if (defringe !== undefined && defringe !== null && (!isRecord(defringe) || Object.keys(defringe).some((key) => !DEFRINGE_KEYS.has(key)))) {
    return null;
  }
  const bands = isRecord(defringe) ? defringe : {};
  const purple = readBand(bands.purple, fallback.defringe.purple);
  const green = readBand(bands.green, fallback.defringe.green);
  if (!purple || !green) return null;
  return { distortion, vignetting, vignettingMidpoint, removeChromaticAberration, defringe: { purple, green } };
}

/** 編集内容の `lens` が描ける形か（無いのも可）。 */
export function hasValidDevelopLens(settings: Record<string, unknown>): boolean {
  return readDevelopLens(settings.lens) !== null;
}

/** 読んだ `lens` が画を変えるか（crate の `Lens::is_active`。中点と色相の範囲だけでは変えない）。 */
export function isActiveDevelopLens(lens: DevelopLens): boolean {
  return (
    lens.distortion !== 0 ||
    lens.vignetting !== 0 ||
    lens.removeChromaticAberration ||
    lens.defringe.purple.amount > 0 ||
    lens.defringe.green.amount > 0
  );
}

/** 読んだ `lens` が既定と同じか（キーごと書かない形）。 */
export function isDefaultDevelopLens(lens: DevelopLens): boolean {
  const d = DEVELOP_LENS_DEFAULT;
  const sameBand = (a: DevelopLensFringeBand, b: DevelopLensFringeBand) =>
    a.amount === b.amount && a.hueLo === b.hueLo && a.hueHi === b.hueHi;
  return (
    lens.distortion === d.distortion &&
    lens.vignetting === d.vignetting &&
    lens.vignettingMidpoint === d.vignettingMidpoint &&
    lens.removeChromaticAberration === d.removeChromaticAberration &&
    sameBand(lens.defringe.purple, d.defringe.purple) &&
    sameBand(lens.defringe.green, d.defringe.green)
  );
}

/**
 * レンズ補正が画を変えるか（形の版 9 が要る。crate の `required_version`）。形の壊れた `lens` も、恒等とみなさず true（描けない
 * 設定として扱う）。無い・null・既定・中点と色相の範囲だけは false。
 */
export function hasActiveDevelopLens(value: unknown): boolean {
  if (!isRecord(value)) return false;
  const lens = readDevelopLens(value.lens);
  return lens === null || isActiveDevelopLens(lens);
}
