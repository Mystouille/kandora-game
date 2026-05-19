/**
 * Left-side semi-collapsible options menu for live play.
 *
 * Visual states:
 *   - Expanded: vertical stack of full-text options. Active
 *     options have a highlighted (emerald) background.
 *   - Collapsed: a narrow strip of single-letter buttons
 *     (S / W / C / D). Active options have highlighted text
 *     colour; inactive ones are white.
 *
 * Controlled component: parent owns `flags` (so external
 * signals — e.g. a manual hand drag flipping `autoSort` off
 * — can update the menu).
 *
 * Persistence: only the `autoSort` preference survives across
 * page loads and hand boundaries (via `localStorage`). The
 * other three "auto play" flags (autoWin / noCall / autoDiscard)
 * are deliberately ephemeral — they reset to `false` on every
 * `hand_start` so a player can't leave a hand on full auto by
 * accident. See {@link readPersistedAutoSort} and
 * {@link writePersistedAutoSort} for the persistence helpers
 * and {@link resetEphemeralFlags} for the per-hand reset.
 */
import { useState } from "react";

/** Stable id → display label (expanded) → single-letter glyph (collapsed). */
const OPTIONS = [
  { key: "autoSort", label: "Auto sort", letter: "S" },
  { key: "autoWin", label: "Auto win", letter: "W" },
  { key: "noCall", label: "No call", letter: "C" },
  { key: "autoDiscard", label: "Auto discard", letter: "D" },
] as const;

export type LivePlayMenuOptionKey = (typeof OPTIONS)[number]["key"];
export type LivePlayMenuFlags = Record<LivePlayMenuOptionKey, boolean>;

export const LIVE_PLAY_MENU_DEFAULTS: LivePlayMenuFlags = {
  autoSort: true,
  autoWin: false,
  noCall: false,
  autoDiscard: false,
};

/** `localStorage` key for the persisted `autoSort` preference. */
export const LIVE_PLAY_MENU_AUTOSORT_STORAGE_KEY = "kandora.live.autoSort";

/**
 * Read the persisted `autoSort` preference from `localStorage`.
 * Returns `LIVE_PLAY_MENU_DEFAULTS.autoSort` when nothing is
 * stored, the stored value is not a recognised boolean string,
 * or `localStorage` isn't available (SSR / privacy mode).
 */
export function readPersistedAutoSort(): boolean {
  if (typeof window === "undefined") {
    return LIVE_PLAY_MENU_DEFAULTS.autoSort;
  }
  try {
    const raw = window.localStorage.getItem(
      LIVE_PLAY_MENU_AUTOSORT_STORAGE_KEY
    );
    if (raw === "true") {
      return true;
    }
    if (raw === "false") {
      return false;
    }
  } catch {
    // localStorage may throw under quota / privacy modes.
  }
  return LIVE_PLAY_MENU_DEFAULTS.autoSort;
}

/**
 * Persist the `autoSort` preference. No-op when `localStorage`
 * isn't available or throws (quota / privacy mode).
 */
export function writePersistedAutoSort(on: boolean): void {
  if (typeof window === "undefined") {
    return;
  }
  try {
    window.localStorage.setItem(
      LIVE_PLAY_MENU_AUTOSORT_STORAGE_KEY,
      on ? "true" : "false"
    );
  } catch {
    // localStorage may throw under quota / privacy modes.
  }
}

/**
 * Build the initial flag set for a fresh mount: persisted
 * `autoSort` (with the default fallback) and every ephemeral
 * "auto play" flag reset to `false`.
 */
export function buildInitialLivePlayMenuFlags(): LivePlayMenuFlags {
  return {
    ...LIVE_PLAY_MENU_DEFAULTS,
    autoSort: readPersistedAutoSort(),
    autoWin: false,
    noCall: false,
    autoDiscard: false,
  };
}

/**
 * Reset the ephemeral "auto play" flags (autoWin / noCall /
 * autoDiscard) on a hand boundary, leaving `autoSort` unchanged.
 * Returns the same reference when nothing would change.
 */
