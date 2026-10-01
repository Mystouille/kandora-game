import { describe, expect, it } from "vitest";
import { normalMatchMode } from "~/game/protocol/matchMode";
import { createInitialState, step } from "~/game/rules";
import { createSystemMatchRuntime } from "../runtime";
import { MatchKernel } from "./matchKernel";

function fixture() {
  const kernel = new MatchKernel(
    normalMatchMode,
    "tenhou-hanchan",
    createSystemMatchRuntime(42)
  );
  kernel.initialize(42, 0);
  return kernel;
}

describe("MatchKernel", () => {
  it("preserves initial state and the engine's ordered draw effects", () => {
    const kernel = fixture();
    const initial = createInitialState(42);
    expect(kernel.view).toEqual(initial);
    const expected = step(initial, { type: "draw", seat: 0 });
    expect(kernel.draw()).toEqual(expected);
    expect(kernel.view).toEqual(expected.state);
  });

  it("returns discard effects after updating the sole authoritative state", () => {
    const kernel = fixture();
    kernel.draw();
    const before = step(createInitialState(42), {
      type: "draw",
      seat: 0,
    }).state;
    const tile = kernel.view.lastDrawn[0];
    if (tile === null) {
      throw new Error("expected a drawn tile");
    }
    const expected = step(before, {
      type: "discard",
      seat: 0,
      tile,
      discardSource: "draw",
    });
    expect(kernel.discard(0, tile, "draw")).toEqual(expected);
    expect(kernel.view).toEqual(expected.state);
  });

  it("rejects illegal transitions explicitly without replacing state", () => {
    const kernel = fixture();
    const before = JSON.stringify(kernel.view);
    expect(() => kernel.discard(0, "1m")).toThrow("engine rejected discard");
    expect(JSON.stringify(kernel.view)).toBe(before);
  });

  it("builds legality through engine probes without mutating state", () => {
    const kernel = fixture();
    kernel.draw();
    const before = JSON.stringify(kernel.view);
    expect(
      kernel.discardLegals(0).some((action) => action.type === "discard")
    ).toBe(true);
    expect(JSON.stringify(kernel.view)).toBe(before);
  });

  it("preserves the forced human draw queue and recovery queue snapshots", () => {
    const kernel = fixture();
    kernel.applyDebugSeed({ humanDraws: ["1m", "2p"] });
    kernel.prepareDebugDraw();
    const result = kernel.draw();
    expect(result.events.find((event) => event.type === "draw")).toMatchObject({
      tile: "1m",
    });
    const queues = kernel.debugQueues();
    queues.humanDraws.push("3s");
    expect(kernel.debugQueues().humanDraws).toEqual(["2p"]);
  });
});
