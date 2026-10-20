import { describe, expect, it } from "vitest";

import {
  IDENTITY_DEVELOP_GEOMETRY,
  cropBoxCorners,
  cropBoxFromGeometry,
  cropFromBox,
  developAspectRatio,
  developFrameSize,
  fitCropBox,
  flipGeometryHorizontal,
  geometryOutputToSource,
  isCropBoxInsideFrame,
  isDevelopAspect,
  isMaxCropBox,
  maxCropBox,
  minCropBoxSize,
  moveCropBox,
  parseDevelopGeometry,
  readDevelopGeometry,
  resetDevelopGeometry,
  resizeCropBox,
  rotateGeometryClockwise,
  setGeometryAngle,
  setGeometryAspect,
  swapDevelopAspect,
  writeDevelopGeometry,
  type CropBox,
  type CropHandle,
  type DevelopGeometry,
  type DevelopSize,
} from "./develop-geometry";
import { neutralDevelopSettings, type DevelopSettings } from "./develop-settings";

const LANDSCAPE: DevelopSize = { width: 3000, height: 2000 };
const PORTRAIT: DevelopSize = { width: 2000, height: 3000 };
const FRAMES = [LANDSCAPE, PORTRAIT];
const ANGLES = [0, 7, -7, 45, -45];
const HANDLES: CropHandle[] = ["n", "s", "e", "w", "ne", "nw", "se", "sw"];

function geometry(partial: Partial<DevelopGeometry> = {}): DevelopGeometry {
  return { ...IDENTITY_DEVELOP_GEOMETRY, crop: { ...IDENTITY_DEVELOP_GEOMETRY.crop }, ...partial };
}

function expectBoxClose(actual: CropBox, expected: CropBox, digits = 6) {
  expect(actual.cx).toBeCloseTo(expected.cx, digits);
  expect(actual.cy).toBeCloseTo(expected.cy, digits);
  expect(actual.width).toBeCloseTo(expected.width, digits);
  expect(actual.height).toBeCloseTo(expected.height, digits);
}

function expectGeometryClose(actual: DevelopGeometry, expected: DevelopGeometry) {
  expect(actual.rotate).toBe(expected.rotate);
  expect(actual.flipH).toBe(expected.flipH);
  expect(actual.flipV).toBe(expected.flipV);
  expect(actual.angle).toBeCloseTo(expected.angle, 9);
  expect(actual.aspect).toBe(expected.aspect);
  for (const key of ["left", "top", "right", "bottom"] as const) {
    expect(actual.crop[key]).toBeCloseTo(expected.crop[key], 9);
  }
}

function source(g: DevelopGeometry, size: DevelopSize, px: number, py: number): [number, number] {
  const point = geometryOutputToSource(g, size, px, py);
  if (!point) throw new Error("the crop is not a rectangle");
  return point;
}

function expectPointClose(actual: [number, number], expected: [number, number]) {
  expect(actual[0]).toBeCloseTo(expected[0], 9);
  expect(actual[1]).toBeCloseTo(expected[1], 9);
}

/** 枠に触れている角の数（枠の辺から 1e-6px 以内）。 */
function touchingCorners(box: CropBox, angle: number, frame: DevelopSize): number {
  return cropBoxCorners(box, angle).filter(
    ([x, y]) =>
      Math.abs(x) < 1e-6 || Math.abs(x - frame.width) < 1e-6 || Math.abs(y) < 1e-6 || Math.abs(y - frame.height) < 1e-6,
  ).length;
}

