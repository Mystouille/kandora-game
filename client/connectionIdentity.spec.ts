import { describe, expect, it } from "vitest";
import { getOrCreateGameClientSessionId } from "./connectionIdentity";

function memoryStorage(initial: string | null = null) {
  let value = initial;
  return {
    getItem: () => value,
    setItem: (_key: string, next: string) => {
      value = next;
    },
    value: () => value,
  };
}

describe("game client session identity", () => {
  it("reuses a valid session-scoped identifier", () => {
    const storage = memoryStorage("client-session-123456");

    expect(
      getOrCreateGameClientSessionId(storage, () => "replacement-session-123")
    ).toBe("client-session-123456");
  });

  it("replaces an invalid stored identifier", () => {
    const storage = memoryStorage("invalid id");

    expect(
      getOrCreateGameClientSessionId(storage, () => "replacement-session-123")
    ).toBe("replacement-session-123");
    expect(storage.value()).toBe("replacement-session-123");
  });

  it("returns an in-memory identifier when storage is unavailable", () => {
    const storage = {
      getItem: () => {
        throw new Error("blocked");
      },
      setItem: () => {
        throw new Error("blocked");
      },
    };

    expect(
      getOrCreateGameClientSessionId(storage, () => "fallback-session-12345")
    ).toBe("fallback-session-12345");
  });

  it("creates an in-memory identifier when no storage is provided", () => {
    expect(
      getOrCreateGameClientSessionId(null, () => "memory-session-123456")
    ).toBe("memory-session-123456");
  });
});
