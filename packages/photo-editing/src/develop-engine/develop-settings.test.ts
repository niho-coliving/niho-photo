import { describe, expect, it } from "vitest";

import { NEUTRAL_BROWSER_PHOTO_ADJUSTMENTS } from "../browser-photo-adjustments";
import {
  applyBrowserAdjustmentsToDevelopSettings,
  copyDevelopSettings,
  developSettingsOnWorkingCopy,
  developSettingsToEditSettings,
  developSettingsVersion,
  DEVELOP_SETTINGS_ENGINE,
  DevelopSettingsBaseMismatchError,
  NIHO2_DEVELOP_SETTINGS_ENGINE,
  hasDevelopGeometry,
  hasNullDevelopGeometryField,
  hasSavedDevelopSettings,
  isEditableDevelopSettings,
  isNeutralDevelopColors,
  isNeutralDevelopSettings,
  neutralDevelopSettings,
  newDevelopSettingsEngine,
  pasteDevelopSettings,
  readBrowserAdjustmentsFromDevelopSettings,
  readDevelopSettings,
  resetDevelopSettingsColors,
  signedWorkingCopyState,
  type DevelopSettings,
} from "./develop-settings";

/** 切り抜き・角度・90° 回転のある幾何（F3 移行元設計）。 */
const CROP = { rotate: 90, flipH: false, flipV: false, angle: -2.5, crop: { left: 0.1, top: 0, right: 0.9, bottom: 1 } };

describe("neutralDevelopSettings", () => {
  it("JPEG / PNG を直接描く新規設定は v1・niho-10・NIHO 標準ルックを使う", () => {
    expect(DEVELOP_SETTINGS_ENGINE).toBe("niho-10");
    expect(NIHO2_DEVELOP_SETTINGS_ENGINE).toBe("niho-2");
    expect(neutralDevelopSettings()).toEqual({
      v: 1,
      engine: "niho-10",
      look: "niho-standard-1",
      base: null,
      exposure: 0,
      contrast: 0,
      saturation: 0,
      relativeTemperature: 0,
      relativeTint: 0,
      whiteBalance: { mode: "asShot" },
    });
    expect(isNeutralDevelopSettings(neutralDevelopSettings())).toBe(true);
  });

  it("作業コピーから描く写真（#16944）は base に作業コピーの版を持つ（neutral のまま）", () => {
    expect(neutralDevelopSettings("raw-apple.d8.p1.e1.cal-none")).toMatchObject({ base: "raw-apple.d8.p1.e1.cal-none", exposure: 0 });
    expect(isNeutralDevelopSettings(neutralDevelopSettings("raw-apple.d8.p1.e1.cal-none"))).toBe(true);
  });

  it("新規の数式は base で決める: 直接描く・raster の作業コピーは niho-10、RAW・版の分からない作業コピー・RAW の写真は niho-2", () => {
    expect(neutralDevelopSettings(null).engine).toBe("niho-10");
    expect(neutralDevelopSettings("raster.ci2.p2.e2.icc-srgb")).toMatchObject({ engine: "niho-10", base: "raster.ci2.p2.e2.icc-srgb" });
    expect(neutralDevelopSettings("raw-apple.d8.p1.e1.cal-none").engine).toBe("niho-2");
    expect(neutralDevelopSettings("raw-apple.d8.p3.e4.cal-signed").engine).toBe("niho-2");
    expect(neutralDevelopSettings("fixture-base").engine).toBe("niho-2");
    // base: null でも RAW の写真（作業コピーの無い RAW など）は呼び出し側が明示する
    expect(neutralDevelopSettings(null, { raw: true })).toEqual({ ...neutralDevelopSettings(null), engine: "niho-2" });
    expect(neutralDevelopSettings("raster.ci2.p2.e2.icc-srgb", { raw: true }).engine).toBe("niho-2");
    expect(newDevelopSettingsEngine(null)).toBe("niho-10");
    expect(newDevelopSettingsEngine("raster.x")).toBe("niho-10");
    expect(newDevelopSettingsEngine("raw-apple.d8.p0.e1.cal-none")).toBe("niho-2");
    expect(newDevelopSettingsEngine(null, { raw: true })).toBe("niho-2");
    // niho-6 と niho-2 の neutral は数式の版だけが違う（同じ画になる）
    const { engine: _six, ...six } = neutralDevelopSettings(null);
    const { engine: _two, ...two } = neutralDevelopSettings(null, { raw: true });
    expect(six).toEqual(two);
  });
});

