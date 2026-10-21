import { describe, expect, it } from "vitest";

import { readPresetResult, UNREADABLE_PRESET_MASKS_ITEM } from "./develop-engine-results";
import {
  IDENTITY_DEVELOP_GEOMETRY,
  cropBoxFromGeometry,
  developFrameSize,
  geometryOutputToSource,
  type DevelopGeometry,
  type DevelopSize,
} from "./develop-geometry";
import { canonicalDevelopMask, type DevelopLinearMask, type DevelopMask, type DevelopRadialMask } from "./develop-masks";
import { presetMasksForPhoto, presetMasksOnWorkingImage } from "./develop-preset-masks";
import { neutralDevelopSettings, presetDevelopSettings, type DevelopSettings } from "./develop-settings";

/** 横長の作業画像（向き反映済み）。 */
const SOURCE: DevelopSize = { width: 3000, height: 2000 };

function geometry(overrides: Partial<DevelopGeometry> = {}): DevelopGeometry {
  return { ...IDENTITY_DEVELOP_GEOMETRY, crop: { ...IDENTITY_DEVELOP_GEOMETRY.crop }, ...overrides };
}

const LINEAR: DevelopLinearMask = {
  id: "xmp-1",
  kind: "linear",
  enabled: true,
  invert: false,
  zero: { x: 0.3, y: 0.8 },
  full: { x: 0.35, y: 0.45 },
  adjust: { exposure: -0.3, highlights: -40 },
};

const RADIAL: DevelopRadialMask = {
  id: "xmp-2",
  kind: "radial",
  enabled: false,
  invert: true,
  center: { x: 0.45, y: 0.5 },
  radius: { x: 0.3, y: 0.15 },
  angle: 0,
  feather: 60,
  adjust: { shadows: 20 },
};

function mapped(point: { x: number; y: number }, g: DevelopGeometry): { x: number; y: number } {
  const source = geometryOutputToSource(g, SOURCE, point.x, point.y);
  if (!source) throw new Error("the geometry maps the point");
  return { x: source[0], y: source[1] };
}

/** 作業画像の上での円形の面の半径 `r`（docs の式。1 が縁）。 */
function radialR(mask: DevelopRadialMask, point: { x: number; y: number }): number {
  const aspect = SOURCE.width / SOURCE.height;
  const theta = (mask.angle * Math.PI) / 180;
  const dx = (point.x - mask.center.x) * aspect;
  const dy = point.y - mask.center.y;
  const px = dx * Math.cos(theta) + dy * Math.sin(theta);
  const py = -dx * Math.sin(theta) + dy * Math.cos(theta);
  return Math.hypot(px / (mask.radius.x * aspect), py / mask.radius.y);
}

/** 見えている枠の上の楕円の縁の点（高さをそろえた出力の座標で回す）。 */
function outputEdge(mask: DevelopRadialMask, g: DevelopGeometry, t: number): { x: number; y: number } {
  const box = cropBoxFromGeometry(g, developFrameSize(SOURCE, g.rotate));
  if (!box) throw new Error("valid crop");
  const aspect = box.width / box.height;
  const theta = (mask.angle * Math.PI) / 180;
  const a = mask.radius.x * aspect;
  const b = mask.radius.y;
  const x = mask.center.x * aspect + a * Math.cos(t) * Math.cos(theta) - b * Math.sin(t) * Math.sin(theta);
  const y = mask.center.y + a * Math.cos(t) * Math.sin(theta) + b * Math.sin(t) * Math.cos(theta);
  return { x: x / aspect, y };
}

function place(masks: readonly DevelopMask[], g: DevelopGeometry) {
  return presetMasksOnWorkingImage(masks, g, SOURCE);
}

/** 写したマスクが、見えている枠の上の元の形と同じ画像の場所を指すか（線形の 2 点・円形の中心と縁）。 */
function expectSamePlace(g: DevelopGeometry) {
  const { masks, dropped } = place([LINEAR, RADIAL], g);
  expect(dropped).toBe(0);
  const [linear, radial] = masks as [DevelopLinearMask, DevelopRadialMask];
  for (const key of ["zero", "full"] as const) {
    const want = mapped(LINEAR[key], g);
    expect(linear[key].x).toBeCloseTo(want.x, 5);
    expect(linear[key].y).toBeCloseTo(want.y, 5);
  }
  const center = mapped(RADIAL.center, g);
  expect(radial.center.x).toBeCloseTo(center.x, 5);
  expect(radial.center.y).toBeCloseTo(center.y, 5);
  expect(Math.abs(radial.angle)).toBeLessThanOrEqual(45);
  for (const t of [0, 0.7, 1.6, 2.5, 3.3, 4.4, 5.6]) {
    expect(radialR(radial, mapped(outputEdge(RADIAL, g, t), g))).toBeCloseTo(1, 4);
  }
  // 形以外（id・有効・反転・ぼかし・補正）はそのまま
  expect(linear.adjust).toEqual(LINEAR.adjust);
  expect(radial).toMatchObject({ id: "xmp-2", enabled: false, invert: true, feather: 60, adjust: { shadows: 20 } });
  return { linear, radial };
}

