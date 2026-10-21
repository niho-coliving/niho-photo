import { developEngineManifestPath } from "./develop-engine-manifest";
import type { DevelopEngineWorkerRequest, DevelopEngineWorkerResponse } from "./develop-engine-worker-core";
import {
  BROKEN_CONVERSION,
  readBuiltinPresets,
  readConversion,
  readPresetResult,
  readSettingsXmp,
  type DevelopBuiltinPreset,
  type DevelopEditSettingsConversion,
  type DevelopPresetResult,
  type DevelopSettingsXmp,
  type DevelopXmpGroup,
} from "./develop-engine-results";
import { readDevelopSettings, type DevelopSettings } from "./develop-settings";

export {
  DEVELOP_XMP_DEFAULT_GROUPS,
  type DevelopBuiltinPreset,
  type DevelopEditSettingsConversion,
  type DevelopPresetResult,
  type DevelopSettingsXmp,
  type DevelopXmpGroup,
} from "./develop-engine-results";

/**
 * 段 2 の wasm（Web Worker）をメインスレッドから使う（移行元設計。移行時の設計文書「段 2」）。
 *
 * - `ready()` を初めて呼んだときに Worker を作って wasm を起こす。Worker が無い・manifest や wasm を読めない・時間切れなら
 *   false（呼び出し側は S1 の canvas に黙って戻る）。結果は覚えておく
 * - `render` は最新の要求だけを描く。Worker へ出す描画は同時に 1 つまでで、出している間に来た要求は「次の 1 つ」として持ち、
 *   さらに新しい要求が来たら古い「次」は null で終える（ドラッグ中に古い画を積まない）
 * - `render` の優先度（`priority`。省略時は `interactive` で drag / final）: drag と final は編集の「次」の 1 枠を分け合い、
 *   preview・background はそれぞれ別の 1 枠を持つ。Worker が空いたら 編集 ＞ preview ＞ background の順に出す（出している
 *   描画は横取りしない。移行元設計。使い分けは F2）
 * - `exportJpeg`（記事用の画像・書き出し）と `convertEditSettings`（Photo Bench の補正の変換）は捨てずに順に処理する
 * - 作業コピー（RAW など、移行元設計）は `openWorkingCopy` で開いて持ち、`exportWorkingCopyJpeg` で持っている写真を変えずに JPEG に
 *   する（Worker の中で JPEG にできなければ、返ってきた画素をメインスレッドの canvas で JPEG にする）
 * - `dispose()` は描き途中の記事用の画像を描き終えてから Worker を止める
 * - `presetSettings`（XMP のプリセットを `developSettings` に当てる）と `builtinPresets`（crate に同梱したプリセット）は NIHO
 *   Desktop の段 2 の写真が使う（移行元設計 S7b）。捨てずに順に処理する
 * - 幾何（切り抜き・回転。F3 移行元設計）の口 `imageSize`・`rasterDecodeSize`・`geometryOutputSize` は、wasm に揃っているとき
 *   （`supportsGeometry()`。crate 0.5.0 から）だけ使える。捨てずに順に処理し、描画の枠・書き出しの数え方には入らない
 * - 効果（白黒・周辺光量補正・粒子。E1 移行元設計）は口が増えないので、Worker が起こした wasm に効果のある設定（`v: 3`）を
 *   読めるか確かめさせる（`supportsEffects()`。版の比較ではない: 画面と wasm の公開が前後すると、効果のある設定を保存したのに
 *   描けない写真ができる。移行元設計）。読めない wasm では、画面は項目を出さない
 * - ディテール（シャープ・ノイズ軽減。v5。Issue #32）も同じく `supportsDetail()` で確かめる。16bit PNG の作業コピー（RAW など）を
 *   開いている間は、描画・見本・色取得に送る設定から `detail` を外す（wasm の final 長辺 2048px が 1 秒を超えるため。書き出しは外さない。
 *   `docs/detail-processing.md`）
 * - `withCaptureExif`（書き出しの JPEG に撮影日時の EXIF を付ける。F7b 移行元設計）は `exportJpeg` と同じく捨てずに順に処理し、
 *   書き出しとして数える（`dispose` は付け終えるまで待つ）。wasm に無ければ reject（呼び出し側は EXIF 無しで続ける）
 * - プリセットの適用量（`applyPreset`）・今の補正の書き出し（`settingsToXmp`）・見本（`renderPresetThumbnail`）は、口が wasm に
 *   あるとき（`supportsPresetAmount()` / `supportsSettingsToXmp()` / `supportsPresetThumbnails()`。F2a 移行元設計）だけ使える。
 *   `applyPreset`・`settingsToXmp` は捨てずに順に処理し、見本は描画の preview の枠（編集の描画の後。写真を開き直す・閉じると
 *   null で終える）
 * - 自動（`autoSettings`。開いている写真の `Developer.autoSettings`、F4a 移行元設計）は、口が wasm にあるとき（`supportsAuto()`）だけ
 *   使える。捨てずに順に処理し、描画の枠には入らない
 * - 開いている写真なしでプリセットを当てる（一覧の一括。F5a-2 移行元設計）: `applyPreset` に `{ workMetaJson }` を渡すと、撮影時の白を
 *   開いている写真ではなく作業コピーのメタ（JPEG / PNG は null）から引く。口（`asShotWhiteFromMeta`）が wasm にあるとき
 *   （`supportsPresetFromMeta()`）だけ使える。省けば今までどおり開いている写真の白
 */

