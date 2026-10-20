import { parseDevelopEngineManifest } from "./develop-engine-manifest";

/**
 * 段 2 の wasm を動かす Web Worker の中身（移行元設計。移行時の設計文書「段 2」）。テストできるよう、
 * fetch・glue の読み込み・postMessage を外から渡す（Worker の殻は `develop-engine.worker.ts`）。
 *
 * - 通常のメッセージは受け取った順に 1 つずつ処理する（前の処理が失敗しても後は止めない）。自動の先読みだけは別枠で待たせ、通常の
 *   要求が来ている間は動かさず、取り消し・昇格を受け付ける
 * - `init` で manifest を読み、glue（wasm-bindgen `--target web`）を読み込んで wasm を起こす。どこかで失敗したら `unavailable`
 *   を返し、以後の要求はすべて `error`（呼び出し側は S1 の canvas に戻る）
 * - `open` は 1 回デコードして持つ（`Developer`）。前の写真は手放す。`render` はそれで描き、`exportJpeg` は持っている写真を
 *   変えずに別の bytes から描く（記事用の画像・書き出し）
 * - `openWorkingCopy` は作業コピー（16bit PNG とメタデータの JSON。RAW など、移行元設計）を開いて持つ（`open` と同じく前の写真は
 *   手放す。作業コピーは長辺 2560px のまま持ち、描く大きさは `render` で決める）。`exportWorkingCopyJpeg` は持っている写真を
 *   変えずに、別の作業コピーを一時的に開いて丁寧に描き（final）、`OffscreenCanvas` で JPEG にする（sRGB・撮影情報なし）。
 *   `OffscreenCanvas` が無ければ画素（`frame`）を返し、メインスレッドが canvas で JPEG にする
 * - 画素・JPEG の bytes は ArrayBuffer ごと transfer する（wasm の memory を指していればコピーしてから）
 * - `convertEditSettings` は Photo Bench `EditSettings` を crate の版付きの変換で `developSettings` にする（作業コピーの上で直す
 *   写真はその `baseVersion` を渡す。結果は JSON のまま返す）
 * - `presetSettings` は XMP のプリセットを `developSettings`（無ければ neutral）に当てた結果、`builtinPresets` は crate に同梱した
 *   プリセットの一覧を JSON のまま返す（NIHO Desktop の段 2 の写真。移行元設計 S7b）。glue に無ければ error（ほかは使える）
 * - 幾何（切り抜き・回転。F3 移行元設計）の口 `imageSize`・`rasterDecodeSize`・`geometryOutputSize`・`beforeSettings`（crate 0.5.0 から）が
 *   glue に揃っていれば `ready` に `geometry: true` を付ける。無い glue では 3 つの要求は error（ほかは使える）。`imageSize` の bytes は
 *   コピーで受け取る（呼び出し側は同じ bytes をこの後 `open` に渡す）
 * - `withCaptureExif` は書き出しの JPEG に NIHO の EXIF（撮影日時・向き 1・sRGB。位置情報・カメラは付けず、前の EXIF は外す。
 *   F7a 移行元設計 / F7b 移行元設計）を付けた JPEG を返す（crate 0.5.0 から。transfer）。glue に無ければ error（呼び出し側は EXIF 無しで続ける）
 * - 効果（白黒・周辺光量補正・粒子。E1 移行元設計）のある設定は `v: 3` で保存する。`v: 3` を読めない wasm は描画を断る
 *   （`unsupportedVersion`）ので、起こした wasm に `validateSettings` で小さな `v: 3` の設定を確かめさせ、読めるときだけ `ready` に
 *   `effects: true` を付ける（crate の版の比較では、画面と wasm の公開が前後したときに食い違った。移行元設計）
 * - プリセットの適用量・書き出し・見本（F2a 移行元設計 の口。crate 0.5.0 から）: `applyPreset`（開いている写真の撮影時の白
 *   `asShotWhite()` を渡す）・`settingsToXmp`・`renderPresetThumbnail`（開いている写真の `thumbnail(256)` の別の session を初回に
 *   作って持ち、丁寧に〔final〕描く。親のengine/CNR設定が変わったら手放し、次回に現在の解析から作り直す。写真を手放すと一緒に手放す）。口が glue にあれば `ready` に `presetAmount` /
 *   `settingsToXmp` / `presetThumbnails` の true を付け、無い glue では要求は error（ほかは使える）
 * - 開いている写真なしのプリセット（一覧の一括。F5a-2 移行元設計）: `applyPreset` に `asShotMetaJson` が付いていれば、開いている
 *   写真の白は見ず、作業コピーのメタ（文字列）から `asShotWhiteFromMeta` で撮影時の白を引く（`null` は撮影時の白なし＝JPEG / PNG）。
 *   付いていなければ今までどおり開いている写真の白。`applyPreset` と `asShotWhiteFromMeta` が glue に揃っていれば `ready` に
 *   `presetFromMeta: true` を付け、無い glue でメタを渡すと error（開いている写真の白で当てて取り違えない）
 * - 自動（F4a 移行元設計 の口）: `autoSettings` は開いている写真の `Developer.autoSettings(settingsJson)` で、今の設定からライト 6 本と
 *   自然な彩度だけを決めた設定の JSON をそのまま返す（通常要求は順に処理し、先読みは低優先度で遅らせて取り消し・昇格できる）。
 *   `Developer` に口があれば `ready` に `auto: true` を付け、無い glue・写真を開いていなければ error（ほかは使える）
 */

