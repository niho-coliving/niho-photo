import { describe, expect, it } from "vitest";

import {
  copyDevelopSettings,
  isNeutralDevelopColors,
  neutralDevelopSettings,
  pasteDevelopSettings,
  presetDevelopSettings,
  sameDevelopSettings,
  type DevelopSettings,
} from "./develop-engine/develop-settings";
import { DEVELOP_XMP_DEFAULT_GROUPS } from "./develop-engine/develop-engine-results";
import { createEditHistory, pushEditHistory, undoEditHistory } from "./photo-editing-edit-history";
import {
  PHOTO_EDITING_COLOR_GRADING_ZONES,
  hasPhotoEditingColorGradingEdits,
  hasPhotoEditingColorGradingNativeExportUnsupportedLuminance,
  hasPhotoEditingColorGradingZoneEdits,
  photoEditingColorGradingHueColor,
  photoEditingColorGradingHueRgb,
  photoEditingColorGradingSwatchColor,
  readPhotoEditingColorGrading,
  resetPhotoEditingColorGrading,
  writePhotoEditingColorGradingScalar,
  writePhotoEditingColorGradingZone,
} from "./photo-editing-color-grading";
import type { PhotoEditingSettings } from "./photo-editing-types";

/**
 * カラーグレーディング（niho-photo#39）の `developSettings.colorGrading` の読み書き。形は crate（`settings.rs`）と同じ
 * `{ shadow | midtone | highlight | global: { hue, saturation, luminance }, blending, balance }`。
 */

const ZERO = { hue: 0, saturation: 0, luminance: 0 };

function base(extra: Record<string, unknown> = {}): DevelopSettings {
  return { ...neutralDevelopSettings(null), ...extra };
}

/** crate の `to_value` が書く、全部が既定の形（プリセットを当てた結果に入っている）。 */
const CRATE_DEFAULT = {
  shadow: ZERO,
  midtone: ZERO,
  highlight: ZERO,
  global: ZERO,
  blending: 100,
  balance: 0,
};

describe("readPhotoEditingColorGrading", () => {
  it("無ければ全部既定（ブレンド 100・ほかは 0）", () => {
    expect(readPhotoEditingColorGrading(base())).toEqual({
      shadow: ZERO,
      midtone: ZERO,
      highlight: ZERO,
      global: ZERO,
      blending: 100,
      balance: 0,
    });
    expect(hasPhotoEditingColorGradingEdits(base())).toBe(false);
    expect(hasPhotoEditingColorGradingEdits(base({ colorGrading: CRATE_DEFAULT }))).toBe(false);
  });

  it("crate の形を読む。欠けた値は既定、範囲外・数でない値は表示のために収めるだけ（色相は 0〜359 に回す）", () => {
    const values = readPhotoEditingColorGrading(
      base({
        colorGrading: {
          shadow: { hue: 220, saturation: 40, luminance: -10 },
          midtone: { saturation: 130, luminance: Number.NaN },
          highlight: { hue: -30, saturation: "50", luminance: 250 },
          global: { hue: 725 },
          blending: Infinity,
          balance: -400,
        },
      }),
    );
    expect(values.shadow).toEqual({ hue: 220, saturation: 40, luminance: -10 });
    expect(values.midtone).toEqual({ hue: 0, saturation: 100, luminance: 0 });
    expect(values.highlight).toEqual({ hue: 330, saturation: 0, luminance: 100 });
    expect(values.global).toEqual({ hue: 5, saturation: 0, luminance: 0 });
    expect(values.blending).toBe(100);
    expect(values.balance).toBe(-100);
    expect(hasPhotoEditingColorGradingZoneEdits(values, "shadow")).toBe(true);
    expect(hasPhotoEditingColorGradingZoneEdits(values, "global")).toBe(true);
  });

  it("ゾーンの印は 3 つの値のどれかが 0 でないとき。ブレンド・バランスだけでも「初期化」できる", () => {
    const values = readPhotoEditingColorGrading(base({ colorGrading: { midtone: { luminance: 20 } } }));
    expect(PHOTO_EDITING_COLOR_GRADING_ZONES.map((zone) => hasPhotoEditingColorGradingZoneEdits(values, zone))).toEqual([
      false,
      true,
      false,
      false,
    ]);
    expect(hasPhotoEditingColorGradingEdits(base({ colorGrading: { blending: 40 } }))).toBe(true);
    expect(hasPhotoEditingColorGradingEdits(base({ colorGrading: { balance: 10 } }))).toBe(true);
  });
});

describe("原寸の native 書き出しとの互換性", () => {
  it("中間調・全体の輝度が動いているときだけ非対応とする", () => {
    expect(hasPhotoEditingColorGradingNativeExportUnsupportedLuminance(base())).toBe(false);
    expect(
      hasPhotoEditingColorGradingNativeExportUnsupportedLuminance(base({ colorGrading: { shadow: { luminance: 25 } } })),
    ).toBe(false);
    expect(
      hasPhotoEditingColorGradingNativeExportUnsupportedLuminance(base({ colorGrading: { midtone: { luminance: -1 } } })),
    ).toBe(true);
    expect(
      hasPhotoEditingColorGradingNativeExportUnsupportedLuminance(base({ colorGrading: { global: { luminance: 1 } } })),
    ).toBe(true);
  });
});

