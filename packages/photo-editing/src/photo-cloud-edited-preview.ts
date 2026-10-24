import type { DevelopFrame } from "./develop-engine/develop-engine-client";
import type { PhotoLibrary, PhotoLibraryPhoto } from "./library/photo-library";

/**
 * 写真の補正後のプレビューを上げる（K3 移行元設計・Epic 移行元設計 の決めごと 15。写真ライブラリの派生物の入力・表示・出力の 3 役のうち
 * 「表示」の役）。
 *
 * - 補正を保存した端末が、いま表示している丁寧な画（段 2 の wasm が描いた final の {@link DevelopFrame}）を縮めて上げる。取り直しも
 *   描き直しもしない（一覧のタイル・画像ライブラリ・開いた瞬間の下絵は、この画を出す）
 * - 上げるのは長辺 1024px までの画と、一覧のタイル用の長辺 512px までの画（どちらも JPEG・撮影情報なし。向きは frame のまま）。
 *   使用量には数えない（オリジナルと編集内容から作り直せる派生）
 * - 描き手は差し替えられる。どの端末が描いてもよく、版（`developRevision`）が同じか新しい画が付けば前の画は捨てる（サーバーが
 *   決める）。同じか新しい版がもう付いていれば上げない
 * - 上げられなかったときは画面に出さない（{@link CreateEditedPreviewUploaderOptions.onError} へ渡すだけ）。次に写真を開いたときに
 *   上げ直す
 */
export const EDITED_PREVIEW_LONG_EDGE = 1024;
export const EDITED_PREVIEW_THUMB_LONG_EDGE = 512;
/** API の上限（画 1MiB・タイル 256KiB）。 */
export const EDITED_PREVIEW_MAX_BYTES = 1024 * 1024;
export const EDITED_PREVIEW_THUMB_MAX_BYTES = 256 * 1024;
/** 上限に収まるまで、この順に画質を下げる。 */
const EDITED_PREVIEW_JPEG_QUALITIES = [0.85, 0.78, 0.7, 0.6] as const;
/** 違う写真を同時に上げてよい数。 */
export const EDITED_PREVIEW_UPLOAD_CONCURRENCY = 2;

/**
 * 補正後のプレビューを付ける口（{@link PhotoLibrary.attachEditedPreview}）を持つ置き場か。この Mac の置き場は持たない。持たない置き場で
 * 上げようとしても必ず失敗し、JPEG の縮小と余分な描画だけが走って `console.warn` が出る（実エンジンでの確認で判明）ので、上げない。
 */
export function libraryCanAttachEditedPreview(library: Pick<PhotoLibrary, "attachEditedPreview">): boolean {
  return typeof library.attachEditedPreview === "function";
}

export type EditedPreviewJpeg = { blob: Blob; width: number; height: number };
export type EditedPreviewJpegs = { preview: EditedPreviewJpeg; thumb: EditedPreviewJpeg };

type Canvas2D = CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D;

/** `OffscreenCanvas` と `<canvas>` の違いを隠した、縮める・JPEG にするための最小の面。 */
type EditedPreviewCanvas = {
  context: Canvas2D;
  image: CanvasImageSource;
  toJpeg(quality: number): Promise<Blob | null>;
  release(): void;
};

function createCanvas(width: number, height: number): EditedPreviewCanvas | null {
  if (typeof OffscreenCanvas !== "undefined") {
    const canvas = new OffscreenCanvas(width, height);
    const context = canvas.getContext("2d");
    if (!context) return null;
    return {
      context,
      image: canvas,
      toJpeg: (quality) => canvas.convertToBlob({ type: "image/jpeg", quality }).catch(() => null),
      release: () => {
        canvas.width = 1;
        canvas.height = 1;
      },
    };
  }
  if (typeof document === "undefined") return null;
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const context = canvas.getContext("2d");
  if (!context) return null;
  return {
    context,
    image: canvas,
    toJpeg: (quality) => new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, "image/jpeg", quality)),
    release: () => {
      // iOS Safari は canvas のメモリをすぐ手放さないため、明示的に小さくする
      canvas.width = 1;
      canvas.height = 1;
    },
  };
}

/** 長辺が `longEdge` に収まるように、縦横比を保って縮めた寸法（すでに収まっていればそのまま）。 */
function fitLongEdge(width: number, height: number, longEdge: number): { width: number; height: number } {
  const long = Math.max(width, height);
  if (long <= longEdge) return { width, height };
  const scale = longEdge / long;
  return { width: Math.max(1, Math.round(width * scale)), height: Math.max(1, Math.round(height * scale)) };
}

/**
 * `source`（`sourceWidth` × `sourceHeight`）を `width` × `height` に縮める。大きく縮めるときは半分ずつ縮めて画質を保つ
 * （一度に縮めると、ブラウザの補間が間引きになって粗くなる）。同じ大きさならそのまま返す。作った面は `owned` に足す。
 */
