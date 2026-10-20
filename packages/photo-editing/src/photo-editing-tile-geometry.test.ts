import { describe, expect, it } from "vitest";

import {
  photoEditingTileGeometry,
  photoEditingTileGeometryStyles,
  type PhotoEditingTileGeometryStyles,
} from "./photo-editing-tile-geometry";

/** style の行列と平行移動を読み、画像の点 `s`（画像の画素）が切り抜きの箱のどこ（枠の画素の単位）に来るかを返す。 */
function place(styles: PhotoEditingTileGeometryStyles, width: number, height: number, s: [number, number]): [number, number] {
  const transform = String(styles.image.transform);
  const matrix = /matrix\(([^)]*)\)/.exec(transform)?.[1].split(",").map(Number) ?? [];
  const translate = /translate\(([-\d.e]+)%, ([-\d.e]+)%\)/.exec(transform) ?? [];
  const [a, b, c, d] = matrix;
  const x = s[0] + (Number(translate[1]) / 100) * width;
  const y = s[1] + (Number(translate[2]) / 100) * height;
  return [a * x + c * y, b * x + d * y];
}

function expectNear(actual: [number, number], expected: [number, number]) {
  expect(actual[0]).toBeCloseTo(expected[0], 1);
  expect(actual[1]).toBeCloseTo(expected[1], 1);
}

describe("photoEditingTileGeometryStyles", () => {
  it("切り抜きだけ: 切り抜きの縦横比の箱をセルに cover で置き、画像を左上の角まで動かす", () => {
    const styles = photoEditingTileGeometryStyles(
      { crop: { left: 0.2, top: 0.1, right: 0.8, bottom: 0.6 } },
      3000,
      2000,
    );
    expect(styles?.box).toMatchObject({ width: "135%", aspectRatio: "1800 / 1000" });
    expect(styles?.image).toMatchObject({
      width: "166.6667%",
      height: "200%",
      transform: "matrix(1, 0, 0, 1, 0, 0) translate(-20%, -10%)",
      maxWidth: "none",
    });
    // 縦長の切り抜きは幅いっぱい（高さがはみ出す）
    const tall = photoEditingTileGeometryStyles({ crop: { left: 0.4, top: 0, right: 0.6, bottom: 1 } }, 3000, 2000);
    expect(tall?.box.width).toBe("100%");
  });

  it("90° 回転: 画像の左上が箱の右上に来る（時計回り）。寸法は入れ替わる", () => {
    const styles = photoEditingTileGeometryStyles({ rotate: 90 }, 3000, 2000);
    expect(styles?.box.aspectRatio).toBe("2000 / 3000");
    if (!styles) throw new Error("styles");
    expectNear(place(styles, 3000, 2000, [0, 0]), [2000, 0]);
    expectNear(place(styles, 3000, 2000, [3000, 2000]), [0, 3000]);
    expectNear(place(styles, 3000, 2000, [0, 2000]), [0, 0]);
  });

  it("半回転・270°・左右 / 上下の反転も、画像の角が箱の対応する角に来る", () => {
    const cases: Array<{ geometry: Record<string, unknown>; topLeftFrom: [number, number] }> = [
      { geometry: { rotate: 180 }, topLeftFrom: [3000, 2000] },
      { geometry: { rotate: 270 }, topLeftFrom: [3000, 0] },
      { geometry: { flipH: true }, topLeftFrom: [3000, 0] },
      { geometry: { flipV: true }, topLeftFrom: [0, 2000] },
      { geometry: { rotate: 90, flipH: true }, topLeftFrom: [0, 0] },
    ];
    for (const testCase of cases) {
      const styles = photoEditingTileGeometryStyles(testCase.geometry, 3000, 2000);
      if (!styles) throw new Error(JSON.stringify(testCase.geometry));
      expectNear(place(styles, 3000, 2000, testCase.topLeftFrom), [0, 0]);
    }
  });

  it("角度つき: 切り抜き枠の左上と右上の角が箱の上の辺の両端に来る（crate と同じ Lightroom の取り方）", () => {
    const geometry = { angle: 10, crop: { left: 0.3, top: 0.2, right: 0.7, bottom: 0.8 } };
    const styles = photoEditingTileGeometryStyles(geometry, 3000, 2000);
    if (!styles) throw new Error("styles");
    const theta = (10 * Math.PI) / 180;
    const [ulx, uly] = [0.3 * 3000, 0.2 * 2000];
    const [dx, dy] = [0.7 * 3000 - ulx, 0.8 * 2000 - uly];
    const cropW = dx * Math.cos(theta) + dy * Math.sin(theta);
    const cropH = -dx * Math.sin(theta) + dy * Math.cos(theta);
    expectNear(place(styles, 3000, 2000, [ulx, uly]), [0, 0]);
    expectNear(place(styles, 3000, 2000, [ulx + cropW * Math.cos(theta), uly + cropW * Math.sin(theta)]), [cropW, 0]);
    expectNear(place(styles, 3000, 2000, [0.7 * 3000, 0.8 * 2000]), [cropW, cropH]);
  });

  it("角度つきで角が枠から出る切り抜きは、中心の回りに縮めて収める（画像の外を見せない）", () => {
    const styles = photoEditingTileGeometryStyles({ angle: 20 }, 3000, 2000);
    if (!styles) throw new Error("styles");
    const [w, h] = String(styles.box.aspectRatio).split(" / ").map(Number);
    // 収めた切り抜きの四隅は画像の中
    for (const corner of [
      [0, 0],
      [w, 0],
      [0, h],
      [w, h],
    ] as const) {
      // 箱の点を画像の点へ戻す（行列は直交: 転置が逆）
      const transform = String(styles.image.transform);
      const [a, b, c, d] = /matrix\(([^)]*)\)/.exec(transform)?.[1].split(",").map(Number) ?? [];
      const translate = /translate\(([-\d.e]+)%, ([-\d.e]+)%\)/.exec(transform) ?? [];
      const x = a * corner[0] + b * corner[1] - (Number(translate[1]) / 100) * 3000;
      const y = c * corner[0] + d * corner[1] - (Number(translate[2]) / 100) * 2000;
      expect(x).toBeGreaterThanOrEqual(-0.5);
      expect(x).toBeLessThanOrEqual(3000.5);
      expect(y).toBeGreaterThanOrEqual(-0.5);
      expect(y).toBeLessThanOrEqual(2000.5);
    }
  });

  it("形の壊れた幾何・寸法が分からない・長方形にならない切り抜きは null（そのまま出す）", () => {
    expect(photoEditingTileGeometryStyles(null, 3000, 2000)).toBeNull();
    expect(photoEditingTileGeometryStyles({ rotate: 45 }, 3000, 2000)).toBeNull();
    expect(photoEditingTileGeometryStyles({ flipH: "yes" }, 3000, 2000)).toBeNull();
    expect(photoEditingTileGeometryStyles({ crop: { left: "0.1" } }, 3000, 2000)).toBeNull();
    expect(photoEditingTileGeometryStyles({ crop: { left: 0.6, right: 0.4 } }, 3000, 2000)).toBeNull();
    expect(photoEditingTileGeometryStyles({ rotate: 90 }, 0, 2000)).toBeNull();
  });
});

