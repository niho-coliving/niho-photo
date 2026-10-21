import { describe, expect, it } from "vitest";

import {
  copyDevelopSettings,
  neutralDevelopSettings,
  pasteDevelopSettings,
  sameDevelopSettings,
  type DevelopSettings,
} from "./develop-engine/develop-settings";
import { createEditHistory, pushEditHistory, undoEditHistory } from "./photo-editing-edit-history";
import {
  PHOTO_EDITING_LUMINANCE_WEIGHTS,
  PHOTO_EDITING_TONE_CURVE_MAX_POINTS,
  addPhotoEditingToneCurvePoint,
  evaluatePhotoEditingToneCurve,
  hasPhotoEditingToneCurveEdits,
  insertPhotoEditingToneCurvePointBeside,
  isIdentityPhotoEditingToneCurve,
  isLinearPhotoEditingToneCurve,
  movePhotoEditingToneCurvePoint,
  normalizePhotoEditingToneCurvePoints,
  photoEditingLuminanceCounts,
  photoEditingToneCurvePath,
  readPhotoEditingToneCurve,
  readPhotoEditingToneCurves,
  removePhotoEditingToneCurvePoint,
  resetPhotoEditingToneCurves,
  writePhotoEditingToneCurve,
  type PhotoEditingToneCurvePoint,
} from "./photo-editing-tone-curve";

/**
 * トーンカーブ（niho-photo#37）の `developSettings` の読み書き・点の操作・曲線の値・背後の輝度の度数。読む規則は crate の
 * `normalized_points`、曲線の値は crate の `DngSpline` と同じ（期待値は crate の式をそのまま動かした値）。
 */

const LINEAR: PhotoEditingToneCurvePoint[] = [
  { x: 0, y: 0 },
  { x: 1, y: 1 },
];

function lifted(): PhotoEditingToneCurvePoint[] {
  return [
    { x: 0, y: 0 },
    { x: 0.5, y: 0.6 },
    { x: 1, y: 1 },
  ];
}

describe("normalizePhotoEditingToneCurvePoints（crate の normalized_points と同じ）", () => {
  it("有限の値だけを 0〜1 に収めて x の順に並べ、x が 1e-6 以内で重なれば後に書いた方を残す", () => {
    expect(
      normalizePhotoEditingToneCurvePoints([
        { x: 1.2, y: 1.4 },
        { x: 0.5, y: 0.4 },
        { x: Number.NaN, y: 0.3 },
        { x: 0.3, y: Number.POSITIVE_INFINITY },
        { x: -0.1, y: -0.2 },
        { x: 0.5000004, y: 0.7 },
      ]),
    ).toEqual([
      { x: 0, y: 0 },
      { x: 0.5000004, y: 0.7 },
      { x: 1, y: 1 },
    ]);
  });

  it("旧い形の [x, y] も読み、2 点に満たなければ・配列でなければ直線の 2 点", () => {
    expect(normalizePhotoEditingToneCurvePoints([[0, 0.1], [1, 0.9]])).toEqual([
      { x: 0, y: 0.1 },
      { x: 1, y: 0.9 },
    ]);
    expect(normalizePhotoEditingToneCurvePoints([{ x: 0.5, y: 0.6 }])).toEqual(LINEAR);
    expect(normalizePhotoEditingToneCurvePoints([{ x: "0", y: 1 }, { x: 1 }])).toEqual(LINEAR);
    expect(normalizePhotoEditingToneCurvePoints("linear")).toEqual(LINEAR);
    expect(normalizePhotoEditingToneCurvePoints(undefined)).toEqual(LINEAR);
  });
});

