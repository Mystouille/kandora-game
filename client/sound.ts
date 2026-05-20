/**
 * Game sound effects (Phase 4).
 *
 * Thin wrapper around howler.js. Keeps audio entirely client-side:
 * `Howl` instances are constructed lazily on first `playGameSound`
 * call so the SSR pass never touches `window`. If an SFX asset is
 * missing or fails to decode, howler logs and we silently no-op —
 * the game must remain playable without sound.
 *
 * Asset convention: each sound has a single source file under
 * `app/game/client/sfx/` (co-located with this module so Vite
 * fingerprints it for `immutable` caching — see `SFX_URLS`).
 * A cue may declare multiple variants (e.g. male / female voice
 * for calls) — one variant is chosen at random per play. Files
 * are optional — missing files just disable that particular
 * cue. Drop new files in and they pick up automatically.
 *
 * Disable / volume preferences are persisted in `localStorage` so
 * a mute persists across page loads.
 */
import { Howl } from "howler";
import type { GameEvent, LegalAction, Seat } from "~/game/protocol/messages";
import { subscribeToGameEvents, useMatchStore } from "./store";

/**
 * Hashed-URL map of every SFX shipped in this build, keyed by
 * basename without extension (e.g. `draw`, `riichi_m`). Vite emits
 * each file under `/assets/<basename>-<hash>.wav` at build time so
 * the browser can cache them `immutable` forever \u2014 a new mix
 * gets a new hash and a new URL, so cache busting is automatic and
 * we pay zero revalidation round-trips on repeat plays.
 *
 * Dev mode resolves the same URLs through Vite's dev server, also
 * with the active `base` (`/kandora/...` under `dev:remote`) baked
 * in, so no `BASE_URL` juggling is needed here.
 */
const SFX_URLS: Record<string, string> = Object.fromEntries(
  Object.entries(
    import.meta.glob("./sfx/*.wav", {
      eager: true,
      query: "?url",
      import: "default",
    }) as Record<string, string>
  ).map(([path, url]) => {
    const base = path
      .split("/")
      .pop()!
      .replace(/\.wav$/, "");
    return [base, url];
  })
);

export type SoundKey =
  | "draw"
  | "discard"
  | "riichi"
  | "ron"
  | "tsumo"
  | "pon"
  | "chi"
  | "kan"
  | "handStart"
  | "matchStart"
  | "timer-tick"
  | "game-start-tick"
  | "call-prompt";

/**
 * Per-cue file basename(s) under `app/game/client/sfx/`. A
 * `string[]` declares random-pick variants (e.g. male/female voice).
 */
const SOUND_FILES: Record<SoundKey, string | readonly string[]> = {
  draw: "draw",
  discard: "discard",
  riichi: "riichi_m",
  ron: "ron_m",
  tsumo: "tsumo_m",
  pon: "pon_m",
  chi: "chi_m",
  kan: "kan_m",
  handStart: "hand_start",
  matchStart: "match_start",
  "timer-tick": "timer_tick",
  "game-start-tick": "game_start_tick",
  "call-prompt": "call_prompt",
};

const LS_ENABLED_KEY = "kandora.game.sound.enabled";
const LS_VOLUME_KEY = "kandora.game.sound.volume";

function readBool(key: string, fallback: boolean): boolean {
  if (typeof window === "undefined") {
    return fallback;
  }
  try {
    const raw = window.localStorage.getItem(key);
    if (raw === null) {
      return fallback;
    }
    return raw === "true";
  } catch {
    return fallback;
  }
}

function readNumber(key: string, fallback: number): number {
  if (typeof window === "undefined") {
    return fallback;
  }
  try {
    const raw = window.localStorage.getItem(key);
    if (raw === null) {
      return fallback;
    }
    const parsed = Number(raw);
    if (!Number.isFinite(parsed)) {
      return fallback;
    }
    return Math.min(1, Math.max(0, parsed));
  } catch {
    return fallback;
  }
}

let enabled = readBool(LS_ENABLED_KEY, true);
let volume = readNumber(LS_VOLUME_KEY, 0.6);

const howls = new Map<string, Howl>();

function howlFor(base: string): Howl | null {
  if (typeof window === "undefined") {
    return null;
  }
  const existing = howls.get(base);
  if (existing) {
    return existing;
  }
  const url = SFX_URLS[base];
  if (!url) {
    // Missing asset \u2014 silently disable this cue. Logged once
    // per basename to help spot typos without spamming.
    if (!howls.has(base)) {
      console.warn(`[sound] no SFX asset bundled for "${base}"`);
    }
    return null;
  }
  try {
    const howl = new Howl({
      src: [url],
      volume,
      preload: true,
      // Silent-fail policy: a missing / undecodable file logs to
      // the console (howler default) but must not throw to the
      // caller. Future-proof against asset-rename mistakes.
      onloaderror: () => undefined,
      onplayerror: () => undefined,
    });
    howls.set(base, howl);
    return howl;
  } catch {
    return null;
  }
}

function pickVariant(key: SoundKey): string {
  const entry = SOUND_FILES[key];
  if (typeof entry === "string") {
    return entry;
  }
  return entry[Math.floor(Math.random() * entry.length)];
}

/**
 * Play the named sound, if sounds are enabled and the asset loads
 * cleanly. No-op during SSR and when the user has muted the game.
 * For cues with multiple variants, a variant is chosen at random.
 */
