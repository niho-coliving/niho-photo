import { describe, expect, it } from "vitest";

import {
  constrainedCropBox,
  cropBoxFromGeometry,
  developFrameSize,
  flipGeometryHorizontal,
  flipGeometryVertical,
  geometryOutputToSource,
  hasGeometryPerspectiveEdits,
  parseDevelopGeometry,
  readDevelopGeometry,
  resetGeometryPerspective,
  rotateGeometryClockwise,
  rotateGeometryCounterClockwise,
  writeDevelopGeometry,
  type CropBox,
  type DevelopGeometry,
  type DevelopPerspective,
  type DevelopSize,
} from "./develop-geometry";
import {
  DEVELOP_PERSPECTIVE_FOCAL_LENGTH,
  constrainCropBoxToPerspective,
  developPerspectiveWarp,
  isIdentityDevelopPerspective,
  perspectiveToCanvas,
  perspectiveToFrame,
  perspectiveValidPolygon,
  transformDevelopPerspective,
  type DevelopPerspectiveWarp,
} from "./develop-perspective";
import {
  autoDevelopSettings,
  copyDevelopSettings,
  developSettingsVersion,
  hasDevelopGeometry,
  hasDevelopPerspective,
  isEditableDevelopSettings,
  isNeutralDevelopSettings,
  neutralDevelopSettings,
  pasteDevelopSettings,
  presetDevelopSettings,
  readDevelopSettings,
  resetDevelopSettingsColors,
  type DevelopSettings,
} from "./develop-settings";

/**
 * 遠近（niho-photo#46）の画面側の計算。crate の `perspective.rs` と同じモデル（回転 → 台形 → 縦横比 → 拡大 → 平行移動）で、向きの
 * 規約・往復・「余白を埋める」・90° 回転と反転での写し方・幾何の読み書きを確かめる。
 */

const IDENTITY: DevelopGeometry = {
  rotate: 0,
  flipH: false,
  flipV: false,
  angle: 0,
  crop: { left: 0, top: 0, right: 1, bottom: 1 },
};

function perspective(values: Partial<DevelopPerspective>): DevelopPerspective {
  return { vertical: 0, horizontal: 0, rotate: 0, aspect: 0, scale: 100, x: 0, y: 0, ...values };
}

function warp(values: Partial<DevelopPerspective>, frame: DevelopSize): DevelopPerspectiveWarp {
  const result = developPerspectiveWarp(perspective(values), frame);
  if (!result) throw new Error("identity");
  return result;
}

function canvas(w: DevelopPerspectiveWarp, p: [number, number]): [number, number] {
  const q = perspectiveToCanvas(w, p);
  if (!q) throw new Error("past the vanishing line");
  return q;
}

function expectClose(actual: [number, number] | null, expected: [number, number], digits = 6) {
  expect(actual).not.toBeNull();
  expect(actual![0]).toBeCloseTo(expected[0], digits);
  expect(actual![1]).toBeCloseTo(expected[1], digits);
}

