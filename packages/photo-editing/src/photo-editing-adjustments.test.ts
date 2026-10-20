import { describe, expect, it } from "vitest";

import {
  PHOTO_EDITING_ADJUSTMENT_GROUPS,
  PHOTO_EDITING_COLOR_ADJUSTMENTS,
  PHOTO_EDITING_EFFECTS_ADJUSTMENTS,
  PHOTO_EDITING_LIGHT_ADJUSTMENTS,
  PHOTO_EDITING_TEMPERATURE_SLIDER_STEPS,
  formatAdjustmentValue,
  formatSignedInteger,
  isDevelopSettingsForm,
  readAbsoluteWhiteBalance,
  readAdjustment,
  readRelativeWhiteBalance,
  resetAbsoluteWhiteBalance,
  resolveWhiteBalanceMode,
  sliderPositionToTemperature,
  temperatureToSliderPosition,
  visiblePhotoEditingAdjustmentGroups,
  writeAbsoluteWhiteBalance,
  writeAdjustment,
  writeRelativeWhiteBalance,
} from "./photo-editing-adjustments";

describe("基本補正の項目", () => {
  it("仕様の調整項目を Lightroom のクラウド版・モバイルの並びで持つ", () => {
    expect(PHOTO_EDITING_LIGHT_ADJUSTMENTS.map((item) => item.label)).toEqual([
      "露光量",
      "コントラスト",
      "ハイライト",
      "シャドウ",
      "白レベル",
      "黒レベル",
    ]);
    expect(PHOTO_EDITING_COLOR_ADJUSTMENTS.map((item) => item.label)).toEqual(["自然な彩度", "彩度"]);
    expect(PHOTO_EDITING_EFFECTS_ADJUSTMENTS.map((item) => item.label)).toEqual(["テクスチャ", "明瞭度", "かすみの除去"]);
    expect(PHOTO_EDITING_LIGHT_ADJUSTMENTS[0]).toMatchObject({ key: "exposure", min: -5, max: 5, step: 0.01 });
    expect(
      [...PHOTO_EDITING_COLOR_ADJUSTMENTS, ...PHOTO_EDITING_EFFECTS_ADJUSTMENTS].every(
        (item) => item.min === -100 && item.max === 100 && item.step === 1,
      ),
    ).toBe(true);
  });
});

describe("基本補正の群（#17118 → F1 #17119）", () => {
  it("ライト → カラー → 効果 の順に、見出しと項目を 1 か所で持つ（13 項目）", () => {
    expect(PHOTO_EDITING_ADJUSTMENT_GROUPS.map((group) => [group.id, group.title])).toEqual([
      ["light", "ライト"],
      ["color", "カラー"],
      ["effects", "効果"],
    ]);
    const [light, color, effects] = PHOTO_EDITING_ADJUSTMENT_GROUPS;
    expect(light.controls.map((control) => control.key)).toEqual(PHOTO_EDITING_LIGHT_ADJUSTMENTS.map((item) => item.key));
    expect(color.controls).toEqual([
      { kind: "whiteBalance", key: "relativeTemperature", channel: "temperature", label: "色温度" },
      { kind: "whiteBalance", key: "relativeTint", channel: "tint", label: "色かぶり補正" },
      ...PHOTO_EDITING_COLOR_ADJUSTMENTS.map((definition) => ({ kind: "adjustment", key: definition.key, definition })),
    ]);
    expect(effects.controls.map((control) => control.key)).toEqual(["texture", "clarity", "dehaze"]);
    expect(PHOTO_EDITING_ADJUSTMENT_GROUPS.flatMap((group) => group.controls)).toHaveLength(13);
  });

  it("効果の群だけが ⓘ の説明（項目ごとに 1 行）を持つ", () => {
    const [light, color, effects] = PHOTO_EDITING_ADJUSTMENT_GROUPS;
    expect(light.info).toBeUndefined();
    expect(color.info).toBeUndefined();
    expect(effects.info).toEqual({
      label: "効果の説明",
      descriptions: {
        texture: "細かな質感を強めたり、和らげたりします",
        clarity: "中間の明暗の差を強めて、くっきり見せます",
        dehaze: "かすみを取り除いたり、足したりします",
      },
    });
  });

  it("見せる項目で絞る（並びは群の定義のまま・項目の無い群は外す・省略時は全部）", () => {
    const browser = visiblePhotoEditingAdjustmentGroups(["saturation", "relativeTint", "exposure", "relativeTemperature", "contrast"]);
    expect(browser.map((group) => [group.id, group.controls.map((control) => control.key)])).toEqual([
      ["light", ["exposure", "contrast"]],
      ["color", ["relativeTemperature", "relativeTint", "saturation"]],
    ]);

    expect(visiblePhotoEditingAdjustmentGroups(["highlights"]).map((group) => group.id)).toEqual(["light"]);
    expect(visiblePhotoEditingAdjustmentGroups(["dehaze"]).map((group) => group.id)).toEqual(["effects"]);
    expect(visiblePhotoEditingAdjustmentGroups([])).toEqual([]);
    expect(visiblePhotoEditingAdjustmentGroups()).toEqual(PHOTO_EDITING_ADJUSTMENT_GROUPS);
    // 定義そのものは変えない
    expect(PHOTO_EDITING_ADJUSTMENT_GROUPS[1].controls).toHaveLength(4);
  });
});

