const pins = new Map([
  ["actions/checkout", "11bd71901bbe5b1630ceea73d27597364c9af683"],
  ["actions/setup-node", "49933ea5288caeca8642d1e84afbd3f7d6820020"],
  ["actions/upload-artifact", "cf430e030ddbb5b0abf93d22962f4752f3646cd9"],
  ["actions/download-artifact", "d3f86a106a0bac45b974a628896c90dbdf5c8093"],
]);

export const candidatePublishCondition = "github.event_name == 'workflow_dispatch' && github.ref == 'refs/heads/main' && github.repository == 'niho-coliving/niho-photo'";
export const candidatePublisherVerifyCommand = "node scripts/candidate/verify-mac-candidate.mjs --directory \"$RUNNER_TEMP/photo-candidate-download/candidate\" --sdk-proof-directory \"$RUNNER_TEMP/photo-candidate-download/sdk-proof\" --expected-manifest-sha256 \"$CANDIDATE_MANIFEST_SHA256\" --expected-source \"$APP_SOURCE_SHA\" --expected-version \"$APP_VERSION\" --expected-sdk-mode published --expected-sdk-version \"$SDK_VERSION\" --expected-sdk-manifest-sha256 \"$SDK_MANIFEST_SHA256\" --run-id \"$CANDIDATE_RUN_ID\" --run-attempt \"$CANDIDATE_RUN_ATTEMPT\" --artifact-id \"$CANDIDATE_ARTIFACT_ID\" --artifact-digest \"$CANDIDATE_ARTIFACT_DIGEST\" --artifact-name \"$CANDIDATE_ARTIFACT_NAME\" --tooling-source \"$CANDIDATE_TOOLING_SHA\" --receipt \"$RUNNER_TEMP/photo-candidate-artifact-receipt.json\" --provenance \"$RUNNER_TEMP/photo-candidate-provenance.json\"";

