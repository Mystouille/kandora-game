import { describe, expect, it, vi } from "vitest";
import { openAppLink } from "./appLinkNavigation";

describe("openAppLink", () => {
  it("uses document navigation so the OS can resolve an App Link", () => {
    const assign = vi.fn();

    openAppLink("/watch/replay/game-1", { assign });

    expect(assign).toHaveBeenCalledWith("/watch/replay/game-1");
  });
});