export type DevelopEngineWorkerRequest =
  | { type: "init"; id: number; manifestUrl: string; diagnostics?: boolean }
  | { type: "open"; id: number; bytes: ArrayBuffer; workingMaxDimension: number }
  | { type: "render"; id: number; settingsJson: string; maxDimension: number; interactive: boolean }
  | {
      type: "exportJpeg";
      id: number;
      bytes: ArrayBuffer;
      settingsJson: string;
      maxDimension: number;
      quality: number;
    }
  | { type: "openWorkingCopy"; id: number; png: ArrayBuffer; metaJson: string }
  | {
      type: "exportWorkingCopyJpeg";
      id: number;
      png: ArrayBuffer;
      metaJson: string;
      settingsJson: string;
      maxDimension: number;
      quality: number;
    }
  | { type: "close"; id: number }
  | { type: "convertEditSettings"; id: number; editSettingsJson: string; baseVersion?: string | null }
  | { type: "presetSettings"; id: number; xmp: string; baseSettingsJson: string | null }
  | { type: "builtinPresets"; id: number }
  | { type: "imageSize"; id: number; bytes: ArrayBuffer }
  | {
      type: "rasterDecodeSize";
      id: number;
      settingsJson: string;
      width: number;
      height: number;
      maxDimension: number;
      cap: number;
    }
  | {
      type: "geometryOutputSize";
      id: number;
      settingsJson: string;
      sourceWidth: number;
      sourceHeight: number;
      maxDimension: number;
    }
  | {
      type: "applyPreset";
      id: number;
      xmp: string;
      baseSettingsJson: string;
      amount: number;
      /**
       * 撮影時の白の出どころ（F5a-2 移行元設計）。省くと開いている写真の白、文字列は作業コピーのメタの JSON（`asShotWhiteFromMeta`
       * で引く）、null は撮影時の白なし（JPEG / PNG。開いている写真の白も使わない）
       */
      asShotMetaJson?: string | null;
    }
  | { type: "settingsToXmp"; id: number; settingsJson: string; optionsJson: string }
  | { type: "renderPresetThumbnail"; id: number; settingsJson: string; maxDimension: number }
  | { type: "withCaptureExif"; id: number; bytes: ArrayBuffer; capturedAt: string; offsetMinutes: number }
  | { type: "autoSettings"; id: number; settingsJson: string }
  /** pointer/focus の先読み。通常要求が待っていれば後へ回す。 */
  | { type: "warmAutoSettings"; id: number; settingsJson: string }
  | { type: "promoteAutoSettings"; id: number }
  | { type: "cancelAutoSettings"; id: number };

/** glue にある口（`ready` に付ける。無い口は付けない）。 */
export type DevelopEngineWorkerFeatures = {
  /** 幾何の口が揃っている（F3 移行元設計） */
  geometry?: true;
  /** wasm が効果のある設定（`v: 3`）を読める（E1b 移行元設計） */
  effects?: true;
  /** `applyPreset`（プリセットの適用量。F2a 移行元設計） */
  presetAmount?: true;
  /** `settingsToXmp`（今の補正をプリセットに書き出す） */
  settingsToXmp?: true;
  /** `Developer.thumbnail`（プリセットの見本の別の session） */
  presetThumbnails?: true;
  /** `Developer.autoSettings`（「自動」。F4a 移行元設計） */
  auto?: true;
  /** `applyPreset` と `asShotWhiteFromMeta`（開いている写真なしでプリセットを当てる。一覧の一括。F5a-2 移行元設計） */
  presetFromMeta?: true;
};

export type DevelopEngineWorkerResponse =
  | { type: "perf"; id: 0; record: DevelopEnginePerfRecord }
  | ({ type: "ready"; id: number; version: string } & DevelopEngineWorkerFeatures)
  | { type: "unavailable"; id: number; reason: string }
  | { type: "opened"; id: number; width: number; height: number }
  | { type: "frame"; id: number; width: number; height: number; rgba: ArrayBuffer }
  /** `exportJpeg`・`exportWorkingCopyJpeg`・`withCaptureExif` の JPEG */
  | { type: "jpeg"; id: number; bytes: ArrayBuffer }
  | { type: "closed"; id: number }
  | { type: "converted"; id: number; resultJson: string }
  | { type: "preset"; id: number; resultJson: string }
  | { type: "builtinPresets"; id: number; presetsJson: string }
  /** `imageSize`（向きを反映した元の寸法）・`geometryOutputSize`（描かずに出力の寸法） */
  | { type: "size"; id: number; width: number; height: number }
  /** `rasterDecodeSize`（切り抜きが要求の大きさに届く作業サイズ＝`open` の長辺） */
  | { type: "decodeSize"; id: number; size: number }
  /** `settingsToXmp` の結果（`{ xmp, notWritten }` の JSON のまま） */
  | { type: "xmp"; id: number; resultJson: string }
  /** `autoSettings` の結果（完成した設定の JSON のまま） */
  | { type: "auto"; id: number; settingsJson: string }
  | { type: "error"; id: number; message: string };

