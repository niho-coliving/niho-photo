import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

function readDialogSource(): string {
  return readFileSync(new URL("./dialog.tsx", import.meta.url), "utf8");
}

describe("dialog content vertical scroll", () => {
  it("lets tall DialogContent scroll vertically with iOS-safe defaults when callers do not own sizing", () => {
    const source = readDialogSource();

    // 中身が画面より高くなっても DialogContent 内で縦スクロールできること。
    // これが無いと、ゲスト追加などでモーダルが縦に伸びた際にモバイルで
    // 上端/下端が画面外へはみ出し、下部ボタンに到達できなくなる。
    expect(source).toContain("max-h-[85dvh]");
    expect(source).toContain("overflow-y-auto");

    // iOS の慣性スクロール / スクロールチェーン抑制。
    expect(source).toContain("overscroll-contain");
    expect(source).toContain("[-webkit-overflow-scrolling:touch]");
  });

  it("does not force default max-height or touch-action onto caller-owned layouts", () => {
    const source = readDialogSource();

    // overflow-hidden / overflow-visible / h-[100dvh] / max-h-* などを持つ既存ダイアログは、
    // 内部スクロール・装飾のはみ出し・全画面表示を各呼び出し元が管理している。
    // 共通 default scroll はそれらを検出した時だけ外す。
    expect(source).toContain("shouldUseDefaultDialogContentScroll");
    expect(source).toContain('token.startsWith("max-h-")');
    expect(source).toContain('token.startsWith("h-")');
    expect(source).toContain('token.startsWith("min-h-")');
    expect(source).toContain('token.startsWith("overflow-")');

    // DialogContent 全体に pan-y を付けると、子要素の overflow-x-auto が横パンできなくなる。
    expect(source).not.toContain("[touch-action:pan-y]");
  });
});
