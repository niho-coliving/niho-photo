import { describe, expect, it } from "vitest";

import {
  IDENTITY_DEVELOP_GEOMETRY,
  cropFromBox,
  developFrameSize,
  geometryOutputToSource,
  type DevelopGeometry,
  type DevelopGeometryRotate,
  type DevelopSize,
} from "./develop-engine/develop-geometry";
import { readDevelopMasks, writeDevelopMasks, type DevelopLinearMask, type DevelopMask, type DevelopRadialMask } from "./develop-engine/develop-masks";
import { neutralDevelopSettings, readDevelopSettings } from "./develop-engine/develop-settings";
import {
  PHOTO_EDITING_MASK_ADJUST_GROUPS,
  addPhotoEditingMask,
  createPhotoEditingMask,
  createPhotoEditingMaskId,
  dragPhotoEditingMaskHandle,
  duplicatePhotoEditingMask,
  hasPhotoEditingMaskHslEdits,
  isPhotoEditingWhiteBalanceAbsolute,
  photoEditingMaskHandlePoint,
  photoEditingMaskHandles,
  photoEditingMaskOutputToSource,
  readPhotoEditingMaskHsl,
  removePhotoEditingMask,
  resetPhotoEditingMaskHsl,
  setPhotoEditingMaskAdjust,
  setPhotoEditingMaskFeather,
  setPhotoEditingMaskHsl,
  togglePhotoEditingMaskEnabled,
  togglePhotoEditingMaskInvert,
  type PhotoEditingMaskFrame,
  type PhotoEditingMaskHandle,
  type Vec2,
} from "./photo-editing-masks";

/**
 * 部分補正（マスク）の画面の計算（M3 #67）。つまみは見えている出力の上に置き、動かした位置は作業画像の座標に直して契約の空間で
 * 解く。どの回転・反転・角度補正でもつまみが形の上にあり、出す値が必ず読める設定になることを確かめる。
 */

const SOURCES: DevelopSize[] = [
  { width: 3000, height: 2000 },
  { width: 2000, height: 3000 },
  { width: 2048, height: 1365 },
];
const ROTATES: DevelopGeometryRotate[] = [0, 90, 180, 270];

function frameOf(source: DevelopSize, partial: Partial<DevelopGeometry> = {}): PhotoEditingMaskFrame {
  return { source, geometry: { ...IDENTITY_DEVELOP_GEOMETRY, crop: { ...IDENTITY_DEVELOP_GEOMETRY.crop }, ...partial } };
}

/** 回転・反転・角度補正つきの切り抜きの組み合わせ（`cropFromBox` で作るので必ず長方形）。 */
function frames(): PhotoEditingMaskFrame[] {
  const result: PhotoEditingMaskFrame[] = [];
  for (const source of SOURCES) {
    for (const rotate of ROTATES) {
      const frame = developFrameSize(source, rotate);
      for (const [flipH, flipV] of [
        [false, false],
        [true, false],
        [false, true],
      ] as const) {
        for (const { angle, box } of [
          { angle: 0, box: { cx: 0.5, cy: 0.5, width: 1, height: 1 } },
          { angle: 8, box: { cx: 0.45, cy: 0.55, width: 0.6, height: 0.5 } },
          { angle: -30, box: { cx: 0.5, cy: 0.5, width: 0.9, height: 0.9 } },
        ]) {
          const crop = cropFromBox(
            { cx: box.cx * frame.width, cy: box.cy * frame.height, width: box.width * frame.width, height: box.height * frame.height },
            angle,
            frame,
          );
          result.push(frameOf(source, { rotate, flipH, flipV, angle, crop }));
        }
      }
    }
  }
  return result;
}

/** 契約の面の式（`docs/local-adjustments.md`「面の式」。invert の前）。 */
function linearT(mask: DevelopLinearMask, frame: PhotoEditingMaskFrame, point: Vec2): number {
  const A = frame.source.width / frame.source.height;
  const Z = [mask.zero.x * A, mask.zero.y];
  const F = [mask.full.x * A, mask.full.y];
  const d = [F[0]! - Z[0]!, F[1]! - Z[1]!];
  const X = point[0] * A;
  const Y = point[1];
  return ((X - Z[0]!) * d[0]! + (Y - Z[1]!) * d[1]!) / (d[0]! * d[0]! + d[1]! * d[1]!);
}