export type DevelopEngineWorkerDeps = {
  fetch: (url: string, init?: RequestInit) => Promise<Response>;
  importModule: (url: string) => Promise<unknown>;
  post: (message: DevelopEngineWorkerResponse, transfer?: Transferable[]) => void;
  /** オプトイン診断だけで使う時計と、安全な定型フィールドだけを受け取るログ口。 */
  now?: () => number;
  logPerf?: (record: DevelopEnginePerfRecord) => void;
  /**
   * 描いた画素（sRGB 8bit RGBA）を JPEG にする（`quality` は 1〜100）。Worker の中で JPEG にできない（`OffscreenCanvas` が無い）
   * なら null（画素を返してメインスレッドで JPEG にする）
   */
  encodeJpeg?: (width: number, height: number, rgba: ArrayBuffer, quality: number) => Promise<ArrayBuffer | null>;
};

export type DevelopEnginePerfRecord = {
  stage: "manifestFetch" | "glueImport" | "wasmInit" | "open" | "openWorkingCopy" | "renderFinal" | "renderInteractive" | "presetThumbnail" | "autoSettings";
  durationMs: number;
  wasmMemoryBytes: number | null;
  status: "ok" | "error";
};

/** glue の `Developer`（wasm-bindgen のクラス。使い終わったら `free`）。 */
type DevelopDeveloper = {
  render: (settingsJson: string, maxDimension: number, interactive: boolean) => unknown;
  free: () => void;
  readonly width: number;
  readonly height: number;
  /** 見本用の別の session（crate 0.5.0 から。無い glue もある） */
  thumbnail?: (maxDimension: number) => DevelopDeveloper;
  /** 撮影時の白の `{ temperature, tint }` の JSON（JPEG / PNG は `"null"`。無い glue もある） */
  asShotWhite?: () => unknown;
  /** 「自動」: 今の設定の JSON から、ライト 6 本と自然な彩度だけを変えた設定の JSON（無い glue もある） */
  autoSettings?: (settingsJson: string) => unknown;
};

/** 見本用の session の長辺（見本 1 枚は、これを行の大きさに縮めて描く）。 */
const PRESET_THUMBNAIL_SESSION_MAX_DIMENSION = 256;

/** 型ガードで確かめた glue（`import init, * as dev from "<js>"`）。 */
type DevelopGlue = {
  init: (options: { module_or_path: string }) => Promise<unknown>;
  version: () => unknown;
  exportJpeg: (input: Uint8Array, settingsJson: string, maxDimension: number, quality: number) => unknown;
  convertEditSettings: (editSettingsJson: string, baseVersion?: string) => unknown;
  Developer: new (input: Uint8Array, workingMaxDimension: number) => DevelopDeveloper;
  /** `Developer.openWorkingCopy(png, metaJson)`（無い glue では作業コピーを開けない） */
  openWorkingCopy: ((png: Uint8Array, metaJson: string) => DevelopDeveloper) | null;
  /** `presetSettings(xmp, baseJson)`（無い glue ではプリセットを当てられない） */
  presetSettings: ((xmp: string, baseJson?: string | null) => unknown) | null;
  /** `builtinPresets()`（無い glue では同梱のプリセットを返せない） */
  builtinPresets: (() => unknown) | null;
  /** 幾何の口（crate 0.5.0 から。4 つ揃っていなければ null＝幾何のある写真の作業サイズ・出力の寸法を決められない） */
  geometry: DevelopGeometryGlue | null;
  /**
   * `withCaptureExif(jpeg, capturedAt, offsetMinutes)`（crate 0.5.0 から。無い glue では書き出しに EXIF を付けられない）。
   * `capturedAt` は ISO 8601（UTC）、`offsetMinutes` は表示する時差（日本は 540）
   */
  withCaptureExif: ((jpeg: Uint8Array, capturedAt: string, offsetMinutes: number) => unknown) | null;
  /**
   * `validateSettings(settingsJson)`: 設定の問題の一覧（JSON の配列。空なら読める）。効果を描けるかの確かめに使う
   * （無い glue では効果を出さない）
   */
  validateSettings: ((settingsJson: string) => unknown) | null;
  /** `applyPreset(xmp, baseJson, amount, asShotJson?)`（無い glue では適用量を変えられない） */
  applyPreset: ((xmp: string, baseJson: string, amount: number, asShotJson?: string) => unknown) | null;
  /**
   * `asShotWhiteFromMeta(metaJson)`: 作業コピーのメタの撮影時の白（`{ temperature, tint }` の JSON。無ければ `"null"`）。無い glue
   * では、開いている写真なしで RAW にプリセットを当てられない
   */
  asShotWhiteFromMeta: ((metaJson: string) => unknown) | null;
  /** `settingsToXmp(settingsJson, optionsJson?)`（無い glue では今の補正をプリセットにできない） */
  settingsToXmp: ((settingsJson: string, optionsJson?: string) => unknown) | null;
  /** `Developer.prototype.thumbnail` がある（無い glue では見本を描けない） */
  presetThumbnails: boolean;
  /** `Developer.prototype.autoSettings` がある（無い glue では「自動」を使えない） */
  auto: boolean;
};

/** 幾何（切り抜き・回転。F3 移行元設計）の口。 */
type DevelopGeometryGlue = {
  /** `imageSize(bytes)`: EXIF の向きを反映した `{ width, height }`（ヘッダーだけ読む） */
  imageSize: (input: Uint8Array) => unknown;
  /** `rasterDecodeSize(settingsJson, width, height, maxDimension, cap)`: `Developer` を開く長辺 */
  rasterDecodeSize: (settingsJson: string, width: number, height: number, maxDimension: number, cap: number) => unknown;
  /** `geometryOutputSize(settingsJson, sourceWidth, sourceHeight, maxDimension)`: 描かずに出力の `{ width, height }` */
  geometryOutputSize: (settingsJson: string, sourceWidth: number, sourceHeight: number, maxDimension: number) => unknown;
  /** `beforeSettings(settingsJson)`: 「補正前」（色だけ neutral・幾何は保つ）。画面は同じ規則を自前で持つので、揃っているかだけを見る */
  beforeSettings: (settingsJson: string) => unknown;
};

