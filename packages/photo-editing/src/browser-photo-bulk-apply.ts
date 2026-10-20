import type { DevelopPresetAsShotSource, DevelopPresetResult } from "./develop-engine/develop-engine-client";
import { resolveDevelopOpenSettings } from "./develop-engine/develop-open-settings";
import {
  browserEditingDevelopSettings,
  hasSavedDevelopSettings,
  isEditableDevelopSettings,
  neutralDevelopSettings,
  pasteDevelopSettings,
  presetDevelopSettings,
  readDevelopSettings,
  sameDevelopSettings,
  type CopiedDevelopSettings,
  type DevelopSettings,
} from "./develop-engine/develop-settings";
import type {
  PhotoLibraryItem,
  PhotoLibraryPhoto,
  PhotoLibrarySaveResult,
  PhotoLibraryWorkingCopyResult,
} from "./library/photo-library";
import { isDevelopDirectRasterOriginal, isDevelopWorkTarget } from "./develop-engine/develop-work-target";

/**
 * 一覧で選んだ複数枚への一括の補正（F5a-2 移行元設計。「1 枚を直して残り 29 枚へ貼り付け」「50 枚に一括でプリセット」）の純粋な核。
 * React に依存させず、保存・作業コピーの確認・プリセットの計算は外から渡す（`use-browser-photo-bulk.ts` が engine と接続口
 * `PhotoLibrary` の `saveDevelopSettings`・`ensureWorkingCopy` を渡す。移行元設計）。
 *
 * - 写真は選んだ順に、同時に `concurrency`（既定 3）枚まで。進み具合は 1 枚終えるたびに知らせる
 * - 1 枚ごとに: 準備中（作業コピーが要る写真で、`workStatus` が `ready` でない・作業コピーの土台の版が分からない）を飛ばす →
 *   直せない写真（元の写真が無い・今の画面が読めない版の補正〔前方互換: 知らない版は書かない〕・作業コピーを作らない・変換できない
 *   プリセット）を飛ばす → 1 枚で開いたときと同じ決め方の今の補正（`resolveDevelopOpenSettings` → `browserEditingDevelopSettings`。
 *   補正を保存したことが無ければ neutral〔JPEG / PNG を直接描く写真と raster の作業コピーは niho-6、RAW などは niho-2〕。作業コピーの上で
 *   直す写真は `base` が作業コピーの版）に、貼り付け（`pasteDevelopSettings`）か
 *   プリセット（100%。`presetDevelopSettings`）を当てる → 今と同じなら保存しない（変わらない） → `expectedRevision` = 一覧の版・
 *   `editedPreviewBy: "server"`（補正後のプレビューはワーカーがすぐ描く）で保存する
 * - 保存の結果が `stale`（409 `photo_cloud_develop_revision_stale`）は飛ばして「別の端末で先に直された」に数える（今の写真を返す）。ほかの失敗は
 *   「保存できなかった」に数えて続ける（同じ写真を自動で再試行しない）
 * - 止める（`stopSignal`）: 新しい写真を始めず、走っている分は終えて集計を返す。打ち切る（`cancelSignal`。画面を離れた・拠点や
 *   権限が変わった）: 新しい写真を始めず、作業コピーの確認を止め、まだ保存していない写真は保存しない
 * - 保存できた写真は「当てる前の補正」（保存したことが無ければ neutral）と「保存直後の版」を覚え、元に戻す（{@link runBrowserPhotoBulkUndo}）
 *   に渡す
 */

/** 同時に直す写真の数の既定。 */
export const BROWSER_PHOTO_BULK_CONCURRENCY = 3;

/** 一括で直す写真（一覧の行の要る分）。 */
export type BrowserPhotoBulkPhoto = Pick<
  PhotoLibraryItem,
  "id" | "fileName" | "fileExtension" | "sizeBytes" | "hasOriginal" | "developSettings" | "developRevision" | "workStatus"
>;

/** 次の補正の作り方。 */
export type BrowserPhotoBulkRecipe =
  | { kind: "paste"; copied: CopiedDevelopSettings }
  | {
      kind: "preset";
      /** 画面に出している名前（状態欄の文に使う） */
      name: string;
      /**
       * プリセットを `base` に 100% で当てる（engine の `applyPreset(xmp, base, 1, asShot)`）。撮影時の白は開いている写真ではなく、
       * 作業コピーのメタ（JPEG / PNG は null）から引く
       */
      apply: (base: DevelopSettings, asShot: DevelopPresetAsShotSource) => Promise<DevelopPresetResult>;
    };

