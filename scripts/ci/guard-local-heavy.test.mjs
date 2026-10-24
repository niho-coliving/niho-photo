import assert from "node:assert/strict";
import { test } from "node:test";
import { isMacMiniDevice } from "./guard-local-heavy.mjs";

test("Tailscale の Mac mini 端末名で止める", () => {
  assert.equal(isMacMiniDevice({ deviceName: "takuya-mac-mini", hostName: "other-host" }), true);
});

test("Tailscale が利用できれば hostname より優先する", () => {
  assert.equal(isMacMiniDevice({ deviceName: "takuya-mac-studio", hostName: "takuya-macmini" }), false);
});

test("Tailscale が停止中でも既知の Mac mini hostname で止める", () => {
  assert.equal(isMacMiniDevice({ deviceName: null, hostName: "takuya-macmini" }), true);
  assert.equal(isMacMiniDevice({ deviceName: null, hostName: "Macmini" }), false);
});
