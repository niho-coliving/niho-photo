import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  PHOTO_EDITING_AUTOSAVE_DELAY_MS,
  createPhotoEditingSettingsAutosave,
  type PhotoEditingAutosaveResult,
} from "./photo-editing-settings-autosave";

/** 保存の失敗の見本（NIHO Desktop の `PhotoEditingError` の代わり。失敗はそのまま `onResult` へ渡る）。 */
class PhotoEditingError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

type Call = {
  operation: "save" | "forget";
  photoId: string;
  settings?: Record<string, unknown>;
  resolve: () => void;
  reject: (error: unknown) => void;
};

function createHarness() {
  const calls: Call[] = [];
  const results: PhotoEditingAutosaveResult[] = [];
  const autosave = createPhotoEditingSettingsAutosave({
    save: (photoId, settings) =>
      new Promise<void>((resolve, reject) => {
        calls.push({ operation: "save", photoId, settings, resolve, reject });
      }),
    forget: (photoId) =>
      new Promise<void>((resolve, reject) => {
        calls.push({ operation: "forget", photoId, resolve, reject });
      }),
    onResult: (result) => results.push(result),
  });
  return { autosave, calls, results };
}

async function settle(): Promise<void> {
  // 応答のあとの次の送信は Promise の後続で行う
  for (let index = 0; index < 5; index += 1) await Promise.resolve();
}

