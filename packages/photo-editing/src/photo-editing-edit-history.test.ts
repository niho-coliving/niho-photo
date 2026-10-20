import { describe, expect, it } from "vitest";

import {
  EDIT_HISTORY_LIMIT,
  canRedoEditHistory,
  canUndoEditHistory,
  createEditHistory,
  pushEditHistory,
  redoEditHistory,
  undoEditHistory,
} from "./photo-editing-edit-history";

describe("取り消し・やり直しの履歴（F1 #17119）", () => {
  it("積んだ順に取り消し、取り消した分をやり直す", () => {
    let history = createEditHistory(0);
    expect(canUndoEditHistory(history)).toBe(false);
    expect(canRedoEditHistory(history)).toBe(false);

    history = pushEditHistory(history, 1);
    history = pushEditHistory(history, 2);
    expect(history).toEqual({ past: [0, 1], present: 2, future: [] });

    history = undoEditHistory(history);
    expect(history).toEqual({ past: [0], present: 1, future: [2] });
    expect(canRedoEditHistory(history)).toBe(true);
    history = undoEditHistory(history);
    expect(history).toEqual({ past: [], present: 0, future: [1, 2] });
    expect(canUndoEditHistory(history)).toBe(false);

    history = redoEditHistory(history);
    expect(history).toEqual({ past: [0], present: 1, future: [2] });
    history = redoEditHistory(history);
    expect(history).toEqual({ past: [0, 1], present: 2, future: [] });
  });

  it("取り消した後に積むと、やり直しの分を捨てる", () => {
    let history = pushEditHistory(pushEditHistory(createEditHistory("a"), "b"), "c");
    history = undoEditHistory(history);
    history = pushEditHistory(history, "d");
    expect(history).toEqual({ past: ["a", "b"], present: "d", future: [] });
    expect(canRedoEditHistory(history)).toBe(false);
  });

  it("今の値と同じ値を積んでも何もしない（比べ方を渡せる）", () => {
    const history = createEditHistory({ exposure: 1 });
    expect(pushEditHistory(history, { exposure: 1 })).not.toBe(history);
    const same = (a: { exposure: number }, b: { exposure: number }) => a.exposure === b.exposure;
    expect(pushEditHistory(history, { exposure: 1 }, same)).toBe(history);
    expect(pushEditHistory(history, { exposure: 2 }, same).present).toEqual({ exposure: 2 });
  });

  it("取り消し・やり直しができなければ、受け取った履歴をそのまま返す", () => {
    const history = createEditHistory(0);
    expect(undoEditHistory(history)).toBe(history);
    expect(redoEditHistory(history)).toBe(history);
  });

  it(`過去は ${EDIT_HISTORY_LIMIT} 件まで持ち、古いものから捨てる`, () => {
    let history = createEditHistory(0);
    for (let value = 1; value <= EDIT_HISTORY_LIMIT + 5; value += 1) history = pushEditHistory(history, value);
    expect(history.past).toHaveLength(EDIT_HISTORY_LIMIT);
    expect(history.past[0]).toBe(5);
    expect(history.present).toBe(EDIT_HISTORY_LIMIT + 5);

    for (let count = 0; count < EDIT_HISTORY_LIMIT; count += 1) history = undoEditHistory(history);
    expect(history.present).toBe(5);
    expect(canUndoEditHistory(history)).toBe(false);
  });
});