export function playGameSound(key: SoundKey): void {
  if (!enabled || typeof window === "undefined") {
    return;
  }
  const howl = howlFor(pickVariant(key));
  if (!howl) {
    return;
  }
  try {
    howl.play();
  } catch {
    // ignore — howler reports through `onplayerror` already.
  }
}

export function setGameSoundEnabled(next: boolean): void {
  enabled = next;
  if (typeof window === "undefined") {
    return;
  }
  try {
    window.localStorage.setItem(LS_ENABLED_KEY, String(next));
  } catch {
    // best-effort persistence
  }
}

export function isGameSoundEnabled(): boolean {
  return enabled;
}

export function setGameSoundVolume(next: number): void {
  const clamped = Math.min(1, Math.max(0, next));
  volume = clamped;
  for (const howl of howls.values()) {
    howl.volume(clamped);
  }
  if (typeof window === "undefined") {
    return;
  }
  try {
    window.localStorage.setItem(LS_VOLUME_KEY, String(clamped));
  } catch {
    // best-effort persistence
  }
}

export function getGameSoundVolume(): number {
  return volume;
}

/**
 * Map an applied `GameEvent` to a SFX cue. Per-seat events that
 * aren't visually loud for the viewer (an opponent's anonymous
 * draw) stay silent so the soundscape only reacts to things the
 * player would expect a cue for.
 */
export function playSoundForEvent(
  event: GameEvent,
  _mySeat: Seat | null
): void {
  switch (event.type) {
    case "hand_start": {
      playGameSound("handStart");
      return;
    }
    case "draw": {
      playGameSound("draw");
      return;
    }
    case "discard": {
      // Riichi declarations get their own (more emphatic) cue.
      if (event.riichi) {
        playGameSound("riichi");
        return;
      }
      playGameSound("discard");
      return;
    }
    case "call": {
      switch (event.meld.type) {
        case "chi":
          playGameSound("chi");
          return;
        case "pon":
          playGameSound("pon");
          return;
        case "daiminkan":
        case "ankan":
        case "shouminkan":
          playGameSound("kan");
          return;
      }
      return;
    }
    case "win": {
      // `loser == null` ⇒ tsumo; otherwise ron.
      if (event.loser == null) {
        playGameSound("tsumo");
      } else {
        playGameSound("ron");
      }
      return;
    }
    case "match_start": {
      playGameSound("matchStart");
      return;
    }
    default:
      return;
  }
}

/**
 * Subscribe the SFX cue mapper to the store's game-event bus.
 * Idempotent across hot-module-reload — only the most recently
 * installed binding stays active. Returns an unsubscribe function
 * so the host route can tear down with the rest of its lifecycle.
 *
 * Sound is fundamentally a side-effect of game-state changes, so
 * the binding lives next to the store (the canonical event
 * publisher), not next to the WebSocket (which is purely
 * transport).
 *
 * Also installs an in-game-only `call-prompt` cue that fires when
 * the focused user is offered a call decision (chi / pon / kan /
 * ron / tsumo). Because this binding is only installed from the
 * live match route (`spectate` and `replay` deliberately skip
 * `installGameSoundBindings`), the cue is naturally gated to the
 * play-from-your-own-seat case and never plays for spectators or
 * replay viewers.
 */
let uninstallBinding: (() => void) | null = null;
export function installGameSoundBindings(): () => void {
  if (uninstallBinding) {
    uninstallBinding();
    uninstallBinding = null;
  }
  const unsubscribe = subscribeToGameEvents(({ event, mySeat }) => {
    playSoundForEvent(event, mySeat);
  });
  const unsubscribeCallPrompt = subscribeToCallPrompt();
  const teardown = (): void => {
    unsubscribe();
    unsubscribeCallPrompt();
    if (uninstallBinding === teardown) {
      uninstallBinding = null;
    }
  };
  uninstallBinding = teardown;
  return teardown;
}

/**
 * Legal-action types that represent a *call* decision the player
 * must respond to (as opposed to their own turn's draw / discard /
 * riichi declaration). When the focused seat's `legalActions`
 * transitions from "no call offered" to "call offered", we cue
 * `call-prompt` so the player notices even if they were looking
 * away from the screen.
 *
 * Notes:
 * - `riichi` is excluded: it's a self-discard variant on the
 *   player's own turn, not a reactive call window.
 * - We fire on the rising edge only — the prompt stays up for
 *   the whole window, but we don't want the cue to repeat on
 *   every re-render.
 */
const CALL_PROMPT_ACTION_TYPES: ReadonlySet<LegalAction["type"]> = new Set([
  "chi",
  "pon",
  "kan",
  "ron",
  "tsumo",
]);

function hasCallPrompt(actions: readonly LegalAction[]): boolean {
  for (const action of actions) {
    if (CALL_PROMPT_ACTION_TYPES.has(action.type)) {
      return true;
    }
  }
  return false;
}

function subscribeToCallPrompt(): () => void {
  return useMatchStore.subscribe((state, prev) => {
    if (state.legalActions === prev.legalActions) {
      return;
    }
    const hadCall = hasCallPrompt(prev.legalActions);
    const hasCall = hasCallPrompt(state.legalActions);
    if (!hadCall && hasCall) {
      playGameSound("call-prompt");
    }
  });
}
