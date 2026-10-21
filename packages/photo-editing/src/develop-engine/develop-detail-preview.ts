/**
 * ディテール（シャープ・ノイズ軽減。v5 の `detail`。Issue #32）を wasm のプレビューへどう送るか（owner 判断 2026-10-21）。
 *
 * - 量の無い `detail`（シャープ 0・輝度のノイズ軽減 0・カラーの明示なし）は外して送る。ディテールを使っていない写真は、今までと
 *   同じ設定の JSON・同じ経路・同じ速さで描く
 * - JPEG / PNG（`open` で開いた写真）は、drag 中（Interactive）も NR を描き、シャープは crate が Final だけで当てる
 * - 16bit PNG の作業コピー（RAW・HEIC / TIFF など。`openWorkingCopy`）は、drag 中は NR も計算し直さない。旧 RAW・raster の作業
 *   コピーは `detail` ごと外す。signed RAW（niho-3/4/5/7/11）は NR が原寸の master の準備に入っているので、外すと master を
 *   作り直してかえって遅くなる。直前の確定描画（Final）の NR のまま送り、同じ master を使い回す。確定描画は今の値をそのまま描く
 * - 色取得・見本は確定描画と同じ画を前提にするので、JPEG と同じく今の値を送る
 */

/** NR を canonical master の準備で当てる signed RAW の数式（crate の `renders_legacy_raw_cnr` と同じ）。 */
export const SIGNED_RAW_DETAIL_ENGINES: ReadonlySet<string> = new Set(["niho-3", "niho-4", "niho-5", "niho-7", "niho-11"]);

/** 確定描画で使った NR（signed RAW の drag 中に使い回す）。 */
export type DevelopDetailNoise = { luminanceNoiseReduction: number; colorNoiseReduction?: number };

type SettingsRecord = Record<string, unknown>;

function isRecord(value: unknown): value is SettingsRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function finiteOr(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

function withoutDetail(settings: SettingsRecord): SettingsRecord {
  const { detail: _detail, ...rest } = settings;
  return rest;
}

/** 描画に効く `detail` か（シャープ・輝度のノイズ軽減が 0 より大きい、またはカラーの明示がある）。 */
function isActiveDetail(detail: unknown): detail is SettingsRecord {
  if (!isRecord(detail)) return false;
  const sharpening = isRecord(detail.sharpening) ? detail.sharpening : {};
  return (
    finiteOr(sharpening.amount, 0) !== 0 ||
    finiteOr(detail.luminanceNoiseReduction, 0) !== 0 ||
    detail.colorNoiseReduction !== undefined
  );
}

/** 量の無い `detail` を外した設定（`detail` が無い・効く設定はそのまま返す）。 */
export function withoutInertDetail(settings: SettingsRecord): SettingsRecord {
  if (!Object.hasOwn(settings, "detail") || isActiveDetail(settings.detail)) return settings;
  return withoutDetail(settings);
}

/** 設定の NR（効く NR が無ければ null）。 */
export function developDetailNoise(settings: SettingsRecord): DevelopDetailNoise | null {
  const detail = settings.detail;
  if (!isRecord(detail)) return null;
  const luminanceNoiseReduction = finiteOr(detail.luminanceNoiseReduction, 0);
  const colorNoiseReduction = typeof detail.colorNoiseReduction === "number" ? detail.colorNoiseReduction : undefined;
  if (luminanceNoiseReduction === 0 && colorNoiseReduction === undefined) return null;
  return colorNoiseReduction === undefined ? { luminanceNoiseReduction } : { luminanceNoiseReduction, colorNoiseReduction };
}

/**
 * 16bit PNG の作業コピーの drag 中（Interactive）の描画に送る設定。`committed` は直前の確定描画の NR（{@link developDetailNoise}）。
 * ディテールを使っていない写真（`detail` も `committed` も無い）は、渡した設定をそのまま返す。
 */
export function interactiveWorkingCopySettings(settings: SettingsRecord, committed: DevelopDetailNoise | null): SettingsRecord {
  const current = withoutInertDetail(settings);
  const signed = typeof settings.engine === "string" && SIGNED_RAW_DETAIL_ENGINES.has(settings.engine);
  if (!signed) return Object.hasOwn(current, "detail") ? withoutDetail(current) : current;
  if (!Object.hasOwn(current, "detail") && committed === null) return current;
  const detail: SettingsRecord = isRecord(current.detail) ? { ...current.detail } : {};
  detail.sharpening = isRecord(detail.sharpening) ? detail.sharpening : { amount: 0, radius: 1, detail: 25, masking: 0 };
  detail.luminanceNoiseReduction = committed?.luminanceNoiseReduction ?? 0;
  if (committed?.colorNoiseReduction === undefined) delete detail.colorNoiseReduction;
  else detail.colorNoiseReduction = committed.colorNoiseReduction;
  return { ...current, v: Math.max(finiteOr(current.v, 1), 5), detail };
}