describe("幾何の読み書き", () => {
  it("無い幾何は恒等、欠けた項目は既定で補い、知らないキーは保つ", () => {
    expect(readDevelopGeometry(null)).toEqual(IDENTITY_DEVELOP_GEOMETRY);
    expect(readDevelopGeometry(neutralDevelopSettings())).toEqual(IDENTITY_DEVELOP_GEOMETRY);
    expect(parseDevelopGeometry(null)).toEqual(IDENTITY_DEVELOP_GEOMETRY);
    expect(parseDevelopGeometry({ rotate: 90, crop: { right: 0.5 }, futureKey: [1] })).toEqual({
      rotate: 90,
      flipH: false,
      flipV: false,
      angle: 0,
      crop: { left: 0, top: 0, right: 0.5, bottom: 1 },
      extra: { futureKey: [1] },
    });
    expect(parseDevelopGeometry({ aspect: null })).toEqual(IDENTITY_DEVELOP_GEOMETRY);
    expect(parseDevelopGeometry({ aspect: "4:5" })?.aspect).toBe("4:5");
  });

  it("壊れた形（crate が拒む形）は null、readDevelopGeometry は恒等を返す", () => {
    for (const broken of [
      [],
      "crop",
      { rotate: 45 },
      { rotate: null },
      { flipH: 1 },
      { angle: "2" },
      { angle: Number.NaN },
      { crop: { width: 1 } },
      { crop: { left: null } },
      { crop: [] },
      { aspect: 4 },
    ]) {
      expect(parseDevelopGeometry(broken), JSON.stringify(broken)).toBeNull();
    }
    expect(readDevelopGeometry({ ...neutralDevelopSettings(), geometry: { rotate: 45 } })).toEqual(IDENTITY_DEVELOP_GEOMETRY);
  });

  it("書いて読むと同じ幾何になり、恒等でなければ v: 2 にする（ほかのキーは触らない）", () => {
    const base: DevelopSettings = { ...neutralDevelopSettings("base-1"), exposure: 0.4, hsl: ["green", { hue: 3 }] };
    const written: DevelopGeometry = {
      rotate: 270,
      flipH: true,
      flipV: false,
      angle: -7.5,
      crop: { left: 0.05, top: 0.3, right: 0.6, bottom: 0.95 },
      aspect: "4:5",
      extra: { futureKey: { keep: true } },
    };
    const settings = writeDevelopGeometry(base, written);

    expect(settings.v).toBe(2);
    expect(settings.geometry).toEqual({
      rotate: 270,
      flipH: true,
      flipV: false,
      angle: -7.5,
      crop: { left: 0.05, top: 0.3, right: 0.6, bottom: 0.95 },
      aspect: "4:5",
      futureKey: { keep: true },
    });
    expect(readDevelopGeometry(settings)).toEqual(written);
    const { geometry: _geometry, v: _v, ...rest } = settings;
    const { v: _baseV, ...baseRest } = base;
    expect(rest).toEqual(baseRest);
    // もう一度書いても変わらない
    expect(writeDevelopGeometry(settings, readDevelopGeometry(settings))).toEqual(settings);
  });

  it("恒等で aspect も既定なら geometry のキーを消して v: 1 にする", () => {
    const cropped = writeDevelopGeometry(neutralDevelopSettings(), geometry({ rotate: 90 }));
    expect(cropped.v).toBe(2);

    for (const identity of [
      geometry(),
      geometry({ aspect: "original" }),
      geometry({ rotate: 180, flipH: true, flipV: true }),
      // 保存の丸め（小数 6 桁）より小さい誤差は全体
      geometry({ crop: { left: -1e-12, top: 1e-9, right: 1 - 1e-9, bottom: 1 + 1e-12 } }),
    ]) {
      const settings = writeDevelopGeometry(cropped, identity);
      expect(Object.hasOwn(settings, "geometry")).toBe(false);
      expect(settings.v).toBe(1);
    }
  });

  it("恒等でも aspect が既定でなければ書く（形の版は 1 のまま）", () => {
    const settings = writeDevelopGeometry(neutralDevelopSettings(), geometry({ aspect: "free" }));
    expect(settings.v).toBe(1);
    expect(settings.geometry).toEqual({
      rotate: 0,
      flipH: false,
      flipV: false,
      angle: 0,
      crop: { left: 0, top: 0, right: 1, bottom: 1 },
      aspect: "free",
    });
  });

  it("crop は 0〜1 に収めて小数 6 桁に丸め、角度は −45〜45 に収める", () => {
    const settings = writeDevelopGeometry(
      neutralDevelopSettings(),
      geometry({ angle: 60, crop: { left: -0.2, top: 0.12345649, right: 0.98765451, bottom: 1.4 } }),
    );
    expect(settings.geometry).toMatchObject({ angle: 45, crop: { left: 0, top: 0.123456, right: 0.987655, bottom: 1 } });
  });

  it("resetDevelopGeometry は幾何を消して v: 1 にし、色は触らない", () => {
    const settings = writeDevelopGeometry({ ...neutralDevelopSettings(), exposure: 0.7 }, geometry({ angle: 3 }));
    const reset = resetDevelopGeometry(settings);
    expect(Object.hasOwn(reset, "geometry")).toBe(false);
    expect(reset.v).toBe(1);
    expect(reset.exposure).toBe(0.7);
  });
});