/** 1 枚の保存（接続口の `saveDevelopSettings`。通れば `saved`、別の端末が先に保存していたら `stale`。ほかの失敗は throw）。 */
export type BrowserPhotoBulkSave = (
  photoId: string,
  settings: DevelopSettings,
  options: { expectedRevision: number; editedPreviewBy: "server" },
) => Promise<PhotoLibrarySaveResult>;

/** 作業コピーの土台の版とメタ（`work/download`。署名 URL を取るだけで作業コピーは落とさない）。 */
export type BrowserPhotoBulkWorkDownload = (
  photoId: string,
  signal: AbortSignal | undefined,
) => Promise<PhotoLibraryWorkingCopyResult>;

/** 元に戻す 1 枚（当てる前の補正と、一括で保存した直後の版）。 */
export type BrowserPhotoBulkUndoEntry = {
  photoId: string;
  /** 当てる前の補正（保存したことが無ければ neutral） */
  before: DevelopSettings;
  /** 一括で保存した直後の `developRevision`（元に戻すときの `expectedRevision`） */
  revision: number;
};

/** 1 枚の結果。 */
export type BrowserPhotoBulkLockedReason = "unsupported" | "base_mismatch" | "base_unavailable" | "reader_incompatible";

export type BrowserPhotoBulkPhotoOutcome =
  | { kind: "applied"; photo: PhotoLibraryPhoto; undo: BrowserPhotoBulkUndoEntry }
  /** 作業コピーを待っている（当てていない） */
  | { kind: "preparing" }
  /** 直せない（元の写真が無い・読めない版の補正・作業コピーを作らない・変換できないプリセット） */
  | { kind: "locked"; reason?: BrowserPhotoBulkLockedReason }
  /** 当てても今と同じ（保存していない） */
  | { kind: "unchanged" }
  /** 別の端末で先に直された（409。今の写真） */
  | { kind: "stale"; photo: PhotoLibraryPhoto }
  /** 保存できなかった（ほかの失敗） */
  | { kind: "failed"; error: unknown }
  /** 打ち切った（保存していない。数えない） */
  | { kind: "cancelled" };

export type BrowserPhotoBulkCounts = {
  applied: number;
  preparing: number;
  locked: number;
  unchanged: number;
  stale: number;
  failed: number;
};

export type BrowserPhotoBulkResult = {
  total: number;
  counts: BrowserPhotoBulkCounts;
  /** 終端理由。準備中へ戻さず、単独の一括callerも利用者へ復元・再読み込み案内を出せる。 */
  lockedReasons: Record<BrowserPhotoBulkLockedReason, number>;
  /** 止めた・打ち切った（始めていない写真が残った） */
  stopped: boolean;
  /** 始めていない（打ち切って保存しなかった分を含む）写真の数 */
  notStarted: number;
  /** 保存できた写真の元に戻す材料（選んだ順） */
  undo: BrowserPhotoBulkUndoEntry[];
};

export type BrowserPhotoBulkProgress = { done: number; total: number };

/** 同時に `concurrency` 枚まで、並びの順に始める（止めたら新しい分を始めない）。結果は並びの位置に入れる。 */
async function runInOrder<T, R>(params: {
  items: readonly T[];
  concurrency: number;
  shouldStop: () => boolean;
  run: (item: T, index: number) => Promise<R>;
  onDone: (result: R, index: number) => void;
}): Promise<{ results: (R | undefined)[]; started: number }> {
  const { items, shouldStop, run, onDone } = params;
  const results: (R | undefined)[] = new Array<R | undefined>(items.length).fill(undefined);
  let next = 0;
  const worker = async () => {
    while (next < items.length && !shouldStop()) {
      const index = next;
      next += 1;
      const result = await run(items[index]!, index);
      results[index] = result;
      onDone(result, index);
    }
  };
  const workers = Math.max(1, Math.min(params.concurrency, items.length));
  await Promise.all(Array.from({ length: workers }, () => worker()));
  return { results, started: next };
}

function emptyCounts(): BrowserPhotoBulkCounts {
  return { applied: 0, preparing: 0, locked: 0, unchanged: 0, stale: 0, failed: 0 };
}

/**
 * 1 枚に当てる。投げない（失敗は `failed`）。
 */
