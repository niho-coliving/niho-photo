import { readFileSync } from "node:fs";
import path from "node:path";

import { defineConfig } from "vitest/config";

// workspace間でReactなどのpeer依存を共有し、二重ロードを防ぐ。
const peerDependencies = (dir: string): string[] =>
  Object.keys(
    (JSON.parse(readFileSync(path.join(dir, "package.json"), "utf8")) as { peerDependencies?: Record<string, string> })
      .peerDependencies ?? {},
  );

const uiDir = path.resolve(__dirname, "../ui");

export default defineConfig({
  resolve: {
    dedupe: [...new Set([...peerDependencies(__dirname), ...peerDependencies(uiDir)])].filter((name) => name !== "niho-ui"),
  },
  server: {
    fs: { allow: [__dirname, uiDir] },
  },
});