/** `applyPreset` の撮影時の白の出どころ（省くと開いている写真）。 */
export type DevelopPresetAsShotSource = {
  /** 作業コピーのメタの JSON（`work/download` の `work.meta`）。RAW 以外の写真（JPEG / PNG）は null（撮影時の白なし） */
  workMetaJson: string | null;
};

export type DevelopFrame = { width: number; height: number; rgba: Uint8ClampedArray<ArrayBuffer> };
export type DevelopSampledColor = { lightness: number; chroma: number; hue: number };

/**
 * 描画の優先度。`drag`（つまみを動かしている間の速い描き方）と `final`（離した後の丁寧な 1 枚）は編集の 1 枠、`preview`（一覧の
 * 下絵など）と `background`（先読みなど）はそれぞれ別の 1 枠。
 */
export type DevelopRenderPriority = "drag" | "final" | "preview" | "background";

export type DevelopRenderOptions = {
  maxDimension: number;
  interactive: boolean;
  /** 省略時は `interactive ? "drag" : "final"` */
  priority?: DevelopRenderPriority;
};

export type DevelopAutoSettingsWarm = {
  /** 先読みの結果。取消時は reject されるので、呼び出し側で静かに捨てる。 */
  promise: Promise<DevelopSettings>;
  /** 「自動」を押したら、Worker が空いた時点で先読みを優先する。 */
  promote: () => void;
  /** 保留中の先読みを取り消し、後続の編集を待たせない。 */
  cancel: () => void;
};

export class DevelopEngineError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DevelopEngineError";
  }
}