describe("writePhotoEditingColorGradingZone / Scalar", () => {
  it("直したゾーンだけを 3 つの値にして書く（ほかのゾーン・知らないキーはそのまま）", () => {
    const before = base({
      colorGrading: { highlight: { hue: 35, saturation: 400, future: 1 }, blending: 60, futureKey: "x" },
    });
    const next = writePhotoEditingColorGradingZone(before, "shadow", { hue: 220, saturation: 40 });
    expect(next.colorGrading).toEqual({
      highlight: { hue: 35, saturation: 400, future: 1 },
      blending: 60,
      futureKey: "x",
      shadow: { hue: 220, saturation: 40, luminance: 0 },
    });
    // 渡した settings は変えない
    expect(before.colorGrading).toEqual({ highlight: { hue: 35, saturation: 400, future: 1 }, blending: 60, futureKey: "x" });
  });

  it("色相は整数の 0〜359 に回し、彩度・輝度は範囲に収める。数でない値は書かない", () => {
    const hue = writePhotoEditingColorGradingZone(base(), "midtone", { hue: 359.6, saturation: 120 });
    expect(hue.colorGrading).toEqual({ midtone: { hue: 0, saturation: 100, luminance: 0 } });
    const negative = writePhotoEditingColorGradingZone(base(), "global", { hue: -90.2, luminance: -300 });
    expect(negative.colorGrading).toEqual({ global: { hue: 270, saturation: 0, luminance: -100 } });
    const settings = base();
    expect(writePhotoEditingColorGradingZone(settings, "shadow", { hue: Number.NaN })).toBe(settings);
  });

  it("見せている値が変わらなければ同じ参照を返す", () => {
    const settings = base({ colorGrading: { shadow: { hue: 220, saturation: 40, luminance: 0 } } });
    expect(writePhotoEditingColorGradingZone(settings, "shadow", { hue: 220, saturation: 40 })).toBe(settings);
    expect(writePhotoEditingColorGradingScalar(settings, "blending", 100)).toBe(settings);
    expect(writePhotoEditingColorGradingScalar(settings, "balance", 0)).toBe(settings);
  });

  it("全部が既定に戻れば colorGrading ごと消す。色相だけ（彩度 0）の途中の値は残す", () => {
    const tinted = writePhotoEditingColorGradingZone(base(), "shadow", { hue: 220, saturation: 40 });
    const hueOnly = writePhotoEditingColorGradingZone(tinted, "shadow", { saturation: 0 });
    expect(hueOnly.colorGrading).toEqual({ shadow: { hue: 220, saturation: 0, luminance: 0 } });
    const cleared = writePhotoEditingColorGradingZone(hueOnly, "shadow", { hue: 0 });
    expect("colorGrading" in cleared).toBe(false);
    // crate の書く全部既定の形（ブレンド 100）から 1 つ動かして戻しても消える
    const fromCrate = base({ colorGrading: CRATE_DEFAULT });
    const moved = writePhotoEditingColorGradingScalar(fromCrate, "balance", 30);
    expect(moved.colorGrading).toEqual({ ...CRATE_DEFAULT, balance: 30 });
    expect("colorGrading" in writePhotoEditingColorGradingScalar(moved, "balance", 0)).toBe(false);
    // 知らないキーがあれば消さない
    const unknown = base({ colorGrading: { future: 1, balance: 10 } });
    expect(writePhotoEditingColorGradingScalar(unknown, "balance", 0).colorGrading).toEqual({ future: 1, balance: 0 });
  });

  it("ブレンド・バランスは範囲に収めて書く", () => {
    expect(writePhotoEditingColorGradingScalar(base(), "blending", -5).colorGrading).toEqual({ blending: 0 });
    expect(writePhotoEditingColorGradingScalar(base(), "balance", 140).colorGrading).toEqual({ balance: 100 });
  });

  it("「初期化」は全部を既定に戻す（キーごと消す）。どれも既定なら同じ参照", () => {
    const edited = base({ exposure: 0.4, colorGrading: { midtone: { luminance: 30 }, blending: 50 } });
    const reset = resetPhotoEditingColorGrading(edited);
    expect("colorGrading" in reset).toBe(false);
    expect(reset.exposure).toBe(0.4);
    const neutral = base({ colorGrading: CRATE_DEFAULT });
    expect(resetPhotoEditingColorGrading(neutral)).toBe(neutral);
  });
});

