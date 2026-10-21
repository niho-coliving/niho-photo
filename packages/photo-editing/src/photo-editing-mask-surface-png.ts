import type { PhotoEditingMaskSurfaceData } from "./photo-editing-mask-brush";

/**
 * マスクの面の PNG（8bit グレー。`docs/local-adjustments.md`「面の受け渡し」）を、塗りの続きに使う値（`width·height` byte）に戻す。
 *
 * - 面の PNG はエンジン（wasm の `encodeMaskSurface`）が作る非 interlace の 8bit グレー（色の型 0・深さ 8）。これは画素をそのまま
 *   読む（`DecompressionStream` で IDAT を伸ばし、行のフィルタを戻す。色の管理を通さないので値は PNG のまま）
 * - それ以外の形（interlace など）や `DecompressionStream` の無い環境は、画像として読み込んで canvas の R の値を使う（グレーの PNG
 *   の R はその値。色の変換は切る）
 * - 読めない・壊れた PNG は投げる（呼び出し側は、読めない面の上に塗らない）
 */

const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
/** 面の 1 辺の上限（エンジンと同じ）。 */
const MAX_SIDE = 4096;
/** 面の PNG の大きさ（エンジンと同じ）。 */
const MAX_PNG_BYTES = 8 * 1024 * 1024;

export class PhotoEditingMaskSurfaceDecodeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PhotoEditingMaskSurfaceDecodeError";
  }
}

type PngHeader = { width: number; height: number; bitDepth: number; colorType: number; interlace: number; idat: Uint8Array[] };

function readUint32(bytes: Uint8Array, offset: number): number {
  return ((bytes[offset]! << 24) | (bytes[offset + 1]! << 16) | (bytes[offset + 2]! << 8) | bytes[offset + 3]!) >>> 0;
}

/** 署名・IHDR・IDAT を読む（CRC は見ない。中身の正しさは面を受け取るエンジンが sha256 と形で確かめる）。 */
function readPngChunks(png: Uint8Array): PngHeader {
  if (png.length < 8 || PNG_SIGNATURE.some((value, index) => png[index] !== value)) {
    throw new PhotoEditingMaskSurfaceDecodeError("not a PNG");
  }
  let offset = 8;
  let header: Omit<PngHeader, "idat"> | null = null;
  const idat: Uint8Array[] = [];
  while (offset + 8 <= png.length) {
    const length = readUint32(png, offset);
    const type = String.fromCharCode(png[offset + 4]!, png[offset + 5]!, png[offset + 6]!, png[offset + 7]!);
    const start = offset + 8;
    const end = start + length;
    if (end + 4 > png.length) throw new PhotoEditingMaskSurfaceDecodeError("truncated PNG");
    if (type === "IHDR") {
      if (length !== 13) throw new PhotoEditingMaskSurfaceDecodeError("invalid IHDR");
      header = {
        width: readUint32(png, start),
        height: readUint32(png, start + 4),
        bitDepth: png[start + 8]!,
        colorType: png[start + 9]!,
        interlace: png[start + 12]!,
      };
    } else if (type === "IDAT") {
      idat.push(png.subarray(start, end));
    } else if (type === "IEND") {
      break;
    }
    offset = end + 4;
  }
  if (!header) throw new PhotoEditingMaskSurfaceDecodeError("missing IHDR");
  if (!(header.width >= 1 && header.width <= MAX_SIDE && header.height >= 1 && header.height <= MAX_SIDE)) {
    throw new PhotoEditingMaskSurfaceDecodeError("invalid size");
  }
  if (idat.length === 0) throw new PhotoEditingMaskSurfaceDecodeError("missing IDAT");
  return { ...header, idat };
}

async function inflate(chunks: Uint8Array[], expectedLength: number): Promise<Uint8Array> {
  const reader = new Blob(chunks as BlobPart[]).stream().pipeThrough(new DecompressionStream("deflate")).getReader();
  const output = new Uint8Array(expectedLength);
  let written = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (value.byteLength > expectedLength - written) {
        await reader.cancel().catch(() => undefined);
        throw new PhotoEditingMaskSurfaceDecodeError("expanded image data exceeds dimensions");
      }
      output.set(value, written);
      written += value.byteLength;
    }
  } finally {
    reader.releaseLock();
  }
  if (written !== expectedLength) throw new PhotoEditingMaskSurfaceDecodeError("image data length does not match dimensions");
  return output;
}