describe("developPerspectiveWarp", () => {
  it("恒等（と無い）なら null", () => {
    expect(developPerspectiveWarp(undefined, { width: 3000, height: 2000 })).toBeNull();
    expect(developPerspectiveWarp(perspective({}), { width: 3000, height: 2000 })).toBeNull();
    expect(isIdentityDevelopPerspective(perspective({ scale: 100 }))).toBe(true);
    expect(isIdentityDevelopPerspective(perspective({ x: 0.1 }))).toBe(false);
  });

  it("逆の写し方で元に戻る", () => {
    const frame = { width: 3000, height: 2000 };
    const w = warp({ vertical: 100, horizontal: -100, rotate: 10, aspect: -100, scale: 50, x: 100, y: -100 }, frame);
    for (const p of [
      [0, 0],
      [3000, 0],
      [900, 1600],
      [3000, 2000],
    ] as [number, number][]) {
      expectClose(perspectiveToFrame(w, canvas(w, p)), p, 6);
    }
  });

  it("垂直方向の負は上が広がり下が狭まる（中心は動かない。crate と同じ式）", () => {
    const frame = { width: 2000, height: 3000 };
    const w = warp({ vertical: -50 }, frame);
    expectClose(perspectiveToCanvas(w, [1000, 1500]), [1000, 1500]);
    const tl = canvas(w, [0, 0]);
    const tr = canvas(w, [2000, 0]);
    const bl = canvas(w, [0, 3000]);
    const br = canvas(w, [2000, 3000]);
    expect(tr[0] - tl[0]).toBeGreaterThan(2000);
    expect(br[0] - bl[0]).toBeLessThan(2000);
    const p = (0.5 * Math.tan((40 * Math.PI) / 180)) / DEVELOP_PERSPECTIVE_FOCAL_LENGTH;
    expect((tr[0] - tl[0]) / 2).toBeCloseTo((1000 / 3000 / (1 - 0.5 * p)) * 3000, 6);
  });

  it("水平方向の正は右が広がる。回転の正は写真が反時計回り（角度補正と同じ向き）", () => {
    const h = warp({ horizontal: 40 }, { width: 3000, height: 2000 });
    expect(canvas(h, [3000, 2000])[1] - canvas(h, [3000, 0])[1]).toBeGreaterThan(2000);
    expect(canvas(h, [0, 2000])[1] - canvas(h, [0, 0])[1]).toBeLessThan(2000);
    const r = warp({ rotate: 5 }, { width: 1000, height: 1000 });
    const a = (5 * Math.PI) / 180;
    expectClose(perspectiveToCanvas(r, [900, 500]), [500 + 400 * Math.cos(a), 500 - 400 * Math.sin(a)]);
  });

  it("縦横比・拡大・オフセットの向きと大きさ", () => {
    const frame = { width: 3000, height: 2000 };
    expectClose(perspectiveToCanvas(warp({ aspect: 100 }, frame), [2500, 1500]), [1500 + 1000 * 1.25, 1000 + 500 / 1.25]);
    expectClose(perspectiveToCanvas(warp({ scale: 50 }, frame), [2500, 1500]), [2000, 1250]);
    expectClose(perspectiveToCanvas(warp({ x: 100 }, frame), [0, 0]), [1500, 0]);
    expectClose(perspectiveToCanvas(warp({ y: -100 }, frame), [0, 2000]), [0, 1000]);
  });
});

