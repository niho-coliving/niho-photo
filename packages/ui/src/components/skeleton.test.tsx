import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { Skeleton, SkeletonList } from "./skeleton";

describe("Skeleton", () => {
  it("applies the default pulse styling and merges className overrides", () => {
    const html = renderToStaticMarkup(<Skeleton className="h-14" />);
    expect(html).toContain("animate-pulse");
    expect(html).toContain("bg-niho-border");
    expect(html).toContain("h-14");
  });

  it("lets className override a conflicting default (e.g. rounded-*)", () => {
    const html = renderToStaticMarkup(<Skeleton className="rounded-[18px]" />);
    expect(html).toContain("rounded-[18px]");
    expect(html).not.toContain("rounded-xl");
  });
});

describe("SkeletonList", () => {
  it("renders `count` skeleton items", () => {
    const html = renderToStaticMarkup(<SkeletonList count={3} className="h-16" />);
    const matches = html.match(/animate-pulse/g) ?? [];
    expect(matches).toHaveLength(3);
    expect(html).toContain("h-16");
  });
});
