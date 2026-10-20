import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

describe("ConfirmDialog component wiring", () => {
  const source = readFileSync(new URL("./confirm-dialog.tsx", import.meta.url), "utf8");

  it("exports ConfirmDialog", () => {
    expect(source).toContain("export function ConfirmDialog");
  });

  it("uses shared Dialog primitives so focus trap stays centralized", () => {
    expect(source).toContain('from "./dialog"');
    expect(source).toContain("<Dialog");
    expect(source).toContain("<DialogContent");
  });

  it("locks close changes while pending", () => {
    expect(source).toContain("if (!isPending) onOpenChange(nextOpen)");
  });

  it("guards confirm against same-tick re-entry before pending props update", () => {
    expect(source).toContain("confirmClickLockedRef");
    expect(source).toContain("if (isPending || confirmDisabled || confirmClickLockedRef.current) return");
  });

  it("keeps primary and secondary actions at least 44px tall", () => {
    expect(source.match(/min-h-11/g)?.length ?? 0).toBeGreaterThanOrEqual(2);
  });

  it("renders modal action errors through the shared banner", () => {
    expect(source).toContain("<ModalActionBanner");
  });
});
