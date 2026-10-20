import { describe, expect, it } from "vitest";

import { extractXmpFromDng, isPhotoPresetDngFileName } from "./photo-preset-dng";

const encoder = new TextEncoder();

/** TIFF の頭と画素に見立てたバイト列の間に、XMP の塊を挟む。 */
function dng(...chunks: string[]): Uint8Array {
  const header = Uint8Array.from([0x49, 0x49, 0x2a, 0x00, 0x08, 0x00, 0x00, 0x00]);
  const noise = Uint8Array.from([0x00, 0xff, 0x3c, 0x78, 0x3a, 0x00, 0x3c, 0x2f, 0x78, 0xfe]);
  const parts: Uint8Array[] = [header];
  for (const chunk of chunks) parts.push(noise, encoder.encode(chunk));
  parts.push(noise);
  const total = parts.reduce((sum, part) => sum + part.length, 0);
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const part of parts) {
    bytes.set(part, offset);
    offset += part.length;
  }
  return bytes;
}

const PRESET_XMP =
  '<x:xmpmeta xmlns:x="adobe:ns:meta/"><rdf:RDF><rdf:Description crs:Exposure2012="+0.40"><crs:Name>朝の光</crs:Name></rdf:Description></rdf:RDF></x:xmpmeta>';

describe("extractXmpFromDng", () => {
  it("バイト列の中の XMP の塊を、UTF-8 の文字のまま取り出す", () => {
    expect(extractXmpFromDng(dng(PRESET_XMP))).toBe(PRESET_XMP);
  });

  it("塊が複数あれば、現像の設定（crs:）を持つ最初の塊を返す", () => {
    const previewXmp = '<x:xmpmeta xmlns:x="adobe:ns:meta/"><rdf:RDF><rdf:Description dc:format="image/jpeg"/></rdf:RDF></x:xmpmeta>';
    expect(extractXmpFromDng(dng(previewXmp, PRESET_XMP))).toBe(PRESET_XMP);
  });

  it("現像の設定を持つ塊が無ければ、最初の塊を返す（読めるかはエンジンが決める）", () => {
    const first = '<x:xmpmeta xmlns:x="adobe:ns:meta/"><rdf:RDF/></x:xmpmeta>';
    const second = '<x:xmpmeta xmlns:x="adobe:ns:meta/"><rdf:RDF><rdf:Description/></rdf:RDF></x:xmpmeta>';
    expect(extractXmpFromDng(dng(first, second))).toBe(first);
  });

  it("XMP が無い・閉じていないなら null", () => {
    expect(extractXmpFromDng(dng())).toBeNull();
    expect(extractXmpFromDng(new Uint8Array(0))).toBeNull();
    expect(extractXmpFromDng(dng('<x:xmpmeta xmlns:x="adobe:ns:meta/"><rdf:RDF>'))).toBeNull();
  });
});

describe("isPhotoPresetDngFileName", () => {
  it("拡張子が dng（大文字も）のときだけ true", () => {
    expect(isPhotoPresetDngFileName("morning.dng")).toBe(true);
    expect(isPhotoPresetDngFileName("MORNING.DNG ")).toBe(true);
    expect(isPhotoPresetDngFileName("morning.xmp")).toBe(false);
    expect(isPhotoPresetDngFileName("dng")).toBe(false);
  });
});