describe("settings の書き換え", () => {
  const presetSettings = {
    exposure: 0.25,
    contrast: 10,
    toneCurves: [{ channel: "rgb", points: [[0, 0], [255, 255]] }],
    hsl: ["red", { hue: 5 }],
    whiteBalance: { mode: "asShot" },
  };

  it("書き換えるキー以外（プリセットが入れた値）はそのまま残す", () => {
    const next = writeAdjustment(presetSettings, "contrast", 35);
    expect(next).toEqual({ ...presetSettings, contrast: 35 });
    expect(next.toneCurves).toBe(presetSettings.toneCurves);
    expect(presetSettings.contrast).toBe(10);
  });

  it("範囲と刻みにそろえる", () => {
    expect(writeAdjustment({}, "exposure", 7).exposure).toBe(5);
    expect(writeAdjustment({}, "exposure", 0.1 + 0.2).exposure).toBe(0.3);
    expect(writeAdjustment({}, "exposure", -0.001).exposure).toBe(0);
    expect(writeAdjustment({}, "saturation", -130).saturation).toBe(-100);
    expect(writeAdjustment({}, "clarity", 12.6).clarity).toBe(13);
    expect(writeAdjustment({ clarity: 3 }, "clarity", Number.NaN).clarity).toBe(3);
  });

  it("無い・数でない値は 0 として読む", () => {
    expect(readAdjustment({}, "dehaze")).toBe(0);
    expect(readAdjustment({ dehaze: "12" }, "dehaze")).toBe(0);
    expect(readAdjustment({ dehaze: -12 }, "dehaze")).toBe(-12);
  });
});

