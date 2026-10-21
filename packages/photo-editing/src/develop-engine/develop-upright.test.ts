import { describe, expect, it } from "vitest";

import { readDevelopGeometry, writeDevelopGeometry, type DevelopGeometry } from "./develop-geometry";
import { neutralDevelopSettings } from "./develop-settings";
import {
  applyDevelopUpright,
  clearDevelopUpright,
  developGeometryUpright,
  isDevelopUprightFound,
  readDevelopUprightEstimate,
  sameDevelopUprightFrame,
  type DevelopUprightEstimate,
} from "./develop-upright";

/**
 * Upright（niho-photo#46 後半）の結果の読み方と幾何への当て方。crate の `estimateUpright` の JSON を読み、押したボタンの結果を
 * 遠近（回転・垂直・水平。ほかの 4 本は既定）・`upright`・「余白を埋める」に書く。
 */

const IDENTITY: DevelopGeometry = { rotate: 0, flipH: false, flipV: false, angle: 0, crop: { left: 0, top: 0, right: 1, bottom: 1 } };
const PERSPECTIVE = { vertical: -31.5, horizontal: 4.25, rotate: 1.5, aspect: 0, scale: 100, x: 0, y: 0 };

function found(): DevelopUprightEstimate {
  return { perspective: PERSPECTIVE, mode: 4, confidence: 0.8, lines: { vertical: 20, horizontal: 6 }, reason: null };
}

describe("readDevelopUprightEstimate", () => {
  it("crate の結果を読む（reason が無ければ null）", () => {
    const json = JSON.stringify({ perspective: PERSPECTIVE, mode: 4, confidence: 0.8, lines: { vertical: 20, horizontal: 6 } });
    expect(readDevelopUprightEstimate(json)).toEqual(found());
    const none = readDevelopUprightEstimate(
      JSON.stringify({
        perspective: { vertical: 0, horizontal: 0, rotate: 0, aspect: 0, scale: 100, x: 0, y: 0 },
        mode: 1,
        confidence: 0,
        lines: { vertical: 0, horizontal: 1 },
        reason: "noLines",
      }),
    );
    expect(none?.reason).toBe("noLines");
    expect(none && isDevelopUprightFound(none)).toBe(false);
    expect(isDevelopUprightFound(found())).toBe(true);
  });

  it("形の違う結果は null", () => {
    const base = { perspective: PERSPECTIVE, mode: 4, confidence: 0.8, lines: { vertical: 20, horizontal: 6 } };
    for (const broken of [
      "not json",
      "[]",
      JSON.stringify({ ...base, mode: 5 }),
      JSON.stringify({ ...base, confidence: 1.5 }),
      JSON.stringify({ ...base, perspective: { ...PERSPECTIVE, vertical: "x" } }),
      JSON.stringify({ ...base, perspective: { vertical: 1 } }),
      JSON.stringify({ ...base, lines: { vertical: -1, horizontal: 0 } }),
      JSON.stringify({ ...base, reason: 3 }),
    ]) {
      expect(readDevelopUprightEstimate(broken), broken).toBeNull();
    }
  });
});

describe("Upright を幾何に当てる", () => {
  it("遠近を推定の 3 本に置き換え（縦横比・拡大・X / Y は既定に戻す）、押したボタンと「余白を埋める」を書く。角度・切り抜きは触らない", () => {
    const before: DevelopGeometry = {
      ...IDENTITY,
      angle: 1.5,
      crop: { left: 0.1, top: 0, right: 0.9, bottom: 1 },
      perspective: { vertical: 10, horizontal: 0, rotate: 0, aspect: 30, scale: 120, x: 5, y: -5 },
    };
    const applied = applyDevelopUpright(before, found(), 1);
    expect(applied).toEqual({ ...before, perspective: PERSPECTIVE, upright: 1, constrain: true });
    expect(developGeometryUpright(applied)).toBe(1);
    // 保存すると v 7（遠近がある）
    const written = writeDevelopGeometry(neutralDevelopSettings(), applied);
    expect(written.v).toBe(7);
    expect(readDevelopGeometry(written)).toMatchObject({ upright: 1, constrain: true, perspective: PERSPECTIVE });
  });

  it("切ると遠近と upright を外し、「余白を埋める」は残す", () => {
    const applied = applyDevelopUpright(IDENTITY, found(), 3);
    const cleared = clearDevelopUpright(applied);
    expect(cleared).toEqual({ ...IDENTITY, constrain: true });
    expect(developGeometryUpright(cleared)).toBe(0);
  });

  it("押しているボタンは 1〜4 だけ（ガイド付きの 5 や壊れた値は 0）", () => {
    expect(developGeometryUpright({ ...IDENTITY, upright: 5 })).toBe(0);
    expect(developGeometryUpright({ ...IDENTITY, upright: 2.5 })).toBe(0);
    expect(developGeometryUpright(IDENTITY)).toBe(0);
  });

  it("推定した枠と同じか（90° 回転・反転・角度。切り抜きと遠近は見ない）", () => {
    expect(sameDevelopUprightFrame(IDENTITY, { ...IDENTITY, crop: { left: 0.2, top: 0, right: 1, bottom: 1 } })).toBe(true);
    expect(sameDevelopUprightFrame(IDENTITY, { ...IDENTITY, rotate: 90 })).toBe(false);
    expect(sameDevelopUprightFrame(IDENTITY, { ...IDENTITY, flipH: true })).toBe(false);
    expect(sameDevelopUprightFrame(IDENTITY, { ...IDENTITY, angle: 2 })).toBe(false);
  });
});
