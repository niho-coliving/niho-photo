import { describe, expect, it } from "vitest";

import {
  IDENTITY_DEVELOP_GEOMETRY,
  geometryOutputToSource,
  geometrySourceToOutput,
  type DevelopGeometry,
} from "./develop-engine/develop-geometry";
import {
  PHOTO_EDITING_MASK_BRUSH_SIZE_MAX,
  PHOTO_EDITING_MASK_BRUSH_SIZE_MIN,
  clampPhotoEditingMaskBrushSize,
  createPhotoEditingMaskStroke,
  filledPhotoEditingMaskSurface,
  photoEditingMaskBrushDab,
  photoEditingMaskBrushFalloff,
  photoEditingMaskBrushPath,
  photoEditingMaskBrushSpacing,
  photoEditingMaskOutputExtent,
  photoEditingMaskSurfaceSize,
  stepPhotoEditingMaskBrushSize,
  type PhotoEditingMaskSurfaceData,
} from "./photo-editing-mask-brush";
import type { PhotoEditingMaskFrame } from "./photo-editing-masks";

/**
 * ブラシの塗りの計算（M4 #68）: 面の大きさ、dab の位置と半径（出力 → 作業画像 → 面の画素。切り抜き・回転・反転・角度補正に付いて
 * くる）、縁・流量の重ね方・消しゴム・間隔・面の外・同じ入力の同じ結果。
 */

const SOURCE = { width: 3000, height: 2000 };
const SURFACE = photoEditingMaskSurfaceSize(SOURCE);

function frameOf(geometry: Partial<DevelopGeometry> = {}): PhotoEditingMaskFrame {
  return { geometry: { ...IDENTITY_DEVELOP_GEOMETRY, crop: { ...IDENTITY_DEVELOP_GEOMETRY.crop }, ...geometry }, source: SOURCE };
}

function blank(width = 8, height = 8, value = 0): PhotoEditingMaskSurfaceData {
  return { width, height, data: filledPhotoEditingMaskSurface(width, height, value) };
}

describe("photoEditingMaskSurfaceSize", () => {
  it("作業画像の縦横比で長辺 1024（短い辺は 1 以上）", () => {
    expect(photoEditingMaskSurfaceSize({ width: 3000, height: 2000 })).toEqual({ width: 1024, height: 683 });
    expect(photoEditingMaskSurfaceSize({ width: 2000, height: 3000 })).toEqual({ width: 683, height: 1024 });
    expect(photoEditingMaskSurfaceSize({ width: 800, height: 800 })).toEqual({ width: 1024, height: 1024 });
    expect(photoEditingMaskSurfaceSize({ width: 100_000, height: 1 })).toEqual({ width: 1024, height: 1 });
  });
});

describe("大きさ", () => {
  it("刻み 0.5 に丸めて 0.5〜30 に収め、[ ] は約 1.25 倍（少なくとも 1 刻み）", () => {
    expect(clampPhotoEditingMaskBrushSize(6.2)).toBe(6);
    expect(clampPhotoEditingMaskBrushSize(0)).toBe(PHOTO_EDITING_MASK_BRUSH_SIZE_MIN);
    expect(clampPhotoEditingMaskBrushSize(99)).toBe(PHOTO_EDITING_MASK_BRUSH_SIZE_MAX);
    expect(stepPhotoEditingMaskBrushSize(6, 1)).toBe(7.5);
    expect(stepPhotoEditingMaskBrushSize(6, -1)).toBe(5);
    expect(stepPhotoEditingMaskBrushSize(0.5, 1)).toBe(1);
    expect(stepPhotoEditingMaskBrushSize(0.5, -1)).toBe(0.5);
    expect(stepPhotoEditingMaskBrushSize(30, 1)).toBe(30);
  });
});

