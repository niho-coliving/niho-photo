import {
  normalizeBrowserPhotoAdjustments,
  type BrowserPhotoAdjustments,
} from "../browser-photo-adjustments";
import { hasActiveDevelopEffects, isInactiveDevelopEffect } from "../photo-editing-effects";
import { PHOTO_EDITING_ZERO_DEFAULT_KEYS, isNeutralPhotoEditingSettings } from "../photo-editing-settings-neutral";

/**
 * NIHO の現像エンジンの編集内容 `developSettings`（移行元設計。移行時の設計文書「段 2」）。Photo Bench の
 * `EditSettings` の上位集合に `v`・`engine`・`look`・`base`・`geometry` を足したもの。ブラウザは基本補正の 13 項目（NIHO Photo 段 1
 * F1 移行元設計。S1 の canvas では露光量・コントラスト・彩度と相対の色温度 / 色かぶり補正だけ）を直し、ほかの項目（HSL など）はそのまま
 * 持って返す。形の版 `v` は、効果が有効なら 3、幾何（回転・反転・角度補正・切り抜き。F3 移行元設計）が恒等でなければ 2、ほかは 1
 * （古い画面は未知の版を編集も描画もしないので、効果や切り抜きを知らない画面が補正を落とした画を作らない）。
 */
/** API schemaの設定型（v1〜v3）を画面で扱う型。未知の項目はそのまま保持する。 */
export type DevelopSettings = {
  v: DevelopSettingsVersion;
  engine: string;
  [key: string]: unknown;
};

/**
 * JPEG / PNG をオリジナルから直接描く（`base: null`）写真と、raster の作業コピー（`raster.*`。HEIC / TIFF / 大きな JPEG）の上で
 * 直す写真の新規編集の数式（移行元設計）。niho-6 は RAW・camera-linear の作業コピーを拒むので、それ以外の新規編集は
 * {@link NIHO2_DEVELOP_SETTINGS_ENGINE}（{@link newDevelopSettingsEngine}）。signed RAW の新規既定は metadata を確認して別途選ぶ。
 * 保存済みの編集内容は、その数式のまま描き・直す（決まりごと 4。niho-1 / niho-2 を niho-6 に変えない）。
 */
export const DEVELOP_SETTINGS_ENGINE = "niho-6";
/**
 * niho-6 より前の新規編集の数式。今も unsigned の RAW の作業コピー（`raw-apple.*` の p0〜2 / e1）・作業コピーの無い RAW・版の
 * 分からない作業コピーの新規編集はこれ。niho-6 の neutral（H/S・自然な彩度・HSL の輝度・黒レベルを当てない）と同じ画になる。
 */
export const NIHO2_DEVELOP_SETTINGS_ENGINE = "niho-2";
/** 公開済み niho-2 wasm が旧式で描く保存済みの数式。編集時も無断で新式に変えない。 */
export const LEGACY_DEVELOP_SETTINGS_ENGINE = "niho-1";
/**
 * 新しく作る編集内容のルック（S8 移行元設計 の NIHO 標準ルック）。保存済みの編集内容はその `look` のまま描き、後から変えない
 * （S5 で直した写真は `niho-interim-1`）。
 */
export const DEVELOP_SETTINGS_LOOK = "niho-standard-1";
export const SIGNED_DEVELOP_SETTINGS_ENGINE = "niho-3";
export const SIGNED_DEVELOP_SETTINGS_LOOK = "niho-standard-2";
export const NIHO4_DEVELOP_SETTINGS_ENGINE = "niho-4";
export const NIHO4_DEVELOP_SETTINGS_LOOK = "niho-standard-3";
/** 対応校正済み signed RAW の新規編集で使う数式とルック（移行元設計）。保存済み niho-3 / niho-4 は昇格しない。 */
export const NIHO7_DEVELOP_SETTINGS_ENGINE = "niho-7";
export const NIHO7_DEVELOP_SETTINGS_LOOK = "niho-standard-5";
export const SIGNED_WORKING_COPY_ENCODING = "signed-gamma18-v1";
/** `look` を持たない保存済みの編集内容のルック（段 2 の crate が読むときの既定と同じ。恒等）。 */
export const DEVELOP_SETTINGS_LOOK_WHEN_MISSING = "niho-interim-1";
/** この画面の crate が描けるルックの版。 */
export const DEVELOP_SETTINGS_LOOKS: readonly string[] = [
  DEVELOP_SETTINGS_LOOK_WHEN_MISSING,
  DEVELOP_SETTINGS_LOOK,
  SIGNED_DEVELOP_SETTINGS_LOOK,
  NIHO4_DEVELOP_SETTINGS_LOOK,
  NIHO7_DEVELOP_SETTINGS_LOOK,
];
/** niho-6 が描けるルック（crate と同じ。無ければ {@link DEVELOP_SETTINGS_LOOK_WHEN_MISSING}）。 */
export const NIHO6_DEVELOP_SETTINGS_LOOKS: readonly string[] = [DEVELOP_SETTINGS_LOOK_WHEN_MISSING, DEVELOP_SETTINGS_LOOK];
/** raster の作業コピーの土台の版の頭（niho-6 で描ける作業コピー）。 */
const RASTER_WORKING_COPY_BASE_PREFIX = "raster.";

