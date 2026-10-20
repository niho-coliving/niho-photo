import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";
import { compareContractFiles, validatePublicationSources, validateSyncManifest } from "./cloud-contract-sync.mjs";

const commit = "7421a21c5dbe867c380c8d727752ecf7c51a4f84";

async function fixture() {
  const root = await mkdtemp(path.join(os.tmpdir(), "niho-cloud-contract-"));
  const sourceRoot = path.join(root, "source");
  const targetRoot = path.join(root, "target");
  const source = "packages/niho-cloud-contract/src/v1.ts";
  const target = "packages/niho-cloud-contract/src/v1.ts";
  for (const directory of [sourceRoot, targetRoot]) await mkdir(path.join(directory, path.dirname(source)), { recursive: true });
  await writeFile(path.join(sourceRoot, source), "export const contract = 1;\n");
  await writeFile(path.join(targetRoot, target), "export const contract = 1;\n");
  return {
    root,
    sourceRoot,
    targetRoot,
    manifest: { schemaVersion: 1, repository: "niho-coliving/niho-docs", commit, files: [{ source, target }] },
  };
}

test("accepts pinned source and byte-identical Photo contract files", async () => {
  const f = await fixture();
  try {
    assert.equal(validateSyncManifest(f.manifest), f.manifest);
    assert.equal(await compareContractFiles(f.manifest, f.sourceRoot, f.targetRoot), 1);
  } finally { await rm(f.root, { recursive: true, force: true }); }
});

test("rejects path traversal, duplicate targets, and divergent contract bytes", async () => {
  const f = await fixture();
  try {
    assert.throws(() => validateSyncManifest({ ...f.manifest, files: [{ source: "../private", target: "safe" }] }));
    assert.throws(() => validateSyncManifest({ ...f.manifest, files: [...f.manifest.files, f.manifest.files[0]] }));
    await writeFile(path.join(f.targetRoot, f.manifest.files[0].target), "export const contract = 2;\n");
    await assert.rejects(compareContractFiles(f.manifest, f.sourceRoot, f.targetRoot));
  } finally { await rm(f.root, { recursive: true, force: true }); }
});

test("requires publication provenance to use the same Docs SHA and file mapping", () => {
  const manifest = { schemaVersion: 1, repository: "niho-coliving/niho-docs", commit, files: [{ source: "packages/niho-cloud-contract/src/v1.ts", target: "packages/niho-cloud-contract/src/v1.ts" }] };
  const publication = {
    externalSources: [{ repository: "niho-coliving/niho-docs", commit }],
    importedFiles: [{
      path: manifest.files[0].target,
      source: { repository: "niho-coliving/niho-docs", commit, path: manifest.files[0].source, sha256: "a".repeat(64) },
      outputSha256: "a".repeat(64),
    }],
  };
  assert.equal(validatePublicationSources(manifest, publication), true);
  publication.externalSources.push({ repository: "attacker/repo", commit });
  assert.throws(() => validatePublicationSources(manifest, publication));
  publication.externalSources.pop();
  publication.importedFiles.push({
    path: "packages/niho-cloud-contract/src/extra.ts",
    source: { repository: "niho-coliving/niho-docs", commit, path: "packages/niho-cloud-contract/src/extra.ts", sha256: "b".repeat(64) },
    outputSha256: "b".repeat(64),
  });
  assert.throws(() => validatePublicationSources(manifest, publication));
  publication.importedFiles.pop();
  publication.externalSources[0].commit = "b".repeat(40);
  assert.throws(() => validatePublicationSources(manifest, publication));
});
