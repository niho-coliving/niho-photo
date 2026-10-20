#!/usr/bin/env node
// sidecar-lock.mjs — niho-camera-cutout を NIHO camera（apps/camera）に sidecar として同梱するための版と指紋（C4 #18392）。
//
// NIHO Desktop の apple-raw-linear と同じ形にする（apps/desktop/scripts/develop-sidecars-lock.mjs）:
//   版     ソースの Sources/NihoCameraCutoutCLI/Tool.swift の `static let version`。実行ファイルは `niho-camera-cutout version`
//          に `niho-camera-cutout X.Y.Z` の 1 行で答え、同梱する側は起動時と stage でこの行をソースの版と照合する。
//   指紋   下の SOURCE_PATHS のうち git が追跡している・無視されていないファイルの `<sha256>  <path>` を 1 行ずつ並べた
//          文字列の SHA-256（パスはリポジトリの root から。Desktop の lock の sources.fingerprint と同じ計算）。テスト・README・
//          この scripts/ は .app の中身を変えないので入れない。
// camera の lock（apps/camera の develop-sidecars.lock.json と同じ形式）は C3 #18391 / C5 #18393 が作り、エンジンの公開の PR
// （ops/runbooks/develop-engine-release.md）が進める。この script は lock を書かない。lock を作る側は `entry` の値を書くか、
// SOURCE_PATHS を自分の指紋に足し、stage で `check-binary` と同じ照合をする（import して使える）。
//
// 使い方:
//   node packages/develop-engine/tools/niho-camera-cutout/scripts/sidecar-lock.mjs version                 ソースの版
//   node packages/develop-engine/tools/niho-camera-cutout/scripts/sidecar-lock.mjs fingerprint [--verbose]  ソースの指紋（--verbose はファイルごと）
//   node packages/develop-engine/tools/niho-camera-cutout/scripts/sidecar-lock.mjs entry                   lock に書く値（JSON）
//   node packages/develop-engine/tools/niho-camera-cutout/scripts/sidecar-lock.mjs check-binary --binary .build/release/niho-camera-cutout
//     ビルドした実行ファイルが同梱する側と同じ環境（HOME と PATH だけ・cwd /）でソースの版を答え、macOS の外の dylib を読まないか
//   node packages/develop-engine/tools/niho-camera-cutout/scripts/sidecar-lock.mjs self-test
//
// 終了コード: 0 = 合っている / 1 = 合わない・壊れている / 2 = 使い方の誤り
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const DEFAULT_REPO_ROOT = path.resolve(SCRIPT_DIR, "../../../../..");

export const SIDECAR_NAME = "niho-camera-cutout";
export const TOOL_REL = "packages/develop-engine/tools/niho-camera-cutout";
const VERSION_SOURCE_REL = `${TOOL_REL}/Sources/NihoCameraCutoutCLI/Tool.swift`;
/** ソースの指紋に入れるもの（リポジトリの root からのパス。フォルダはその下の全部。無いパスは無視される）。 */
export const SOURCE_PATHS = [`${TOOL_REL}/Package.swift`, `${TOOL_REL}/Package.resolved`, `${TOOL_REL}/Sources`];
// sidecar に渡す環境変数（NIHO Desktop の sidecar と同じく HOME と PATH だけ）
const SIDECAR_ENV = () => ({ HOME: os.homedir(), PATH: "/usr/bin:/bin" });
// Mach-O（thin / fat）の先頭 4 バイト
const MACHO_MAGICS = new Set(["cffaedfe", "cefaedfe", "feedfacf", "feedface", "cafebabe", "bebafeca"]);

const EXIT = { ok: 0, mismatch: 1, usage: 2 };

class LockError extends Error {
  constructor(message, exitCode = EXIT.mismatch) {
    super(message);
    this.exitCode = exitCode;
  }
}

function parseArgs(argv) {
  const [command, ...rest] = argv;
  const options = {};
  for (let index = 0; index < rest.length; index += 1) {
    const arg = rest[index];
    if (!arg.startsWith("--")) throw new LockError(`unknown argument: ${arg}`, EXIT.usage);
    const key = arg.slice(2);
    if (key === "verbose") {
      options[key] = true;
      continue;
    }
    const value = rest[index + 1];
    if (value === undefined) throw new LockError(`${arg} needs a value`, EXIT.usage);
    options[key] = value;
    index += 1;
  }
  return { command, options };
}