describe("readPhotoEditingToneCurve", () => {
  it("曲線が無ければ 4 チャンネルとも直線", () => {
    expect(readPhotoEditingToneCurves({})).toEqual({ rgb: LINEAR, red: LINEAR, green: LINEAR, blue: LINEAR });
    expect(readPhotoEditingToneCurves({ toneCurves: [] })).toEqual({ rgb: LINEAR, red: LINEAR, green: LINEAR, blue: LINEAR });
  });

  it("取り込んだプリセット（crate がチャンネル名の順に入れた 4 本）をそれぞれのチャンネルで読む", () => {
    const settings = {
      toneCurves: [
        { channel: "blue", points: [{ x: 0, y: 0 }, { x: 63 / 255, y: 56 / 255 }, { x: 1, y: 1 }] },
        { channel: "green", points: [{ x: 0, y: 10 / 255 }, { x: 1, y: 250 / 255 }] },
        { channel: "red", points: [{ x: 0, y: 0 }, { x: 1, y: 1 }] },
        { channel: "rgb", points: [{ x: 0, y: 20 / 255 }, { x: 120 / 255, y: 131 / 255 }, { x: 1, y: 1 }] },
      ],
    };
    const curves = readPhotoEditingToneCurves(settings);
    expect(curves.rgb).toEqual([
      { x: 0, y: 20 / 255 },
      { x: 120 / 255, y: 131 / 255 },
      { x: 1, y: 1 },
    ]);
    expect(curves.red).toEqual(LINEAR);
    expect(curves.green).toEqual([
      { x: 0, y: 10 / 255 },
      { x: 1, y: 250 / 255 },
    ]);
    expect(curves.blue[1]).toEqual({ x: 63 / 255, y: 56 / 255 });
  });

  it("master は RGB 全体の別名。同じチャンネルが 2 本あれば先の 1 本（crate の描き方と同じ）", () => {
    const settings = {
      toneCurves: [
        { channel: "master", points: [{ x: 0, y: 0.1 }, { x: 1, y: 1 }] },
        { channel: "rgb", points: [{ x: 0, y: 0.5 }, { x: 1, y: 1 }] },
        { channel: "luma", points: [{ x: 0, y: 0.9 }, { x: 1, y: 1 }] },
      ],
    };
    expect(readPhotoEditingToneCurve(settings, "rgb")).toEqual([
      { x: 0, y: 0.1 },
      { x: 1, y: 1 },
    ]);
  });
});