describe("developSettingsOnWorkingCopy（#16944）", () => {
  it("保存済みbaseと違う作業コピーは開かず、同じbaseならルックと補正を保つ", () => {
    expect(() =>
      developSettingsOnWorkingCopy(
        { ...neutralDevelopSettings("raw-apple.d8.p0.e1.cal-none"), look: "niho-interim-1", exposure: 0.4, hsl: { red: 1 } },
        "raw-apple.d8.p1.e1.cal-none",
      ),
    ).toThrow(DevelopSettingsBaseMismatchError);
    expect(
      developSettingsOnWorkingCopy(
        { ...neutralDevelopSettings("raw-apple.d8.p1.e1.cal-none"), look: "niho-interim-1", exposure: 0.4, hsl: { red: 1 } },
        "raw-apple.d8.p1.e1.cal-none",
      ),
    ).toEqual({
      ...neutralDevelopSettings("raw-apple.d8.p1.e1.cal-none"),
      look: "niho-interim-1",
      exposure: 0.4,
      hsl: { red: 1 },
    });
    expect(developSettingsOnWorkingCopy(null, "raster.ci1.p1.e1.icc-srgb")).toEqual(neutralDevelopSettings("raster.ci1.p1.e1.icc-srgb"));
    expect(developSettingsOnWorkingCopy(null, "raw-apple.d8.p1.e1.cal-none").look).toBe("niho-standard-1");
  });

  it("未保存なら raster の作業コピーは niho-10、unsigned RAW の作業コピー・版の分からない作業コピーは niho-2 で初期化する", () => {
    expect(developSettingsOnWorkingCopy(null, "raster.ci1.p1.e1.icc-srgb")).toMatchObject({
      engine: "niho-10",
      look: "niho-standard-1",
      base: "raster.ci1.p1.e1.icc-srgb",
    });
    expect(developSettingsOnWorkingCopy(null, "raster.ci2.p2.e2.icc-srgb", { kind: "raster", encoding: "jpeg8" }).engine).toBe(
      "niho-10",
    );
    expect(developSettingsOnWorkingCopy(null, "raw-apple.d8.p1.e1.cal-none", { kind: "raw" })).toMatchObject({
      engine: "niho-2",
      base: "raw-apple.d8.p1.e1.cal-none",
    });
    expect(developSettingsOnWorkingCopy(null, "fixture-base").engine).toBe("niho-2");
  });

  it("保存済みの niho-6 は raster の作業コピーの上でだけ開き、RAW・signed・版の分からない作業コピーと描けないルックは engine_mismatch（#18397）", () => {
    const raster = "raster.ci2.p2.e2.icc-srgb";
    const direct: DevelopSettings = { ...neutralDevelopSettings(null), exposure: 0.4 };
    expect(developSettingsOnWorkingCopy(direct, raster)).toEqual({ ...direct, base: raster });
    expect(developSettingsOnWorkingCopy({ ...direct, look: "niho-interim-1" }, raster).look).toBe("niho-interim-1");
    const { look: _look, ...noLook } = direct;
    expect(developSettingsOnWorkingCopy(noLook, raster)).toMatchObject({ engine: "niho-10", look: "niho-interim-1" });
    expect(developSettingsOnWorkingCopy({ ...direct, engine: "niho-6" }, raster).engine).toBe("niho-6");

    const mismatch = (run: () => unknown) => {
      try {
        run();
      } catch (error) {
        return error instanceof DevelopSettingsBaseMismatchError ? error.reason : error;
      }
      return null;
    };
    expect(mismatch(() => developSettingsOnWorkingCopy(direct, "raw-apple.d8.p1.e1.cal-none"))).toBe("engine_mismatch");
    expect(mismatch(() => developSettingsOnWorkingCopy({ ...direct, base: "raw-apple.d8.p1.e1.cal-none" }, "raw-apple.d8.p1.e1.cal-none")))
      .toBe("engine_mismatch");
    expect(mismatch(() => developSettingsOnWorkingCopy(direct, "fixture-base"))).toBe("engine_mismatch");
    const signedBase = "raw-apple.d8.p3.e4.cal-signed";
    const signedMeta = { kind: "raw", encoding: { kind: "signed-gamma18-v1", ceiling: 2 } };
    expect(mismatch(() => developSettingsOnWorkingCopy(direct, signedBase, signedMeta))).toBe("engine_mismatch");
    expect(mismatch(() => developSettingsOnWorkingCopy({ ...direct, look: "niho-standard-2" }, raster))).toBe("engine_mismatch");
    expect(mismatch(() => developSettingsOnWorkingCopy({ ...direct, look: "niho-standard-3" }, raster))).toBe("engine_mismatch");
    // 保存済みの niho-2 は RAW の上でも raster の上でも niho-2 のまま（数式を変えない）
    const legacy = { ...direct, engine: "niho-2" };
    expect(developSettingsOnWorkingCopy(legacy, raster).engine).toBe("niho-2");
    expect(developSettingsOnWorkingCopy(legacy, "raw-apple.d8.p1.e1.cal-none").engine).toBe("niho-2");
  });

  it("signed RAWはbaseとmetadataと niho-3/standard-2 の組だけを開く", () => {
    const base = "raw-apple.d8.p3.e4.cal-signed";
    const meta = { kind: "raw", encoding: { kind: "signed-gamma18-v1", ceiling: 2 } };
    expect(developSettingsOnWorkingCopy(null, base, meta)).toMatchObject({
      engine: "niho-3",
      look: "niho-standard-2",
      base,
    });
    const saved = { ...neutralDevelopSettings(base), engine: "niho-3", look: "niho-standard-2", colorNoiseReduction: 31 };
    expect(developSettingsOnWorkingCopy(saved, base, meta)).toEqual(saved);
    expect(() => developSettingsOnWorkingCopy(saved, base)).toThrow(DevelopSettingsBaseMismatchError);
    expect(() => developSettingsOnWorkingCopy(neutralDevelopSettings(base), base, meta)).toThrow(DevelopSettingsBaseMismatchError);
  });

  it("対応校正の未保存signedだけniho-11へ初期化し、保存済みniho-3/niho-4/niho-7を維持する", () => {
    const base = "raw-apple.d8.p3.e4.cal-panasonic-dc-s5-apple-v4.lens-apple";
    const meta = { kind: "raw", encoding: { kind: "signed-gamma18-v1", ceiling: 2 },
      dcpSha256: "apple-ciraw8/linear-prophoto-d50/cal-panasonic-dc-s5-apple-v4" };
    expect(developSettingsOnWorkingCopy(null, base, meta)).toMatchObject({ engine: "niho-11", look: "niho-standard-5" });
    const saved = { ...neutralDevelopSettings(base), engine: "niho-3", look: "niho-standard-2" };
    expect(developSettingsOnWorkingCopy(saved, base, meta)).toEqual(saved);
    const savedNiho4 = { ...saved, engine: "niho-4", look: "niho-standard-3" };
    expect(developSettingsOnWorkingCopy(savedNiho4, base, meta)).toEqual(savedNiho4);
    const savedNiho7 = { ...saved, engine: "niho-7", look: "niho-standard-5" };
    expect(developSettingsOnWorkingCopy(savedNiho7, base, meta)).toEqual(savedNiho7);
    expect(developSettingsOnWorkingCopy(null, base, { ...meta, dcpSha256: "cal-unknown" })).toMatchObject({ engine: "niho-3" });
    expect(() => developSettingsOnWorkingCopy({ ...saved, engine: "niho-4", look: "niho-standard-3" }, base,
      { ...meta, dcpSha256: "cal-unknown" })).toThrow(DevelopSettingsBaseMismatchError);
    expect(isEditableDevelopSettings({ v: 1, engine: "niho-4", look: "niho-standard-3" })).toBe(true);
    expect(isEditableDevelopSettings({ v: 1, engine: "niho-7", look: "niho-standard-5" })).toBe(true);
    expect(isEditableDevelopSettings({ v: 1, engine: "niho-11", look: "niho-standard-5" })).toBe(true);
    expect(() => developSettingsOnWorkingCopy({ ...saved, engine: "niho-7", look: "niho-standard-5" }, base,
      { ...meta, dcpSha256: "cal-unknown" })).toThrow(DevelopSettingsBaseMismatchError);
    for (const [otherBase, otherMeta] of [
      ["raster.ci2.p2.e2.icc-srgb", { kind: "raster", encoding: "jpeg8" }],
      ["camera-linear.v1", null],
    ] as const) {
      expect(() => developSettingsOnWorkingCopy({ ...saved, engine: "niho-7", look: "niho-standard-5", base: otherBase },
        otherBase, otherMeta)).toThrow(DevelopSettingsBaseMismatchError);
    }
  });

  it("signed metadataはRust readerと同じexact encodingを必須にし、legacy RAWとraster jpeg8だけをunsignedで保つ", () => {
    const signedBase = "raw-apple.d8.p3.e4.cal-signed";
    expect(signedWorkingCopyState(signedBase, { kind: "raw", encoding: { kind: "signed-gamma18-v1", ceiling: 2 } })).toBe(
      "signed",
    );
    for (const encoding of [
      { kind: "signed-gamma18-v1" },
      { kind: "signed-gamma18-v1", ceiling: 3 },
      { kind: "signed-gamma18-v1", ceiling: 2, extra: true },
      { kind: "future", ceiling: 2 },
    ]) {
      expect(signedWorkingCopyState(signedBase, { kind: "raw", encoding })).toBe("mismatch");
    }
    expect(signedWorkingCopyState("raw-apple.d8.p0.e1.cal-none", { kind: "raw" })).toBe("unsigned");
    expect(signedWorkingCopyState("raw-apple.d8.p2.e1.cal-none", { kind: "raw", encoding: null })).toBe("unsigned");
    expect(signedWorkingCopyState("raster.ci2.p2.e2.icc-srgb", { kind: "raster", encoding: "jpeg8" })).toBe("unsigned");
    expect(signedWorkingCopyState("raw-apple.d8.p2.e9.cal-future", { kind: "raw" })).toBe("mismatch");
    expect(signedWorkingCopyState("raw-apple.d8.p2.e1.cal-none", { kind: "raw", encoding: "jpeg8" })).toBe("mismatch");
    expect(signedWorkingCopyState("fixture-base", null)).toBe("unsigned");
  });

  it("ルックを持たない保存済みの編集内容は恒等のルック（crate の既定と同じ）で続ける", () => {
    expect(developSettingsOnWorkingCopy({ v: 1, engine: "niho-1", exposure: 0.2 }, "raw-apple.d8.p1.e1.cal-none")).toEqual({
      v: 1,
      engine: "niho-1",
      look: "niho-interim-1",
      base: "raw-apple.d8.p1.e1.cal-none",
      exposure: 0.2,
    });
  });
});

