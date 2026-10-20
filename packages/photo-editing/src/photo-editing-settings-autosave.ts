import type { PhotoEditingSettings } from "./photo-editing-types";

/**
 * 写真ごとの編集内容の自動保存（owner 決定 8、移行時の設計文書「ページの呼び方」）。
 *
 * - 設定が変わったら（スライダーを離した・プリセットを当てた）少し待ってまとめ、最新の 1 つだけを保存する
 * - ドラッグ中は保存しない（ドラッグが続く間は、待っている保存も送らない）
 * - 同じ写真への保存・「初期化」（保存を消す）は前の応答を待ってから送る。後から着いた古い設定で上書きせず、
 *   「初期化」の後の保存が先に着いて消えることもない
 * - 写真を閉じる・画面を離れる前は、待っている保存を送り終えてから close / release を呼ぶ
 *   （release の後の保存は `notFound` になる）
 * - 送り終えていない保存がある間は `hasPendingWork()` が true（ページを閉じる前の確認に使う。変わったら `subscribe`
 *   で知らせる）
 * - 失敗しても編集は止めない。結果は `onResult` で知らせる（呼び出し側が目立たずに出す）
 */

/** 設定が変わってから保存するまで待つ時間。続けて変えた分はまとめて 1 回にする。 */
export const PHOTO_EDITING_AUTOSAVE_DELAY_MS = 800;

export type PhotoEditingAutosaveOperation = "save" | "forget";

export type PhotoEditingAutosaveResult = {
  photoId: string;
  operation: PhotoEditingAutosaveOperation;
  /** 成功なら null */
  error: unknown;
};

export type PhotoEditingSettingsAutosave = {
  /** 設定が変わったとき（スライダーを離した・プリセットを当てた）。少し待ってまとめて保存する */
  schedule: (photoId: string, settings: PhotoEditingSettings) => void;
  /** ドラッグ中。待っている保存をまだ送らない（待ち時間を始めからにする） */
  deferPending: () => void;
  /** 「初期化」。待っている保存を捨て、前の保存の応答を待ってから保存を消す */
  forget: (photoId: string) => void;
  /**
   * 待っている保存を今すぐ送り、その写真の保存・「初期化」がすべて終わったら `then` を呼ぶ
   * （何も待っていなければその場で呼ぶ）。写真を閉じる前に使う
   */
  flush: (photoId: string, then?: () => void) => void;
  /** すべての写真について {@link PhotoEditingSettingsAutosave.flush}。画面を離れる前に使う */
  flushAll: (then?: () => void) => void;
  /**
   * 送り終えていない保存・「初期化」がある（まとめる待ち時間の途中・応答待ちを含む）。ページを閉じる前の確認に使う
   */
  hasPendingWork: () => boolean;
  /** {@link PhotoEditingSettingsAutosave.hasPendingWork} が変わったら `listener` を呼ぶ。外す関数を返す */
  subscribe: (listener: () => void) => () => void;
};

type PhotoQueue = {
  /** まだ送っていない最新の設定 */
  pending: PhotoEditingSettings | null;
  timer: ReturnType<typeof setTimeout> | null;
  forgetQueued: boolean;
  /** 保存か「初期化」の応答を待っている */
  running: boolean;
  idleWaiters: Array<() => void>;
};

