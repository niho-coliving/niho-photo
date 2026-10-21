import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { buildEnvironment } from "../../../scripts/ci/release-evidence-lib.mjs";

// 公開CI用検証app。release mode、ad-hoc署名、updater・公式更新featureは無効。
const root = fileURLToPath(new URL("../../../", import.meta.url));
let isolatedRoot;
try {
  isolatedRoot = await mkdtemp(path.join(process.env.TMPDIR || tmpdir(), "niho-photo-release-app-"));
  const home = path.join(isolatedRoot, "home"), cargoHome = path.join(isolatedRoot, "cargo"), npmUserConfig = path.join(isolatedRoot, "npm-user.npmrc"), npmGlobalConfig = path.join(isolatedRoot, "npm-global.npmrc");
  await Promise.all([mkdir(home), mkdir(cargoHome), writeFile(npmUserConfig, ""), writeFile(npmGlobalConfig, "")]);
  const env = buildEnvironment(process.env, root, { home, cargoHome, tmpdir: isolatedRoot, npmUserConfig, npmGlobalConfig });
  const result = spawnSync("tauri", ["build", "--bundles", "app", "--config", JSON.stringify({ bundle: { macOS: { signingIdentity: "-", hardenedRuntime: false }, createUpdaterArtifacts: false } }), "--", "--locked"], { stdio: "inherit", env });
  if (result.error) console.error("公開検証appのビルドを起動できませんでした（値は非表示）");
  process.exitCode = result.status ?? 1;
} catch {
  console.error("公開検証appの隔離環境を準備できませんでした（値は非表示）");
  process.exitCode = 1;
} finally {
  if (isolatedRoot) await rm(isolatedRoot, { recursive: true, force: true });
}