const NIHO4_CALIBRATION_PATTERN = /^apple-ciraw8\/linear-prophoto-d50\/cal-(?:panasonic-dc-s5|sony-zv-e10m2|sony-ilme-fx30)-apple-v[0-9]+$/u;

export function supportsNiho4SignedRaw(meta: unknown): boolean {
  return isRecord(meta) && typeof meta.dcpSha256 === "string" && NIHO4_CALIBRATION_PATTERN.test(meta.dcpSha256);
}

/** niho-7 を新規既定にできる、校正が既知の signed RAW metadata か。 */
export function supportsNiho7SignedRaw(meta: unknown): boolean {
  return supportsNiho4SignedRaw(meta);
}

const SIGNED_RAW_BASE_VERSION_PATTERN = /^raw-apple\.d[A-Za-z0-9]+\.p3\.e4\./u;
const LEGACY_RAW_BASE_VERSION_PATTERN = /^raw-apple\.d[A-Za-z0-9]+\.p[0-2]\.e1(?:\.|$)/u;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function numberOrZero(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

/** この画面が読む `developSettings` の形の版（1: 基本、2: 幾何あり、3: 効果あり）。 */
export type DevelopSettingsVersion = 1 | 2 | 3;

function isDevelopSettingsVersion(value: unknown): value is DevelopSettingsVersion {
  return value === 1 || value === 2 || value === 3;
}

/**
 * `geometry`（crate の `geometry.rs` の `is_identity`）が恒等でないか。回転（半回転と左右・上下の両方の反転は恒等）・角度・全体で
 * ない切り抜きのどれかがあれば true。縦横比の指定（`aspect`）だけなら恒等。形の壊れた値は恒等とみなさない（描けない設定として扱う）。
 */
export function hasDevelopGeometry(value: unknown): boolean {
  if (!isRecord(value)) return false;
  const geometry = value.geometry;
  if (geometry === undefined || geometry === null) return false;
  if (!isRecord(geometry)) return true;
  const rotate = geometry.rotate ?? 0;
  const flipH = geometry.flipH ?? false;
  const flipV = geometry.flipV ?? false;
  const turned = !(
    (rotate === 0 && flipH === false && flipV === false) ||
    (rotate === 180 && flipH === true && flipV === true)
  );
  const crop = geometry.crop ?? {};
  if (!isRecord(crop)) return true;
  const edge = (key: string, whole: number) => (crop[key] === undefined ? whole : crop[key]);
  const whole = edge("left", 0) === 0 && edge("top", 0) === 0 && edge("right", 1) === 1 && edge("bottom", 1) === 1;
  return turned || (geometry.angle ?? 0) !== 0 || !whole;
}

export function hasNullDevelopGeometryField(value: unknown): boolean {
  if (!isRecord(value) || !isRecord(value.geometry)) return false;
  const geometry = value.geometry;
  if (["rotate", "flipH", "flipV", "angle"].some((key) => Object.hasOwn(geometry, key) && geometry[key] === null)) return true;
  if (!Object.hasOwn(geometry, "crop")) return false;
  const crop = geometry.crop;
  if (crop === null) return true;
  return isRecord(crop) && ["left", "top", "right", "bottom"].some((key) => Object.hasOwn(crop, key) && crop[key] === null);
}

/** 編集内容に要る形の版（効果が有効なら 3、幾何が恒等でなければ 2。crate の `required_version`）。`developSettings` を書くときは常にこれにする。 */
export function developSettingsVersion(settings: Record<string, unknown>): DevelopSettingsVersion {
  if (hasActiveDevelopEffects(settings)) return 3;
  return hasDevelopGeometry(settings) ? 2 : 1;
}

/** 新しく作る編集内容の数式の選び方（{@link newDevelopSettingsEngine}）。 */
export type NewDevelopSettingsEngineOptions = {
  /**
   * RAW の写真（作業コピーの無い RAW など、`base` が null でも JPEG / PNG のオリジナルから直接描くのではない写真）なら true。
   * `base` によらず {@link NIHO2_DEVELOP_SETTINGS_ENGINE} にする（niho-6 は RAW を描かない）。
   */
  raw?: boolean;
};

/**
 * 新しく作る（保存したことの無い写真の）編集内容の数式（移行元設計）。JPEG / PNG をオリジナルから直接描く（`base: null`）・raster の
 * 作業コピー（`raster.*`）なら {@link DEVELOP_SETTINGS_ENGINE}（niho-6）、unsigned RAW の作業コピー（`raw-apple.*`）・版の分からない
 * 作業コピー・RAW の写真（`raw: true`）は {@link NIHO2_DEVELOP_SETTINGS_ENGINE}。signed RAW は {@link signedNeutralDevelopSettings}。
 */
export function newDevelopSettingsEngine(base: string | null, options: NewDevelopSettingsEngineOptions = {}): string {
  if (options.raw === true) return NIHO2_DEVELOP_SETTINGS_ENGINE;
  if (base === null || base.startsWith(RASTER_WORKING_COPY_BASE_PREFIX)) return DEVELOP_SETTINGS_ENGINE;
  return NIHO2_DEVELOP_SETTINGS_ENGINE;
}

/**
 * 何も当てていない編集内容（「初期化」はこれを保存する）。小さな JPEG / PNG はオリジナルから直接描くので `base: null`、作業コピー
 * から描く写真（RAW など。移行元設計）は作業コピーの `baseVersion` を渡す。数式は {@link newDevelopSettingsEngine} で `base` から決める
 * （`base: null` で RAW の写真を持ちうる呼び出し側は `{ raw: true }` を渡す）。
 */
export function neutralDevelopSettings(
  base: string | null = null,
  options: NewDevelopSettingsEngineOptions = {},
): DevelopSettings {
  return {
    v: 1,
    engine: newDevelopSettingsEngine(base, options),
    look: DEVELOP_SETTINGS_LOOK,
    base,
    exposure: 0,
    contrast: 0,
    saturation: 0,
    relativeTemperature: 0,
    relativeTint: 0,
    whiteBalance: { mode: "asShot" },
  };
}

/** 未保存 signed RAW の初期化。対応校正だけ niho-7、その他は niho-3。 */
export function signedNeutralDevelopSettings(base: string, meta?: unknown): DevelopSettings {
  const niho7 = supportsNiho7SignedRaw(meta);
  return {
    ...neutralDevelopSettings(base),
    engine: niho7 ? NIHO7_DEVELOP_SETTINGS_ENGINE : SIGNED_DEVELOP_SETTINGS_ENGINE,
    look: niho7 ? NIHO7_DEVELOP_SETTINGS_LOOK : SIGNED_DEVELOP_SETTINGS_LOOK,
  };
}

export type SignedWorkingCopyState = "signed" | "unsigned" | "mismatch";

/** signed の判定はこのhelperだけで行い、baseとmetadataの片方だけ一致する入力を拒否する。 */
export function signedWorkingCopyState(baseVersion: unknown, meta: unknown): SignedWorkingCopyState {
  const signedBase = typeof baseVersion === "string" && SIGNED_RAW_BASE_VERSION_PATTERN.test(baseVersion);
  let metadataState: "signed_raw" | "legacy_raw" | "raster" | "legacy_unknown" | "absent" | "invalid";
  if (meta === undefined || meta === null) {
    metadataState = "absent";
  } else if (!isRecord(meta)) {
    metadataState = "invalid";
  } else if (meta.kind === "raw") {
    if (meta.encoding === undefined || meta.encoding === null) {
      metadataState = "legacy_raw";
    } else if (isRecord(meta.encoding)) {
      const keys = Object.keys(meta.encoding);
      const ceiling = meta.encoding.ceiling;
      metadataState =
        keys.length === 2 &&
        keys.includes("kind") &&
        keys.includes("ceiling") &&
        meta.encoding.kind === SIGNED_WORKING_COPY_ENCODING &&
        typeof ceiling === "number" &&
        Number.isFinite(ceiling) &&
        Number.isInteger(ceiling) &&
        ceiling >= 1 &&
        ceiling <= 65_536 &&
        (ceiling & (ceiling - 1)) === 0
          ? "signed_raw"
          : "invalid";
    } else {
      metadataState = "invalid";
    }
  } else if (meta.kind === "raster") {
    metadataState = meta.encoding === undefined || meta.encoding === null || meta.encoding === "jpeg8" ? "raster" : "invalid";
  } else if (!Object.hasOwn(meta, "kind") && !Object.hasOwn(meta, "encoding")) {
    metadataState = "legacy_unknown";
  } else {
    metadataState = "invalid";
  }
  if (metadataState === "invalid") return "mismatch";
  if (signedBase) return metadataState === "signed_raw" ? "signed" : "mismatch";
  if (metadataState === "signed_raw") return "mismatch";
  if (typeof baseVersion === "string" && baseVersion.startsWith("raw-apple.")) {
    return LEGACY_RAW_BASE_VERSION_PATTERN.test(baseVersion) && (metadataState === "legacy_raw" || metadataState === "absent")
      ? "unsigned"
      : "mismatch";
  }
  if (typeof baseVersion === "string" && baseVersion.startsWith("raster.")) {
    return metadataState === "raster" || metadataState === "absent" ? "unsigned" : "mismatch";
  }
  return metadataState === "legacy_unknown" || metadataState === "legacy_raw" || metadataState === "raster" || metadataState === "absent"
    ? "unsigned"
    : "mismatch";
}

export class DevelopSettingsBaseMismatchError extends Error {
  constructor(readonly reason: "base_mismatch" | "signed_mismatch" | "engine_mismatch") {
    super(reason);
    this.name = "DevelopSettingsBaseMismatchError";
  }
}

/**
 * 作業コピー（`baseVersion`）の上で直す編集内容にする（移行元設計）。設定が無ければその版の neutral（NIHO 標準ルック。数式は
 * raster の作業コピーなら niho-6、unsigned RAW なら niho-2、signed RAW なら niho-3 / niho-4 / niho-7）。保存済みの nonempty `base` があれば
 * 同じ版だけを使い、新しい版へ無言で上書きしない。数式・ルックも保存済みの版のまま（S8 移行元設計）。niho-6 の保存済みの設定は
 * raster の作業コピーの上でだけ開く（RAW・版の分からない作業コピーの上では `engine_mismatch`。移行元設計）。
 */
export function developSettingsOnWorkingCopy(
  settings: DevelopSettings | null,
  baseVersion: string,
  meta?: unknown,
): DevelopSettings {
  const signed = signedWorkingCopyState(baseVersion, meta);
  if (signed === "mismatch") throw new DevelopSettingsBaseMismatchError("signed_mismatch");
  if (!settings) return signed === "signed" ? signedNeutralDevelopSettings(baseVersion, meta) : neutralDevelopSettings(baseVersion);
  if (typeof settings.base === "string" && settings.base.length > 0 && settings.base !== baseVersion) {
    throw new DevelopSettingsBaseMismatchError("base_mismatch");
  }
  // niho-6 は RAW・camera-linear の作業コピーを描かない（crate の IncompatibleWorkingCopy）。描けないルックとの組も開かない
  if (
    settings.engine === DEVELOP_SETTINGS_ENGINE &&
    (!baseVersion.startsWith(RASTER_WORKING_COPY_BASE_PREFIX) || !isNiho6Look(settings.look))
  ) {
    throw new DevelopSettingsBaseMismatchError("engine_mismatch");
  }
  const signedEngine = settings.engine === SIGNED_DEVELOP_SETTINGS_ENGINE;
  const signedLook = settings.look === SIGNED_DEVELOP_SETTINGS_LOOK;
  const niho4Engine = settings.engine === NIHO4_DEVELOP_SETTINGS_ENGINE;
  const niho4Look = settings.look === NIHO4_DEVELOP_SETTINGS_LOOK;
  const niho7Engine = settings.engine === NIHO7_DEVELOP_SETTINGS_ENGINE;
  const niho7Look = settings.look === NIHO7_DEVELOP_SETTINGS_LOOK;
  if (signedEngine !== signedLook || niho4Engine !== niho4Look || niho7Engine !== niho7Look ||
      (signed === "signed") !== (signedEngine || niho4Engine || niho7Engine) ||
      ((niho4Engine || niho7Engine) && !supportsNiho7SignedRaw(meta))) {
    if (signed === "unsigned" && !baseVersion.startsWith("raw-apple.") && signedEngine && signedLook) {
      // niho-3 raster は既存の対応済み仕様。RAW以外では保持する。
    } else {
      throw new DevelopSettingsBaseMismatchError("engine_mismatch");
    }
  }
  const next = { ...settings, base: baseVersion, look: settings.look ?? DEVELOP_SETTINGS_LOOK_WHEN_MISSING };
  return { ...next, v: developSettingsVersion(next) };
}

/** API の値を編集内容として読む（形の版が 1〜3 でなければ null）。 */
export function readDevelopSettings(value: unknown): DevelopSettings | null {
  if (!isRecord(value) || !isDevelopSettingsVersion(value.v)) return null;
  const engine = value.engine;
  if (typeof engine !== "string") return null;
  return { ...value, v: value.v, engine };
}

/**
 * このブラウザの版で続きを直せる編集内容か。まだ無い（null）なら直せる。形の版が 1〜3 で数式の版がこの画面の知っている版
 * （niho-1 / niho-2 / niho-3 / niho-4 / niho-6 / niho-7）、ルックがその数式の描ける版（無ければ恒等。niho-6 は interim-1 / standard-1 だけ）の
 * ときだけ直せる（新しい版の NIHO で保存した設定を古い数式・ルックで読み替えない）。恒等でない
 * 幾何を v1 で持つ壊れた設定は直さない。幾何を扱えない面（NIHO Desktop。移行元設計）は `{ geometry: false }` を渡し、幾何のある設定を
 * 閲覧だけにする（切り抜きを落として描かない・保存しない）。
 */
export function isEditableDevelopSettings(value: unknown, options: { geometry?: boolean } = {}): boolean {
  if (value === null || value === undefined) return true;
  if (!isRecord(value) || !isDevelopSettingsVersion(value.v)) return false;
  const legacyEngine = value.engine === NIHO2_DEVELOP_SETTINGS_ENGINE || value.engine === LEGACY_DEVELOP_SETTINGS_ENGINE;
  const niho6Engine = value.engine === DEVELOP_SETTINGS_ENGINE;
  const signedEngine = value.engine === SIGNED_DEVELOP_SETTINGS_ENGINE;
  const niho4Engine = value.engine === NIHO4_DEVELOP_SETTINGS_ENGINE;
  const niho7Engine = value.engine === NIHO7_DEVELOP_SETTINGS_ENGINE;
  if (!legacyEngine && !niho6Engine && !signedEngine && !niho4Engine && !niho7Engine) return false;
  if (value.v < developSettingsVersion(value)) return false;
  if (value.look !== undefined && (typeof value.look !== "string" || !DEVELOP_SETTINGS_LOOKS.includes(value.look))) return false;
  // niho-6 は NIHO 標準ルック（standard-1）と恒等（interim-1・無し）だけを描く
  if (niho6Engine && !isNiho6Look(value.look)) return false;
  if (signedEngine !== (value.look === SIGNED_DEVELOP_SETTINGS_LOOK)) return false;
  if (niho4Engine !== (value.look === NIHO4_DEVELOP_SETTINGS_LOOK)) return false;
  if (niho7Engine !== (value.look === NIHO7_DEVELOP_SETTINGS_LOOK)) return false;
  return options.geometry !== false || !hasDevelopGeometry(value);
}

/** niho-6 が描けるルックか（無ければ恒等のルックとして描ける）。 */
function isNiho6Look(look: unknown): boolean {
  return look === undefined || (typeof look === "string" && NIHO6_DEVELOP_SETTINGS_LOOKS.includes(look));
}

/**
 * 右パネルの「初期化」で保存する編集内容: 色の補正だけを neutral に戻し、幾何（切り抜き・回転）と形の版は保つ（F3 移行元設計「初期化は
 * 色だけを戻し、切り抜きは戻さない」）。効果（白黒・周辺光量補正・粒子）も色の補正として外す（「補正前」の画も同じ）。`engine`・`look` は
 * 現在の数式とルックのまま保ち（今の編集内容が無ければ `base` の neutral と同じ数式。{@link newDevelopSettingsEngine}）、`base` は今の
 * 作業コピーの版（小さな JPEG / PNG は null）。
 */
export function resetDevelopSettingsColors(current: DevelopSettings | null, base: string | null): DevelopSettings {
  const neutral: DevelopSettings = neutralDevelopSettings(base);
  if (current) neutral.engine = current.engine;
  if (current && current.look === undefined) delete neutral.look;
  else if (current) neutral.look = current.look;
  if (!current || !isRecord(current.geometry)) return neutral;
  const next = { ...neutral, geometry: current.geometry };
  return { ...next, v: developSettingsVersion(next) };
}

/**
 * プリセットを当てた結果（crate の `presetSettings`）を、当てる前の編集内容 `base` の枠に入れる（F2b 移行元設計）。プリセットは色の
 * 補正だけを変え、ルック・土台の版（`look`・`base`）と幾何（切り抜き・回転）は当てる前のまま保つ
 * （`engine` は通常 base のまま。旧式 niho-1 の写真に非 0 の増分 WB を当てたときの Rust の `niho-2` 昇格だけ保持する。niho-3 /
 * niho-4 / niho-6 の写真は Rust も昇格させない）
 * （移行時の設計文書「プリセットの適用量・書き出し・見本」）。形の版 `v` は保った幾何から決め直す。効果
 * （`grayscale`・`grayMixer`・`vignette`・`grain`）は色の補正と同じくプリセットの結果のまま入れる（モノクロのプリセットを当てると
 * 白黒になる。E1b 移行元設計）。
 */
export function presetDevelopSettings(base: DevelopSettings, presetResult: DevelopSettings): DevelopSettings {
  const next: Record<string, unknown> = { ...presetResult, base: base.base ?? null };
  if (base.look === undefined) delete next.look;
  else next.look = base.look;
  if (isRecord(base.geometry)) next.geometry = base.geometry;
  else delete next.geometry;
  const promoted =
    presetResult.engine === NIHO2_DEVELOP_SETTINGS_ENGINE && base.engine === LEGACY_DEVELOP_SETTINGS_ENGINE;
  return { ...next, v: developSettingsVersion(next), engine: promoted ? NIHO2_DEVELOP_SETTINGS_ENGINE : base.engine };
}

/**
 * 「自動」の結果（crate の `Developer.autoSettings`。F4a 移行元設計）を、押す前の編集内容 `before` の枠に入れる（F4b 移行元設計）。crate は
 * ライト 6 本と自然な彩度だけを変えてほかのキーは渡したまま返すが、画面でも数式の版・ルック・土台の版（`engine`・`look`・`base`）・
 * 幾何（切り抜き・回転）と効果（`grayscale`・`grayMixer`・`vignette`・`grain`）を押す前のものにそろえる（プリセットと違い、自動は
 * 白黒にしない）。形の版 `v` は保った幾何から決め直す。
 */
export function autoDevelopSettings(before: DevelopSettings, autoResult: DevelopSettings): DevelopSettings {
  const next: Record<string, unknown> = { ...presetDevelopSettings(before, autoResult) };
  for (const key of DEVELOP_EFFECT_SETTINGS_KEYS) {
    if (before[key] === undefined) delete next[key];
    else next[key] = before[key];
  }
  return { ...next, v: developSettingsVersion(next), engine: before.engine };
}

/**
 * コピーした補正（「補正をコピー」。F5a-2 移行元設計）。色の補正（HSL・効果など、この画面が知らない項目も含む全部）を持ち、貼り付け先の
 * ものを保つ項目（数式の版・ルック・土台の版・幾何）は持たない。RAW の絶対のホワイトバランス（撮影時の白との絶対値で、写真ごとの
 * 値）も写さない。
 */
export type CopiedDevelopSettings = Record<string, unknown>;

export function copyDevelopSettings(settings: DevelopSettings): CopiedDevelopSettings {
  const { v: _v, engine: _engine, look: _look, base: _base, geometry: _geometry, ...rest } = settings;
  const copied: CopiedDevelopSettings = { ...rest };
  if (isRecord(copied.whiteBalance) && copied.whiteBalance.mode === "absolute") delete copied.whiteBalance;
  return copied;
}

/**
 * コピーした補正を今の編集内容 `base` に貼り付けた結果（「補正を貼り付け」。取り消しの 1 単位で確定する）。色の補正はコピーした
 * 全部に置き換え（コピーに無い項目は neutral）、数式の版・ルック・土台の版と幾何（切り抜き・回転）は貼り付け先のまま。ホワイト
 * バランスは、コピーに無い（RAW の絶対値だった）とき・貼り付け先が絶対値（RAW で撮影時の白から直した）ときは mode と相対値を含めて貼り付け先のまま。
 * 形の版 `v` は保った幾何から決め直す。
 */
export function pasteDevelopSettings(base: DevelopSettings, copied: CopiedDevelopSettings): DevelopSettings {
  const baseVersion = typeof base.base === "string" ? base.base : null;
  const next: Record<string, unknown> = { ...neutralDevelopSettings(baseVersion), ...copied, base: baseVersion };
  if (base.look === undefined) delete next.look;
  else next.look = base.look;
  if (isRecord(base.geometry)) next.geometry = base.geometry;
  else delete next.geometry;
  const baseWhiteBalance = isRecord(base.whiteBalance) ? base.whiteBalance : null;
  if (copied.whiteBalance === undefined || baseWhiteBalance?.mode === "absolute") {
    if (baseWhiteBalance) next.whiteBalance = baseWhiteBalance;
    else delete next.whiteBalance;
    if (base.relativeTemperature === undefined) delete next.relativeTemperature;
    else next.relativeTemperature = base.relativeTemperature;
    if (base.relativeTint === undefined) delete next.relativeTint;
    else next.relativeTint = base.relativeTint;
  }
  return { ...next, v: developSettingsVersion(next), engine: base.engine };
}

/** 編集内容から、ブラウザのスライダーの値を読む（無い項目は 0）。 */
export function readBrowserAdjustmentsFromDevelopSettings(settings: DevelopSettings | null): BrowserPhotoAdjustments {
  const source: Record<string, unknown> = settings ?? {};
  return normalizeBrowserPhotoAdjustments({
    exposure: numberOrZero(source.exposure),
    contrast: numberOrZero(source.contrast),
    saturation: numberOrZero(source.saturation),
    temperature: numberOrZero(source.relativeTemperature),
    tint: numberOrZero(source.relativeTint),
  });
}

/**
 * スライダーの値を編集内容に重ねる。土台（`base`。無ければ JPEG / PNG をオリジナルから直接描く neutral〔niho-6〕。RAW の写真は
 * `neutralDevelopSettings(null, { raw: true })` を土台に渡す）の知らない項目は残す。相対の色温度 / 色かぶり補正を
 * 動かしたら `whiteBalance.mode` を `relative` にし（段 2 はそれを求める）、両方 0 に戻したら撮影時（`asShot`）に戻す。
 */
export function applyBrowserAdjustmentsToDevelopSettings(
  base: DevelopSettings | null,
  adjustments: BrowserPhotoAdjustments,
): DevelopSettings {
  const source = base ?? neutralDevelopSettings();
  const value = normalizeBrowserPhotoAdjustments(adjustments);
  const baseWhiteBalance = isRecord(source.whiteBalance) ? source.whiteBalance : null;
  let whiteBalance: Record<string, unknown>;
  if (value.temperature !== 0 || value.tint !== 0) {
    whiteBalance = { ...(baseWhiteBalance ?? {}), mode: "relative" };
  } else if (baseWhiteBalance?.mode === "relative") {
    whiteBalance = { ...baseWhiteBalance, mode: "asShot" };
  } else {
    whiteBalance = baseWhiteBalance ?? { mode: "asShot" };
  }
  return {
    ...source,
    v: developSettingsVersion(source),
    engine: source.engine,
    look: source.look === undefined ? DEVELOP_SETTINGS_LOOK_WHEN_MISSING : source.look,
    base: source.base === undefined ? null : source.base,
    exposure: value.exposure,
    contrast: value.contrast,
    saturation: value.saturation,
    relativeTemperature: value.temperature,
    relativeTint: value.tint,
    whiteBalance,
  };
}

/**
 * ブラウザで直し始める編集内容（開いたときの土台。無ければ JPEG / PNG を直接描く neutral）。版の情報をそろえ、露光量・コントラスト・彩度と相対の白を
 * 範囲に収め、相対の白と `whiteBalance.mode` を合わせる（段 2 の `modeMismatch` を避ける）。ほかの項目はそのまま持つ。
 */
export function browserEditingDevelopSettings(base: DevelopSettings | null): DevelopSettings {
  return applyBrowserAdjustmentsToDevelopSettings(base, readBrowserAdjustmentsFromDevelopSettings(base));
}

function canonicalValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalValue);
  if (!isRecord(value)) return value;
  const result: Record<string, unknown> = {};
  for (const key of Object.keys(value).sort()) {
    if (value[key] !== undefined) result[key] = canonicalValue(value[key]);
  }
  return result;
}

