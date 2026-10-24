import { describe, expect, it } from "vitest";

import {
  hasPhotoEditingNativeExportUnsupportedSettings,
  photoEditingNativeExportBlockers,
  photoEditingNativeExportUnsupportedFailedText,
  photoEditingNativeExportUnsupportedText,
} from "./photo-editing-native-export";

const HEAL = [{ id: "a", mode: "remove", radius: 0.02, feather: 0.5, points: [[0.5, 0.5]] }];

describe("原寸の native renderer が描けない補正の判定", () => {
  it("補正が無い・描ける補正だけなら理由は無い", () => {
    expect(photoEditingNativeExportBlockers({})).toEqual([]);
    expect(photoEditingNativeExportBlockers({ exposure: 1, colorGrading: { shadow: { luminance: 20 } } })).toEqual([]);
    expect(hasPhotoEditingNativeExportUnsupportedSettings({ geometry: { angle: 3, crop: { left: 0.1, top: 0, right: 1, bottom: 1 } } })).toBe(
      false,
    );
  });

  it("中間調・全体の輝度・遠近・修復の印・画を変えるレンズ補正を、固定の順で返す", () => {
    expect(photoEditingNativeExportBlockers({ colorGrading: { midtone: { luminance: 1 } } })).toEqual(["colorGradingLuminance"]);
    expect(photoEditingNativeExportBlockers({ geometry: { perspective: { rotate: 1 } } })).toEqual(["perspective"]);
    expect(photoEditingNativeExportBlockers({ heal: HEAL })).toEqual(["heal"]);
    expect(photoEditingNativeExportBlockers({ lens: { vignetting: -10 } })).toEqual(["lens"]);
    expect(
      photoEditingNativeExportBlockers({
        lens: { distortion: 5 },
        heal: HEAL,
        geometry: { perspective: { x: 3 } },
        colorGrading: { global: { luminance: 5 } },
      }),
    ).toEqual(["colorGradingLuminance", "perspective", "heal", "lens"]);
  });

  it("恒等の遠近・空の修復・中点と色相の範囲だけのレンズ・余白を埋める / Upright だけは理由にしない", () => {
    expect(photoEditingNativeExportBlockers({ geometry: { perspective: { vertical: 0, scale: 100 }, constrain: true, upright: 2 } })).toEqual([]);
    expect(photoEditingNativeExportBlockers({ heal: [] })).toEqual([]);
    expect(photoEditingNativeExportBlockers({ lens: { vignettingMidpoint: 20, defringe: { purple: { hueLo: 20, hueHi: 80 } } } })).toEqual([]);
  });

  it("形の壊れた修復・遠近・レンズは、描けない設定として理由にする", () => {
    expect(photoEditingNativeExportBlockers({ heal: "x" })).toEqual(["heal"]);
    expect(photoEditingNativeExportBlockers({ geometry: { perspective: "x" } })).toEqual(["perspective"]);
    expect(photoEditingNativeExportBlockers({ lens: "x" })).toEqual(["lens"]);
  });

  it("文は、輝度だけ（または理由が無い）なら従来のまま、それ以外は名前を並べる", () => {
    expect(photoEditingNativeExportUnsupportedText([])).toBe("原寸は中間調・全体の輝度に未対応です");
    expect(photoEditingNativeExportUnsupportedText(["colorGradingLuminance"])).toBe("原寸は中間調・全体の輝度に未対応です");
    expect(photoEditingNativeExportUnsupportedText(["perspective"])).toBe("原寸は遠近に未対応です");
    expect(photoEditingNativeExportUnsupportedText(["perspective", "heal", "lens"])).toBe("原寸は遠近、修復、レンズ補正に未対応です");
    expect(photoEditingNativeExportUnsupportedFailedText([])).toBe("中間調・全体の輝度を使っている写真は、原寸で書き出せません。");
    expect(photoEditingNativeExportUnsupportedFailedText(["heal"])).toBe("修復を使っている写真は、原寸で書き出せません。");
    expect(photoEditingNativeExportUnsupportedFailedText(["colorGradingLuminance", "lens"])).toBe(
      "中間調・全体の輝度、レンズ補正を使っている写真は、原寸で書き出せません。",
    );
  });
});
