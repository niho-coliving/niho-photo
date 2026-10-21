#!/usr/bin/env node
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import {
  chmodSync,
  copyFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const TARGET = "aarch64-apple-darwin";
const RUST_TOOLCHAIN = "1.98.1";
const TOOLS = ["apple-raw-linear", "niho-develop-render", "niho-camera-cutout"];
const MACHO_MAGICS = new Set(["cffaedfe", "cefaedfe", "feedfacf", "feedface", "cafebabe", "bebafeca"]);
const SHA256 = /^[a-f0-9]{64}$/u;

export class NativeBuildError extends Error {}

export const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");

function json(file) {
  try {
    return JSON.parse(readFileSync(file, "utf8"));
  } catch {
    throw new NativeBuildError("native build JSONを読めません");
  }
}

function ordinaryDirectory(directory, label) {
  const stat = lstatSync(directory, { throwIfNoEntry: false });
  if (!stat?.isDirectory() || stat.isSymbolicLink()) throw new NativeBuildError(`${label}は通常directoryが必要です`);
}

function run(command, args, options = {}) {
  const result = spawnSync(command, args, { encoding: "utf8", maxBuffer: 64 * 1024 * 1024, ...options });
  if (result.error || result.status !== 0) {
    throw new NativeBuildError(`${path.basename(command)}の実行に失敗しました（値は非表示）`);
  }
  return String(result.stdout ?? "").trim();
}

export function nativeBuildEnvironment(input, { engineRoot, isolatedRoot }) {
  if (!path.isAbsolute(engineRoot) || !path.isAbsolute(isolatedRoot)) throw new NativeBuildError("native build隔離pathが不正です");
  const inherited = Object.fromEntries(
    ["PATH", "LANG", "DEVELOPER_DIR", "SDKROOT"].filter((key) => input[key]).map((key) => [key, input[key]]),
  );
  const rustupHome = input.RUSTUP_HOME || (input.HOME ? path.join(input.HOME, ".rustup") : undefined);
  if (!path.isAbsolute(rustupHome ?? "")) throw new NativeBuildError("Rust toolchainの保存先は絶対pathが必要です");
  const home = path.join(isolatedRoot, "home");
  const cargoHome = path.join(isolatedRoot, "cargo-home");
  const temporary = path.join(isolatedRoot, "tmp");
  for (const directory of [home, cargoHome, temporary]) mkdirSync(directory, { recursive: true, mode: 0o700 });
  const remap = [
    [engineRoot, "engine-source"],
    [isolatedRoot, "build-temp"],
    [rustupHome, "rust-toolchain"],
    [input.HOME, "build-user"],
    [cargoHome, "cargo-registry"],
  ]
    .filter(([from]) => from)
    .sort(([left], [right]) => right.length - left.length)
    .map(([from, to]) => `--remap-path-prefix=${from}=${to}`);
  return {
    ...inherited,
    HOME: home,
    CARGO_HOME: cargoHome,
    RUSTUP_HOME: rustupHome,
    TMPDIR: temporary,
    RUSTUP_TOOLCHAIN: RUST_TOOLCHAIN,
    CARGO_TARGET_DIR: path.join(isolatedRoot, "cargo-target"),
    CARGO_BUILD_TARGET: TARGET,
    CARGO_BUILD_JOBS: "2",
    CARGO_PROFILE_RELEASE_DEBUG: "0",
    CARGO_PROFILE_RELEASE_STRIP: "debuginfo",
    CARGO_ENCODED_RUSTFLAGS: remap.join("\x1f"),
    CI: "true",
  };
}

function requiredSourcePaths(engineRoot) {
  return [
    "Cargo.lock",
    "Cargo.toml",
    "rust-toolchain.toml",
    "LICENSES.md",
    "licenses/Adobe-DNG-SDK-LICENSE.txt",
    "calibration/apple-registry.json",
    "calibration/apple-signed-registry.json",
    "calibration/panasonic-dc-s5/apple-v1.json",
    "calibration/panasonic-dc-s5/apple-v2.json",
    "crates/niho-develop-render/Cargo.toml",
    "crates/niho-develop-render/src/main.rs",
    "tools/apple-raw-linear/Package.swift",
    "tools/apple-raw-linear/Sources/apple-raw-linear/main.swift",
    "tools/niho-camera-cutout/Package.swift",
    "tools/niho-camera-cutout/Sources/NihoCameraCutoutCLI/main.swift",
  ].map((relative) => path.join(engineRoot, ...relative.split("/")));
}

export function validateNativeSourceClosure(engineRoot) {
  ordinaryDirectory(engineRoot, "engine source");
  for (const file of requiredSourcePaths(engineRoot)) {
    const stat = lstatSync(file, { throwIfNoEntry: false });
    if (!stat?.isFile() || stat.isSymbolicLink()) throw new NativeBuildError("engine sourceのnative build closureが不足しています");
  }
  const legacy = [
    ["calibration/panasonic-dc-s5/apple-v1.json", 4988, "85995e52e8a8a9e958d78a3a35a1c9d5de7916b804bd5fca2fd29a81b88ece18"],
    ["calibration/panasonic-dc-s5/apple-v2.json", 5378, "19a0b544394c5434c0fa352fed47502d68634263a971cafb36eacfa372e97cad"],
  ];
  for (const [relative, size, digest] of legacy) {
    const bytes = readFileSync(path.join(engineRoot, ...relative.split("/")));
    if (bytes.length !== size || sha256(bytes) !== digest) throw new NativeBuildError("legacy calibration bytesが固定値と一致しません");
  }
  const toolchain = /^channel\s*=\s*"([^"]+)"/mu.exec(readFileSync(path.join(engineRoot, "rust-toolchain.toml"), "utf8"))?.[1];
  if (toolchain !== RUST_TOOLCHAIN) throw new NativeBuildError("Rust toolchain pinが不正です");
  return { rustToolchain: toolchain, target: TARGET };
}