describe("枠と切り抜きの箱", () => {
  it("90 / 270 は枠の幅と高さが入れ替わる", () => {
    expect(developFrameSize({ width: 300, height: 200 }, 0)).toEqual({ width: 300, height: 200 });
    expect(developFrameSize({ width: 300, height: 200 }, 90)).toEqual({ width: 200, height: 300 });
    expect(developFrameSize({ width: 300, height: 200 }, 180)).toEqual({ width: 300, height: 200 });
    expect(developFrameSize({ width: 300, height: 200 }, 270)).toEqual({ width: 200, height: 300 });
  });

  it("crate の corners_follow_lightroom と同じ数値", () => {
    // 角度なし: 角の間の長方形
    const box = cropBoxFromGeometry({ angle: 0, crop: { left: 0.2, top: 0.1, right: 0.8, bottom: 0.6 } }, LANDSCAPE);
    expect(box).not.toBeNull();
    expectBoxClose(box!, { cx: 1500, cy: 700, width: 1800, height: 1000 }, 9);
    expect(cropBoxCorners(box!, 0)[0][0]).toBeCloseTo(600, 9);
    expect(cropBoxCorners(box!, 0)[0][1]).toBeCloseTo(200, 9);

    // 正方形を中心の回りに時計回りに 90° 回す: 左上の角は、回す前の右上の角の位置
    const square = { width: 1000, height: 1000 };
    const turned = cropBoxFromGeometry({ angle: 90, crop: { left: 0.6, top: 0.4, right: 0.4, bottom: 0.6 } }, square);
    expect(turned).not.toBeNull();
    expectBoxClose(turned!, { cx: 500, cy: 500, width: 200, height: 200 }, 9);
    const [topLeft, topRight, , bottomLeft] = cropBoxCorners(turned!, 90);
    expectPointClose(topLeft, [600, 400]);
    // across = (0, 200)・down = (−200, 0)
    expectPointClose([topRight[0] - topLeft[0], topRight[1] - topLeft[1]], [0, 200]);
    expectPointClose([bottomLeft[0] - topLeft[0], bottomLeft[1] - topLeft[1]], [-200, 0]);

    // 正の角度は時計回り（y は下向き）: 上の辺は右下がり
    const tilted = cropBoxCorners(cropBoxFromGeometry({ angle: 10, crop: { left: 0, top: 0, right: 1, bottom: 1 } }, square)!, 10);
    expect(tilted[1][1] - tilted[0][1]).toBeGreaterThan(0);
    expect(tilted[3][0] - tilted[0][0]).toBeLessThan(0);
  });

  it("その角度で長方形にならない切り抜きは null（crate の invalidCrop）", () => {
    const square = { width: 1000, height: 1000 };
    expect(cropBoxFromGeometry({ angle: 45, crop: { left: 0, top: 0.5, right: 1, bottom: 0.5 } }, square)).toBeNull();
    expect(cropBoxFromGeometry({ angle: 30, crop: { left: 0.5, top: 0.5, right: 0.5, bottom: 0.5 } }, square)).toBeNull();
    // 中心が枠の辺の上（角度つき）は描けない
    expect(
      geometryOutputToSource(geometry({ angle: 45, crop: { left: 0, top: 0, right: 0, bottom: 1 } }), square, 0.5, 0.5),
    ).toBeNull();
  });

  it("cropBoxFromGeometry と cropFromBox は往復で一致する", () => {
    const crops = [
      { left: 0, top: 0, right: 1, bottom: 1 },
      { left: 0.2, top: 0.1, right: 0.8, bottom: 0.6 },
      { left: 0.31, top: 0.27, right: 0.74, bottom: 0.9 },
    ];
    for (const frame of FRAMES) {
      for (const angle of ANGLES) {
        for (const crop of crops) {
          const box = cropBoxFromGeometry({ angle, crop }, frame);
          if (!box) continue;
          const back = cropFromBox(box, angle, frame);
          for (const key of ["left", "top", "right", "bottom"] as const) {
            expect(back[key], `${frame.width} ${angle} ${key}`).toBeCloseTo(crop[key], 12);
          }
        }
        const box: CropBox = { cx: frame.width * 0.45, cy: frame.height * 0.55, width: 640, height: 410 };
        const again = cropBoxFromGeometry({ angle, crop: cropFromBox(box, angle, frame) }, frame);
        expect(again).not.toBeNull();
        expectBoxClose(again!, box, 8);
      }
    }
  });
});

