import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

describe("ModalActionBanner component wiring", () => {
  const source = readFileSync(new URL("./modal-action-banner.tsx", import.meta.url), "utf8");

  it("exports ModalActionBanner", () => {
    expect(source).toContain("export function ModalActionBanner");
  });

  it("announces error and warning messages through alert semantics", () => {
    expect(source).toContain('role={tone === "error" || tone === "warning" ? "alert" : "status"}');
    expect(source).toContain('aria-live={tone === "error" || tone === "warning" ? "assertive" : "polite"}');
  });

  it("keeps modal action buttons at least 44px tall", () => {
    expect(source).toContain("min-h-11");
  });

  it("supports retry or recovery actions", () => {
    expect(source).toContain("action?: { label: string; onClick: () => void; disabled?: boolean; loading?: boolean }");
    expect(source).toContain("action.label");
  });
});
