import { describe, expect, it } from "vitest";

import { developDetailNoise, interactiveWorkingCopySettings, withoutInertDetail } from "./develop-detail-preview";

/** ディテール（Issue #32）を wasm のプレビューへどう送るか（owner 判断 2026-10-21）。 */

const SHARP = { amount: 60, radius: 1, detail: 25, masking: 0 };

describe("withoutInertDetail", () => {
  it("量の無い detail は外し、効く detail・detail の無い設定はそのまま（同じオブジェクト）返す", () => {
    const plain = { v: 1, engine: "niho-10" };
    expect(withoutInertDetail(plain)).toBe(plain);
    const active = { v: 5, engine: "niho-10", detail: { sharpening: SHARP, luminanceNoiseReduction: 0 } };
    expect(withoutInertDetail(active)).toBe(active);
    const inert = { v: 5, engine: "niho-10", detail: { sharpening: { ...SHARP, amount: 0, radius: 2 }, luminanceNoiseReduction: 0 } };
    expect(withoutInertDetail(inert)).toEqual({ v: 5, engine: "niho-10" });
    // カラーの明示（0 を含む）は signed RAW の旧の値を上書きするので外さない
    const explicitZero = { ...inert, detail: { ...inert.detail, colorNoiseReduction: 0 } };
    expect(withoutInertDetail(explicitZero)).toBe(explicitZero);
  });
});

describe("interactiveWorkingCopySettings", () => {
  it("旧 RAW・raster の作業コピーは drag 中に detail ごと外す（NR もシャープも描かない）", () => {
    const settings = { v: 5, engine: "niho-2", detail: { sharpening: SHARP, luminanceNoiseReduction: 30, colorNoiseReduction: 40 } };
    expect(interactiveWorkingCopySettings(settings, developDetailNoise(settings))).toEqual({ v: 5, engine: "niho-2" });
    const raster = { ...settings, engine: "niho-10" };
    expect(interactiveWorkingCopySettings(raster, null)).toEqual({ v: 5, engine: "niho-10" });
  });

  it("signed RAW は直前の確定描画の NR のまま送る（今の NR は離した後の確定描画で当てる）", () => {
    const committed = developDetailNoise({ detail: { sharpening: SHARP, luminanceNoiseReduction: 20, colorNoiseReduction: 30 } });
    expect(committed).toEqual({ luminanceNoiseReduction: 20, colorNoiseReduction: 30 });
    const dragging = { v: 5, engine: "niho-11", contrast: 5, detail: { sharpening: SHARP, luminanceNoiseReduction: 80 } };
    expect(interactiveWorkingCopySettings(dragging, committed)).toEqual({
      v: 5,
      engine: "niho-11",
      contrast: 5,
      detail: { sharpening: SHARP, luminanceNoiseReduction: 20, colorNoiseReduction: 30 },
    });
    // NR を 0 に戻して detail が消えても、確定描画までは前の NR の master を使う
    expect(interactiveWorkingCopySettings({ v: 1, engine: "niho-11" }, committed)).toEqual({
      v: 5,
      engine: "niho-11",
      detail: {
        sharpening: { amount: 0, radius: 1, detail: 25, masking: 0 },
        luminanceNoiseReduction: 20,
        colorNoiseReduction: 30,
      },
    });
    // 前の確定描画に NR が無ければ、NR 0（カラーは明示しない＝旧の値）で送る
    expect(interactiveWorkingCopySettings(dragging, null)).toEqual({
      v: 5,
      engine: "niho-11",
      contrast: 5,
      detail: { sharpening: SHARP, luminanceNoiseReduction: 0 },
    });
  });

  it("ディテールを使わない写真（detail も前の NR も無い）は、渡した設定をそのまま返す", () => {
    const plain = { v: 1, engine: "niho-11", colorNoiseReduction: 25 };
    expect(interactiveWorkingCopySettings(plain, null)).toBe(plain);
    expect(developDetailNoise(plain)).toBeNull();
    expect(developDetailNoise({ detail: { sharpening: SHARP, luminanceNoiseReduction: 0 } })).toBeNull();
  });
});
