import { describe, expect, it } from "vitest";

import { readDevelopGeometry } from "./develop-engine/develop-geometry";
import { MAX_HEAL_MARKS, MAX_HEAL_POINTS, MAX_HEAL_TOTAL_POINTS } from "./develop-engine/develop-heal";
import { addDevelopHealMark, readDevelopHeal, type DevelopHealMarkView } from "./develop-engine/develop-heal-editing";
import { resetDevelopSettingsColors, type DevelopSettings } from "./develop-engine/develop-settings";
import {
  appendHealStrokePoint,
  clampHealSource,
  compareBeforeDevelopSettings,
  defaultHealSource,
  formatHealPercent,
  healCoreRadius,
  healFrameDevelopSettings,
  healKeyDelta,
  healMarkAt,
  healMarkBounds,
  healMarkFingerprint,
  healPointDistance,
  healPointFromClient,
  healRadiusFromDial,
  healRadiusPixels,
  healRadiusToDial,
  healStrokePointLimit,
  moveHealKeyCursor,
  nextHealMarkId,
  stepHealRadius,
} from "./photo-editing-heal";

/**
 * 修復の道具の画面の計算（niho-photo#44 後半）: 幾何なしの表示の設定・「補正前」・画面の点と印の座標・半径の画面の px・なぞる点の
 * 間引きと上限・大きさのダイヤル・「写す」の既定の写し元と押し戻し・印の当たり判定。
 */

const BASE: DevelopSettings = { v: 1, engine: "niho-10", look: "niho-standard-1", base: null, exposure: 0.4 };

function mark(id: string, points: [number, number][], radius = 0.02, extra: Partial<DevelopHealMarkView> = {}): DevelopHealMarkView {
  return { id, mode: "remove", radius, feather: 0.5, points, source: null, ...extra };
}

function withMarks(count: number, pointsEach = 1): DevelopSettings {
  let settings = BASE;
  for (let index = 0; index < count; index += 1) {
    const points = Array.from({ length: pointsEach }, (_, i) => [0.1 + (i % 10) * 0.05, 0.1 + index * 0.01] as [number, number]);
    settings = addDevelopHealMark(settings, { id: `m${index}`, mode: "remove", radius: 0.02, feather: 0.5, points });
  }
  return settings;
}

describe("幾何なしの表示（修復の道具の間）", () => {
  it("90° 回転・反転・角度・切り抜き・遠近を全部外し、色・効果・修復の印・知らないキーは保つ（渡した設定は変えない）", () => {
    const settings: DevelopSettings = {
      ...addDevelopHealMark(BASE, { id: "m1", mode: "remove", radius: 0.02, feather: 0.5, points: [[0.2, 0.3]] }),
      grayscale: true,
      futureKey: { a: 1 },
      geometry: {
        rotate: 90,
        flipH: true,
        flipV: false,
        angle: 4.5,
        crop: { left: 0.1, top: 0.2, right: 0.9, bottom: 0.8 },
        aspect: "3:2",
        perspective: { vertical: 20, horizontal: 0, rotate: 0, aspect: 0, scale: 100, x: 0, y: 0 },
        upright: 2,
      },
    };
    const before = JSON.stringify(settings);
    const frame = healFrameDevelopSettings(settings);
    expect(frame.geometry).toBeUndefined();
    expect(readDevelopGeometry(frame)).toMatchObject({ rotate: 0, flipH: false, flipV: false, angle: 0, crop: { left: 0, top: 0, right: 1, bottom: 1 } });
    expect(frame.exposure).toBe(0.4);
    expect(frame.grayscale).toBe(true);
    expect(frame.futureKey).toEqual({ a: 1 });
    expect(frame.heal).toEqual(settings.heal);
    expect(frame.v).toBe(8);
    expect(JSON.stringify(settings)).toBe(before);
  });

  it("幾何も印も無い設定は、形の版も含めて同じ値", () => {
    expect(healFrameDevelopSettings(BASE)).toEqual(BASE);
  });
});

