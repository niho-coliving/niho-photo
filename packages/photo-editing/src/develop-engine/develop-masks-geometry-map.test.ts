import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { geometryOutputToSource, parseDevelopGeometry, type DevelopSize } from "./develop-geometry";
import { isIdentityDevelopPerspective } from "./develop-perspective";

/**
 * 部分補正（マスク）の面は、出力の画素の中心を作業画像の位置に戻して評価する（docs/local-adjustments.md「座標」）。crate の
 * `local_render::SourceMap` はこの `geometryOutputToSource` と同じ写像（遠近と「余白を埋める」を含む）で、共有 fixture の値で
 * 突き合わせる（Rust 側は `tests/masks_geometry_map.rs`）。fixture はこのテストが `geometryOutputToSource` から作る値そのもの:
 * 関数を変えたら `UPDATE_MASK_FIXTURES=1 npm run test --workspace packages/photo-editing -- develop-masks-geometry-map` で
 * 書き直し、Rust のテストも通ることを確かめる（書き直さずに関数だけ変えるとこのテストが落ちる）。消失線の向こうの点
 * （`geometryOutputToSource` が null）は `sx` `sy` を null で持つ。
 */

const FIXTURE_URL = new URL(
  "../../../develop-engine/crates/niho-develop/tests/fixtures/masks/geometry-map-cases.json",
  import.meta.url,
);

type MapCase = { name: string; geometry: Record<string, unknown>; source: DevelopSize };
type MapPoint = { px: number; py: number; sx: number | null; sy: number | null };
type PixelCase = MapCase & { maxDimension: number; output: DevelopSize; stride: number };
type PixelPoint = MapPoint & { i: number; j: number };
type MapFixture = {
  comment: string;
  cases: (MapCase & { points: MapPoint[] })[];
  pixels: (PixelCase & { points: PixelPoint[] })[];
};

const SIZES: DevelopSize[] = [
  { width: 3000, height: 2000 },
  { width: 1707, height: 2560 },
  { width: 640, height: 640 },
  { width: 4000, height: 1000 },
];

/** 遠近の 7 本の上限近く（余白を埋めるの有無で 2 回使う）。 */
const NEAR_LIMITS = { vertical: 95, horizontal: -90, rotate: 9.5, aspect: 90, scale: 140, x: -80, y: 75 };
/** 補正後の枠の隅が消失線の向こうになる遠近（余白を埋めないと null の点が出る）。 */
const PAST_VANISHING_LINE = { vertical: 100, horizontal: 100, scale: 50 };