/**
 * 編集内容を比べるための文字列。キーの順を問わず、0 が既定の調整項目（露光量・ハイライトなど）は無いのと 0 を同じにする
 * （スライダーを 0 のまま離した・0 でダブルクリックしたときに、変わったと数えない）。
 */
export function developSettingsKey(settings: DevelopSettings): string {
  const record: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(settings)) {
    if (value === undefined || (PHOTO_EDITING_ZERO_DEFAULT_KEYS.has(key) && value === 0)) continue;
    record[key] = value;
  }
  return JSON.stringify(canonicalValue(record));
}

/** 2 つの編集内容が同じか（{@link developSettingsKey} で比べる）。 */
export function sameDevelopSettings(a: DevelopSettings, b: DevelopSettings): boolean {
  return a === b || developSettingsKey(a) === developSettingsKey(b);
}

/** 版の情報（見た目を変えない）。 */
const DEVELOP_METADATA_KEYS: ReadonlySet<string> = new Set(["v", "engine", "look", "base"]);

/** 0 でない既定値を持つ項目（既定値なら何も当てていない）。 */
const DEVELOP_DEFAULT_VALUES: ReadonlyMap<string, number> = new Map([
  ["parametricShadowSplit", 25],
  ["parametricMidtoneSplit", 50],
  ["parametricHighlightSplit", 75],
  ["curveRefineSaturation", 100],
]);