function radialR(mask: DevelopRadialMask, frame: PhotoEditingMaskFrame, point: Vec2): number {
  const A = frame.source.width / frame.source.height;
  const theta = (mask.angle * Math.PI) / 180;
  const dx = point[0] * A - mask.center.x * A;
  const dy = point[1] - mask.center.y;
  const px = dx * Math.cos(theta) + dy * Math.sin(theta);
  const py = -dx * Math.sin(theta) + dy * Math.cos(theta);
  return Math.hypot(px / (mask.radius.x * A), py / mask.radius.y);
}

/** 出力の画素の大きさ（作業画像の画素で測る。出力の位置 → 作業画像は相似なので、角までの距離がそのまま幅・高さ）。 */
function outputPixels(frame: PhotoEditingMaskFrame): DevelopSize {
  const at = (x: number, y: number) => {
    const point = geometryOutputToSource(frame.geometry, frame.source, x, y)!;
    return [point[0] * frame.source.width, point[1] * frame.source.height];
  };
  const origin = at(0, 0);
  const right = at(1, 0);
  const bottom = at(0, 1);
  return {
    width: Math.hypot(right[0]! - origin[0]!, right[1]! - origin[1]!),
    height: Math.hypot(bottom[0]! - origin[0]!, bottom[1]! - origin[1]!),
  };
}

function screenDistance(frame: PhotoEditingMaskFrame, a: Vec2, b: Vec2): number {
  const size = outputPixels(frame);
  return Math.hypot((a[0] - b[0]) * size.width, (a[1] - b[1]) * size.height);
}

function handle(mask: DevelopMask, frame: PhotoEditingMaskFrame, name: PhotoEditingMaskHandle): Vec2 {
  const point = photoEditingMaskHandlePoint(mask, frame, name);
  if (!point) throw new Error(`no handle ${name}`);
  return point;
}

function expectReadable(masks: DevelopMask[]) {
  const written = writeDevelopMasks(neutralDevelopSettings(), masks);
  const read = readDevelopSettings(JSON.parse(JSON.stringify(written)) as unknown);
  expect(read).not.toBeNull();
  expect(readDevelopMasks(read)).toHaveLength(masks.length);
}

function linear(frame: PhotoEditingMaskFrame, id = "mask-a"): DevelopLinearMask {
  const mask = createPhotoEditingMask("linear", frame, id);
  if (mask?.kind !== "linear") throw new Error("no linear mask");
  return mask;
}

function radial(frame: PhotoEditingMaskFrame, id = "mask-b"): DevelopRadialMask {
  const mask = createPhotoEditingMask("radial", frame, id);
  if (mask?.kind !== "radial") throw new Error("no radial mask");
  return mask;
}