describe("「補正前」の設定", () => {
  it("色は neutral、幾何は保ち、修復の印は外す（初期化は印を保つのと別）", () => {
    const healed: DevelopSettings = {
      ...addDevelopHealMark(BASE, { id: "m1", mode: "remove", radius: 0.02, feather: 0.5, points: [[0.2, 0.3]] }),
      geometry: { rotate: 90, flipH: false, flipV: false, angle: 0, crop: { left: 0, top: 0, right: 1, bottom: 1 } },
    };
    const before = compareBeforeDevelopSettings(healed, null);
    expect(before.heal).toBeUndefined();
    expect(before.exposure).toBe(0);
    expect(readDevelopGeometry(before).rotate).toBe(90);
    expect(before.v).toBe(2);
    // 「初期化」は印を保つ
    expect(resetDevelopSettingsColors(healed, null).heal).toEqual(healed.heal);
  });

  it("印の無い設定は「初期化」と同じ値（今までの「補正前」の画をそのまま使える）", () => {
    expect(compareBeforeDevelopSettings(BASE, null)).toEqual(resetDevelopSettingsColors(BASE, null));
  });
});

describe("画面の点と半径", () => {
  const rect = { left: 100, top: 50, width: 400, height: 200 };

  it("canvas の画面の矩形の中の位置を 0〜1 に直す。写真の外は始めない（null）か端に収める", () => {
    expect(healPointFromClient(rect, 100, 50, { clampToPhoto: false })).toEqual([0, 0]);
    expect(healPointFromClient(rect, 300, 150, { clampToPhoto: false })).toEqual([0.5, 0.5]);
    expect(healPointFromClient(rect, 99, 150, { clampToPhoto: false })).toBeNull();
    expect(healPointFromClient(rect, 800, -20, { clampToPhoto: true })).toEqual([1, 0]);
    expect(healPointFromClient({ ...rect, width: 0 }, 300, 150, { clampToPhoto: true })).toBeNull();
    expect(healPointFromClient(null, 300, 150, { clampToPhoto: true })).toBeNull();
  });

  it("半径の画面の px は 半径 × 矩形の長辺。ぼかしても全部埋まる内側は 縁から ぼかし × 半径 / 2 内側", () => {
    expect(healRadiusPixels(0.02, rect)).toBe(8);
    expect(healRadiusPixels(0.02, { width: 200, height: 400 })).toBe(8);
    expect(healRadiusPixels(0.02, null)).toBe(0);
    expect(healCoreRadius(0.02, 0.5)).toBeCloseTo(0.015);
    expect(healCoreRadius(0.02, 0)).toBe(0.02);
    expect(healCoreRadius(0.02, 1)).toBeCloseTo(0.01);
  });

  it("2 点の間は長辺の単位で測る（横長の写真の縦の 1 は 高さ / 長辺）", () => {
    expect(healPointDistance([0, 0], [1, 0], { width: 400, height: 200 })).toBe(1);
    expect(healPointDistance([0, 0], [0, 1], { width: 400, height: 200 })).toBe(0.5);
    expect(healPointDistance([0, 0], [0, 1], null)).toBe(1);
  });
});

describe("なぞる点の間引きと上限", () => {
  const size = { width: 400, height: 200 };

  it("前の点から 半径の 1/4（長辺の単位）より近い点は足さない（渡した配列のまま）", () => {
    const start: readonly [number, number][] = [[0.5, 0.5]];
    // 半径 0.02 の 1/4 = 0.005 = 長辺 400px の 2px
    const near = appendHealStrokePoint(start, [0.5 + 1 / 400, 0.5], { radius: 0.02, size, limit: 512 });
    expect(near).toBe(start);
    const far = appendHealStrokePoint(start, [0.5 + 3 / 400, 0.5], { radius: 0.02, size, limit: 512 });
    expect(far).toEqual([
      [0.5, 0.5],
      [0.5 + 3 / 400, 0.5],
    ]);
    // 縦は 高さ / 長辺 で測る（0.008 × 0.5 = 0.004 < 0.005）
    expect(appendHealStrokePoint(start, [0.5, 0.508], { radius: 0.02, size, limit: 512 })).toBe(start);
    expect(appendHealStrokePoint(start, [Number.NaN, 0.5], { radius: 0.02, size, limit: 512 })).toBe(start);
  });

  it("上限の点の数に達したら足さない（最後の点で打ち切る）", () => {
    const full: readonly [number, number][] = [
      [0.1, 0.1],
      [0.2, 0.2],
    ];
    expect(appendHealStrokePoint(full, [0.9, 0.9], { radius: 0.02, size, limit: 2 })).toBe(full);
  });

  it("新しい印に使える点は 1 つの印 512・合計 2048 の残り。印が 64 個なら 0", () => {
    expect(healStrokePointLimit(BASE)).toBe(MAX_HEAL_POINTS);
    const many = withMarks(4, 500);
    expect(healStrokePointLimit(many)).toBe(MAX_HEAL_TOTAL_POINTS - 2000);
    expect(healStrokePointLimit(withMarks(MAX_HEAL_MARKS))).toBe(0);
  });
});

