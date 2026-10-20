import { describe, expect, it } from "vitest";

import {
  findRawEmbeddedJpegs,
  readRawOrientation,
  readTiffOrientation,
  resolveRawPreviewOrientation,
  type RawEmbeddedJpeg,
} from "./raw-embedded-preview";

function concat(...parts: Uint8Array[]): Uint8Array {
  const total = parts.reduce((sum, part) => sum + part.length, 0);
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const part of parts) {
    bytes.set(part, offset);
    offset += part.length;
  }
  return bytes;
}

function segment(marker: number, payload: Uint8Array): Uint8Array {
  const length = payload.length + 2;
  return concat(new Uint8Array([0xff, marker, (length >> 8) & 0xff, length & 0xff]), payload);
}

/** IFD0 に向き（SHORT）だけを持つ TIFF。`magic` は TIFF=42・RW2=0x55・ORF="RO"。 */
function tiff(options: { orientation: number | null; littleEndian?: boolean; magic?: number }): Uint8Array {
  const littleEndian = options.littleEndian ?? true;
  const bytes = new Uint8Array(8 + 2 + 12 + 4);
  const view = new DataView(bytes.buffer);
  bytes.set(littleEndian ? [0x49, 0x49] : [0x4d, 0x4d], 0);
  view.setUint16(2, options.magic ?? 42, littleEndian);
  view.setUint32(4, 8, littleEndian);
  if (options.orientation === null) {
    view.setUint16(8, 1, littleEndian);
    view.setUint16(10, 0x0100, littleEndian); // ImageWidth
    view.setUint16(12, 3, littleEndian);
    view.setUint32(14, 1, littleEndian);
    view.setUint16(18, 4000, littleEndian);
  } else {
    view.setUint16(8, 1, littleEndian);
    view.setUint16(10, 0x0112, littleEndian);
    view.setUint16(12, 3, littleEndian);
    view.setUint32(14, 1, littleEndian);
    view.setUint16(18, options.orientation, littleEndian);
  }
  return bytes;
}

/** 最小の JPEG（SOF・SOS・圧縮データ・EOI）。`exifOrientation` を渡すと EXIF の APP1 も付ける。 */
function jpeg(options: {
  width: number;
  height: number;
  sof?: number;
  precision?: number;
  exifOrientation?: number;
  entropy?: number[];
  betweenScans?: boolean;
}): Uint8Array {
  const sofPayload = new Uint8Array(15);
  const sofView = new DataView(sofPayload.buffer);
  sofPayload[0] = options.precision ?? 8;
  sofView.setUint16(1, options.height);
  sofView.setUint16(3, options.width);
  sofPayload[5] = 3;
  const sosPayload = new Uint8Array([3, 1, 0, 2, 0x11, 3, 0x11, 0, 63, 0]);
  const entropy = new Uint8Array(options.entropy ?? [0x12, 0xff, 0x00, 0x34, 0xff, 0xd0, 0x56]);
  const parts: Uint8Array[] = [new Uint8Array([0xff, 0xd8])];
  if (options.exifOrientation !== undefined) {
    parts.push(segment(0xe1, concat(new TextEncoder().encode("Exif\0\0"), tiff({ orientation: options.exifOrientation }))));
  }
  parts.push(segment(0xdb, new Uint8Array(65)));
  parts.push(segment(options.sof ?? 0xc0, sofPayload));
  parts.push(segment(0xda, sosPayload), entropy);
  if (options.betweenScans) {
    // progressive: 走査の間に DHT と次の SOS が挟まる（DHT の値に FF D9 が現れても終わりとみなさない）
    parts.push(segment(0xc4, new Uint8Array([0x10, 0xff, 0xd9, 0x01])), segment(0xda, sosPayload), entropy);
  }
  parts.push(new Uint8Array([0xff, 0xd9]));
  return concat(...parts);
}

function filler(length: number, seed = 7): Uint8Array {
  const bytes = new Uint8Array(length);
  let state = seed;
  for (let index = 0; index < length; index += 1) {
    state = (state * 1103515245 + 12345) & 0x7fffffff;
    bytes[index] = state & 0xff;
  }
  return bytes;
}

/** 圧縮データらしい bytes（0xFF の後には必ず 0x00 を詰める）。 */
function stuffedEntropy(length: number, seed: number): number[] {
  const entropy: number[] = [];
  for (const byte of filler(length, seed)) {
    entropy.push(byte);
    if (byte === 0xff) entropy.push(0x00);
  }
  return entropy;
}

function positionOf(haystack: Uint8Array, needle: Uint8Array): number {
  outer: for (let offset = 0; offset + needle.length <= haystack.length; offset += 1) {
    for (let index = 0; index < needle.length; index += 1) {
      if (haystack[offset + index] !== needle[index]) continue outer;
    }
    return offset;
  }
  return -1;
}