describe("constrainCropBoxToPerspective（余白を埋める）", () => {
  function inside(box: CropBox, angle: number, w: DevelopPerspectiveWarp) {
    const theta = (angle * Math.PI) / 180;
    const u = [Math.cos(theta), Math.sin(theta)];
    const v = [-u[1], u[0]];
    const { width, height } = w.frame;
    for (const [a, b] of [
      [-1, -1],
      [1, -1],
      [1, 1],
      [-1, 1],
    ]) {
      const q: [number, number] = [
        box.cx + (a * box.width * u[0] + b * box.height * v[0]) / 2,
        box.cy + (a * box.width * u[1] + b * box.height * v[1]) / 2,
      ];
      const tolerance = 1e-6 * Math.max(width, height);
      expect(q[0]).toBeGreaterThanOrEqual(-tolerance);
      expect(q[0]).toBeLessThanOrEqual(width + tolerance);
      const p = perspectiveToFrame(w, q)!;
      expect(p[0]).toBeGreaterThanOrEqual(-tolerance);
      expect(p[0]).toBeLessThanOrEqual(width + tolerance);
      expect(p[1]).toBeGreaterThanOrEqual(-tolerance);
      expect(p[1]).toBeLessThanOrEqual(height + tolerance);
    }
  }

  it("補正した写真の中に、角度と縦横比を保って収める（大きくはしない）", () => {
    const frame = { width: 3000, height: 2000 };
    for (const values of [{ vertical: -40 }, { vertical: 100, horizontal: -60, rotate: -7 }, { aspect: -100, rotate: 10 }]) {
      const w = warp(values, frame);
      const box = { cx: 1500, cy: 1000, width: 3000, height: 2000 };
      const fitted = constrainCropBoxToPerspective(box, 0, w);
      inside(fitted, 0, w);
      expect(fitted.width).toBeLessThan(box.width);
      expect(fitted.width / fitted.height).toBeCloseTo(1.5, 9);
    }
  });

  it("写真がずれたら、中央で縮めずに動かして大きく残す（crate と同じ結果）", () => {
    const fitted = constrainCropBoxToPerspective({ cx: 2000, cy: 1000, width: 4000, height: 2000 }, 0, warp({ x: 50 }, { width: 4000, height: 2000 }));
    expect(fitted.width).toBeCloseTo(3000, 3);
    expect(fitted.cx).toBeCloseTo(2500, 3);
    expect(fitted.cy).toBeCloseTo(1000, 6);
  });

  it("すでに収まっている箱はそのまま（同じもの）", () => {
    const box = { cx: 1500, cy: 1000, width: 600, height: 400 };
    expect(constrainCropBoxToPerspective(box, 0, warp({ vertical: -20 }, { width: 3000, height: 2000 }))).toBe(box);
  });

  it("写真が占める凸多角形を返す（枠との共通部分）", () => {
    const polygon = perspectiveValidPolygon(warp({ scale: 50 }, { width: 3000, height: 2000 }))!;
    const xs = polygon.map((p) => p[0]);
    const ys = polygon.map((p) => p[1]);
    expect(Math.min(...xs)).toBeCloseTo(750, 6);
    expect(Math.max(...xs)).toBeCloseTo(2250, 6);
    expect(Math.min(...ys)).toBeCloseTo(500, 6);
    expect(Math.max(...ys)).toBeCloseTo(1500, 6);
  });

  it("constrainedCropBox は「余白を埋める」が on で遠近があるときだけ収める", () => {
    const frame = { width: 3000, height: 2000 };
    const box = { cx: 1500, cy: 1000, width: 3000, height: 2000 };
    const tilted = { ...IDENTITY, perspective: perspective({ vertical: -40 }) };
    expect(constrainedCropBox(tilted, box, frame)).toBe(box);
    expect(constrainedCropBox({ ...IDENTITY, constrain: true }, box, frame)).toBe(box);
    expect(constrainedCropBox({ ...tilted, constrain: true }, box, frame).width).toBeLessThan(3000);
  });
});

