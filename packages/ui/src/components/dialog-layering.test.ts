import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

function readDialogSource(): string {
  return readFileSync(new URL("./dialog.tsx", import.meta.url), "utf8");
}

describe("dialog layering", () => {
  it("keeps default dialogs above living menu and module sheets", () => {
    const source = readDialogSource();

    expect(source).toContain("living module panels");
    expect(source).toContain("z-[150] bg-black/80");
    expect(source).toContain("top-[50%] z-[150] grid");
    expect(source).not.toContain("z-[60] bg-black/80");
    expect(source).not.toContain("top-[50%] z-[60] grid");
  });
});