describe("isEditableDevelopSettings", () => {
  it("まだ無いか、v1〜v4 で既知の数式なら直せる（未知の版・必要版より低い値は直さない）", () => {
    expect(isEditableDevelopSettings(null)).toBe(true);
    expect(isEditableDevelopSettings(undefined)).toBe(true);
    expect(isEditableDevelopSettings({ v: 1, engine: "niho-1" })).toBe(true);
    expect(isEditableDevelopSettings({ v: 2, engine: "niho-1", geometry: CROP })).toBe(true);
    expect(isEditableDevelopSettings({ v: 2, engine: "niho-1" })).toBe(true);
    expect(isEditableDevelopSettings({ v: 1, engine: "niho-2" })).toBe(true);
    expect(isEditableDevelopSettings({ v: 1, engine: "niho-3" })).toBe(false);
    expect(isEditableDevelopSettings({ v: 1, engine: "niho-3", look: "niho-standard-2" })).toBe(true);
    expect(isEditableDevelopSettings({ v: 3, engine: "niho-1" })).toBe(true);
    expect(isEditableDevelopSettings({ v: 2, engine: "niho-1", grayscale: true })).toBe(false);
    expect(isEditableDevelopSettings({ v: 3, engine: "niho-1", grayscale: true })).toBe(true);
    expect(isEditableDevelopSettings({ v: 4, engine: "niho-1", colorPoints: [] })).toBe(true);
    expect(isEditableDevelopSettings({ v: 5, engine: "niho-1" })).toBe(false);
    expect(isEditableDevelopSettings({ v: 1, engine: "niho-1", geometry: CROP })).toBe(false);
    expect(isEditableDevelopSettings("niho-1")).toBe(false);
  });

  it("niho-6 / niho-10 は raster ルックだけ、niho-7 / niho-11 は standard-5 だけを直せる", () => {
    expect(isEditableDevelopSettings(neutralDevelopSettings())).toBe(true);
    expect(isEditableDevelopSettings({ v: 1, engine: "niho-6" })).toBe(true);
    expect(isEditableDevelopSettings({ v: 1, engine: "niho-6", look: "niho-standard-1" })).toBe(true);
    expect(isEditableDevelopSettings({ v: 1, engine: "niho-6", look: "niho-interim-1" })).toBe(true);
    expect(isEditableDevelopSettings({ v: 2, engine: "niho-6", look: "niho-standard-1", geometry: CROP })).toBe(true);
    expect(isEditableDevelopSettings({ v: 3, engine: "niho-6", grayscale: true })).toBe(true);
    expect(isEditableDevelopSettings({ v: 1, engine: "niho-6", look: "niho-standard-2" })).toBe(false);
    expect(isEditableDevelopSettings({ v: 1, engine: "niho-6", look: "niho-standard-3" })).toBe(false);
    expect(isEditableDevelopSettings({ v: 1, engine: "niho-6", look: "niho-standard-9" })).toBe(false);
    expect(isEditableDevelopSettings({ v: 1, engine: "niho-6", look: null })).toBe(false);
    expect(isEditableDevelopSettings({ v: 1, engine: "niho-10", look: "niho-standard-1" })).toBe(true);
    expect(isEditableDevelopSettings({ v: 1, engine: "niho-5" })).toBe(false);
    expect(isEditableDevelopSettings({ v: 1, engine: "niho-7" })).toBe(false);
    expect(isEditableDevelopSettings({ v: 1, engine: "niho-7", look: "niho-standard-5" })).toBe(true);
    expect(isEditableDevelopSettings({ v: 1, engine: "niho-7", look: "niho-standard-3" })).toBe(false);
    expect(isEditableDevelopSettings({ v: 1, engine: "niho-11", look: "niho-standard-5" })).toBe(true);
    expect(isEditableDevelopSettings({ v: 1, engine: "niho-11", look: "niho-standard-3" })).toBe(false);
    expect(isEditableDevelopSettings({ v: 1, engine: "niho-4", look: "niho-standard-5" })).toBe(false);
    expect(isEditableDevelopSettings({ v: 1, engine: "niho-10", look: "niho-standard-5" })).toBe(false);
  });

  it("幾何を扱えない面（NIHO Desktop）は、幾何のある設定を直さない（幾何の無い v1 / v2 は直せる）", () => {
    expect(isEditableDevelopSettings({ v: 2, engine: "niho-1", geometry: CROP }, { geometry: false })).toBe(false);
    expect(isEditableDevelopSettings({ v: 1, engine: "niho-1" }, { geometry: false })).toBe(true);
    expect(isEditableDevelopSettings({ v: 1, engine: "niho-1", geometry: { aspect: "1:1" } }, { geometry: false })).toBe(true);
    expect(isEditableDevelopSettings(null, { geometry: false })).toBe(true);
  });

  it("ルックはこの画面の知っている版（niho-interim-1・niho-standard-1）か、無いときだけ直せる", () => {
    expect(isEditableDevelopSettings({ v: 1, engine: "niho-1", look: "niho-interim-1" })).toBe(true);
    expect(isEditableDevelopSettings({ v: 1, engine: "niho-1", look: "niho-standard-1" })).toBe(true);
    expect(isEditableDevelopSettings({ v: 2, engine: "niho-1", geometry: CROP, look: "niho-standard-1" })).toBe(true);
    expect(isEditableDevelopSettings({ v: 1, engine: "niho-1", look: "niho-standard-2" })).toBe(false);
    expect(isEditableDevelopSettings({ v: 2, engine: "niho-1", geometry: CROP, look: "niho-standard-2" })).toBe(false);
    expect(isEditableDevelopSettings({ v: 1, engine: "niho-1", look: 1 })).toBe(false);
  });

  it("readDevelopSettings は v1〜v4 の形だけを読む（形の版はそのまま）", () => {
    expect(readDevelopSettings({ v: 1, engine: "niho-1", exposure: 1 })).toEqual({ v: 1, engine: "niho-1", exposure: 1 });
    expect(readDevelopSettings({ v: 2, engine: "niho-1", geometry: CROP })).toEqual({ v: 2, engine: "niho-1", geometry: CROP });
    expect(readDevelopSettings({ v: 3, engine: "niho-1", grayscale: true })).toEqual({ v: 3, engine: "niho-1", grayscale: true });
    expect(readDevelopSettings({ v: 4, engine: "niho-1", colorPoints: [] })).toEqual({ v: 4, engine: "niho-1", colorPoints: [] });
    expect(readDevelopSettings({ v: 1 })).toBeNull();
    expect(readDevelopSettings(null)).toBeNull();
  });
});

