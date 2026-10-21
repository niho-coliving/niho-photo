try {
  const needs = JSON.parse(process.env.CI_NEEDS);
  const expected = {
    plan: "success",
    publication: "success",
    secrets: "success",
    dependencies: process.env.GITHUB_EVENT_NAME === "pull_request" ? "success" : "skipped",
    "photo-editing": needs.plan.outputs["photo-editing"] === "true" ? "success" : "skipped",
    "photo-sdk": needs.plan.outputs["photo-sdk"] === "true" ? "success" : "skipped",
    "photo-candidate": needs.plan.outputs["photo-candidate"] === "true" ? "success" : "skipped",
    native: needs.plan.outputs["has-native"] === "true" ? "success" : "skipped",
    swift: needs.plan.outputs["has-swift"] === "true" ? "success" : "skipped",
  };
  const failed = Object.entries(expected).filter(([job, result]) => needs[job]?.result !== result);
  if (failed.length) throw new Error();
  console.log("公開CIの必須検査が成功しました（変更なし・未導入scopeはplanに明示）");
} catch {
  console.error("公開CIの必須検査に失敗・取消・想定外のskipがあります。各jobを確認してください。");
  process.exitCode = 1;
}
