import { PHOTO_EDITING_AUTOSAVE_DELAY_MS } from "../photo-editing-settings-autosave";
import type { DevelopSettings } from "./develop-settings";
import type { PhotoLibraryPhoto, PhotoLibrarySaveResult } from "../library/photo-library";

/**
 * ブラウザで直している 1 枚の編集内容（`developSettings`）の自動保存（移行元設計。移行時の設計文書
 * 「自動保存と補正後のプレビュー」）。写真ごとに作る。
 *
 * - スライダーを動かしたら 800ms まとめて、最新の値だけを `PUT .../develop-settings` へ送る。同じ写真への保存は直列
 *   （前の応答を待ってから次）。成功応答の `developRevision` と送った値を「保存済み」として持つ（補正後のプレビューは、この値で
 *   描いた画だけをこの版で上げる。K3 移行元設計）
 * - 失敗のうち、写真が無い（404）・形が違う（400）・権限が無い（403。見分けは写真の出どころの `errors.isPermanentSaveFailure`）は
 *   送り直しても通らないので、まだ送っていない値を捨てて
 *   終える（離れるのを止めない）。ほか（通信・5xx・版の照合でない 409・429 など）は値を残して `failed` にし、自動では送り
 *   直さない（次の変更・`flush`・`retry` で送る）
 * - `flush` は待ちを止めて今すぐ送り、送り終わるまで待つ（写真を離れる前）。送り直せる失敗で値が残れば `ok: false`
 * - 版の照合（F1b 移行元設計）: 作るときに直し始めた版（開いた写真の `developRevision`）を渡すと、保存のたびに `expectedRevision` と
 *   して送り、通るたびに応答の版へ進める。別の端末が先に保存していた（保存の結果が `stale`。接続口 `PhotoLibrary` の
 *   `saveDevelopSettings` が 409 `photo_cloud_develop_revision_stale` をこの結果にする。移行元設計）ら、まだ送って
 *   いない値を捨てて止まり（`failed` にしない・自動で送り直さない・以後の変更も送らない）、`onStale`（今の写真）を 1 回呼ぶ。
 *   画面は今の写真で開き直し、保存係をその版で作り直す。止まった後の `flush` は `ok: true`（保存したものは無い）で、離れるのを
 *   止めない。版を渡さずに作れば、今までどおり後の保存が勝つ
 */

export type DevelopSettingsSaverState = "idle" | "waiting" | "saving" | "failed";

export type DevelopSettingsLastSaved = {
  settings: DevelopSettings;
  developRevision: number;
  developSettingsUpdatedAt: string | null;
};

export type DevelopSettingsFlushResult =
  | { ok: true; saved: DevelopSettingsLastSaved | null; dropped?: unknown }
  | { ok: false; error: unknown };

export type DevelopSettingsSaver = {
  /** 変えた値を持ち、まとめる待ちを始め直す */
  schedule: (settings: DevelopSettings) => void;
  /** 待ちを止めて今すぐ送り、送り終わるまで待つ */
  flush: () => Promise<DevelopSettingsFlushResult>;
  /** 失敗した値を送り直す（{@link DevelopSettingsSaver.flush} と同じ） */
  retry: () => Promise<DevelopSettingsFlushResult>;
  getState: () => DevelopSettingsSaverState;
  getLastSaved: () => DevelopSettingsLastSaved | null;
  getLastError: () => unknown;
  /** 送り終えていない値がある（まとめる待ち・送信中・失敗して残っている） */
  hasPendingWork: () => boolean;
  /** 直し始めた版（保存が通るたびに応答の版へ進む）。版を渡さずに作った保存係は undefined */
  getExpectedRevision: () => number | undefined;
  /** まとめる待ちを止める（以後の変更は受けず、まだ送っていない値は flush されない限り送らない。送信中の保存は捨てない） */
  dispose: () => void;
};