describe("幾何（回転・反転・角度補正・切り抜き。#17138）", () => {
  it("hasDevelopGeometry は crate の is_identity と同じ（半回転＋両方の反転・縦横比だけは恒等、壊れた値は恒等でない）", () => {
    expect(hasDevelopGeometry({ v: 1 })).toBe(false);
    expect(hasDevelopGeometry({ geometry: null })).toBe(false);
    expect(hasDevelopGeometry({ geometry: {} })).toBe(false);
    expect(hasDevelopGeometry({ geometry: { aspect: "4:5" } })).toBe(false);
    expect(hasDevelopGeometry({ geometry: { rotate: 180, flipH: true, flipV: true } })).toBe(false);
    expect(hasDevelopGeometry({ geometry: { crop: { left: 0, top: 0, right: 1, bottom: 1 } } })).toBe(false);
    expect(hasDevelopGeometry({ geometry: { rotate: 180 } })).toBe(true);
    expect(hasDevelopGeometry({ geometry: { flipV: true } })).toBe(true);
    expect(hasDevelopGeometry({ geometry: { angle: 0.5 } })).toBe(true);
    expect(hasDevelopGeometry({ geometry: { crop: { right: 0.9 } } })).toBe(true);
    expect(hasDevelopGeometry({ geometry: "crop" })).toBe(true);
    expect(developSettingsVersion({ geometry: CROP })).toBe(2);
    expect(developSettingsVersion({ geometry: { aspect: "1:1" } })).toBe(1);
    expect(developSettingsVersion({ grayscale: true })).toBe(3);
    expect(developSettingsVersion({ geometry: CROP, grain: { amount: 1 } })).toBe(3);
    expect(hasNullDevelopGeometryField({ geometry: { rotate: null } })).toBe(true);
    expect(hasNullDevelopGeometryField({ geometry: { crop: { left: null } } })).toBe(true);
    expect(hasNullDevelopGeometryField({ geometry: { aspect: null } })).toBe(false);
  });

  it("スライダーの値を重ねても、幾何と v2 を保つ（幾何を外せば v1 に戻る）", () => {
    const cropped = { ...neutralDevelopSettings(), v: 2 as const, geometry: CROP };
    const next = applyBrowserAdjustmentsToDevelopSettings(cropped, { ...NEUTRAL_BROWSER_PHOTO_ADJUSTMENTS, exposure: 0.5 });
    expect(next).toMatchObject({ v: 2, geometry: CROP, exposure: 0.5 });
    const uncropped = applyBrowserAdjustmentsToDevelopSettings(
      { ...cropped, geometry: { aspect: "1:1" } },
      NEUTRAL_BROWSER_PHOTO_ADJUSTMENTS,
    );
    expect(uncropped.v).toBe(1);
  });

  it("「初期化」は色だけを neutral に戻し、幾何と v2 を保つ（幾何が無ければ neutral そのもの）", () => {
    const cropped = { ...neutralDevelopSettings("raw-1"), v: 2 as const, exposure: 0.8, geometry: CROP };
    expect(resetDevelopSettingsColors(cropped, "raw-2")).toEqual({ ...neutralDevelopSettings("raw-2"), v: 2, geometry: CROP });
    expect(resetDevelopSettingsColors({ ...neutralDevelopSettings(), exposure: 0.8, geometry: { aspect: "4:5" } }, null)).toEqual({
      ...neutralDevelopSettings(),
      geometry: { aspect: "4:5" },
    });
    expect(resetDevelopSettingsColors({ ...neutralDevelopSettings(), exposure: 0.8 }, null)).toEqual(neutralDevelopSettings());
    expect(resetDevelopSettingsColors(null, null)).toEqual(neutralDevelopSettings());
    expect(resetDevelopSettingsColors({ ...cropped, engine: "niho-1" }, "raw-2")).toEqual({
      ...neutralDevelopSettings("raw-2"), engine: "niho-1", v: 2, geometry: CROP,
    });
    expect(resetDevelopSettingsColors({ ...neutralDevelopSettings(), engine: "niho-1", exposure: 0.8 }, null).engine).toBe("niho-1");
    expect(resetDevelopSettingsColors({ v: 1, engine: "niho-1", exposure: 0.8 }, null)).not.toHaveProperty("look");
  });

  it("「初期化」は今の数式を保ち、今の編集内容が無ければ base の neutral と同じ数式にする（#18397）", () => {
    expect(resetDevelopSettingsColors(null, null).engine).toBe("niho-10");
    expect(resetDevelopSettingsColors(null, "raster.ci2.p2.e2.icc-srgb")).toEqual(neutralDevelopSettings("raster.ci2.p2.e2.icc-srgb"));
    expect(resetDevelopSettingsColors(null, "raw-apple.d8.p1.e1.cal-none")).toMatchObject({
      engine: "niho-2",
      base: "raw-apple.d8.p1.e1.cal-none",
    });
    // 保存済みの niho-2 の写真を初期化しても niho-6 にしない
    expect(resetDevelopSettingsColors({ ...neutralDevelopSettings(), engine: "niho-2", exposure: 0.8 }, null)).toEqual({
      ...neutralDevelopSettings(),
      engine: "niho-2",
    });
    expect(resetDevelopSettingsColors({ ...neutralDevelopSettings("raster.x"), exposure: 0.8 }, "raster.x").engine).toBe("niho-10");
  });

  it("切り抜いただけの写真は neutral ではない（オリジナルのままでは見せられない）が、色は neutral（初期化を押せない）", () => {
    const cropped = { ...neutralDevelopSettings(), v: 2 as const, geometry: CROP };
    expect(isNeutralDevelopSettings(cropped)).toBe(false);
    expect(isNeutralDevelopColors(cropped)).toBe(true);
    expect(isNeutralDevelopColors({ ...cropped, exposure: 0.1 })).toBe(false);
    expect(isNeutralDevelopSettings({ ...neutralDevelopSettings(), geometry: { aspect: "1:1" } })).toBe(true);
  });
});

