import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import {
  canonicalDevelopMask,
  DEVELOP_MASK_KINDS,
  DEVELOP_MASKS_SETTINGS_VERSION,
  hasActiveDevelopMasks,
  hasDevelopMasks,
  hasValidDevelopMasks,
  isActiveDevelopMask,
  isZeroDevelopMaskAdjust,
  MAX_DEVELOP_MASKS,
  parseDevelopMasks,
  readDevelopMasks,
  writeDevelopMasks,
  type DevelopMask,
} from "./develop-masks";
import { DEVELOP_SETTINGS_DRAFT_MAX_BYTES } from "./develop-settings-draft";
import {
  applyBrowserAdjustmentsToDevelopSettings,
  autoDevelopSettings,
  copyDevelopSettings,
  developSettingsOnWorkingCopy,
  developSettingsToEditSettings,
  developSettingsVersion,
  isEditableDevelopSettings,
  isNeutralDevelopColors,
  isNeutralDevelopSettings,
  neutralDevelopSettings,
  pasteDevelopSettings,
  presetDevelopSettings,
  readDevelopSettings,
  resetDevelopSettingsColors,
  type DevelopSettings,
} from "./develop-settings";
import { photoEditingPresetNotWrittenError } from "../photo-editing-copy";

/** Rust（`niho-develop` の `tests/masks_settings.rs`）と共有する fixture。 */
const FIXTURE_URL = new URL(
  "../../../develop-engine/crates/niho-develop/tests/fixtures/masks/settings-cases.json",
  import.meta.url,
);

type ValidCase = { name: string; settings: Record<string, unknown>; canonical: unknown[] };
type InvalidCase = { name: string; settings: Record<string, unknown>; code: string };

const fixture = JSON.parse(readFileSync(fileURLToPath(FIXTURE_URL), "utf8")) as { valid: ValidCase[]; invalid: InvalidCase[] };

function whiteBalanceMode(settings: Record<string, unknown>): unknown {
  const whiteBalance = settings.whiteBalance;
  return typeof whiteBalance === "object" && whiteBalance !== null ? (whiteBalance as Record<string, unknown>).mode : undefined;
}

const SID = "a".repeat(64);

function linear(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: "m1",
    kind: "linear",
    zero: { x: 0.5, y: 0.2 },
    full: { x: 0.5, y: 0.5 },
    adjust: { exposure: -0.7 },
    ...overrides,
  };
}

function parsedOne(value: Record<string, unknown>): DevelopMask {
  const masks = parseDevelopMasks([value]);
  if (!masks) throw new Error("expected valid mask");
  return masks[0]!;
}

describe("共有 fixture（Rust の masks_settings.rs と同じ）", () => {
  it("fixture は各種類・上限・全フィールドの範囲外を含む", () => {
    expect(fixture.valid.length).toBeGreaterThanOrEqual(15);
    expect(fixture.invalid.length).toBeGreaterThanOrEqual(100);
    const kinds = new Set(fixture.valid.flatMap((item) => (item.canonical as { kind: string }[]).map((mask) => mask.kind)));
    expect([...kinds].sort()).toEqual([...DEVELOP_MASK_KINDS].sort());
  });

  it.each(fixture.valid.map((item) => [item.name, item] as const))("読めて、正規形に書ける: %s", (_name, item) => {
    const masks = parseDevelopMasks(item.settings.masks, { whiteBalanceMode: whiteBalanceMode(item.settings) });
    expect(masks).not.toBeNull();
    expect(readDevelopSettings(item.settings)).not.toBeNull();
    expect(hasValidDevelopMasks(item.settings)).toBe(true);
    const base = readDevelopSettings(item.settings) as DevelopSettings;
    const written = writeDevelopMasks(base, masks as DevelopMask[]);
    // JSON.stringify でキー順まで比べる
    expect(JSON.stringify(written.masks)).toBe(JSON.stringify(item.canonical.length > 0 ? item.canonical : undefined));
    expect(Object.hasOwn(written, "masks")).toBe(item.canonical.length > 0);
    expect(written.v).toBe(item.canonical.length > 0 ? DEVELOP_MASKS_SETTINGS_VERSION : 1);
    // 正規形をもう一度読んで書いても変わらない
    const again = readDevelopMasks(written);
    expect(JSON.stringify(writeDevelopMasks(written, again).masks)).toBe(JSON.stringify(written.masks));
    // 正規形の設定は読める
    if (item.canonical.length > 0) expect(readDevelopSettings(written)).not.toBeNull();
  });

  it.each(fixture.invalid.map((item) => [item.name, item] as const))("読まない: %s", (_name, item) => {
    expect(readDevelopSettings(item.settings)).toBeNull();
    if (item.code !== "versionTooLow" && item.code !== "unsupportedVersion") {
      expect(parseDevelopMasks(item.settings.masks, { whiteBalanceMode: whiteBalanceMode(item.settings) })).toBeNull();
      expect(hasValidDevelopMasks(item.settings)).toBe(false);
      expect(readDevelopMasks(item.settings)).toEqual([]);
    }
  });
});

