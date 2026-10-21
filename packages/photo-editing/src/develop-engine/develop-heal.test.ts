import { describe, expect, it } from "vitest";

import {
  HEAL_SETTINGS_VERSION,
  MAX_HEAL_MARKS,
  MAX_HEAL_POINTS,
  MAX_HEAL_TOTAL_POINTS,
  hasDevelopHeal,
  hasValidDevelopHeal,
  isDevelopHealId,
  readDevelopHealMarks,
} from "./develop-heal";

const mark = (id: string, extra: Record<string, unknown> = {}) => ({
  id,
  mode: "remove",
  radius: 0.02,
  feather: 0.5,
  points: [
    [0.1, 0.2],
    [0.3, 0.25],
  ],
  ...extra,
});

describe("readDevelopHealMarks（crate の heal.rs と同じ形）", () => {
  it("無い・null は空、描ける印はそのまま読む（写し元は無い・null・-1〜1）", () => {
    expect(HEAL_SETTINGS_VERSION).toBe(8);
    expect(readDevelopHealMarks(undefined)).toEqual([]);
    expect(readDevelopHealMarks(null)).toEqual([]);
    const marks = [mark("a"), mark("b", { mode: "clone", source: [-0.4, 0.1] }), mark("c", { source: null })];
    expect(readDevelopHealMarks(marks)).toBe(marks);
  });

  it("壊れた印・範囲外・知らないキー・重複した id・上限超えは描けない（null）", () => {
    const broken: unknown[] = [
      {},
      "heal",
      [mark("a", { mode: "blur" })],
      [mark("a", { radius: 0.001 })],
      [mark("a", { radius: 0.3 })],
      [mark("a", { feather: 1.5 })],
      [mark("a", { points: [] })],
      [mark("a", { points: [[1.2, 0.5]] })],
      [mark("a", { points: [[0.5]] })],
      [mark("a", { points: [[0.5, Number.NaN]] })],
      [mark("a", { source: [2, 0] })],
      [mark("a", { size: 3 })],
      [mark("")],
      [mark("あ")],
      [mark("x".repeat(65))],
      [mark("a"), mark("a")],
      Array.from({ length: MAX_HEAL_MARKS + 1 }, (_, i) => mark(`m${i}`)),
      [mark("a", { points: Array.from({ length: MAX_HEAL_POINTS + 1 }, () => [0.5, 0.5]) })],
      Array.from({ length: 5 }, (_, i) => mark(`m${i}`, { points: Array.from({ length: MAX_HEAL_TOTAL_POINTS / 4 }, () => [0.5, 0.5]) })),
    ];
    for (const value of broken) expect(readDevelopHealMarks(value), JSON.stringify(value).slice(0, 80)).toBeNull();
    expect(readDevelopHealMarks(Array.from({ length: MAX_HEAL_MARKS }, (_, i) => mark(`m${i}`)))).not.toBeNull();
  });

  it("hasDevelopHeal は印が 1 つでもあれば true（壊れた値も恒等とみなさない）、空・無いは false", () => {
    expect(hasDevelopHeal({ heal: [mark("a")] })).toBe(true);
    expect(hasDevelopHeal({ heal: "x" })).toBe(true);
    expect(hasDevelopHeal({ heal: [] })).toBe(false);
    expect(hasDevelopHeal({ heal: null })).toBe(false);
    expect(hasDevelopHeal({})).toBe(false);
    expect(hasDevelopHeal(null)).toBe(false);
    expect(hasValidDevelopHeal({ heal: [mark("a")] })).toBe(true);
    expect(hasValidDevelopHeal({ heal: [mark("a", { mode: "x" })] })).toBe(false);
  });

  it("id は 1〜64 文字の ASCII", () => {
    expect(isDevelopHealId("m-1")).toBe(true);
    expect(isDevelopHealId("x".repeat(64))).toBe(true);
    expect(isDevelopHealId("")).toBe(false);
    expect(isDevelopHealId("印")).toBe(false);
    expect(isDevelopHealId(3)).toBe(false);
  });
});