describe("photoEditingTileGeometry", () => {
  const geometry = { rotate: 90, crop: { left: 0.1, top: 0, right: 0.9, bottom: 1 } };
  const saved = { developSettingsUpdatedAt: "2026-09-30T00:00:00.000Z" };

  it("保存してある developSettings が恒等でない幾何を持つときだけ、その幾何を返す", () => {
    expect(photoEditingTileGeometry({ ...saved, developSettings: { v: 2, engine: "niho-1", geometry } })).toEqual(geometry);
    expect(photoEditingTileGeometry({ ...saved, developSettings: { v: 1, engine: "niho-1", geometry: { aspect: "1:1" } } })).toBeNull();
    expect(photoEditingTileGeometry({ ...saved, developSettings: { v: 1, engine: "niho-1" } })).toBeNull();
    // K1c 移行元設計: 古い API が返す旧エンジンの settings の日時（新しい）は見ない（補正は developSettings だけ）
    const legacyFields = { hasSettings: true, settingsUpdatedAt: "2026-10-01T00:00:00.000Z" };
    expect(photoEditingTileGeometry({ ...saved, ...legacyFields, developSettings: { v: 2, engine: "niho-1", geometry } })).toEqual(
      geometry,
    );
    expect(photoEditingTileGeometry({ ...saved, developSettings: null })).toBeNull();
    expect(photoEditingTileGeometry({})).toBeNull();
  });

  it("補正後のプレビューのタイルを出す写真には当てない（切り抜き・回転は画に入っている。K3 #17149）", () => {
    const developSettings = { v: 2, engine: "niho-1", geometry };
    const editedPreview = { revision: 3, width: 1024, height: 768, url: "https://example.test/edited.jpg" };
    expect(
      photoEditingTileGeometry({
        ...saved,
        developSettings,
        editedPreview: { ...editedPreview, thumbUrl: "https://example.test/edited-thumb.jpg" },
      }),
    ).toBeNull();
    // 補正後のプレビューがあってもタイルの URL が無ければ補正前のプレビューを出すので、幾何を当てる
    expect(photoEditingTileGeometry({ ...saved, developSettings, editedPreview: { ...editedPreview, thumbUrl: null } })).toEqual(
      geometry,
    );
    expect(photoEditingTileGeometry({ ...saved, developSettings, editedPreview: null })).toEqual(geometry);
  });
});