type RenderedFrame = { width: number; height: number; rgba: Uint8ClampedArray };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

/** glue の形（default が関数・render / exportJpeg / Developer / version がある）を確かめてから使う。 */
function readGlue(module: unknown): DevelopGlue | null {
  if (!isRecord(module)) return null;
  const init = module.default;
  const version = module.version;
  const render = module.render;
  const exportJpeg = module.exportJpeg;
  const convertEditSettings = module.convertEditSettings;
  const Developer = module.Developer;
  if (
    typeof init !== "function" ||
    typeof version !== "function" ||
    typeof render !== "function" ||
    typeof exportJpeg !== "function" ||
    typeof convertEditSettings !== "function" ||
    typeof Developer !== "function"
  ) {
    return null;
  }
  // 作業コピーを開く静的メソッド（無い glue でも、オリジナルから描く分は使う）
  const openWorkingCopy: unknown = Reflect.get(Developer, "openWorkingCopy");
  // プリセット（無い glue でも、描く分は使う）
  const presetSettings = module.presetSettings;
  const builtinPresets = module.builtinPresets;
  // 幾何の口（無い glue でも、幾何の無い写真は描ける）
  const { imageSize, rasterDecodeSize, geometryOutputSize, beforeSettings } = module;
  // 書き出しの EXIF（無い glue でも、EXIF 無しで書き出せる）
  const withCaptureExif = module.withCaptureExif;
  // 設定の検査（無い glue でも描ける。効果を出さないだけ）
  const validateSettings = module.validateSettings;
  // プリセットの適用量・書き出し・見本の口（無い glue でも、100% で当てる分は使う）
  const { applyPreset, settingsToXmp, asShotWhiteFromMeta } = module;
  const developerPrototype: unknown = Reflect.get(Developer, "prototype");
  const thumbnail: unknown = isRecord(developerPrototype) ? Reflect.get(developerPrototype, "thumbnail") : undefined;
  // 「自動」の口（無い glue でも、手で直す分は使う）
  const autoSettings: unknown = isRecord(developerPrototype) ? Reflect.get(developerPrototype, "autoSettings") : undefined;
  const geometry: DevelopGeometryGlue | null =
    typeof imageSize === "function" &&
    typeof rasterDecodeSize === "function" &&
    typeof geometryOutputSize === "function" &&
    typeof beforeSettings === "function"
      ? {
          imageSize: imageSize as DevelopGeometryGlue["imageSize"],
          rasterDecodeSize: rasterDecodeSize as DevelopGeometryGlue["rasterDecodeSize"],
          geometryOutputSize: geometryOutputSize as DevelopGeometryGlue["geometryOutputSize"],
          beforeSettings: beforeSettings as DevelopGeometryGlue["beforeSettings"],
        }
      : null;
  return {
    init: init as DevelopGlue["init"],
    version: version as DevelopGlue["version"],
    exportJpeg: exportJpeg as DevelopGlue["exportJpeg"],
    convertEditSettings: convertEditSettings as DevelopGlue["convertEditSettings"],
    Developer: Developer as DevelopGlue["Developer"],
    openWorkingCopy:
      typeof openWorkingCopy === "function" ? (openWorkingCopy.bind(Developer) as DevelopGlue["openWorkingCopy"]) : null,
    presetSettings: typeof presetSettings === "function" ? (presetSettings as DevelopGlue["presetSettings"]) : null,
    builtinPresets: typeof builtinPresets === "function" ? (builtinPresets as DevelopGlue["builtinPresets"]) : null,
    geometry,
    withCaptureExif: typeof withCaptureExif === "function" ? (withCaptureExif as DevelopGlue["withCaptureExif"]) : null,
    validateSettings: typeof validateSettings === "function" ? (validateSettings as DevelopGlue["validateSettings"]) : null,
    applyPreset: typeof applyPreset === "function" ? (applyPreset as DevelopGlue["applyPreset"]) : null,
    asShotWhiteFromMeta:
      typeof asShotWhiteFromMeta === "function" ? (asShotWhiteFromMeta as DevelopGlue["asShotWhiteFromMeta"]) : null,
    settingsToXmp: typeof settingsToXmp === "function" ? (settingsToXmp as DevelopGlue["settingsToXmp"]) : null,
    presetThumbnails: typeof thumbnail === "function",
    auto: typeof autoSettings === "function",
  };
}

/** wasm が効果のある設定を読めるかを確かめる、効果が 1 つだけ効いている小さな設定（crate の `EFFECTS_SETTINGS_VERSION` = 3）。 */
const EFFECTS_PROBE_SETTINGS_JSON = JSON.stringify({
  v: 3,
  engine: "niho-1",
  look: "niho-interim-1",
  base: null,
  vignette: { amount: -1 },
});

/** 古い wasm・壊れた応答・throw は false（効果の項目を出さない）。 */
function acceptsEffectSettings(validateSettings: DevelopGlue["validateSettings"]): boolean {
  if (!validateSettings) return false;
  try {
    const issues: unknown = JSON.parse(String(validateSettings(EFFECTS_PROBE_SETTINGS_JSON)));
    return Array.isArray(issues) && issues.length === 0;
  } catch {
    return false;
  }
}

