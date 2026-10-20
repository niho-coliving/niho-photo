import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

function readPopoverSource(): string {
  return readFileSync(new URL("./popover.tsx", import.meta.url), "utf8");
}

describe("popover layering", () => {
  it("keeps portaled popovers above living menu and module sheets", () => {
    const source = readPopoverSource();

    expect(source).toContain("z-[150] w-72");
    expect(source).not.toContain("z-[60] w-72");
  });
});
