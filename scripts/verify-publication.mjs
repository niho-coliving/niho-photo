import { createHash } from "node:crypto";
import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));
const readJson = async (name) => JSON.parse(await readFile(path.join(root, name), "utf8"));
const policy = await readJson("docs/security/publication-policy.json");
const manifest = await readJson("docs/security/publication-manifest.json");
const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");
const failures = [];
const approved = new Set();
const hashPattern = /^[a-f0-9]{64}$/;

function checkPath(name) {
  if (name !== path.posix.normalize(name) || name.startsWith("/") || name.startsWith("../") || name.includes("\\")) {
    throw new Error(`公開manifestのパスが不正です: ${name}`);
  }
  if (
    policy.forbiddenPathPrefixes.some((prefix) => name.startsWith(prefix)) ||
    policy.forbiddenBasenames.includes(path.posix.basename(name)) ||
    policy.forbiddenExtensions.includes(path.posix.extname(name).toLowerCase())
  ) failures.push(`公開禁止パス: ${name}`);
}

for (const entry of [...manifest.importedFiles, ...manifest.generatedFiles]) {
  checkPath(entry.path);
  if (approved.has(entry.path)) failures.push(`manifestの重複: ${entry.path}`);
  approved.add(entry.path);
  const bytes = await readFile(path.join(root, entry.path));
  const expected = entry.outputSha256 ?? entry.sha256;
  if (!hashPattern.test(expected ?? "") || sha256(bytes) !== expected) failures.push(`ハッシュ不一致: ${entry.path}`);
  if (bytes.length > policy.maxFileBytes) failures.push(`サイズ超過: ${entry.path}`);
  if (bytes.includes(0)) failures.push(`未承認のバイナリ: ${entry.path}`);
  new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  if (entry.source) {
    checkPath(entry.source.path);
    if (entry.source.repository !== manifest.sourceBaseline.repository || entry.source.commit !== manifest.sourceBaseline.commit) {
      failures.push(`出典の基準点が不一致: ${entry.path}`);
    }
    if (!hashPattern.test(entry.source.sha256)) failures.push(`出典ハッシュが不正: ${entry.path}`);
    if (entry.source.sha256 !== expected && entry.modifications.length === 0) failures.push(`変更理由が未記録: ${entry.path}`);
  }
}

async function checkPackageTree(directory) {
  for (const item of await readdir(path.join(root, directory), { withFileTypes: true })) {
    const name = `${directory}/${item.name}`;
    if (["node_modules", "coverage", "dist", ".vitest"].includes(item.name)) continue;
    if (item.isSymbolicLink()) failures.push(`未承認のsymlink: ${name}`);
    else if (item.isDirectory()) await checkPackageTree(name);
    else if (!approved.has(name)) failures.push(`allowlist外のpackageファイル: ${name}`);
  }
}
await checkPackageTree("packages");

const lock = await readJson("package-lock.json");
for (const [name, dependency] of Object.entries(lock.packages ?? {})) {
  if (dependency.resolved && !dependency.link && !dependency.resolved.startsWith("https://registry.npmjs.org/")) {
    failures.push(`公開registry以外の依存: ${name}`);
  }
}

if (failures.length) {
  console.error(failures.join("\n"));
  process.exitCode = 1;
} else {
  console.log(`公開allowlist検証: ${manifest.importedFiles.length} imported / ${manifest.generatedFiles.length} generated files、違反なし`);
}
