import { describe, expect, it } from "vitest";

import { MAX_HEAL_MARKS, MAX_HEAL_POINTS, readDevelopHealMarks } from "./develop-heal";
import {
  DEFAULT_HEAL_FEATHER,
  DEFAULT_HEAL_RADIUS,
  addDevelopHealMark,
  appendDevelopHealPoint,
  canAddDevelopHealMark,
  clearDevelopHeal,
  developHealUsage,
  readDevelopHeal,
  removeDevelopHealMark,
  updateDevelopHealMark,
} from "./develop-heal-editing";
import { isEditableDevelopSettings, readDevelopSettings, type DevelopSettings } from "./develop-settings";

const BASE: DevelopSettings = { v: 1, engine: "niho-10", look: "niho-standard-1", base: null, exposure: 0.3, futureKey: { a: 1 } };

const stroke = (id: string, points: [number, number][] = [[0.2, 0.3]]) => ({
  id,
  mode: "remove" as const,
  radius: 0.02,
  feather: 0.5,
  points,
});

describe("修復の印を直す純関数（niho-photo#44）", () => {
  it("印を足すと v: 8 になり、座標は 5 桁に丸め、半径・ぼかしは範囲に収める。ほかのキーは保つ", () => {
    const next = addDevelopHealMark(BASE, {
      id: "m1",
      mode: "clone",
      radius: 0.5,
      feather: -1,
      points: [
        [0.123456789, 1.2],
        [-0.1, 0.5],
      ],
      source: [0.3333333, -2],
    });
    expect(next.v).toBe(8);
    expect(next.exposure).toBe(0.3);
    expect(next.futureKey).toEqual({ a: 1 });
    expect(next.heal).toEqual([
      {
        id: "m1",
        mode: "clone",
        radius: 0.25,
        feather: 0,
        points: [
          [0.12346, 1],
          [0, 0.5],
        ],
        source: [0.33333, -1],
      },
    ]);
    // crate が描ける形（readDevelopHealMarks）で、編集を続けられる
    expect(readDevelopHealMarks(next.heal)).not.toBeNull();
    expect(readDevelopSettings(next)).not.toBeNull();
    expect(isEditableDevelopSettings(next)).toBe(true);
  });

  it("使えない id・重複した id・点の無い印・上限を超える印は足さない（同じ参照）", () => {
    const one = addDevelopHealMark(BASE, stroke("m1"));
    expect(addDevelopHealMark(one, stroke("m1"))).toBe(one);
    expect(addDevelopHealMark(one, stroke(""))).toBe(one);
    expect(addDevelopHealMark(one, { ...stroke("m2"), points: [] })).toBe(one);
    expect(addDevelopHealMark(one, { ...stroke("m2"), points: [[Number.NaN, 0]] })).toBe(one);
    expect(addDevelopHealMark(one, { ...stroke("m2"), radius: Number.NaN })).toBe(one);
    let full: DevelopSettings = BASE;
    for (let i = 0; i < MAX_HEAL_MARKS; i++) full = addDevelopHealMark(full, stroke(`m${i}`));
    expect(developHealUsage(full)).toEqual({ marks: MAX_HEAL_MARKS, points: MAX_HEAL_MARKS });
    expect(canAddDevelopHealMark(full)).toBe(false);
    expect(addDevelopHealMark(full, stroke("extra"))).toBe(full);
    const many = Array.from({ length: MAX_HEAL_POINTS + 1 }, (_, i): [number, number] => [i / 1000, 0.5]);
    expect(addDevelopHealMark(BASE, { ...stroke("long"), points: many })).toBe(BASE);
    // 合計 2048 点まで
    let total: DevelopSettings = BASE;
    for (let i = 0; i < 4; i++) total = addDevelopHealMark(total, { ...stroke(`t${i}`), points: many.slice(0, 512) });
    expect(developHealUsage(total).points).toBe(2048);
    expect(canAddDevelopHealMark(total)).toBe(false);
    expect(addDevelopHealMark(total, stroke("over"))).toBe(total);
  });

  it("なぞる点は半径の 1/4 より離れたときだけ足す（写真の縦横比で長辺の単位に直して測る）", () => {
    const started = addDevelopHealMark(BASE, stroke("m1", [[0.5, 0.5]]));
    // 半径 0.02 の 1/4 = 長辺の 0.005
    expect(appendDevelopHealPoint(started, "m1", [0.503, 0.5])).toBe(started);
    const moved = appendDevelopHealPoint(started, "m1", [0.506, 0.5]);
    expect(readDevelopHeal(moved)[0]?.points).toEqual([
      [0.5, 0.5],
      [0.506, 0.5],
    ]);
    // 縦長の写真では縦の割合が長辺に近い
    const size = { width: 1000, height: 2000 };
    expect(appendDevelopHealPoint(started, "m1", [0.508, 0.5], { size })).toBe(started);
    expect(appendDevelopHealPoint(started, "m1", [0.5, 0.506], { size })).not.toBe(started);
    expect(appendDevelopHealPoint(started, "none", [0.9, 0.9])).toBe(started);
    expect(appendDevelopHealPoint(started, "m1", [Number.NaN, 0.9])).toBe(started);
    // 1 つの印は 512 点まで
    let long = addDevelopHealMark(BASE, stroke("m1", [[0, 0]]));
    for (let i = 1; i < MAX_HEAL_POINTS + 5; i++) long = appendDevelopHealPoint(long, "m1", [i / 1000, 0], { minSpacing: 0 });
    expect(readDevelopHeal(long)[0]?.points.length).toBe(MAX_HEAL_POINTS);
  });

  it("印の値を書き換え、変わらなければ同じ参照。写し元の null は「エンジンが選ぶ」に戻す。印の知らないキーは保つ", () => {
    const one = addDevelopHealMark(BASE, stroke("m1"));
    expect(updateDevelopHealMark(one, "m1", { radius: 0.02, feather: 0.5, mode: "remove" })).toBe(one);
    expect(updateDevelopHealMark(one, "none", { radius: 0.1 })).toBe(one);
    expect(updateDevelopHealMark(one, "m1", { radius: Number.NaN })).toBe(one);
    const changed = updateDevelopHealMark(one, "m1", { radius: 0.9, feather: 0.2, mode: "clone", source: [0.1, -0.2] });
    expect(readDevelopHeal(changed)[0]).toMatchObject({ radius: 0.25, feather: 0.2, mode: "clone", source: [0.1, -0.2] });
    const auto = updateDevelopHealMark(changed, "m1", { source: null });
    expect((auto.heal as Record<string, unknown>[])[0]).not.toHaveProperty("source");
    expect(updateDevelopHealMark(auto, "m1", { source: null })).toBe(auto);
    const extra = { ...BASE, v: 8 as const, heal: [{ ...stroke("m1"), later: true }] };
    expect((updateDevelopHealMark(extra, "m1", { feather: 1 }).heal as Record<string, unknown>[])[0]?.later).toBe(true);
  });

  it("印を消すと残りは描いた順のまま。最後の印を消すと heal ごと消え、形の版は戻る", () => {
    let s = addDevelopHealMark(BASE, stroke("a"));
    s = addDevelopHealMark(s, stroke("b", [[0.6, 0.6]]));
    s = addDevelopHealMark(s, stroke("c", [[0.7, 0.7]]));
    const without = removeDevelopHealMark(s, "b");
    expect(readDevelopHeal(without).map((m) => m.id)).toEqual(["a", "c"]);
    expect(removeDevelopHealMark(s, "none")).toBe(s);
    const empty = removeDevelopHealMark(removeDevelopHealMark(without, "a"), "c");
    expect(empty).not.toHaveProperty("heal");
    expect(empty.v).toBe(1);
    const withPerspective = { ...s, geometry: { perspective: { vertical: -10 } } };
    expect(clearDevelopHeal(withPerspective).v).toBe(7);
    expect(clearDevelopHeal(BASE)).toBe(BASE);
  });

  it("読むときは範囲外を収め、数でない値は既定にし（書き戻さない）、印として読めない要素は見せない", () => {
    const raw = {
      ...BASE,
      v: 8 as const,
      heal: [
        { id: "a", mode: "clone", radius: 9, feather: "x", points: [[2, -1], [0.5, Number.NaN], "p"], source: [5, -5] },
        { id: "b", mode: "?", points: "none" },
        "broken",
        { mode: "remove" },
      ],
    };
    expect(readDevelopHeal(raw)).toEqual([
      { id: "a", mode: "clone", radius: 0.25, feather: DEFAULT_HEAL_FEATHER, points: [[1, 0]], source: [1, -1] },
      { id: "b", mode: "remove", radius: DEFAULT_HEAL_RADIUS, feather: DEFAULT_HEAL_FEATHER, points: [], source: null },
    ]);
    expect(raw.heal[0]).toMatchObject({ radius: 9 });
    expect(developHealUsage(raw)).toEqual({ marks: 4, points: 3 });
  });
});