export function validateNativeLock(engineRoot, lock) {
  const versionFrom = (relative, pattern) => pattern.exec(readFileSync(path.join(engineRoot, relative), "utf8"))?.[1];
  const versions = {
    appleRawLinear: versionFrom("tools/apple-raw-linear/Sources/apple-raw-linear/CLI.swift", /static let version = "([^"]+)"/u),
    nihoDevelopRender: versionFrom("Cargo.toml", /\[workspace\.package\][\s\S]*?^version\s*=\s*"([^"]+)"/mu),
    nihoCameraCutout: versionFrom("tools/niho-camera-cutout/Sources/NihoCameraCutoutCLI/Tool.swift", /static let version = "([^"]+)"/u),
  };
  if (lock.schemaVersion !== 1 || Object.entries(versions).some(([name, version]) => !/^\d+\.\d+\.\d+$/u.test(version ?? "") || lock[name]?.version !== version)) {
    throw new NativeBuildError("native lockとSDK sourceのtool versionが一致しません");
  }
  return versions;
}

function parseVersion(name, stdout) {
  return new RegExp(`^${name} (\\d+\\.\\d+\\.\\d+)(?:\\s|$)`, "u").exec(String(stdout).trim())?.[1] ?? null;
}

function systemDylibs(binary, env) {
  const head = readFileSync(binary).subarray(0, 4).toString("hex");
  if (!MACHO_MAGICS.has(head)) throw new NativeBuildError("native toolがMach-Oではありません");
  const output = run("otool", ["-L", binary], { env });
  const dylibs = output
    .split("\n")
    .slice(1)
    .map((line) => line.trim().split(" (")[0])
    .filter(Boolean);
  if (dylibs.some((item) => !item.startsWith("/usr/lib/") && !item.startsWith("/System/"))) {
    throw new NativeBuildError("native toolがmacOS外のdylibを参照しています");
  }
  return dylibs;
}

function architecture(binary, env) {
  const value = run("lipo", ["-archs", binary], { env });
  if (value !== "arm64") throw new NativeBuildError("native toolがarm64 thin binaryではありません");
  return value;
}

