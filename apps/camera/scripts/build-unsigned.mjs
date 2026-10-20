import { spawnSync } from "node:child_process";

// 公開開発用。署名/認証secretを引き継がず、debug .appをad-hoc署名で作る。
const env = { ...process.env, CSC_IDENTITY_AUTO_DISCOVERY: "false", CARGO_BUILD_JOBS: process.env.CARGO_BUILD_JOBS ?? "2" };
for (const key of Object.keys(env)) {
  if (/^(?:APPLE_|TAURI_SIGNING_|NIHO_FIREBASE_|NIHO_ACCOUNT_)/.test(key)) delete env[key];
}
const result = spawnSync("tauri", ["build", "--debug", "--bundles", "app", "--config", JSON.stringify({ bundle: { macOS: { signingIdentity: "-", hardenedRuntime: false }, createUpdaterArtifacts: false } })], { stdio: "inherit", env });
if (result.error) console.error("unsignedビルドを起動できませんでした。");
process.exitCode = result.status ?? 1;