function sha256Bytes(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

/** バイト順の比較（localeCompare は環境で並びが変わりうるので使わない）。 */
function byteOrder(a, b) {
  return a < b ? -1 : a > b ? 1 : 0;
}

// --- ソースの指紋 ---------------------------------------------------------------

/**
 * 指紋に入れるファイル（リポジトリの root からのパス）。git が追跡しているものと、まだ追加していないが無視されていない
 * もの（`git ls-files -co --exclude-standard`。`.build/` などの成果物は入らない）のうち、今あるふつうのファイル。
 */
function sourceFiles(repoRoot) {
  const run = spawnSync("git", ["-C", repoRoot, "ls-files", "-z", "-co", "--exclude-standard", "--", ...SOURCE_PATHS], {
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
  });
  if (run.status !== 0) {
    throw new LockError(`git ls-files に失敗しました（${run.stderr?.trim() || `status ${run.status}`}）`);
  }
  const files = new Set();
  for (const file of run.stdout.split("\0")) {
    if (!file || path.posix.basename(file) === ".DS_Store") continue;
    // 消したがまだコミットしていないファイルは、今のソースに無いので入れない
    if (!fs.lstatSync(path.join(repoRoot, file), { throwIfNoEntry: false })?.isFile()) continue;
    files.add(file);
  }
  if (files.size === 0) throw new LockError(`${TOOL_REL} のソースが見つかりません（--repo-root を確認してください）`);
  return [...files].sort(byteOrder);
}

/** `<sha256>  <path>` を 1 行ずつ並べた文字列の SHA-256（パスも入れるので、名前の変更も変わったとみなす）。 */
export function sourceFingerprint(repoRoot = DEFAULT_REPO_ROOT) {
  const entries = sourceFiles(repoRoot).map((file) => [file, sha256Bytes(fs.readFileSync(path.join(repoRoot, file)))]);
  const listing = entries.map(([file, digest]) => `${digest}  ${file}\n`).join("");
  return { fingerprint: sha256Bytes(listing), fileCount: entries.length, entries };
}

// --- 版 -----------------------------------------------------------------------

/** ソースに書かれた版（ビルドしなくても読める）。 */
export function sourceVersion(repoRoot = DEFAULT_REPO_ROOT) {
  const file = path.join(repoRoot, VERSION_SOURCE_REL);
  const swift = fs.existsSync(file) ? fs.readFileSync(file, "utf8") : "";
  const version = /static let version = "(\d+\.\d+\.\d+)"/.exec(swift)?.[1];
  if (!version) throw new LockError(`${VERSION_SOURCE_REL} に static let version = "X.Y.Z" がありません`);
  return version;
}

/** `niho-camera-cutout version` → `niho-camera-cutout 0.1.0`。 */
export function parseVersionLine(stdout) {
  const match = new RegExp(`^${SIDECAR_NAME} (\\d+\\.\\d+\\.\\d+)$`).exec(String(stdout ?? "").trim());
  return match?.[1] ?? null;
}

/** lock に書く値。 */
export function lockEntry(repoRoot = DEFAULT_REPO_ROOT) {
  const { fingerprint, fileCount } = sourceFingerprint(repoRoot);
  return { version: sourceVersion(repoRoot), sources: { fingerprint, fileCount } };
}

// --- ビルドした実行ファイルの照合 ---------------------------------------------------

/**
 * 実行ファイルが読む dylib が macOS の中（/usr/lib・/System）だけか（Homebrew や back-deploy の dylib に依存すると、
 * ビルドした Mac では動いても会員の Mac で起動しない）。Mach-O でなければ見ない。
 */
function systemOnlyDylibProblems(executable) {
  const head = Buffer.alloc(4);
  const fd = fs.openSync(executable, "r");
  try {
    fs.readSync(fd, head, 0, 4, 0);
  } finally {
    fs.closeSync(fd);
  }
  if (!MACHO_MAGICS.has(head.toString("hex"))) return [];
  const result = spawnSync("otool", ["-L", executable], { encoding: "utf8" });
  if (result.status !== 0) return [`otool -L ${path.basename(executable)} に失敗しました`];
  return result.stdout
    .split("\n")
    .slice(1)
    .map((line) => line.trim().split(" (")[0])
    .filter((dylib) => dylib && !dylib.startsWith("/usr/lib/") && !dylib.startsWith("/System/"))
    .map((dylib) => `${path.basename(executable)} が macOS の外の dylib を読みます: ${dylib}`);
}

/** ビルドした実行ファイルが、同梱する側と同じ環境でソースの版を答え、macOS の外の dylib を読まないか。答えた版を返す。 */
export function checkBinary(executable, repoRoot = DEFAULT_REPO_ROOT) {
  if (!fs.statSync(executable, { throwIfNoEntry: false })?.isFile()) throw new LockError(`実行ファイルがありません: ${executable}`);
  const expected = sourceVersion(repoRoot);
  const result = spawnSync(executable, ["version"], { encoding: "utf8", env: SIDECAR_ENV(), cwd: "/", timeout: 30_000 });
  const version = result.status === 0 ? parseVersionLine(result.stdout) : null;
  if (!version) {
    throw new LockError(
      `${SIDECAR_NAME} version に答えません（status ${result.status}, signal ${result.signal ?? "-"}）: ` +
        `${String(result.stdout ?? "").trim()} ${String(result.stderr ?? "").trim()}`,
    );
  }
  if (version !== expected) {
    throw new LockError(`${SIDECAR_NAME} の版が違います: 実行ファイル ${version} / ソース ${expected}（ビルドし直してください）`);
  }
  const problems = systemOnlyDylibProblems(executable);
  if (problems.length > 0) throw new LockError(problems.join("\n"));
  return version;
}

// --- self-test ----------------------------------------------------------------

function selfTest() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "niho-camera-cutout-sidecar-lock-test-"));
  const write = (file, content, mode) => {
    const full = path.join(root, file);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, content);
    if (mode) fs.chmodSync(full, mode);
  };
  const expectExit = (label, code, fn) => {
    try {
      fn();
    } catch (error) {
      if (error.exitCode === code) return;
      throw new Error(`${label}: expected exit ${code}, got ${error.exitCode}: ${error.message}`);
    }
    throw new Error(`${label}: expected exit ${code}, but it passed`);
  };
  const assert = (condition, label) => {
    if (!condition) throw new Error(`self-test: ${label}`);
  };
  const git = (...args) => {
    const result = spawnSync("git", ["-C", root, ...args], { encoding: "utf8" });
    if (result.status !== 0) throw new Error(`self-test: git ${args.join(" ")} failed: ${result.stderr}`);
  };
  try {
    if (spawnSync("git", ["init", "-q", root]).status !== 0) throw new Error("self-test: git init failed");
    git("config", "user.email", "self-test@example.invalid");
    git("config", "user.name", "self-test");
    git("config", "commit.gpgsign", "false");
    expectExit("no sources", EXIT.mismatch, () => sourceFingerprint(root));
    write(".gitignore", `${TOOL_REL}/.build/\n`);
    write(`${TOOL_REL}/Package.swift`, "// swift-tools-version: 6.0\n");
    write(`${TOOL_REL}/Sources/NihoCameraCutout/CutoutComposer.swift`, "public struct CutoutComposer {}\n");
    write(VERSION_SOURCE_REL, 'enum Tool {\n    static let name = "niho-camera-cutout"\n    static let version = "0.3.1"\n}\n');
    write(`${TOOL_REL}/Sources/NihoCameraCutout/.DS_Store`, "finder");
    write(`${TOOL_REL}/Tests/NihoCameraCutoutTests/CLITests.swift`, "// tests\n");
    write(`${TOOL_REL}/README.md`, "# readme\n");
    write(`${TOOL_REL}/scripts/sidecar-lock.mjs`, "// script\n");
    write(`${TOOL_REL}/.build/release/niho-camera-cutout`, "binary");

    // 追加前（untracked）のファイルも入る。テスト・README・scripts・.build・.DS_Store は入らない
    const first = sourceFingerprint(root);
    assert(
      JSON.stringify(first.entries.map(([file]) => file)) ===
        JSON.stringify([
          `${TOOL_REL}/Package.swift`,
          `${TOOL_REL}/Sources/NihoCameraCutout/CutoutComposer.swift`,
          VERSION_SOURCE_REL,
        ]),
      `source files: ${first.entries.map(([file]) => file).join(", ")}`,
    );
    // Desktop の lock（develop-sidecars-lock.mjs sourceFingerprint）と同じ計算
    const listing = first.entries
      .map(([file]) => `${sha256Bytes(fs.readFileSync(path.join(root, file)))}  ${file}\n`)
      .join("");
    assert(first.fingerprint === sha256Bytes(listing) && first.fileCount === 3, "fingerprint is the SHA-256 of the listing");

    git("add", "-A");
    git("commit", "-q", "--no-verify", "-m", "init");
    assert(sourceFingerprint(root).fingerprint === first.fingerprint, "tracking does not change the fingerprint");
    write(`${TOOL_REL}/Tests/NihoCameraCutoutTests/CLITests.swift`, "// more tests\n");
    write(`${TOOL_REL}/README.md`, "# readme 2\n");
    write(`${TOOL_REL}/.build/release/niho-camera-cutout`, "binary 2");
    assert(sourceFingerprint(root).fingerprint === first.fingerprint, "tests, docs and build outputs do not change it");
    write(`${TOOL_REL}/Sources/NihoCameraCutout/CutoutComposer.swift`, "public struct CutoutComposer { }\n");
    const edited = sourceFingerprint(root);
    assert(edited.fingerprint !== first.fingerprint, "a source edit changes it");
    fs.renameSync(
      path.join(root, `${TOOL_REL}/Sources/NihoCameraCutout/CutoutComposer.swift`),
      path.join(root, `${TOOL_REL}/Sources/NihoCameraCutout/Composer.swift`),
    );
    const renamed = sourceFingerprint(root);
    assert(renamed.fingerprint !== edited.fingerprint && renamed.fileCount === 3, "a rename changes it");
    fs.rmSync(path.join(root, `${TOOL_REL}/Sources/NihoCameraCutout/Composer.swift`));
    assert(sourceFingerprint(root).fileCount === 2, "a deleted, uncommitted file is not in the sources");

    assert(sourceVersion(root) === "0.3.1", "version from Tool.swift");
    const entry = lockEntry(root);
    assert(entry.version === "0.3.1" && entry.sources.fileCount === 2, "lock entry");
    assert(parseVersionLine("niho-camera-cutout 0.1.0\n") === "0.1.0", "version line");
    assert(parseVersionLine("niho-camera-cutout 0.1") === null, "a version needs three parts");
    assert(parseVersionLine("apple-raw-linear 0.1.0") === null, "another sidecar's line");
    assert(parseVersionLine("niho-camera-cutout 0.1.0 extra") === null, "nothing after the version");

    // 実行ファイルの照合（同梱する側と同じ環境で `version` を聞く）
    const binary = (name, body) => {
      write(name, `#!/bin/sh\n${body}\n`, 0o755);
      return path.join(root, name);
    };
    assert(
      checkBinary(binary("ok", 'test "$1" = version && test "$PWD" = / && echo "niho-camera-cutout 0.3.1"'), root) === "0.3.1",
      "binary answers the source version",
    );
    expectExit("stale binary", EXIT.mismatch, () => checkBinary(binary("stale", 'echo "niho-camera-cutout 0.3.0"'), root));
    expectExit("failing binary", EXIT.mismatch, () => checkBinary(binary("fail", "exit 3"), root));
    expectExit("no binary", EXIT.mismatch, () => checkBinary(path.join(root, "missing"), root));
    write(VERSION_SOURCE_REL, 'enum Tool {\n    static let version = "0.3"\n}\n');
    expectExit("version without three parts", EXIT.mismatch, () => sourceVersion(root));
    expectExit("unknown argument", EXIT.usage, () => parseArgs(["fingerprint", "verbose"]));
    expectExit("missing value", EXIT.usage, () => parseArgs(["check-binary", "--binary"]));
    console.log("self-test: ok");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}