async function applyToPhoto(
  photo: BrowserPhotoBulkPhoto,
  params: {
    recipe: BrowserPhotoBulkRecipe;
    save: BrowserPhotoBulkSave;
    workDownload: BrowserPhotoBulkWorkDownload;
    cancelSignal: AbortSignal | undefined;
  },
): Promise<BrowserPhotoBulkPhotoOutcome> {
  const { recipe, save, workDownload, cancelSignal } = params;
  // 元の写真の無い写真（記事の画像）は編集できない
  if (!photo.hasOriginal) return { kind: "locked" };
  // 今の画面が読めない版の補正は書かない（前方互換: 新しい版の NIHO で保存した補正を古い数式で上書きしない）
  const stored = hasSavedDevelopSettings(photo) ? readDevelopSettings(photo.developSettings) : null;
  if (hasSavedDevelopSettings(photo) && (!stored || !isEditableDevelopSettings(photo.developSettings))) {
    return { kind: "locked" };
  }
  let baseVersion: string | null = null;
  let workMeta: unknown;
  let workMetaJson: string | null = null;
  try {
    // 作業コピーが要る写真（RAW・HEIC など）は、できていて土台の版が分かるときだけ当てる
    if (isDevelopWorkTarget(photo)) {
      if (photo.workStatus !== "ready") return { kind: "preparing" };
      const work = await workDownload(photo.id, cancelSignal);
      if (cancelSignal?.aborted) return { kind: "cancelled" };
      if (work.kind === "notReady") return { kind: "preparing" };
      if (work.kind === "notApplicable") return { kind: "locked" };
      if (work.kind === "baseUnavailable") return { kind: "locked", reason: "base_unavailable" };
      if (work.kind === "incompatible") return { kind: "locked", reason: "reader_incompatible" };
      baseVersion = work.download.work.baseVersion;
      workMeta = work.download.work.meta;
      workMetaJson = JSON.stringify(work.download.work.meta);
    }
    // 1 枚で開いたときと同じ決め方の今の補正（保存したことが無ければ neutral。保存済み base があれば同じ版だけを使う）
    const resolved = resolveDevelopOpenSettings({ cloudPhoto: photo, baseVersion, workMeta });
    if (resolved.kind === "newer") return { kind: "locked", reason: "unsupported" };
    if (resolved.kind === "baseMismatch") return { kind: "locked", reason: "base_mismatch" };
    // 保存したことの無い写真を作業コピーなしで直すときの neutral は、JPEG / PNG をオリジナルから直接描く写真だけ niho-6。ほか
    // （RAW など）は niho-2（`editedPreviewBy: "server"` で保存し、ワーカーが描く。niho-6 は RAW を描けない。移行元設計）
    const unsavedBase =
      baseVersion === null && !isDevelopDirectRasterOriginal(photo) ? neutralDevelopSettings(null, { raw: true }) : null;
    const current = browserEditingDevelopSettings(resolved.baseSettings ?? unsavedBase);
    let next: DevelopSettings;
    if (recipe.kind === "paste") {
      next = pasteDevelopSettings(current, recipe.copied);
    } else {
      const result = await recipe.apply(current, { workMetaJson });
      if (cancelSignal?.aborted) return { kind: "cancelled" };
      // 段 2 で扱えない項目が残るプリセットは当てない（黙って落とさない）
      if (!result.converted) return { kind: "locked" };
      next = presetDevelopSettings(current, result.settings);
    }
    if (sameDevelopSettings(next, current)) return { kind: "unchanged" };
    if (cancelSignal?.aborted) return { kind: "cancelled" };
    let saved: PhotoLibraryPhoto;
    try {
      const result = await save(photo.id, next, { expectedRevision: photo.developRevision, editedPreviewBy: "server" });
      if (result.kind === "stale") return { kind: "stale", photo: result.photo };
      saved = result.photo;
    } catch (error) {
      return { kind: "failed", error };
    }
    return {
      kind: "applied",
      photo: saved,
      // 当てる前の補正（保存したことが無ければ、1 枚で開いたときの neutral）
      undo: { photoId: photo.id, before: stored ?? current, revision: saved.developRevision },
    };
  } catch (error) {
    if (cancelSignal?.aborted) return { kind: "cancelled" };
    return { kind: "failed", error };
  }
}

/**
 * 選んだ写真（選んだ順）に一括で当てる。投げない（1 枚ずつの失敗は集計に入れる）。
 */