export function createDevelopSettingsSaver(options: {
  /**
   * 1 回の保存（接続口 `PhotoLibrary` の `saveDevelopSettings`）。`expectedRevision` は直し始めた版（版を渡さずに作った保存係は
   * undefined）。別の端末が先に保存していたら `stale`、ほかの失敗は投げる
   */
  save: (settings: DevelopSettings, expectedRevision: number | undefined) => Promise<PhotoLibrarySaveResult>;
  /**
   * 送り直しても通らない失敗か（写真が無い・形が違う・権限が無い。接続口 `PhotoLibrary` の `errors.isPermanentSaveFailure`。移行元設計）
   */
  isPermanentFailure: (error: unknown) => boolean;
  /** 直し始めた版（開いた写真の `developRevision`）。省けば版を送らない（後の保存が勝つ） */
  expectedRevision?: number;
  delayMs?: number;
  onChange?: () => void;
  /** schedule の値を debounce / 通信より前に同期退避する。返した印は、その値の保存成功時にだけ onSaved へ返す。 */
  onScheduled?: (settings: DevelopSettings) => unknown;
  /** 送った値の保存が成功したとき。送信中に schedule された新しい値の印とは混ぜない。 */
  onSaved?: (settings: DevelopSettings, scheduled: unknown) => void;
  /** 送り直しても通らない失敗で、まだ送っていない値を捨てたとき（画面に 1 回出す） */
  onDropped?: (error: unknown) => void;
  /** 別の端末が先に保存していたので断られ、まだ送っていない値を捨てて止まったとき（今の写真。1 回だけ） */
  onStale?: (photo: PhotoLibraryPhoto) => void;
}): DevelopSettingsSaver {
  const delayMs = options.delayMs ?? PHOTO_EDITING_AUTOSAVE_DELAY_MS;
  /** 直し始めた版（保存が通るたびに応答の版へ進む） */
  let expectedRevision = options.expectedRevision;
  /** 別の端末が先に保存していたので止まった（以後は送らない） */
  let stale = false;
  /** まだ送っていない最新の値と、schedule 時に同期退避したその世代の印。 */
  let pending: { settings: DevelopSettings; scheduled: unknown } | null = null;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let sending = false;
  /** 送り直せる失敗で値が残っている（次の変更・flush・retry まで送らない） */
  let failed = false;
  let lastSaved: DevelopSettingsLastSaved | null = null;
  let lastError: unknown = null;
  /** 送り直しても通らない失敗で捨てた（次の flush の結果に添える） */
  let dropped: unknown = undefined;
  let disposed = false;
  let flushWaiters: Array<(result: DevelopSettingsFlushResult) => void> = [];
  let notifiedState: DevelopSettingsSaverState = "idle";
  let notifiedLastSaved: DevelopSettingsLastSaved | null = null;

  const currentState = (): DevelopSettingsSaverState => {
    if (sending) return "saving";
    if (failed) return "failed";
    if (timer !== null || pending !== null) return "waiting";
    return "idle";
  };

  const notify = () => {
    const state = currentState();
    if (state === notifiedState && lastSaved === notifiedLastSaved) return;
    notifiedState = state;
    notifiedLastSaved = lastSaved;
    try {
      options.onChange?.();
    } catch {
      // 知らせる側の失敗で、保存を止めない
    }
  };

  const stopTimer = () => {
    if (timer === null) return;
    clearTimeout(timer);
    timer = null;
  };

  /** flush を待っている人に、送り終えた結果を返す（送信中・送る値がある間は返さない）。 */
  const settleWaiters = () => {
    if (flushWaiters.length === 0 || sending || timer !== null) return;
    if (pending !== null && !failed) return;
    const result: DevelopSettingsFlushResult = failed
      ? { ok: false, error: lastError }
      : stale
        ? { ok: true, saved: null }
        : dropped !== undefined
        ? { ok: true, saved: lastSaved, dropped }
        : { ok: true, saved: lastSaved };
    if (result.ok) dropped = undefined;
    const waiters = flushWaiters;
    flushWaiters = [];
    for (const resolve of waiters) resolve(result);
  };

  /** 送る値があり、待ち・送信中・失敗で止めていなければ送る（止めた後は、flush を待っているときだけ送る）。 */
  function pump(): void {
    if (sending || timer !== null || failed || stale || pending === null || (disposed && flushWaiters.length === 0)) {
      settleWaiters();
      notify();
      return;
    }
    const scheduled = pending;
    const settings = scheduled.settings;
    pending = null;
    sending = true;
    notify();
    let request: Promise<PhotoLibrarySaveResult>;
    try {
      request = options.save(settings, expectedRevision);
    } catch (error) {
      request = Promise.reject(error);
    }
    void request
      .then(
        (result) => {
          if (result.kind === "stale") {
            // 別の端末が先に保存していた。まだ送っていない値も捨てて止まる（送り直しても同じ版では通らない）
            pending = null;
            stopTimer();
            stale = true;
            try {
              options.onStale?.(result.photo);
            } catch {
              // 知らせる側の失敗で、後始末を止めない
            }
            return;
          }
          const photo = result.photo;
          lastSaved = {
            settings,
            developRevision: photo.developRevision,
            developSettingsUpdatedAt: photo.developSettingsUpdatedAt ?? null,
          };
          if (expectedRevision !== undefined) expectedRevision = photo.developRevision;
          lastError = null;
          try {
            options.onSaved?.(settings, scheduled.scheduled);
          } catch {
            // 端末退避の後始末の失敗で、サーバー保存を失敗扱いにしない
          }
        },
        (error: unknown) => {
          lastError = error;
          if (options.isPermanentFailure(error)) {
            // 送り直しても通らない。まだ送っていない値も捨てて終える
            pending = null;
            stopTimer();
            dropped = error;
            try {
              options.onDropped?.(error);
            } catch {
              // 知らせる側の失敗で、後始末を止めない
            }
            return;
          }
          // 送り直せる。送っている間に新しい値が来ていればそちらを残す。新しい値のまとめる待ちが続いていれば、その時間が
          // 来たら送る
          if (pending === null) pending = scheduled;
          if (timer === null) failed = true;
        },
      )
      .finally(() => {
        sending = false;
        pump();
      });
  }

  const flush = (): Promise<DevelopSettingsFlushResult> =>
    new Promise<DevelopSettingsFlushResult>((resolve) => {
      flushWaiters.push(resolve);
      stopTimer();
      // 失敗して残っている値も送り直す
      failed = false;
      pump();
    });

  return {
    schedule(settings) {
      // 止まった後の変更は送らない（画面が今の写真で開き直し、保存係を作り直す）
      if (disposed || stale) return;
      let scheduled: unknown;
      try {
        scheduled = options.onScheduled?.(settings);
      } catch {
        // 端末退避の失敗で、既存のサーバー保存を止めない
      }
      pending = { settings, scheduled };
      failed = false;
      dropped = undefined;
      stopTimer();
      // 離れる前の flush を待っている間の変更は、待たずに続けて送る
      if (flushWaiters.length === 0) {
        timer = setTimeout(() => {
          timer = null;
          pump();
        }, delayMs);
      }
      pump();
    },
    flush,
    retry: flush,
    getState: currentState,
    getLastSaved: () => lastSaved,
    getLastError: () => lastError,
    hasPendingWork: () => currentState() !== "idle",
    getExpectedRevision: () => expectedRevision,
    dispose() {
      disposed = true;
      stopTimer();
      notify();
    },
  };
}