describe("writePhotoEditingToneCurve", () => {
  it("曲線が無い設定に 1 チャンネルを書く（{ channel, points: [{ x, y }] } の 1 本）", () => {
    const next = writePhotoEditingToneCurve({ exposure: 0.5 }, "rgb", lifted());
    expect(next).toEqual({ exposure: 0.5, toneCurves: [{ channel: "rgb", points: lifted() }] });
  });

  it("直線の 2 点に戻したチャンネルは消し、1 本も残らなければ toneCurves ごと消す", () => {
    const curved = writePhotoEditingToneCurve({ exposure: 0.5 }, "rgb", lifted());
    const back = writePhotoEditingToneCurve(curved, "rgb", LINEAR);
    expect(back).toEqual({ exposure: 0.5 });
    expect("toneCurves" in back).toBe(false);
    const twoChannels = writePhotoEditingToneCurve(curved, "red", lifted());
    expect(writePhotoEditingToneCurve(twoChannels, "rgb", LINEAR)).toEqual({ exposure: 0.5, toneCurves: [{ channel: "red", points: lifted() }] });
  });

  it("触っていないチャンネル（範囲外の値・知らないチャンネルも）は元の値のまま、並びも保つ", () => {
    const red = { channel: "red", points: [{ x: 0, y: -0.2 }, { x: 0.4, y: 1.3 }, { x: 1, y: 1 }] };
    const unknown = { channel: "luma", points: [{ x: 0, y: 0.9 }] };
    const rgb = { channel: "rgb", points: [{ x: 0, y: 0.1 }, { x: 1, y: 1 }] };
    const settings = { toneCurves: [red, rgb, unknown], parametricShadows: 10, curveRefineSaturation: 80 };
    const next = writePhotoEditingToneCurve(settings, "rgb", lifted());
    const curves = next.toneCurves as unknown[];
    expect(curves[0]).toBe(red);
    expect(curves[1]).toEqual({ channel: "rgb", points: lifted() });
    expect(curves[2]).toBe(unknown);
    expect(next.parametricShadows).toBe(10);
    expect(next.curveRefineSaturation).toBe(80);
    // 書き換えたのは新しい値（渡した設定は変えない）
    expect(settings.toneCurves[1]).toBe(rgb);
  });

  it("master の 1 本は rgb に書き換え（同じ位置）、重なった 2 本目は消す", () => {
    const settings = {
      toneCurves: [
        { channel: "green", points: [{ x: 0, y: 0.2 }, { x: 1, y: 1 }] },
        { channel: "master", points: [{ x: 0, y: 0.1 }, { x: 1, y: 1 }] },
        { channel: "rgb", points: [{ x: 0, y: 0.5 }, { x: 1, y: 1 }] },
      ],
    };
    const next = writePhotoEditingToneCurve(settings, "rgb", lifted());
    expect(next.toneCurves).toEqual([settings.toneCurves[0], { channel: "rgb", points: lifted() }]);
  });

  it("触ったチャンネルは整えた点で書き直す（範囲外・重なり・非有限を描ける形に）", () => {
    const settings = {
      toneCurves: [{ channel: "blue", points: [{ x: 1, y: 1.5 }, { x: 0.5, y: 0.4 }, { x: 0.5, y: 0.45 }, { x: 0, y: Number.NaN }, { x: 0, y: 0 }] }],
    };
    const points = readPhotoEditingToneCurve(settings, "blue");
    expect(points).toEqual([
      { x: 0, y: 0 },
      { x: 0.5, y: 0.45 },
      { x: 1, y: 1 },
    ]);
    const moved = movePhotoEditingToneCurvePoint(points, 1, { x: 0.5, y: 0.5 });
    expect(writePhotoEditingToneCurve(settings, "blue", moved).toneCurves).toEqual([
      {
        channel: "blue",
        points: [
          { x: 0, y: 0 },
          { x: 0.5, y: 0.5 },
          { x: 1, y: 1 },
        ],
      },
    ]);
  });

  it("読んだ形が変わらなければ、渡した設定をそのまま返す（壊れた値も書き直さない）", () => {
    const settings = { toneCurves: [{ channel: "rgb", points: [{ x: 1, y: 1.2 }, { x: 0, y: 0.1 }] }] };
    expect(writePhotoEditingToneCurve(settings, "rgb", readPhotoEditingToneCurve(settings, "rgb"))).toBe(settings);
    const empty = { toneCurves: [] };
    expect(writePhotoEditingToneCurve(empty, "red", LINEAR)).toBe(empty);
  });
});

describe("hasPhotoEditingToneCurveEdits / resetPhotoEditingToneCurves（カーブの「初期化」）", () => {
  it("直線の 2 点でない曲線が 1 本でもあれば押せる。初期化は toneCurves ごと消し、ほかの項目（パラメトリック・曲線の彩度）は保つ", () => {
    const settings = {
      exposure: 0.3,
      parametricShadows: 10,
      curveRefineSaturation: 80,
      toneCurves: [{ channel: "red", points: lifted() }],
    };
    expect(hasPhotoEditingToneCurveEdits(settings)).toBe(true);
    expect(resetPhotoEditingToneCurves(settings)).toEqual({ exposure: 0.3, parametricShadows: 10, curveRefineSaturation: 80 });
  });

  it("直線のまま（無い・空・直線の 2 点）は押せず、初期化しても渡した設定のまま", () => {
    for (const settings of [{}, { toneCurves: [] }, { toneCurves: [{ channel: "rgb", points: [{ x: 0, y: 0 }, { x: 1, y: 1 }] }] }]) {
      expect(hasPhotoEditingToneCurveEdits(settings)).toBe(false);
      expect(resetPhotoEditingToneCurves(settings)).toBe(settings);
    }
  });

  it("対角線の上に点だけ残した曲線は、画を変えない（恒等）が「初期化」で点を消せる", () => {
    const diagonal = [
      { x: 0, y: 0 },
      { x: 0.5, y: 0.5 },
      { x: 1, y: 1 },
    ];
    expect(isIdentityPhotoEditingToneCurve(diagonal)).toBe(true);
    expect(isLinearPhotoEditingToneCurve(diagonal)).toBe(false);
    expect(hasPhotoEditingToneCurveEdits({ toneCurves: [{ channel: "rgb", points: diagonal }] })).toBe(true);
  });
});

