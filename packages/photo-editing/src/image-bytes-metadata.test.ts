import { describe, expect, it } from "vitest";

import { readJpegPixelSize, readPngPixelSize, scrubJpegGpsMetadata } from "./image-bytes-metadata";

type IfdEntrySpec = { tag: number; type: number; count: number; value: number };

const TAG_ORIENTATION = 0x0112;
const TAG_MAKE = 0x010f;
const TAG_GPS_POINTER = 0x8825;
const TAG_PRINT_IM = 0xc4a5;
const NEXT_IFD_SENTINEL = 0x1234;

/**
 * テスト用の最小 EXIF(TIFF) を組み立てる。
 * IFD0: Make("Apple", 値は IFD の外) / Orientation(=6) / GPS ポインタ / PrintIM(GPS の後ろの項目)
 *       次の IFD オフセットには目印の値を入れ、項目を詰めた後も正しい位置に残るかを見る。
 * GPS IFD: GPSLatitudeRef("N", 項目内) / GPSLatitude(RATIONAL×3, 値は IFD の外)
 */
function buildExifTiff(options: { littleEndian: boolean; gpsLatitudeType?: number; gpsOffsetOverride?: number }) {
  const { littleEndian } = options;
  const ifd0Offset = 8;
  const ifd0Entries = 4;
  const ifd0Size = 2 + ifd0Entries * 12 + 4; // 54
  const makeOffset = ifd0Offset + ifd0Size; // 62
  const gpsOffset = makeOffset + 6; // 68
  const gpsSize = 2 + 2 * 12 + 4; // 30
  const latitudeOffset = gpsOffset + gpsSize; // 98
  const length = latitudeOffset + 24; // 122

  const bytes = new Uint8Array(length);
  const view = new DataView(bytes.buffer);
  bytes.set(littleEndian ? [0x49, 0x49] : [0x4d, 0x4d], 0);
  view.setUint16(2, 42, littleEndian);
  view.setUint32(4, ifd0Offset, littleEndian);

  const writeIfd = (start: number, entries: IfdEntrySpec[], nextIfdOffset = 0) => {
    view.setUint16(start, entries.length, littleEndian);
    entries.forEach((entry, index) => {
      const at = start + 2 + index * 12;
      view.setUint16(at, entry.tag, littleEndian);
      view.setUint16(at + 2, entry.type, littleEndian);
      view.setUint32(at + 4, entry.count, littleEndian);
      if (entry.type === 3 && entry.count === 1) view.setUint16(at + 8, entry.value, littleEndian);
      else view.setUint32(at + 8, entry.value, littleEndian);
    });
    view.setUint32(start + 2 + entries.length * 12, nextIfdOffset, littleEndian);
  };

  writeIfd(ifd0Offset, [
    { tag: TAG_MAKE, type: 2, count: 6, value: makeOffset },
    { tag: TAG_ORIENTATION, type: 3, count: 1, value: 6 },
    { tag: TAG_GPS_POINTER, type: 4, count: 1, value: options.gpsOffsetOverride ?? gpsOffset },
    { tag: TAG_PRINT_IM, type: 7, count: 4, value: 0x01020304 },
  ], NEXT_IFD_SENTINEL);
  bytes.set(Array.from("Apple\0", (char) => char.charCodeAt(0)), makeOffset);
  writeIfd(gpsOffset, [
    { tag: 0x0001, type: 2, count: 2, value: 0 },
    { tag: 0x0002, type: options.gpsLatitudeType ?? 5, count: 3, value: latitudeOffset },
  ]);
  bytes[gpsOffset + 2 + 8] = 0x4e; // "N"（項目の中に入る値）
  [35, 1, 18, 1, 5000, 100].forEach((value, index) => view.setUint32(latitudeOffset + index * 4, value, littleEndian));

  return { bytes, gpsOffset, gpsEnd: length };
}

function segment(marker: number, data: Uint8Array): Uint8Array {
  const out = new Uint8Array(4 + data.length);
  out[0] = 0xff;
  out[1] = marker;
  out[2] = ((data.length + 2) >> 8) & 0xff;
  out[3] = (data.length + 2) & 0xff;
  out.set(data, 4);
  return out;
}

