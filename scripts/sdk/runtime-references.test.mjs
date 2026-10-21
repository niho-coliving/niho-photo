import assert from "node:assert/strict";
import test from "node:test";

import { rewriteVersionedRuntimeReferences } from "./build-develop-engine-runtime.mjs";

test("web glueの仮想module IDを保ち実ファイル参照だけを版指定する", () => {
  const input = Buffer.from([
    'const imports = { "./niho_develop_wasm_bg.js": import0 };',
    'module_or_path = new URL("niho_develop_wasm_bg.wasm", import.meta.url);',
    '/* @ts-self-types="./niho_develop_wasm.d.ts" */',
  ].join("\n"));
  const output = rewriteVersionedRuntimeReferences("niho_develop_wasm.js", input, "0.25.0").toString();
  assert.match(output, /"\.\/niho_develop_wasm_bg\.js": import0/u);
  assert.match(output, /new URL\("niho_develop_wasm_bg-0\.25\.0\.wasm"/u);
  assert.match(output, /niho_develop_wasm-0\.25\.0\.d\.ts/u);
});

test("仮想module IDと同名の外部JS参照は許可しない", () => {
  for (const reference of [
    'import("./niho_develop_wasm_bg.js")',
    'new URL("./niho_develop_wasm_bg.js", import.meta.url)',
  ]) {
    assert.throws(() => rewriteVersionedRuntimeReferences("niho_develop_wasm.js", Buffer.from(reference), "0.25.0"), /unversioned runtime/u);
  }
});