describe("parseDevelopMasks", () => {
  it("読んだ結果は正規化される（enabled / invert は常にあり、0 の項目と帯は持たない）", () => {
    expect(parsedOne(linear({ adjust: { exposure: 0, contrast: 12, hsl: { red: { hue: 0 }, blue: { luminance: -4 } } } }))).toEqual({
      id: "m1",
      kind: "linear",
      enabled: true,
      invert: false,
      zero: { x: 0.5, y: 0.2 },
      full: { x: 0.5, y: 0.5 },
      adjust: { contrast: 12, hsl: { blue: { hue: 0, saturation: 0, luminance: -4 } } },
    });
    expect(parsedOne(linear({ enabled: false, invert: true })).enabled).toBe(false);
    expect(parsedOne(linear({ enabled: false, invert: true })).invert).toBe(true);
  });

  it("hsl は帯と値が交互の配列でも、帯の対応表でも読む（重複・未知の帯・奇数長は読まない）", () => {
    const delta = { hue: 5 };
    const asArray = parsedOne(linear({ adjust: { hsl: ["red", delta, "blue", { saturation: 2 }] } }));
    const asObject = parsedOne(linear({ adjust: { hsl: { red: delta, blue: { saturation: 2 } } } }));
    expect(asArray).toEqual(asObject);
    expect(parseDevelopMasks([linear({ adjust: { hsl: ["red", delta, "red", delta] } })])).toBeNull();
    expect(parseDevelopMasks([linear({ adjust: { hsl: { pink: delta } } })])).toBeNull();
    expect(parseDevelopMasks([linear({ adjust: { hsl: ["red"] } })])).toBeNull();
    expect(parseDevelopMasks([linear({ adjust: { hsl: [1, delta] } })])).toBeNull();
    expect(parseDevelopMasks([linear({ adjust: { hsl: { red: { alpha: 1 } } } })])).toBeNull();
    expect(parseDevelopMasks([linear({ adjust: { hsl: { red: { hue: null } } } })])).toBeNull();
    expect(parseDevelopMasks([linear({ adjust: { hsl: 5 } })])).toBeNull();
  });

  it("非有限値・NaN・Infinity・文字列の数値は読まない", () => {
    for (const bad of [Number.NaN, Number.POSITIVE_INFINITY, "1", null, true]) {
      expect(parseDevelopMasks([linear({ adjust: { exposure: bad } })])).toBeNull();
      expect(parseDevelopMasks([linear({ zero: { x: bad, y: 0.2 } })])).toBeNull();
    }
    expect(parseDevelopMasks([linear({ adjust: { exposure: Number.NaN } })])).toBeNull();
  });

  it("線形の 2 点は距離 0.001 以上（ユークリッド）", () => {
    expect(parseDevelopMasks([linear({ zero: { x: 0.5, y: 0.5 }, full: { x: 0.5, y: 0.5 } })])).toBeNull();
    expect(parseDevelopMasks([linear({ zero: { x: 0.5, y: 0.5 }, full: { x: 0.5004, y: 0.5004 } })])).toBeNull();
    expect(parseDevelopMasks([linear({ zero: { x: 0.5, y: 0.5 }, full: { x: 0.5008, y: 0.5008 } })])).not.toBeNull();
    expect(parseDevelopMasks([linear({ zero: { x: 0.5, y: 0.5 }, full: { x: 0.502, y: 0.5 } })])).not.toBeNull();
  });

  it("線形マスクを小数6桁へ正規化しても最小距離を保ち、設定を読み直せる", () => {
    const mask = parsedOne(linear({ zero: { x: 0, y: 0 }, full: { x: 0.0007072, y: 0.0007072 } }));
    const written = writeDevelopMasks(neutralDevelopSettings(null), [mask]);

    expect(parseDevelopMasks(written.masks)).not.toBeNull();
    expect(readDevelopSettings(written)).not.toBeNull();
    expect(written.v).toBe(DEVELOP_MASKS_SETTINGS_VERSION);
  });

  it("id は ASCII の英数字 _ - で 1〜64 byte、配列内で一意（大文字小文字は別）", () => {
    expect(parseDevelopMasks([linear({ id: "A_b-9" }), linear({ id: "a_b-9" })])).not.toBeNull();
    expect(parseDevelopMasks([linear({ id: "a".repeat(64) })])).not.toBeNull();
    for (const id of ["", "a".repeat(65), "a b", "a.b", "マスク", "a\n"]) {
      expect(parseDevelopMasks([linear({ id })])).toBeNull();
    }
    expect(parseDevelopMasks([linear({ id: "x" }), linear({ id: "x" })])).toBeNull();
  });

  it("面の id は小文字 16 進 64 文字、寸法は 1〜4096 の整数", () => {
    const surface = (overrides: Record<string, unknown>) => ({
      id: "s1",
      kind: "brush",
      surface: { id: SID, width: 4096, height: 1, ...overrides },
      adjust: {},
    });
    expect(parseDevelopMasks([surface({})])).not.toBeNull();
    for (const bad of [
      { id: SID.toUpperCase() },
      { id: SID.slice(1) },
      { id: `${SID}0` },
      { id: `g${SID.slice(1)}` },
      { width: 0 },
      { width: 4097 },
      { height: 0 },
      { height: 4097 },
      { width: 10.5 },
      { width: "10" },
    ]) {
      expect(parseDevelopMasks([surface(bad)])).toBeNull();
    }
    expect(parseDevelopMasks([{ ...surface({}), surface: { id: SID, width: 8, height: 8, format: "png" } }])).toBeNull();
  });

  it("種類に合わないキー・足りないキー・未知の種類は読まない", () => {
    expect(parseDevelopMasks([linear({ center: { x: 0.5, y: 0.5 } })])).toBeNull();
    expect(parseDevelopMasks([linear({ opacity: 1 })])).toBeNull();
    expect(parseDevelopMasks([linear({ kind: "gradient" })])).toBeNull();
    const { full: _full, ...withoutFull } = linear();
    expect(parseDevelopMasks([withoutFull])).toBeNull();
    const { adjust: _adjust, ...withoutAdjust } = linear();
    expect(parseDevelopMasks([withoutAdjust])).toBeNull();
    expect(parseDevelopMasks([{ id: "b", kind: "brush", zero: { x: 0, y: 0 }, adjust: {} }])).toBeNull();
    expect(parseDevelopMasks([{ id: "r", kind: "radial", zero: { x: 0, y: 0 }, adjust: {} }])).toBeNull();
  });

  it("配列でない・9 枚以上・要素がオブジェクトでないものは読まない", () => {
    expect(parseDevelopMasks(undefined)).toBeNull();
    expect(parseDevelopMasks(null)).toBeNull();
    expect(parseDevelopMasks({})).toBeNull();
    expect(parseDevelopMasks(["linear"])).toBeNull();
    expect(parseDevelopMasks([null])).toBeNull();
    expect(parseDevelopMasks([])).toEqual([]);
    const many = (count: number) => Array.from({ length: count }, (_, index) => linear({ id: `m${index}` }));
    expect(parseDevelopMasks(many(MAX_DEVELOP_MASKS))).toHaveLength(MAX_DEVELOP_MASKS);
    expect(parseDevelopMasks(many(MAX_DEVELOP_MASKS + 1))).toBeNull();
  });

  it("相対 WB の差分は absolute のとき（マスクが無効でも）読まない", () => {
    const masks = [linear({ adjust: { relativeTemperature: 5 }, enabled: false })];
    expect(parseDevelopMasks(masks, { whiteBalanceMode: "absolute" })).toBeNull();
    expect(parseDevelopMasks(masks, { whiteBalanceMode: "relative" })).not.toBeNull();
    expect(parseDevelopMasks(masks, { whiteBalanceMode: "asShot" })).not.toBeNull();
    expect(parseDevelopMasks(masks)).not.toBeNull();
    expect(parseDevelopMasks([linear({ adjust: { relativeTint: 0, exposure: 1 } })], { whiteBalanceMode: "absolute" })).not.toBeNull();
    expect(hasValidDevelopMasks({ whiteBalance: { mode: "absolute" }, masks })).toBe(false);
    expect(hasValidDevelopMasks({ whiteBalance: { mode: "relative" }, masks })).toBe(true);
  });
});