describe("presetMasksOnWorkingImage", () => {
  it("幾何が恒等なら、見えている枠と作業画像は同じ", () => {
    const { masks } = place([LINEAR, RADIAL], geometry());
    expect(masks).toEqual([LINEAR, RADIAL]);
  });

  it("90° 回した写真では幅と高さの半軸が入れ替わり、角度は 0 のまま", () => {
    const g = geometry({ rotate: 90 });
    const { radial } = expectSamePlace(g);
    // 見えている枠は 2000×3000。横の半軸 0.3×2000 = 600px は作業画像の縦（600 / 2000）、縦の 0.15×3000 = 450px は横（450 / 3000）
    expect(radial.center).toEqual({ x: 0.5, y: 0.55 });
    expect(radial.radius.x).toBeCloseTo(0.15, 6);
    expect(radial.radius.y).toBeCloseTo(0.3, 6);
    expect(radial.angle).toBe(0);
  });

  it.each([
    ["180°", { rotate: 180 as const }],
    ["270°", { rotate: 270 as const }],
    ["左右の反転", { flipH: true }],
    ["上下の反転", { flipV: true }],
    ["90° と左右の反転", { rotate: 90 as const, flipH: true }],
    ["切り抜き", { crop: { left: 0.2, top: 0.1, right: 0.7, bottom: 0.6 } }],
    ["270° と切り抜き", { rotate: 270 as const, crop: { left: 0.1, top: 0.3, right: 0.9, bottom: 0.8 } }],
    ["角度補正", { angle: 10 }],
    ["角度補正と 90° と上下の反転と切り抜き", { angle: -7.5, rotate: 90 as const, flipV: true, crop: { left: 0.15, top: 0.1, right: 0.85, bottom: 0.9 } }],
  ])("%s: 画像の同じ場所に置く（線形の 2 点・円形の中心と縁）", (_name, overrides) => {
    expectSamePlace(geometry(overrides));
  });

  it("切り抜きは見えている枠の分だけ縮めて置く", () => {
    const g = geometry({ crop: { left: 0.2, top: 0.1, right: 0.7, bottom: 0.6 } });
    const { masks } = place([LINEAR, RADIAL], g);
    const [linear, radial] = masks as [DevelopLinearMask, DevelopRadialMask];
    expect(linear.zero.x).toBeCloseTo(0.2 + 0.3 * 0.5, 6);
    expect(linear.zero.y).toBeCloseTo(0.1 + 0.8 * 0.5, 6);
    expect(radial.center.x).toBeCloseTo(0.425, 6);
    expect(radial.center.y).toBeCloseTo(0.35, 6);
    expect(radial.radius.x).toBeCloseTo(0.15, 6);
    expect(radial.radius.y).toBeCloseTo(0.075, 6);
  });

  it("角度補正の分だけ円形に角度が付く（回転なし）", () => {
    const { radial } = expectSamePlace(geometry({ angle: 10 }));
    expect(radial.angle).toBeCloseTo(10, 4);
  });

  it("範囲を外れる（小さな切り抜きで縮んだ）マスクと面のマスクは置かず、数える", () => {
    const tiny = geometry({ crop: { left: 0.5, top: 0.5, right: 0.51, bottom: 0.51 } });
    const short: DevelopLinearMask = { ...LINEAR, zero: { x: 0.5, y: 0.5 }, full: { x: 0.5, y: 0.52 } };
    const surface: DevelopMask = {
      id: "s",
      kind: "brush",
      enabled: true,
      invert: false,
      surface: { id: "a".repeat(64), width: 8, height: 8 },
      adjust: { exposure: 1 },
    };
    expect(place([short, RADIAL, surface], tiny)).toEqual({ masks: [], dropped: 3 });
    // 描けない切り抜き（左右が逆）は 1 枚も置かない
    expect(place([LINEAR], geometry({ crop: { left: 0.8, top: 0, right: 0.2, bottom: 1 } }))).toEqual({ masks: [], dropped: 1 });
  });
});

