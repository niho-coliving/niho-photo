/**
 * RAW に埋め込まれた JPEG（TIFF/IFD の `JpgFromRaw` / `PreviewImage` など）を、ブラウザで「写真を追加」するときの
 * プレビューの元として探す（移行元設計・移行時の設計文書「写真を追加」）。
 *
 * TIFF の IFD を厳密には辿らず、ファイルの bytes を 1 回走査して JPEG の区間（SOI `FF D8` → EOI `FF D9`）を見つける
 * （RW2 / CR2 / NEF / ARW / DNG のほか、CR3・RAF・ORF でも実用になる発見的な手法）。
 *
 * - ブラウザで開ける JPEG（8bit の SOF0〜2: baseline / extended / progressive）だけを候補にする。CR2・DNG の RAW 本体は
 *   可逆 JPEG（SOF3）なので候補にしない
 * - サムネイル（長辺 320px 未満）と、デコードが重すぎるもの（既定 4,000 万画素超）は候補にしない
 * - 候補は画素数の大きい順（同じなら bytes の大きい順）。デコードできなければ呼び出し側が次を試す
 *
 * 向き: JPEG 自身が EXIF の向きを持っていればデコーダ（`imageOrientation: "from-image"`）に任せ、持っていなければ RAW の
 * IFD0 の向きを描くときに当てる（{@link resolveRawPreviewOrientation}）。
 */

/** 走査する bytes の上限（クラウドのオリジナルの上限と同じ 200MiB）。 */
export const RAW_EMBEDDED_PREVIEW_MAX_SCAN_BYTES = 200 * 1024 * 1024;
/** これより小さい JPEG（EXIF のサムネイルなど）はプレビューにしない。 */
export const RAW_EMBEDDED_PREVIEW_MIN_LONG_EDGE = 320;
const DEFAULT_MAX_PIXELS = 40_000_000;
/** CR3（ISO BMFF）の IFD0 を探す範囲（`CMT1` の箱はファイルの先頭近くにある）。 */
const CR3_HEADER_SEARCH_BYTES = 1024 * 1024;

const MARKER_SOI = 0xd8;
const MARKER_EOI = 0xd9;
const MARKER_SOS = 0xda;
const MARKER_APP1 = 0xe1;
const TIFF_TAG_ORIENTATION = 0x0112;
const TIFF_TYPE_SHORT = 3;

export type RawEmbeddedJpeg = {
  /** bytes の中の JPEG の区間（`start` から `end` の手前まで） */
  start: number;
  end: number;
  width: number;
  height: number;
  /** JPEG 自身の EXIF の向き（1〜8。無ければ null） */
  orientation: number | null;
};

function readU16BE(bytes: Uint8Array, offset: number): number {
  return (bytes[offset]! << 8) | bytes[offset + 1]!;
}

function readU32BE(bytes: Uint8Array, offset: number): number {
  return ((bytes[offset]! << 24) | (bytes[offset + 1]! << 16) | (bytes[offset + 2]! << 8) | bytes[offset + 3]!) >>> 0;
}

/** SOF（フレームの寸法を持つ段）か。DHT(C4) / JPG(C8) / DAC(CC) は SOF ではない。 */
function isSofMarker(marker: number): boolean {
  return marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc;
}

/** ブラウザで開ける SOF（baseline / extended sequential / progressive）。 */
function isBrowserDecodableSof(marker: number): boolean {
  return marker === 0xc0 || marker === 0xc1 || marker === 0xc2;
}

/**
 * TIFF（`tiffStart` から始まる、`tiffEnd` の手前まで）の IFD0 の向き（1〜8）。読めなければ null。
 * TIFF（42）のほか、Panasonic RW2（0x55）と Olympus ORF（"RO" / "RS"）の見出しも読む。
 */
