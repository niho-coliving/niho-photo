import { describe, expect, it } from "vitest";

import {
  DEFAULT_PHOTO_EDITING_PANELS,
  PHOTO_EDITING_PANELS_STORAGE_KEY,
  parseStoredPhotoEditingPanels,
  serializePhotoEditingPanels,
} from "./photo-editing-panels";

describe("写真編集の面の開閉の記憶", () => {
  it("キーはナビの折りたたみと同じ流儀（niho:host:…:v1）", () => {
    expect(PHOTO_EDITING_PANELS_STORAGE_KEY).toBe("niho:host:photoEditing:panels:v1");
  });

  it("保存値が無ければ全部開く", () => {
    expect(parseStoredPhotoEditingPanels(null)).toEqual({ left: true, strip: true, right: true });
    expect(DEFAULT_PHOTO_EDITING_PANELS).toEqual({ left: true, strip: true, right: true });
  });

  it("保存した開閉を読み、書いた値と同じに戻る", () => {
    const panels = { left: false, strip: true, right: false };
    const raw = serializePhotoEditingPanels(panels);
    expect(JSON.parse(raw)).toEqual(panels);
    expect(parseStoredPhotoEditingPanels(raw)).toEqual(panels);
  });

  it("壊れた値・形の違う値は既定に戻し、真偽値でない項目だけを既定（開く）にする", () => {
    expect(parseStoredPhotoEditingPanels("not json")).toEqual(DEFAULT_PHOTO_EDITING_PANELS);
    expect(parseStoredPhotoEditingPanels("[false,false,false]")).toEqual(DEFAULT_PHOTO_EDITING_PANELS);
    expect(parseStoredPhotoEditingPanels("null")).toEqual(DEFAULT_PHOTO_EDITING_PANELS);
    expect(parseStoredPhotoEditingPanels("\"1\"")).toEqual(DEFAULT_PHOTO_EDITING_PANELS);
    expect(parseStoredPhotoEditingPanels('{"left":false,"strip":"no","other":false}')).toEqual({
      left: false,
      strip: true,
      right: true,
    });
  });
});