export function photoCandidateWorkflowFailures(workflow) {
  const failures = [];
  const fail = (message) => failures.push(message);
  const serialized = JSON.stringify(workflow);
  if (workflow.name !== "Photo Mac candidate release") fail("candidate workflow名が不正");
  if (JSON.stringify(workflow.permissions) !== JSON.stringify({ contents: "read" })) fail("candidate workflow既定権限はcontents: readのみ");
  if (Object.keys(workflow.on ?? {}).join(",") !== "workflow_dispatch") fail("candidate releaseはmanual dispatchのみ");
  const inputs = workflow.on?.workflow_dispatch?.inputs ?? {};
  if (Object.keys(inputs).join(",") !== "app_source_sha,sdk_version,app_version,sdk_manifest_sha256" || Object.values(inputs).some((input) => input?.required !== true || input?.type !== "string")) fail("candidate dispatch入力集合が不正");
  if (workflow.concurrency?.["cancel-in-progress"] !== false || typeof workflow.concurrency?.group !== "string") fail("candidate release concurrencyが不正");
  const publicVariable = "${{ vars.NIHO_PHOTO_PUBLIC_FIREBASE_WEB_API_KEY }}";
  const withoutPublicVariable = serialized.replaceAll(publicVariable, "PUBLIC_FIREBASE_VARIABLE");
  if (/\$\{\{[^}]*\b(?:secrets|vars)\b[^}]*\}\}|pull_request_target|\bid-token\b/u.test(withoutPublicVariable) || serialized.split(publicVariable).length !== 2) fail("candidate workflowのvariable例外は公開Firebase Web config 1箇所だけ");
  if (Object.keys(workflow.jobs ?? {}).sort().join(",") !== "build,publish") fail("candidate workflow job集合が不正");
  const build = workflow.jobs?.build, publish = workflow.jobs?.publish;
  if (build?.["runs-on"] !== "macos-26" || build?.["timeout-minutes"] !== 90 || build?.permissions || build?.environment) fail("candidate builderはmacOS 26/read-only/90分に固定");
  if (publish?.["runs-on"] !== "ubuntu-24.04" || publish?.["timeout-minutes"] !== 10 || JSON.stringify(publish?.needs) !== JSON.stringify(["build"]) || publish?.if !== candidatePublishCondition || JSON.stringify(publish?.permissions) !== JSON.stringify({ actions: "read", contents: "write" }) || publish?.environment) fail("candidate publisherのrunner/条件/最小権限が不正");
  const expectedOutputs = {
    "app-source-sha": "${{ steps.source.outputs.app-source-sha }}",
    "app-version": "${{ steps.source.outputs.app-version }}",
    "sdk-version": "${{ steps.sdk.outputs.sdk-version }}",
    "sdk-manifest-sha256": "${{ steps.sdk.outputs.sdk-manifest-sha256 }}",
    "candidate-manifest-sha256": "${{ steps.candidate.outputs.candidate-manifest-sha256 }}",
    "candidate-manifest-file": "${{ steps.candidate.outputs.candidate-manifest-file }}",
    "artifact-id": "${{ steps.upload.outputs.artifact-id }}",
    "artifact-digest": "${{ steps.upload.outputs.artifact-digest }}",
    "artifact-name": "${{ steps.names.outputs.artifact-name }}",
  };
  if (JSON.stringify(build?.outputs) !== JSON.stringify(expectedOutputs)) fail("candidate builder/publisher output境界が不正");
  for (const [jobName, job] of Object.entries(workflow.jobs ?? {})) {
    for (const step of job.steps ?? []) {
      if (step["continue-on-error"]) fail("candidate workflowの失敗を無視できません");
      if (step.uses) {
        const [name, pin, extra] = step.uses.split("@");
        if (extra || !/^[a-f0-9]{40}$/u.test(pin ?? "") || pins.get(name) !== pin) fail("candidate workflowのAction pinが未検証です");
        if (name === "actions/checkout" && (step.with?.["persist-credentials"] !== false || step.with?.token || step.with?.["ssh-key"])) fail("candidate checkoutはcredentialを保持できません");
      }
      if (step.run && /\$\{\{\s*github\.(?:event|head_ref|ref_name)/u.test(step.run)) fail("candidate shellへevent入力を直接展開できません");
      if (jobName === "publish" && step.run && /(?:^|\s)(?:npm|npx|cargo|rustc|rustup|wasm-bindgen|swift|xcodebuild|tauri)\s/u.test(step.run)) fail("candidate publisherはinstall/native/buildを実行できません");
      if (jobName === "publish" && step.run && /photo-candidate-download\/(?:candidate|sdk-proof)\/[^\s"]*\.(?:mjs|js|sh|bin|app)/u.test(step.run)) fail("candidate publisherはartifact内codeを実行できません");
    }
  }
  const source = build?.steps?.find((step) => step.id === "source");
  const sourceEnv = { APP_SOURCE_SHA: "${{ inputs.app_source_sha }}", APP_VERSION: "${{ inputs.app_version }}", CANDIDATE_REPOSITORY: "${{ github.repository }}", CANDIDATE_WORKFLOW_REF: "${{ github.ref }}", CANDIDATE_WORKFLOW_SHA: "${{ github.sha }}", SDK_MANIFEST_SHA256: "${{ inputs.sdk_manifest_sha256 }}", SDK_VERSION: "${{ inputs.sdk_version }}" };
  if (JSON.stringify(source?.env) !== JSON.stringify(sourceEnv) || !source?.run?.includes('"refs/heads/main"') || !source.run.includes('"niho-coliving/niho-photo"') || !source.run.includes('"$(git rev-parse HEAD)" != "$CANDIDATE_WORKFLOW_SHA"') || !source.run.includes("git merge-base --is-ancestor") || !source.run.includes("refs/remotes/origin/main") || !source.run.includes("git checkout --detach") || !source.run.includes("^[a-f0-9]{40}$") || !source.run.includes("^[a-f0-9]{64}$") || !source.run.includes(".test(appVersion)") || source["continue-on-error"]) fail("candidate dispatch/app/SDK入力はmainと厳格形式へ固定する必要があります");
  const install = build?.steps?.find((step) => step.name === "Node依存をversion overlay前に準備");
  if (install?.run !== "npm ci --ignore-scripts --no-audit --no-fund") fail("candidate dependency installはoverlay前の固定lockだけ");
  const sdk = build?.steps?.find((step) => step.id === "sdk");
  for (const token of ["gh api", "gh release download", "photo-sdk-artifact-receipt.json", "git fetch --no-tags origin", "prepare-published-sdk.mjs", "--expected-manifest-sha256", "--github-output"]) if (!sdk?.run?.includes(token)) fail("公開SDK releaseのtag/bytes/receipt proofが不足しています");
  if (sdk?.env?.GH_TOKEN !== "${{ github.token }}" || sdk?.env?.SDK_MANIFEST_SHA256 !== "${{ inputs.sdk_manifest_sha256 }}") fail("公開SDK取得はread-only tokenとdispatch hashに固定");
  const config = build?.steps?.find((step) => step.name === "公開Firebase Web configだけをbuild fileへ書く");
  if (JSON.stringify(config?.env) !== JSON.stringify({ NIHO_PHOTO_PUBLIC_FIREBASE_WEB_API_KEY: publicVariable }) || !config?.run?.includes("^AIza[A-Za-z0-9_-]{30,}$") || !config.run.includes("photo-candidate-public-config.json")) fail("公開Firebase variableは単一config stepだけで形式検査する");
  const candidate = build?.steps?.find((step) => step.id === "candidate");
  for (const token of ["candidate:build", "--sdk-mode published", "candidate:verify", "--sdk-proof-directory", "--expected-sdk-version", "--expected-sdk-manifest-sha256", "candidate-manifest-sha256"]) if (!candidate?.run?.includes(token)) fail("candidate builderのpublished SDK/data検証が不足しています");
  if (Object.hasOwn(candidate?.env ?? {}, "NIHO_PHOTO_PUBLIC_FIREBASE_WEB_API_KEY")) fail("公開Firebase値をcandidate step envへ継承できません");
  const uploads = build?.steps?.filter((step) => step.uses?.startsWith("actions/upload-artifact@")) ?? [];
  const uploadWith = { name: "${{ steps.names.outputs.artifact-name }}", path: "${{ runner.temp }}/photo-candidate-artifact/", "if-no-files-found": "error", "retention-days": 30, "compression-level": 0, "include-hidden-files": false };
  if (uploads.length !== 1 || uploads[0].id !== "upload" || JSON.stringify(uploads[0].with) !== JSON.stringify(uploadWith)) fail("candidateとSDK proofだけを専用artifactへ保存する必要があります");
  const checkout = publish?.steps?.find((step) => step.uses?.startsWith("actions/checkout@"));
  if (checkout?.with?.ref !== "${{ github.sha }}" || checkout?.with?.["fetch-depth"] !== 1) fail("candidate publisherはdispatchしたmain toolingを使う必要があります");
  const downloads = publish?.steps?.filter((step) => step.uses?.startsWith("actions/download-artifact@")) ?? [];
  const downloadWith = { "artifact-ids": "${{ needs.build.outputs.artifact-id }}", path: "${{ runner.temp }}/photo-candidate-download", "merge-multiple": true };
  if (downloads.length !== 1 || JSON.stringify(downloads[0].with) !== JSON.stringify(downloadWith)) fail("candidate publisherは同run artifact IDだけを取得する必要があります");
  const verify = publish?.steps?.find((step) => step.name === "dispatch mainのverifierで全bytesを再照合");
  const verifyEnv = { APP_SOURCE_SHA: "${{ needs.build.outputs.app-source-sha }}", APP_VERSION: "${{ needs.build.outputs.app-version }}", CANDIDATE_ARTIFACT_DIGEST: "${{ needs.build.outputs.artifact-digest }}", CANDIDATE_ARTIFACT_ID: "${{ needs.build.outputs.artifact-id }}", CANDIDATE_ARTIFACT_NAME: "${{ needs.build.outputs.artifact-name }}", CANDIDATE_MANIFEST_SHA256: "${{ needs.build.outputs.candidate-manifest-sha256 }}", CANDIDATE_RUN_ATTEMPT: "${{ github.run_attempt }}", CANDIDATE_RUN_ID: "${{ github.run_id }}", CANDIDATE_TOOLING_SHA: "${{ github.sha }}", SDK_MANIFEST_SHA256: "${{ needs.build.outputs.sdk-manifest-sha256 }}", SDK_VERSION: "${{ needs.build.outputs.sdk-version }}" };
  if (verify?.run !== candidatePublisherVerifyCommand || JSON.stringify(verify?.env) !== JSON.stringify(verifyEnv)) fail("candidate publisherはmanifest/SDK/artifact/runをmain verifierで再照合する必要があります");
  const release = publish?.steps?.find((step) => step.name === "新規CAS tagとcandidate prereleaseを作成");
  for (const token of ["gh api --method POST", "refs/tags/$tag", "photo-candidate-v$APP_VERSION-${APP_SOURCE_SHA:0:12}", "gh release create", "--verify-tag", "--prerelease", "--latest=false", "*.dmg", "*.app.tar.gz", "*.cdx.json", "*.candidate.json", "niho-photo-sdk-*.json", "photo-candidate-artifact-receipt.json", "photo-candidate-provenance.json"]) if (!release?.run?.includes(token)) fail("candidate prereleaseのCAS/assets契約が不足しています");
  if (/(?:--clobber|--force|release upload|git push|git tag -f|refs\/tags\/camera-v)/u.test(release?.run ?? "") || release?.env?.GH_TOKEN !== "${{ github.token }}") fail("candidate releaseの上書き/private camera-v変更は禁止です");
  return [...new Set(failures)];
}
