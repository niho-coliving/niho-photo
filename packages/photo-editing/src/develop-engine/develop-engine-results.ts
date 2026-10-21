import { parseDevelopMasks, type DevelopMask } from "./develop-masks";
import { readDevelopSettings, type DevelopSettings } from "./develop-settings";

/**
 * 段 2 の wasm（Worker）が JSON で返す結果の型と読み方（`develop-engine-client.ts` から使う。形が違えば null を返し、呼ぶ側が
 * `DevelopEngineError` にする）。
 */

/** Photo Bench `EditSettings` を `developSettings` に変換した結果（crate の版付きの変換。`ok` でなければ扱えない項目がある）。 */
export type DevelopEditSettingsConversion = {
  ok: boolean;
  settings: DevelopSettings | null;
  issues: unknown[];
};

/** crate に同梱したプリセット（`builtinPresets`）。 */
export type DevelopBuiltinPreset = { id: string; name: string; xmp: string };

/** 今の補正を XMP に書き出すときの群（crate の `XmpGroup`。既定は `exposure` と `whiteBalance` を除く 11 群）。 */
export type DevelopXmpGroup =
  | "exposure"
  | "whiteBalance"
  | "tone"
  | "presence"
  | "toneCurve"
  | "hsl"
  | "colorGrading"
  | "calibration"
  | "blackAndWhite"
  | "vignette"
  | "grain"
  | "noiseReduction"
  | "sharpening";

/** crate の既定の群（露光量と絶対のホワイトバランスを含めない）。 */
export const DEVELOP_XMP_DEFAULT_GROUPS: readonly DevelopXmpGroup[] = [
  "tone",
  "presence",
  "toneCurve",
  "hsl",
  "colorGrading",
  "calibration",
  "blackAndWhite",
  "vignette",
  "grain",
  "noiseReduction",
  "sharpening",
];

/** 今の補正を書き出した Lightroom のプリセット（`notWritten` は書けなかった項目。相対の色温度・色かぶりなど）。 */
export type DevelopSettingsXmp = { xmp: string; notWritten: string[] };

/**
 * XMP のプリセットを `developSettings` に当てた結果（crate の `presetSettings`）。`converted` が false なら、当てた結果に段 2 で
 * 扱えない項目がある（`settings.legacySettings` に残る）。
 */
export type DevelopPresetResult = {
  /** XMP の `crs:Name`（無ければ空文字） */
  name: string;
  settings: DevelopSettings;
  converted: boolean;
  /**
   * 段 2 が再現しない XMP の項目（レンズ補正・色収差・知らない項目・ブラシや AI のマスクなど）。シャープ・ノイズ軽減は crate 0.19.0（Issue #32）から
   * 近い式で描く（crate の `approximate`）ので、読めない値か既定でない細かな項目のときだけ入る
   */
  unsupported: string[];
  /**
   * プリセットの部分補正（Lightroom の線形・円形のマスク。crate の `PresetResult::masks`）。座標は**当てる写真の見えている枠**
   * （切り抜き・回転・反転・角度補正の後の出力）の上で、`settings.masks`（当てる前の写真のまま）には入っていない。写真に置くときは
   * `presetDevelopSettings` が写真の幾何と作業画像の大きさで作業画像の座標へ写す。無い（0 枚）ときはキーが無い。
   */
  masks?: DevelopMask[];
};

/** 結果のマスクが読めなかったときに `unsupported` に足す項目（画面は「読めないマスク」と知らせる）。 */
export const UNREADABLE_PRESET_MASKS_ITEM = "MaskGroupBasedCorrections";

export const BROKEN_CONVERSION: DevelopEditSettingsConversion = { ok: false, settings: null, issues: [] };

/** 変換の結果の JSON（`{ converter, ok, settings, issues, notes }`）を読む。形が違えば扱えない（`ok: false`）。 */
export function readConversion(resultJson: string): DevelopEditSettingsConversion {
  let value: unknown;
  try {
    value = JSON.parse(resultJson);
  } catch {
    return BROKEN_CONVERSION;
  }
  if (typeof value !== "object" || value === null || Array.isArray(value)) return BROKEN_CONVERSION;
  const record = value as Record<string, unknown>;
  const settings = readDevelopSettings(record.settings);
  if (typeof record.ok !== "boolean" || !settings) return BROKEN_CONVERSION;
  return { ok: record.ok, settings, issues: Array.isArray(record.issues) ? record.issues : [] };
}

/** JSON のオブジェクトを読む（読めない・オブジェクトでなければ null）。 */
function parseRecord(json: string): Record<string, unknown> | null {
  let value: unknown;
  try {
    value = JSON.parse(json);
  } catch {
    return null;
  }
  return typeof value === "object" && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}

function readStringList(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
}

/**
 * プリセットを当てた結果の JSON を読む（`applyPreset` の結果も同じ形）。`settings` が v1 の形でなければ null。`masks` は M1 の
 * 読み方（`parseDevelopMasks`。結果の `settings` のホワイトバランスの方式で）で厳密に読み、1 枚でも読めなければプリセットのマスクを
 * すべて使わず、`unsupported` に {@link UNREADABLE_PRESET_MASKS_ITEM} を足す（黙って落とさない）。
 */
export function readPresetResult(resultJson: string): DevelopPresetResult | null {
  const record = parseRecord(resultJson);
  const settings = record ? readDevelopSettings(record.settings) : null;
  if (!record || !settings) return null;
  const result: DevelopPresetResult = {
    name: typeof record.name === "string" ? record.name : "",
    settings,
    converted: record.converted === true,
    unsupported: readStringList(record.unsupported),
  };
  if (record.masks === undefined) return result;
  const whiteBalance = settings.whiteBalance;
  const whiteBalanceMode =
    typeof whiteBalance === "object" && whiteBalance !== null ? (whiteBalance as Record<string, unknown>).mode : undefined;
  const masks = parseDevelopMasks(record.masks, { whiteBalanceMode });
  if (masks === null) {
    if (!result.unsupported.includes(UNREADABLE_PRESET_MASKS_ITEM)) result.unsupported.push(UNREADABLE_PRESET_MASKS_ITEM);
  } else if (masks.length > 0) {
    result.masks = masks;
  }
  return result;
}

/** 同梱のプリセットの一覧の JSON を読む（`id` と `xmp` の無いものは落とす。名前が無ければ `id`）。一覧でなければ null。 */
export function readBuiltinPresets(presetsJson: string): DevelopBuiltinPreset[] | null {
  let value: unknown;
  try {
    value = JSON.parse(presetsJson);
  } catch {
    return null;
  }
  if (!Array.isArray(value)) return null;
  return value.flatMap((item: unknown) => {
    if (typeof item !== "object" || item === null) return [];
    const record = item as Record<string, unknown>;
    const id = typeof record.id === "string" ? record.id : "";
    const xmp = typeof record.xmp === "string" ? record.xmp : "";
    if (!id || !xmp) return [];
    const name = typeof record.name === "string" && record.name ? record.name : id;
    return [{ id, name, xmp }];
  });
}

/** 書き出した XMP の JSON（`{ xmp, notWritten }`）を読む。XMP が無ければ null。 */
export function readSettingsXmp(resultJson: string): DevelopSettingsXmp | null {
  const record = parseRecord(resultJson);
  if (!record || typeof record.xmp !== "string" || !record.xmp) return null;
  return { xmp: record.xmp, notWritten: readStringList(record.notWritten) };
}
