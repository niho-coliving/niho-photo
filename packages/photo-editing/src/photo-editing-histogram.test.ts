import { describe, expect, it } from "vitest";

import {
  PHOTO_EDITING_CLIP_HIGHLIGHT_FLAG,
  PHOTO_EDITING_CLIP_HIGHLIGHT_RGB,
  PHOTO_EDITING_CLIP_SHADOW_FLAG,
  PHOTO_EDITING_CLIP_SHADOW_RGB,
  PHOTO_EDITING_HISTOGRAM_LEVELS,
  computePhotoEditingHistogram,
  fillPhotoEditingClipOverlay,
  photoEditingHistogramAreaPath,
  photoEditingHistogramLinePath,
  photoEditingHistogramPeak,
} from "./photo-editing-histogram";

/**
 * ヒストグラム（niho-photo#36）の計算。画（RGBA）から 256 階調 × RGB の度数と、黒つぶれ / 白飛びの割合・クリップ領域の印を数える。
 */

/** 全画素が同じ色の RGBA。 */
function solid(width: number, height: number, r: number, g: number, b: number, a = 255): Uint8ClampedArray {
  const rgba = new Uint8ClampedArray(width * height * 4);
  for (let offset = 0; offset < rgba.length; offset += 4) {
    rgba[offset] = r;
    rgba[offset + 1] = g;
    rgba[offset + 2] = b;
    rgba[offset + 3] = a;
  }
  return rgba;
}

function total(counts: Uint32Array): number {
  return counts.reduce((sum, count) => sum + count, 0);
}