/** glue にある口（`ready` に付ける）。 */
function glueFeatures(glue: DevelopGlue): DevelopEngineWorkerFeatures {
  return {
    ...(glue.geometry ? { geometry: true as const } : {}),
    ...(glue.applyPreset ? { presetAmount: true as const } : {}),
    ...(glue.settingsToXmp ? { settingsToXmp: true as const } : {}),
    ...(glue.presetThumbnails ? { presetThumbnails: true as const } : {}),
    ...(glue.auto ? { auto: true as const } : {}),
    ...(glue.applyPreset && glue.asShotWhiteFromMeta ? { presetFromMeta: true as const } : {}),
  };
}

/** 開いている写真の撮影時の白（`applyPreset` の第 4 引数）。読めなければ undefined（crate は撮影時の白なしで当てる）。 */
function readAsShotWhite(developer: DevelopDeveloper | null): string | undefined {
  if (!developer || typeof developer.asShotWhite !== "function") return undefined;
  try {
    const white = developer.asShotWhite();
    return typeof white === "string" ? white : undefined;
  } catch {
    return undefined;
  }
}

/**
 * 開いている写真なしで当てるときの撮影時の白（`applyPreset` の第 4 引数。F5a-2 移行元設計）。`null` は撮影時の白なし（JPEG / PNG）、
 * 文字列は作業コピーのメタの JSON から引く。glue に口が無い・読めないメタは error（開いている写真の白で当てない）。
 */
function readAsShotWhiteFromMeta(glue: DevelopGlue, metaJson: string | null): string | undefined {
  if (metaJson === null) return undefined;
  const read = glue.asShotWhiteFromMeta;
  if (!read) throw new Error("develop engine cannot read the as-shot white");
  const white = read(metaJson);
  if (typeof white !== "string") throw new Error("develop engine returned no as-shot white");
  return white;
}

function isPositiveInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value > 0;
}

function readFrame(value: unknown): RenderedFrame {
  if (!isRecord(value)) throw new Error("develop engine returned no frame");
  const { width, height, rgba } = value;
  if (!isPositiveInteger(width) || !isPositiveInteger(height) || !(rgba instanceof Uint8ClampedArray)) {
    throw new Error("develop engine returned an invalid frame");
  }
  if (rgba.length !== width * height * 4) throw new Error("develop engine returned a frame of the wrong size");
  return { width, height, rgba };
}

/** glue が返した `{ width, height }`（正の整数）を読む。 */
function readSize(value: unknown): { width: number; height: number } {
  if (!isRecord(value)) throw new Error("develop engine returned no size");
  const { width, height } = value;
  if (!isPositiveInteger(width) || !isPositiveInteger(height)) throw new Error("develop engine returned an invalid size");
  return { width, height };
}

function readMemoryBuffer(initOutput: unknown): ArrayBufferLike | null {
  if (!isRecord(initOutput)) return null;
  const memory = initOutput.memory;
  return typeof WebAssembly !== "undefined" && memory instanceof WebAssembly.Memory ? memory.buffer : null;
}

/**
 * transfer してよい ArrayBuffer にする。wasm の memory を指している・一部だけを指している・SharedArrayBuffer なら
 * コピーする（wasm の memory を transfer すると wasm が壊れる）。
 */
function transferableBuffer(view: Uint8Array | Uint8ClampedArray, wasmMemory: ArrayBufferLike | null): ArrayBuffer {
  const buffer = view.buffer;
  if (
    buffer instanceof ArrayBuffer &&
    buffer !== wasmMemory &&
    view.byteOffset === 0 &&
    view.byteLength === buffer.byteLength
  ) {
    return buffer;
  }
  const copy = new Uint8Array(view.byteLength);
  copy.set(new Uint8Array(buffer, view.byteOffset, view.byteLength));
  return copy.buffer;
}

function errorMessage(error: unknown): string {
  if (error instanceof Error && error.message) return error.message;
  if (typeof error === "string" && error) return error;
  return "develop engine failed";
}

function analysisSettingsKeyFromJson(settingsJson: string): string | null {
  let settings: unknown;
  try {
    settings = JSON.parse(settingsJson);
  } catch {
    return null;
  }
  if (typeof settings !== "object" || settings === null || Array.isArray(settings)) return null;
  const values = settings as Record<string, unknown>;
  const colorNoiseReduction = values.colorNoiseReduction ?? 0;
  if (typeof colorNoiseReduction !== "number" || !Number.isFinite(colorNoiseReduction)) return null;
  const engine = typeof values.engine === "string" ? values.engine : "";
  return `${engine}:${colorNoiseReduction}`;
}