describe("transformDevelopPerspective（90° 回転・反転で結果といっしょに写す）", () => {
  const sample = perspective({ vertical: -30, horizontal: 12, rotate: 2.5, aspect: 20, scale: 110, x: 15, y: -7.5 });

  it("4 回で元に戻り、時計回りと反時計回りは打ち消す。反転は 2 回で元に戻る", () => {
    let turned = sample;
    for (let i = 0; i < 4; i += 1) turned = transformDevelopPerspective(turned, "clockwise");
    expect(turned).toEqual(sample);
    expect(transformDevelopPerspective(transformDevelopPerspective(sample, "clockwise"), "counterClockwise")).toEqual(sample);
    expect(transformDevelopPerspective(transformDevelopPerspective(sample, "flipHorizontal"), "flipHorizontal")).toEqual(sample);
    expect(transformDevelopPerspective(transformDevelopPerspective(sample, "flipVertical"), "flipVertical")).toEqual(sample);
  });

  it("回した枠で写すと、写した点が回る（F' = M F M⁻¹）", () => {
    const frame = { width: 3000, height: 2000 };
    const turnedFrame = { width: 2000, height: 3000 };
    const w = warp(sample, frame);
    const cw = developPerspectiveWarp(transformDevelopPerspective(sample, "clockwise"), turnedFrame)!;
    const ccw = developPerspectiveWarp(transformDevelopPerspective(sample, "counterClockwise"), turnedFrame)!;
    const fh = developPerspectiveWarp(transformDevelopPerspective(sample, "flipHorizontal"), frame)!;
    const fv = developPerspectiveWarp(transformDevelopPerspective(sample, "flipVertical"), frame)!;
    for (const p of [
      [400, 300],
      [2700, 1900],
      [1500, 100],
    ] as [number, number][]) {
      const q = canvas(w, p);
      // 時計回り: 枠の点 (x, y) は (H − y, x) へ
      expectClose(perspectiveToCanvas(cw, [2000 - p[1], p[0]]), [2000 - q[1], q[0]], 6);
      // 反時計回り: (y, W − x) へ
      expectClose(perspectiveToCanvas(ccw, [p[1], 3000 - p[0]]), [q[1], 3000 - q[0]], 6);
      expectClose(perspectiveToCanvas(fh, [3000 - p[0], p[1]]), [3000 - q[0], q[1]], 6);
      expectClose(perspectiveToCanvas(fv, [p[0], 2000 - p[1]]), [q[0], 2000 - q[1]], 6);
    }
  });

  it("幾何の 90° 回転・反転が遠近も写す（遠近の無い幾何は遠近を持たないまま）", () => {
    const source = { width: 3000, height: 2000 };
    const geometry = { ...IDENTITY, perspective: sample };
    expect(rotateGeometryClockwise(geometry, source).perspective).toEqual(transformDevelopPerspective(sample, "clockwise"));
    expect(rotateGeometryCounterClockwise(geometry, source).perspective).toEqual(
      transformDevelopPerspective(sample, "counterClockwise"),
    );
    expect(flipGeometryHorizontal(geometry, source).perspective).toEqual(transformDevelopPerspective(sample, "flipHorizontal"));
    expect(flipGeometryVertical(geometry, source).perspective).toEqual(transformDevelopPerspective(sample, "flipVertical"));
    expect("perspective" in rotateGeometryClockwise(IDENTITY, source)).toBe(false);
    expect("perspective" in flipGeometryHorizontal(IDENTITY, source)).toBe(false);
  });
});

describe("幾何の読み書き（遠近・余白を埋める・Upright）", () => {
  it("読む: 欠けた項目は恒等の値、知らないキー・数でない値・null は壊れた形", () => {
    expect(parseDevelopGeometry({ perspective: { vertical: -20 } })?.perspective).toEqual(perspective({ vertical: -20 }));
    expect(parseDevelopGeometry({ constrain: true, upright: 3 })).toMatchObject({ constrain: true, upright: 3 });
    expect(parseDevelopGeometry({ perspective: { tilt: 1 } })).toBeNull();
    expect(parseDevelopGeometry({ perspective: { vertical: "1" } })).toBeNull();
    expect(parseDevelopGeometry({ perspective: null })).toBeNull();
    expect(parseDevelopGeometry({ constrain: 1 })).toBeNull();
    expect(parseDevelopGeometry({ upright: "auto" })).toBeNull();
    // 遠近の無い幾何は、今までと同じ形で読む
    expect(parseDevelopGeometry({ rotate: 90 })).toEqual({ ...IDENTITY, rotate: 90 });
  });

  it("書く: 遠近は範囲に収めて恒等でなければ書き、形の版は 7。恒等なら書かない", () => {
    const base = neutralDevelopSettings();
    const written = writeDevelopGeometry(base, { ...IDENTITY, perspective: perspective({ vertical: -140, x: 12.3456789 }) });
    expect(written.v).toBe(7);
    expect(written.geometry).toEqual({
      ...IDENTITY,
      perspective: perspective({ vertical: -100, x: 12.345679 }),
    });
    const identity = writeDevelopGeometry(base, { ...IDENTITY, perspective: perspective({}) });
    expect(identity.v).toBe(1);
    expect("geometry" in identity).toBe(false);
    // 遠近と切り抜きがあれば 7（切り抜きだけなら 2）
    const cropped = writeDevelopGeometry(base, { ...IDENTITY, crop: { left: 0.1, top: 0, right: 1, bottom: 1 } });
    expect(cropped.v).toBe(2);
    expect(writeDevelopGeometry(cropped, { ...readDevelopGeometry(cropped), perspective: perspective({ scale: 90 }) }).v).toBe(7);
  });

  it("「余白を埋める」と Upright だけなら幾何のキーは残すが形の版は上げない（描く画が変わらない）", () => {
    const written = writeDevelopGeometry(neutralDevelopSettings(), { ...IDENTITY, constrain: true, upright: 2 });
    expect(written.v).toBe(1);
    expect(written.geometry).toMatchObject({ constrain: true, upright: 2 });
    // off・0・範囲外の Upright は書かない
    const off = writeDevelopGeometry(neutralDevelopSettings(), { ...IDENTITY, constrain: false, upright: 9 });
    expect("geometry" in off).toBe(false);
  });

  it("ジオメトリの「初期化」は遠近・余白を埋める・Upright だけを戻す", () => {
    const geometry: DevelopGeometry = {
      ...IDENTITY,
      angle: 4,
      aspect: "4:5",
      perspective: perspective({ vertical: -10 }),
      constrain: true,
      upright: 1,
    };
    expect(hasGeometryPerspectiveEdits(geometry)).toBe(true);
    const reset = resetGeometryPerspective(geometry);
    expect(reset).toEqual({ ...IDENTITY, angle: 4, aspect: "4:5" });
    expect(hasGeometryPerspectiveEdits(reset)).toBe(false);
  });
});

