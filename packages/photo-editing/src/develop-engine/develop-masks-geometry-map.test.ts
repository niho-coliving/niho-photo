import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { geometryOutputToSource, parseDevelopGeometry, type DevelopSize } from "./develop-geometry";

/**
 * 部分補正（マスク）の面は、出力の画素の中心を作業画像の位置に戻して評価する（docs/local-adjustments.md「座標」）。crate の
 * `local_render::SourceMap` はこの `geometryOutputToSource` と同じ写像で、共有 fixture の値で突き合わせる（Rust 側は
 * `tests/masks_geometry_map.rs`）。fixture はこのテストが `geometryOutputToSource` から作る値そのもの: 関数を変えたら
 * `UPDATE_MASK_FIXTURES=1 npm run test --workspace packages/photo-editing -- develop-masks-geometry-map` で書き直し、Rust の
 * テストも通ることを確かめる（書き直さずに関数だけ変えるとこのテストが落ちる）。
 */

const FIXTURE_URL = new URL(
  "../../../develop-engine/crates/niho-develop/tests/fixtures/masks/geometry-map-cases.json",
  import.meta.url,
);

type MapCase = { name: string; geometry: Record<string, unknown>; source: DevelopSize };
type MapPoint = { px: number; py: number; sx: number; sy: number };
type MapFixture = { comment: string; cases: (MapCase & { points: MapPoint[] })[] };

const SIZES: DevelopSize[] = [
  { width: 3000, height: 2000 },
  { width: 1707, height: 2560 },
  { width: 640, height: 640 },
  { width: 4000, height: 1000 },
];

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
];

const POINTS: [number, number][] = [
  [0.5, 0.5],
  [0, 0],
  [1, 1],
  [1, 0],
  [0.25, 0.75],
  [0.9, 0.1],
  [0.123, 0.456],
];

/** fixture の中身（`geometryOutputToSource` の値）。 */
function generate(): MapFixture {
  const cases: MapFixture["cases"] = [];
  for (const source of SIZES) {
    for (const { name, geometry } of GEOMETRIES) {
      const parsed = parseDevelopGeometry(geometry);
      if (!parsed) throw new Error(`${name}: invalid geometry`);
      const points = POINTS.map(([px, py]): MapPoint => {
        const mapped = geometryOutputToSource(parsed, source, px, py);
        if (!mapped) throw new Error(`${name} ${source.width}x${source.height}: not a rectangle`);
        return { px, py, sx: mapped[0], sy: mapped[1] };
      });
      cases.push({ name: `${name} ${source.width}x${source.height}`, geometry, source, points });
    }
  }
  return {
    comment:
      "geometryOutputToSource (packages/photo-editing/src/develop-engine/develop-geometry.ts): output (px, py) -> working image (sx, sy). Written by develop-masks-geometry-map.test.ts (UPDATE_MASK_FIXTURES=1); read by tests/masks_geometry_map.rs.",
    cases,
  };
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
    fixture.cases.forEach((c, i) => {
      const want = generated.cases[i]!.points;
      expect(c.points).toHaveLength(want.length);
      c.points.forEach((p, j) => {
        const w = want[j]!;
        expect([p.px, p.py]).toEqual([w.px, w.py]);
        expect(Math.abs(p.sx - w.sx)).toBeLessThan(1e-12);
        expect(Math.abs(p.sy - w.sy)).toBeLessThan(1e-12);
      });
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
});