describe("書き出し（正規形）", () => {
  it("キー順は id kind enabled invert 種類のキー adjust、enabled は false のときだけ・invert は true のときだけ", () => {
    const radial = parsedOne({
      id: "r1",
      kind: "radial",
      invert: true,
      enabled: false,
      center: { x: 0.5, y: 0.5 },
      radius: { x: 0.3, y: 0.2 },
      angle: 15,
      feather: 50,
      adjust: { saturation: 10, exposure: 0.4 },
    });
    expect(JSON.stringify(canonicalDevelopMask(radial))).toBe(
      '{"id":"r1","kind":"radial","enabled":false,"invert":true,"center":{"x":0.5,"y":0.5},"radius":{"x":0.3,"y":0.2},"angle":15,"feather":50,"adjust":{"exposure":0.4,"saturation":10}}',
    );
    const brush = parsedOne({ id: "b1", kind: "brush", surface: { id: SID, width: 8, height: 4 }, adjust: {} });
    expect(JSON.stringify(canonicalDevelopMask(brush))).toBe(
      `{"id":"b1","kind":"brush","surface":{"id":"${SID}","width":8,"height":4},"adjust":{}}`,
    );
  });

  it("数値は小数 6 桁に丸め、丸めて 0 になる項目と -0 は書かない", () => {
    const mask = parsedOne(
      linear({
        zero: { x: 0.12345678, y: -0.0000004 },
        full: { x: 0.9999996, y: 1 },
        adjust: { exposure: 0.1234567, contrast: 0.0000001, highlights: -0.0000002, hsl: { red: { hue: 1.0000004, saturation: 0.0000003 } } },
      }),
    );
    expect(JSON.stringify(canonicalDevelopMask(mask))).toBe(
      '{"id":"m1","kind":"linear","zero":{"x":0.123457,"y":0},"full":{"x":1,"y":1},"adjust":{"exposure":0.123457,"hsl":["red",{"hue":1}]}}',
    );
  });

  it("hsl は帯の並び（赤〜マゼンタ）で、帯と値が交互の配列", () => {
    const mask = parsedOne(linear({ adjust: { hsl: { magenta: { hue: 3 }, red: { luminance: -2, hue: 1 }, aqua: { saturation: 4 } } } }));
    expect(JSON.stringify(canonicalDevelopMask(mask).adjust)).toBe(
      '{"hsl":["red",{"hue":1,"luminance":-2},"aqua",{"saturation":4},"magenta",{"hue":3}]}',
    );
  });

  it("writeDevelopMasks は v を決め直し、空の配列は masks を外す（ほかの項目・知らない項目は保つ）", () => {
    const base: DevelopSettings = { ...neutralDevelopSettings(null), exposure: 0.3, futureKey: { a: 1 } };
    const masks = parseDevelopMasks([linear()]) as DevelopMask[];
    const written = writeDevelopMasks(base, masks);
    expect(written.v).toBe(5);
    expect(written.engine).toBe(base.engine);
    expect(written.exposure).toBe(0.3);
    expect(written.futureKey).toEqual({ a: 1 });
    expect(written.masks).toEqual([linear()]);
    expect(readDevelopSettings(written)).not.toBeNull();
    // 外すと、ほかの機能が要る版に戻る
    const geometry = { rotate: 90 };
    const withGeometry = writeDevelopMasks({ ...written, geometry }, masks);
    expect(withGeometry.v).toBe(5);
    const cleared = writeDevelopMasks(withGeometry, []);
    expect(Object.hasOwn(cleared, "masks")).toBe(false);
    expect(cleared.v).toBe(2);
    expect(writeDevelopMasks(written, []).v).toBe(1);
    // 入力は書き換えない
    expect(Object.hasOwn(base, "masks")).toBe(false);
  });

  it("writeDevelopMasks は対応上限を超えるマスクを拒否する", () => {
    const masks = Array.from({ length: MAX_DEVELOP_MASKS + 1 }, (_, index) => parsedOne(linear({ id: `m${index}` })));
    expect(() => writeDevelopMasks(neutralDevelopSettings(null), masks)).toThrow(RangeError);
  });

  it("無効なマスクも保ち、v 5 を要求する（編集は残す）", () => {
    const off = parsedOne(linear({ enabled: false }));
    const written = writeDevelopMasks(neutralDevelopSettings(null), [off]);
    expect(written.v).toBe(5);
    expect(hasDevelopMasks(written)).toBe(true);
    expect(hasActiveDevelopMasks(written)).toBe(false);
  });
});

