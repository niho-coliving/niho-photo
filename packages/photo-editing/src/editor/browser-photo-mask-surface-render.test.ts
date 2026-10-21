import { describe, expect, it, vi } from "vitest";

import { DevelopMaskSurfaceError, type DevelopEngine, type DevelopFrame } from "../develop-engine/develop-engine-client";
import { readDevelopMasks, writeDevelopMasks, type DevelopMask } from "../develop-engine/develop-masks";
import { neutralDevelopSettings } from "../develop-engine/develop-settings";

import { renderDevelopWithoutUnreadableMasks, withoutDevelopMasks } from "./browser-photo-mask-surface-render";

/**
 * 面を読めない写真を開いた直後の 1 枚（M4 #68）: 読めないマスクだけを当てずに描く（次々に読めないと分かれば続けて外す）。保存する設定は
 * 変えない（呼び出し側が持つ）。
 */

function brush(id: string, n: number): DevelopMask {
  return {
    id,
    kind: "brush",
    enabled: true,
    invert: false,
    surface: { id: n.toString(16).padStart(64, "0"), width: 4, height: 3 },
    adjust: { exposure: -1 },
  };
}

const SETTINGS = writeDevelopMasks(neutralDevelopSettings(), [brush("a", 1), brush("b", 2), brush("c", 3)]);
const FRAME: DevelopFrame = { width: 1, height: 1, rgba: new Uint8ClampedArray(4) };

describe("withoutDevelopMasks", () => {
  it("指定したマスクだけ当てない（ほかは変えない）。当てるマスクが無ければ同じ設定", () => {
    const next = withoutDevelopMasks(SETTINGS, new Set(["b"]));
    expect(readDevelopMasks(next).map((mask) => [mask.id, mask.enabled])).toEqual([
      ["a", true],
      ["b", false],
      ["c", true],
    ]);
    expect(withoutDevelopMasks(next, new Set(["b"]))).toBe(next);
    expect(withoutDevelopMasks(neutralDevelopSettings(), new Set(["b"]))).toEqual(neutralDevelopSettings());
  });
});

describe("renderDevelopWithoutUnreadableMasks", () => {
  it("読めないと分かったマスクを外して描き直し、次々に読めなければ続けて外す", async () => {
    const render = vi.fn(async (settings: object) => {
      const enabled = readDevelopMasks(settings).filter((mask) => mask.enabled).map((mask) => mask.id);
      if (enabled.includes("c")) throw new DevelopMaskSurfaceError("maskSurfaceMissing", { maskId: "c" });
      return FRAME;
    });
    const result = await renderDevelopWithoutUnreadableMasks(
      { render } as unknown as Pick<DevelopEngine, "render">,
      SETTINGS,
      { maxDimension: 640, interactive: false },
      new DevelopMaskSurfaceError("maskSurfaceMissing", { maskId: "a" }),
    );
    expect(result).toEqual({ frame: FRAME, maskIds: ["a", "c"] });
    expect(render).toHaveBeenCalledTimes(2);
  });

  it("マスクの分からない失敗・面のほかの失敗はそのまま投げる", async () => {
    const engine = { render: vi.fn(async () => Promise.reject(new Error("boom"))) } as unknown as Pick<DevelopEngine, "render">;
    await expect(
      renderDevelopWithoutUnreadableMasks(engine, SETTINGS, { maxDimension: 640, interactive: false }, new DevelopMaskSurfaceError("maskSurfaceMissing", {})),
    ).rejects.toBeInstanceOf(DevelopMaskSurfaceError);
    await expect(
      renderDevelopWithoutUnreadableMasks(
        engine,
        SETTINGS,
        { maxDimension: 640, interactive: false },
        new DevelopMaskSurfaceError("maskSurfaceMissing", { maskId: "a" }),
      ),
    ).rejects.toThrow("boom");
  });
});