describe("computePhotoEditingHistogram", () => {
  it("単色の画は、その色の階調だけに全画素が入る（黒つぶれ・白飛びは無し）", () => {
    const result = computePhotoEditingHistogram(solid(8, 4, 10, 128, 250), 8, 4);
    expect(result.pixelCount).toBe(32);
    expect(result.red).toHaveLength(PHOTO_EDITING_HISTOGRAM_LEVELS);
    expect(result.red[10]).toBe(32);
    expect(result.green[128]).toBe(32);
    expect(result.blue[250]).toBe(32);
    expect(total(result.red)).toBe(32);
    expect(total(result.green)).toBe(32);
    expect(total(result.blue)).toBe(32);
    expect(result.shadowClipped).toBe(0);
    expect(result.highlightClipped).toBe(0);
    expect(result.shadowRate).toBe(0);
    expect(result.highlightRate).toBe(0);
    expect(result.clipMask).toBeNull();
  });

  it("0 から 255 までのグラデーションは、どの階調にも同じ数が入り、両端の 2 段ずつ（0〜1 / 254〜255）だけがクリップになる", () => {
    const rgba = new Uint8ClampedArray(PHOTO_EDITING_HISTOGRAM_LEVELS * 4);
    for (let level = 0; level < PHOTO_EDITING_HISTOGRAM_LEVELS; level += 1) {
      rgba.set([level, level, level, 255], level * 4);
    }
    const result = computePhotoEditingHistogram(rgba, PHOTO_EDITING_HISTOGRAM_LEVELS, 1);
    for (const counts of [result.red, result.green, result.blue]) {
      expect(Array.from(counts).every((count) => count === 1)).toBe(true);
    }
    expect(result.shadowClipped).toBe(2);
    expect(result.highlightClipped).toBe(2);
    expect(result.shadowRate).toBeCloseTo(2 / 256, 10);
    expect(result.highlightRate).toBeCloseTo(2 / 256, 10);
  });

  it("端から 1 段まで数える: 1 と 254 は入り、2 と 253 は入らない（エンジンは補正を掛けると白を 254 までしか出さない）", () => {
    const rgba = new Uint8ClampedArray([
      1, 128, 128, 255,
      128, 128, 254, 255,
      2, 128, 128, 255,
      128, 128, 253, 255,
    ]);
    const result = computePhotoEditingHistogram(rgba, 2, 2, { mask: true });
    expect(Array.from(result.clipMask?.flags ?? [])).toEqual([
      PHOTO_EDITING_CLIP_SHADOW_FLAG,
      PHOTO_EDITING_CLIP_HIGHLIGHT_FLAG,
      0,
      0,
    ]);
    expect(result.shadowClipped).toBe(1);
    expect(result.highlightClipped).toBe(1);
  });

  it("全黒は全画素が黒つぶれ（白飛びは 0）、全白は全画素が白飛び（黒つぶれは 0）", () => {
    const black = computePhotoEditingHistogram(solid(5, 5, 0, 0, 0), 5, 5);
    expect(black.red[0]).toBe(25);
    expect(black.shadowRate).toBe(1);
    expect(black.highlightRate).toBe(0);
    const white = computePhotoEditingHistogram(solid(5, 5, 255, 255, 255), 5, 5);
    expect(white.blue[255]).toBe(25);
    expect(white.highlightRate).toBe(1);
    expect(white.shadowRate).toBe(0);
  });

  it("いずれかのチャンネルが端（0〜1 / 254〜255）の画素を数える（純色の赤は黒つぶれにも白飛びにも入る）", () => {
    // 画素 0: R だけ 0（黒つぶれ） / 画素 1: B だけ 255（白飛び） / 画素 2: 純色の赤（両方） / 画素 3: どちらでもない
    const rgba = new Uint8ClampedArray([
      0, 100, 100, 255,
      100, 100, 255, 255,
      255, 0, 0, 255,
      2, 253, 128, 255,
    ]);
    const result = computePhotoEditingHistogram(rgba, 2, 2, { mask: true });
    expect(result.shadowClipped).toBe(2);
    expect(result.highlightClipped).toBe(2);
    expect(result.shadowRate).toBe(0.5);
    expect(result.highlightRate).toBe(0.5);
    expect(Array.from(result.clipMask?.flags ?? [])).toEqual([
      PHOTO_EDITING_CLIP_SHADOW_FLAG,
      PHOTO_EDITING_CLIP_HIGHLIGHT_FLAG,
      PHOTO_EDITING_CLIP_SHADOW_FLAG | PHOTO_EDITING_CLIP_HIGHLIGHT_FLAG,
      0,
    ]);
    expect(result.clipMask).toMatchObject({ width: 2, height: 2 });
  });

  it("アルファは見ない（透明な画素も、色の値のとおりに数える）", () => {
    const opaque = computePhotoEditingHistogram(solid(4, 4, 0, 40, 255, 255), 4, 4);
    const transparent = computePhotoEditingHistogram(solid(4, 4, 0, 40, 255, 0), 4, 4);
    expect(transparent.pixelCount).toBe(16);
    expect(Array.from(transparent.red)).toEqual(Array.from(opaque.red));
    expect(Array.from(transparent.green)).toEqual(Array.from(opaque.green));
    expect(Array.from(transparent.blue)).toEqual(Array.from(opaque.blue));
    expect(transparent.shadowRate).toBe(1);
    expect(transparent.highlightRate).toBe(1);
  });

  it("空の配列・大きさが 0 以下や数でない画は、何も数えず（割合は 0・エラーにしない）、印も作らない", () => {
    for (const [width, height] of [[0, 0], [4, 0], [-3, 2], [Number.NaN, 2], [Number.POSITIVE_INFINITY, 2]] as const) {
      const result = computePhotoEditingHistogram(new Uint8ClampedArray(0), width, height, { mask: true });
      expect(result.pixelCount).toBe(0);
      expect(total(result.red)).toBe(0);
      expect(result.shadowRate).toBe(0);
      expect(result.highlightRate).toBe(0);
      expect(result.clipMask).toBeNull();
    }
    // 大きさだけあって画素が無い
    const empty = computePhotoEditingHistogram(new Uint8ClampedArray(0), 4, 4, { mask: true });
    expect(empty.pixelCount).toBe(0);
    expect(empty.shadowRate).toBe(0);
    expect(empty.clipMask?.flags).toHaveLength(16);
  });

  it("配列が大きさより短ければ、ある分だけ数える（端数の byte は使わない）", () => {
    const result = computePhotoEditingHistogram(new Uint8ClampedArray([0, 0, 0, 255, 255, 255, 255, 255, 9, 9]), 4, 4);
    expect(result.pixelCount).toBe(2);
    expect(result.shadowRate).toBe(0.5);
    expect(result.highlightRate).toBe(0.5);
  });

  it("印は要るとき（mask: true）だけ作る。作っても度数と割合は同じ", () => {
    const rgba = solid(3, 3, 0, 255, 128);
    const without = computePhotoEditingHistogram(rgba, 3, 3);
    const withMask = computePhotoEditingHistogram(rgba, 3, 3, { mask: true });
    expect(without.clipMask).toBeNull();
    expect(withMask.clipMask?.flags).toHaveLength(9);
    expect(Array.from(withMask.red)).toEqual(Array.from(without.red));
    expect(withMask.shadowClipped).toBe(without.shadowClipped);
    expect(withMask.highlightClipped).toBe(without.highlightClipped);
  });

  it("1280x853 の画は緩い上限（150ms）より十分速く数えられる（印つきでも）", () => {
    const width = 1280;
    const height = 853;
    const rgba = new Uint8ClampedArray(width * height * 4);
    for (let offset = 0; offset < rgba.length; offset += 4) {
      // 擬似的な写真: 画素ごとに少しずつ違う色。端のクリップも混ぜる
      rgba[offset] = (offset >> 2) & 255;
      rgba[offset + 1] = ((offset >> 2) * 7) & 255;
      rgba[offset + 2] = ((offset >> 2) * 13) & 255;
      rgba[offset + 3] = 255;
    }
    computePhotoEditingHistogram(rgba, width, height, { mask: true });
    const startedAt = performance.now();
    const plain = computePhotoEditingHistogram(rgba, width, height);
    const masked = computePhotoEditingHistogram(rgba, width, height, { mask: true });
    const elapsed = performance.now() - startedAt;
    expect(plain.pixelCount).toBe(width * height);
    expect(masked.clipMask?.flags).toHaveLength(width * height);
    expect(elapsed).toBeLessThan(150);
  });
});

