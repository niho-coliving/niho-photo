import { describe, expect, it } from "vitest";
import type { CutoutDetection, CutoutRecipe, CutoutSubject } from "niho-photo-editing/photo-cutout";

import { CameraCommandError, createCameraCommands, toCameraCommandError, type Invoke } from "./commands";

type Call = { command: string; args?: Parameters<Invoke>[1]; options?: Parameters<Invoke>[2] };

function recording(answer: (call: Call) => unknown) {
  const calls: Call[] = [];
  const invoke: Invoke = async <T>(command: string, args?: Parameters<Invoke>[1], options?: Parameters<Invoke>[2]) => {
    const call: Call = options ? { command, args, options } : { command, args };
    calls.push(call);
    const value = answer(call);
    if (value instanceof Error || (typeof value === "object" && value !== null && "reject" in value)) {
      throw value instanceof Error ? value : (value as { reject: unknown }).reject;
    }
    return value as T;
  };
  return { calls, commands: createCameraCommands(invoke) };
}

describe("createCameraCommands", () => {
  it("wraps arguments in `request` with camelCase names and unwraps the answers", async () => {
    const folder = { folderId: "folder-1", name: "DCIM", children: [], photos: [], truncated: false };
    const { calls, commands } = recording(({ command }) => {
      switch (command) {
        case "camera_library_add_folder":
          return { folder };
        case "camera_library_list_folder":
          return { folder };
        case "camera_photo_save_settings":
          return { revision: 3 };
        case "camera_export_to_folder":
          return { fileName: "P1-2.jpg" };
        case "camera_choose_export_folder":
          return { exportFolder: null };
        default:
          return {};
      }
    });

    await expect(commands.addFolder()).resolves.toEqual(folder);
    await expect(commands.listFolder("folder-1")).resolves.toEqual(folder);
    await commands.forgetFolder("folder-1");
    await expect(commands.saveSettings("photo-1", { exposure: 0.3 }, 2)).resolves.toBe(3);
    await commands.developSource("photo-1");
    await commands.developSource("photo-1", {
      forceWorkingCopy: true,
      sourceContext: { hasSavedDevelopSettings: false, hasDevelopEdits: false, baseVersion: null },
    });
    await commands.exportPhoto(
      "photo-1",
      { exposure: 0.3 },
      { hasSavedDevelopSettings: false, hasDevelopEdits: false },
    );
    await expect(
      commands.exportToFolder(
        "export-1",
        "photo-1",
        {},
        { hasSavedDevelopSettings: true, hasDevelopEdits: true },
        "P1.jpg",
      ),
    ).resolves.toBe("P1-2.jpg");
    await expect(commands.chooseExportFolder()).resolves.toBeNull();

    expect(calls).toEqual([
      { command: "camera_library_add_folder", args: undefined },
      { command: "camera_library_list_folder", args: { request: { folderId: "folder-1" } } },
      { command: "camera_library_forget_folder", args: { request: { folderId: "folder-1" } } },
      {
        command: "camera_photo_save_settings",
        args: { request: { photoId: "photo-1", developSettings: { exposure: 0.3 }, expectedRevision: 2 } },
      },
      { command: "camera_develop_source", args: { request: { photoId: "photo-1" } } },
      {
        command: "camera_develop_source",
        args: {
          request: {
            photoId: "photo-1",
            forceWorkingCopy: true,
            sourceContext: { hasSavedDevelopSettings: false, hasDevelopEdits: false, baseVersion: null },
          },
        },
      },
      {
        command: "camera_export",
        args: {
          request: {
            photoId: "photo-1",
            developSettings: { exposure: 0.3 },
            hasSavedDevelopSettings: false,
            hasDevelopEdits: false,
          },
        },
      },
      {
        command: "camera_export_to_folder",
        args: {
          request: {
            exportFolderId: "export-1",
            photoId: "photo-1",
            developSettings: {},
            hasSavedDevelopSettings: true,
            hasDevelopEdits: true,
            suggestedFileName: "P1.jpg",
          },
        },
      },
      { command: "camera_choose_export_folder", args: undefined },
    ]);
  });

  it("returns raw IPC bytes as a Uint8Array", async () => {
    const bytes = new Uint8Array([0x89, 0x50, 0x4e, 0x47]);
    const { commands } = recording(() => bytes.buffer.slice(0));
    await expect(commands.developSourceBytes("photo-1", "token-1")).resolves.toEqual(bytes);
  });

  it("uses the cutout command contract and keeps masks as raw bytes", async () => {
    const maskSHA256 = "b".repeat(64);
    const subject: CutoutSubject = {
      selection: "instance-1",
      pixelCount: 4,
      mask: `${maskSHA256}.png`,
      maskSHA256,
      maskWidth: 4,
      maskHeight: 2,
    };
    const detection: CutoutDetection = {
      schemaVersion: 1,
      engine: "Vision",
      engineRevision: 1,
      width: 4,
      height: 2,
      inputSHA256: "a".repeat(64),
      sourceOrientation: 1,
      largest: "instance-1",
      subjects: [subject],
    };
    const recipe = { v: 1, detection, selected: "instance-1", background: { kind: "transparent" }, strokes: [] } as CutoutRecipe;
    const bytes = new Uint8Array([0x89, 0x50, 0x4e, 0x47]);
    const { calls, commands } = recording(({ command }) => {
      if (command === "camera_cutout_status") return { available: true };
      if (command === "camera_cutout_load_recipe") return { recipe };
      if (command === "camera_cutout_detect") return { detection };
      if (command === "camera_cutout_read_mask") return bytes.buffer.slice(0);
      if (command === "camera_cutout_export") return { saved: true, fileName: "P1.png" };
      return {};
    });
    await expect(commands.cutoutStatus()).resolves.toEqual({ available: true });
    await expect(commands.cutoutLoadRecipe("photo-1")).resolves.toEqual(recipe);
    await commands.cutoutSaveRecipe("photo-1", recipe);
    await expect(commands.cutoutDetect("photo-1", "detect-1")).resolves.toEqual(detection);
    await commands.cutoutCancel("detect-1");
    await expect(commands.cutoutReadMask("photo-1", subject)).resolves.toEqual(bytes);
    await expect(commands.cutoutExport("photo-1", recipe, { exposure: 0.2 }, "png")).resolves.toEqual({
      saved: true,
      fileName: "P1.png",
    });
    expect(calls.map(({ command, args }) => [command, args])).toEqual([
      ["camera_cutout_status", undefined],
      ["camera_cutout_load_recipe", { request: { photoId: "photo-1" } }],
      ["camera_cutout_save_recipe", { request: { photoId: "photo-1", recipe } }],
      ["camera_cutout_detect", { request: { photoId: "photo-1", operationId: "detect-1" } }],
      ["camera_cutout_cancel", { request: { operationId: "detect-1" } }],
      ["camera_cutout_read_mask", { request: { photoId: "photo-1", subject } }],
      [
        "camera_cutout_export",
        { request: { photoId: "photo-1", recipe, developSettings: { exposure: 0.2 }, format: "png" } },
      ],
    ]);
  });

  it("turns native failures into CameraCommandError with the revision of a conflict", async () => {
    const { commands } = recording(() => ({
      reject: { code: "revisionConflict", message: "別の操作で補正が変わりました。", currentRevision: 5 },
    }));
    const error = await commands.saveSettings("photo-1", {}, 4).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(CameraCommandError);
    expect(error).toMatchObject({ code: "revisionConflict", currentRevision: 5, message: "別の操作で補正が変わりました。" });
  });

  it("maps unknown failures (e.g. an ACL refusal string) to an internal error with a plain message", () => {
    const error = toCameraCommandError("Command camera_x not allowed by ACL");
    expect(error.code).toBe("internal");
    expect(error.message).not.toContain("ACL");
    expect(toCameraCommandError({ code: "notFound", message: "写真が見つかりません。" })).toMatchObject({
      code: "notFound",
      currentRevision: null,
    });
  });

  it("keeps presets on this Mac through the preset commands", async () => {
    const preset = { id: "preset-1", name: "夕方", xmp: "<x:xmpmeta/>", source: "xmp", createdAt: "1970-01-01T00:00:00.001Z" };
    const { calls, commands } = recording(({ command }) =>
      command === "camera_presets_list" ? { presets: [preset] } : command === "camera_presets_delete" ? {} : { preset },
    );
    await expect(commands.listPresets()).resolves.toEqual([preset]);
    await expect(commands.createPreset("夕方", "<x:xmpmeta/>", "xmp")).resolves.toEqual(preset);
    await commands.renamePreset("preset-1", "夜");
    await commands.deletePreset("preset-1");
    expect(calls.map((call) => [call.command, call.args])).toEqual([
      ["camera_presets_list", undefined],
      ["camera_presets_create", { request: { name: "夕方", xmp: "<x:xmpmeta/>", source: "xmp" } }],
      ["camera_presets_rename", { request: { id: "preset-1", name: "夜" } }],
      ["camera_presets_delete", { request: { id: "preset-1" } }],
    ]);
  });

  it("copies the original natively and saves a page-made file as raw IPC bytes with the encoded name", async () => {
    const { calls, commands } = recording(({ command }) =>
      command === "camera_export_original" ? { saved: true, fileName: "P1.RW2" } : { result: "saved" },
    );
    await expect(commands.exportOriginal("photo-1", "P1.RW2")).resolves.toEqual({ saved: true, fileName: "P1.RW2" });
    const bytes = new Uint8Array([0xff, 0xd8, 0xff]);
    await expect(commands.saveFile(bytes, "夕方 1/2.jpg")).resolves.toBe("saved");
    expect(calls).toEqual([
      { command: "camera_export_original", args: { request: { photoId: "photo-1", suggestedFileName: "P1.RW2" } } },
      {
        command: "camera_save_file",
        args: bytes,
        options: { headers: { "x-niho-file-name": encodeURIComponent("夕方 1/2.jpg") } },
      },
    ]);
  });

  it("reports a closed save dialog as cancelled and a refusal as CameraCommandError", async () => {
    const cancelled = recording(() => ({ result: "cancelled" }));
    await expect(cancelled.commands.saveFile(new Uint8Array([1]), "a.xmp")).resolves.toBe("cancelled");
    const refused = recording(() => ({ reject: { code: "invalidRequest", message: "保存できない名前です。" } }));
    await expect(refused.commands.saveFile(new Uint8Array([1]), "a.exe")).rejects.toMatchObject({
      code: "invalidRequest",
      message: "保存できない名前です。",
    });
  });
});