/**
 * 何も当てていない編集内容か（無ければ true）。恒等でない幾何（切り抜き・回転）があれば neutral にしない（オリジナルのままでは
 * 見せられない）。版の情報と既定値の項目を除き、残りを Photo Bench の neutral の判定にかける（分からない項目があれば neutral とみなさ
 * ない）。変換できなかった値（`legacySettings`）があれば neutral にしない。相対の色温度 / 色かぶり補正が 0 なら、
 * `whiteBalance.mode` が `relative` でも撮影時のままとみなす。
 */
export function isNeutralDevelopSettings(value: unknown): boolean {
  if (hasDevelopGeometry(value)) return false;
  return isNeutralDevelopColors(value);
}

/**
 * 色の補正が何も当たっていないか（幾何は見ない。右パネルの「初期化」を押せるかに使う。初期化は色だけを戻し、切り抜きは戻さない）。
 * ほかは {@link isNeutralDevelopSettings} と同じ。効果（白黒・周辺光量補正・粒子。E1 移行元設計）は crate の `is_neutral` と同じ規則で
 * 数える: 白黒がオン・周辺光量補正か粒子の量が 0 でなければ neutral にしない（量が 0 の `vignette` / `grain` と、白黒でないときの
 * `grayMixer` は画に効かないので neutral のまま）。
 */
