import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { after, test } from "node:test";
import { fileURLToPath } from "node:url";

import {
  assertRelativePath,
  assertStrictSemver,
  auditTypeScriptClosure,
  matchesPackagePath,
  packReleaseSet,
  sha256,
  validateConfig,
  validateRuntimeAssets,
  verifyReleaseManifestFiles,
} from "./release-set-lib.mjs";
import { smokeConsumer } from "./smoke-consumer.mjs";
import { rewriteVersionedRuntimeReferences, runtimeBuildEnvironment, versionedRuntimeFileName } from "./build-develop-engine-runtime.mjs";

const realRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const temporary = [];

function temp(prefix) {
  const directory = mkdtempSync(path.join(tmpdir(), prefix));
  temporary.push(directory);
  return directory;
}

after(() => {
  for (const directory of temporary.splice(0)) rmSync(directory, { recursive: true, force: true });
});

function runGit(root, args) {
  return execFileSync("git", ["-C", root, ...args], { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
}

function put(root, relative, bytes) {
  const target = path.join(root, ...relative.split("/"));
  mkdirSync(path.dirname(target), { recursive: true });
  writeFileSync(target, bytes);
}

function commit(root, message) {
  runGit(root, ["add", "--all"]);
  runGit(root, ["-c", "user.name=SDK test", "-c", "user.email=sdk-test@invalid.example", "commit", "-m", message]);
}

function runtimeFixture(root, config, source = { commit: "a".repeat(40), tree: "b".repeat(40) }) {
  const directory = path.join(root, ...config.engine.assetDirectory.split("/"));
  mkdirSync(directory, { recursive: true });
  const values = {
    [`niho_develop_wasm-${config.engine.crateVersion}.js`]: "export default async function init() {}\nexport class Developer {}\n",
    [`niho_develop_wasm_bg-${config.engine.crateVersion}.wasm`]: Buffer.from([0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00]),
    [`niho_develop_wasm-${config.engine.crateVersion}.d.ts`]: "export default function init(input?: unknown): Promise<unknown>;\n",
  };
  const manifest = {
    schemaVersion: 1,
    engine: config.engine.version,
    version: config.engine.crateVersion,
    source: { repository: "niho-coliving/niho-photo", ...source },
    build: { rustToolchain: "1.98.1", wasmBindgen: "0.2.129", target: "wasm32-unknown-unknown", profile: "release" },
    files: Object.fromEntries(Object.entries(values).map(([name, value]) => {
      const bytes = Buffer.isBuffer(value) ? value : Buffer.from(value);
      return [name, { sha256: sha256(bytes), bytes: bytes.length }];
    })),
  };
  put(directory, config.engine.manifestName, `${JSON.stringify(manifest, null, 2)}\n`);
  for (const [name, value] of Object.entries(values)) put(directory, name, value);
  return directory;
}

function createFixture() {
  const root = temp("niho-photo-sdk-repo-");
  const config = JSON.parse(readFileSync(path.join(realRoot, "sdk/release-set.json"), "utf8"));
  runGit(root, ["init", "--quiet"]);
  for (const name of ["LICENSE.md", "ASSET_LICENSE.md", "TRADEMARKS.md", "THIRD_PARTY_NOTICES.md"]) put(root, name, readFileSync(path.join(realRoot, name)));
  put(root, "sdk/release-set.json", `${JSON.stringify(config, null, 2)}\n`);
  for (const definition of config.packages) {
    const names = runGit(realRoot, ["ls-files", "--", definition.sourceRoot]).trim().split("\n").filter(Boolean);
    for (const name of names) {
      const relative = name.slice(definition.sourceRoot.length + 1);
      if (matchesPackagePath(relative, definition)) put(root, name, readFileSync(path.join(realRoot, name)));
    }
  }
  commit(root, "fixture");
  const source = { commit: runGit(root, ["rev-parse", "HEAD"]).trim(), tree: runGit(root, ["rev-parse", "HEAD^{tree}"]).trim() };
  const assets = runtimeFixture(temp("niho-photo-sdk-runtime-"), { engine: { ...config.engine, assetDirectory: "assets" } }, source);
  return { root, config, assets, source };
}

test("strict semver と安全な相対 path だけを受け入れる", () => {
  assert.equal(assertStrictSemver("1.2.3-beta.1+build.5"), "1.2.3-beta.1+build.5");
  assert.equal(assertStrictSemver("1.2.3+001"), "1.2.3+001");
  for (const value of ["v1.2.3", "1.2", "01.2.3", "1.2.3-01"]) assert.throws(() => assertStrictSemver(value));
  assert.equal(assertRelativePath("packages/photo-editing"), "packages/photo-editing");
  for (const value of ["../private", "/tmp/source", "a/../../b", "a\\b"]) assert.throws(() => assertRelativePath(value));
});

test("wasm-bindgen の出力名と JS/d.ts 内部参照を同じ crate version へ固定する", () => {
  assert.equal(versionedRuntimeFileName("niho_develop_wasm_bg.wasm", "0.25.0"), "niho_develop_wasm_bg-0.25.0.wasm");
  assert.equal(versionedRuntimeFileName("niho_develop_wasm.js", "0.25.0"), "niho_develop_wasm-0.25.0.js");
  const source = Buffer.from('new URL("niho_develop_wasm_bg.wasm", import.meta.url); import("./niho_develop_wasm.js");\n');
  const rewritten = rewriteVersionedRuntimeReferences("niho_develop_wasm.js", source, "0.25.0").toString("utf8");
  assert.match(rewritten, /niho_develop_wasm_bg-0\.25\.0\.wasm/);
  assert.match(rewritten, /niho_develop_wasm-0\.25\.0\.js/);
  assert.doesNotMatch(rewritten, /niho_develop_wasm_bg\.wasm/);
  assert.equal(rewriteVersionedRuntimeReferences("niho_develop_wasm_bg.wasm", Buffer.from("bytes"), "0.25.0").toString(), "bytes");
});

test("engine runtime build は外部Cargo設定を捨てpathをremapする", () => {
  const env = runtimeBuildEnvironment({
    PATH: "/bin",
    HOME: "/synthetic/home",
    CARGO_HOME: "/synthetic/cargo",
    RUSTUP_HOME: "/synthetic/rustup",
    RUSTFLAGS: "unapproved",
    CARGO_TARGET_DIR: "/unapproved/target",
  }, { home: "/isolated/home", temporary: "/isolated/tmp", target: "/isolated/target" });
  assert.equal(env.HOME, "/isolated/home");
  assert.equal(env.CARGO_TARGET_DIR, "/isolated/target");
  assert.equal(env.RUSTFLAGS, undefined);
  assert.match(env.CARGO_ENCODED_RUSTFLAGS, /target-feature=\+simd128/);
  for (const prefix of [realRoot, "/synthetic/home", "/synthetic/cargo", "/synthetic/rustup", "/isolated/tmp"]) assert.ok(env.CARGO_ENCODED_RUSTFLAGS.includes(`--remap-path-prefix=${prefix}=`));
  const defaults = runtimeBuildEnvironment({ PATH: "/bin", HOME: "/default/home" }, { home: "/isolated/home", temporary: "/isolated/tmp", target: "/isolated/target" });
  assert.equal(defaults.CARGO_HOME, "/default/home/.cargo");
  assert.equal(defaults.RUSTUP_HOME, "/default/home/.rustup");
  assert.ok(defaults.CARGO_ENCODED_RUSTFLAGS.includes("--remap-path-prefix=/default/home/.rustup=toolchain"));
  assert.throws(() => runtimeBuildEnvironment({ HOME: "/default/home", CARGO_HOME: "relative" }, { home: "/isolated/home", temporary: "/isolated/tmp", target: "/isolated/target" }), /絶対path/);
});

test("release-set 定義は package/path/version の改変を拒否する", () => {
  const config = JSON.parse(readFileSync(path.join(realRoot, "sdk/release-set.json"), "utf8"));
  assert.equal(validateConfig(config), config);
  assert.throws(() => validateConfig({ ...config, version: "latest" }), /semver/);
  const escaped = structuredClone(config);
  escaped.packages[0].sourceRoot = "../niho-app";
  assert.throws(() => validateConfig(escaped), /相対path/);
});

test("TypeScript dependency closure の欠落を拒否する", () => {
  const stage = temp("niho-photo-sdk-closure-");
  put(stage, "src/index.ts", 'import "./missing";\n');
  assert.throws(() => auditTypeScriptClosure(stage, { peerDependencies: {}, exports: { ".": "./src/index.ts" } }), /dependency closure/);
});

test("engine runtime の欠落・tamper・symlink を拒否する", () => {
  const root = temp("niho-photo-sdk-assets-");
  const config = JSON.parse(readFileSync(path.join(realRoot, "sdk/release-set.json"), "utf8"));
  const assets = runtimeFixture(root, { engine: { ...config.engine, assetDirectory: "assets" } });
  const expectedSource = { commit: "a".repeat(40), tree: "b".repeat(40) };
  const valid = validateRuntimeAssets({ assetDirectory: assets, engine: config.engine, expectedSource });
  assert.equal(valid.files.length, 3);
  assert.throws(() => validateRuntimeAssets({ assetDirectory: assets, engine: config.engine, expectedSource: { ...expectedSource, commit: "c".repeat(40) } }), /provenance/);
  const wasm = valid.files.find((file) => file.name.endsWith(".wasm"));
  writeFileSync(path.join(assets, wasm.name), "tampered");
  assert.throws(() => validateRuntimeAssets({ assetDirectory: assets, engine: config.engine, expectedSource }), /hash/);
  rmSync(path.join(assets, wasm.name));
  symlinkSync(path.join(assets, valid.files[0].name), path.join(assets, wasm.name));
  assert.throws(() => validateRuntimeAssets({ assetDirectory: assets, engine: config.engine, expectedSource }), /symlink/);
  assert.throws(() => validateRuntimeAssets({ assetDirectory: path.join(root, "missing"), engine: config.engine, expectedSource }), /ありません/);
});

test("clean Git object から決定的 tarball を作り repo 外 consumer で TS/Worker/CSS を bundle する", { timeout: 120_000 }, async () => {
  const fixture = createFixture();
  const first = path.join(temp("niho-photo-sdk-output-a-"), "release");
  const second = path.join(temp("niho-photo-sdk-output-b-"), "release");
  const one = await packReleaseSet({ repoRoot: fixture.root, outputDirectory: first, assetDirectory: fixture.assets });
  const two = await packReleaseSet({ repoRoot: fixture.root, outputDirectory: second, assetDirectory: fixture.assets });
  assert.deepEqual(one.manifest.packages, two.manifest.packages);
  assert.equal(one.manifest.releaseReady, true);
  assert.deepEqual(one.manifest.recipeCompatibility.supportedVersions, [1, 2, 3, 4, 5, 6, 7, 8, 9]);
  assert.ok(one.manifest.recipeCompatibility.engineIdentifiers.includes("niho-13"));
  assert.equal(one.manifest.recipeCompatibility.nodeRuntimeValidator, false);
  assert.equal(one.manifest.uiSingleton.hostExport, "niho-photo-editing/sdk-dialog-host");
  for (const item of one.manifest.packages) {
    const entries = execFileSync("tar", ["-tzf", path.join(first, item.file)], { encoding: "utf8" });
    for (const name of ["LICENSE.md", "ASSET_LICENSE.md", "TRADEMARKS.md", "THIRD_PARTY_NOTICES.md"]) assert.match(entries, new RegExp(`package/${name}`));
    if (["develop-engine-source", "develop-engine-runtime"].includes(item.id)) {
      assert.match(entries, /LICENSES\.md/);
      assert.match(entries, /Adobe-DNG-SDK-LICENSE\.txt/);
    }
  }
  const manifestPath = path.join(first, one.manifestName);
  assert.deepEqual(verifyReleaseManifestFiles(manifestPath).packages, one.manifest.packages);
  for (const [name, mutate] of [
    ["empty-packages", (value) => { value.packages = []; }],
    ["wrong-repository", (value) => { value.repository = "other/repository"; }],
    ["short-tree", (value) => { value.source.tree = "abc"; }],
    ["duplicate-package", (value) => { value.packages[1] = { ...value.packages[0] }; }],
    ["bad-integrity", (value) => { value.packages[0].integrity = "sha256-invalid"; }],
    ["missing-recipe", (value) => { delete value.recipeCompatibility; }],
    ["missing-ui-singleton", (value) => { delete value.uiSingleton; }],
  ]) {
    const changed = structuredClone(one.manifest);
    mutate(changed);
    const changedPath = path.join(first, `${name}.json`);
    writeFileSync(changedPath, `${JSON.stringify(changed)}\n`);
    assert.throws(() => verifyReleaseManifestFiles(changedPath));
  }
  const linkedManifest = path.join(temp("niho-photo-sdk-manifest-link-"), "release.json");
  symlinkSync(manifestPath, linkedManifest);
  assert.throws(() => verifyReleaseManifestFiles(linkedManifest), /通常ファイル/);
  const linkedPackages = temp("niho-photo-sdk-package-links-");
  writeFileSync(path.join(linkedPackages, "release.json"), `${JSON.stringify(one.manifest)}\n`);
  for (const item of one.manifest.packages) symlinkSync(path.join(first, item.file), path.join(linkedPackages, item.file));
  assert.throws(() => verifyReleaseManifestFiles(path.join(linkedPackages, "release.json")), /通常ファイル/);
  const smoke = smokeConsumer(manifestPath);
  assert.ok(smoke.files.some((file) => file.endsWith(".css")));
  assert.ok(smoke.files.filter((file) => file.endsWith(".js")).length >= 2);
  await assert.rejects(packReleaseSet({ repoRoot: fixture.root, outputDirectory: first, assetDirectory: fixture.assets }), /上書き/);
  await assert.rejects(packReleaseSet({ repoRoot: fixture.root, outputDirectory: path.join(temp("niho-photo-sdk-option-"), "release"), assetDirectory: fixture.assets, sourceRef: "--help" }), /HEAD または full commit SHA/);

  const link = path.join(fixture.root, "packages/photo-editing/src/escape.ts");
  symlinkSync("../../../../LICENSE.md", link);
  commit(fixture.root, "tracked symlink");
  const linkedSource = { commit: runGit(fixture.root, ["rev-parse", "HEAD"]).trim(), tree: runGit(fixture.root, ["rev-parse", "HEAD^{tree}"]).trim() };
  rmSync(fixture.assets, { recursive: true, force: true });
  const linkedAssets = runtimeFixture(path.dirname(fixture.assets), { engine: { ...fixture.config.engine, assetDirectory: path.basename(fixture.assets) } }, linkedSource);
  await assert.rejects(packReleaseSet({ repoRoot: fixture.root, outputDirectory: path.join(temp("niho-photo-sdk-symlink-"), "release"), assetDirectory: linkedAssets }), /symlink/);

  writeFileSync(path.join(fixture.root, "untracked.txt"), "dirty");
  await assert.rejects(packReleaseSet({ repoRoot: fixture.root, outputDirectory: path.join(temp("niho-photo-sdk-dirty-"), "release"), assetDirectory: linkedAssets }), /clean working tree/);
});
