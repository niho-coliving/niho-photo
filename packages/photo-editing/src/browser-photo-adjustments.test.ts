import { describe, expect, it } from "vitest";

import {
  NEUTRAL_BROWSER_PHOTO_ADJUSTMENTS,
  applyBrowserPhotoAdjustments,
  normalizeBrowserPhotoAdjustments,
} from "./browser-photo-adjustments";

describe("browser photo pixel adjustments", () => {
  it("neutral は RGBA を1バイトも変えない", () => {
    const input = new Uint8ClampedArray([0, 17, 255, 13, 240, 120, 2, 255]);
    expect(Array.from(applyBrowserPhotoAdjustments(input, NEUTRAL_BROWSER_PHOTO_ADJUSTMENTS))).toEqual(Array.from(input));
  });

  it("露光量は 2^EV で増減し alpha を保つ", () => {
    const input = new Uint8ClampedArray([64, 32, 16, 123]);
    expect(Array.from(applyBrowserPhotoAdjustments(input, { ...NEUTRAL_BROWSER_PHOTO_ADJUSTMENTS, exposure: 1 }))).toEqual([
      128, 64, 32, 123,
    ]);
    expect(Array.from(applyBrowserPhotoAdjustments(input, { ...NEUTRAL_BROWSER_PHOTO_ADJUSTMENTS, exposure: -1 }))).toEqual([
      32, 16, 8, 123,
    ]);
  });

  it("contrast / temperature / tint / saturation を実画素へ適用する", () => {
    const input = new Uint8ClampedArray([180, 100, 40, 255]);
    expect(Array.from(applyBrowserPhotoAdjustments(input, { ...NEUTRAL_BROWSER_PHOTO_ADJUSTMENTS, contrast: 50 }))).not.toEqual(Array.from(input));
    expect(Array.from(applyBrowserPhotoAdjustments(input, { ...NEUTRAL_BROWSER_PHOTO_ADJUSTMENTS, temperature: 80 }))[0]).toBeGreaterThan(
      applyBrowserPhotoAdjustments(input, { ...NEUTRAL_BROWSER_PHOTO_ADJUSTMENTS, temperature: 80 })[2],
    );
    expect(Array.from(applyBrowserPhotoAdjustments(input, { ...NEUTRAL_BROWSER_PHOTO_ADJUSTMENTS, tint: 80 }))).not.toEqual(Array.from(input));
    const gray = applyBrowserPhotoAdjustments(input, { ...NEUTRAL_BROWSER_PHOTO_ADJUSTMENTS, saturation: -100 });
    expect(gray[0]).toBe(gray[1]);
    expect(gray[1]).toBe(gray[2]);
  });

  it("非有限値と範囲外を有限の範囲へ clamp する", () => {
    expect(normalizeBrowserPhotoAdjustments({
      exposure: Number.POSITIVE_INFINITY,
      contrast: 999,
      temperature: -999,
      tint: Number.NaN,
      saturation: 101,
    })).toEqual({ exposure: 0, contrast: 100, temperature: -100, tint: 0, saturation: 100 });
  });
});