export function isNeutralDevelopColors(value: unknown): boolean {
  if (value === null || value === undefined) return true;
  if (!isRecord(value)) return false;
  if (value.legacySettings !== undefined && value.legacySettings !== null) return false;
  const rest: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(value)) {
    if (DEVELOP_METADATA_KEYS.has(key) || key === "legacySettings" || key === "geometry") continue;
    if (DEVELOP_DEFAULT_VALUES.has(key) && item === DEVELOP_DEFAULT_VALUES.get(key)) continue;
    // 画に効いていない効果の項目は除く（効いている・形の壊れた項目は残り、下の判定で neutral にならない）
    if (isInactiveDevelopEffect(key, item) === true) continue;
    rest[key] = item;
  }
  const whiteBalance = rest.whiteBalance;
  if (
    isRecord(whiteBalance) &&
    whiteBalance.mode === "relative" &&
    numberOrZero(rest.relativeTemperature) === 0 &&
    numberOrZero(rest.relativeTint) === 0
  ) {
    rest.whiteBalance = { ...whiteBalance, mode: "asShot" };
  }
  return isNeutralPhotoEditingSettings(rest);
}

/**
 * クラウドの写真に補正（`developSettings`）を保存してあるか。補正の置き場は `developSettings` の 1 つで、旧エンジン（Photo Bench）の
 * `settings` は読まない（K1c 移行元設計。保存したことの無い写真は補正なし）。neutral かどうかは見ない（「初期化」も保存した補正）。
 */
