import { describe, expect, it, vi } from "vitest";

import { renderBrowserPhotoExportJpeg } from "./browser-photo-export-render";
import { DevelopMaskSurfaceError, type DevelopEngine } from "./develop-engine/develop-engine-client";
import { neutralDevelopSettings } from "./develop-engine/develop-settings";

/**
 * 書き出しの面のマスク（M4 #68）: 書き出す写真の面の読み口を engine へ渡し、面を読めなければ外して書き出さずに理由と次の一歩を出す。
 */

const JPEG = new Uint8Array([0xff, 0xd8, 0xff, 0xd9]);

describe("renderBrowserPhotoExportJpeg（面のマスク）", () => {
  it("書き出す写真の面の読み口を engine の書き出しへ渡す（省けば渡さない）", async () => {
    const exportJpeg = vi.fn(async () => JPEG.slice());
    const engine = { exportJpeg } as unknown as DevelopEngine;
    const maskSurfaces = vi.fn(async () => null);
    await renderBrowserPhotoExportJpeg({
      engine,
      input: { kind: "original", bytes: new ArrayBuffer(4) },
      settings: neutralDevelopSettings(),
      size: "long2048",
      capturedAt: null,
      maskSurfaces,
    });
    expect(exportJpeg).toHaveBeenCalledWith(expect.any(ArrayBuffer), expect.anything(), {
      maxDimension: 2048,
      quality: 90,
      maskSurfaces,
    });
    await renderBrowserPhotoExportJpeg({
      engine,
      input: { kind: "original", bytes: new ArrayBuffer(4) },
      settings: neutralDevelopSettings(),
      size: "long2048",
      capturedAt: null,
    });
    expect(exportJpeg).toHaveBeenLastCalledWith(expect.any(ArrayBuffer), expect.anything(), { maxDimension: 2048, quality: 90 });
  });

  it("面を読めないマスクは外して書き出さず、理由と次の一歩の 1 行で断る", async () => {
    const engine = {
      exportJpeg: vi.fn(async () => {
        throw new DevelopMaskSurfaceError("maskSurfaceMissing", { maskId: "mask-b" });
      }),
    } as unknown as DevelopEngine;
    await expect(
      renderBrowserPhotoExportJpeg({
        engine,
        input: { kind: "original", bytes: new ArrayBuffer(4) },
        settings: neutralDevelopSettings(),
        size: "long2048",
        capturedAt: null,
      }),
    ).rejects.toThrow("マスクの面を読めないため書き出せませんでした。そのマスクを削除するか、塗り直してから書き出してください。");
  });
});
