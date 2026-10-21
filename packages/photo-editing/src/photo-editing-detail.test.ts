import { describe, expect, it } from "vitest";

import { developSettingsVersion, neutralDevelopSettings, readDevelopSettings } from "./develop-engine/develop-settings";
import {
  formatDetailValue,
  isInertDetailControl,
  readDetailValue,
  writeDetailValue,
} from "./photo-editing-detail";
import type { PhotoEditingSettings } from "./photo-editing-types";

/** ディテール（シャープ・ノイズ軽減。Issue #32）の `developSettings.detail`（v6）の読み書き。 */

const RASTER: PhotoEditingSettings = neutralDevelopSettings();
const SIGNED_RAW: PhotoEditingSettings = { ...neutralDevelopSettings(), engine: "niho-11", look: "niho-standard-5" };

describe("readDetailValue", () => {
  it("detail が無ければ crate の既定（シャープ 0・半径 1・ディテール 25・マスク 0・ノイズ軽減 0・カラー 0）", () => {
    expect(
      ["sharpenAmount", "sharpenRadius", "sharpenDetail", "sharpenMasking", "luminanceNoiseReduction", "colorNoiseReduction"].map(
        (key) => readDetailValue(RASTER, key as Parameters<typeof readDetailValue>[1]),
      ),
    ).toEqual([0, 1, 25, 0, 0, 0]);
  });

  it("カラーの明示が無いとき、signed RAW は旧 top-level の値（50 で頭打ち）、JPEG / PNG は 0 を描く", () => {
    expect(readDetailValue({ ...SIGNED_RAW, colorNoiseReduction: 30 }, "colorNoiseReduction")).toBe(30);
    expect(readDetailValue({ ...SIGNED_RAW, colorNoiseReduction: 80 }, "colorNoiseReduction")).toBe(50);
    expect(readDetailValue({ ...RASTER, colorNoiseReduction: 30 }, "colorNoiseReduction")).toBe(0);
  });
});

describe("writeDetailValue", () => {
  it("動かすと exact な detail を書き、v6 になる。既定に戻すと detail ごと消す", () => {
    const sharpened = writeDetailValue(RASTER, "sharpenAmount", 40);
    expect(sharpened.detail).toEqual({
      sharpening: { amount: 40, radius: 1, detail: 25, masking: 0 },
      luminanceNoiseReduction: 0,
    });
    const versioned = { ...sharpened, v: developSettingsVersion(sharpened) };
    expect(versioned.v).toBe(6);
    // crate と同じ形の検査（exact keys・範囲）を通る
    expect(readDevelopSettings(versioned)).not.toBeNull();

    const back = writeDetailValue(sharpened, "sharpenAmount", 0);
    expect(back).not.toHaveProperty("detail");
    expect(developSettingsVersion(back)).toBe(1);
  });

  it("範囲に収め、半径は 0.1 刻み・ほかは整数に丸める。変わらなければ同じ設定を返す", () => {
    expect(readDetailValue(writeDetailValue(RASTER, "sharpenRadius", 1.26), "sharpenRadius")).toBe(1.3);
    expect(readDetailValue(writeDetailValue(RASTER, "sharpenRadius", 9), "sharpenRadius")).toBe(3);
    expect(readDetailValue(writeDetailValue(RASTER, "sharpenRadius", 0.1), "sharpenRadius")).toBe(0.5);
    expect(readDetailValue(writeDetailValue(RASTER, "sharpenAmount", 400), "sharpenAmount")).toBe(150);
    expect(readDetailValue(writeDetailValue(RASTER, "luminanceNoiseReduction", 33.6), "luminanceNoiseReduction")).toBe(34);
    expect(writeDetailValue(RASTER, "sharpenAmount", 0)).toBe(RASTER);
    expect(writeDetailValue(RASTER, "sharpenAmount", Number.NaN)).toBe(RASTER);
  });

  it("カラーは旧の値と同じなら明示を消し（signed RAW は R209 と同じ画素）、違えば 0 を含めて明示する", () => {
    const raw = { ...SIGNED_RAW, colorNoiseReduction: 30 };
    expect(writeDetailValue(raw, "colorNoiseReduction", 30)).toBe(raw);
    const lowered = writeDetailValue(raw, "colorNoiseReduction", 0);
    expect(lowered.detail).toMatchObject({ colorNoiseReduction: 0 });
    expect(readDetailValue(lowered, "colorNoiseReduction")).toBe(0);
    const restored = writeDetailValue(lowered, "colorNoiseReduction", 30);
    expect(restored).not.toHaveProperty("detail");
    expect(restored.colorNoiseReduction).toBe(30);

    // JPEG / PNG の旧の値は描かれないので、0 は明示しない
    const raster = writeDetailValue({ ...RASTER, colorNoiseReduction: 30 }, "colorNoiseReduction", 45);
    expect(raster.detail).toMatchObject({ colorNoiseReduction: 45 });
    expect(writeDetailValue(raster, "colorNoiseReduction", 0)).not.toHaveProperty("detail");
  });

  it("ほかの項目・ほかのキーは保つ", () => {
    const start = writeDetailValue({ ...RASTER, contrast: 12 }, "luminanceNoiseReduction", 20);
    const next = writeDetailValue(start, "sharpenMasking", 35);
    expect(next.contrast).toBe(12);
    expect(next.detail).toEqual({
      sharpening: { amount: 0, radius: 1, detail: 25, masking: 35 },
      luminanceNoiseReduction: 20,
    });
  });
});

describe("表示と押せるか", () => {
  it("半径は小数 1 桁、ほかは整数。シャープが 0 の間は半径・ディテール・マスクが効かない", () => {
    expect(formatDetailValue("sharpenRadius", 1)).toBe("1.0");
    expect(formatDetailValue("sharpenAmount", 40)).toBe("40");
    expect(isInertDetailControl(RASTER, "sharpenRadius")).toBe(true);
    expect(isInertDetailControl(RASTER, "luminanceNoiseReduction")).toBe(false);
    expect(isInertDetailControl(writeDetailValue(RASTER, "sharpenAmount", 10), "sharpenRadius")).toBe(false);
  });
});
