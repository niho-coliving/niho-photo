#!/usr/bin/env node
import path from "node:path";
import { fileURLToPath } from "node:url";

import { packReleaseSet, SdkReleaseError } from "./release-set-lib.mjs";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");

function option(argv, name) {
  const index = argv.indexOf(name);
  if (index === -1) return undefined;
  if (!argv[index + 1] || argv[index + 1].startsWith("--")) throw new SdkReleaseError(`${name} に値が必要です`);
  return argv[index + 1];
}

const argv = process.argv.slice(2);
const allowed = new Set(["--output", "--source", "--engine-assets"]);
for (let index = 0; index < argv.length; index += 2) {
  if (!allowed.has(argv[index]) || !argv[index + 1]) throw new SdkReleaseError("使い方: pack-release-set.mjs --output <新規directory> [--source <commit>] [--engine-assets <directory>]");
}

try {
  const output = option(argv, "--output");
  if (!output) throw new SdkReleaseError("--output が必要です");
  const result = await packReleaseSet({
    repoRoot,
    outputDirectory: path.resolve(output),
    sourceRef: option(argv, "--source") ?? "HEAD",
    assetDirectory: option(argv, "--engine-assets") ? path.resolve(option(argv, "--engine-assets")) : undefined,
  });
  console.log(`SDK release set を生成しました: ${path.join(result.outputDirectory, result.manifestName)}`);
} catch (error) {
  console.error(error instanceof Error ? error.message : "SDK release set の生成に失敗しました");
  process.exitCode = 1;
}