describe("枠の中に収める", () => {
  it("maxCropBox は 4 つの角が枠の中で、少なくとも 1 組が枠に触れる", () => {
    for (const frame of FRAMES) {
      for (const angle of ANGLES) {
        for (const ratio of [null, 1, 4 / 5, 16 / 9, 3 / 2]) {
          const box = maxCropBox(frame, angle, ratio);
          const label = `${frame.width}x${frame.height} ${angle} ${ratio}`;
          expect(isCropBoxInsideFrame(box, angle, frame), label).toBe(true);
          expect(touchingCorners(box, angle, frame), label).toBeGreaterThanOrEqual(2);
          expect(box.cx).toBe(frame.width / 2);
          expect(box.cy).toBe(frame.height / 2);
          expect(box.width / box.height).toBeCloseTo(ratio ?? frame.width / frame.height, 9);
          expect(isMaxCropBox(box, angle, frame), label).toBe(true);
        }
      }
    }
  });

  it("角度 0 で比率が枠と同じなら枠全体", () => {
    for (const frame of [...FRAMES, { width: 1707, height: 2560 }, { width: 997, height: 1003 }]) {
      expect(maxCropBox(frame, 0, null)).toEqual({
        cx: frame.width / 2,
        cy: frame.height / 2,
        width: frame.width,
        height: frame.height,
      });
    }
  });

  it("fitCropBox は crate の最大の内接と同じ（枠全体を 10° 回すと中心の回りに縮む）", () => {
    // crate の a_turned_crop_is_brought_inside_the_frame
    const raw = cropBoxFromGeometry({ angle: 10, crop: { left: 0, top: 0, right: 1, bottom: 1 } }, LANDSCAPE);
    expect(raw).not.toBeNull();
    const fitted = fitCropBox(raw!, 10, LANDSCAPE);
    const radians = (10 * Math.PI) / 180;
    // s = (W/2) / ((W cos 2a + H sin 2a) / 2)
    const scale = 3000 / (3000 * Math.cos(2 * radians) + 2000 * Math.sin(2 * radians));
    expect(fitted.cx).toBe(1500);
    expect(fitted.cy).toBe(1000);
    expect(fitted.width).toBeCloseTo((3000 * Math.cos(radians) + 2000 * Math.sin(radians)) * scale, 8);
    expect(fitted.height).toBeCloseTo((-3000 * Math.sin(radians) + 2000 * Math.cos(radians)) * scale, 8);
    expect(fitted.width).toBeLessThan(3000);
    expect(fitted.width).toBeGreaterThan(2000);
    expect(isCropBoxInsideFrame(fitted, 10, LANDSCAPE)).toBe(true);
    expect(touchingCorners(fitted, 10, LANDSCAPE)).toBeGreaterThanOrEqual(2);
    // 描かれる位置（geometryOutputToSource）も同じ箱
    const topLeft = cropBoxCorners(fitted, 10)[0];
    expectPointClose(source(geometry({ angle: 10 }), LANDSCAPE, 0, 0), [topLeft[0] / 3000, topLeft[1] / 2000]);
  });

  it("fitCropBox は枠の中の箱を変えず、出る箱は中心と比率を保って縮める", () => {
    for (const frame of FRAMES) {
      for (const angle of ANGLES) {
        const inside: CropBox = { cx: frame.width / 2, cy: frame.height / 2, width: 300, height: 200 };
        expect(fitCropBox(inside, angle, frame)).toEqual(inside);

        const outside: CropBox = { cx: frame.width * 0.8, cy: frame.height * 0.3, width: 1600, height: 1200 };
        const fitted = fitCropBox(outside, angle, frame);
        expect(isCropBoxInsideFrame(fitted, angle, frame)).toBe(true);
        expect(fitted.cx).toBe(outside.cx);
        expect(fitted.cy).toBe(outside.cy);
        expect(fitted.width / fitted.height).toBeCloseTo(4 / 3, 9);
        expect(fitted.width).toBeLessThan(outside.width);
        expect(touchingCorners(fitted, angle, frame)).toBeGreaterThanOrEqual(1);
      }
    }
  });

  it("fitCropBox は最小の大きさを下回らず、中心が枠の外・辺の上でも枠の中に収める", () => {
    expect(minCropBoxSize(LANDSCAPE)).toBe(40);
    expect(minCropBoxSize({ width: 300, height: 200 })).toBe(8);
    for (const frame of FRAMES) {
      const min = minCropBoxSize(frame);
      for (const angle of ANGLES) {
        for (const box of [
          { cx: -50, cy: frame.height / 2, width: 400, height: 300 },
          { cx: frame.width, cy: frame.height, width: 400, height: 300 },
          { cx: frame.width / 2, cy: frame.height / 2, width: 3, height: 2 },
          { cx: 1, cy: 1, width: 3, height: 2 },
        ]) {
          const fitted = fitCropBox(box, angle, frame);
          const label = `${frame.width} ${angle} ${JSON.stringify(box)}`;
          expect(isCropBoxInsideFrame(fitted, angle, frame), label).toBe(true);
          expect(Math.min(fitted.width, fitted.height), label).toBeGreaterThanOrEqual(min - 1e-9);
          expect(fitted.width / fitted.height, label).toBeCloseTo(box.width / box.height, 9);
        }
      }
    }
  });

  it("moveCropBox は大きさを変えず、角が枠から出ない所で止まる", () => {
    for (const frame of FRAMES) {
      for (const angle of ANGLES) {
        const box: CropBox = { cx: frame.width / 2, cy: frame.height / 2, width: 600, height: 400 };
        const moved = moveCropBox(box, 120, -80, angle, frame);
        expect(moved).toEqual({ ...box, cx: box.cx + 120, cy: box.cy - 80 });
        for (const [dx, dy] of [
          [1e6, 0],
          [-1e6, 0],
          [0, 1e6],
          [0, -1e6],
          [1e6, -1e6],
        ]) {
          const stopped = moveCropBox(box, dx, dy, angle, frame);
          expect(stopped.width).toBe(box.width);
          expect(stopped.height).toBe(box.height);
          expect(isCropBoxInsideFrame(stopped, angle, frame)).toBe(true);
          expect(touchingCorners(stopped, angle, frame)).toBeGreaterThanOrEqual(1);
          if (dx === 0) expect(stopped.cx).toBe(box.cx);
          if (dy === 0) expect(stopped.cy).toBe(box.cy);
        }
      }
    }
  });
});

