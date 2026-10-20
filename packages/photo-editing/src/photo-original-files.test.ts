import { describe, expect, it } from "vitest";

import {
  BROWSER_CLOUD_ORIGINAL_FILE_EXTENSIONS,
  BROWSER_CLOUD_ORIGINAL_MAX_BYTES,
  validateBrowserCloudOriginalFile,
} from "./photo-original-files";

describe("validateBrowserCloudOriginalFile", () => {
  it("API と同じ拡張子（WebP・XMP は除く）だけを受け、空・200MiB 超を断る", () => {
    expect(validateBrowserCloudOriginalFile({ name: "P1.RW2", size: BROWSER_CLOUD_ORIGINAL_MAX_BYTES })).toEqual({
      ok: true,
      fileExtension: "rw2",
    });
    expect(BROWSER_CLOUD_ORIGINAL_FILE_EXTENSIONS).not.toContain("webp");
    expect(validateBrowserCloudOriginalFile({ name: "photo.webp", size: 10 }).ok).toBe(false);
    expect(validateBrowserCloudOriginalFile({ name: "preset.xmp", size: 10 }).ok).toBe(false);
    expect(validateBrowserCloudOriginalFile({ name: "P1.RAW", size: 0 }).ok).toBe(false);
    expect(validateBrowserCloudOriginalFile({ name: "P1.RAW", size: BROWSER_CLOUD_ORIGINAL_MAX_BYTES + 1 })).toEqual({
      ok: false,
      message: "写真は 1 枚 200MB までです。",
    });
  });
});
