import { createHash } from "node:crypto";
import {
  constants as fsConstants,
  copyFileSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import ts from "typescript";

import { assertPublicBytes, guardBundle } from "../ci/release-evidence-lib.mjs";

const SEMVER = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?(?:\+([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?$/;
const PACKAGE_NAME = /^(?:@[a-z0-9][a-z0-9._-]*\/[a-z0-9][a-z0-9._-]*|[a-z0-9][a-z0-9._-]*)$/;
const SHA256 = /^[a-f0-9]{64}$/;
const SIMPLE_ASSET = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
const ROOT_NOTICE_FILES = ["LICENSE.md", "ASSET_LICENSE.md", "TRADEMARKS.md", "THIRD_PARTY_NOTICES.md"];
const ENGINE_NOTICE_FILES = ["LICENSES.md", "licenses/Adobe-DNG-SDK-LICENSE.txt"];

export class SdkReleaseError extends Error {}

export function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

export function sri(bytes) {
  return `sha256-${createHash("sha256").update(bytes).digest("base64")}`;
}

function jsonBytes(value) {
  return Buffer.from(`${JSON.stringify(value, null, 2)}\n`);
}

export function assertRelativePath(value, label = "path") {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.includes("\\") ||
    value.includes("\0") ||
    value.startsWith("/") ||
    value.split("/").some((part) => part === "" || part === "." || part === "..")
  ) {
    throw new SdkReleaseError(`${label} が安全な相対pathではありません`);
  }
  return value;
}

export function assertStrictSemver(value) {
  const match = typeof value === "string" ? SEMVER.exec(value) : null;
  if (!match) throw new SdkReleaseError("SDK version は strict semver が必要です");
  for (const part of match[4]?.split(".") ?? []) {
    if (/^\d+$/.test(part) && part.length > 1 && part.startsWith("0")) throw new SdkReleaseError("SDK version の数値識別子に先頭 0 は使えません");
  }
  return value;
}

function globRegex(pattern) {
  assertRelativePath(pattern.replaceAll("*", "x"), "glob");
  let result = "^";
  for (let index = 0; index < pattern.length; index += 1) {
    const char = pattern[index];
    if (char === "*") {
      if (pattern[index + 1] === "*") {
        index += 1;
        if (pattern[index + 1] === "/") {
          index += 1;
          result += "(?:.*/)?";
        } else {
          result += ".*";
        }
      } else {
        result += "[^/]*";
      }
    } else {
      result += /[.+?^${}()|[\]\\]/.test(char) ? `\\${char}` : char;
    }
  }
  return new RegExp(`${result}$`);
}

export function matchesPackagePath(relative, definition) {
  assertRelativePath(relative, "source file");
  return definition.include.some((pattern) => globRegex(pattern).test(relative)) && !definition.exclude.some((pattern) => globRegex(pattern).test(relative));
}

export function validateConfig(config) {
  if (!config || config.schemaVersion !== 1 || config.repository !== "niho-coliving/niho-photo") throw new SdkReleaseError("release-set の基本契約が不正です");
  assertStrictSemver(config.version);
  if (!Array.isArray(config.packages) || config.packages.length !== 4) throw new SdkReleaseError("release-set は UI/editor/cloud contract/engine source の 4 package が必要です");
  const ids = new Set();
  const names = new Set();
  for (const definition of config.packages) {
    if (!definition || !["typescript", "rust-source"].includes(definition.kind) || !/^[a-z][a-z0-9-]*$/.test(definition.id ?? "") || !PACKAGE_NAME.test(definition.name ?? "")) throw new SdkReleaseError("package 定義が不正です");
    if (ids.has(definition.id) || names.has(definition.name)) throw new SdkReleaseError("package id/name が重複しています");
    ids.add(definition.id);
    names.add(definition.name);
    assertRelativePath(definition.sourceRoot, "sourceRoot");
    if (!Array.isArray(definition.include) || !definition.include.length || !Array.isArray(definition.exclude)) throw new SdkReleaseError("package include/exclude が不正です");
    for (const pattern of [...definition.include, ...definition.exclude]) globRegex(pattern);
    for (const [from, to] of Object.entries(definition.rewritePackageImports ?? {})) {
      if (!PACKAGE_NAME.test(from) || !PACKAGE_NAME.test(to) || from === to) throw new SdkReleaseError("package import rewrite が不正です");
    }
    for (const [from, to] of Object.entries(definition.rewriteSpecifiers ?? {})) {
      const dependency = to.startsWith("@") ? to.split("/").slice(0, 2).join("/") : to.split("/")[0];
      if (typeof from !== "string" || !from || from.includes("\\") || from.includes("\0") || !PACKAGE_NAME.test(dependency)) throw new SdkReleaseError("module specifier rewrite が不正です");
    }
  }
  if (!ids.has("ui") || !ids.has("photo-editing") || !ids.has("cloud-contract") || !ids.has("develop-engine-source")) throw new SdkReleaseError("必須 package がありません");
  const engineSource = config.packages.find(({ id }) => id === "develop-engine-source");
  if (!ENGINE_NOTICE_FILES.every((file) => engineSource.include.some((pattern) => globRegex(pattern).test(file)))) throw new SdkReleaseError("engine source の license/notice closure が不足しています");
  const engine = config.engine;
  if (!engine || !/^niho-[1-9]\d*$/.test(engine.version ?? "") || !SEMVER.test(engine.crateVersion ?? "") || !PACKAGE_NAME.test(engine.runtimePackageName ?? "")) throw new SdkReleaseError("engine pin が不正です");
  assertRelativePath(engine.assetDirectory, "engine assetDirectory");
  if (engine.manifestName !== `manifest-${engine.crateVersion}.json`) throw new SdkReleaseError("engine manifest 名と crate version が一致しません");
  for (const item of [...engine.contractPaths, ...engine.buildInputs]) assertRelativePath(item, "engine input");
  if (!Array.isArray(engine.requiredExtensions) || ![".js", ".wasm", ".d.ts"].every((extension) => engine.requiredExtensions.includes(extension))) throw new SdkReleaseError("engine runtime の必須拡張子がありません");
  return config;
}

function git(repoRoot, args, options = {}) {
  try {
    return execFileSync("git", ["-C", repoRoot, ...args], { maxBuffer: 128 * 1024 * 1024, ...options });
  } catch {
    throw new SdkReleaseError("Git object の読み取りに失敗しました");
  }
}

function resolveSource(repoRoot, sourceRef) {
  if (sourceRef !== "HEAD" && !/^[a-f0-9]{40}$/.test(sourceRef ?? "")) throw new SdkReleaseError("source は HEAD または full commit SHA が必要です");
  const commit = git(repoRoot, ["rev-parse", "--verify", "--end-of-options", `${sourceRef}^{commit}`], { encoding: "utf8" }).trim();
  const tree = git(repoRoot, ["rev-parse", "--verify", `${commit}^{tree}`], { encoding: "utf8" }).trim();
  if (!/^[a-f0-9]{40}$/.test(commit) || !/^[a-f0-9]{40}$/.test(tree)) throw new SdkReleaseError("full source SHA を解決できません");
  const dirty = git(repoRoot, ["status", "--porcelain=v1", "--untracked-files=all"], { encoding: "utf8" });
  if (dirty.length !== 0) throw new SdkReleaseError("release pack は clean working tree からだけ生成できます");
  return { commit, tree };
}

function treeEntries(repoRoot, commit, sourceRoot) {
  const output = git(repoRoot, ["ls-tree", "-rz", "--full-tree", commit, "--", sourceRoot]);
  if (!output.length) throw new SdkReleaseError(`tracked source がありません: ${sourceRoot}`);
  return output
    .toString("utf8")
    .split("\0")
    .filter(Boolean)
    .map((record) => {
      const match = /^(\d+) (\w+) ([a-f0-9]{40})\t(.+)$/.exec(record);
      if (!match) throw new SdkReleaseError("git tree entry が不正です");
      const [, mode, type, object, file] = match;
      assertRelativePath(file, "tracked source");
      if (mode === "120000") throw new SdkReleaseError(`symlink は SDK source に含められません: ${file}`);
      if (mode !== "100644" && mode !== "100755") throw new SdkReleaseError(`通常ファイル以外は SDK source に含められません: ${file}`);
      if (type !== "blob") throw new SdkReleaseError(`blob 以外は SDK source に含められません: ${file}`);
      return { mode, object, file };
    });
}

function gitBytes(repoRoot, commit, file) {
  assertRelativePath(file, "git object path");
  return git(repoRoot, ["show", `${commit}:${file}`]);
}

function safeDestination(root, relative) {
  assertRelativePath(relative, "staging path");
  const target = path.resolve(root, ...relative.split("/"));
  if (!target.startsWith(`${path.resolve(root)}${path.sep}`)) throw new SdkReleaseError("staging path が package 外を指しています");
  return target;
}

function put(root, relative, bytes) {
  const target = safeDestination(root, relative);
  mkdirSync(path.dirname(target), { recursive: true, mode: 0o755 });
  writeFileSync(target, bytes, { mode: 0o644, flag: "wx" });
}

function rewriteImports(bytes, rewrites, specifierRewrites, file) {
  if ((!Object.keys(rewrites).length && !Object.keys(specifierRewrites).length) || !/\.(?:[cm]?[jt]sx?)$/.test(file)) return bytes;
  let text = bytes.toString("utf8");
  for (const [from, to] of Object.entries(rewrites)) {
    const escaped = from.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    text = text.replace(new RegExp(`(["'])${escaped}(?=\\/|["'])`, "g"), `$1${to}`);
  }
  for (const [from, to] of Object.entries(specifierRewrites)) {
    const escaped = from.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    text = text.replace(new RegExp(`(["'])${escaped}\\1`, "g"), `$1${to}$1`);
  }
  return Buffer.from(text);
}

function packageManifest(definition, original, config) {
  const rootNotices = ROOT_NOTICE_FILES;
  if (definition.kind === "rust-source") {
    return {
      name: definition.name,
      version: config.version,
      description: "NIHO photo develop engine source pinned to an SDK release set",
      license: "UNLICENSED",
      files: ["engine", "release-inputs.json", ...rootNotices],
      engines: { node: "24.x" },
    };
  }
  const manifest = structuredClone(original);
  delete manifest.private;
  delete manifest.scripts;
  delete manifest.devDependencies;
  manifest.name = definition.name;
  manifest.version = config.version;
  manifest.license = "UNLICENSED";
  manifest.files = ["src", ...rootNotices, ...(definition.id === "ui" ? ["tailwind-theme.cjs"] : []), ...(definition.id === "cloud-contract" ? ["README.md"] : [])];
  if (definition.id === "ui") manifest.sideEffects = ["./src/styles/*.css"];
  if (definition.id === "photo-editing") {
    const peers = { ...(manifest.peerDependencies ?? {}) };
    delete peers["niho-ui"];
    peers["niho-photo-ui"] = config.version;
    peers["niho-photo-cloud-contract"] = config.version;
    manifest.peerDependencies = Object.fromEntries(Object.entries(peers).sort(([a], [b]) => a.localeCompare(b, "en")));
    manifest.exports = {
      ...(manifest.exports ?? {}),
      "./develop-engine/*": "./src/develop-engine/*.ts",
      "./editor/*": "./src/editor/*.tsx",
      "./library/*": "./src/library/*.ts",
      "./sdk-dialog-host": "./src/sdk-dialog-host.tsx",
    };
  }
  return manifest;
}

function resolveRelativeImport(files, fromFile, specifier) {
  const base = path.posix.normalize(path.posix.join(path.posix.dirname(fromFile), specifier));
  if (base.startsWith("../") || base === "..") return null;
  const withoutJs = base.replace(/\.(?:m?js)$/, "");
  const candidates = [base, `${base}.ts`, `${base}.tsx`, `${base}.js`, `${base}.mjs`, `${base}.json`, `${base}.css`, `${withoutJs}.ts`, `${withoutJs}.tsx`, `${base}/index.ts`, `${base}/index.tsx`];
  return candidates.find((candidate) => files.has(candidate)) ?? null;
}

export function auditTypeScriptClosure(stage, manifest) {
  const files = new Set();
  function visit(directory, prefix = "") {
    for (const name of readdirSync(directory).sort()) {
      const full = path.join(directory, name);
      const relative = prefix ? `${prefix}/${name}` : name;
      const stat = lstatSync(full);
      if (stat.isDirectory()) visit(full, relative);
      else files.add(relative);
    }
  }
  visit(stage);
  const peers = new Set(Object.keys(manifest.peerDependencies ?? {}));
  for (const file of [...files].filter((name) => /\.(?:[cm]?[jt]sx?)$/.test(name))) {
    const text = readFileSync(path.join(stage, file), "utf8");
    const specifiers = [
      ...ts.preProcessFile(text, true, true).importedFiles.map(({ fileName }) => fileName),
      ...[...text.matchAll(/new\s+URL\(\s*["']([^"']+)["']\s*,\s*import\.meta\.url\s*\)/g)].map((match) => match[1]),
    ];
    for (const specifier of specifiers) {
      if (specifier.startsWith(".")) {
        if (!resolveRelativeImport(files, file, specifier)) throw new SdkReleaseError(`dependency closure に欠落があります: ${file}`);
        continue;
      }
      const dependency = specifier.startsWith("@") ? specifier.split("/").slice(0, 2).join("/") : specifier.split("/")[0];
      if (["next", "@tauri-apps", "niho-ui"].some((forbidden) => dependency === forbidden || dependency.startsWith(`${forbidden}/`))) throw new SdkReleaseError(`SDK host 境界外の import があります: ${dependency}`);
      if (!dependency.startsWith("node:") && !peers.has(dependency)) throw new SdkReleaseError(`runtime dependency が peerDependencies にありません: ${dependency}`);
    }
  }
  for (const target of Object.values(manifest.exports ?? {})) {
    if (typeof target !== "string" || !target.startsWith("./")) continue;
    if (target.includes("*")) {
      const expression = globRegex(target.slice(2));
      if (![...files].some((file) => expression.test(file))) throw new SdkReleaseError(`export に対応する source がありません: ${target}`);
    } else if (!files.has(target.slice(2))) {
      throw new SdkReleaseError(`export source がありません: ${target}`);
    }
  }
}

function stageSourcePackage({ repoRoot, commit, config, definition, stage, rootNotices }) {
  const entries = treeEntries(repoRoot, commit, definition.sourceRoot);
  const selected = entries.filter(({ file }) => matchesPackagePath(file.slice(definition.sourceRoot.length + 1), definition));
  if (!selected.length) throw new SdkReleaseError(`package source が空です: ${definition.id}`);
  let originalManifest = {};
  for (const entry of selected) {
    const relative = entry.file.slice(definition.sourceRoot.length + 1);
    const bytes = gitBytes(repoRoot, commit, entry.file);
    if (relative === "package.json") {
      originalManifest = JSON.parse(bytes.toString("utf8"));
      continue;
    }
    const output = definition.kind === "rust-source" ? `engine/${relative}` : relative;
    put(stage, output, rewriteImports(bytes, definition.rewritePackageImports ?? {}, definition.rewriteSpecifiers ?? {}, relative));
  }
  const manifest = packageManifest(definition, originalManifest, config);
  if (definition.id === "photo-editing") {
    put(
      stage,
      "src/sdk-dialog-host.tsx",
      Buffer.from('export { AppDialogHost as PhotoEditingDialogHost } from "niho-photo-ui/components/app-dialog-host";\n'),
    );
  }
  put(stage, "package.json", jsonBytes(manifest));
  for (const [name, bytes] of Object.entries(rootNotices)) put(stage, name, bytes);
  if (definition.kind === "rust-source") {
    put(stage, "release-inputs.json", jsonBytes({
      schemaVersion: 1,
      engine: config.engine.version,
      crateVersion: config.engine.crateVersion,
      sourceRoot: definition.sourceRoot,
      buildInputs: config.engine.buildInputs,
      command: "cargo build --locked --manifest-path engine/Cargo.toml --target wasm32-unknown-unknown --release -p niho-develop-wasm",
    }));
  } else {
    auditTypeScriptClosure(stage, manifest);
  }
  return manifest;
}

export function validateRuntimeAssets({ assetDirectory, engine, expectedSource }) {
  if (!path.isAbsolute(assetDirectory)) throw new SdkReleaseError("engine asset 入力は絶対 path で指定してください");
  let directoryStat;
  try {
    directoryStat = lstatSync(assetDirectory);
  } catch {
    throw new SdkReleaseError(`engine runtime asset がありません: ${engine.manifestName}`);
  }
  if (!directoryStat.isDirectory() || directoryStat.isSymbolicLink()) throw new SdkReleaseError("engine asset directory は通常の directory が必要です");
  const manifestPath = path.join(assetDirectory, engine.manifestName);
  let manifestBytes;
  try {
    const stat = lstatSync(manifestPath);
    if (!stat.isFile() || stat.isSymbolicLink()) throw new Error();
    manifestBytes = readFileSync(manifestPath);
  } catch {
    throw new SdkReleaseError(`engine runtime manifest がありません: ${engine.manifestName}`);
  }
  let manifest;
  try {
    manifest = JSON.parse(manifestBytes.toString("utf8"));
  } catch {
    throw new SdkReleaseError("engine runtime manifest が JSON ではありません");
  }
  if (manifest.engine !== engine.version || manifest.version !== engine.crateVersion || !manifest.files || typeof manifest.files !== "object" || Array.isArray(manifest.files)) throw new SdkReleaseError("engine runtime manifest の pin が release-set と一致しません");
  if (
    !expectedSource ||
    manifest.source?.repository !== "niho-coliving/niho-photo" ||
    manifest.source?.commit !== expectedSource.commit ||
    manifest.source?.tree !== expectedSource.tree ||
    manifest.build?.rustToolchain !== "1.98.1" ||
    manifest.build?.wasmBindgen !== "0.2.129" ||
    manifest.build?.target !== "wasm32-unknown-unknown" ||
    manifest.build?.profile !== "release"
  ) throw new SdkReleaseError("engine runtime の build provenance が selected source と一致しません");
  const names = Object.keys(manifest.files).sort();
  if (!names.length || !engine.requiredExtensions.every((extension) => names.some((name) => name.endsWith(extension)))) throw new SdkReleaseError("engine runtime dependency closure が不足しています");
  const files = [];
  for (const name of names) {
    if (!SIMPLE_ASSET.test(name) || name.includes("..")) throw new SdkReleaseError("engine runtime manifest に不正な path があります");
    const expected = manifest.files[name];
    if (!expected || !SHA256.test(expected.sha256 ?? "") || !Number.isSafeInteger(expected.bytes) || expected.bytes <= 0) throw new SdkReleaseError("engine runtime manifest の file metadata が不正です");
    const full = path.join(assetDirectory, name);
    let stat;
    try {
      stat = lstatSync(full);
    } catch {
      throw new SdkReleaseError(`engine runtime dependency がありません: ${name}`);
    }
    if (!stat.isFile() || stat.isSymbolicLink()) throw new SdkReleaseError("engine runtime の symlink / 特殊ファイルは禁止です");
    const bytes = readFileSync(full);
    if (bytes.length !== expected.bytes || sha256(bytes) !== expected.sha256) throw new SdkReleaseError(`engine runtime asset の hash が一致しません: ${name}`);
    assertPublicBytes(bytes);
    files.push({ name, bytes, sha256: expected.sha256, integrity: sri(bytes), size: bytes.length });
  }
  return { manifest, manifestBytes, files };
}

function stageRuntimePackage({ stage, config, runtime, rootNotices, engineNotices }) {
  const manifest = {
    name: config.engine.runtimePackageName,
    version: config.version,
    description: "NIHO photo develop engine immutable wasm runtime",
    license: "UNLICENSED",
    files: ["develop-engine", ...ROOT_NOTICE_FILES, ...ENGINE_NOTICE_FILES],
    exports: {
      "./manifest": `./develop-engine/${config.engine.version}/${config.engine.manifestName}`,
      "./*": `./develop-engine/${config.engine.version}/*`,
    },
    engines: { node: "24.x" },
  };
  put(stage, "package.json", jsonBytes(manifest));
  for (const [name, bytes] of Object.entries(rootNotices)) put(stage, name, bytes);
  for (const [name, bytes] of Object.entries(engineNotices)) put(stage, name, bytes);
  const prefix = `develop-engine/${config.engine.version}`;
  put(stage, `${prefix}/${config.engine.manifestName}`, runtime.manifestBytes);
  for (const file of runtime.files) put(stage, `${prefix}/${file.name}`, file.bytes);
  return manifest;
}

function tarEntries(tarball) {
  let output;
  try {
    output = execFileSync("tar", ["-tzf", tarball], { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
  } catch {
    throw new SdkReleaseError("tarball を検査できません");
  }
  const entries = output.split("\n").filter(Boolean);
  if (!entries.length) throw new SdkReleaseError("空の tarball は許可されません");
  for (const entry of entries) {
    if (!entry.startsWith("package/") || entry.startsWith("/") || entry.includes("\\") || entry.split("/").some((part) => part === "..")) throw new SdkReleaseError("tarball に path traversal があります");
  }
  return entries;
}

function npmPackDeterministic(stage, scratch) {
  const destinations = [mkdtempSync(path.join(scratch, "pack-a-")), mkdtempSync(path.join(scratch, "pack-b-"))];
  const outputs = [];
  for (const destination of destinations) {
    let result;
    try {
      result = JSON.parse(execFileSync("npm", ["pack", "--json", "--ignore-scripts", "--offline", "--pack-destination", destination, "."], {
        cwd: stage,
        encoding: "utf8",
        env: { ...process.env, TZ: "UTC", SOURCE_DATE_EPOCH: "0", npm_config_update_notifier: "false" },
        maxBuffer: 64 * 1024 * 1024,
      }));
    } catch {
      throw new SdkReleaseError("npm pack に失敗しました");
    }
    if (!Array.isArray(result) || result.length !== 1 || !SIMPLE_ASSET.test(result[0].filename ?? "")) throw new SdkReleaseError("npm pack の出力が不正です");
    const tarball = path.join(destination, result[0].filename);
    tarEntries(tarball);
    outputs.push(tarball);
  }
  const first = readFileSync(outputs[0]);
  const second = readFileSync(outputs[1]);
  if (!first.equals(second)) throw new SdkReleaseError("npm package tarball が決定的ではありません");
  return { filename: path.basename(outputs[0]), bytes: first, entries: tarEntries(outputs[0]) };
}

function sourceRecords(repoRoot, commit, paths) {
  return paths.map((file) => {
    const bytes = gitBytes(repoRoot, commit, file);
    return { path: file, sha256: sha256(bytes), integrity: sri(bytes), size: bytes.length };
  });
}

function verifyEnginePins(repoRoot, commit, config) {
  const client = gitBytes(repoRoot, commit, "packages/photo-editing/src/develop-engine/develop-engine-manifest.ts").toString("utf8");
  const engineVersion = /export const DEVELOP_ENGINE_VERSION = "([^"]+)";/.exec(client)?.[1];
  const crateVersion = /export const DEVELOP_ENGINE_CRATE_VERSION = "([^"]+)";/.exec(client)?.[1];
  const cargo = gitBytes(repoRoot, commit, "packages/develop-engine/Cargo.toml").toString("utf8");
  const workspaceVersion = /\[workspace\.package\][\s\S]*?^version = "([^"]+)"/m.exec(cargo)?.[1];
  if (engineVersion !== config.engine.version || crateVersion !== config.engine.crateVersion || workspaceVersion !== config.engine.crateVersion) throw new SdkReleaseError("editor / engine source / release-set の version pin が一致しません");
}