describe("fillPhotoEditingClipOverlay", () => {
  const mask = {
    width: 2,
    height: 2,
    flags: Uint8Array.from([
      PHOTO_EDITING_CLIP_SHADOW_FLAG,
      PHOTO_EDITING_CLIP_HIGHLIGHT_FLAG,
      PHOTO_EDITING_CLIP_SHADOW_FLAG | PHOTO_EDITING_CLIP_HIGHLIGHT_FLAG,
      0,
    ]),
  };
  const [shadowR, shadowG, shadowB] = PHOTO_EDITING_CLIP_SHADOW_RGB;
  const [highlightR, highlightG, highlightB] = PHOTO_EDITING_CLIP_HIGHLIGHT_RGB;

  function fill(show: { shadows: boolean; highlights: boolean }): number[] {
    // 前の内容が残っていても全画素を書き直す
    const target = new Uint8ClampedArray(16).fill(77);
    fillPhotoEditingClipOverlay(target, mask, show);
    return Array.from(target);
  }

  it("黒つぶれは青、白飛びは赤で塗り、ほかは透明。両方の印がある画素は赤", () => {
    expect(fill({ shadows: true, highlights: true })).toEqual([
      shadowR, shadowG, shadowB, 255,
      highlightR, highlightG, highlightB, 255,
      highlightR, highlightG, highlightB, 255,
      0, 0, 0, 0,
    ]);
  });

  it("見せる側だけ塗る（黒つぶれだけなら、両方の印がある画素は青）", () => {
    expect(fill({ shadows: true, highlights: false })).toEqual([
      shadowR, shadowG, shadowB, 255,
      0, 0, 0, 0,
      shadowR, shadowG, shadowB, 255,
      0, 0, 0, 0,
    ]);
    expect(fill({ shadows: false, highlights: true })).toEqual([
      0, 0, 0, 0,
      highlightR, highlightG, highlightB, 255,
      highlightR, highlightG, highlightB, 255,
      0, 0, 0, 0,
    ]);
    expect(fill({ shadows: false, highlights: false }).every((value) => value === 0)).toBe(true);
  });
});

