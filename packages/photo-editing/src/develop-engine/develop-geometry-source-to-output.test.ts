import { describe, expect, it } from "vitest";

import {
  IDENTITY_DEVELOP_GEOMETRY,
  cropFromBox,
  developFrameSize,
  geometryOutputToSource,
  geometrySourceToOutput,
  type DevelopGeometry,
  type DevelopGeometryRotate,
  type DevelopSize,
} from "./develop-geometry";

/**
 * `geometrySourceToOutput`（作業画像 → 出力。部分補正のつまみを写真の上の見えている位置に置く）が `geometryOutputToSource` の
 * ちょうど逆になっていることを、回転 4 通り・反転・角度補正つきの切り抜き・いくつかの縦横比で往復させて確かめる。
 */

const SOURCES: DevelopSize[] = [
  { width: 3000, height: 2000 },
  { width: 2000, height: 3000 },
  { width: 1000, height: 1000 },
  { width: 4096, height: 1365 },
];
const ROTATES: DevelopGeometryRotate[] = [0, 90, 180, 270];
const FLIPS: Array<[boolean, boolean]> = [
  [false, false],
  [true, false],
  [false, true],
  [true, true],
];
/**
 * 角度と切り抜きの箱（枠に対する割合の中心・幅・高さ）。`cropFromBox` で `crop` にするので、どの縦横比・回転でも長方形になる。
 * 大きな箱に角度を付けたものは角が枠から出る（描き方は中心の回りに縮めて収める）。
 */
const BOXES: Array<{ angle: number; cx: number; cy: number; width: number; height: number }> = [
  { angle: 0, cx: 0.5, cy: 0.5, width: 1, height: 1 },
  { angle: 0, cx: 0.5, cy: 0.35, width: 0.6, height: 0.5 },
  { angle: 7, cx: 0.48, cy: 0.51, width: 0.7, height: 0.6 },
  { angle: -12.5, cx: 0.47, cy: 0.475, width: 0.4, height: 0.45 },
  // 角が枠から出る
  { angle: 30, cx: 0.5, cy: 0.5, width: 0.9, height: 0.9 },
  { angle: -45, cx: 0.55, cy: 0.5, width: 0.8, height: 0.7 },
];
const POINTS: Array<[number, number]> = [
  [0.5, 0.5],
  [0, 0],
  [1, 1],
  [0.13, 0.87],
  [0.71, 0.29],
  // 出力の外（線形の端は枠の外にも置ける）
  [-0.4, 1.3],
  [1.6, -0.2],
];

function geometries(size: DevelopSize): DevelopGeometry[] {
  const result: DevelopGeometry[] = [];
  for (const rotate of ROTATES) {
    const frame = developFrameSize(size, rotate);
    for (const [flipH, flipV] of FLIPS) {
      for (const spec of BOXES) {
        const crop = cropFromBox(
          {
            cx: spec.cx * frame.width,
            cy: spec.cy * frame.height,
            width: spec.width * frame.width,
            height: spec.height * frame.height,
          },
          spec.angle,
          frame,
        );
        result.push({ ...IDENTITY_DEVELOP_GEOMETRY, rotate, flipH, flipV, angle: spec.angle, crop });
      }
    }
  }
  return result;
}

function expectClose(actual: [number, number] | null, expected: [number, number], label: string) {
  expect(actual, label).not.toBeNull();
  expect(Math.abs(actual![0] - expected[0]), label).toBeLessThan(1e-9);
  expect(Math.abs(actual![1] - expected[1]), label).toBeLessThan(1e-9);
}

