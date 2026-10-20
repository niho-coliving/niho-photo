import { readFile, lstat } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { repositoryFiles, parseInventory, digest, isAsset } from "./ci/publication-lib.mjs";
const root = fileURLToPath(new URL("../", import.meta.url));
const inventory = parseInventory(await readFile(path.join(root, "docs/legal/asset-inventory.csv"), "utf8"));
const failures = [];
let checked = 0;
for (const { name } of repositoryFiles(root)) {
  if (!(await lstat(path.join(root, name))).isFile()) continue;
  const bytes = await readFile(path.join(root, name));
  if (bytes.includes(0)) continue;
  let text;
  try { text = new TextDecoder("utf-8", { fatal: true }).decode(bytes); } catch { continue; }
  checked++;
  if (text.includes("\r")) failures.push(`${JSON.stringify(name)}: CR改行`);
  // 公開許可済み資産のbyte列は改行追加でも変えない。出典との一致は公開guardが確認する。
  const approvedAsset = isAsset(name) && inventory.some((row) => row.decision === "公開可能" && row.sha256 === digest(bytes) && Number(row.size_bytes) === bytes.length);
  if (!approvedAsset && text.length && !text.endsWith("\n")) failures.push(`${JSON.stringify(name)}: 最終改行なし`);
  if (text.split("\n").some((line) => /[ \t]+$/.test(line))) failures.push(`${JSON.stringify(name)}: 行末空白`);
}
if (failures.length) {
  console.error(failures.join("\n"));
  process.exitCode = 1;
} else console.log(`書式確認: ${checked}ファイル、違反なし`);