function copyCalibration(engineRoot, lock, outputDirectory) {
  const destination = path.join(outputDirectory, "develop-calibration");
  mkdirSync(destination, { recursive: true, mode: 0o755 });
  const records = [];
  for (const [relative, expected] of Object.entries(lock.calibration?.files ?? {}).sort(([a], [b]) => a.localeCompare(b, "en"))) {
    if (!/^[A-Za-z0-9][A-Za-z0-9._/-]*$/u.test(relative) || relative.split("/").some((part) => part === "..") || !SHA256.test(expected)) {
      throw new NativeBuildError("calibration lockが不正です");
    }
    const source = path.join(engineRoot, "calibration", ...relative.split("/"));
    const bytes = readFileSync(source);
    if (sha256(bytes) !== expected) throw new NativeBuildError("calibration hashがlockと一致しません");
    const target = path.join(destination, ...relative.split("/"));
    mkdirSync(path.dirname(target), { recursive: true, mode: 0o755 });
    copyFileSync(source, target);
    chmodSync(target, 0o644);
    records.push({ path: relative, sha256: expected, bytes: bytes.length });
  }
  if (!records.some(({ path: name }) => name === "apple-registry.json") || !records.some(({ path: name }) => name === "apple-signed-registry.json")) {
    throw new NativeBuildError("calibration registryがlockにありません");
  }
  return records;
}

function swiftBinary({ packagePath, name, scratch, env }) {
  run("swift", ["build", "-c", "release", "--package-path", packagePath, "--scratch-path", scratch], { env, stdio: "inherit" });
  const bin = run("swift", ["build", "-c", "release", "--package-path", packagePath, "--scratch-path", scratch, "--show-bin-path"], { env });
  return path.join(bin, name);
}

