import { describe, expect, it } from "vitest";

import {
  PHOTO_ZOOM_FIT,
  clampZoom,
  fitPhotoZoomContent,
  isPhotoZoomed,
  resolveMaxZoomScale,
  toggleZoomAt,
  zoomAround,
  type PhotoZoomBounds,
  type PhotoZoomPoint,
  type PhotoZoomState,
} from "./photo-editing-zoom";

/** 写真の面の拡大の計算（F6c 移行元設計）。面の中央が原点、`translate(x, y) scale(scale)`、transform-origin は中央。 */

// 面 390×500 に、全体表示で 360×240 の画（作業画像は幅 1440px = 4 倍まで）
const BOUNDS: PhotoZoomBounds = { areaWidth: 390, areaHeight: 500, contentWidth: 360, contentHeight: 240, maxScale: 4 };

/** `focal`（面の中央が原点）の下にある画の点（全体表示の画の中央が原点）。 */
function contentPointUnder(state: PhotoZoomState, focal: PhotoZoomPoint): PhotoZoomPoint {
  return { x: (focal.x - state.x) / state.scale, y: (focal.y - state.y) / state.scale };
}

describe("zoomAround", () => {
  it("focal の下の画を動かさずに倍率を変える", () => {
    const focal = { x: 80, y: -40 };
    const zoomed = zoomAround(PHOTO_ZOOM_FIT, focal, 3);
    expect(zoomed).toEqual({ scale: 3, x: -160, y: 80 });
    expect(contentPointUnder(zoomed, focal)).toEqual(contentPointUnder(PHOTO_ZOOM_FIT, focal));

    // ずれている状態から続けて変えても、同じ点の下の画は同じ
    const start: PhotoZoomState = { scale: 2, x: 30, y: -12 };
    const before = contentPointUnder(start, focal);
    const after = contentPointUnder(zoomAround(start, focal, 3.5), focal);
    expect(after.x).toBeCloseTo(before.x, 9);
    expect(after.y).toBeCloseTo(before.y, 9);
  });

  it("面の中央を focal にすると、ずれは倍率の比で伸び縮みする", () => {
    expect(zoomAround({ scale: 2, x: 40, y: -20 }, { x: 0, y: 0 }, 4)).toEqual({ scale: 4, x: 80, y: -40 });
    expect(zoomAround(PHOTO_ZOOM_FIT, { x: 0, y: 0 }, 2.5)).toEqual({ scale: 2.5, x: 0, y: 0 });
  });

  it("倍率が 0 以下なら変えない", () => {
    const state: PhotoZoomState = { scale: 2, x: 10, y: 10 };
    expect(zoomAround(state, { x: 5, y: 5 }, 0)).toBe(state);
  });
});

describe("clampZoom", () => {
  it("倍率を 1〜maxScale に収める。1 以下は全体表示（ずれは 0）", () => {
    expect(clampZoom({ scale: 9, x: 0, y: 0 }, BOUNDS).scale).toBe(4);
    expect(clampZoom({ scale: 1, x: 120, y: -80 }, BOUNDS)).toBe(PHOTO_ZOOM_FIT);
    expect(clampZoom({ scale: 0.4, x: 120, y: -80 }, BOUNDS)).toBe(PHOTO_ZOOM_FIT);
    expect(clampZoom({ scale: Number.NaN, x: 0, y: 0 }, BOUNDS)).toBe(PHOTO_ZOOM_FIT);
  });

  it("ずれを、拡大した画が面からはみ出した分の半分までに収める", () => {
    // 4 倍: 画は 1440×960。はみ出しは 横 (1440 - 390) / 2 = 525、縦 (960 - 500) / 2 = 230
    expect(clampZoom({ scale: 4, x: 9999, y: -9999 }, BOUNDS)).toEqual({ scale: 4, x: 525, y: -230 });
    expect(clampZoom({ scale: 4, x: -9999, y: 9999 }, BOUNDS)).toEqual({ scale: 4, x: -525, y: 230 });
    expect(clampZoom({ scale: 4, x: 100, y: -50 }, BOUNDS)).toEqual({ scale: 4, x: 100, y: -50 });
  });

  it("拡大しても画が面より小さい向きは、ずれを 0 にする（中央のまま）", () => {
    // 2 倍: 画は 720×480。横ははみ出す（165）が、縦（480）は面（500）より小さい
    expect(clampZoom({ scale: 2, x: 400, y: 120 }, BOUNDS)).toEqual({ scale: 2, x: 165, y: 0 });
    expect(clampZoom({ scale: 2, x: -0, y: -0 }, BOUNDS)).toEqual({ scale: 2, x: 0, y: 0 });
  });
});

describe("resolveMaxZoomScale", () => {
  it("作業画像の 100%（画の 1px が CSS の 1px）まで", () => {
    expect(resolveMaxZoomScale({ contentWidth: 360, intrinsicWidth: 1440 })).toBe(4);
    expect(resolveMaxZoomScale({ contentWidth: 370, intrinsicWidth: 1280 })).toBeCloseTo(1280 / 370, 9);
  });

  it("小さい画でも 2 倍までは寄れる。寸法が読めないときも 2 倍", () => {
    expect(resolveMaxZoomScale({ contentWidth: 360, intrinsicWidth: 400 })).toBe(2);
    expect(resolveMaxZoomScale({ contentWidth: 0, intrinsicWidth: 1440 })).toBe(2);
    expect(resolveMaxZoomScale({ contentWidth: 360, intrinsicWidth: 0 })).toBe(2);
  });
});

describe("toggleZoomAt", () => {
  it("全体表示なら focal を中心に 100% へ、拡大中なら全体表示へ", () => {
    const focal = { x: 60, y: 30 };
    const zoomed = toggleZoomAt(PHOTO_ZOOM_FIT, focal, 4);
    expect(zoomed).toEqual({ scale: 4, x: -180, y: -90 });
    expect(isPhotoZoomed(zoomed)).toBe(true);
    expect(toggleZoomAt(zoomed, focal, 4)).toBe(PHOTO_ZOOM_FIT);
    expect(toggleZoomAt({ scale: 1.2, x: 3, y: 4 }, focal, 4)).toBe(PHOTO_ZOOM_FIT);
    expect(isPhotoZoomed(PHOTO_ZOOM_FIT)).toBe(false);
  });
});

describe("fitPhotoZoomContent", () => {
  it("箱が画の縦横比どおりならそのまま、違えば箱の中に収めた大きさ（object-fit: contain）", () => {
    expect(fitPhotoZoomContent({ boxWidth: 360, boxHeight: 240, intrinsicWidth: 1440, intrinsicHeight: 960 })).toEqual({
      width: 360,
      height: 240,
    });
    // 正方形の箱に横長の画（作業コピーを待っている間のプレビュー）
    expect(fitPhotoZoomContent({ boxWidth: 370, boxHeight: 370, intrinsicWidth: 1024, intrinsicHeight: 512 })).toEqual({
      width: 370,
      height: 185,
    });
  });

  it("箱が無ければ 0、画の大きさが分からなければ箱の大きさ", () => {
    expect(fitPhotoZoomContent({ boxWidth: 0, boxHeight: 240, intrinsicWidth: 1440, intrinsicHeight: 960 })).toEqual({
      width: 0,
      height: 0,
    });
    expect(fitPhotoZoomContent({ boxWidth: 360, boxHeight: 240, intrinsicWidth: 0, intrinsicHeight: 0 })).toEqual({
      width: 360,
      height: 240,
    });
  });
});