describe("有効なマスク", () => {
  it("有効で adjust が何か動かすものだけが画を変える（0 だけ・0 の帯だけ・空は変えない）", () => {
    const active = parsedOne(linear());
    expect(isActiveDevelopMask(active)).toBe(true);
    expect(isActiveDevelopMask({ ...active, enabled: false })).toBe(false);
    expect(isActiveDevelopMask({ ...active, adjust: {} })).toBe(false);
    expect(isActiveDevelopMask({ ...active, adjust: { exposure: 0, contrast: 0 } })).toBe(false);
    expect(isActiveDevelopMask({ ...active, adjust: { hsl: { red: { hue: 0, saturation: 0, luminance: 0 } } } })).toBe(false);
    expect(isActiveDevelopMask({ ...active, adjust: { hsl: { red: { hue: 0, saturation: 0, luminance: 2 } } } })).toBe(true);
    expect(isZeroDevelopMaskAdjust({})).toBe(true);
    expect(isZeroDevelopMaskAdjust({ relativeTint: -1 })).toBe(false);
  });

  it("設定から読む（無い・壊れていれば空）", () => {
    expect(readDevelopMasks(null)).toEqual([]);
    expect(readDevelopMasks({})).toEqual([]);
    expect(readDevelopMasks({ masks: [{ id: "x" }] })).toEqual([]);
    expect(readDevelopMasks({ masks: [linear()] })).toHaveLength(1);
    expect(hasDevelopMasks({ masks: [linear()] })).toBe(true);
    expect(hasDevelopMasks({ masks: [] })).toBe(false);
    expect(hasValidDevelopMasks({})).toBe(true);
    expect(hasValidDevelopMasks({ masks: null })).toBe(false);
  });
});

