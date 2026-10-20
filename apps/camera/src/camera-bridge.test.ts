import { describe, expect, it } from "vitest";

import { readAppInfo, UPDATE_STAGED_EVENT, watchUpdate, type Invoke, type Listen, type UpdateStatus } from "./camera-bridge";

const answering =
  (value: unknown): Invoke =>
  async <T>(command: string) => {
    expect(command).toBe("camera_app_info");
    return value as T;
  };

describe("readAppInfo", () => {
  it("returns the app version from camera_app_info", async () => {
    await expect(readAppInfo(answering({ appVersion: "0.1.0" }))).resolves.toEqual({ appVersion: "0.1.0" });
  });

  it("returns null for an unexpected answer instead of throwing", async () => {
    await expect(readAppInfo(answering(null))).resolves.toBeNull();
    await expect(readAppInfo(answering({ appVersion: 1 }))).resolves.toBeNull();
    await expect(readAppInfo(answering({ appVersion: "dev" }))).resolves.toBeNull();
  });

  it("returns null when the command fails (e.g. outside the app)", async () => {
    const failing: Invoke = async () => {
      throw new Error("not allowed by ACL");
    };
    await expect(readAppInfo(failing)).resolves.toBeNull();
  });
});

describe("watchUpdate", () => {
  function fakeTauri(status: unknown) {
    const order: string[] = [];
    let emit: ((payload: unknown) => void) | null = null;
    let unlistened = 0;
    const listen: Listen = async <T,>(event: string, handler: (event: { payload: T }) => void) => {
      order.push(`listen ${event}`);
      emit = (payload) => handler({ payload: payload as T });
      return () => {
        unlistened += 1;
      };
    };
    const invoke: Invoke = async <T,>(command: string) => {
      order.push(command);
      if (status instanceof Error) throw status;
      return status as T;
    };
    return { order, listen, invoke, emit: (payload: unknown) => emit?.(payload), unlistened: () => unlistened };
  }

  it("listens before reading the current status, then passes on staged versions", async () => {
    const tauri = fakeTauri({ enabled: true, stagedVersion: null });
    const seen: UpdateStatus[] = [];
    const stop = await watchUpdate((status) => seen.push(status), tauri);

    expect(tauri.order).toEqual([`listen ${UPDATE_STAGED_EVENT}`, "camera_update_status"]);
    tauri.emit({ enabled: true, stagedVersion: "0.1.8" });
    expect(seen).toEqual([
      { enabled: true, stagedVersion: null },
      { enabled: true, stagedVersion: "0.1.8" },
    ]);
    stop();
    expect(tauri.unlistened()).toBe(1);
  });

  it("drops answers of an unexpected shape", async () => {
    const tauri = fakeTauri({ enabled: "yes", stagedVersion: null });
    const seen: UpdateStatus[] = [];
    await watchUpdate((status) => seen.push(status), tauri);
    tauri.emit({ enabled: true, stagedVersion: "latest" });
    tauri.emit(null);
    expect(seen).toEqual([]);
  });

  it("stops listening and fails when the status cannot be read", async () => {
    const tauri = fakeTauri(new Error("not allowed by ACL"));
    await expect(watchUpdate(() => undefined, tauri)).rejects.toThrow("not allowed by ACL");
    expect(tauri.unlistened()).toBe(1);
  });
});
