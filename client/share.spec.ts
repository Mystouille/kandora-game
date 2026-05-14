/**
 * Tests for canonical share-URL helpers.
 *
 * `import.meta.env.VITE_PUBLIC_BASE_URL` is mutated per-test via
 * `vi.stubEnv` so we can exercise the "env override" and "browser
 * fallback" branches in isolation.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  matchShareUrl,
  profileShareUrl,
  publicBaseUrl,
  replayShareUrl,
} from "./share";

describe("share URL helpers", () => {
  beforeEach(() => {
    vi.stubEnv("VITE_PUBLIC_BASE_URL", "");
  });
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("falls back to an empty string in node (no env, no window)", () => {
    // In the node test environment there's no `window`; the helper
    // returns "" so callers get root-relative paths that still
    // work when the browser later renders them.
    expect(publicBaseUrl()).toBe("");
  });

  it("uses VITE_PUBLIC_BASE_URL when set", () => {
    vi.stubEnv("VITE_PUBLIC_BASE_URL", "https://kandora.example.com");
    expect(publicBaseUrl()).toBe("https://kandora.example.com");
  });

  it("trims a trailing slash from the env override", () => {
    vi.stubEnv("VITE_PUBLIC_BASE_URL", "https://kandora.example.com/");
    expect(publicBaseUrl()).toBe("https://kandora.example.com");
  });

  it("builds replay share URLs", () => {
    vi.stubEnv("VITE_PUBLIC_BASE_URL", "https://kandora.example.com");
    expect(replayShareUrl("abc123")).toBe(
      "https://kandora.example.com/replays/abc123"
    );
  });

  it("builds match share URLs", () => {
    vi.stubEnv("VITE_PUBLIC_BASE_URL", "https://kandora.example.com");
    expect(matchShareUrl("abc123")).toBe(
      "https://kandora.example.com/game/abc123"
    );
  });

  it("builds profile share URLs", () => {
    vi.stubEnv("VITE_PUBLIC_BASE_URL", "https://kandora.example.com");
    expect(profileShareUrl("user-42")).toBe(
      "https://kandora.example.com/profile/user-42"
    );
  });

  it("URL-encodes path segments", () => {
    vi.stubEnv("VITE_PUBLIC_BASE_URL", "https://kandora.example.com");
    expect(replayShareUrl("a/b c")).toBe(
      "https://kandora.example.com/replays/a%2Fb%20c"
    );
  });
});