describe("スライダーと編集内容の写し", () => {
  it("露光量・コントラスト・彩度は同名、色温度 / 色かぶり補正は相対の値として読む（範囲の外は丸める）", () => {
    expect(
      readBrowserAdjustmentsFromDevelopSettings({
        v: 1,
        engine: "niho-1",
        exposure: 0.5,
        contrast: 20,
        saturation: -10,
        relativeTemperature: 30,
        relativeTint: -300,
        highlights: 40,
      }),
    ).toEqual({ exposure: 0.5, contrast: 20, saturation: -10, temperature: 30, tint: -100 });
    expect(readBrowserAdjustmentsFromDevelopSettings(null)).toEqual(NEUTRAL_BROWSER_PHOTO_ADJUSTMENTS);
  });

  it("土台が無ければ neutral に重ねる", () => {
    expect(
      applyBrowserAdjustmentsToDevelopSettings(null, { exposure: 1, contrast: 10, saturation: 5, temperature: 0, tint: 0 }),
    ).toEqual({ ...neutralDevelopSettings(), exposure: 1, contrast: 10, saturation: 5 });
  });

  it("土台の知らない項目（HSL など）・ルック・base は残す", () => {
    const base = {
      v: 1 as const,
      engine: "niho-1",
      look: "niho-standard-1",
      base: "raw-1",
      hsl: ["green", { hue: 10, saturation: 0, luminance: 0 }],
      highlights: -20,
      whiteBalance: { mode: "asShot" },
    };
    const next = applyBrowserAdjustmentsToDevelopSettings(base, { ...NEUTRAL_BROWSER_PHOTO_ADJUSTMENTS, exposure: 0.3 });
    expect(next).toMatchObject({
      v: 1,
      engine: "niho-1",
      look: "niho-standard-1",
      base: "raw-1",
      hsl: base.hsl,
      highlights: -20,
      exposure: 0.3,
      whiteBalance: { mode: "asShot" },
    });
  });

  it("look・base が無い土台には暫定ルックと base: null を足す", () => {
    const next = applyBrowserAdjustmentsToDevelopSettings({ v: 1, engine: "niho-1" }, NEUTRAL_BROWSER_PHOTO_ADJUSTMENTS);
    expect(next.look).toBe("niho-interim-1");
    expect(next.base).toBeNull();
    expect(next.whiteBalance).toEqual({ mode: "asShot" });
  });

  it("相対の色温度 / 色かぶり補正を動かしたら whiteBalance.mode を relative、両方 0 に戻したら asShot", () => {
    const warmed = applyBrowserAdjustmentsToDevelopSettings(null, { ...NEUTRAL_BROWSER_PHOTO_ADJUSTMENTS, temperature: 25 });
    expect(warmed).toMatchObject({ relativeTemperature: 25, relativeTint: 0, whiteBalance: { mode: "relative" } });

    const tinted = applyBrowserAdjustmentsToDevelopSettings(warmed, { ...NEUTRAL_BROWSER_PHOTO_ADJUSTMENTS, tint: -5 });
    expect(tinted).toMatchObject({ relativeTemperature: 0, relativeTint: -5, whiteBalance: { mode: "relative" } });

    const back = applyBrowserAdjustmentsToDevelopSettings(tinted, NEUTRAL_BROWSER_PHOTO_ADJUSTMENTS);
    expect(back.whiteBalance).toEqual({ mode: "asShot" });
    expect(isNeutralDevelopSettings(back)).toBe(true);
    const legacy = applyBrowserAdjustmentsToDevelopSettings(
      { ...neutralDevelopSettings(), engine: "niho-1" },
      { ...NEUTRAL_BROWSER_PHOTO_ADJUSTMENTS, temperature: 25 },
    );
    expect(legacy.engine).toBe("niho-1");
  });

  it("相対の値が 0 のままなら、土台の白（absolute など）は変えない", () => {
    const base = { v: 1 as const, engine: "niho-1", whiteBalance: { mode: "absolute", temperature: 5200, tint: 3 } };
    expect(applyBrowserAdjustmentsToDevelopSettings(base, { ...NEUTRAL_BROWSER_PHOTO_ADJUSTMENTS, exposure: 1 }).whiteBalance).toEqual(
      base.whiteBalance,
    );
  });
});

