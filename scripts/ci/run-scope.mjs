import { spawnSync } from "node:child_process";
import { readFile, access } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { scopes } from "./scopes.mjs";

export async function scopeCommands(root, scope) {
  const config = scopes[scope];
  if (!config) throw new Error("未知の公開CI scopeです");
  const readJson = async (name) => JSON.parse(await readFile(path.join(root, name), "utf8"));
  const commands = [];
  if (config.kind === "npm" || config.kind === "hybrid") {
    const repository = await readJson("package.json");
    for (const workspace of config.workspaces) {
      if (!repository.workspaces?.includes(workspace)) throw new Error(`${scope}: 公開root workspaceへの登録が必要です`);
      const pkg = await readJson(`${workspace}/package.json`);
      const required = ["typecheck", "test", "lint", ...(config.native ? ["build:unsigned"] : [])];
      for (const script of required) {
        if (typeof pkg.scripts?.[script] !== "string" || !pkg.scripts[script].trim()) throw new Error(`${scope}: package script ${script} が必要です`);
        commands.push(["npm", ["run", script, "--workspace", workspace]]);
      }
    }
  }
  if (config.kind === "native" || config.kind === "hybrid" || config.native) {
    // 移行時に公開用の実行入口を明示する。非公開repoのコマンドは推測しない。
    const metadata = await readJson(`${config.root}/public-ci.json`);
    if (metadata.schemaVersion !== 1 || metadata.syntheticFixtures !== true || metadata.unsigned !== true || !Array.isArray(metadata.cargoManifests) || !Array.isArray(metadata.swiftPackages) || !metadata.cargoManifests.length) throw new Error(`${scope}: public-ci.jsonにunsigned / synthetic fixture / native対象の宣言が必要です`);
    await access(path.join(root, config.root, "LICENSES.md"));
    for (const manifest of metadata.cargoManifests) {
      if (typeof manifest !== "string" || !/^(?:[A-Za-z0-9_-]+\/)*Cargo\.toml$/.test(manifest)) throw new Error(`${scope}: Cargoパスが不正です`);
      const fullPath = `${config.root}/${manifest}`;
      await access(path.join(root, fullPath));
      await access(path.join(root, path.dirname(fullPath), "Cargo.lock"));
      commands.push(["cargo", ["fmt", "--manifest-path", fullPath, "--all", "--", "--check"]]);
      commands.push(["cargo", ["clippy", "--locked", "--manifest-path", fullPath, "--all-targets", "--", "-D", "warnings"]]);
      commands.push(["cargo", ["test", "--locked", "--manifest-path", fullPath]]);
    }
    for (const directory of metadata.swiftPackages) {
      if (typeof directory !== "string" || !/^(?:[A-Za-z0-9_-]+\/?)+$/.test(directory)) throw new Error(`${scope}: Swiftパスが不正です`);
      const fullPath = `${config.root}/${directory}`;
      await access(path.join(root, fullPath, "Package.swift"));
      commands.push(["swift", ["test", "--package-path", fullPath]]);
    }
  }
  return commands;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const root = fileURLToPath(new URL("../../", import.meta.url));
  const scope = process.argv[2];
  try {
    const commands = await scopeCommands(root, scope);
    for (const [command, args] of commands) {
      console.log(`公開CI: ${scope} / ${command} ${args.join(" ")}`);
      const result = spawnSync(command, args, { cwd: root, stdio: "inherit", env: { ...process.env, CI: "true", CSC_IDENTITY_AUTO_DISCOVERY: "false" } });
      if (result.error || result.status !== 0) { process.exitCode = 1; break; }
    }
  } catch {
    console.error(`公開CI契約が未完了です: ${Object.hasOwn(scopes, scope) ? scope : "不明なscope"}。docs/ci/public-ci.mdのmetadata・workspace・scriptを確認してください。`);
    process.exitCode = 1;
  }
}
