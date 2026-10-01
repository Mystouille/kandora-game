import { describe, expect, it } from "vitest";
import { createControlledRuntime } from "./controlledRuntime";

describe("controlled timing fixture", () => {
  it("runs ordered callbacks and cancels stale work", async () => {
    const runtime = createControlledRuntime(1_000);
    const calls: number[] = [];
    runtime.schedule(() => calls.push(runtime.now()), 100);
    const stale = runtime.schedule(() => calls.push(-1), 50);
    stale.cancel();
    runtime.schedule(() => calls.push(runtime.now()), 100);
    await runtime.advanceBy(99);
    expect(calls).toEqual([]);
    await runtime.advanceBy(1);
    expect(calls).toEqual([1_100, 1_100]);
  });

  it("lets independent network and frame delays share a deterministic clock", async () => {
    const runtime = createControlledRuntime(0);
    const stages: string[] = [];
    runtime.schedule(() => {
      stages.push("received");
      runtime.schedule(() => stages.push("painted"), 33);
    }, 150);
    await runtime.advanceBy(182);
    expect(stages).toEqual(["received"]);
    await runtime.advanceBy(1);
    expect(stages).toEqual(["received", "painted"]);
    expect(() => runtime.schedule(() => undefined, -1)).toThrow();
  });
});