function main() {
  const { command, options } = parseArgs(process.argv.slice(2));
  const repoRoot = path.resolve(options["repo-root"] ?? DEFAULT_REPO_ROOT);
  switch (command) {
    case "version":
      console.log(sourceVersion(repoRoot));
      return;
    case "fingerprint": {
      const { fingerprint, fileCount, entries } = sourceFingerprint(repoRoot);
      if (options.verbose) for (const [file, digest] of entries) console.log(`${digest}  ${file}`);
      console.log(`${fingerprint}（${fileCount} ファイル）`);
      return;
    }
    case "entry":
      console.log(JSON.stringify(lockEntry(repoRoot), null, 2));
      return;
    case "check-binary": {
      if (!options.binary) throw new LockError("check-binary には --binary が要ります", EXIT.usage);
      const executable = path.resolve(options.binary);
      const version = checkBinary(executable, repoRoot);
      console.log(`${path.relative(repoRoot, executable) || executable} は ${SIDECAR_NAME} ${version}（ソースの版）で、macOS の dylib だけを読みます`);
      return;
    }
    case "self-test":
      selfTest();
      return;
    default:
      throw new LockError(
        `使い方: sidecar-lock.mjs <version|fingerprint|entry|check-binary|self-test> [options]（${command ?? "コマンドなし"}）`,
        EXIT.usage,
      );
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    main();
  } catch (error) {
    console.error(error.message);
    process.exit(error.exitCode ?? EXIT.mismatch);
  }
}
