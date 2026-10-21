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
  PHOTO_EDITING_HSL_AXES,
  PHOTO_EDITING_HSL_BANDS,
  hasPhotoEditingHslAxisEdits,
  hasPhotoEditingHslEdits,
  readPhotoEditingHsl,
  resetPhotoEditingHsl,
  writePhotoEditingHsl,
} from "./photo-editing-hsl";
import type { PhotoEditingSettings } from "./photo-editing-types";

/**
 * カラーミキサー（HSL。niho-photo#38）の `developSettings.hsl` の読み書き。形は crate（`settings.rs`）と同じで、crate は交互の配列で
 * 書き、オブジェクトの形も読む。
 */

const ZERO = { hue: 0, saturation: 0, luminance: 0 };

function base(extra: Record<string, unknown> = {}): DevelopSettings {
  return { ...neutralDevelopSettings(null), ...extra };
}

describe("readPhotoEditingHsl", () => {
  it("交互の配列とオブジェクトのどちらも読み、欠けた色・値は 0", () => {
    const fromArray = readPhotoEditingHsl(
      base({ hsl: ["blue", { hue: -14, saturation: 14, luminance: 17 }, "green", { hue: 12, saturation: -23 }] }),
    );
    const fromObject = readPhotoEditingHsl(
      base({ hsl: { green: { hue: 12, saturation: -23 }, blue: { hue: -14, saturation: 14, luminance: 17 } } }),
    );
    expect(fromArray).toEqual(fromObject);
    expect(fromArray.blue).toEqual({ hue: -14, saturation: 14, luminance: 17 });
    expect(fromArray.green).toEqual({ hue: 12, saturation: -23, luminance: 0 });
    expect(fromArray.red).toEqual(ZERO);
    expect(Object.keys(fromArray)).toEqual([...PHOTO_EDITING_HSL_BANDS]);
  });

  it("無い・壊れた形は 0。同じ色が 2 つあれば先の 1 つ。余った最後の 1 つは数えない", () => {
    for (const hsl of [undefined, null, 3, "blue", [], {}, ["blue"], [3, { hue: 10 }]]) {
      const values = readPhotoEditingHsl(base({ hsl }));
      for (const band of PHOTO_EDITING_HSL_BANDS) expect(values[band]).toEqual(ZERO);
    }
    const duplicated = readPhotoEditingHsl(base({ hsl: ["red", { hue: 5 }, "red", { hue: 50 }, "blue"] }));
    expect(duplicated.red.hue).toBe(5);
    expect(duplicated.blue).toEqual(ZERO);
  });

  it("範囲外は -100〜100 に収め、有限の数でない値・数でない値は 0 で見せる（設定は変えない）", () => {
    const settings = base({
      hsl: ["red", { hue: 150, saturation: -400, luminance: Number.NaN }, "aqua", { hue: Infinity, saturation: "10", luminance: -0 }],
    });
    const before = JSON.stringify(settings);
    const values = readPhotoEditingHsl(settings);
    expect(values.red).toEqual({ hue: 100, saturation: -100, luminance: 0 });
    expect(values.aqua).toEqual(ZERO);
    expect(Object.is(values.aqua.luminance, -0)).toBe(false);
    expect(JSON.stringify(settings)).toBe(before);
  });
});

describe("hasPhotoEditingHslEdits / hasPhotoEditingHslAxisEdits", () => {
  it("24 の値のどれかが 0 でなければ true。軸ごとにも数える", () => {
    expect(hasPhotoEditingHslEdits(base())).toBe(false);
    expect(hasPhotoEditingHslEdits(base({ hsl: [] }))).toBe(false);
    expect(hasPhotoEditingHslEdits(base({ hsl: ["blue", ZERO] }))).toBe(false);
    const settings = base({ hsl: ["blue", { hue: 0, saturation: -100, luminance: 0 }] });
    expect(hasPhotoEditingHslEdits(settings)).toBe(true);
    const values = readPhotoEditingHsl(settings);
    expect(PHOTO_EDITING_HSL_AXES.filter((axis) => hasPhotoEditingHslAxisEdits(values, axis))).toEqual(["saturation"]);
  });
});

