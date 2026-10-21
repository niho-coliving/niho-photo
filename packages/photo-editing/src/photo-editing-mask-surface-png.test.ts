import { deflateSync } from "node:zlib";

import { describe, expect, it } from "vitest";

import {
  PhotoEditingMaskSurfaceDecodeError,
  decodePhotoEditingMaskSurfacePng,
} from "./photo-editing-mask-surface-png";

/**
 * 面の PNG → 値（M4 #68）: エンジンの形（非 interlace の 8bit グレー）を、行のフィルタ 5 種のどれでも PNG の値のまま読む。
 * テスト用の符号化（zlib・フィルタを行ごとに選ぶ）で往復させる。
 */

function chunk(type: string, data: Uint8Array): Uint8Array {
  const out = new Uint8Array(12 + data.length);
  const view = new DataView(out.buffer);
  view.setUint32(0, data.length);
  for (let index = 0; index < 4; index += 1) out[4 + index] = type.charCodeAt(index);
  out.set(data, 8);
  // CRC は読まない（エンジンが中身を照らす）
  return out;
}

function gray8Png(width: number, height: number, raw: Uint8Array, interlace = 0): Uint8Array {
  const header = new Uint8Array(13);
  const view = new DataView(header.buffer);
  view.setUint32(0, width);
  view.setUint32(4, height);
  header[8] = 8;
  header[9] = 0;
  header[12] = interlace;
  const parts = [
    new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", header),
    chunk("IDAT", new Uint8Array(deflateSync(raw))),
    chunk("IEND", new Uint8Array(0)),
  ];
  const png = new Uint8Array(parts.reduce((sum, part) => sum + part.length, 0));
  let offset = 0;
  for (const part of parts) {
    png.set(part, offset);
    offset += part.length;
  }
  return png;
}

function paeth(a: number, b: number, c: number): number {
  const p = a + b - c;
  const pa = Math.abs(p - a);
  const pb = Math.abs(p - b);
  const pc = Math.abs(p - c);
  if (pa <= pb && pa <= pc) return a;
  return pb <= pc ? b : c;
}

/** テスト用の 8bit グレーの PNG（`filters[y % filters.length]` を行のフィルタに使う）。 */
function encodeGray8(width: number, height: number, data: Uint8Array, filters: number[] = [0], options: { interlace?: number } = {}) {
  const raw = new Uint8Array((width + 1) * height);
  for (let y = 0; y < height; y += 1) {
    const filter = filters[y % filters.length]!;
    raw[y * (width + 1)] = filter;
    for (let x = 0; x < width; x += 1) {
      const value = data[y * width + x]!;
      const left = x > 0 ? data[y * width + x - 1]! : 0;
      const up = y > 0 ? data[(y - 1) * width + x]! : 0;
      const upLeft = x > 0 && y > 0 ? data[(y - 1) * width + x - 1]! : 0;
      const predictor = [0, left, up, (left + up) >> 1, paeth(left, up, upLeft)][filter]!;
      raw[y * (width + 1) + 1 + x] = (value - predictor) & 0xff;
    }
  }
  return gray8Png(width, height, raw, options.interlace ?? 0);
}

function sample(width: number, height: number): Uint8Array {
  const data = new Uint8Array(width * height);
  for (let index = 0; index < data.length; index += 1) data[index] = (index * 37 + (index >> 3) * 11) & 0xff;
  return data;
}

describe("decodePhotoEditingMaskSurfacePng", () => {
  it("行のフィルタ 5 種のどれでも、値を PNG のまま読む（往復）", async () => {
    const data = sample(31, 9);
    for (const filters of [[0], [1], [2], [3], [4], [0, 1, 2, 3, 4]]) {
      const decoded = await decodePhotoEditingMaskSurfacePng(encodeGray8(31, 9, data, filters));
      expect(decoded.width).toBe(31);
      expect(decoded.height).toBe(9);
      expect([...decoded.data]).toEqual([...data]);
    }
  });

  it("IDAT が分かれていても読む", async () => {
    const data = sample(16, 16);
    const png = encodeGray8(16, 16, data, [2]);
    // IDAT を 2 つに割った PNG を作り直す
    const idatStart = 8 + 25;
    const length = new DataView(png.buffer).getUint32(idatStart);
    const body = png.subarray(idatStart + 8, idatStart + 8 + length);
    const split = Math.floor(body.length / 2);
    const rebuilt = new Uint8Array([
      ...png.subarray(0, idatStart),
      ...chunk("IDAT", body.subarray(0, split)),
      ...chunk("IDAT", body.subarray(split)),
      ...chunk("IEND", new Uint8Array(0)),
    ]);
    expect([...(await decodePhotoEditingMaskSurfacePng(rebuilt)).data]).toEqual([...data]);
  });

  it("PNG でない・寸法の無い・壊れた中身は投げる（読めない面には塗らない）", async () => {
    await expect(decodePhotoEditingMaskSurfacePng(new Uint8Array([1, 2, 3]))).rejects.toBeInstanceOf(PhotoEditingMaskSurfaceDecodeError);
    const png = encodeGray8(4, 4, sample(4, 4));
    const broken = png.slice();
    // IDAT の中身を壊す
    broken.fill(0xff, 8 + 25 + 8, 8 + 25 + 14);
    await expect(decodePhotoEditingMaskSurfacePng(broken)).rejects.toBeInstanceOf(PhotoEditingMaskSurfaceDecodeError);
    const zeroWidth = png.slice();
    new DataView(zeroWidth.buffer).setUint32(16, 0);
    await expect(decodePhotoEditingMaskSurfacePng(zeroWidth)).rejects.toBeInstanceOf(PhotoEditingMaskSurfaceDecodeError);
  });

  it("読み込み PNG の上限と、宣言寸法を超える展開を拒む", async () => {
    await expect(decodePhotoEditingMaskSurfacePng(new Uint8Array(8 * 1024 * 1024 + 1))).rejects.toBeInstanceOf(
      PhotoEditingMaskSurfaceDecodeError,
    );
    // 1×1 の宣言に対して大きな IDAT を持たせても、展開結果を寸法分より先に読み込まない。
    const oversizedRaw = new Uint8Array(8 * 1024 * 1024);
    await expect(decodePhotoEditingMaskSurfacePng(gray8Png(1, 1, oversizedRaw))).rejects.toBeInstanceOf(
      PhotoEditingMaskSurfaceDecodeError,
    );
  });

  it("エンジンの形でない PNG（interlace）は画像として読む口へ回す（その口の無い環境では投げる）", async () => {
    const png = encodeGray8(4, 4, sample(4, 4), [0], { interlace: 1 });
    await expect(decodePhotoEditingMaskSurfacePng(png)).rejects.toBeInstanceOf(PhotoEditingMaskSurfaceDecodeError);
  });
});