describe("ブラシの大きさのダイヤル", () => {
  it("0〜100 の目盛りを対数で 0.2%〜12% に当て、逆も戻る", () => {
    expect(healRadiusFromDial(0)).toBe(0.002);
    expect(healRadiusFromDial(100)).toBe(0.12);
    expect(healRadiusFromDial(-5)).toBe(0.002);
    expect(healRadiusFromDial(Number.NaN)).toBe(0.002);
    const middle = healRadiusFromDial(50);
    expect(middle).toBeCloseTo(Math.sqrt(0.002 * 0.12), 5);
    for (const dial of [0, 10, 33, 50, 77, 100]) {
      expect(Math.round(healRadiusToDial(healRadiusFromDial(dial)))).toBe(dial);
    }
    // ダイヤルの外の半径は端
    expect(healRadiusToDial(0.001)).toBe(0);
    expect(healRadiusToDial(0.2)).toBe(100);
  });

  it("[ ] は 5 目盛りずつ（端で止まる）", () => {
    const larger = stepHealRadius(0.02, 1);
    expect(larger).toBeGreaterThan(0.02);
    expect(Math.round(healRadiusToDial(larger)) - Math.round(healRadiusToDial(0.02))).toBe(5);
    expect(stepHealRadius(0.02, -1)).toBeLessThan(0.02);
    expect(stepHealRadius(0.12, 1)).toBe(0.12);
    expect(stepHealRadius(0.002, -1)).toBe(0.002);
  });

  it("% の表示は 10 未満は小数 1 桁、ほかは整数（末尾の 0 は書かない）", () => {
    expect(formatHealPercent(2)).toBe("2%");
    expect(formatHealPercent(0.2)).toBe("0.2%");
    expect(formatHealPercent(1.234)).toBe("1.2%");
    expect(formatHealPercent(12)).toBe("12%");
    expect(formatHealPercent(10.6)).toBe("11%");
  });
});

describe("「写す」の既定の写し元", () => {
  const square = { width: 1000, height: 1000 };

  it("点 1 つなら、中心から半径の 3 倍だけ下（写真の内側に収まる側）", () => {
    expect(defaultHealSource([[0.5, 0.5]], 0.02, square)).toEqual([0, 0.06]);
    // 下に収まらなければ上
    expect(defaultHealSource([[0.5, 0.97]], 0.02, square)).toEqual([0, -0.06]);
  });

  it("横の電線はなぞった向きに直交する側（線の太さの分 + 半径の 3 倍）へ。縦横比は長辺の単位で直す", () => {
    expect(
      defaultHealSource(
        [
          [0.1, 0.5],
          [0.9, 0.5],
        ],
        0.01,
        square,
      ),
    ).toEqual([0, 0.03]);
    // 横長 3:2 の写真の縦の 0.03（長辺の単位）は 高さの 0.045
    expect(
      defaultHealSource(
        [
          [0.1, 0.5],
          [0.9, 0.5],
        ],
        0.01,
        { width: 3000, height: 2000 },
      ),
    ).toEqual([0, 0.045]);
    // 縦の線は右へ
    expect(
      defaultHealSource(
        [
          [0.5, 0.1],
          [0.5, 0.9],
        ],
        0.01,
        square,
      ),
    ).toEqual([0.03, 0]);
  });

  it("どの側も収まらなければ、はみ出しの最も小さい側。同じ入力には同じ値", () => {
    const huge: [number, number][] = [
      [0.05, 0.05],
      [0.95, 0.95],
    ];
    const first = defaultHealSource(huge, 0.2, square);
    expect(defaultHealSource(huge, 0.2, square)).toEqual(first);
    expect(Math.abs(first[0])).toBeLessThanOrEqual(1);
    expect(Math.abs(first[1])).toBeLessThanOrEqual(1);
  });

  it("写し元を写真の内側へ押し戻す（写す範囲 = 印の外接矩形 + 半径）", () => {
    const points: [number, number][] = [[0.5, 0.5]];
    expect(clampHealSource(points, 0.02, [0.6, 0], square)).toEqual([0.48, 0]);
    expect(clampHealSource(points, 0.02, [-0.7, -0.7], square)).toEqual([-0.48, -0.48]);
    expect(clampHealSource(points, 0.02, [0.1, -0.2], square)).toEqual([0.1, -0.2]);
    // 印が写真より大きければ真ん中
    expect(
      clampHealSource(
        [
          [0, 0.5],
          [1, 0.5],
        ],
        0.1,
        [0.3, 0],
        square,
      )[0],
    ).toBe(0);
  });
});