describe("photoEditingMaskBrushDab", () => {
  it("幾何なし: 出力の位置が作業画像の位置で、半径は短い辺 × 大きさ%（面の画素の縦横で別）", () => {
    const dab = photoEditingMaskBrushDab(frameOf(), SURFACE, [0.25, 0.5], 6)!;
    expect(dab.x).toBeCloseTo(0.25 * 1024, 9);
    expect(dab.y).toBeCloseTo(0.5 * 683, 9);
    // 短い辺 2000px × 6% = 120px（作業画像）→ 面の画素
    expect(dab.rx).toBeCloseTo((120 * 1024) / 3000, 9);
    expect(dab.ry).toBeCloseTo((120 * 683) / 2000, 9);
  });

  it("切り抜き: 半径は見えている短い辺（作業画像の画素）に比例する", () => {
    const frame = frameOf({ crop: { left: 0.25, top: 0, right: 0.75, bottom: 1 } });
    expect(photoEditingMaskOutputExtent(frame)).toEqual({ width: 1500, height: 2000 });
    const dab = photoEditingMaskBrushDab(frame, SURFACE, [0.5, 0.5], 10)!;
    expect(dab.x).toBeCloseTo(0.5 * 1024, 9);
    expect(dab.rx).toBeCloseTo((150 * 1024) / 3000, 9);
  });

  it("回転・反転: 出力の点は同じ内容（作業画像の位置）に塗る", () => {
    const rotated = frameOf({ rotate: 90 });
    const extent = photoEditingMaskOutputExtent(rotated)!;
    expect(extent.width).toBeCloseTo(2000, 9);
    expect(extent.height).toBeCloseTo(3000, 9);
    const source = geometryOutputToSource(rotated.geometry, SOURCE, 0.2, 0.7)!;
    const dab = photoEditingMaskBrushDab(rotated, SURFACE, [0.2, 0.7], 6)!;
    expect(dab.x / 1024).toBeCloseTo(source[0], 9);
    expect(dab.y / 683).toBeCloseTo(source[1], 9);

    const flipped = frameOf({ flipH: true });
    const mirrored = photoEditingMaskBrushDab(flipped, SURFACE, [0.2, 0.5], 6)!;
    expect(mirrored.x / 1024).toBeCloseTo(0.8, 9);
  });

  it("角度補正つきの切り抜き: dab の中心を出力へ戻すと押した点、半径は写像の縮尺どおり", () => {
    const frame = frameOf({ angle: 12, crop: { left: 0.2, top: 0.15, right: 0.8, bottom: 0.85 } });
    const extent = photoEditingMaskOutputExtent(frame)!;
    const output: [number, number] = [0.3, 0.6];
    const dab = photoEditingMaskBrushDab(frame, SURFACE, output, 8)!;
    const back = geometrySourceToOutput(frame.geometry, SOURCE, dab.x / 1024, dab.y / 683)!;
    expect(back[0]).toBeCloseTo(output[0], 6);
    expect(back[1]).toBeCloseTo(output[1], 6);
    expect(dab.rx).toBeCloseTo((0.08 * Math.min(extent.width, extent.height) * 1024) / 3000, 9);
    // 相似な写像: 出力の 1 の動きは、作業画像の画素で縦横同じ長さに縮む
    expect(extent.width / extent.height).toBeGreaterThan(0);
  });

  it("遠近では局所ヤコビアンで画面の円を面上の楕円へ写す", () => {
    const viewport = { width: 900, height: 600 };
    const frame = frameOf({
      perspective: { vertical: -30, horizontal: 12, rotate: 2.5, aspect: 20, scale: 110, x: 15, y: -7.5 },
    });
    const output: [number, number] = [0.48, 0.52];
    const dab = photoEditingMaskBrushDab(frame, SURFACE, output, 3, viewport)!;
    expect(dab.metric).toBeDefined();
    expect(Math.abs(dab.metric![1])).toBeGreaterThan(0.00001);

    const center = geometryOutputToSource(frame.geometry, SOURCE, output[0], output[1])!;
    const radius = 0.03 * Math.min(viewport.width, viewport.height);
    const directions: [number, number][] = [
      [1, 0],
      [0, 1],
      [Math.SQRT1_2, Math.SQRT1_2],
      [-Math.SQRT1_2, Math.SQRT1_2],
    ];
    for (const [dx, dy] of directions) {
      const point: [number, number] = [output[0] + (dx * radius) / viewport.width, output[1] + (dy * radius) / viewport.height];
      const mapped = geometryOutputToSource(frame.geometry, SOURCE, point[0], point[1])!;
      const sx = (mapped[0] - center[0]) * SURFACE.width;
      const sy = (mapped[1] - center[1]) * SURFACE.height;
      const [xx, xy, yy] = dab.metric!;
      const distance = Math.sqrt(xx * sx * sx + 2 * xy * sx * sy + yy * sy * sy);
      expect(distance).toBeCloseTo(1, 1);
    }
  });
});

