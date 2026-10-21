import { describe, expect, it } from "vitest";

import {
  cropBoxCorners,
  developFrameSize,
  maxCropBox,
  readDevelopGeometry,
  type CropBox,
  type DevelopGeometry,
  type DevelopSize,
} from "./develop-engine/develop-geometry";
import { neutralDevelopSettings, type DevelopSettings } from "./develop-engine/develop-settings";
import {
  canSwapCropAspect,
  cropArrowDirection,
  cropAspectLabel,
  cropAspectOf,
  cropExportLimitLongEdge,
  cropFrameDevelopSettings,
  cropKeyboardStep,
  cropOutputSize,
  cropOverlayLayout,
  cropScreenToFrameDelta,
  editingCropBox,
  fitDevelopSize,
  formatCropAngle,
  geometryWithCropBox,
  isCropAspectSelected,
  readDevelopSize,
} from "./photo-editing-crop";

/** 切り抜きの道具の画面の計算（F3b 移行元設計）。 */

const FRAME: DevelopSize = { width: 3000, height: 2000 };
const VIEWPORT: DevelopSize = { width: 848, height: 648 };

function geometry(partial: Partial<DevelopGeometry> = {}): DevelopGeometry {
  return { rotate: 0, flipH: false, flipV: false, angle: 0, crop: { left: 0, top: 0, right: 1, bottom: 1 }, ...partial };
}

describe("縦横比のチップ", () => {
  it("無いのは「元の比率」、入れ替えた比率は元のチップを選ばれた表示にする", () => {
    expect(cropAspectOf(geometry())).toBe("original");
    expect(cropAspectOf(geometry({ aspect: "5:4" }))).toBe("5:4");
    expect(isCropAspectSelected("original", "original")).toBe(true);
    expect(isCropAspectSelected("originalSwapped", "original")).toBe(true);
    expect(isCropAspectSelected("5:4", "4:5")).toBe(true);
    expect(isCropAspectSelected("4:5", "4:5")).toBe(true);
    expect(isCropAspectSelected("4:5", "3:4")).toBe(false);
    expect(isCropAspectSelected("free", "original")).toBe(false);
  });

  it("メニューのボタンの名前は今の向きの比率（入れ替えた元の比率は「元の比率」）", () => {
    expect(cropAspectLabel("original")).toBe("元の比率");
    expect(cropAspectLabel("originalSwapped")).toBe("元の比率");
    expect(cropAspectLabel("free")).toBe("自由");
    expect(cropAspectLabel("4:5")).toBe("4:5");
    expect(cropAspectLabel("5:4")).toBe("5:4");
  });

  it("「自由」と「1:1」は縦横を入れ替えられない", () => {
    expect(canSwapCropAspect("free")).toBe(false);
    expect(canSwapCropAspect("1:1")).toBe(false);
    expect(canSwapCropAspect("original")).toBe(true);
    expect(canSwapCropAspect("originalSwapped")).toBe(true);
    expect(canSwapCropAspect("9:16")).toBe(true);
  });
});

describe("表示", () => {
  it("角度は符号つき・小数 1 桁まで（0 は「0°」）", () => {
    expect(formatCropAngle(1.5)).toBe("+1.5°");
    expect(formatCropAngle(0)).toBe("0°");
    expect(formatCropAngle(-0.04)).toBe("0°");
    expect(formatCropAngle(-12.34)).toBe("-12.3°");
    expect(formatCropAngle(45)).toBe("+45°");
  });

  it("寸法として読めない値は null", () => {
    expect(readDevelopSize({ width: 6000, height: 4000 })).toEqual({ width: 6000, height: 4000 });
    expect(readDevelopSize(undefined)).toBeNull();
    expect(readDevelopSize({ width: 0, height: 10 })).toBeNull();
    expect(readDevelopSize({ width: "10", height: 10 })).toBeNull();
    expect(readDevelopSize({ width: Number.NaN, height: 10 })).toBeNull();
  });

  it("書き出しの入力は長辺 4096px に収める", () => {
    expect(fitDevelopSize({ width: 6000, height: 4000 }, 4096)).toEqual({ width: 4096, height: 2731 });
    expect(fitDevelopSize({ width: 3000, height: 2000 }, 4096)).toEqual({ width: 3000, height: 2000 });
  });

  it("書き出しの 1 行は、切り抜きで長辺が届かなくなるときだけ", () => {
    const input: DevelopSize = { width: 4096, height: 2731 };
    expect(cropExportLimitLongEdge({ width: 2048, height: 1365 }, input)).toBeNull();
    expect(cropExportLimitLongEdge({ width: 1536, height: 1024 }, input)).toBe(1536);
    // 小さい写真は、切り抜かなければ出さない
    const small: DevelopSize = { width: 1600, height: 1200 };
    expect(cropExportLimitLongEdge({ width: 1600, height: 1200 }, small)).toBeNull();
    expect(cropExportLimitLongEdge({ width: 800, height: 600 }, small)).toBe(800);
  });

  it("切り抜いた結果の画素は箱の幅と高さを丸める", () => {
    expect(cropOutputSize({ cx: 0, cy: 0, width: 1200.4, height: 959.6 })).toEqual({ width: 1200, height: 960 });
  });
});

