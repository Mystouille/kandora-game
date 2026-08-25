import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { ViewerList } from "./ViewerList";

const toggleViewerList = (): void => undefined;

describe("ViewerList", () => {
  it("renders spectators by live or delayed mode and hides players", () => {
    const html = renderToStaticMarkup(
      createElement(ViewerList, {
        expanded: true,
        onToggle: toggleViewerList,
        viewers: [
          { userId: "u1", displayName: "Alice", role: "player" },
          {
            userId: "u2",
            displayName: "Bob",
            role: "spectator",
            delayMs: 0,
          },
          {
            userId: "u3",
            displayName: "Carol",
            role: "spectator",
            delayMs: 5 * 60_000,
          },
        ],
      })
    );

    expect(html).toContain("Viewers");
    expect(html).not.toContain("Alice");
    expect(html).not.toContain("playing");
    expect(html).toContain("Bob");
    expect(html).toContain("live");
    expect(html).toContain("Carol");
    expect(html).toContain("5 min delay");
    expect(html).toContain(">2<");
    expect(html).toContain('aria-expanded="true"');
    expect(html).toContain('aria-label="Hide viewer list"');
    expect(html).toContain("max-h-full");
    expect(html).toContain("overflow-y-auto");
    expect(html).not.toContain("max-h-40");
  });

  it("keeps the header visible before presence arrives", () => {
    const html = renderToStaticMarkup(
      createElement(ViewerList, {
        expanded: true,
        onToggle: toggleViewerList,
        viewers: [],
      })
    );

    expect(html).toContain("Viewers");
    expect(html).toContain(">0<");
    expect(html).toContain('aria-expanded="true"');
  });

  it("keeps the header but excludes players from the count", () => {
    const html = renderToStaticMarkup(
      createElement(ViewerList, {
        expanded: true,
        onToggle: toggleViewerList,
        viewers: [
          { userId: "u1", displayName: "Alice", role: "player" },
        ],
      })
    );

    expect(html).toContain("Viewers");
    expect(html).toContain(">0<");
    expect(html).not.toContain("Alice");
  });

  it("collapses to the header and count", () => {
    const html = renderToStaticMarkup(
      createElement(ViewerList, {
        expanded: false,
        onToggle: toggleViewerList,
        viewers: [
          {
            userId: "u2",
            displayName: "Bob",
            role: "spectator",
            delayMs: 0,
          },
        ],
      })
    );

    expect(html).toContain("Viewers");
    expect(html).toContain(">1<");
    expect(html).toContain('aria-expanded="false"');
    expect(html).toContain('aria-label="Show viewer list"');
    expect(html).not.toContain("Bob");
  });
});