describe("isNeutralDevelopSettings", () => {
  it("無ければ neutral。版の情報と既定値の項目（パラメトリックの区切り・curveRefineSaturation 100）は数えない", () => {
    expect(isNeutralDevelopSettings(null)).toBe(true);
    expect(
      isNeutralDevelopSettings({
        ...neutralDevelopSettings(),
        look: "niho-standard-1",
        base: "raw-1",
        parametricShadowSplit: 25,
        parametricMidtoneSplit: 50,
        parametricHighlightSplit: 75,
        curveRefineSaturation: 100,
        toneCurves: [],
      }),
    ).toBe(true);
  });

  it("値が 0 でない・既定と違う区切り・変換できなかった値・知らない項目があれば neutral でない", () => {
    expect(isNeutralDevelopSettings({ ...neutralDevelopSettings(), exposure: 0.1 })).toBe(false);
    expect(isNeutralDevelopSettings({ ...neutralDevelopSettings(), parametricShadowSplit: 30 })).toBe(false);
    expect(isNeutralDevelopSettings({ ...neutralDevelopSettings(), legacySettings: { exposure: 0 } })).toBe(false);
    expect(isNeutralDevelopSettings({ ...neutralDevelopSettings(), mystery: 1 })).toBe(false);
  });

  it("whiteBalance.mode が relative でも相対の値が 0 なら neutral", () => {
    expect(isNeutralDevelopSettings({ ...neutralDevelopSettings(), whiteBalance: { mode: "relative" } })).toBe(true);
    expect(
      isNeutralDevelopSettings({ ...neutralDevelopSettings(), whiteBalance: { mode: "relative" }, relativeTint: 3 }),
    ).toBe(false);
    expect(isNeutralDevelopSettings({ ...neutralDevelopSettings(), whiteBalance: { mode: "absolute" } })).toBe(false);
  });
});