describe("既定のマスク", () => {
  it("線形は見えている高さの 30% が効果 100%・55% が 0% の水平なグラデーション（幾何が恒等なら作業画像の座標のまま）", () => {
    const mask = linear(frameOf({ width: 3000, height: 2000 }));
    expect(mask.full.x).toBeCloseTo(0.5, 12);
    expect(mask.full.y).toBeCloseTo(0.3, 12);
    expect(mask.zero.x).toBeCloseTo(0.5, 12);
    expect(mask.zero.y).toBeCloseTo(0.55, 12);
    expect(mask.adjust).toEqual({});
    expect(mask.enabled).toBe(true);
    expect(mask.invert).toBe(false);
  });

  it("どの回転・反転・角度補正でも、線形は見えている出力で水平の 30%→55%、円形は見えている中心の短い辺 25% の円（ぼかし 50）", () => {
    for (const frame of frames()) {
      const label = JSON.stringify(frame);
      const lin = linear(frame);
      const full = handle(lin, frame, "full");
      const zero = handle(lin, frame, "zero");
      expect(full[0], label).toBeCloseTo(0.5, 9);
      expect(full[1], label).toBeCloseTo(0.3, 9);
      expect(zero[0], label).toBeCloseTo(0.5, 9);
      expect(zero[1], label).toBeCloseTo(0.55, 9);

      const rad = radial(frame);
      expect(rad.feather).toBe(50);
      const center = handle(rad, frame, "center");
      expect(center[0], label).toBeCloseTo(0.5, 9);
      expect(center[1], label).toBeCloseTo(0.5, 9);
      const size = outputPixels(frame);
      const expected = Math.min(size.width, size.height) * 0.25;
      // 画面で円（4 つの端が中心から同じ距離）
      for (const end of ["right", "left", "top", "bottom"] as const) {
        expect(screenDistance(frame, handle(rad, frame, end), center) / expected, `${label} ${end}`).toBeCloseTo(1, 6);
      }
      expectReadable([lin, rad]);
    }
  });

  it("幾何が描けない切り抜きでは作らない（null）", () => {
    const broken = frameOf({ width: 1000, height: 1000 }, { angle: 45, crop: { left: 0, top: 0.5, right: 1, bottom: 0.5 } });
    expect(createPhotoEditingMask("linear", broken, "mask-a")).toBeNull();
    expect(photoEditingMaskHandles(linear(frameOf({ width: 1000, height: 1000 })), broken)).toBeNull();
  });
});

describe("つまみは形の上にある", () => {
  it("線形の始点は面 1・終点は面 0・中央は 0.5、円形の軸の端は楕円の縁（r = 1）。回転・反転・角度補正のすべてで", () => {
    for (const frame of frames()) {
      const label = JSON.stringify(frame);
      const lin = { ...linear(frame), zero: { x: 0.2, y: 0.7 }, full: { x: 0.6, y: 0.25 } };
      for (const [name, t] of [["zero", 0], ["full", 1], ["center", 0.5]] as const) {
        const source = photoEditingMaskOutputToSource(frame, handle(lin, frame, name))!;
        expect(linearT(lin, frame, source), `${label} ${name}`).toBeCloseTo(t, 9);
      }
      const rad: DevelopRadialMask = { ...radial(frame), center: { x: 0.4, y: 0.6 }, radius: { x: 0.2, y: 0.1 }, angle: 33 };
      for (const name of ["right", "left", "top", "bottom"] as const) {
        const source = photoEditingMaskOutputToSource(frame, handle(rad, frame, name))!;
        expect(radialR(rad, frame, source), `${label} ${name}`).toBeCloseTo(1, 9);
      }
      const center = photoEditingMaskOutputToSource(frame, handle(rad, frame, "center"))!;
      expect(radialR(rad, frame, center), label).toBeCloseTo(0, 9);
    }
  });

  it("線形の 2 本の線（始点・終点を通り向きに直角）は画面でも直角（写像が相似）", () => {
    for (const frame of frames()) {
      const lin = { ...linear(frame), zero: { x: 0.2, y: 0.7 }, full: { x: 0.6, y: 0.25 } };
      const size = outputPixels(frame);
      const zero = handle(lin, frame, "zero");
      const full = handle(lin, frame, "full");
      const direction = [(full[0] - zero[0]) * size.width, (full[1] - zero[1]) * size.height];
      // 画面で直角に引いた線の上の点も、面の値が同じ（等値線）
      const normal = [-direction[1]!, direction[0]!];
      const along: Vec2 = [zero[0] + (normal[0]! * 0.1) / size.width, zero[1] + (normal[1]! * 0.1) / size.height];
      const source = photoEditingMaskOutputToSource(frame, along)!;
      expect(linearT(lin, frame, source), JSON.stringify(frame)).toBeCloseTo(0, 9);
    }
  });
});