describe("印の当たり判定", () => {
  const size = { width: 1000, height: 1000 };
  const marks = [
    mark("a", [
      [0.1, 0.5],
      [0.5, 0.5],
    ]),
    mark("b", [[0.3, 0.5]], 0.05),
    mark("c", [[0.8, 0.8]], 0.01),
  ];

  it("線までの長さが半径以内の、上に重なる（後から描いた）印を選ぶ。無ければ null", () => {
    expect(healMarkAt(marks, [0.3, 0.5], size)).toBe("b");
    expect(healMarkAt(marks, [0.45, 0.51], size)).toBe("a");
    expect(healMarkAt(marks, [0.8, 0.809], size)).toBe("c");
    expect(healMarkAt(marks, [0.8, 0.815], size)).toBeNull();
    expect(healMarkAt(marks, [0.8, 0.815], size, 0.006)).toBe("c");
    expect(healMarkAt([], [0.5, 0.5], size)).toBeNull();
  });

  it("外接矩形と中心", () => {
    const bounds = healMarkBounds([
      [0.1, 0.2],
      [0.5, 0.6],
    ]);
    expect(bounds).toMatchObject({ minX: 0.1, minY: 0.2, maxX: 0.5, maxY: 0.6 });
    expect(bounds.center[0]).toBeCloseTo(0.3);
    expect(bounds.center[1]).toBeCloseTo(0.4);
  });
});

describe("印の id・指紋・キーボード", () => {
  it("新しい印の id は使っていない最小の h 番号", () => {
    expect(nextHealMarkId(BASE)).toBe("h1");
    const one = addDevelopHealMark(BASE, { id: "h1", mode: "remove", radius: 0.02, feather: 0.5, points: [[0.2, 0.3]] });
    const two = addDevelopHealMark(one, { id: "h3", mode: "remove", radius: 0.02, feather: 0.5, points: [[0.2, 0.3]] });
    expect(nextHealMarkId(two)).toBe("h2");
  });

  it("指紋は値が変われば変わる", () => {
    const settings = addDevelopHealMark(BASE, { id: "h1", mode: "remove", radius: 0.02, feather: 0.5, points: [[0.2, 0.3]] });
    const [view] = readDevelopHeal(settings);
    expect(healMarkFingerprint(view)).toBe(healMarkFingerprint({ ...view }));
    expect(healMarkFingerprint({ ...view, radius: 0.03 })).not.toBe(healMarkFingerprint(view));
    expect(healMarkFingerprint({ ...view, mode: "clone", source: [0.1, 0] })).not.toBe(healMarkFingerprint(view));
  });

  it("矢印で 1%（Shift で 10%）動かし、写真の外へは出さない。矢印でなければ null", () => {
    expect(healKeyDelta("ArrowRight", false)).toEqual([0.01, 0]);
    expect(healKeyDelta("ArrowUp", true)).toEqual([0, -0.1]);
    expect(healKeyDelta("Enter", false)).toBeNull();
    expect(moveHealKeyCursor([0.5, 0.5], "ArrowLeft", false)).toEqual([0.49, 0.5]);
    expect(moveHealKeyCursor([0.5, 0.95], "ArrowDown", true)).toEqual([0.5, 1]);
    expect(moveHealKeyCursor([0.5, 0.5], "a", false)).toBeNull();
  });
});