export type DevelopEngine = {
  /** 使えるか（初回に Worker を作って wasm を起こす。throw しない） */
  ready: () => Promise<boolean>;
  /** 写真を 1 回デコードして持つ（前の写真は手放す。待っている描画は null で終える） */
  open: (bytes: ArrayBuffer, workingMaxDimension: number) => Promise<{ width: number; height: number }>;
  /** 持っている写真を描く。同じ枠の新しい要求に追い越されたら null */
  render: (settings: object, options: DevelopRenderOptions) => Promise<DevelopFrame | null>;
  /** 描画座標の色ミキサー直前の Oklch。座標は表示フレームに対する 0〜1。 */
  sampleColor: (
    settings: object,
    options: { maxDimension: number; x: number; y: number },
  ) => Promise<DevelopSampledColor>;
  /** 別の bytes（オリジナルのコピー）から JPEG を描く。持っている写真は変えない */
  exportJpeg: (
    bytes: ArrayBuffer,
    settings: object,
    options: { maxDimension: number; quality: number },
  ) => Promise<Uint8Array<ArrayBuffer>>;
  /**
   * 作業コピー（16bit PNG とメタデータの JSON）を開いて持つ（前の写真は手放す。待っている描画は null で終える。長辺 2560px の
   * まま持ち、描く大きさは `render` で決める）
   */
  openWorkingCopy: (png: ArrayBuffer, metaJson: string) => Promise<{ width: number; height: number }>;
  /** 別の作業コピー（コピー）から丁寧に描いて JPEG にする（sRGB・撮影情報なし）。持っている写真は変えない */
  exportWorkingCopyJpeg: (
    png: ArrayBuffer,
    metaJson: string,
    settings: object,
    options: { maxDimension: number; quality: number },
  ) => Promise<Uint8Array<ArrayBuffer>>;
  /**
   * Photo Bench `EditSettings` を `developSettings` に変換する（壊れた結果は `ok: false`）。作業コピーの上で直す写真は、その
   * `baseVersion` を渡す（変換した設定の `base` になる）
   */
  convertEditSettings: (
    editSettings: object,
    options?: { baseVersion?: string | null },
  ) => Promise<DevelopEditSettingsConversion>;
  /** XMP のプリセットを `baseSettings`（null なら neutral）に当てる（プリセットが持つ項目だけを置き換える）。読めない XMP は reject */
  presetSettings: (xmp: string, baseSettings: object | null) => Promise<DevelopPresetResult>;
  /** crate に同梱したプリセットの一覧 */
  builtinPresets: () => Promise<DevelopBuiltinPreset[]>;
  /**
   * XMP のプリセットを `baseSettings`（当てる直前の設定）に適用量 `amount`（0〜1.5）で当てる（結果 ＝ base ＋ 適用量 ×（100% の
   * 結果 − base）。RAW の絶対のホワイトバランスは開いている写真の撮影時の白から補間する）。`asShot` を渡すと、開いている写真の
   * 白ではなく作業コピーのメタから引く（{@link DevelopPresetAsShotSource}。口の無い wasm では reject）。wasm に無ければ reject
   */
  applyPreset: (
    xmp: string,
    baseSettings: object,
    amount: number,
    asShot?: DevelopPresetAsShotSource,
  ) => Promise<DevelopPresetResult>;
  /** 設定を Lightroom のプリセット（XMP）に書き出す（`groups` を省くと crate の既定の群）。wasm に無ければ reject */
  settingsToXmp: (
    settings: object,
    options: { name: string; groups?: readonly DevelopXmpGroup[] },
  ) => Promise<DevelopSettingsXmp>;
  /**
   * 持っている写真のプリセットの見本を丁寧に描く（見本用の別の session。長辺 `maxDimension` に収める）。描画の preview の枠で
   * 待ち（編集の描画を先に出す）、同じ枠の新しい要求・写真を開き直す・閉じると null。wasm に無ければ reject
   */
  renderPresetThumbnail: (settings: object, maxDimension: number) => Promise<DevelopFrame | null>;
  /** `applyPreset` を使える wasm か（初回に wasm を起こす。使えなければ false。throw しない） */
  supportsPresetAmount: () => Promise<boolean>;
  /** `settingsToXmp` を使える wasm か（初回に wasm を起こす。使えなければ false。throw しない） */
  supportsSettingsToXmp: () => Promise<boolean>;
  /** `renderPresetThumbnail` を使える wasm か（初回に wasm を起こす。使えなければ false。throw しない） */
  supportsPresetThumbnails: () => Promise<boolean>;
  /**
   * 開いている写真なしで `applyPreset` を当てられる wasm か（`applyPreset` と `asShotWhiteFromMeta` がある。一覧の一括のプリセット。
   * F5a-2 移行元設計。初回に wasm を起こす。使えなければ false。throw しない）
   */
  supportsPresetFromMeta: () => Promise<boolean>;
  /**
   * 持っている写真の「自動」: 今の設定 `settings`（プリセットを当てた状態）から、ライト 6 本（露光量・コントラスト・ハイライト・
   * シャドウ・白レベル・黒レベル）と自然な彩度だけを決めた設定（ほかの項目は渡したまま。切り抜きの範囲で測る）。捨てずに順に
   * 処理し、描画の枠は使わない。wasm に無い・写真を開いていない・結果を編集内容として読めなければ reject
   */
  autoSettings: (settings: object) => Promise<DevelopSettings>;
  /** pointer/focus 操作向けの低優先度・取消可能な先読み。 */
  warmAutoSettings?: (settings: object) => DevelopAutoSettingsWarm;
  /**
   * `autoSettings` を使える wasm か（開いた写真の `Developer` に口がある。crate の口が無い公開済みの wasm もある。初回に wasm を
   * 起こす。使えなければ false。throw しない）
   */
  supportsAuto: () => Promise<boolean>;
  /**
   * 幾何（切り抜き・回転）の口が wasm に揃っているか（crate 0.5.0 から。初回に wasm を起こす。使えなければ false。throw しない）。
   * false の wasm は、恒等でない幾何のある設定（`v: 2`）を描かない（`render` が reject）
   */
  supportsGeometry: () => Promise<boolean>;
  /**
   * 効果（白黒・周辺光量補正・粒子）のある設定（`v: 3`）を読める wasm か（Worker が起こした wasm が `validateSettings` で小さな
   * `v: 3` の設定を通すとき。初回に wasm を起こす。使えない・関数が無ければ false。throw しない）。false の wasm は `v: 3` の描画を断る
   */
  supportsEffects: () => Promise<boolean>;
  /** 独立した色ミキサー（`developSettings` v4）を読んで描ける wasm か。 */
  supportsColorPoints: () => Promise<boolean>;
  /** ディテール（シャープ・ノイズ軽減。`developSettings` v5。Issue #32）を読んで描ける wasm か。throw しない */
  supportsDetail: () => Promise<boolean>;
  /**
   * JPEG / PNG の寸法（EXIF の向きを反映。ヘッダーだけ読む）。bytes は Worker へコピーで渡す（呼び出し側の ArrayBuffer はそのまま
   * 使える。`open` / `exportJpeg` は手放す）。wasm に無ければ reject
   */
  imageSize: (bytes: ArrayBuffer) => Promise<{ width: number; height: number }>;
  /**
   * `size`（`imageSize`）のオリジナルを `open` する長辺: 設定の切り抜きが `maxDimension` に届く作業サイズ（`cap` が上限。0 は上限
   * なし。幾何が無ければ `maxDimension`）。wasm に無ければ reject
   */
  rasterDecodeSize: (
    settings: object,
    size: { width: number; height: number },
    maxDimension: number,
    cap: number,
  ) => Promise<number>;
  /** 描かずに出力の寸法（`source` は開いた写真の `width` / `height`）。wasm に無ければ reject */
  geometryOutputSize: (
    settings: object,
    source: { width: number; height: number },
    maxDimension: number,
  ) => Promise<{ width: number; height: number }>;
  /**
   * 書き出しの JPEG に NIHO の EXIF（撮影日時・向き 1・sRGB。位置情報・カメラは付けず、前の EXIF は外す）を付けた JPEG。
   * `capturedAt` は写真の `capturedAt`（ISO 8601・UTC）、`offsetMinutes` は表示する時差（日本は 540）。bytes は Worker へ渡して
   * 手放す（失敗したときに元の JPEG を使うなら、呼び出し側がコピーを渡す）。wasm に無ければ reject
   */
  withCaptureExif: (
    jpeg: Uint8Array<ArrayBuffer>,
    capturedAt: string,
    offsetMinutes: number,
  ) => Promise<Uint8Array<ArrayBuffer>>;
  /** 持っている写真を手放す */
  close: () => Promise<void>;
  /** 使い終わり（描き途中の JPEG を待ってから Worker を止める。以後の要求は reject） */
  dispose: () => void;
};

export type CreateDevelopEngineOptions = {
  createWorker?: () => Worker | null;
  manifestUrl?: string;
  loadTimeoutMs?: number;
  /** 写真編集タブの ?photoDevelopPerf=1 だけで有効にする Worker 段階診断（明示値はテスト用）。 */
  diagnostics?: boolean;
  /** Worker が返した画素を JPEG にする（テストで差し替える。既定はメインスレッドの canvas） */
  encodeFrameJpeg?: (frame: DevelopFrame, quality: number) => Promise<Uint8Array<ArrayBuffer>>;
};

