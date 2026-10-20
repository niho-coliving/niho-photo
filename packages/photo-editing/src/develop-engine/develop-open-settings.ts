import type { PhotoLibraryPhoto } from "../library/photo-library";

import type { DevelopEditSettingsConversion, DevelopEngine } from "./develop-engine-client";
import {
  DevelopSettingsBaseMismatchError,
  developSettingsOnWorkingCopy,
  hasSavedDevelopSettings,
  isEditableDevelopSettings,
  readDevelopSettings,
  type DevelopSettings,
} from "./develop-settings";

/**
 * クラウドの写真を段 2 の wasm で開くときに使う補正（移行時の設計文書 決まりごと 11）。ブラウザ版
 * （移行元設計 / 移行元設計）と NIHO Desktop（移行元設計 S7b）が同じ規則で決める。
 *
 * - 補正は写真に 1 つで、置き場は `developSettings` の 1 つ（K1c 移行元設計。旧エンジン（Photo Bench）の `settings` は読まない）。
 *   保存してあればそれ（新しい版の NIHO で保存した設定は `newer`。古い数式で読み替えない）、保存したことが無ければ補正なし（neutral）
 * - 保存済み `base` があれば同じ版だけを開き、無ければ取得した作業コピーの版で初期化する（開いただけでは保存しない）
 */

/**
 * 開いたときの補正の出どころ。`develop` は保存してある `developSettings`、`none` は補正を保存したことが無い写真（補正なしで開く）。
 */
export type DevelopOpenSettingsSource = "develop" | "none";

export type DevelopOpenSettings =
  | {
      kind: "settings";
      /** スライダーを重ねる土台（オリジナルから直接描く写真で補正を保存したことが無ければ null。作業コピーでは常に `base` つき） */
      baseSettings: DevelopSettings | null;
      settingsSource: DevelopOpenSettingsSource;
    }
  /** 新しい版の NIHO（段 2 の数式）で保存した `developSettings`（この画面では閲覧だけ） */
  | { kind: "newer" }
  /** 保存済みbaseと取得したartifact、またはsignedのbase/metadata/engine/lookが一致しない。 */
  | { kind: "baseMismatch" };

/**
 * 旧エンジン（Photo Bench）の `EditSettings` を crate の版付きの変換で `developSettings` に写した結果（NIHO Desktop の面が、この Mac
 * の補正をクラウドへ保存するときに使う。クラウドから読む側では使わない。K1c 移行元設計）。
 *
 * - `converted`: 写せた（作業コピーでは保存済み `base` と取得した版が一致する場合だけ）
 * - `unconvertible`: 段 2 で扱えない項目がある（`ok: false` で `legacySettings` が残る）。クラウドへ送らない
 * - `failed`: wasm が変換できなかった（Worker の失敗・壊れた応答・この画面と違う数式の版）
 */
export type DevelopEditSettingsConverted =
  | { kind: "converted"; settings: DevelopSettings }
  | { kind: "unconvertible" }
  | { kind: "failed" };

export async function convertEditSettingsToDevelop(
  engine: Pick<DevelopEngine, "convertEditSettings">,
  editSettings: Record<string, unknown> | null,
  baseVersion: string | null,
): Promise<DevelopEditSettingsConverted> {
  let converted: DevelopEditSettingsConversion;
  try {
    converted =
      baseVersion === null
        ? await engine.convertEditSettings(editSettings ?? {})
        : await engine.convertEditSettings(editSettings ?? {}, { baseVersion });
  } catch {
    return { kind: "failed" };
  }
  // 壊れた応答（形が違う）は settings が無い
  if (!converted.settings) return { kind: "failed" };
  if (!isEditableDevelopSettings(converted.settings)) return { kind: "failed" };
  if (!converted.ok) return { kind: "unconvertible" };
  return { kind: "converted", settings: converted.settings };
}

export function resolveDevelopOpenSettings(params: {
  cloudPhoto: Pick<PhotoLibraryPhoto, "developSettings">;
  baseVersion: string | null;
  /** 作業コピーのmetadata。signed baseでは省略不可。 */
  workMeta?: unknown;
  /**
   * 幾何（回転・反転・角度補正・切り抜き。`v: 2`）を扱える面か（既定 true）。NIHO Desktop の面は false で、幾何のある
   * `developSettings` を `newer`（閲覧だけ）で開く（移行元設計）。
   */
  geometry?: boolean;
}): DevelopOpenSettings {
  const { cloudPhoto, baseVersion } = params;
  let baseSettings: DevelopSettings | null = null;
  let settingsSource: DevelopOpenSettingsSource = "none";
  if (hasSavedDevelopSettings(cloudPhoto)) {
    if (!isEditableDevelopSettings(cloudPhoto.developSettings, { geometry: params.geometry })) return { kind: "newer" };
    baseSettings = readDevelopSettings(cloudPhoto.developSettings);
    // 形の版を読めない（保存のときにサーバーが弾く形）は、古い数式で読み替えず閲覧だけ
    if (!baseSettings) return { kind: "newer" };
    settingsSource = "develop";
  }
  try {
    return {
      kind: "settings",
      baseSettings:
        baseVersion === null ? baseSettings : developSettingsOnWorkingCopy(baseSettings, baseVersion, params.workMeta),
      settingsSource,
    };
  } catch (error) {
    if (error instanceof DevelopSettingsBaseMismatchError) return { kind: "baseMismatch" };
    throw error;
  }
}
