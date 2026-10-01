import { describe, expect, it, vi } from "vitest";
import {
  HumanSessionTakeoverRequiredError,
  PlayerConnections,
} from "./playerConnections";

function fixture() {
  const onDisconnect = vi.fn();
  const connections = new PlayerConnections(
    (seat) => ({
      userId: `human-${seat}`,
      displayName: `Human ${seat}`,
      isBot: false,
    }),
    onDisconnect
  );
  return { connections, onDisconnect };
}

describe("PlayerConnections", () => {
  it("requires an explicit takeover and fences the old sender", () => {
    const { connections } = fixture();
    const first = vi.fn();
    const second = vi.fn();
    connections.attach(0, first, undefined, { clientSessionId: "first" });
    expect(() =>
      connections.attach(0, second, undefined, { clientSessionId: "second" })
    ).toThrow(HumanSessionTakeoverRequiredError);
    expect(
      connections.attach(0, second, undefined, {
        clientSessionId: "second",
        takeover: true,
      })
    ).toEqual({
      previousSend: first,
      previousClientSessionId: "first",
      tookOver: true,
    });
    expect(connections.detach(0, first, false, true)).toBe(false);
    expect(connections.isAttached(0, second)).toBe(true);
  });

  it("preserves self-reported AFK on automatic reconnect but clears explicit resume", () => {
    const { connections } = fixture();
    connections.attach(0, vi.fn(), undefined, { clientSessionId: "first" });
    connections.setAfk(0, true);
    connections.detach(0, undefined, false, true);
    connections.attach(0, vi.fn(), undefined, { clientSessionId: "first" });
    expect(connections.isConnected(0)).toBe(false);
    connections.attach(0, vi.fn(), undefined, {
      clientSessionId: "first",
      takeover: true,
    });
    expect(connections.isConnected(0)).toBe(true);
  });

  it("does not change saved absence policy when detaching a paused process", () => {
    const { connections } = fixture();
    connections.attach(2, vi.fn());
    connections.detach(2, undefined, true, true);
    expect(connections.sender(2)).toBeNull();
    expect(connections.policySnapshot().disconnected[2]).toBe(false);
  });

  it("requires two consecutive probe misses and resets strikes on action", async () => {
    const { connections, onDisconnect } = fixture();
    connections.attach(0, vi.fn(), async () => false);
    await connections.probe(0);
    expect(connections.policySnapshot().livenessProbeMisses[0]).toBe(1);
    expect(onDisconnect).not.toHaveBeenCalled();
    connections.recordAction(0);
    await connections.probe(0);
    expect(onDisconnect).not.toHaveBeenCalled();
    await connections.probe(0);
    expect(connections.policySnapshot().disconnected[0]).toBe(true);
    expect(onDisconnect).toHaveBeenCalledOnce();
  });

  it("ignores a stale liveness result after replacement", async () => {
    const { connections } = fixture();
    let finish!: (alive: boolean) => void;
    const held = new Promise<boolean>((resolve) => {
      finish = resolve;
    });
    connections.attach(0, vi.fn(), () => held);
    const probing = connections.probe(0);
    connections.attach(0, vi.fn(), async () => true);
    finish(false);
    await probing;
    expect(connections.policySnapshot().livenessProbeMisses[0]).toBe(0);
    expect(connections.canProbe(0)).toBe(true);
  });

  it("moves all identity-bound connection state and invalidates pending probes", async () => {
    const { connections } = fixture();
    const sender = vi.fn();
    let finish!: (alive: boolean) => void;
    const held = new Promise<boolean>((resolve) => {
      finish = resolve;
    });
    connections.attach(1, sender, () => held, { clientSessionId: "one" });
    const probing = connections.probe(1);
    connections.permute([1, 0, 2, 3]);
    finish(false);
    await probing;
    expect(connections.seatFor(sender)).toBe(0);
    expect(connections.policySnapshot().livenessProbeMisses).toEqual([
      0, 0, 0, 0,
    ]);
    expect(() =>
      connections.attach(0, vi.fn(), undefined, {
        clientSessionId: "different",
      })
    ).toThrow(HumanSessionTakeoverRequiredError);
  });

  it("copies durable policy values without exposing writable storage", () => {
    const { connections } = fixture();
    const policy = connections.policySnapshot();
    policy.disconnected[2] = true;
    policy.livenessProbeMisses[2] = 1;
    connections.restorePolicy(policy);
    policy.disconnected[2] = false;
    expect(connections.policySnapshot().disconnected[2]).toBe(true);
    expect(connections.policySnapshot().livenessProbeMisses[2]).toBe(1);
  });
});