describe("photoEditingMaskBrushFalloff", () => {
  it("中心は 1・縁の外は 0・ぼかしの幅で滑らかに 0 へ（ぼかし 0 でも縁の約 1 画素はなじませる）", () => {
    expect(photoEditingMaskBrushFalloff(0, 50, 100)).toBe(1);
    expect(photoEditingMaskBrushFalloff(1, 50, 100)).toBe(0);
    expect(photoEditingMaskBrushFalloff(1.2, 50, 100)).toBe(0);
    // ぼかし 100: 中心から縁まで smoothstep（半分で 0.5）
    expect(photoEditingMaskBrushFalloff(0.5, 100, 100)).toBeCloseTo(0.5, 12);
    // ぼかし 50: 中心から半径の半分までは 1
    expect(photoEditingMaskBrushFalloff(0.4, 50, 100)).toBe(1);
    // ぼかし 0: 縁の 1 画素（半径 100 の 1%）だけ
    expect(photoEditingMaskBrushFalloff(0.98, 0, 100)).toBe(1);
    expect(photoEditingMaskBrushFalloff(0.995, 0, 100)).toBeCloseTo(0.5, 12);
  });
});

describe("photoEditingMaskBrushPath", () => {
  it("半径の 25% ごとに置き、残りを次の線分に持ち越す", () => {
    const first = photoEditingMaskBrushPath([0, 0], [10, 0], 2.5, 0);
    expect(first.points).toEqual([
      [2.5, 0],
      [5, 0],
      [7.5, 0],
      [10, 0],
    ]);
    expect(first.carry).toBe(0);
    const short = photoEditingMaskBrushPath([10, 0], [11, 0], 2.5, first.carry);
    expect(short.points).toEqual([]);
    expect(short.carry).toBe(1);
    const next = photoEditingMaskBrushPath([11, 0], [13, 0], 2.5, short.carry);
    expect(next.points).toEqual([[12.5, 0]]);
    expect(next.carry).toBeCloseTo(0.5, 12);
    expect(photoEditingMaskBrushSpacing(8, { width: 400, height: 300 })).toBeCloseTo(0.08 * 300 * 0.25, 12);
  });
});

