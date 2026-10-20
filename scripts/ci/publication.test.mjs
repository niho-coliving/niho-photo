import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtemp, mkdir, writeFile, readFile, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { digest, verifyPublication, parseInventory } from "./publication-lib.mjs";
const realRoot = fileURLToPath(new URL("../../", import.meta.url));
const baseline = "a".repeat(40), candidate = "b".repeat(40);
const header = "source_commit,source_path,sha256,size_bytes,category,origin,license_evidence,redistribution,decision\n";

async function fixture(t) {
  const root = await mkdtemp(path.join(tmpdir(), "photo-publication-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const put = async (name, bytes) => { await mkdir(path.dirname(path.join(root, name)), { recursive: true }); await writeFile(path.join(root, name), bytes); };
  const json = async (name, value) => put(name, `${JSON.stringify(value, null, 2)}\n`);
  execFileSync("git", ["init", "--quiet"], { cwd: root });
  await put("docs/security/publication-policy.json", await readFile(path.join(realRoot, "docs/security/publication-policy.json")));
  await put("docs/legal/asset-inventory.csv", header);
  const source = "export const exposure = 0;\n";
  await put("packages/example/src/exposure.ts", source);
  const manifest = { schemaVersion: 1, issue: 11, sourceBaseline: { repository: "niho-app", commit: baseline }, auditedCandidate: { repository: "niho-clients", commit: candidate }, importedFiles: [{ path: "packages/example/src/exposure.ts", source: { repository: "niho-app", commit: baseline, path: "packages/example/src/exposure.ts", sha256: digest(source) }, outputSha256: digest(source), modifications: [] }], generatedFiles: [], excludedSources: [], deferredScopes: [] };
  const save = () => json("docs/security/publication-manifest.json", manifest);
  await save();
  return { root, put, json, manifest, save, check: async () => (await verifyPublication(root)).failures };
}

const rejected = async (f, pattern) => assert.ok((await f.check()).some((failure) => pattern.test(failure)), `拒否されませんでした: ${pattern}`);

test("監査済みソースは許可し、manifest hash更新だけでは出典を偽装できない", async (t) => {
  const f = await fixture(t);
  assert.deepEqual(await f.check(), []);
  await f.put("packages/example/src/exposure.ts", "export const exposure = 1;\n");
  await rejected(f, /ハッシュ不一致/);
  f.manifest.importedFiles[0].outputSha256 = digest("export const exposure = 1;\n");
  await f.save();
  await rejected(f, /変更理由不正/);
  f.manifest.importedFiles[0].modifications = ["露光の合成テストの期待値を更新。"];
  await f.save();
  assert.deepEqual(await f.check(), []);
  f.manifest.importedFiles[0].source.commit = candidate;
  await f.save();
  await rejected(f, /出典不正/);
});

test("packages外の禁止パス、秘密ファイル、巨大fixtureも拒否する", async (t) => {
  const f = await fixture(t);
  for (const name of ["apps/api/index.ts", "docs/.env.production", "misc/ID_RSA", "misc/key.PEM", ".gitmodules", ".npmrc", ".gitleaksignore", "sample.DCP"]) await f.put(name, "synthetic forbidden input\n");
  await f.put("docs/oversize.txt", Buffer.alloc(2097153, 65));
  const failures = await f.check();
  assert.equal(failures.filter((v) => v.startsWith("公開禁止パス")).length, 8);
  assert.ok(failures.some((v) => /サイズ超過/.test(v)));
  const policy = JSON.parse(await readFile(path.join(f.root, "docs/security/publication-policy.json")));
  policy.forbiddenBasenames = [];
  policy.forbiddenPathPrefixes = [];
  policy.forbiddenExtensions = [];
  await f.json("docs/security/publication-policy.json", policy);
  assert.equal((await f.check()).filter((v) => v.startsWith("公開禁止パス")).length, 8);
});

test("symlinkとsubmoduleとmanifest未登録ソースを拒否する", async (t) => {
  const f = await fixture(t);
  await symlink("docs/security/publication-policy.json", path.join(f.root, "linked"));
  await f.put("packages/extra/new.ts", "export {};\n");
  execFileSync("git", ["update-index", "--add", "--cacheinfo", `160000,${candidate},vendor/module`], { cwd: f.root });
  const failures = await f.check();
  assert.ok(failures.some((v) => /通常ファイル以外/.test(v)));
  assert.ok(failures.some((v) => /symlink\/submodule/.test(v)));
  assert.ok(failures.some((v) => /未登録ソース/.test(v)));
});

test("未承認binaryとテキスト画像も拒否し、公開可能台帳のexact bytesだけ許可する", async (t) => {
  const f = await fixture(t);
  const name = "packages/example/assets/icon.png";
  const bytes = Buffer.from([137, 80, 78, 71, 0, 13, 10]);
  await f.put(name, bytes);
  await rejected(f, /公開許可未確認/);
  f.manifest.importedFiles.push({ path: name, source: { repository: "niho-app", commit: baseline, path: name, sha256: digest(bytes) }, outputSha256: digest(bytes), modifications: [] });
  await f.save();
  await f.put("docs/legal/asset-inventory.csv", `${header}${candidate},${name},${digest(bytes)},${bytes.length},icon,独立作成した合成のアイコン,オーナーの公開許可を確認済み,独立再配布禁止,公開可能\n`);
  assert.deepEqual(await f.check(), []);
  const changed = Buffer.from([137, 80, 78, 71, 0, 14, 10]);
  await f.put(name, changed);
  f.manifest.importedFiles[1].outputSha256 = digest(changed);
  f.manifest.importedFiles[1].modifications = ["未監査バイトへの差し替えを試す。"];
  await f.save();
  await rejected(f, /公開許可未確認/);
  await f.put("docs/logo.svg", '<svg xmlns="http://www.w3.org/2000/svg"/>\n');
  await rejected(f, /未登録資産/);
});

test("要置換fixtureの元バイト列はrenameでも拒否し、独立合成JSONへ置換できる", async (t) => {
  const f = await fixture(t);
  const original = '{"sample":"unreviewed"}\n';
  const name = "packages/example/fixtures/sample.json";
  await f.put("docs/legal/asset-inventory.csv", `${header}${candidate},private/original.json,${digest(original)},${Buffer.byteLength(original)},fixture,生成元未確認の既存入力,公開許可未確認の入力,不可,要置換\n`);
  await f.put(name, original);
  f.manifest.generatedFiles.push({ path: name, sha256: digest(original), origin: "独立生成と申告したが既存バイトを流用。" });
  await f.save();
  await rejected(f, /非公開\/要置換/);
  const synthetic = '{"sample":[0,1,2]}\n';
  await f.put(name, synthetic);
  f.manifest.generatedFiles[0].sha256 = digest(synthetic);
  f.manifest.generatedFiles[0].origin = "0から2までの整数を手書きした独立合成fixture。";
  await f.save();
  assert.deepEqual(await f.check(), []);
});

test("private URL/package参照の値をエラーへ出力しない", async (t) => {
  const f = await fixture(t);
  const privateUrl = "https://" + "10.1.2.3" + "/sensitive-marker";
  await f.put("docs/example.md", `${privateUrl}\n`);
  await f.json("package.json", { dependencies: { "private-package": "git+" + privateUrl } });
  const failures = await f.check();
  assert.ok(failures.some((v) => /非公開参照/.test(v)));
  assert.ok(failures.some((v) => /package参照/.test(v)));
  assert.ok(failures.every((v) => !v.includes("sensitive-marker") && !v.includes("10.1.2.3")));
});

test("manifest重複、欠落、path traversal、policyサイズ緩和を拒否する", async (t) => {
  const f = await fixture(t);
  f.manifest.importedFiles.push(f.manifest.importedFiles[0]);
  f.manifest.generatedFiles.push({ path: "../outside", sha256: "a".repeat(64), origin: "不正な外部パスへのアクセスを試す。" });
  await f.save();
  await rejected(f, /重複/);
  await rejected(f, /パス不正/);
  await rm(path.join(f.root, "packages/example/src/exposure.ts"));
  await rejected(f, /ファイル欠落/);
  const policy = JSON.parse(await readFile(path.join(f.root, "docs/security/publication-policy.json")));
  policy.maxFileBytes = 2097153;
  await f.json("docs/security/publication-policy.json", policy);
  await assert.rejects(f.check, /policy/);
});

test("CSV内の引用カンマを解釈し、不正な列数と引用符は拒否する", () => {
  const row = `${header}${candidate},source,${"c".repeat(64)},1,fixture,"合成,入力",許可あり,不可,公開可能\n`;
  assert.equal(parseInventory(row)[0].origin, "合成,入力");
  assert.throws(() => parseInventory(`${header}wrong,columns\n`));
  assert.throws(() => parseInventory(`${header}"unterminated\n`));
});

test("理由付きmanifest更新は出典とschemaを保持し、未登録ファイルを追加しない", async (t) => {
  const f = await fixture(t);
  for (const script of ["scripts/update-publication-manifest.mjs", "scripts/ci/publication-lib.mjs", "scripts/ci/workflow-lib.mjs"]) await f.put(script, await readFile(path.join(realRoot, script)));
  const before = structuredClone(f.manifest);
  const changed = "export const exposure = 2;\n";
  await f.put(before.importedFiles[0].path, changed);
  const script = path.join(f.root, "scripts/update-publication-manifest.mjs");
  execFileSync(process.execPath, [script, "--path", before.importedFiles[0].path, "--reason", "独立合成の露光入力に合わせて既定値を変更。"], { stdio: "pipe" });
  const updated = JSON.parse(await readFile(path.join(f.root, "docs/security/publication-manifest.json")));
  assert.deepEqual(updated.sourceBaseline, before.sourceBaseline);
  assert.deepEqual(updated.importedFiles[0].source, before.importedFiles[0].source);
  assert.equal(updated.schemaVersion, 1);
  assert.equal(updated.importedFiles[0].outputSha256, digest(changed));
  assert.equal(updated.importedFiles[0].modifications.length, 1);
  assert.deepEqual(await f.check(), []);
  const manifestBytes = await readFile(path.join(f.root, "docs/security/publication-manifest.json"));
  assert.throws(() => execFileSync(process.execPath, [script, "--path", "unregistered.ts", "--reason", "未登録ファイルの自動追加を試す。"], { stdio: "pipe" }));
  assert.deepEqual(await readFile(path.join(f.root, "docs/security/publication-manifest.json")), manifestBytes);
});
