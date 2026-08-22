import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { ViewerList } from "./ViewerList";

describe("ViewerList", () => {
  it("renders connected names, roles, and count", () => {
    const html = renderToStaticMarkup(
      createElement(ViewerList, {
        viewers: [
          { userId: "u1", displayName: "Alice", role: "player" },
          { userId: "u2", displayName: "Bob", role: "spectator" },
        ],
      })
    );

    expect(html).toContain("Viewers");
    expect(html).toContain("Alice");
    expect(html).toContain("playing");
    expect(html).toContain("Bob");
    expect(html).toContain("watching");
    expect(html).toContain(">2<");
  });

  it("renders nothing before presence arrives", () => {
    expect(
      renderToStaticMarkup(createElement(ViewerList, { viewers: [] }))
    ).toBe("");
  });
});