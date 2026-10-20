import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { lstat, readFile } from "node:fs/promises";
import path from "node:path";
import { workflowFailures } from "./workflow-lib.mjs";

export const digest = (bytes) => createHash("sha256").update(bytes).digest("hex");
const sha256 = /^[a-f0-9]{64}$/;
const commit = /^[a-f0-9]{40}$/;
const forbiddenPrefixes = ["apps/api/", "apps/web/", "ops/", "infra/", "archive/", "private/", "secrets/", "release/", "target/", "node_modules/"];
const forbiddenNames = [".env", "id_rsa", "id_ed25519", "credentials.json", "service-account.json", ".gitmodules", ".npmrc", ".gitleaks.toml", ".gitleaksignore", ".git-credentials", ".netrc", "id_ecdsa", "id_dsa"];
const forbiddenExtensions = [".p12", ".p8", ".pem", ".key", ".mobileprovision", ".cer", ".crt", ".db", ".sqlite", ".onnx", ".mlmodel", ".mlmodelc", ".dcp", ".pfx", ".jks", ".keystore", ".sqlite3", ".dmg", ".pkg", ".exe", ".msi", ".ipa", ".aab", ".apk"];
const assetExtensions = new Set([".png", ".jpg", ".jpeg", ".gif", ".webp", ".avif", ".heic", ".tif", ".tiff", ".svg", ".ico", ".icns", ".woff", ".woff2", ".ttf", ".otf", ".bin", ".wasm", ".f32", ".hex", ".icc", ".icm", ".pdf", ".zip", ".gz", ".mp4", ".mov", ".raw", ".rw2", ".dng", ".nef", ".cr2", ".arw", ".wav", ".mp3", ".aiff", ".flac"]);
export const isAsset = (name) => assetExtensions.has(path.posix.extname(name).toLowerCase()) || /(?:^|\/)(?:fixtures?|calibration|models?|profiles?|data|assets)(?:\/|$)/i.test(name);
export const isSource = (name) => /^(?:packages|apps)\//.test(name);
export const validPath = (name) => typeof name === "string" && name.length > 0 && !/[\x00-\x1f\x7f\\]/.test(name) && !name.startsWith("/") && !name.startsWith("../") && name !== "." && name === path.posix.normalize(name);
const meaningful = (value) => typeof value === "string" && value.trim().length >= 8;

// CSVの引用符、カンマ、改行を扱い、権利判断の列ずれを黙認しない。
export function parseInventory(text) {
  const rows = [];
  let row = [], field = "", quoted = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (c === '"' && quoted && text[i + 1] === '"') { field += '"'; i++; }
    else if (c === '"') quoted = !quoted;
    else if (c === "," && !quoted) { row.push(field); field = ""; }
    else if (c === "\n" && !quoted) { row.push(field.replace(/\r$/, "")); rows.push(row); row = []; field = ""; }
    else field += c;
  }
  if (quoted) throw new Error("資産台帳CSVの引用符が閉じていません");
  if (field || row.length) { row.push(field); rows.push(row); }
  const headers = rows.shift();
  if (!headers || new Set(headers).size !== headers.length || !["source_commit", "source_path", "sha256", "size_bytes", "origin", "license_evidence", "redistribution", "decision"].every((key) => headers.includes(key))) throw new Error("資産台帳の必須列がありません");
  return rows.filter((r) => r.some(Boolean)).map((r) => {
    if (r.length !== headers.length) throw new Error("資産台帳の列数が不正です");
    return Object.fromEntries(headers.map((key, index) => [key, r[index]]));
  });
}

export function repositoryFiles(root) {
  const tracked = execFileSync("git", ["ls-files", "--stage", "-z"], { cwd: root, encoding: "utf8" }).split("\0").filter(Boolean).map((line) => {
    const tab = line.indexOf("\t");
    const [mode, , stage] = line.slice(0, tab).split(" ");
    if (stage !== "0") throw new Error("未解決のGit conflictがあります");
    return { name: line.slice(tab + 1), mode };
  });
  const extra = execFileSync("git", ["ls-files", "--others", "--exclude-standard", "-z"], { cwd: root, encoding: "utf8" }).split("\0").filter(Boolean).map((name) => ({ name, mode: "100644" }));
  return [...tracked, ...extra];
}

function pathForbidden(name, policy) {
  const lower = name.toLowerCase();
  const basename = path.posix.basename(lower);
  return [...forbiddenPrefixes, ...policy.forbiddenPathPrefixes].some((prefix) => lower.startsWith(prefix.toLowerCase())) ||
    [...forbiddenNames, ...policy.forbiddenBasenames].includes(basename) || /^\.env(?:\.|$)/.test(basename) ||
    [...forbiddenExtensions, ...policy.forbiddenExtensions].includes(path.posix.extname(lower)) ||
    /(?:^|\/)(?:\.git|node_modules|target)(?:\/|$)/.test(lower);
}

