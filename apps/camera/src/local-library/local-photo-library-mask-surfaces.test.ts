import { describe, expect, it } from "vitest";

import { createCameraCommands, type Invoke } from "./commands";
import { LOCAL_CLOSED_CAPABILITIES, createLocalPhotoLibrary, localCapabilities } from "./local-photo-library";

/**
 * この Mac の `PhotoLibrary` のマスクの面（M4 #68）: 一覧の `entryId` を開いた写真の native の `photoId` に結んで保存・読み出し
 * （native が写真を手放していたら、同じ中身のときだけ開き直す）、置き場に無い面は null、面を保存できることは能力で知らせる。
 */

const SURFACE_ID = "a".repeat(64);

function fakeNative(options: { contents?: string[]; missing?: boolean } = {}) {
  const calls: Array<{ command: string; args: unknown; options?: unknown }> = [];
  const contents = [...(options.contents ?? ["c".repeat(64)])];
  let opened = 0;
  let released = false;
  const invoke: Invoke = async <T>(command: string, args?: Parameters<Invoke>[1], invokeOptions?: Parameters<Invoke>[2]) => {
    calls.push(invokeOptions ? { command, args, options: invokeOptions } : { command, args });
    const request = (args as { request?: Record<string, unknown> } | undefined)?.request;
    switch (command) {
      case "camera_photo_open": {
        opened += 1;
        const contentSha256 = contents.length > 1 ? contents.shift()! : contents[0]!;
        return {
          photos: (request?.entryIds as string[]).map((entryId) => ({
            photoId: `native-${opened}`,
            entryId,
            fileName: "DSC.JPG",
            format: "jpeg",
            sizeBytes: 10,
            contentSha256,
            modifiedAt: null,
            nativeExport: true,
            saved: null,
          })),
          failed: [],
        } as T;
      }
      case "camera_mask_surface_save": {
        const photoId = (invokeOptions as { headers: Record<string, string> }).headers["x-niho-photo-id"];
        if (photoId === "native-1" && released) throw { code: "notFound", message: "写真が見つかりません。" };
        return { id: SURFACE_ID, width: 4, height: 3 } as T;
      }
      case "camera_mask_surface_load":
        if (options.missing) throw { code: "maskSurfaceMissing", message: "面が見つかりません。" };
        if (request?.photoId === "native-1" && released) throw { code: "notFound", message: "写真が見つかりません。" };
        return new Uint8Array([0x89, 0x50]).buffer as T;
      default:
        throw { code: "invalidRequest", message: command };
    }
  };
  return {
    calls,
    release: () => {
      released = true;
    },
    library: createLocalPhotoLibrary(createCameraCommands(invoke)),
  };
}

describe("この Mac のマスクの面", () => {
  it("一覧の写真を開いた native の photoId で面を保存し（raw IPC・header）、id で読む", async () => {
    const { library, calls } = fakeNative();
    const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47]);
    await expect(library.saveMaskSurface!("e-1", png)).resolves.toEqual({ id: SURFACE_ID, width: 4, height: 3 });
    await expect(library.loadMaskSurface!("e-1", SURFACE_ID)).resolves.toEqual(new Uint8Array([0x89, 0x50]));
    expect(calls.map((call) => call.command)).toEqual(["camera_photo_open", "camera_mask_surface_save", "camera_mask_surface_load"]);
    expect(calls[1]).toEqual({ command: "camera_mask_surface_save", args: png, options: { headers: { "x-niho-photo-id": "native-1" } } });
    expect(calls[2]!.args).toEqual({ request: { photoId: "native-1", surfaceId: SURFACE_ID } });
  });

  it("置き場に無い・壊れた面は null（ほかの失敗は投げる）", async () => {
    const { library } = fakeNative({ missing: true });
    await expect(library.loadMaskSurface!("e-1", SURFACE_ID)).resolves.toBeNull();
  });

  it("native が写真を手放していたら、同じ中身のときだけ開き直してやり直す（中身が替わっていたら投げる）", async () => {
    const same = fakeNative();
    await same.library.saveMaskSurface!("e-1", new Uint8Array([1]));
    same.release();
    await expect(same.library.saveMaskSurface!("e-1", new Uint8Array([1]))).resolves.toMatchObject({ id: SURFACE_ID });
    expect(same.calls.filter((call) => call.command === "camera_photo_open")).toHaveLength(2);

    const replaced = fakeNative({ contents: ["c".repeat(64), "d".repeat(64)] });
    await replaced.library.loadMaskSurface!("e-1", SURFACE_ID);
    replaced.release();
    await expect(replaced.library.loadMaskSurface!("e-1", SURFACE_ID)).rejects.toMatchObject({ code: "notFound" });
  });

  it("面を保存できることを能力で知らせる（同梱の sidecar に依らない。読めるまでは閉じた値）", () => {
    expect(LOCAL_CLOSED_CAPABILITIES.maskSurfaces).toBe(false);
    expect(localCapabilities({ available: false })).toMatchObject({ maskSurfaces: true });
    expect(localCapabilities({ available: true, masks: true })).toMatchObject({ maskSurfaces: true, nativeExportMasks: true });
  });
});