describe("つまみを動かす", () => {
  it("中央（中心）は形ごと平行移動し、つまみは動かした先に来る", () => {
    for (const frame of frames()) {
      const label = JSON.stringify(frame);
      for (const start of [linear(frame), radial(frame)] as DevelopMask[]) {
        const from = handle(start, frame, "center");
        const to: Vec2 = [from[0] + 0.05, from[1] - 0.04];
        const moved = dragPhotoEditingMaskHandle(start, "center", frame, from, to);
        expect(moved, label).not.toBeNull();
        const after = handle(moved!, frame, "center");
        expect(after[0], label).toBeCloseTo(to[0], 9);
        expect(after[1], label).toBeCloseTo(to[1], 9);
        if (moved!.kind === "radial" && start.kind === "radial") {
          expect(moved!.radius).toEqual(start.radius);
          expect(moved!.angle).toBe(start.angle);
        }
      }
    }
  });

  it("線形の始点・終点はその端だけを動かし、2 点が重なる動きは null", () => {
    for (const frame of frames()) {
      const start = linear(frame);
      const from = handle(start, frame, "zero");
      const to: Vec2 = [from[0] + 0.1, from[1] + 0.2];
      const moved = dragPhotoEditingMaskHandle(start, "zero", frame, from, to) as DevelopLinearMask;
      const after = handle(moved, frame, "zero");
      expect(after[0]).toBeCloseTo(to[0], 9);
      expect(after[1]).toBeCloseTo(to[1], 9);
      expect(moved.full).toEqual(start.full);
      // 始点の上へ終点を重ねる
      expect(dragPhotoEditingMaskHandle(start, "zero", frame, from, handle(start, frame, "full"))).toBeNull();
    }
  });

  it("円形の軸の端はその軸の半径だけを変え（反対側も同じ）、つまみは指の位置を軸に射影した所に来る", () => {
    for (const frame of frames()) {
      const label = JSON.stringify(frame);
      const start: DevelopRadialMask = { ...radial(frame), angle: 20 };
      for (const name of ["right", "left", "top", "bottom"] as const) {
        const from = handle(start, frame, name);
        const center = handle(start, frame, "center");
        // 端を中心から 1.5 倍の所へ
        const to: Vec2 = [center[0] + (from[0] - center[0]) * 1.5, center[1] + (from[1] - center[1]) * 1.5];
        const moved = dragPhotoEditingMaskHandle(start, name, frame, from, to) as DevelopRadialMask;
        const after = handle(moved, frame, name);
        expect(after[0], `${label} ${name}`).toBeCloseTo(to[0], 9);
        expect(after[1], `${label} ${name}`).toBeCloseTo(to[1], 9);
        if (name === "right" || name === "left") {
          expect(moved.radius.x / start.radius.x).toBeCloseTo(1.5, 9);
          expect(moved.radius.y).toBe(start.radius.y);
        } else {
          expect(moved.radius.y / start.radius.y).toBeCloseTo(1.5, 9);
          expect(moved.radius.x).toBe(start.radius.x);
        }
        expect(moved.center).toEqual(start.center);
      }
    }
  });

  it("回転は中心から指への向きが上の端の向きになる（画面で時計回りに回せば時計回り。反転していても指に付いてくる）", () => {
    for (const frame of frames()) {
      const label = JSON.stringify(frame);
      const start: DevelopRadialMask = { ...radial(frame), radius: { x: 0.2, y: 0.1 } };
      const center = handle(start, frame, "center");
      const top = handle(start, frame, "top");
      // 画面の画素で、中心の回りに上の端を 90° 回した位置
      const size = outputPixels(frame);
      const v = [(top[0] - center[0]) * size.width, (top[1] - center[1]) * size.height];
      const turned = [-v[1]!, v[0]!];
      const to: Vec2 = [center[0] + turned[0]! / size.width, center[1] + turned[1]! / size.height];
      const moved = dragPhotoEditingMaskHandle(start, "rotate", frame, top, to) as DevelopRadialMask;
      const after = handle(moved, frame, "top");
      expect(after[0], label).toBeCloseTo(to[0], 6);
      expect(after[1], label).toBeCloseTo(to[1], 6);
      expect(Math.abs(moved.angle)).toBeCloseTo(90, 6);
    }
  });

  it("範囲に収める: 中心 0〜1・半軸 0.005〜1.5・線形の端 −1〜2", () => {
    const frame = frameOf({ width: 3000, height: 2000 });
    const rad = radial(frame);
    const center = handle(rad, frame, "center");
    const far = dragPhotoEditingMaskHandle(rad, "center", frame, center, [center[0] + 5, center[1] - 5]) as DevelopRadialMask;
    expect(far.center).toEqual({ x: 1, y: 0 });
    const right = handle(rad, frame, "right");
    const tiny = dragPhotoEditingMaskHandle(rad, "right", frame, right, center) as DevelopRadialMask;
    expect(tiny.radius.x).toBe(0.005);
    const huge = dragPhotoEditingMaskHandle(rad, "right", frame, right, [right[0] + 10, right[1]]) as DevelopRadialMask;
    expect(huge.radius.x).toBe(1.5);
    const lin = linear(frame);
    const zero = handle(lin, frame, "zero");
    const outside = dragPhotoEditingMaskHandle(lin, "zero", frame, zero, [zero[0] - 10, zero[1] + 10]) as DevelopLinearMask;
    expect(outside.zero).toEqual({ x: -1, y: 2 });
    // 中央は 2 点の両方が収まるところで止まる（向きと幅は変えない）
    const mid = handle(lin, frame, "center");
    const shifted = dragPhotoEditingMaskHandle(lin, "center", frame, mid, [mid[0], mid[1] + 10]) as DevelopLinearMask;
    expect(Math.max(shifted.zero.y, shifted.full.y)).toBeCloseTo(2, 12);
    expect(shifted.zero.y - shifted.full.y).toBeCloseTo(lin.zero.y - lin.full.y, 12);
    expectReadable([far, tiny, huge, outside, shifted].map((mask, index) => ({ ...mask, id: `mask-${index}` })));
  });

  it("どんな動きの結果も、読める設定として書ける（乱数で 400 回）", () => {
    let seed = 7;
    const random = () => {
      seed = (seed * 1103515245 + 12345) % 2147483648;
      return seed / 2147483648;
    };
    const all = frames();
    const handles: Record<"linear" | "radial", PhotoEditingMaskHandle[]> = {
      linear: ["zero", "full", "center"],
      radial: ["center", "right", "left", "top", "bottom", "rotate"],
    };
    for (let index = 0; index < 400; index += 1) {
      const frame = all[Math.floor(random() * all.length)]!;
      const start: DevelopMask = random() < 0.5 ? linear(frame, "mask-x") : radial(frame, "mask-x");
      const kind = start.kind as "linear" | "radial";
      const name = handles[kind][Math.floor(random() * handles[kind].length)]!;
      const from = name === "rotate" ? handle(start, frame, "top") : handle(start, frame, name);
      const to: Vec2 = [from[0] + (random() - 0.5) * 4, from[1] + (random() - 0.5) * 4];
      const moved = dragPhotoEditingMaskHandle(start, name, frame, from, to) ?? start;
      expectReadable([moved]);
    }
  });
});

