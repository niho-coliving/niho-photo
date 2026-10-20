import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import {
  DEVELOP_ENGINE_CRATE_VERSION,
  DEVELOP_ENGINE_VERSION,
  developEngineManifestPath,
} from "niho-photo-editing/develop-engine/develop-engine-manifest";

import {
  appExecutable,
  checkBundledEngine,
  DEFAULT_FROM,
  ENGINE,
  latestManifestName,
  removeStaleEngineDirs,
  stageDevelopEngine,
} from "./stage-develop-engine.mjs";

const dirs = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

function tempDir() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "camera-stage-engine-"));
  dirs.push(dir);
  return dir;
}

const sha256 = (text) => createHash("sha256").update(text).digest("hex");

function publish(dir, version, { wasm = "wasm-bytes", js = "glue", tamper = false } = {}) {
  const files = {
    [`niho_develop_wasm_bg-${version}.wasm`]: wasm,
    [`niho_develop_wasm-${version}.js`]: js,
  };
  const manifest = {
    engine: ENGINE,
    version,
    files: Object.fromEntries(
      Object.entries(files).map(([name, text]) => [name, { sha256: sha256(text), bytes: Buffer.byteLength(text) }]),
    ),
  };
  fs.writeFileSync(path.join(dir, `manifest-${version}.json`), JSON.stringify(manifest));
  for (const [name, text] of Object.entries(files)) fs.writeFileSync(path.join(dir, name), tamper ? `${text}!` : text);
}

describe("removeStaleEngineDirs", () => {
  it("leaves only the current engine's folder in the bundled place", () => {
    const root = tempDir();
    for (const name of ["niho-4", "niho-5", "stray.txt"]) {
      if (name.endsWith(".txt")) fs.writeFileSync(path.join(root, name), "x");
      else fs.mkdirSync(path.join(root, name, "sub"), { recursive: true });
    }
    expect(removeStaleEngineDirs(root, "niho-5")).toEqual(["niho-4", "stray.txt"]);
    expect(fs.readdirSync(root)).toEqual(["niho-5"]);
    expect(removeStaleEngineDirs(path.join(root, "missing"), "niho-5")).toEqual([]);
  });
});

describe("stageDevelopEngine", () => {
  it("copies only the newest manifest and the files it lists after checking them", () => {
    const from = tempDir();
    const to = path.join(tempDir(), "out");
    publish(from, "0.9.0");
    publish(from, "0.13.0");
    publish(from, "0.12.1");
    fs.writeFileSync(path.join(from, "manifest.json"), "{}");
    fs.mkdirSync(to, { recursive: true });
    fs.writeFileSync(path.join(to, "stale.wasm"), "old");

    expect(latestManifestName(from)).toBe("manifest-0.13.0.json");
    const staged = stageDevelopEngine({ from, to });
    expect(staged.version).toBe("0.13.0");
    expect(fs.readdirSync(to).sort()).toEqual([
      "manifest-0.13.0.json",
      "niho_develop_wasm-0.13.0.js",
      "niho_develop_wasm_bg-0.13.0.wasm",
    ]);
  });

  it("refuses a published file that does not match the manifest", () => {
    const from = tempDir();
    publish(from, "0.13.0", { tamper: true });
    expect(() => stageDevelopEngine({ from, to: path.join(tempDir(), "out") })).toThrow(/sha256/);
  });

  it("refuses when nothing is published", () => {
    expect(() => stageDevelopEngine({ from: tempDir(), to: path.join(tempDir(), "out") })).toThrow(/公開物がありません/);
  });

  it("uses the public engine staging contract without private checkout", () => {
    expect(DEFAULT_FROM).toContain("packages/develop-engine/public/develop-engine");
    expect(ENGINE).toBe(DEVELOP_ENGINE_VERSION);
    const from = tempDir();
    publish(from, DEVELOP_ENGINE_CRATE_VERSION);
    const staged = stageDevelopEngine({ from, to: path.join(tempDir(), "out") });
    expect(`/develop-engine/${ENGINE}/${staged.manifest}`).toBe(developEngineManifestPath());
  });
});

describe("checkBundledEngine", () => {
  /** tauri build が作る .app を真似る（実行ファイルに画面の置き場のキーが埋め込まれ、dist/ に画面の build がある）。 */
  function fakeBuild(version, { embed = true, distTamper = false } = {}) {
    const from = tempDir();
    publish(from, version);
    const dist = tempDir();
    stageDevelopEngine({ from, to: path.join(dist, "develop-engine", ENGINE) });
    if (distTamper) fs.writeFileSync(path.join(dist, "develop-engine", ENGINE, `niho_develop_wasm_bg-${version}.wasm`), "other");
    const app = path.join(tempDir(), "NIHO photo.app");
    fs.mkdirSync(path.join(app, "Contents/MacOS"), { recursive: true });
    fs.writeFileSync(
      path.join(app, "Contents/Info.plist"),
      "<plist><dict>\n\t<key>CFBundleExecutable</key>\n\t<string>niho_camera</string>\n</dict></plist>\n",
    );
    const keys = embed
      ? fs.readdirSync(path.join(dist, "develop-engine", ENGINE)).map((name) => `/develop-engine/${ENGINE}/${name}`)
      : [];
    fs.writeFileSync(path.join(app, "Contents/MacOS/niho_camera"), Buffer.concat([Buffer.from([0xcf, 0xfa]), Buffer.from(keys.join("\0"))]));
    return { from, dist, app };
  }

  it("confirms the newest published wasm is in the built UI and embedded in the app", () => {
    const { from, dist, app } = fakeBuild("0.13.0");
    expect(appExecutable(app)).toBe(path.join(app, "Contents/MacOS/niho_camera"));
    expect(checkBundledEngine({ executable: appExecutable(app), dist, from })).toEqual({
      version: "0.13.0",
      files: ["manifest-0.13.0.json", "niho_develop_wasm_bg-0.13.0.wasm", "niho_develop_wasm-0.13.0.js"],
    });
  });

  it("refuses an app whose executable does not carry the wasm", () => {
    const { from, dist, app } = fakeBuild("0.13.0", { embed: false });
    expect(() => checkBundledEngine({ executable: appExecutable(app), dist, from })).toThrow(/埋め込まれていない/);
  });

  it("refuses a UI build whose wasm differs from the published one", () => {
    const { from, dist, app } = fakeBuild("0.13.0", { distTamper: true });
    expect(() => checkBundledEngine({ executable: appExecutable(app), dist, from })).toThrow(/公開物と違う/);
  });

  it("refuses a UI build of an older published version", () => {
    const { from, dist, app } = fakeBuild("0.13.0");
    publish(from, "0.13.1");
    expect(() => checkBundledEngine({ executable: appExecutable(app), dist, from })).toThrow(/0\.13\.1/);
  });
});
