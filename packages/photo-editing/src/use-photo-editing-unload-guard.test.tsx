// @vitest-environment jsdom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  PHOTO_EDITING_AUTOSAVE_DELAY_MS,
  createPhotoEditingSettingsAutosave,
  type PhotoEditingSettingsAutosave,
} from "./photo-editing-settings-autosave";
import { usePhotoEditingUnloadGuard } from "./use-photo-editing-unload-guard";

let container: HTMLDivElement;
let root: Root;
let mounted: boolean;
/** 送った保存の応答（呼ぶと成功で返る） */
let saveResponses: Array<() => void>;
let autosave: PhotoEditingSettingsAutosave;
const getAutosave = () => autosave;

function Probe(props: { working: boolean }) {
  usePhotoEditingUnloadGuard({ getAutosave, working: props.working });
  return null;
}

async function render(working: boolean): Promise<void> {
  await act(async () => {
    root.render(<Probe working={working} />);
  });
}

/** ページを離れる・閉じる前の確認が出るか（NIHO Desktop の閉じる前の確認と同じく、合成した beforeunload で確かめる） */
function leavingIsGuarded(): boolean {
  const event = new Event("beforeunload", { cancelable: true });
  window.dispatchEvent(event);
  return event.defaultPrevented;
}

function beforeUnloadListenerCalls(spy: { mock: { calls: unknown[][] } }): number {
  return spy.mock.calls.filter(([type]) => type === "beforeunload").length;
}

async function settle(): Promise<void> {
  await act(async () => {
    for (let index = 0; index < 5; index += 1) await Promise.resolve();
  });
}

beforeEach(() => {
  vi.useFakeTimers();
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  saveResponses = [];
  autosave = createPhotoEditingSettingsAutosave({
    save: () =>
      new Promise<void>((resolve) => {
        saveResponses.push(resolve);
      }),
    forget: async () => undefined,
  });
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  mounted = true;
});

afterEach(async () => {
  if (mounted) {
    await act(async () => {
      root.unmount();
    });
  }
  container.remove();
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe("usePhotoEditingUnloadGuard", () => {
  it("作業中（クラウドへ入れている途中・一括の書き出し中・記事に入れている途中）の間だけ beforeunload を登録し、作業が無くなったら外す", async () => {
    const added = vi.spyOn(window, "addEventListener");
    const removed = vi.spyOn(window, "removeEventListener");

    await render(false);
    expect(leavingIsGuarded()).toBe(false);
    expect(beforeUnloadListenerCalls(added)).toBe(0);

    await render(true);
    expect(leavingIsGuarded()).toBe(true);

    await render(false);
    expect(leavingIsGuarded()).toBe(false);
    expect(beforeUnloadListenerCalls(added)).toBe(1);
    expect(beforeUnloadListenerCalls(removed)).toBe(1);
  });

  it("自動保存の待ち（まとめる待ち時間・応答待ち）の間も確かめ、送り終えたら外す", async () => {
    await render(false);

    await act(async () => {
      autosave.schedule("p1", { exposure: 0.3 });
    });
    expect(leavingIsGuarded()).toBe(true);

    await act(async () => {
      vi.advanceTimersByTime(PHOTO_EDITING_AUTOSAVE_DELAY_MS);
    });
    expect(saveResponses).toHaveLength(1);
    expect(leavingIsGuarded()).toBe(true);

    saveResponses[0]();
    await settle();
    expect(autosave.hasPendingWork()).toBe(false);
    expect(leavingIsGuarded()).toBe(false);
  });

  it("画面を離れた（unmount）ら外す", async () => {
    const removed = vi.spyOn(window, "removeEventListener");
    await render(true);
    expect(leavingIsGuarded()).toBe(true);

    await act(async () => {
      root.unmount();
    });
    mounted = false;

    expect(beforeUnloadListenerCalls(removed)).toBe(1);
    expect(leavingIsGuarded()).toBe(false);
  });
});