export function createDevelopEngineWorkerHandler(
  deps: DevelopEngineWorkerDeps,
): (message: DevelopEngineWorkerRequest) => Promise<void> {
  // 起こした glue（まだなら null）。起こせなかったら unavailable にして、以後は何も受けない
  let glue: DevelopGlue | null = null;
  let version = "";
  // 起こした wasm が効果のある設定（v: 3）を読めるか（起こしたときに 1 回だけ確かめる）
  let effects = false;
  let wasmMemory: () => ArrayBufferLike | null = () => null;
  let diagnostics = false;
  let unavailableReason: string | null = null;
  let developer: DevelopDeveloper | null = null;
  // 開いている写真の見本用の session（初めて見本を描くときに作る。写真を手放すと一緒に手放す）
  let thumbnailSession: DevelopDeveloper | null = null;
  let currentAnalysisKey: string | null = null;
  let chain: Promise<void> = Promise.resolve();
  let warmAuto: Extract<DevelopEngineWorkerRequest, { type: "warmAutoSettings" }> | null = null;
  let warmTimer: ReturnType<typeof setTimeout> | null = null;
  let scheduledWarm: object | null = null;
  let normalPending = 0;
  let handle: (message: DevelopEngineWorkerRequest) => Promise<void>;

  const recordPerf = (stage: DevelopEnginePerfRecord["stage"], started: number, status: DevelopEnginePerfRecord["status"]) => {
    try {
      deps.logPerf?.({
        stage,
        durationMs: Math.max(0, (deps.now ?? performance.now.bind(performance))() - started),
        wasmMemoryBytes: wasmMemory()?.byteLength ?? null,
        status,
      });
    } catch {
      // 診断の失敗で写真の操作や元のエラーを変えない。
    }
  };
  const startPerf = (): number | null => {
    try {
      return (deps.now ?? performance.now.bind(performance))();
    } catch {
      // 時計を読めなくても本来の処理は続ける。
      return null;
    }
  };
  const measure = <T>(stage: DevelopEnginePerfRecord["stage"], action: () => T): T => {
    if (!diagnostics) return action();
    const started = startPerf();
    if (started === null) return action();
    try {
      const result = action();
      recordPerf(stage, started, "ok");
      return result;
    } catch (error) {
      recordPerf(stage, started, "error");
      throw error;
    }
  };
  const measureAsync = async <T>(stage: DevelopEnginePerfRecord["stage"], action: () => Promise<T>): Promise<T> => {
    if (!diagnostics) return action();
    const started = startPerf();
    if (started === null) return action();
    try {
      const result = await action();
      recordPerf(stage, started, "ok");
      return result;
    } catch (error) {
      recordPerf(stage, started, "error");
      throw error;
    }
  };

  const clearWarmTimer = () => {
    if (warmTimer !== null) clearTimeout(warmTimer);
    warmTimer = null;
  };

  /** 先読みは Worker が短時間空いてから動かし、通常要求の列へ割り込ませない。 */
  const scheduleWarm = (delayMs = 0) => {
    if (!warmAuto || warmTimer !== null || normalPending > 0) return;
    warmTimer = setTimeout(() => {
      warmTimer = null;
      if (!warmAuto || normalPending > 0) return;
      const candidate = warmAuto;
      const token = {};
      scheduledWarm = token;
      const next = chain
        .then(async () => {
          // 先行処理中に通常要求・取消が届いたら先読みを動かさない。
          if (scheduledWarm !== token || warmAuto !== candidate || normalPending > 0) return;
          scheduledWarm = null;
          warmAuto = null;
          await handle({ type: "autoSettings", id: candidate.id, settingsJson: candidate.settingsJson });
        })
        .catch(() => undefined);
      chain = next;
      void next.then(() => scheduleWarm());
    }, delayMs);
  };

  const freeQuietly = (target: DevelopDeveloper | null) => {
    try {
      target?.free();
    } catch {
      // 手放すときの失敗で、次の写真を止めない
    }
  };

  const releaseThumbnailSession = () => {
    const current = thumbnailSession;
    thumbnailSession = null;
    freeQuietly(current);
  };

  const releaseDeveloper = () => {
    const current = developer;
    developer = null;
    releaseThumbnailSession();
    currentAnalysisKey = null;
    freeQuietly(current);
  };

  const postReady = (id: number) => {
    deps.post({
      type: "ready",
      id,
      version,
      ...(glue ? glueFeatures(glue) : {}),
      ...(effects ? { effects: true as const } : {}),
    });
  };

  const init = async (id: number, manifestUrl: string, enableDiagnostics: boolean): Promise<void> => {
    diagnostics = enableDiagnostics;
    if (glue) {
      postReady(id);
      return;
    }
    if (unavailableReason !== null) {
      deps.post({ type: "unavailable", id, reason: unavailableReason });
      return;
    }
    try {
      const manifest = await measureAsync("manifestFetch", async () => {
        const response = await deps.fetch(manifestUrl, { cache: "no-cache" });
        if (!response.ok) throw new Error(`develop engine manifest ${response.status}`);
        const parsed = parseDevelopEngineManifest(await response.json(), manifestUrl);
        if (!parsed) throw new Error("develop engine manifest is invalid");
        return parsed;
      });
      const loaded = await measureAsync("glueImport", async () => {
        const parsed = readGlue(await deps.importModule(manifest.jsUrl));
        if (!parsed) throw new Error("develop engine glue is invalid");
        return parsed;
      });
      await measureAsync("wasmInit", async () => {
        const output = await loaded.init({ module_or_path: manifest.wasmUrl });
        wasmMemory = () => readMemoryBuffer(output);
      });
      const reported = loaded.version();
      glue = loaded;
      version = typeof reported === "string" && reported ? reported : manifest.version;
      effects = acceptsEffectSettings(loaded.validateSettings);
      postReady(id);
    } catch (error) {
      unavailableReason = errorMessage(error);
      deps.post({ type: "unavailable", id, reason: unavailableReason });
    }
  };

  const requireGlue = (): DevelopGlue => {
    if (!glue) throw new Error(unavailableReason ?? "develop engine is not initialized");
    return glue;
  };

  /** 幾何の口（glue に揃っていなければ error）。 */
  const requireGeometry = (): DevelopGeometryGlue => {
    const geometry = requireGlue().geometry;
    if (!geometry) throw new Error("develop engine cannot read geometry");
    return geometry;
  };

  /** 作業コピーを開く（glue に `openWorkingCopy` が無ければ error）。 */
  const openWorkingCopy = (png: ArrayBuffer, metaJson: string): DevelopDeveloper => {
    const opener = requireGlue().openWorkingCopy;
    if (!opener) throw new Error("develop engine cannot open working copies");
    return opener(new Uint8Array(png), metaJson);
  };

  /**
   * 持っている写真は変えず、別の作業コピーを一時的に開いて丁寧に描き（final）、手放す。画素は手放す前に transfer できる
   * ArrayBuffer にする。
   */
  const renderWorkingCopyOnce = (
    png: ArrayBuffer,
    metaJson: string,
    settingsJson: string,
    maxDimension: number,
  ): { width: number; height: number; rgba: ArrayBuffer } => {
    const working = openWorkingCopy(png, metaJson);
    try {
      const frame = readFrame(working.render(settingsJson, maxDimension, false));
      return { width: frame.width, height: frame.height, rgba: transferableBuffer(frame.rgba, wasmMemory()) };
    } finally {
      try {
        working.free();
      } catch {
        // 手放すときの失敗で、描いた結果を捨てない
      }
    }
  };

  handle = async (message: DevelopEngineWorkerRequest): Promise<void> => {
    const id = message.id;
    try {
      switch (message.type) {
        case "init":
          await init(id, message.manifestUrl, message.diagnostics === true);
          return;
        case "open": {
          const opened = measure("open", () => {
            const loaded = requireGlue();
            releaseDeveloper();
            const next = new loaded.Developer(new Uint8Array(message.bytes), message.workingMaxDimension);
            developer = next;
            return next;
          });
          deps.post({ type: "opened", id, width: opened.width, height: opened.height });
          return;
        }
        case "openWorkingCopy": {
          const opened = measure("openWorkingCopy", () => {
            requireGlue();
            releaseDeveloper();
            const next = openWorkingCopy(message.png, message.metaJson);
            developer = next;
            return next;
          });
          deps.post({ type: "opened", id, width: opened.width, height: opened.height });
          return;
        }
        case "render": {
          const { frame, rgba } = measure(message.interactive ? "renderInteractive" : "renderFinal", () => {
            requireGlue();
            if (!developer) throw new Error("no photo is open");
            const frame = readFrame(developer.render(message.settingsJson, message.maxDimension, message.interactive));
            const nextAnalysisKey = analysisSettingsKeyFromJson(message.settingsJson);
            if (nextAnalysisKey !== null) {
              if (currentAnalysisKey !== null && nextAnalysisKey !== currentAnalysisKey) releaseThumbnailSession();
              currentAnalysisKey = nextAnalysisKey;
            }
            return { frame, rgba: transferableBuffer(frame.rgba, wasmMemory()) };
          });
          deps.post({ type: "frame", id, width: frame.width, height: frame.height, rgba }, [rgba]);
          return;
        }
        case "exportJpeg": {
          const loaded = requireGlue();
          const jpeg = loaded.exportJpeg(
            new Uint8Array(message.bytes),
            message.settingsJson,
            message.maxDimension,
            message.quality,
          );
          if (!(jpeg instanceof Uint8Array) || jpeg.byteLength === 0) throw new Error("develop engine returned no JPEG");
          const bytes = transferableBuffer(jpeg, wasmMemory());
          deps.post({ type: "jpeg", id, bytes }, [bytes]);
          return;
        }
        case "exportWorkingCopyJpeg": {
          const { width, height, rgba } = renderWorkingCopyOnce(
            message.png,
            message.metaJson,
            message.settingsJson,
            message.maxDimension,
          );
          let jpeg: ArrayBuffer | null = null;
          try {
            jpeg = deps.encodeJpeg ? await deps.encodeJpeg(width, height, rgba, message.quality) : null;
          } catch {
            // Worker の中で JPEG にできなければ、画素を返してメインスレッドで JPEG にする
            jpeg = null;
          }
          if (jpeg && jpeg.byteLength > 0) {
            deps.post({ type: "jpeg", id, bytes: jpeg }, [jpeg]);
          } else {
            deps.post({ type: "frame", id, width, height, rgba }, [rgba]);
          }
          return;
        }
        case "convertEditSettings": {
          const loaded = requireGlue();
          const resultJson = loaded.convertEditSettings(message.editSettingsJson, message.baseVersion ?? undefined);
          if (typeof resultJson !== "string") throw new Error("develop engine returned no conversion");
          deps.post({ type: "converted", id, resultJson });
          return;
        }
        case "presetSettings": {
          const apply = requireGlue().presetSettings;
          if (!apply) throw new Error("develop engine cannot apply presets");
          const resultJson = apply(message.xmp, message.baseSettingsJson);
          if (typeof resultJson !== "string") throw new Error("develop engine returned no preset settings");
          deps.post({ type: "preset", id, resultJson });
          return;
        }
        case "builtinPresets": {
          const list = requireGlue().builtinPresets;
          if (!list) throw new Error("develop engine has no builtin presets");
          const presetsJson = list();
          if (typeof presetsJson !== "string") throw new Error("develop engine returned no builtin presets");
          deps.post({ type: "builtinPresets", id, presetsJson });
          return;
        }
        case "imageSize": {
          const size = readSize(requireGeometry().imageSize(new Uint8Array(message.bytes)));
          deps.post({ type: "size", id, width: size.width, height: size.height });
          return;
        }
        case "rasterDecodeSize": {
          const size = requireGeometry().rasterDecodeSize(
            message.settingsJson,
            message.width,
            message.height,
            message.maxDimension,
            message.cap,
          );
          if (!isPositiveInteger(size)) throw new Error("develop engine returned an invalid decode size");
          deps.post({ type: "decodeSize", id, size });
          return;
        }
        case "geometryOutputSize": {
          const size = readSize(
            requireGeometry().geometryOutputSize(
              message.settingsJson,
              message.sourceWidth,
              message.sourceHeight,
              message.maxDimension,
            ),
          );
          deps.post({ type: "size", id, width: size.width, height: size.height });
          return;
        }
        case "withCaptureExif": {
          const attach = requireGlue().withCaptureExif;
          if (!attach) throw new Error("develop engine cannot write EXIF");
          const jpeg = attach(new Uint8Array(message.bytes), message.capturedAt, message.offsetMinutes);
          if (!(jpeg instanceof Uint8Array) || jpeg.byteLength === 0) throw new Error("develop engine returned no JPEG");
          const bytes = transferableBuffer(jpeg, wasmMemory());
          deps.post({ type: "jpeg", id, bytes }, [bytes]);
          return;
        }
        case "applyPreset": {
          const loaded = requireGlue();
          const apply = loaded.applyPreset;
          if (!apply) throw new Error("develop engine cannot change the preset amount");
          // 撮影時の白は、メタを渡されたらそこから（開いている写真は見ない）、渡されなければ開いている写真から
          const asShot =
            message.asShotMetaJson === undefined
              ? readAsShotWhite(developer)
              : readAsShotWhiteFromMeta(loaded, message.asShotMetaJson);
          const resultJson = apply(message.xmp, message.baseSettingsJson, message.amount, asShot);
          if (typeof resultJson !== "string") throw new Error("develop engine returned no preset settings");
          deps.post({ type: "preset", id, resultJson });
          return;
        }
        case "settingsToXmp": {
          const write = requireGlue().settingsToXmp;
          if (!write) throw new Error("develop engine cannot write presets");
          const resultJson = write(message.settingsJson, message.optionsJson);
          if (typeof resultJson !== "string") throw new Error("develop engine returned no XMP");
          deps.post({ type: "xmp", id, resultJson });
          return;
        }
        case "renderPresetThumbnail": {
          const { frame, rgba } = measure("presetThumbnail", () => {
            if (!requireGlue().presetThumbnails) throw new Error("develop engine cannot render preset thumbnails");
            const opened = developer;
            if (!opened || typeof opened.thumbnail !== "function") throw new Error("no photo is open");
            if (!thumbnailSession) thumbnailSession = opened.thumbnail(PRESET_THUMBNAIL_SESSION_MAX_DIMENSION);
            const frame = readFrame(thumbnailSession.render(message.settingsJson, message.maxDimension, false));
            return { frame, rgba: transferableBuffer(frame.rgba, wasmMemory()) };
          });
          deps.post({ type: "frame", id, width: frame.width, height: frame.height, rgba }, [rgba]);
          return;
        }
        case "autoSettings": {
          const settingsJson = measure("autoSettings", () => {
            requireGlue();
            // 開いている写真の session で測る（写真を開いていない・口の無い glue では使えない）
            const opened = developer;
            if (!opened) throw new Error("no photo is open");
            if (typeof opened.autoSettings !== "function") throw new Error("develop engine cannot pick auto settings");
            const result = opened.autoSettings(message.settingsJson);
            if (typeof result !== "string") throw new Error("develop engine returned no auto settings");
            return result;
          });
          deps.post({ type: "auto", id, settingsJson });
          return;
        }
        case "close":
          requireGlue();
          releaseDeveloper();
          deps.post({ type: "closed", id });
          return;
        default:
          throw new Error("unknown develop engine request");
      }
    } catch (error) {
      deps.post({ type: "error", id, message: errorMessage(error) });
    }
  };

  return (message) => {
    if (message.type === "warmAutoSettings") {
      // 保留する先読みは 1 件だけにし、置き換えで Worker の待ち行列を増やさない。
      if (warmAuto && warmAuto.id !== message.id) {
        deps.post({ type: "error", id: warmAuto.id, message: "auto settings prefetch superseded" });
      }
      warmAuto = message;
      scheduledWarm = null;
      clearWarmTimer();
      scheduleWarm();
      return Promise.resolve();
    }
    if (message.type === "promoteAutoSettings") {
      if (warmAuto?.id === message.id) {
        clearWarmTimer();
        scheduledWarm = null;
        scheduleWarm(0);
      }
      return Promise.resolve();
    }
    if (message.type === "cancelAutoSettings") {
      if (warmAuto?.id === message.id) {
        warmAuto = null;
        scheduledWarm = null;
        clearWarmTimer();
      }
      return Promise.resolve();
    }

    // 通常要求を保留中の先読みより先に処理する。
    normalPending += 1;
    clearWarmTimer();
    scheduledWarm = null;
    // 受け取った順に 1 つずつ（前の失敗で後を止めない）
    const next = chain
      .then(async () => {
        normalPending = Math.max(0, normalPending - 1);
        await handle(message);
      })
      .catch(() => undefined);
    chain = next;
    void next.then(() => scheduleWarm());
    return next;
  };
}