function recipeCompatibility(repoRoot, commit) {
  const source = gitBytes(repoRoot, commit, "packages/photo-editing/src/develop-engine/develop-settings.ts").toString("utf8");
  const versionsText = /export type DevelopSettingsVersion = ([^;]+);/.exec(source)?.[1];
  const versions = [...new Set((versionsText?.match(/\b\d+\b/g) ?? []).map(Number))].sort((a, b) => a - b);
  const engines = [...source.matchAll(/export const [A-Z0-9_]*DEVELOP_SETTINGS_ENGINE = "(niho-\d+)";/g)]
    .map((match) => match[1])
    .filter((value, index, values) => values.indexOf(value) === index)
    .sort((a, b) => Number(a.slice(5)) - Number(b.slice(5)));
  if (JSON.stringify(versions) !== JSON.stringify([1, 2, 3, 4, 5, 6, 7, 8, 9]) || !engines.includes("niho-13")) throw new SdkReleaseError("recipe compatibility を source から確定できません");
  return {
    format: "typescript-source",
    supportedVersions: versions,
    engineIdentifiers: engines,
    nodeRuntimeValidator: false,
    limitation: "A plain Node.js API requires a generated JavaScript and declaration contract package in a later release slice.",
  };
}

export async function packReleaseSet({ repoRoot, configPath = "sdk/release-set.json", outputDirectory, sourceRef = "HEAD", assetDirectory } = {}) {
  if (!repoRoot || !path.isAbsolute(repoRoot)) throw new SdkReleaseError("repoRoot は絶対 path が必要です");
  assertRelativePath(configPath, "config path");
  if (!outputDirectory || !path.isAbsolute(outputDirectory)) throw new SdkReleaseError("output は絶対 path が必要です");
  try {
    lstatSync(outputDirectory);
    throw new SdkReleaseError("既存の SDK output は上書きできません");
  } catch (error) {
    if (error instanceof SdkReleaseError) throw error;
    if (error?.code !== "ENOENT") throw new SdkReleaseError("SDK output を確認できません");
  }
  const { commit, tree } = resolveSource(repoRoot, sourceRef);
  const config = validateConfig(JSON.parse(gitBytes(repoRoot, commit, configPath).toString("utf8")));
  verifyEnginePins(repoRoot, commit, config);
  const assets = path.resolve(assetDirectory ?? path.join(repoRoot, config.engine.assetDirectory));
  const runtime = validateRuntimeAssets({ assetDirectory: assets, engine: config.engine, expectedSource: { commit, tree } });
  const rootNotices = Object.fromEntries(ROOT_NOTICE_FILES.map((name) => [name, gitBytes(repoRoot, commit, name)]));
  const engineNotices = Object.fromEntries(ENGINE_NOTICE_FILES.map((name) => [name, gitBytes(repoRoot, commit, `packages/develop-engine/${name}`)]));
  const scratch = mkdtempSync(path.join(tmpdir(), "niho-photo-sdk-pack-"));
  try {
    const packages = [];
    for (const definition of config.packages) {
      const stage = path.join(scratch, `stage-${definition.id}`);
      mkdirSync(stage, { mode: 0o755 });
      stageSourcePackage({ repoRoot, commit, config, definition, stage, rootNotices });
      await guardBundle(stage, [repoRoot]);
      const packed = npmPackDeterministic(stage, scratch);
      packages.push({ id: definition.id, name: definition.name, ...packed });
    }
    const runtimeStage = path.join(scratch, "stage-develop-engine-runtime");
    mkdirSync(runtimeStage, { mode: 0o755 });
    stageRuntimePackage({ stage: runtimeStage, config, runtime, rootNotices, engineNotices });
    await guardBundle(runtimeStage, [repoRoot]);
    const packedRuntime = npmPackDeterministic(runtimeStage, scratch);
    packages.push({ id: "develop-engine-runtime", name: config.engine.runtimePackageName, ...packedRuntime });

    const manifestName = `niho-photo-sdk-${config.version}-${commit}.json`;
    const manifest = {
      schemaVersion: 1,
      releaseReady: true,
      repository: config.repository,
      version: config.version,
      source: { commit, tree },
      packages: packages.map(({ id, name, filename, bytes }) => ({ id, name, file: filename, sha256: sha256(bytes), integrity: sri(bytes), size: bytes.length })),
      engine: {
        version: config.engine.version,
        crateVersion: config.engine.crateVersion,
        manifest: {
          file: config.engine.manifestName,
          sha256: sha256(runtime.manifestBytes),
          integrity: sri(runtime.manifestBytes),
          size: runtime.manifestBytes.length,
        },
        runtimeFiles: runtime.files.map(({ name, sha256: hash, integrity, size }) => ({ name, sha256: hash, integrity, size })),
        contracts: sourceRecords(repoRoot, commit, config.engine.contractPaths),
        buildInputs: sourceRecords(repoRoot, commit, config.engine.buildInputs),
      },
      recipeCompatibility: recipeCompatibility(repoRoot, commit),
      uiSingleton: {
        package: "niho-photo-ui",
        hostExport: "niho-photo-editing/sdk-dialog-host",
        requirement: "Render PhotoEditingDialogHost from this export so editor dialogs and the host share one appDialog store instance.",
      },
    };
    const manifestBytes = jsonBytes(manifest);
    assertPublicBytes(manifestBytes);
    mkdirSync(outputDirectory, { recursive: true, mode: 0o755 });
    for (const item of packages) writeFileSync(path.join(outputDirectory, item.filename), item.bytes, { flag: "wx", mode: 0o644 });
    writeFileSync(path.join(outputDirectory, manifestName), manifestBytes, { flag: "wx", mode: 0o644 });
    return { manifest, manifestName, outputDirectory };
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}

export function verifyReleaseManifestFiles(manifestPath) {
  const manifestStat = lstatSync(manifestPath);
  if (!manifestStat.isFile() || manifestStat.isSymbolicLink()) throw new SdkReleaseError("SDK release manifest は通常ファイルが必要です");
  const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
  assertStrictSemver(manifest.version);
  if (
    manifest.schemaVersion !== 1 ||
    manifest.releaseReady !== true ||
    manifest.repository !== "niho-coliving/niho-photo" ||
    !/^[a-f0-9]{40}$/.test(manifest.source?.commit ?? "") ||
    !/^[a-f0-9]{40}$/.test(manifest.source?.tree ?? "")
  ) throw new SdkReleaseError("SDK release manifest が不正です");
  const requiredPackages = new Map([
    ["ui", "niho-photo-ui"],
    ["photo-editing", "niho-photo-editing"],
    ["cloud-contract", "niho-photo-cloud-contract"],
    ["develop-engine-source", "niho-photo-develop-engine-source"],
    ["develop-engine-runtime", "niho-photo-develop-engine-runtime"],
  ]);
  if (!Array.isArray(manifest.packages) || manifest.packages.length !== requiredPackages.size) throw new SdkReleaseError("SDK package 集合が不正です");
  const ids = new Set();
  const names = new Set();
  const filenames = new Set();
  const directory = path.dirname(manifestPath);
  for (const item of manifest.packages) {
    if (
      requiredPackages.get(item.id) !== item.name ||
      ids.has(item.id) ||
      names.has(item.name) ||
      filenames.has(item.file) ||
      !SIMPLE_ASSET.test(item.file ?? "") ||
      !item.file.endsWith(".tgz") ||
      !SHA256.test(item.sha256 ?? "") ||
      item.integrity !== `sha256-${Buffer.from(item.sha256, "hex").toString("base64")}` ||
      !Number.isSafeInteger(item.size) ||
      item.size <= 0
    ) throw new SdkReleaseError("SDK package record が不正です");
    ids.add(item.id);
    names.add(item.name);
    filenames.add(item.file);
    const packagePath = path.join(directory, item.file);
    const packageStat = lstatSync(packagePath);
    if (!packageStat.isFile() || packageStat.isSymbolicLink()) throw new SdkReleaseError("SDK package は通常ファイルが必要です");
    const bytes = readFileSync(packagePath);
    if (bytes.length !== item.size || sha256(bytes) !== item.sha256 || sri(bytes) !== item.integrity) throw new SdkReleaseError(`SDK package hash が一致しません: ${item.name}`);
    tarEntries(packagePath);
  }
  if ([...requiredPackages.keys()].some((id) => !ids.has(id))) throw new SdkReleaseError("SDK package の必須集合が不足しています");
  const engine = manifest.engine;
  if (!engine || !/^niho-[1-9]\d*$/.test(engine.version ?? "")) throw new SdkReleaseError("SDK engine 契約が不正です");
  assertStrictSemver(engine.crateVersion);
  const recordsValid = (records, expectedPaths) => {
    if (!Array.isArray(records) || records.length !== expectedPaths.length) return false;
    const recordPaths = new Set();
    for (const record of records) {
      if (!expectedPaths.includes(record.path) || recordPaths.has(record.path) || !SHA256.test(record.sha256 ?? "") || record.integrity !== `sha256-${Buffer.from(record.sha256, "hex").toString("base64")}` || !Number.isSafeInteger(record.size) || record.size <= 0) return false;
      recordPaths.add(record.path);
    }
    return expectedPaths.every((item) => recordPaths.has(item));
  };
  const expectedContracts = [
    "packages/photo-editing/src/develop-engine/develop-engine-manifest.ts",
    "packages/photo-editing/src/develop-engine/develop-settings.ts",
    "packages/develop-engine/crates/niho-develop/src/settings.rs",
  ];
  const expectedBuildInputs = [
    "packages/develop-engine/Cargo.lock",
    "packages/develop-engine/Cargo.toml",
    "packages/develop-engine/rust-toolchain.toml",
    "packages/develop-engine/crates/niho-develop-wasm/Cargo.toml",
    "packages/develop-engine/crates/niho-develop-wasm/src/lib.rs",
  ];
  if (!recordsValid(engine.contracts, expectedContracts) || !recordsValid(engine.buildInputs, expectedBuildInputs)) throw new SdkReleaseError("SDK engine source pin が不正です");
  if (engine.manifest?.file !== `manifest-${engine.crateVersion}.json` || !SHA256.test(engine.manifest?.sha256 ?? "") || engine.manifest?.integrity !== `sha256-${Buffer.from(engine.manifest.sha256, "hex").toString("base64")}` || !Number.isSafeInteger(engine.manifest?.size) || engine.manifest.size <= 0) throw new SdkReleaseError("SDK engine manifest record が不正です");
  const runtimeFiles = engine.runtimeFiles;
  if (!Array.isArray(runtimeFiles) || ![".js", ".wasm", ".d.ts"].every((extension) => runtimeFiles.some((file) => file.name?.endsWith(extension)))) throw new SdkReleaseError("SDK engine runtime closure が不正です");
  const runtimeNames = new Set();
  for (const file of runtimeFiles) {
    if (!SIMPLE_ASSET.test(file.name ?? "") || runtimeNames.has(file.name) || !SHA256.test(file.sha256 ?? "") || file.integrity !== `sha256-${Buffer.from(file.sha256, "hex").toString("base64")}` || !Number.isSafeInteger(file.size) || file.size <= 0) throw new SdkReleaseError("SDK engine runtime record が不正です");
    runtimeNames.add(file.name);
  }
  const recipe = manifest.recipeCompatibility;
  if (recipe?.format !== "typescript-source" || JSON.stringify(recipe.supportedVersions) !== JSON.stringify([1, 2, 3, 4, 5, 6, 7, 8, 9]) || !Array.isArray(recipe.engineIdentifiers) || new Set(recipe.engineIdentifiers).size !== recipe.engineIdentifiers.length || !recipe.engineIdentifiers.includes(engine.version) || recipe.nodeRuntimeValidator !== false || typeof recipe.limitation !== "string" || recipe.limitation.length < 16) throw new SdkReleaseError("SDK recipe compatibility 契約が不正です");
  if (manifest.uiSingleton?.package !== "niho-photo-ui" || manifest.uiSingleton?.hostExport !== "niho-photo-editing/sdk-dialog-host" || typeof manifest.uiSingleton?.requirement !== "string" || manifest.uiSingleton.requirement.length < 16) throw new SdkReleaseError("SDK UI singleton 契約が不正です");
  return manifest;
}