const GEOMETRIES: { name: string; geometry: Record<string, unknown> }[] = [
  { name: "identity", geometry: {} },
  { name: "rotate 90", geometry: { rotate: 90 } },
  { name: "rotate 180", geometry: { rotate: 180 } },
  { name: "rotate 270", geometry: { rotate: 270 } },
  { name: "flipH", geometry: { flipH: true } },
  { name: "flipV", geometry: { flipV: true } },
  { name: "rotate 90 flipH flipV", geometry: { rotate: 90, flipH: true, flipV: true } },
  { name: "crop", geometry: { crop: { left: 0.1, top: 0.2, right: 0.85, bottom: 0.9 } } },
  {
    name: "rotate 270 flipH crop",
    geometry: { rotate: 270, flipH: true, crop: { left: 0.05, top: 0.3, right: 0.6, bottom: 0.95 } },
  },
  { name: "angle 10 (inscribed shrink)", geometry: { angle: 10 } },
  { name: "angle -20 (inscribed shrink)", geometry: { angle: -20 } },
  {
    name: "angle 3 rotate 90 crop",
    geometry: { angle: 3, rotate: 90, crop: { left: 0.1, top: 0.15, right: 0.85, bottom: 0.9 } },
  },
  {
    name: "angle -7.5 flipH crop",
    geometry: { angle: -7.5, flipH: true, crop: { left: 0.05, top: 0.3, right: 0.6, bottom: 0.95 } },
  },
  {
    name: "angle 44 thin crop",
    geometry: { angle: 44, rotate: 180, flipV: true, crop: { left: 0.5, top: 0, right: 0.5, bottom: 1 } },
  },
  // 遠近（v7）: 小さい値から上限近くまで、余白を埋める（constrain）の有無、90° 回転・反転・角度・切り抜きとの組み合わせ
  { name: "perspective vertical -30", geometry: { perspective: { vertical: -30 } } },
  { name: "perspective vertical -30 constrain", geometry: { perspective: { vertical: -30 }, constrain: true } },
  { name: "perspective small", geometry: { perspective: { vertical: 5, horizontal: -3 } } },
  {
    name: "perspective horizontal 45 rotate -3.5 constrain",
    geometry: { perspective: { horizontal: 45, rotate: -3.5 }, constrain: true },
  },
  { name: "perspective aspect -60 scale 120", geometry: { perspective: { aspect: -60, scale: 120 } } },
  {
    name: "perspective scale 70 x 40 y -25 constrain",
    geometry: { perspective: { scale: 70, x: 40, y: -25 }, constrain: true },
  },
  {
    name: "perspective offset to a corner constrain",
    geometry: { perspective: { x: -100, y: 100, scale: 50 }, constrain: true },
  },
  { name: "perspective near the limits", geometry: { perspective: NEAR_LIMITS } },
  { name: "perspective near the limits constrain", geometry: { perspective: NEAR_LIMITS, constrain: true } },
  { name: "perspective past the vanishing line", geometry: { perspective: PAST_VANISHING_LINE } },
  {
    name: "perspective past the vanishing line constrain",
    geometry: { perspective: PAST_VANISHING_LINE, constrain: true },
  },
  {
    name: "perspective rotate 90 flipH angle 6 crop constrain",
    geometry: {
      rotate: 90,
      flipH: true,
      angle: 6,
      crop: { left: 0.08, top: 0.1, right: 0.9, bottom: 0.85 },
      perspective: { vertical: -40, horizontal: 15, rotate: 2, scale: 90 },
      constrain: true,
    },
  },
  {
    name: "perspective rotate 270 flipV angle -4 crop",
    geometry: {
      rotate: 270,
      flipV: true,
      angle: -4,
      crop: { left: 0.1, top: 0.05, right: 0.75, bottom: 0.9 },
      perspective: { vertical: 25, aspect: 40, y: -30 },
    },
  },
  {
    name: "perspective rotate 180 flipH flipV constrain",
    geometry: { rotate: 180, flipH: true, flipV: true, perspective: { vertical: -60 }, constrain: true },
  },
  {
    name: "perspective angle -15 crop constrain",
    geometry: {
      angle: -15,
      crop: { left: 0.15, top: 0.1, right: 0.8, bottom: 0.95 },
      perspective: { vertical: 50, rotate: -10 },
      constrain: true,
    },
  },
  { name: "perspective identity values constrain", geometry: { perspective: { vertical: 0, scale: 100 }, constrain: true } },
];

const POINTS: [number, number][] = [
  [0.5, 0.5],
  [0, 0],
  [1, 1],
  [1, 0],
  [0.25, 0.75],
  [0.9, 0.1],
  [0.123, 0.456],
  [0.03, 0.97],
  [0.98, 0.6],
];

/**
 * 出力の画素の中心 `((i + 0.5) / W, (j + 0.5) / H)` での値（`stride` 画素おき）。`output` は crate がこの幾何を `maxDimension`
 * で描く大きさ（`frame::output_size`。Rust のテストが `Session::mask_plane` の大きさと一致することを確かめる）で、Rust 側は
 * この点の値から面を計算して `Session::mask_plane` と描画（`Session::render`）を突き合わせる。
 */
