import { describe, expect, it, vi } from "vitest";

import {
  readLocalStorageItemSafely,
  removeLocalStorageItemSafely,
  writeLocalStorageItemSafely,
} from "./local-storage-safe";

describe("local-storage-safe", () => {
  it("returns null/false when container is undefined", () => {
    expect(readLocalStorageItemSafely("key", undefined)).toBeNull();
    expect(writeLocalStorageItemSafely("key", "value", undefined)).toBe(false);
    expect(removeLocalStorageItemSafely("key", undefined)).toBe(false);
  });

  it("returns null/false when localStorage getter throws", () => {
    const container = {};
    Object.defineProperty(container, "localStorage", {
      get() {
        throw new Error("blocked");
      },
    });

    expect(readLocalStorageItemSafely("key", container as { localStorage: Storage })).toBeNull();
    expect(writeLocalStorageItemSafely("key", "value", container as { localStorage: Storage })).toBe(false);
    expect(removeLocalStorageItemSafely("key", container as { localStorage: Storage })).toBe(false);
  });

  it("returns null when getItem throws", () => {
    const storage = {
      getItem: vi.fn(() => {
        throw new Error("blocked");
      }),
      setItem: vi.fn(),
      removeItem: vi.fn(),
    };

    expect(readLocalStorageItemSafely("key", { localStorage: storage })).toBeNull();
  });

  it("returns false for setItem/removeItem failures", () => {
    const storage = {
      getItem: vi.fn(() => null),
      setItem: vi.fn(() => {
        throw new Error("quota");
      }),
      removeItem: vi.fn(() => {
        throw new Error("quota");
      }),
    };

    expect(writeLocalStorageItemSafely("key", "value", { localStorage: storage })).toBe(false);
    expect(removeLocalStorageItemSafely("key", { localStorage: storage })).toBe(false);
  });

  it("reads/writes/removes with healthy storage", () => {
    const map = new Map<string, string>();
    const storage = {
      getItem: vi.fn((key: string) => map.get(key) ?? null),
      setItem: vi.fn((key: string, value: string) => {
        map.set(key, value);
      }),
      removeItem: vi.fn((key: string) => {
        map.delete(key);
      }),
    };

    expect(writeLocalStorageItemSafely("a", "1", { localStorage: storage })).toBe(true);
    expect(readLocalStorageItemSafely("a", { localStorage: storage })).toBe("1");
    expect(removeLocalStorageItemSafely("a", { localStorage: storage })).toBe(true);
    expect(readLocalStorageItemSafely("a", { localStorage: storage })).toBeNull();
  });
});