function concat(parts: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((sum, part) => sum + part.length, 0));
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.length;
  }
  return out;
}

function ascii(text: string): Uint8Array {
  return Uint8Array.from(text, (char) => char.charCodeAt(0));
}

function buildJpeg(options: { width: number; height: number; app1?: Uint8Array[] }): Uint8Array {
  const sof = new Uint8Array([8, options.height >> 8, options.height & 0xff, options.width >> 8, options.width & 0xff, 1, 1, 0x11, 0]);
  const sos = new Uint8Array([1, 1, 0, 0, 63, 0]);
  return concat([
    new Uint8Array([0xff, 0xd8]),
    ...(options.app1 ?? []).map((data) => segment(0xe1, data)),
    segment(0xc0, sof),
    segment(0xda, sos),
    new Uint8Array([0x12, 0x34, 0x56]),
    new Uint8Array([0xff, 0xd9]),
  ]);
}

function exifApp1(tiff: Uint8Array): Uint8Array {
  return concat([ascii("Exif\0\0"), tiff]);
}

/** 書き換え後の IFD0 を読み直す（テスト側の独立した読み取り）。 */
function readIfd0(jpeg: Uint8Array, tiffStart: number, littleEndian: boolean) {
  const view = new DataView(jpeg.buffer, jpeg.byteOffset, jpeg.byteLength);
  const ifd0 = tiffStart + view.getUint32(tiffStart + 4, littleEndian);
  const count = view.getUint16(ifd0, littleEndian);
  const entries = new Map<number, { type: number; count: number; at: number }>();
  for (let index = 0; index < count; index += 1) {
    const at = ifd0 + 2 + index * 12;
    entries.set(view.getUint16(at, littleEndian), {
      type: view.getUint16(at + 2, littleEndian),
      count: view.getUint32(at + 4, littleEndian),
      at,
    });
  }
  const nextIfdOffset = view.getUint32(ifd0 + 2 + count * 12, littleEndian);
  return { entries, nextIfdOffset, view };
}

// SOI(2) + APP1 マーカー(2) + 長さ(2) + "Exif\0\0"(6)
const TIFF_START_IN_JPEG = 12;