export function hasSavedDevelopSettings(photo: { developSettings?: unknown }): boolean {
  return isRecord(photo.developSettings);
}

/** Photo Bench `EditSettings` の既知の top-level の項目（`developSettings` から Photo Bench の形へ戻すときに残す）。 */
const EDIT_SETTINGS_KEYS: readonly string[] = [
  "exposure",
  "contrast",
  "highlights",
  "shadows",
  "whites",
  "blacks",
  "texture",
  "clarity",
  "dehaze",
  "vibrance",
  "saturation",
  "relativeTemperature",
  "relativeTint",
  "toneCurves",
  "hsl",
  "calibration",
  "colorGrading",
  "parametricShadows",
  "parametricDarks",
  "parametricLights",
  "parametricHighlights",
  "parametricShadowSplit",
  "parametricMidtoneSplit",
  "parametricHighlightSplit",
  "curveRefineSaturation",
];

/** 旧エンジン（Photo Bench）の形に無い、NIHO の効果のキー。 */
const DEVELOP_EFFECT_SETTINGS_KEYS = ["grayscale", "grayMixer", "vignette", "grain"] as const;

/**
 * `developSettings` を Photo Bench `EditSettings` の形へ戻す（NIHO Desktop の面が、クラウドに結び付いたこの Mac の写真を Photo Bench で
 * 描くとき・原寸の書き出しのときに使う。crate の `convert::to_edit_settings_value` と同じ規則）。版の情報（`v`・`engine`・`look`・`base`）と知らない項目は落とし、白は
 * `absolute` → `custom`、ほか（撮影時・相対）→ `asShot`（相対の値はそのまま残る）。作業コピーの上で直した RAW などの補正
 * （`base` がある。移行元設計）も同じ規則で戻し、Desktop は自分の土台で描く（owner 決定 2026-09-29「写真 1 枚に補正 1 つ」）。
 * 変換できなかった値（`legacySettings`）か恒等でない幾何があれば戻せないので null。
 */
