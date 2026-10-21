// @vitest-environment node

import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

/**
 * NIHO photo の窓の地（niho-photo#49）。画面を描く前・窓の大きさを変えている間に見える窓そのものの色（tauri.conf.json の
 * `backgroundColor`）を、画面の地（styles.css の `--niho-surface`。owner 決定 2026-10-21 の Claude アプリの白）と同じにする。
 * 違うと、起動の一瞬と窓の端に前の生成りの色が出る。
 */
describe("窓の地の色", () => {
  it("tauri.conf.json の窓の backgroundColor は styles.css の --niho-surface と同じ", () => {
    const conf = JSON.parse(readFileSync(new URL("../src-tauri/tauri.conf.json", import.meta.url), "utf8")) as {
      app: { windows: { backgroundColor?: string }[] };
    };
    const css = readFileSync(new URL("./styles.css", import.meta.url), "utf8");
    const surface = /--niho-surface:\s*(#[0-9A-Fa-f]{6})\s*;/u.exec(css)?.[1]?.toUpperCase();
    expect(surface).toBe("#FCFBF9");
    expect(conf.app.windows.length).toBeGreaterThan(0);
    for (const window of conf.app.windows) {
      expect(window.backgroundColor?.toUpperCase()).toBe(surface);
    }
  });
});
