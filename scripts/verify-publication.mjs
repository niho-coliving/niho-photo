import { fileURLToPath } from "node:url";
import { verifyPublication } from "./ci/publication-lib.mjs";

try {
  const result = await verifyPublication(fileURLToPath(new URL("../", import.meta.url)));
  if (result.failures.length) {
    console.error(result.failures.join("\n"));
    process.exitCode = 1;
  } else console.log(`公開検証: ${result.fileCount} files / ${result.imported} imported / ${result.generated} generated、違反なし`);
} catch {
  // パーサー例外には検出値が含まれる場合があるため、そのまま出さない。
  console.error("公開検証を完了できませんでした。policy / manifest / 台帳 / Git状態を確認してください（値は非表示）");
  process.exitCode = 1;
}