export function containsPrivateReference(text) {
  // 値はエラーに含めない。公開ドキュメント内の移行元の名前だけはURLではないため許容。
  const urls = text.match(/(?:https?|ssh|git\+https|git\+ssh):\/\/[^\s<>"'`]+|git@[A-Za-z0-9.-]+:[^\s<>"'`]+/gi) ?? [];
  return urls.some((url) => {
    const normalized = url.toLowerCase();
    if (/github\.com[/:]niho-coliving\/(?:niho-app|niho-clients)(?:[/.#?]|$)/.test(normalized)) return true;
    try {
      const parsed = new URL(url);
      const host = parsed.hostname;
      return Boolean(parsed.username || parsed.password) || /(?:\.internal|\.local|\.ts\.net)$/.test(host) || /^(?:10\.|192\.168\.|172\.(?:1[6-9]|2\d|3[01])\.)/.test(host) || /(?:^|\.)(?:app-stg\.niho\.life|supabase\.co|hitohako\.jpn\.org)$/.test(host);
    } catch { return /^git@/i.test(url); }
  });
}

export async function verifyPublication(root) {
  const failures = [];
  const fail = (code, name = "") => failures.push(`${code}${name ? `: ${JSON.stringify(name)}` : ""}`);
  const readJson = async (name) => JSON.parse(await readFile(path.join(root, name), "utf8"));
  const policy = await readJson("docs/security/publication-policy.json");
  const manifest = await readJson("docs/security/publication-manifest.json");
  if (policy.schemaVersion !== 1 || !Number.isSafeInteger(policy.maxFileBytes) || policy.maxFileBytes <= 0 || policy.maxFileBytes > 10485760 || policy.assetManifestRequired !== true || policy.assetManifestPath !== "docs/security/publication-manifest.json" || !["forbiddenPathPrefixes", "forbiddenBasenames", "forbiddenExtensions"].every((key) => Array.isArray(policy[key]) && policy[key].every((v) => typeof v === "string"))) throw new Error("公開policyの契約が不正です");
  if (manifest.schemaVersion !== 1 || !commit.test(manifest.sourceBaseline?.commit ?? "") || !manifest.sourceBaseline?.repository || !commit.test(manifest.auditedCandidate?.commit ?? "") || !Array.isArray(manifest.importedFiles) || !Array.isArray(manifest.generatedFiles) || !Array.isArray(manifest.excludedSources) || !Array.isArray(manifest.deferredScopes)) throw new Error("公開manifestのschemaが不正です");
  const inventory = parseInventory(await readFile(path.join(root, "docs/legal/asset-inventory.csv"), "utf8"));
  for (const row of inventory) {
    if (!commit.test(row.source_commit) || !validPath(row.source_path) || !sha256.test(row.sha256) || !Number.isSafeInteger(Number(row.size_bytes)) || Number(row.size_bytes) < 0 || !["公開可能", "確認待ち", "要置換", "非公開維持"].includes(row.decision)) fail("資産台帳の記録不正");
  }
  const approved = new Map();
  for (const [kind, entries] of [["imported", manifest.importedFiles], ["generated", manifest.generatedFiles]]) {
    for (const entry of entries) {
      if (!validPath(entry.path)) { fail("manifestパス不正"); continue; }
      if (approved.has(entry.path)) fail("manifest重複", entry.path);
      approved.set(entry.path, { ...entry, kind });
      if (!sha256.test((kind === "imported" ? entry.outputSha256 : entry.sha256) ?? "")) fail("manifestハッシュ不正", entry.path);
      if (kind === "imported") {
        if (!entry.source || !validPath(entry.source.path) || entry.source.repository !== manifest.sourceBaseline.repository || entry.source.commit !== manifest.sourceBaseline.commit || !sha256.test(entry.source.sha256 ?? "")) fail("manifest出典不正", entry.path);
        if (entry.source && validPath(entry.source.path) && pathForbidden(entry.source.path, policy)) fail("manifest出典禁止パス", entry.path);
        if (!Array.isArray(entry.modifications) || entry.modifications.some((v) => !meaningful(v)) || (entry.source?.sha256 !== entry.outputSha256 && !entry.modifications?.length)) fail("manifest変更理由不正", entry.path);
      } else if (!meaningful(entry.origin)) fail("manifest生成元未記録", entry.path);
    }
  }
  for (const excluded of manifest.excludedSources) {
    if (!validPath(excluded.sourcePath) || !meaningful(excluded.reason) || (excluded.sourceSha256 && !sha256.test(excluded.sourceSha256))) fail("manifest除外記録不正");
  }
  const files = repositoryFiles(root);
  const existing = new Set(files.map(({ name }) => name));
  const workspaceNames = new Set();
  const workspacePaths = new Set();
  for (const { name } of files.filter(({ name }) => isSource(name) && name.endsWith("/package.json"))) {
    try { workspaceNames.add((await readJson(name)).name); workspacePaths.add(path.posix.dirname(name)); } catch { fail("package JSON不正", name); }
  }
  for (const { name, mode } of files) {
    if (!validPath(name)) { fail("公開パス不正"); continue; }
    if (pathForbidden(name, policy)) fail("公開禁止パス", name);
    if (mode === "120000" || mode === "160000") { fail("symlink/submodule禁止", name); continue; }
    let stat;
    let unsafeParent = false;
    const parts = name.split("/");
    for (let i = 1; i < parts.length; i++) {
      try { if (!(await lstat(path.join(root, ...parts.slice(0, i)))).isDirectory()) unsafeParent = true; }
      catch { unsafeParent = true; }
    }
    if (unsafeParent) { fail("通常ディレクトリ以外の親は禁止", name); continue; }
    try { stat = await lstat(path.join(root, name)); } catch { fail("追跡ファイル欠落", name); continue; }
    if (stat.isSymbolicLink() || !stat.isFile()) { fail("通常ファイル以外は禁止", name); continue; }
    if (stat.size > policy.maxFileBytes) { fail("公開サイズ超過", name); continue; }
    const bytes = await readFile(path.join(root, name));
    const hash = digest(bytes);
    const entry = approved.get(name);
    if (isSource(name) && !entry) fail("manifest未登録ソース", name);
    if (entry && hash !== (entry.outputSha256 ?? entry.sha256)) fail("manifestハッシュ不一致", name);
    let text;
    try { text = new TextDecoder("utf-8", { fatal: true }).decode(bytes); } catch { /* binary requires exact asset approval below */ }
    const binary = bytes.includes(0) || text === undefined;
    if (binary || isAsset(name)) {
      if (!entry) fail("manifest未登録資産", name);
      const sourcePath = entry?.source?.path ?? name;
      const sourceHash = entry?.source?.sha256 ?? hash;
      const publicAsset = inventory.some((row) => row.source_path === sourcePath && row.sha256 === sourceHash && row.sha256 === hash && Number(row.size_bytes) === bytes.length && row.decision === "公開可能" && meaningful(row.origin) && meaningful(row.license_evidence) && row.redistribution && (!entry?.source || row.source_commit === manifest.auditedCandidate.commit || row.source_commit === entry.source.commit));
      const independentSynthetic = !binary && /(?:^|\/)fixtures?\//i.test(name) && /\.(?:json|csv|txt)$/.test(name) && entry?.kind === "generated" && meaningful(entry.origin) && !inventory.some((row) => row.sha256 === hash && Number(row.size_bytes) === bytes.length && row.decision !== "公開可能");
      if (!publicAsset && !independentSynthetic) fail("資産の公開許可未確認", name);
      if (inventory.some((row) => row.sha256 === hash && Number(row.size_bytes) === bytes.length && row.decision !== "公開可能")) fail("非公開/要置換の元資産", name);
    }
    if (text !== undefined && containsPrivateReference(text)) fail("非公開参照検出（値は非表示）", name);
    if (/^\.github\/workflows\/[^/]+\.ya?ml$/.test(name)) {
      try { for (const violation of workflowFailures(JSON.parse(text))) fail(violation, name); }
      catch { fail("workflowは構造検査可能なJSON形式で記述", name); }
    }
    if (name.endsWith("package.json")) {
      try {
        const pkg = JSON.parse(text);
        if (isSource(name) && pkg.private !== true) fail("npm公開禁止設定なし", name);
        for (const section of ["dependencies", "devDependencies", "peerDependencies", "optionalDependencies", "overrides"]) {
          for (const [dependency, version] of Object.entries(pkg[section] ?? {})) {
            if (typeof version !== "string" || /(?:https?:|git[+:]|github:|file:|link:|ssh:|\/\/)/i.test(version) || ((/^@niho\//.test(dependency) || /^niho-/.test(dependency)) && !workspaceNames.has(dependency))) fail("非公開/非registry package参照", name);
          }
        }
      } catch { fail("package JSON不正", name); }
    }
    if (name === "package-lock.json") {
      const lock = JSON.parse(text);
      if (lock.lockfileVersion !== 3) fail("lock形式不正", name);
      for (const dependency of Object.values(lock.packages ?? {})) {
        if (dependency.link && !workspacePaths.has(dependency.resolved)) fail("公開workspace以外へのlock link", name);
        if (dependency.resolved && !dependency.link && !/^https:\/\/registry\.npmjs\.org\//.test(dependency.resolved)) fail("公開registry以外のlock依存", name);
      }
    }
  }
  for (const name of approved.keys()) if (!existing.has(name)) fail("manifestファイル欠落", name);
  return { failures: [...new Set(failures)], fileCount: files.length, imported: manifest.importedFiles.length, generated: manifest.generatedFiles.length };
}
