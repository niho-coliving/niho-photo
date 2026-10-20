import { describe, expect, it, vi } from "vitest";

import type { CutoutDetection, CutoutRecipe } from "niho-photo-editing/photo-cutout";
import { cloudKey } from "niho-photo-editing/editor/browser-photo-editing-model";

import { CameraCommandError, createCameraCommands, type Invoke } from "./commands";
import { createLocalPhotoCutoutHost } from "./local-photo-cutout-host";

const SHA = "a".repeat(64);
const MASK_SHA = "b".repeat(64);
const PHOTO_KEY = cloudKey("entry-1");
const detection: CutoutDetection = {
  schemaVersion: 1,
  engine: "Vision",
  engineRevision: 1,
  width: 4,
  height: 2,
  inputSHA256: SHA,
  sourceOrientation: 1,
  largest: "instance-1",
  subjects: [
    {
      selection: "instance-1",
      pixelCount: 4,
      mask: `${MASK_SHA}.png`,
      maskSHA256: MASK_SHA,
      maskWidth: 4,
      maskHeight: 2,
    },
  ],
};
const recipe: CutoutRecipe = {
  v: 1,
  detection,
  selected: "instance-1",
  background: { kind: "transparent" },
  strokes: [],
};

function fakeCommands(answer: (command: string, request: Record<string, unknown> | undefined) => unknown) {
  const calls: Array<[string, Record<string, unknown> | undefined]> = [];
  const invoke: Invoke = async <T,>(command: string, args?: Parameters<Invoke>[1]) => {
    const request = (args as { request?: Record<string, unknown> } | undefined)?.request;
    calls.push([command, request]);
    return answer(command, request) as T;
  };
  return { calls, commands: createCameraCommands(invoke) };
}

describe("createLocalPhotoCutoutHost", () => {
  it("resolves the UI photo key to the opened native photoId without passing a path", async () => {
    const native = fakeCommands((command) =>
      command === "camera_cutout_load_recipe" ? { recipe } : command === "camera_cutout_read_mask" ? new Uint8Array([1, 2]).buffer : {},
    );
    const resolved: string[] = [];
    const host = createLocalPhotoCutoutHost(native.commands, async (key, run) => {
      resolved.push(key);
      return run("photo-native-1");
    });
    await expect(host.loadRecipe(PHOTO_KEY)).resolves.toEqual(recipe);
    await expect(host.readMask(PHOTO_KEY, detection.subjects[0]!)).resolves.toEqual(new Uint8Array([1, 2]));
    expect(resolved).toEqual(["entry-1", "entry-1"]);
    expect(native.calls).toEqual([
      ["camera_cutout_load_recipe", { photoId: "photo-native-1" }],
      ["camera_cutout_read_mask", { photoId: "photo-native-1", subject: detection.subjects[0] }],
    ]);
    expect(JSON.stringify(native.calls)).not.toContain("/");
  });

  it("cancels the native operation and ignores a late detection after AbortSignal", async () => {
    let finish: ((value: { detection: CutoutDetection }) => void) | undefined;
    const native = fakeCommands((command) => {
      if (command === "camera_cutout_detect") return new Promise<{ detection: CutoutDetection }>((resolve) => (finish = resolve));
      return {};
    });
    const host = createLocalPhotoCutoutHost(native.commands, (_key, run) => run("photo-1"));
    const controller = new AbortController();
    const pending = host.detect(PHOTO_KEY, controller.signal);
    await Promise.resolve();
    controller.abort();
    await expect(pending).rejects.toMatchObject({ name: "AbortError" });
    expect(native.calls.map(([command]) => command)).toEqual(["camera_cutout_detect", "camera_cutout_cancel"]);
    finish?.({ detection });
    await Promise.resolve();
  });

  it("does not open or detect an already-aborted photo", async () => {
    const native = fakeCommands(() => ({ detection }));
    const withPhoto = vi.fn();
    const host = createLocalPhotoCutoutHost(native.commands, (_key, run) => {
      withPhoto();
      return run("photo-1");
    });
    const controller = new AbortController();
    controller.abort();
    await expect(host.detect(PHOTO_KEY, controller.signal)).rejects.toMatchObject({ name: "AbortError" });
    expect(withPhoto).not.toHaveBeenCalled();
    expect(native.calls).toEqual([]);
  });

  it("keeps native errors and maps a closed export dialog to saved false", async () => {
    const failure = new CameraCommandError("no_subjects", "被写体が見つかりません。");
    const native = fakeCommands((command) => {
      if (command === "camera_cutout_detect") throw failure;
      if (command === "camera_cutout_export") return { saved: false };
      return {};
    });
    const host = createLocalPhotoCutoutHost(native.commands, (_key, run) => run("photo-1"));
    await expect(host.detect(PHOTO_KEY, new AbortController().signal)).rejects.toMatchObject({ code: "no_subjects" });
    await expect(host.exportFullSize?.(PHOTO_KEY, { recipe, settings: {}, format: "png" })).resolves.toEqual({
      saved: false,
      fileName: "",
    });
  });

  it("rejects unknown editor keys before resolving a native photo", async () => {
    const native = fakeCommands(() => ({ recipe: null }));
    const resolved = vi.fn();
    const host = createLocalPhotoCutoutHost(native.commands, (_key, run) => {
      resolved();
      return run("photo-1");
    });
    await expect(host.loadRecipe("entry-1")).rejects.toMatchObject({ code: "invalidRequest" });
    await expect(host.loadRecipe("cloud:")).rejects.toMatchObject({ code: "invalidRequest" });
    expect(resolved).not.toHaveBeenCalled();
    expect(native.calls).toEqual([]);
  });
});
