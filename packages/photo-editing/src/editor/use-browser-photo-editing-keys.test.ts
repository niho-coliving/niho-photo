import { describe, expect, it } from "vitest";

import { resolveBrowserPhotoEditingKey } from "./use-browser-photo-editing-keys";

/** 1 枚の編集のキーの読み分け（⌘Z / ⇧⌘Z・⌥⇧⌘C / ⌥⇧⌘V・`\`）。 */

function keyEvent(init: { key: string; metaKey?: boolean; ctrlKey?: boolean; shiftKey?: boolean; altKey?: boolean; defaultPrevented?: boolean; isComposing?: boolean }) {
  return {
    key: init.key,
    metaKey: init.metaKey ?? false,
    ctrlKey: init.ctrlKey ?? false,
    shiftKey: init.shiftKey ?? false,
    altKey: init.altKey ?? false,
    defaultPrevented: init.defaultPrevented ?? false,
    isComposing: init.isComposing ?? false,
  };
}

describe("resolveBrowserPhotoEditingKey", () => {
  it("⌘Z / ⇧⌘Z（Ctrl でも）は取り消す / やり直す", () => {
    expect(resolveBrowserPhotoEditingKey(keyEvent({ key: "z", metaKey: true }), { typing: false })).toBe("undo");
    expect(resolveBrowserPhotoEditingKey(keyEvent({ key: "Z", ctrlKey: true, shiftKey: true }), { typing: false })).toBe("redo");
  });

  it("⌥⇧⌘C / ⌥⇧⌘V（Ctrl+Alt+Shift でも）は補正をコピー / 貼り付け。Chrome の DevTools と重なるキーは扱わない（#17140）", () => {
    expect(resolveBrowserPhotoEditingKey(keyEvent({ key: "C", metaKey: true, shiftKey: true, altKey: true }), { typing: false })).toBe("copy");
    expect(resolveBrowserPhotoEditingKey(keyEvent({ key: "v", ctrlKey: true, shiftKey: true, altKey: true }), { typing: false })).toBe("paste");
    expect(resolveBrowserPhotoEditingKey(keyEvent({ key: "c", metaKey: true }), { typing: false })).toBeNull();
    expect(resolveBrowserPhotoEditingKey(keyEvent({ key: "v", ctrlKey: true }), { typing: false })).toBeNull();
    expect(resolveBrowserPhotoEditingKey(keyEvent({ key: "c", metaKey: true, shiftKey: true }), { typing: false })).toBeNull();
    expect(resolveBrowserPhotoEditingKey(keyEvent({ key: "x", metaKey: true, shiftKey: true }), { typing: false })).toBeNull();
  });

  it("\\ と ¥ は補正前。文字を打つ欄・IME の変換中・ほかが扱ったキーは扱わない", () => {
    expect(resolveBrowserPhotoEditingKey(keyEvent({ key: "\\" }), { typing: false })).toBe("compare");
    expect(resolveBrowserPhotoEditingKey(keyEvent({ key: "¥" }), { typing: false })).toBe("compare");
    expect(resolveBrowserPhotoEditingKey(keyEvent({ key: "C", metaKey: true, shiftKey: true }), { typing: true })).toBeNull();
    expect(resolveBrowserPhotoEditingKey(keyEvent({ key: "z", metaKey: true, isComposing: true }), { typing: false })).toBeNull();
    expect(resolveBrowserPhotoEditingKey(keyEvent({ key: "z", metaKey: true, defaultPrevented: true }), { typing: false })).toBeNull();
  });
});
