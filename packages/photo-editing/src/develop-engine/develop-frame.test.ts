import { describe, expect, it } from "vitest";

import { keepsDevelopCanvasSize } from "./develop-frame";

/**
 * 操作中の小さな画（色ポイント・マスクの drag の 640px）を canvas の大きさのまま描くか（M3 #67）。canvas の画素が画面の大きさを
 * 決めるので、縮めると drag の間だけ写真が小さく見え、上のつまみも動く。
 */
describe("keepsDevelopCanvasSize", () => {
  it("同じ縦横比の小さな画は、今の canvas の大きさのまま描く（640 と 1280 の丸めの違いは同じ比率）", () => {
    expect(keepsDevelopCanvasSize({ width: 1280, height: 853 }, { width: 640, height: 427 })).toBe(true);
    expect(keepsDevelopCanvasSize({ width: 853, height: 1280 }, { width: 427, height: 640 })).toBe(true);
  });

  it("同じ大きさ・大きな画・比率の違う画（幾何が変わった）・まだ描いていない canvas は、画の大きさにする", () => {
    expect(keepsDevelopCanvasSize({ width: 1280, height: 853 }, { width: 1280, height: 853 })).toBe(false);
    expect(keepsDevelopCanvasSize({ width: 640, height: 427 }, { width: 1280, height: 853 })).toBe(false);
    expect(keepsDevelopCanvasSize({ width: 1280, height: 853 }, { width: 427, height: 640 })).toBe(false);
    expect(keepsDevelopCanvasSize({ width: 0, height: 0 }, { width: 640, height: 427 })).toBe(false);
  });
});