describe("geometryOutputToSource（遠近）", () => {
  it("出力の位置を、補正後の枠 → 遠近を戻す → 回転・反転を戻す で作業画像の位置にする", () => {
    const source = { width: 3000, height: 2000 };
    const geometry: DevelopGeometry = { ...IDENTITY, perspective: perspective({ vertical: -40, rotate: 3 }) };
    // 中心は動かない
    const center = geometryOutputToSource(geometry, source, 0.5, 0.5)!;
    expect(center[0]).toBeCloseTo(0.5, 9);
    expect(center[1]).toBeCloseTo(0.5, 9);
    // 角は逆の写し方のとおり
    const frame = developFrameSize(source, 0);
    const w = developPerspectiveWarp(geometry.perspective, frame)!;
    const corner = perspectiveToFrame(w, [3000, 2000])!;
    const mapped = geometryOutputToSource(geometry, source, 1, 1)!;
    expect(mapped[0]).toBeCloseTo(corner[0] / 3000, 9);
    expect(mapped[1]).toBeCloseTo(corner[1] / 2000, 9);
    // 「余白を埋める」なら角も写真の中
    const constrained = geometryOutputToSource({ ...geometry, constrain: true }, source, 1, 1)!;
    expect(constrained[0]).toBeLessThanOrEqual(1 + 1e-9);
    expect(constrained[1]).toBeLessThanOrEqual(1 + 1e-9);
    // 90° 回転の後に遠近
    const turned = geometryOutputToSource({ ...geometry, rotate: 90 }, source, 0.5, 0.5)!;
    expect(turned[0]).toBeCloseTo(0.5, 9);
    expect(turned[1]).toBeCloseTo(0.5, 9);
  });

  it("遠近の無い幾何は今までどおり", () => {
    const source = { width: 3000, height: 2000 };
    const geometry = { ...IDENTITY, crop: { left: 0.2, top: 0.1, right: 0.8, bottom: 0.9 } };
    const box = cropBoxFromGeometry(geometry, source)!;
    expect(box.width).toBeCloseTo(1800, 9);
    expect(geometryOutputToSource(geometry, source, 0, 0)).toEqual([0.2, 0.1]);
  });
});