describe("点の操作", () => {
  it("点を足す: 座標を小数 3 桁に丸め、x の順の位置に入れる", () => {
    expect(addPhotoEditingToneCurvePoint(LINEAR, { x: 0.25049, y: 0.40051 })).toEqual({
      points: [
        { x: 0, y: 0 },
        { x: 0.25, y: 0.401 },
        { x: 1, y: 1 },
      ],
      index: 1,
    });
    expect(addPhotoEditingToneCurvePoint(lifted(), { x: 0.75, y: 0.8 })?.index).toBe(2);
  });

  it("両端の点の外・隣の点から 1% 未満・点が多すぎるときは足さない", () => {
    expect(addPhotoEditingToneCurvePoint(LINEAR, { x: 0, y: 0.5 })).toBeNull();
    expect(addPhotoEditingToneCurvePoint(LINEAR, { x: 1, y: 0.5 })).toBeNull();
    expect(addPhotoEditingToneCurvePoint([{ x: 0.2, y: 0 }, { x: 1, y: 1 }], { x: 0.1, y: 0.1 })).toBeNull();
    expect(addPhotoEditingToneCurvePoint(lifted(), { x: 0.505, y: 0.2 })).toBeNull();
    expect(addPhotoEditingToneCurvePoint(lifted(), { x: 0.51, y: 0.2 })?.index).toBe(2);
    expect(addPhotoEditingToneCurvePoint(LINEAR, { x: Number.NaN, y: 0.2 })).toBeNull();
    const full = Array.from({ length: PHOTO_EDITING_TONE_CURVE_MAX_POINTS }, (_, index) => {
      const x = index / (PHOTO_EDITING_TONE_CURVE_MAX_POINTS - 1);
      return { x, y: x };
    });
    expect(addPhotoEditingToneCurvePoint(full, { x: 0.03, y: 0.5 })).toBeNull();
  });

  it("点を動かす: 隣の点を追い越さず 1% 空け、y は 0〜1。両端の点は上下だけ", () => {
    const points = [
      { x: 0, y: 0 },
      { x: 0.3, y: 0.3 },
      { x: 0.6, y: 0.6 },
      { x: 1, y: 1 },
    ];
    expect(movePhotoEditingToneCurvePoint(points, 1, { x: 0.9, y: 1.4 })[1]).toEqual({ x: 0.59, y: 1 });
    expect(movePhotoEditingToneCurvePoint(points, 2, { x: 0.1, y: -0.3 })[2]).toEqual({ x: 0.31, y: 0 });
    expect(movePhotoEditingToneCurvePoint(points, 1, { x: 0.41234, y: 0.55555 })[1]).toEqual({ x: 0.412, y: 0.556 });
    expect(movePhotoEditingToneCurvePoint(points, 0, { x: 0.5, y: 0.2 })[0]).toEqual({ x: 0, y: 0.2 });
    expect(movePhotoEditingToneCurvePoint(points, 3, { x: 0.5, y: 0.8 })[3]).toEqual({ x: 1, y: 0.8 });
    // 変わらなければ同じ並び
    expect(movePhotoEditingToneCurvePoint(points, 1, { x: 0.3, y: 0.3 })).toBe(points);
    expect(movePhotoEditingToneCurvePoint(points, 9, { x: 0.3, y: 0.3 })).toBe(points);
  });

  it("取り込んだ曲線の近い点（1/255 の格子）は、今より近づけない（離す向きには動かせる）", () => {
    const points = [
      { x: 0, y: 0 },
      { x: 1 / 255, y: 2 / 255 },
      { x: 2 / 255, y: 3 / 255 },
      { x: 1, y: 1 },
    ];
    expect(movePhotoEditingToneCurvePoint(points, 1, { x: 0.5, y: 0.1 })[1].x).toBe(1 / 255);
    expect(movePhotoEditingToneCurvePoint(points, 2, { x: 0, y: 0.1 })[2].x).toBe(2 / 255);
    expect(movePhotoEditingToneCurvePoint(points, 2, { x: 0.2, y: 0.1 })[2]).toEqual({ x: 0.2, y: 0.1 });
  });

  it("点を消す: 両端の点は消せない", () => {
    expect(removePhotoEditingToneCurvePoint(lifted(), 1)).toEqual(LINEAR);
    const points = lifted();
    expect(removePhotoEditingToneCurvePoint(points, 0)).toBe(points);
    expect(removePhotoEditingToneCurvePoint(points, 2)).toBe(points);
  });

  it("キーボードで足す点は、隣の点との真ん中の今の曲線の上（画は変えない）。最後の点なら前の点との間", () => {
    expect(insertPhotoEditingToneCurvePointBeside(LINEAR, 0)).toEqual({
      points: [
        { x: 0, y: 0 },
        { x: 0.5, y: 0.5 },
        { x: 1, y: 1 },
      ],
      index: 1,
    });
    const inserted = insertPhotoEditingToneCurvePointBeside(lifted(), 2);
    expect(inserted?.index).toBe(2);
    expect(inserted?.points[2].x).toBe(0.75);
    expect(inserted?.points[2].y).toBeCloseTo(evaluatePhotoEditingToneCurve(lifted(), 0.75), 3);
    expect(insertPhotoEditingToneCurvePointBeside([{ x: 0, y: 0 }, { x: 0.015, y: 0.1 }, { x: 1, y: 1 }], 0)).toBeNull();
  });
});