describe("色相環の色（エンジンの grade_direction の移植）", () => {
  it("同じ色相でエンジンが乗せる色の向きの、いちばん鮮やかな sRGB の色", () => {
    // crate の `grade_direction` → `PROPHOTO_TO_SRGB` を倍精度で計算した値（ProPhoto の原色なので HSL の同じ角度とはずれる）
    expect(photoEditingColorGradingHueRgb(0)).toEqual([255, 0, 88]);
    expect(photoEditingColorGradingHueRgb(35)).toEqual([255, 158, 0]);
    expect(photoEditingColorGradingHueRgb(60)).toEqual([255, 230, 0]);
    expect(photoEditingColorGradingHueRgb(120)).toEqual([0, 255, 147]);
    expect(photoEditingColorGradingHueRgb(220)).toEqual([0, 200, 255]);
    expect(photoEditingColorGradingHueRgb(240)).toEqual([0, 126, 255]);
    expect(photoEditingColorGradingHueRgb(300)).toEqual([255, 0, 219]);
    // 360 は 0 と同じ
    expect(photoEditingColorGradingHueRgb(360)).toEqual(photoEditingColorGradingHueRgb(0));
    expect(photoEditingColorGradingHueColor(35)).toBe("rgb(255 158 0)");
  });

  it("つまみの塗りは、中心の白から縁の色へ彩度の割合で混ぜる", () => {
    expect(photoEditingColorGradingSwatchColor(35, 0)).toBe("rgb(255 255 255)");
    expect(photoEditingColorGradingSwatchColor(35, 100)).toBe("rgb(255 158 0)");
    expect(photoEditingColorGradingSwatchColor(220, 50)).toBe("rgb(128 228 255)");
  });
});

describe("履歴・コピー / 貼り付け・プリセット（colorGrading は developSettings の素通しのキー）", () => {
  const edited = (): DevelopSettings =>
    writePhotoEditingColorGradingZone(
      writePhotoEditingColorGradingZone(base(), "shadow", { hue: 220, saturation: 40 }),
      "highlight",
      { hue: 35, saturation: 45 },
    ) as DevelopSettings;

  it("補正のコピーに colorGrading が入り、貼り付け先に当たる。無いコピーを貼ると消える", () => {
    const copied = copyDevelopSettings(edited());
    expect(copied.colorGrading).toEqual({
      shadow: { hue: 220, saturation: 40, luminance: 0 },
      highlight: { hue: 35, saturation: 45, luminance: 0 },
    });
    const pasted = pasteDevelopSettings(neutralDevelopSettings("raw-apple.1"), copied);
    expect(pasted.colorGrading).toEqual(copied.colorGrading);
    expect(pasted.v).toBe(1);
    const plain = copyDevelopSettings(neutralDevelopSettings(null));
    expect("colorGrading" in pasteDevelopSettings(edited(), plain)).toBe(false);
  });

  it("値を変えると履歴に積まれ、同じ値・初期化して戻した編集内容は積まない", () => {
    const before = base();
    const after = edited();
    expect(sameDevelopSettings(before, after)).toBe(false);
    const history = pushEditHistory(createEditHistory(before), after, sameDevelopSettings);
    expect(history.present).toBe(after);
    expect(undoEditHistory(history).present).toBe(before);
    const same = writePhotoEditingColorGradingZone(after, "shadow", { hue: 220, saturation: 40 }) as DevelopSettings;
    expect(pushEditHistory(history, same, sameDevelopSettings)).toBe(history);
    expect(sameDevelopSettings(resetPhotoEditingColorGrading(after) as DevelopSettings, before)).toBe(true);
  });

  it("書いた colorGrading は「初期化」の判定に数え、全部既定に戻せば neutral", () => {
    const after = writePhotoEditingColorGradingZone(base(), "global", { luminance: 25 });
    expect(isNeutralDevelopColors(after)).toBe(false);
    expect(isNeutralDevelopColors(writePhotoEditingColorGradingZone(after, "global", { luminance: 0 }))).toBe(true);
  });

  it("今の補正をプリセットに保存するときの既定の群に colorGrading が入る（crate の xmp_write が 4 ゾーンと輝度を書いて読み戻す）", () => {
    expect(DEVELOP_XMP_DEFAULT_GROUPS).toContain("colorGrading");
  });

  it("プリセットを当てた結果（crate の presetSettings。全部のキーを書く形）が UI に出て、動かせる", () => {
    const presetResult: DevelopSettings = {
      ...neutralDevelopSettings(null),
      colorGrading: {
        ...CRATE_DEFAULT,
        shadow: { hue: 200, saturation: 25, luminance: -5 },
        highlight: { hue: 40, saturation: 30, luminance: 0 },
        blending: 60,
        balance: -20,
      },
    };
    const applied = presetDevelopSettings(base({ exposure: 0.3 }), presetResult) as PhotoEditingSettings;
    const values = readPhotoEditingColorGrading(applied);
    expect(values.shadow).toEqual({ hue: 200, saturation: 25, luminance: -5 });
    expect(values.blending).toBe(60);
    expect(values.balance).toBe(-20);
    const moved = writePhotoEditingColorGradingZone(applied, "midtone", { luminance: 15 });
    expect(moved.colorGrading).toEqual({
      ...CRATE_DEFAULT,
      shadow: { hue: 200, saturation: 25, luminance: -5 },
      midtone: { hue: 0, saturation: 0, luminance: 15 },
      highlight: { hue: 40, saturation: 30, luminance: 0 },
      blending: 60,
      balance: -20,
    });
  });
});
