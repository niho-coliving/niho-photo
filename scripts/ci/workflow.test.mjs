import assert from "node:assert/strict";
import { test } from "node:test";
import { readFile } from "node:fs/promises";
import { workflowFailures } from "./workflow-lib.mjs";
const workflow = JSON.parse(await readFile(new URL("../../.github/workflows/public-ci.yml", import.meta.url), "utf8"));
test("公開workflowの権限、runner、pin、aggregate契約", () => assert.deepEqual(workflowFailures(workflow), []));
for (const [name, mutate] of [
  ["tag Action", (w) => { w.jobs.plan.steps[0].uses = "actions/checkout@v4"; }],
  ["unverified Action commit", (w) => { w.jobs.plan.steps[0].uses = `actions/checkout@${"a".repeat(40)}`; }],
  ["write permission", (w) => { w.permissions.contents = "write"; }],
  ["job permission", (w) => { w.jobs.plan.permissions = { contents: "write" }; }],
  ["credential persistence", (w) => { w.jobs.plan.steps[0].with["persist-credentials"] = true; }],
  ["private runner", (w) => { w.jobs.native["runs-on"] = ["self-hosted"]; }],
  ["production environment", (w) => { w.jobs.native.environment = "production"; }],
  ["privileged event", (w) => { w.on["pull_request" + "_target"] = {}; }],
  ["secret reference", (w) => { w.jobs.plan.env = { TOKEN: "${{ secrets." + "SYNTHETIC }}" }; }],
  ["shell injection", (w) => { w.jobs.plan.steps.push({ run: "echo '${{ github.event.pull_request.title }}'" }); }],
  ["aggregate bypass", (w) => { w.jobs.aggregate.needs = ["plan"]; }],
  ["concurrency disabled", (w) => { w.concurrency["cancel-in-progress"] = false; }],
]) test(`workflowの危険な変更を拒否: ${name}`, () => {
  const changed = structuredClone(workflow);
  mutate(changed);
  assert.ok(workflowFailures(changed).length > 0);
});