describe("evaluatePhotoEditingToneCurve（crate の DngSpline と同じ値）", () => {
  const inputs = [0, 0.1, 0.15, 0.3, 0.45, 0.6, 0.8, 0.95, 1];

  it("crate の式で求めた値と一致する（両端の外は端の高さ、0〜1 に収める）", () => {
    const cases: Array<{ points: PhotoEditingToneCurvePoint[]; expected: number[] }> = [
      {
        points: lifted(),
        expected: [0, 0.1296, 0.19365, 0.3792, 0.54855, 0.6944, 0.8568, 0.96495, 1],
      },
      {
        points: [
          { x: 0, y: 0.08 },
          { x: 0.25, y: 0.2 },
          { x: 0.75, y: 0.82 },
          { x: 1, y: 0.95 },
        ],
        expected: [0.08, 0.11225, 0.134, 0.248005, 0.43732, 0.647965, 0.85914, 0.93276, 0.95],
      },
      {
        points: [
          { x: 0.2, y: 0.1 },
          { x: 0.4, y: 0.5 },
          { x: 0.9, y: 0.95 },
        ],
        expected: [0.1, 0.1, 0.1, 0.311785714286, 0.578589285714, 0.755428571429, 0.897714285714, 0.95, 0.95],
      },
      {
        // 行き過ぎる曲線（crate は -1.37 などを 0 に収める）
        points: [
          { x: 0, y: 0 },
          { x: 0.1, y: 0.9 },
          { x: 0.2, y: 0.1 },
          { x: 1, y: 1 },
        ],
        expected: [0, 0.9, 0.63818221831, 0, 0, 0, 0, 0.643518926056, 1],
      },
    ];
    for (const { points, expected } of cases) {
      inputs.forEach((input, index) => {
        expect(evaluatePhotoEditingToneCurve(points, input)).toBeCloseTo(expected[index], 9);
      });
    }
  });

  it("直線は恒等。点を足して持ち上げると、真ん中が明るくなる", () => {
    expect(evaluatePhotoEditingToneCurve(LINEAR, 0.37)).toBeCloseTo(0.37, 12);
    expect(evaluatePhotoEditingToneCurve(lifted(), 0.5)).toBe(0.6);
    expect(evaluatePhotoEditingToneCurve(lifted(), 0.3)).toBeGreaterThan(0.3);
  });

  it("グラフの線の path は 0〜1 の座標（出力 1 が上）で、点の上を必ず通る", () => {
    const path = photoEditingToneCurvePath(
      [
        { x: 0, y: 0 },
        { x: 0.333, y: 0.5 },
        { x: 1, y: 1 },
      ],
      4,
    );
    expect(path.startsWith("M0 1L")).toBe(true);
    expect(path).toContain("L0.333 0.5");
    expect(path.endsWith("L1 0")).toBe(true);
    // 行き過ぎる曲線も 0〜1 の外に出さない
    const overshoot = photoEditingToneCurvePath([
      { x: 0, y: 0 },
      { x: 0.1, y: 0.9 },
      { x: 0.2, y: 0.1 },
      { x: 1, y: 1 },
    ]);
    const ys = overshoot
      .split(/[ML]/)
      .filter(Boolean)
      .map((pair) => Number(pair.split(" ")[1]));
    expect(Math.min(...ys)).toBeGreaterThanOrEqual(0);
    expect(Math.max(...ys)).toBeLessThanOrEqual(1);
  });
});

