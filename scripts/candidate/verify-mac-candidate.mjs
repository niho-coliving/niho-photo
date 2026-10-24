#!/usr/bin/env node
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { CandidateError, sha256, verifyCandidateDirectory, verifySdkProofDirectory, writeCandidateTransportProof } from "./mac-candidate-lib.mjs";

function parse(argv) {
  const required = new Set(["--directory", "--expected-manifest-sha256", "--expected-source", "--expected-version", "--expected-sdk-mode", "--expected-sdk-version", "--expected-sdk-manifest-sha256", "--run-id", "--run-attempt"]);
  const optional = new Set(["--sdk-proof-directory", "--artifact-id", "--artifact-digest", "--artifact-name", "--tooling-source", "--receipt", "--provenance"]);
  const allowed = new Set([...required, ...optional]);
  const values = {};
  for (let index = 0; index < argv.length; index += 2) {
    const key = argv[index], value = argv[index + 1];
    if (!allowed.has(key) || !value || value.startsWith("--") || values[key]) throw new CandidateError("candidate verifier引数が不正です");
    values[key] = value;
  }
  for (const key of required) if (!values[key]) throw new CandidateError(`candidate verifierに${key}が必要です`);
  const transport = ["--artifact-id", "--artifact-digest", "--artifact-name", "--tooling-source", "--receipt", "--provenance"];
  if (transport.some((key) => values[key]) && (!values["--sdk-proof-directory"] || transport.some((key) => !values[key]))) throw new CandidateError("candidate transport proof引数が不足しています");
  return values;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const values = parse(process.argv.slice(2));
    const directory = path.resolve(values["--directory"]);
    const result = verifyCandidateDirectory(directory);
    const manifestBytes = readFileSync(path.join(directory, result.manifestFile));
    if (sha256(manifestBytes) !== values["--expected-manifest-sha256"] || result.manifest.source.commit !== values["--expected-source"] || result.manifest.version !== values["--expected-version"] || result.manifest.sdk.mode !== values["--expected-sdk-mode"] || result.manifest.sdk.version !== values["--expected-sdk-version"] || result.manifest.sdk.manifestSha256 !== values["--expected-sdk-manifest-sha256"] || result.manifest.run.id !== values["--run-id"] || result.manifest.run.attempt !== values["--run-attempt"] || !["published", "local-validation"].includes(values["--expected-sdk-mode"])) {
      throw new CandidateError("candidate transport pinが一致しません");
    }
    let sdkProof;
    if (values["--sdk-proof-directory"]) sdkProof = verifySdkProofDirectory({
      directory: path.resolve(values["--sdk-proof-directory"]),
      candidateManifest: result.manifest,
      expectedSdkVersion: values["--expected-sdk-version"],
      expectedSdkManifestSha256: values["--expected-sdk-manifest-sha256"],
    });
    if (values["--receipt"]) writeCandidateTransportProof({
      candidate: result,
      sdkProof,
      artifactId: values["--artifact-id"],
      artifactDigest: values["--artifact-digest"],
      artifactName: values["--artifact-name"],
      toolingSourceSha: values["--tooling-source"],
      receiptFile: path.resolve(values["--receipt"]),
      provenanceFile: path.resolve(values["--provenance"]),
    });
    console.log(`Mac candidateをdata-only検証しました（${result.assets.length} assets）`);
  } catch (error) {
    console.error(error instanceof Error ? error.message : "Mac candidate検証に失敗しました");
    process.exitCode = 1;
  }
}
