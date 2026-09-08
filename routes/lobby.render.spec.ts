import { createElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { LobbyLoaderData } from "./lobby";

const mocks = vi.hoisted(() => ({
  navigate: vi.fn(),
  revalidate: vi.fn(),
}));

let loaderData: LobbyLoaderData;

vi.mock("react-router", async (importOriginal) => {
  const actual = await importOriginal<typeof import("react-router")>();
  return {
    ...actual,
    Link: ({ to, children, ...props }: { to: string; children: ReactNode }) =>
      createElement("a", { ...props, href: to }, children),
    useLoaderData: () => loaderData,
    useNavigate: () => mocks.navigate,
    useRevalidator: () => ({
      state: "idle",
      revalidate: mocks.revalidate,
    }),
  };
});

import LobbyRoute from "./lobby";

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
      gameLogs: [],
    };
  });

  it("offers only Tenhou's built-in five-minute delayed stream", () => {
    const markup = renderToStaticMarkup(createElement(LobbyRoute));

    expect(markup).toContain("TNT Open");
    expect(markup).toContain("[1] East · [2] South");
    expect(markup).toContain('href="/watch/live/WATCH%2F123"');
    expect(markup.match(/5min delay/g)).toHaveLength(1);
    expect(markup).not.toContain("Watch live");
    expect(markup).not.toContain("delay=");
  });
});