describe("resizeCropBox", () => {
  /** つまみの反対側の点（角のつまみは反対の角、辺のつまみは反対の辺の両端）。 */
  function anchors(box: CropBox, handle: CropHandle, angle: number, fixedRatio: boolean): [number, number][] {
    const [topLeft, topRight, bottomRight, bottomLeft] = cropBoxCorners(box, angle);
    const middle = (a: [number, number], b: [number, number]): [number, number] => [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2];
    const edge = (a: [number, number], b: [number, number]) => (fixedRatio ? [middle(a, b)] : [a, b]);
    switch (handle) {
      case "n":
        return edge(bottomLeft, bottomRight);
      case "s":
        return edge(topLeft, topRight);
      case "e":
        return edge(topLeft, bottomLeft);
      case "w":
        return edge(topRight, bottomRight);
      case "ne":
        return [bottomLeft];
      case "nw":
        return [bottomRight];
      case "se":
        return [topLeft];
      default:
        return [topRight];
    }
  }

  it("反対側の辺・角は動かず、結果は枠の中で、比率を守る", () => {
    for (const frame of FRAMES) {
      for (const angle of ANGLES) {
        for (const ratio of [null, 3 / 2, 1]) {
          const height = 400;
          const box: CropBox = { cx: frame.width / 2, cy: frame.height / 2, width: ratio === null ? 700 : height * ratio, height };
          for (const handle of HANDLES) {
            for (const [dx, dy] of [
              [60, 40],
              [-90, -50],
              [1e5, 1e5],
              [-1e5, -1e5],
              [1e5, -1e5],
            ]) {
              const resized = resizeCropBox(box, handle, dx, dy, angle, frame, ratio);
              const label = `${frame.width} ${angle} ${ratio} ${handle} ${dx},${dy}`;
              expect(isCropBoxInsideFrame(resized, angle, frame), label).toBe(true);
              expect(Math.min(resized.width, resized.height), label).toBeGreaterThanOrEqual(minCropBoxSize(frame) - 1e-9);
              if (ratio !== null) expect(resized.width / resized.height, label).toBeCloseTo(ratio, 9);
              const before = anchors(box, handle, angle, ratio !== null);
              const after = anchors(resized, handle, angle, ratio !== null);
              before.forEach((point, index) => {
                expect(after[index][0], label).toBeCloseTo(point[0], 6);
                expect(after[index][1], label).toBeCloseTo(point[1], 6);
              });
            }
          }
        }
      }
    }
  });

  it("自由な比率は、つまみの動きの分だけ幅・高さが変わる（辺のつまみは片方だけ）", () => {
    const box: CropBox = { cx: 1500, cy: 1000, width: 600, height: 400 };
    expect(resizeCropBox(box, "se", 60, 40, 0, LANDSCAPE, null)).toEqual({ cx: 1530, cy: 1020, width: 660, height: 440 });
    expect(resizeCropBox(box, "nw", 60, 40, 0, LANDSCAPE, null)).toEqual({ cx: 1530, cy: 1020, width: 540, height: 360 });
    expect(resizeCropBox(box, "e", 60, 999, 0, LANDSCAPE, null)).toEqual({ cx: 1530, cy: 1000, width: 660, height: 400 });
    expect(resizeCropBox(box, "n", 999, -40, 0, LANDSCAPE, null)).toEqual({ cx: 1500, cy: 980, width: 600, height: 440 });
    // 角度つきでも、切り抜きの自分の軸で変わる
    const turned = resizeCropBox(box, "e", 60, 0, 30, LANDSCAPE, null);
    expect(turned.width).toBeCloseTo(660, 9);
    expect(turned.height).toBe(400);
    expect(turned.cx).toBeCloseTo(1500 + 30 * Math.cos(Math.PI / 6), 9);
    expect(turned.cy).toBeCloseTo(1000 + 30 * Math.sin(Math.PI / 6), 9);
  });

  it("比率を守るとき、辺のつまみは直交する方向を中心線の回りに伸縮する", () => {
    const box: CropBox = { cx: 1500, cy: 1000, width: 600, height: 400 };
    const resized = resizeCropBox(box, "e", 60, 0, 0, LANDSCAPE, 3 / 2);
    expect(resized.width).toBeCloseTo(660, 9);
    expect(resized.height).toBeCloseTo(440, 9);
    expect(resized.cx).toBeCloseTo(1530, 9);
    expect(resized.cy).toBeCloseTo(1000, 9);
  });

  it("枠に当たったら止まる（自由な比率の角のつまみは、当たっていない方だけ動く）", () => {
    const box: CropBox = { cx: 2600, cy: 1000, width: 600, height: 400 };
    // 右は枠まで 100px、下は 800px
    expect(resizeCropBox(box, "se", 500, 300, 0, LANDSCAPE, null)).toEqual({ cx: 2650, cy: 1150, width: 700, height: 700 });
    // 比率を守るときは、先に当たる辺で止まる
    const locked = resizeCropBox(box, "se", 500, 300, 0, LANDSCAPE, 3 / 2);
    expect(locked.width).toBeCloseTo(700, 9);
    expect(locked.height).toBeCloseTo(700 / 1.5, 9);
  });

  it("最小の大きさで止まる", () => {
    const box: CropBox = { cx: 1500, cy: 1000, width: 600, height: 400 };
    const free = resizeCropBox(box, "se", -5000, -5000, 0, LANDSCAPE, null);
    expect(free.width).toBe(40);
    expect(free.height).toBe(40);
    const locked = resizeCropBox(box, "se", -5000, -5000, 0, LANDSCAPE, 3 / 2);
    expect(locked.width).toBeCloseTo(60, 9);
    expect(locked.height).toBeCloseTo(40, 9);
  });
});

