import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { copyFileSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { nativeSearchPaths, normalizeNativeSearchPaths, assertSystemNativeSearchPaths } from "../../packages/develop-engine/build-macos-native.mjs";

test("実Mach-Oから未使用のSwift探索pathを削除・再署名し、@rpath dylib依存は拒否する", { skip: process.platform !== "darwin" || process.arch !== "arm64" }, () => {
  const root = mkdtempSync(path.join(tmpdir(), "native-rpath-fixture-"));
  try {
    const env = { PATH: "/usr/bin:/bin:/usr/sbin:/sbin", HOME: root };
    const source = path.join(root, "fixture.c"), binary = path.join(root, "fixture"), bad = path.join(root, "bad");
    writeFileSync(source, "int main(void) { return 93; }\n");
    const sdk = execFileSync("/usr/bin/xcrun", ["--sdk", "macosx", "--show-sdk-path"], { env, encoding: "utf8" }).trim();
    execFileSync("/usr/bin/clang", ["-arch", "arm64", "-mmacosx-version-min=14.0", "-isysroot", sdk, source, "-Wl,-headerpad_max_install_names", "-Wl,-rpath,@loader_path", "-Wl,-rpath,/Applications/SyntheticSDK/lib", "-o", binary], { env, stdio: "pipe" });
    copyFileSync(binary, bad);
    execFileSync("/usr/bin/install_name_tool", ["-change", "/usr/lib/libSystem.B.dylib", "@rpath/libExternal.dylib", bad], { env, stdio: "pipe" });
    assert.throws(() => normalizeNativeSearchPaths(bad, env), /macOS外のdylib/u);
    assert.ok(nativeSearchPaths(bad, env).includes("@loader_path"));
    assert.equal(normalizeNativeSearchPaths(binary, env), 2);
    assert.deepEqual(assertSystemNativeSearchPaths(binary, env), []);
    execFileSync("/usr/bin/codesign", ["--verify", "--strict", binary], { env, stdio: "pipe" });
  } finally { rmSync(root, { recursive: true, force: true }); }
});