describe("切り抜きの間に描く編集内容", () => {
  it("切り抜きと角度を外し、回転と反転・色の補正は保つ", () => {
    const settings: DevelopSettings = {
      ...neutralDevelopSettings(),
      v: 2,
      exposure: 0.5,
      geometry: {
        rotate: 90,
        flipH: true,
        flipV: false,
        angle: 3,
        crop: { left: 0.2, top: 0.2, right: 0.8, bottom: 0.8 },
        aspect: "1:1",
      },
    };
    const frame = cropFrameDevelopSettings(settings);
    expect(frame).toEqual({
      ...neutralDevelopSettings(),
      v: 2,
      exposure: 0.5,
      geometry: { rotate: 90, flipH: true, flipV: false, angle: 0, crop: { left: 0, top: 0, right: 1, bottom: 1 } },
    });
  });

  it("回転も反転も無ければ幾何を消して v: 1", () => {
    const settings: DevelopSettings = {
      ...neutralDevelopSettings(),
      v: 2,
      contrast: 10,
      geometry: { rotate: 0, flipH: false, flipV: false, angle: 5, crop: { left: 0.1, top: 0.1, right: 0.9, bottom: 0.9 } },
    };
    expect(cropFrameDevelopSettings(settings)).toEqual({ ...neutralDevelopSettings(), contrast: 10 });
    // 幾何の無い編集内容はそのまま
    const plain: DevelopSettings = { ...neutralDevelopSettings(), exposure: 1 };
    expect(cropFrameDevelopSettings(plain)).toEqual(plain);
  });
});

describe("画面に見せる切り抜きの箱", () => {
  it("保存値の箱をそのまま返し、書き戻すと同じ切り抜きになる", () => {
    const saved = geometry({ crop: { left: 0.25, top: 0.25, right: 0.75, bottom: 0.75 } });
    const box = editingCropBox(saved, FRAME);
    expect(box).toEqual({ cx: 1500, cy: 1000, width: 1500, height: 1000 });
    expect(geometryWithCropBox(saved, box, FRAME).crop).toEqual(saved.crop);
  });

  it("長方形にならない値は、その縦横比で内接する最大の箱", () => {
    const broken = geometry({ crop: { left: 0.8, top: 0.2, right: 0.2, bottom: 0.8 }, aspect: "1:1" });
    expect(editingCropBox(broken, FRAME)).toEqual(maxCropBox(FRAME, 0, 1));
  });

  it("角が枠から出る保存値は枠に収める", () => {
    const outside = geometry({ angle: 20 });
    const box = editingCropBox(outside, FRAME);
    for (const [x, y] of cropBoxCorners(box, 20)) {
      expect(x).toBeGreaterThanOrEqual(-1e-6);
      expect(x).toBeLessThanOrEqual(FRAME.width + 1e-6);
      expect(y).toBeGreaterThanOrEqual(-1e-6);
      expect(y).toBeLessThanOrEqual(FRAME.height + 1e-6);
    }
  });
});

describe("キーボード", () => {
  it("1 回で枠の短辺の 1%、⇧ で 5%", () => {
    expect(cropKeyboardStep(FRAME, false)).toBe(20);
    expect(cropKeyboardStep(FRAME, true)).toBe(100);
    expect(cropKeyboardStep(developFrameSize(FRAME, 90), false)).toBe(20);
  });

  it("矢印キーだけを向きにする", () => {
    expect(cropArrowDirection("ArrowLeft")).toEqual([-1, 0]);
    expect(cropArrowDirection("ArrowDown")).toEqual([0, 1]);
    expect(cropArrowDirection("Enter")).toBeNull();
  });
});

