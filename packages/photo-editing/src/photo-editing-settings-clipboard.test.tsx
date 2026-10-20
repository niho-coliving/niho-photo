// @vitest-environment jsdom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  readPhotoEditingSettingsClipboard,
  resetPhotoEditingSettingsClipboardForTest,
  usePhotoEditingSettingsClipboard,
  writePhotoEditingSettingsClipboard,
} from "./photo-editing-settings-clipboard";

/** 「補正をコピー」の置き場（ページを開いている間のメモリ上の 1 つ）。 */

let container: HTMLDivElement;
let root: Root;
const seen: Record<string, string> = {};

function Probe(props: { name: string }) {
  const clipboard = usePhotoEditingSettingsClipboard();
  seen[props.name] = clipboard ? JSON.stringify(clipboard.settings) : "none";
  return null;
}

beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  resetPhotoEditingSettingsClipboardForTest();
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => {
    root.unmount();
  });
  container.remove();
  resetPhotoEditingSettingsClipboardForTest();
});

describe("photoEditingSettingsClipboard", () => {
  it("何も写していなければ null。写すと写した補正と時刻を持ち、写し直すと前の分は捨てる", () => {
    expect(readPhotoEditingSettingsClipboard()).toBeNull();
    writePhotoEditingSettingsClipboard({ exposure: 0.5 }, 1000);
    expect(readPhotoEditingSettingsClipboard()).toEqual({ settings: { exposure: 0.5 }, copiedAt: 1000 });
    writePhotoEditingSettingsClipboard({ contrast: 10 }, 2000);
    expect(readPhotoEditingSettingsClipboard()).toEqual({ settings: { contrast: 10 }, copiedAt: 2000 });
  });

  it("同じページの読み手は同じ値を見る（写すと全員に反映し、捨てると全員が空になる）", async () => {
    await act(async () => {
      root.render(
        <>
          <Probe name="menu" />
          <Probe name="keys" />
        </>,
      );
    });
    expect(seen).toEqual({ menu: "none", keys: "none" });

    await act(async () => {
      writePhotoEditingSettingsClipboard({ exposure: 0.5 }, 1000);
    });
    expect(seen).toEqual({ menu: '{"exposure":0.5}', keys: '{"exposure":0.5}' });

    await act(async () => {
      resetPhotoEditingSettingsClipboardForTest();
    });
    expect(seen).toEqual({ menu: "none", keys: "none" });
  });
});