function describeCalls(calls: Call[]) {
  return calls.map((call) =>
    call.operation === "save" ? ["save", call.photoId, call.settings?.exposure] : ["forget", call.photoId],
  );
}

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe("createPhotoEditingSettingsAutosave", () => {
  it("少し待ってまとめ、続けて変えた分は最新の 1 つだけを保存する", async () => {
    const { autosave, calls } = createHarness();

    autosave.schedule("p1", { exposure: 0.1 });
    vi.advanceTimersByTime(PHOTO_EDITING_AUTOSAVE_DELAY_MS - 100);
    autosave.schedule("p1", { exposure: 0.2 });
    autosave.schedule("p1", { exposure: 0.3 });
    vi.advanceTimersByTime(PHOTO_EDITING_AUTOSAVE_DELAY_MS - 1);
    expect(calls).toHaveLength(0);

    vi.advanceTimersByTime(1);
    expect(describeCalls(calls)).toEqual([["save", "p1", 0.3]]);
  });

  it("写真ごとに別に待つ", () => {
    const { autosave, calls } = createHarness();

    autosave.schedule("p1", { exposure: 0.1 });
    autosave.schedule("p2", { exposure: 0.2 });
    vi.advanceTimersByTime(PHOTO_EDITING_AUTOSAVE_DELAY_MS);

    expect(describeCalls(calls)).toEqual([
      ["save", "p1", 0.1],
      ["save", "p2", 0.2],
    ]);
  });

  it("同じ写真の保存は前の応答を待ってから、待つ間に来た最新の設定だけを送る", async () => {
    const { autosave, calls } = createHarness();

    autosave.schedule("p1", { exposure: 0.1 });
    vi.advanceTimersByTime(PHOTO_EDITING_AUTOSAVE_DELAY_MS);
    autosave.schedule("p1", { exposure: 0.2 });
    autosave.schedule("p1", { exposure: 0.3 });
    vi.advanceTimersByTime(PHOTO_EDITING_AUTOSAVE_DELAY_MS);

    // 前の保存が返るまでは送らない（後から着いた古い設定で上書きしない）
    expect(describeCalls(calls)).toEqual([["save", "p1", 0.1]]);

    calls[0].resolve();
    await settle();
    expect(describeCalls(calls)).toEqual([
      ["save", "p1", 0.1],
      ["save", "p1", 0.3],
    ]);
  });

  it("ドラッグ中（deferPending）は待っている保存を送らない", () => {
    const { autosave, calls } = createHarness();

    autosave.schedule("p1", { exposure: 0.1 });
    for (let index = 0; index < 10; index += 1) {
      vi.advanceTimersByTime(PHOTO_EDITING_AUTOSAVE_DELAY_MS / 2);
      autosave.deferPending();
    }
    expect(calls).toHaveLength(0);

    vi.advanceTimersByTime(PHOTO_EDITING_AUTOSAVE_DELAY_MS);
    expect(describeCalls(calls)).toEqual([["save", "p1", 0.1]]);
  });

  it("「初期化」は待っている保存を捨て、送った保存の応答を待ってから消し、その後の変更はまた保存する", async () => {
    const { autosave, calls } = createHarness();

    autosave.schedule("p1", { exposure: 0.1 });
    vi.advanceTimersByTime(PHOTO_EDITING_AUTOSAVE_DELAY_MS);
    autosave.schedule("p1", { exposure: 0.2 });
    autosave.forget("p1");

    // 送った保存の応答を待つ
    expect(describeCalls(calls)).toEqual([["save", "p1", 0.1]]);
    calls[0].resolve();
    await settle();
    // 待っていた 0.2 は捨てる
    expect(describeCalls(calls)).toEqual([
      ["save", "p1", 0.1],
      ["forget", "p1"],
    ]);

    autosave.schedule("p1", { exposure: 0.5 });
    vi.advanceTimersByTime(PHOTO_EDITING_AUTOSAVE_DELAY_MS);
    // 消す応答が返るまでは保存を送らない（保存が先に着いて消えないように）
    expect(calls).toHaveLength(2);
    calls[1].resolve();
    await settle();
    expect(describeCalls(calls)).toEqual([
      ["save", "p1", 0.1],
      ["forget", "p1"],
      ["save", "p1", 0.5],
    ]);
  });

  it("flush は待っている保存をすぐ送り、応答のあとで続きを呼ぶ（何も待っていなければその場で呼ぶ）", async () => {
    const { autosave, calls } = createHarness();
    const closed = vi.fn();

    autosave.flush("p1", closed);
    expect(closed).toHaveBeenCalledTimes(1);

    autosave.schedule("p1", { exposure: 0.4 });
    autosave.flush("p1", closed);
    expect(describeCalls(calls)).toEqual([["save", "p1", 0.4]]);
    expect(closed).toHaveBeenCalledTimes(1);

    calls[0].resolve();
    await settle();
    expect(closed).toHaveBeenCalledTimes(2);

    // flush のあとに時間が来ても二重に送らない
    vi.advanceTimersByTime(PHOTO_EDITING_AUTOSAVE_DELAY_MS);
    expect(calls).toHaveLength(1);
  });

  it("flushAll はすべての写真の保存を送り終えてから続きを呼ぶ", async () => {
    const { autosave, calls } = createHarness();
    const released = vi.fn();

    autosave.schedule("p1", { exposure: 0.1 });
    autosave.schedule("p2", { exposure: 0.2 });
    autosave.flushAll(released);
    expect(describeCalls(calls)).toEqual([
      ["save", "p1", 0.1],
      ["save", "p2", 0.2],
    ]);

    calls[0].resolve();
    await settle();
    expect(released).not.toHaveBeenCalled();
    calls[1].resolve();
    await settle();
    expect(released).toHaveBeenCalledTimes(1);

    const releasedAgain = vi.fn();
    autosave.flushAll(releasedAgain);
    expect(releasedAgain).toHaveBeenCalledTimes(1);
  });

  it("失敗を知らせ、次の保存は止めない", async () => {
    const { autosave, calls, results } = createHarness();

    autosave.schedule("p1", { exposure: 0.1 });
    vi.advanceTimersByTime(PHOTO_EDITING_AUTOSAVE_DELAY_MS);
    const failure = new PhotoEditingError("internal", "編集内容を保存できませんでした。");
    calls[0].reject(failure);
    await settle();
    expect(results).toEqual([{ photoId: "p1", operation: "save", error: failure }]);

    autosave.schedule("p1", { exposure: 0.2 });
    vi.advanceTimersByTime(PHOTO_EDITING_AUTOSAVE_DELAY_MS);
    calls[1].resolve();
    await settle();
    expect(results.at(-1)).toEqual({ photoId: "p1", operation: "save", error: null });
  });

  it("保存の関数が同期で投げても失敗として扱い、後始末を続ける", async () => {
    const results: PhotoEditingAutosaveResult[] = [];
    const closed = vi.fn();
    const autosave = createPhotoEditingSettingsAutosave({
      save: () => {
        throw new PhotoEditingError("engineUnavailable", "no bridge");
      },
      forget: async () => undefined,
      onResult: (result) => results.push(result),
    });

    autosave.schedule("p1", { exposure: 0.1 });
    autosave.flush("p1", closed);
    await settle();

    expect(results).toHaveLength(1);
    expect(results[0].error).toBeInstanceOf(PhotoEditingError);
    expect(closed).toHaveBeenCalledTimes(1);
  });

  it("送り終えていない保存がある間は hasPendingWork が true（待ち時間・応答待ちを含む）。変わったときだけ知らせる", async () => {
    const { autosave, calls } = createHarness();
    const changes: boolean[] = [];
    const unsubscribe = autosave.subscribe(() => changes.push(autosave.hasPendingWork()));
    expect(autosave.hasPendingWork()).toBe(false);

    // まとめる待ち時間の途中
    autosave.schedule("p1", { exposure: 0.1 });
    autosave.schedule("p2", { exposure: 0.2 });
    expect(autosave.hasPendingWork()).toBe(true);
    // 応答待ち
    vi.advanceTimersByTime(PHOTO_EDITING_AUTOSAVE_DELAY_MS);
    expect(calls).toHaveLength(2);
    expect(autosave.hasPendingWork()).toBe(true);

    calls[0].resolve();
    await settle();
    expect(autosave.hasPendingWork()).toBe(true);
    calls[1].reject(new Error("network"));
    await settle();
    expect(autosave.hasPendingWork()).toBe(false);
    expect(changes).toEqual([true, false]);

    // 「初期化」も送り終えるまで。外した後は知らせない
    autosave.forget("p1");
    expect(autosave.hasPendingWork()).toBe(true);
    unsubscribe();
    calls[2].resolve();
    await settle();
    expect(autosave.hasPendingWork()).toBe(false);
    expect(changes).toEqual([true, false, true]);
  });
});
