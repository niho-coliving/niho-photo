import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { UpdateStatus } from "./camera-bridge";
import { CameraUpdateNotice, updateNoticeText } from "./camera-update-notice";

// React 18 の act を jsdom で使う
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
});

/** native の自動更新を真似る（今の状態を先に渡し、あとから差し替えを送る）。 */
function fakeNative(initial: UpdateStatus) {
  const handlers: Array<(status: UpdateStatus) => void> = [];
  let unlistened = 0;
  return {
    watch: async (handler: (status: UpdateStatus) => void) => {
      handlers.push(handler);
      handler(initial);
      return () => {
        unlistened += 1;
      };
    },
    send: (status: UpdateStatus) => {
      for (const handler of handlers) handler(status);
    },
    unlistened: () => unlistened,
  };
}

async function show(watch: (handler: (status: UpdateStatus) => void) => Promise<() => void>) {
  await act(async () => {
    root.render(<CameraUpdateNotice watch={watch} />);
  });
}

describe("CameraUpdateNotice", () => {
  it("shows nothing while the app does not update itself (no public key, a development or E2E build)", async () => {
    const native = fakeNative({ enabled: false, stagedVersion: null });
    await show(native.watch);
    expect(container.textContent).toBe("");
  });

  it("says the new version applies on the next launch once it is staged, and can be closed", async () => {
    const native = fakeNative({ enabled: true, stagedVersion: null });
    await show(native.watch);
    expect(container.textContent).toBe("");

    await act(async () => native.send({ enabled: true, stagedVersion: "0.1.8" }));
    const notice = container.querySelector('[role="status"]');
    expect(notice?.textContent).toBe(updateNoticeText("0.1.8"));
    expect(updateNoticeText("0.1.8")).toBe("新しい版 0.1.8 を入れました。閉じて開き直すと切り替わります。");

    await act(async () => {
      container.querySelector<HTMLButtonElement>('button[aria-label="更新の案内を閉じる"]')?.click();
    });
    expect(container.textContent).toBe("");
  });

  it("keeps the notice when an older status arrives after the update was staged", async () => {
    const native = fakeNative({ enabled: true, stagedVersion: "0.1.8" });
    await show(native.watch);
    await act(async () => native.send({ enabled: true, stagedVersion: null }));
    expect(container.textContent).toContain("0.1.8");
  });

  it("stays silent when the native side cannot be reached, and stops listening when it goes away", async () => {
    await show(async () => {
      throw new Error("not allowed by ACL");
    });
    expect(container.textContent).toBe("");

    const native = fakeNative({ enabled: true, stagedVersion: null });
    await show(native.watch);
    await act(async () => root.unmount());
    expect(native.unlistened()).toBe(1);
    root = createRoot(container);
  });
});