const PIXEL_CASES: PixelCase[] = [
  {
    name: "pixels vertical -40",
    geometry: { perspective: { vertical: -40 } },
    source: { width: 120, height: 80 },
    maxDimension: 48,
    output: { width: 48, height: 32 },
    stride: 3,
  },
  {
    name: "pixels rotate 90 vertical 35 constrain",
    geometry: { rotate: 90, perspective: { vertical: 35, rotate: 3 }, constrain: true },
    source: { width: 120, height: 80 },
    maxDimension: 48,
    output: { width: 32, height: 48 },
    stride: 3,
  },
  {
    name: "pixels flipH angle 4 crop horizontal -30 constrain",
    geometry: {
      flipH: true,
      angle: 4,
      crop: { left: 0.05, top: 0.05, right: 0.95, bottom: 0.95 },
      perspective: { horizontal: -30, scale: 110 },
      constrain: true,
    },
    source: { width: 120, height: 80 },
    maxDimension: 48,
    output: { width: 48, height: 27 },
    stride: 3,
  },
];

function parse(name: string, geometry: Record<string, unknown>) {
  const parsed = parseDevelopGeometry(geometry);
  if (!parsed) throw new Error(`${name}: invalid geometry`);
  return parsed;
}

/** `(px, py)` の値。null は遠近の消失線の向こうだけ（遠近の無い幾何の null は長方形にならない切り抜きで、fixture にしない）。 */
function mapPoint(
  name: string,
  parsed: ReturnType<typeof parse>,
  source: DevelopSize,
  px: number,
  py: number,
): MapPoint {
  const mapped = geometryOutputToSource(parsed, source, px, py);
  if (!mapped && isIdentityDevelopPerspective(parsed.perspective)) {
    throw new Error(`${name} ${source.width}x${source.height}: not a rectangle`);
  }
  return { px, py, sx: mapped ? mapped[0] : null, sy: mapped ? mapped[1] : null };
}

/** fixture の中身（`geometryOutputToSource` の値）。 */
function generate(): MapFixture {
  const cases: MapFixture["cases"] = [];
  for (const source of SIZES) {
    for (const { name, geometry } of GEOMETRIES) {
      const parsed = parse(name, geometry);
      const points = POINTS.map(([px, py]) => mapPoint(name, parsed, source, px, py));
      if (points.every((p) => p.sx === null)) throw new Error(`${name} ${source.width}x${source.height}: no point maps`);
      cases.push({ name: `${name} ${source.width}x${source.height}`, geometry, source, points });
    }
  }
  const pixels: MapFixture["pixels"] = PIXEL_CASES.map((pixelCase) => {
    const parsed = parse(pixelCase.name, pixelCase.geometry);
    const { width, height } = pixelCase.output;
    const points: PixelPoint[] = [];
    for (let j = 0; j < height; j += pixelCase.stride) {
      for (let i = 0; i < width; i += pixelCase.stride) {
        const point = mapPoint(pixelCase.name, parsed, pixelCase.source, (i + 0.5) / width, (j + 0.5) / height);
        points.push({ i, j, ...point });
      }
    }
    return { ...pixelCase, points };
  });
  return {
    comment:
      "geometryOutputToSource (packages/photo-editing/src/develop-engine/develop-geometry.ts): output (px, py) -> working image (sx, sy); sx and sy are null past the perspective's vanishing line. `pixels` holds output pixel centres ((i + 0.5) / W, (j + 0.5) / H) of the size the crate renders at maxDimension. Written by develop-masks-geometry-map.test.ts (UPDATE_MASK_FIXTURES=1); read by tests/masks_geometry_map.rs.",
    cases,
    pixels,
  };
}

function expectSamePoints(actual: MapPoint[], want: MapPoint[]) {
  expect(actual).toHaveLength(want.length);
  actual.forEach((p, j) => {
    const w = want[j]!;
    expect([p.px, p.py]).toEqual([w.px, w.py]);
    if (w.sx === null || w.sy === null) {
      expect([p.sx, p.sy]).toEqual([null, null]);
      return;
    }
    expect(Math.abs(p.sx! - w.sx)).toBeLessThan(1e-12);
    expect(Math.abs(p.sy! - w.sy)).toBeLessThan(1e-12);
  });
}

