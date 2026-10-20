import { describe, expect, it } from "vitest";
import { ACCOUNT_CONTRACT, LOCAL_ACCOUNT, accountMessage, parseAccountSnapshot, type AccountError, type AccountPhase } from "./index";

describe("Photo/Docs account contract", () => {
  it("keeps local editing available and rejects unknown fields, versions, phases, and raw error text", () => {
    for (const value of [null, {}, { ...LOCAL_ACCOUNT, contractVersion: 999 }, { ...LOCAL_ACCOUNT, accessToken: "synthetic-sensitive" },
      { ...LOCAL_ACCOUNT, error: "remote-sensitive-message" }, { ...LOCAL_ACCOUNT, phase: "admin" },
      { ...LOCAL_ACCOUNT, available: true }, { ...LOCAL_ACCOUNT, phase: "connected" }, { ...LOCAL_ACCOUNT, localEditingAvailable: false }]) {
      expect(parseAccountSnapshot(value)).toEqual(LOCAL_ACCOUNT);
      expect(JSON.stringify(parseAccountSnapshot(value))).not.toContain("sensitive");
    }
  });
  it("matches every shared phase/error and gives fixed actionable local-safe messages", () => {
    const phases: AccountPhase[] = ["local_only", "signed_out", "waiting", "refreshing", "connected", "offline", "failed"];
    const errors: AccountError[] = ["not_configured", "invalid_config", "busy", "cancelled", "expired", "invalid_redirect", "invalid_state",
      "invalid_response", "rejected", "network", "paused", "account_unavailable", "browser", "storage", "internal"];
    expect(phases).toEqual(ACCOUNT_CONTRACT.phases);
    expect(errors).toEqual(ACCOUNT_CONTRACT.errorCodes);
    for (const error of errors) {
      const snapshot = parseAccountSnapshot({ ...LOCAL_ACCOUNT, phase: "failed", available: true, error });
      expect(snapshot.localEditingAvailable).toBe(true);
      expect(accountMessage(snapshot).length).toBeGreaterThan(5);
    }
    expect(accountMessage({ ...LOCAL_ACCOUNT, error: "network" })).toContain("ネットワーク");
    expect(accountMessage({ ...LOCAL_ACCOUNT, error: "expired" })).toContain("もう一度");
    expect(accountMessage({ ...LOCAL_ACCOUNT, error: "cancelled" })).toContain("取り消しました");
  });
});

describe("固定errorの優先表示", () => {
  it("keeps paused, expired, rejected, and storage messages distinct in offline or failed phases", () => {
    for (const [phase, error, text] of [
      ["offline", "paused", "一時停止"], ["failed", "expired", "もう一度ログイン"],
      ["failed", "rejected", "ログインできません"], ["failed", "storage", "保存先"],
    ] as const) {
      const state = parseAccountSnapshot({ ...LOCAL_ACCOUNT, available: true, phase, error });
      expect(accountMessage(state)).toContain(text);
      expect(accountMessage(state)).not.toContain("オフラインです");
    }
  });
});