describe("角度補正・縦横比", () => {
  it("aspect の比率と、縦横の入れ替え", () => {
    expect(developAspectRatio("free", LANDSCAPE)).toBeNull();
    expect(developAspectRatio(undefined, LANDSCAPE)).toBe(1.5);
    expect(developAspectRatio("original", LANDSCAPE)).toBe(1.5);
    expect(developAspectRatio("originalSwapped", LANDSCAPE)).toBeCloseTo(2 / 3, 12);
    expect(developAspectRatio("4:5", LANDSCAPE)).toBe(0.8);
    expect(developAspectRatio("square", LANDSCAPE)).toBeNull();

    expect(swapDevelopAspect("original")).toBe("originalSwapped");
    expect(swapDevelopAspect("originalSwapped")).toBe("original");
    expect(swapDevelopAspect("4:5")).toBe("5:4");
    expect(swapDevelopAspect("16:9")).toBe("9:16");
    expect(swapDevelopAspect("1:1")).toBe("1:1");
    expect(swapDevelopAspect("free")).toBe("free");

    // crate の is_aspect と同じ
    for (const ok of ["free", "original", "originalSwapped", "4:5", "16:9", "9999:1"]) expect(isDevelopAspect(ok), ok).toBe(true);
    for (const bad of ["", "4:", "0:1", "04:5", "4/5", "10000:1", "square"]) expect(isDevelopAspect(bad), bad).toBe(false);
  });

  it("setGeometryAspect は、その比率で枠の中心に内接する最大の箱にする（free は箱を変えない）", () => {
    const cropped = geometry({ angle: 7, crop: { left: 0.3, top: 0.3, right: 0.7, bottom: 0.7 } });
    for (const frame of FRAMES) {
      for (const aspect of ["original", "originalSwapped", "1:1", "4:5", "16:9"]) {
        const next = setGeometryAspect(cropped, aspect, frame);
        expect(next.aspect).toBe(aspect);
        const box = cropBoxFromGeometry(next, frame);
        expect(box).not.toBeNull();
        expectBoxClose(box!, maxCropBox(frame, 7, developAspectRatio(aspect, frame)), 6);
      }
    }
    expect(setGeometryAspect(cropped, "free", LANDSCAPE)).toEqual({ ...cropped, aspect: "free" });
    expect(setGeometryAspect(cropped, "square", LANDSCAPE)).toBe(cropped);
    // 角度 0 の「元の比率」は枠全体
    expect(setGeometryAspect(geometry({ crop: cropped.crop }), "original", LANDSCAPE).crop).toEqual({
      left: 0,
      top: 0,
      right: 1,
      bottom: 1,
    });
  });

  it("まだ枠を動かしていない切り抜きは、角度を変えると新しい角度の最大の箱になり、0 に戻すと枠全体に戻る", () => {
    for (const frame of FRAMES) {
      const tilted = setGeometryAngle(geometry(), 5, frame);
      expect(tilted.angle).toBe(5);
      expectBoxClose(cropBoxFromGeometry(tilted, frame)!, maxCropBox(frame, 5, null), 6);

      // 保存（小数 6 桁の丸め）を挟んでも「最大の箱」のまま
      const saved = readDevelopGeometry(writeDevelopGeometry(neutralDevelopSettings(), tilted));
      const more = setGeometryAngle(saved, -12, frame);
      expectBoxClose(cropBoxFromGeometry(more, frame)!, maxCropBox(frame, -12, null), 6);

      const savedMore = readDevelopGeometry(writeDevelopGeometry(neutralDevelopSettings(), more));
      const back = writeDevelopGeometry(neutralDevelopSettings(), setGeometryAngle(savedMore, 0, frame));
      expect(Object.hasOwn(back, "geometry")).toBe(false);
      expect(back.v).toBe(1);
    }
  });

  it("縦横比を選んだ切り抜きは、角度を変えてもその比率の最大の箱", () => {
    const square = setGeometryAspect(geometry(), "1:1", LANDSCAPE);
    const tilted = setGeometryAngle(readDevelopGeometry(writeDevelopGeometry(neutralDevelopSettings(), square)), 20, LANDSCAPE);
    expect(tilted.aspect).toBe("1:1");
    expectBoxClose(cropBoxFromGeometry(tilted, LANDSCAPE)!, maxCropBox(LANDSCAPE, 20, 1), 6);
  });

  it("自分で動かした切り抜きは、中心と大きさを保ち、枠から出る分だけ縮める", () => {
    const box: CropBox = { cx: 900, cy: 700, width: 800, height: 500 };
    const moved = geometry({ crop: cropFromBox(box, 0, LANDSCAPE), aspect: "free" });
    expect(isMaxCropBox(box, 0, LANDSCAPE)).toBe(false);

    // 収まる角度: そのまま
    const small = setGeometryAngle(moved, 10, LANDSCAPE);
    expectBoxClose(cropBoxFromGeometry(small, LANDSCAPE)!, box, 6);

    // 収まらない大きさ: 中心と比率を保って縮む
    const big: CropBox = { cx: 900, cy: 700, width: 1700, height: 1300 };
    const tilted = setGeometryAngle(geometry({ crop: cropFromBox(big, 0, LANDSCAPE), aspect: "free" }), 30, LANDSCAPE);
    const fitted = cropBoxFromGeometry(tilted, LANDSCAPE)!;
    expect(fitted.cx).toBeCloseTo(900, 6);
    expect(fitted.cy).toBeCloseTo(700, 6);
    expect(fitted.width / fitted.height).toBeCloseTo(1700 / 1300, 9);
    expect(fitted.width).toBeLessThan(1700);
    expect(isCropBoxInsideFrame(fitted, 30, LANDSCAPE)).toBe(true);
  });

  it("角度は −45〜45 に収める", () => {
    expect(setGeometryAngle(geometry(), 80, LANDSCAPE).angle).toBe(45);
    expect(setGeometryAngle(geometry(), -80, LANDSCAPE).angle).toBe(-45);
    expect(setGeometryAngle(geometry(), Number.NaN, LANDSCAPE).angle).toBe(0);
  });
});

