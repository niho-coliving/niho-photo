// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";

const unregister: (() => void)[] = [];

afterEach(() => {
  for (const cleanup of unregister.splice(0).reverse()) cleanup();
  vi.unstubAllGlobals();
});

async function freshModule() {
  vi.resetModules();
  return import("./dismiss-layers");
}

describe("browser realm の dismiss layer 契約 v1", () => {
  it("host と SDK の別 module からも最も新しい面だけを閉じる", async () => {
    const host = await freshModule();
    const sdk = await freshModule();
    const outer = vi.fn();
    const inner = vi.fn();
    unregister.push(host.registerDismissLayer(outer));
    const removeInner = sdk.registerDismissLayer(inner);
    unregister.push(removeInner);

    expect(host.dismissTopLayer()).toBe(true);
    expect(inner).toHaveBeenCalledOnce();
    expect(outer).not.toHaveBeenCalled();
    removeInner();
    expect(sdk.dismissTopLayer()).toBe(true);
    expect(outer).toHaveBeenCalledOnce();
  });

  it("途中の面の解除は他の面を消さず、二度解除しても安全", async () => {
    const first = await freshModule();
    const second = await freshModule();
    const outer = vi.fn();
    const inner = vi.fn();
    const removeOuter = first.registerDismissLayer(outer);
    unregister.push(removeOuter, second.registerDismissLayer(inner));
    removeOuter();
    removeOuter();
    expect(first.dismissTopLayer()).toBe(true);
    expect(inner).toHaveBeenCalledOnce();
    expect(outer).not.toHaveBeenCalled();
  });

  it("HMR の再 import 後も開いている面と解除関数を保持する", async () => {
    const before = await freshModule();
    const close = vi.fn();
    const remove = before.registerDismissLayer(close);
    unregister.push(remove);
    const after = await freshModule();
    expect(after.dismissTopLayer()).toBe(true);
    expect(close).toHaveBeenCalledOnce();
    remove();
    expect(after.dismissTopLayer()).toBe(false);
  });

  it("SSR では callback を共有・保持しない", async () => {
    const module = await freshModule();
    vi.stubGlobal("window", undefined);
    const close = vi.fn();
    const remove = module.registerDismissLayer(close);
    expect(module.dismissTopLayer()).toBe(false);
    remove();
    vi.unstubAllGlobals();
    expect(module.dismissTopLayer()).toBe(false);
    expect(close).not.toHaveBeenCalled();
  });
});