describe("効果（白黒・周辺光量補正・粒子。E1b #17134）", () => {
  it("白黒だけオン・周辺光量補正だけ・粒子だけ、のどれでも neutral でない（「初期化」を押せる）", () => {
    const gray: DevelopSettings = { ...neutralDevelopSettings(), grayscale: true };
    const vignette: DevelopSettings = { ...neutralDevelopSettings(), vignette: { amount: -20 } };
    const grain: DevelopSettings = { ...neutralDevelopSettings(), grain: { amount: 15 } };
    for (const settings of [gray, vignette, grain]) {
      expect(isNeutralDevelopColors(settings)).toBe(false);
      expect(isNeutralDevelopSettings(settings)).toBe(false);
    }
  });

  it("画に効いていない効果の項目は neutral のまま（crate の is_neutral と同じ）。形の壊れた値は neutral にしない", () => {
    const inactive: DevelopSettings = {
      ...neutralDevelopSettings(),
      grayscale: false,
      grayMixer: { red: 40, blue: -25.5 },
      vignette: { amount: 0, midpoint: 40, style: "paintOverlay" },
      grain: { amount: 0, size: 60, roughness: 50 },
    };
    expect(isNeutralDevelopColors(inactive)).toBe(true);
    expect(isNeutralDevelopColors({ ...neutralDevelopSettings(), vignette: { midpoint: 40 }, grain: { size: 60 } })).toBe(true);
    // 白黒がオンなら、ミックスの有無によらず neutral でない
    expect(isNeutralDevelopColors({ ...inactive, grayscale: true })).toBe(false);
    expect(isNeutralDevelopColors({ ...neutralDevelopSettings(), grayscale: 1 })).toBe(false);
    expect(isNeutralDevelopColors({ ...neutralDevelopSettings(), grayscale: null })).toBe(false);
    expect(isNeutralDevelopColors({ ...neutralDevelopSettings(), grayMixer: { red: "40" } })).toBe(false);
    expect(isNeutralDevelopColors({ ...neutralDevelopSettings(), vignette: 20 })).toBe(false);
    expect(isNeutralDevelopColors({ ...neutralDevelopSettings(), vignette: { amount: null } })).toBe(false);
    expect(isNeutralDevelopColors({ ...neutralDevelopSettings(), grain: [] })).toBe(false);
  });

  it("「初期化」と「補正前」は効果も外し、幾何と v2 を保つ", () => {
    const edited: DevelopSettings = {
      ...neutralDevelopSettings("raw-1"),
      v: 2,
      geometry: CROP,
      grayscale: true,
      grayMixer: { red: 40 },
      vignette: { amount: -20 },
      grain: { amount: 15, size: 40 },
    };
    const reset = resetDevelopSettingsColors(edited, "raw-1");
    expect(reset).toEqual({ ...neutralDevelopSettings("raw-1"), v: 2, geometry: CROP });
    expect(isNeutralDevelopColors(reset)).toBe(true);
    for (const key of ["grayscale", "grayMixer", "vignette", "grain"]) expect(Object.hasOwn(reset, key)).toBe(false);
  });
});

// K1c 移行元設計: 補正の置き場は developSettings の 1 つ。旧エンジン（Photo Bench）の settings・その保存日時は見ない
describe("hasSavedDevelopSettings", () => {
  const developed = { ...neutralDevelopSettings(), exposure: 0.5 };

  it("developSettings があれば true、保存したことが無ければ（null・項目なし）false", () => {
    expect(hasSavedDevelopSettings({ developSettings: developed })).toBe(true);
    expect(hasSavedDevelopSettings({ developSettings: null })).toBe(false);
    expect(hasSavedDevelopSettings({})).toBe(false);
    // 形の壊れた値（オブジェクトでない）は補正として読まない
    expect(hasSavedDevelopSettings({ developSettings: [developed] })).toBe(false);
    expect(hasSavedDevelopSettings({ developSettings: "niho-1" })).toBe(false);
  });

  it("neutral かどうかは見ない（「初期化」も保存した補正）。古い API が返す旧エンジンの項目があっても結果は変わらない", () => {
    expect(hasSavedDevelopSettings({ developSettings: neutralDevelopSettings() })).toBe(true);
    const legacyFields = { hasSettings: true, settingsUpdatedAt: "2026-09-28T02:00:00.000Z" };
    expect(hasSavedDevelopSettings({ ...legacyFields, developSettings: developed })).toBe(true);
    expect(hasSavedDevelopSettings({ ...legacyFields, developSettings: null })).toBe(false);
  });
});

describe("developSettingsToEditSettings（crate の to_edit_settings_value と同じ規則）", () => {
  it("効いている効果（白黒・周辺光量補正・粒子）のある補正は写さない（落として色つきで出さない）。効いていない効果は落として写す", () => {
    const base = { v: 1, engine: "niho-1", exposure: 0.5 };
    expect(developSettingsToEditSettings({ ...base, grayscale: true })).toBeNull();
    expect(developSettingsToEditSettings({ ...base, vignette: { amount: -20 } })).toBeNull();
    expect(developSettingsToEditSettings({ ...base, grain: { amount: 30 } })).toBeNull();
    expect(
      developSettingsToEditSettings({ ...base, grayscale: false, grayMixer: { red: 10 }, vignette: { amount: 0 }, grain: { amount: 0, size: 40 } }),
    ).toEqual({ exposure: 0.5, whiteBalance: { mode: "asShot" } });
  });

  it("版の情報と知らない項目を落とし、相対の白は asShot にして相対の値を残す", () => {
    expect(
      developSettingsToEditSettings({
        ...neutralDevelopSettings(),
        exposure: 0.5,
        highlights: -20,
        relativeTemperature: 12,
        relativeTint: -3,
        whiteBalance: { mode: "relative" },
        toneCurves: [{ channel: "master", points: [[0, 0], [1, 1]] }],
        hsl: ["green", { hue: 10, saturation: 0, luminance: 0 }],
        parametricShadowSplit: 25,
        mystery: 1,
      }),
    ).toEqual({
      exposure: 0.5,
      contrast: 0,
      saturation: 0,
      highlights: -20,
      relativeTemperature: 12,
      relativeTint: -3,
      toneCurves: [{ channel: "master", points: [[0, 0], [1, 1]] }],
      hsl: ["green", { hue: 10, saturation: 0, luminance: 0 }],
      parametricShadowSplit: 25,
      whiteBalance: { mode: "asShot" },
    });
  });

  it("absolute の白は custom（温度・色かぶりの有限数を添える）", () => {
    expect(
      developSettingsToEditSettings({
        v: 1,
        engine: "niho-1",
        base: null,
        whiteBalance: { mode: "absolute", temperature: 5200, tint: 3 },
      }),
    ).toEqual({ whiteBalance: { mode: "custom", temperature: 5200, tint: 3 } });
    expect(developSettingsToEditSettings({ v: 1, engine: "niho-1" })).toEqual({ whiteBalance: { mode: "asShot" } });
  });

  it("作業コピーの上で直した補正（base がある RAW など。#16944）も base・look を落として戻す（Desktop は自分の土台で描く）", () => {
    expect(
      developSettingsToEditSettings({
        ...neutralDevelopSettings("raw-apple.d8.p1.e1.cal-none"),
        exposure: 0.7,
        relativeTint: 4,
        whiteBalance: { mode: "relative" },
      }),
    ).toEqual({
      exposure: 0.7,
      contrast: 0,
      saturation: 0,
      relativeTemperature: 0,
      relativeTint: 4,
      whiteBalance: { mode: "asShot" },
    });
  });

  it("変換できなかった値（legacySettings）・知らない版・幾何（切り抜きを落として写さない）は戻せない（null）", () => {
    expect(developSettingsToEditSettings({ ...neutralDevelopSettings(), legacySettings: { exposure: 9 } })).toBeNull();
    expect(
      developSettingsToEditSettings({ ...neutralDevelopSettings("raw-1"), legacySettings: { profile: "adobe" } }),
    ).toBeNull();
    expect(developSettingsToEditSettings({ v: 5, engine: "niho-1" })).toBeNull();
    expect(developSettingsToEditSettings({ ...neutralDevelopSettings(), v: 2, geometry: CROP })).toBeNull();
    expect(developSettingsToEditSettings({ v: 2, engine: "niho-1" })).toEqual({ whiteBalance: { mode: "asShot" } });
    expect(developSettingsToEditSettings(null)).toBeNull();
  });
});

