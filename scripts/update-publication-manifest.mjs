import { readFile, writeFile, lstat } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { digest, validPath } from "./ci/publication-lib.mjs";

// 既存1ファイルだけ更新する。baseline・出典hash・権利判断は自動で変更しない。
try {
  const args = process.argv.slice(2);
  if (args.length !== 4 || args[0] !== "--path" || args[2] !== "--reason" || !validPath(args[1]) || args[3].trim().length < 8) throw new Error();
  const root = fileURLToPath(new URL("../", import.meta.url));
  const manifestPath = path.join(root, "docs/security/publication-manifest.json");
  const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
  const entry = [...manifest.importedFiles, ...manifest.generatedFiles].find((item) => item.path === args[1]);
  if (!entry || !(await lstat(path.join(root, args[1]))).isFile()) throw new Error();
  const hash = digest(await readFile(path.join(root, args[1])));
  if (entry.source) {
    entry.outputSha256 = hash;
    entry.modifications = [...new Set([...entry.modifications, args[3].trim()])];
  } else {
    entry.sha256 = hash;
    entry.origin = `${entry.origin}\n変更理由: ${args[3].trim()}`;
  }
  await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
  console.log("指定1ファイルのmanifestを更新しました。公開guardと出所・権利のレビューを実施してください。");
} catch {
  console.error("使用法: node scripts/update-publication-manifest.mjs --path <既存manifestパス> --reason <8文字以上の具体的な変更理由>（入力値は非表示）");
  process.exitCode = 1;
}