function paeth(a: number, b: number, c: number): number {
  const p = a + b - c;
  const pa = Math.abs(p - a);
  const pb = Math.abs(p - b);
  const pc = Math.abs(p - c);
  if (pa <= pb && pa <= pc) return a;
  return pb <= pc ? b : c;
}

/** 8bit グレー（1 byte/画素）の行のフィルタを戻す。 */
function unfilterGray8(raw: Uint8Array, width: number, height: number): Uint8Array {
  const stride = width + 1;
  if (raw.length !== stride * height) throw new PhotoEditingMaskSurfaceDecodeError("image data length does not match dimensions");
  const out = new Uint8Array(width * height);
  for (let y = 0; y < height; y += 1) {
    const filter = raw[y * stride]!;
    const source = y * stride + 1;
    const row = y * width;
    const previous = row - width;
    for (let x = 0; x < width; x += 1) {
      const value = raw[source + x]!;
      const left = x > 0 ? out[row + x - 1]! : 0;
      const up = y > 0 ? out[previous + x]! : 0;
      const upLeft = x > 0 && y > 0 ? out[previous + x - 1]! : 0;
      let decoded: number;
      switch (filter) {
        case 0:
          decoded = value;
          break;
        case 1:
          decoded = value + left;
          break;
        case 2:
          decoded = value + up;
          break;
        case 3:
          decoded = value + ((left + up) >> 1);
          break;
        case 4:
          decoded = value + paeth(left, up, upLeft);
          break;
        default:
          throw new PhotoEditingMaskSurfaceDecodeError("unknown PNG filter");
      }
      out[row + x] = decoded & 0xff;
    }
  }
  return out;
}

/** 画像として読み込み、canvas の R の値を使う（グレーの PNG。色の変換を切る）。 */
async function decodeWithCanvas(png: Uint8Array): Promise<PhotoEditingMaskSurfaceData> {
  if (typeof createImageBitmap !== "function") throw new PhotoEditingMaskSurfaceDecodeError("cannot decode PNG");
  const bitmap = await createImageBitmap(new Blob([png as BlobPart], { type: "image/png" }), {
    colorSpaceConversion: "none",
    premultiplyAlpha: "none",
  });
  try {
    const { width, height } = bitmap;
    const canvas =
      typeof OffscreenCanvas === "function"
        ? new OffscreenCanvas(width, height)
        : Object.assign(document.createElement("canvas"), { width, height });
    const context = canvas.getContext("2d") as CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D | null;
    if (!context) throw new PhotoEditingMaskSurfaceDecodeError("cannot decode PNG");
    context.drawImage(bitmap, 0, 0);
    const rgba = context.getImageData(0, 0, width, height).data;
    const data = new Uint8Array(width * height);
    for (let index = 0; index < data.length; index += 1) data[index] = rgba[index * 4]!;
    return { width, height, data };
  } finally {
    bitmap.close();
  }
}

/** 面の PNG を値に戻す（読めなければ {@link PhotoEditingMaskSurfaceDecodeError}）。 */
export async function decodePhotoEditingMaskSurfacePng(png: Uint8Array): Promise<PhotoEditingMaskSurfaceData> {
  if (png.byteLength > MAX_PNG_BYTES) throw new PhotoEditingMaskSurfaceDecodeError("PNG is too large");
  const header = readPngChunks(png);
  const direct = header.bitDepth === 8 && header.colorType === 0 && header.interlace === 0;
  if (direct && typeof DecompressionStream === "function") {
    let raw: Uint8Array;
    try {
      raw = await inflate(header.idat, (header.width + 1) * header.height);
    } catch {
      throw new PhotoEditingMaskSurfaceDecodeError("broken image data");
    }
    return { width: header.width, height: header.height, data: unfilterGray8(raw, header.width, header.height) };
  }
  return decodeWithCanvas(png);
}