export function photoDevelopDiagnosticsEnabled(location: { pathname: string; search: string } | null =
  typeof window === "undefined" ? null : window.location): boolean {
  const optedIn = new URLSearchParams(location?.search ?? "").get("photoDevelopPerf") === "1";
  return optedIn && (location?.pathname.endsWith("/photoEditing") === true || location?.pathname === "/");
}

/** wasm を起こすのを諦めるまでの時間。 */
export const DEVELOP_ENGINE_LOAD_TIMEOUT_MS = 20_000;

type Pending = {
  kind:
    | "open"
    | "openWorkingCopy"
    | "exportJpeg"
    | "exportWorkingCopyJpeg"
    | "close"
    | "convertEditSettings"
    | "presetSettings"
    | "builtinPresets"
    | "applyPreset"
    | "settingsToXmp"
    | "autoSettings"
    | "sampleColor"
    | "warmAutoSettings"
    | "imageSize"
    | "rasterDecodeSize"
    | "geometryOutputSize"
    | "withCaptureExif";
  resolve: (response: DevelopEngineWorkerResponse) => void;
  reject: (error: unknown) => void;
};

/** 描き終えるまで Worker を止めない仕事（記事用の画像・書き出しの JPEG と、その EXIF）。 */
function isExportKind(kind: Pending["kind"]): boolean {
  return kind === "exportJpeg" || kind === "exportWorkingCopyJpeg" || kind === "withCaptureExif";
}

/** view がちょうど指している ArrayBuffer（一部だけを指していればコピー。transfer で余分を送らない）。 */
function exactArrayBuffer(view: Uint8Array<ArrayBuffer>): ArrayBuffer {
  return view.byteOffset === 0 && view.byteLength === view.buffer.byteLength ? view.buffer : view.slice().buffer;
}

type RenderRequest = {
  /** `render`（持っている写真）か `thumbnail`（見本用の別の session） */
  kind: "render" | "thumbnail";
  settingsJson: string;
  maxDimension: number;
  interactive: boolean;
  resolve: (frame: DevelopFrame | null) => void;
  reject: (error: unknown) => void;
};

type InFlightRender = RenderRequest & { id: number; stale: boolean };

/** 「次」を持つ枠（drag と final は編集の 1 枠）。並びは Worker が空いたときに出す順。 */
type RenderSlot = "edit" | "preview" | "background";
const RENDER_SLOT_ORDER: readonly RenderSlot[] = ["edit", "preview", "background"];

function renderSlotOf(priority: DevelopRenderPriority): RenderSlot {
  return priority === "drag" || priority === "final" ? "edit" : priority;
}

/** プリセットを当てた結果を読む（`settings` が v1 の形でなければ throw）。 */
function presetResultOrThrow(resultJson: string): DevelopPresetResult {
  const result = readPresetResult(resultJson);
  if (!result) throw new DevelopEngineError("develop engine returned invalid preset settings");
  return result;
}

function autoSettingsResponse(response: DevelopEngineWorkerResponse): DevelopSettings {
  if (response.type !== "auto") throw new DevelopEngineError("develop engine returned no auto settings");
  let parsed: unknown;
  try {
    parsed = JSON.parse(response.settingsJson);
  } catch {
    parsed = null;
  }
  const result = readDevelopSettings(parsed);
  if (!result) throw new DevelopEngineError("develop engine returned invalid auto settings");
  return result;
}

/** Worker の中で JPEG にできなかった画素を、メインスレッドの canvas で JPEG にする（sRGB のまま・撮影情報なし）。 */
async function encodeFrameJpegWithCanvas(frame: DevelopFrame, quality: number): Promise<Uint8Array<ArrayBuffer>> {
  if (typeof document === "undefined") throw new DevelopEngineError("develop engine cannot encode JPEG");
  const canvas = document.createElement("canvas");
  try {
    canvas.width = frame.width;
    canvas.height = frame.height;
    const context = canvas.getContext("2d");
    if (!context) throw new DevelopEngineError("develop engine cannot encode JPEG");
    context.putImageData(new ImageData(frame.rgba, frame.width, frame.height), 0, 0);
    const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, "image/jpeg", quality / 100));
    if (!blob) throw new DevelopEngineError("develop engine cannot encode JPEG");
    return new Uint8Array(await blob.arrayBuffer());
  } finally {
    canvas.width = 1;
    canvas.height = 1;
  }
}

function createDefaultWorker(): Worker | null {
  if (typeof Worker === "undefined") return null;
  try {
    return new Worker(new URL("./develop-engine.worker.ts", import.meta.url), { type: "module" });
  } catch {
    return null;
  }
}

function defaultManifestUrl(): string | null {
  if (typeof window === "undefined") return null;
  try {
    return new URL(developEngineManifestPath(), window.location.origin).href;
  } catch {
    return null;
  }
}