describe("並び・状態・局所の補正", () => {
  const frame = frameOf({ width: 3000, height: 2000 });

  it("id は配列の中で一意（契約の文字だけ）", () => {
    const masks: DevelopMask[] = [linear(frame, "mask-000000")];
    const id = createPhotoEditingMaskId(masks, () => 0);
    expect(id).not.toBe("mask-000000");
    expect(id).toMatch(/^[A-Za-z0-9_-]{1,64}$/u);
    expect(createPhotoEditingMaskId([], () => 0.5)).toMatch(/^mask-[0-9a-z]{6}$/u);
  });

  it("足すのは 8 枚まで・複製は直後に新しい id で少しずらして入れる・消す", () => {
    let masks: DevelopMask[] = [];
    for (let index = 0; index < 9; index += 1) masks = addPhotoEditingMask(masks, linear(frame, `mask-${index}`));
    expect(masks).toHaveLength(8);
    const two = [linear(frame, "mask-a"), radial(frame, "mask-b")];
    const withAdjust = [{ ...two[0]!, adjust: { exposure: -0.5 } }, two[1]!];
    const duplicated = duplicatePhotoEditingMask(withAdjust, "mask-a", frame, "mask-c");
    expect(duplicated.map((mask) => mask.id)).toEqual(["mask-a", "mask-c", "mask-b"]);
    const copy = duplicated[1] as DevelopLinearMask;
    expect(copy.adjust).toEqual({ exposure: -0.5 });
    expect(copy.zero.x).toBeCloseTo(withAdjust[0]!.kind === "linear" ? (withAdjust[0] as DevelopLinearMask).zero.x + 0.03 : 0, 9);
    // 8 枚なら複製しない
    expect(duplicatePhotoEditingMask(masks, "mask-0", frame, "mask-z")).toHaveLength(8);
    expect(removePhotoEditingMask(duplicated, "mask-c").map((mask) => mask.id)).toEqual(["mask-a", "mask-b"]);
    expectReadable(duplicated);
  });

  it("目・反転の切り替え、ぼかしは 0〜100 の整数", () => {
    const rad = radial(frame);
    expect(togglePhotoEditingMaskEnabled(rad).enabled).toBe(false);
    expect(togglePhotoEditingMaskInvert(rad).invert).toBe(true);
    expect((setPhotoEditingMaskFeather(rad, 130) as DevelopRadialMask).feather).toBe(100);
    expect((setPhotoEditingMaskFeather(rad, -3) as DevelopRadialMask).feather).toBe(0);
    // 線形にぼかしは無い
    const lin = linear(frame);
    expect(setPhotoEditingMaskFeather(lin, 20)).toBe(lin);
  });

  it("局所の差分は範囲と刻みにそろえ、0 はキーを外す。全体の白が absolute の間は相対の白を変えない", () => {
    const lin = linear(frame);
    expect(setPhotoEditingMaskAdjust(lin, "exposure", -0.704, { whiteBalanceAbsolute: false }).adjust).toEqual({ exposure: -0.7 });
    expect(setPhotoEditingMaskAdjust(lin, "contrast", 250, { whiteBalanceAbsolute: false }).adjust).toEqual({ contrast: 100 });
    const set = setPhotoEditingMaskAdjust(lin, "highlights", -30, { whiteBalanceAbsolute: false });
    expect(setPhotoEditingMaskAdjust(set, "highlights", 0, { whiteBalanceAbsolute: false }).adjust).toEqual({});
    expect(setPhotoEditingMaskAdjust(lin, "relativeTemperature", 20, { whiteBalanceAbsolute: true })).toBe(lin);
    expect(setPhotoEditingMaskAdjust(lin, "relativeTemperature", 20, { whiteBalanceAbsolute: false }).adjust).toEqual({
      relativeTemperature: 20,
    });
    expect(isPhotoEditingWhiteBalanceAbsolute({ whiteBalance: { mode: "absolute", temperature: 5000, tint: 0 } })).toBe(true);
    expect(isPhotoEditingWhiteBalanceAbsolute({ whiteBalance: { mode: "relative" } })).toBe(false);
    expect(isPhotoEditingWhiteBalanceAbsolute({})).toBe(false);
  });

  it("局所のスライダーは全体と同じ ライト／カラー／効果 の並び（HSL は無い）", () => {
    expect(PHOTO_EDITING_MASK_ADJUST_GROUPS.map((group) => group.title)).toEqual(["ライト", "カラー", "効果"]);
    expect(PHOTO_EDITING_MASK_ADJUST_GROUPS.map((group) => group.adjustments.map((definition) => definition.key))).toEqual([
      ["exposure", "contrast", "highlights", "shadows", "whites", "blacks"],
      ["relativeTemperature", "relativeTint", "vibrance", "saturation"],
      ["texture", "clarity", "dehaze"],
    ]);
    expect(
      PHOTO_EDITING_MASK_ADJUST_GROUPS.flatMap((group) => group.adjustments)
        .filter((definition) => definition.whiteBalance)
        .map((definition) => definition.label),
    ).toEqual(["色温度", "色かぶり補正"]);
  });
});