describe("下書き・保存の上限", () => {
  it("最大の 8 枚（全項目・全帯を埋めても）は下書きの 32 KiB に十分収まる", () => {
    const hsl = Object.fromEntries(
      ["red", "orange", "yellow", "green", "aqua", "blue", "purple", "magenta"].map((band) => [band, { hue: -12.345678, saturation: 99.999999, luminance: -100 }]),
    );
    const adjust = {
      exposure: -4.123456,
      contrast: -99.123456,
      highlights: -99.123456,
      shadows: -99.123456,
      whites: -99.123456,
      blacks: -99.123456,
      texture: -99.123456,
      clarity: -99.123456,
      dehaze: -99.123456,
      vibrance: -99.123456,
      saturation: -99.123456,
      relativeTemperature: -99.123456,
      relativeTint: -99.123456,
      hsl,
    };
    const masks = Array.from({ length: MAX_DEVELOP_MASKS }, (_, index) => ({
      id: `mask-${"x".repeat(50)}${index}`,
      kind: "brush",
      enabled: false,
      invert: true,
      surface: { id: SID, width: 4096, height: 4096 },
      adjust,
    }));
    const parsed = parseDevelopMasks(masks) as DevelopMask[];
    expect(parsed).toHaveLength(MAX_DEVELOP_MASKS);
    const written = writeDevelopMasks(neutralDevelopSettings(null), parsed);
    const bytes = new TextEncoder().encode(JSON.stringify(written)).byteLength;
    expect(bytes).toBeLessThan(DEVELOP_SETTINGS_DRAFT_MAX_BYTES / 2);
    expect(DEVELOP_MASK_KINDS).toHaveLength(5);
  });
});