export function readTiffOrientation(bytes: Uint8Array, tiffStart: number, tiffEnd: number = bytes.length): number | null {
  const end = Math.min(tiffEnd, bytes.length);
  if (tiffStart < 0 || tiffStart + 8 > end) return null;
  let littleEndian: boolean;
  if (bytes[tiffStart] === 0x49 && bytes[tiffStart + 1] === 0x49) littleEndian = true;
  else if (bytes[tiffStart] === 0x4d && bytes[tiffStart + 1] === 0x4d) littleEndian = false;
  else return null;
  const u16 = (offset: number) =>
    littleEndian ? bytes[offset]! | (bytes[offset + 1]! << 8) : readU16BE(bytes, offset);
  const u32 = (offset: number) =>
    littleEndian
      ? (bytes[offset]! | (bytes[offset + 1]! << 8) | (bytes[offset + 2]! << 16) | (bytes[offset + 3]! << 24)) >>> 0
      : readU32BE(bytes, offset);

  const magic = u16(tiffStart + 2);
  if (magic !== 42 && magic !== 0x55 && magic !== 0x4f52 && magic !== 0x5352) return null;
  const ifd = tiffStart + u32(tiffStart + 4);
  if (ifd < tiffStart + 8 || ifd + 2 > end) return null;
  const count = u16(ifd);
  for (let index = 0; index < count; index += 1) {
    const entry = ifd + 2 + index * 12;
    if (entry + 12 > end) return null;
    if (u16(entry) !== TIFF_TAG_ORIENTATION) continue;
    if (u16(entry + 2) !== TIFF_TYPE_SHORT) return null;
    const value = u16(entry + 8);
    return value >= 1 && value <= 8 ? value : null;
  }
  return null;
}

function indexOfAscii(bytes: Uint8Array, text: string, from: number, until: number): number {
  const first = text.charCodeAt(0);
  const last = Math.min(until, bytes.length) - text.length;
  let offset = from;
  while (offset <= last) {
    const found = bytes.indexOf(first, offset);
    if (found < 0 || found > last) return -1;
    let matched = true;
    for (let index = 1; index < text.length; index += 1) {
      if (bytes[found + index] !== text.charCodeAt(index)) {
        matched = false;
        break;
      }
    }
    if (matched) return found;
    offset = found + 1;
  }
  return -1;
}

/**
 * RAW の IFD0 の向き（1〜8）。TIFF 系（CR2 / NEF / ARW / DNG / RW2 / ORF / PEF など）はファイルの先頭の TIFF、CR3 は
 * `CMT1` の箱の TIFF を読む。読めなければ 1（そのまま）。
 */
export function readRawOrientation(bytes: Uint8Array): number {
  const fromTiff = readTiffOrientation(bytes, 0);
  if (fromTiff !== null) return fromTiff;
  const cmt1 = indexOfAscii(bytes, "CMT1", 4, CR3_HEADER_SEARCH_BYTES);
  if (cmt1 >= 4) {
    const boxSize = readU32BE(bytes, cmt1 - 4);
    const boxEnd = boxSize >= 8 ? cmt1 - 4 + boxSize : bytes.length;
    return readTiffOrientation(bytes, cmt1 + 4, boxEnd) ?? 1;
  }
  return 1;
}

/** EXIF の APP1（`Exif\0\0` + TIFF）の向き。無ければ null。 */
function readExifSegmentOrientation(bytes: Uint8Array, dataStart: number, segmentEnd: number): number | null {
  if (dataStart + 6 > segmentEnd) return null;
  // "Exif\0\0"
  if (
    bytes[dataStart] !== 0x45 ||
    bytes[dataStart + 1] !== 0x78 ||
    bytes[dataStart + 2] !== 0x69 ||
    bytes[dataStart + 3] !== 0x66 ||
    bytes[dataStart + 4] !== 0 ||
    bytes[dataStart + 5] !== 0
  ) {
    return null;
  }
  return readTiffOrientation(bytes, dataStart + 6, segmentEnd);
}

/**
 * SOS の後の圧縮データの終わり（EOI の直後）。圧縮データの中の `FF 00`（詰め物）・`FF D0〜D7`（RST）は飛ばし、
 * progressive の走査の間に挟まる段（DHT・SOS など）は長さを読んで飛ばす。途中で SOI が来た・終わらなければ null。
 */
function findJpegEnd(bytes: Uint8Array, from: number): number | null {
  let offset = from;
  while (offset < bytes.length) {
    const ff = bytes.indexOf(0xff, offset);
    if (ff < 0 || ff + 1 >= bytes.length) return null;
    const marker = bytes[ff + 1]!;
    if (marker === 0x00 || marker === 0xff || (marker >= 0xd0 && marker <= 0xd7)) {
      offset = ff + 1;
      continue;
    }
    if (marker === MARKER_EOI) return ff + 2;
    if (marker === MARKER_SOI) return null;
    if (ff + 4 > bytes.length) return null;
    const length = readU16BE(bytes, ff + 2);
    if (length < 2) return null;
    offset = ff + 2 + length;
  }
  return null;
}

type ParsedJpeg = RawEmbeddedJpeg & { decodable: boolean };

