#!/usr/bin/env node
// stage-develop-engine.mjs — 段 2 の wasm（NIHO の公開物）を NIHO photo の画面に同梱する（spec niho-camera-app.md
// 決まりごと 4「wasm を niho.life から取らない」・「段 1・段 2」）。
//
// 公開移植前の内部構成については docs/migration/mac-client.md を参照。
// 置く。ここから、いちばん新しい版の manifest（manifest-<X.Y.Z>.json）と、それが files に挙げるファイル（glue の .js・.wasm・
// 型定義）だけを apps/camera/public/develop-engine/<engine>/ へ写す。写す前に manifest の sha256 と bytes と照らし、合わなければ
// 止める（壊れた・途中の公開物を .app に入れない）。public/ は vite が dist/ へそのまま写す（gitignore 済み）。
// 保存済みの旧 engine（niho-1〜3）の補正は、いちばん新しい wasm の互換経路で描く（web と同じ）ので、写すのは 1 版だけ。
//
// 使い方:
//   node apps/camera/scripts/stage-develop-engine.mjs            （package.json の web:dev / web:build が先に呼ぶ）
//   node apps/camera/scripts/stage-develop-engine.mjs --print    （写す版を表示するだけ）
//   node apps/camera/scripts/stage-develop-engine.mjs --check-app "…/NIHO photo.app"
//     できた .app に、いちばん新しい版の wasm が入っているか（配布の build-dmg.sh が確かめる。C5 #18393）
//
// 終了コード: 0 = 写した・入っている / 1 = 公開物が無い・壊れている・.app に入っていない / 2 = 使い方の誤り
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(SCRIPT_DIR, "../../..");
/** 画面（packages/photo-editing）が読む wasm の置き場の名前と版を決める 1 か所。公開の PR（release-engine.mjs）が書き換える。 */
export const ENGINE_MANIFEST_SOURCE = path.join(REPO_ROOT, "packages/photo-editing/src/develop-engine/develop-engine-manifest.ts");

const MANIFEST_RE = /^manifest-(\d+)\.(\d+)\.(\d+)\.json$/;
const FILE_NAME_RE = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

export class StageError extends Error {
  constructor(message, exitCode = 1) {
    super(message);
    this.exitCode = exitCode;
  }
}

/**
 * bundle が読める最新の数式の置き場（画面の `DEVELOP_ENGINE_VERSION`）。ここに固定で書くと、公開の PR が画面の側だけを
 * 進めたときに古い置き場の wasm を同梱し、配った camera で manifest が 404 になる（#18497 の niho-4 → niho-5）。
 */
export function readBundleEngine(source = ENGINE_MANIFEST_SOURCE) {
  const match = /export const DEVELOP_ENGINE_VERSION = "([a-z0-9-]+)";/.exec(fs.readFileSync(source, "utf8"));
  if (!match) throw new StageError(`${path.relative(REPO_ROOT, source)} の DEVELOP_ENGINE_VERSION を読めません`);
  return match[1];
}

export const ENGINE = readBundleEngine();
export const DEFAULT_FROM = path.join(REPO_ROOT, "packages/develop-engine/public/develop-engine", ENGINE);
export const DEFAULT_TO = path.join(REPO_ROOT, "apps/camera/public/develop-engine", ENGINE);

/** いちばん新しい版の manifest のファイル名（無ければ StageError）。 */
export function latestManifestName(fromDir) {
  const names = fs.existsSync(fromDir) ? fs.readdirSync(fromDir) : [];
  const versions = names
    .map((name) => ({ name, match: MANIFEST_RE.exec(name) }))
    .filter(({ match }) => match)
    .map(({ name, match }) => ({ name, parts: match.slice(1).map(Number) }))
    .sort((a, b) => b.parts[0] - a.parts[0] || b.parts[1] - a.parts[1] || b.parts[2] - a.parts[2]);
  if (versions.length === 0) throw new StageError(`段 2 の wasm の公開物がありません: ${fromDir}`);
  return versions[0].name;
}

const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");

/** 公開物を照らして写す。写した版と、写したファイル名を返す。 */
export function stageDevelopEngine({ from = DEFAULT_FROM, to = DEFAULT_TO } = {}) {
  const manifestName = latestManifestName(from);
  const manifestBytes = fs.readFileSync(path.join(from, manifestName));
  const manifest = JSON.parse(manifestBytes.toString("utf8"));
  const version = MANIFEST_RE.exec(manifestName).slice(1).join(".");
  if (manifest.engine !== ENGINE || manifest.version !== version) {
    throw new StageError(`${manifestName} の engine / version が名前と合いません（${manifest.engine} ${manifest.version}）`);
  }
  const files = Object.entries(manifest.files ?? {});
  if (!files.some(([name]) => name.endsWith(".wasm")) || !files.some(([name]) => name.endsWith(".js"))) {
    throw new StageError(`${manifestName} の files に .wasm と .js がありません`);
  }
  const verified = files.map(([name, expected]) => {
    if (!FILE_NAME_RE.test(name) || name.includes("..")) throw new StageError(`${manifestName} のファイル名が不正です: ${name}`);
    const bytes = fs.readFileSync(path.join(from, name));
    if (bytes.length !== expected.bytes || sha256(bytes) !== expected.sha256) {
      throw new StageError(`${name} が ${manifestName} の sha256 / bytes と合いません（公開をやり直してください）`);
    }
    return [name, bytes];
  });
  fs.rmSync(to, { recursive: true, force: true });
  fs.mkdirSync(to, { recursive: true });
  fs.writeFileSync(path.join(to, manifestName), manifestBytes);
  for (const [name, bytes] of verified) fs.writeFileSync(path.join(to, name), bytes);
  return { version, manifest: manifestName, files: verified.map(([name]) => name) };
}