export function resetEphemeralFlags(
  flags: LivePlayMenuFlags
): LivePlayMenuFlags {
  if (!flags.autoWin && !flags.noCall && !flags.autoDiscard) {
    return flags;
  }
  return {
    ...flags,
    autoWin: false,
    noCall: false,
    autoDiscard: false,
  };
}

export interface LivePlayMenuProps {
  /** Controlled flags. Parent should pass the current state. */
  flags: LivePlayMenuFlags;
  /** Fired with the *new* flags whenever a button toggles. */
  onChange: (flags: LivePlayMenuFlags) => void;
}

export function LivePlayMenu(props: LivePlayMenuProps): React.JSX.Element {
  const { flags, onChange } = props;
  const [expanded, setExpanded] = useState<boolean>(false);

  const toggle = (key: LivePlayMenuOptionKey): void => {
    onChange({ ...flags, [key]: !flags[key] });
  };

  // Common handler so right-click (which fires `contextmenu`,
  // not `click`) toggles too — and the native browser context
  // menu is suppressed while hovering the menu.
  const handleContextMenu = (e: React.MouseEvent, action: () => void): void => {
    e.preventDefault();
    action();
  };

  return (
    <div
      // Vertically centred on the left edge. `pointer-events-auto`
      // because the outer match container disables touch
      // gestures on the canvas, not on overlay children.
      className="pointer-events-auto absolute left-2 top-1/2 -translate-y-1/2 z-30 flex flex-col gap-2 rounded-lg border border-emerald-700/60 bg-emerald-950/85 p-3 shadow-xl"
    >
      <button
        type="button"
        onClick={() => setExpanded((v) => !v)}
        onContextMenu={(e) =>
          handleContextMenu(e, () => setExpanded((v) => !v))
        }
        aria-label={expanded ? "Collapse options menu" : "Expand options menu"}
        aria-expanded={expanded}
        className={
          "h-14 flex items-center justify-center text-emerald-200 hover:text-white text-4xl font-bold leading-none rounded hover:bg-emerald-800/60 " +
          // Expanded: chevron stretches across the full drawer
          // width so it reads as a "close" affordance. Collapsed:
          // square w-14 button so it matches the letter glyphs
          // below and the drawer keeps a single-column shape.
          (expanded ? "w-full" : "w-14")
        }
      >
        {expanded ? "«" : "»"}
      </button>
      {OPTIONS.map((opt) => {
        const active = flags[opt.key];
        if (expanded) {
          // Expanded row: a w-14 letter glyph (same size and X
          // position as the collapsed letter buttons) plus the
          // full label to the right. The active background spans
          // the whole row so it reads as a single toggle target.
          return (
            <button
              key={opt.key}
              type="button"
              onClick={() => toggle(opt.key)}
              onContextMenu={(e) => handleContextMenu(e, () => toggle(opt.key))}
              aria-pressed={active}
              className={
                "h-14 flex items-center rounded text-base font-semibold transition-colors " +
                (active
                  ? "bg-emerald-500 text-emerald-950 hover:bg-emerald-400"
                  : "bg-emerald-900/70 text-white hover:bg-emerald-800")
              }
            >
              <span className="w-14 h-14 flex items-center justify-center font-mono font-bold text-2xl">
                {opt.letter}
              </span>
              <span className="pr-6">{opt.label}</span>
            </button>
          );
        }
        // Collapsed glyph: text colour reflects state.
        return (
          <button
            key={opt.key}
            type="button"
            onClick={() => toggle(opt.key)}
            onContextMenu={(e) => handleContextMenu(e, () => toggle(opt.key))}
            aria-label={`${opt.label} (${active ? "on" : "off"})`}
            aria-pressed={active}
            title={opt.label}
            className={
              "w-14 h-14 flex items-center justify-center rounded font-mono font-bold text-2xl transition-colors hover:bg-emerald-800/60 " +
              (active ? "text-emerald-300" : "text-white")
            }
          >
            {opt.letter}
          </button>
        );
      })}
    </div>
  );
}
