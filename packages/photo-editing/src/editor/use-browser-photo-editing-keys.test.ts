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

  it("Enter は切り抜きの［完了］、Esc は［キャンセル］（⇧Enter・修飾キーつきは扱わない）", () => {
    expect(resolveBrowserPhotoEditingKey(keyEvent({ key: "Enter" }), { typing: false })).toBe("cropDone");
    expect(resolveBrowserPhotoEditingKey(keyEvent({ key: "Escape" }), { typing: false })).toBe("cropCancel");
    expect(resolveBrowserPhotoEditingKey(keyEvent({ key: "Enter", shiftKey: true }), { typing: false })).toBeNull();
    expect(resolveBrowserPhotoEditingKey(keyEvent({ key: "Enter", metaKey: true }), { typing: false })).toBeNull();
    expect(resolveBrowserPhotoEditingKey(keyEvent({ key: "Enter", altKey: true }), { typing: false })).toBeNull();
    expect(resolveBrowserPhotoEditingKey(keyEvent({ key: "Escape", ctrlKey: true }), { typing: false })).toBeNull();
    // 文字を打つ欄（角度の値の入力など）・IME の変換中・ほかが扱った Enter / Esc は扱わない
    expect(resolveBrowserPhotoEditingKey(keyEvent({ key: "Enter" }), { typing: true })).toBeNull();
    expect(resolveBrowserPhotoEditingKey(keyEvent({ key: "Enter", isComposing: true }), { typing: false })).toBeNull();
    expect(resolveBrowserPhotoEditingKey(keyEvent({ key: "Escape", defaultPrevented: true }), { typing: false })).toBeNull();
    // R はこれまでどおり（⌥R は扱わない）
    expect(resolveBrowserPhotoEditingKey(keyEvent({ key: "r" }), { typing: false })).toBe("tool");
    expect(resolveBrowserPhotoEditingKey(keyEvent({ key: "R", shiftKey: true }), { typing: false })).toBe("tool");
    expect(resolveBrowserPhotoEditingKey(keyEvent({ key: "r", altKey: true }), { typing: false })).toBeNull();
  });

  it("J は黒つぶれ・白飛びの印の切り替え（niho-photo#36）。修飾キーつき・文字を打つ欄・IME の変換中・ほかが扱ったキーは扱わない", () => {
    expect(resolveBrowserPhotoEditingKey(keyEvent({ key: "j" }), { typing: false })).toBe("clip");
    // CapsLock で大文字になっても Shift を押していなければ同じ
    expect(resolveBrowserPhotoEditingKey(keyEvent({ key: "J" }), { typing: false })).toBe("clip");
    expect(resolveBrowserPhotoEditingKey(keyEvent({ key: "J", shiftKey: true }), { typing: false })).toBeNull();
    expect(resolveBrowserPhotoEditingKey(keyEvent({ key: "j", altKey: true }), { typing: false })).toBeNull();
    expect(resolveBrowserPhotoEditingKey(keyEvent({ key: "j", metaKey: true }), { typing: false })).toBeNull();
    expect(resolveBrowserPhotoEditingKey(keyEvent({ key: "j", ctrlKey: true }), { typing: false })).toBeNull();
    expect(resolveBrowserPhotoEditingKey(keyEvent({ key: "j" }), { typing: true })).toBeNull();
    expect(resolveBrowserPhotoEditingKey(keyEvent({ key: "j", isComposing: true }), { typing: false })).toBeNull();
    expect(resolveBrowserPhotoEditingKey(keyEvent({ key: "j", defaultPrevented: true }), { typing: false })).toBeNull();
  });

  it("\\ と ¥ は補正前。文字を打つ欄・IME の変換中・ほかが扱ったキーは扱わない", () => {
    expect(resolveBrowserPhotoEditingKey(keyEvent({ key: "\\" }), { typing: false })).toBe("compare");
    expect(resolveBrowserPhotoEditingKey(keyEvent({ key: "¥" }), { typing: false })).toBe("compare");
    expect(resolveBrowserPhotoEditingKey(keyEvent({ key: "C", metaKey: true, shiftKey: true }), { typing: true })).toBeNull();
    expect(resolveBrowserPhotoEditingKey(keyEvent({ key: "z", metaKey: true, isComposing: true }), { typing: false })).toBeNull();
    expect(resolveBrowserPhotoEditingKey(keyEvent({ key: "z", metaKey: true, defaultPrevented: true }), { typing: false })).toBeNull();
  });
});