export function createDevelopEngine(options: CreateDevelopEngineOptions = {}): DevelopEngine {
  const loadTimeoutMs = options.loadTimeoutMs ?? DEVELOP_ENGINE_LOAD_TIMEOUT_MS;
  let worker: Worker | null = null;
  let readyPromise: Promise<boolean> | null = null;
  let settleReady: ((ready: boolean) => void) | null = null;
  let initId: number | null = null;
  let status: "idle" | "loading" | "ready" | "unavailable" | "disposed" = "idle";
  let nextId = 1;
  const pending = new Map<number, Pending>();
  let inFlightRender: InFlightRender | null = null;
  const queuedRenders: Record<RenderSlot, RenderRequest | null> = { edit: null, preview: null, background: null };
  let exportsInFlight = 0;
  let terminateWhenIdle = false;
  // 幾何の口が wasm に揃っている（`ready` の応答で分かる）
  let geometrySupported = false;
  // 効果（白黒・周辺光量補正・粒子）を描ける版の crate（`ready` の応答の版で分かる）
  let effectsSupported = false;
  let colorPointsSupported = false;
  let detailSupported = false;
  // 開いている写真のプレビュー（描画・見本・色取得）にディテール（シャープ・ノイズ軽減。Issue #32）を描くか。16bit PNG の作業コピー
  // （RAW など）は wasm の final（長辺 2048px）が 1 秒を超える（docs/detail-processing.md の実測）ので、Issue の方針どおり
  // プレビューでは描かず、書き出し（`exportJpeg` / `exportWorkingCopyJpeg`）だけが描く。JPEG / PNG（`open`）は描く
  let previewDetail = true;
  const previewSettingsJson = (settings: object): string => {
    if (previewDetail || !("detail" in settings)) return JSON.stringify(settings);
    const { detail: _detail, ...rest } = settings as Record<string, unknown>;
    return JSON.stringify(rest);
  };
  // プリセットの適用量・書き出し・見本の口が wasm にある（`ready` の応答で分かる）
  let presetAmountSupported = false;
  let settingsToXmpSupported = false;
  let presetThumbnailsSupported = false;
  // 「自動」の口が wasm の `Developer` にある（`ready` の応答で分かる）
  let autoSupported = false;
  // 開いている写真なしでプリセットを当てる口（`asShotWhiteFromMeta`）が wasm にある（`ready` の応答で分かる）
  let presetFromMetaSupported = false;

  const unavailableError = () =>
    new DevelopEngineError(status === "disposed" ? "develop engine is disposed" : "develop engine is unavailable");

  const post = (message: DevelopEngineWorkerRequest, transfer: Transferable[] = []) => {
    if (!worker) throw unavailableError();
    worker.postMessage(message, transfer);
  };

  /** 写真を切り替えるとき、まだ消費していない自動補正の先読みを取り消す。 */
  const cancelWarmAutoSettings = () => {
    for (const [id, entry] of pending) {
      if (entry.kind !== "warmAutoSettings") continue;
      pending.delete(id);
      try {
        post({ type: "cancelAutoSettings", id });
      } catch {
        // ローカルの待機は取り除いた。Worker が終了済みなら取り消し要求は不要。
      }
      entry.reject(new DevelopEngineError("auto settings prefetch cancelled"));
    }
  };

  /** 持っている「次」をすべて null で終える。 */
  const dropQueuedRenders = () => {
    for (const slot of RENDER_SLOT_ORDER) {
      const queued = queuedRenders[slot];
      queuedRenders[slot] = null;
      queued?.resolve(null);
    }
  };

  /** Worker を止め、待っているものをすべて終える（描画は null、ほかは reject）。 */
  const terminate = (nextStatus: "unavailable" | "disposed") => {
    status = nextStatus;
    const current = worker;
    worker = null;
    try {
      current?.terminate();
    } catch {
      // 止めるときの失敗で、待っている呼び出し側を止めない
    }
    settleReady?.(false);
    settleReady = null;
    const error = unavailableError();
    for (const entry of pending.values()) entry.reject(error);
    pending.clear();
    exportsInFlight = 0;
    if (inFlightRender && !inFlightRender.stale) inFlightRender.resolve(null);
    inFlightRender = null;
    dropQueuedRenders();
  };

  const sendRender = (request: RenderRequest) => {
    const id = nextId++;
    const entry: InFlightRender = { ...request, id, stale: false };
    inFlightRender = entry;
    try {
      post(
        request.kind === "thumbnail"
          ? { type: "renderPresetThumbnail", id, settingsJson: request.settingsJson, maxDimension: request.maxDimension }
          : {
              type: "render",
              id,
              settingsJson: request.settingsJson,
              maxDimension: request.maxDimension,
              interactive: request.interactive,
            },
      );
    } catch (error) {
      inFlightRender = null;
      request.reject(error);
    }
  };

  /** 出していた描画が終わったら、持っていた「次」を 編集 ＞ preview ＞ background の順に 1 つ出す。 */
  const finishRender = () => {
    inFlightRender = null;
    for (const slot of RENDER_SLOT_ORDER) {
      const next = queuedRenders[slot];
      if (!next) continue;
      queuedRenders[slot] = null;
      sendRender(next);
      if (inFlightRender) return;
    }
  };

  /** 持っている写真が変わる（open / close）。出している描画の結果は捨て、「次」は null で終える。 */
  const dropRenders = () => {
    if (inFlightRender && !inFlightRender.stale) {
      inFlightRender.stale = true;
      inFlightRender.resolve(null);
    }
    dropQueuedRenders();
  };

  const onResponse = (response: DevelopEngineWorkerResponse) => {
    if (response.type === "perf") {
      if (options.diagnostics ?? photoDevelopDiagnosticsEnabled()) {
        console.info("[photo-develop-perf]", response.record);
      }
      return;
    }
    if (response.id === initId) {
      initId = null;
      if (response.type === "ready") {
        geometrySupported = response.geometry === true;
        effectsSupported = response.effects === true;
        colorPointsSupported = response.colorPoints === true;
        detailSupported = response.detail === true;
        presetAmountSupported = response.presetAmount === true;
        settingsToXmpSupported = response.settingsToXmp === true;
        presetThumbnailsSupported = response.presetThumbnails === true;
        autoSupported = response.auto === true;
        presetFromMetaSupported = response.presetFromMeta === true;
        status = "ready";
        settleReady?.(true);
        settleReady = null;
      } else {
        terminate("unavailable");
      }
      return;
    }
    if (inFlightRender && response.id === inFlightRender.id) {
      const entry = inFlightRender;
      if (!entry.stale) {
        if (response.type === "frame") {
          entry.resolve({ width: response.width, height: response.height, rgba: new Uint8ClampedArray(response.rgba) });
        } else if (response.type === "error") {
          entry.reject(new DevelopEngineError(response.message));
        } else {
          entry.resolve(null);
        }
      }
      finishRender();
      return;
    }
    const entry = pending.get(response.id);
    if (!entry) return;
    pending.delete(response.id);
    if (response.type === "error") entry.reject(new DevelopEngineError(response.message));
    else entry.resolve(response);
    if (isExportKind(entry.kind)) {
      exportsInFlight = Math.max(0, exportsInFlight - 1);
      if (terminateWhenIdle && exportsInFlight === 0) terminate("disposed");
    }
  };

  const request = (
    kind: Pending["kind"],
    build: (id: number) => { message: DevelopEngineWorkerRequest; transfer?: Transferable[] },
  ): Promise<DevelopEngineWorkerResponse> => {
    if (status !== "ready" || terminateWhenIdle) return Promise.reject(unavailableError());
    const id = nextId++;
    return new Promise<DevelopEngineWorkerResponse>((resolve, reject) => {
      pending.set(id, { kind, resolve, reject });
      if (isExportKind(kind)) exportsInFlight += 1;
      try {
        const { message, transfer } = build(id);
        post(message, transfer);
      } catch (error) {
        pending.delete(id);
        if (isExportKind(kind)) exportsInFlight = Math.max(0, exportsInFlight - 1);
        reject(error);
      }
    });
  };

  const startWorker = (): Promise<boolean> => {
    const manifestUrl = options.manifestUrl ?? defaultManifestUrl();
    let created: Worker | null = null;
    try {
      created = manifestUrl ? (options.createWorker ?? createDefaultWorker)() : null;
    } catch {
      created = null;
    }
    if (!created || !manifestUrl) {
      status = "unavailable";
      return Promise.resolve(false);
    }
    worker = created;
    status = "loading";
    const result = new Promise<boolean>((resolve) => {
      settleReady = resolve;
    });
    const timer = setTimeout(() => {
      if (status === "loading") terminate("unavailable");
    }, loadTimeoutMs);
    void result.then(() => clearTimeout(timer));
    created.addEventListener("message", (event: MessageEvent<DevelopEngineWorkerResponse>) => onResponse(event.data));
    // Worker が落ちた・受け取れない形だった → 使えない扱い
    created.addEventListener("error", () => terminate("unavailable"));
    created.addEventListener("messageerror", () => terminate("unavailable"));
    const id = nextId++;
    initId = id;
    try {
      const diagnostics = options.diagnostics ?? photoDevelopDiagnosticsEnabled();
      post({ type: "init", id, manifestUrl, ...(diagnostics ? { diagnostics: true } : {}) });
    } catch {
      terminate("unavailable");
    }
    return result;
  };

  const ready = (): Promise<boolean> => {
    // 止めた後・起こした後に Worker が落ちたときは使えない
    if (status === "disposed" || status === "unavailable" || terminateWhenIdle) return Promise.resolve(false);
    if (!readyPromise) readyPromise = startWorker();
    return readyPromise;
  };

  /**
   * 描画を待ち行列に入れる。Worker が空いていればすぐ出し、出している間は優先度の枠の「次」として持つ（同じ枠の古い「次」は
   * null で終える）。
   */
  const enqueueRender = (
    request: Omit<RenderRequest, "resolve" | "reject">,
    priority: DevelopRenderPriority,
  ): Promise<DevelopFrame | null> => {
    if (status !== "ready" || terminateWhenIdle) return Promise.reject(unavailableError());
    return new Promise<DevelopFrame | null>((resolve, reject) => {
      const next: RenderRequest = { ...request, resolve, reject };
      if (inFlightRender === null) {
        sendRender(next);
        return;
      }
      // 同じ枠の古い「次」は null で終える（ほかの枠の「次」は残す）
      const slot = renderSlotOf(priority);
      queuedRenders[slot]?.resolve(null);
      queuedRenders[slot] = next;
    });
  };

  return {
    ready,

    async supportsGeometry() {
      return (await ready()) && geometrySupported;
    },

    async supportsEffects() {
      return (await ready()) && effectsSupported;
    },

    async supportsColorPoints() {
      return (await ready()) && colorPointsSupported;
    },

    async supportsDetail() {
      return (await ready()) && detailSupported;
    },

    async sampleColor(settings, options) {
      const response = await request("sampleColor", (id) => ({
        message: {
          type: "sampleColor",
          id,
          settingsJson: previewSettingsJson(settings),
          maxDimension: options.maxDimension,
          x: options.x,
          y: options.y,
        },
      }));
      if (response.type !== "sampledColor") throw new DevelopEngineError("develop engine returned no sampled color");
      return { lightness: response.lightness, chroma: response.chroma, hue: response.hue };
    },

    async imageSize(bytes) {
      // transfer しない（Worker へはコピーが渡る。呼び出し側は同じ bytes をこの後 `open` に渡す）
      const response = await request("imageSize", (id) => ({ message: { type: "imageSize", id, bytes } }));
      if (response.type !== "size") throw new DevelopEngineError("develop engine returned no image size");
      return { width: response.width, height: response.height };
    },

    async rasterDecodeSize(settings, size, maxDimension, cap) {
      const response = await request("rasterDecodeSize", (id) => ({
        message: {
          type: "rasterDecodeSize",
          id,
          settingsJson: JSON.stringify(settings),
          width: size.width,
          height: size.height,
          maxDimension,
          cap,
        },
      }));
      if (response.type !== "decodeSize") throw new DevelopEngineError("develop engine returned no decode size");
      return response.size;
    },

    async geometryOutputSize(settings, source, maxDimension) {
      const response = await request("geometryOutputSize", (id) => ({
        message: {
          type: "geometryOutputSize",
          id,
          settingsJson: JSON.stringify(settings),
          sourceWidth: source.width,
          sourceHeight: source.height,
          maxDimension,
        },
      }));
      if (response.type !== "size") throw new DevelopEngineError("develop engine returned no output size");
      return { width: response.width, height: response.height };
    },

    async withCaptureExif(jpeg, capturedAt, offsetMinutes) {
      const response = await request("withCaptureExif", (id) => {
        const bytes = exactArrayBuffer(jpeg);
        return { message: { type: "withCaptureExif", id, bytes, capturedAt, offsetMinutes }, transfer: [bytes] };
      });
      if (response.type !== "jpeg") throw new DevelopEngineError("develop engine returned no JPEG");
      return new Uint8Array(response.bytes);
    },

    async open(bytes, workingMaxDimension) {
      dropRenders();
      cancelWarmAutoSettings();
      previewDetail = true;
      const response = await request("open", (id) => ({
        message: { type: "open", id, bytes, workingMaxDimension },
        transfer: [bytes],
      }));
      if (response.type !== "opened") throw new DevelopEngineError("develop engine could not open the photo");
      return { width: response.width, height: response.height };
    },

    render(settings, renderOptions) {
      return enqueueRender(
        {
          kind: "render",
          settingsJson: previewSettingsJson(settings),
          maxDimension: renderOptions.maxDimension,
          interactive: renderOptions.interactive,
        },
        renderOptions.priority ?? (renderOptions.interactive ? "drag" : "final"),
      );
    },

    renderPresetThumbnail(settings, maxDimension) {
      if (status === "ready" && !terminateWhenIdle && !presetThumbnailsSupported) {
        return Promise.reject(new DevelopEngineError("develop engine cannot render preset thumbnails"));
      }
      // 見本は丁寧に描く（interactive は Worker へ送らない）。編集の描画を待たせない preview の枠
      return enqueueRender(
        { kind: "thumbnail", settingsJson: previewSettingsJson(settings), maxDimension, interactive: false },
        "preview",
      );
    },

    async supportsPresetAmount() {
      return (await ready()) && presetAmountSupported;
    },

    async supportsSettingsToXmp() {
      return (await ready()) && settingsToXmpSupported;
    },

    async supportsPresetThumbnails() {
      return (await ready()) && presetThumbnailsSupported;
    },

    async supportsAuto() {
      return (await ready()) && autoSupported;
    },

    async supportsPresetFromMeta() {
      return (await ready()) && presetFromMetaSupported;
    },

    async autoSettings(settings) {
      // 口の無い wasm には送らない
      if (status === "ready" && !terminateWhenIdle && !autoSupported) {
        throw new DevelopEngineError("develop engine cannot pick auto settings");
      }
      const response = await request("autoSettings", (id) => ({
        message: { type: "autoSettings", id, settingsJson: JSON.stringify(settings) },
      }));
      return autoSettingsResponse(response);
    },

    warmAutoSettings(settings) {
      if (status !== "ready" || terminateWhenIdle || !autoSupported) {
        return {
          promise: Promise.reject(unavailableError()),
          promote: () => undefined,
          cancel: () => undefined,
        };
      }

      const id = nextId++;
      let resolve!: (response: DevelopEngineWorkerResponse) => void;
      let reject!: (error: unknown) => void;
      const promise = new Promise<DevelopSettings>((resolveResult, rejectResult) => {
        resolve = (response) => {
          try {
            resolveResult(autoSettingsResponse(response));
          } catch (error) {
            rejectResult(error);
          }
        };
        reject = rejectResult;
      });
      pending.set(id, { kind: "warmAutoSettings", resolve, reject });
      try {
        post({ type: "warmAutoSettings", id, settingsJson: JSON.stringify(settings) });
      } catch (error) {
        pending.delete(id);
        reject(error);
      }

      return {
        promise,
        promote: () => {
          if (!pending.has(id)) return;
          try {
            post({ type: "promoteAutoSettings", id });
          } catch {
            // Worker のエラー・終了処理が待機中の要求を reject する。
          }
        },
        cancel: () => {
          const entry = pending.get(id);
          if (!entry) return;
          pending.delete(id);
          try {
            post({ type: "cancelAutoSettings", id });
          } catch {
            // ローカルの待機は取り除いた。Worker が終了済みなら取り消し要求は不要。
          }
          entry.reject(new DevelopEngineError("auto settings prefetch cancelled"));
        },
      };
    },

    async applyPreset(xmp, baseSettings, amount, asShot) {
      // 作業コピーのメタから撮影時の白を引けない wasm には送らない（開いている写真の白で当てて取り違えない）
      if (asShot && status === "ready" && !terminateWhenIdle && !presetFromMetaSupported) {
        throw new DevelopEngineError("develop engine cannot read the as-shot white");
      }
      const response = await request("applyPreset", (id) => ({
        message: {
          type: "applyPreset",
          id,
          xmp,
          baseSettingsJson: JSON.stringify(baseSettings),
          amount,
          // 省いたときは今までどおり（開いている写真の白。要求の形も変えない）
          ...(asShot ? { asShotMetaJson: asShot.workMetaJson } : {}),
        },
      }));
      if (response.type !== "preset") throw new DevelopEngineError("develop engine returned no preset settings");
      return presetResultOrThrow(response.resultJson);
    },

    async settingsToXmp(settings, xmpOptions) {
      const response = await request("settingsToXmp", (id) => ({
        message: {
          type: "settingsToXmp",
          id,
          settingsJson: JSON.stringify(settings),
          optionsJson: JSON.stringify(
            xmpOptions.groups ? { name: xmpOptions.name, groups: [...xmpOptions.groups] } : { name: xmpOptions.name },
          ),
        },
      }));
      if (response.type !== "xmp") throw new DevelopEngineError("develop engine returned no XMP");
      const written = readSettingsXmp(response.resultJson);
      if (!written) throw new DevelopEngineError("develop engine returned an invalid XMP");
      return written;
    },

    async exportJpeg(bytes, settings, exportOptions) {
      const response = await request("exportJpeg", (id) => ({
        message: {
          type: "exportJpeg",
          id,
          bytes,
          settingsJson: JSON.stringify(settings),
          maxDimension: exportOptions.maxDimension,
          quality: exportOptions.quality,
        },
        transfer: [bytes],
      }));
      if (response.type !== "jpeg") throw new DevelopEngineError("develop engine returned no JPEG");
      return new Uint8Array(response.bytes);
    },

    async openWorkingCopy(png, metaJson) {
      dropRenders();
      cancelWarmAutoSettings();
      previewDetail = false;
      const response = await request("openWorkingCopy", (id) => ({
        message: { type: "openWorkingCopy", id, png, metaJson },
        transfer: [png],
      }));
      if (response.type !== "opened") throw new DevelopEngineError("develop engine could not open the working copy");
      return { width: response.width, height: response.height };
    },

    async exportWorkingCopyJpeg(png, metaJson, settings, exportOptions) {
      const response = await request("exportWorkingCopyJpeg", (id) => ({
        message: {
          type: "exportWorkingCopyJpeg",
          id,
          png,
          metaJson,
          settingsJson: JSON.stringify(settings),
          maxDimension: exportOptions.maxDimension,
          quality: exportOptions.quality,
        },
        transfer: [png],
      }));
      if (response.type === "jpeg") return new Uint8Array(response.bytes);
      if (response.type !== "frame") throw new DevelopEngineError("develop engine returned no JPEG");
      // Worker の中で JPEG にできなかった（OffscreenCanvas が無い）→ メインスレッドで JPEG にする
      const frame: DevelopFrame = { width: response.width, height: response.height, rgba: new Uint8ClampedArray(response.rgba) };
      return (options.encodeFrameJpeg ?? encodeFrameJpegWithCanvas)(frame, exportOptions.quality);
    },

    async convertEditSettings(editSettings, conversionOptions = {}) {
      const response = await request("convertEditSettings", (id) => ({
        message: {
          type: "convertEditSettings",
          id,
          editSettingsJson: JSON.stringify(editSettings),
          ...(conversionOptions.baseVersion ? { baseVersion: conversionOptions.baseVersion } : {}),
        },
      }));
      if (response.type !== "converted") return BROKEN_CONVERSION;
      return readConversion(response.resultJson);
    },

    async presetSettings(xmp, baseSettings) {
      const response = await request("presetSettings", (id) => ({
        message: {
          type: "presetSettings",
          id,
          xmp,
          baseSettingsJson: baseSettings === null ? null : JSON.stringify(baseSettings),
        },
      }));
      if (response.type !== "preset") throw new DevelopEngineError("develop engine returned no preset settings");
      return presetResultOrThrow(response.resultJson);
    },

    async builtinPresets() {
      const response = await request("builtinPresets", (id) => ({ message: { type: "builtinPresets", id } }));
      if (response.type !== "builtinPresets") throw new DevelopEngineError("develop engine returned no builtin presets");
      const presets = readBuiltinPresets(response.presetsJson);
      if (!presets) throw new DevelopEngineError("develop engine returned invalid builtin presets");
      return presets;
    },

    async close() {
      dropRenders();
      cancelWarmAutoSettings();
      await request("close", (id) => ({ message: { type: "close", id } }));
    },

    dispose() {
      if (status === "disposed" || terminateWhenIdle) return;
      if (status !== "ready" || exportsInFlight === 0) {
        terminate("disposed");
        return;
      }
      // 描き途中の JPEG（記事用の画像）を描き終えてから止める。待っている描画は null で終える
      terminateWhenIdle = true;
      dropRenders();
    },
  };
}