describe("補正のコピーと貼り付け（F5a-2 #17140）", () => {
  const source: DevelopSettings = {
    ...neutralDevelopSettings("raw-1"),
    v: 2,
    look: "niho-interim-1",
    exposure: 0.8,
    contrast: 10,
    relativeTemperature: 12,
    whiteBalance: { mode: "relative" },
    hsl: { red: { hue: 5 } },
    geometry: CROP,
  };
  const copied = {
    exposure: 0.8,
    contrast: 10,
    saturation: 0,
    relativeTemperature: 12,
    relativeTint: 0,
    whiteBalance: { mode: "relative" },
    hsl: { red: { hue: 5 } },
  };

  it("コピーは色の補正（この画面が知らない項目も）を持ち、数式の版・ルック・土台の版・幾何は持たない", () => {
    expect(copyDevelopSettings(source)).toEqual(copied);
  });

  it("RAW の絶対のホワイトバランスは写さない（撮影時のまま・相対は写す）", () => {
    expect(copyDevelopSettings({ ...source, whiteBalance: { mode: "absolute", temperature: 5200, tint: 3 } })).not.toHaveProperty(
      "whiteBalance",
    );
    expect(copyDevelopSettings(neutralDevelopSettings()).whiteBalance).toEqual({ mode: "asShot" });
  });

  it("貼り付けは色の補正を写した全部に置き換え（写しに無い項目は neutral）、数式の版・ルック・土台の版は貼り付け先のまま", () => {
    const target: DevelopSettings = { ...neutralDevelopSettings(null), engine: "niho-2", saturation: -20, effects: { grain: 30 } };
    const pasted = pasteDevelopSettings(target, copyDevelopSettings(source));
    expect(pasted).toEqual({
      ...neutralDevelopSettings(null),
      engine: "niho-2",
      exposure: 0.8,
      contrast: 10,
      relativeTemperature: 12,
      whiteBalance: { mode: "relative" },
      hsl: { red: { hue: 5 } },
    });
    // 作業コピーの上で直す写真は、その土台の版のまま。ルックの無い古い設定はルック無しのまま
    expect(pasteDevelopSettings({ ...target, base: "raw-9" }, copied).base).toBe("raw-9");
    const { look: _look, ...noLook } = target;
    expect(pasteDevelopSettings(noLook, copied)).not.toHaveProperty("look");
    expect(pasteDevelopSettings({ ...target, engine: "niho-1" }, copied).engine).toBe("niho-1");
  });

  it("貼り付け先の幾何（切り抜き・回転）は保ち、形の版はその幾何から決め直す", () => {
    const cropped = pasteDevelopSettings({ ...neutralDevelopSettings(), v: 2, geometry: CROP }, copied);
    expect(cropped.geometry).toEqual(CROP);
    expect(cropped.v).toBe(2);
    // 写し元に幾何があっても、貼り付け先に無ければ付かない
    expect(pasteDevelopSettings(neutralDevelopSettings(), copyDevelopSettings(source))).not.toHaveProperty("geometry");
  });

  it("ホワイトバランスは、写しに無い（RAW の絶対値だった）・貼り付け先が絶対値なら、貼り付け先のまま", () => {
    const absolute = { mode: "absolute", temperature: 4800, tint: -2 };
    expect(
      pasteDevelopSettings(
        { ...neutralDevelopSettings("raw-2"), whiteBalance: absolute, relativeTemperature: 11, relativeTint: 4 },
        copied,
      ),
    ).toMatchObject({ whiteBalance: absolute, relativeTemperature: 11, relativeTint: 4 });
    const withoutWhiteBalance = copyDevelopSettings({ ...source, relativeTemperature: 0, whiteBalance: absolute });
    expect(
      pasteDevelopSettings(
        { ...neutralDevelopSettings(), whiteBalance: { mode: "relative" }, relativeTemperature: 3, relativeTint: -6 },
        withoutWhiteBalance,
      ),
    ).toMatchObject({ whiteBalance: { mode: "relative" }, relativeTemperature: 3, relativeTint: -6, exposure: 0.8 });
    // 貼り付け先にも無ければ付けない
    const { whiteBalance: _whiteBalance, ...bare } = neutralDevelopSettings();
    expect(pasteDevelopSettings(bare, withoutWhiteBalance)).not.toHaveProperty("whiteBalance");
  });

  it("貼り付け先の数式（niho-10 / RAW の作業コピーの niho-2）は写し元によらず保つ", () => {
    expect(pasteDevelopSettings(neutralDevelopSettings(), copied).engine).toBe("niho-10");
    expect(pasteDevelopSettings(neutralDevelopSettings("raw-apple.d8.p1.e1.cal-none"), copied)).toMatchObject({
      engine: "niho-2",
      base: "raw-apple.d8.p1.e1.cal-none",
    });
  });
});