describe("回転・反転", () => {
  const SOURCE: DevelopSize = { width: 3000, height: 2000 };
  const CASES: DevelopGeometry[] = [
    geometry(),
    geometry({ crop: { left: 0.2, top: 0.1, right: 0.8, bottom: 0.6 } }),
    geometry({ flipH: true, crop: { left: 0.1, top: 0.15, right: 0.85, bottom: 0.9 } }),
    geometry({ flipV: true, rotate: 90, crop: { left: 0.05, top: 0.3, right: 0.6, bottom: 0.95 } }),
    geometry({ angle: 7, crop: cropFromBox({ cx: 1400, cy: 900, width: 900, height: 500 }, 7, SOURCE) }),
    geometry({
      rotate: 270,
      flipH: true,
      angle: -12,
      crop: cropFromBox({ cx: 900, cy: 1600, width: 700, height: 1000 }, -12, { width: 2000, height: 3000 }),
      aspect: "4:5",
    }),
  ];

  it("crate の frame_pixels_follow_the_turn_and_the_flips と同じ対応（3 x 2 の作業画像）", () => {
    const tiny: DevelopSize = { width: 3, height: 2 };
    const pixels = (partial: Partial<DevelopGeometry>): number[] => {
      const g = geometry(partial);
      const frame = developFrameSize(tiny, g.rotate);
      const result: number[] = [];
      for (let y = 0; y < frame.height; y += 1) {
        for (let x = 0; x < frame.width; x += 1) {
          const [sx, sy] = source(g, tiny, (x + 0.5) / frame.width, (y + 0.5) / frame.height);
          result.push(Math.floor(sy * tiny.height) * tiny.width + Math.floor(sx * tiny.width));
        }
      }
      return result;
    };
    expect(pixels({ rotate: 90 })).toEqual([3, 0, 4, 1, 5, 2]);
    expect(pixels({ rotate: 180 })).toEqual([5, 4, 3, 2, 1, 0]);
    expect(pixels({ rotate: 270 })).toEqual([2, 5, 1, 4, 0, 3]);
    expect(pixels({ flipH: true })).toEqual([2, 1, 0, 5, 4, 3]);
    expect(pixels({ flipV: true })).toEqual([3, 4, 5, 0, 1, 2]);
    expect(pixels({ rotate: 90, flipH: true })).toEqual([0, 3, 1, 4, 2, 5]);
  });

  it("rotateGeometryClockwise は表示される結果を時計回りに 90° 回す（反転・角度があっても）", () => {
    for (const before of CASES) {
      const after = rotateGeometryClockwise(before, SOURCE);
      expect(after.rotate).toBe((before.rotate + 90) % 360);
      // 結果の右上の角は、回す前の結果の左上の角と同じ作業画像の点。ほかの角・中も同じく回る
      expectPointClose(source(after, SOURCE, 1, 0), source(before, SOURCE, 0, 0));
      expectPointClose(source(after, SOURCE, 1, 1), source(before, SOURCE, 1, 0));
      expectPointClose(source(after, SOURCE, 0, 1), source(before, SOURCE, 1, 1));
      expectPointClose(source(after, SOURCE, 0, 0), source(before, SOURCE, 0, 1));
      expectPointClose(source(after, SOURCE, 0.75, 0.2), source(before, SOURCE, 0.2, 0.25));
      // 幅と高さが入れ替わる
      const beforeBox = cropBoxFromGeometry(before, developFrameSize(SOURCE, before.rotate))!;
      const afterBox = cropBoxFromGeometry(after, developFrameSize(SOURCE, after.rotate))!;
      expect(afterBox.width).toBeCloseTo(beforeBox.height, 6);
      expect(afterBox.height).toBeCloseTo(beforeBox.width, 6);
    }
  });

  it("rotateGeometryClockwise を 4 回で元に戻る", () => {
    for (const before of CASES) {
      let current = before;
      for (let turn = 0; turn < 4; turn += 1) current = rotateGeometryClockwise(current, SOURCE);
      expectGeometryClose(current, before);
    }
  });

  it("回しても、切り抜きの比率は aspect の比率のまま（<w>:<h> は縦横を入れ替え、original は枠ごと回る）", () => {
    for (const aspect of ["original", "originalSwapped", "4:5", "1:1", "16:9"]) {
      const before = setGeometryAspect(geometry({ angle: 4 }), aspect, SOURCE);
      const after = rotateGeometryClockwise(before, SOURCE);
      const frame = developFrameSize(SOURCE, after.rotate);
      const box = cropBoxFromGeometry(after, frame)!;
      expect(box.width / box.height, aspect).toBeCloseTo(developAspectRatio(after.aspect, frame)!, 9);
      expect(isMaxCropBox(box, after.angle, frame), aspect).toBe(true);
    }
    expect(rotateGeometryClockwise(geometry({ aspect: "4:5" }), SOURCE).aspect).toBe("5:4");
    expect(rotateGeometryClockwise(geometry({ aspect: "original" }), SOURCE).aspect).toBe("original");
    expect(rotateGeometryClockwise(geometry({ aspect: "free" }), SOURCE).aspect).toBe("free");
    expect(Object.hasOwn(rotateGeometryClockwise(geometry(), SOURCE), "aspect")).toBe(false);
  });

  it("flipGeometryHorizontal は表示される結果を左右に鏡映する（結果の左上と右上が入れ替わる）", () => {
    for (const before of CASES) {
      const after = flipGeometryHorizontal(before, SOURCE);
      expect(after.flipH).toBe(!before.flipH);
      expect(after.angle).toBeCloseTo(-before.angle, 12);
      expectPointClose(source(after, SOURCE, 0, 0), source(before, SOURCE, 1, 0));
      expectPointClose(source(after, SOURCE, 1, 0), source(before, SOURCE, 0, 0));
      expectPointClose(source(after, SOURCE, 0, 1), source(before, SOURCE, 1, 1));
      expectPointClose(source(after, SOURCE, 0.2, 0.7), source(before, SOURCE, 0.8, 0.7));
    }
  });

  it("flipGeometryHorizontal を 2 回で元に戻る", () => {
    for (const before of CASES) {
      expectGeometryClose(flipGeometryHorizontal(flipGeometryHorizontal(before, SOURCE), SOURCE), before);
    }
    // 角度 0 は −0 にしない（保存の値が揺れない）
    expect(Object.is(flipGeometryHorizontal(geometry(), SOURCE).angle, 0)).toBe(true);
  });

  it("枠全体を回して保存すると、切り抜きは全体のまま（rotate だけが変わる）", () => {
    const turned = writeDevelopGeometry(neutralDevelopSettings(), rotateGeometryClockwise(geometry(), SOURCE));
    expect(turned.v).toBe(2);
    expect(turned.geometry).toEqual({
      rotate: 90,
      flipH: false,
      flipV: false,
      angle: 0,
      crop: { left: 0, top: 0, right: 1, bottom: 1 },
    });
    // 左右の反転を 2 回・回転を 4 回で恒等に戻り、geometry は消える
    let current = readDevelopGeometry(turned);
    for (let turn = 0; turn < 3; turn += 1) current = rotateGeometryClockwise(current, SOURCE);
    const back = writeDevelopGeometry(turned, current);
    expect(Object.hasOwn(back, "geometry")).toBe(false);
    expect(back.v).toBe(1);
  });
});