describe("局所のカラーミキサー（adjust.hsl。niho-photo#93）", () => {
  const frame = frameOf({ width: 3000, height: 2000 });

  it("無い色・値は 0 で読み、書いた値は ±100 の整数に収める", () => {
    const lin = linear(frame);
    const values = readPhotoEditingMaskHsl(lin);
    expect(Object.keys(values)).toEqual(["red", "orange", "yellow", "green", "aqua", "blue", "purple", "magenta"]);
    expect(values.blue).toEqual({ hue: 0, saturation: 0, luminance: 0 });
    expect(hasPhotoEditingMaskHslEdits(lin)).toBe(false);
    const set = setPhotoEditingMaskHsl(lin, "blue", "saturation", -140.4);
    expect(set.adjust.hsl).toEqual({ blue: { hue: 0, saturation: -100, luminance: 0 } });
    expect(setPhotoEditingMaskHsl(lin, "red", "hue", 12.6).adjust.hsl).toEqual({ red: { hue: 13, saturation: 0, luminance: 0 } });
    expect(readPhotoEditingMaskHsl(set).blue.saturation).toBe(-100);
    expect(hasPhotoEditingMaskHslEdits(set)).toBe(true);
    // -0 は 0・数でない値・同じ値は変えない（渡したマスクのまま）
    expect(setPhotoEditingMaskHsl(lin, "blue", "hue", -0.2)).toBe(lin);
    expect(setPhotoEditingMaskHsl(lin, "blue", "hue", Number.NaN)).toBe(lin);
    expect(setPhotoEditingMaskHsl(set, "blue", "saturation", -100)).toBe(set);
  });

  it("写して書き換え（元のマスクは変えない）、3 値とも 0 の色は消し、色が残らなければ adjust.hsl ごと消す（ほかの差分は残す）", () => {
    const base: DevelopMask = { ...linear(frame), adjust: { exposure: -0.5 } };
    const one = setPhotoEditingMaskHsl(base, "blue", "saturation", -100);
    const two = setPhotoEditingMaskHsl(one, "orange", "luminance", 20);
    expect(one.adjust.hsl).toEqual({ blue: { hue: 0, saturation: -100, luminance: 0 } });
    expect(two.adjust.hsl).toEqual({
      blue: { hue: 0, saturation: -100, luminance: 0 },
      orange: { hue: 0, saturation: 0, luminance: 20 },
    });
    const backToOne = setPhotoEditingMaskHsl(two, "orange", "luminance", 0);
    expect(backToOne.adjust.hsl).toEqual({ blue: { hue: 0, saturation: -100, luminance: 0 } });
    const cleared = setPhotoEditingMaskHsl(backToOne, "blue", "saturation", 0);
    expect(cleared.adjust).toEqual({ exposure: -0.5 });
    expect("hsl" in cleared.adjust).toBe(false);
    expect(base.adjust).toEqual({ exposure: -0.5 });
    // 初期化は hsl だけを外す
    expect(resetPhotoEditingMaskHsl(two).adjust).toEqual({ exposure: -0.5 });
    expect(resetPhotoEditingMaskHsl(base)).toBe(base);
  });

  it("保存は正規形の交互の配列（色の順・0 の値は書かない）で、読み直すと同じ値", () => {
    const lin = linear(frame, "mask-a");
    const edited = setPhotoEditingMaskHsl(setPhotoEditingMaskHsl(lin, "blue", "saturation", -100), "red", "hue", 15);
    const written = writeDevelopMasks(neutralDevelopSettings(), [edited]);
    const stored = (written.masks as Array<{ adjust: Record<string, unknown> }>)[0]!.adjust;
    expect(stored.hsl).toEqual(["red", { hue: 15 }, "blue", { saturation: -100 }]);
    expect(
      (writeDevelopMasks(neutralDevelopSettings(), [setPhotoEditingMaskHsl(lin, "blue", "saturation", -100)]).masks as Array<{
        adjust: Record<string, unknown>;
      }>)[0]!.adjust,
    ).toEqual({ hsl: ["blue", { saturation: -100 }] });
    const read = readDevelopMasks(JSON.parse(JSON.stringify(written)) as unknown);
    expect(readPhotoEditingMaskHsl(read[0]!).blue.saturation).toBe(-100);
    expect(readPhotoEditingMaskHsl(read[0]!).red.hue).toBe(15);
    expectReadable([edited]);
  });
});
