/**
 * RelayController tests — orchestration only, with a fake Tenhou client so no
 * live connection is needed (the real client is validated separately, spike 0b).
 */
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("../persist", () => ({
  createMatchDoc: vi.fn(async () => undefined),
  archiveMatch: vi.fn(async () => undefined),
  archiveReplayLog: vi.fn(async () => undefined),
}));

import { MatchProcess } from "../match";
import { RelayController } from "./relayController";
import type {
  TenhouClientFactory,
  TenhouClientHandlers,
  TenhouSpectateClient,
} from "./tenhouClient";

class FakeClient implements TenhouSpectateClient {
  started = false;
  stopped = false;
  constructor(
    readonly watchId: string,
    readonly handlers: TenhouClientHandlers
  ) {}
  start(): void {
    this.started = true;
  }
  stop(): void {
    this.stopped = true;
  }
}

function harness(idleGraceMs = 1000) {
  const clients: FakeClient[] = [];
  const matches = new Map<string, MatchProcess>();
  const closedSpectators: string[] = [];
  const factory: TenhouClientFactory = (watchId, handlers) => {
    const client = new FakeClient(watchId, handlers);
    clients.push(client);
    return client;
  };
  const controller = new RelayController({
    matches,
    closeSpectators: (matchId) => closedSpectators.push(matchId),
    createClient: factory,
    idleGraceMs,
  });
  const lastClient = (): FakeClient => {
    const client = clients.at(-1);
    if (!client) {
      throw new Error("no client created");
    }
    return client;
  };
  return { controller, matches, clients, closedSpectators, lastClient };
}

function ids(start: number): string {
  return Array.from({ length: 13 }, (_, i) => start + i).join(",");
}
const unFrame = (): Record<string, unknown> => ({
  tag: "UN",
  n0: "East",
  n1: "South",
  n2: "West",
  n3: "North",
});
const initFrame = (): Record<string, unknown> => ({
  tag: "INITBYLOG",
  childNodes: [
    {
      tag: "INIT",
      seed: "0,0,0,0,0,4",
      ten: "250,250,250,250",
      oya: "0",
      hai0: ids(0),
      hai1: ids(13),
      hai2: ids(26),
      hai3: ids(39),
    },
    { tag: "T80" },
    { tag: "D80" },
  ],
});
const ryuukyokuFrame = (): Record<string, unknown> => ({
  tag: "WGC",
  childNodes: [
    {
      tag: "RYUUKYOKU",
      ba: "0,0",
      sc: "250,0,250,0,250,0,250,0",
      owari: "250,0,250,0,250,0,250,0",
    },
  ],
});

describe("RelayController", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("de-duplicates by watch-id (one match, one upstream client)", () => {
    const { controller, matches, clients } = harness();
    const a = controller.start("WATCH-1");
    const b = controller.start("WATCH-1");
    expect(a.matchId).toBe(b.matchId);
    expect(clients).toHaveLength(1);
    expect(matches.size).toBe(1);
    expect(clients[0].started).toBe(true);
  });

  it("decodes incoming frames into the relay match", () => {
    const { controller, matches, lastClient } = harness();
    const { matchId } = controller.start("WATCH-2");
    lastClient().handlers.onFrame(unFrame());
    lastClient().handlers.onFrame(initFrame());
    const match = matches.get(matchId);
    expect(match).toBeDefined();
    const types = match
      ? match.replaySpectatorBuffer(0).map((e) => e.event.type)
      : [];
    expect(types).toContain("match_start");
    expect(types).toContain("hand_start");
    expect(types).toContain("draw");
    expect(types).toContain("discard");
  });

  it("tears down after the idle grace once the last spectator leaves", () => {
    vi.useFakeTimers();
    const { controller, matches, closedSpectators, lastClient } = harness(1000);
    const { matchId } = controller.start("WATCH-3");
    controller.onSpectatorAttached(matchId);
    vi.advanceTimersByTime(2000);
    expect(matches.has(matchId)).toBe(true);
    controller.onSpectatorGone(matchId);
    vi.advanceTimersByTime(1100);
    expect(matches.has(matchId)).toBe(false);
    expect(lastClient().stopped).toBe(true);
    expect(closedSpectators).toContain(matchId);
  });

  it("tears down automatically when the stream reaches match_end", () => {
    const { controller, matches, lastClient } = harness();
    const { matchId } = controller.start("WATCH-4");
    lastClient().handlers.onFrame(unFrame());
    lastClient().handlers.onFrame(initFrame());
    lastClient().handlers.onFrame(ryuukyokuFrame());
    expect(matches.has(matchId)).toBe(false);
    expect(lastClient().stopped).toBe(true);
  });

  it("only reports managed matchIds", () => {
    const { controller } = harness();
    const { matchId } = controller.start("WATCH-5");
    expect(controller.managesMatch(matchId)).toBe(true);
    expect(controller.managesMatch("not-a-relay")).toBe(false);
  });
});