describe("photoEditingHistogramPeak / photoEditingHistogramAreaPath", () => {
  function channels(fill: (counts: Uint32Array) => void) {
    const histogram = {
      red: new Uint32Array(PHOTO_EDITING_HISTOGRAM_LEVELS),
      green: new Uint32Array(PHOTO_EDITING_HISTOGRAM_LEVELS),
      blue: new Uint32Array(PHOTO_EDITING_HISTOGRAM_LEVELS),
    };
    fill(histogram.red);
    return histogram;
  }

  it("縦軸の最大は中間（1〜254）の最大。両端の突出には引きずられない", () => {
    const histogram = channels((counts) => {
      counts[0] = 100000;
      counts[255] = 90000;
      counts[40] = 300;
      counts[128] = 500;
    });
    expect(photoEditingHistogramPeak(histogram)).toBe(500);
  });

  it("中間がすべて空なら全階調の最大、度数がまったく無ければ 1", () => {
    expect(photoEditingHistogramPeak(channels((counts) => { counts[0] = 7; counts[255] = 9; }))).toBe(9);
    expect(photoEditingHistogramPeak(channels(() => undefined))).toBe(1);
  });

  it("塗りの path は左下から始まり、256 階調ぶんの点を通って右下で閉じる。peak 以上は一番上、0 は一番下", () => {
    const counts = new Uint32Array(PHOTO_EDITING_HISTOGRAM_LEVELS);
    counts[0] = 1000; // peak を超える → y=0
    counts[1] = 50; // 半分 → y=50（高さ 100）
    const path = photoEditingHistogramAreaPath(counts, 100, 100);
    expect(path.startsWith("M0 100L0.5 0L1.5 50L2.5 100")).toBe(true);
    expect(path.endsWith("L256 100Z")).toBe(true);
    expect(path.match(/L/g)).toHaveLength(PHOTO_EDITING_HISTOGRAM_LEVELS + 1);
  });

  it("peak が 0 以下でも落ちない（空のグラフ）", () => {
    const path = photoEditingHistogramAreaPath(new Uint32Array(PHOTO_EDITING_HISTOGRAM_LEVELS), 0, 80);
    expect(path.startsWith("M0 80L0.5 80")).toBe(true);
    expect(photoEditingHistogramLinePath(new Uint32Array(PHOTO_EDITING_HISTOGRAM_LEVELS), 0, 80).startsWith("M0.5 80L1.5 80")).toBe(true);
  });

  it("上辺の線は塗りと同じ点を、左右・下の辺なしで通る", () => {
    const counts = new Uint32Array(PHOTO_EDITING_HISTOGRAM_LEVELS);
    counts[0] = 1000;
    counts[1] = 50;
    const line = photoEditingHistogramLinePath(counts, 100, 100);
    expect(line.startsWith("M0.5 0L1.5 50L2.5 100")).toBe(true);
    expect(line.endsWith("L255.5 100")).toBe(true);
    expect(line.match(/L/g)).toHaveLength(PHOTO_EDITING_HISTOGRAM_LEVELS - 1);
    expect(photoEditingHistogramAreaPath(counts, 100, 100)).toContain(line.slice(1));
  });
});
