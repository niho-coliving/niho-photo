import { deflateSync } from "node:zlib";

import { describe, expect, it } from "vitest";

import {
  applyCutoutStrokes,
  composeCutoutRgba,
  createCutoutRecipe,
  downscaleCutoutMask,
  type CutoutBrushStroke,
  type CutoutDetection,
  type CutoutRecipe,
} from "./photo-cutout";

import { BrowserPhotoCutoutExportError, composeBrowserPhotoCutoutRgba } from "./browser-photo-cutout-export";

/**
 * 背景除去を当てた書き出しの画素の計算（NIHO camera。C4 移行元設計）: 原寸のマスクを描いた大きさに縮めてからブラシを塗り、形式の背景
 * （JPEG は透明を白に）で合成すること・縦横比の違うマスクを当てないこと。
 */

const sha = (char: string) => char.repeat(64);

/** 8bit グレーの PNG（filter 0 だけ。CRC は読み手が見ないので 0 のまま）。 */
function grayPng(rows: number[][]): Uint8Array {
  const width = rows[0]!.length;
  const raw = Buffer.from(rows.flatMap((row) => [0, ...row]));
  const chunk = (type: string, data: Buffer) => {
    const out = Buffer.alloc(12 + data.length);
    out.writeUInt32BE(data.length, 0);
    out.write(type, 4, "latin1");
    data.copy(out, 8);
    return out;
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(rows.length, 4);
  ihdr[8] = 8;
  ihdr[9] = 0;
  return new Uint8Array(
    Buffer.concat([
      Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
      chunk("IHDR", ihdr),
      chunk("IDAT", deflateSync(raw)),
      chunk("IEND", Buffer.alloc(0)),
    ]),
  );
}

/** 4 x 2 の写真の被写体 1 つ（右半分が被写体）。 */
const DETECTION: CutoutDetection = {
  schemaVersion: 1,
  engine: "VNGenerateForegroundInstanceMaskRequest",
  engineRevision: 1,
  width: 4,
  height: 2,
  inputSHA256: sha("a"),
  sourceOrientation: 1,
  largest: "instance-1",
  subjects: [{ selection: "instance-1", pixelCount: 4, mask: `${sha("1")}.png`, maskSHA256: sha("1"), maskWidth: 4, maskHeight: 2 }],
};
const MASK_ROWS = [
  [0, 0, 255, 255],
  [0, 0, 255, 255],
];
const MASK_PNG = grayPng(MASK_ROWS);

/** 描いた画（`width` x `height`。どの画素も同じ色・不透明）。 */
function rendered(width: number, height: number): Uint8ClampedArray {
  const rgba = new Uint8ClampedArray(width * height * 4);
  for (let index = 0; index < width * height; index += 1) rgba.set([10, 20, 30, 255], index * 4);
  return rgba;
}

function recipe(overrides: Partial<CutoutRecipe> = {}): CutoutRecipe {
  return { ...createCutoutRecipe(DETECTION), ...overrides };
}

/** 画素ごとの [r, g, b, a] */
function pixels(rgba: Uint8ClampedArray): number[][] {
  return Array.from({ length: rgba.length / 4 }, (_, index) => Array.from(rgba.subarray(index * 4, index * 4 + 4)));
}

describe("composeBrowserPhotoCutoutRgba", () => {
  it("PNG の透明の背景は alpha のまま（被写体の外を透明に、色は残す）", async () => {
    const out = await composeBrowserPhotoCutoutRgba({ rgba: rendered(4, 2), width: 4, height: 2, maskPng: MASK_PNG, recipe: recipe(), format: "png" });
    expect(pixels(out)).toEqual([
      [10, 20, 30, 0],
      [10, 20, 30, 0],
      [10, 20, 30, 255],
      [10, 20, 30, 255],
      [10, 20, 30, 0],
      [10, 20, 30, 0],
      [10, 20, 30, 255],
      [10, 20, 30, 255],
    ]);
  });

  it("JPEG は透明の背景を白に合成し（不透明）、色の背景はどちらの形式でもその色を敷く", async () => {
    const jpeg = await composeBrowserPhotoCutoutRgba({ rgba: rendered(4, 2), width: 4, height: 2, maskPng: MASK_PNG, recipe: recipe(), format: "jpeg" });
    expect(pixels(jpeg).slice(0, 4)).toEqual([
      [255, 255, 255, 255],
      [255, 255, 255, 255],
      [10, 20, 30, 255],
      [10, 20, 30, 255],
    ]);
    const color = await composeBrowserPhotoCutoutRgba({
      rgba: rendered(4, 2),
      width: 4,
      height: 2,
      maskPng: MASK_PNG,
      recipe: recipe({ background: { kind: "color", color: "#ff0000" } }),
      format: "png",
    });
    expect(pixels(color).slice(0, 4)).toEqual([
      [255, 0, 0, 255],
      [255, 0, 0, 255],
      [10, 20, 30, 255],
      [10, 20, 30, 255],
    ]);
  });

  it("原寸のマスクを描いた大きさへ縮めてから、確定したブラシをその大きさで塗る（プレビューと同じ順）", async () => {
    const strokes: CutoutBrushStroke[] = [
      { mode: "erase", radius: 0.5, points: [{ x: 1, y: 0 }] },
      { mode: "restore", radius: 0.5, points: [{ x: 0, y: 1 }] },
    ];
    const withStrokes = recipe({ strokes });
    const out = await composeBrowserPhotoCutoutRgba({ rgba: rendered(2, 1), width: 2, height: 1, maskPng: MASK_PNG, recipe: withStrokes, format: "png" });
    const scaled = downscaleCutoutMask({ width: 4, height: 2, pixels: new Uint8Array(MASK_ROWS.flat()) }, 2, 1);
    expect(Array.from(scaled.pixels)).toEqual([0, 255]);
    const expected = composeCutoutRgba(
      rendered(2, 1),
      { width: 2, height: 1, pixels: applyCutoutStrokes(scaled.pixels, 2, 1, strokes) },
      { kind: "transparent" },
    );
    expect(Array.from(out)).toEqual(Array.from(expected));
    // ブラシが効いている（消した右は被写体でなくなり、戻した左は被写体になる）
    expect(pixels(out).map((pixel) => pixel[3])).toEqual([255, 0]);
  });

  it("縦横比が 1% を超えて違う・detect の答えと寸法の違う・描いた画より小さいマスクは当てない（mask_mismatch）", async () => {
    const base = { maskPng: MASK_PNG, recipe: recipe(), format: "png" as const };
    const mismatch = expect.objectContaining({
      name: "BrowserPhotoCutoutExportError",
      code: "mask_mismatch",
      message: "保存していた背景除去を読めませんでした。もう一度「背景を除去」を押してください。",
    });
    await expect(composeBrowserPhotoCutoutRgba({ ...base, rgba: rendered(3, 1), width: 3, height: 1 })).rejects.toEqual(mismatch);
    // 拡大はしない
    await expect(composeBrowserPhotoCutoutRgba({ ...base, rgba: rendered(8, 4), width: 8, height: 4 })).rejects.toEqual(mismatch);
    const otherSize = recipe({
      detection: { ...DETECTION, width: 8, height: 4, subjects: [{ ...DETECTION.subjects[0]!, maskWidth: 8, maskHeight: 4 }] },
    });
    await expect(composeBrowserPhotoCutoutRgba({ ...base, recipe: otherSize, rgba: rendered(4, 2), width: 4, height: 2 })).rejects.toBeInstanceOf(
      BrowserPhotoCutoutExportError,
    );
    // 1% 以内なら縦横を別々に縮めて当てる（200 x 100 のマスクを 199 x 100 に）
    const wide = grayPng(Array.from({ length: 100 }, () => new Array<number>(200).fill(255)));
    const wideRecipe = recipe({
      detection: { ...DETECTION, width: 200, height: 100, subjects: [{ ...DETECTION.subjects[0]!, maskWidth: 200, maskHeight: 100 }] },
    });
    const near = await composeBrowserPhotoCutoutRgba({ maskPng: wide, recipe: wideRecipe, format: "png", rgba: rendered(199, 100), width: 199, height: 100 });
    expect(near.length).toBe(199 * 100 * 4);
  });

  it("マスクの PNG を読めなければ corrupt_mask", async () => {
    await expect(
      composeBrowserPhotoCutoutRgba({ rgba: rendered(4, 2), width: 4, height: 2, maskPng: new Uint8Array([1, 2, 3]), recipe: recipe(), format: "png" }),
    ).rejects.toEqual(expect.objectContaining({ code: "corrupt_mask" }));
  });
});