describe("writePhotoEditingHsl", () => {
  it("crate の出力と同じ交互の配列（色の順）で書き、直した色は 3 つの値を持つ", () => {
    const one = writePhotoEditingHsl(base(), "blue", "saturation", -100);
    expect(one.hsl).toEqual(["blue", { hue: 0, saturation: -100, luminance: 0 }]);
    const two = writePhotoEditingHsl(one, "red", "hue", 20);
    expect(two.hsl).toEqual(["red", { hue: 20, saturation: 0, luminance: 0 }, "blue", { hue: 0, saturation: -100, luminance: 0 }]);
    // オブジェクトの形の設定も、書けば交互の配列（色の順）になる
    const fromObject = writePhotoEditingHsl(base({ hsl: { magenta: { hue: 3 }, orange: { luminance: -4 } } }), "green", "luminance", 9);
    expect(fromObject.hsl).toEqual([
      "orange",
      { luminance: -4 },
      "green",
      { hue: 0, saturation: 0, luminance: 9 },
      "magenta",
      { hue: 3 },
    ]);
  });

  it("全部 0 に戻ると hsl ごと消す。3 つとも 0 になった色は消す", () => {
    const settings = base({ hsl: ["red", { hue: 20, saturation: 0, luminance: 0 }, "blue", { hue: 0, saturation: -30, luminance: 0 }] });
    const redCleared = writePhotoEditingHsl(settings, "red", "hue", 0);
    expect(redCleared.hsl).toEqual(["blue", { hue: 0, saturation: -30, luminance: 0 }]);
    const allCleared = writePhotoEditingHsl(redCleared, "blue", "saturation", 0);
    expect("hsl" in allCleared).toBe(false);
    // 0 だけの色（crate が書いた形）が残っていても、何も当てていない形にそろえる
    const zeroEntry = writePhotoEditingHsl(base({ hsl: ["aqua", ZERO, "red", { hue: 5 }] }), "red", "hue", 0);
    expect("hsl" in zeroEntry).toBe(false);
  });

  it("見せている値が変わらない・有限の数でないときは、渡した settings をそのまま返す", () => {
    const settings = base({ hsl: ["blue", { hue: 0, saturation: -100, luminance: 0 }] });
    expect(writePhotoEditingHsl(settings, "blue", "saturation", -100)).toBe(settings);
    expect(writePhotoEditingHsl(settings, "blue", "saturation", -250)).toBe(settings);
    expect(writePhotoEditingHsl(settings, "red", "hue", 0)).toBe(settings);
    expect(writePhotoEditingHsl(settings, "red", "hue", -0)).toBe(settings);
    expect(writePhotoEditingHsl(settings, "red", "hue", Number.NaN)).toBe(settings);
    expect(writePhotoEditingHsl(settings, "red", "hue", Number.POSITIVE_INFINITY)).toBe(settings);
    const empty = base();
    expect(writePhotoEditingHsl(empty, "green", "luminance", 0)).toBe(empty);
    // 範囲外は -100〜100 に収めて書く
    expect(writePhotoEditingHsl(empty, "green", "luminance", 180).hsl).toEqual(["green", { hue: 0, saturation: 0, luminance: 100 }]);
  });

  it("ほかのキー・触っていない色（範囲外・知らないキーも）・知らない色の名前は壊さない", () => {
    const settings = base({
      exposure: 0.4,
      toneCurves: [{ channel: "rgb", points: [{ x: 0, y: 0.1 }, { x: 1, y: 1 }] }],
      hsl: [
        "future",
        { hue: 1 },
        "yellow",
        { hue: 140, saturation: 5, extra: "keep" },
        "red",
        { hue: 10 },
        "red",
        { hue: 99 },
      ],
    });
    const next = writePhotoEditingHsl(settings, "red", "luminance", -7);
    expect(next.exposure).toBe(0.4);
    expect(next.toneCurves).toBe(settings.toneCurves);
    expect(next.hsl).toEqual([
      "red",
      { hue: 10, saturation: 0, luminance: -7 },
      "yellow",
      { hue: 140, saturation: 5, extra: "keep" },
      "future",
      { hue: 1 },
    ]);
    // 触っていない色の値は同じ参照のまま
    expect((next.hsl as unknown[])[3]).toBe((settings.hsl as unknown[])[3]);
    // 渡した settings は変えない
    expect((settings.hsl as unknown[]).length).toBe(8);
    // 知らない名前が残っていれば、0 に戻しても hsl を消さない
    const unknownOnly = writePhotoEditingHsl(base({ hsl: ["future", { hue: 1 }, "red", { hue: 4 }] }), "red", "hue", 0);
    expect(unknownOnly.hsl).toEqual(["future", { hue: 1 }]);
  });

  it("直した色は、範囲外の値を見せている値（収めた値）で書き直す", () => {
    const next = writePhotoEditingHsl(base({ hsl: ["purple", { hue: 150, saturation: "x" }] }), "purple", "luminance", 12);
    expect(next.hsl).toEqual(["purple", { hue: 100, saturation: 0, luminance: 12 }]);
  });
});