function scaleCanvas(
  source: EditedPreviewCanvas,
  sourceWidth: number,
  sourceHeight: number,
  width: number,
  height: number,
  owned: EditedPreviewCanvas[],
): EditedPreviewCanvas | null {
  let current = source;
  let currentWidth = sourceWidth;
  let currentHeight = sourceHeight;
  while (currentWidth !== width || currentHeight !== height) {
    const nextWidth = Math.max(width, Math.ceil(currentWidth / 2));
    const nextHeight = Math.max(height, Math.ceil(currentHeight / 2));
    const next = createCanvas(nextWidth, nextHeight);
    if (!next) return null;
    owned.push(next);
    next.context.imageSmoothingEnabled = true;
    next.context.imageSmoothingQuality = "high";
    next.context.drawImage(current.image, 0, 0, currentWidth, currentHeight, 0, 0, nextWidth, nextHeight);
    current = next;
    currentWidth = nextWidth;
    currentHeight = nextHeight;
  }
  return current;
}

/** 画質を下げながら JPEG にし、`maxBytes` に収まった最初のものを返す。どの画質でも収まらなければ null。 */
async function encodeUnderLimit(canvas: EditedPreviewCanvas, maxBytes: number, signal?: AbortSignal): Promise<Blob | null> {
  for (const quality of EDITED_PREVIEW_JPEG_QUALITIES) {
    if (signal?.aborted) return null;
    const blob = await canvas.toJpeg(quality);
    // JPEG にできない環境は PNG が返る。上げ先は image/jpeg に固定されているので上げない
    if (blob && blob.type !== "image/jpeg") return null;
    if (blob && blob.size > 0 && blob.size <= maxBytes) return blob;
  }
  return null;
}

/**
 * 段 2 の丁寧な画（{@link DevelopFrame}）を、上げる 2 枚の JPEG（画とタイル）に縮める。画は長辺 `min(1024, frame の長辺)`、
 * タイルは長辺 `min(512, frame の長辺)`（向きは frame のまま・撮影情報なし）。上限（画 1MiB・タイル 256KiB）に収まるまで画質を
 * 下げ、収まらなければ null。canvas が無い環境・frame が壊れているときも null（上げない）。`OffscreenCanvas` があればそれで描く。
 */
export async function encodeEditedPreviewJpegs(
  frame: DevelopFrame,
  options: { signal?: AbortSignal } = {},
): Promise<EditedPreviewJpegs | null> {
  const { width, height, rgba } = frame;
  if (!Number.isInteger(width) || !Number.isInteger(height) || width < 1 || height < 1) return null;
  if (rgba.length !== width * height * 4) return null;

  const owned: EditedPreviewCanvas[] = [];
  try {
    const base = createCanvas(width, height);
    if (!base) return null;
    owned.push(base);
    base.context.putImageData(new ImageData(rgba, width, height), 0, 0);

    const previewSize = fitLongEdge(width, height, EDITED_PREVIEW_LONG_EDGE);
    const thumbSize = fitLongEdge(width, height, EDITED_PREVIEW_THUMB_LONG_EDGE);
    const previewCanvas = scaleCanvas(base, width, height, previewSize.width, previewSize.height, owned);
    // タイルは縮めた画から縮める（1 段で済み、元の大きさから縮めるより速い）
    const thumbCanvas =
      previewCanvas && scaleCanvas(previewCanvas, previewSize.width, previewSize.height, thumbSize.width, thumbSize.height, owned);
    if (!previewCanvas || !thumbCanvas) return null;

    const previewBlob = await encodeUnderLimit(previewCanvas, EDITED_PREVIEW_MAX_BYTES, options.signal);
    if (!previewBlob) return null;
    const thumbBlob = await encodeUnderLimit(thumbCanvas, EDITED_PREVIEW_THUMB_MAX_BYTES, options.signal);
    if (!thumbBlob) return null;
    return {
      preview: { blob: previewBlob, ...previewSize },
      thumb: { blob: thumbBlob, ...thumbSize },
    };
  } finally {
    for (const canvas of owned) canvas.release();
  }
}

// ---------------------------------------------------------------------------
// 上げる

/** 上げ終わったとき（付いた・もう付いていた）の結果。 */
export type EditedPreviewUploaded = {
  /**
   * 付いた後の写真。`editedPreview` の `url`・`thumbUrl` は null（一覧だけが読み取り URL を出す）。同じか新しい版がもう付いていて
   * 今の写真を持っていないとき（409 superseded）は null。
   */
  photo: PhotoLibraryPhoto | null;
  /** 付けたタイル（画面が一覧のタイルをすぐ差し替えるための Blob）。何も上げなかったとき（`upload: null`・superseded）は null。 */
  thumbBlob: Blob | null;
};

