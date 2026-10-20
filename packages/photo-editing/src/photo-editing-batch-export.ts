/**
 * 複数枚の書き出し（owner 決定 7、移行時の設計文書「ページの呼び方」）。
 *
 * - 書き出し先のフォルダを 1 回だけ選ぶ（閉じたら何もしない）
 * - 写真ごとに前の応答を待ってから次を書き出す（エンジンに一度に積まない）
 * - 失敗した写真は記録して次へ進む。`engineUnavailable` も次の要求でエンジンが起動し直すので進んでよい
 * - `folderNotFound`（フォルダを消した・外付けを外した）は残りも同じなので止める
 * - 止める操作（`signal`）は書き出し中の 1 枚が終わってから効く
 */

export type PhotoEditingBatchExportTarget = {
  photoId: string;
  fileName: string;
};

export type PhotoEditingBatchExportFailure = PhotoEditingBatchExportTarget & {
  error: unknown;
};

export type PhotoEditingBatchExportResult =
  /** フォルダの選択を閉じた */
  | { status: "cancelled" }
  | {
      /** `completed` は最後まで進んだ（失敗した写真を含む）。`stopped` は途中で止めた */
      status: "completed" | "stopped" | "folderNotFound";
      total: number;
      savedCount: number;
      failures: PhotoEditingBatchExportFailure[];
      /** `folderNotFound` のときの失敗 */
      folderError: unknown;
    };

export type PhotoEditingBatchExportProgress = {
  /** 書き出し中の写真の番号（1 から） */
  index: number;
  total: number;
  target: PhotoEditingBatchExportTarget;
};

export type PhotoEditingBatchSequenceResult = {
  status: "completed" | "stopped";
  total: number;
  savedCount: number;
  failures: PhotoEditingBatchExportFailure[];
};

/**
 * 複数枚を指定された順に 1 枚ずつ処理する共通部分。写真ごとの失敗は記録して次へ進み、停止は処理中の 1 枚が終わったあとに効く。
 * Desktop のフォルダ書き出しと、ブラウザの ZIP 書き出しが同じ意味で使う。
 */
export async function runPhotoEditingBatchSequence(options: {
  targets: readonly PhotoEditingBatchExportTarget[];
  exportPhoto: (target: PhotoEditingBatchExportTarget) => Promise<boolean>;
  signal?: AbortSignal;
  onProgress?: (progress: PhotoEditingBatchExportProgress) => void;
}): Promise<PhotoEditingBatchSequenceResult> {
  const total = options.targets.length;
  const failures: PhotoEditingBatchExportFailure[] = [];
  let savedCount = 0;
  for (const [index, target] of options.targets.entries()) {
    if (options.signal?.aborted) return { status: "stopped", total, savedCount, failures };
    options.onProgress?.({ index: index + 1, total, target });
    try {
      if (await options.exportPhoto(target)) savedCount += 1;
    } catch (error) {
      failures.push({ ...target, error });
    }
  }
  return { status: "completed", total, savedCount, failures };
}

export async function runPhotoEditingBatchExport(options: {
  targets: readonly PhotoEditingBatchExportTarget[];
  chooseFolder: () => Promise<string | null>;
  /** 1 枚を書き出す。書き出さなかった（途中で閉じた写真など）ときは false */
  exportPhoto: (target: PhotoEditingBatchExportTarget, folderId: string) => Promise<boolean>;
  /**
   * 書き出し先のフォルダが無くなった失敗か（残りも書けないので止める。写真の出どころの `errors.isExportFolderNotFound`。移行元設計）
   */
  isFolderNotFound: (error: unknown) => boolean;
  signal?: AbortSignal;
  onProgress?: (progress: PhotoEditingBatchExportProgress) => void;
}): Promise<PhotoEditingBatchExportResult> {
  const folderId = await options.chooseFolder();
  if (!folderId) return { status: "cancelled" };

  let folderError: unknown = null;
  const controller = new AbortController();
  const stopWhenRequested = () => controller.abort();
  options.signal?.addEventListener("abort", stopWhenRequested, { once: true });
  if (options.signal?.aborted) controller.abort();
  try {
    const result = await runPhotoEditingBatchSequence({
      targets: options.targets,
      signal: controller.signal,
      onProgress: options.onProgress,
      exportPhoto: async (target) => {
        try {
          return await options.exportPhoto(target, folderId);
        } catch (error) {
          if (!options.isFolderNotFound(error)) throw error;
          folderError = error;
          controller.abort();
          // この写真は保存できていない。共通 runner には通常失敗として積ませず、Desktop 固有の停止理由として返す。
          return false;
        }
      },
    });
    if (folderError !== null) {
      return {
        status: "folderNotFound",
        total: result.total,
        savedCount: result.savedCount,
        failures: result.failures,
        folderError,
      };
    }
    return { ...result, folderError: null };
  } finally {
    options.signal?.removeEventListener("abort", stopWhenRequested);
  }
}
