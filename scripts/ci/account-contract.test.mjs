import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";
import { test } from "node:test";
import path from "node:path";
import { selectScopes } from "./scopes.mjs";

const root = fileURLToPath(new URL("../../", import.meta.url));
const read = (name) => readFile(path.join(root, name), "utf8");
const canonical = "packages/desktop-account/contract/native-account-v2.json";
function verifyPin(bytes, pin) {
  const contract = JSON.parse(bytes);
  assert.equal(pin.contract, contract.contract);
  assert.equal(pin.version, contract.version);
  assert.equal(pin.sha256, createHash("sha256").update(bytes).digest("hex"));
}

test("Photoの消費pinはDocsと共通のversioned正本のexact digestを要求する", async () => {
  const bytes = await read(canonical), pin = JSON.parse(await read("apps/camera/account-contract.json"));
  verifyPin(bytes, pin);
  assert.throws(() => verifyPin(bytes.replace('"version": 2', '"version": 3'), pin));
  assert.throws(() => verifyPin(bytes.replace('"S256"', '"plain"'), pin));
  const contract = JSON.parse(bytes);
  assert.deepEqual(contract.consumers, ["photo", "docs"]);
  assert.equal(contract.protocol, "niho-app-connect-v1");
  assert.equal(contract.firebaseRefreshToken, "discard");
  assert.equal(contract.connectionRefreshToken, "rotate-and-save-before-firebase-exchange");
  assert.equal(contract.clientRoleClaimsGrantAuthority, false);
  const rust = await read("packages/desktop-account/src/lib.rs"), ts = await read("packages/desktop-account/ts/src/index.ts");
  assert.ok(rust.includes('include_str!("../contract/native-account-v2.json")'));
  assert.ok(ts.includes('from "../../contract/native-account-v2.json"'));
});

test("共通契約の変更はPhotoとaccountのCIを選択し、公開設定の無いbuildはlocal-only", async () => {
  const plan = selectScopes([canonical], ["apps/camera", "packages/desktop-account"]);
  for (const scope of ["camera", "desktop-account"]) assert.equal(plan.find((item) => item.scope === scope).selected, true);
  const native = await read("apps/camera/src-tauri/src/account.rs");
  assert.ok(native.includes("Account::disabled"));
  assert.ok(native.includes("NIHO_PHOTO_PUBLIC_FIREBASE_WEB_API_KEY"));
  assert.match(native, /Config::production\(\s*ClientId::Camera/);
  assert.ok(native.includes("public-account-v2"));
  const workspace = JSON.parse(await read("package.json"));
  assert.ok(workspace.workspaces.includes("packages/desktop-account/ts"));
});