export type CreateEditedPreviewUploaderOptions = {
  /**
   * 縮めた 2 枚を写真に付ける（接続口 `PhotoLibrary` の `attachEditedPreview`。クラウドは web の `attachEditedPreviewJpegs`。移行元設計）。
   * 同じか新しい版がもう付いていれば何も上げずに返す
   */
  attach: (
    photoId: string,
    developRevision: number,
    encoded: EditedPreviewJpegs,
    signal: AbortSignal,
  ) => Promise<EditedPreviewUploaded>;
  /** frame を 2 枚の JPEG にする。省略時は {@link encodeEditedPreviewJpegs}。 */
  encode?: (frame: DevelopFrame, options?: { signal?: AbortSignal }) => Promise<EditedPreviewJpegs | null>;
  /** 上げ終わった（付いた・もう付いていた）とき。`dispose()` の後は呼ばない。 */
  onUploaded?: (photoId: string, result: EditedPreviewUploaded) => void;
  /** 上げられなかったとき（画面には出さない想定。次に開いたときに上げ直す）。`dispose()` の後は呼ばない。 */
  onError?: (photoId: string, error: unknown) => void;
};

export type EditedPreviewUploader = {
  /**
   * 補正を保存した写真の、いま表示している画（保存の応答の `photo.developRevision` で描いた final の frame）を上げる。
   * `frame` は上げ終わる（縮めて JPEG にする）まで書き換えない。同じ写真で上げている間の呼び出しは、待ちを版の大きい 1 件だけ残す
   * （同じか古い版は捨てる）。違う写真は並べて上げる（同時に {@link EDITED_PREVIEW_UPLOAD_CONCURRENCY} 本まで）。
   */
  submit(photoId: string, request: { developRevision: number; frame: DevelopFrame }): void;
  /** 待ちを捨て、上げている途中は止める。以後は何もしない（callback も呼ばない）。 */
  dispose(): void;
};

type PendingJob = { developRevision: number; frame: DevelopFrame };
type PhotoQueue = {
  running: { developRevision: number; controller: AbortController } | null;
  pending: PendingJob | null;
  /** `waiting`（順番待ち）に並んでいるか */
  queued: boolean;
};

function notify(callback: () => void): void {
  try {
    callback();
  } catch (error) {
    // 画面の callback の失敗で、ほかの写真の順番待ちを止めない
    console.error("[photo-editing] edited preview callback failed", error);
  }
}

export function createEditedPreviewUploader(options: CreateEditedPreviewUploaderOptions): EditedPreviewUploader {
  const { attach, onUploaded, onError } = options;
  const encode = options.encode ?? encodeEditedPreviewJpegs;
  const photos = new Map<string, PhotoQueue>();
  /** 上げる順番を待っている写真（先に待った順）。 */
  const waiting: string[] = [];
  let active = 0;
  let disposed = false;

  /** 1 件を上げる。throw しない（失敗は `onError`）。 */
  const runJob = async (photoId: string, job: PendingJob, signal: AbortSignal): Promise<void> => {
    let uploaded: EditedPreviewUploaded;
    try {
      const encoded = await encode(job.frame, { signal });
      // 描けなかった（上限に収まらない・canvas が無い）ときは何もしない
      if (signal.aborted) return;
      if (!encoded) {
        notify(() => onError?.(photoId, new Error("edited preview could not be encoded")));
        return;
      }
      uploaded = await attach(photoId, job.developRevision, encoded, signal);
    } catch (error) {
      if (signal.aborted) return;
      notify(() => onError?.(photoId, error));
      return;
    }
    if (signal.aborted) return;
    notify(() => onUploaded?.(photoId, uploaded));
  };

  const pump = (): void => {
    while (!disposed && active < EDITED_PREVIEW_UPLOAD_CONCURRENCY) {
      const photoId = waiting.shift();
      if (photoId === undefined) return;
      const queue = photos.get(photoId);
      const job = queue?.pending;
      if (!queue || !job) continue;
      queue.pending = null;
      queue.queued = false;
      const controller = new AbortController();
      queue.running = { developRevision: job.developRevision, controller };
      active += 1;
      void runJob(photoId, job, controller.signal).finally(() => {
        active -= 1;
        queue.running = null;
        if (disposed) return;
        if (queue.pending) {
          // 上げている間に次の版が来ていた。ほかの写真の後ろに並ぶ
          queue.queued = true;
          waiting.push(photoId);
        } else if (photos.get(photoId) === queue) {
          photos.delete(photoId);
        }
        pump();
      });
    }
  };

  return {
    submit(photoId, request) {
      if (disposed) return;
      const queue = photos.get(photoId) ?? { running: null, pending: null, queued: false };
      const newest = Math.max(
        queue.running?.developRevision ?? Number.NEGATIVE_INFINITY,
        queue.pending?.developRevision ?? Number.NEGATIVE_INFINITY,
      );
      // 上げている・待っている版と同じか古い版は上げても意味が無い（サーバーも同じか古い版は付けない）
      if (request.developRevision <= newest) return;
      queue.pending = { developRevision: request.developRevision, frame: request.frame };
      photos.set(photoId, queue);
      if (!queue.running && !queue.queued) {
        queue.queued = true;
        waiting.push(photoId);
      }
      pump();
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      waiting.length = 0;
      for (const queue of photos.values()) {
        queue.pending = null;
        queue.running?.controller.abort();
      }
      photos.clear();
    },
  };
}