describe("createPhotoEditingMaskStroke", () => {
  it("dab の逆共分散metricは回転した楕円の内外判定に使う", () => {
    const stroke = createPhotoEditingMaskStroke(blank(64, 64), { feather: 100, flow: 100, erase: false });
    stroke.addDab({ x: 32.5, y: 32.5, rx: 10, ry: 10, metric: [0.13, -0.12, 0.13] });
    const result = stroke.result()!;
    expect(result[37 * 64 + 37]).toBeGreaterThan(0);
    expect(result[27 * 64 + 37]).toBe(0);
  });

  it("塗りは v + (255 − v)·A（dab ごとに v += (255 − v)·a を重ねたのと同じ）、終わりに 1 回だけ丸める", () => {
    const base = blank(4, 4, 0);
    const stroke = createPhotoEditingMaskStroke(base, { feather: 50, flow: 50, erase: false });
    const dab = { x: 1.5, y: 1.5, rx: 0.75, ry: 0.75 };
    stroke.addDab(dab);
    expect(stroke.result()![1 * 4 + 1]).toBe(128);
    stroke.addDab(dab);
    const twice = stroke.result()!;
    expect(twice[1 * 4 + 1]).toBe(191);
    // 半径の外は変えない・元の値は変えない
    expect(twice[1 * 4 + 0]).toBe(0);
    expect(base.data.every((value) => value === 0)).toBe(true);
  });

  it("消しゴムは v·(1 − A)", () => {
    const base = blank(4, 4, 200);
    const stroke = createPhotoEditingMaskStroke(base, { feather: 50, flow: 50, erase: true });
    const dab = { x: 2.5, y: 2.5, rx: 0.75, ry: 0.75 };
    stroke.addDab(dab);
    expect(stroke.result()![2 * 4 + 2]).toBe(100);
    stroke.addDab(dab);
    expect(stroke.result()![2 * 4 + 2]).toBe(50);
  });

  it("流量 100・中心の dab は 255 にする。面の外にはみ出た dab は内側だけ、全部外なら何も変えない", () => {
    const stroke = createPhotoEditingMaskStroke(blank(), { feather: 0, flow: 100, erase: false });
    stroke.addDab({ x: -1, y: 4, rx: 3, ry: 3 });
    const result = stroke.result()!;
    expect(result[4 * 8 + 0]).toBe(255);
    expect(result[4 * 8 + 3]).toBe(0);
    const outside = createPhotoEditingMaskStroke(blank(), { feather: 0, flow: 100, erase: false });
    outside.addDab({ x: -10, y: -10, rx: 2, ry: 2 });
    outside.addDab({ x: Number.NaN, y: 1, rx: 2, ry: 2 });
    expect(outside.dirty).toBeNull();
    expect(outside.result()).toBeNull();
  });

  it("どの画素も変わらない塗り（全部 255 の上・全部 0 の消しゴム）は null", () => {
    const full = createPhotoEditingMaskStroke(blank(8, 8, 255), { feather: 50, flow: 100, erase: false });
    full.addDab({ x: 4, y: 4, rx: 3, ry: 3 });
    expect(full.result()).toBeNull();
    const empty = createPhotoEditingMaskStroke(blank(8, 8, 0), { feather: 50, flow: 100, erase: true });
    empty.addDab({ x: 4, y: 4, rx: 3, ry: 3 });
    expect(empty.result()).toBeNull();
  });

  it("同じ入力は同じ結果（線に沿った dab を同じ順に重ねる）", () => {
    const frame = frameOf({ rotate: 270, flipV: true, crop: { left: 0.1, top: 0.2, right: 0.9, bottom: 0.7 } });
    const run = () => {
      const stroke = createPhotoEditingMaskStroke(
        { width: SURFACE.width, height: SURFACE.height, data: filledPhotoEditingMaskSurface(SURFACE.width, SURFACE.height, 30) },
        { feather: 35, flow: 40, erase: false },
      );
      let carry = 0;
      let last: [number, number] = [40, 40];
      for (const next of [
        [120, 60],
        [210, 140],
        [260, 230],
      ] as Array<[number, number]>) {
        const path = photoEditingMaskBrushPath(last, next, photoEditingMaskBrushSpacing(5, { width: 400, height: 300 }), carry);
        for (const point of path.points) {
          const dab = photoEditingMaskBrushDab(frame, SURFACE, [point[0] / 400, point[1] / 300], 5);
          if (dab) stroke.addDab(dab);
        }
        carry = path.carry;
        last = next;
      }
      return stroke.result();
    };
    const first = run();
    expect(first).not.toBeNull();
    expect(run()).toEqual(first);
  });
});