export async function runBrowserPhotoBulkApply(params: {
  photos: readonly BrowserPhotoBulkPhoto[];
  recipe: BrowserPhotoBulkRecipe;
  save: BrowserPhotoBulkSave;
  workDownload: BrowserPhotoBulkWorkDownload;
  /** 止める（新しい写真を始めない。走っている分は終える） */
  stopSignal?: AbortSignal;
  /** 打ち切る（新しい写真を始めず、まだ保存していない写真は保存しない） */
  cancelSignal?: AbortSignal;
  concurrency?: number;
  onProgress?: (progress: BrowserPhotoBulkProgress) => void;
  /** 1 枚終えるたび（保存できた・別の端末で先に直されていた写真を一覧に反映する） */
  onPhotoDone?: (photoId: string, outcome: BrowserPhotoBulkPhotoOutcome) => void;
}): Promise<BrowserPhotoBulkResult> {
  const { photos, stopSignal, cancelSignal } = params;
  const total = photos.length;
  const counts = emptyCounts();
  const lockedReasons: Record<BrowserPhotoBulkLockedReason, number> = {
    unsupported: 0,
    base_mismatch: 0,
    base_unavailable: 0,
    reader_incompatible: 0,
  };
  let done = 0;
  let cancelled = 0;
  const { results, started } = await runInOrder({
    items: photos,
    concurrency: params.concurrency ?? BROWSER_PHOTO_BULK_CONCURRENCY,
    shouldStop: () => stopSignal?.aborted === true || cancelSignal?.aborted === true,
    run: (photo) =>
      applyToPhoto(photo, {
        recipe: params.recipe,
        save: params.save,
        workDownload: params.workDownload,
        cancelSignal,
      }),
    onDone: (outcome, index) => {
      if (outcome.kind === "cancelled") cancelled += 1;
      else counts[outcome.kind] += 1;
      if (outcome.kind === "locked" && outcome.reason !== undefined) lockedReasons[outcome.reason] += 1;
      done += 1;
      params.onPhotoDone?.(photos[index]!.id, outcome);
      params.onProgress?.({ done, total });
    },
  });
  const undo: BrowserPhotoBulkUndoEntry[] = [];
  for (const outcome of results) if (outcome?.kind === "applied") undo.push(outcome.undo);
  const notStarted = total - started + cancelled;
  return { total, counts, lockedReasons, stopped: notStarted > 0, notStarted, undo };
}

/** 元に戻す 1 枚の結果。 */
export type BrowserPhotoBulkUndoOutcome =
  | { kind: "undone"; photo: PhotoLibraryPhoto }
  /** その後に直されていた（409。戻していない） */
  | { kind: "stale"; photo: PhotoLibraryPhoto }
  | { kind: "failed"; error: unknown }
  | { kind: "cancelled" };

export type BrowserPhotoBulkUndoResult = {
  total: number;
  counts: { undone: number; stale: number; failed: number };
  stopped: boolean;
  notStarted: number;
};

/**
 * 一括で保存した写真を、当てる前の補正に戻す（1 回きり）。覚えた補正を `expectedRevision` = 一括で保存した直後の版で保存し直し、
 * その後に直されていた写真（409）は戻さずに数える。投げない。
 */
export async function runBrowserPhotoBulkUndo(params: {
  entries: readonly BrowserPhotoBulkUndoEntry[];
  save: BrowserPhotoBulkSave;
  stopSignal?: AbortSignal;
  cancelSignal?: AbortSignal;
  concurrency?: number;
  onProgress?: (progress: BrowserPhotoBulkProgress) => void;
  onPhotoDone?: (photoId: string, outcome: BrowserPhotoBulkUndoOutcome) => void;
}): Promise<BrowserPhotoBulkUndoResult> {
  const { entries, save, stopSignal, cancelSignal } = params;
  const total = entries.length;
  const counts = { undone: 0, stale: 0, failed: 0 };
  let done = 0;
  let cancelled = 0;
  const { started } = await runInOrder({
    items: entries,
    concurrency: params.concurrency ?? BROWSER_PHOTO_BULK_CONCURRENCY,
    shouldStop: () => stopSignal?.aborted === true || cancelSignal?.aborted === true,
    run: async (entry): Promise<BrowserPhotoBulkUndoOutcome> => {
      if (cancelSignal?.aborted) return { kind: "cancelled" };
      try {
        const result = await save(entry.photoId, entry.before, {
          expectedRevision: entry.revision,
          editedPreviewBy: "server",
        });
        return result.kind === "stale" ? { kind: "stale", photo: result.photo } : { kind: "undone", photo: result.photo };
      } catch (error) {
        return { kind: "failed", error };
      }
    },
    onDone: (outcome, index) => {
      if (outcome.kind === "cancelled") cancelled += 1;
      else counts[outcome.kind] += 1;
      done += 1;
      params.onPhotoDone?.(entries[index]!.photoId, outcome);
      params.onProgress?.({ done, total });
    },
  });
  const notStarted = total - started + cancelled;
  return { total, counts, stopped: notStarted > 0, notStarted };
}
