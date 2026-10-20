/**
 * Lightroom のプリセットを DNG で受け取ったとき（モバイル版の共有など）の、中の XMP の取り出し（NIHO Photo 段 1 F2b 移行元設計）。
 * DNG（TIFF）を解釈せず、ファイルの中の XMP の塊（`<x:xmpmeta` から `</x:xmpmeta>` まで。UTF-8）をそのまま探す。取り出した
 * XMP は `.xmp` のプリセットと同じ経路で読む。
 */

/** 取り込める DNG の大きさの上限（ブラウザのメモリに 1 回載せる）。 */
export const PHOTO_PRESET_DNG_MAX_BYTES = 100 * 1024 * 1024;

const XMP_OPEN = "<x:xmpmeta";
const XMP_CLOSE = "</x:xmpmeta>";
/** 現像の設定（Camera Raw の名前空間）を持つ塊の目印。 */
const CAMERA_RAW_MARKER = "crs:";

function asciiBytes(text: string): Uint8Array {
  return Uint8Array.from(text, (character) => character.charCodeAt(0));
}

const XMP_OPEN_BYTES = asciiBytes(XMP_OPEN);
const XMP_CLOSE_BYTES = asciiBytes(XMP_CLOSE);

/** `pattern` が最初に現れる位置（`from` 以降。無ければ -1）。 */
function indexOfBytes(bytes: Uint8Array, pattern: Uint8Array, from: number): number {
  const last = bytes.length - pattern.length;
  let index = bytes.indexOf(pattern[0], from);
  while (index !== -1 && index <= last) {
    let matched = true;
    for (let offset = 1; offset < pattern.length; offset += 1) {
      if (bytes[index + offset] !== pattern[offset]) {
        matched = false;
        break;
      }
    }
    if (matched) return index;
    index = bytes.indexOf(pattern[0], index + 1);
  }
  return -1;
}

/** プリセットのファイル名が DNG か（拡張子で見る）。 */
export function isPhotoPresetDngFileName(fileName: string): boolean {
  return /\.dng$/i.test(fileName.trim());
}

/**
 * DNG の中の XMP を取り出す（無ければ null）。塊が複数あるとき（埋め込みのプレビューなどが自分の XMP を持つ）は、現像の設定
 * （`crs:`）を持つ最初の塊、無ければ最初の塊。
 */
export function extractXmpFromDng(bytes: Uint8Array): string | null {
  const decoder = new TextDecoder("utf-8");
  let first: string | null = null;
  let from = 0;
  for (;;) {
    const start = indexOfBytes(bytes, XMP_OPEN_BYTES, from);
    if (start === -1) break;
    const close = indexOfBytes(bytes, XMP_CLOSE_BYTES, start + XMP_OPEN_BYTES.length);
    if (close === -1) break;
    const end = close + XMP_CLOSE_BYTES.length;
    const xmp = decoder.decode(bytes.subarray(start, end));
    if (xmp.includes(CAMERA_RAW_MARKER)) return xmp;
    first ??= xmp;
    from = end;
  }
  return first;
}