export function createPhotoEditingSettingsAutosave(options: {
  save: (photoId: string, settings: PhotoEditingSettings) => Promise<unknown>;
  forget: (photoId: string) => Promise<unknown>;
  onResult?: (result: PhotoEditingAutosaveResult) => void;
  delayMs?: number;
}): PhotoEditingSettingsAutosave {
  const delayMs = options.delayMs ?? PHOTO_EDITING_AUTOSAVE_DELAY_MS;
  // 写真ごとの列は、送り終えていない保存・「初期化」がある間だけある（何も残らなければ pump が消す）
  const queues = new Map<string, PhotoQueue>();
  const pendingListeners = new Set<() => void>();
  let notifiedPending = false;

  /** 送り終えていない保存の有無が変わったら知らせる。 */
  const notifyPendingChange = () => {
    const pending = queues.size > 0;
    if (pending === notifiedPending) return;
    notifiedPending = pending;
    for (const listener of Array.from(pendingListeners)) {
      try {
        listener();
      } catch {
        // 知らせる側の失敗で、保存を止めない
      }
    }
  };

  const queueFor = (photoId: string): PhotoQueue => {
    let queue = queues.get(photoId);
    if (!queue) {
      queue = { pending: null, timer: null, forgetQueued: false, running: false, idleWaiters: [] };
      queues.set(photoId, queue);
      notifyPendingChange();
    }
    return queue;
  };

  const stopTimer = (queue: PhotoQueue) => {
    if (queue.timer === null) return;
    clearTimeout(queue.timer);
    queue.timer = null;
  };

  const startTimer = (photoId: string, queue: PhotoQueue) => {
    stopTimer(queue);
    queue.timer = setTimeout(() => {
      queue.timer = null;
      pump(photoId);
    }, delayMs);
  };

  const report = (result: PhotoEditingAutosaveResult) => {
    try {
      options.onResult?.(result);
    } catch {
      // 知らせる側の失敗で、続く保存を止めない
    }
  };

  const run = (
    photoId: string,
    queue: PhotoQueue,
    operation: PhotoEditingAutosaveOperation,
    call: () => Promise<unknown>,
  ) => {
    queue.running = true;
    let result: Promise<unknown>;
    try {
      result = call();
    } catch (error) {
      result = Promise.reject(error);
    }
    void result
      .then(
        () => report({ photoId, operation, error: null }),
        (error: unknown) => report({ photoId, operation, error }),
      )
      .finally(() => {
        queue.running = false;
        pump(photoId);
      });
  };

  /** 次に送るものがあれば送り、何も残っていなければ待っている人に知らせる。 */
  function pump(photoId: string): void {
    const queue = queues.get(photoId);
    if (!queue || queue.running) return;
    if (queue.forgetQueued) {
      queue.forgetQueued = false;
      run(photoId, queue, "forget", () => options.forget(photoId));
      return;
    }
    if (queue.pending !== null) {
      // 待ち時間の途中なら、時間が来るか flush されるまで送らない
      if (queue.timer !== null) return;
      const settings = queue.pending;
      queue.pending = null;
      run(photoId, queue, "save", () => options.save(photoId, settings));
      return;
    }
    if (queue.timer !== null) return;
    queues.delete(photoId);
    notifyPendingChange();
    for (const then of queue.idleWaiters.splice(0)) {
      try {
        then();
      } catch {
        // 閉じる・止める側の失敗で、ほかの写真の後始末を止めない
      }
    }
  }

  const flush = (photoId: string, then?: () => void) => {
    const queue = queues.get(photoId);
    if (!queue) {
      then?.();
      return;
    }
    stopTimer(queue);
    if (then) queue.idleWaiters.push(then);
    pump(photoId);
  };

  return {
    schedule(photoId, settings) {
      const queue = queueFor(photoId);
      queue.pending = settings;
      startTimer(photoId, queue);
    },
    deferPending() {
      for (const [photoId, queue] of queues) {
        if (queue.timer !== null) startTimer(photoId, queue);
      }
    },
    forget(photoId) {
      const queue = queueFor(photoId);
      stopTimer(queue);
      queue.pending = null;
      queue.forgetQueued = true;
      pump(photoId);
    },
    flush,
    flushAll(then) {
      const photoIds = Array.from(queues.keys());
      if (photoIds.length === 0) {
        then?.();
        return;
      }
      let remaining = photoIds.length;
      const settleOne = () => {
        remaining -= 1;
        if (remaining === 0) then?.();
      };
      for (const photoId of photoIds) flush(photoId, settleOne);
    },
    hasPendingWork: () => queues.size > 0,
    subscribe(listener) {
      pendingListeners.add(listener);
      return () => {
        pendingListeners.delete(listener);
      };
    },
  };
}