describe("色温度・色かぶり補正", () => {
  const asShot = { temperature: 5200, tint: 3 };

  it("Adobe のプロファイルで開いた RAW だけが絶対値", () => {
    expect(resolveWhiteBalanceMode({ asShotWhiteBalance: asShot })).toBe("absolute");
    expect(resolveWhiteBalanceMode({ asShotWhiteBalance: null })).toBe("relative");
  });

  it("撮影時のままなら撮影時の値を出す", () => {
    expect(readAbsoluteWhiteBalance({ whiteBalance: { mode: "asShot" } }, asShot)).toEqual({
      temperature: 5200,
      tint: 3,
      asShot: true,
    });
    expect(readAbsoluteWhiteBalance({}, asShot).asShot).toBe(true);
    expect(readAbsoluteWhiteBalance({ whiteBalance: { mode: "custom", temperature: null } }, asShot).asShot).toBe(true);
  });

  it("絶対値を書くと custom になり、撮影時に戻せる", () => {
    const custom = writeAbsoluteWhiteBalance({ exposure: 0.2 }, { temperature: 60000, tint: -3.4 });
    expect(custom).toEqual({ exposure: 0.2, whiteBalance: { mode: "custom", temperature: 50000, tint: -3 } });
    expect(readAbsoluteWhiteBalance(custom, asShot)).toEqual({ temperature: 50000, tint: -3, asShot: false });
    expect(resetAbsoluteWhiteBalance(custom)).toEqual({ exposure: 0.2, whiteBalance: { mode: "asShot" } });
  });

  it("RAW 以外は相対値（−100〜+100）を書く", () => {
    const next = writeRelativeWhiteBalance({ whiteBalance: { mode: "asShot" } }, "relativeTemperature", 140);
    expect(next).toEqual({ whiteBalance: { mode: "asShot" }, relativeTemperature: 100 });
    expect(readRelativeWhiteBalance(next, "relativeTemperature")).toBe(100);
    expect(readRelativeWhiteBalance(next, "relativeTint")).toBe(0);
  });

  it("色温度のつまみは両端が 2000K と 50000K で、低い側ほど細かい", () => {
    expect(sliderPositionToTemperature(0)).toBe(2000);
    expect(sliderPositionToTemperature(PHOTO_EDITING_TEMPERATURE_SLIDER_STEPS)).toBe(50000);
    expect(temperatureToSliderPosition(2000)).toBe(0);
    expect(temperatureToSliderPosition(50000)).toBe(PHOTO_EDITING_TEMPERATURE_SLIDER_STEPS);
    // よく使う 2500〜10000K がつまみの半分以上を占める
    expect(temperatureToSliderPosition(10000) - temperatureToSliderPosition(2500)).toBeGreaterThan(
      PHOTO_EDITING_TEMPERATURE_SLIDER_STEPS / 2,
    );
  });

  it("つまみと色温度を往復しても値がずれない", () => {
    for (const kelvin of [2000, 3200, 5200, 6500, 9000, 50000]) {
      const position = temperatureToSliderPosition(kelvin);
      expect(temperatureToSliderPosition(sliderPositionToTemperature(position))).toBe(position);
    }
  });
});

