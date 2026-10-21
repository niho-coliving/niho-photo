import { describe, expect, it } from "vitest";

import { isNeutralPhotoEditingSettings } from "./photo-editing-settings-neutral";

describe("isNeutralPhotoEditingSettings", () => {
  it("無い・空・既定値だけなら neutral", () => {
    expect(isNeutralPhotoEditingSettings(null)).toBe(true);
    expect(isNeutralPhotoEditingSettings(undefined)).toBe(true);
    expect(isNeutralPhotoEditingSettings({})).toBe(true);
    expect(
      isNeutralPhotoEditingSettings({
        version: 3,
        exposure: 0,
        contrast: 0,
        highlights: 0,
        shadows: 0,
        whites: 0,
        blacks: 0,
        texture: 0,
        clarity: 0,
        dehaze: 0,
        vibrance: 0,
        saturation: 0,
        relativeTemperature: 0,
        relativeTint: 0,
        whiteBalance: { mode: "asShot" },
        toneCurves: [
          { channel: "master" },
          { channel: "master", points: [{ x: 0, y: 0 }, { x: 1, y: 1 }] },
          { channel: "rgb", points: [[0, 0], [255, 255]] },
        ],
        hsl: { red: { hue: 0, saturation: 0, luminance: 0 } },
        calibration: { redPrimary: { hue: 0, saturation: 0 } },
        colorGrading: { shadows: { hue: 0, saturation: 0 }, enabled: false },
        look: null,
      }),
    ).toBe(true);
  });

  it("数値の調整・色温度・曲線・HSL・カラーグレーディング・ルックのどれかが当たっていれば neutral でない", () => {
    expect(isNeutralPhotoEditingSettings({ exposure: 0.3 })).toBe(false);
    expect(isNeutralPhotoEditingSettings({ relativeTint: -4 })).toBe(false);
    expect(isNeutralPhotoEditingSettings({ whiteBalance: { mode: "custom", temperature: 5600, tint: 4 } })).toBe(false);
    expect(isNeutralPhotoEditingSettings({ toneCurves: [{ channel: "master", points: [{ x: 0, y: 0.1 }, { x: 1, y: 1 }] }] })).toBe(false);
    expect(isNeutralPhotoEditingSettings({ hsl: ["red", { hue: 5 }] })).toBe(false);
    expect(isNeutralPhotoEditingSettings({ colorGrading: { midtones: { hue: 30, saturation: 12 } } })).toBe(false);
    expect(isNeutralPhotoEditingSettings({ look: { name: "Adobe Vivid" } })).toBe(false);
  });

  it("修復の印（heal。niho-photo#44）は空なら neutral、1 つでもあれば画を変える", () => {
    expect(isNeutralPhotoEditingSettings({ heal: [] })).toBe(true);
    expect(isNeutralPhotoEditingSettings({ heal: null })).toBe(true);
    expect(isNeutralPhotoEditingSettings({ heal: [{ id: "a", mode: "remove", radius: 0.02, feather: 0, points: [[0.5, 0.5]] }] })).toBe(false);
    expect(isNeutralPhotoEditingSettings({ heal: "x" })).toBe(false);
  });

  it("分からないキー・分からない形の値があれば neutral とみなさない（安全側）", () => {
    expect(isNeutralPhotoEditingSettings({ sharpening: 0 })).toBe(false);
    expect(isNeutralPhotoEditingSettings({ exposure: "0" })).toBe(false);
    expect(isNeutralPhotoEditingSettings({ hsl: { red: { mode: "custom" } } })).toBe(false);
    expect(isNeutralPhotoEditingSettings({ toneCurves: "linear" })).toBe(false);
    expect(isNeutralPhotoEditingSettings({ toneCurves: [{ channel: "unknown" }] })).toBe(false);
    expect(isNeutralPhotoEditingSettings({ toneCurves: [{ channel: "master", custom: false }] })).toBe(false);
    expect(isNeutralPhotoEditingSettings({ toneCurves: [{ channel: "master", points: [{ x: 0, y: 0, anchor: true }] }] })).toBe(false);
    expect(isNeutralPhotoEditingSettings([])).toBe(false);
  });
});
