import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { Spinner } from "./spinner";

describe("Spinner", () => {
  it("既定は xl(48px)・明るい黄緑(brand)・装飾(aria-hidden)", () => {
    const html = renderToStaticMarkup(<Spinner />);
    const div = html.match(/<div[^>]*>/)?.[0] ?? "";

    // 色は --niho-loading-spinner-color の単一の正
    expect(div).toContain("border-[var(--niho-loading-spinner-color)]");
    // 既定サイズ xl
    expect(div).toContain("h-12 w-12 border-4");
    // 共通の spinner 基底クラス
    expect(div).toContain("animate-spin");
    expect(div).toContain("rounded-full");
    // 上辺だけ透明＝弧（塗りつぶし円にならない）
    expect(div).toContain("border-t-transparent");
    // prefers-reduced-motion 対応（design-guide §9 MUST）
    expect(div).toContain("motion-reduce:animate-none");
    // 既定は装飾。live region を増やさない
    expect(div).toContain('aria-hidden="true"');
    expect(div).not.toContain('role="status"');
  });

  it("label 省略時は border-t-transparent が色クラスより後に効く（弧を保証）", () => {
    // tone=onColor(border-white) と className=border 指定が来ても上辺透明が残ること
    const html = renderToStaticMarkup(
      <Spinner size="md" tone="onColor" className="border-niho-dark" />,
    );
    const div = html.match(/<div[^>]*>/)?.[0] ?? "";
    expect(div).toContain("border-t-transparent");
  });

  it("size でサイズ・border 幅が一意に決まる", () => {
    const sm = renderToStaticMarkup(<Spinner size="sm" />);
    expect(sm).toContain("h-4 w-4 border-2");
    const md = renderToStaticMarkup(<Spinner size="md" />);
    expect(md).toContain("h-6 w-6 border-2");
    const lg = renderToStaticMarkup(<Spinner size="lg" />);
    expect(lg).toContain("h-10 w-10 border-4");
    const xl = renderToStaticMarkup(<Spinner size="xl" />);
    expect(xl).toContain("h-12 w-12 border-4");
  });

  it('tone="onColor" は白リング（色面の上向け）', () => {
    const html = renderToStaticMarkup(<Spinner size="md" tone="onColor" />);
    expect(html).toContain("border-white");
    expect(html).not.toContain("border-[var(--niho-loading-spinner-color)]");
  });

  it("className は layout 用に追記できる（基底クラスは保持）", () => {
    const html = renderToStaticMarkup(<Spinner className="mx-auto mb-4" />);
    expect(html).toContain("mx-auto");
    expect(html).toContain("mb-4");
    expect(html).toContain("animate-spin");
  });

  it("label を渡すと role=status で読み上げる（単独ローダー用）", () => {
    const html = renderToStaticMarkup(<Spinner label="送信中" />);
    expect(html).toContain('role="status"');
    expect(html).toContain('aria-label="送信中"');
    expect(html).not.toContain('aria-hidden');
  });
});
