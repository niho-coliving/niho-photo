import { appendFile } from "node:fs/promises";
import { createArtifactReceipt } from "./release-evidence-lib.mjs";

const summary = process.env.GITHUB_STEP_SUMMARY;
if (!summary) throw new Error("GitHub Actions step summaryがありません");
const receipt = createArtifactReceipt({
  artifactId: process.env.RELEASE_ARTIFACT_ID,
  artifactDigest: process.env.RELEASE_ARTIFACT_DIGEST,
  artifactName: process.env.RELEASE_ARTIFACT_NAME,
  commit: process.env.GITHUB_SHA,
  runId: process.env.GITHUB_RUN_ID,
  runAttempt: process.env.GITHUB_RUN_ATTEMPT,
});
await appendFile(summary, receipt);
