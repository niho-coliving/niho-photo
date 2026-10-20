/**
 * 補正の取り消し・やり直しの履歴（NIHO Photo 段 1 F1 移行元設計）。値を持つだけの純粋なモジュールで、画面の状態・保存には触らない。
 *
 * - `present` が今の値、`past` が取り消せる値（古い順）、`future` がやり直せる値（次に戻る順）
 * - 1 単位の編集を確定したら `pushEditHistory`（同じ値なら何もしない。やり直しの分は捨てる。過去は {@link EDIT_HISTORY_LIMIT} 件まで）
 * - どの関数も、変わらなければ受け取った履歴をそのまま返す（呼ぶ側は `===` で変わったかを見られる）
 */
export type EditHistory<T> = {
  readonly past: readonly T[];
  readonly present: T;
  readonly future: readonly T[];
};

/** 取り消せる数の上限（古いものから捨てる）。 */
export const EDIT_HISTORY_LIMIT = 100;

export type EditHistoryEquals<T> = (a: T, b: T) => boolean;

export function createEditHistory<T>(initial: T): EditHistory<T> {
  return { past: [], present: initial, future: [] };
}

/** 確定した値を積む。今の値と同じなら何もしない。 */
export function pushEditHistory<T>(
  history: EditHistory<T>,
  next: T,
  equals: EditHistoryEquals<T> = Object.is,
): EditHistory<T> {
  if (equals(history.present, next)) return history;
  const past = [...history.past, history.present];
  return {
    past: past.length > EDIT_HISTORY_LIMIT ? past.slice(past.length - EDIT_HISTORY_LIMIT) : past,
    present: next,
    future: [],
  };
}

export function canUndoEditHistory<T>(history: EditHistory<T>): boolean {
  return history.past.length > 0;
}

export function canRedoEditHistory<T>(history: EditHistory<T>): boolean {
  return history.future.length > 0;
}

/** 1 つ前の値に戻す（戻せなければそのまま）。 */
export function undoEditHistory<T>(history: EditHistory<T>): EditHistory<T> {
  if (history.past.length === 0) return history;
  const previous = history.past[history.past.length - 1] as T;
  return {
    past: history.past.slice(0, -1),
    present: previous,
    future: [history.present, ...history.future],
  };
}

/** 取り消した値を 1 つやり直す（やり直せなければそのまま）。 */
export function redoEditHistory<T>(history: EditHistory<T>): EditHistory<T> {
  if (history.future.length === 0) return history;
  const [next, ...rest] = history.future as [T, ...T[]];
  return {
    past: [...history.past, history.present],
    present: next,
    future: rest,
  };
}
