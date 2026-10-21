import { describe, expect, it } from "vitest";

import {
  DEVELOP_LENS_DEFAULT,
  hasActiveDevelopLens,
  isDefaultDevelopLens,
  readDevelopLens,
} from "./develop-engine/develop-lens";
import type { DevelopSettings } from "./develop-engine/develop-settings";
import { healFrameDevelopSettings } from "./photo-editing-heal";
import {
  hasPhotoEditingLensEdits,
  readPhotoEditingLens,
  readWorkingCopyLensProfile,
  resetPhotoEditingLens,
  withoutPhotoEditingLensWarp,
  writePhotoEditingLens,
  writePhotoEditingLensChromaticAberration,
} from "./photo-editing-lens";

const base: DevelopSettings = { v: 1, engine: "niho-13", look: "niho-standard-1", base: null, exposure: 0.2 };

describe("readDevelopLens（crate の parse_lens / validate_lens と同じ規則）", () => {
  it("欠けた項目は既定、無い・null は既定", () => {
    expect(readDevelopLens(undefined)).toEqual(DEVELOP_LENS_DEFAULT);
    expect(readDevelopLens(null)).toEqual(DEVELOP_LENS_DEFAULT);
    const lens = readDevelopLens({ distortion: -12, defringe: { green: { amount: 5 } } });
    expect(lens).toMatchObject({ distortion: -12, vignettingMidpoint: 50, removeChromaticAberration: false });
    expect(lens?.defringe.green).toEqual({ amount: 5, hueLo: 40, hueHi: 60 });
    expect(lens?.defringe.purple).toEqual({ amount: 0, hueLo: 30, hueHi: 70 });
    expect(readDevelopLens({ defringe: null })).toEqual(DEVELOP_LENS_DEFAULT);
  });

  it("知らないキー・数でない値・範囲外・色相の逆転は描けない形（null）", () => {
    for (const broken of [
      { foo: 1 },
      { distortion: "1" },
      { distortion: 100.5 },
      { vignetting: -101 },
      { vignettingMidpoint: -1 },
      { removeChromaticAberration: null },
      { defringe: { purple: { x: 1 } } },
      { defringe: { purple: null } },
      { defringe: { violet: {} } },
      { defringe: { green: { amount: 101 } } },
      { defringe: { green: { hueLo: 70, hueHi: 60 } } },
      { distortion: Number.NaN },
      [],
      "lens",
    ]) {
      expect(readDevelopLens(broken), JSON.stringify(broken)).toBeNull();
    }
  });

  it("画を変えるか・既定か", () => {
    expect(hasActiveDevelopLens({ lens: { vignettingMidpoint: 20 } })).toBe(false);
    expect(hasActiveDevelopLens({ lens: { defringe: { purple: { hueLo: 0 } } } })).toBe(false);
    expect(hasActiveDevelopLens({ lens: { vignetting: 1 } })).toBe(true);
    expect(hasActiveDevelopLens({ lens: { foo: 1 } })).toBe(true);
    expect(hasActiveDevelopLens({})).toBe(false);
    expect(isDefaultDevelopLens(readDevelopLens({ distortion: 0, vignettingMidpoint: 50 })!)).toBe(true);
    expect(isDefaultDevelopLens(readDevelopLens({ vignettingMidpoint: 51 })!)).toBe(false);
  });
});

