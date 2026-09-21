import { describe, expect, it, vi } from "vitest";
import {
  installScreenWakeLock,
  type ScreenWakeLockApi,
  type ScreenWakeLockDocument,
  type ScreenWakeLockSentinel,
} from "./screenWakeLock";

class FakeVisibilityDocument implements ScreenWakeLockDocument {
  visibilityState: DocumentVisibilityState = "visible";
  private listener: (() => void) | null = null;

  addEventListener(_type: "visibilitychange", listener: () => void): void {
    this.listener = listener;
  }

  removeEventListener(_type: "visibilitychange", listener: () => void): void {
    if (this.listener === listener) {
      this.listener = null;
    }
  }

  setVisibility(visibilityState: DocumentVisibilityState): void {
    this.visibilityState = visibilityState;
    this.listener?.();
  }
}

function deferred<Value>() {
  let resolve!: (value: Value) => void;
  const promise = new Promise<Value>((nextResolve) => {
    resolve = nextResolve;
  });
  return { promise, resolve };
}

describe("screen wake lock", () => {
  it("acquires while visible, releases while hidden, and reacquires", async () => {
    const visibilityDocument = new FakeVisibilityDocument();
    const first = { release: vi.fn().mockResolvedValue(undefined) };
    const second = { release: vi.fn().mockResolvedValue(undefined) };
    const request = vi.fn<ScreenWakeLockApi["request"]>();
    request.mockResolvedValueOnce(first).mockResolvedValueOnce(second);

    const dispose = installScreenWakeLock({ request }, visibilityDocument);
    await Promise.resolve();
    expect(request).toHaveBeenCalledWith("screen");

    visibilityDocument.setVisibility("hidden");
    expect(first.release).toHaveBeenCalledOnce();
    visibilityDocument.setVisibility("visible");
    await Promise.resolve();
    expect(request).toHaveBeenCalledTimes(2);

    dispose();
    expect(second.release).toHaveBeenCalledOnce();
  });

  it("waits until a hidden document becomes visible", async () => {
    const visibilityDocument = new FakeVisibilityDocument();
    visibilityDocument.visibilityState = "hidden";
    const sentinel = { release: vi.fn().mockResolvedValue(undefined) };
    const request = vi
      .fn<ScreenWakeLockApi["request"]>()
      .mockResolvedValue(sentinel);

    const dispose = installScreenWakeLock({ request }, visibilityDocument);
    expect(request).not.toHaveBeenCalled();
    visibilityDocument.setVisibility("visible");
    await Promise.resolve();
    expect(request).toHaveBeenCalledOnce();
    dispose();
  });

  it("releases a request that resolves after disposal", async () => {
    const visibilityDocument = new FakeVisibilityDocument();
    const pending = deferred<ScreenWakeLockSentinel>();
    const sentinel = { release: vi.fn().mockResolvedValue(undefined) };
    const request = vi
      .fn<ScreenWakeLockApi["request"]>()
      .mockReturnValue(pending.promise);

    const dispose = installScreenWakeLock({ request }, visibilityDocument);
    dispose();
    pending.resolve(sentinel);
    await pending.promise;
    await Promise.resolve();
    expect(sentinel.release).toHaveBeenCalledOnce();
  });
});