describe("scrubJpegGpsMetadata", () => {
  it.each([
    { label: "little-endian (II)", littleEndian: true },
    { label: "big-endian (MM)", littleEndian: false },
  ])("removes the GPS IFD losslessly and keeps Orientation ($label)", ({ littleEndian }) => {
    const tiff = buildExifTiff({ littleEndian });
    const jpeg = buildJpeg({ width: 1600, height: 1200, app1: [exifApp1(tiff.bytes)] });
    const before = jpeg.slice();

    const result = scrubJpegGpsMetadata(jpeg);

    expect(result.status).toBe("scrubbed");
    if (result.status !== "scrubbed") return;
    // 入力は書き換えない。長さも変えない（オフセットを動かさないため）。
    expect(jpeg).toEqual(before);
    expect(result.bytes.length).toBe(jpeg.length);

    const { entries, nextIfdOffset, view } = readIfd0(result.bytes, TIFF_START_IN_JPEG, littleEndian);
    expect(entries.has(TAG_GPS_POINTER)).toBe(false);
    expect([...entries.keys()]).toEqual([TAG_MAKE, TAG_ORIENTATION, TAG_PRINT_IM]);
    // GPS の後ろにあった項目と次の IFD オフセットは 12 バイト前へ詰めて残る。
    const printIm = entries.get(TAG_PRINT_IM);
    expect(printIm && view.getUint32(printIm.at + 8, littleEndian)).toBe(0x01020304);
    expect(nextIfdOffset).toBe(NEXT_IFD_SENTINEL);
    // 向き（Orientation=6）は残る。
    const orientation = entries.get(TAG_ORIENTATION);
    expect(orientation && view.getUint16(orientation.at + 8, littleEndian)).toBe(6);
    // IFD の外にある Make の値も元の位置のまま読める。
    const make = entries.get(TAG_MAKE);
    const makeOffset = make ? view.getUint32(make.at + 8, littleEndian) : -1;
    expect(String.fromCharCode(...result.bytes.slice(TIFF_START_IN_JPEG + makeOffset, TIFF_START_IN_JPEG + makeOffset + 5))).toBe("Apple");

    // GPS IFD と緯度の値はすべてゼロで塗られ、元の座標が残っていない。
    const gpsRegion = result.bytes.slice(TIFF_START_IN_JPEG + tiff.gpsOffset, TIFF_START_IN_JPEG + tiff.gpsEnd);
    expect(gpsRegion.every((value) => value === 0)).toBe(true);
    // 画像データ（SOF 以降）は 1 バイトも変わらない。
    const imageStart = TIFF_START_IN_JPEG + tiff.bytes.length;
    expect(result.bytes.slice(imageStart)).toEqual(jpeg.slice(imageStart));
    expect(readJpegPixelSize(result.bytes)).toEqual({ width: 1600, height: 1200 });
  });

  it("reports no-gps when EXIF has no GPS pointer", () => {
    const jpeg = buildJpeg({ width: 800, height: 600, app1: [exifApp1(new Uint8Array([0x49, 0x49, 42, 0, 8, 0, 0, 0, 0, 0, 0, 0, 0, 0]))] });
    expect(scrubJpegGpsMetadata(jpeg)).toEqual({ status: "no-gps" });
  });

  it("reports no-gps for a JPEG without any APP1 segment", () => {
    expect(scrubJpegGpsMetadata(buildJpeg({ width: 800, height: 600 }))).toEqual({ status: "no-gps" });
  });

  it("asks for a re-encode when XMP carries GPS coordinates", () => {
    const xmp = ascii('http://ns.adobe.com/xap/1.0/\0<x:xmpmeta><rdf:Description exif:GPSLatitude="35,18.5N"/></x:xmpmeta>');
    const jpeg = buildJpeg({ width: 800, height: 600, app1: [xmp] });
    expect(scrubJpegGpsMetadata(jpeg)).toEqual({ status: "unscrubbable" });
  });

  it("asks for a re-encode when a GPS entry has an unknown TIFF type", () => {
    const tiff = buildExifTiff({ littleEndian: true, gpsLatitudeType: 99 });
    const jpeg = buildJpeg({ width: 800, height: 600, app1: [exifApp1(tiff.bytes)] });
    expect(scrubJpegGpsMetadata(jpeg)).toEqual({ status: "unscrubbable" });
  });

  it("asks for a re-encode when the GPS pointer is out of bounds", () => {
    const tiff = buildExifTiff({ littleEndian: true, gpsOffsetOverride: 10_000 });
    const jpeg = buildJpeg({ width: 800, height: 600, app1: [exifApp1(tiff.bytes)] });
    expect(scrubJpegGpsMetadata(jpeg)).toEqual({ status: "unscrubbable" });
  });

  it("asks for a re-encode when the bytes are not a JPEG", () => {
    expect(scrubJpegGpsMetadata(new Uint8Array([0x89, 0x50, 0x4e, 0x47]))).toEqual({ status: "unscrubbable" });
  });
});

describe("readJpegPixelSize / readPngPixelSize", () => {
  it("reads the frame size from the JPEG SOF header", () => {
    expect(readJpegPixelSize(buildJpeg({ width: 4000, height: 3000 }))).toEqual({ width: 4000, height: 3000 });
  });

  it("returns null for bytes that are not a JPEG", () => {
    expect(readJpegPixelSize(new Uint8Array([0, 1, 2, 3]))).toBeNull();
  });

  it("reads the size from the PNG IHDR chunk", () => {
    const png = new Uint8Array(33);
    png.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52], 0);
    const view = new DataView(png.buffer);
    view.setUint32(16, 3000);
    view.setUint32(20, 2000);
    expect(readPngPixelSize(png)).toEqual({ width: 3000, height: 2000 });
  });
});