describe("レンズの節の読み書き", () => {
  it("見せる値は範囲に収め、無い値は既定", () => {
    expect(readPhotoEditingLens(base)).toEqual({
      distortion: 0,
      vignetting: 0,
      vignettingMidpoint: 50,
      defringePurple: 0,
      defringeGreen: 0,
      removeChromaticAberration: false,
    });
    expect(
      readPhotoEditingLens({ ...base, lens: { distortion: 140, vignetting: "x", defringe: { green: { amount: 30 } } } }),
    ).toMatchObject({ distortion: 100, vignetting: 0, defringeGreen: 30 });
  });

  it("1 つの値だけを書き、整数に丸めて範囲に収め、形の版を決め直す", () => {
    const next = writePhotoEditingLens(base, "distortion", 12.4);
    expect(next.lens).toEqual({ distortion: 12 });
    expect(next.v).toBe(9);
    expect(next.exposure).toBe(0.2);
    const purple = writePhotoEditingLens(next, "defringePurple", 250);
    expect(purple.lens).toEqual({ distortion: 12, defringe: { purple: { amount: 100 } } });
    // フリンジの色相の範囲（XMP から入った値）は保つ
    const ranged = { ...base, v: 9, lens: { defringe: { green: { amount: 10, hueLo: 35, hueHi: 65 } } } } as DevelopSettings;
    expect(writePhotoEditingLens(ranged, "defringeGreen", 20).lens).toEqual({
      defringe: { green: { amount: 20, hueLo: 35, hueHi: 65 } },
    });
    // 中点だけは画を変えないので版を上げない
    const midpoint = writePhotoEditingLens(base, "vignettingMidpoint", 30);
    expect(midpoint.lens).toEqual({ vignettingMidpoint: 30 });
    expect(midpoint.v).toBe(1);
  });

  it("全部が既定になれば lens ごと消し、変わらなければ同じ参照を返す", () => {
    const next = writePhotoEditingLens(base, "vignetting", -40);
    const back = writePhotoEditingLens(next, "vignetting", 0);
    expect(back).not.toHaveProperty("lens");
    expect(back.v).toBe(1);
    expect(writePhotoEditingLens(next, "vignetting", -40)).toBe(next);
    expect(writePhotoEditingLens(next, "vignetting", Number.NaN)).toBe(next);
    expect(writePhotoEditingLens(base, "distortion", 0)).toBe(base);
  });

  it("色収差の除去を切り替える", () => {
    const on = writePhotoEditingLensChromaticAberration(base, true);
    expect(on.lens).toEqual({ removeChromaticAberration: true });
    expect(on.v).toBe(9);
    expect(writePhotoEditingLensChromaticAberration(on, true)).toBe(on);
    const off = writePhotoEditingLensChromaticAberration(on, false);
    expect(off).not.toHaveProperty("lens");
    expect(off.v).toBe(1);
  });

  it("初期化はレンズ補正の全部（中点・色相の範囲も）を外す。既定のときは押せない", () => {
    expect(hasPhotoEditingLensEdits(base)).toBe(false);
    const midpoint = { ...base, lens: { vignettingMidpoint: 20 } };
    expect(hasPhotoEditingLensEdits(midpoint)).toBe(true);
    expect(hasPhotoEditingLensEdits({ ...base, lens: { distortion: 0 } })).toBe(false);
    const edited = { ...base, v: 9, lens: { distortion: 5, defringe: { purple: { amount: 10, hueLo: 20, hueHi: 80 } } } } as DevelopSettings;
    const reset = resetPhotoEditingLens(edited);
    expect(reset).not.toHaveProperty("lens");
    expect(reset.v).toBe(1);
    expect(resetPhotoEditingLens(base)).toBe(base);
  });

  it("修復の道具の画は、画素を動かすレンズ補正（歪み・色収差）を外し、周辺光量・フリンジは残す", () => {
    const lensed = {
      ...base,
      v: 9,
      geometry: { rotate: 90, angle: 2 },
      lens: { distortion: 20, removeChromaticAberration: true, vignetting: 30, defringe: { purple: { amount: 10 } } },
    } as DevelopSettings;
    const frame = healFrameDevelopSettings(lensed);
    expect(frame.lens).toEqual({ distortion: 0, removeChromaticAberration: false, vignetting: 30, defringe: { purple: { amount: 10 } } });
    expect(frame.v).toBe(9);
    const plain = { ...base, v: 9, lens: { distortion: 20 } } as DevelopSettings;
    expect(withoutPhotoEditingLensWarp(plain)).not.toHaveProperty("lens");
    expect(withoutPhotoEditingLensWarp(base)).toBe(base);
  });
});

describe("作業コピーに焼き込まれたプロファイル補正", () => {
  const meta = (lensCorrection: unknown) => JSON.stringify({ kind: "raw", _source: { decoderVersion: "8", lensCorrection } });

  it("_source.lensCorrection.mode を読む（apple / embedded / none）", () => {
    expect(readWorkingCopyLensProfile(meta({ mode: "apple" }))).toBe("apple");
    expect(readWorkingCopyLensProfile(meta({ mode: "embedded", source: "sony" }))).toBe("embedded");
    expect(readWorkingCopyLensProfile(meta({ mode: "none", reason: "unsupported" }))).toBe("none");
  });

  it("作業コピーでない・読めない・無い・知らない値なら null（状態を出さない）", () => {
    expect(readWorkingCopyLensProfile(null)).toBeNull();
    expect(readWorkingCopyLensProfile(undefined)).toBeNull();
    expect(readWorkingCopyLensProfile("")).toBeNull();
    expect(readWorkingCopyLensProfile("{")).toBeNull();
    expect(readWorkingCopyLensProfile(JSON.stringify({ kind: "raster" }))).toBeNull();
    expect(readWorkingCopyLensProfile(meta({ mode: "off" }))).toBeNull();
    expect(readWorkingCopyLensProfile(meta("apple"))).toBeNull();
  });
});
