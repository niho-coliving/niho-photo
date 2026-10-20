import { describe, expect, it } from "vitest";

import type { PhotoEditingSettings } from "../photo-editing-types";
import {
  PHOTO_EDITING_ADJUSTMENT_GROUPS,
  PHOTO_EDITING_TEMPERATURE_MAX_KELVIN,
  PHOTO_EDITING_TEMPERATURE_MIN_KELVIN,
  type PhotoEditingAdjustmentControl,
  type PhotoEditingControlKey,
} from "../photo-editing-adjustments";

import {
  resolvePhotoEditingControlSliders,
  type PhotoEditingSettingsUpdate,
  type PhotoEditingSliderPhase,
} from "./photo-editing-adjustment-controls";

/**
 * 群の項目 → スライダーに渡す値（F6c 移行元設計 で `PhotoEditingAdjustmentGroups` から切り出した）。PC のスライダーとスマホの目盛りが
 * 同じものを使う。`isDefault` はスマホのチップが値を添えるかどうかに使う。
 */

function control(key: PhotoEditingControlKey): PhotoEditingAdjustmentControl {
  const found = PHOTO_EDITING_ADJUSTMENT_GROUPS.flatMap((group) => group.controls).find((candidate) => candidate.key === key);
  if (!found) throw new Error(`control not found: ${key}`);
  return found;
}

function resolve(options: {
  settings: PhotoEditingSettings | null;
  asShot?: { temperature: number; tint: number } | null;
  disabled?: boolean;
}) {
  const changes: { settings: PhotoEditingSettings; phase: PhotoEditingSliderPhase }[] = [];
  let current: PhotoEditingSettings = options.settings ?? {};
  const resolved = resolvePhotoEditingControlSliders({
    settings: options.settings,
    photo: { asShotWhiteBalance: options.asShot ?? null },
    disabled: options.disabled ?? false,
    idPrefix: "p",
    onSettingsChange: (update: PhotoEditingSettingsUpdate, phase) => {
      current = update(current);
      changes.push({ settings: current, phase });
    },
  });
  return { ...resolved, changes };
}

describe("resolvePhotoEditingControlSliders", () => {
  it("補正の項目: 定義の範囲・刻みと表示の文字を返し、0 のときだけ既定値のまま", () => {
    const { sliderFor, changes } = resolve({ settings: { exposure: 0, contrast: 20 } });
    const exposure = sliderFor(control("exposure"));
    expect(exposure).toMatchObject({ key: "exposure", id: "p-exposure", label: "露光量", value: 0, isDefault: true, disabled: false });
    expect(exposure.entry).toBeUndefined();
    const contrast = sliderFor(control("contrast"));
    expect(contrast).toMatchObject({ key: "contrast", value: 20, valueText: "+20", isDefault: false });

    contrast.onChange(35, "drag");
    contrast.onReset();
    expect(changes).toEqual([
      { settings: expect.objectContaining({ contrast: 35 }), phase: "drag" },
      { settings: expect.objectContaining({ contrast: 0 }), phase: "commit" },
    ]);
  });

  it("相対の白（撮影時の白が無い写真）: 相対のキーで読み書きし、「撮影時に戻す」は出さない", () => {
    const { sliderFor, resetWhiteBalance, changes } = resolve({ settings: { relativeTemperature: 12, relativeTint: 0 } });
    const temperature = sliderFor(control("relativeTemperature"));
    expect(temperature).toMatchObject({
      key: "relativeTemperature",
      id: "p-relativeTemperature",
      label: "色温度",
      min: -100,
      max: 100,
      value: 12,
      valueText: "+12",
      isDefault: false,
    });
    expect(temperature.entry).toBeUndefined();
    expect(sliderFor(control("relativeTint")).isDefault).toBe(true);
    expect(resetWhiteBalance).toBeNull();

    temperature.onChange(-5, "commit");
    expect(changes).toEqual([{ settings: expect.objectContaining({ relativeTemperature: -5 }), phase: "commit" }]);
  });

  it("絶対の白（撮影時の白がある写真）: 撮影時のままは既定値、色温度は K の直接入力を持つ", () => {
    const asShot = { temperature: 5200, tint: 4 };
    const untouched = resolve({ settings: {}, asShot });
    const temperature = untouched.sliderFor(control("relativeTemperature"));
    expect(temperature).toMatchObject({ key: "temperature", id: "p-temperature", valueText: "5200", isDefault: true });
    expect(temperature.entry).toMatchObject({
      min: PHOTO_EDITING_TEMPERATURE_MIN_KELVIN,
      max: PHOTO_EDITING_TEMPERATURE_MAX_KELVIN,
      step: 1,
    });
    const tint = untouched.sliderFor(control("relativeTint"));
    expect(tint).toMatchObject({ key: "tint", id: "p-tint", value: 4, valueText: "+4", isDefault: true });
    expect(tint.entry).toBeUndefined();
    // 撮影時のままなら「撮影時に戻す」は出さない
    expect(untouched.resetWhiteBalance).toBeNull();

    temperature.entry?.commit(6100);
    expect(untouched.changes).toEqual([
      { settings: expect.objectContaining({ whiteBalance: { mode: "custom", temperature: 6100, tint: 4 } }), phase: "commit" },
    ]);
  });

  it("絶対の白を変えた写真: 変えた項目だけ既定値でなくなり、「撮影時に戻す」で戻せる（押せないときは出さない）", () => {
    const asShot = { temperature: 5200, tint: 4 };
    const settings = { whiteBalance: { mode: "custom", temperature: 6100, tint: 4 } };
    const changed = resolve({ settings, asShot });
    expect(changed.sliderFor(control("relativeTemperature"))).toMatchObject({ valueText: "6100", isDefault: false });
    expect(changed.sliderFor(control("relativeTint")).isDefault).toBe(true);

    expect(changed.resetWhiteBalance).not.toBeNull();
    changed.resetWhiteBalance?.();
    expect(changed.changes).toEqual([
      { settings: expect.objectContaining({ whiteBalance: { mode: "asShot" } }), phase: "commit" },
    ]);

    const disabled = resolve({ settings, asShot, disabled: true });
    expect(disabled.resetWhiteBalance).toBeNull();
    expect(disabled.sliderFor(control("contrast")).disabled).toBe(true);
  });
});