describe("findRawEmbeddedJpegs", () => {
  it("RAW の bytes から、ブラウザで開ける最大の埋め込み JPEG を区間ごと返す（サムネイル・可逆 JPEG の RAW 本体は除く）", () => {
    const thumbnail = jpeg({ width: 160, height: 120 });
    const preview = jpeg({ width: 1616, height: 1080 });
    const full = jpeg({ width: 5472, height: 3648 });
    const rawData = jpeg({ width: 6000, height: 4000, sof: 0xc3, entropy: stuffedEntropy(4096, 3) });
    const raw = concat(tiff({ orientation: 6 }), filler(300), thumbnail, filler(200), preview, filler(100), full, filler(50), rawData);

    const found = findRawEmbeddedJpegs(raw);

    expect(found.map((item) => [item.width, item.height])).toEqual([
      [5472, 3648],
      [1616, 1080],
    ]);
    const start = positionOf(raw, full);
    expect(found[0]).toMatchObject({ start, end: start + full.length, orientation: null });
  });

  it("4,000 万画素を超える JPEG は選ばず、次に大きいものを返す", () => {
    const huge = jpeg({ width: 8192, height: 5464 });
    const preview = jpeg({ width: 1620, height: 1080 });
    const found = findRawEmbeddedJpegs(concat(filler(64), huge, filler(64), preview));
    expect(found.map((item) => item.width)).toEqual([1620]);
  });

  it("圧縮データの FF 00・RST と、progressive の走査の間の段を読み飛ばして終わりを見つける", () => {
    const progressive = jpeg({ width: 1920, height: 1440, sof: 0xc2, betweenScans: true });
    const raw = concat(filler(128), progressive, filler(128));
    const [found] = findRawEmbeddedJpegs(raw);
    const start = positionOf(raw, progressive);
    expect(found).toMatchObject({ start, end: start + progressive.length, width: 1920, height: 1440 });
  });

  it("12bit の JPEG・SOF の無い偽の SOI・壊れた JPEG は候補にしない", () => {
    const twelveBit = jpeg({ width: 2000, height: 1500, sof: 0xc1, precision: 12 });
    const fakeSoi = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x04, 0x00, 0x00, 0xff, 0xda, 0x00, 0x02]);
    // SOS の途中で切れた JPEG（次の JPEG の SOI まで EOI が無い）
    const truncated = jpeg({ width: 3000, height: 2000 }).subarray(0, 100);
    const valid = jpeg({ width: 1024, height: 768 });
    const found = findRawEmbeddedJpegs(
      concat(fakeSoi, new Uint8Array(50), twelveBit, truncated, new Uint8Array(50), valid),
    );
    expect(found.map((item) => [item.width, item.height])).toEqual([[1024, 768]]);
  });

  it("JPEG が無ければ空", () => {
    expect(findRawEmbeddedJpegs(filler(10_000))).toEqual([]);
    expect(findRawEmbeddedJpegs(new Uint8Array(0))).toEqual([]);
  });

  it("JPEG 自身の EXIF の向きを読む", () => {
    const [found] = findRawEmbeddedJpegs(concat(filler(10), jpeg({ width: 1920, height: 1080, exifOrientation: 8 })));
    expect(found?.orientation).toBe(8);
  });
});

describe("readRawOrientation", () => {
  it("TIFF 系（II / MM）・RW2・ORF の IFD0 の向きを読む", () => {
    expect(readRawOrientation(concat(tiff({ orientation: 6 }), filler(32)))).toBe(6);
    expect(readRawOrientation(concat(tiff({ orientation: 8, littleEndian: false }), filler(32)))).toBe(8);
    expect(readRawOrientation(tiff({ orientation: 3, magic: 0x55 }))).toBe(3);
    expect(readRawOrientation(tiff({ orientation: 6, magic: 0x4f52 }))).toBe(6);
  });

  it("CR3 は CMT1 の箱の TIFF を読む", () => {
    const cmt1Payload = tiff({ orientation: 6 });
    const box = concat(new Uint8Array([0, 0, 0, 8 + cmt1Payload.length]), new TextEncoder().encode("CMT1"), cmt1Payload);
    const cr3 = concat(new Uint8Array([0, 0, 0, 24]), new TextEncoder().encode("ftypcrx "), filler(16), box, filler(64));
    expect(readRawOrientation(cr3)).toBe(6);
  });

  it("向きが無い・読めなければ 1", () => {
    expect(readRawOrientation(tiff({ orientation: null }))).toBe(1);
    expect(readRawOrientation(filler(64))).toBe(1);
    expect(readTiffOrientation(tiff({ orientation: 9 }), 0)).toBeNull();
    expect(readTiffOrientation(tiff({ orientation: 6 }).subarray(0, 12), 0)).toBeNull();
  });
});

describe("resolveRawPreviewOrientation", () => {
  const landscape: RawEmbeddedJpeg = { start: 0, end: 10, width: 1600, height: 1200, orientation: null };

  it("JPEG 自身に向きが無く横長なら、RAW の向きを当てる", () => {
    expect(resolveRawPreviewOrientation(landscape, 6)).toBe(6);
  });

  it("JPEG 自身の EXIF 向き（1 を含む）がある・縦長（回し終えている）なら RAW の向きを重ねない", () => {
    expect(resolveRawPreviewOrientation({ ...landscape, orientation: 1 }, 8)).toBe(1);
    expect(resolveRawPreviewOrientation({ ...landscape, orientation: 6 }, 6)).toBe(1);
    expect(resolveRawPreviewOrientation({ ...landscape, width: 1200, height: 1600 }, 6)).toBe(1);
    expect(resolveRawPreviewOrientation(landscape, 0)).toBe(1);
  });
});