describe("photoEditingLuminanceCounts（グラフの背後の輝度）", () => {
  it("R / G / B の度数を階調ごとに Rec.709 の重みで混ぜて整数に丸める", () => {
    expect(PHOTO_EDITING_LUMINANCE_WEIGHTS).toEqual({ red: 0.2126, green: 0.7152, blue: 0.0722 });
    const red = new Uint32Array(256);
    const green = new Uint32Array(256);
    const blue = new Uint32Array(256);
    red[10] = 1000;
    green[10] = 1000;
    blue[10] = 1000;
    red[200] = 1000;
    green[50] = 1000;
    blue[100] = 1000;
    const counts = photoEditingLuminanceCounts({ red, green, blue });
    expect(counts).toHaveLength(256);
    // 灰色（3 色が同じ階調）はその度数のまま
    expect(counts[10]).toBe(1000);
    expect(counts[200]).toBe(213);
    expect(counts[50]).toBe(715);
    expect(counts[100]).toBe(72);
    expect(counts[0]).toBe(0);
  });
});

describe("developSettings の中の曲線（コピー・貼り付け・取り消し）", () => {
  const curved = (): DevelopSettings => ({
    ...neutralDevelopSettings(null),
    exposure: 0.2,
    toneCurves: [
      { channel: "rgb", points: lifted() },
      { channel: "blue", points: [{ x: 0, y: 0.1 }, { x: 1, y: 0.9 }] },
    ],
  });

  it("補正のコピーに曲線が入り、貼り付け先に曲線ごと当たる（形の版は v1 のまま）", () => {
    const copied = copyDevelopSettings(curved());
    expect(copied.toneCurves).toEqual(curved().toneCurves);
    const pasted = pasteDevelopSettings(neutralDevelopSettings("raw-apple.1"), copied);
    expect(pasted.toneCurves).toEqual(curved().toneCurves);
    expect(pasted.v).toBe(1);
    // 曲線の無いコピーを貼ると、貼り付け先の曲線は消える（色の補正はコピーに置き換わる）
    const plain = copyDevelopSettings(neutralDevelopSettings(null));
    expect("toneCurves" in pasteDevelopSettings(curved(), plain)).toBe(false);
  });

  it("曲線を変えると別の編集内容として履歴に積まれ、取り消すと元の曲線に戻る", () => {
    const base = curved();
    const edited = writePhotoEditingToneCurve(base, "rgb", movePhotoEditingToneCurvePoint(lifted(), 1, { x: 0.5, y: 0.7 })) as DevelopSettings;
    expect(sameDevelopSettings(base, edited)).toBe(false);
    const history = pushEditHistory(createEditHistory(base), edited, sameDevelopSettings);
    expect(history.present).toBe(edited);
    expect(undoEditHistory(history).present).toBe(base);
    // 同じ曲線（キーの順が違うだけ）は同じ編集内容
    const reordered = { ...base, toneCurves: [{ points: lifted(), channel: "rgb" }, (base.toneCurves as unknown[])[1]] };
    expect(sameDevelopSettings(base, reordered)).toBe(true);
    // 「初期化」で曲線を消した編集内容は、曲線を書く前と同じ
    const reset = resetPhotoEditingToneCurves(writePhotoEditingToneCurve(neutralDevelopSettings(null), "rgb", lifted())) as DevelopSettings;
    expect(sameDevelopSettings(reset, neutralDevelopSettings(null))).toBe(true);
  });
});