describe("段 2 の developSettings（NIHO Desktop のクラウドの写真。#16946 S7b）", () => {
  const develop = {
    v: 1,
    engine: "niho-1",
    look: "niho-interim-1",
    base: null,
    exposure: 0,
    contrast: 0,
    saturation: 0,
    relativeTemperature: 0,
    relativeTint: 0,
    whiteBalance: { mode: "asShot" },
  };
  const asShot = { temperature: 5550, tint: 6 };

  it("v: 1 と engine を持つ設定だけを developSettings の形として扱う", () => {
    expect(isDevelopSettingsForm(develop)).toBe(true);
    expect(isDevelopSettingsForm({ exposure: 0, whiteBalance: { mode: "asShot" } })).toBe(false);
    expect(isDevelopSettingsForm({ v: 1 })).toBe(false);
    // 切り抜き・回転のある v2 も段 2 の形（相対の白で whiteBalance.mode を合わせる。移行元設計）
    const cropped = { ...develop, v: 2, geometry: { rotate: 90 } };
    expect(isDevelopSettingsForm(cropped)).toBe(true);
    expect(writeRelativeWhiteBalance(cropped, "relativeTemperature", 12)).toMatchObject({
      v: 2,
      geometry: { rotate: 90 },
      relativeTemperature: 12,
      whiteBalance: { mode: "relative" },
    });
    expect(isDevelopSettingsForm({ v: 3, engine: "niho-1" })).toBe(false);
  });

  it("スライダーの項目は同じ名前・単位で書く（版の情報はそのまま）", () => {
    const next = writeAdjustment(develop, "highlights", -40);
    expect(next).toEqual({ ...develop, highlights: -40 });
    expect(readAdjustment(next, "highlights")).toBe(-40);
  });

  it("絶対の色温度・色かぶりは absolute で書き、absolute も読む。撮影時に戻せる", () => {
    const absolute = writeAbsoluteWhiteBalance(develop, { temperature: 6500.4, tint: 200 });
    expect(absolute.whiteBalance).toEqual({ mode: "absolute", temperature: 6500, tint: 150 });
    expect(absolute.base).toBeNull();
    expect(readAbsoluteWhiteBalance(absolute, asShot)).toEqual({ temperature: 6500, tint: 150, asShot: false });
    expect(readAbsoluteWhiteBalance(develop, asShot)).toEqual({ temperature: 5550, tint: 6, asShot: true });
    expect(resetAbsoluteWhiteBalance(absolute).whiteBalance).toEqual({ mode: "asShot" });
  });

  it("絶対値を書く・撮影時に戻すときは相対の値を 0 にする（段 2 の検証 modeMismatch を起こさない）", () => {
    const relative = { ...develop, relativeTemperature: 20, relativeTint: -4, whiteBalance: { mode: "relative" } };
    const absolute = writeAbsoluteWhiteBalance(relative, { temperature: 6000, tint: 3 });
    expect(absolute).toMatchObject({
      relativeTemperature: 0,
      relativeTint: 0,
      whiteBalance: { mode: "absolute", temperature: 6000, tint: 3 },
    });
    expect(resetAbsoluteWhiteBalance(relative)).toMatchObject({
      relativeTemperature: 0,
      relativeTint: 0,
      whiteBalance: { mode: "asShot" },
    });
    // Photo Bench の形は今までどおり（相対の値に触らない）
    expect(writeAbsoluteWhiteBalance({ relativeTemperature: 20 }, { temperature: 6000, tint: 3 })).toEqual({
      relativeTemperature: 20,
      whiteBalance: { mode: "custom", temperature: 6000, tint: 3 },
    });
    expect(resetAbsoluteWhiteBalance({ relativeTemperature: 20, whiteBalance: { mode: "custom" } })).toEqual({
      relativeTemperature: 20,
      whiteBalance: { mode: "asShot" },
    });
  });

  it("相対の補正が残っている developSettings の RAW は相対で見せ、両方 0 に戻すと絶対に戻る", () => {
    const raw = { asShotWhiteBalance: asShot };
    const relative = { ...develop, relativeTemperature: 20, relativeTint: 0, whiteBalance: { mode: "relative" } };
    expect(resolveWhiteBalanceMode(raw, relative)).toBe("relative");
    expect(resolveWhiteBalanceMode(raw, develop)).toBe("absolute");
    expect(resolveWhiteBalanceMode(raw)).toBe("absolute");
    const back = writeRelativeWhiteBalance(relative, "relativeTemperature", 0);
    expect(back.whiteBalance).toEqual({ mode: "asShot" });
    expect(resolveWhiteBalanceMode(raw, back)).toBe("absolute");
    // Photo Bench の形の RAW は相対の値があっても絶対（今までどおり）
    expect(resolveWhiteBalanceMode(raw, { relativeTemperature: 20, whiteBalance: { mode: "asShot" } })).toBe("absolute");
    expect(resolveWhiteBalanceMode({ asShotWhiteBalance: null }, develop)).toBe("relative");
  });

  it("相対の色温度・色かぶり補正を動かすと relative、両方 0 に戻すと撮影時（asShot）", () => {
    const warm = writeRelativeWhiteBalance(develop, "relativeTemperature", 12);
    expect(warm).toMatchObject({ relativeTemperature: 12, whiteBalance: { mode: "relative" } });
    const tinted = writeRelativeWhiteBalance(warm, "relativeTint", -5);
    expect(tinted).toMatchObject({ relativeTemperature: 12, relativeTint: -5, whiteBalance: { mode: "relative" } });
    const back = writeRelativeWhiteBalance(writeRelativeWhiteBalance(tinted, "relativeTemperature", 0), "relativeTint", 0);
    expect(back).toMatchObject({ relativeTemperature: 0, relativeTint: 0, whiteBalance: { mode: "asShot" } });
    // Photo Bench の形は whiteBalance を変えない（今までどおり）
    expect(writeRelativeWhiteBalance({ whiteBalance: { mode: "asShot" } }, "relativeTint", 30)).toEqual({
      whiteBalance: { mode: "asShot" },
      relativeTint: 30,
    });
  });
});

describe("値の表示", () => {
  it("露光量は小数 2 桁、他は整数で、正の値に + を付ける", () => {
    expect(formatAdjustmentValue("exposure", 0.35)).toBe("+0.35");
    expect(formatAdjustmentValue("exposure", 0)).toBe("0.00");
    expect(formatAdjustmentValue("exposure", -1.2)).toBe("-1.20");
    expect(formatAdjustmentValue("contrast", 12)).toBe("+12");
    expect(formatAdjustmentValue("contrast", -5)).toBe("-5");
    expect(formatAdjustmentValue("contrast", 0)).toBe("0");
    expect(formatSignedInteger(-0.4)).toBe("0");
  });
});