describe("geometrySourceToOutput", () => {
  it("出力 → 作業画像 → 出力の往復で元の位置に戻る（回転・反転・角度補正・縦横比のすべての組み合わせ）", () => {
    for (const size of SOURCES) {
      for (const geometry of geometries(size)) {
        for (const point of POINTS) {
          const label = JSON.stringify({ size, geometry, point });
          const source = geometryOutputToSource(geometry, size, point[0], point[1]);
          expect(source, label).not.toBeNull();
          expectClose(geometrySourceToOutput(geometry, size, source![0], source![1]), point, label);
        }
      }
    }
  });

  it("作業画像 → 出力 → 作業画像の往復でも元の位置に戻る", () => {
    for (const size of SOURCES) {
      for (const geometry of geometries(size)) {
        for (const point of POINTS) {
          const label = JSON.stringify({ size, geometry, point });
          const output = geometrySourceToOutput(geometry, size, point[0], point[1]);
          expect(output, label).not.toBeNull();
          expectClose(geometryOutputToSource(geometry, size, output![0], output![1]), point, label);
        }
      }
    }
  });

  it("遠近と余白を埋めるを含めても、作業画像と出力の座標が往復する", () => {
    const source = { width: 3000, height: 2000 };
    const perspective = { vertical: -30, horizontal: 18, rotate: 4, aspect: 10, scale: 110, x: 5, y: -3 };
    const frame = developFrameSize(source, 90);
    const constrained: DevelopGeometry = {
      ...IDENTITY_DEVELOP_GEOMETRY,
      rotate: 90,
      flipH: true,
      angle: 8,
      crop: cropFromBox(
        { cx: frame.width * 0.5, cy: frame.height * 0.5, width: frame.width * 0.7, height: frame.height * 0.65 },
        8,
        frame,
      ),
      perspective,
      constrain: true,
    };
    const geometries: DevelopGeometry[] = [
      { ...IDENTITY_DEVELOP_GEOMETRY, perspective },
      constrained,
    ];
    const points: Array<[number, number]> = [[0.1, 0.2], [0.5, 0.5], [0.87, 0.73]];

    for (const geometry of geometries) {
      for (const point of points) {
        const sourcePoint = geometryOutputToSource(geometry, source, point[0], point[1]);
        expect(sourcePoint).not.toBeNull();
        expectClose(
          geometrySourceToOutput(geometry, source, sourcePoint![0], sourcePoint![1]),
          point,
          JSON.stringify({ geometry, point, direction: "output-source-output" }),
        );

        const outputPoint = geometrySourceToOutput(geometry, source, point[0], point[1]);
        expect(outputPoint).not.toBeNull();
        expectClose(
          geometryOutputToSource(geometry, source, outputPoint![0], outputPoint![1]),
          point,
          JSON.stringify({ geometry, point, direction: "source-output-source" }),
        );
      }
    }
  });

  it("幾何が恒等なら位置はそのまま、切り抜きだけなら枠の中の割合", () => {
    const size = { width: 3000, height: 2000 };
    expectClose(geometrySourceToOutput(IDENTITY_DEVELOP_GEOMETRY, size, 0.3, 0.8), [0.3, 0.8], "identity");
    const cropped = { ...IDENTITY_DEVELOP_GEOMETRY, crop: { left: 0.2, top: 0.1, right: 0.8, bottom: 0.6 } };
    // 切り抜きの左上が 0,0・右下が 1,1
    expectClose(geometrySourceToOutput(cropped, size, 0.2, 0.1), [0, 0], "top-left");
    expectClose(geometrySourceToOutput(cropped, size, 0.8, 0.6), [1, 1], "bottom-right");
    // 時計回りの 90° 回転: 作業画像の左上は出力の右上
    const turned = { ...IDENTITY_DEVELOP_GEOMETRY, rotate: 90 as const };
    expectClose(geometrySourceToOutput(turned, size, 0, 0), [1, 0], "rotate 90");
    // 左右の反転: 左端は右端
    const flipped = { ...IDENTITY_DEVELOP_GEOMETRY, flipH: true };
    expectClose(geometrySourceToOutput(flipped, size, 0, 0.5), [1, 0.5], "flipH");
  });

  it("順方向が描けない切り抜き（長方形にならない・角度つきで中心が枠の外）は null", () => {
    const square = { width: 1000, height: 1000 };
    expect(
      geometrySourceToOutput(
        { ...IDENTITY_DEVELOP_GEOMETRY, angle: 45, crop: { left: 0, top: 0.5, right: 1, bottom: 0.5 } },
        square,
        0.5,
        0.5,
      ),
    ).toBeNull();
    expect(
      geometrySourceToOutput(
        { ...IDENTITY_DEVELOP_GEOMETRY, angle: 45, crop: { left: 0, top: 0, right: 0, bottom: 1 } },
        square,
        0.5,
        0.5,
      ),
    ).toBeNull();
  });
});