describe("developSettings の版・プリセット・コピー（遠近）", () => {
  const tilted = (): DevelopSettings =>
    writeDevelopGeometry(neutralDevelopSettings(), {
      ...IDENTITY,
      crop: { left: 0.1, top: 0, right: 0.9, bottom: 1 },
      perspective: perspective({ vertical: -30 }),
      constrain: true,
    });

  it("遠近があれば形の版は 7（色ポイント・効果・幾何より上）。5・6 は読まない", () => {
    const settings = tilted();
    expect(settings.v).toBe(7);
    expect(developSettingsVersion({ ...settings, grayscale: true })).toBe(7);
    expect(hasDevelopPerspective(settings)).toBe(true);
    expect(hasDevelopGeometry({ geometry: { perspective: { scale: 100 }, constrain: true } })).toBe(false);
    expect(hasDevelopGeometry({ geometry: { perspective: { scale: 120 } } })).toBe(true);
    // 形の壊れた遠近は恒等とみなさない
    expect(hasDevelopPerspective({ geometry: { perspective: { tilt: 1 } } })).toBe(true);
    expect(readDevelopSettings(settings)).not.toBeNull();
    expect(isEditableDevelopSettings(settings)).toBe(true);
    expect(isEditableDevelopSettings({ ...settings, v: 4 })).toBe(false);
    expect(readDevelopSettings({ ...settings, v: 5 })).toBeNull();
    expect(readDevelopSettings({ ...settings, v: 6 })).toBeNull();
    // 遠近は色の補正ではない（初期化で残る）が、恒等でない幾何として neutral にしない
    expect(isNeutralDevelopSettings(settings)).toBe(false);
    const reset = resetDevelopSettingsColors({ ...settings, exposure: 0.5 }, null);
    expect(reset.geometry).toEqual(settings.geometry);
    expect(reset.v).toBe(7);
  });

  it("補正のコピーは幾何（遠近も）を運ばず、貼り付けは貼り付け先の幾何のまま", () => {
    const copied = copyDevelopSettings({ ...tilted(), exposure: 0.4 });
    expect("geometry" in copied).toBe(false);
    const pasted = pasteDevelopSettings(neutralDevelopSettings(), copied);
    expect("geometry" in pasted).toBe(false);
    expect(pasted.v).toBe(1);
    const onto = pasteDevelopSettings(tilted(), copyDevelopSettings({ ...neutralDevelopSettings(), exposure: 0.4 }));
    expect(onto.geometry).toEqual(tilted().geometry);
    expect(onto.v).toBe(7);
  });

  it("プリセットは変形（遠近・Upright）だけを入れ、切り抜き・回転・余白を埋めるは当てる前のまま。自動は幾何を変えない", () => {
    const base = tilted();
    const result = {
      ...neutralDevelopSettings(),
      exposure: 0.3,
      geometry: { ...(base.geometry as object), perspective: perspective({ vertical: -50, scale: 110 }), upright: 1, constrain: false },
      v: 7 as const,
    };
    const applied = presetDevelopSettings(base, result);
    expect(applied.geometry).toEqual({ ...(base.geometry as object), perspective: perspective({ vertical: -50, scale: 110 }), upright: 1 });
    expect(applied.exposure).toBe(0.3);
    expect(applied.v).toBe(7);
    // プリセットが遠近を恒等にしたら、遠近を外す（版も下がる）
    const flat = presetDevelopSettings(base, { ...result, geometry: { ...(base.geometry as object), perspective: undefined } });
    expect((flat.geometry as Record<string, unknown>).perspective).toBeUndefined();
    expect(flat.v).toBe(2);
    // 幾何の無い写真は、遠近が入らなければ幾何のキーを作らない
    expect("geometry" in presetDevelopSettings(neutralDevelopSettings(), { ...neutralDevelopSettings(), exposure: 0.1 })).toBe(false);
    const fresh = presetDevelopSettings(neutralDevelopSettings(), {
      ...neutralDevelopSettings(),
      geometry: { perspective: perspective({ horizontal: 20 }) },
      v: 7,
    });
    expect(fresh.geometry).toEqual({ perspective: perspective({ horizontal: 20 }) });
    expect(fresh.v).toBe(7);
    // 自動は押す前の幾何のまま
    const auto = autoDevelopSettings(base, { ...result, exposure: 0.7 });
    expect(auto.geometry).toEqual(base.geometry);
  });
});