/**
 * 画面に同梱する置き場（`apps/camera/public/develop-engine/`）から、今のエンジン（{@link ENGINE}）の置き場ではないものを消す。
 * エンジンの公開で置き場の名前が変わる（#18497 の niho-4 → niho-5）と、前に写した置き場が手元に残り、`.app` に古い wasm も入るため。
 * 置き場は gitignore された camera だけの場所で、写したもののほかは置かない。消した名前を返す。
 */
export function removeStaleEngineDirs(root = path.dirname(DEFAULT_TO), engine = ENGINE) {
  if (!fs.existsSync(root)) return [];
  const removed = [];
  for (const name of fs.readdirSync(root)) {
    if (name === engine) continue;
    fs.rmSync(path.join(root, name), { recursive: true, force: true });
    removed.push(name);
  }
  return removed.sort();
}

export const DEFAULT_DIST = path.join(REPO_ROOT, "apps/camera/dist");

/** .app の Info.plist（Tauri が書く XML）の CFBundleExecutable。 */
export function appExecutable(appPath) {
  const plist = fs.readFileSync(path.join(appPath, "Contents/Info.plist"), "utf8");
  const name = /<key>CFBundleExecutable<\/key>\s*<string>([^<]+)<\/string>/.exec(plist)?.[1];
  if (!name) throw new StageError(`${appPath} の Info.plist に CFBundleExecutable がありません`);
  return path.join(appPath, "Contents/MacOS", name);
}

/**
 * できた .app に、公開物のいちばん新しい版（stageDevelopEngine が写すもの）が入っているか確かめる。Tauri は画面（frontendDist =
 * dist/）を実行ファイルに埋め込む（ファイルとしては .app に無い。中身は圧縮される）ので、2 つを見る:
 *   - dist/develop-engine/<engine>/ のファイルが manifest の sha256・bytes と合う（埋め込んだ元の中身）
 *   - 実行ファイルに、それぞれの置き場のキー（`/develop-engine/<engine>/<名前>`。画面が読む URL のパス）がある
 * 合わなければ StageError。確かめた版とファイル名を返す。
 */
export function checkBundledEngine({ executable, dist = DEFAULT_DIST, from = DEFAULT_FROM, engine = ENGINE }) {
  const manifestName = latestManifestName(from);
  const manifestBytes = fs.readFileSync(path.join(from, manifestName));
  const manifest = JSON.parse(manifestBytes.toString("utf8"));
  const version = MANIFEST_RE.exec(manifestName).slice(1).join(".");
  const names = [manifestName, ...Object.keys(manifest.files ?? {})];
  const problems = [];
  const distDir = path.join(dist, "develop-engine", engine);
  for (const name of names) {
    const file = path.join(distDir, name);
    if (!fs.existsSync(file)) {
      problems.push(`画面の build に無い: dist/develop-engine/${engine}/${name}`);
      continue;
    }
    const bytes = fs.readFileSync(file);
    const expected = manifest.files?.[name];
    const same = expected ? bytes.length === expected.bytes && sha256(bytes) === expected.sha256 : bytes.equals(manifestBytes);
    if (!same) problems.push(`画面の build の中身が公開物と違う: dist/develop-engine/${engine}/${name}`);
  }
  const binary = fs.readFileSync(executable);
  for (const name of names) {
    const key = `/develop-engine/${engine}/${name}`;
    if (!binary.includes(Buffer.from(key))) problems.push(`.app の実行ファイルに埋め込まれていない: ${key}`);
  }
  if (problems.length > 0) {
    throw new StageError([`.app に段 2 の wasm ${engine} ${version} が入っていません:`, ...problems.map((line) => `  - ${line}`)].join("\n"));
  }
  return { version, files: names };
}

function main(argv) {
  if (argv[0] === "--check-app") {
    if (argv.length !== 2) throw new StageError("使い方: stage-develop-engine.mjs --check-app <NIHO photo.app>", 2);
    const checked = checkBundledEngine({ executable: appExecutable(argv[1]) });
    console.log(`.app の段 2 の wasm を確かめました: ${ENGINE} ${checked.version}（${checked.files.length} ファイル）`);
    return;
  }
  if (argv.length > 1 || (argv[0] && argv[0] !== "--print")) {
    throw new StageError("使い方: stage-develop-engine.mjs [--print | --check-app <NIHO photo.app>]", 2);
  }
  if (argv[0] === "--print") {
    console.log(latestManifestName(DEFAULT_FROM));
    return;
  }
  removeStaleEngineDirs();
  if (!fs.existsSync(DEFAULT_FROM)) {
    fs.rmSync(DEFAULT_TO, { recursive: true, force: true });
    console.log("現像エンジンは未導入です。ローカル閲覧機能で起動します（#9）。");
    return;
  }
  const staged = stageDevelopEngine();
  console.log(`段 2 の wasm ${ENGINE} ${staged.version} を同梱します（${staged.files.length + 1} ファイル）`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    main(process.argv.slice(2));
  } catch (error) {
    console.error(error.message);
    process.exit(error.exitCode ?? 1);
  }
}