describe("developSettings への取り込み（部分補正は写真自身の編集）", () => {
  const MASK = linear();
  const withMasks = (overrides: Record<string, unknown> = {}, masks: unknown[] = [MASK]): DevelopSettings =>
    ({ ...neutralDevelopSettings(null), v: 5, masks, ...overrides }) as DevelopSettings;

  it("形の版: マスクがあれば 5（ほかの機能より先）、空・壊れていれば要求しない", () => {
    expect(developSettingsVersion(withMasks())).toBe(5);
    expect(developSettingsVersion(withMasks({ colorPoints: [{}], grayscale: true, geometry: { rotate: 90 } }))).toBe(5);
    expect(developSettingsVersion(withMasks({}, [linear({ enabled: false })]))).toBe(5);
    expect(developSettingsVersion(withMasks({}, []))).toBe(1);
    expect(developSettingsVersion(withMasks({}, [{ id: "broken" }]))).toBe(1);
    expect(developSettingsVersion({ ...neutralDevelopSettings(null), geometry: { rotate: 90 } })).toBe(2);
  });

  it("readDevelopSettings / isEditableDevelopSettings は壊れたマスク・5 未満の版を読まない", () => {
    expect(readDevelopSettings(withMasks())).toEqual(withMasks());
    expect(readDevelopSettings(withMasks({ v: 4 }))).toBeNull();
    expect(readDevelopSettings(withMasks({ v: 1 }, [linear({ enabled: false })]))).toBeNull();
    expect(readDevelopSettings(withMasks({}, [{ id: "broken" }]))).toBeNull();
    expect(readDevelopSettings(withMasks({}, []))).not.toBeNull();
    expect(readDevelopSettings(withMasks({ v: 4 }, []))).not.toBeNull();
    expect(readDevelopSettings({ ...withMasks(), masks: null })).toBeNull();
    expect(isEditableDevelopSettings(withMasks())).toBe(true);
    expect(isEditableDevelopSettings(withMasks({ v: 4 }))).toBe(false);
    expect(isEditableDevelopSettings(withMasks({}, [{ id: "broken" }]))).toBe(false);
    expect(isEditableDevelopSettings(withMasks({ v: 8 }))).toBe(false);
    expect(
      isEditableDevelopSettings(withMasks({ whiteBalance: { mode: "absolute", temperature: 5500, tint: 0 } }, [linear({ adjust: { relativeTint: 3 } })])),
    ).toBe(false);
    // 幾何を扱えない面でも、マスクだけなら直せる（幾何がなければ）
    expect(isEditableDevelopSettings(withMasks(), { geometry: false })).toBe(true);
  });

  it("画を変えるマスクがあれば neutral でない（無効・空の adjust・マスクなしは neutral のまま）", () => {
    expect(isNeutralDevelopColors(withMasks())).toBe(false);
    expect(isNeutralDevelopSettings(withMasks())).toBe(false);
    expect(isNeutralDevelopColors(withMasks({}, [linear({ enabled: false })]))).toBe(true);
    expect(isNeutralDevelopColors(withMasks({}, [linear({ adjust: {} })]))).toBe(true);
    expect(isNeutralDevelopColors(withMasks({}, []))).toBe(true);
    // 壊れた形は neutral にしない
    expect(isNeutralDevelopColors(withMasks({}, [{ id: "broken" }]))).toBe(false);
  });

  it("「初期化」はマスクを外す（幾何は保つ）", () => {
    expect(resetDevelopSettingsColors(withMasks(), null)).toEqual(neutralDevelopSettings(null));
    const reset = resetDevelopSettingsColors(withMasks({ geometry: { rotate: 90 } }), null);
    expect(reset).not.toHaveProperty("masks");
    expect(reset.v).toBe(2);
  });

  it("プリセットと自動はその写真のマスクを変えない（プリセットの結果にあっても使わない）", () => {
    const base = withMasks({ exposure: 0.2 });
    const result = { ...neutralDevelopSettings(null), v: 1, exposure: 1 } as DevelopSettings;
    const preset = presetDevelopSettings(base, result);
    expect(preset.masks).toEqual([MASK]);
    expect(preset.v).toBe(5);
    expect(preset.exposure).toBe(1);
    const other = [linear({ id: "other" })];
    expect(presetDevelopSettings(base, { ...result, masks: other, v: 5 }).masks).toEqual([MASK]);
    // 写真にマスクが無ければ、結果のマスクも持ち込まない
    const none = presetDevelopSettings(neutralDevelopSettings(null), { ...result, masks: other, v: 5 });
    expect(none).not.toHaveProperty("masks");
    expect(none.v).toBe(1);
    const auto = autoDevelopSettings(base, { ...result, exposure: 0.5 });
    expect(auto.masks).toEqual([MASK]);
    expect(auto.v).toBe(5);
    expect(auto.exposure).toBe(0.5);
  });

  it("補正のコピーはマスクを持ち出さず、貼り付けは貼り付け先のマスクを保つ", () => {
    const source = withMasks({ exposure: 0.8 });
    const copied = copyDevelopSettings(source);
    expect(copied).not.toHaveProperty("masks");
    expect(copied).not.toHaveProperty("v");
    expect(copied.exposure).toBe(0.8);
    const targetMasks = [linear({ id: "target" })];
    const target = withMasks({ exposure: 0.1 }, targetMasks);
    const pasted = pasteDevelopSettings(target, copied);
    expect(pasted.masks).toEqual(targetMasks);
    expect(pasted.v).toBe(5);
    expect(pasted.exposure).toBe(0.8);
    // 貼り付け先にマスクが無ければ付かない（コピーに紛れていても使わない）
    const plain = pasteDevelopSettings(neutralDevelopSettings(null), { ...copied, masks: [MASK] });
    expect(plain).not.toHaveProperty("masks");
    expect(plain.v).toBe(1);
  });

  it("旧形式（Photo Bench）へは、マスクがあれば戻せない", () => {
    expect(developSettingsToEditSettings(withMasks())).toBeNull();
    expect(developSettingsToEditSettings(withMasks({}, [linear({ enabled: false })]))).toBeNull();
    const empty = developSettingsToEditSettings(withMasks({}, []));
    expect(empty).toMatchObject({ whiteBalance: { mode: "asShot" } });
    expect(empty).not.toHaveProperty("masks");
  });

  it("スライダーの上書き・作業コピーへの付け替えはマスクと v 5 を保つ", () => {
    const applied = applyBrowserAdjustmentsToDevelopSettings(withMasks(), { exposure: 1, contrast: 0, saturation: 0, temperature: 0, tint: 0 });
    expect(applied.masks).toEqual([MASK]);
    expect(applied.v).toBe(5);
    const onCopy = developSettingsOnWorkingCopy(withMasks({ base: "raster.d1" }), "raster.d1");
    expect(onCopy.masks).toEqual([MASK]);
    expect(onCopy.v).toBe(5);
  });

  it("プリセットに保存できない項目の表示に「部分補正（マスク）」がある", () => {
    expect(photoEditingPresetNotWrittenError(["masks"])).toContain("部分補正（マスク）");
    expect(photoEditingPresetNotWrittenError(["masks", "colorPoints"])).toContain("部分補正（マスク）・ポイントカラー");
  });
});
