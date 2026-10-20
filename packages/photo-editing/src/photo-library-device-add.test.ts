import { describe, expect, it } from "vitest";

import { MAC_FOLDER_TRUNCATED_NOTICE, summarizeMacCloudAdd } from "./photo-library-device-add";

describe("summarizeMacCloudAdd", () => {
  it("止めた理由 > 失敗 > 入れなかった写真（フォルダの上限・RAW と同じ写真の JPEG）。無ければ null", () => {
    const failure = { fileName: "A.RW2", message: "x", retry: null };
    expect(summarizeMacCloudAdd({ stopMessage: "容量が足りません", failures: [failure], rawPairedJpegCount: 2, truncated: true })).toEqual({
      kind: "stopped",
      text: "容量が足りません",
    });
    expect(summarizeMacCloudAdd({ stopMessage: null, failures: [failure], rawPairedJpegCount: 2, truncated: false })).toEqual({
      kind: "failed",
      failures: [failure],
    });
    expect(summarizeMacCloudAdd({ stopMessage: null, failures: [], rawPairedJpegCount: 2, truncated: true })).toEqual({
      kind: "notice",
      text: `${MAC_FOLDER_TRUNCATED_NOTICE}。RAW と同じ写真の JPEG 2 枚は入れませんでした`,
    });
    expect(summarizeMacCloudAdd({ stopMessage: null, failures: [], rawPairedJpegCount: 0, truncated: false })).toBeNull();
  });
});
