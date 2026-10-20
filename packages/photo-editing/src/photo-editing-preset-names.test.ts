import { describe, expect, it } from "vitest";

import { builtinPhotoPresetDisplayName } from "./photo-editing-preset-names";

describe("builtinPhotoPresetDisplayName", () => {
  it("crate の id（niho- 付き）を日本語名にする", () => {
    expect(builtinPhotoPresetDisplayName({ id: "niho-bluesky2", name: "bluesky2" })).toBe("青空");
    expect(builtinPhotoPresetDisplayName({ id: "niho-pastel", name: "pastel" })).toBe("パステル");
    expect(builtinPhotoPresetDisplayName({ id: "niho-colorful", name: "colorful" })).toBe("鮮やか");
  });

  it("niho- が無い id・大文字の id でも当たる", () => {
    expect(builtinPhotoPresetDisplayName({ id: "bluesky2", name: "bluesky2" })).toBe("青空");
    expect(builtinPhotoPresetDisplayName({ id: "NIHO-Pastel", name: "Pastel" })).toBe("パステル");
  });

  it("id で当たらなければ名前で当てる", () => {
    expect(builtinPhotoPresetDisplayName({ id: "preset-3", name: "colorful" })).toBe("鮮やか");
  });

  it("表に無いプリセットは元の名前のまま", () => {
    expect(builtinPhotoPresetDisplayName({ id: "niho-night", name: "night" })).toBe("night");
    expect(builtinPhotoPresetDisplayName({ id: "toString", name: "constructor" })).toBe("constructor");
  });
});
