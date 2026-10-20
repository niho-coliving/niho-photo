import { execFileSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import path from "node:path";

const commitPattern = /^[a-f0-9]{40}$/;
const repository = "niho-coliving/niho-docs";

export function validateSyncManifest(manifest) {
  if (
    manifest?.schemaVersion !== 1
    || manifest.repository !== repository
    || !commitPattern.test(manifest.commit ?? "")
    || !Array.isArray(manifest.files)
    || manifest.files.length === 0
  ) throw new Error("invalid manifest");
  const targets = new Set();
  for (const item of manifest.files) {
    for (const key of ["source", "target"]) {
      const value = item?.[key];
      if (typeof value !== "string" || value.length === 0 || value.startsWith("/") || value.includes("\\") || /[\x00-\x1f\x7f]/.test(value) || value !== path.posix.normalize(value) || value.split("/").some((part) => !part || part === "." || part === "..")) throw new Error("invalid path");
    }
    if (targets.has(item.target)) throw new Error("duplicate target");
    targets.add(item.target);
  }
  return manifest;
}

export function validatePublicationSources(syncManifest, publicationManifest) {
  const external = publicationManifest?.externalSources;
  if (
    !Array.isArray(external)
    || external.length !== 1
    || external[0]?.repository !== syncManifest.repository
    || external[0]?.commit !== syncManifest.commit
  ) throw new Error("external source mismatch");
  const importedFiles = publicationManifest.importedFiles;
  if (!Array.isArray(importedFiles)) throw new Error("import manifest missing");
  const externalImports = importedFiles.filter((item) => item.source?.repository === syncManifest.repository);
  if (externalImports.length !== syncManifest.files.length) throw new Error("external import set mismatch");
  for (const { source, target } of syncManifest.files) {
    const matches = externalImports.filter((item) => item.path === target);
    const entry = matches.length === 1 ? matches[0] : undefined;
    if (
      !entry
      || entry.source?.repository !== syncManifest.repository
      || entry.source?.commit !== syncManifest.commit
      || entry.source?.path !== source
      || !/^[a-f0-9]{64}$/.test(entry.source?.sha256 ?? "")
      || entry.source.sha256 !== entry.outputSha256
    ) throw new Error("import manifest mismatch");
  }
  return true;
}

export async function compareContractFiles(manifest, sourceRoot, targetRoot) {
  let checked = 0;
  for (const { source, target } of manifest.files) {
    const [sourceBytes, targetBytes] = await Promise.all([
      readFile(path.join(sourceRoot, source)),
      readFile(path.join(targetRoot, target)),
    ]);
    const sourceHash = createHash("sha256").update(sourceBytes).digest("hex");
    const targetHash = createHash("sha256").update(targetBytes).digest("hex");
    if (sourceHash !== targetHash) throw new Error("contract mismatch");
    checked++;
  }
  return checked;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const root = fileURLToPath(new URL("../../", import.meta.url));
    const sourceRoot = process.argv[2];
    if (!sourceRoot) throw new Error("source checkout required");
    const manifest = validateSyncManifest(JSON.parse(await readFile(path.join(root, "docs/security/cloud-contract-source.json"), "utf8")));
    const publicationManifest = JSON.parse(await readFile(path.join(root, "docs/security/publication-manifest.json"), "utf8"));
    validatePublicationSources(manifest, publicationManifest);
    const actualCommit = execFileSync("git", ["-C", sourceRoot, "rev-parse", "HEAD"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
    if (actualCommit !== manifest.commit) throw new Error("commit mismatch");
    const checked = await compareContractFiles(manifest, sourceRoot, root);
    console.log(`Docs cloud contract同期: ${checked} files / SHA固定一致`);
  } catch {
    console.error("Docs cloud contract同期に失敗しました。固定SHAと公開ファイルhashを確認してください（値は非表示）");
    process.exitCode = 1;
  }
}