describe("presetMasksForPhoto", () => {
  it("マスクが無い・作業画像の大きさが分からない・幾何が壊れているときは置かない（null）", () => {
    expect(presetMasksForPhoto(undefined, undefined, undefined)).toBeNull();
    expect(presetMasksForPhoto(undefined, { masks: [], source: SOURCE }, undefined)).toBeNull();
    expect(presetMasksForPhoto(undefined, { masks: [LINEAR], source: null }, undefined)).toBeNull();
    expect(presetMasksForPhoto({ rotate: 45 }, { masks: [LINEAR], source: SOURCE }, undefined)).toBeNull();
    expect(presetMasksForPhoto(undefined, { masks: [LINEAR], source: SOURCE }, undefined)).toEqual([canonicalDevelopMask(LINEAR)]);
  });
});

describe("presetDevelopSettings のプリセットのマスク", () => {
  const PHOTO_MASK = canonicalDevelopMask({ ...LINEAR, id: "photo-1", adjust: { exposure: 0.5 } });
  const base: DevelopSettings = { ...neutralDevelopSettings(null), v: 5, masks: [PHOTO_MASK] };
  const result: DevelopSettings = { ...neutralDevelopSettings(null), exposure: 0.2 };

  it("マスクを持つプリセットは、写真の幾何で写したマスクで写真のマスクを置き換える", () => {
    const next = presetDevelopSettings(base, result, { masks: [LINEAR, RADIAL], source: SOURCE });
    expect(next.masks).toEqual([canonicalDevelopMask(LINEAR), canonicalDevelopMask(RADIAL)]);
    expect(next.v).toBe(5);
    expect(next.exposure).toBe(0.2);
    const turned = presetDevelopSettings({ ...base, v: 5, geometry: { rotate: 90 } }, result, { masks: [RADIAL], source: SOURCE });
    expect(turned.geometry).toEqual({ rotate: 90 });
    expect(turned.masks).toEqual([
      expect.objectContaining({ id: "xmp-2", center: { x: 0.5, y: 0.55 }, radius: { x: 0.15, y: 0.3 }, angle: 0 }),
    ]);
  });

  it("大きさが分からない・マスクの無いプリセット・置けないマスクなら、写真のマスクのまま", () => {
    expect(presetDevelopSettings(base, result, { masks: [LINEAR], source: null }).masks).toEqual([PHOTO_MASK]);
    expect(presetDevelopSettings(base, result, { source: SOURCE }).masks).toEqual([PHOTO_MASK]);
    expect(presetDevelopSettings(base, result).masks).toEqual([PHOTO_MASK]);
    // 絶対のホワイトバランスの結果には、相対の色温度の差分のあるマスクは置けない（crate の localWhiteBalance）
    const absolute: DevelopSettings = { ...result, whiteBalance: { mode: "absolute", temperature: 5600, tint: 4 } };
    const warm: DevelopLinearMask = { ...LINEAR, adjust: { relativeTemperature: 20 } };
    expect(presetDevelopSettings(base, absolute, { masks: [warm], source: SOURCE }).masks).toEqual([PHOTO_MASK]);
    const none = presetDevelopSettings(neutralDevelopSettings(null), absolute, { masks: [warm], source: SOURCE });
    expect(none).not.toHaveProperty("masks");
  });
});

describe("readPresetResult のマスク", () => {
  const settings = { v: 1, engine: "niho-1" };
  const json = (extra: Record<string, unknown>) =>
    JSON.stringify({ name: "p", settings, converted: true, unsupported: ["Sharpness"], ...extra });

  it("masks を M1 の読み方で読み、無い・空ならキーを持たない", () => {
    const read = readPresetResult(json({ masks: [canonicalDevelopMask(LINEAR), canonicalDevelopMask(RADIAL)] }));
    expect(read?.masks).toEqual([LINEAR, RADIAL]);
    expect(readPresetResult(json({}))).not.toHaveProperty("masks");
    expect(readPresetResult(json({ masks: [] }))).not.toHaveProperty("masks");
  });

  it("1 枚でも読めなければプリセットのマスクを使わず、unsupported に読めないマスクを足す", () => {
    const broken = readPresetResult(json({ masks: [canonicalDevelopMask(LINEAR), { id: "bad id", kind: "linear" }] }));
    expect(broken).not.toHaveProperty("masks");
    expect(broken?.unsupported).toEqual(["Sharpness", UNREADABLE_PRESET_MASKS_ITEM]);
    const absolute = readPresetResult(
      JSON.stringify({
        settings: { ...settings, whiteBalance: { mode: "absolute", temperature: 5600, tint: 4 } },
        converted: true,
        masks: [canonicalDevelopMask({ ...LINEAR, adjust: { relativeTint: 5 } })],
      }),
    );
    expect(absolute).not.toHaveProperty("masks");
    expect(absolute?.unsupported).toEqual([UNREADABLE_PRESET_MASKS_ITEM]);
  });
});
