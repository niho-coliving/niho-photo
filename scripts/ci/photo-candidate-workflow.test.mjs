import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";

import { photoCandidateWorkflowFailures } from "./photo-candidate-workflow-lib.mjs";

const workflow = JSON.parse(await readFile(new URL("../../.github/workflows/photo-candidate-release.yml", import.meta.url), "utf8"));

test("Mac candidate release workflowはread-only builderとdata-only publisherだけを許可する", () => assert.deepEqual(photoCandidateWorkflowFailures(workflow), []));

for (const [name, mutate] of [
  ["builder OIDC permission", (value) => { value.jobs.build.permissions = { "id-token": "write" }; }],
  ["attestation omitted", (value) => { value.jobs.publish.steps = value.jobs.publish.steps.filter((step) => step.id !== "attest"); }],
  ["attestation subject changed", (value) => { value.jobs.publish.steps.find((step) => step.id === "attest").with["subject-path"] = "unverified.json"; }],
  ["attestation OIDC permission omitted", (value) => { delete value.jobs.publish.permissions["id-token"]; }],
  ["build write permission", (value) => { value.jobs.build.permissions = { contents: "write" }; }],
  ["unfixed action", (value) => { value.jobs.build.steps[0].uses = "actions/checkout@v4"; }],
  ["non-main dispatch", (value) => { value.jobs.build.steps.find((step) => step.id === "source").run = "git checkout HEAD"; }],
  ["app semver validation omitted", (value) => { value.jobs.build.steps.find((step) => step.id === "source").run = value.jobs.build.steps.find((step) => step.id === "source").run.replace(".test(appVersion)", ".test(\"1.0.0\")"); }],
  ["extra variable", (value) => { value.jobs.build.env = { UNSAFE: "${{ vars.OTHER }}" }; }],
  ["Firebase variable inherited by build", (value) => { value.jobs.build.steps.find((step) => step.id === "candidate").env.NIHO_PHOTO_PUBLIC_FIREBASE_WEB_API_KEY = "${{ vars.NIHO_PHOTO_PUBLIC_FIREBASE_WEB_API_KEY }}"; }],
  ["SDK manifest hash omitted", (value) => { value.jobs.build.steps.find((step) => step.id === "sdk").run = "gh release download photo-sdk-v0.1.1"; }],
  ["artifact by name", (value) => { const step = value.jobs.publish.steps.find((item) => item.uses?.startsWith("actions/download-artifact@")); delete step.with["artifact-ids"]; step.with.name = "candidate"; }],
  ["publisher install", (value) => { value.jobs.publish.steps.push({ run: "npm install" }); }],
  ["artifact script executed", (value) => { value.jobs.publish.steps.find((step) => step.name === "dispatch mainのverifierで全bytesを再照合").run = "node $RUNNER_TEMP/photo-candidate-download/candidate/script.mjs"; }],
  ["transport digest omitted", (value) => { delete value.jobs.publish.steps.find((step) => step.name === "dispatch mainのverifierで全bytesを再照合").env.CANDIDATE_ARTIFACT_DIGEST; }],
  ["release overwrite", (value) => { value.jobs.publish.steps.find((step) => step.name === "新規CAS tagとcandidate prereleaseを作成").run += "\ngh release upload --clobber"; }],
  ["not prerelease", (value) => { value.jobs.publish.steps.find((step) => step.name === "新規CAS tagとcandidate prereleaseを作成").run = value.jobs.publish.steps.find((step) => step.name === "新規CAS tagとcandidate prereleaseを作成").run.replace("--prerelease", ""); }],
  ["private updater tag", (value) => { value.jobs.publish.steps.find((step) => step.name === "新規CAS tagとcandidate prereleaseを作成").run += "\nrefs/tags/camera-v1"; }],
]) test(`Mac candidate workflowの危険な変更を拒否: ${name}`, () => {
  const changed = structuredClone(workflow);
  mutate(changed);
  assert.ok(photoCandidateWorkflowFailures(changed).length > 0);
});