describe("mask geometry map fixture", () => {
  it("is the values of geometryOutputToSource", () => {
    const generated = generate();
    const path = fileURLToPath(FIXTURE_URL);
    if (process.env.UPDATE_MASK_FIXTURES === "1") {
      writeFileSync(path, `${JSON.stringify(generated, null, 2)}\n`);
    }
    const fixture = JSON.parse(readFileSync(path, "utf8")) as MapFixture;
    expect(fixture.comment).toBe(generated.comment);
    expect(fixture.cases.map((c) => [c.name, c.geometry, c.source])).toEqual(
      generated.cases.map((c) => [c.name, c.geometry, c.source]),
    );
    fixture.cases.forEach((c, i) => expectSamePoints(c.points, generated.cases[i]!.points));
    const header = ({ points: _points, ...rest }: MapFixture["pixels"][number]) => rest;
    expect(fixture.pixels.map(header)).toEqual(generated.pixels.map(header));
    fixture.pixels.forEach((c, i) => {
      const want = generated.pixels[i]!.points;
      expect(c.points.map((p) => [p.i, p.j])).toEqual(want.map((p) => [p.i, p.j]));
      expectSamePoints(c.points, want);
    });
  });

  it("covers every quarter turn, both flips, crops and turned crops that shrink", () => {
    const names = generate().cases.map((c) => c.name);
    expect(names).toHaveLength(SIZES.length * GEOMETRIES.length);
    // 角度つきで枠から出る切り抜きは中心の回りに縮めて収める（中心は動かない）
    const turned = generate().cases.find((c) => c.name === "angle 10 (inscribed shrink) 3000x2000")!;
    expect(turned.points[0]!.sx).toBeCloseTo(0.5, 12);
    expect(turned.points[0]!.sy).toBeCloseTo(0.5, 12);
    const corner = turned.points[1]!;
    expect(corner.sx).toBeGreaterThan(0);
    expect(corner.sy).toBeGreaterThan(0);
  });

  it("covers perspectives with and without constrain, past the vanishing line included", () => {
    const { cases, pixels } = generate();
    const byName = (name: string) => cases.find((c) => c.name === name)!;
    const inside = (p: MapPoint) =>
      p.sx !== null && p.sy !== null && p.sx >= -1e-9 && p.sx <= 1 + 1e-9 && p.sy >= -1e-9 && p.sy <= 1 + 1e-9;
    // 余白を埋めないと、遠近で空いた隅は写真の外（0〜1 の外）を指す。埋めると出力の隅まで写真の中
    expect(byName("perspective vertical -30 3000x2000").points.some((p) => !inside(p))).toBe(true);
    for (const size of SIZES) {
      const suffix = `${size.width}x${size.height}`;
      for (const name of ["perspective vertical -30 constrain", "perspective rotate 90 flipH angle 6 crop constrain"]) {
        expect(byName(`${name} ${suffix}`).points.every(inside)).toBe(true);
      }
      // 恒等の遠近に余白を埋めるだけなら、恒等の写像のまま
      expect(byName(`perspective identity values constrain ${suffix}`).points).toEqual(byName(`identity ${suffix}`).points);
    }
    // 消失線の向こうの点（null）がある。中心はどれも写る
    const past = cases.filter((c) => c.name.startsWith("perspective past the vanishing line ") && !c.name.includes("constrain"));
    expect(past.some((c) => c.points.some((p) => p.sx === null))).toBe(true);
    expect(cases.every((c) => c.points[0]!.sx !== null)).toBe(true);
    // 画素の例: 出力の全体に散らばり、余白を埋めたものは全部写真の中。埋めないものは隅が写真の外
    for (const pixelCase of pixels) {
      expect(pixelCase.points.length).toBeGreaterThan(50);
      if (pixelCase.geometry.constrain === true) expect(pixelCase.points.every(inside)).toBe(true);
    }
    expect(pixels[0]!.points.some((p) => !inside(p))).toBe(true);
  });
});