export function developSettingsToEditSettings(value: unknown): Record<string, unknown> | null {
  const settings = readDevelopSettings(value);
  if (!settings) return null;
  if (settings.legacySettings !== undefined && settings.legacySettings !== null) return null;
  // 旧エンジンの形は幾何を持てない（切り抜き・回転を落として写さない。移行元設計）
  if (hasDevelopGeometry(settings)) return null;
  // 効いている効果（白黒・周辺光量補正・粒子。E1 移行元設計）も旧エンジンの形に無い。落として写すと、白黒の写真が色つきで出る
  if (DEVELOP_EFFECT_SETTINGS_KEYS.some((key) => isInactiveDevelopEffect(key, settings[key]) === false)) return null;
  const result: Record<string, unknown> = {};
  for (const key of EDIT_SETTINGS_KEYS) {
    if (settings[key] !== undefined) result[key] = settings[key];
  }
  const whiteBalance = isRecord(settings.whiteBalance) ? settings.whiteBalance : null;
  const nextWhiteBalance: Record<string, unknown> = { mode: whiteBalance?.mode === "absolute" ? "custom" : "asShot" };
  for (const key of ["temperature", "tint"]) {
    const item = whiteBalance?.[key];
    if (typeof item === "number" && Number.isFinite(item)) nextWhiteBalance[key] = item;
  }
  result.whiteBalance = nextWhiteBalance;
  return result;
}