describe("枠の部品の置き方", () => {
  const whole: CropBox = { cx: 1500, cy: 1000, width: 3000, height: 2000 };

  it("角度 0 は写真を回さず、余白 24px の内側に収めて中央に置く", () => {
    const layout = cropOverlayLayout({ frame: FRAME, box: whole, angle: 0, viewport: VIEWPORT });
    // 幅 800 / 3000 と 高さ 600 / 2000 の小さい方
    expect(layout?.scale).toBeCloseTo(800 / 3000, 9);
    expect(layout?.rotate).toBe(0);
    expect(layout?.photo.left).toBeCloseTo(24, 6);
    expect(layout?.photo.width).toBeCloseTo(800, 6);
    expect(layout?.photo.height).toBeCloseTo(800 / 1.5, 6);
    expect(layout?.photo.top).toBeCloseTo((648 - 800 / 1.5) / 2, 6);
    expect(layout?.box).toEqual(layout?.photo);
  });

  it("角度 a は写真を −a 度回し、回した写真の外接の長方形を収める", () => {
    const angle = 10;
    const box = maxCropBox(FRAME, angle, null);
    const layout = cropOverlayLayout({ frame: FRAME, box, angle, viewport: VIEWPORT });
    const theta = (angle * Math.PI) / 180;
    const boundsWidth = 3000 * Math.cos(theta) + 2000 * Math.sin(theta);
    const boundsHeight = 3000 * Math.sin(theta) + 2000 * Math.cos(theta);
    expect(layout?.rotate).toBe(-10);
    expect(layout?.scale).toBeCloseTo(Math.min(800 / boundsWidth, 600 / boundsHeight), 9);
    // 枠の中心にある箱は、画面の中央にまっすぐ立つ
    const scale = layout?.scale ?? 0;
    expect((layout?.box.left ?? 0) + (layout?.box.width ?? 0) / 2).toBeCloseTo(424, 6);
    expect((layout?.box.top ?? 0) + (layout?.box.height ?? 0) / 2).toBeCloseTo(324, 6);
    expect(layout?.box.width).toBeCloseTo(box.width * scale, 6);
    expect(layout?.box.height).toBeCloseTo(box.height * scale, 6);
  });

  it("中心から外れた箱は、写真と一緒に回した位置に置く（枠を動かしても倍率と写真は変わらない）", () => {
    const angle = 90;
    const centered = cropOverlayLayout({ frame: FRAME, box: { cx: 1500, cy: 1000, width: 200, height: 100 }, angle, viewport: VIEWPORT });
    const moved = cropOverlayLayout({ frame: FRAME, box: { cx: 1800, cy: 1000, width: 200, height: 100 }, angle, viewport: VIEWPORT });
    expect(moved?.scale).toBe(centered?.scale);
    expect(moved?.photo).toEqual(centered?.photo);
    const scale = moved?.scale ?? 0;
    // 枠の右へ 300 は、−90 度回した画面では上へ 300
    expect((moved?.box.left ?? 0) - (centered?.box.left ?? 0)).toBeCloseTo(0, 6);
    expect((moved?.box.top ?? 0) - (centered?.box.top ?? 0)).toBeCloseTo(-300 * scale, 6);
  });

  it("写真の長辺の上限があれば引き伸ばさない。表示の領域が余白より小さければ null", () => {
    const small: DevelopSize = { width: 300, height: 200 };
    const layout = cropOverlayLayout({
      frame: small,
      box: { cx: 150, cy: 100, width: 300, height: 200 },
      angle: 0,
      viewport: VIEWPORT,
      maxLongEdge: 600,
    });
    expect(layout?.scale).toBe(2);
    expect(cropOverlayLayout({ frame: FRAME, box: whole, angle: 0, viewport: { width: 40, height: 400 } })).toBeNull();
    expect(cropOverlayLayout({ frame: FRAME, box: whole, angle: 0, viewport: { width: 0, height: 0 } })).toBeNull();
  });

  it("画面の軸の動きを枠の軸に直す", () => {
    expect(cropScreenToFrameDelta(10, 0, 0)).toEqual([10, 0]);
    const [dx, dy] = cropScreenToFrameDelta(10, 0, 90);
    expect(dx).toBeCloseTo(0, 9);
    expect(dy).toBeCloseTo(10, 9);
    const [ux, uy] = cropScreenToFrameDelta(0, 10, 90);
    expect(ux).toBeCloseTo(-10, 9);
    expect(uy).toBeCloseTo(0, 9);
  });
});

describe("保存の形", () => {
  it("cropFrameDevelopSettings の結果は幾何として読める", () => {
    const settings: DevelopSettings = {
      ...neutralDevelopSettings(),
      v: 2,
      geometry: { rotate: 270, flipH: false, flipV: true, angle: -2, crop: { left: 0.1, top: 0, right: 1, bottom: 0.9 } },
    };
    expect(readDevelopGeometry(cropFrameDevelopSettings(settings))).toEqual(
      geometry({ rotate: 270, flipV: true }),
    );
  });

  it("遠近（niho-photo#46）は補正後の枠全体を描くので残し、「余白を埋める」は外す（形の版は 7 のまま）", () => {
    const perspective = { vertical: -30, horizontal: 0, rotate: 1, aspect: 0, scale: 100, x: 0, y: 0 };
    const settings: DevelopSettings = {
      ...neutralDevelopSettings(),
      v: 7,
      geometry: { angle: 3, crop: { left: 0.1, top: 0, right: 0.9, bottom: 1 }, perspective, constrain: true },
    };
    const frame = cropFrameDevelopSettings(settings);
    expect(frame.v).toBe(7);
    expect(readDevelopGeometry(frame)).toEqual({ ...geometry({}), perspective });
  });

  it("editingCropBox は「余白を埋める」が on で遠近があれば、補正した写真の中に収めた箱を見せる", () => {
    const frame = { width: 3000, height: 2000 };
    const tilted = { ...geometry({}), perspective: { vertical: -40, horizontal: 0, rotate: 0, aspect: 0, scale: 100, x: 0, y: 0 } };
    expect(editingCropBox(tilted, frame)).toEqual({ cx: 1500, cy: 1000, width: 3000, height: 2000 });
    const constrained = editingCropBox({ ...tilted, constrain: true }, frame);
    expect(constrained.width).toBeLessThan(3000);
    expect(constrained.width / constrained.height).toBeCloseTo(1.5, 9);
  });
});