export function buildMacosNative({ engineRoot, lockPath, outputDirectory, inputEnv = process.env }) {
  if (process.platform !== "darwin" || process.arch !== "arm64") throw new NativeBuildError("native buildはApple Silicon macOS専用です");
  const closure = validateNativeSourceClosure(engineRoot);
  const lock = json(lockPath);
  validateNativeLock(engineRoot, lock);
  if (lstatSync(outputDirectory, { throwIfNoEntry: false })) throw new NativeBuildError("native outputは新規directoryが必要です");
  const isolatedRoot = mkdtempSync(path.join(tmpdir(), "niho-photo-native-build-"));
  try {
    const env = nativeBuildEnvironment(inputEnv, { engineRoot, isolatedRoot });
    const rustVersion = run("rustc", ["--version"], { cwd: engineRoot, env });
    if (!rustVersion.startsWith(`rustc ${RUST_TOOLCHAIN} `)) throw new NativeBuildError("固定Rust toolchainが利用できません");
    const swiftVersion = run("swift", ["--version"], { env }).split("\n")[0];
    const lockBefore = sha256(readFileSync(path.join(engineRoot, "Cargo.lock")));
    const apple = swiftBinary({
      packagePath: path.join(engineRoot, "tools/apple-raw-linear"),
      name: "apple-raw-linear",
      scratch: path.join(isolatedRoot, "swift-apple"),
      env,
    });
    const cutout = swiftBinary({
      packagePath: path.join(engineRoot, "tools/niho-camera-cutout"),
      name: "niho-camera-cutout",
      scratch: path.join(isolatedRoot, "swift-cutout"),
      env,
    });
    run("cargo", ["build", "--release", "--locked", "--target", TARGET, "-p", "niho-develop-render"], {
      cwd: engineRoot,
      env,
      stdio: "inherit",
    });
    const renderer = path.join(env.CARGO_TARGET_DIR, TARGET, "release", "niho-develop-render");
    if (sha256(readFileSync(path.join(engineRoot, "Cargo.lock"))) !== lockBefore) throw new NativeBuildError("Cargo.lockがbuild中に変わりました");

    mkdirSync(outputDirectory, { recursive: true, mode: 0o755 });
    const sourceByName = { "apple-raw-linear": apple, "niho-develop-render": renderer, "niho-camera-cutout": cutout };
    const expectedByName = {
      "apple-raw-linear": lock.appleRawLinear?.version,
      "niho-develop-render": lock.nihoDevelopRender?.version,
      "niho-camera-cutout": lock.nihoCameraCutout?.version,
    };
    const binaries = [];
    const runtimeEnv = { HOME: env.HOME, PATH: "/usr/bin:/bin" };
    for (const name of TOOLS) {
      const source = sourceByName[name];
      const stat = lstatSync(source, { throwIfNoEntry: false });
      if (!stat?.isFile() || stat.isSymbolicLink()) throw new NativeBuildError("native tool出力がありません");
      const version = parseVersion(name, run(source, ["version"], { cwd: "/", env: runtimeEnv, timeout: 30_000 }));
      if (!version || version !== expectedByName[name]) throw new NativeBuildError("native tool versionがlockと一致しません");
      const target = path.join(outputDirectory, `${name}-${TARGET}`);
      copyFileSync(source, target);
      chmodSync(target, 0o755);
      const bytes = readFileSync(target);
      binaries.push({ name, version, architecture: architecture(target, runtimeEnv), file: path.basename(target), sha256: sha256(bytes), bytes: bytes.length, dylibs: systemDylibs(target, runtimeEnv) });
    }
    const calibration = copyCalibration(engineRoot, lock, outputDirectory);
    const registryProof = ["apple-registry.json", "apple-signed-registry.json"].map((name) => {
      const stdout = run(path.join(outputDirectory, `apple-raw-linear-${TARGET}`), ["registry", path.join(outputDirectory, "develop-calibration", name)], {
        cwd: "/",
        env: runtimeEnv,
        timeout: 30_000,
      });
      let value;
      try { value = JSON.parse(stdout); } catch { throw new NativeBuildError("calibration registry検査がJSONを返しません"); }
      if (value.registry !== name || !Number.isSafeInteger(value.cameras) || value.cameras < 0) throw new NativeBuildError("calibration registry検査に失敗しました");
      return { file: name, cameras: value.cameras };
    });
    const overlay = {
      bundle: {
        externalBin: TOOLS.map((name) => path.join(outputDirectory, name)),
        resources: { [`${path.join(outputDirectory, "develop-calibration")}/`]: "develop-calibration/" },
      },
    };
    const manifest = {
      schemaVersion: 1,
      target: TARGET,
      toolchain: { rust: rustVersion, swift: swiftVersion },
      source: closure,
      binaries,
      calibration,
      registries: registryProof,
      overlay,
    };
    writeFileSync(path.join(outputDirectory, "native-build-manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`, { flag: "wx", mode: 0o644 });
    writeFileSync(path.join(outputDirectory, "tauri.native.conf.json"), `${JSON.stringify(overlay, null, 2)}\n`, { flag: "wx", mode: 0o644 });
    return manifest;
  } catch (error) {
    rmSync(outputDirectory, { recursive: true, force: true });
    throw error;
  } finally {
    rmSync(isolatedRoot, { recursive: true, force: true });
  }
}

function options(argv) {
  const allowed = new Set(["--engine", "--lock", "--output"]);
  const result = {};
  for (let index = 0; index < argv.length; index += 2) {
    const key = argv[index], value = argv[index + 1];
    if (!allowed.has(key) || !value || value.startsWith("--") || result[key]) throw new NativeBuildError("native build引数が不正です");
    result[key] = value;
  }
  if (!result["--engine"] || !result["--lock"] || !result["--output"]) throw new NativeBuildError("--engine --lock --outputが必要です");
  return result;
}

if (process.argv[1] && existsSync(process.argv[1]) && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const values = options(process.argv.slice(2));
    buildMacosNative({ engineRoot: path.resolve(values["--engine"]), lockPath: path.resolve(values["--lock"]), outputDirectory: path.resolve(values["--output"]) });
    console.log("macOS native toolsを検査してstageしました");
  } catch (error) {
    console.error(error instanceof Error ? error.message : "macOS native buildに失敗しました");
    process.exitCode = 1;
  }
}
