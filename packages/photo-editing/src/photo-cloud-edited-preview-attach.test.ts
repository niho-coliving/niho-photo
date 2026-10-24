import { describe, expect, it, vi } from "vitest";

import { libraryCanAttachEditedPreview } from "./photo-cloud-edited-preview";

describe("libraryCanAttachEditedPreview", () => {
  it("補正後のプレビューを付ける口を持つ置き場は上げてよい（クラウド）", () => {
    expect(libraryCanAttachEditedPreview({ attachEditedPreview: vi.fn() })).toBe(true);
  });

  it("口を持たない置き場（この Mac）は上げない", () => {
    expect(libraryCanAttachEditedPreview({})).toBe(false);
    expect(libraryCanAttachEditedPreview({ attachEditedPreview: undefined })).toBe(false);
  });
});