describe("resetPhotoEditingHsl", () => {
  it("24 の値を 0 に戻す（hsl ごと消す）。どれも 0 なら、渡した settings のまま", () => {
    const settings = base({ exposure: 0.2, hsl: ["blue", { saturation: -100 }, "future", { hue: 1 }] });
    const reset = resetPhotoEditingHsl(settings);
    expect("hsl" in reset).toBe(false);
    expect(reset.exposure).toBe(0.2);
    for (const hsl of [undefined, [], ["red", ZERO]]) {
      const neutral = base({ hsl });
      expect(resetPhotoEditingHsl(neutral)).toBe(neutral);
    }
  });
});

describe("履歴・コピー / 貼り付け・プリセット（hsl は developSettings の素通しのキー）", () => {
  const edited = (): DevelopSettings => writePhotoEditingHsl(base(), "blue", "saturation", -100) as DevelopSettings;

  it("補正のコピーに hsl が入り、貼り付け先に当たる（形の版は v1 のまま）。hsl の無いコピーを貼ると消える", () => {
    const copied = copyDevelopSettings(edited());
    expect(copied.hsl).toEqual(["blue", { hue: 0, saturation: -100, luminance: 0 }]);
    const pasted = pasteDevelopSettings(neutralDevelopSettings("raw-apple.1"), copied);
    expect(pasted.hsl).toEqual(copied.hsl);
    expect(pasted.v).toBe(1);
    expect(pasted.base).toBe("raw-apple.1");
    const plain = copyDevelopSettings(neutralDevelopSettings(null));
    expect("hsl" in pasteDevelopSettings(edited(), plain)).toBe(false);
  });

  it("値を変えると別の編集内容として履歴に積まれ、取り消すと元に戻る。初期化した編集内容は書く前と同じ", () => {
    const before = base();
    const after = edited();
    expect(sameDevelopSettings(before, after)).toBe(false);
    const history = pushEditHistory(createEditHistory(before), after, sameDevelopSettings);
    expect(history.present).toBe(after);
    expect(undoEditHistory(history).present).toBe(before);
    // 同じ値を書いた（つまみを動かさずに離した）ときは積まない
    const same = writePhotoEditingHsl(after, "blue", "saturation", -100) as DevelopSettings;
    expect(pushEditHistory(history, same, sameDevelopSettings)).toBe(history);
    expect(sameDevelopSettings(resetPhotoEditingHsl(after) as DevelopSettings, before)).toBe(true);
  });

  it("書いた hsl は「初期化」の判定（色の補正が何か当たっているか）に数え、全部 0 に戻せば neutral", () => {
    const after = edited();
    expect(isNeutralDevelopColors(after)).toBe(false);
    expect(isNeutralDevelopColors(writePhotoEditingHsl(after, "blue", "saturation", 0))).toBe(true);
  });

  it("今の補正をプリセットに保存するときの既定の群に hsl が入る（crate の xmp_write が 24 の値を書いて読み戻す）", () => {
    expect(DEVELOP_XMP_DEFAULT_GROUPS).toContain("hsl");
  });

  it("プリセットを当てた結果（crate の presetSettings）の hsl が、そのまま読める", () => {
    const presetResult: DevelopSettings = {
      ...neutralDevelopSettings(null),
      hsl: ["orange", { hue: 6, saturation: -12, luminance: 8 }, "blue", { hue: -10, saturation: -20, luminance: 0 }],
    };
    const applied = presetDevelopSettings(base({ exposure: 0.3 }), presetResult);
    const values = readPhotoEditingHsl(applied as PhotoEditingSettings);
    expect(values.orange).toEqual({ hue: 6, saturation: -12, luminance: 8 });
    expect(values.blue).toEqual({ hue: -10, saturation: -20, luminance: 0 });
    // プリセットの値を UI から動かせる（触っていない色は残る）
    const moved = writePhotoEditingHsl(applied, "blue", "saturation", -100);
    expect(moved.hsl).toEqual([
      "orange",
      { hue: 6, saturation: -12, luminance: 8 },
      "blue",
      { hue: -10, saturation: -100, luminance: 0 },
    ]);
  });
});