/** `start`（SOI）から JPEG を読む。段の並びが壊れている・SOS の前に SOF が無い・終わらなければ null。 */
function parseJpegAt(bytes: Uint8Array, start: number): ParsedJpeg | null {
  let offset = start + 2;
  let frame: { marker: number; width: number; height: number; precision: number } | null = null;
  let orientation: number | null = null;
  while (offset + 4 <= bytes.length) {
    if (bytes[offset] !== 0xff) return null;
    // 段の前の 0xFF の詰め物は読み飛ばす
    while (offset + 1 < bytes.length && bytes[offset + 1] === 0xff) offset += 1;
    if (offset + 4 > bytes.length) return null;
    const marker = bytes[offset + 1]!;
    if (marker === MARKER_SOI || marker === MARKER_EOI || marker === 0x00) return null;
    if ((marker >= 0xd0 && marker <= 0xd7) || marker === 0x01) {
      offset += 2;
      continue;
    }
    const length = readU16BE(bytes, offset + 2);
    const dataStart = offset + 4;
    const segmentEnd = offset + 2 + length;
    if (length < 2 || segmentEnd > bytes.length) return null;
    if (isSofMarker(marker)) {
      if (length < 8) return null;
      frame = {
        marker,
        precision: bytes[dataStart]!,
        height: readU16BE(bytes, dataStart + 1),
        width: readU16BE(bytes, dataStart + 3),
      };
    } else if (marker === MARKER_APP1 && orientation === null) {
      orientation = readExifSegmentOrientation(bytes, dataStart, segmentEnd);
    }
    if (marker === MARKER_SOS) {
      if (!frame || frame.width < 1 || frame.height < 1) return null;
      const end = findJpegEnd(bytes, segmentEnd);
      if (end === null) return null;
      return {
        start,
        end,
        width: frame.width,
        height: frame.height,
        orientation,
        decodable: isBrowserDecodableSof(frame.marker) && frame.precision === 8,
      };
    }
    offset = segmentEnd;
  }
  return null;
}

/**
 * RAW の bytes を 1 回走査して、ブラウザで開ける埋め込み JPEG を大きい順に返す（無ければ空）。`maxPixels` を超えるもの・
 * 長辺が `minLongEdge` 未満のものは入れない。走査するのは先頭の {@link RAW_EMBEDDED_PREVIEW_MAX_SCAN_BYTES} まで。
 */
export function findRawEmbeddedJpegs(
  bytes: Uint8Array,
  options: { maxPixels?: number; minLongEdge?: number } = {},
): RawEmbeddedJpeg[] {
  const maxPixels = options.maxPixels ?? DEFAULT_MAX_PIXELS;
  const minLongEdge = options.minLongEdge ?? RAW_EMBEDDED_PREVIEW_MIN_LONG_EDGE;
  const scanned = bytes.length > RAW_EMBEDDED_PREVIEW_MAX_SCAN_BYTES
    ? bytes.subarray(0, RAW_EMBEDDED_PREVIEW_MAX_SCAN_BYTES)
    : bytes;
  const found: RawEmbeddedJpeg[] = [];
  let offset = 0;
  while (offset + 4 <= scanned.length) {
    const ff = scanned.indexOf(0xff, offset);
    if (ff < 0 || ff + 4 > scanned.length) break;
    if (scanned[ff + 1] !== MARKER_SOI || scanned[ff + 2] !== 0xff) {
      offset = ff + 1;
      continue;
    }
    const parsed = parseJpegAt(scanned, ff);
    if (!parsed) {
      offset = ff + 2;
      continue;
    }
    const pixels = parsed.width * parsed.height;
    if (parsed.decodable && pixels <= maxPixels && Math.max(parsed.width, parsed.height) >= minLongEdge) {
      found.push({
        start: parsed.start,
        end: parsed.end,
        width: parsed.width,
        height: parsed.height,
        orientation: parsed.orientation,
      });
    }
    // JPEG の中の EXIF のサムネイルはこの JPEG より小さいので、終わりの後から探す
    offset = parsed.end;
  }
  return found.sort(
    (left, right) => right.width * right.height - left.width * left.height || right.end - right.start - (left.end - left.start),
  );
}

/**
 * 描くときに当てる向き。JPEG 自身が EXIF の向きを持っていれば（値 1 も明示値）デコーダの結果を使うので 1。
 * 向きが無く縦長なら回し終えているものとして 1。ほかは RAW の IFD0 の向き。
 */
export function resolveRawPreviewOrientation(jpeg: RawEmbeddedJpeg, rawOrientation: number): number {
  if (jpeg.orientation !== null) return 1;
  if (jpeg.height > jpeg.width) return 1;
  return rawOrientation >= 1 && rawOrientation <= 8 ? rawOrientation : 1;
}
