import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { ViewerList, ViewerListToggle } from "./ViewerList";

describe("ViewerList", () => {
  it("renders spectators by live or delayed mode and hides players", () => {
    const html = renderToStaticMarkup(
      createElement(ViewerList, {
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
  });

  it("renders nothing before presence arrives", () => {
    expect(
      renderToStaticMarkup(createElement(ViewerList, { viewers: [] }))
    ).toBe("");
  });

  it("renders nothing when presence contains only players", () => {
    expect(
      renderToStaticMarkup(
        createElement(ViewerList, {
          viewers: [
            { userId: "u1", displayName: "Alice", role: "player" },
          ],
        })
      )
    ).toBe("");
  });

  it("labels the inline eye toggle from its current visibility", () => {
    const visibleHtml = renderToStaticMarkup(
      createElement(ViewerListToggle, {
        visible: true,
        onToggle: () => undefined,
      })
    );
    const hiddenHtml = renderToStaticMarkup(
      createElement(ViewerListToggle, {
        visible: false,
        onToggle: () => undefined,
      })
    );

    expect(visibleHtml).toContain('aria-label="Hide viewer list"');
    expect(visibleHtml).toContain('aria-pressed="true"');
    expect(hiddenHtml).toContain('aria-label="Show viewer list"');
    expect(hiddenHtml).toContain('aria-pressed="false"');
  });
});