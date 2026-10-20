import { describe, expect, it } from "vitest";

import {
  browserEditingDevelopSettings,
  developSettingsKey,
  neutralDevelopSettings,
  sameDevelopSettings,
} from "./develop-settings";

describe("ブラウザで直す編集内容（F1 #17119）", () => {
  it("開いたときの土台をそろえる（無ければ neutral・13 項目のうち触らない項目はそのまま持つ・相対の白と mode を合わせる）", () => {
    expect(browserEditingDevelopSettings(null)).toEqual(neutralDevelopSettings());

    const opened = browserEditingDevelopSettings({
      v: 1,
      engine: "niho-1",
      highlights: -40,
      clarity: 25,
      relativeTemperature: 12,
      whiteBalance: { mode: "asShot" },
      hsl: { red: { hue: 5 } },
    });
    expect(opened).toMatchObject({
      v: 1,
      engine: "niho-1",
      look: "niho-interim-1",
      base: null,
      exposure: 0,
      highlights: -40,
      clarity: 25,
      relativeTemperature: 12,
      whiteBalance: { mode: "relative" },
      hsl: { red: { hue: 5 } },
    });
  });

  it("キーの順・0 が既定の項目の有無を問わずに比べる（ほかの違いは違うとみなす）", () => {
    const base = neutralDevelopSettings();
    expect(sameDevelopSettings(base, { ...base, highlights: 0, clarity: 0 })).toBe(true);
    expect(sameDevelopSettings(base, { ...base, highlights: -0 })).toBe(true);
    const reordered = { whiteBalance: { mode: "asShot" }, ...base };
    expect(developSettingsKey(reordered)).toBe(developSettingsKey(base));

    expect(sameDevelopSettings(base, { ...base, highlights: -10 })).toBe(false);
    expect(sameDevelopSettings(base, { ...base, whiteBalance: { mode: "relative" } })).toBe(false);
    expect(sameDevelopSettings(base, { ...base, base: "raw-b1" })).toBe(false);
  });
});
