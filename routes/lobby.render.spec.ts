import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { LobbyLoaderData } from "./lobby";

const mocks = vi.hoisted(() => ({
  revalidate: vi.fn(),
}));

let loaderData: LobbyLoaderData;

vi.mock("react-router", async (importOriginal) => {
  const actual = await importOriginal<typeof import("react-router")>();
  return {
    ...actual,
    useLoaderData: () => loaderData,
    useRevalidator: () => ({
      state: "idle",
      revalidate: mocks.revalidate,
    }),
  };
});

import LobbyRoute, { soloMatchPath } from "./lobby";

describe("game lobby", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    loaderData = {
      flag: { gameEnabled: true },
      presets: [],
      tenhouLiveGames: [
        {
          watchId: "WATCH/123",
          leagueName: "TNT Open",
          startTime: Date.parse("2026-09-08T18:00:00.000Z"),
          players: [
            { seat: 0, displayName: "East" },
            { seat: 1, displayName: "South" },
          ],
        },
      ],
      gameLogs: [
        {
          gameId: "REPLAY/456",
          ruleSet: "m-league",
          mode: {
            type: "duplicate",
            seed: "Board-A",
            generationVersion: 1,
          },
          startedAt: Date.parse("2026-09-08T16:00:00.000Z"),
          endedAt: Date.parse("2026-09-08T17:00:00.000Z"),
          seats: [],
        },
      ],
    };
  });

  it("marks only the solo handoff for native auto-start", () => {
    expect(soloMatchPath("ROOM/123")).toBe("/game/ROOM%2F123?solo=1");
  });

  it("uses document links for Tenhou streams and completed replays", () => {
    const markup = renderToStaticMarkup(createElement(LobbyRoute));

    expect(markup).toContain("TNT Open");
    expect(markup).toContain("[1] East · [2] South");
    expect(markup).toContain('href="/watch/live/WATCH%2F123"');
    expect(markup).toContain('href="/watch/replay/REPLAY%2F456"');
    expect(markup.match(/5min delay/g)).toHaveLength(1);
    expect(markup).not.toContain("Watch live");
    expect(markup).not.toContain("delay=");
    expect(markup).toContain("Duplicate · Board-A");
  });

  it("renders duplicate mode off without exposing the seed field", () => {
    const markup = renderToStaticMarkup(createElement(LobbyRoute));

    expect(markup).toContain("Duplicate mode");
    expect(markup).toContain('role="switch"');
    expect(markup).not.toContain("Duplicate seed");
    expect(markup).not.toContain('placeholder="Enter seed"');
  });
});
