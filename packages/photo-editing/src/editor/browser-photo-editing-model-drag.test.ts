import { describe, expect, it } from "vitest";

import { writeDevelopMasks, type DevelopMask } from "../develop-engine/develop-masks";
import { neutralDevelopSettings } from "../develop-engine/develop-settings";

import {
  DEVELOP_COLOR_POINT_DRAG_MAX_DIMENSION,
  DEVELOP_PREVIEW_MAX_DIMENSION,
  developInteractiveMaxDimension,
} from "./browser-photo-editing-model";

/**
 * 操作中（drag）の描画の長辺（M3 #67）。マスクは層ごとに描くので、画を変えるマスクがある間は色ポイントと同じ 640px にする
 * （M2 の実測: 3 枚の 1280px の drag は 240〜390 ms）。
 */

const LINEAR: DevelopMask = {
  id: "mask-a",
  kind: "linear",
  enabled: true,
  invert: false,
  zero: { x: 0.5, y: 0.55 },
  full: { x: 0.5, y: 0.3 },
  adjust: { exposure: -0.7 },
};

describe("developInteractiveMaxDimension", () => {
  it("マスクも色ポイントも無ければ、操作中もプレビューと同じ長辺", () => {
    expect(developInteractiveMaxDimension(neutralDevelopSettings())).toBe(DEVELOP_PREVIEW_MAX_DIMENSION);
  });

  it("画を変えるマスクが 1 枚でもあれば 640px", () => {
    expect(developInteractiveMaxDimension(writeDevelopMasks(neutralDevelopSettings(), [LINEAR]))).toBe(
      DEVELOP_COLOR_POINT_DRAG_MAX_DIMENSION,
    );
    expect(DEVELOP_COLOR_POINT_DRAG_MAX_DIMENSION).toBe(640);
  });

  it("画を変えないマスク（補正が 0・外している）だけなら縮めない", () => {
    const settings = writeDevelopMasks(neutralDevelopSettings(), [
      { ...LINEAR, adjust: {} },
      { ...LINEAR, id: "mask-b", enabled: false },
    ]);
    expect(developInteractiveMaxDimension(settings)).toBe(DEVELOP_PREVIEW_MAX_DIMENSION);
  });

  it("動かしている色ポイントがあれば 640px（今までどおり）", () => {
    const settings = {
      ...neutralDevelopSettings(),
      v: 4,
      engine: "niho-10",
      look: "niho-standard-1",
      colorPoints: [
        {
          id: "color-a",
          target: { lightness: 0.7, chroma: 0.1, hue: 50 },
          range: { hue: 20, chroma: 0.05, lightness: 0.1 },
          delta: { hue: 4, chromaScale: 1, lightness: 0 },
        },
      ],
    };
    expect(developInteractiveMaxDimension(settings)).toBe(DEVELOP_COLOR_POINT_DRAG_MAX_DIMENSION);
  });
});
