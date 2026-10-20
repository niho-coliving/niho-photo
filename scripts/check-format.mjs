import { readFile } from "node:fs/promises";
const root = new URL("../", import.meta.url);
const manifest = JSON.parse(await readFile(new URL("../docs/security/publication-manifest.json", import.meta.url), "utf8"));
const paths = [
  ...manifest.importedFiles.map(({ path }) => path),
  ...manifest.generatedFiles.map(({ path }) => path),
];
const failures = [];

for (const path of paths) {
  const text = await readFile(new URL(path, root), "utf8");
  if (text.includes("\r")) failures.push(`${path}: CR改行`);
  if (!text.endsWith("\n")) failures.push(`${path}: 最終改行なし`);
  if (text.split("\n").some((line) => /[ \t]+$/.test(line))) failures.push(`${path}: 行末空白`);
}

if (failures.length) {
  console.error(failures.join("\n"));
  process.exitCode = 1;
} else {
  console.log(`書式確認: ${paths.length}ファイル、違反なし`);
}
